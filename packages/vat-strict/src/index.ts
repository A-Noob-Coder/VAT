// StrictRunner (架构设计 §8.2): 独立于角色的真实执行闸门。
// 白名单命令 + 超时 + 输出截断; 角色 (LLM) 永远拿不到 shell。
//
// 闸门序列: scaffold → install → tsc --noEmit → vitest run → docker build (可选)
// 任何一步 fail 即整体未通过; skipped (如无 Dockerfile) 不影响结论。
import { exec as execCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { StrictGatePort, StrictReport, StrictStep } from '@vat/core';

const execAsync = promisify(execCb);

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type ExecFn = (cmd: string, cwd: string, timeoutMs: number) => Promise<ExecResult>;

const realExec: ExecFn = async (cmd, cwd, timeoutMs) => {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: '1' },
    });
    return { ok: true, stdout, stderr, timedOut: false, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(e.message ?? e),
      timedOut: Boolean(e.killed) || e.signal === 'SIGKILL',
      durationMs: Date.now() - started,
    };
  }
};

export interface StrictRunnerOptions {
  /** 含 tsc/vitest 的 bin 目录; null/undefined 时回退 npx --yes */
  binDir?: string | null;
  install?: 'auto' | 'always' | 'never';
  dockerBuild?: 'auto' | 'off';
  enableTsc?: boolean;
  enableVitest?: boolean;
  timeouts?: { installMs?: number; tscMs?: number; vitestMs?: number; dockerMs?: number };
  exec?: ExecFn;
  /** 测试注入: 跳过真实文件系统脚手架 */
  now?: () => number;
}

const DEFAULT_TIMEOUTS = { installMs: 120_000, tscMs: 60_000, vitestMs: 180_000, dockerMs: 300_000 };
const DETAIL_LIMIT = 8000;

function clip(text: string, limit = DETAIL_LIMIT): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + `\n…[截断, 原始输出 ${t.length} 字符]`;
}

function tscErrorCount(text: string): number {
  return (text.match(/error TS\d+/g) ?? []).length;
}

export class StrictRunner implements StrictGatePort {
  private readonly exec: ExecFn;
  private readonly opts: Required<Pick<StrictRunnerOptions, 'install' | 'dockerBuild' | 'enableTsc' | 'enableVitest'>> & StrictRunnerOptions;

  constructor(options: StrictRunnerOptions = {}) {
    this.opts = {
      install: options.install ?? 'auto',
      dockerBuild: options.dockerBuild ?? 'auto',
      enableTsc: options.enableTsc ?? true,
      enableVitest: options.enableVitest ?? true,
      ...options,
    };
    this.exec = options.exec ?? realExec;
  }

