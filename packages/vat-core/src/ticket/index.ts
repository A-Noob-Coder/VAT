// 单据协议: frontmatter + 正文, 五元素命名, seq 防冲突 (架构设计 §5.2)
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { OutputSource, Ticket, TicketType } from '../types.js';

export class TicketError extends Error {}

const TICKET_TYPES: TicketType[] = ['requirement', 'task', 'review', 'defect', 'return', 'notify'];

export interface TicketMetaInput {
  from: string;
  to: string;
  type: TicketType;
  card: string;
  version?: number;
  source: OutputSource;
  title: string;
  body: string;
  now: Date;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

export function stamp(d: Date): { day: string; time: string; iso: string } {
  return {
    day: `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`,
    time: `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`,
    iso: d.toISOString(),
  };
}

export function ticketId(meta: TicketMetaInput, seq: number): string {
  const { day, time } = stamp(meta.now);
  return `tkt_${day}_${time}_${pad(seq, 3)}`;
}

export function ticketFileName(meta: TicketMetaInput, seq: number): string {
  const { day, time } = stamp(meta.now);
  return `${meta.from}-${meta.to}-${meta.type}-${day}-${time}-${pad(seq, 3)}.md`;
}

export function serializeTicket(t: Ticket): string {
  const fm = YAML.stringify({
    id: t.id,
    from: t.from,
    to: t.to,
    type: t.type,
    card: t.card,
    version: t.version,
    seq: t.seq,
    source: t.source,
    created_at: t.created_at,
    title: t.title,
  });
  return `---\n${fm}---\n\n${t.body}\n`;
}

export function parseTicket(fileName: string, content: string): Ticket {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match || !match[1]) throw new TicketError(`单据 ${fileName} 缺少 frontmatter`);
  const meta = YAML.parse(match[1]) as Record<string, unknown>;
  for (const key of ['id', 'from', 'to', 'type', 'card', 'seq', 'created_at']) {
    if (meta[key] === undefined) throw new TicketError(`单据 ${fileName} frontmatter 缺少 ${key}`);
  }
  if (!TICKET_TYPES.includes(meta.type as TicketType)) {
    throw new TicketError(`单据 ${fileName} 类型非法: ${meta.type}`);
  }
  return {
    id: String(meta.id),
    from: String(meta.from),
    to: String(meta.to),
    type: meta.type as TicketType,
    card: String(meta.card),
    version: Number(meta.version ?? 1),
    seq: Number(meta.seq),
    source: (meta.source as OutputSource) ?? 'human',
    created_at: String(meta.created_at),
    title: String(meta.title ?? fileName),
    body: (match[2] ?? '').trim(),
    fileName,
  };
}

export function createTicket(meta: TicketMetaInput, seq: number): Ticket {
  return {
    id: ticketId(meta, seq),
    from: meta.from,
    to: meta.to,
    type: meta.type,
    card: meta.card,
    version: meta.version ?? 1,
    seq,
    source: meta.source,
    created_at: stamp(meta.now).iso,
    title: meta.title,
    body: meta.body,
    fileName: ticketFileName(meta, seq),
  };
}

/** 写入角色收件箱 */
export function deliverTicket(paths: { mailboxIn(roleId: string): string }, ticket: Ticket): string {
  const dir = paths.mailboxIn(ticket.to);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ticket.fileName);
  if (fs.existsSync(file)) {
    throw new TicketError(`单据文件名冲突: ${ticket.fileName} (seq 分配异常)`);
  }
  fs.writeFileSync(file, serializeTicket(ticket), 'utf8');
  return file;
}

/** 扫描收件箱顶层所有单据 (位置即状态: in/ = 待处理) */
export function scanInbox(inboxDir: string): Ticket[] {
  if (!fs.existsSync(inboxDir)) return [];
  const tickets: Ticket[] = [];
  for (const name of fs.readdirSync(inboxDir).sort()) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(inboxDir, name);
    if (!fs.statSync(file).isFile()) continue;
    try {
      tickets.push(parseTicket(name, fs.readFileSync(file, 'utf8')));
    } catch (err) {
      // 结构损坏的单据交由调用方死信处理; 这里带文件名抛出以便定位
      throw new TicketError(`${(err as Error).message}`);
    }
  }
  return tickets;
}

/**
 * Seq 分配器: 同一分钟内自增, 由目录中已有文件名播种, 防止同名冲突。
 */
export class SeqAllocator {
  private counters = new Map<string, number>();

  seedFromDirectories(dirs: string[]): void {
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const match = /-(\d{8})-(\d{6})-(\d{3})\.md$/.exec(name);
        if (!match?.[1] || !match[2] || !match[3]) continue;
        const key = `${match[1]}-${match[2].slice(0, 4)}`; // YYYYMMDD-HHmm (到分钟)
        const seq = Number(match[3]);
        this.counters.set(key, Math.max(this.counters.get(key) ?? 0, seq));
      }
    }
  }

  next(now: Date): number {
    const { day, time } = stamp(now);
    const key = `${day}-${time.slice(0, 4)}`; // 到分钟
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
}
