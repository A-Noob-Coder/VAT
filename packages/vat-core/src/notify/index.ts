/**
 * VAT 多通道通知子系统 (M4)
 * ------------------------------------------------------------------
 * 当流水线出现需要人介入的信号 (如 PM 判定需求不明确、熔断裁决) 时,
 * Hub 会把 type==='notify' 的单据广播到所有已启用的通知通道。
 *
 * 设计要点:
 *  - NotifyChannel 抽象: 每个通道只实现 send(msg), 互不影响 (best-effort, 单通道失败不阻断其他)。
 *  - 通道类型: email (HTTP 邮件 API, Resend/SES 风格) / webhook (企微/飞书/Slack 兼容) / wechat (微信官方小龙虾插件, webhook 风格)。
 *  - 全部基于 fetch, 零新增依赖; fetch 可注入以便单测。
 *  - 微信 claw: 微信官方信息交互插件, 本质是一个 webhook 推送 URL。其载荷近似企业微信机器人
 *    格式 ({ msgtype:'text', text:{content} })。若插件实际字段不同, 仅需调整 WeChatChannel 的
 *    buildPayload, url 由用户在配置中填插件的真实推送端点。
 */

import type { VatConfig } from '../types.js';

export type NotifyLevel = 'info' | 'warn' | 'block';

export interface NotifyMessage {
  title: string;
  body: string;
  level?: NotifyLevel;
  card?: string;
  meta?: Record<string, unknown>;
}

export interface EmailChannelConfig {
  id: string;
  type: 'email';
  enabled?: boolean;
  to: string;
  from?: string;
  /** 邮件 API 端点, 默认 Resend 风格。设为 SES/SendGrid 时按各自契约调整字段。 */
  apiUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface WebhookChannelConfig {
  id: string;
  type: 'webhook';
  enabled?: boolean;
  url: string;
  template?: 'slack' | 'wecom' | 'feishu' | 'generic';
}

export interface WeChatChannelConfig {
  id: string;
  type: 'wechat';
  enabled?: boolean;
  /** 微信 claw 插件的推送 URL */
  url: string;
  template?: 'text' | 'markdown';
}

export type ChannelConfig = EmailChannelConfig | WebhookChannelConfig | WeChatChannelConfig;

export interface NotifyConfig {
  channels: ChannelConfig[];
}

export interface NotifyChannel {
  readonly id: string;
  readonly type: ChannelConfig['type'];
  readonly enabled: boolean;
  send(msg: NotifyMessage): Promise<void>;
}

export interface Notifier {
  channels: NotifyChannel[];
  notify(msg: NotifyMessage): Promise<{ sent: string[]; failed: Array<{ id: string; error: string }> }>;
}

type FetchImpl = typeof fetch;

const DEFAULT_FETCH: FetchImpl =
  typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchImpl) : (() => Promise.reject(new Error('fetch unavailable'))) as FetchImpl;

function envKey(cfg: { apiKey?: string; apiKeyEnv?: string }): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.apiKeyEnv) return process.env[cfg.apiKeyEnv];
  return undefined;
}

async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  fetchImpl: FetchImpl
): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ---------- Email (HTTP 邮件 API) ----------

class EmailChannel implements NotifyChannel {
  readonly id: string;
  readonly type = 'email' as const;
  readonly enabled: boolean;
  private constructor(
    private readonly cfg: EmailChannelConfig,
    private readonly fetchImpl: FetchImpl
  ) {
    this.id = cfg.id;
    this.enabled = cfg.enabled ?? true;
  }
  static create(cfg: EmailChannelConfig, f: FetchImpl) {
    return new EmailChannel(cfg, f);
  }
  send(msg: NotifyMessage): Promise<void> {
    const key = envKey(this.cfg);
    if (!key) throw new Error(`email 通道 "${this.cfg.id}" 缺少 apiKey (设置 ${this.cfg.apiKeyEnv ?? 'apiKey'})`);
    const apiUrl = this.cfg.apiUrl ?? 'https://api.resend.com/emails';
    const payload = {
      to: [this.cfg.to],
      from: this.cfg.from ?? 'vat@localhost',
      subject: `[VAT] ${msg.title}`,
      text: `${msg.body}\n\n-- VAT 虚拟工程组织`,
    };
    return postJson(apiUrl, payload, { Authorization: `Bearer ${key}` }, this.fetchImpl);
  }
}

