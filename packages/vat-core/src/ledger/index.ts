// Token 账本 (架构设计 §6.5): 逐次追加 JSONL, 只记录真实调用
import fs from 'node:fs';
import path from 'node:path';
import type { LedgerEntry } from '../types.js';

export function appendLedger(ledgerFile: string, entry: LedgerEntry): void {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n', 'utf8');
}

export function readLedgerDay(ledgerFile: string): LedgerEntry[] {
  if (!fs.existsSync(ledgerFile)) return [];
  const out: LedgerEntry[] = [];
  for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // 损坏行跳过 (进程中途被杀可能留下半行)
    }
  }
  return out;
}

export interface UsageSummary {
  totalTokens: number;
  billableTokens: number; // 预算口径: 排除 scripted/strict-runner
  calls: number;
  byRole: Record<string, number>;
  byCard: Record<string, number>;
}

/** 汇总某日账本; budgetOnly=true 时仅统计计入预算的真实 LLM 调用 */
export function summarize(entries: LedgerEntry[], budgetOnly = false): UsageSummary {
  const sum: UsageSummary = {
    totalTokens: 0,
    billableTokens: 0,
    calls: 0,
    byRole: {},
    byCard: {},
  };
  for (const e of entries) {
    sum.totalTokens += e.totalTokens;
    sum.calls += 1;
    sum.byRole[e.role] = (sum.byRole[e.role] ?? 0) + e.totalTokens;
    sum.byCard[e.card] = (sum.byCard[e.card] ?? 0) + e.totalTokens;
    if (!budgetOnly || e.source === 'llm') {
      sum.billableTokens += e.totalTokens;
    }
  }
  return sum;
}

export function todayKey(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
