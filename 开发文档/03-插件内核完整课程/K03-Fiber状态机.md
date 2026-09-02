# K03：Fiber 状态机与可接纳工作边界

## 这一课解决什么

插件可能正在等待依赖、加载、活动、加载失败、卸载或已释放。若只使用 `active: boolean`，无法表达“正在卸载但清理还没完成”“加载失败但未来依赖变化可重试”“还未发布却已经有 owner”。竞态最终会变成一组互相矛盾的布尔值。

本课先实现状态机和等待语义，不运行完整 Effect setup；K04 接入。

## 状态模型

目标状态：

```text
PENDING ──依赖/配置就绪──> LOADING ──成功──> ACTIVE
   ▲                           │                 │
   │                           └─失败──> FAILED  │
   │                                      │      │
   └────────依赖恢复/重试──────────────────┘      │
                                                  │
ACTIVE/LOADING/FAILED ──dispose/reload──> UNLOADING
UNLOADING ──永久释放──> DISPOSED
UNLOADING ──需要重载且条件仍满足──> PENDING/LOADING
```

具体转移可与上游内部略有差别，但可观察语义必须明确。

## 每个状态允许什么

| 状态 | 可注册新 Effect | 可对外提供 Service | 可启动 apply | dispose 行为 |
|---|---:|---:|---:|---|
| PENDING | 仅内核自有准备项 | 否 | 条件满足后 | 进入卸载/终止 |
| LOADING | 允许当前 setup 所属 Effect | 否 | 已在进行 | 触发重入卸载屏障 |
| ACTIVE | 是 | 是 | 否 | 开始卸载 |
| FAILED | 仅诊断/重载所需 | 否 | 条件变化可重试 | 清理后终止/待重载 |
| UNLOADING | 否 | 清理期按服务合同受控可见 | 否 | 加入同一停稳事务 |
| DISPOSED | 否 | 否 | 否 | 幂等返回已完成事务 |

## 功能合同

- MUST：状态集合封闭，非法转移明确失败；
- MUST：状态变更按单一串行化点提交；
- MUST：观察者能获得 old/new/identity；
- MUST：等待接口能等待当前加载/卸载惯性；
- MUST：重复 dispose 加入同一卸载事务；
- MUST：DISPOSED 永不重新激活；需要 HMR 应创建/切换新世代；
- MUST：UNLOADING 不接纳用户新 Effect；
- SHOULD：FAILED 保留启动错误用于 await/reload 诊断。

## 你先做的设计题

1. `dispose()` 在 LOADING 中被调用，状态先变 UNLOADING 还是等 setup 完成？外部何时能看到？
2. `awaitActive()` 遇到 FAILED 应拒绝还是等待未来重试？是否需要两个 API？
3. 状态 listener 抛错是否回滚状态？
4. reload 与永久 dispose 如何共享卸载机制但产生不同下一状态？

## 实现任务

1. 定义 FiberId/uid 和状态；
2. 建立合法转移表，而不是任意 setter；
3. 实现状态观察事件，observer 失败隔离；
4. 实现 startup/unload inertia 的等待接口；
5. 实现幂等 dispose 骨架，暂时没有真实 Effect；
6. 保存最近启动错误；
7. 写状态图对应的表驱动测试。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 正常加载 | PENDING→LOADING→ACTIVE |
| 加载失败 | LOADING→FAILED，await 暴露 cause |
| ACTIVE dispose | ACTIVE→UNLOADING→DISPOSED |
| LOADING 中 dispose | 不发布 ACTIVE，最终 DISPOSED |
| FAILED 后依赖恢复 | 按重试合同重新 LOADING |
| 重复/并发 dispose | 一次状态序列，一个停稳 Promise |
| DISPOSED 后操作 | 稳定拒绝或幂等，无复活 |
| 非法转移 | 内核错误且原状态不变 |
| 状态 observer 抛错 | 状态仍提交，其余 observer 仍收到 |
| observer 内重入 dispose | 无递归破坏，最终稳定 |

## 源码复盘

- [`vendor/cordis/src/fiber.ts`](../../deepseek-harness/vendor/cordis/src/fiber.ts) 的 `State`、`Fiber` 字段、`_refresh/_reload/_unload/await`；
- [`docs/cordis-api/fiber.zh.md`](../../deepseek-harness/docs/cordis-api/fiber.zh.md)；
- Cordis 生命周期教程。

观察 `_runner.epoch`、`store/inertia` 和 uid 如何共同表达“当前世代”。

## 完成标准

- 表驱动测试覆盖所有合法/非法转移；
- LOADING 中卸载不会短暂发布 ACTIVE；
- observer 异常不破坏内部状态；
- 重复 dispose 的 Promise 语义明确。

## 复盘问题

1. FAILED 为什么不是 DISPOSED？
2. 状态、epoch 和 uid 分别表达什么？
3. “状态已变 DISPOSED”和“完全停稳”为什么可能有时间差，如何避免对外暴露差异？
