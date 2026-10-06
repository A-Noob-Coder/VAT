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
