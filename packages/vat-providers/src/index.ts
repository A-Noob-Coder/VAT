// 多协议模型接入层 (架构设计 §7.1): openai-compat / anthropic / gemini + 跨协议容灾链
export * from './probe.js';


//
// 结构化输出策略:
//  - gemini:    responseMimeType=application/json (schema 走 prompt 声明, 兼容性最好)
//  - anthropic: tool-use 强制 schema (tool_choice)
//  - openai-compat: response_format=json_object + prompt 声明 schema (覆盖最广的服务端)
// 全部协议的响应都会经 vat-core 的宽健 JSON 解析与 RoleOutput 校验兜底。

export interface ProviderConfig {
  id: string;
  protocol: 'openai-compat' | 'anthropic' | 'gemini';
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  model: string;
  rpmLimit?: number;
  /** 关闭思考模式 (GLM: thinking.type=disabled)。思考型模型把答案放进 reasoning_content 时开启 */
  disableThinking?: boolean;
}

export interface GenerateRequest {
  system: string;
  user: string;
  schema?: unknown;
  maxTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerateResponse {
  text: string;
  providerId: string;
  model: string;
  usage: Usage;
  latencyMs: number;
}

export class AllProvidersFailedError extends Error {
  constructor(detail: string) {
    super(`所有模型均不可用: ${detail}`);
  }
}

interface HttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

async function httpJson(
  url: string,
  init: RequestInit & { headers: Record<string, string> }
): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    const err: HttpError = new Error(`${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Math.round(parseFloat(retryAfter) * 1000);
    const retryDelay = /"retryDelay":\s*"(\d+)s"/.exec(text);
    if (retryDelay?.[1]) err.retryAfterMs = Number(retryDelay[1]) * 1000;
    throw err;
  }
  return JSON.parse(text) as unknown;
}

type GenerateFn = (
  req: GenerateRequest,
  apiKey: string,
  cfg: ProviderConfig
) => Promise<GenerateResponse>;

// ---------- openai-compat ----------

/**
 * 统一走 SSE 流式 (stream: true): 中转/网关 (ALB 60s 硬切断实测) 之下,
 * 非流式长生成必死, 流式连接上持续有数据即可存活。usage 经 stream_options 索取。
 */
const openaiCompat: GenerateFn = async (req, apiKey, cfg) => {
  const baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const baseBody: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    max_tokens: req.maxTokens ?? 8192,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.schema) baseBody.response_format = { type: 'json_object' };
  if (cfg.disableThinking) baseBody.thinking = { type: 'disabled' };

  let body = baseBody;
  // 服务端不识别的字段 (stream_options / thinking) → 400 时逐级降级重试
  let stream: StreamResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    stream = await httpStream(endpoint, headers, body);
    if (!stream.ok && stream.status === 400) {
      const stripped = stripUnknownField(body, stream.errorText);
      if (stripped) {
        body = stripped;
        continue;
      }
    }
    break;
  }
  if (!stream || !stream.ok) {
    const err: HttpError = new Error(`${stream?.status ?? 0} ${stream?.errorText.slice(0, 300) ?? 'no response'}`);
    err.status = stream?.status;
    err.retryAfterMs = stream?.retryAfterMs;
    throw err;
  }
  const events = stream.events;

  let text = '';
  let reasoning = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  for await (const evt of events) {
    if (evt === '[DONE]') break;
    let chunk: {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      chunk = JSON.parse(evt) as typeof chunk;
    } catch {
      continue; // 心跳/噪声帧
    }
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    // 部分思考型模型 (实测 glm-5.3-flash 中转) 把答案全部放进 reasoning_content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (chunk.usage) usage = chunk.usage;
  }

  return {
    text: text.trim().length > 0 ? text : reasoning,
    providerId: cfg.id,
    model: cfg.model,
    usage: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    },
    latencyMs: 0,
  };
};

interface StreamResult {
  ok: boolean;
  status: number;
  errorText: string;
  retryAfterMs?: number;
  events: AsyncIterable<string>;
}

/** 发起 SSE 流式请求; 非 2xx 时读取错误体并返回失败结果 */
async function httpStream(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<StreamResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const errorText = await res.text().catch(() => '');
    const errRes: StreamResult = {
      ok: false,
      status: res.status,
      errorText,
      events: emptyEvents(),
    };
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) errRes.retryAfterMs = Math.round(parseFloat(retryAfter) * 1000);
    const retryDelay = /"retryDelay":\s*"(\d+)s"/.exec(errorText);
    if (retryDelay?.[1]) errRes.retryAfterMs = Number(retryDelay[1]) * 1000;
    return errRes;
  }
  async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data) yield data;
        }
      }
    }
  }
  const reader = res.body.getReader();
  return { ok: true, status: res.status, errorText: '', events: sseEvents(reader) };
}

async function* emptyEvents(): AsyncGenerator<string> {}

/** 服务端 400 且报错点名某字段时, 从请求体剥离该字段 (逐级降级) */
function stripUnknownField(body: Record<string, unknown>, errorText: string): Record<string, unknown> | null {
  const known = new Set(['model', 'messages', 'max_tokens', 'stream', 'response_format']);
  for (const field of Object.keys(body)) {
    if (known.has(field)) continue;
    if (new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(errorText)) {
      const { [field]: _removed, ...rest } = body;
      void _removed;
      return rest;
    }
  }
  return null;
}

// ---------- anthropic ----------

const anthropic: GenerateFn = async (req, apiKey, cfg) => {
  const baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? 8192,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  };
  let data: {
    content?: Array<{ type: string; text?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (req.schema) {
    // tool-use 强制结构化输出
    body.tools = [{ name: 'emit_output', description: '输出本角色的结构化执行结果', input_schema: req.schema }];
    body.tool_choice = { type: 'tool', name: 'emit_output' };
    data = (await httpJson(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })) as typeof data;
    const toolUse = data.content?.find((b) => b.type === 'tool_use');
    return {
      text: JSON.stringify(toolUse?.input ?? {}),
      providerId: cfg.id,
      model: cfg.model,
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      latencyMs: 0,
    };
  }
  data = (await httpJson(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })) as typeof data;
  const text = data.content?.map((b) => b.text ?? '').join('') ?? '';
  return {
    text,
    providerId: cfg.id,
    model: cfg.model,
    usage: {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
    latencyMs: 0,
  };
};

// ---------- gemini ----------

const gemini: GenerateFn = async (req, apiKey, cfg) => {
  const baseUrl = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? 8192,
      ...(req.schema ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const data = (await httpJson(`${baseUrl}/models/${cfg.model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  })) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const usage = data.usageMetadata;
  return {
    text,
    providerId: cfg.id,
    model: cfg.model,
    usage: {
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? (usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0),
    },
    latencyMs: 0,
  };
};

