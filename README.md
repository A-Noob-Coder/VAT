# VAT MVP v0.2

单人研发效率工具:以真实 git 工作区为唯一事实源的虚拟团队编排引擎 (Hub + 单据协议 + 分级执行)。

- 技术架构设计:[docs/技术架构设计.md](./docs/技术架构设计.md)(v0.2-draft2,主程裁决已合入)
- 上游文档:`../VAT (Vibe Coding Agent Team) 虚拟团队编排引擎 · 产品需求文档 (PRD).md`
- v0.1 原型(仅作概念参考,代码不复用):`../vat-—-vibe-coding-agent-team/`

## 关键决策(详见架构设计 §13)

- **交互**:CLI 为主 + 本地 Dashboard(只读投影 + 卡点裁决)
- **分发**:v0.2 以 npm 包分发;桌面安装包(Tauri 壳)v0.3+ 再做
- **模型接入**:协议适配层(OpenAI 兼容 chat/completions、Anthropic messages、Gemini),填 baseUrl+Key 即插即用;记忆压缩阈值随模型接入配置
- **编制**:PM / DEV / REVIEW / QA / OPS 五角色默认在编,SEC/ARCH 等按需招聘

## 状态

- [x] 技术架构设计 v0.2-draft2
- [x] **M1 诚实内核**(已完成)
  - 真实落盘工作区:章程/单据/卡片/记忆/账本/事件流全部是文件,单据位置即状态(in/=待处理、archive/=已处理、_dead/=死信、_held/=卡点暂扣)
  - Hub 强制治理:状态机转移矩阵硬校验、3 次合计打回熔断(仅冻结该卡)、日/单卡 token 预算、需求批准卡点
  - 真实 token 账本(逐笔 JSONL,scripted 不计费)、追加式事件流
  - 崩溃恢复:任意时刻 kill 后重启即从目录重扫续跑(有测试覆盖)
  - ScriptedExecutor 确定性演练(游标状态持久化,跨进程保持进度)
- [x] **M2 严格闸门**(已完成,60 个测试全通过)
  - StrictRunner 白名单闸门:脚手架 → 依赖安装(--ignore-scripts)→ `tsc --noEmit` → `vitest run` → docker build(可选),全部带超时与输出截断;LLM 永远拿不到 shell
  - DEV 提审闸门:未过真实编译/测试 → defect 单打回 DEV,进入自修环(默认 ≤2 次,不占打回计数);自修环耗尽后每次失败转正式打回(进入熔断计数)
  - QA 验收闸门:QA 追加的测试文件真实执行,失败即真实打回并阻断签发
  - 测试报告来自真实运行输出(用例数/通过数/失败数 + 失败详情),作为 source: strict-runner 交付物归档
  - 工具链自动发现(复用 VAT 自带 tsc/vitest),`vat doctor` 检查工具链与 docker

- [x] **M3 驾驶舱**(已完成,66 个测试全通过)
  - `vat dashboard` 启动本地驾驶舱(仅绑 127.0.0.1)
  - Vite+React 单页,Quiet Luxury 视觉(黑曜石/古铜金/发丝分割/衬线混排)
  - 看板(六列 + 冻结/卡点徽章)、卡片详情(交付物按 source 徽章标注)、事件流(SSE 实时滚动)、账本(日预算进度条)
  - 写操作经 Hub 校验:卡点批准/驳回、熔断裁决恢复、快速提单;Dashboard 永不直接写工作区文件
  - 事件流 SSE 尾部跟随 + state_dirty 自动刷新(终端推进流水线,页面实时更新)

## 快速上手

```bash
npm install && npm run build          # 构建 monorepo
node packages/vat-cli/dist/cli.js --help

# 试试演练模式(无需 API Key)
mkdir /tmp/vat-demo && cd /tmp/vat-demo
node <repo>/packages/vat-cli/dist/cli.js init
cp <repo>/scenarios/golden-path.yaml scenarios/
node <repo>/packages/vat-cli/dist/cli.js req "实现令牌桶限流中间件"
node <repo>/packages/vat-cli/dist/cli.js run --mode simulation   # → 卡点暂停 (exit 2)
node <repo>/packages/vat-cli/dist/cli.js approve CARD-0001 --stage requirement_approval --note ok
node <repo>/packages/vat-cli/dist/cli.js run --mode simulation   # → done
node <repo>/packages/vat-cli/dist/cli.js board

# 试试 strict 严格模式(无需 API Key,代码真实过 tsc/vitest 闸门)
node <repo>/packages/vat-cli/dist/cli.js req "实现令牌桶限流中间件 (strict)"
node <repo>/packages/vat-cli/dist/cli.js run --mode simulation   # → 卡点
node <repo>/packages/vat-cli/dist/cli.js approve CARD-0001 --stage requirement_approval --note ok
node <repo>/packages/vat-cli/dist/cli.js run --mode strict --scenario scenarios/strict-demo.yaml
# 闸门报告在 deliverables/CARD-0001/ (source: strict-runner), 真实工程在 projects/CARD-0001/

# 试试驾驶舱 (M3): 另开一个终端
node <repo>/packages/vat-cli/dist/cli.js dashboard --port 4600
# 浏览器打开 http://127.0.0.1:4600 — 看板/事件流/账本实时投影, 卡点与熔断可直接裁决

# 接真实模型 (draft 模式): 编辑 vat.config.json 填 provider,
# 设置对应 apiKeyEnv 环境变量后 vat run --mode draft
```

## 测试

```bash
npm test        # 66 个测试: 状态机表驱动 / 单据协议 / 熔断 / 卡点 / 预算 / 死信 / 崩溃恢复 /
                # 真实账本 / StrictRunner 单测 / 真实 tsc+vitest 集成 / Hub 闸门编排 / Dashboard 服务
```
