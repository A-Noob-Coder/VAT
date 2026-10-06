# VAT 多智能体编排架构设计 —— 模型解耦 / 轻量 agent 二改 / 订阅唤起 / 自动 compact

> 版本：v0.3-orchestration-design
> 输入约束：glm-5.3-flash 强制深度思考、PI 类轻量 agent 二改、消息订阅式角色唤起、会话窗口阈值自动 compact
> 对齐基线：`mvp_0.2/docs/技术架构设计.md`（`<role>-docs/in/`、`memory/<ROLE>/` 三件套、`consumes` 订阅、`vat doctor --probe-models`、CLI 适配器）

---

## 0. 结论先行（逐问给答案）

1. **glm-5.3-flash 不是障碍，把"思考"和"输出契约"耦合在模型自格式化上才是 bug。** 任何角色都能用它，前提是在 Role Executor 与 StrictRunner 之间加一层**确定性抽取/格式化 Extractor**。
2. **PI（badlogic/pi-mono，~49k★）不是"缺团队角色的轻量 agent"——它已内置 team/chain/pipeline + compaction + skills。** 正确做法是把 PI 当 VAT 的**角色引擎**（落点 = 已规划的 C1 cli-executor / P6 适配器，扩为 `cli:pi`），VAT 在其上补"外部治理 + 文件邮箱 + 跨会话角色记忆"。
3. **并行开发可行：先冻结协议层（agent.md + ticket schema 单点 owner），再按目录归属切 7~8 个无冲突工作包。**
4. **消息订阅式唤起 + 阈值 compact：这就是正确的事件溯源式架构，docs 文件夹即邮箱即记忆。** 证伪点：单角色 task 速率 >~100/min 时文件系统成为瓶颈，需换消息队列（Redis Streams / NATS），协议不变只换 transport。

---

## 1. glm-5.3-flash 在团队里的正确用法

### 1.1 根因复盘（与既有结论不同调）

既有 `VAT_开发计划.md` 把 glm-5.3-flash 当作"待替换的问题模型"（#8 探测换模型）。这是**绕过问题而非解决问题**：它只对"中转 23 个候选里能找到更好的"成立。一旦用户**坚持**某角色用 glm-5.3-flash（你的提问前提），换模型的解法就失效。

真正的根因：StrictRunner 依赖模型**自格式化**输出 JSON 信封；glm-5.3-flash 是推理模型，倾向先深度思考再（往往不）给结构化输出 → 信封永不出现。**责任在管线设计，不在模型。**

### 1.2 三层解耦（推荐，且与现有 `vat doctor --probe-models` 互补）

| 层 | 职责 | 是否依赖模型自格式化 |
|---|---|---|
| 思考层 Brain | 推理模型（glm-5.3-flash）产出自省 / 计划 / 代码 | 否 |
| 抽取层 Extractor | 确定性解析：function-calling / `response_format=json_object` / grammar / 正则兜底 | **否（确定性）** |
| 契约层 Envelope | 包装成 StrictRunner 认的 `{role, intent, payload, artifact}` | 否 |

**铁律：永远不要让模型自我格式化。** Extractor 按优先级取以下任一：
- **function calling / tool use**（最稳）：让模型"调用" `emit_result(tool)`，参数即结构化信封，思考文本走 `reasoning_content` 旁路。
- **`response_format=json_object`**（API 支持时）。
- **grammar-constrained decode**（outlines / lm-format-enforcer）。
- **兜底**：cheap 模型或正则从推理文本抠 JSON（最次，但可用）。

`vat doctor --probe-models` 的角色从"选主力"升级为"**测每个模型的 Extractor 适配方式**"：输出矩阵 = `{model, 是否支持 function_calling, 是否支持 json_mode, 推理型?, 推荐角色}`。glm-5.3-flash 标注为"推理型，需 Extractor+function_calling"，**仍可用于任意角色**。

### 1.3 其他 agent 怎么用它

"其他 agent" 有两层含义，都回答：

- **团队内其他角色**：每个 Role Executor 内置同一套 Extractor，换模型不动管线。模型路由表决定哪个角色走推理模型：

  | 角色 | 模型路由 | 说明 |
  |---|---|---|
  | ARCH / DESIGN / DEBUG / REVIEW | glm-5.3-flash（推理型） | 走"思考 + Extractor"两阶段 |
  | DEV（常规）/ TRIVIAL / SCRIPTED | 快模型直出信封 | 省 token、低延迟 |
  | 用户强制 DEV 也用 glm | 允许，Extractor 照常 | 代价=token 成本+延迟↑，budget guard 兜底 |

