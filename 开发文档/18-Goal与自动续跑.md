# Goal 与自动续跑

## 目标

让一个 Session 保存一个长期目标，并在用户授权后自动启动有限轮次的同 Session 工作。Goal 状态和自动调度必须拆成两个组件。

## 前置条件

完成 [Plan 模块](17-Plan模块.md)。

## GoalService

Goal 状态包含 ID、revision、objective、phase、blocker、maxRounds、roundsStarted、createdAt 和 updatedAt。支持 create、edit、pause、resume、complete、block 和 clear。所有 mutation 写 `goal/change` 完整快照并使用 CAS。

GoalService 只拥有状态。进程重启、Session resume 和 Fork 后，active phase 可以保留，但自动续跑授权必须默认 disarmed，防止恢复后无人工确认继续产生副作用。

## GoalRoundDriver

Driver 监听 Goal 变化和 Agent idle。active + armed + 有剩余轮次时，先 flush Goal mutation，再排入一条带轮次信息的 followup。只有该消息真正进入 Step 才增加 roundsStarted。人类输入优先于自动轮次。

## 终止和异常

- complete、pause、block、clear 和达到轮次上限都会 disarm。
- 用户取消有 Goal 工作的 Turn 时自动 pause，避免马上重新启动。
- 模型或持久化异常不做无限自动重试；需要显式 resume。
- 模型自己报告完成仍是提议，关键领域目标应由本体后置条件或独立 evaluator 认证。

## 手写顺序

1. 实现 Goal 事件、投影和 CAS Service。
2. 实现进程内 armed 状态，明确不持久化。
3. 实现 idle 监听和轮次预约。
4. 实现 flush 后二次检查，处理状态变化竞争。
5. 实现 Goal 工具和用户命令。
6. 接入可选本体 completion evaluator。

## 测试与完成标准

覆盖生命周期、过期 revision、轮次上限、人类消息抢占、flush 失败、取消、重启 disarm 和 evaluator 拒绝完成。完成后设置两轮 Goal，Agent 自动运行两次并在上限停下；重启不会自行继续。

## DSH 参考

- [Goal 状态](../deepseek-harness/packages/goal/goal/README.md)
- [Goal Round Driver](../deepseek-harness/packages/goal/goal-round-driver/README.md)
