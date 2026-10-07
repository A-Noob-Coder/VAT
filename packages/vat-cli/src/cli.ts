#!/usr/bin/env node
// VAT CLI (架构设计 §9.1): 单人虚拟研发团队的命令行驾驶舱
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type {
  Card,
  CheckpointStage,
  ExecutionMode,
  ModelClient,
  Priority,
  ResumePoint,
  RoleExecutor,
} from '@vat/core';
import {
  Hub,
  LlmExecutor,
  LeaderLock,
  Watcher,
  ScriptedExecutor,
  checkWorkspace,
  compressMemory,
  initWorkspace,
  listCards,
  loadCard,
  loadConfig,
  loadEnv,
  loadScenario,
  parseCharter,
  readEvents,
  readLedgerDay,
  readSnapshot,
  resolvePaths,
  summarize,
  todayKey,
  buildNotifier,
  resolveRoleChain,
  CharterError,
  ConfigError,
  DEFAULT_MEMORY_SETTINGS,
} from '@vat/core';
import { ModelRouter, suggestChain } from '@vat/providers';
import { StrictRunner, dockerAvailable, resolveToolchainBin } from '@vat/strict';

// ---------- 输出助手 ----------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const gold = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function fail(message: string): never {
  console.error(red(`✗ ${message}`));
  process.exit(1);
}

// ---------- 上下文装载 ----------

interface Ctx {
  root: string;
  paths: ReturnType<typeof resolvePaths>;
  charter: ReturnType<typeof parseCharter>;
  config: ReturnType<typeof loadConfig>;
}

function loadContext(root: string): Ctx {
  const paths = resolvePaths(root);
  // .env: key 不进 config、不进 shell 历史 (cwd 优先, 工作区根兜底)
  loadEnv(process.cwd(), root);
  if (!fs.existsSync(paths.charterFile)) {
    fail(`未找到工作区章程 ${paths.charterFile} — 先运行 vat init`);
  }
  let charter;
  let config;
  try {
    charter = parseCharter(fs.readFileSync(paths.charterFile, 'utf8'));
  } catch (err) {
    fail((err as CharterError).message);
  }
  try {
    config = loadConfig(paths.configFile);
  } catch (err) {
    fail((err as ConfigError).message);
  }
  return { root, paths, charter, config };
}

function scenarioFileFor(ctx: Ctx, scenarioFile?: string): string {
  const dir = ctx.paths.scenariosDir;
  const file =
    scenarioFile ??
    (() => {
      if (!fs.existsSync(dir)) fail(`演练模式需要剧本: ${dir} 不存在`);
      const yamls = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
      if (yamls.length !== 1) {
        fail(`scenarios/ 下应有且仅有一个剧本 (找到 ${yamls.length} 个), 或用 --scenario 指定`);
      }
      const found = yamls[0];
      if (!found) fail('scenarios/ 下未找到剧本文件');
      return path.join(dir, found);
    })();
  return file;
}

function buildScripted(ctx: Ctx, scenarioFile?: string): ScriptedExecutor {
  const file = scenarioFileFor(ctx, scenarioFile);
  const scenario = loadScenario(file);
  console.log(dim(`[演练剧本] ${scenario.name} — 产出将标注"演练数据"`));
  const stateFile = path.join(ctx.paths.scenariosDir, `.${path.basename(file)}.state.json`);
  return new ScriptedExecutor(scenario, path.dirname(file), stateFile);
}

function buildExecutor(ctx: Ctx, mode: ExecutionMode, scenarioFile?: string): RoleExecutor {
  if (mode === 'simulation') return buildScripted(ctx, scenarioFile);
  // strict 模式同样支持剧本驱动 (无 API Key 也能演示真实闸门): --scenario
  if (mode === 'strict' && scenarioFile) return buildScripted(ctx, scenarioFile);
  const providers = ctx.config.providers ?? [];
  const globalChain = ctx.config.modelChain ?? [];
  if (providers.length === 0) {
    fail('vat.config.json 缺少 providers 配置, 无法进入该模式');
  }

  // 按角色解析模型通道: 不同角色可走各自擅长的模型 API (roleModels), 缺省回退全局 modelChain。
  // 相同链路的角色共享同一个路由器实例, 从而共享限频冷却状态。
  const routerCache = new Map<string, ModelClient>();
  const clientForRole = (roleId: string): ModelClient => {
    const chain = resolveRoleChain(ctx.config, roleId);
    const effective = chain.length > 0 ? chain : globalChain;
    if (effective.length === 0) {
      throw new Error(
        `角色 ${roleId} 没有可用的模型链路 (roleModels 与 modelChain 均为空或无效)`
      );
    }
    const key = effective.join('>');
    let client = routerCache.get(key);
    if (!client) {
      const router = new ModelRouter(providers, effective);
      client = { generate: (req) => router.generate(req) };
      routerCache.set(key, client);
    }
    return client;
  };

  return new LlmExecutor(clientForRole);
}