const PROTOCOLS: Record<ProviderConfig['protocol'], GenerateFn> = {
  'openai-compat': openaiCompat,
  anthropic,
  gemini,
};

export interface ChainAttempt {
  providerId: string;
  ok: boolean;
  detail: string;
}

/** 上游模型清单 (GET /models, openai-compat 标准端点; anthropic/gemini 有对应端点) */
export interface UpstreamModels {
  providerId: string;
  models: string[];
  currentModelInList: boolean;
}

/**
 * 模型路由器: 按 modelChain 顺序尝试, 429/5xx 冷却后自动切换下一家;
 * 全链冷却时执行有限轮次的等待重试 (免费/低配额档不再一触即停);
 * 每家 provider 支持客户端 RPM 节流 (rpmLimit, 默认关闭)。
 * 冷却时长取服务端 retry-after / retryDelay, 缺省 60s。
 */
export class ModelRouter {
  private cooldowns = new Map<string, number>();
  private lastCallAt = new Map<string, number>();
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly providers: ProviderConfig[],
    private readonly chain: string[],
    opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.sleepFn = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** 客户端 RPM 节流: 保证同 provider 两次调用间隔 ≥ 60000/rpmLimit ms */
  private async throttle(cfg: ProviderConfig): Promise<void> {
    const rpm = cfg.rpmLimit;
    if (!rpm || rpm <= 0) return;
    const minInterval = 60_000 / rpm;
    const last = this.lastCallAt.get(cfg.id);
    const wait = last ? minInterval - (this.now() - last) : 0;
    if (wait > 0) await this.sleepFn(Math.ceil(wait));
    this.lastCallAt.set(cfg.id, this.now());
  }

  private byId(id: string): ProviderConfig | undefined {
    return this.providers.find((p) => p.id === id);
  }

  private apiKey(cfg: ProviderConfig): string {
    const key = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
    if (!key) throw new Error(`provider "${cfg.id}" 缺少 API Key (设置 ${cfg.apiKeyEnv ?? 'apiKey'})`);
    return key;
  }

