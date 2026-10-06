# VAT · 下一步开发计划（v0.3 主线）

> 整合自 `docs/v0.3-plan.md`（版本 v0.3-plan2，2026-10-06）的未完成清单，按优先序重排。
> 总目标：**从「引擎正确」走向「真实可用」**（v0.3 主线）。
> 当前唯一硬卡点：DEV 轮真实产出未通过，根因是主力模型 `glm-5.3-flash` 强制深度思考、`content` 恒空、JSON 信封不产出 → **正确解法是用容灾链换模型，而非对抗思考习惯**。

---

## 〇 · 现状快照（已完成，不重复做）

- **v0.2 全里程碑**：M1 诚实内核 / M2 严格闸门（StrictRunner：真实 tsc+vitest+docker）/ M3 驾驶舱（本地 Web + SSE + 卡点裁决），**88 项测试全过**。
- **v0.3-V1 工程改造 100%**：ModelRouter 节流/冷却重试、`listModels` 三协议、openai-compat SSE 流式化 + 400 降级、输出解析加固（`<think>` 剥离 / 围栏提取 / 顶层对象跨度扫描 / repairJson）、LLM 提示词 maxTokens 8192→16384、CLI `.env` 加载 + `vat models` + `vat doctor`。
- **真实链路已验证**：`vat models`（23 模型）、`doctor --network`（全绿）、**PM 轮真实产出专业级 PRD**、**真实 token 记账（16,636 tokens）**、**记忆真实更新**、需求卡点全流程正确。

---

## 一 · 未完成项（按优先序）

| 序 | 来源 | 事项 | 状态 | 优先级 |
|---|---|---|---|---|
| T1 | #8 | 模型探测：中转候选模型 `content` 通道结构化输出测试，切换主力 | 📋 下一步首项 | **P0** |
| T2 | 卡点解 | 基于 T1 改 ModelRouter 默认主力 + 容灾链顺序 | 📋 依赖 T1 | **P0** |
| T3 | #7 | 真实 e2e 验收：draft 模式 PM→DEV→REVIEW→QA 至 done | ⏳ PM 过 / DEV 卡 | **P0** |
| T4 | #6 | 接入指南文档（`vat models`/`doctor` 用法、配置说明） | ⏳ 命令已交付 / 指南待写 | P1 |
| T5 | #9 | 上下文预算对齐（200k/256k 时代）：`summaryWarnChars` 4000→12000、`decisionWindow` 20→50、`lessonWindow` 30→80 | 📋 待办 | P1 |
| T6 | #10 | 跨进程运行锁（防两个 `vat run` 并发消费同一单据） | 📋 待办（已暴露隐患） | P1 |
| T7 | V2 | `cli-executor`：把 `claude`/`gemini`/`codex` CLI 包成 Role Executor | 📋 后续 | P2 |
| T8 | V3 | 记忆自动压缩 + Dashboard 增强（记忆查看器/单据全文/过滤） | 📋 后续 | P3 |
| T9 | V4 | 分发：`@vat/cli` npm 包 / 便携 zip；Tauri 壳可选 | 📋 后续 | P3 |
| T10 | 闭环 | 用 VAT 管 Yestar 项目，形成经业务验证的对外硬证据 | 📋 后续 | P2 |

---

## 二 · 分阶段开发计划

### Phase 0 — 解锁「真实可用」（P0，关键路径）

> 目标：换主力模型后，一句话需求 → 卡片 done，全链 `source:llm`。

**T1 · 模型探测脚本（P0，第一步）**
- 动作：对中转 23 个模型逐一实测——发送结构化 JSON 任务，判定输出是否走正常 `content` 通道且能产出完整 JSON 信封。
- 沉淀：固化到 `vat doctor --probe-models`（常驻能力，非一次性脚本）。
- 验收：输出每个模型的「content 通道可用 / 信封稳定 / 思考型」三维判定表。

**T2 · 切换主力模型（P0，依赖 T1）**
- 动作：将 ModelRouter 默认主力改为 T1 判定的「content 通道 + 信封稳定」模型；按可用性重排容灾链。
- 验收：`glm-5.3-flash` 从 DEV 主力移除（或降为末位容灾）；DEV 轮不再因思考流耗尽预算而丢失信封。

