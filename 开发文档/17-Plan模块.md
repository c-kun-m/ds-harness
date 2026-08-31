# Plan 模块

## 目标

实现会话级 Plan Mode，支持用户要求 Agent 先调研和提交计划。Plan Mode 是协作状态和 Prompt 指导，不是本体 Action DAG，也不能替代权限、审批和 Guard。

## 前置条件

完成 [Todo 模块](16-Todo模块.md)。

## 状态和事件

`plan/mode { active }` 是整值替换事件。Service 暴露 `get(agent)` 和 `set(agent, active)`；Agent 正在运行时，选择排入下一次 pre-step，空闲时立即写日志。UI 同时展示已提交状态和 pending 选择。

## 模型行为

active 时加入稳定 Plan Policy section：只读调研、记录假设、列出 API/数据流/失败/测试和验收，最后调用 `exit_plan_mode`。`exit_plan_mode` 始终在工具目录中，非 active 调用返回错误；active 调用通过用户问题服务提交审阅。

## 硬限制

如果产品要求 Plan Mode 不写文件，必须由 Permission Preset 或工具 Guard 限制写工具。不能因为 Prompt 写着“不要修改”就把它当安全保证。

## 手写顺序

1. 写状态投影和空闲/运行中切换语义。
2. 写 active Prompt section。
3. 写 `/plan`、`/plan off` 命令或等价 RPC。
4. 写 `exit_plan_mode` 和一次性用户审阅。
5. 写 Web pending 状态和计划审阅卡。

## 测试与完成标准

覆盖空闲切换、mid-turn 切换、取消 pending、恢复、Fork 继承、Spawn 默认 inactive、审阅批准/拒绝/关闭，以及软指导不能绕过 Guard。完成后 active 状态跨重启保持一致。

## DSH 参考

- [Plan Mode](../deepseek-harness/packages/plan/plan-mode/README.md)
