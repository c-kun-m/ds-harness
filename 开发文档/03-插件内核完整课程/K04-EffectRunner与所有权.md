# K04：EffectRunner、多形态 Effect 与创建所有权

## 这一课解决什么

用户插件的 setup 可能同步返回、异步返回、逐项 yield disposer，甚至在 setup 内触发卸载。如果先执行 setup 再登记清理，重入时 owner 找不到半成品；如果 Promise 拒绝后不回滚，插件会泄漏；如果 async generator 在旧世代卸载后继续 yield，会把清理注册到错误实例。

本课把 K01 和 K03 组合成真正的 EffectRunner。

## 支持的 Effect 形态

setup 的结果至少支持：

- `void | null | undefined`；
- 单个 disposer；
- `Iterable<disposer>`；
- `Promise<disposer | void>`；
- `AsyncIterable<disposer>`。

无效返回值必须明确 TypeError/内核错误，不能静默忽略。

## 核心时序

```text
调用 effect(setup)
  → 检查 Fiber 可接纳
  → 创建 effect record
  → 先把 owner wrapper 登记到 Fiber
  → 记录当前 epoch
  → 调用 setup
      → 收集同步/异步 disposer
      → 若失败，逆序回滚已收集项
  → setup barrier 结算
  → 返回公开单次 disposer（必要时 thenable/awaitable）
```

先登记 owner wrapper 是本课最重要的不变量。

## 功能合同

- MUST：setup 前 owner 已能发现并清理该 Effect；
- MUST：同步 setup 抛错时回滚已收集 disposer 并移除 owner；
- MUST：异步 setup 拒绝时执行相同回滚并观察清理错误；
- MUST：无效返回值失败并回滚；
- MUST：Iterable/AsyncIterable 每个已产出 disposer 都归该 Effect；
- MUST：epoch 变化后 AsyncIterable 不再接纳新 disposer，并请求 iterator 结束；
- MUST：UNLOADING/DISPOSED 拒绝新 Effect；
- MUST：公开 disposer 单次有效，并等待 setup barrier 后再完成清理；
- MUST：一个 Effect 内清理逆序串行。

## 你先做的设计题

1. owner wrapper 已登记但 setup 尚未返回 disposer，此时卸载怎样等待？
2. async generator 已 yield A，随后 Fiber 卸载，之后又 yield B：A/B 分别怎么办？
3. setup 同步抛错，同时 A 的回滚也失败，向调用者报告什么？
4. 为什么 public disposer 可能需要是 thenable，而不只是 `() => Promise<void>`？你是否需要完全复刻这个 API 形状？

## 实现任务

1. 定义 EffectRecord：owner、epoch、state、collected disposers、setup barrier、cleanup transaction；
2. 在执行 setup 前把 wrapper 放入 Fiber 的 owner collection；
3. 规范化所有支持的返回形态；
4. 实现同步/异步失败回滚；
5. 实现 async iterator 取消/return 和 stale epoch 防护；
6. 实现公开 disposer 的幂等与等待；
7. 为 Effect 添加可选 label/children 元数据，供后续诊断，不影响执行身份。

## 测试矩阵

| 编号 | 场景 | 必须观察到 |
|---|---|---|
| E-01 | void/null | 正常注册、卸载无清理 |
| E-02 | 单 disposer | 卸载执行一次 |
| E-03 | iterable A/B/C | C/B/A |
| E-04 | promise disposer | dispose 等 setup，再执行 disposer |
| E-05 | async iterable | 已 yield 项逆序清理 |
| E-06 | 同步 setup 抛错 | 已收集项回滚，owner 无残留 |
| E-07 | async setup reject | 回滚完成后拒绝，无 unhandled rejection |
| E-08 | 无效返回值 | 稳定错误 + 回滚 |
| E-09 | setup 内重入 owner dispose | 不漏清理，最终停稳 |
| E-10 | unloading 时注册 | INACTIVE_EFFECT，无 setup 副作用 |
| E-11 | async generator 跨 epoch yield | 旧世代不接纳新项 |
| E-12 | public disposer 与 owner dispose 并发 | 每项一次，双方等待同一清理 |
| E-13 | 回滚项失败 | 其余项继续，主因保留 |

## 源码复盘

重点读 [`vendor/cordis/src/fiber.ts`](../../deepseek-harness/vendor/cordis/src/fiber.ts)：

- Effect wrapper 登记顺序；
- result 规范化；
- `effectInertia`/运行中清理加入；
- setup barrier；
- 同步与异步失败路径；
- generator/async generator 的收集；
- epoch 检查。

再读 [`vendor/README.md`](../../deepseek-harness/vendor/README.md)，理解这些加固解决过哪些真实重入漏洞。

## 完成标准

- E-01 至 E-13 全部通过；
- setup 内重入卸载测试是确定性的，不靠 sleep；
- 主失败与清理失败都可诊断；
- stale async generator 不污染新世代；
- 差异账本明确是否复刻 thenable disposer 的 API 形状。

## 复盘问题

1. “先拥有，再执行”如何消除重入窗口？
2. setup barrier 和 cleanup inertia 有什么区别？
3. 为什么 async generator 必须绑定 epoch？
