# VAT 编排 Hub 与无状态 Harness 分层决策

> 回应: Grok 竞品分析建议"做成编排 Hub, 底层用 PI 这类现成无状态 agent harness"
> 日期: 2026-10-08 · 状态: **判定 = 采纳, 但边界收紧**

## 0. 结论 (先说判词)

**方向正确, 但命题要修正**: VAT **已经是**编排 Hub——信箱派发 / 状态机 / 卡点 / 账本 / 熔断全是 Hub 职责。真正的问题不是"要不要做成 Hub", 而是:

> **Hub 之下的"单角色会话执行层"要不要外包给 PI 这类无状态 harness?**

判定: **应该。且代码里 `RoleExecutor` 端口 (`packages/vat-core/src/types.ts:171`) 已天然预留插槽——这是一次换心手术, 不是重构。**

## 1. 分层判定 (谁做什么, 谁绝不做什么)

| 层 | 职责 | 归属 | 理由 |
|---|---|---|---|
| **有状态编排** | 信箱/状态机/卡点/账本/熔断/记忆归属/通知 | **VAT 自研, 不可外包** | 这是差异化本体: 文件系统即唯一事实源、审计账本、甲乙方治理。市面无现成品, 外包 = 自废武功 |
| **无状态会话执行** | 工具循环 / 会话内压缩 / 子任务 / sandbox | **外包给 PI** | 通用能力, PI (~49k★ MIT) 已磨好; 自研 = 重复造轮子且质量更差 |
| **记忆写回策略** | windowTokenLimit(256k) + compressTriggerPct → 写回 `memory/<role>/` 与 `tasks/<id>/docs/` | **VAT 所有** | 注意: PI 的 compaction 是"会话内上下文管理", VAT 的压缩是"跨会话长期记忆沉淀"——**两层不同, 都要**。PI compaction 可承接会话内那半 |

## 2. PI 能用 / 不能用清单

**能用 (harness 内部能力):**
- 单角色会话循环 (agentic loop + 工具调用: 文件/shell/编辑)
- 会话内 compaction (窗口内上下文爆炸的即期解法)
- 成熟工具生态与 sandbox

**不能用 (越界即自毁):**
- ❌ PI 的 team/chain/pipeline 多智能体编排 → 与 VAT Hub 职责重叠。用了 = 两套状态源, 审计账本与卡点全部失效。**硬约束: 适配器只 import PI 的 session/agent 层, 禁用其编排特性**
- ❌ PI 的持久记忆 → VAT 双级记忆 (角色级+任务级) 是权威; PI 内部记忆仅作会话内缓存, 不落 VAT 权威记忆
- ⚠️ PI 的 provider 层 → VAT 的按角色路由 (roleModels) + RPM 节流 + 冷却容灾必须保留。优先让 PI 会话走 VAT 的 `ModelClient` (待验证 PI 是否支持自定义 transport; 不支持则角色 harness 化延后)

## 3. 落地方案 (P1.5: 一个端口 + 一个适配器)

```
VAT Hub (有状态编排, 自研) ──RoleContext──▶ RoleExecutor 端口 (已存在)
                                            ├─ llm      现役零依赖信封执行器 (默认; draft/离线测试)
                                            ├─ scripted 剧本执行器 (测试/演示)
                                            └─ pi       新增 PiHarnessAdapter (P1.5)
ExecutorResult → Hub 校验 (validateRoleOutput) → VAT 文件系统落盘 (信任边界不变)
```

- **端口已存在, kind 联合类型加 `'pi'` 即可**, Hub 零改动
- PiHarnessAdapter 职责: RoleContext (角色章程 + 票据 + 记忆快照) → 组装 PI 会话初值 → PI 跑工具循环 → **末步强制产出 VAT 信封** → `validateRoleOutput` 校验 → 失败走现有修复重试
- **按角色启用**: DEV 先行 (最吃工具: 写文件/tsc/跑测试), PM/REVIEW 暂留 llm 执行器 (纯产出型, 工具收益低)。配置: `roleHarness: { DEV: 'pi' }`, 缺省 `llm`
- 依赖隔离: pi-mono 为 optional peerDependency + 懒加载; 未安装则该角色自动回退 llm 执行器

## 4. 成本对比 (颗粒度)

| 方案 | 工作量 | 质量 |
|---|---|---|
| 自研工具循环 + 会话压缩 (原 K 工具系列) | 5-8 人日 | sandbox/工具安全是深坑, 长尾无底 |
| PiHarnessAdapter | **1.5-2 人日** (端口 0.5 + 适配器 0.5-1 + 集成测试 0.5) | 直接到 PI 成熟度 |

净省 ~4-6 人日, 且把最深的坑 (工具安全) 转嫁给已验证的社区实现。

## 5. 风险与证伪条件

1. **结构化收敛失败** (概率中): PI 工具循环发散、不肯收口出信封 → **证伪信号: DEV 试点 10 个任务, 信封一次通过率 <60% → 回退 llm 执行器, 端口保留**
2. **PI API 快速变动** (概率高): 锁版本 + 适配器隔离层 <300 行, 升级成本可控
3. **双状态源** (设计错误, 一票否决): 误用 PI team/chain → 账本/卡点失效。代码评审红线
4. **模型路由冲突**: PI 不接受自定义 transport → roleModels/容灾链失效 → 延后该角色 harness 化, 等 PI 支持或自研 transport 桥
5. **离线可测性**: scripted 执行器永久保留, CI 不依赖 PI

## 6. 排期

- **P1 (当前)**: 记忆压缩双旋钮先做——它是 VAT 层的跨会话沉淀, 任何 harness 都替代不了, 与本决策正交
- **P1.5**: `AgentHarnessPort` (即 RoleExecutor 扩展) + `PiHarnessAdapter`, DEV 角色试点
- **推广判据**: DEV 试点 10 任务信封通过率 ≥60% 且工具事故 0 → 推广 QA/OPS; <60% → 回退, 端口保留待 PI 成熟