- **外部轻量 agent（PI 类）被二改为角色后**：通过 §2 的 RoleWrapper 调用同一 Executor，因此"怎么用 glm"对它们是透明的——外壳统一处理 thinking→envelope。

> **证伪条件**：若 glm-5.3-flash 的 reasoning 输出把 JSON 严重包裹/转义，且**不支持** function_calling / json_mode，则必须加"formatter 二阶"（cheap 模型清洗）。此时该角色延迟翻倍——这是用推理模型跑执行角色的**隐藏税**，预算护栏会先爆。届时正确动作是把它从 DEV 移回 ARCH/REVIEW 类角色，而非硬扛。

---

## 2. PI（badlogic/pi-mono，~49k★，MIT，TS monorepo）作为 VAT 角色引擎

> 校正（2026-10-06 17:17）：用户指明 PI 是真实开源 Agent（非泛指的 Plan-Implement 轻量框架）。PI 已自带多智能体编排与 compaction，故原"缺团队角色"前提作废，下面改为"PI 作 VAT 角色引擎"的集成设计。

### 2.1 先纠正前提：PI 不"缺团队角色"

PI 是分层 Agent 运行时，其生态包 `agent-pi` 已内置多智能体编排：

- `pi-ai`：多 Provider 统一 LLM API（OpenAI / Anthropic / Google / Mistral / Bedrock）
- `pi-agent-core`：Agent Loop + Tool Calling + Session + **Compaction（上下文压缩）**
- `pi-coding-agent`：完整 coding agent（内置工具 / 会话持久化 / 可扩展）
- `agent-pi` 扩展：NORMAL / PLAN / SPEC / PIPELINE / **TEAM** / **CHAIN** 模式 + agent-team 派发 + agent-chain 顺序管道 + pipeline-team 混合 + **memory-cycle**（跨 compaction 的 memory 存/取）

→ 你原话"它们缺的是团队的角色"在 PI 上**不成立**：PI 已有 team/chain/pipeline 与 compaction。真正缺的，是 VAT 这一层才提供的**外部治理 + 事件溯源邮箱 + 跨会话角色记忆**。

### 2.2 正确集成路径：PI 作 Role Engine（落点 = 已规划的 C1 cli-executor / P6 适配器）

- **A. PI 作角色引擎（推荐）**：把 `pi-coding-agent` CLI（或程序化调 `pi-agent-core`）包成 VAT 的 `engine: cli:pi` 角色执行器，归入 `adapters/cli/`（即 P6 包，扩为 claude / gemini / codex / **pi**）。PI 给你：agent loop + 工具 + compaction + skills；VAT 给你：Hub 治理（熔断 / 预算 / 严格闸门）+ `<role>-docs/in/` 文件邮箱订阅 + `memory/<ROLE>/` 三件套跨会话记忆。这正落在你说的"编排真实 AGENT 具象化"（C1），且引擎比 claude/gemini/codex CLI 更厚（自带 loop / 工具 / 压缩）。
- **B. PI 作编排底座（不推荐，v0.3 不做）**：用 PI 的 TEAM/CHAIN 当 VAT 内部角色运行时，VAT Hub 退化为 PI 的薄壳。代价：PI 的 team 是**单进程内**派发（一个 Pi 会话里调子 agent），会丢掉 VAT 的"文件出现即激活独立角色会话 + 审计账本 + 跨角色熔断"优势。

### 2.3 PI 相对 VAT 真正缺的（= VAT 必须补的）

| 能力 | PI 现状 | VAT 补法 |
|---|---|---|
| 外部文件邮箱唤起 | 无（team 在会话内触发） | `<role>-docs/in/` + 单 Watcher daemon |
| Hub 级治理 | 仅 per-agent 工具守卫（security-guard） | 熔断 / 预算 / 严格闸门 / 账本 |
| 跨会话角色记忆 | compaction 是会话级 | `memory/<ROLE>/{summary,decisions,lessons}` + context-seed |
| 单据生命周期 | 无 | in/ → archive / _dead + 主程批准卡点 |

### 2.4 反对意见（不替你捂盖子）

