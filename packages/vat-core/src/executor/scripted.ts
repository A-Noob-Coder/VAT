// ScriptedExecutor: 确定性演练执行器 —— 诚实仿真 + e2e 测试夹具二合一 (架构设计 §7.2)
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  ExecutorResult,
  RoleContext,
  RoleExecutor,
  RoleOutput,
  TicketType,
} from '../types.js';

export class ScriptMismatchError extends Error {
  constructor(roleId: string, ticketType: TicketType, scenarioName: string) {
    super(
      `演练剧本 "${scenarioName}" 中没有匹配步骤: role=${roleId}, ticketType=${ticketType}。` +
        `请补齐 when: { role: ${roleId}, ticketType: ${ticketType} } 的步骤。`
    );
  }
}

export interface ScenarioStep {
  when: { role: string; ticketType?: TicketType };
  thought: string;
  action: string;
  tickets?: Array<{ to: string; type: TicketType; title: string; body: string }>;
  memoryUpdates?: RoleOutput['memoryUpdates'];
  deliverable?: { title: string; type: string; content?: string; file?: string };
  codeFiles?: Array<{ path: string; content: string }>;
  statusSuggestion?: RoleOutput['statusSuggestion'];
  repeat?: boolean; // 允许重复命中 (如"始终打回"的评审角色)
}

export interface Scenario {
  name: string;
  description?: string;
  steps: ScenarioStep[];
}

export function loadScenario(file: string): Scenario {
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) as Scenario;
  if (!raw?.name || !Array.isArray(raw.steps)) {
    throw new Error(`演练剧本 ${path.basename(file)} 缺少 name/steps`);
  }
  return raw;
}

export class ScriptedExecutor implements RoleExecutor {
  readonly kind = 'scripted' as const;

  private consumed = new Set<number>();
  private stateFile?: string;

  constructor(
    private readonly scenario: Scenario,
    private readonly baseDir?: string, // 解析 deliverable.file 的相对目录
    stateFile?: string // 游标持久化: CLI 跨进程多次 run 时保持剧本进度
  ) {
    if (stateFile) {
      this.stateFile = stateFile;
      try {
        if (fs.existsSync(stateFile)) {
          const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { consumed?: number[] };
          this.consumed = new Set(raw.consumed ?? []);
        }
      } catch {
        this.consumed = new Set();
      }
    }
  }

  private persistState(): void {
    if (!this.stateFile) return;
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify({ scenario: this.scenario.name, consumed: [...this.consumed] }, null, 2),
      'utf8'
    );
  }

  run(ctx: RoleContext): Promise<ExecutorResult> {
    const step = this.matchStep(ctx.role.id, ctx.ticket.type);
    if (!step) throw new ScriptMismatchError(ctx.role.id, ctx.ticket.type, this.scenario.name);

    let deliverable: RoleOutput['deliverable'];
    if (step.deliverable) {
      if (step.deliverable.file) {
        const file = path.resolve(this.baseDir ?? process.cwd(), step.deliverable.file);
        deliverable = {
          title: step.deliverable.title,
          type: step.deliverable.type as NonNullable<RoleOutput['deliverable']>['type'],
          content: fs.readFileSync(file, 'utf8'),
        };
      } else {
        deliverable = {
          title: step.deliverable.title,
          type: step.deliverable.type as NonNullable<RoleOutput['deliverable']>['type'],
          content: step.deliverable.content ?? '',
        };
      }
    }

    const output: RoleOutput = {
      thought: step.thought,
      action: step.action,
      tickets: (step.tickets ?? []).map((t) => ({ ...t })),
      memoryUpdates: step.memoryUpdates,
      deliverable,
      codeFiles: step.codeFiles,
      statusSuggestion: step.statusSuggestion,
    };

    return Promise.resolve({ output, source: 'scripted' });
  }

  private matchStep(roleId: string, ticketType: TicketType): ScenarioStep | undefined {
    const steps = this.scenario.steps;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      if (step.when.role !== roleId) continue;
      if (step.when.ticketType && step.when.ticketType !== ticketType) continue;
      if (this.consumed.has(i)) continue; // 已消费 (跨进程持久)
      if (!step.repeat) {
        this.consumed.add(i);
        this.persistState();
      }
      return step;
    }
    return undefined;
  }
}

/**
 * 演练模式的诚实性约束 (架构设计 §2.2 原则三):
 * 所有演练产出统一标注, 禁止与真实产出混淆。
 */
export function applySimulationWatermark(output: RoleOutput): RoleOutput {
  const mark = '\n\n> ⚠️ 演练数据 (simulation): 本内容来自预置剧本, 非真实模型产出。\n';
  return {
    ...output,
    thought: `[演练] ${output.thought}`,
    deliverable: output.deliverable
      ? { ...output.deliverable, content: output.deliverable.content + mark }
      : undefined,
  };
}
