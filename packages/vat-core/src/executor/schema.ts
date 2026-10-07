// RoleOutput 的机器校验 (Hub 信任边界: LLM 产出必须过校验才能落盘)
import type { CardStatus, DeliverableType, RoleOutput, TicketType } from '../types.js';

const TICKET_TYPES: TicketType[] = ['requirement', 'task', 'review', 'defect', 'return', 'notify'];
const DELIVERABLE_TYPES: DeliverableType[] = ['spec', 'code', 'review', 'test', 'config'];
const STATUSES: CardStatus[] = ['backlog', 'ready', 'developing', 'review', 'testing', 'done'];

export type ValidateResult =
  | { ok: true; value: RoleOutput }
  | { ok: false; error: string };

/** 从模型原始文本提取 JSON (容忍代码围栏、<think>/推理流噪声与前后缀文本) */
export function extractJson(text: string): unknown {
  // 推理型模型 (deepseek-reasoner 等) 会在正文输出 <think>...</think>, 先剥离; 再去 BOM/零宽字符
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\ufeff\u200b-\u200f\u202a-\u202e]+/, '')
    .trim();

  // 候选优先级 (关键: 裸 JSON 优先, 围栏候选靠后 —
  // 否则信封 body 里的 markdown ``` 代码块会被误当围栏劫持提取)
  const attempts: string[] = [];
  // 1) 整段即 JSON (最常见: 裸信封, 无围栏无前后缀)
  attempts.push(cleaned);
  // 2) 首 { 到末 } 切片 (信封内含 ``` 代码块时依旧正确)
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(cleaned.slice(start, end + 1));
  // 3) 围栏候选: 非贪婪逐个 + 贪婪外层, 都从后往前试
  const fenceCandidates: string[] = [];
  for (const m of cleaned.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    fenceCandidates.push(m[1] ?? '');
  }
  const outer = /```(?:json)?\s*\n?([\s\S]*)```/.exec(cleaned);
  if (outer?.[1]) fenceCandidates.push(outer[1]);
  for (const f of fenceCandidates.reverse()) {
    const s = f.indexOf('{');
    const e = f.lastIndexOf('}');
    if (s !== -1 && e > s) attempts.push(f.slice(s, e + 1));
  }

  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      try {
        return JSON.parse(repairJson(a));
      } catch {
        /* 下一个候选 */
      }
    }
  }

  // 思考型模型路径: 输出流是自由思考, 最终 JSON 信封在"最后一个完整顶层对象"处 —
  // 从后往前逐个尝试顶层 {} 跨度 (粗暴的首 { 到末 } 切片会被思考中的代码污染)
  const spans = topLevelObjectSpans(cleaned);
  for (let i = spans.length - 1; i >= 0; i--) {
    const spanIndex = spans[i];
    if (!spanIndex) continue;
    const span = cleaned.slice(spanIndex[0], spanIndex[1] + 1);
    try {
      return JSON.parse(span);
    } catch {
      try {
        return JSON.parse(repairJson(span));
      } catch {
        continue;
      }
    }
  }

  throw new Error('输出中未找到 JSON 对象');
}

/** 扫描出所有完整顶层 {} 跨度 (字符串感知, 容忍 // 行注释) */
function topLevelObjectSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push([start, i]);
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return spans;
}

