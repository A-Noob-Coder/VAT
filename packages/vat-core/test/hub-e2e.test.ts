// Hub 端到端测试: 黄金路径/卡点/打回/熔断恢复/预算/死信/崩溃恢复/真实账本
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  Hub,
  LlmExecutor,
  appendLedger,
  listCards,
  loadCard,
  loadConfig,
  readEvents,
  readLedgerDay,
  resolvePaths,
  saveCard,
  scanInbox,
  summarize,
  todayKey,
  Scenario,
} from '../src/index.js';
import { FIXED_NOW, buildScenario, goldenScenario, makeWorkspace, scriptedHub, tempRoot } from './helpers.js';

function rejectionScenario(rejectCount: number): Scenario {
  const steps = [
    {
      role: 'PM',
      ticketType: 'requirement',
      deliverable: { title: 'PRD', type: 'spec', content: '# PRD' },
      tickets: [{ to: 'DEV', type: 'task', title: '任务', body: '实现' }],
    },
    {
      role: 'DEV',
      ticketType: 'task',
      deliverable: { title: '实现', type: 'code', content: 'export class A {}' },
      tickets: [{ to: 'REVIEW', type: 'review', title: '提审', body: '请审' }],
    },
  ];
  for (let i = 1; i <= rejectCount; i++) {
    steps.push({
      role: 'REVIEW',
      ticketType: 'review',
      tickets: [{ to: 'DEV', type: 'return', title: `打回 ${i}/3`, body: '缺陷' }],
    });
    steps.push({
      role: 'DEV',
      ticketType: 'return',
      deliverable: { title: `修复 v${i + 1}`, type: 'code', content: `v${i + 1}` },
      tickets: [{ to: 'REVIEW', type: 'review', title: '再提审', body: '已修复' }],
    });
  }
  steps.push({
    role: 'REVIEW',
    ticketType: 'review',
    deliverable: { title: '终审报告', type: 'review', content: '准入' },
    tickets: [{ to: 'QA', type: 'review', title: '准入', body: '请验收' }],
  });
  steps.push({
    role: 'QA',
    ticketType: 'review',
    deliverable: { title: '验收报告', type: 'test', content: '通过' },
    tickets: [{ to: 'PM', type: 'notify', title: '准出', body: '通过' }],
  });
  steps.push({
    role: 'DEV',
    ticketType: 'notify',
    thought: '收到主程裁决意见, 记入 lessons',
    action: '确认裁决并继续',
  });
  steps.push({
    role: 'PM',
    ticketType: 'notify',
    thought: '归档结项',
    action: '归档结项',
  });
  return buildScenario(steps);
}

async function runGolden(checkpointOn: boolean) {
  const ws = makeWorkspace((c) => {
    c.data.checkpoints.requirement_approval = checkpointOn;
  });
  const hub = scriptedHub(ws.root, ws.paths, ws.charter, goldenScenario());
  hub.submitRequirement({ title: '限流中间件', body: '实现 50k QPS 令牌桶' });
  return { ws, hub };
}

