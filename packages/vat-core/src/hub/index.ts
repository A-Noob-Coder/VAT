// VAT Hub 引擎 (架构设计 §6): 单据调度 · 状态机守卫 · 熔断 · 预算 · 人工卡点 · 崩溃恢复
//
// 设计不变量:
//  1. Hub 是工作区唯一写入者; 角色(LLM)产出必须经校验后由 Hub 落盘
//  2. 单据位置即状态: in/ = 待处理, archive/ = 已处理, _dead/ = 死信, _held/ = 卡点暂扣
//  3. 状态转移只认 TRANSITION_MATRIX; LLM 的 statusSuggestion 仅供参考
//  4. 任一时刻 kill 进程均安全: 重启即从目录重扫恢复
import fs from 'node:fs';
import path from 'node:path';
import type {
  Card,
  Charter,
  CheckpointStage,
  ExecutionMode,
  ExecutorResult,
  HubEvent,
  Priority,
  ResumePoint,
  RoleExecutor,
  StrictGatePort,
  StrictReport,
  Ticket,
  VatConfig,
} from '../types.js';
import { findRole, renderCharter, withRole } from '../charter/index.js';
import { loadCard, listCards, nextCardId, saveCard, appendCardBody } from '../card/index.js';
import { planTurn } from '../card/statemachine.js';
import type { TurnPlan } from '../card/statemachine.js';
import { DEFAULT_MAX_DEV_SELF_REPAIR } from '../types.js';
import { appendEvent } from '../events/index.js';
import { appendLedger, readLedgerDay, summarize, todayKey } from '../ledger/index.js';
import { memorySettingsFor, resolveRoleChain } from '../config.js';
import { readSnapshot, writeMemoryUpdates } from '../memory/index.js';
import type { Notifier } from '../notify/index.js';
import { applySimulationWatermark } from '../executor/scripted.js';
import {
  SeqAllocator,
  createTicket,
  deliverTicket,
  parseTicket,
  scanInbox,
  serializeTicket,
  stamp,
} from '../ticket/index.js';
import type { WorkspacePaths } from '../workspace/index.js';
import { gitAutoCommit } from './git.js';

export interface HubOptions {
  paths: WorkspacePaths;
  charter: Charter;
  config: VatConfig;
  mode: ExecutionMode;
  executor?: RoleExecutor; // run() 需要; 人工命令 (approve/resume/...) 可不传
  strictGate?: StrictGatePort; // strict 模式的真实执行闸门 (M2)
  oneStep?: boolean;
  cardFilter?: string;
  now?: () => Date;
  onEvent?: (event: HubEvent) => void; // CLI 实时打印 / SSE 转发
  /** 多通道通知器: type==='notify' 的单据投递时广播 (需求澄清/熔断裁决等人工介入信号)。 */
  notifier?: Notifier;
}

export type StopReason = 'drained' | 'blocked' | 'budget' | 'checkpoint' | 'single-step' | 'error';

export interface RunResult {
  processed: number;
  stopReason: StopReason;
  message?: string;
  exitCode: number;
}

