# 后台 Job 模块

## 目标

为 Shell、一次性子 Agent、导出和长时间业务调用提供统一的后台任务身份、输出、等待和取消能力。

## 前置条件

完成 [Goal 与自动续跑](18-Goal与自动续跑.md)。

## Job 接口

- `start(spec)`：在完成预检后一次性启动 Producer。
- `get(id, caller)`、`list(caller)`：返回不可变快照。
- `read(id, caller)`：读取增量或终态输出。
- `wait(id, timeout, caller, signal)`：等待终态或超时快照。
- `kill(id, caller, reason)`：请求取消，先调用 Producer，再转 stopping。
- `onChanged`、`onDone`：通知 UI 和 Agent。

## 状态

`queued → running → stopping → completed | failed | cancelled`。settlement first-wins；一个 Job 只有一个终态。Job 记录 owner Session ID，调用者只能读取和取消自己拥有的 Job；可预测 ID 不能成为越权入口。

## 输出

流式 Job 使用有界 ring buffer 和 cursor；终态结果幂等可读。超过限制的输出写 Spill Store。Producer 的原始敏感日志不直接进入模型，工具结果只提供状态、摘要和引用。

## 手写顺序

1. 实现 Job ID、状态机、Registry 和 owner 校验。
2. 实现 waiters、done/changed listeners 和 first-wins settlement。
3. 实现输出缓冲、Spill 和 cursor。
4. 实现取消、owner dispose 和 Runtime shutdown 排空。
5. 注册 `job_list`、`job_output`、`job_kill` 工具。

## 测试与完成标准

覆盖并发 settlement、取消失败、等待超时、调用者越权、owner 销毁、输出溢出和通知异常隔离。完成后把一个长 `sleep + output` 假任务放后台，能查询、增量读取、取消并在 Session 中收到终态通知。

## DSH 参考

- [Job Registry](../deepseek-harness/packages/jobs/jobs/README.md)
- [本地 Job 实现](../deepseek-harness/packages/jobs/jobs-local/README.md)
