// vat.config.json 读写 (模型接入 / git / hub 设置) (架构设计 §7.1)
import fs from 'node:fs';
import type { VatConfig, ModelMemorySettings } from './types.js';
import { DEFAULT_MEMORY_SETTINGS } from './types.js';

export const DEFAULT_CONFIG_JSON = JSON.stringify(
  {
    providers: [
      {
        id: 'gemini',
        protocol: 'gemini',
        apiKeyEnv: 'GEMINI_API_KEY',
        model: 'gemini-2.5-flash',
        rpmLimit: 10,
      },
    ],
    modelChain: ['gemini'],
    modelSettings: {
      gemini: { memory: { summaryWarnChars: 4000, decisionWindow: 15, lessonWindow: 20 } },
    },
    git: { autocommit: true },
    hub: { maxConcurrentCards: 1 },
  },
  null,
  2
);

export class ConfigError extends Error {}

export function loadConfig(configFile: string): VatConfig {
  if (!fs.existsSync(configFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8')) as VatConfig;
  } catch (err) {
    throw new ConfigError(`vat.config.json 不是合法 JSON: ${(err as Error).message}`);
  }
}

export function memorySettingsFor(config: VatConfig, providerId: string | undefined): ModelMemorySettings {
  const override = providerId ? config.modelSettings?.[providerId]?.memory : undefined;
  return { ...DEFAULT_MEMORY_SETTINGS, ...override };
}

/**
 * 解析某角色实际使用的模型链路 (角色级覆盖 + 全局回退)。
 * - 优先取 `roleModels[roleId]` (单 id 或 id 数组);
 * - 过滤掉 providers 中不存在的 id;
 * - 若解析后仍为空, 回退到全局 `modelChain`; 再为空则返回 []。
 */
export function resolveRoleChain(config: VatConfig, roleId: string): string[] {
  const globalChain = config.modelChain ?? [];
  const raw = config.roleModels?.[roleId];
  if (raw == null) return globalChain;
  const ids = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x));
  const valid = ids.filter((id) => (config.providers ?? []).some((p) => p.id === id));
  return valid.length > 0 ? valid : globalChain;
}