export class Hub {
  constructor(private readonly opts: HubOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private emit(
    evt: {
      type: Parameters<typeof appendEvent>[1]['type'];
      severity?: Parameters<typeof appendEvent>[1]['severity'];
      role?: string;
      card?: string;
      ticket?: string;
      message: string;
    },
    at = this.now()
  ): HubEvent {
    const event = appendEvent(this.opts.paths.eventsFile(todayKey(at)), evt, at);
    this.opts.onEvent?.(event);
    return event;
  }

  /**
   * 统一投递出口: 落盘 + 通知广播。
   * type==='notify' 的单据 (PM 需求澄清 / 熔断裁决恢复等) 表示需要人介入,
   * 经 Notifier best-effort 广播到所有已启用通道, 单通道失败不阻断流水线。
   */
  private deliverOutgoing(ticket: Ticket, at: Date): void {
    deliverTicket(this.opts.paths, ticket);
    if (ticket.type === 'notify' && this.opts.notifier) {
      void this.opts.notifier
        .notify({
          title: ticket.title,
          body: ticket.body,
          level: 'warn',
          card: ticket.card,
          meta: { from: ticket.from, to: ticket.to, ticketId: ticket.id },
        })
        .then((r) => {
          if (r.failed.length > 0) {
            this.emit({
              type: 'warning',
              severity: 'warning',
              card: ticket.card,
              message: `通知通道部分失败: ${r.failed.map((f) => `${f.id}(${f.error.slice(0, 60)})`).join(', ')}`,
            }, at);
          }
        });
    }
  }

  // ---------- 人工动作 ----------

  /** 主程提需求: 新建卡片 + requirement 单入 PM 收件箱 */
  submitRequirement(input: { title: string; body: string; priority?: Priority }): {
    card: Card;
    ticket: Ticket;
  } {
    const { paths, charter } = this.opts;
    const at = this.now();
    const cardId = nextCardId(paths.boardDir);
    const card: Card = {
      id: cardId,
      title: input.title,
      status: 'backlog',
      frozen: false,
      owner: 'PM',
      priority: input.priority ?? 'P1',
      rejection_count: 0,
      self_repair_count: 0,
      checkpoints_passed: [],
      ticket_chain: [],
      deliverables: [],
      token_used: 0,
      created_at: stamp(at).iso,
      updated_at: stamp(at).iso,
      body: `## 需求原文\n\n${input.body}\n`,
    };
    saveCard(paths, card);
    fs.mkdirSync(paths.taskDocsDir(cardId), { recursive: true }); // K08 任务级记忆地基: tasks/<CARD_ID>/docs

    const seq = this.allocSeq().next(at);
    const ticket = createTicket(
      {
        from: 'USER',
        to: 'PM',
        type: 'requirement',
        card: cardId,
        source: 'human',
        title: `需求: ${input.title}`,
        body: input.body,
        now: at,
      },
      seq
    );
    deliverTicket(paths, ticket);
    this.emit({
      type: 'ticket_arrival',
      severity: 'info',
      card: cardId,
      ticket: ticket.id,
      message: `主程创建卡片 ${cardId} 并投递需求单至 PM-docs/in/`,
    }, at);
    return { card, ticket };
  }

  /** 批准卡点: 释放 _held 单据至目标收件箱 */
  approve(cardId: string, stage: CheckpointStage, note?: string): void {
    const { paths } = this.opts;
    const card = loadCard(paths, cardId);
    if (card.checkpoint?.stage !== stage) {
      throw new Error(`卡片 ${cardId} 当前不处于 ${stage} 卡点`);
    }
    this.releaseHeld(cardId);
    card.checkpoint = undefined;
    card.checkpoints_passed = [...card.checkpoints_passed, stage];
    if (note) {
      const patched = appendCardBody(card, `主程批准 (${stage})`, note);
      saveCard(paths, patched);
    } else {
      saveCard(paths, card);
    }
    this.emit({
      type: 'human_action',
      severity: 'success',
      card: cardId,
      message: `主程批准卡点 ${stage}${note ? `: ${note}` : ''}，暂扣单据已释放`,
    });
    void this.git(`approve ${cardId} ${stage}`);
  }

  /** 驳回卡点: 卡片退回 backlog, 暂扣单据死信, 向 PM 投递驳回说明 */
  reject(cardId: string, stage: CheckpointStage, note: string): void {
    const { paths, charter } = this.opts;
    const card = loadCard(paths, cardId);
    if (card.checkpoint?.stage !== stage) {
      throw new Error(`卡片 ${cardId} 当前不处于 ${stage} 卡点`);
    }
    this.deadLetterHeld(cardId);
    const at = this.now();
    const seq = this.allocSeq().next(at);
    const noteTicket = createTicket(
      {
        from: 'USER',
        to: 'PM',
        type: 'return',
        card: cardId,
        source: 'human',
        title: `[主程驳回] ${card.title}`,
        body: `主程在 ${stage} 卡点驳回了当前方案。\n\n驳回意见:\n${note}`,
        now: at,
      },
      seq
    );
    deliverTicket(paths, noteTicket);
    const patched = appendCardBody(card, `主程驳回 (${stage})`, note);
    saveCard(paths, {
      ...patched,
      status: 'backlog',
      owner: 'PM',
      checkpoint: undefined,
      updated_at: stamp(at).iso,
    });
    this.emit({
      type: 'human_action',
      severity: 'warning',
      card: cardId,
      message: `主程驳回卡点 ${stage}: ${note}；卡片退回 backlog`,
    }, at);
    void findRole(charter, 'PM'); // 章程一致性自检 (PM 必须在编)
    void this.git(`reject ${cardId} ${stage}`);
  }

  /** 熔断裁决恢复 (架构设计 §6.3) */
  resume(cardId: string, point: ResumePoint, note: string): void {
    const { paths } = this.opts;
    const card = loadCard(paths, cardId);
    if (!card.frozen) throw new Error(`卡片 ${cardId} 未处于冻结状态`);
    const at = this.now();
    const target =
      point === 'developing' ? 'DEV' : point === 'review' ? 'REVIEW' : 'PM';
    const status = point === 'redesign' ? 'backlog' : point;

    const seq = this.allocSeq().next(at);
    const noteTicket = createTicket(
      {
        from: 'USER',
        to: target,
        type: 'notify',
        card: cardId,
        source: 'human',
        title: `[熔断裁决] ${card.title} → ${point}`,
        body: `主程对熔断卡片作出裁决: 从 ${point} 恢复。\n\n裁决意见:\n${note}`,
        now: at,
      },
      seq
    );
    deliverTicket(paths, noteTicket);

    saveCard(paths, {
      ...card,
      status,
      owner: target,
      frozen: false,
      frozen_reason: undefined,
      rejection_count: 0,
      checkpoint: undefined,
      updated_at: stamp(at).iso,
      body: card.body + `\n\n## 熔断裁决 (${point})\n\n${note}\n`,
    });
    this.emit({
      type: 'human_action',
      severity: 'success',
      card: cardId,
      message: `主程裁决熔断卡片 ${cardId} 从 ${point} 恢复, 打回计数清零`,
    }, at);
    void this.git(`resume ${cardId} ${point}`);
  }

  /** 招聘角色: 更新章程 frontmatter + 开目录 (架构设计 §5.1) */
  recruitRole(role: { id: string; title: string; responsibilities: string; consumes: string[] }): void {
    const { paths, charter } = this.opts;
    const nextData = withRole(charter, {
      id: role.id,
      title: role.title,
      responsibilities: role.responsibilities,
      consumes: role.consumes as Charter['data']['team']['roles'][number]['consumes'],
    });
    fs.writeFileSync(paths.charterFile, renderCharter({ data: nextData, body: charter.body }), 'utf8');
    fs.mkdirSync(paths.mailboxIn(role.id), { recursive: true });
    fs.mkdirSync(paths.mailboxArchive(role.id), { recursive: true });
    fs.mkdirSync(paths.roleMemoryDir(role.id), { recursive: true });
    this.emit({
      type: 'system',
      severity: 'success',
      role: role.id,
      message: `主程招聘角色 ${role.id} (${role.title}); 章程已更新, 收件箱与记忆区已开辟`,
    });
    void this.git(`recruit ${role.id}`);
  }

  // ---------- 主循环 ----------

  async run(): Promise<RunResult> {
    const { paths, charter } = this.opts;

    // 预算守卫: 团队日限额 (只计真实 LLM 调用)。0 = 不限制 (默认推荐);
    // 真正影响模型性能的是单会话窗口大小 (memory.windowTokenLimit), 而非总量封顶。
    const daily = summarize(readLedgerDay(paths.ledgerFile(todayKey(this.now()))), true);
    const dailyLimit = charter.data.budget.daily_token_limit;
    if (dailyLimit > 0 && daily.billableTokens >= dailyLimit) {
      this.emit({
        type: 'budget_break',
        severity: 'error',
        message: `日 token 预算触顶 (${daily.billableTokens}/${charter.data.budget.daily_token_limit}), 全局挂起派工`,
      });
      return {
        processed: 0,
        stopReason: 'budget',
        exitCode: 3,
        message: '日预算触顶, 请次日再跑或调高章程 budget.daily_token_limit',
      };
    }

    const seq = this.allocSeq();
    let processed = 0;
    const blockers: string[] = [];

    for (;;) {
      const queues = this.scanQueues();
      const picked = this.pickNext(queues, blockers);

      if (!picked) {
        // 卡点检测优先于冻结: 卡点暂扣后队列已空, 需扫看板判断
        const waiting = listCards(paths.boardDir).find((c) => c.checkpoint);
        if (waiting) {
          return {
            processed,
            stopReason: 'checkpoint',
            exitCode: 2,
            message: `等待人工卡点: ${waiting.id} (${waiting.checkpoint?.stage}) — vat approve / vat reject`,
          };
        }
        if (blockers.length > 0) {
          return {
            processed,
            stopReason: 'blocked',
            exitCode: 0,
            message: `流水线被冻结卡片挂起: ${blockers.join('; ')}`,
          };
        }
        return { processed, stopReason: 'drained', exitCode: 0, message: '所有单据处理完毕' };
      }

      try {
        await this.processOne(picked.card, picked.ticket, seq);
        processed += 1;
      } catch (err) {
        this.emit({
          type: 'warning',
          severity: 'error',
          card: picked.card,
          ticket: picked.ticket.id,
          message: `处理单据失败, 保留在收件箱待重试: ${(err as Error).message}`,
        });
        return {
          processed,
          stopReason: 'error',
          exitCode: 1,
          message: (err as Error).message,
        };
      }

      if (this.opts.oneStep) {
        return { processed, stopReason: 'single-step', exitCode: 0 };
      }
    }
  }

  // ---------- 内部实现 ----------

  private allocSeq(at = this.now()): SeqAllocator {
    const allocator = new SeqAllocator();
    const { paths, charter } = this.opts;
    const dirs: string[] = [paths.deadDir, paths.heldDir];
    for (const role of charter.data.team.roles) {
      dirs.push(paths.mailboxIn(role.id), paths.mailboxArchive(role.id));
    }
    allocator.seedFromDirectories(dirs);
    void at;
    return allocator;
  }

  private scanQueues(): Map<string, Ticket[]> {
    const { paths, charter } = this.opts;
    const queues = new Map<string, Ticket[]>();
    const rosterIds = new Set(charter.data.team.roles.map((r) => r.id));
    for (const role of charter.data.team.roles) {
      let tickets: Ticket[];
      try {
        tickets = scanInbox(paths.mailboxIn(role.id));
      } catch (err) {
        this.emit({ type: 'warning', severity: 'error', role: role.id, message: (err as Error).message });
        continue;
      }
      for (const ticket of tickets) {
        if (!fs.existsSync(paths.cardFile(ticket.card))) {
          this.deadLetter(ticket, `引用的卡片 ${ticket.card} 不存在`, role.id);
          continue;
        }
        const list = queues.get(ticket.card) ?? [];
        list.push(ticket);
        queues.set(ticket.card, list);
      }
    }
    // 编制外邮箱 (角色被移出章程后的残留) 一律死信, 不静默忽略
    if (fs.existsSync(paths.ticketsDir)) {
      for (const entry of fs.readdirSync(paths.ticketsDir)) {
        const match = /^(.+)-docs$/.exec(entry);
        if (!match?.[1] || rosterIds.has(match[1])) continue;
        const inbox = path.join(paths.ticketsDir, entry, 'in');
        if (!fs.existsSync(inbox)) continue;
        for (const ticket of scanInbox(inbox)) {
          this.deadLetter(ticket, `接收角色 ${match[1]} 不在章程编制内`, match[1]);
        }
      }
    }
    for (const list of queues.values()) {
      list.sort((a, b) => (a.created_at + a.seq).localeCompare(b.created_at + b.seq));
    }
    return queues;
  }

  private pickNext(
    queues: Map<string, Ticket[]>,
    blockers: string[]
  ): { card: string; ticket: Ticket } | undefined {
    blockers.length = 0;
    let best: { card: string; ticket: Ticket } | undefined;
    for (const [cardId, list] of queues) {
      if (this.opts.cardFilter && cardId !== this.opts.cardFilter) continue;
      if (list.length === 0) continue;
      const card = loadCard(this.opts.paths, cardId);
      if (card.checkpoint) {
        blockers.push(`checkpoint:${cardId} (${card.checkpoint.stage})`);
        continue;
      }
      if (card.frozen) {
        blockers.push(`frozen:${cardId} (${card.frozen_reason ?? 'rejections'})`);
        continue;
      }
      const perCardLimit = this.opts.charter.data.budget.per_card_token_limit;
      if (perCardLimit > 0 && card.token_used >= perCardLimit) {
        this.freezeCard(card, 'budget', '单卡 token 预算触顶');
        blockers.push(`frozen:${cardId} (budget)`);
        continue;
      }
      const head = list[0];
      if (head && (!best || head.created_at < best.ticket.created_at)) {
        best = { card: cardId, ticket: head };
      }
    }
    return best;
  }

  private async processOne(cardId: string, ticket: Ticket, seq: SeqAllocator): Promise<void> {
    const { paths, charter, config } = this.opts;
    const at = this.now();
    const card = loadCard(paths, cardId);
    const role = findRole(charter, ticket.to);
    if (!role) {
      this.deadLetter(ticket, `接收角色 ${ticket.to} 不在章程编制内`, ticket.to);
      return;
    }

    this.emit({
      type: 'role_wake',
      severity: 'info',
      role: role.id,
      card: cardId,
      ticket: ticket.id,
      message: `单据 [${ticket.fileName}] 唤醒 ${role.title} (模式: ${this.opts.mode})`,
    }, at);

    const memorySettings = memorySettingsFor(config, resolveRoleChain(config, role.id)[0]);
    const memory = readSnapshot(paths.roleMemoryDir(role.id), memorySettings);

    let result: ExecutorResult;
    if (!this.opts.executor) {
      throw new Error('Hub 未配置执行器 (executor)');
    }
    try {
      result = await this.opts.executor.run({ role, charter, ticket, card, memory, mode: this.opts.mode });
    } catch (err) {
      // 执行失败: 单据保留在 in/, 下次 run 重试 (崩溃安全语义)
      this.emit({
        type: 'warning',
        severity: 'error',
        role: role.id,
        card: cardId,
        ticket: ticket.id,
        message: `角色执行失败 (${(err as Error).message}); 单据保留待重试`,
      }, at);
      throw err;
    }

    // 校验产出 (scripted 产出也过校验, 保持同一信任边界)
    // 演练模式诚实性: 产出统一标注 (架构设计 §2.2 原则三)
    let output = result.output;
    if (this.opts.mode === 'simulation') output = applySimulationWatermark(output);
    if (output.memoryUpdates?.summaryUpdate && output.memoryUpdates.summaryUpdate.length > memorySettings.summaryWarnChars) {
      this.emit({
        type: 'warning',
        severity: 'warning',
        role: role.id,
        message: `summaryUpdate 超阈值 (${output.memoryUpdates.summaryUpdate.length}/${memorySettings.summaryWarnChars}), 已截断`,
      }, at);
    }

    // 状态机规划 (非法迁移 → 降级为 warning, 保留原状态)
    let plan: TurnPlan;
    try {
      plan = planTurn(card, role.id, output, charter.data.checkpoints);
      for (const warning of plan.warnings) {
        this.emit({ type: 'warning', severity: 'warning', card: cardId, role: role.id, message: warning }, at);
      }
    } catch (err) {
      this.emit({
        type: 'warning',
        severity: 'warning',
        card: cardId,
        role: role.id,
        message: (err as Error).message,
      }, at);
      plan = { hops: [], nextStatus: card.status, rejectionIncrement: 0, checkpoint: null, warnings: [] };
    }

    // 交付物落盘
    const deliverableRefs = [...card.deliverables];
    if (output.deliverable) {
      const ref = this.saveDeliverable(cardId, role.id, result.source, output.deliverable, at);
      deliverableRefs.push(ref);
      this.emit({
        type: 'role_complete',
        severity: 'success',
        role: role.id,
        card: cardId,
        message: `${role.title} 产出交付物「${output.deliverable.title}」(${output.deliverable.type}, source: ${result.source})`,
      }, at);
    }
    if (output.codeFiles && output.codeFiles.length > 0) {
      const projectDir = paths.cardProjectDir(cardId);
      for (const f of output.codeFiles) {
        const dest = path.join(projectDir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content, 'utf8');
      }
      this.emit({
        type: 'role_complete',
        severity: 'info',
        role: role.id,
        card: cardId,
        message: `${role.title} 写入工程文件 ${output.codeFiles.length} 个 → projects/${cardId}/`,
      }, at);
    }

    // strict 闸门 (架构设计 §8.2): 真实执行验证, 独立于任何角色
    let rejectionIncrement = plan.rejectionIncrement;
    let selfRepair = card.self_repair_count;
    const effectiveDrafts = [...output.tickets];
    const prebuiltTickets: Ticket[] = []; // 闸门签发的 defect 单 (source: strict-runner)
    if (this.opts.strictGate && this.opts.mode === 'strict') {
      const gate = this.opts.strictGate;
      const projectDir = paths.cardProjectDir(cardId);

      // DEV 提审闸门: 代码必须通过真实编译/测试才能进入 review
      if (role.id === 'DEV' && plan.hops.some((h) => h.to === 'review')) {
        if (!output.codeFiles || output.codeFiles.length === 0) {
          this.emit({
            type: 'warning',
            severity: 'warning',
            role: role.id,
            card: cardId,
            message: 'strict 模式下 DEV 提审未附带 codeFiles, 闸门无法验证, 视为未通过',
          }, at);
          const applied = this.applyGateRejection(plan, {
            card, role: role.id, at, seq, reasonSummary: 'DEV 未提交可执行代码文件 (codeFiles 为空)',
            detail: 'strict 模式要求 DEV 产出真实工程文件', selfRepairBefore: selfRepair,
          });
          plan = applied.plan;
          if (applied.defectTicket) prebuiltTickets.push(applied.defectTicket);
          selfRepair = applied.selfRepair;
          effectiveDrafts.length = 0;
          rejectionIncrement = plan.rejectionIncrement;
        } else {
          const report = await gate.runGate({ cardId, projectDir });
          deliverableRefs.push(
            this.saveDeliverable(cardId, 'STRICT', 'strict-runner', {
              title: `StrictRunner 报告 (${report.ok ? '通过' : '未通过'})`,
              type: 'test',
              content: renderStrictReportMd(report),
            }, at)
          );
          if (report.ok) {
            selfRepair = 0; // 闸门通过, 自修环清零
            this.emit({
              type: 'system',
              severity: 'success',
              role: role.id,
              card: cardId,
              message: `🛡 strict 闸门通过: ${report.summary}`,
            }, at);
          } else {
            const applied = this.applyGateRejection(plan, {
              card, role: role.id, at, seq, reasonSummary: report.summary,
              detail: renderGateDetail(report), selfRepairBefore: selfRepair,
            });
            plan = applied.plan;
            if (applied.defectTicket) prebuiltTickets.push(applied.defectTicket);
            selfRepair = applied.selfRepair;
            effectiveDrafts.length = 0; // 打回单由闸门签发, DEV 的提审单不再投递
            rejectionIncrement = plan.rejectionIncrement;
          }
        }
      }

      // QA 测试闸门: QA 追加的测试文件真实执行, 失败即真实打回
      if (role.id === 'QA' && output.codeFiles && output.codeFiles.length > 0) {
        const report = await gate.runGate({ cardId, projectDir });
        deliverableRefs.push(
          this.saveDeliverable(cardId, 'STRICT', 'strict-runner', {
            title: `StrictRunner 验收报告 (${report.ok ? '通过' : '未通过'})`,
            type: 'test',
            content: renderStrictReportMd(report),
          }, at)
        );
        if (report.ok) {
          this.emit({
            type: 'system',
            severity: 'success',
            role: role.id,
            card: cardId,
            message: `🛡 strict 验收闸门通过: ${report.summary}`,
          }, at);
        } else {
          // 阻断签发: QA 的 notify 不投递, 卡片按矩阵打回 developing, 计一次正式打回
          for (let i = effectiveDrafts.length - 1; i >= 0; i--) {
            const d = effectiveDrafts[i];
            if (d && d.type === 'notify' && d.to === 'PM') effectiveDrafts.splice(i, 1);
          }
          plan = {
            hops: [{ from: card.status, to: 'developing' }],
            nextStatus: 'developing',
            rejectionIncrement: rejectionIncrement + 1,
            checkpoint: null,
            warnings: [],
          };
          rejectionIncrement = plan.rejectionIncrement;
          prebuiltTickets.push(
            createTicket(
              {
                from: 'STRICT',
                to: 'DEV',
                type: 'defect',
                card: cardId,
                source: 'strict-runner',
                title: `[strict 验收未通过] ${card.title}: ${report.summary}`,
                body: renderGateDetail(report),
                now: this.now(),
              },
              seq.next(this.now())
            )
          );
          this.emit({
            type: 'system',
            severity: 'error',
            role: role.id,
            card: cardId,
            message: `🛡 strict 验收闸门未通过: ${report.summary}; 真实打回至 DEV`,
          }, at);
        }
      }
    }

    // 产出单据: 校验 toRole → 卡点暂扣 或 投递收件箱; 编制外目标 → 死信留证
    const outgoing: Ticket[] = [];
    for (const draft of effectiveDrafts) {
      if (!findRole(charter, draft.to)) {
        const rogue = createTicket(
          {
            from: role.id,
            to: draft.to,
            type: draft.type,
            card: cardId,
            source: result.source,
            title: draft.title,
            body: draft.body,
            now: this.now(),
          },
          seq.next(this.now())
        );
        this.writeDeadLetter(rogue, `产出单据的 toRole "${draft.to}" 不在章程编制内`);
        continue;
      }
      outgoing.push(
        createTicket(
          {
            from: role.id,
            to: draft.to,
            type: draft.type,
            card: cardId,
            source: result.source,
            title: draft.title,
            body: draft.body,
            now: this.now(),
          },
          seq.next(this.now())
        )
      );
    }
    outgoing.push(...prebuiltTickets);

    let checkpointStage: CheckpointStage | null = plan.checkpoint;
    for (const t of outgoing) {
      if (checkpointStage) {
        this.holdTicket(cardId, t);
      } else {
        this.deliverOutgoing(t, at);
        this.emit({
          type: 'ticket_arrival',
          severity: 'info',
          role: role.id,
          card: cardId,
          ticket: t.id,
          message: `${role.title} 向 ${t.to}-docs/in/ 投递 [${t.fileName}]: ${t.title}`,
        }, at);
      }
    }
    if (checkpointStage) {
      this.emit({
        type: 'checkpoint_wait',
        severity: 'warning',
        card: cardId,
        message: `卡片 ${cardId} 进入人工卡点 ${checkpointStage}; ${outgoing.length} 张单据暂扣于 tickets/_held/${cardId}/, 等待主程 approve/reject`,
      }, at);
    }

    // 停滞检测: 无产出单据且无状态推进 → 流水线将卡死, 显式告警
    if (outgoing.length === 0 && plan.hops.length === 0 && card.status !== 'done') {
      this.emit({
        type: 'warning',
        severity: 'warning',
        role: role.id,
        card: cardId,
        message: `${role.title} 完成处理但未产出任何单据且状态未推进; 卡片 ${cardId} 可能停滞, 需主程介入`,
      }, at);
    }

    // 卡片状态更新
    const rejectionCount = card.rejection_count + plan.rejectionIncrement;
    const maxRejections = charter.data.circuit_breaker.max_rejections;
    const frozen = rejectionCount >= maxRejections;
    const nextOwner = outgoing[outgoing.length - 1]?.to ?? role.id;
    const hops = plan.hops;
    const lastHop = hops[hops.length - 1];
    const status = lastHop ? lastHop.to : card.status;

    const chain = new Set(card.ticket_chain);
    chain.add(ticket.id);
    for (const t of outgoing) chain.add(t.id);

    const updated: Card = {
      ...card,
      status,
      owner: nextOwner,
      rejection_count: rejectionCount,
      self_repair_count: selfRepair,
      frozen: frozen || card.frozen,
      frozen_reason: frozen ? `累计打回 ${rejectionCount} 次 (≥${maxRejections})` : card.frozen_reason,
      ticket_chain: [...chain],
      deliverables: deliverableRefs,
      token_used: card.token_used + (result.usage?.totalTokens ?? 0),
      checkpoint: checkpointStage ? { stage: checkpointStage, since: stamp(at).iso } : card.checkpoint,
      updated_at: stamp(at).iso,
    };
    saveCard(paths, updated);

    for (const hop of hops) {
      this.emit({
        type: 'status_change',
        severity: 'info',
        card: cardId,
        role: role.id,
        message: `卡片状态 ${hop.from} → ${hop.to} (由 ${role.id} 推进)`,
      }, at);
    }
    if (frozen && !card.frozen) {
      this.emit({
        type: 'circuit_break',
        severity: 'error',
        card: cardId,
        message: `🚨 打回熔断: 卡片 ${cardId} 累计打回 ${rejectionCount}/${maxRejections}, 已冻结; 等待主程 vat resume`,
      }, at);
    }

    // 记忆更新
    const memWarnings = writeMemoryUpdates(paths.roleMemoryDir(role.id), output.memoryUpdates, memorySettings);
    for (const w of memWarnings) {
      this.emit({ type: 'warning', severity: 'warning', role: role.id, message: w }, at);
    }

    // 账本: 只记真实调用 (scripted 不计入预算)
    if (result.usage) {
      appendLedger(paths.ledgerFile(todayKey(this.now())), {
        ts: stamp(this.now()).iso,
        role: role.id,
        card: cardId,
        ticket: ticket.id,
        providerId: result.providerId ?? 'unknown',
        model: result.model ?? 'unknown',
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        latencyMs: result.latencyMs ?? 0,
        source: result.source,
      });
    }

    this.emit({
      type: 'role_complete',
      severity: 'success',
      role: role.id,
      card: cardId,
      ticket: ticket.id,
      message: `${role.title} 完成处理: ${output.action}`,
    }, at);

    // 归档已处理单据
    this.archiveTicket(ticket);
    await this.git(`hub: ${cardId} ${ticket.id} by ${role.id}`);
  }

  private saveDeliverable(
    cardId: string,
    roleId: string,
    source: string,
    deliverable: { title: string; type: string; content: string },
    at: Date
  ): Card['deliverables'][number] {
    const { paths } = this.opts;
    const dir = paths.cardDeliverableDir(cardId);
    fs.mkdirSync(dir, { recursive: true });
    const slug = deliverable.title
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const index = fs.readdirSync(dir).length + 1;
    const file = path.join(dir, `${String(index).padStart(2, '0')}-${roleId}-${slug || 'deliverable'}.md`);
    const header = [
      '---',
      `title: ${JSON.stringify(deliverable.title)}`,
      `type: ${deliverable.type}`,
      `source: ${source}`,
      `role: ${roleId}`,
      `created_at: ${stamp(at).iso}`,
      '---',
      '',
      '',
    ].join('\n');
    fs.writeFileSync(file, header + deliverable.content + '\n', 'utf8');
    return {
      title: deliverable.title,
      type: deliverable.type as Card['deliverables'][number]['type'],
      source: source as Card['deliverables'][number]['source'],
      role: roleId,
      path: path.relative(paths.root, file),
      timestamp: stamp(at).iso,
    };
  }

  private holdTicket(cardId: string, ticket: Ticket): void {
    const { paths } = this.opts;
    const dir = path.join(paths.heldDir, cardId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ticket.fileName), serializeTicket(ticket), 'utf8');
  }

