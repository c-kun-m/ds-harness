# 子 Agent 模块

## 目标

实现可替换的 Subagent Provider、Spawn、Fork、一次性运行、可继续会话、层级所有权和控制工具。先完成同进程 Provider，再增加外部进程 Provider。

## 前置条件

完成 [后台 Job 模块](19-后台Job模块.md)。

## Provider 合同

`SubagentProvider` 声明 `outputSchema`、`depthLimit`、`toolFilter`、`persona` 和 `continuable` 能力。请求使用某能力而 Provider 不支持时，Service 在启动前拒绝，不能静默忽略。

一次性接口 `start(request)` 返回 `SubagentRun` 和终态 Result。可继续接口只让 Provider 准备新会话 seed；生命周期、后续消息、冷恢复和所有权由统一 `ContinuationManager` 管理，防止每个 Provider 发明一套继续语义。

## Spawn 与 Fork

- Spawn 创建空历史子 Session，继承工作目录、模型路由、Permission Preset 和允许的 Preset 策略。
- Fork 复制父 Session 到最近的闭合 Turn 边界，Header 记录 parentSession 和 seedLength。
- 两者都写持久 descriptor，记录 provider、mode、label、composition 和 delegationDepth。
- 默认最大深度为配置值；使用绝对深度而不是“剩余次数”，使重启后仍可验证。

## One-shot 与 Continuable

One-shot 默认前台等待，显式后台时注册 Job。Continuable 默认可以后台返回子 Session ID，后续 `send_message` 把内容作为下一条 FIFO Turn；它不返回该消息的独立结果，结果在子 Session 中查看。

## 控制语义

- `send_message` 只允许父 Agent 给直接 continuable child 发消息，不能进行 mid-turn steering。
- `interrupt_agent` 允许祖先中断后代当前 Turn，保留排队消息和子 Agent 身份，已发布后代继续运行。
- `list_agents` 分直接 children 和完整 descendants；列表是快照，实际操作再次鉴权。

## 手写顺序

1. 定义 Provider、Capability、Request、Result 和 lifecycle event。
2. 实现 Provider Registry 和能力预检。
3. 实现 lineage、depth、descriptor 和父子投影。
4. 实现 in-process Spawn。
5. 实现闭合 Turn Fork。
6. 实现 ContinuationManager、FIFO follow-up、冷恢复和 interrupt。
7. 实现 Subagent 工具、控制工具和 Job 后台桥接。
8. 最后实现 out-of-process Provider，并复用 SDK/ACP 协议。

## 安全和生命周期

子 Agent 工具过滤同时影响可见性和执行。子 Agent 继承的权限只能相同或更窄。父 Agent dispose 时取消并等待其拥有的 continuable 树；一次性外部进程必须经过 TERM/KILL 回收阶梯。Session lineage 只证明关系，不自动授予跨进程活跃所有权。

## 测试与完成标准

覆盖能力不支持、深度上限、Spawn 空历史、Fork 闭合前缀、前台结果、后台 ID、FIFO 消息、冷恢复、祖先中断、兄弟越权和递归清理。完成后父 Agent 同时启动两个 child，继续自身工作，再分别发送后续消息并查看各自独立日志。

## DSH 参考

- [Subagent 类型](../deepseek-harness/packages/subagent/subagent/src/types.ts)
- [Spawn Provider](../deepseek-harness/packages/subagent/subagent-spawn-in-process/README.md)
- [Fork Provider](../deepseek-harness/packages/subagent/subagent-fork-in-process/README.md)
- [控制工具](../deepseek-harness/packages/subagent/tool-subagent-control/README.md)