function buildStrictGate(ctx: Ctx): StrictRunner {
  const strict = ctx.charter.data.execution.strict ?? {};
  const binDir = resolveToolchainBin();
  if (!binDir) {
    console.log(gold('⚠ 未找到 tsc/vitest 工具链, 闸门将回退 npx --yes (需网络)'));
  }
  return new StrictRunner({
    binDir,
    install: strict.install ?? 'auto',
    dockerBuild: strict.docker_build ?? 'auto',
    enableTsc: strict.tsc ?? true,
    enableVitest: strict.vitest ?? true,
  });
}

function buildHub(
  ctx: Ctx,
  mode: ExecutionMode,
  opts: { step?: boolean; card?: string; scenario?: string; quiet?: boolean } = {}
): Hub {
  const executor =
    mode === 'simulation' || mode === 'draft' || (mode === 'strict' && opts.scenario)
      ? buildExecutor(ctx, mode, opts.scenario)
      : mode === 'strict'
        ? buildExecutor(ctx, 'draft')
        : undefined;
  const strictGate = mode === 'strict' ? buildStrictGate(ctx) : undefined;
  const notifier = buildNotifier(ctx.config, {
    logger: opts.quiet ? undefined : (l) => console.error(dim(l)),
  });
  return new Hub({
    paths: ctx.paths,
    charter: ctx.charter,
    config: ctx.config,
    mode,
    executor,
    strictGate,
    notifier,
    oneStep: opts.step,
    cardFilter: opts.card,
    onEvent: opts.quiet
      ? undefined
      : (e) => {
          const icon =
            e.severity === 'error' ? '✗' : e.severity === 'warning' ? '⚠' : e.severity === 'success' ? '✓' : '·';
          console.log(
            dim(`[${new Date(e.ts).toLocaleTimeString()}]`) +
              ` ${icon} ` +
              (e.severity === 'error' ? red(e.message) : e.severity === 'warning' ? gold(e.message) : e.severity === 'success' ? green(e.message) : e.message)
          );
        },
  });
}

function resolveMode(ctx: Ctx, modeArg?: string): ExecutionMode {
  const mode = (modeArg ?? ctx.charter.data.execution.default_mode) as ExecutionMode;
  if (!['draft', 'strict', 'simulation'].includes(mode)) {
    fail(`未知执行模式: ${mode} (draft | simulation | strict)`);
  }
  return mode;
}

const STAGE_LABEL: Record<CheckpointStage, string> = {
  requirement_approval: '需求批准 (PM 已拆解, 等待主程批准下发)',
  release_approval: '发布批准 (QA 已签发, 等待主程批准交付)',
};

// ---------- 命令注册 ----------

const program = new Command();
program.name('vat').description('VAT — Vibe Coding Agent Team 虚拟团队编排引擎 (MVP v0.2)').version('0.2.0');
program.option('-d, --dir <path>', '工作区目录', process.cwd());

program
  .command('init')
  .description('初始化 VAT 工作区 (章程/目录/配置)')
  .action(() => {
    const root = program.opts().dir as string;
    const paths = resolvePaths(root);
    if (fs.existsSync(paths.charterFile)) fail(`已是 VAT 工作区: ${paths.charterFile} 存在`);
    initWorkspace(root);
    console.log(green(`✓ VAT 工作区已初始化: ${root}`));
    console.log(dim('  下一步: vat req "一句话需求" 提交首个需求, 或 vat doctor 检查环境'));
  });

