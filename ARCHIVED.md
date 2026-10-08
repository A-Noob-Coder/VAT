# ⛔ ARCHIVED — 本仓库已停止开发 (2026-10-08)

## 状态

VAT (虚拟工程组织运行时) 定性为**设计草稿, 非产品**, 归档停更。

**结论依据** (Gro k 竞品分析 + 自评一致):
- 单人开发场景下, 组织层 (PM/DEV/REVIEW/QA/OPS 多角色流水线) 是 token 税: 每个角色跳转 = token + 延迟 + 新故障点, 而一个清醒的 agent + 一页 AGENTS.md 可覆盖个人项目 95% 需求
- 治理价值 (卡点/熔断/账本) 只在"无人值守多智能体舰队"场景成立, 当前无此场景
- 底层 harness (agent loop/工具层/模型适配) 不自研 — Pi (badlogic/pi-mono) 已是该位置的标准答案, 无生态对拼无意义

## 保留资产 (git 历史可查, 不迁移)

**决策 (已提炼为 AGENTS 模板, 见用户工作区)**:
1. 模型选型: 结构化输出主力 = kimi-k2.6; glm 系话痨+截断, 只做容灾
2. Windows 工程禁令: curl 发中文必毁编码 (用 node fetch) / git push 挂起=凭据 GUI / commit message 含反引号用 `-F`
3. LLM JSON 提取: 裸 JSON 整段直解优先于围栏正则 (围栏会被 body 内 ``` 劫持) — `4ed1db7`
4. 会话交接纪律: 交接页 ≤1 页, 重复犯错写进 AGENTS.md

**可复用代码 (按需从历史提取, 不作为系统维护)**:
- `packages/vat-core/src/executor/schema.ts` — extractJson/repairJson 加固 (任何 LLM JSON 解析场景可用)
- `packages/vat-core/src/notify/` — 邮件/webhook/微信推送通道 (零依赖)
- `packages/vat-providers/` — 模型容灾路由 (RPM 节流+冷却+按角色链)

**设计文档**: `docs/design/` 七篇 (架构/压缩/产品形态/价值裁决/开发清单/分层决策) — 作为设计存档保留

## 仓库处置建议

- GitHub 端: Settings → General → 底部 **Archive this repository** (变只读, 一键可逆)
- 本地: 保留目录即可, 不再 pull/push

## 后续工作方式

在真实项目里直接用 Pi / Claude Code。窗口满 → 新会话, 交接 ≤1 页。重复犯错 → 禁令写进该项目的 AGENTS.md, 不另起系统。
