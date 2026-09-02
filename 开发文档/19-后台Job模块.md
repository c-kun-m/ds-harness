# 19：后台 Job Registry、所有者隔离与终态通知

## 本课定位

Jobs seam 让长时间工作在 Agent 继续运行时保持活动，并可读取输出、等待、取消和接收完成通知。抽象约定与进程本地实现分包；只加载抽象服务不能启动工作。

## 学习目标

- 建立稳定 `<kind>-N` identity 和按 owner Session 的授权；
- 在启动 producer 前完成控制器/策略预检；
- 用 running/stopping/completed/killed/failed 封闭状态；
- 实现单消费流游标、等待与 first-wins settlement；
- 记录终态后再释放 waiters，最后隔离通知 listener；
- owner/service dispose 取消并等待活动工作；
- 将大输出限制/Spill 与 Job 核心分开。

## 抽象合同

### Start

生产方提交 kind、label、owner Agent、可选 byte limit 和 `run(hooks)`。在调用 run 前预检：kind/label/limits、owner 可见 controller、重复/容量/准入。任何预检失败不分配公开 job id、不启动 producer。

拥有者必须已有 controller（例如 tool-jobs）才能 start，避免创建 Agent 永远无法读取/停止的工作。无 owner Job 可按合同全局可见，并存活到 service dispose。

### 访问

- get/list：非消费 immutable snapshot；
- read：推进该 Job 唯一输出游标；
- wait(timeout/signal)：终态或超时 snapshot，不改变状态；
- kill：在修改为 stopping 前调用 producer cancel，取消失败如何分类要稳定；
- snapshots 每次新复制，不借出可变内部值。

Job id 可预测，所以 owner check 是授权边界，不是保密。

### 状态和结算

```text
running → stopping → killed
running/stopping → completed | failed
```

终态 first-wins。一次结算顺序：提交唯一终态 record → 释放所有 waiters/可见变化 → 隔离通知 listeners。完成最后宣布，因为 listener 可能同步唤醒 Agent，新 Turn 必须看到已提交终态。

### 生命周期

provider/producer fiber 卸载不默认撤销已经接受并转移所有权的 Job；owner/session/service dispose 请求取消并等待守约 producer。cancel/dispose 抛错时仍要形成 failed/killed 记录并继续排空，不能永久卡 registry。

## 输出

核心 seam 固定上游只有单消费流游标；独立观察者若需要各自 cursor 是未来扩展。每次完整模型输出/通知有 byte limit；大内容写 12 的 Spill，snapshot 只含有界 tail/summary/reference。敏感 producer 日志不直接模型可见。

## 实现任务

1. JobKindMap/Id/Start/Hooks/Snapshot types；
2. 抽象 JobRegistry 和 provider registration；
3. owner/controller/effect scoped attach；
4. local registry、id allocator、state/settlement；
5. output buffer/single read cursor/byte limit；
6. get/list/read/wait/kill；
7. owner/service teardown；
8. listener notification ordering；
9. job_list/job_output/job_kill consumer；
10. Spill 接入。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 无 controller start | producer 不运行、无公开 id |
| 正常完成/失败/kill | 唯一终态和时间戳合法 |
| 并发完成/kill/fail | first-wins，其余不覆盖 |
| owner/兄弟 Agent | 只有 owner 可见/可控 |
| no-owner Job | 按全局合同可见并随 service 释放 |
| read 两次 | 单游标只返回新增输出 |
| wait timeout/cancel | 返回超时/取消，不改变 Job 终态 |
| cancel hook 抛错 | 形成可诊断终态，不悬挂 |
| listener 抛错 | 其余 listener 和终态不受影响 |
| listener 内启动 Agent work | 已能读取 committed terminal |
| owner dispose | 活动 Job 取消并完全停稳 |
| 输出超限 | 有界 snapshot + Spill，无内存无界增长 |
| 旧 controller disposer | 不移除新 controller |

## 源码复盘

- [`packages/jobs/jobs/README.zh.md`](../deepseek-harness/packages/jobs/jobs/README.zh.md) 与 `src/index/types/brand/invariant`；
- [`packages/jobs/jobs-local/README.zh.md`](../deepseek-harness/packages/jobs/jobs-local/README.zh.md)；
- [`packages/jobs/tool-jobs/README.zh.md`](../deepseek-harness/packages/jobs/tool-jobs/README.zh.md)。

## 完成标准

- owner 授权不能被可预测 id 绕过；
- start 预检无幽灵 Job；
- 结算/通知顺序有重入测试；
- owner/service dispose 后无 producer/waiter/listener；
- 明确当前 Job 不跨进程重启持久恢复。

## 复盘问题

1. 为什么 controller 可用性是 start 前置条件？
2. 完成通知为什么必须最后发？
3. 单消费流游标限制会影响哪些 UI/多观察者场景？
