# Watcher 守护 · 文件邮箱订阅式唤起

> 对应开发清单: K04 (跨进程锁) / K05 (Watcher 选举+订阅唤起) / K08 (任务级 docs 钩子) / v0.3-plan #8 + #10

## 背景

v0.2 的流水线由人工 `vat run` 驱动——适合演示, 但不满足"甲乙方自主交付"的诉求:
**需求投进去后, 角色应能随单据到达自动被唤起, 无需人守着终端敲命令。**

这一节把"文件邮箱订阅 + 自动唤起"落地为一个守护进程原语, 且**完全不改动 Hub 的
单据消费/归档逻辑**——Watcher 只负责"触发 + 选主 + 去重", Hub 继续做它该做的事。

## 三个新原语

### 1. 跨进程 LeaderLock (`src/lock.ts`)
- `<root>/.vat-watch-lock` 写入 `{pid, ts, host}` 心跳记录。
- `acquire()` 仅在锁不存在 / 持有者 PID 已死 / 心跳过期(stale, 默认 30s) 时夺取。
- `renew()` leader 续约; `recheck()` 被他人夺取则自动降级为 follower。
- 解决 v0.3-plan #10 实测暴露的隐患: 两个 `vat run` / `vat watch` 不会并发消费同一单据。

### 2. Watcher (`src/watcher/index.ts`)
- 轮询 `tickets/<ROLE>-docs/in/*.md` (与 Hub `scanInbox` 一致读取 `.md`)。
- 仅 leader 进程对"新出现且未见过的单据"调用 `dispatch(roleId, file)`。
- `dispatch` 由 CLI 注入 (默认 = `hub.run()`), 故 Watcher 与具体编排逻辑解耦。
- 进程内 `seen` 集合去重; 跨进程去重靠 LeaderLock 保证只有一个 leader 在驱动。
- 单测覆盖: leader 触发+去重 / follower 不触发 / roles 过滤。

### 3. 任务级 docs 钩子 (`WorkspacePaths.taskDocsDir`)
- 建卡时即 `mkdir tasks/<CARD_ID>/docs/` (K08 任务级记忆地基)。
- 与既有角色级 `memory/<ROLE>/` 构成两级记忆: 角色级=跨任务工龄经验, 任务级=本项目约束。
- 后续 P1 的压缩/蒸馏/冷启动将读写该目录。

## 用法

```bash
# 启动守护 (单 leader, 其余实例自动转 follower)
vat watch
# 监听 tickets/*-docs/in/*.md, 自动唤起 hub.run()

# 体检并拿到推荐 modelChain (v0.3 #8 / K01 换主力)
vat doctor --network
# 输出: 建议 modelChain (可用优先): [claude, gpt, glm]
#       → 把以上顺序写入 vat.config.json 的 modelChain 即可换主力模型
```

## 与"甲乙方自主交付"架构的关系

- **消息订阅唤起**: PM 写 `tickets/<ROLE>-docs/in/<id>.md` → Watcher 唤起角色会话 (§产品形态定义 八章)。
- **单 PM 入口**: 外部只与 PM 交互, PM 经 Hub 路由到各角色, Watcher 只负责"有信到了就叫人"。
- **可接管**: 一切在文件系统, `vat watch` 挂了直接 `vat run` 兜底 (两者共用 Hub, 互不冲突)。

## 已知边界 (诚实标注)

- 当前监听 `.md` 而非 `.ready`; 原子 `tmp→rename .ready` 协议是后续加固项 (避免大单据半写被扫到)。
- 轮询间隔默认 1s, 非实时 (满足异步长程工作流, 不满足交互式实时)。
- Watcher 异常不退出 (守护语义), 但 dispatch 失败会 console.error 并继续。
