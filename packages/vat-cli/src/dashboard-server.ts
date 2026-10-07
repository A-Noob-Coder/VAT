// VAT 本地驾驶舱服务 (架构设计 §9.3):
// 仅绑 127.0.0.1; 静态前端 + 只读投影 API (state/events SSE) + 卡点裁决写操作。
// Dashboard 永远不直接写工作区文件 —— 所有写操作经 Hub 校验执行。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  Hub,
  loadCard,
  loadConfig,
  parseCharter,
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
