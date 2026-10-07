// 跨进程 leader 锁 (v0.3 #10 / K04): 保证同一工作区只有一个 Watcher 真正驱动 Hub,
// 防止两个 `vat run` / `vat watch` 并发消费同一单据。
//
// 实现: 在 <root>/.vat-watch-lock 写入 {pid, ts, host} 记录。
//  - acquire(): 若锁不存在或持有者 PID 已死 / 心跳过期(stale), 则夺取
//  - renew():   leader 每次巡检续约心跳
//  - recheck(): 被他人夺取则自动降级 (follower 不动作)
// stale 判定用注入的 now/isAlive, 便于单测; 生产默认依赖 process。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface LeaderLockRecord {
  pid: number;
  ts: number; // 最后心跳 (ms)
  host: string;
}

export interface LeaderLockOptions {
  lockFile: string;
  pid?: number;
  host?: string;
  staleMs?: number; // 默认 30_000
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

export class LeaderLock {
  private readonly lockFile: string;
  private readonly pid: number;
  private readonly host: string;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private heldByMe = false;

  constructor(opts: LeaderLockOptions) {
    this.lockFile = opts.lockFile;
    this.pid = opts.pid ?? process.pid;
    this.host = opts.host ?? (process.platform || 'local');
    this.staleMs = opts.staleMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.isAlive = opts.isAlive ?? defaultIsAlive;
  }

  get isLeader(): boolean {
    return this.heldByMe;
  }

  /** 尝试成为 leader; 成功 true, 他人持有且存活则 false */
  acquire(): boolean {
    if (this.heldByMe) {
      this.writeRecord();
      return true;
    }
    const cur = this.readRecord();
    if (cur && this.isAlive(cur.pid) && this.now() - cur.ts < this.staleMs) {
      return false; // 他人持有且存活
    }
    this.writeRecord();
    this.heldByMe = true;
    return true;
  }

  /** leader 续约心跳 */
  renew(): void {
    if (this.heldByMe) this.writeRecord();
  }

  /** 放弃 leader (仅当由我持有) */
  release(): void {
    if (!this.heldByMe) return;
    try {
      const cur = this.readRecord();
      if (cur && cur.pid === this.pid) fs.unlinkSync(this.lockFile);
    } catch {
      /* 忽略: 文件可能已被他人清理 */
    }
    this.heldByMe = false;
  }

  /** 重新确认我仍持有; 被他人夺取则降级返回 false */
  recheck(): boolean {
    const cur = this.readRecord();
    if (!cur || cur.pid !== this.pid) {
      this.heldByMe = false;
      return false;
    }
    return true;
  }

  private readRecord(): LeaderLockRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as LeaderLockRecord;
    } catch {
      return null;
    }
  }

  private writeRecord(): void {
    const rec: LeaderLockRecord = { pid: this.pid, ts: this.now(), host: this.host };
    try {
      fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
      fs.writeFileSync(this.lockFile, JSON.stringify(rec), 'utf8');
    } catch {
      /* 忽略: 极少数并发写冲突由下次巡检自愈 */
    }
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: 仅检测存活, 不发信号
    return true;
  } catch {
    return false;
  }
}
