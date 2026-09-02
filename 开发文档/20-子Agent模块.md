# 20：Subagent Provider、发布所有权与可继续子级

## 本课定位

Subagent seam 在一个服务下容纳多个具名 provider：进程内 spawn/fork、ACP、SDK、Codex、Claude Code 等。一次性运行和可继续子级是两种不同所有权模型；Provider 必须显式声明能力，不能静默忽略请求覆盖。

## 学习目标

- 建立 provider registry/capability preflight；
- 让 `start()` 只有在真实子 Agent 已存在并发布后才兑现；
- 区分 one-shot run ownership 与 continuable persistent Session/Activation；
- 记录版本化 descriptor、lineage、depth 和精确路由；
- 实现相邻 parent/child 消息、冷恢复、中断和发现；
- 在启动、发布、取消、provider unload 和 parent teardown 中完全停稳；
- 将权限/工具范围在创建时固定，子 Agent 内不能自行加宽。

## Provider Registry

Provider 以唯一 name 注册，声明支持：one-shot/continuable、agentOptions（provider/model/reasoning/maxTokens）、structured output、seed/fork、附件等。Service 在任何资源创建前比较请求与能力；不支持即稳定失败。

provider registration 是 Effect：卸载阻止新 start，但已接受并发布的 run 由调用者拥有，不被 provider disposer 随意撤销。

## One-shot

请求经能力校验、descriptor snapshot、provider setup。`start()` 的发布边界：

- 发布前 provider 拥有所有资源，失败必须回滚停稳；
- 成功兑现后调用方拥有 SubagentRun；
- Run 提供 child identity、result Promise、dispose；
- result 含最终 assistant output、可选结构化值、stop reason 和安全诊断；
- result 失败按合同兑现/拒绝，不丢 stop reason；
- dispose 取消剩余工作并等待 child Session/Scope/Agent 完全拆除。

进程内 driver 从父路由/创建选项解析子路由，应用 persona/tool restrictions/structured output 后再发布。结构化输出只在权威最终工具结果成功后提交；捕获后单调 Guard 阻止后续工具；缺必需值的正常结束视为 error，不自动重提示。

## Spawn 与 Fork

- Spawn：新 Session，无父对话 seed，但记录 lineage/depth/cwd；
- Fork：seed 是父会话稳定完成 Turn 前缀，并记录 inherited cut；读取 child 自有最终输出时排除 seed；
- child depth = parent depth + 1，使用绝对 maxDepth，恢复后仍可验证；
- descriptor 写入 child 日志，不进入模型历史；
- descriptor 固定 provider/mode/route，用于 continuable 冷恢复。

权限不能在子会话内加宽。若复刻 DSH 进程内驱动器，注意它创建新的扁平组合 Scope，不自动继承父级每个临时工具限制；它把明确的沙箱覆盖与 `approval: never` 固定到 delegated child，并通过 runtime context 告知权限范围不可加宽。本项目若选择“全部继承且只能收窄”，必须写差异和相应安全测试。

## Continuable

可继续 child 有持久 Session identity，同一时刻至多一个进程内 Activation：

- manager 预留 child id/descriptor；
- 创建或冷恢复 Session/Agent；
- 安装 Activation 后提交 prompt；
- 完成一次 Turn 后 child 可保持可继续 identity；
- direct parent 后续可发送消息；没有 Activation 时 direct child 可冷恢复；
- Activation 结算向在线 direct parent 追加一次 runtime 通知。

## 消息与控制

`sendMessage(sender,target)` 使用精确在线 Agent：sender 可发给 direct continuable child；只有驻留 continuable child 可发给自己的 direct parent。忙 target 使用 steer 到最近 Step，idle target 启动新 Turn。Host/browser queue 是独立认证路径。

Parent 可中断活动后代（具体授权层级要固定）；中断当前工作不销毁 child identity。取消收敛期间到达的消息可能排队直到下一唤醒，这个边界需要测试/文档。

`listChildren`/descendant tree 从在线 Session + 可选 persistence 读取，不为发现而加载/恢复 child。快照含 mode、active、lineage；执行操作时重新鉴权。

## 交付限制

- 跨进程 continuable 需要持久 mailbox + lease，核心当前不提供；
- parent offline 时 child→parent 无持久 mailbox，拒绝而非假装接纳；
- crash 可能丢失已接受但未写入 child Session 的 prompt；
- ACP child 可按 provider 只支持 one-shot；
- lifecycle observer 不能获得 run disposal capability。

## 实现任务

1. Provider/Capabilities/Request/Result/Run types；
2. registry + preflight + scoped registration；
3. descriptor/lineage/depth/fold/invariant；
4. in-process one-shot driver + publication transaction；
5. Spawn/Fork seed；
6. structured output runtime；
7. ContinuationManager/Activation/cold restore；
8. adjacent messaging/interrupt/list discovery；
9. permission/tool composition policy；
10. model tools/control surface；
11. out-of-process providers 后置。

## 测试矩阵

| 场景 | 必须观察到 |
|---|---|
| provider/capability 不支持 | 创建前失败，无 child |
| setup/publish 失败 | 所有未发布资源停稳 |
| start 成功后 provider unload | 已发布 run 按 owner 合同继续/可 dispose |
| Spawn/Fork | 空/稳定 seed，lineage/cut/depth 正确 |
| maxDepth | 恢复后仍拒绝超限 |
| structured output 正常/缺失/后续调用 | 提交点和 Guard 正确 |
| one-shot cancel/dispose | result 收敛，Session/Agent/Scope 移除 |
| continuable FIFO/cold restore | identity 不变，消息顺序正确 |
| busy/idle sendMessage | steer/新 Turn 语义正确 |
| 非相邻/兄弟/离线 parent | 授权拒绝 |
| interrupt | 当前工作停，child identity/队列按合同保留 |
| list discovery | 不激活冷 child，快照与操作二次鉴权 |
| parent teardown | 拥有的 Activation/child tree 停稳 |
| 权限加宽尝试 | fail-closed，delegation context 可见 |

## 源码复盘

- [`packages/subagent/subagent/README.zh.md`](../deepseek-harness/packages/subagent/subagent/README.zh.md) 与 [`src`](../deepseek-harness/packages/subagent/subagent/src)；
- [`packages/subagent/subagent-in-process-driver/README.zh.md`](../deepseek-harness/packages/subagent/subagent-in-process-driver/README.zh.md)；
- [`subagent-spawn-in-process`](../deepseek-harness/packages/subagent/subagent-spawn-in-process)、[`subagent-fork-in-process`](../deepseek-harness/packages/subagent/subagent-fork-in-process)；
- tool-subagent/control 和各外部 provider README/tests。

## 完成标准

- 发布前/后 owner 边界可由故障测试证明；
- Spawn/Fork/one-shot/continuable 行为分开；
- 消息只能走授权相邻关系；
- 权限不能从 child 内加宽；
- teardown 无 Activation、listener、Session owner 或进程残留。

## 复盘问题

1. Provider registration disposer 为什么不能直接取消已发布 Run？
2. persistent child identity 与 resident Activation 有什么区别？
3. lineage 为什么不是授权证明？
