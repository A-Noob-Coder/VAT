// extractJson 健壮性测试: 真实模型输出的各种脏形态
import { describe, expect, it } from 'vitest';
import { extractJson, repairJson } from '../src/index.js';

const ENVELOPE = '{"thought":"t","action":"a","tickets":[]}';

describe('extractJson · 真实模型脏输出', () => {
  it('干净 JSON', () => {
    expect(extractJson(ENVELOPE)).toEqual({ thought: 't', action: 'a', tickets: [] });
  });

  it('```json 围栏包裹', () => {
    expect(extractJson('```json\n' + ENVELOPE + '\n```')).toEqual({ thought: 't', action: 'a', tickets: [] });
  });

  it('<think> 推理段剥离', () => {
    expect(extractJson(`<think>想一想… { 假对象 }</think>\n${ENVELOPE}`)).toEqual({
      thought: 't',
      action: 'a',
      tickets: [],
    });
  });

  it('尾随逗号 + // 注释 (宽健修复)', () => {
    expect(
      extractJson('{\n  // 思考注释\n  "thought": "t",\n  "tickets": [],\n}')
    ).toEqual({ thought: 't', tickets: [] });
  });

  it('思考流中夹带代码 + 信封在最后 → 取最后一个完整顶层对象', () => {
    const reasoning = [
      '先设计接口: {',
      '  capacity: 100,   // 思考中的伪代码对象',
      '}',
      '再考虑 TTL 边界 { a: 1 } …',
      '最终结论:',
      ENVELOPE,
    ].join('\n');
    expect(extractJson(reasoning)).toEqual({ thought: 't', action: 'a', tickets: [] });
  });

  it('信封在字符串里包含花括号时仍正确配对', () => {
    const withBraces = '{"thought":"代码里有 { 和 }","action":"a","tickets":[]}';
    const reasoning = `写代码 class A { x = 1; }\n结论:\n${withBraces}`;
    expect(extractJson(reasoning)).toEqual({ thought: '代码里有 { 和 }', action: 'a', tickets: [] });
  });

  it('无 JSON → 报错', () => {
    expect(() => extractJson('这里没有任何对象')).toThrow(/未找到 JSON 对象/);
  });

  it('裸信封内含 ``` 代码块 — 围栏不得劫持提取 (2026-10-07 PM PRD 故障回归)', () => {
    const raw = [
      '{"thought":"t","action":"a","tickets":[{"to":"DEV","type":"task","title":"t1",',
      '"body":"## 数据模型\\n```\\ninterface Todo {\\n id: number;\\n content: string;\\n}\\n```\\n完成"}]}',
    ].join('');
    const out = extractJson(raw) as { tickets: Array<{ to: string; title: string }> };
    expect(out.tickets[0].to).toBe('DEV');
    expect(out.tickets[0].title).toBe('t1');
  });

  it('裸信封 + 前后缀散文 + body 内含真实换行的 interface 代码块', () => {
    const raw = [
      '好的, 以下是我的产出:\n',
      '{"thought":"t","action":"a","tickets":[{"to":"QA","type":"review","title":"x",',
      '"body":"说明:\\n```\\ninterface Todo {\\n id: number;\\n}\\n```\ndone"}],',
      '"statusSuggestion":"ready"}\n以上。',
    ].join('');
    const out = extractJson(raw) as { tickets: Array<{ to: string }>; statusSuggestion: string };
    expect(out.tickets[0].to).toBe('QA');
    expect(out.statusSuggestion).toBe('ready');
  });

  it('字符串内裸换行/制表符 (未转义控制字符) 走修复路径', () => {
    const raw =
      '{"thought":"t","action":"a","tickets":[{"to":"DEV","type":"task","title":"x","body":"第一行\n第二行\n\t第三行"}]}';
    const out = extractJson(raw) as { tickets: Array<{ body: string }> };
    expect(out.tickets[0].body).toBe('第一行\n第二行\n\t第三行');
  });
});

describe('repairJson', () => {
  it('字符串内的 // 与 " 不被破坏', () => {
    const src = '{"url":"http://x","note":" Say \\"hi\\""}';
    expect(JSON.parse(repairJson(src))).toEqual({ url: 'http://x', note: ' Say "hi"' });
  });
});
