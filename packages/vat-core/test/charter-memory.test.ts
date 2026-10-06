// 章程解析 / 记忆三件套测试
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  CharterError,
  compressMemory,
  defaultCharter,
  parseCharter,
  readSnapshot,
  renderCharter,
  withRole,
  writeMemoryUpdates,
  DEFAULT_MEMORY_SETTINGS,
} from '../src/index.js';

describe('章程', () => {
  it('默认章程可解析, 五角色在编', () => {
    const c = defaultCharter();
    expect(c.data.team.roles.map((r) => r.id)).toEqual(['PM', 'DEV', 'REVIEW', 'QA', 'OPS']);
    expect(c.data.circuit_breaker.max_rejections).toBe(3);
    expect(c.data.checkpoints.requirement_approval).toBe(true);
  });

  it('render → parse 往返无损', () => {
    const c = defaultCharter();
    const parsed = parseCharter(renderCharter(c));
    expect(parsed.data).toEqual(c.data);
    expect(parsed.body).toBe(c.body);
  });

  it('缺 frontmatter 抛错', () => {
    expect(() => parseCharter('# 只有正文')).toThrow(CharterError);
  });

  it('角色 id 重复抛错', () => {
    const c = JSON.parse(JSON.stringify(defaultCharter())) as ReturnType<typeof defaultCharter>;
    c.data.team.roles.push({ ...c.data.team.roles[0] }); // 重复 PM
    expect(() => parseCharter(renderCharter(c))).toThrow(CharterError);
  });

  it('withRole 招聘 SEC 并保留原编制', () => {
    const c = defaultCharter();
    const next = withRole(c, {
      id: 'SEC',
      title: '安全官',
      responsibilities: '安全审计',
      consumes: ['review'],
    });
    expect(next.team.roles.map((r) => r.id)).toContain('SEC');
    expect(next.team.roles.length).toBe(6);
  });
});

describe('记忆三件套', () => {
  it('写入决策/教训/摘要并可读回', () => {
    const dir = fs.mkdtempSync('vat-mem-');
    try {
      writeMemoryUpdates(dir, {
        summaryUpdate: '已完成需求拆解',
        newDecision: { title: '采用惰性补充', rationale: 'O(1)' },
        newLesson: { issue: '参数校验遗漏', avoidance: '提审前自查' },
      }, DEFAULT_MEMORY_SETTINGS);
      const snap = readSnapshot(dir, DEFAULT_MEMORY_SETTINGS);
      expect(snap.summary).toBe('已完成需求拆解');
      expect(snap.decisions).toHaveLength(1);
      expect(snap.decisions[0].title).toBe('采用惰性补充');
      expect(snap.lessons).toHaveLength(1);
      expect(snap.lessons[0].avoidance).toBe('提审前自查');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('注入窗口生效 (窗口=2 时只读最近两条)', () => {
    const dir = fs.mkdtempSync('vat-mem-');
    try {
      for (let i = 0; i < 5; i++) {
        writeMemoryUpdates(dir, { newDecision: { title: `决策${i}`, rationale: 'r' } }, DEFAULT_MEMORY_SETTINGS);
      }
      const snap = readSnapshot(dir, { ...DEFAULT_MEMORY_SETTINGS, decisionWindow: 2 });
      expect(snap.decisions).toHaveLength(2);
      expect(snap.decisions[1].title).toBe('决策4');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('手动压缩: 超窗口条目归档', () => {
    const dir = fs.mkdtempSync('vat-mem-');
    try {
      for (let i = 0; i < 5; i++) {
        writeMemoryUpdates(dir, { newLesson: { issue: `坑${i}`, avoidance: 'a' } }, DEFAULT_MEMORY_SETTINGS);
      }
      const result = compressMemory(dir, { ...DEFAULT_MEMORY_SETTINGS, lessonWindow: 2 });
      expect(result.archivedLessons).toBe(3);
      const snap = readSnapshot(dir, { ...DEFAULT_MEMORY_SETTINGS, lessonWindow: 30 });
      expect(snap.lessons).toHaveLength(2);
      expect(fs.existsSync(`${dir}/lessons-archive.md`)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('超长摘要截断并告警', () => {
    const dir = fs.mkdtempSync('vat-mem-');
    try {
      const warnings = writeMemoryUpdates(
        dir,
        { summaryUpdate: 'x'.repeat(100) },
        { ...DEFAULT_MEMORY_SETTINGS, summaryWarnChars: 50 }
      );
      expect(warnings).toHaveLength(1);
      expect(readSnapshot(dir, DEFAULT_MEMORY_SETTINGS).summary.length).toBeLessThanOrEqual(60);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
