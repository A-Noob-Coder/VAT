// Hub 事件流 (架构设计 §6.6): 追加式 JSONL 审计日志, Dashboard 的数据源
import fs from 'node:fs';
import path from 'node:path';
import type { HubEvent, HubEventType } from '../types.js';

export function appendEvent(
  eventsFile: string,
  evt: {
    type: HubEventType;
    severity?: HubEvent['severity'];
    role?: string;
    card?: string;
    ticket?: string;
    message: string;
  },
  now = new Date()
): HubEvent {
  const event: HubEvent = {
    ts: now.toISOString(),
    type: evt.type,
    severity: evt.severity ?? 'info',
    role: evt.role,
    card: evt.card,
    ticket: evt.ticket,
    message: evt.message,
  };
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n', 'utf8');
  return event;
}

export function readEvents(eventsFile: string): HubEvent[] {
  if (!fs.existsSync(eventsFile)) return [];
  const out: HubEvent[] = [];
  for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HubEvent);
    } catch {
      // 半行忽略 (崩溃安全)
    }
  }
  return out;
}
