// VAT 核心领域类型 (架构设计 §5 核心协议)

export type CardStatus = 'backlog' | 'ready' | 'developing' | 'review' | 'testing' | 'done';

export type TicketType = 'requirement' | 'task' | 'review' | 'defect' | 'return' | 'notify';

export type OutputSource = 'llm' | 'strict-runner' | 'scripted' | 'human';

export type ExecutionMode = 'draft' | 'strict' | 'simulation';

export type Priority = 'P0' | 'P1' | 'P2';

export type CheckpointStage = 'requirement_approval' | 'release_approval';

export type ResumePoint = 'developing' | 'review' | 'redesign';

// ---------- 章程 (agent.md frontmatter) ----------

export interface CharterRole {
  id: string; // PM / DEV / REVIEW / QA / OPS ...
  title: string;
  responsibilities: string;
  consumes: TicketType[];
}

export interface CharterData {
  version: number;
  team: { roles: CharterRole[] };
  pipeline: { statuses: CardStatus[] };
  checkpoints: { requirement_approval: boolean; release_approval: boolean };
  circuit_breaker: { max_rejections: number };
  budget: { daily_token_limit: number; per_card_token_limit: number };
  execution: {
    default_mode: ExecutionMode;
    strict?: {
      tsc?: boolean;
      vitest?: boolean;
      docker_build?: 'auto' | 'off';
      max_dev_self_repair?: number;
      install?: 'auto' | 'always' | 'never';
    };
  };
}

export interface Charter {
  data: CharterData;
  body: string; // 正文 (注入角色 prompt 的自然语言规范)
}

// ---------- 单据 ----------

export interface Ticket {
  id: string; // tkt_YYYYMMDD_HHmmss_seq
  from: string;
  to: string;
  type: TicketType;
  card: string;
  version: number;
  seq: number;
  source: OutputSource;
  created_at: string; // ISO
  title: string;
  body: string;
  fileName: string;
}

export interface OutgoingTicketDraft {
  to: string;
  type: TicketType;
  title: string;
  body: string;
}

// ---------- 卡片 ----------

export type DeliverableType = 'spec' | 'code' | 'review' | 'test' | 'config';

export interface CardDeliverableRef {
  title: string;
  type: DeliverableType;
  source: OutputSource;
  role: string;
  path: string; // 相对工作区根
  timestamp: string;
}

export interface Card {
  id: string; // CARD-0001
  title: string;
  status: CardStatus;
  frozen: boolean;
  frozen_reason?: string;
  owner: string;
  priority: Priority;
  rejection_count: number;
  self_repair_count: number;
  checkpoints_passed: string[];
  checkpoint?: { stage: CheckpointStage; since: string };
  ticket_chain: string[];
  deliverables: CardDeliverableRef[];
  token_used: number;
  created_at: string;
  updated_at: string;
  body: string; // 需求原文 + 裁决记录
}

// ---------- 记忆 ----------

export interface MemoryDecision {
  id: string;
  title: string;
  rationale: string;
  timestamp: string;
}

export interface MemoryLesson {
  id: string;
  issue: string;
  avoidance: string;
  timestamp: string;
}

export interface MemorySnapshot {
  summary: string;
  decisions: MemoryDecision[];
  lessons: MemoryLesson[];
}

export interface MemoryUpdates {
  summaryUpdate?: string;
  newDecision?: { title: string; rationale: string };
  newLesson?: { issue: string; avoidance: string };
}

// ---------- 执行器 (架构设计 §7) ----------

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RoleOutput {
  thought: string;
  action: string;
  tickets: OutgoingTicketDraft[];
  memoryUpdates?: MemoryUpdates;
  deliverable?: { title: string; type: DeliverableType; content: string };
  codeFiles?: Array<{ path: string; content: string }>; // strict 模式使用 (M2)
  statusSuggestion?: CardStatus; // 仅建议, Hub 依矩阵裁决
}

export interface ExecutorResult {
  output: RoleOutput;
  source: OutputSource;
  usage?: UsageInfo;
  providerId?: string;
  model?: string;
  latencyMs?: number;
}

export interface RoleContext {
  role: CharterRole;
  charter: Charter;
  ticket: Ticket;
  card?: Card;
  memory: MemorySnapshot;
  mode: ExecutionMode;
}

export interface RoleExecutor {
  readonly kind: 'llm' | 'scripted' | 'cli';
  run(ctx: RoleContext): Promise<ExecutorResult>;
}

// 模型调用端口 (由 vat-providers 实现, 依赖倒置保持 core 无网络依赖)
export interface ModelClient {
  generate(req: {
    system: string;
    user: string;
    schema?: unknown;
    maxTokens?: number;
  }): Promise<{
    text: string;
    providerId: string;
    model: string;
    usage: UsageInfo;
    latencyMs: number;
  }>;
}

// ---------- strict 闸门端口 (由 vat-strict 实现, 依赖倒置) ----------

export interface StrictStep {
  name: string; // scaffold | install | tsc | vitest | docker
  status: 'ok' | 'fail' | 'skipped';
  durationMs: number;
  summary: string;
  detail?: string; // 已截断的真实输出 (stderr / 测试 JSON)
}

export interface StrictReport {
  ok: boolean;
  summary: string;
  projectDir: string;
  steps: StrictStep[];
  tests: { total: number; passed: number; failed: number } | null;
}

export interface StrictGatePort {
  runGate(input: { cardId: string; projectDir: string }): Promise<StrictReport>;
}

export const DEFAULT_MAX_DEV_SELF_REPAIR = 2;

// ---------- Hub 事件流 ----------

export type HubEventType =
  | 'system'
  | 'ticket_arrival'
  | 'role_wake'
  | 'role_complete'
  | 'status_change'
  | 'circuit_break'
  | 'budget_break'
  | 'checkpoint_wait'
  | 'human_action'
  | 'dead_letter'
  | 'warning';

export interface HubEvent {
  ts: string;
  type: HubEventType;
  severity: 'info' | 'success' | 'warning' | 'error';
  role?: string;
  card?: string;
  ticket?: string;
  message: string;
}

// ---------- 账本 ----------

export interface LedgerEntry {
  ts: string;
  role: string;
  card: string;
  ticket: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  source: OutputSource;
}

// ---------- 配置 (vat.config.json) ----------

export interface ProviderConfig {
  id: string;
  protocol: 'openai-compat' | 'anthropic' | 'gemini';
  baseUrl?: string; // openai-compat 必填; anthropic/gemini 可覆盖默认端点
  apiKeyEnv?: string; // 从该环境变量读 key (推荐)
  apiKey?: string; // 直接内联 (不推荐)
  model: string;
  rpmLimit?: number; // 预留: 客户端限速
}

export interface ModelMemorySettings {
  summaryWarnChars: number;
  decisionWindow: number;
  lessonWindow: number;
}

export interface VatConfig {
  providers?: ProviderConfig[];
  modelChain?: string[];
  /** 角色 → 模型通道: 填 provider id (单模型) 或 provider id 数组 (角色级容灾链)。
   *  缺省 (未配置该角色) 时回退到全局 modelChain。用于让不同角色走各自擅长的模型 API。 */
  roleModels?: Record<string, string | string[]>;
  modelSettings?: Record<string, { memory?: Partial<ModelMemorySettings> }>;
  git?: { autocommit?: boolean };
  hub?: { maxConcurrentCards?: number };
}

export const DEFAULT_MEMORY_SETTINGS: ModelMemorySettings = {
  summaryWarnChars: 4000,
  decisionWindow: 20,
  lessonWindow: 30,
};
