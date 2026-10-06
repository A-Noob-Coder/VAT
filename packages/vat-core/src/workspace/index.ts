// 工作区目录规范与初始化 (架构设计 §4: 唯一事实源)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CHARTER_MARKDOWN, parseCharter, renderCharter } from '../charter/index.js';
import type { Charter } from '../types.js';
import { DEFAULT_CONFIG_JSON } from '../config.js';

export interface WorkspacePaths {
  root: string;
  charterFile: string;
  configFile: string;
  boardDir: string;
  ticketsDir: string;
  deadDir: string;
  heldDir: string;
  memoryDir: string;
  projectsDir: string;
  deliverablesDir: string;
  ledgerDir: string;
  eventsDir: string;
  scenariosDir: string;

  mailboxIn(roleId: string): string;
  mailboxArchive(roleId: string): string;
  roleMemoryDir(roleId: string): string;
  cardFile(cardId: string): string;
  cardProjectDir(cardId: string): string;
  cardDeliverableDir(cardId: string): string;
  ledgerFile(day: string): string; // day = YYYYMMDD
  eventsFile(day: string): string;
}

export function resolvePaths(root: string): WorkspacePaths {
  const p = (...rel: string[]) => path.join(root, ...rel);
  return {
    root,
    charterFile: p('agent.md'),
    configFile: p('vat.config.json'),
    boardDir: p('board'),
    ticketsDir: p('tickets'),
    deadDir: p('tickets', '_dead'),
    heldDir: p('tickets', '_held'),
    memoryDir: p('memory'),
    projectsDir: p('projects'),
    deliverablesDir: p('deliverables'),
    ledgerDir: p('ledger'),
    eventsDir: p('events'),
    scenariosDir: p('scenarios'),

    mailboxIn: (roleId) => p('tickets', `${roleId}-docs`, 'in'),
    mailboxArchive: (roleId) => p('tickets', `${roleId}-docs`, 'archive'),
    roleMemoryDir: (roleId) => p('memory', roleId),
    cardFile: (cardId) => p('board', `${cardId}.md`),
    cardProjectDir: (cardId) => p('projects', cardId),
    cardDeliverableDir: (cardId) => p('deliverables', cardId),
    ledgerFile: (day) => p('ledger', `usage-${day}.jsonl`),
    eventsFile: (day) => p('events', `hub-${day}.jsonl`),
  };
}

/** 初始化工作区: 目录骨架 + 默认章程 + 默认配置 */
export function initWorkspace(root: string, charter?: Charter): void {
  const paths = resolvePaths(root);
  for (const dir of [
    paths.boardDir,
    paths.ticketsDir,
    paths.deadDir,
    paths.heldDir,
    paths.memoryDir,
    paths.projectsDir,
    paths.deliverablesDir,
    paths.ledgerDir,
    paths.eventsDir,
    paths.scenariosDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const roles =
    charter?.data.team.roles ?? parseCharter(DEFAULT_CHARTER_MARKDOWN).data.team.roles;
  for (const role of roles) {
    fs.mkdirSync(paths.mailboxIn(role.id), { recursive: true });
    fs.mkdirSync(paths.mailboxArchive(role.id), { recursive: true });
    fs.mkdirSync(paths.roleMemoryDir(role.id), { recursive: true });
  }
  if (!fs.existsSync(paths.charterFile)) {
    fs.writeFileSync(
      paths.charterFile,
      charter ? renderCharter(charter) : DEFAULT_CHARTER_MARKDOWN,
      'utf8'
    );
  }
  if (!fs.existsSync(paths.configFile)) {
    fs.writeFileSync(paths.configFile, DEFAULT_CONFIG_JSON, 'utf8');
  }
}

/** 校验工作区完整性, 返回缺失项列表 (vat doctor 用) */
export function checkWorkspace(paths: WorkspacePaths, charter: Charter): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(paths.charterFile)) missing.push('agent.md');
  if (!fs.existsSync(paths.configFile)) missing.push('vat.config.json');
  for (const dir of [paths.boardDir, paths.deadDir, paths.heldDir, paths.ledgerDir, paths.eventsDir]) {
    if (!fs.existsSync(dir)) missing.push(path.relative(paths.root, dir));
  }
  for (const role of charter.data.team.roles) {
    if (!fs.existsSync(paths.mailboxIn(role.id))) missing.push(`tickets/${role.id}-docs/in`);
    if (!fs.existsSync(paths.roleMemoryDir(role.id))) missing.push(`memory/${role.id}`);
  }
  return missing;
}
