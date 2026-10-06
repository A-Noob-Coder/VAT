// Dashboard 服务端集成测试: 状态投影 / 动作校验 / SSE 流 (真实 HTTP, 端口 0)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { startDashboardServer, type DashboardServerHandle } from '../src/dashboard-server.js';
import { Hub, loadCard, saveCard, ScriptedExecutor, type Card } from '@vat/core';
import { FIXED_NOW, makeWorkspace, type makeWorkspace as MakeWorkspace } from './helpers.js';

type Ws = ReturnType<typeof MakeWorkspace>;

async function withServer<T>(ws: Ws, fn: (handle: DashboardServerHandle, base: string) => Promise<T>): Promise<T> {
  const handle = await startDashboardServer(
    { root: ws.root, paths: ws.paths, charter: ws.charter, config: { git: { autocommit: false } } },
    { port: 0 }
  );
  try {
    return await fn(handle, `http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

function makeHub(ws: Ws): Hub {
  return new Hub({
    paths: ws.paths,
    charter: ws.charter,
    config: { git: { autocommit: false } },
    mode: 'draft',
    now: FIXED_NOW,
  });
}

describe('dashboard server', () => {
  it('GET /api/state 投影卡片/角色/账本/可用日期', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    makeHub(ws).submitRequirement({ title: '限流器', body: 'x' });

    await withServer(ws, async (_h, base) => {
      const res = await fetch(`${base}/api/state`);
      expect(res.status).toBe(200);
      const state = (await res.json()) as {
        cards: Array<{ id: string; status: string }>;
        roles: Array<{ id: string; pending: number }>;
        ledger: { calls: number };
        days: string[];
      };
      expect(state.cards).toHaveLength(1);
      expect(state.cards[0].status).toBe('backlog');
      expect(state.roles.find((r) => r.id === 'PM')?.pending).toBe(1);
      expect(state.days.length).toBeGreaterThanOrEqual(1);
      expect(state.ledger.calls).toBe(0); // 尚无真实调用
    });
  });

  it('POST /api/approve: 卡点放行; 非法请求 400', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = true;
    });
    // PM 拆解后进入卡点 (剧本驱动的最小流水线)
    const hub = new Hub({
      paths: ws.paths,
      charter: ws.charter,
      config: { git: { autocommit: false } },
      mode: 'simulation',
      executor: new ScriptedExecutor(
        {
          name: '最小剧本',
          steps: [
            {
              when: { role: 'PM', ticketType: 'requirement' },
              thought: '拆解',
              action: '下发任务',
              deliverable: { title: 'PRD', type: 'spec', content: '# PRD' },
              tickets: [{ to: 'DEV', type: 'task', title: '任务', body: '实现' }],
            },
          ],
        },
        ws.root
      ),
      now: FIXED_NOW,
    });
    hub.submitRequirement({ title: 'x', body: 'x' });
    const runResult = await hub.run();
    expect(runResult.stopReason).toBe('checkpoint');

    await withServer(ws, async (_h, base) => {
      const bad = await fetch(`${base}/api/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: 'HACK-1', stage: 'requirement_approval' }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(`${base}/api/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: 'CARD-0001', stage: 'requirement_approval', note: '驾驶舱批准' }),
      });
      expect(ok.status).toBe(200);
      expect(fs.readdirSync(ws.paths.mailboxIn('DEV')).length).toBe(1); // 放行单据已投递
    });
  });

  it('POST /api/resume: 冻结卡片可裁决; 缺意见 400', async () => {
    const ws = makeWorkspace();
    const hub = makeHub(ws);
    hub.submitRequirement({ title: 'x', body: 'x' });
    // 手工冻结一张卡 (模拟熔断后的状态)
    const card: Card = { ...loadCard(ws.paths, 'CARD-0001'), frozen: true, frozen_reason: '测试冻结' };
    saveCard(ws.paths, card);

    await withServer(ws, async (_h, base) => {
      const noNote = await fetch(`${base}/api/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: 'CARD-0001', point: 'developing' }),
      });
      expect(noNote.status).toBe(400);

      const ok = await fetch(`${base}/api/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: 'CARD-0001', point: 'developing', note: '修复后恢复' }),
      });
      expect(ok.status).toBe(200);
      expect(loadCard(ws.paths, 'CARD-0001').frozen).toBe(false);
      // 裁决意见单已投递 DEV
      expect(fs.readdirSync(ws.paths.mailboxIn('DEV')).length).toBe(1);
    });
  });

  it('GET /api/events (SSE): 下发既有事件批次并保持连接', async () => {
    const ws = makeWorkspace();
    makeHub(ws).submitRequirement({ title: 'x', body: 'x' });

    await withServer(ws, async (_h, base) => {
      const res = await fetch(`${base}/api/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"kind":"batch"');
      expect(text).toContain('ticket_arrival');
      await reader.cancel();
    });
  });

  it('POST /api/req: 驾驶舱快速提单 (经同一 Hub 校验)', async () => {
    const ws = makeWorkspace();
    await withServer(ws, async (_h, base) => {
      const ok = await fetch(`${base}/api/req`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '驾驶舱提单', body: '内容', priority: 'P0' }),
      });
      expect(ok.status).toBe(200);
      expect(loadCard(ws.paths, 'CARD-0001').priority).toBe('P0');
      const bad = await fetch(`${base}/api/req`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      });
      expect(bad.status).toBe(400);
    });
  });

  it('静态前端: 已构建 dist 时返回 index.html', async () => {
    const ws = makeWorkspace();
    await withServer(ws, async (_h, base) => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('<div id="root">');
    });
  });
});
