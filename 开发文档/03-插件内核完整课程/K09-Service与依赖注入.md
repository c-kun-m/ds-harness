# K09：Service、provide/inject 与依赖生命周期

## 这一课解决什么

服务不是“Map 中存在一个值”就可用。Provider 可能仍在 LOADING、已经 UNLOADING，或者只在另一个 isolation 中可见。消费者还要区分 required 和 optional 依赖；required provider 消失时，消费者必须先卸载，恢复后再重新加载。

## 依赖模型

插件的 inject 可以表达：

- required：没有 ACTIVE provider 时消费者不能 ACTIVE；
- optional：可缺失，变化时可通知但不强制卸载；
- map/array/装饰器元数据：最终规范化为统一依赖集合。

解析还要考虑 Context 的 isolation label 和父 Fiber 链。

## Provider 生命周期

```text
provide 开始
  → 检查同 isolation key 无冲突
  → 注册 provider Effect
  → provider ACTIVE 后 notify dependents

provide dispose
  → 标记不再对新消费者可用
  → 通知 required consumers 卸载
  → 等消费者 cleanup 停稳
  → 清理期允许 provider 自己/依赖清理按合同访问
  → 移除 provider 并 notify
```

## 功能合同

- MUST：同 service + isolation key 的重复 provider 失败；
- MUST：解析只返回 ACTIVE provider，清理期例外必须严格限定；
- MUST：required 缺失时消费者保持 PENDING/卸载，不能用 undefined 继续；
- MUST：required provider 消失时消费者卸载，恢复时重新加载；
- MUST：optional 缺失不阻止加载；
- MUST：provider 移除要等待依赖消费者的卸载义务；
- MUST：consumer cleanup 可在约定窗口访问正在移除的 provider；
- MUST：Service getter/setter/mixin/accessor 注册都是 Effect；
- MUST：服务访问必须符合 inject/provide 声明，特殊内建属性除外；
- MUST：旧 provider disposer 不删除新 provider。

## 你先做的设计题

1. Provider 先从 Map 删除再通知消费者，会导致 consumer cleanup 出现什么问题？
2. 依赖图环如何处理？等待所有 required provider ACTIVE 会不会死锁？
3. optional provider 出现后，消费者应该自动 reload 还是只收到事件？
4. provider 状态 ACTIVE，但所在 isolation 与 caller 不同，是否算可用？

## 实现任务

1. 规范化 inject metadata；
2. 实现 provider key（service + isolation）；
3. 实现 `provide/get/set` 和访问授权；
4. 建立 dependent 追踪和 notify；
5. 把 required 依赖集合折叠成 Fiber epoch；
6. 实现 provider remove 的两阶段语义；
7. 实现 Service mixin/accessor 的 Effect 化注册；
8. 记录循环依赖的明确策略和限制。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| required provider 先存在 | consumer 加载 ACTIVE |
| required 缺失 | consumer PENDING，不运行 apply |
| provider 后出现 | consumer 自动加载 |
| provider 消失 | consumer 先卸载，清理可访问 provider |
| provider 恢复 | consumer 新 epoch 重载 |
| optional 缺失/出现 | 不阻止加载，变化按合同通知 |
| duplicate isolation key | provider 加载前后无污染，明确失败 |
| 两个 isolation | 各自消费者解析正确 provider |
| 未声明访问 | 代理稳定拒绝 |
| mixin/accessor dispose | 精确恢复原表面，不误删后继 |
| provider/consumer 并发 dispose | 无死锁、无悬挂 dependent |
| required dependency chain | 级联顺序与停稳正确 |

## 源码复盘

- [`vendor/cordis/src/reflect.ts`](../../deepseek-harness/vendor/cordis/src/reflect.ts) 的 provider、resolve、notify 和 dependency tracking；
- [`vendor/cordis/src/service.ts`](../../deepseek-harness/vendor/cordis/src/service.ts)；
- [`vendor/cordis/src/fiber.ts`](../../deepseek-harness/vendor/cordis/src/fiber.ts) 的 epoch 与 refresh；
- Cordis 服务教程和 API 文档。

## 完成标准

- required 消失/恢复的完整演示通过；
- provider cleanup 窗口有专门测试；
- isolation 与 inject 授权不能绕过；
- 依赖环策略写入差异账本。

## 复盘问题

1. 为什么 provider 移除是一项异步义务？
2. Fiber epoch 为什么包含 provider Fiber uid？
3. inject 声明既是依赖信息又是访问权限，这种合并有什么优缺点？