program
  .command('req')
  .description('向 PM 提交新需求 (新建卡片)')
  .argument('<title>', '需求标题')
  .option('-b, --body <text>', '需求详述', '')
  .option('--body-file <path>', '从文件读取需求详述')
  .option('-p, --priority <level>', '优先级 P0|P1|P2', 'P1')
  .action((title: string, opts: { body: string; bodyFile?: string; priority: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    let body = opts.body;
    if (opts.bodyFile) body = fs.readFileSync(opts.bodyFile, 'utf8');
    if (!body) body = title;
    if (!['P0', 'P1', 'P2'].includes(opts.priority)) fail('优先级须为 P0/P1/P2');
    const hub = buildHub(ctx, 'draft', { quiet: false });
    const { card } = hub.submitRequirement({
      title,
      body,
      priority: opts.priority as Priority,
    });
    console.log(green(`✓ 卡片 ${card.id} 已创建并投递需求单至 PM-docs/in/`));
    console.log(dim(`  下一步: vat run --mode draft|simulation 驱动流水线`));
  });

program
  .command('run')
  .description('驱动流水线直至队列排空 / 卡点 / 熔断 / 预算触顶')
  .option('--mode <mode>', 'draft | simulation | strict (默认取章程 execution.default_mode)')
  .option('--card <id>', '仅处理指定卡片')
  .option('--step', '单步执行一轮')
  .option('--scenario <path>', 'simulation 模式指定剧本文件')
  .action(async (opts: { mode?: string; card?: string; step?: boolean; scenario?: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const mode = resolveMode(ctx, opts.mode);
    const hub = buildHub(ctx, mode, opts);
    const result = await hub.run();
    console.log('');
    if (result.stopReason === 'checkpoint') {
      console.log(gold(`⏸ ${result.message}`));
    } else if (result.stopReason === 'blocked') {
      console.log(red(`⛔ ${result.message}`));
    } else if (result.stopReason === 'budget') {
      console.log(red(`💰 ${result.message}`));
    } else if (result.stopReason === 'error') {
      console.log(red(`✗ ${result.message}`));
    } else {
      console.log(green(`✓ ${result.message} (本轮处理 ${result.processed} 张单据)`));
    }
    process.exit(result.exitCode);
  });

program
  .command('board')
  .description('终端看板')
  .action(() => {
    const ctx = loadContext(program.opts().dir as string);
    const cards = listCards(ctx.paths.boardDir);
    if (cards.length === 0) {
      console.log(dim('看板空空如也 — vat req 提交第一个需求'));
      return;
    }
    console.log(gold('VAT 看板'));
    console.log(dim('-'.repeat(96)));
    for (const card of cards) {
      const flag = card.frozen ? red('[FROZEN]') : card.checkpoint ? gold(`[待${card.checkpoint.stage === 'requirement_approval' ? '批准' : '发布'}]`) : '        ';
      console.log(
        `${flag} ${cyan(card.id)} ${card.status.padEnd(11)} ${dim(`by ${card.owner}`)}  ` +
          `${card.title.slice(0, 32)}  ` +
          dim(`打回 ${card.rejection_count}/3 · token ${card.token_used}`)
      );
    }
    console.log(dim('-'.repeat(96)));
  });

program
  .command('show')
  .description('卡片详情: 单据链 / 交付物 / 账本')
  .argument('<cardId>')
  .action((cardId: string) => {
    const ctx = loadContext(program.opts().dir as string);
    let card: Card;
    try {
      card = loadCard(ctx.paths, cardId);
    } catch {
      fail(`卡片不存在: ${cardId}`);
    }
    console.log(gold(`${card.id} · ${card.title}`));
    console.log(`状态: ${card.status}${card.frozen ? red(' [FROZEN]') : ''}  持有者: ${card.owner}  优先级: ${card.priority}`);
    console.log(`打回: ${card.rejection_count}/3  卡点: ${card.checkpoint ? STAGE_LABEL[card.checkpoint.stage] : '无'}  token: ${card.token_used}`);
    console.log('');
    console.log(dim(card.body));
    if (card.deliverables.length > 0) {
      console.log(gold('\n交付物:'));
      for (const d of card.deliverables) {
        console.log(`  - [${d.type}] ${d.title} ${dim(`(${d.path}, source: ${d.source})`)}`);
      }
    }
    if (card.ticket_chain.length > 0) {
      console.log(gold('\n单据链:'));
      console.log(`  ${card.ticket_chain.join(' → ')}`);
    }
  });

program
  .command('approve')
  .description('批准人工卡点 (释放暂扣单据)')
  .argument('<cardId>')
  .requiredOption('--stage <stage>', 'requirement_approval | release_approval')
  .option('-n, --note <text>', '批准意见', '')
  .action((cardId: string, opts: { stage: string; note: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const hub = buildHub(ctx, 'draft', { quiet: true });
    try {
      hub.approve(cardId, opts.stage as CheckpointStage, opts.note || undefined);
    } catch (err) {
      fail((err as Error).message);
    }
    console.log(green(`✓ 卡点已批准, 暂扣单据已释放`));
    console.log(dim('  下一步: vat run 继续流水线'));
  });

program
  .command('reject')
  .description('驳回卡点 (卡片退回 backlog, 通知 PM)')
  .argument('<cardId>')
  .requiredOption('--stage <stage>', 'requirement_approval | release_approval')
  .requiredOption('-n, --note <text>', '驳回意见')
  .action((cardId: string, opts: { stage: string; note: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const hub = buildHub(ctx, 'draft', { quiet: true });
    try {
      hub.reject(cardId, opts.stage as CheckpointStage, opts.note);
    } catch (err) {
      fail((err as Error).message);
    }
    console.log(green(`✓ 已驳回, 卡片退回 backlog, 驳回意见已投递 PM-docs/in/`));
  });

program
  .command('resume')
  .description('熔断裁决恢复 (打回计数清零)')
  .argument('<cardId>')
  .requiredOption('--point <point>', 'developing | review | redesign')
  .requiredOption('-n, --note <text>', '裁决意见')
  .action((cardId: string, opts: { point: string; note: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const hub = buildHub(ctx, 'draft', { quiet: true });
    try {
      hub.resume(cardId, opts.point as ResumePoint, opts.note);
    } catch (err) {
      fail((err as Error).message);
    }
    console.log(green(`✓ 卡片 ${cardId} 已从 ${opts.point} 恢复`));
    console.log(dim('  下一步: vat run 继续流水线'));
  });

program
  .command('recruit')
  .description('招聘新角色 (更新章程 + 开辟收件箱/记忆区)')
  .requiredOption('--id <id>', '角色 ID (大写, 如 SEC)')
  .requiredOption('--title <title>', '职位名称')
  .option('-r, --responsibilities <text>', '职责描述', '待补充')
  .option('-c, --consumes <types>', '关注的单据类型 (逗号分隔)', 'task')
  .action((opts: { id: string; title: string; responsibilities: string; consumes: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const hub = buildHub(ctx, 'draft', { quiet: true });
    try {
      hub.recruitRole({
        id: opts.id,
        title: opts.title,
        responsibilities: opts.responsibilities,
        consumes: opts.consumes.split(',').map((s) => s.trim()),
      });
    } catch (err) {
      fail((err as Error).message);
    }
    console.log(green(`✓ 角色 ${opts.id} 已入编: ${opts.id}-docs/ 与 memory/${opts.id}/ 已开辟, agent.md 已更新`));
  });

program
  .command('memory')
  .description('查看角色持久记忆三件套')
  .argument('[roleId]')
  .action((roleId?: string) => {
    const ctx = loadContext(program.opts().dir as string);
    const roles = roleId ? [roleId] : ctx.charter.data.team.roles.map((r) => r.id);
    for (const role of roles) {
      const snapshot = readSnapshot(ctx.paths.roleMemoryDir(role), DEFAULT_MEMORY_SETTINGS);
      console.log(gold(`\n=== ${role} ===`));
      console.log(dim('summary.md:'));
      console.log(`  ${snapshot.summary.slice(0, 400)}`);
      console.log(dim(`decisions.md (${snapshot.decisions.length} 条):`));
      for (const d of snapshot.decisions.slice(-5)) console.log(`  - [${d.id}] ${d.title}`);
      console.log(dim(`lessons.md (${snapshot.lessons.length} 条):`));
      for (const l of snapshot.lessons.slice(-5)) console.log(`  - [${l.id}] ${l.issue}`);
    }
  });

program
  .command('ledger')
  .description('Token 账本 (真实计量)')
  .option('--day <yyyymmdd>', '日期 (默认今天)')
  .action((opts: { day?: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const day = opts.day ?? todayKey();
    const entries = readLedgerDay(ctx.paths.ledgerFile(day));
    const sum = summarize(entries);
    const billable = summarize(entries, true);
    if (sum.calls === 0) {
      console.log(dim(`${day} 无调用记录`));
      return;
    }
    console.log(gold(`Token 账本 ${day}`));
    console.log(`调用 ${sum.calls} 次 · 总计 ${sum.totalTokens} · 计费口径 (真实 LLM) ${billable.billableTokens}`);
    console.log(dim('按角色:'));
    for (const [role, tokens] of Object.entries(sum.byRole)) {
      console.log(`  ${role.padEnd(8)} ${tokens}`);
    }
    const limit = ctx.charter.data.budget.daily_token_limit;
    console.log(dim(`日预算: ${billable.billableTokens}/${limit} (${Math.round((billable.billableTokens / limit) * 100)}%)`));
  });

program
  .command('compress')
  .description('手动压缩角色记忆 (超窗口条目移入归档)')
  .argument('<roleId>')
  .action((roleId: string) => {
    const ctx = loadContext(program.opts().dir as string);
    const result = compressMemory(ctx.paths.roleMemoryDir(roleId), DEFAULT_MEMORY_SETTINGS);
    console.log(
      green(`✓ ${roleId} 记忆压缩完成: 归档 decisions ${result.archivedDecisions} 条, lessons ${result.archivedLessons} 条`)
    );
  });

program
  .command('models')
  .description('获取上游模型列表 (openai-compat /models;anthropic、gemini 有对应端点)')
  .option('-p, --provider <id>', '仅查看指定 provider (默认容灾链全部)')
  .action(async (opts: { provider?: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const chain = opts.provider ? [opts.provider] : ctx.config.modelChain ?? [];
    if (chain.length === 0) fail('vat.config.json 未配置 modelChain');
    const router = new ModelRouter(ctx.config.providers ?? [], chain);
    try {
      const results = await router.listModels(opts.provider);
      for (const r of results) {
        console.log(gold(`◆ ${r.providerId} (${r.models.length} 个模型)`));
        const cfg = (ctx.config.providers ?? []).find((p) => p.id === r.providerId);
        if (cfg) {
          console.log(
            r.currentModelInList
              ? green(`  ✓ 当前配置 ${cfg.model} 在上游列表中`)
              : red(`  ✗ 当前配置 ${cfg.model} 不在上游列表中 (请核对模型名)`)
          );
        }
        for (const m of r.models) console.log(`  ${m}`);
        if (r.models.length === 0) console.log(red('  (上游未返回模型列表)'));
      }
    } catch (err) {
      fail(`获取上游模型失败: ${(err as Error).message}`);
    }
  });

program
  .command('doctor')
  .description('体检: 工作区完整性 / 配置 / git / 模型链')
  .option('--network', '实际探测模型链连通性 (会产生少量调用)', false)
  .action(async (opts: { network: boolean }) => {
    const ctx = loadContext(program.opts().dir as string);
    const missing = checkWorkspace(ctx.paths, ctx.charter);
    console.log(missing.length === 0 ? green('✓ 工作区结构完整') : red(`✗ 缺失: ${missing.join(', ')}`));
    console.log(`章程角色: ${ctx.charter.data.team.roles.map((r) => r.id).join(', ')}`);
    console.log(
      `卡点: requirement_approval=${ctx.charter.data.checkpoints.requirement_approval}, release_approval=${ctx.charter.data.checkpoints.release_approval}`
    );
    const { gitAvailable } = await import('@vat/core');
    console.log((await gitAvailable(ctx.root)) ? green('✓ git 仓库可用 (审计 commit 开启)') : gold('⚠ 非 git 仓库, 自动提交不可用'));
    // strict 工具链
    const binDir = resolveToolchainBin();
    console.log(
      binDir
        ? green(`✓ strict 工具链就绪: ${binDir}`)
        : gold('⚠ 未找到 tsc/vitest 工具链, strict 闸门将回退 npx --yes (需网络)')
    );
    console.log((await dockerAvailable()) ? green('✓ docker 可用 (镜像构建闸门开启)') : gold('⚠ docker 不可用, docker 闸门自动跳过'));
    // 模型链
    const chain = ctx.config.modelChain ?? [];
    for (const id of chain) {
      const cfg = (ctx.config.providers ?? []).find((p) => p.id === id);
      if (!cfg) {
        console.log(red(`✗ 模型 ${id}: 配置缺失`));
        continue;
      }
      const viaEnv = Boolean(cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]);
      const hasKey = Boolean(cfg.apiKey ?? viaEnv);
      const source = cfg.apiKey ? 'config 内联 (不推荐)' : viaEnv ? `${cfg.apiKeyEnv} ✓` : `未设置 ${cfg.apiKeyEnv ?? 'apiKey'}`;
      console.log(
        hasKey
          ? green(`✓ 模型 ${id} (${cfg.protocol}/${cfg.model}): Key 就绪 (${source}${cfg.baseUrl ? `, ${cfg.baseUrl}` : ''})`)
          : gold(`⚠ 模型 ${id}: 未设置 ${source} — 可写入工作区 .env 文件`)
      );
    }
    if (opts.network) {
      const router = new ModelRouter(ctx.config.providers ?? [], chain);
      const results = await router.probe({ system: 'ping', user: 'pong', maxTokens: 16 });
      for (const r of results) {
        console.log(r.ok ? green(`✓ 探测 ${r.providerId}: 可用 (${r.detail})`) : red(`✗ 探测 ${r.providerId}: ${r.detail}`));
      }
      const suggested = suggestChain(chain, results);
      console.log(gold(`建议 modelChain (可用优先): [${suggested.join(', ')}]`));
      if (suggested.join(',') !== chain.join(',')) {
        console.log(dim('  → 把以上顺序写入 vat.config.json 的 modelChain 即可换主力模型 (v0.3 #8 / K01)'));
      }
    }
  });

program
  .command('events')
  .description('查看 Hub 事件流 (审计日志)')
  .option('--day <yyyymmdd>', '日期 (默认今天)')
  .option('-n, --limit <count>', '最近 N 条', '30')
  .action((opts: { day?: string; limit: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const events = readEvents(ctx.paths.eventsFile(opts.day ?? todayKey()));
    const limit = Number(opts.limit);
    for (const e of events.slice(-limit)) {
      const icon = e.severity === 'error' ? '✗' : e.severity === 'warning' ? '⚠' : e.severity === 'success' ? '✓' : '·';
      console.log(`${dim(new Date(e.ts).toLocaleTimeString())} ${icon} ${dim(`[${e.type}]`)} ${e.message}`);
    }
  });

program
  .command('dashboard')
  .description('启动本地驾驶舱 (127.0.0.1: 看板 / 事件流 / 账本 / 卡点裁决)')
  .option('--port <n>', '监听端口', '4600')
  .action(async (opts: { port: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const { startDashboardServer } = await import('./dashboard-server.js');
    const handle = await startDashboardServer(ctx, { port: Number(opts.port) });
    console.log(green(`✓ VAT 驾驶舱已启动: http://127.0.0.1:${handle.port}`));
    console.log(dim('  只绑 127.0.0.1 (仅本机可访问); Ctrl+C 停止'));
    console.log(dim('  观察流程: 终端 vat run 推进流水线, 此处实时投影并处理卡点/熔断'));
  });

program
  .command('watch')
  .description('启动 Watcher 守护: 监听 tickets/*-docs/in/*.md, 自动唤起 Hub 处理 (单 leader, 跨进程锁)')
  .option('--mode <mode>', 'draft | simulation | strict (默认取章程 execution.default_mode)')
  .option('--poll <ms>', '轮询间隔(ms)', '1000')
  .action(async (opts: { mode?: string; poll: string }) => {
    const ctx = loadContext(program.opts().dir as string);
    const mode = resolveMode(ctx, opts.mode);
    const hub = buildHub(ctx, mode, { quiet: false });
    const lock = new LeaderLock({ lockFile: path.join(ctx.root, '.vat-watch-lock') });
    const watcher = new Watcher({
      paths: ctx.paths,
      dispatch: async () => {
        await hub.run();
      },
      lock,
      pollingMs: Number(opts.poll),
    });
    console.log(green(`✓ VAT Watcher 已启动 (leader=${lock.isLeader}) — 监听 ${ctx.paths.ticketsDir}/*-docs/in/*.md`));
    console.log(dim('   仅一个进程为 leader (跨进程锁), 其余自动转 follower; Ctrl+C 停止'));
    console.log(dim('   fallback: 守护挂了直接 `vat run` 兜底 (两者共用 Hub, 互不冲突)'));
    const onSig = () => {
      void watcher.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    await watcher.start();
  });

program.parseAsync();
