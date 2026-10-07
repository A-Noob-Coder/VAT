// Dashboard API 客户端: 只读投影 + 卡点裁决
export type CardStatus = 'backlog' | 'ready' | 'developing' | 'review' | 'testing' | 'done';

export interface CardDto {
  id: string;
  title: string;
  status: CardStatus;
  frozen: boolean;
  frozen_reason?: string;
  owner: string;
  priority: 'P0' | 'P1' | 'P2';
  rejection_count: number;
  self_repair_count: number;
  checkpoints_passed: string[];
  checkpoint?: { stage: string; since: string };
  ticket_chain: string[];
  deliverables: Array<{
    title: string;
    type: string;
    source: string;
    role: string;
    path: string;
    timestamp: string;
  }>;
  token_used: number;
  created_at: string;
  updated_at: string;
  body: string;
}

export interface EventDto {
  ts: string;
  type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  role?: string;
  card?: string;
  ticket?: string;
  message: string;
}

export interface StateDto {
  root: string;
  day: string;
  charter: {
    roles: Array<{ id: string; title: string }>;
    checkpoints: { requirement_approval: boolean; release_approval: boolean };
    breaker: { max_rejections: number };
    budget: { daily_token_limit: number; per_card_token_limit: number };
    strict: { max_dev_self_repair?: number } | null;
  };
  cards: CardDto[];
  roles: Array<{ id: string; title: string; pending: number }>;
  ledger: {
    day: string;
    calls: number;
    totalTokens: number;
    billableTokens: number;
    byRole: Record<string, number>;
    byCard: Record<string, number>;
    dailyLimit: number;
  };
  days: string[];
}

/** 配置中心: vat.config.json + 章程 frontmatter (data) 与正文 (body) */
export interface ConfigDto {
  config: Record<string, unknown>;
  charter: {
    data: Record<string, unknown>;
    body: string;
  };
}

async function post(action: string, body: object): Promise<void> {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export const api = {
  async state(day?: string | null): Promise<StateDto> {
    const res = await fetch(`/api/state${day ? `?day=${day}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as StateDto;
  },
  approve(cardId: string, stage: string, note?: string) {
    return post('approve', { cardId, stage, note });
  },
  reject(cardId: string, stage: string, note: string) {
    return post('reject', { cardId, stage, note });
  },
  resume(cardId: string, point: string, note: string) {
    return post('resume', { cardId, point, note });
  },
  req(title: string, body: string, priority: string) {
    return post('req', { title, body, priority });
  },
  async config(): Promise<ConfigDto> {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ConfigDto;
  },
  saveConfig(payload: { config?: Record<string, unknown>; charterData?: Record<string, unknown> }) {
    return post('config', payload);
  },
};

/** SSE 订阅: 返回取消函数; 断线由 EventSource 自动重连 */
export function openStream(day: string, onMessage: (msg: StreamMessage) => void): () => void {
  const es = new EventSource(`/api/events?day=${day}`);
  es.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as StreamMessage);
    } catch {
      // 忽略坏帧
    }
  };
  return () => es.close();
}

export type StreamMessage =
  | { kind: 'hello'; day: string }
  | { kind: 'batch' | 'append'; events: EventDto[] }
  | { kind: 'state_dirty' };