  async runGate(input: { cardId: string; projectDir: string }): Promise<StrictReport> {
    const { projectDir } = input;
    const steps: StrictStep[] = [];
    const timeouts = { ...DEFAULT_TIMEOUTS, ...this.opts.timeouts };

    // ── 闸门 1: 脚手架 (补齐缺失的 package.json / tsconfig.json) ──
    steps.push(await this.stepScaffold(projectDir));

    // ── 闸门 2: 依赖安装 (仅当声明了外部依赖且 node_modules 缺失) ──
    steps.push(await this.stepInstall(projectDir, timeouts.installMs));

    // ── 闸门 3: 类型检查 tsc --noEmit ──
    const tsFiles = this.findFiles(projectDir, ['.ts', '.tsx'], ['node_modules', 'dist']);
    const hasTests = this.findFiles(projectDir, ['.test.ts', '.test.tsx', '.spec.ts'], ['node_modules', 'dist']).length > 0;
    if (this.opts.enableTsc && tsFiles.length > 0) {
      const r = await this.exec(this.cmd('tsc', '--noEmit'), projectDir, timeouts.tscMs);
      const errors = tscErrorCount(r.stdout + r.stderr);
      steps.push({
        name: 'tsc',
        status: r.ok ? 'ok' : 'fail',
        durationMs: r.durationMs,
        summary: r.ok ? '类型检查通过' : r.timedOut ? `类型检查超时 (>${timeouts.tscMs / 1000}s)` : `类型检查失败 (${errors} 处 error TS)`,
        detail: r.ok ? undefined : clip(`${r.stdout}\n${r.stderr}`),
      });
    } else {
      steps.push({
        name: 'tsc',
        status: 'skipped',
        durationMs: 0,
        summary: this.opts.enableTsc ? '未发现 TypeScript 文件' : '章程已禁用 tsc 闸门',
      });
    }

    // ── 闸门 4: 单元测试 vitest run (真实执行, 报告来自真实输出) ──
    let tests: StrictReport['tests'] = null;
    if (this.opts.enableVitest && hasTests) {
      const r = await this.exec(this.cmd('vitest', 'run --reporter=json'), projectDir, timeouts.vitestMs);
      const parsed = this.parseVitestJson(r.stdout) ?? this.parseVitestText(r.stdout + r.stderr);
      tests = parsed;
      steps.push({
        name: 'vitest',
        status: r.ok ? 'ok' : 'fail',
        durationMs: r.durationMs,
        summary: parsed
          ? `测试 ${parsed.total} · 通过 ${parsed.passed} · 失败 ${parsed.failed}`
          : r.ok
            ? '测试执行成功 (无法解析统计)'
            : r.timedOut
              ? `测试超时 (>${timeouts.vitestMs / 1000}s)`
              : '测试执行失败',
        detail: r.ok ? undefined : clip(`${r.stdout}\n${r.stderr}`),
      });
    } else {
      steps.push({
        name: 'vitest',
        status: 'skipped',
        durationMs: 0,
        summary: this.opts.enableVitest ? '未发现测试文件 (*.test.ts / *.spec.ts)' : '章程已禁用 vitest 闸门',
      });
    }

    // ── 闸门 5: docker build (可选, Dockerfile 存在且 docker 可用) ──
    steps.push(await this.stepDocker(input.cardId, projectDir, timeouts.dockerMs));

    const failed = steps.filter((s) => s.status === 'fail');
    const ran = steps.filter((s) => s.status !== 'skipped');
    const ok = failed.length === 0 && ran.length > 0;
    const summary = failed.length > 0
      ? failed.map((s) => s.summary).join('; ')
      : steps
          .filter((s) => s.status !== 'skipped')
          .map((s) => `${s.name} ✓${s.name === 'vitest' && tests ? ` ${tests.passed}/${tests.total}` : ''}`)
          .join(' · ') || '无可执行验证内容';

    return { ok, summary, projectDir, steps, tests };
  }

  // ---------- 各闸门实现 ----------

  private async stepScaffold(projectDir: string): Promise<StrictStep> {
    const started = Date.now();
    const actions: string[] = [];
    const pkg = path.join(projectDir, 'package.json');
    const tsconfig = path.join(projectDir, 'tsconfig.json');
    fs.mkdirSync(projectDir, { recursive: true });
    if (!fs.existsSync(pkg)) {
      fs.writeFileSync(
        pkg,
        JSON.stringify(
          { name: 'vat-strict-project', private: true, version: '0.0.0', type: 'module' },
          null,
          2
        ) + '\n',
        'utf8'
      );
      actions.push('补齐 package.json');
    }
    if (!fs.existsSync(tsconfig)) {
      fs.writeFileSync(
        tsconfig,
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              esModuleInterop: true,
              forceConsistentCasingInFileNames: true,
            },
            include: ['**/*.ts', '**/*.tsx'],
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
      actions.push('补齐 tsconfig.json');
    }
    return {
      name: 'scaffold',
      status: 'ok',
      durationMs: Date.now() - started,
      summary: actions.length > 0 ? actions.join(', ') : '工程文件齐备',
    };
  }

