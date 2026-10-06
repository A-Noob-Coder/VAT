// 状态机矩阵表驱动测试 (架构设计 §6.2: 规则在引擎, 不在提示词)
import { describe, expect, it } from 'vitest';
import { TRANSITION_MATRIX, canTransition, planTurn } from '../src/index.js';

// 架构设计 §6.2 的规范表 (机器可读副本, 矩阵必须与此一致)
const SPEC: Record<string, Record<string, string[]>> = {
  backlog: { PM: ['ready'], USER: ['backlog'] },
  ready: { DEV: ['developing'], USER: ['ready', 'backlog'] },
  developing: { DEV: ['review'], USER: ['developing'] },
  review: { REVIEW: ['testing', 'developing'], USER: ['review'] },
  testing: { QA: ['done', 'developing'], USER: ['testing'] },
  done: { PM: ['done'], USER: ['done'] },
};

describe('状态机转移矩阵', () => {
  it('矩阵与架构设计 §6.2 规范表完全一致', () => {
    expect(TRANSITION_MATRIX).toEqual(SPEC);
  });

  it('canTransition 覆盖全部合法迁移', () => {
    const legal: Array<[string, string, string]> = [
      ['backlog', 'PM', 'ready'],
      ['ready', 'DEV', 'developing'],
      ['developing', 'DEV', 'review'],
      ['review', 'REVIEW', 'testing'],
      ['review', 'REVIEW', 'developing'],
      ['testing', 'QA', 'done'],
      ['testing', 'QA', 'developing'],
      ['done', 'PM', 'done'],
    ];
    for (const [from, actor, to] of legal) {
      expect(canTransition(from as never, actor, to as never), `${from}-${actor}->${to}`).toBe(true);
    }
  });

  it('非法迁移被拒绝 (v0.1 缺陷回归: DEV 不能宣布 done)', () => {
    expect(canTransition('developing', 'DEV', 'done')).toBe(false);
    expect(canTransition('backlog', 'DEV', 'review')).toBe(false);
    expect(canTransition('testing', 'PM', 'done')).toBe(false);
    expect(canTransition('review', 'QA', 'testing')).toBe(false);
  });
});

describe('planTurn 回合规划', () => {
  const ckOff = { requirement_approval: false, release_approval: false };
  const ckOn = { requirement_approval: true, release_approval: true };

  it('PM at backlog + task 单 → ready (附 spec)', () => {
    const plan = planTurn(
      { id: 'CARD-0001', status: 'backlog' },
      'PM',
      {
        tickets: [{ to: 'DEV', type: 'task', title: 't', body: 'b' }],
        deliverable: { title: 'PRD', type: 'spec', content: 'x' },
      },
      ckOn
    );
    expect(plan.hops).toEqual([{ from: 'backlog', to: 'ready' }]);
    expect(plan.checkpoint).toBe('requirement_approval');
    expect(plan.rejectionIncrement).toBe(0);
  });

  it('PM 未附 PRD 即推进 ready → 出具告警 (交付红线)', () => {
    const plan = planTurn(
      { id: 'CARD-0001', status: 'backlog' },
      'PM',
      { tickets: [{ to: 'DEV', type: 'task', title: 't', body: 'b' }] },
      ckOff
    );
    expect(plan.nextStatus).toBe('ready');
    expect(plan.warnings.join()).toContain('PRD');
  });

  it('DEV at ready 提审 → 链式迁移 ready→developing→review', () => {
    const plan = planTurn(
      { id: 'CARD-0001', status: 'ready' },
      'DEV',
      { tickets: [{ to: 'REVIEW', type: 'review', title: 't', body: 'b' }] },
      ckOff
    );
    expect(plan.hops).toEqual([
      { from: 'ready', to: 'developing' },
      { from: 'developing', to: 'review' },
    ]);
  });

  it('DEV at developing 提审 → review', () => {
    const plan = planTurn(
      { id: 'CARD-0001', status: 'developing' },
      'DEV',
      { tickets: [{ to: 'REVIEW', type: 'review', title: 't', body: 'b' }] },
      ckOff
    );
    expect(plan.nextStatus).toBe('review');
  });

  it('REVIEW 打回 → developing, 计数 +1; 通过 → testing', () => {
    const reject = planTurn(
      { id: 'CARD-0001', status: 'review' },
      'REVIEW',
      { tickets: [{ to: 'DEV', type: 'return', title: 't', body: 'b' }] },
      ckOff
    );
    expect(reject.nextStatus).toBe('developing');
    expect(reject.rejectionIncrement).toBe(1);

    const pass = planTurn(
      { id: 'CARD-0001', status: 'review' },
      'REVIEW',
      { tickets: [{ to: 'QA', type: 'review', title: 't', body: 'b' }] },
      ckOff
    );
    expect(pass.nextStatus).toBe('testing');
    expect(pass.rejectionIncrement).toBe(0);
  });

  it('QA 签发 → done (release 卡点可配置); defect → developing +1', () => {
    const done = planTurn(
      { id: 'CARD-0001', status: 'testing' },
      'QA',
      { tickets: [{ to: 'PM', type: 'notify', title: 't', body: 'b' }] },
      ckOff
    );
    expect(done.nextStatus).toBe('done');
    expect(done.checkpoint).toBeNull();

    const doneCk = planTurn(
      { id: 'CARD-0001', status: 'testing' },
      'QA',
      { tickets: [{ to: 'PM', type: 'notify', title: 't', body: 'b' }] },
      ckOn
    );
    expect(doneCk.checkpoint).toBe('release_approval');

    const defect = planTurn(
      { id: 'CARD-0001', status: 'testing' },
      'QA',
      { tickets: [{ to: 'DEV', type: 'defect', title: 't', body: 'b' }] },
      ckOff
    );
    expect(defect.nextStatus).toBe('developing');
    expect(defect.rejectionIncrement).toBe(1);
  });

  it('OPS 处理工单不改变卡片状态', () => {
    const plan = planTurn(
      { id: 'CARD-0001', status: 'done' },
      'OPS',
      { tickets: [{ to: 'PM', type: 'notify', title: 't', body: 'b' }] },
      ckOff
    );
    expect(plan.hops).toEqual([]);
    expect(plan.nextStatus).toBe('done');
  });

  it('非法迁移抛出违规异常 (矩阵硬拒绝)', () => {
    expect(() =>
      planTurn(
        { id: 'CARD-0001', status: 'done' },
        'DEV',
        { tickets: [{ to: 'REVIEW', type: 'review', title: 't', body: 'b' }] },
        ckOff
      )
    ).toThrow(/状态机违规/);
  });
});
