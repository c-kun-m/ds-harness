# K13：DSH Scope、事件方向与分层注册

## 这一课解决什么

Cordis Context 提供插件生命周期和服务隔离，但 Agent Runtime 还需要一组“属于某个 Agent/Session 的注册”：工具、提示词、事件监听器和扩展层。它们要沿显式父链可见，且释放一个 Agent 时只撤销其注册。DSH Scope 把可见性和生命周期绑定到同一个 Context。

## Scope 模型

每个 Scope：

- 有独立不透明 key 和 backing Fiber；
- Context 上带不可伪造/受控的 scope tag；
- 可选择绑定一个 parent scope；
- dispose 等 backing Fiber 和所有 inertia 停稳；
- 可以生成 scoped event target/carrier。

父链 nearest-first；合并层时通常从最远祖先到最近/自身，让近层覆盖。

## 事件方向

对带 scope target 的事件：

- child 发出的事件可以被自身和 ancestor listener 接收；
- ancestor 发出的事件不会向 descendant 下泄；
- untagged global listener 按明确规则接收；
- 原有 `Context.filter` 与 scope filter 组合，不被覆盖；
- carrier 只公开必要表面，内部 scope key 不可被调用方直接取出伪造。

## 分层存储

### NamedEntries

- 名称唯一；
- 保持插入顺序；
- duplicate 由调用方收到明确错误；
- undo 精确、幂等；
- drain 时切换 Map generation，旧 iterator 不与新世代混合。

### AnonymousEntries

- 即使值相等，每次添加也有不同 symbol identity；
- undo 只撤销该次添加；
- 仍保持插入与 generation 语义。

### ScopedLayers

- global layer eager，scope overlay lazy；
- 只读操作不创建 layer；
- exact peek 不走父链；
- chain 从最远祖先到当前 scope；
- merge 先 global 再各层，近层 shadow；
- effect action 的可见 scope 和生命周期 owner 来自同一 Context；
- action 返回 undo；先登记 undo 再通知；通知失败要回滚 action；
- 空 layer 自动回收。

## 功能合同

- MUST：Scope parent 只能通过精确 binding 绑定/改绑；
- MUST：拒绝自环和祖先环；
- MUST：dispose 幂等并等待 Fiber/inertia 完全停稳；
- MUST：事件只按 child→ancestor 方向传播；
- MUST：carrier subject 与 resolver 的身份匹配可由 invariant 验证；
- MUST：Named/Anonymous undo 精确、幂等；
- MUST：只读操作不产生 layer；
- MUST：notification failure 回滚刚完成的 layer action；
- MUST：Scope dispose 只撤销本 scope owned entries；
- MUST：iterator/drain generation 语义确定。

## 你先做的设计题

1. 为什么 parent relation 不能只是公开 `scope.parent = x`？
2. 事件向上而不向下的业务含义是什么？全局 listener 为什么仍可能收到？
3. merge 读取层时为何从远到近，而 `scopeChainOf` 返回 nearest-first？
4. action 已修改 layer，notification 抛错，为什么必须 rollback？

## 实现任务

1. 实现 createScope/backing Fiber/tag/raw dispose/quiescence；
2. 实现 parent binding、rebind 和 cycle detection；
3. 实现 opaque scopeTarget 和 filter composition；
4. 实现 NamedEntries/AnonymousEntries；
5. 实现 ScopedLayers 的 lazy layer、peek/chain/merge；
6. 实现 layer effect 的 undo-before-notify 与失败回滚；
7. 实现 scope invariant；
8. 用工具/提示词/监听器各做一个真实组合演示。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 新 Scope 立即使用 | 不必等 backing Fiber ACTIVE |
| 重复 dispose/raw-first | 同一停稳事务，无重复清理 |
| bind/rebind | 只有 binding owner 可改绑 |
| cycle/self parent | 副作用前拒绝 |
| child event | child、parent、root 依规则接收 |
| parent event | child 不接收 |
| global + base filter | 两种规则正确组合 |
| carrier 伪造/subject 不匹配 | invariant 拒绝 |
| Named duplicate | 明确错误，旧项不变 |
| equal anonymous values | 两个独立 identity |
| drain 中 add | 新世代不混入旧 iterator |
| read missing layer | 不创建 overlay |
| merge shadow | global→far→near→exact |
| action/factory/notify 失败 | 层和 owner 均回滚 |
| scope dispose | 只清理本层，空 layer 回收 |

## 源码复盘

- [`packages/core/scope/README.zh.md`](../../deepseek-harness/packages/core/scope/README.zh.md)；
- [`packages/core/scope/src/index.ts`](../../deepseek-harness/packages/core/scope/src/index.ts)；
- [`packages/core/scope/src/store.ts`](../../deepseek-harness/packages/core/scope/src/store.ts)；
- [`packages/core/scope/src/invariant.ts`](../../deepseek-harness/packages/core/scope/src/invariant.ts)；
- 对应 `scope.spec.ts`、`store.spec.ts`、`invariant.spec.ts`。

## 完成标准

- 上述测试矩阵全部覆盖；
- 工具、提示词和事件三类 scope 演示通过；
- 可见性与生命周期确实来自同一个 Context；
- dispose 后 backing Fiber、inertia、layers 和 listeners 全部为空；
- `PARITY.md` 映射 DSH Scope 代表性测试。

## 复盘问题

1. Context、Fiber 和 Scope 三者各自拥有哪部分语义？
2. 为什么只读不创建 layer 是重要不变量？
3. scoped event 的向上方向如何支持 parent 观察 child，同时避免能力下泄？

## 内核阶段毕业检查

完成本课后回到 [03 总路线](../03-工程骨架与插件内核.md)，执行五个阶段演示和全量 parity 审查。没有完成 K01–K12 的差异项，不能因为 Scope 能跑就跳到 Agent Loop。