**T3 · 真实 e2e 验收（P0，依赖 T2）**
- 动作：draft 模式跑通 PM→DEV→REVIEW→QA 全链至 `done`。
- 验收：
  - 全链单据 `source: llm`；
  - 账本逐笔真实 `usage`；
  - 429 场景冷却后续跑不丢状态；
  - DEV 产出可被 StrictRunner 闸门（真实 tsc+vitest）接纳。

### Phase 1 — V1 收尾（P1）

**T4 · 接入指南文档**
- 动作：写 `docs/integration-guide.md` + README 接入段；覆盖 `.env` 配置、`vat models`/`vat doctor` 用法、模型切换说明。
- 验收：新人按文档可独立完成接入与模型探测。

**T5 · 上下文预算对齐**
- 动作：上调记忆注入默认值（`summaryWarnChars` 4000→12000、`decisionWindow` 20→50、`lessonWindow` 30→80），适配 200k/256k 上下文。
- 验收：长任务下记忆注入不触发过早截断告警，决策/教训召回率提升（可抽样比对）。

**T6 · 跨进程运行锁**
- 动作：在 Hub 调度入口加文件锁 / 单例标记，防两个 `vat run` 并发消费同一单据。
- 验收：并发启动两个 `vat run`，第二实例被拒绝或排队，无重复消费。

### Phase 2 — 演进路线（P2/P3）

**T7 · `cli-executor`（V2，核心价值）** ← VAT「编排真实 AGENT 能力具象化」的真正落地点
- 动作：章程角色声明 `engine: cli:<name>`；把 `claude`/`gemini`/`codex` CLI 包成 Role Executor（写临时 prompt 文件 → spawn → 解析产出），与 StrictRunner 闸门对接。
- 验收：同一卡片混编 `llm` + `cli` 引擎跑通；VAT 从「自己调 LLM」升级为「编排真实 coding agent」。

**T10 · 闭环验证（与 T7 并行）**
- 动作：用 VAT 管理 Yestar 分诊项目，产出经业务验证的交付物。
- 验收：形成可对外讲述的真实案例（替代 demo 叙事）。

**T8 · 记忆压缩 + Dashboard（V3）** / **T9 · 分发（V4）**：在 V1/V2 稳定后推进。

---

## 三 · 关键路径

```
Phase 0 (P0):  T1(探测模型) → T2(换主力) → T3(e2e验收)
                    │
Phase 1 (P1):  T4(文档)  T5(预算)  T6(锁)   ← 可与 Phase 0 末段并行
                    │
Phase 2 (P2):  T7(cli-executor) → T10(管Yestar闭环)
                    │
               T8(V3)  T9(V4)
```

**最短解锁链 = T1 → T2 → T3**，其余均不阻塞「真实可用」。

---

## 四 · 里程碑定义

- **M·V1-DONE**：T1–T3 完成 → 一句话需求到卡片 done 全链 `source:llm`，账本逐笔真实 usage，429 冷却续跑。
- **M·V1-FINISH**：T4–T6 完成 → 可文档化接入、长上下文稳定、并发安全。
- **M·V2-DONE**：T7 完成 → VAT 能编排真实 coding agent CLI。
- **M·CLOSED-LOOP**：T10 完成 → VAT 驱动真实业务项目交付。

---

## 五 · 风险登记（来自 v0.3-plan §五，持续跟踪）

1. **中转模型质量参差**：glm-5.3-flash 思考型行为已证实；T1 探测脚本将沉淀为 `vat doctor --probe-models` 常驻能力，定期复测。
2. **并发运行**：两个 `vat run` 可能同时消费同一单据（T6 解决）。
3. **提示注入**：XML 包裹 + 闸门白名单已缓解；真实运行后复查 `_dead/` 无注入痕迹（持续）。

---

## 六 · 建议的执行顺序（一句话）

**先花 1 个冲刺把 T1→T2→T3 打通（解锁真实可用），并行补 T4–T6 收尾，再上 T7 cli-executor 实现「编排真实 AGENT」的具象化，最后用 T10 闭环验证。**

> 注：本计划严格基于 `docs/v0.3-plan.md`（v0.3-plan2）的未完成清单与卡点分析整合，未增删原始待办项，仅做优先级重排与里程碑切分。