  isCoolingDown(id: string): boolean {
    const until = this.cooldowns.get(id);
    return until !== undefined && this.now() < until;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const MAX_WAIT_ROUNDS = 3;
    let lastAttempts: ChainAttempt[] = [];

    for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
      const attempts: ChainAttempt[] = [];
      let sawRateLimit = false;
      let nextReadyAt = Number.POSITIVE_INFINITY;

      for (const id of this.chain) {
        const cfg = this.byId(id);
        if (!cfg) {
          attempts.push({ providerId: id, ok: false, detail: '配置中不存在' });
          continue;
        }
        if (this.isCoolingDown(id)) {
          sawRateLimit = true;
          const until = this.cooldowns.get(id) ?? 0;
          if (until < nextReadyAt) nextReadyAt = until;
          attempts.push({ providerId: id, ok: false, detail: '冷却中 (限频/配额)' });
          continue;
        }
        let key: string;
        try {
          key = this.apiKey(cfg);
        } catch (err) {
          attempts.push({ providerId: id, ok: false, detail: (err as Error).message });
          continue;
        }
        await this.throttle(cfg);
        const started = Date.now();
        try {
          const res = await PROTOCOLS[cfg.protocol].call(null, req, key, cfg);
          res.latencyMs = Date.now() - started;
          this.cooldowns.delete(id);
          return res;
        } catch (err) {
          const e = err as HttpError;
          const is429 = e.status === 429 || /RESOURCE_EXHAUSTED|rate.?limit/i.test(e.message);
          const is5xx = (e.status ?? 0) >= 500;
          if (is429 || is5xx) {
            sawRateLimit = true;
            const cooldownMs = e.retryAfterMs ?? (is5xx ? 30_000 : 60_000);
            const until = this.now() + cooldownMs;
            this.cooldowns.set(id, until);
            if (until < nextReadyAt) nextReadyAt = until;
            attempts.push({ providerId: id, ok: false, detail: `${e.status} 冷却 ${Math.round(cooldownMs / 1000)}s` });
          } else {
            attempts.push({ providerId: id, ok: false, detail: e.message.slice(0, 200) });
          }
        }
      }

      lastAttempts = attempts;

      // 全链处于限频冷却 → 等到最早的冷却结束再试一轮 (有限轮次, 上限单次等待 90s)
      if (sawRateLimit && round < MAX_WAIT_ROUNDS - 1 && nextReadyAt !== Number.POSITIVE_INFINITY) {
        const waitMs = Math.min(Math.max(nextReadyAt - this.now(), 1_000), 90_000);
        await this.sleepFn(waitMs);
        continue;
      }
      break;
    }

    throw new AllProvidersFailedError(
      lastAttempts.map((a) => `${a.providerId}: ${a.detail}`).join(' | ') || '容灾链为空'
    );
  }

  /**
   * 获取上游模型列表 (vat models 命令 / 未来配置界面的数据源)。
   * openai-compat: GET {baseUrl}/models · anthropic: GET /v1/models · gemini: GET {base}/models
   */
  async listModels(providerId?: string): Promise<UpstreamModels[]> {
    const ids = providerId ? [providerId] : this.chain;
    const out: UpstreamModels[] = [];
    for (const id of ids) {
      const cfg = this.byId(id);
      if (!cfg) {
        out.push({ providerId: id, models: [], currentModelInList: false });
        continue;
      }
      const key = this.apiKey(cfg);
      const models = await this.fetchModelList(cfg, key);
      out.push({
        providerId: id,
        models,
        currentModelInList: models.includes(cfg.model),
      });
    }
    return out;
  }

  private async fetchModelList(cfg: ProviderConfig, key: string): Promise<string[]> {
    if (cfg.protocol === 'openai-compat') {
      const baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const data = (await httpJson(`${baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      })) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
    }
    if (cfg.protocol === 'anthropic') {
      const baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
      const data = (await httpJson(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      })) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
    }
    // gemini
    const baseUrl = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const data = (await httpJson(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
    })) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
  }

  /** vat doctor: 逐个探测模型可用性 */
  async probe(req: GenerateRequest): Promise<ChainAttempt[]> {
    const out: ChainAttempt[] = [];
    for (const id of this.chain) {
      const cfg = this.byId(id);
      if (!cfg) {
        out.push({ providerId: id, ok: false, detail: '配置中不存在' });
        continue;
      }
      try {
        const key = this.apiKey(cfg);
        await PROTOCOLS[cfg.protocol].call(
          null,
          { system: 'ping', user: 'Reply with the single word: pong', maxTokens: 16 },
          key,
          cfg
        );
        out.push({ providerId: id, ok: true, detail: cfg.model });
      } catch (err) {
        out.push({ providerId: id, ok: false, detail: (err as Error).message.slice(0, 200) });
      }
    }
    return out;
  }
}
