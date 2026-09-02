# K07：Plugin Registry、插件形态与实例记录

## 这一课解决什么

到 K06 为止，你能直接创建 Fiber，但还没有统一回答：一个插件是什么、同一插件有多少实例、怎样查找/更新/删除，以及不同导出形态如何调用。Registry 是插件定义与运行实例之间的索引，不是生命周期 owner 的替代品。

## 支持的插件形态

固定基线至少包含：

- 函数插件；
- 构造函数/类服务式插件；
- 带 `apply` 的对象插件；
- 带声明元数据的插件：name、inject、Config 等。

插件解析应在副作用前完成；不支持的形态稳定失败。

## Registry 模型

一个 callback/definition 可能对应多个 Fiber。Registry 需要同时支持：

- definition → runtime record；
- runtime record → 多个 fibers；
- fiber identity → 精确实例；
- 删除 definition 时释放其所有 fibers；
- 单实例更新不误伤同 callback 的其他实例。

## 功能合同

- MUST：插件形态解析确定且可诊断；
- MUST：同一 definition 可有多个独立 Fiber；
- MUST：`plugin()` 返回能等待启动结果、也能精确 dispose 的实例句柄；
- MUST：Registry record 只在至少有定义/实例需要时存在；
- MUST：delete definition 会阻止新实例并释放现有实例；
- MUST：旧实例句柄不能删除后创建的新实例；
- MUST：registry 索引更新与 Fiber 发布/拆除原子一致；
- MUST：Plugin.apply 的 this/constructor 语义明确；
- SHOULD：支持继承/声明合并的 inject metadata。

## 你先做的设计题

1. 函数是否是 class 不能只靠 `typeof === 'function'`，你准备如何判定？
2. `plugin()` 返回 Fiber 还是另一个 handle？怎样避免把内部可变 Fiber 全部暴露？
3. definition delete 与单 Fiber dispose 并发时谁串行化？
4. 插件对象被调用方后来修改，Registry 是否观察到？需要 freeze/快照吗？

## 实现任务

1. 定义插件公共联合和解析器；
2. 定义 RuntimeRecord 与实例索引；
3. 实现 `register/start/get/list/delete`；
4. 将 start 接到 K06 创建事务；
5. 实现实例句柄的 await/dispose；
6. 支持 inject 元数据读取，依赖解析留到 K09；
7. 写 registry 与 Fiber 故障注入一致性测试。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| function/object/class 插件 | 按正确调用语义启动 |
| 非法形态 | 副作用前 INVALID_PLUGIN |
| 同 definition 两实例 | 独立状态、独立 dispose |
| 单实例失败 | 不污染另一个实例/record |
| delete definition | 阻止新建并等待全部实例 |
| delete 与 start 竞争 | 要么发布完整实例，要么完整回滚 |
| 旧 handle 与新世代 | 旧 handle 不误删 |
| inherited inject metadata | 解析结果符合继承规则 |
| publish/detach observer 失败 | 索引与 Fiber 树仍一致 |
| repeated delete/dispose | 幂等或稳定拒绝 |

## 源码复盘

- [`vendor/cordis/src/registry.ts`](../../deepseek-harness/vendor/cordis/src/registry.ts)；
- [`vendor/cordis/src/utils.ts`](../../deepseek-harness/vendor/cordis/src/utils.ts) 的构造函数判定；
- [`docs/cordis-api/registry.zh.md`](../../deepseek-harness/docs/cordis-api/registry.zh.md)。

重点观察 RuntimeRecord 为什么按 callback 聚合，而 Fiber 仍保留独立 uid 和 config。

## 完成标准

- 三种插件形态和非法形态有测试；
- definition delete 的竞争测试通过；
- Registry 与 Fiber 所有权没有双重 disposer；
- 能说明 record、fiber、handle 三者职责。

## 复盘问题

1. Registry 为什么不是 Fiber 的 owner？
2. 同一 callback 多实例对 HMR 和配置有什么影响？
3. thenable handle 有什么易用性，也会带来什么类型/错误风险？