  private releaseHeld(cardId: string): void {
    const { paths } = this.opts;
    const dir = path.join(paths.heldDir, cardId);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      const ticket = parseTicket(name, fs.readFileSync(file, 'utf8'));
      deliverTicket(paths, ticket);
      this.emit({
        type: 'ticket_arrival',
        severity: 'info',
        card: cardId,
        ticket: ticket.id,
        message: `卡点放行: [${name}] → ${ticket.to}-docs/in/`,
      });
      fs.rmSync(file);
    }
  }

  private deadLetterHeld(cardId: string): void {
    const { paths } = this.opts;
    const dir = path.join(paths.heldDir, cardId);
    if (!fs.existsSync(dir)) return;
    fs.mkdirSync(paths.deadDir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      fs.renameSync(path.join(dir, name), path.join(paths.deadDir, `${cardId}-${name}`));
    }
  }

  /** 死信: 将单据移入 _dead/ 并记录事件 (fromRoleId 指明其所在收件箱; 未落盘的产出单据只记事件) */
  private deadLetter(ticket: Ticket, reason: string, fromRoleId?: string): void {
    const { paths } = this.opts;
    if (fromRoleId) {
      const src = path.join(paths.mailboxIn(fromRoleId), ticket.fileName);
      if (fs.existsSync(src)) {
        fs.mkdirSync(paths.deadDir, { recursive: true });
        fs.renameSync(src, path.join(paths.deadDir, ticket.fileName));
      }
    }
    this.emit({
      type: 'dead_letter',
      severity: 'error',
      ticket: ticket.id,
      card: ticket.card,
      message: `单据死信 [${ticket.fileName}]: ${reason}`,
    });
  }

  /** 死信写入 (单据从未落盘时, 保留违规产出作为审计证据) */
  private writeDeadLetter(ticket: Ticket, reason: string): void {
    const { paths } = this.opts;
    fs.mkdirSync(paths.deadDir, { recursive: true });
    fs.writeFileSync(path.join(paths.deadDir, ticket.fileName), serializeTicket(ticket), 'utf8');
    this.emit({
      type: 'dead_letter',
      severity: 'error',
      ticket: ticket.id,
      card: ticket.card,
      message: `单据死信 [${ticket.fileName}]: ${reason}`,
    });
  }

  private archiveTicket(ticket: Ticket): void {
    const { paths } = this.opts;
    const inbox = paths.mailboxIn(ticket.to);
    const archive = paths.mailboxArchive(ticket.to);
    const src = path.join(inbox, ticket.fileName);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(archive, { recursive: true });
    let dest = path.join(archive, ticket.fileName);
    if (fs.existsSync(dest)) dest = path.join(archive, ticket.fileName.replace(/\.md$/, `-r${Date.now()}.md`));
    fs.renameSync(src, dest);
  }

  private freezeCard(card: Card, reason: string, detail: string): void {
    const { paths } = this.opts;
    saveCard(paths, {
      ...card,
      frozen: true,
      frozen_reason: detail,
      updated_at: stamp(this.now()).iso,
    });
    this.emit({
      type: 'budget_break',
      severity: 'error',
      card: card.id,
      message: `卡片 ${card.id} 因 ${reason} 冻结: ${detail}`,
    });
  }

  /**
   * strict 闸门失败 → 阻断提审, 生成 defect 单回 DEV (自修环):
   * 失败次数 ≤ max_dev_self_repair 时仅自修; 耗尽后每次失败计一次正式打回 (进入熔断计数)。
   */
  private applyGateRejection(
    plan: TurnPlan,
    args: {
      card: Card;
      role: string;
      at: Date;
      seq: SeqAllocator;
      reasonSummary: string;
      detail: string;
      selfRepairBefore: number;
    }
  ): { plan: TurnPlan; defectTicket: Ticket | null; selfRepair: number } {
    const { card, at, seq, reasonSummary, detail, selfRepairBefore } = args;
    const maxSelf =
      this.opts.charter.data.execution.strict?.max_dev_self_repair ?? DEFAULT_MAX_DEV_SELF_REPAIR;
    const selfRepair = selfRepairBefore + 1;
    const formal = selfRepair > maxSelf;
    const rejectionIncrement = formal ? plan.rejectionIncrement + 1 : 0;

    // 保留进入 developing 的迁移 (工作已存在), 仅阻断进入 review
    const hops = plan.hops.filter((h) => h.to !== 'review');
    const nextPlan: TurnPlan = {
      hops,
      nextStatus: hops[hops.length - 1]?.to ?? card.status,
      rejectionIncrement,
      checkpoint: plan.checkpoint,
      warnings: plan.warnings,
    };

    const defectTicket = createTicket(
      {
        from: 'STRICT',
        to: 'DEV',
        type: 'defect',
        card: card.id,
        source: 'strict-runner',
        title: `[strict 闸门未通过] ${card.title}: ${reasonSummary}${formal ? ` (自修环已耗尽, 计入正式打回 ${rejectionIncrement})` : ` (自修环 ${selfRepair}/${maxSelf})`}`,
        body: detail,
        now: at,
      },
      seq.next(at)
    );

    this.emit({
      type: 'system',
      severity: 'error',
      role: args.role,
      card: card.id,
      ticket: defectTicket.id,
      message: formal
        ? `🛡 strict 闸门未通过: ${reasonSummary}; 自修环耗尽, 计入正式打回 (累计 ${card.rejection_count + rejectionIncrement})`
        : `🛡 strict 闸门未通过: ${reasonSummary}; defect 已打回 DEV (自修环 ${selfRepair}/${maxSelf})`,
    }, at);

    return { plan: nextPlan, defectTicket, selfRepair };
  }

  private async git(message: string): Promise<void> {
    await gitAutoCommit(this.opts.paths.root, `vat: ${message}`, this.opts.config.git?.autocommit ?? false);
  }
}

