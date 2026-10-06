// Hub strict 闸门编排测试 (fake gate): 自修环 / 正式打回 / QA 阻断签发
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_DEV_SELF_REPAIR,
  Hub,
  ScriptedExecutor,
  loadCard,
  type Scenario,
  type StrictGatePort,
  type StrictReport,
} from '../src/index.js';
import { FIXED_NOW, buildScenario, makeWorkspace } from './helpers.js';

/**
 * strict 模式剧本: DEV 提审带 codeFiles; DEV/defect 可重复 (自修环重提);
 * REVIEW/QA/PM 可重复 (打回后二次签发)。
 */
function strictScenario(): Scenario {
  const code = 'export const v = 1;';
  return buildScenario([
    {
      role: 'PM',
      ticketType: 'requirement',
      deliverable: { title: 'PRD', type: 'spec', content: '# PRD' },
      tickets: [{ to: 'DEV', type: 'task', title: '任务', body: '实现' }],
    },
    {
      role: 'DEV',
      ticketType: 'task',
      deliverable: { title: '实现', type: 'code', content: code },
      codeFiles: [{ path: 'src/v.ts', content: code }],
      tickets: [{ to: 'REVIEW', type: 'review', title: '提审', body: '请审' }],
    },
    {
      role: 'DEV',
      ticketType: 'defect',
      thought: '收到闸门缺陷单, 修复后重新提审',
      action: '修复并重新提审',
      codeFiles: [{ path: 'src/v.ts', content: code }],
      tickets: [{ to: 'REVIEW', type: 'review', title: '再提审', body: '已修复' }],
      repeat: true,
    },
    {
      role: 'REVIEW',
      ticketType: 'review',
      deliverable: { title: '审计', type: 'review', content: '准入' },
      tickets: [{ to: 'QA', type: 'review', title: '准入', body: '请验收' }],
      repeat: true,
    },
    {
      role: 'QA',
      ticketType: 'review',
      deliverable: { title: '验收', type: 'test', content: '通过' },
      codeFiles: [{ path: 'src/v.qa.test.ts', content: 'export const t = 1;' }],
      tickets: [{ to: 'PM', type: 'notify', title: '准出', body: '通过' }],
      repeat: true,
    },
    { role: 'PM', ticketType: 'notify', thought: '归档', action: '结项', repeat: true },
    { role: 'DEV', ticketType: 'notify', thought: '确认裁决', action: '确认', repeat: true },
  ]);
}

function gateFailingFrom(failFromCall: number, failUntilCall?: number): StrictGatePort {
  let calls = 0;
  const failReport = (projectDir: string): StrictReport => ({
    ok: false,
    summary: '类型检查失败 (2 处 error TS)',
    projectDir,
    steps: [
      { name: 'tsc', status: 'fail', durationMs: 10, summary: '类型检查失败 (2 处 error TS)', detail: 'src/v.ts(1,1): error TS2322: ...' },
    ],
    tests: null,
  });
  const passReport = (projectDir: string): StrictReport => ({
    ok: true,
    summary: 'tsc ✓ · vitest ✓',
    projectDir,
    steps: [
      { name: 'scaffold', status: 'ok', durationMs: 1, summary: '工程文件齐备' },
      { name: 'tsc', status: 'ok', durationMs: 10, summary: '类型检查通过' },
    ],
    tests: { total: 3, passed: 3, failed: 0 },
  });
  return {
    async runGate({ projectDir }) {
      calls += 1;
      const shouldFail = calls >= failFromCall && (failUntilCall === undefined || calls <= failUntilCall);
      return shouldFail ? failReport(projectDir) : passReport(projectDir);
    },
  };
}

function strictWorkspace() {
  return makeWorkspace((c) => {
    c.data.checkpoints.requirement_approval = false;
    c.data.execution.strict = { tsc: true, vitest: true, docker_build: 'off', max_dev_self_repair: 2 };
  });
}