describe('Hub 端到端 · 黄金路径', () => {
  it('无卡点: 一轮跑完全链路至 done, 全部单据归档', async () => {
    const { ws, hub } = await runGolden(false);
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');

    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('done');
    expect(card.owner).toBe('PM'); // QA notify → PM
    expect(card.frozen).toBe(false);
    expect(card.deliverables).toHaveLength(4); // PRD/代码/审计/验收
    expect(card.ticket_chain).toHaveLength(5); // req + task + review + review + notify

    // 收件箱全部清空, 归档有物
    for (const role of ['PM', 'DEV', 'REVIEW', 'QA']) {
      expect(scanInbox(ws.paths.mailboxIn(role))).toHaveLength(0);
    }
    expect(fs.readdirSync(ws.paths.mailboxArchive('DEV'))).toHaveLength(1);
    // 交付物真实落盘
    expect(fs.readdirSync(ws.paths.cardDeliverableDir('CARD-0001'))).toHaveLength(4);
  });

  it('需求批准卡点: run 暂停 → approve 释放 → 跑完', async () => {
    const { ws, hub } = await runGolden(true);
    const r1 = await hub.run();
    expect(r1.stopReason).toBe('checkpoint');
    expect(r1.exitCode).toBe(2);

    const held = fs.readdirSync(path.join(ws.paths.heldDir, 'CARD-0001'));
    expect(held).toHaveLength(1); // PM 的 task 单暂扣
    expect(scanInbox(ws.paths.mailboxIn('DEV'))).toHaveLength(0);
    expect(loadCard(ws.paths, 'CARD-0001').status).toBe('ready');

    hub.approve('CARD-0001', 'requirement_approval', '方案可行, 下发');
    expect(fs.readdirSync(path.join(ws.paths.heldDir, 'CARD-0001'))).toHaveLength(0);
    expect(scanInbox(ws.paths.mailboxIn('DEV'))).toHaveLength(1);
    expect(loadCard(ws.paths, 'CARD-0001').checkpoints_passed).toContain('requirement_approval');

    const r2 = await hub.run();
    expect(r2.stopReason).toBe('drained');
    expect(loadCard(ws.paths, 'CARD-0001').status).toBe('done');

    const events = readEvents(ws.paths.eventsFile(todayKey(FIXED_NOW())));
    expect(events.some((e) => e.type === 'checkpoint_wait')).toBe(true);
    expect(events.some((e) => e.type === 'human_action')).toBe(true);
  });
});

describe('Hub 端到端 · 打回与熔断', () => {
  it('一次打回: 卡片回 developing, 计数 1, 修复后最终 done', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, rejectionScenario(1));
    hub.submitRequirement({ title: '限流器', body: 'x' });
    await hub.run();

    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('done');
    expect(card.rejection_count).toBe(1);
    const events = readEvents(ws.paths.eventsFile(todayKey(FIXED_NOW())));
    expect(events.some((e) => e.message.includes('review → developing'))).toBe(true);
  });

  it('三次打回触发熔断冻结 (仅该卡), 主程 resume developing 后交付', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, rejectionScenario(3));
    hub.submitRequirement({ title: '限流器', body: 'x' });

    const r1 = await hub.run();
    expect(r1.stopReason).toBe('blocked');
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.frozen).toBe(true);
    expect(card.rejection_count).toBe(3);
    // 第 3 张打回单仍在 DEV 收件箱等待 (不丢弃)
    expect(scanInbox(ws.paths.mailboxIn('DEV')).length).toBe(1);

    hub.resume('CARD-0001', 'developing', '按意见修复精度问题');
    const resumed = loadCard(ws.paths, 'CARD-0001');
    expect(resumed.frozen).toBe(false);
    expect(resumed.rejection_count).toBe(0);
    expect(resumed.status).toBe('developing');

    const r2 = await hub.run();
    expect(r2.stopReason).toBe('drained');
    expect(loadCard(ws.paths, 'CARD-0001').status).toBe('done');

    const events = readEvents(ws.paths.eventsFile(todayKey(FIXED_NOW())));
    expect(events.filter((e) => e.type === 'circuit_break')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'human_action')).toHaveLength(1);
  });

  it('resume redesign: 卡片退回 backlog 重走 PM', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, rejectionScenario(3));
    hub.submitRequirement({ title: '限流器', body: 'x' });
    await hub.run();
    hub.resume('CARD-0001', 'redesign', '需求方向错了, 重拆');
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('backlog');
    expect(card.owner).toBe('PM');
    expect(card.rejection_count).toBe(0);
  });
});

