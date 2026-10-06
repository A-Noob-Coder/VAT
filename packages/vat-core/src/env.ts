// .env 加载器: key 不进 config、不进 shell 历史 (架构设计 v0.3-plan V1-4)
import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 .env 文件并注入 process.env。
 * 规则: KEY=VALUE (值可带引号); # 注释; 已存在的环境变量不被覆盖。
 * 依次加载 cwd/.env 与 <工作区根>/.env (后者优先级更高, 后加载者也不覆盖先到者)。
 */
export function loadEnv(...dirs: string[]): string[] {
  const loaded: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, '.env');
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!key || !(key in process.env)) {
        process.env[key] = value;
        loaded.push(key);
      }
    }
  }
  return loaded;
}
