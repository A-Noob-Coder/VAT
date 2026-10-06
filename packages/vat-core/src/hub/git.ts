// git 自动提交 (架构设计 §6.6): 每轮一 commit, 可配; 无 git 环境优雅降级
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function gitAutoCommit(
  root: string,
  message: string,
  enabled: boolean
): Promise<boolean> {
  if (!enabled) return false;
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', message, '--no-verify'], { cwd: root });
    return true;
  } catch {
    return false; // nothing to commit / git 异常 → 静默跳过
  }
}

export async function gitAvailable(root: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return fs.existsSync(path.join(root, '.git'));
  } catch {
    return false;
  }
}