describe('Hub 端到端 · 预算与死信', () => {
  it('日预算触顶: 全局挂起, 不处理任何单据', async () => {
    const ws = makeWorkspace((c) => {
      c.data.budget.daily_token_limit = 1000;
      c.data.checkpoints.requirement_approval = false;
    });
    // 预置真实 LLM 账本 (scripted 不计费)
    appendLedger(ws.paths.ledgerFile(todayKey(FIXED_NOW())), {
      ts: FIXED_NOW().toISOString(),
      role: 'PM',
      card: 'CARD-0001',
      ticket: 'tkt_x',
      providerId: 'fake',
      model: 'fake-model',
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1000,
      latencyMs: 10,
      source: 'llm',
    });
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, goldenScenario());
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('budget');
    expect(result.exitCode).toBe(3);
    expect(scanInbox(ws.paths.mailboxIn('PM'))).toHaveLength(1); // 未被消费
  });

  it('单卡预算触顶: 仅冻结该卡, 其他卡不受影响', async () => {
    const ws = makeWorkspace((c) => {
      c.data.budget.per_card_token_limit = 100;
      c.data.checkpoints.requirement_approval = false;
    });
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, rejectionScenario(1));
    const { card } = hub.submitRequirement({ title: 'A', body: 'x' });
    saveCard(ws.paths, { ...card, token_used: 500 }); // 已超单卡预算
    const result = await hub.run();
    expect(result.stopReason).toBe('blocked');
    expect(loadCard(ws.paths, card.id).frozen).toBe(true);
    expect(loadCard(ws.paths, card.id).frozen_reason).toContain('预算');
  });

  it('引用不存在卡片的单据 → 死信', async () => {
    const ws = makeWorkspace();
    const { createTicket, deliverTicket } = await import('../src/index.js');
    const rogue = createTicket(
      {
        from: 'PM',
        to: 'DEV',
        type: 'task',
        card: 'CARD-9999',
        source: 'human',
        title: '野单据',
        body: 'x',
        now: FIXED_NOW(),
      },
      1
    );
    deliverTicket(ws.paths, rogue);
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, goldenScenario());
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    expect(fs.readdirSync(ws.paths.deadDir)).toHaveLength(1);
    const events = readEvents(ws.paths.eventsFile(todayKey(FIXED_NOW())));
    expect(events.some((e) => e.type === 'dead_letter')).toBe(true);
  });

  it('产出单据指向编制外角色 → 死信, 流水线继续', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    const scenario = buildScenario([
      {
        role: 'PM',
        ticketType: 'requirement',
        deliverable: { title: 'PRD', type: 'spec', content: 'x' },
        tickets: [
          { to: 'GHOST', type: 'task', title: '野单', body: 'x' },
          { to: 'DEV', type: 'task', title: '正常任务', body: 'x' },
        ],
      },
      {
        role: 'DEV',
        ticketType: 'task',
        deliverable: { title: '实现', type: 'code', content: 'x' },
        tickets: [{ to: 'REVIEW', type: 'review', title: '提审', body: 'x' }],
      },
      {
        role: 'REVIEW',
        ticketType: 'review',
        deliverable: { title: '审计', type: 'review', content: 'x' },
        tickets: [{ to: 'QA', type: 'review', title: '准入', body: 'x' }],
      },
      {
        role: 'QA',
        ticketType: 'review',
        deliverable: { title: '验收', type: 'test', content: 'x' },
        tickets: [{ to: 'PM', type: 'notify', title: '准出', body: 'x' }],
      },
      {
        role: 'PM',
        ticketType: 'notify',
        thought: '归档结项',
        action: '归档结项',
      },
    ]);
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, scenario);
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    expect(loadCard(ws.paths, 'CARD-0001').status).toBe('done');
    expect(fs.readdirSync(ws.paths.deadDir)).toHaveLength(1);
  });
});

