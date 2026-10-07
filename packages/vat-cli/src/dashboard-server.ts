// VAT 本地驾驶舱服务 (架构设计 §9.3):
// 仅绑 127.0.0.1; 静态前端 + 只读投影 API (state/events SSE) + 卡点裁决写操作。
// Dashboard 永远不直接写工作区文件 —— 所有写操作经 Hub 校验执行。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  Hub,
  buildNotifier,
  loadCard,
  loadConfig,
  parseCharter,
  parseTicket,
  readLedgerDay,
  readEvents,
  renderCharter,
  resolvePaths,
  scanInbox,
  summarize,
  todayKey,
  type Card,
  type CheckpointStage,
  type HubEvent,
  type Priority,
  type ResumePoint,
  type Ticket,
  type VatConfig,
} from '@vat/core';
import type { WorkspacePaths } from '@vat/core';
import type { Charter } from '@vat/core';

const require = createRequire(import.meta.url);

export interface DashboardContext {
  root: string;
  paths: WorkspacePaths;
  charter: Charter;
  config: VatConfig;
}

export interface DashboardServerHandle {
  port: number;
  close(): Promise<void>;
}

// ---------- 状态投影 ----------

function buildState(ctx: DashboardContext, day: string) {
  const { paths, charter } = ctx;
  const cards: Card[] = fs
    .readdirSync(paths.boardDir)
    .filter((n) => /^CARD-\d+\.md$/.test(n))
    .sort()
    .map((n) => loadCard(paths, path.basename(n, '.md')));

  const roles = charter.data.team.roles.map((r) => ({
    id: r.id,
    title: r.title,
    pending: scanInbox(paths.mailboxIn(r.id)).length,
  }));

  const ledgerEntries = readLedgerDay(paths.ledgerFile(day));
  const ledgerAll = summarize(ledgerEntries);
  const ledgerBillable = summarize(ledgerEntries, true);

  const days = fs.existsSync(paths.eventsDir)
    ? fs
        .readdirSync(paths.eventsDir)
        .map((f) => /hub-(\d{8})\.jsonl/.exec(f)?.[1])
        .filter((d): d is string => Boolean(d))
        .sort()
    : [];

  return {
    root: paths.root,
    day,
    charter: {
      roles: charter.data.team.roles.map((r) => ({ id: r.id, title: r.title })),
      checkpoints: charter.data.checkpoints,
      breaker: charter.data.circuit_breaker,
      budget: charter.data.budget,
      strict: charter.data.execution.strict ?? null,
    },
    cards,
    roles,
    ledger: {
      day,
      calls: ledgerAll.calls,
      totalTokens: ledgerAll.totalTokens,
      billableTokens: ledgerBillable.billableTokens,
      byRole: ledgerAll.byRole,
      byCard: ledgerAll.byCard,
      dailyLimit: charter.data.budget.daily_token_limit,
    },
    days,
  };
}

// ---------- 图谱投影 (席位环绕项目的知识图谱) ----------

/** 扫描全部信箱目录, 建立 ticket id → Ticket 索引 (in/ + archive/ + _held/<card>/) */
function collectTickets(paths: WorkspacePaths): Map<string, Ticket> {
  const map = new Map<string, Ticket>();
  const scanDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const t = parseTicket(f, fs.readFileSync(path.join(dir, f), 'utf8'));
        map.set(t.id, t);
      } catch {
        // 坏文件跳过, 不阻塞投影
      }
    }
  };
  if (!fs.existsSync(paths.ticketsDir)) return map;
  for (const entry of fs.readdirSync(paths.ticketsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    scanDir(path.join(paths.ticketsDir, entry.name, 'in'));
    scanDir(path.join(paths.ticketsDir, entry.name, 'archive'));
  }
  if (fs.existsSync(paths.heldDir)) {
    for (const entry of fs.readdirSync(paths.heldDir, { withFileTypes: true })) {
      if (entry.isDirectory()) scanDir(path.join(paths.heldDir, entry.name));
    }
  }
  return map;
}

