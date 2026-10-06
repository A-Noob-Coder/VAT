// ModelRouter 集成测试: 本地 mock HTTP 服务验证三协议请求形状 / usage 映射 / 429 冷却等待 / listModels / RPM 节流
import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelRouter, type ProviderConfig } from '../src/index.js';

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function startMock(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{ server: http.Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(bodyText || '{}') as Record<string, unknown>;
      } catch {
        body = { raw: bodyText };
      }
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body,
      });
      handler(req, bodyText, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, captured });
    });
  });
}

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** openai-compat 适配器现走 SSE 流式 — mock 以 data: 帧回复 */
function sseReply(res: http.ServerResponse, content: string, usage: object): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const REPLY = {
  openai: (content: string) =>
    JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
};

const OPENAI_CFG = (url: string, rpm?: number): ProviderConfig => ({
  id: 'mock-openai',
  protocol: 'openai-compat',
  baseUrl: url,
  apiKey: 'sk-test',
  model: 'mock-model-1',
  rpmLimit: rpm,
});

describe('openai-compat 协议适配 (SSE 流式)', () => {
  it('chat/completions 流式形状 + Bearer 鉴权 + usage 映射', async () => {
    const { server, url, captured } = await startMock((_req, _b, res) => {
      sseReply(res, '{"thought":"t","action":"a","tickets":[]}', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    });
    servers.push(server);

    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai']);
    const res = await router.generate({ system: 'sys', user: 'usr' });

    expect(res.text).toContain('thought');
    expect(res.providerId).toBe('mock-openai');
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    const cap = captured[0];
    expect(cap.method).toBe('POST');
    expect(cap.url).toBe('/chat/completions');
    expect(cap.headers.authorization).toBe('Bearer sk-test');
    expect(cap.body.model).toBe('mock-model-1');
    expect((cap.body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
    expect((cap.body as { stream?: boolean }).stream).toBe(true); // 防网关 60s 切断
  });

  it('json schema 存在时携带 response_format=json_object', async () => {
    const { server, url, captured } = await startMock((_req, _b, res) => {
      sseReply(res, '{}', {});
    });
    servers.push(server);

    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai']);
    await router.generate({ system: 's', user: 'u', schema: { type: 'object' } });
    expect((captured[0].body.response_format as { type: string }).type).toBe('json_object');
  });

  it('服务端不识别 stream_options → 自动降级重试', async () => {
    const { server, url, captured } = await startMock((_req, _bodyText, res) => {
      const current = captured[captured.length - 1]?.body as { stream_options?: unknown } | undefined;
      if (current?.stream_options) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown field stream_options' } }));
        return;
      }
      sseReply(res, '{}', {});
    });
    servers.push(server);

    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai']);
    const res = await router.generate({ system: 's', user: 'u', schema: { type: 'object' } });
    expect(res.text).toBe('{}');
    expect(captured).toHaveLength(2);
    expect((captured[0].body as { stream_options?: unknown }).stream_options).toBeTruthy();
    expect((captured[1].body as { stream_options?: unknown }).stream_options).toBeUndefined();
  });

  it('思考型模型: content 恒空时回退使用 reasoning_content', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '{"thought":"来自推理段"' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: ',"action":"a","tickets":[]}' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    servers.push(server);

    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai']);
    const res = await router.generate({ system: 's', user: 'u' });
    expect(res.text).toBe('{"thought":"来自推理段","action":"a","tickets":[]}');
  });

  it('content 与 reasoning 同时存在 → 优先 content', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      sseReply(res, '{"thought":"正文答案"}', {});
    });
    servers.push(server);

    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai']);
    const res = await router.generate({ system: 's', user: 'u' });
    expect(res.text).toBe('{"thought":"正文答案"}');
  });

  it('GET /models 列表 + 当前模型核对', async () => {
    const { server, url, captured } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }, { id: 'glm-4.7' }, { id: 'mock-model-1' }] }));
    });
    servers.push(server);

    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai']);
    const [result] = await router.listModels();
    expect(result.providerId).toBe('mock-openai');
    expect(result.models).toEqual(['glm-4.7', 'glm-5.3-flash', 'mock-model-1']);
    expect(result.currentModelInList).toBe(true);
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('/models');
    expect(captured[0].headers.authorization).toBe('Bearer sk-test');
  });
});