describe('Hub 端到端 · 崩溃恢复', () => {
  it('每步用全新 Hub 实例 (等价 kill -9 重启), 卡点-批准-交付最终一致', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = true; // 卡点打在链路中间
    });
    // 进程 1: 提需求 + 跑到卡点
    const hub1 = scriptedHub(ws.root, ws.paths, ws.charter, goldenScenario());
    hub1.submitRequirement({ title: 'x', body: 'x' });
    const r1 = await hub1.run();
    expect(r1.stopReason).toBe('checkpoint');

    // 进程 2: 批准 (全新实例, 仅凭文件恢复)
    const hub2 = scriptedHub(ws.root, ws.paths, ws.charter, goldenScenario());
    hub2.approve('CARD-0001', 'requirement_approval', '通过');

    // 进程 3..N: 反复重启直到跑完
    for (let i = 0; i < 20; i++) {
      const result = await scriptedHub(ws.root, ws.paths, ws.charter, goldenScenario()).run();
      if (result.stopReason === 'drained') break;
    }
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('done');
    // 状态一致性: 无残留 in/
    for (const role of ['PM', 'DEV', 'REVIEW', 'QA', 'OPS']) {
      expect(scanInbox(ws.paths.mailboxIn(role))).toHaveLength(0);
    }
  });
});

describe('Hub 端到端 · 真实账本 (LLM 执行器 + 假客户端)', () => {
  it('usage 逐笔记账, 计费口径只含 llm', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    const calls: string[] = [];
    const client = {
      generate: async (req: { user: string }) => {
        calls.push(req.user);
        const turn = calls.length;
        const outputs = [
          // PM
          JSON.stringify({
            thought: '拆解',
            action: '下发',
            tickets: [{ to: 'DEV', type: 'task', title: '任务', body: '实现' }],
            deliverable: { title: 'PRD', type: 'spec', content: '# PRD' },
            memoryUpdates: { summaryUpdate: '已拆解' },
          }),
          // DEV
          JSON.stringify({
            thought: '编码',
            action: '提审',
            tickets: [{ to: 'REVIEW', type: 'review', title: '提审', body: 'x' }],
            deliverable: { title: '实现', type: 'code', content: 'export {}' },
          }),
          // REVIEW
          JSON.stringify({
            thought: '审查',
            action: '准入',
            tickets: [{ to: 'QA', type: 'review', title: '准入', body: 'x' }],
            deliverable: { title: '审计', type: 'review', content: 'ok' },
          }),
          // QA
          JSON.stringify({
            thought: '验收',
            action: '签发',
            tickets: [{ to: 'PM', type: 'notify', title: '准出', body: 'x' }],
            deliverable: { title: '验收', type: 'test', content: 'ok' },
          }),
          // PM 归档
          JSON.stringify({
            thought: '归档',
            action: '结项',
            tickets: [],
          }),
        ];
        return {
          text: outputs[turn - 1],
          providerId: 'fake',
          model: 'fake-model',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          latencyMs: 5,
        };
      },
    };
    const executor = new LlmExecutor(client);
    const hub = new Hub({
      paths: ws.paths,
      charter: ws.charter,
      config: loadConfig(ws.paths.configFile),
      mode: 'draft',
      executor,
      now: FIXED_NOW,
    });
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    expect(loadCard(ws.paths, 'CARD-0001').token_used).toBe(750); // 5 轮 × 150, 真实记账

    const ledger = readLedgerDay(ws.paths.ledgerFile(todayKey(FIXED_NOW())));
    expect(ledger).toHaveLength(5);
    expect(ledger.every((e) => e.source === 'llm')).toBe(true);
    const sum = summarize(ledger, true);
    expect(sum.billableTokens).toBe(750);
    expect(sum.byRole['DEV']).toBe(150);
  });
});

describe('多卡片隔离', () => {
  it('第二张卡不影响第一张卡交付; 卡号自增', async () => {
    const ws = makeWorkspace((c) => {
      c.data.checkpoints.requirement_approval = false;
    });
    // 两张卡各走一遍完整链路 → 步骤全部可重复
    const repeatScenario: Scenario = {
      name: '可重复黄金路径',
      steps: goldenScenario().steps.map((s) => ({ ...s, repeat: true })),
    };
    const hub = scriptedHub(ws.root, ws.paths, ws.charter, repeatScenario);
    hub.submitRequirement({ title: '卡一', body: 'x' });
    hub.submitRequirement({ title: '卡二', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    const cards = listCards(ws.paths.boardDir);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.id)).toEqual(['CARD-0001', 'CARD-0002']);
    expect(cards.every((c) => c.status === 'done')).toBe(true);
  });
});
