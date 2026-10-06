// 卡片文件 IO (board/CARD-xxxx.md, frontmatter + 需求正文) (架构设计 §5.3)
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Card, CardStatus, Priority } from '../types.js';

export class CardError extends Error {}

export function serializeCard(card: Card): string {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    body,
    ...meta
  } = card;
  const fm = YAML.stringify(meta);
  return `---\n${fm}---\n\n${card.body}\n`;
}

export function parseCard(fileName: string, content: string): Card {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match || !match[1]) throw new CardError(`卡片 ${fileName} 缺少 frontmatter`);
  const meta = YAML.parse(match[1]) as Record<string, unknown>;
  for (const key of ['id', 'title', 'status', 'owner']) {
    if (meta[key] === undefined) throw new CardError(`卡片 ${fileName} frontmatter 缺少 ${key}`);
  }
  return {
    id: String(meta.id),
    title: String(meta.title),
    status: meta.status as CardStatus,
    frozen: Boolean(meta.frozen ?? false),
    frozen_reason: meta.frozen_reason ? String(meta.frozen_reason) : undefined,
    owner: String(meta.owner),
    priority: (meta.priority as Priority) ?? 'P1',
    rejection_count: Number(meta.rejection_count ?? 0),
    self_repair_count: Number(meta.self_repair_count ?? 0),
    checkpoints_passed: (meta.checkpoints_passed as string[]) ?? [],
    checkpoint: (meta.checkpoint as Card['checkpoint']) ?? undefined,
    ticket_chain: (meta.ticket_chain as string[]) ?? [],
    deliverables: (meta.deliverables as Card['deliverables']) ?? [],
    token_used: Number(meta.token_used ?? 0),
    created_at: String(meta.created_at ?? ''),
    updated_at: String(meta.updated_at ?? ''),
    body: (match[2] ?? '').trim(),
  };
}

export function loadCard(paths: { cardFile(cardId: string): string }, cardId: string): Card {
  const file = paths.cardFile(cardId);
  if (!fs.existsSync(file)) throw new CardError(`卡片不存在: ${cardId}`);
  return parseCard(path.basename(file), fs.readFileSync(file, 'utf8'));
}

export function saveCard(paths: { cardFile(cardId: string): string }, card: Card): void {
  fs.mkdirSync(paths.cardFile(card.id).replace(/[^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(paths.cardFile(card.id), serializeCard(card), 'utf8');
}

/** 生成下一张卡片 id: 扫描 board/ 取最大序号 +1 */
export function nextCardId(boardDir: string): string {
  let max = 0;
  if (fs.existsSync(boardDir)) {
    for (const name of fs.readdirSync(boardDir)) {
      const match = /^CARD-(\d+)\.md$/.exec(name);
      if (match?.[1]) max = Math.max(max, Number(match[1]));
    }
  }
  return `CARD-${String(max + 1).padStart(4, '0')}`;
}

export function listCards(boardDir: string): Card[] {
  if (!fs.existsSync(boardDir)) return [];
  const cards: Card[] = [];
  for (const name of fs.readdirSync(boardDir).sort()) {
    if (!/^CARD-\d+\.md$/.test(name)) continue;
    cards.push(parseCard(name, fs.readFileSync(path.join(boardDir, name), 'utf8')));
  }
  return cards;
}

/** 在卡片正文追加一节裁决/事件记录 */
export function appendCardBody(card: Card, heading: string, text: string): Card {
  return { ...card, body: `${card.body}\n\n## ${heading}\n\n${text}\n` };
}
