# 08：Agent 句柄、输入准入与 Turn/Step 循环

## 本课定位

Agent 包拥有公共句柄、Registry、Inbox 和事件词汇；Agent Loop 是可替换的具体驱动器。不要把两者做成一个不可测试大类。创建 Agent 是事务，发布后的唯一 Handle 是拆除能力。

## 学习目标

- 区分 Agent public surface 与 loop driver；
- 实现 followup/steer/inject 的不同唤醒和边界语义；
- 实现 claim/splice 的可恢复 Inbox 投影；
- 建立一次一个 Turn、一次一个模型请求的驱动器；
- 用 pre-step、request-error、turn-stopping 扩展循环；
- 将工具 body 并发与结果 commit 结合；
- 正确创建、发布、取消、排空和拆除 Agent/Session/Scope。

## Agent 公共合同

### 输入

- `followup`：普通下一 Turn 工作，FIFO，并唤醒 idle Agent；
- `steer`：面向当前/下一 Step 的输入，唤醒 driver；
- `inject`：加入下一可接受 Step 的上下文，但不唤醒 idle Agent；
- 每条消息有 MessageId 和恰好一个 source；
- 领取候选后才到达的消息留到后续边界，不混入已冻结 batch。

### 取消与等待

- `cancel(cause)` 中止活动 Turn，默认清空待处理 inbox；
- `keepInbox: true` 只中止当前活动并保留排队工作；
- `whenIdle` 等整个 Agent 无活动 Turn/Step/request/tool commit；它不承诺某条 prompt 的因果结果；
- dispose 后拒绝新输入。

### Registry/Handle

创建者获得 AgentHandle；只有 handle/结构 owner 能拆除。Registry 查询返回裸 Agent，不返回 dispose 能力。同 Session/Agent id 的并发创建需要原子占位。

## Pre-step 准入

候选输入经 `agent/pre-step` 得到：

- reject；或
- enter：完整、冻结、带身份的消息 batch，可标记 `startsRequestSeries`。

claim 后被拒绝的消息不悄悄重新排队。监听器包装下游决定时要保留完整 batch 与 request-series 标志，除非有意替换。

## Turn/Step 状态机

```text
idle + accepted followup/steer
→ turn/start
→ claim candidate input
→ pre-step
→ step/start + accepted messages
→ assemble system prompt/tools/runtime context
→ request/header
→ LLM stream + assistant message
→ no tool calls: step/end → turn-stopping → turn/end
→ tool calls: bounded execution/ordered commit → step/end → next step
```

每条 finally 路径都闭合已打开的 Step/Turn。max tokens、blocked、aborted、provider error 和 persistence error 是不同 end reason。

## Request error

模型请求失败通过 `agent/request-error` waterfall 决定 retry/replace/fail。重试必须复用同一冻结 assembly/request envelope；工具或插件 middleware 错误可以关闭当前 Turn，但不自动永久销毁 Agent。

## 工具调用阶段

- 先记录/解析模型 tool calls；
- 预策略与分类按模型序；
- parallel-safe body 有界重叠，exclusive 形成屏障；
- policy/result commit 按模型序；
- cancel 之后不启动未分发 body，合成 ABORTED_BEFORE_DISPATCH；
- 已启动 body 等待停稳；
- 所有 result commit 后才能开始下一 Step。

## 创建事务

```text
创建私有 Session + Scope + Agent 对象
→ setup(agentCtx) 安装 scoped tools/prompt/listeners
→ 启动 driver 所需内部资源
→ 注册/announce Session 与 Agent
→ 返回唯一 AgentHandle
```

setup、Session publish、Agent announce 任一步失败都回滚。销毁顺序：停止新准入 → cancel/drain loop → dispose Scope → detach Agent → detach Session。确切顺序要与 Registry 可见性测试一致。

## Initiator Scope

用 AsyncLocalStorage 归因同进程异步工作；它不是授权或存活证明。worker/process/wire 必须显式传 identity。teardown 要拒绝新 initiator boundary 并排空已进入的 Promise。

## 实现任务

1. Inbox 事件/投影和 claim/splice；
2. Agent public interface、status 和 Registry/Handle；
3. 单一 driver promise/wakeup；
4. Turn/Step loop 与 end-finally；
5. pre-step/request-error/turn-stopping；
6. SystemPrompt + LLM + ToolRuntime 接线；
7. cancel/keepInbox/whenIdle；
8. create/resume transaction；
9. initiator scope 与 teardown；
10. 全路径 invariant。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 无工具/单工具/多 Step | 日志和最终输出闭合 |
| running 时 followup | 不进入当前 Turn，留给下一 Turn |
| idle/running steer | 按 next-step 合同进入并唤醒 |
| idle inject | 不唤醒，下一请求可见 |
| pre-step reject/replace | claim 不回滚，日志有确定结果 |
| 同时多次 wake | 只有一个 driver/Turn |
| request retry | 同一冻结 assembly，有限次数 |
| max tokens/provider error | 正确 end reason，不伪完成 |
| cancel 各阶段 | 未启动合成、已启动收敛、Turn 闭合 |
| keepInbox | 当前取消后排队输入仍可继续 |
| create setup/publish 失败 | Session/Scope/Agent 全回滚 |
| dispose 与消息竞争 | 新准入关闭，已接收工作停稳 |
| initiator 并行链 | 身份不串线，teardown 后不可新建 |
| resume 中断日志 | 先由恢复层配平，再开始新 Turn |

## 源码复盘

- [`packages/core/agent/README.zh.md`](../deepseek-harness/packages/core/agent/README.zh.md) 与 [`src`](../deepseek-harness/packages/core/agent/src)；
- [`packages/core/agent-loop/README.zh.md`](../deepseek-harness/packages/core/agent-loop/README.zh.md)；
- [`agent.ts`](../deepseek-harness/packages/core/agent-loop/src/agent.ts)、[`tool-calls.ts`](../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts)、`runtime-context/invariant`；
- [`docs/agent-lifecycle.zh.md`](../deepseek-harness/docs/agent-lifecycle.zh.md)；
- [`packages/core/agent-loop/tests`](../deepseek-harness/packages/core/agent-loop/tests)。

## 完成标准

- scripted model + tools 完成多 Step；
- 输入边界和取消竞争有确定性测试；
- 所有结束路径日志配平；
- setup/announce 故障注入无残留；
- AgentHandle 是唯一拆除能力；
- whenIdle/dispose 真正表示停稳。

## 复盘问题

1. followup、steer、inject 为什么不能合并成 `sendMessage` 一个操作？
2. Agent 包与 Loop 包分离带来什么可替换性？
3. 为什么 claim 后 reject 不应自动重新排队？
