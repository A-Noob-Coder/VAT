# VAT 压缩机制规格 —— 扒取 Claude Code / Codex 编排层实现

> 版本：v0.3-compact-spec
> 目的：将 Claude Code 与 Codex（均开源）的上下文压缩（compaction）机制中**编排层可复用**的部分，映射到 VAT §4.4「隔离 + 压缩 双级记忆模型」，直接缓解「压缩质量 = 架构命门」风险。
> 来源：两家 CLI 均为开源（Claude Code `anthropics/claude-code` Apache 2.0；Codex `openai/codex` MIT），以下机制来自对开源代码的社区逆向整理（文件路径与常量可逐一核对上游）。

---

## 0. 结论

1. **能扒，且只扒编排层即可。** 两家压缩的"摘要质量"最终由调用模型决定（与 VAT 同构），但**分层策略、固定摘要 schema、触发/熔断常量、预压缩钩子**全部是显式代码，可直接借鉴。
2. **VAT 当前 §4.4 的 Compact 是单层的**（一次 LLM 摘要）。应升级为**分层 + 结构化 schema + 熔断 + 预压缩钩子 + 无模型回退**，对齐两家最佳实践。
3. **扒不到的部分**（服务端 `context_management` beta / 远端 `encrypted_content`）依赖模型潜在理解，对 VAT 不必要——VAT 的压缩目标是写回 `memory/<ROLE>/` 文件，本就走本地确定性路径。

---

## 1. Claude Code 压缩机制（5 层渐进）

关键目录：`src/services/compact/`

| 层 | 机制 | 触发 | 文件 | VAT 可采纳 |
|---|---|---|---|---|
| T1 MicroCompact | 每轮手术式清除旧工具结果（文件读/Shell/Grep），cached 走 API `cache_edits`、超时(>60min)走 `[Old tool result content cleared]` | 每轮 | `microCompact.ts` | ✅ 窗口内先裁剪工具噪声再摘要 |
| T2 API 上下文管理 | 服务端 `context_management` beta（`clear_tool_uses_20250919` / `clear_thinking_20251015`）移除旧工具结果与思考块 | 服务端 | `apiMicrocompact.ts` | ⚠️ 依赖 Anthropic API，VAT 本地不可直接用 |
| T3 会话记忆压缩 | **后台 fork agent 持续维护** `.claude/session-memory.md`，需压缩时摘要已存在→免额外 API 调用；前缀保留，向后扩展满足最小阈值(10K token / 5 text-block，上限 40K) | 自动首选 | `sessionMemoryCompact.ts` | ✅ **主动式(后台)压缩**，对齐 VAT Watcher daemon |
| T4 全量压缩(回退) | fork compact agent 跑 9 段固定 schema 摘要；`<analysis>` 草稿被 `formatCompactSummary()` 剥离；压后重注附件(≤5 文件/50K、skills 25K) | 手动/自动 | `compact.ts` `prompt.ts` | ✅ 9 段 schema 直接复用 |
| T5 PTL 截断(应急) | `truncateHeadForPTLRetry()` 丢最旧轮次组，保 ≥1 组，重试 ≤3 | API 413 | `autoCompact.ts` | ✅ 应急兜底 |

**关键常量（可移植）：**
- `AUTOCOMPACT_BUFFER_TOKENS = 13,000`（自动触发 = 有效窗口 − 13,000）
- `MANUAL_COMPACT_BUFFER_TOKENS = 3,000`（硬阻塞上限）
- `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20,000`
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（**连续 3 次失败→本会话永久禁用自动压缩**，即熔断）

**9 段固定摘要 schema（BASE_COMPACT_PROMPT）：**
1. Primary Request and Intent（用户显式意图）
2. Key Technical Concepts（技术/框架/模式）
3. Files and Code Sections（改动文件 + 代码片段）
4. Errors and Fixes（错误与修复）
5. Problem Solving（已解/进行中）
6. All User Messages（全部非工具用户消息，追踪意图漂移）
7. Pending Tasks（待办）
8. Current Work（压缩前精确进行态）
9. Optional Next Step（仅当贴合近期请求）

**预压缩钩子（PreCompact Hooks）：** 压缩前跑脚本导出关键状态到外部文件（如 `git diff --name-only`）。→ VAT 可映射为：压缩前把临界状态快照写入 `memory/<ROLE>/`，而非纯靠 LLM 蒸馏。

**主动式即时压缩（高级实践）：** 后台 daemon 监控软阈值(如 7,500 token)，用 prompt caching(ephemeral) 异步预生成摘要，硬限到达即零阻塞换入。→ VAT 的 `core/sub` Watcher 可承担此职责。

---

## 2. Codex 压缩机制（双路）

关键目录：`codex-rs/core/src/`（Rust）

| 路 | 机制 | 说明 |
|---|---|---|
| 远端(OpenAI provider) | `/responses/compact` 返回 `type=compaction item` + `encrypted_content` | 服务端压缩，客户端不透明，可中途触发 |
| 本地(非 OpenAI) | `templates/compact/prompt.md` 客户端 LLM 摘要 | "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary..." |