// ---------- Webhook (企微/飞书/Slack) ----------

function webhookPayload(t: WebhookChannelConfig['template'], msg: NotifyMessage): unknown {
  const full = `【${msg.level ?? 'info'}】${msg.title}\n\n${msg.body}`;
  switch (t) {
    case 'slack':
      return { text: full };
    case 'wecom':
      return { msgtype: 'text', text: { content: full } };
    case 'feishu':
      return { msg_type: 'text', content: { text: full } };
    default:
      return { text: full };
  }
}

class WebhookChannel implements NotifyChannel {
  readonly id: string;
  readonly type = 'webhook' as const;
  readonly enabled: boolean;
  private constructor(
    private readonly cfg: WebhookChannelConfig,
    private readonly fetchImpl: FetchImpl
  ) {
    this.id = cfg.id;
    this.enabled = cfg.enabled ?? true;
  }
  static create(cfg: WebhookChannelConfig, f: FetchImpl) {
    return new WebhookChannel(cfg, f);
  }
  send(msg: NotifyMessage): Promise<void> {
    return postJson(this.cfg.url, webhookPayload(this.cfg.template, msg), {}, this.fetchImpl);
  }
}

// ---------- WeChat (claw 插件, webhook 风格) ----------

class WeChatChannel implements NotifyChannel {
  readonly id: string;
  readonly type = 'wechat' as const;
  readonly enabled: boolean;
  private constructor(
    private readonly cfg: WeChatChannelConfig,
    private readonly fetchImpl: FetchImpl
  ) {
    this.id = cfg.id;
    this.enabled = cfg.enabled ?? true;
  }
  static create(cfg: WeChatChannelConfig, f: FetchImpl) {
    return new WeChatChannel(cfg, f);
  }
  send(msg: NotifyMessage): Promise<void> {
    const content = `${msg.title}\n\n${msg.body}`;
    // 微信 claw 插件大多兼容企业微信机器人格式; 若字段不同, 改此处即可。
    const payload =
      this.cfg.template === 'markdown'
        ? { msgtype: 'markdown', markdown: { content } }
        : { msgtype: 'text', text: { content } };
    return postJson(this.cfg.url, payload, {}, this.fetchImpl);
  }
}

export interface BuildNotifierOptions {
  fetchImpl?: FetchImpl;
  logger?: (line: string) => void;
}

export function buildNotifier(config: VatConfig, opts: BuildNotifierOptions = {}): Notifier {
  const fetchImpl = opts.fetchImpl ?? DEFAULT_FETCH;
  const log = opts.logger ?? (() => {});
  const channels: NotifyChannel[] = (config.notify?.channels ?? []).map((c) => {
    switch (c.type) {
      case 'email':
        return EmailChannel.create(c, fetchImpl);
      case 'webhook':
        return WebhookChannel.create(c, fetchImpl);
      case 'wechat':
        return WeChatChannel.create(c, fetchImpl);
    }
  });

  return {
    channels,
    async notify(msg) {
      const sent: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const ch of channels) {
        if (!ch.enabled) continue;
        try {
          await ch.send(msg);
          sent.push(ch.id);
          log(`[notify] → ${ch.type}:${ch.id} ok`);
        } catch (err) {
          const error = (err as Error).message;
          failed.push({ id: ch.id, error });
          log(`[notify] → ${ch.type}:${ch.id} failed: ${error}`);
        }
      }
      return { sent, failed };
    },
  };
}
