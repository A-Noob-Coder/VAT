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

/** 工作区路径投影 */
export interface PathsDto {
  root: string;
  paths: Record<string, string>;
}

/** 图谱投影: 席位环绕项目的知识图谱 (节点 + 流转边 + 工件) */
export interface GraphDto {
  cards: Array<{ id: string; title: string; status: CardStatus; checkpoint: { stage: string; since: string } | null }>;
  card: {
    id: string;
    title: string;
    status: CardStatus;
    owner: string;
    frozen: boolean;
    checkpoint: { stage: string; since: string } | null;
    checkpoints_passed: string[];
  } | null;
  seats: Array<{ id: string; title: string; pending: number; active: boolean; isOwner: boolean }>;
  checkpoints: Array<{ id: string; label: string; enabled: boolean; passed: boolean; waiting: boolean }>;
  artifacts: Array<{ id: string; label: string; role: string; edgeKey: string }>;
  edges: Array<{
    from: string;
    to: string;
    label: string;
    count: number;
    lastAt: string;
    kind: 'flow' | 'feedback';
    active: boolean;
  }>;
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

async function postJson<T>(action: string, body: object): Promise<T> {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
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
  /** 工作区各文件落盘路径 */
  async paths(): Promise<PathsDto> {
    const res = await fetch('/api/paths');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PathsDto;
  },
  /** 图谱投影 (默认聚焦当前活跃卡片) */
  async graph(cardId?: string | null): Promise<GraphDto> {
    const qs = cardId ? `?card=${encodeURIComponent(cardId)}` : '';
    const res = await fetch(`/api/graph${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as GraphDto;
  },
  /** 切换服务端工作区到另一项目目录 */
  switchProject(dir: string) {
    return post('project/switch', { dir });
  },
  /** 测试发送一条通知到指定通道 */
  testNotify(channel: Record<string, unknown>) {
    return postJson<{ ok: boolean; sent: string[]; failed: Array<{ id: string; error: string }> }>(
      'config/test-notify',
      { channel }
    );
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