**本地压缩算法（`compact.rs`，可移植伪码）：**
```
on trigger(reason ∈ {user_requested, context_limit, model_downshift, comp_hash_changed}):
  history += [SUMMARIZATION_PROMPT]            # 9 行提示
  summary_suffix = last assistant message in compact turn
  summary_text   = SUMMARY_PREFIX + "\n" + summary_suffix
  retained = newest-first user messages, 跳过以 SUMMARY_PREFIX 开头的, 填充至 COMPACT_USER_MESSAGE_MAX_TOKENS(20,000)
  new_history = retained(chronological) + [CompactionSummary(summary_text)]   # 摘要放最后
  if mid-turn: 在最后真实用户消息前插入 build_initial_context(world_state)
  replace_history(new_history); advance_window(); recompute_tokens()
  警告: "long threads and multiple compactions reduce accuracy"
```

**Token-budget 压缩（`compact_token_budget.rs`，无模型调用）：**
```
new_history = build_initial_context(world_state) + retained developer messages (≤ RETAINED_MESSAGE_TOKEN_BUDGET = 64,000)
# 确定性回退，不调 LLM
```
→ VAT 的**廉价/失败回退路径**可直接用：LLM 摘要失败或低价值角色走确定性裁剪。

**关键常量（可移植）：**
- `COMPACT_USER_MESSAGE_MAX_TOKENS = 20,000`
- `RETAINED_MESSAGE_TOKEN_BUDGET = 64,000`
- `BASELINE_TOKENS = 12,000`（UI 预留，使 "%剩余" 反映用户可控空间）
- `effective_context_window_percent` 默认 `95%`

**已踩坑（必须规避）：** v0.54→v0.56 修复 "summaries of summaries"——重复压缩递归摘要 prior summaries 导致长会话质量退化。修复=干净模板避免递归累积。→ **VAT 压缩必须锚定原始上下文或保留滚动 raw 缓冲，绝不对 prior summary 再摘要**（印证 §4.4「保留 archive/ 原始转录」缓解项）。

**Prompt 缓存跨压缩保留：** 压缩后复用同一 `prompt_cache_key`(thread_id)，不重开会话→命中预热缓存。→ VAT 跨任务窗口可复用稳定前缀降本。

---

## 3. VAT 可直接采纳的 8 条（映射 §4.4）

| # | 采纳项 | 来源 | VAT 落点 |
|---|---|---|---|
| C1 | **分层压缩**：窗口内先 MicroCompact 裁工具噪声 → 再 LLM 结构化摘要 | Claude T1+T4 | `core/session/compact` 分两阶 |
| C2 | **固定 9 段 schema**（或 Codex 4 段 handoff）替代自由摘要 | 两家 | `memory/<ROLE>/` 写盘结构强制分段 |
| C3 | **主动式(后台)压缩**：Watcher 软阈值预生成，零阻塞换入 | Claude 高级实践 | `core/sub` daemon 兼任 |
| C4 | **压缩熔断**：连续 3 次失败禁用自动压缩本会话 | Claude T5 常量 | 并入现有 circuit_breaker |
| C5 | **预压缩钩子**：压缩前快照临界状态到 `memory/<ROLE>/` | Claude PreCompact | `in/` 钩子扩展 |
| C6 | **无模型 token-budget 回退**：确定性裁剪，不调 LLM | Codex | P 序列 P5 回退路径 |
| C7 | **禁递归摘要**：锚定原始或保留 raw 滚动缓冲 | Codex bugfix | 落实 archive/ 原始转录 |
| C8 | **缓存前缀跨窗口复用**降本 | Codex | 跨任务 context-seed 复用 |

---

## 4. 诚实边界（证伪条件）

- **服务端魔法扒不到**：Claude 的 `context_management` beta 与 Codex 远端 `encrypted_content` 依赖模型潜在理解，不透明。VAT 不依赖它们，故无损失；但若你想 100% 复刻"极致"，这部分永远在云端。
- **schema ≠ quality**：扒到 9 段提示词给的是**结构**，不是**质量**。摘要质量仍由调用模型决定——VAT 的"压缩质量自检"（seed 能否复现已知决策）仍是必要护栏，不可省。
- **许可**：Codex MIT 可自由复用；Claude Code Apache 2.0 可学习/复用（注意署名与 NOTICE）。直接抄代码需合规，学模式无碍。
- **触发阈值需按 VAT 模型重标定**：13,000 / 95% 等常量是 Anthropic/OpenAI 按自家模型定的，VAT 用 glm/PI/claude 混跑，应实测后设自己的 `AUTOCOMPACT_BUFFER`。

---

## 5. 建议落地（P 序列新增工作包）

- **P-compact（并入 P3 会话生命周期）**：实现 C1 分层 + C2 9 段 schema + C4 熔断 + C5 预压缩钩子。
- **P-compact-fallback（并入 P5 严格闸门旁）**：实现 C6 token-budget 无模型回退 + C7 禁递归（archive/ 原始转录）。
- **P-compact-proactive（并入 P2 订阅 Watcher）**：实现 C3 后台软阈值预压缩 + C8 缓存前缀复用。

> 优先级：P-compact > P-compact-fallback > P-compact-proactive。先有"结构化 + 熔断 + 不递归"的可靠压缩，再谈主动式与降本。