function strictHub(ws: ReturnType<typeof strictWorkspace>, gate: StrictGatePort): Hub {
  return new Hub({
    paths: ws.paths,
    charter: ws.charter,
    config: { git: { autocommit: false } },
    mode: 'strict',
    executor: new ScriptedExecutor(strictScenario(), '/tmp'),
    strictGate: gate,
    now: FIXED_NOW,
  });
}

describe('Hub strict 闸门 · DEV 提审', () => {
  it('闸门通过: 提审放行, 报告作为交付物落盘 (source: strict-runner), 自修环清零', async () => {
    const ws = strictWorkspace();
    const hub = strictHub(ws, gateFailingFrom(99));
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('done');
    expect(card.self_repair_count).toBe(0);
    const deliverableDir = ws.paths.cardDeliverableDir('CARD-0001');
    const strictFiles = fs.readdirSync(deliverableDir).filter((f) => f.includes('STRICT'));
    // DEV 提审报告 + QA 验收报告各一份
    expect(strictFiles.length).toBe(2);
    const content = fs.readFileSync(path.join(deliverableDir, strictFiles[0]), 'utf8');
    expect(content).toContain('StrictRunner 执行报告');
    expect(content).toContain('通过');
  });

  it('闸门失败 → defect 打回 DEV (自修环 1), 提审单不投递, 不计正式打回; 修复后通过', async () => {
    const ws = strictWorkspace();
    const hub = strictHub(ws, gateFailingFrom(1, 1)); // 仅第 1 次调用失败
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('done');
    expect(card.rejection_count).toBe(0); // 自修环内不计正式打回
    // defect 单真实投递并被 DEV 消费归档
    const devArchive = fs.readdirSync(ws.paths.mailboxArchive('DEV'));
    expect(devArchive.some((f) => f.startsWith('STRICT-DEV-defect'))).toBe(true);
  });

  it('自修环耗尽 (失败次数 > 上限 2) → 每次失败转正式打回, 熔断触发冻结', async () => {
    const ws = strictWorkspace();
    const hub = strictHub(ws, gateFailingFrom(1)); // 永远失败
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('blocked');
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.frozen).toBe(true);
    expect(card.rejection_count).toBe(3); // 打回 3 次触发熔断
    expect(card.self_repair_count).toBeGreaterThanOrEqual(DEFAULT_MAX_DEV_SELF_REPAIR + 1);
    // defect 单持续打回 DEV (真实打回材料在 DEV 归档)
    expect(fs.readdirSync(ws.paths.mailboxArchive('DEV')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('Hub strict 闸门 · QA 验收', () => {
  it('QA 追加测试失败 → 签发阻断, 真实打回 developing +1, defect 回 DEV; 修复后最终交付', async () => {
    const ws = strictWorkspace();
    const hub = strictHub(ws, gateFailingFrom(2, 2)); // 仅第 2 次调用 (QA) 失败
    hub.submitRequirement({ title: 'x', body: 'x' });
    const result = await hub.run();
    expect(result.stopReason).toBe('drained');
    const card = loadCard(ws.paths, 'CARD-0001');
    expect(card.status).toBe('done');
    expect(card.rejection_count).toBe(1); // QA 阶段失败 = 正式打回
    // defect 单由闸门签发 (source: strict-runner), DEV 消费归档
    const devArchive = fs.readdirSync(ws.paths.mailboxArchive('DEV'));
    expect(devArchive.some((f) => f.startsWith('STRICT-DEV-defect'))).toBe(true);
    // 事件流包含验收闸门失败记录
    const events = fs.readFileSync(ws.paths.eventsFile('20261006'), 'utf8');
    expect(events).toContain('strict 验收闸门未通过');
    // strict 报告至少 2 份 (DEV 提审 + QA 验收)
    const deliverableDir = ws.paths.cardDeliverableDir('CARD-0001');
    expect(fs.readdirSync(deliverableDir).filter((f) => f.includes('STRICT')).length).toBeGreaterThanOrEqual(2);
  });
});
