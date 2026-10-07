import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Watcher } from '../src/watcher/index.js';
import { LeaderLock } from '../src/lock.js';
import type { WorkspacePaths } from '../src/workspace/index.js';

/** 最小 WorkspacePaths 实现, 仅 Watcher 需要的字段 */
function makePaths(root: string): WorkspacePaths {
  const p = (...rel: string[]) => path.join(root, ...rel);
  const roleDir = (roleId: string) => p('tickets', `${roleId}-docs`, 'in');
  return {
    root,
    charterFile: p('agent.md'),
    configFile: p('vat.config.json'),
    boardDir: p('board'),
    ticketsDir: p('tickets'),
    deadDir: p('tickets', '_dead'),
    heldDir: p('tickets', '_held'),
    memoryDir: p('memory'),
    projectsDir: p('projects'),
    deliverablesDir: p('deliverables'),
    ledgerDir: p('ledger'),
    eventsDir: p('events'),
    scenariosDir: p('scenarios'),
    tasksDir: p('tasks'),
    mailboxIn: (r) => roleDir(r),
    mailboxArchive: (r) => p('tickets', `${r}-docs`, 'archive'),
    roleMemoryDir: (r) => p('memory', r),
    taskDocsDir: (c) => p('tasks', c, 'docs'),
    cardFile: (c) => p('board', `${c}.md`),
    cardProjectDir: (c) => p('projects', c),
    cardDeliverableDir: (c) => p('deliverables', c),
    ledgerFile: (d) => p('ledger', `usage-${d}.jsonl`),
    eventsFile: (d) => p('events', `hub-${d}.jsonl`),
  };
}

function writeTicket(root: string, role: string, name: string): string {
  const dir = path.join(root, 'tickets', `${role}-docs`, 'in');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '# ticket\n');
  return file;
}

describe('Watcher', () => {
  it('leader 在 .md 出现时触发 dispatch 且去重', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-watch-'));
    const paths = makePaths(root);
    const dispatch = vi.fn(async () => {});
    const lock = new LeaderLock({ lockFile: path.join(root, '.lock'), pid: 1, isAlive: () => true });
    const w = new Watcher({ paths, dispatch, lock, sleepFn: async () => {} });
    await w.start();
    writeTicket(root, 'PM', 't1.md');
    writeTicket(root, 'PM', 't2.md');
    await w.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    await w.tick(); // 重复巡检不重复 dispatch
    expect(dispatch).toHaveBeenCalledTimes(2);
    await w.stop();
  });

  it('follower (非 leader) 不触发 dispatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-watch-'));
    const paths = makePaths(root);
    const dispatch = vi.fn(async () => {});
    const leaderLock = new LeaderLock({ lockFile: path.join(root, '.lock'), pid: 999, isAlive: () => true });
    leaderLock.acquire();
    const follower = new Watcher({
      paths,
      dispatch,
      lock: new LeaderLock({ lockFile: path.join(root, '.lock'), pid: 1, isAlive: () => true }),
      sleepFn: async () => {},
    });
    await follower.tick();
    writeTicket(root, 'PM', 't1.md');
    await follower.tick();
    expect(dispatch).not.toHaveBeenCalled();
    leaderLock.release();
  });

  it('仅监听指定角色 (roles 过滤)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-watch-'));
    const paths = makePaths(root);
    const dispatch = vi.fn(async () => {});
    const lock = new LeaderLock({ lockFile: path.join(root, '.lock'), pid: 1, isAlive: () => true });
    const w = new Watcher({ paths, dispatch, lock, roles: ['QA'], sleepFn: async () => {} });
    await w.start();
    writeTicket(root, 'PM', 'pm1.md');
    writeTicket(root, 'QA', 'qa1.md');
    await w.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('QA', expect.stringContaining('qa1.md'));
    await w.stop();
  });
});
