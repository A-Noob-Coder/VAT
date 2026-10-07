import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LeaderLock } from '../src/lock.js';

function tmpLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-lock-'));
  return path.join(dir, 'watch.lock');
}

describe('LeaderLock', () => {
  it('首次 acquire 成为 leader', () => {
    const lock = new LeaderLock({ lockFile: tmpLock(), pid: 1001 });
    expect(lock.acquire()).toBe(true);
    expect(lock.isLeader).toBe(true);
    lock.release();
  });

  it('第二个实例无法夺取存活的 leader, 释放后可夺取', () => {
    const f = tmpLock();
    const a = new LeaderLock({ lockFile: f, pid: 1001, isAlive: () => true });
    const b = new LeaderLock({ lockFile: f, pid: 1002, isAlive: () => true });
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    expect(b.isLeader).toBe(false);
    a.release();
    expect(b.acquire()).toBe(true); // a 释放后 b 可夺取
    b.release();
  });

  it('leader 心跳过期(stale)后被他人夺取并降级', () => {
    const f = tmpLock();
    const now = { t: 1_000_000 };
    const a = new LeaderLock({ lockFile: f, pid: 1001, now: () => now.t, isAlive: () => true, staleMs: 30_000 });
    const b = new LeaderLock({ lockFile: f, pid: 1002, now: () => now.t, isAlive: () => true, staleMs: 30_000 });
    expect(a.acquire()).toBe(true);
    now.t += 40_000; // 超过 staleMs
    expect(b.acquire()).toBe(true); // a 过期 → b 夺取
    expect(a.recheck()).toBe(false); // a 自动降级
    b.release();
  });

  it('持有者 PID 不存活视为可夺取', () => {
    const f = tmpLock();
    // isAlive 必须是统一 liveness 检查器: 入参 pid → 是否存活 (a/b 共用同一逻辑)
    const state = { aAlive: true };
    const alive = (pid: number) => (pid === 1001 ? state.aAlive : pid === 1002);
    const a = new LeaderLock({ lockFile: f, pid: 1001, isAlive: alive });
    const b = new LeaderLock({ lockFile: f, pid: 1002, isAlive: alive });
    expect(a.acquire()).toBe(true); // a 进程存活, 首次无锁 → 夺取
    state.aAlive = false;           // a 进程退出
    expect(b.acquire()).toBe(true); // 锁中 pid=1001 已死 → b 夺取
    expect(b.isLeader).toBe(true);
    b.release();
  });
});
