# K01：Disposable 与基础 Effect 语义

## 这一课解决什么

插件会注册监听器、服务、计时器和外部资源。卸载时必须只撤销自己创建的内容，而且重复撤销不能重复副作用。一个简单数组能演示 LIFO，却很容易漏掉精确身份、注册中撤销和异步失败。

本课只建立基础资源语义；Fiber 生命周期和多形态 Effect 在 K04 完成。

## 学习目标

- 区分“资源”“disposer”“拥有者”和“注册记录”；
- 实现幂等的单资源 disposer；
- 实现保持插入顺序、支持 O(1) 精确删除、可逆序清空的集合；
- 理解当前 `EffectStack` 能证明什么、不能证明什么；
- 明确同步 disposer 与异步 disposer 的统一等待方式。

## 关键概念

### 精确撤销

如果服务 A 被卸载后同名服务 B 已注册，A 的旧 disposer 不能删除 B。因此撤销必须绑定注册记录/不透明 token/对象身份，而不是再次按名称搜索。

### 单次执行

公开 disposer 第一次调用取得清理所有权；后续调用不重复执行。若清理异步，后续调用应该加入同一个 Promise，而不是提前返回“好像完成”。

### 顺序

基础 Effect 内的清理按登记逆序执行。清理 3 失败后，清理 2 和 1 仍然需要执行；错误如何聚合在 K02 固化。

## 功能合同

- MUST：每个 disposer 的副作用至多一次；
- MUST：重复调用可以等待同一个清理事务；
- MUST：owner 清空按逆序取得所有活动记录；
- MUST：单条记录提前删除后，owner 清空不再执行它；
- MUST：旧 disposer 不能误删同名后继记录；
- MUST：清空期间新加入的记录不混入当前批次，必须有明确下一世代/拒绝策略；
- MUST：空值清空立即完成；
- MUST NOT：一次失败让剩余清理永远不运行。

## 当前 `EffectStack` 的定位

现有简单实现如果具备 LIFO 和幂等，只能保留为 spike。它还没有证明：

- setup 失败回滚；
- Promise/Iterable/AsyncIterable Effect；
- Fiber state 与 UNLOADING 拒绝；
- 重入卸载；
- sibling Effect 并发；
- cleanup inertia；
- 父子插件所有权。

不要通过不断添加布尔值把它强行变成最终 Fiber。

## 你先做的设计题

1. `Map<id, disposer>` 与数组相比，怎样同时支持 O(1) 删除和逆序清空？
2. disposer 自己再次调用自己会发生什么？
3. disposer A 在运行中提前撤销 disposer B，逆序队列是否还应该调用 B？
4. clear 运行中有人 add，新项属于当前清理还是下一世代？

## 实现任务

1. 定义同步/异步 disposer 的内部统一合同；
2. 实现有序 disposable collection；
3. `add` 返回精确、幂等的公开 disposer；
4. `delete`/提前释放只影响精确记录；
5. `clear` 原子取得当前活动集合并按逆序执行；
6. 记录多个清理错误，暂时可使用简单 AggregateError；K02 再统一错误模型；
7. 保留当前 `EffectStack` 测试，新增精确身份和异步重复等待测试。

## 测试矩阵

| 编号 | 场景 | 必须观察到 |
|---|---|---|
| D-01 | 三项正常清空 | 3、2、1 |
| D-02 | 同一 disposer 调两次 | 副作用一次 |
| D-03 | 两次并发调用 async disposer | 共享一次清理并都在其完成后结算 |
| D-04 | 中间项提前释放 | 提前执行一次，clear 不再执行 |
| D-05 | 旧句柄与同名新记录 | 旧句柄不影响新记录 |
| D-06 | 某项同步抛错 | 其余项仍执行，最终拒绝 |
| D-07 | 某项异步拒绝 | 其余项仍执行，拒绝被观察 |
| D-08 | clear 中 add | 新记录遵守你声明的世代策略 |
| D-09 | 空 clear/重复 clear | 无副作用、稳定完成 |
| D-10 | disposer 重入 clear | 不死锁、不重复执行 |

## 源码复盘

完成第一版后阅读：

- [`vendor/cordis/src/utils.ts`](../../deepseek-harness/vendor/cordis/src/utils.ts) 的 `DisposableList`；
- [`vendor/cordis/src/fiber.ts`](../../deepseek-harness/vendor/cordis/src/fiber.ts) 中单个 Effect 如何收集和执行 disposer。

重点比较 `Map + WeakMap` 的身份管理、`clear()` 返回逆序快照，以及 Cordis 为什么把更复杂的异步所有权留给 Fiber。

## 完成标准

- D-01 至 D-10 通过；
- 能说明单 Effect LIFO 与 Fiber sibling 并发不矛盾；
- 当前 spike 与正式生命周期模型的边界写入差异账本；
- 无未处理 rejection。

## 复盘问题

1. 幂等为什么不能简单写成“第二次直接 return”？
2. 精确撤销为什么是 HMR 和服务替换的基础？
3. 逆序清理解决的是什么依赖问题？它不能解决什么？