describe('anthropic 协议适配', () => {
  it('tool-use 强制 schema + x-api-key 鉴权 + usage 映射', async () => {
    const { server, url, captured } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'tool_use', input: { thought: 't', action: 'a', tickets: [] } }],
          usage: { input_tokens: 80, output_tokens: 40 },
        })
      );
    });
    servers.push(server);

    const cfg: ProviderConfig = { id: 'mock-anthropic', protocol: 'anthropic', baseUrl: url, apiKey: 'ak-test', model: 'claude-mock' };
    const router = new ModelRouter([cfg], ['mock-anthropic']);
    const res = await router.generate({ system: 's', user: 'u', schema: { type: 'object' } });

    expect(JSON.parse(res.text)).toEqual({ thought: 't', action: 'a', tickets: [] });
    expect(res.usage).toEqual({ promptTokens: 80, completionTokens: 40, totalTokens: 120 });
    const cap = captured[0];
    expect(cap.url).toBe('/v1/messages');
    expect(cap.headers['x-api-key']).toBe('ak-test');
    expect(cap.headers['anthropic-version']).toBe('2023-06-01');
    expect((cap.body.tool_choice as { type: string }).type).toBe('tool');
  });
});

describe('gemini 协议适配', () => {
  it('generateContent + x-goog-api-key + usageMetadata 映射', async () => {
    const { server, url, captured } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"thought":"t","action":"a","tickets":[]}' }] } }],
          usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 30, totalTokenCount: 90 },
        })
      );
    });
    servers.push(server);

    const cfg: ProviderConfig = { id: 'mock-gemini', protocol: 'gemini', baseUrl: url, apiKey: 'gk-test', model: 'gemini-mock' };
    const router = new ModelRouter([cfg], ['mock-gemini']);
    const res = await router.generate({ system: 's', user: 'u', schema: { type: 'object' } });

    expect(res.usage).toEqual({ promptTokens: 60, completionTokens: 30, totalTokens: 90 });
    const cap = captured[0];
    expect(cap.url).toBe('/models/gemini-mock:generateContent');
    expect(cap.headers['x-goog-api-key']).toBe('gk-test');
    expect((cap.body.generationConfig as { responseMimeType?: string }).responseMimeType).toBe('application/json');
  });

  it('listModels: 剥离 models/ 前缀', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-mock' }] }));
    });
    servers.push(server);

    const cfg: ProviderConfig = { id: 'mock-gemini', protocol: 'gemini', baseUrl: url, apiKey: 'gk-test', model: 'gemini-mock' };
    const router = new ModelRouter([cfg], ['mock-gemini']);
    const [result] = await router.listModels();
    expect(result.models).toEqual(['gemini-2.5-flash', 'gemini-mock']);
    expect(result.currentModelInList).toBe(true);
  });
});

describe('429 冷却与等待重试', () => {
  it('单 provider 全冷却 → 等待后重试成功 (不再一触即停)', async () => {
    let calls = 0;
    const { server, url, captured } = await startMock((_req, _b, res) => {
      calls += 1;
      if (calls <= 2) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        return;
      }
      sseReply(res, '{"thought":"t","action":"a","tickets":[]}', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    });
    servers.push(server);

    let fakeNow = 1_000_000;
    const sleeps: number[] = [];
    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai'], {
      now: () => fakeNow,
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    });

    const res = await router.generate({ system: 's', user: 'u' });
    expect(res.text).toContain('thought');
    expect(calls).toBe(3);
    // 两次 429 → 两次等待, 每次均为 retry-after 的 1s
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBe(1000);
    expect(captured.length).toBe(3);
  });

  it('持续 429 → 有限轮次后抛 AllProvidersFailedError', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      res.writeHead(429, { 'retry-after': '1' });
      res.end('rate limited');
    });
    servers.push(server);

    let fakeNow = 1_000_000;
    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai'], {
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });

    await expect(router.generate({ system: 's', user: 'u' })).rejects.toThrow(/所有模型均不可用/);
  });

  it('非限频错误 (401) 不触发等待, 直接抛错', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    });
    servers.push(server);

    const sleeps: number[] = [];
    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai'], {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(router.generate({ system: 's', user: 'u' })).rejects.toThrow(/所有模型均不可用/);
    expect(sleeps).toHaveLength(0);
  });
});

describe('RPM 客户端节流', () => {
  it('同 provider 连续调用间隔 ≥ 60000/rpmLimit', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(REPLY.openai('{}'));
    });
    servers.push(server);

    let fakeNow = 1_000_000;
    const router = new ModelRouter([OPENAI_CFG(url, 30)], ['mock-openai'], {
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });

    const t0 = fakeNow;
    await router.generate({ system: 's', user: '1' });
    await router.generate({ system: 's', user: '2' });
    await router.generate({ system: 's', user: '3' });
    // rpm=30 → 最小间隔 2000ms; 三次调用共等待 2 次
    expect(fakeNow - t0).toBe(4000);
  });

  it('rpmLimit 未设置 → 不节流', async () => {
    const { server, url } = await startMock((_req, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(REPLY.openai('{}'));
    });
    servers.push(server);

    let fakeNow = 1_000_000;
    const router = new ModelRouter([OPENAI_CFG(url)], ['mock-openai'], {
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });
    await router.generate({ system: 's', user: '1' });
    await router.generate({ system: 's', user: '2' });
    expect(fakeNow).toBe(1_000_000);
  });
});
