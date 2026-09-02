# 17：Plan Mode 的持久姿态、步骤边界与人工评审

## 本课定位

Plan Mode 是会话级软引导：让 Agent 先探索和提交计划。它不禁用工具，也不替代本体计划、Guard、审批或沙箱。核心状态由日志重放，pending 也是从已记录命令/状态推导，不维护一份不可恢复 UI 内存真相。

## 学习目标

- 用 `plan/mode { active }` 全值事件持久状态；
- 在 idle 与开放 Turn 中正确安排变更提交点；
- 从投影推导 `{ active, pending }`；
- 实现 `/plan`、`/plan off` 和带消息/图片的进入；
- 让 `exit_plan_mode` 始终保持工具目录稳定；
- 通过一次交互 review 批准退出或继续规划；
- 明确软提示与硬权限边界。

## 状态提交

- 没有开放 Turn：set 可立即 append `plan/mode`；
- Turn 正在运行：选择保持 pending，直到下一个被接受的 in-turn pre-step，由 Agent Runtime 唯一追加；
- append 失败不能让内存状态假装已切换；
- 重复设置同值 no-op；
- 恢复/fork 从日志重建 active/pending；
- set/get 依赖 `plan` 和 turnBoundary projection，缺失时显式失败。

## Prompt 与工具

active 时注册/启用稳定 `plan:policy` section；inactive 时不贡献该文本。`exit_plan_mode` 始终注册，避免状态切换改变工具目录和 KV cache；inactive 调用按稳定错误处理。

Prompt 只指导“探索、设计、提交计划”，不能成为写权限。只读计划模式要通过 Permission Preset/Tool Guard 硬限制。

## `/plan` 命令

- `/plan`：请求 active；
- `/plan <message>`：请求 active，并把去空白文本作为普通 steer/input；
- 图片与该消息一同提交；
- `/plan off`：请求 inactive，不发送模型消息；
- `/plan off` 带图片必须在任何状态变化前拒绝，避免附件丢失；
- open Turn 中命令选择按 pending 边界生效。

## 评审退出

Agent 以 Markdown（从标题开始）调用 `exit_plan_mode`：

- 有交互 review：用户 `Approve` 或 `Keep planning` + 可选反馈；
- Approve 记录静默 pending exit，在下一个 accepted pre-step 提交；当前工具 batch 其余调用仍处于 plan policy；
- Keep planning 发送反馈继续；
- 关闭 review/转为普通发言时，通知 Agent 等待下一输入；
- 没有交互通道或服务 reload 时 fail-closed；`/plan off` 是人工退路。

## 实现任务

1. `plan/mode` event/invariant；
2. plan + turnBoundary projection；
3. PlanMode service set/get 和 pending commit；
4. scoped `plan:policy` section；
5. `/plan` command 的文本/图片分支；
6. `exit_plan_mode` tool + review seam；
7. Web/client projection；
8. resume/fork/compaction 测试。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| idle set/on/off/no-op | 事件和 projection 正确 |
| mid-Turn set | pending，下一 accepted pre-step 提交 |
| commit append 失败 | active 不伪改变，Turn 按合同继续 |
| `/plan message` + image | 模式选择和输入原子接纳 |
| `/plan off` + image | 状态变化前拒绝 |
| active/inactive assembly | section 有/无，工具目录稳定 |
| exit approve | pending exit，当前 batch 不提前失去 policy |
| keep planning/feedback | 仍 active，反馈进入 Agent |
| 无 review/reload/abort | 工具 fail-closed，无悬挂 question |
| resume/fork | active/pending 可由日志重建 |
| Guard | Plan Prompt 无法绕过写限制 |

## 源码复盘

- [`packages/plan/plan-mode/README.zh.md`](../deepseek-harness/packages/plan/plan-mode/README.zh.md)；
- [`packages/plan/plan-mode/src/index.ts`](../deepseek-harness/packages/plan/plan-mode/src/index.ts)、`types.ts`、`invariant.ts`；
- 计划模式命令、projection、review 和工具测试。

## 完成标准

- active/pending 完全由日志投影；
- mid-Turn 边界无竞态；
- exit tool 永久存在且评审 fail-closed；
- 图片命令分支无丢失；
- 明确 Plan Mode 是软引导。

## 复盘问题

1. 为什么批准退出不立即在当前工具 batch 生效？
2. 工具目录稳定对缓存和恢复有什么好处？
3. pending 为什么应该是投影而不是独立内存字段？
