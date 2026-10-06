// StrictRunner 单元测试: fake exec 驱动闸门编排, 不触网
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StrictRunner, resolveToolchainBin, type ExecFn } from '../src/index.js';

function tempProject(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-strict-'));
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const okExec: ExecFn = async () => ({ ok: true, stdout: '', stderr: '', timedOut: false, durationMs: 5 });

describe('StrictRunner · 脚手架', () => {
  it('缺 package.json/tsconfig 时自动补齐', async () => {
    const dir = tempProject({ 'src/a.ts': 'export const a = 1;\n' });
    const runner = new StrictRunner({ exec: okExec, dockerBuild: 'off' });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(true);
    expect(report.steps[0].summary).toContain('补齐');
  });

  it('已有工程文件时不覆盖', async () => {
    const dir = tempProject({
      'package.json': '{"name":"custom","private":true}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const runner = new StrictRunner({ exec: okExec, dockerBuild: 'off' });
    await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toContain('custom');
  });
});

describe('StrictRunner · install 闸门', () => {
  it('auto + 无外部依赖 → 跳过安装', async () => {
    const dir = tempProject({ 'src/a.ts': 'export const a = 1;\n' });
    const calls: string[] = [];
    const runner = new StrictRunner({
      exec: async (cmd, ...rest) => {
        calls.push(cmd);
        return okExec(cmd, ...rest);
      },
      dockerBuild: 'off',
    });
    await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(calls.some((c) => c.includes('npm install'))).toBe(false);
  });

  it('auto + 声明依赖 + 无 node_modules → 执行 npm install --ignore-scripts', async () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'x', private: true, dependencies: { lodash: '^4' } }),
      'src/a.ts': 'export const a = 1;\n',
    });
    const calls: string[] = [];
    const runner = new StrictRunner({
      exec: async (cmd, ...rest) => {
        calls.push(cmd);
        return okExec(cmd, ...rest);
      },
      dockerBuild: 'off',
    });
    await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(calls.some((c) => c.includes('npm install --ignore-scripts'))).toBe(true);
  });

  it('never → 永不安装', async () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'x', private: true, dependencies: { lodash: '^4' } }),
      'src/a.ts': 'export const a = 1;\n',
    });
    const runner = new StrictRunner({ exec: okExec, install: 'never', dockerBuild: 'off' });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(report.steps.find((s) => s.name === 'install')?.status).toBe('skipped');
  });
});

describe('StrictRunner · tsc / vitest 闸门', () => {
  it('tsc 失败 → step fail 且统计 error TS 数', async () => {
    const dir = tempProject({ 'src/a.ts': 'const x: number = "oops";\n' });
    const runner = new StrictRunner({
      exec: async (cmd) => {
        if (cmd.includes('tsc')) {
          return { ok: false, stdout: 'src/a.ts(1,1): error TS2322: Type string is not assignable to number', stderr: '', timedOut: false, durationMs: 10 };
        }
        return { ok: true, stdout: '', stderr: '', timedOut: false, durationMs: 5 };
      },
      dockerBuild: 'off',
    });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    const tsc = report.steps.find((s) => s.name === 'tsc');
    expect(tsc?.status).toBe('fail');
    expect(tsc?.summary).toContain('error TS');
    expect(report.ok).toBe(false);
  });

  it('vitest JSON reporter 解析真实测试统计', async () => {
    const dir = tempProject({
      'src/a.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'src/a.test.ts': "import { expect } from 'vitest';\n",
    });
    const vitestJson = JSON.stringify({
      success: true,
      numTotalTests: 12,
      numPassedTests: 12,
      numFailedTests: 0,
    });
    const runner = new StrictRunner({
      exec: async (cmd) =>
        cmd.includes('vitest')
          ? { ok: true, stdout: vitestJson, stderr: '', timedOut: false, durationMs: 100 }
          : { ok: true, stdout: '', stderr: '', timedOut: false, durationMs: 5 },
      dockerBuild: 'off',
    });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(report.tests).toEqual({ total: 12, passed: 12, failed: 0 });
    expect(report.ok).toBe(true);
    expect(report.summary).toContain('vitest ✓ 12/12');
  });

  it('vitest 失败 → ok=false 且 detail 含失败输出', async () => {
    const dir = tempProject({
      'src/a.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'src/a.test.ts': "import { expect } from 'vitest';\n",
    });
    const runner = new StrictRunner({
      exec: async (cmd) =>
        cmd.includes('vitest')
          ? { ok: false, stdout: JSON.stringify({ numTotalTests: 3, numPassedTests: 2, numFailedTests: 1 }), stderr: 'AssertionError: expected 5 to be 4', timedOut: false, durationMs: 100 }
          : { ok: true, stdout: '', stderr: '', timedOut: false, durationMs: 5 },
      dockerBuild: 'off',
    });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(report.ok).toBe(false);
    expect(report.tests?.failed).toBe(1);
    const vitest = report.steps.find((s) => s.name === 'vitest');
    expect(vitest?.detail).toContain('AssertionError');
  });
});

describe('StrictRunner · docker 闸门', () => {
  it('无 Dockerfile → skipped', async () => {
    const dir = tempProject({ 'src/a.ts': 'export const a = 1;\n' });
    const runner = new StrictRunner({ exec: okExec, dockerBuild: 'auto' });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(report.steps.find((s) => s.name === 'docker')?.summary).toBe('无 Dockerfile');
  });

  it('Dockerfile 存在但 docker 不可用 → skipped (不阻塞)', async () => {
    const dir = tempProject({ 'src/a.ts': 'export const a = 1;\n', Dockerfile: 'FROM node:20-alpine\n' });
    const runner = new StrictRunner({
      exec: async (cmd) =>
        cmd.includes('docker version')
          ? { ok: false, stdout: '', stderr: 'command not found', timedOut: false, durationMs: 10 }
          : { ok: true, stdout: '', stderr: '', timedOut: false, durationMs: 5 },
    });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    const docker = report.steps.find((s) => s.name === 'docker');
    expect(docker?.status).toBe('skipped');
    expect(report.ok).toBe(true); // 跳过不阻塞整体结论
  });

  it('Dockerfile 存在且构建失败 → fail', async () => {
    const dir = tempProject({ 'src/a.ts': 'export const a = 1;\n', Dockerfile: 'FROM node:20-alpine\n' });
    const runner = new StrictRunner({
      exec: async (cmd) =>
        cmd.includes('docker version')
          ? { ok: true, stdout: '24.0.7', stderr: '', timedOut: false, durationMs: 10 }
          : cmd.includes('docker build')
            ? { ok: false, stdout: '', stderr: 'ERROR: failed to solve', timedOut: false, durationMs: 100 }
            : { ok: true, stdout: '', stderr: '', timedOut: false, durationMs: 5 },
    });
    const report = await runner.runGate({ cardId: 'CARD-0001', projectDir: dir });
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name === 'docker')?.status).toBe('fail');
  });
});

describe('工具链解析', () => {
  it('resolveToolchainBin 能从包位置向上找到 monorepo node_modules/.bin', () => {
    const bin = resolveToolchainBin();
    expect(bin).toBeTruthy();
    expect(bin).toContain('node_modules');
  });
});