- **版本 / 许可风险**：PI ~49k★ 极活跃（2026-05 仍在更），API 漂移快；`engine: cli:pi` 必须 pin 版本 + 用 `vat doctor` 复测适配。PI 改 CLI 接口则 Wrapper 即碎。
- **PI 的 team 模式已够用，是否与 VAT 重复？** 不重复：PI team = "一个 agent 调多个 specialist"；VAT = "多个独立角色会话由外部 Hub 按单据调度 + 治理"。层级不同，VAT 在 PI 之上。
- **过度依赖**：核心 DEV 引擎压在外部开源项目上，PI 停更 / 改协议即卡。缓解：`cli:pi` 与 `cli:claude/gemini/codex` 并列作容灾，VAT 的 envelope 契约不变。

---

## 3. 最小化并行拆解（无文件冲突）

### 3.1 切分原则

1. **协议层先于一切**：`agent.md` schema + `ticket` schema 单点 owner，冻结后再并行。共享契约=消息格式，不是共享代码。
2. **目录归属即所有权**：每个工作包独占子目录，无交叉写。
3. **跨包交互只过 `protocol/`，不共享可变文件** → 证明无冲突。

### 3.2 工作包（按优先级，可并行）

| # | 工作包 | 目录归属 | 依赖 | 冲突面 |
|---|---|---|---|---|
| P0 | 协议层：ticket + role manifest schema（含版本号） | `protocol/` | 无 | 无（先冻结，单人） |
| P1 | Role Executor harness + Extractor（解 glm 问题） | `core/executor/` | P0 | 无 |
| P2 | `<role>-docs/in/` 订阅唤起 Watcher（单 daemon 多角色） | `core/sub/` | P0 | 无 |
| P3 | 会话生命周期 + 阈值 auto-compact | `core/session/` | P0 | 无 |
| P4 | Hub 调度 + PM 下发（串接 P1~P3） | `core/hub/` | P1,P2,P3 | 无 |
| P5 | StrictRunner 门禁（tsc/vitest/docker） | `core/strict/` | P1 | 无 |
| P6 | CLI executor 适配器（claude/gemini/codex/**pi**） | `adapters/cli/` | P1 | 无 |
| P7 | 看板 / 可观测（events/ 消费） | `ui/` | P4 | 无 |

**并行顺序**：P0 单人做完（~1 天）→ P1~P3 三人并行（~3~5 天）→ P4 串接（~2 天）→ P5/P6/P7 并行收尾（~3~5 天）。

**无文件冲突证明**：每个包只写自己目录；P4 是唯一跨目录读者（读 `protocol/` 定义、写 `board/` 与 `events/`，但 `board/` 由 Hub 独占更新，符合既有"卡片状态 Hub 独占"规则）；其余包零交叉写。

> 颗粒度：P0 ≈ 1 文件 ~200 行；P1~P3 各 1~2 文件；P4~P7 各 1~3 文件；总计新增 ~1800~2800 行，可分 3~4 人 2~3 周交付 MVP 闭环。

---

## 4. 消息订阅式唤起 + 自动 compact 长期记忆

### 4.1 架构（事件溯源式，扩展既有 `in/→archive/` 机制）

```
PM/主程 ──写──> tickets/<ROLE>-docs/in/<ticketId>.json   (.tmp → rename .ready 原子写)
                        │  fs.watch / inotify / 轮询
                        ▼
                 Watcher Daemon  (单点，按 roleId 路由，避免进程爆炸)
                        │ 唤起
                        ▼
                 Role Session  状态机: idle → active → compact → idle
                        │ 处理，产物落 projects/ + deliverables/，单据移 archive/
                        ▼
                 窗口计数器  (tokens / messages / minutes，取最先达阈值者)
                        │ 达阈值 或 空闲 > N min
                        ▼
                 Auto-Compact: LLM 摘要 → memory/<ROLE>/{summary,decisions,lessons}.md
                              + 生成 context-seed.md 供下个会话冷启动
                        ▼
                 reset 窗口，回 idle
```

### 4.2 关键设计点（均建立在既有 `技术架构设计.md` 之上）

- **原子写**：task 先写 `.tmp` 再 `rename` 为 `.ready`，Watcher 只认 `.ready`，避免读到半截文件（修复"部分写入竞态"）。
- **单 Watcher 多角色**：不要每角色一个 watcher 进程（进程爆炸）；一个 daemon 按 `roleId` 路由到对应 session。
- **阈值可配**：DEBUG/ARCH 窗口大（~32k tokens），TRIVIAL 窗口小（~4k）；到阈值触发 compact，**未到但空闲 > N min 也 compact**（防挂起浪费上下文）。
- **docs 文件夹 = 邮箱 = 记忆**：`in/` 是事件日志，`archive/` 是已处理，`memory/` 是长期记忆，`projects/`+`deliverables/` 是产出。审计链天然完整（与既有 `events/hub-*.jsonl` 互补）。
- **compact 是蒸馏不是删除**：保留决策、接口契约、未决项；强制含 `constraints` 段（硬规则不丢），写入 `memory/` 并生成 `context-seed.md` 冷启动。

### 4.3 证伪 / 风险（推翻本架构的门槛）

- **文件系统瓶颈**：单角色 task 速率 >~100/min 时，轮询/fs.watch 丢事件、`rename` 竞争。届时换 Redis Streams / NATS —— **协议（ticket schema + roleId 路由）不变，只换 transport**。
- **compact 漂移**：摘要丢关键约束 → 角色"忘了"硬规则。缓解：compact 模板强制 `constraints` 段，且每次 compact 后跑一次 StrictRunner 自检。
- **唤起风暴**：PM 一次性下发 50 个 ticket 到同角色 → 建议**角色内单会话串行 + 跨角色并行**；同角色突发用队列 + 优先级（`consumes` 已支持按单据类型分流）。
- **多角色共享上下文**：若某任务需 ARCH→DEV→REVIEW 串联且上下文连续，纯文件订阅会丢中间态。缓解：ticket 内嵌 `threadId`，相关角色 compact 时把 `threadId` 摘要写入共享 `memory/threads/<threadId>.md`。

### 4.4 修正：隔离 + 压缩 双级记忆模型（per-task 会话窗 → 写回长期记忆）

此前 §4 把 auto-compact 画在"角色会话"层面。本修正收敛为**双级**模型，明确"窗口"是**每个任务一个**，且窗口的压缩产物**写回**长期记忆——隔离提供边界，压缩提供积累：

```
memory/<ROLE>/  长期记忆·跨任务·持久        ←─ 写回 ─┐
      ▲                                          │
      │ context-seed 冷启动                       │ Compact 蒸馏
      │                                          │ (summary/decisions/lessons)
      │                                          ▼
tasks/<id>/  会话窗  本次任务·有界·只装          [Compact]
              task/docs + 精简角色记忆
      │ 工作：最近对话 + 工具调用
      └──────── 达阈值 / 任务结束 ──────────────→
```

- **隔离（边界）**：每个任务 = 一个独立会话窗，只加载 `tasks/<id>/docs/` + 角色精简记忆（context-seed），**不把整个角色历史灌进一个窗口** → 窗口天然有界，不会爆。
- **压缩（积累）**：窗口满 / 任务结束 → Compact 蒸馏 → 写回 `memory/<ROLE>/`（跨任务经验）+ 更新 `tasks/<id>/docs/`（任务约束）→ 窗口 reset。**这是"独立员工有工龄积累"机制成立的硬前提**——PI 的 `--no-session` subagent 用完即焚、Codex 单窗持续压缩但无任务边界，都没做到"有界窗口 + 写回长期记忆"的合流。
- **反失真**：新开会话不再"重读原始文档"（易爆 + 重建失真），而是从**蒸馏后的高信号 seed** 冷启动 → 窗口小、失真低。

> **证伪（整套架构命门）**：若蒸馏丢关键 `constraints/decisions`，长期记忆腐烂 → 每次冷启动带病 → 员工越干越傻。缓解：compact 模板强制分段（constraints/decisions/lessons）+ 保留 `archive/` 原始转录可回滚 + 高价值角色加 human-in-loop 复核 + 加"压缩质量自检"（seed 能否复现已知决策）。

---

## 5. 一句话总结

glm-5.3-flash 可用（加 Extractor，不换模型也行）；**PI 作 VAT 角色引擎（`cli:pi` 适配器，落点 C1/P6）——它已自带 team/chain/pipeline + compaction，VAT 在其上补"治理 + 文件邮箱 + 跨会话角色记忆"**，而非"补团队角色"；并行开发先冻协议再按目录切 7 包零冲突；消息订阅 + 阈值 compact（双级：per-task 会话窗隔离 + 压缩写回角色长期记忆）是正确架构，文件系统在百 task/min 内够用、之上换 MQ——而这一切都建立在你已规划的 `mvp_0.2` 目录规范之上，不是另起炉灶。
