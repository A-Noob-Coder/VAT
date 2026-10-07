// Watcher 守护 (K05): 文件邮箱订阅式唤起。
// 监听 tickets/<ROLE>-docs/in/*.md, 出现新单据即唤起 dispatch (CLI 注入 = hub.run())。
// 通过 LeaderLock 实现单 leader 选举: 仅 leader 进程真正驱动, 其余自动转 follower。
// 与 Hub 解耦: Watcher 只负责"触发 + 去重 + 选主", 单据消费/归档由 Hub 完成。
import fs from 'node:fs';
import path from 'node:path';
import type { WorkspacePaths } from '../workspace/index.js';
import { LeaderLock } from '../lock.js';

export type WatchDispatch = (roleId: string, file: string) => Promise<void>;

export interface WatcherOptions {
  paths: WorkspacePaths;
  dispatch: WatchDispatch;
  lock: LeaderLock;
  /** 轮询间隔 (ms), 默认 1000 */
  pollingMs?: number;
  /** 仅监听指定角色收件箱; 缺省扫描 tickets/*-docs/in */
  roles?: string[];
  /** 注入用于测试; 默认 setTimeout */
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WatcherStatus {
  running: boolean;
  leader: boolean;
  dispatched: number;
}

export class Watcher {
  private readonly paths: WorkspacePaths;
  private readonly dispatch: WatchDispatch;
  private readonly lock: LeaderLock;
  private readonly pollingMs: number;
  private readonly roles?: string[];
  private readonly sleepFn: (ms: number) => Promise<void>;
  private running = false;
  private seen = new Set<string>();
  private dispatchCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WatcherOptions) {
    this.paths = opts.paths;
    this.dispatch = opts.dispatch;
    this.lock = opts.lock;
    this.pollingMs = opts.pollingMs ?? 1000;
    this.roles = opts.roles;
    this.sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  get status(): WatcherStatus {
    return { running: this.running, leader: this.lock.isLeader, dispatched: this.dispatchCount };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick(); // 首轮立即巡检
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void (async () => {
        if (!this.running) return;
        try {
          await this.tick();
        } catch {
          /* 守护进程不应因单次异常退出 */
        }
        this.scheduleNext();
      })();
    }, this.pollingMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lock.release();
  }

  /** 单次巡检: 维持 leader 身份, 对新到 .md 单据触发 dispatch */
  async tick(): Promise<void> {
    if (this.lock.isLeader) {
      if (!this.lock.recheck()) return; // 已被他人夺取 → 降级
      this.lock.renew();
    } else {
      if (!this.lock.acquire()) return; // follower: 不动作
    }
    if (!this.lock.isLeader) return;

    for (const { roleId, dir } of this.findInboxes()) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      for (const f of files) {
        const key = path.join(dir, f);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        try {
          await this.dispatch(roleId, key);
          this.dispatchCount++;
        } catch (err) {
          console.error(`[watcher] dispatch ${roleId} ${f} 失败: ${(err as Error).message}`);
        }
      }
    }
  }

  private findInboxes(): Array<{ roleId: string; dir: string }> {
    const root = this.paths.ticketsDir;
    const out: Array<{ roleId: string; dir: string }> = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const m = /^([A-Z0-9_]+)-docs$/.exec(entry);
      if (!m || !m[1]) continue;
      const roleId = m[1];
      if (this.roles && !this.roles.includes(roleId)) continue;
      out.push({ roleId, dir: path.join(root, entry, 'in') });
    }
    return out;
  }
}