// StrictRunner 报告 → Markdown 交付物 (真实执行输出的审计呈现)
function renderStrictReportMd(report: StrictReport): string {
  const lines: string[] = [
    '# StrictRunner 执行报告',
    '',
    `**结论: ${report.ok ? '✅ 通过' : '❌ 未通过'}** — ${report.summary}`,
    '',
    `工程目录: \`${report.projectDir}\``,
    '',
    '| 闸门 | 结果 | 耗时 | 摘要 |',
    '|---|---|---|---|',
  ];
  for (const s of report.steps) {
    const icon = s.status === 'ok' ? '✅' : s.status === 'fail' ? '❌' : '⏭️';
    lines.push(`| ${s.name} | ${icon} ${s.status} | ${s.durationMs}ms | ${s.summary.replace(/\|/g, '\|')} |`);
  }
  if (report.tests) {
    lines.push('', `**测试统计**: 总计 ${report.tests.total} · 通过 ${report.tests.passed} · 失败 ${report.tests.failed}`);
  }
  for (const s of report.steps) {
    if (s.detail) {
      lines.push('', `## ${s.name} 输出 (截断)`, '', '```', s.detail, '```');
    }
  }
  return lines.join('\n') + '\n';
}

// defect 单正文: 失败步骤 + 真实输出 (截断)
function renderGateDetail(report: StrictReport): string {
  const failed = report.steps.filter((s) => s.status === 'fail');
  const parts: string[] = [
    '## strict 闸门执行结果',
    '',
    `结论: ${report.ok ? '通过' : '未通过'} — ${report.summary}`,
  ];
  if (report.tests) {
    parts.push('', `测试: 总计 ${report.tests.total}, 通过 ${report.tests.passed}, 失败 ${report.tests.failed}`);
  }
  for (const s of failed.length > 0 ? failed : report.steps) {
    parts.push('', `### 闸门 ${s.name} (${s.status})`, '', '```', (s.detail ?? s.summary).slice(0, 4000), '```');
  }
  return parts.join('\n') + '\n';
}
