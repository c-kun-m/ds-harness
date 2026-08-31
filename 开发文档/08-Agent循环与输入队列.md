# Agent 循环与输入队列

## 目标

实现单 Agent 的 Turn/Step 状态机、统一输入箱、取消和模型—工具循环。此模块只编排既有服务，不包含业务工具、本体规则或产品 UI。

## 前置条件

完成 [工具注册与执行管线](07-工具注册与执行管线.md)。

## Agent 接口

- `followup(message)`：进入 `next-turn` FIFO 并唤醒 Agent。
- `steer(message)`：进入 `next-step` FIFO 并唤醒 Agent。
- `inject(message)`：进入 `next-step` FIFO，但不唤醒空闲 Agent。
- `cancel(cause, { keepInbox })`：取消当前 Turn；子 Agent 控制以后使用 `keepInbox: true`。
- `status`：idle、running、disposing、disposed。
- `waitForIdle(signal?)`：等待整个 Agent 静止，不承诺某个 Prompt 的因果结果。

## 状态机

1. followup 唤醒空闲 Agent，追加 `turn/start`。
2. 原子领取全部 next-step 输入和一条 next-turn 输入。
3. 组装提示词和工具，执行 `agent/pre-step`。
4. pre-step 拒绝时以 blocked 结束；首批输入被改写为空时以 completed 零 Step 结束。
5. 追加 `step/start` 和进入本 Step 的 `user/message`。
6. 构造冻结模型请求并消费流。
7. 没有工具调用则 Step 和 Turn 完成。
8. 有工具调用则执行工具；工具结果或 steer/inject 使循环进入下一个 Step。
9. 结束前派发 `agent/turn-stopping`，最后总是追加 `turn/end`。

## 手写顺序

1. 实现两个队列和带 Message ID 的 splice/claim 操作。
2. 实现 Agent Registry，保证同一 Session ID 只有一个活 Agent。
3. 实现 idle/running 状态和单一 driver promise，防止重复唤醒启动两个循环。
4. 实现 Turn 和 Step，所有 finally 路径补齐 end 事件。
5. 接入 Prompt Assembly、LlmRegistry 和 ToolRuntime。
6. 实现请求失败的有限重试；同一 Step 重试必须复用冻结 assembly。
7. 实现取消：停止启动新工具，等待已启动工具收敛，未启动调用写入 aborted 结果。
8. 实现 create/resume 的发布事务；Setup 完成前 Agent 不进入公共 Registry。

## 关键不变量

- 一个 Agent 同时最多运行一个 Turn，一个 Turn 同时最多运行一个模型请求。
- followup 不改变当前 Turn；steer 只影响当前 Turn 的下一 Step。
- claim 后输入从队列移除；拒绝不会悄悄重新排队。
- Agent 发布前 Setup 失败必须回滚 Session、作用域和所有插件。
- Agent dispose 先停止和排空，再卸载子作用域，最后从 Registry 移除。

## 测试

- 无工具、单工具、多 Step、多并行工具路径。
- followup、steer、inject 在 idle 和 running 下的不同语义。
- 首步空输入、pre-step 拒绝、max-tokens、模型错误和用户取消。
- 同时唤醒、取消与新消息竞争、dispose 与创建竞争。
- 所有结束路径都有闭合 Turn/Step 日志。

## 完成标准

脚本化模型依次请求 `read_text` 和 `echo`，Runtime 执行两个工具并返回最终文本；并发发送 steer 后，下一 Step 能看到它，Session 重放得到完全相同的模型历史。

## DSH 参考

- [Agent Loop 实现](../deepseek-harness/packages/core/agent-loop/src/agent.ts)
- [Agent Loop 合同](../deepseek-harness/packages/core/agent-loop/README.md)
- [生命周期图](../deepseek-harness/docs/agent-lifecycle.md)