function buildGraph(ctx: DashboardContext, cardId?: string | null) {
  const { paths, charter } = ctx;
  const cards: Card[] = fs.existsSync(paths.boardDir)
    ? fs
        .readdirSync(paths.boardDir)
        .filter((n) => /^CARD-\d+\.md$/.test(n))
        .sort()
        .map((n) => loadCard(paths, path.basename(n, '.md')))
    : [];
  const card =
    (cardId ? cards.find((c) => c.id === cardId) : undefined) ??
    cards.find((c) => c.checkpoint) ??
    cards.find((c) => c.status !== 'done') ??
    cards[cards.length - 1] ??
    null;

  // 席位: USER + 章程编制; active = 持有单据或为卡片当前 owner
  const seats = [
    { id: 'USER', title: '主程', pending: 0, active: false, isOwner: false },
    ...charter.data.team.roles.map((r) => ({
      id: r.id,
      title: r.title,
      pending: scanInbox(paths.mailboxIn(r.id)).length,
      active: r.id === card?.owner || scanInbox(paths.mailboxIn(r.id)).length > 0,
      isOwner: r.id === card?.owner,
    })),
  ];

  const checkpoints = (
    [
      ['requirement_approval', '需求批准'],
      ['release_approval', '发布批准'],
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    enabled: Boolean(
      charter.data.checkpoints[id as 'requirement_approval' | 'release_approval']
    ),
    passed: card ? card.checkpoints_passed.includes(id) : false,
    waiting: card?.checkpoint?.stage === id,
  }));

  // 边: ticket_chain 逐票还原 from→to:type, 去重计数; defect/return 为反馈边
  const ticketsById = collectTickets(paths);
  const edgeMap = new Map<
    string,
    { from: string; to: string; label: string; count: number; lastAt: string; kind: 'flow' | 'feedback' }
  >();
  let latest: Ticket | undefined;
  if (card) {
    const chain = card.ticket_chain
      .map((id) => ticketsById.get(id))
      .filter((t): t is Ticket => Boolean(t))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    for (const t of chain) {
      latest = t;
      const key = `${t.from}->${t.to}:${t.type}`;
      const prev = edgeMap.get(key);
      const kind: 'flow' | 'feedback' = t.type === 'defect' || t.type === 'return' ? 'feedback' : 'flow';
      if (prev) {
        prev.count += 1;
        prev.lastAt = t.created_at;
      } else {
        edgeMap.set(key, { from: t.from, to: t.to, label: t.type, count: 1, lastAt: t.created_at, kind });
      }
    }
  }
  const edges = [...edgeMap.values()].map((e) => ({
    ...e,
    active: Boolean(
      latest && e.from === latest.from && e.to === latest.to && e.label === latest.type
    ),
  }));

  // 工件: 交付物挂在产出角色出发的第一条边上; PRD 在需求批准后挂到 PM 出发的边
  const artifacts: Array<{ id: string; label: string; role: string; edgeKey: string }> = [];
  if (card) {
    for (const d of card.deliverables) {
      const target = edges.find((e) => e.from === d.role);
      if (target) {
        artifacts.push({
          id: `dlv-${artifacts.length}`,
          label: d.title,
          role: d.role,
          edgeKey: `${target.from}->${target.to}:${target.label}`,
        });
      }
    }
    if (card.checkpoints_passed.includes('requirement_approval')) {
      const prdEdge = edges.find((e) => e.from === 'PM');
      if (prdEdge) {
        artifacts.push({
          id: 'prd',
          label: 'PRD.md',
          role: 'PM',
          edgeKey: `${prdEdge.from}->${prdEdge.to}:${prdEdge.label}`,
        });
      }
    }
  }

  return {
    cards: cards.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      checkpoint: c.checkpoint ?? null,
    })),
    card: card
      ? {
          id: card.id,
          title: card.title,
          status: card.status,
          owner: card.owner,
          frozen: card.frozen,
          checkpoint: card.checkpoint ?? null,
          checkpoints_passed: card.checkpoints_passed,
        }
      : null,
    seats,
    checkpoints,
    artifacts,
    edges,
  };
}

// ---------- SSE: 事件流尾部跟随 ----------

// 这些事件意味着看板/账本状态发生了变化 → 通知前端重新拉取投影
const STATE_DIRTY_TYPES = new Set([
  'ticket_arrival',
  'status_change',
  'circuit_break',
  'human_action',
  'checkpoint_wait',
  'budget_break',
  'system',
]);

