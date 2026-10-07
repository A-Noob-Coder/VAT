import { describe, it, expect } from 'vitest';
import { suggestChain } from '../src/probe.js';
import type { ChainAttempt } from '../src/index.js';

describe('suggestChain', () => {
  it('把可用模型排到链首, 同可用度保持原序', () => {
    const chain = ['glm', 'claude', 'gpt'];
    const attempts: ChainAttempt[] = [
      { providerId: 'glm', ok: false, detail: 'x' },
      { providerId: 'claude', ok: true, detail: 'y' },
      { providerId: 'gpt', ok: true, detail: 'z' },
    ];
    expect(suggestChain(chain, attempts)).toEqual(['claude', 'gpt', 'glm']);
  });

  it('全部不可用则保持原序', () => {
    const chain = ['a', 'b'];
    const attempts: ChainAttempt[] = [
      { providerId: 'a', ok: false, detail: '' },
      { providerId: 'b', ok: false, detail: '' },
    ];
    expect(suggestChain(chain, attempts)).toEqual(['a', 'b']);
  });

  it('空链返回空', () => {
    expect(suggestChain([], [])).toEqual([]);
  });
});
