// 测试公共工具: 临时工作区 + 固定时钟 + 剧本构造
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Charter,
  Hub,
  RoleExecutor,
  ScriptedExecutor,
  Scenario,
  WorkspacePaths,
  defaultCharter,
  initWorkspace,
  resolvePaths,
} from '../src/index.js';

export function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vat-test-'));
}

/** 固定时钟: 所有单据落在同一分钟, 由 seq 保证唯一 */
export const FIXED_NOW = () => new Date(2026, 9, 6, 9, 30, 0);

export function makeWorkspace(modify?: (c: Charter) => void): {
  root: string;
  paths: WorkspacePaths;
  charter: Charter;
} {
  const root = tempRoot();
  const charter = defaultCharter();
  modify?.(charter);
  initWorkspace(root, charter);
  return { root, paths: resolvePaths(root), charter };
}

export interface ScenarioStepSpec {
  role: string;
  ticketType?: string;
  tickets?: Array<{ to: string; type: string; title: string; body: string }>;
  deliverable?: { title: string; type: string; content?: string };
  codeFiles?: Array<{ path: string; content: string }>;
  thought?: string;
  action?: string;
  repeat?: boolean;
}

/** 以编程方式构造确定性剧本 */
export function buildScenario(steps: ScenarioStepSpec[]): Scenario {
  return {
    name: '测试剧本',
    steps: steps.map((s) => ({
      when: { role: s.role, ticketType: s.ticketType as Scenario['steps'][number]['when']['ticketType'] },
      thought: s.thought ?? `${s.role} 思考`,
      action: s.action ?? `${s.role} 行动`,
      tickets: s.tickets as Scenario['steps'][number]['tickets'],
      deliverable: s.deliverable as Scenario['steps'][number]['deliverable'],
      codeFiles: s.codeFiles,
      repeat: s.repeat,
    })),
  };
}

/** 黄金路径: PM → DEV → REVIEW → QA → PM, 无打回 */
export function goldenScenario(): Scenario {
  return buildScenario([
    {
      role: 'PM',
      ticketType: 'requirement',
      deliverable: { title: 'PRD 规格书', type: 'spec', content: '# PRD\n实现限流器' },
      tickets: [{ to: 'DEV', type: 'task', title: '[开发任务] 限流器', body: '按 PRD 实现' }],
    },
    {
      role: 'DEV',
      ticketType: 'task',
      deliverable: { title: '源码实现', type: 'code', content: 'export class TokenBucket {}' },
      tickets: [{ to: 'REVIEW', type: 'review', title: '[提审] 限流器', body: '请审查' }],
    },
    {
      role: 'REVIEW',
      ticketType: 'review',
      deliverable: { title: '审计报告', type: 'review', content: '准入' },
      tickets: [{ to: 'QA', type: 'review', title: '[准入] 限流器', body: '请验收' }],
    },
    {
      role: 'QA',
      ticketType: 'review',
      deliverable: { title: '验收报告', type: 'test', content: '通过' },
      tickets: [
        { to: 'PM', type: 'notify', title: '[准出] 限流器', body: '验收通过, 建议结项' },
      ],
    },
    {
      role: 'PM',
      ticketType: 'notify',
      thought: '验收通知到达, 归档结项',
      action: '归档结项, 交付完成',
    },
  ]);
}

export function scriptedHub(
  root: string,
  paths: WorkspacePaths,
  charter: Charter,
  scenario: Scenario,
  extra?: { now?: () => Date; oneStep?: boolean; onEvent?: (e: unknown) => void }
): Hub {
  const executor: RoleExecutor = new ScriptedExecutor(scenario, root);
  return new Hub({
    paths,
    charter,
    config: { git: { autocommit: false } },
    mode: 'simulation',
    executor,
    now: extra?.now ?? FIXED_NOW,
    oneStep: extra?.oneStep,
    onEvent: extra?.onEvent as never,
  });
}