  private async stepInstall(projectDir: string, timeoutMs: number): Promise<StrictStep> {
    const started = Date.now();
    const pkgFile = path.join(projectDir, 'package.json');
    let needsDeps = false;
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as Record<string, Record<string, unknown>>;
        const own = { ...pkg.dependencies, ...pkg.devDependencies };
        // 仅脚手架产生的空工程视为无外部依赖
        needsDeps = Object.keys(own).length > 0;
      } catch {
        needsDeps = true;
      }
    }
    const hasModules = fs.existsSync(path.join(projectDir, 'node_modules'));
    if (this.opts.install === 'never' || (this.opts.install === 'auto' && (!needsDeps || hasModules))) {
      return {
        name: 'install',
        status: 'skipped',
        durationMs: Date.now() - started,
        summary: hasModules ? 'node_modules 已存在' : '无外部依赖, 跳过安装',
      };
    }
    const r = await this.exec('npm install --ignore-scripts --no-audit --no-fund', projectDir, timeoutMs);
    return {
      name: 'install',
      status: r.ok ? 'ok' : 'fail',
      durationMs: r.durationMs,
      summary: r.ok ? '依赖安装完成' : r.timedOut ? `依赖安装超时 (>${timeoutMs / 1000}s)` : '依赖安装失败',
      detail: r.ok ? undefined : clip(`${r.stdout}\n${r.stderr}`, 4000),
    };
  }

  private async stepDocker(cardId: string, projectDir: string, timeoutMs: number): Promise<StrictStep> {
    const started = Date.now();
    const dockerfile = path.join(projectDir, 'Dockerfile');
    if (this.opts.dockerBuild === 'off' || !fs.existsSync(dockerfile)) {
      return {
        name: 'docker',
        status: 'skipped',
        durationMs: Date.now() - started,
        summary: this.opts.dockerBuild === 'off' ? '章程已禁用 docker 闸门' : '无 Dockerfile',
      };
    }
    const probe = await this.exec('docker version --format "{{.Server.Version}}"', projectDir, 8_000);
    if (!probe.ok) {
      return {
        name: 'docker',
        status: 'skipped',
        durationMs: Date.now() - started,
        summary: 'docker 不可用, 跳过构建验证',
      };
    }
    const r = await this.exec(`docker build -t vat-card-${cardId.toLowerCase()} .`, projectDir, timeoutMs);
    return {
      name: 'docker',
      status: r.ok ? 'ok' : 'fail',
      durationMs: r.durationMs,
      summary: r.ok ? '镜像构建成功' : r.timedOut ? `镜像构建超时 (>${timeoutMs / 1000}s)` : '镜像构建失败',
      detail: r.ok ? undefined : clip(r.stderr || r.stdout),
    };
  }

  // ---------- 工具 ----------

  /** 组装白名单命令; binDir 优先, 回退 npx --yes */
  private cmd(tool: 'tsc' | 'vitest', args: string): string {
    const bin = this.opts.binDir ? path.join(this.opts.binDir, tool) : null;
    if (bin && (fs.existsSync(bin) || fs.existsSync(`${bin}.cmd`) || fs.existsSync(`${bin}.ps1`))) {
      return `"${bin}" ${args}`;
    }
    return `npx --yes ${tool} ${args}`;
  }

  private findFiles(dir: string, exts: string[], exclude: string[]): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (exclude.includes(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  }

  private parseVitestJson(stdout: string): StrictReport['tests'] {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      const data = JSON.parse(stdout.slice(start, end + 1)) as {
        numTotalTests?: number;
        numPassedTests?: number;
        numFailedTests?: number;
      };
      if (data.numTotalTests === undefined) return null;
      return {
        total: data.numTotalTests ?? 0,
        passed: data.numPassedTests ?? 0,
        failed: data.numFailedTests ?? 0,
      };
    } catch {
      return null;
    }
  }

  private parseVitestText(text: string): StrictReport['tests'] {
    const m = /Tests\s+(\d+)\s+passed(?:\s+\((\d+)\))?/.exec(text);
    if (m?.[1]) {
      const failed = /Tests\s+\d+\s+failed/.test(text);
      return { total: Number(m[1]), passed: Number(m[1]), failed: failed ? 1 : 0 };
    }
    return null;
  }
}

/**
 * 从指定目录向上查找同时含 tsc 与 vitest 的 node_modules/.bin。
 * VAT 以 npm 包分发时, 自带的工具链随依赖安装, 工程无需单独装 tsc。
 */
export function resolveToolchainBin(fromDir?: string): string | null {
  let dir = fromDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const bin = path.join(dir, 'node_modules', '.bin');
    if (
      fs.existsSync(path.join(bin, 'tsc')) ||
      fs.existsSync(path.join(bin, 'tsc.cmd')) ||
      fs.existsSync(path.join(bin, 'vitest')) ||
      fs.existsSync(path.join(bin, 'vitest.cmd'))
    ) {
      return bin;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** docker 可用性探测 (doctor / 闸门共用) */
export async function dockerAvailable(exec: ExecFn = realExec): Promise<boolean> {
  const r = await exec('docker version --format "{{.Server.Version}}"', process.cwd(), 8_000);
  return r.ok;
}
