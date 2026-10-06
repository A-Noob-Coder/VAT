// 角色记忆三件套 (架构设计 §5.4): 真实落盘, Hub 注入, 阈值随模型接入配置
import fs from 'node:fs';
import path from 'node:path';
import type {
  MemoryDecision,
  MemoryLesson,
  MemorySnapshot,
  MemoryUpdates,
  ModelMemorySettings,
} from '../types.js';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ts(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let seq = 0;
export function newId(prefix: string): string {
  seq = (seq + 1) % 10000;
  return `${prefix}-${Date.now().toString(36)}${seq}`.toUpperCase();
}

// ---------- 读取 ----------

export function readSummary(memoryDir: string): string {
  const file = path.join(memoryDir, 'summary.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '(暂无摘要)';
}

export function readDecisions(memoryDir: string): MemoryDecision[] {
  return readEntries(path.join(memoryDir, 'decisions.md')).map((e) => ({
    id: e.id,
    title: e.a,
    rationale: e.b,
    timestamp: e.ts,
  }));
}

export function readLessons(memoryDir: string): MemoryLesson[] {
  return readEntries(path.join(memoryDir, 'lessons.md')).map((e) => ({
    id: e.id,
    issue: e.a,
    avoidance: e.b,
    timestamp: e.ts,
  }));
}

interface RawEntry {
  id: string;
  ts: string;
  a: string;
  b: string;
}

function readEntries(file: string): RawEntry[] {
  if (!fs.existsSync(file)) return [];
  const out: RawEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^-\s+(\S+)\s+\|([^|]*)\|([^|]*)\|(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined && match[3] !== undefined && match[4] !== undefined) {
      out.push({
        id: match[1].trim(),
        ts: match[2].trim(),
        a: match[3].trim(),
        b: match[4].trim(),
      });
    }
  }
  return out;
}

export function readSnapshot(memoryDir: string, settings: ModelMemorySettings): MemorySnapshot {
  const decisions = readDecisions(memoryDir).slice(-settings.decisionWindow);
  const lessons = readLessons(memoryDir).slice(-settings.lessonWindow);
  return { summary: readSummary(memoryDir), decisions, lessons };
}

// ---------- 写入 ----------

function appendEntries(file: string, rows: Array<{ id: string; a: string; b: string }>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map(
    (r) => `- ${r.id} | ${ts()} | ${r.a.replace(/\n/g, ' ')} | ${r.b.replace(/\n/g, ' ')}`
  );
  fs.appendFileSync(file, (fs.existsSync(file) && fs.statSync(file).size > 0 ? '\n' : '') + lines.join('\n') + '\n', 'utf8');
}

/** 应用执行器的记忆更新; 返回被截断/修正的告警 */
export function writeMemoryUpdates(
  memoryDir: string,
  updates: MemoryUpdates | undefined,
  settings: ModelMemorySettings
): string[] {
  const warnings: string[] = [];
  if (!updates) return warnings;

  if (updates.summaryUpdate !== undefined) {
    let text = updates.summaryUpdate.trim();
    if (text.length === 0) text = '(空摘要)';
    if (text.length > settings.summaryWarnChars) {
      text = `${text.slice(0, settings.summaryWarnChars)}…[超限截断]`;
      warnings.push(`summaryUpdate 超过 ${settings.summaryWarnChars} 字符, 已截断`);
    }
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'summary.md'), text + '\n', 'utf8');
  }
  if (updates.newDecision) {
    appendEntries(path.join(memoryDir, 'decisions.md'), [
      { id: newId('DEC'), a: updates.newDecision.title, b: updates.newDecision.rationale },
    ]);
  }
  if (updates.newLesson) {
    appendEntries(path.join(memoryDir, 'lessons.md'), [
      { id: newId('LES'), a: updates.newLesson.issue, b: updates.newLesson.avoidance },
    ]);
  }
  return warnings;
}

/** 手动压缩: 把超出窗口的历史 decisions/lessons 移入归档文件 (v0.2 策略) */
export function compressMemory(memoryDir: string, settings: ModelMemorySettings): {
  archivedDecisions: number;
  archivedLessons: number;
} {
  const decFile = path.join(memoryDir, 'decisions.md');
  const lesFile = path.join(memoryDir, 'lessons.md');

  const archive = (file: string, window: number, archiveName: string): number => {
    const entries = readEntries(file);
    if (entries.length <= window) return 0;
    const overflow = entries.slice(0, entries.length - window);
    const keep = entries.slice(entries.length - window);
    const archiveFile = path.join(memoryDir, archiveName);
    for (const e of overflow) {
      fs.appendFileSync(
        archiveFile,
        `- ${e.id} | ${e.ts} | ${e.a} | ${e.b}\n`,
        'utf8'
      );
    }
    fs.writeFileSync(
      file,
      keep.map((e) => `- ${e.id} | ${e.ts} | ${e.a} | ${e.b}`).join('\n') + '\n',
      'utf8'
    );
    return overflow.length;
  };

  return {
    archivedDecisions: archive(decFile, settings.decisionWindow, 'decisions-archive.md'),
    archivedLessons: archive(lesFile, settings.lessonWindow, 'lessons-archive.md'),
  };
}
