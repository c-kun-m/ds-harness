# 21：Workflow Run 合同、脚本编排与 Worker 引擎

## 本课定位

Workflow 运行模型/用户提供的临时 JavaScript 编排：扇出 one-shot subagent、parallel、pipeline、phase、log，最终返回一个 JSON 值。它不是持久 DAG：进程崩溃不能恢复中间脚本状态，领域关键流程仍用 15。

## 学习目标

- 将 Workflow seam 与具体 Worker engine 分开；
- 在 run 创建前校验 script/meta/limits；
- 让活动 Run 由调用者持有并负责 dispose；
- 让 result 永不拒绝，运行失败通过 stopReason/error 兑现；
- 区分 fatal contract/infrastructure error 与普通 child failure；
- 用 paired observation events 展示进度，不泄露取消能力；
- 在取消/超时/Worker crash 时有界排空所有 child。

## Workflow Service

`ctx.workflowEngine.start({ script, meta, args?, parent, signal? })`：

- meta/args 是普通 lossless JSON，不作为代码插值；
- script 是纯 JavaScript body，支持顶层 await，最终 `return JsonValue`；
- 解析、meta 违规、不支持的限制在 Run 存在前拒绝；
- 成功返回 WorkflowRun：id/meta/result/cancel/dispose；
- result Promise 永不拒绝，兑现 `{ stopReason, result, agentsStarted, error? }`；
- dispose 必要时 cancel，并在有界宽限期等待脚本与 child 停稳。

一个 Context 只允许一个 engine provider；第二个 provider 加载失败。Engine provider unload 阻止新 start，但调用者仍拥有已接受 Run，必须 dispose。

## 脚本 API

- `agent(prompt, opts)`：启动 one-shot child；成功返回最终文本/结构值，普通 child 非完成可返回 null；
- `parallel(tasks)`：有界并行，结果按输入序；
- `pipeline(items, stages)`：每 item 顺序过 stages，不同 item 有界重叠；
- `phase(title)`、`log(message)`：只观察、有大小限制；
- 不提供嵌套 `workflow()`；
- 没有 return 时结果 null。

脚本/钩子错误分两类：拼错参数、超限、不可序列化、provider/bridge 故障等 `WorkflowError(fatal=true)` 终止整个脚本，parallel/pipeline 不吞；普通 child stop/failure 作为 null 由脚本处理。

## Worker 隔离

当前引擎可用 Worker Thread：只暴露 RPC hooks，不提供 require/import/process/fs/net/eval/Function。仍然不要把 Worker 当恶意代码安全边界；真正不可信脚本需要独立进程/容器、CPU/内存/网络强隔离。

限制至少包括 wall deadline、最大并发 child、总 child starts、parallel/pipeline items、script/meta/args/result/log bytes、Worker memory。到限额关闭新工作、取消并排空已开始 child。

## 事件

`workflow/start/end` 配对；phase/log；`agent-start/end` 按 seq 配对。Payload 是 immutable identity snapshot，不含活动 Run handle。每个 observer 独立拿副本；抛错只记录，不影响执行和其他 observer。

基础 Workflow 事件可以作为 runtime observation；若写 Session，需要明确它不等于脚本 checkpoint，不能声称可恢复。

## 实现任务

1. Workflow types/Error/Run/Engine seam；
2. preflight parser/meta/limits；
3. paired event/invariant + listener isolation；
4. Worker RPC/runtime bootstrap；
5. agent bridge/Subagent ownership；
6. parallel/pipeline bounded scheduler；
7. cancellation/deadline/crash/dispose；
8. value serialization/size limits；
9. workflow model tool result envelope；
10. 与 15 的边界说明。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| parse/meta 失败 | start 拒绝，无 Run/Worker |
| return/missing return | JSON 值/null |
| child success/failure | 值/null，普通失败不杀脚本 |
| fatal hook misuse | stopReason error，result 不拒绝 |
| parallel/pipeline | 并发有界、结果输入序 |
| structured child output | schema 成功/失败语义正确 |
| 超 item/start/log/result 限制 | fatal、有界、无后续启动 |
| signal/cancel/timeout | stopReason cancelled/error 按合同，child 停稳 |
| Worker crash/hang | 有界终止，不悬挂 result |
| dispose 并发/result 已完成 | 幂等，资源一次释放 |
| observer 抛错/篡改 payload | 不影响执行/同级 observer |
| engine unload | 阻止新 Run，不窃取旧 Run owner |

## 源码复盘

- [`packages/workflow/workflow/README.zh.md`](../deepseek-harness/packages/workflow/workflow/README.zh.md) 与 `src/index/types/runtime-types/invariant`；
- [`packages/workflow/workflow-worker-thread/README.zh.md`](../deepseek-harness/packages/workflow/workflow-worker-thread/README.zh.md)；
- [`packages/workflow/tool-workflow/README.zh.md`](../deepseek-harness/packages/workflow/tool-workflow/README.zh.md)；
- Workflow/Worker 的配额、取消、fatal 与结果测试。

## 完成标准

- result 永不拒绝，preflight 与运行失败边界清楚；
- 所有 Run 由调用方 dispose 且有泄漏测试；
- Worker 限制和 child 排空有故障测试；
- observer 只观察；
- 文档明确不持久恢复、不嵌套、无 token 总预算。

## 复盘问题

1. 为什么 start preflight 失败与 Run result error 要分开？
2. 普通 child failure 为什么返回 null，而 hook contract error 必须 fatal？
3. Worker Thread 能隔离哪些故障，不能隔离哪些攻击？