/** 最小 JSON 修复: 字符串内裸换行/制表符转义、去尾随逗号、去 // 行注释 */
export function repairJson(src: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      // 裸控制字符 (LLM 把多行代码直接塞进字符串字段的典型病) → 合法转义
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === ',') {
      // 向后看第一个非空白字符, 是 } 或 ] 则为尾随逗号 → 跳过
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j] ?? '')) j++;
      if (src[j] === '}' || src[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

export function validateRoleOutput(raw: unknown): ValidateResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '输出不是对象' };
  const obj = raw as Record<string, unknown>;

  if (typeof obj.thought !== 'string' || obj.thought.length === 0) {
    return { ok: false, error: '缺少 thought (字符串)' };
  }
  if (typeof obj.action !== 'string' || obj.action.length === 0) {
    return { ok: false, error: '缺少 action (字符串)' };
  }

  const ticketsRaw = obj.tickets;
  if (!Array.isArray(ticketsRaw)) return { ok: false, error: 'tickets 必须是数组 (可为空)' };
  const tickets = [];
  for (let i = 0; i < ticketsRaw.length; i++) {
    const t = ticketsRaw[i] as Record<string, unknown>;
    if (typeof t?.to !== 'string' || t.to.length === 0) {
      return { ok: false, error: `tickets[${i}].to 缺失` };
    }
    if (!TICKET_TYPES.includes(t.type as TicketType)) {
      return { ok: false, error: `tickets[${i}].type 非法: ${String(t.type)}` };
    }
    if (typeof t?.title !== 'string' || typeof t?.body !== 'string') {
      return { ok: false, error: `tickets[${i}] 缺少 title/body` };
    }
    tickets.push({
      to: t.to,
      type: t.type as TicketType,
      title: t.title.slice(0, 200),
      body: t.body,
    });
  }

  let memoryUpdates: RoleOutput['memoryUpdates'];
  if (obj.memoryUpdates && typeof obj.memoryUpdates === 'object') {
    const mu = obj.memoryUpdates as Record<string, unknown>;
    memoryUpdates = {};
    if (mu.summaryUpdate !== undefined && mu.summaryUpdate !== null) {
      if (typeof mu.summaryUpdate !== 'string') return { ok: false, error: 'memoryUpdates.summaryUpdate 须为字符串' };
      memoryUpdates.summaryUpdate = mu.summaryUpdate;
    }
    if (mu.newDecision && typeof mu.newDecision === 'object') {
      const d = mu.newDecision as Record<string, unknown>;
      if (typeof d.title !== 'string' || typeof d.rationale !== 'string') {
        return { ok: false, error: 'memoryUpdates.newDecision 须含 title/rationale 字符串' };
      }
      memoryUpdates.newDecision = { title: d.title, rationale: d.rationale };
    }
    if (mu.newLesson && typeof mu.newLesson === 'object') {
      const l = mu.newLesson as Record<string, unknown>;
      if (typeof l.issue !== 'string' || typeof l.avoidance !== 'string') {
        return { ok: false, error: 'memoryUpdates.newLesson 须含 issue/avoidance 字符串' };
      }
      memoryUpdates.newLesson = { issue: l.issue, avoidance: l.avoidance };
    }
  }

  let deliverable: RoleOutput['deliverable'];
  if (obj.deliverable && typeof obj.deliverable === 'object') {
    const d = obj.deliverable as Record<string, unknown>;
    if (typeof d.title !== 'string' || typeof d.content !== 'string') {
      return { ok: false, error: 'deliverable 须含 title/content 字符串' };
    }
    const dtype = (d.type ?? 'spec') as DeliverableType;
    if (!DELIVERABLE_TYPES.includes(dtype)) {
      return { ok: false, error: `deliverable.type 非法: ${String(d.type)}` };
    }
    deliverable = { title: d.title, type: dtype, content: d.content };
  }

  let codeFiles: RoleOutput['codeFiles'];
  if (Array.isArray(obj.codeFiles) && obj.codeFiles.length > 0) {
    codeFiles = [];
    for (let i = 0; i < obj.codeFiles.length; i++) {
      const f = obj.codeFiles[i] as Record<string, unknown>;
      if (typeof f?.path !== 'string' || typeof f?.content !== 'string') {
        return { ok: false, error: `codeFiles[${i}] 须含 path/content 字符串` };
      }
      if (f.path.includes('..')) return { ok: false, error: `codeFiles[${i}].path 禁止路径穿越` };
      codeFiles.push({ path: f.path, content: f.content });
    }
  }

  let statusSuggestion: CardStatus | undefined;
  if (typeof obj.statusSuggestion === 'string') {
    if (!STATUSES.includes(obj.statusSuggestion as CardStatus)) {
      return { ok: false, error: `statusSuggestion 非法: ${obj.statusSuggestion}` };
    }
    statusSuggestion = obj.statusSuggestion as CardStatus;
  }

  return {
    ok: true,
    value: { thought: obj.thought, action: obj.action, tickets, memoryUpdates, deliverable, codeFiles, statusSuggestion },
  };
}

/** 供各协议 adapter 使用的 JSON Schema (Gemini responseSchema / Anthropic tool-use) */
export const ROLE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string' },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '目标角色 ID, 如 DEV/REVIEW/QA/PM/OPS' },
          type: { type: 'string', enum: [...TICKET_TYPES] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'type', 'title', 'body'],
      },
    },
    memoryUpdates: {
      type: 'object',
      properties: {
        summaryUpdate: { type: 'string' },
        newDecision: {
          type: 'object',
          properties: { title: { type: 'string' }, rationale: { type: 'string' } },
          required: ['title', 'rationale'],
        },
        newLesson: {
          type: 'object',
          properties: { issue: { type: 'string' }, avoidance: { type: 'string' } },
          required: ['issue', 'avoidance'],
        },
      },
    },
    deliverable: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: [...DELIVERABLE_TYPES] },
        content: { type: 'string' },
      },
      required: ['title', 'type', 'content'],
    },
    statusSuggestion: { type: 'string', enum: [...STATUSES] },
  },
  required: ['thought', 'action', 'tickets'],
} as const;
