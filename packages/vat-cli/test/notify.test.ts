import { describe, expect, it } from 'vitest';
import { buildNotifier, type NotifyMessage } from '@vat/core';

type Call = { url: string; payload: unknown; headers: Record<string, string> };

function mockFetch(calls: Call[], failUrls: Set<string> = new Set()) {
  const impl = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const payload = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, payload, headers: init?.headers ?? {} });
    if (failUrls.has(url)) {
      return new Response('{"error":"boom"}', { status: 500, statusText: 'Internal Server Error' });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return impl;
}

const MSG: NotifyMessage = {
  title: '需求澄清',
  body: '请确认 A 还是 B',
  level: 'warn',
  card: 'CARD-1',
};

describe('buildNotifier', () => {
  it('wechat 通道按企微机器人格式推送 text 载荷', async () => {
    const calls: Call[] = [];
    const notifier = buildNotifier(
      { notify: { channels: [{ id: 'wx', type: 'wechat', url: 'https://wx.example/push' }] } },
      { fetchImpl: mockFetch(calls) }
    );
    const r = await notifier.notify(MSG);
    expect(r.sent).toEqual(['wx']);
    expect(r.failed).toEqual([]);
    expect(calls[0].url).toBe('https://wx.example/push');
    expect(calls[0].payload).toMatchObject({
      msgtype: 'text',
      text: { content: expect.stringContaining('需求澄清') },
    });
  });

  it('webhook 通道按模板分发 wecom/feishu/slack 载荷', async () => {
    const calls: Call[] = [];
    const notifier = buildNotifier(
      {
        notify: {
          channels: [
            { id: 'qy', type: 'webhook', template: 'wecom', url: 'https://h/wecom' },
            { id: 'fs', type: 'webhook', template: 'feishu', url: 'https://h/feishu' },
            { id: 'sl', type: 'webhook', template: 'slack', url: 'https://h/slack' },
          ],
        },
      },
      { fetchImpl: mockFetch(calls) }
    );
    const r = await notifier.notify(MSG);
    expect(r.sent).toHaveLength(3);
    expect(calls[0].payload).toMatchObject({ msgtype: 'text', text: { content: expect.any(String) } });
    expect(calls[1].payload).toMatchObject({ msg_type: 'text', content: { text: expect.any(String) } });
    expect(calls[2].payload).toMatchObject({ text: expect.any(String) });
  });

  it('email 通道走 HTTP 邮件 API 并带 Bearer 头', async () => {
    process.env.VAT_TEST_MAIL_KEY = 'sk-test';
    const calls: Call[] = [];
    const notifier = buildNotifier(
      {
        notify: {
          channels: [
            {
              id: 'mail',
              type: 'email',
              to: 'user@example.com',
              apiKeyEnv: 'VAT_TEST_MAIL_KEY',
              apiUrl: 'https://mail.example/emails',
            },
          ],
        },
      },
      { fetchImpl: mockFetch(calls) }
    );
    const r = await notifier.notify(MSG);
    expect(r.sent).toEqual(['mail']);
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test');
    expect(calls[0].payload).toMatchObject({
      to: ['user@example.com'],
      subject: '[VAT] 需求澄清',
    });
    delete process.env.VAT_TEST_MAIL_KEY;
  });

  it('单通道失败不阻断其他通道 (best-effort 隔离)', async () => {
    const calls: Call[] = [];
    const notifier = buildNotifier(
      {
        notify: {
          channels: [
            { id: 'bad', type: 'webhook', url: 'https://h/bad' },
            { id: 'good', type: 'wechat', url: 'https://h/good' },
          ],
        },
      },
      { fetchImpl: mockFetch(calls, new Set(['https://h/bad'])) }
    );
    const r = await notifier.notify(MSG);
    expect(r.sent).toEqual(['good']);
    expect(r.failed).toEqual([{ id: 'bad', error: expect.stringContaining('HTTP 500') }]);
  });

  it('email 缺少 apiKey 记为失败而非抛出', async () => {
    const calls: Call[] = [];
    const notifier = buildNotifier(
      { notify: { channels: [{ id: 'mail', type: 'email', to: 'a@b.c', apiKeyEnv: 'VAT_NO_SUCH_KEY' }] } },
      { fetchImpl: mockFetch(calls) }
    );
    const r = await notifier.notify(MSG);
    expect(r.sent).toEqual([]);
    expect(r.failed[0].error).toContain('缺少 apiKey');
    expect(calls).toHaveLength(0);
  });

  it('disabled 通道不发送', async () => {
    const calls: Call[] = [];
    const notifier = buildNotifier(
      { notify: { channels: [{ id: 'off', type: 'wechat', url: 'https://h/off', enabled: false }] } },
      { fetchImpl: mockFetch(calls) }
    );
    const r = await notifier.notify(MSG);
    expect(r.sent).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
