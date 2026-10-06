// 测试助手: 临时工作区 (vat-cli 测试用, 基于 @vat/core 公共出口)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultCharter,
  initWorkspace,
  resolvePaths,
  type Charter,
  type WorkspacePaths,
} from '@vat/core';

export const FIXED_NOW = () => new Date(2026, 9, 6, 9, 30, 0);

export function makeWorkspace(modify?: (c: Charter) => void): {
  root: string;
  paths: WorkspacePaths;
  charter: Charter;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-cli-test-'));
  const charter = defaultCharter();
  modify?.(charter);
  initWorkspace(root, charter);
  return { root, paths: resolvePaths(root), charter };
}
