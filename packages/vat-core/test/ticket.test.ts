// 单据协议测试: 五元素命名 / seq 防冲突 / 序列化往返 / 死信位置语义
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SeqAllocator,
  createTicket,
  parseTicket,
  serializeTicket,
  ticketFileName,
} from '../src/index.js';

const NOW = () => new Date(2026, 9, 6, 9, 30, 0);

function meta(type = 'task') {
  return {
    from: 'PM',
    to: 'DEV',
    type: type as 'task',
    card: 'CARD-0001',
    source: 'llm' as const,
    title: '[开发任务] 限流器',
    body: '实现令牌桶',
    now: NOW(),
  };
}

describe('单据命名协议', () => {
  it('五元素命名: <from>-<to>-<type>-<day>-<time>-<seq>.md', () => {
    const t = createTicket(meta(), 1);
    expect(t.fileName).toBe('PM-DEV-task-20261006-093000-001.md');
    expect(t.id).toBe('tkt_20261006_093000_001');
  });

  it('同分钟多单据由 seq 保证唯一 (v0.1 同名冲突回归)', () => {
    const a = createTicket(meta(), 1);
    const b = createTicket(meta(), 2);
    const c = createTicket(meta('review'), 3);
    expect(new Set([a.fileName, b.fileName, c.fileName]).size).toBe(3);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });
});

describe('序列化往返', () => {
  it('serialize → parse 字段无损', () => {
    const t = createTicket(meta(), 7);
    const parsed = parseTicket(t.fileName, serializeTicket(t));
    expect(parsed).toEqual(t);
  });

  it('缺 frontmatter 抛错', () => {
    expect(() => parseTicket('x.md', '没有 frontmatter 的正文')).toThrow(/frontmatter/);
  });

  it('frontmatter 缺关键字段抛错', () => {
    const bad = '---\nid: tkt_x\nfrom: PM\n---\n\n正文';
    expect(() => parseTicket('x.md', bad)).toThrow(/缺少/);
  });

  it('非法类型抛错', () => {
    const bad = '---\nid: t\ntype: gossip\ncard: CARD-0001\nfrom: A\nto: B\nseq: 1\ncreated_at: x\n---\n\nx';
    expect(() => parseTicket('x.md', bad)).toThrow(/类型非法/);
  });
});

describe('SeqAllocator', () => {
  it('从已有文件名播种, 续接序号不冲突', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-seed-'));
    try {
      fs.writeFileSync(path.join(dir, 'PM-DEV-task-20261006-093000-005.md'), '');
      const alloc = new SeqAllocator();
      alloc.seedFromDirectories([dir]);
      expect(alloc.next(NOW())).toBe(6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跨分钟重新计数', () => {
    const alloc = new SeqAllocator();
    expect(alloc.next(new Date(2026, 9, 6, 9, 30, 0))).toBe(1);
    expect(alloc.next(new Date(2026, 9, 6, 9, 30, 30))).toBe(2);
    expect(alloc.next(new Date(2026, 9, 6, 9, 31, 0))).toBe(1); // 新分钟
  });

  it('ticketFileName 与 createTicket 一致', () => {
    expect(ticketFileName(meta(), 1)).toBe(createTicket(meta(), 1).fileName);
  });
});
