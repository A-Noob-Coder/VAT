// 状态机矩阵与回合规划 (架构设计 §6.2: 规则在引擎, 不在提示词)
import type { Card, CardStatus, CheckpointStage, RoleOutput } from '../types.js';

/**
 * 转移矩阵: M[当前状态][触发角色] = 允许进入的下一状态集合。
 * USER (主程) 列用于人工裁决 (approve / reject / resume)。
 * 本表为硬编码事实, 章程正文只是其人读投影; 两者不一致时以本表为准。
 */
export const TRANSITION_MATRIX: Record<CardStatus, Partial<Record<string, CardStatus[]>>> = {
  backlog: { PM: ['ready'], USER: ['backlog'] },
  ready: { DEV: ['developing'], USER: ['ready', 'backlog'] },
  developing: { DEV: ['review'], USER: ['developing'] },
  review: { REVIEW: ['testing', 'developing'], USER: ['review'] },
  testing: { QA: ['done', 'developing'], USER: ['testing'] },
  done: { PM: ['done'], USER: ['done'] },
};

export function canTransition(from: CardStatus, actor: string, to: CardStatus): boolean {
  return TRANSITION_MATRIX[from]?.[actor]?.includes(to) ?? false;
}

/** 该状态下有权行动的角色 (不含 USER) */
export function allowedActors(status: CardStatus): string[] {
  return Object.keys(TRANSITION_MATRIX[status] ?? {}).filter((a) => a !== 'USER');
}

export interface TurnHop {
  from: CardStatus;
  to: CardStatus;
}

export interface TurnPlan {
  hops: TurnHop[];
  nextStatus: CardStatus;
  rejectionIncrement: number;
  checkpoint: CheckpointStage | null;
  warnings: string[];
}

const isRejection = (t: { type: string }) => t.type === 'return' || t.type === 'defect';

/**
 * 根据触发角色与其产出单据, 规划本轮的状态迁移路径。
 * 每一跳都经过矩阵校验, 非法即抛错 (Hub 捕获后降级为 warning 并保留原状态)。
 */
export function planTurn(
  card: Pick<Card, 'id' | 'status'>,
  actor: string,
  output: Pick<RoleOutput, 'tickets' | 'deliverable'>,
  checkpoints: { requirement_approval: boolean; release_approval: boolean }
): TurnPlan {
  const warnings: string[] = [];
  const hops: TurnHop[] = [];
  let rejectionIncrement = 0;
  let checkpoint: CheckpointStage | null = null;

  const push = (to: CardStatus) => {
    const lastHop = hops[hops.length - 1];
    const from = lastHop ? lastHop.to : card.status;
    if (!canTransition(from, actor, to)) {
      throw new Error(
        `状态机违规: ${actor} 试图在 ${from} 推进到 ${to} (卡片 ${card.id}); 该迁移已被矩阵拒绝`
      );
    }
    hops.push({ from, to });
  };

  const tickets = output.tickets ?? [];
  const toRole = (type: string) => tickets.some((t) => t.type === type);

  switch (actor) {
    case 'PM': {
      if (card.status === 'backlog' && toRole('task')) {
        push('ready');
        if (!output.deliverable || output.deliverable.type !== 'spec') {
          warnings.push('PM 未附 PRD 规格书 (deliverable: spec) 即推进 ready, 违反章程交付红线');
        }
      }
      break; // done 状态下 PM 收 notify 归档, 不产生迁移
    }
    case 'DEV': {
      if (toRole('review')) {
        if (card.status === 'ready') push('developing');
        const entered = hops[hops.length - 1];
        if (card.status === 'developing' || entered?.to === 'developing') {
          push('review');
        } else if (hops.length === 0) {
          push('review'); // 从无权状态提审 → push 内必然抛状态机违规
        }
      }
      break;
    }
    case 'REVIEW': {
      if (card.status !== 'review') break;
      const rejects = tickets.some(isRejection);
      if (rejects) {
        push('developing');
        rejectionIncrement = 1;
      } else if (toRole('review')) {
        push('testing');
      }
      break;
    }
    case 'QA': {
      if (card.status !== 'testing') break;
      const rejects = tickets.some(isRejection);
      if (rejects) {
        push('developing');
        rejectionIncrement = 1;
      } else if (toRole('notify')) {
        push('done');
        if (checkpoints.release_approval) checkpoint = 'release_approval';
      }
      break;
    }
    default:
      // OPS 及扩展角色: 处理工单但不改变卡片状态
      break;
  }

  // 进入 ready 的卡点: 需求批准 (v0.2 默认开启)
  if (hops.some((h) => h.to === 'ready') && checkpoints.requirement_approval) {
    checkpoint = 'requirement_approval';
  }

  return {
    hops,
    nextStatus: hops[hops.length - 1]?.to ?? card.status,
    rejectionIncrement,
    checkpoint,
    warnings,
  };
}
