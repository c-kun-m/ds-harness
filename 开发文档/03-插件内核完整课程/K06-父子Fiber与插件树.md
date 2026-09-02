# K06：父子 Fiber、插件树与原子发布

## 这一课解决什么

插件会创建子插件。父卸载必须级联释放子；子创建失败不能留下幽灵节点；最关键的是，子 Fiber 不能先对外发布，再由父补登记 disposer——发布通知中的重入卸载会让子失去所有者。

## 所有权模型

```text
Parent Fiber
  └─ parent-owned Effect
       └─ child raw disposer
            └─ Child Fiber
                 ├─ child effects
                 └─ grandchildren
```

父不是通过“树里能找到 child”拥有它，而是通过已经登记的精确 Effect/disposer 拥有它。树是观察视图，disposer 是能力。

## 创建事务

推荐时序：

1. 验证 parent 可接纳 child；
2. 构造未发布 Child Fiber；
3. 在 parent Effect 中登记 child raw disposer；
4. 完成 child 初始解析/加载；
5. 发布 child 到 registry/tree 并发送通知；
6. 任一步失败，沿既有 owner 回滚并完全停稳。

## 功能合同

- MUST：每个非根 Fiber 恰有一个结构 owner；
- MUST：父在 child 发布前拥有其 raw disposer；
- MUST：父 unload 等待所有 child 完全停稳；
- MUST：child 自行 dispose 只精确撤销自己在父中的 owner Effect；
- MUST：创建、加载或发布通知失败不留下 tree/registry/effect 残留；
- MUST：发布通知内重入 dispose 不产生已发布孤儿；
- MUST：旧 child disposer 不影响同 id/同插件的新 child 世代；
- MUST：根 Fiber 有明确特殊所有者，不伪造普通 parent；
- SHOULD：tree observer 只读，不能获得未授权 disposer。

## 你先做的设计题

1. child apply 成功但 registry publish 失败，谁负责清理 child effect？
2. child 自卸载与 parent 同时卸载，父的 Effect 记录何时删除？
3. tree 中是否允许 FAILED child？它对外是否算已发布？
4. 多个相同 plugin callback 的 child 如何区分身份？

## 实现任务

1. 定义 root 和 child identity/generation；
2. 实现 parent-owned child Effect；
3. 实现 child 创建事务和 rollback；
4. 实现 tree/registry 的原子 publish/detach；
5. 发布后发送 observer 通知，异常按合同隔离或回滚；
6. 实现父卸载的 child 级联与等待；
7. 提供只读 tree snapshot/diagnostic。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 正常 parent→child | child 发布一次，树一致 |
| parent unload | child 先/同时清理，父等待停稳 |
| child 自 dispose | 只移除自己，parent 仍 ACTIVE |
| child setup 失败 | 不发布，所有 child effect 回滚 |
| parent owner 登记失败 | child 不启动或被回滚 |
| publish 失败 | child 完全释放，无幽灵 tree 节点 |
| publish observer 内 parent dispose | 无孤儿，最终都 DISPOSED |
| parent/child 并发 dispose | 每个清理一次 |
| 旧 child disposer + 新世代 | 旧句柄不移除新 child |
| 孙子级联 | 整棵子树停稳后 parent 兑现 |
| tree observer 抛错 | 按合同不破坏所有权 |

## 源码复盘

- [`vendor/cordis/src/fiber.ts`](../../deepseek-harness/vendor/cordis/src/fiber.ts) 的 plugin 创建、runtime fibers 和 parent Effect；
- [`vendor/cordis/src/registry.ts`](../../deepseek-harness/vendor/cordis/src/registry.ts) 的 Fiber wrapper；
- [`vendor/README.md`](../../deepseek-harness/vendor/README.md) 的 child ownership/publication hardening。

## 完成标准

- 任意创建失败点的故障注入都无残留；
- parent/child 并发 dispose 测试稳定；
- tree 只是视图，真正 owner 能被明确指出；
- 完成三层级联停稳演示。

## 复盘问题

1. “先登记 disposer，再发布 child”解决哪个重入窗口？
2. 为什么从 registry 删除节点不等于释放 child？
3. 观察树和所有权树可以不同吗？什么时候？