function startEventStream(
  ctx: DashboardContext,
  day: string,
  res: http.ServerResponse
): () => void {
  const { paths } = ctx;
  let closed = false;
  let offset = 0;
  const file = paths.eventsFile(day);

  const send = (payload: object) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // 既有事件一次性下发
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const events = parseEvents(content);
    offset = Buffer.byteLength(content, 'utf8');
    send({ kind: 'batch', events });
  } else {
    send({ kind: 'batch', events: [] });
  }
  send({ kind: 'hello', day });

  const tail = () => {
    if (closed) return;
    try {
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      if (size <= offset) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      const events = parseEvents(buf.toString('utf8'));
      if (events.length > 0) {
        send({ kind: 'append', events });
        if (events.some((e) => STATE_DIRTY_TYPES.has(e.type))) {
          send({ kind: 'state_dirty' });
        }
      }
    } catch {
      // 半行/瞬时占用 → 下一轮补读
    }
  };

  const timer = setInterval(tail, 800);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  return () => {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
  };
}

function parseEvents(text: string): HubEvent[] {
  const out: HubEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HubEvent);
    } catch {
      // 半行忽略
    }
  }
  return out;
}

// ---------- HTTP 助手 ----------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(distDir: string, urlPath: string, res: http.ServerResponse): boolean {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(distDir, rel);
  if (!full.startsWith(distDir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return false;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(full));
  return true;
}

// ---------- 裁决动作 ----------

async function handleAction(
  ctx: DashboardContext,
  action: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const hub = new Hub({
    paths: ctx.paths,
    charter: ctx.charter,
    config: ctx.config,
    mode: 'draft',
  });

  if (action === 'req') {
    // 需求录入: 驾驶舱允许快速提单 (与 vat req 等价, 经同一 Hub 校验)
    const title = String(body.title ?? '').trim();
    if (!title) throw new Error('需求标题不能为空');
    const priority = (['P0', 'P1', 'P2'].includes(String(body.priority)) ? String(body.priority) : 'P1') as Priority;
    hub.submitRequirement({ title, body: String(body.body ?? title), priority });
    return { ok: true, action: 'req' };
  }

  const cardId = String(body.cardId ?? '');
  if (!/^CARD-\d+$/.test(cardId)) throw new Error('cardId 非法');
  loadCard(ctx.paths, cardId); // 确认存在

  if (action === 'approve') {
    const stage = String(body.stage ?? '') as CheckpointStage;
    if (stage !== 'requirement_approval' && stage !== 'release_approval') {
      throw new Error('stage 非法');
    }
    hub.approve(cardId, stage, body.note ? String(body.note) : undefined);
    return { ok: true, action: 'approve' };
  }
  if (action === 'reject') {
    const stage = String(body.stage ?? '') as CheckpointStage;
    if (stage !== 'requirement_approval' && stage !== 'release_approval') {
      throw new Error('stage 非法');
    }
    const note = String(body.note ?? '').trim();
    if (!note) throw new Error('驳回必须附意见 (note)');
    hub.reject(cardId, stage, note);
    return { ok: true, action: 'reject' };
  }
  if (action === 'resume') {
    const point = String(body.point ?? '') as ResumePoint;
    if (point !== 'developing' && point !== 'review' && point !== 'redesign') {
      throw new Error('point 非法 (developing | review | redesign)');
    }
    const note = String(body.note ?? '').trim();
    if (!note) throw new Error('熔断裁决必须附意见 (note)');
    hub.resume(cardId, point, note);
    return { ok: true, action: 'resume' };
  }
  throw new Error(`未知动作: ${action}`);
}

// ---------- 服务入口 ----------

