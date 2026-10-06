// StrictRunner 真实集成测试: 真 tsc + 真 vitest 在临时工程上执行
// node_modules 通过 junction 复用 monorepo 依赖, 无需联网安装
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StrictRunner, resolveToolchainBin } from '../src/index.js';

function setupProject(src: string, test: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-strict-real-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'rate-limiter.ts'), src, 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'rate-limiter.test.ts'), test, 'utf8');
  // junction: 工程的 node_modules → monorepo node_modules (离线安装等价物)
  const repoNodeModules = path.resolve(__dirname, '..', '..', '..', 'node_modules');
  fs.symlinkSync(repoNodeModules, path.join(dir, 'node_modules'), 'junction');
  return dir;
}

const GOOD_SRC = `export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(public readonly capacity: number, public readonly refillPerSec: number) {
    if (capacity <= 0 || refillPerSec <= 0) throw new Error('InvalidConfig');
    this.tokens = capacity;
  }
  acquire(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}
`;

const GOOD_TEST = `import { describe, it, expect } from 'vitest';
import { TokenBucket } from './rate-limiter.js';

describe('TokenBucket', () => {
  it('容量内放行, 超量拒绝', () => {
    const b = new TokenBucket(2, 0.001);
    expect(b.acquire(2)).toBe(true);
    expect(b.acquire(1)).toBe(false);
  });
  it('非法配置抛错', () => {
    expect(() => new TokenBucket(0, 1)).toThrow();
  });
});
`;

const BROKEN_TEST = GOOD_TEST.replace('expect(b.acquire(1)).toBe(false);', 'expect(b.acquire(1)).toBe(true);');

describe('StrictRunner 集成 · 真实 tsc + vitest', () => {
  it('健康工程: 闸门通过, 统计来自真实测试输出', { timeout: 240_000 }, async () => {
    const dir = setupProject(GOOD_SRC, GOOD_TEST);
    const runner = new StrictRunner({ binDir: resolveToolchainBin(), install: 'never', dockerBuild: 'off' });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(report.ok).toBe(true);
    expect(report.tests?.passed).toBe(2);
    expect(report.tests?.failed).toBe(0);
    expect(report.steps.find((s) => s.name === 'tsc')?.status).toBe('ok');
    expect(report.steps.find((s) => s.name === 'vitest')?.status).toBe('ok');
  }, 240_000);

  it('断言失败的工程: 闸门拒绝, defect 材料含失败详情', { timeout: 240_000 }, async () => {
    const dir = setupProject(GOOD_SRC, BROKEN_TEST);
    const runner = new StrictRunner({ binDir: resolveToolchainBin(), install: 'never', dockerBuild: 'off' });
    const report = await runner.runGate({ cardId: 'CARD-0002', projectDir: dir });
    expect(report.ok).toBe(false);
    expect(report.tests?.failed).toBe(1);
    const vitest = report.steps.find((s) => s.name === 'vitest');
    expect(vitest?.detail).toContain('expected');
  }, 240_000);

  it('类型错误的工程: tsc 闸门拦截', { timeout: 240_000 }, async () => {
    const dir = setupProject('export const n: number = "not a number";\n', GOOD_TEST);
    const runner = new StrictRunner({ binDir: resolveToolchainBin(), install: 'never', dockerBuild: 'off' });
    const report = await runner.runGate({ cardId: 'CARD-0003', projectDir: dir });
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name === 'tsc')?.status).toBe('fail');
  }, 240_000);
});
