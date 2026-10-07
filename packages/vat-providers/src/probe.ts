// 模型探测 → 推荐 modelChain 顺序 (v0.3 #8 / K01「换主力模型」)。
// router.probe() 已能探测每个 provider 可用性; 此函数把结果转成"可用优先"的链顺序,
// 供 `vat doctor --network` 直接给出可粘贴的 modelChain 建议。
import type { ChainAttempt } from './index.js';

/**
 * 根据探测结果给出建议 modelChain 顺序: 可用的排到链首, 同可用度保持原序。
 * 服务于"把探测到的可用模型换为主力"——避免与 glm-5.3-flash 这类思考型模型的
 * 深度思考习惯对抗 (K01-K03 的解法不是对抗, 是换链首项)。
 */
export function suggestChain(chain: string[], attempts: ChainAttempt[]): string[] {
  const ok = new Set(attempts.filter((a) => a.ok).map((a) => a.providerId));
  return [...chain].sort((a, b) => Number(ok.has(b)) - Number(ok.has(a)));
}