export function startDashboardServer(
  ctx: DashboardContext,
  opts: { port?: number; host?: string } = {}
): Promise<DashboardServerHandle> {
  let distDir: string | null = null;
  try {
    const pkg = require.resolve('@vat/dashboard/package.json');
    distDir = path.join(path.dirname(pkg), 'dist');
  } catch {
    distDir = null; // 仅 API 模式 (前端未构建)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      // ---- API ----
      if (url.pathname === '/api/state') {
        const day = url.searchParams.get('day') ?? todayKey();
        sendJson(res, 200, buildState(ctx, day));
        return;
      }
      if (url.pathname === '/api/graph' && req.method === 'GET') {
        sendJson(res, 200, buildGraph(ctx, url.searchParams.get('card')));
        return;
      }
      if (url.pathname === '/api/events') {
        const day = url.searchParams.get('day') ?? todayKey();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        const cleanup = startEventStream(ctx, day, res);
        req.on('close', cleanup);
        return;
      }

      // ---- 项目与路径 ----
      if (url.pathname === '/api/paths' && req.method === 'GET') {
        const p = ctx.paths;
        const abs = (v: string) => path.resolve(v);
        sendJson(res, 200, {
          root: abs(ctx.root),
          paths: {
            charterFile: abs(p.charterFile),
            configFile: abs(p.configFile),
            boardDir: abs(p.boardDir),
            ticketsDir: abs(p.ticketsDir),
            deadDir: abs(p.deadDir),
            heldDir: abs(p.heldDir),
            memoryDir: abs(p.memoryDir),
            projectsDir: abs(p.projectsDir),
            deliverablesDir: abs(p.deliverablesDir),
            ledgerDir: abs(p.ledgerDir),
            eventsDir: abs(p.eventsDir),
            scenariosDir: abs(p.scenariosDir),
            tasksDir: abs(p.tasksDir),
          },
        });
        return;
      }
      // 切换服务端工作区到另一个已注册项目目录 (需含 agent.md 章程)
      if (url.pathname === '/api/project/switch' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as { dir?: string };
          const dir = path.resolve(String(body.dir ?? ''));
          if (!dir) throw new Error('缺少 dir');
          const charterPath = path.join(dir, 'agent.md');
          if (!fs.existsSync(charterPath)) {
            throw new Error(`目录 ${dir} 缺少 agent.md, 不是合法 VAT 工作区 (先在该目录运行 vat init)`);
          }
          const nextPaths = resolvePaths(dir);
          const nextConfig = loadConfig(nextPaths.configFile);
          const nextCharter = parseCharter(fs.readFileSync(charterPath, 'utf8'));
          ctx.root = dir;
          ctx.paths = nextPaths;
          ctx.config = nextConfig;
          ctx.charter = nextCharter;
          sendJson(res, 200, { ok: true, root: dir, roles: nextCharter.data.team.roles.length });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      // ---- 通知渠道测试发送 ----
      if (url.pathname === '/api/config/test-notify' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as { channel?: unknown };
          if (!body.channel || typeof body.channel !== 'object') {
            throw new Error('缺少 channel 配置');
          }
          const notifier = buildNotifier({
            notify: { channels: [body.channel as never] },
          });
          const result = await notifier.notify({
            title: 'VAT 测试通知',
            body: `这是一条来自 VAT 驾驶舱的测试通知 (${new Date().toLocaleString('zh-CN')})。\n收到即表示该通道配置有效。`,
            level: 'info',
          });
          if (result.sent.length === 0) {
            throw new Error(`全部通道发送失败: ${result.failed.map((f) => f.error.slice(0, 120)).join('; ')}`);
          }
          sendJson(res, 200, { ok: true, sent: result.sent, failed: result.failed });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      // ---- 配置读写 (驾驶舱内联管理 vat.config.json + 章程) ----
      if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            config: ctx.config,
            charter: { data: ctx.charter.data, body: ctx.charter.body },
          });
          return;
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}') as {
              config?: Record<string, unknown>;
              charterData?: Record<string, unknown>;
            };
            if (body.config && typeof body.config === 'object') {
              fs.writeFileSync(ctx.paths.configFile, JSON.stringify(body.config, null, 2) + '\n', 'utf8');
              ctx.config = loadConfig(ctx.paths.configFile);
            }
            if (body.charterData && typeof body.charterData === 'object') {
              const nextData = body.charterData as unknown as Charter['data'];
              const md = renderCharter({ data: nextData, body: ctx.charter.body });
              fs.writeFileSync(ctx.paths.charterFile, md, 'utf8');
              ctx.charter = parseCharter(fs.readFileSync(ctx.paths.charterFile, 'utf8'));
            }
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 400, { error: (err as Error).message });
          }
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (url.pathname.startsWith('/api/') && req.method === 'POST') {
        const action = url.pathname.slice('/api/'.length);
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        try {
          const result = await handleAction(ctx, action, body);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      // ---- 静态前端 ----
      if (req.method === 'GET' && distDir) {
        if (serveStatic(distDir, url.pathname, res)) return;
        // SPA fallback
        if (!url.pathname.startsWith('/api/') && serveStatic(distDir, '/index.html', res)) return;
      }
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  const port = opts.port ?? 4600;
  const host = opts.host ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

export { resolvePaths };
