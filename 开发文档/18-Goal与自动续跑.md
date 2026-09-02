# 18：持久 Goal 状态、进程内授权与 Goal Round Driver

## 本课定位

每个 Agent Session 最多一个当前 Goal。Goal service 只拥有持久状态；Round Driver 独立调度同 Session 自动续行。`armed/disarmed` 是进程本地授权，resume/fork/restart 后默认 disarmed，防止恢复即自动产生副作用。

## Goal 领域合同

### 持久状态

- identity、revision、objective；
- phase：active/paused/blocked/complete；
- roundsStarted、maxGoalRounds；
- blocker（blocked 时稳定 lower-kebab code + 人类说明）；
- created/updated 时间；
- clear 使用带 revision tombstone；
- 默认上限可配置（固定上游默认 256），create 可覆盖且必须正安全整数。

### 操作

create、edit、pause、resume、complete、block、clear。所有变更携带精确 `{ id, revision }` CAS；旧 view 拒绝。pause/complete/block/clear disarm；resume 只在有剩余 Round 时接受并清 blocker。

完成 Goal 可被新 Goal 替代；未完成 Goal 需要显式 edit/状态处理/clear，不静默覆盖。

### 持久与非持久

`goal/change` 携带变更后完整 snapshot；Goal/phase/revision/rounds 持久。Activation armed/disarmed 只在进程缓存；每次 session-start/resume/fork 新边界都 disarm，显式 resume 才重新授权。

严格 fold 拒绝 revision 不连续、非法 phase、时间倒退（可 clamp 策略）、Round 不连续和畸形 tombstone。第一次 fold 失败后 service fail-closed。

## Goal Round Driver

调度条件：Agent idle + Goal active + armed + 有容量。Driver 没有自己的 maxRounds 配置，避免策略重复。

```text
goal changed/agent idle
→ reserve { goalId, revision, round = roundsStarted + 1 }
→ flush Session durability obligation
→ recheck goal revision/activation/capacity and competing human input
→ enqueue reserved <goal_round> message
→ agent/pre-step before/after downstream revalidate claim
→ 只有 goal-source user/message 真正进入 Step 才计 roundsStarted
```

预留本身不消耗 Round；陈旧预留丢弃。人类工作在预留前/准入前到达时优先，自动工作让行。

## 停止与异常

- phase 非 active、disarmed、容量耗尽时不续行；
- 上限耗尽记录稳定 `round-limit` blocker；
- max-tokens、flush/provider error、cancel、plugin unload 停止，不隐式重试；
- 与 Goal Round 相关的取消暂停/disarm，防止 idle 后立刻复活；
- unload 关闭准入、disarm、取消在途并等待 driver/Agent 停稳；
- 已在卸载开始前被 Inbox 接纳的 Round 可能消耗一次，必须记录这项边界。

Goal 完成默认由调用方/模型决定；关键本体 Goal 应增加独立 evaluator/14–15 后置条件认证，而不是修改基础 Goal service。

## 实现任务

1. GoalId/Error/Snapshot/View/Ref；
2. strict fold、event、tombstone、projection；
3. GoalService CAS 和 activation cache；
4. lifecycle session-start disarm；
5. Driver reserve/flush/recheck/claim guard；
6. 固定 goal-round prompt 和 message source；
7. 轮次上限/blocker/异常停用；
8. Goal tools/commands；
9. 可选本体 completion evaluator。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| create/edit/lifecycle/clear | revision 与合法转移正确 |
| stale ref | 不覆盖新状态 |
| resume/fork/restart | Goal 持久但 activation disarmed |
| reserve 后 human input | 自动 Round 让行且不计数 |
| flush 失败/等待中 revision 改变 | 不排入陈旧 Round |
| pre-step downstream 替换/拒绝 | 完整 claim 再验证，未准入不计数 |
| Round message 准入 | 正数连续 roundsStarted |
| 上限 | block round-limit，不超预算 |
| cancel/max-tokens/provider error | disarm/停止，无自动重试 |
| teardown | 无新 Round，在途停稳 |
| forged goal message/prompt | invariant 拒绝 |
| evaluator 拒绝 complete | 基础状态与领域认证边界明确 |

## 源码复盘

- [`packages/goal/goal/README.zh.md`](../deepseek-harness/packages/goal/goal/README.zh.md) 及 `src/domain/fold/runtime/index/invariant`；
- [`packages/goal/goal-round-driver/README.zh.md`](../deepseek-harness/packages/goal/goal-round-driver/README.zh.md) 及 `src/index/prompt/invariant`；
- [`packages/goal/tool-goal`](../deepseek-harness/packages/goal/tool-goal)。

## 完成标准

- 状态与调度包/职责分离；
- resume 默认不自动继续；
- reserve/claim/revision 竞争测试通过；
- 只有真正准入的 Goal message 计 Round；
- 所有异常停止均无无限自动重试。

## 复盘问题

1. 为什么 armed 不持久化？
2. 预留和准入分开如何防止浪费 Round？
3. Goal phase 与 Agent status 为什么不能合成一个状态机？
