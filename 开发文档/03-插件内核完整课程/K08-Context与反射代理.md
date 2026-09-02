# K08：Context、作用域扩展与反射代理

## 这一课解决什么

插件不能靠全局变量访问所有服务。它需要一个携带当前 Fiber、作用域、隔离标签、拦截配置和访问追踪的 Context。子 Context 应继承父能力，但自己的注册只在自己的生命周期内有效。

## Context 不是普通 Map

Context 同时承担：

- 当前 Fiber/Effect owner；
- 原型式子作用域；
- 服务访问代理；
- isolation label 链；
- per-service intercept 配置链；
- filter/trace 的调用上下文；
- 内建 reflect/registry/events/logger 入口。

## 功能合同

- MUST：root Context 由受控代理提供内建能力；
- MUST：`extend()` 创建原型继承的子 Context，不复制整个服务表；
- MUST：子注册使用子 Fiber/Scope owner，释放不影响父；
- MUST：`isolate(name,label)` 只改变指定服务的解析隔离；
- MUST：`intercept(name,config)` 形成从 root 到 nearest 的配置链；
- MUST：服务方法被取出/调用时保留正确 receiver 和调用 Context；
- MUST：Context 有跨副本/realm 可识别 brand，不依赖单一 `instanceof`；
- MUST：未声明访问在 K09 的注入规则下被拒绝；
- MUST：trace/bind 不把调用者上下文泄漏到无关异步任务。

## 你先做的设计题

1. 为什么直接把 service instance 赋给 `ctx.foo` 会丢失“谁在调用”的信息？
2. `Object.create(parentCtx)` 与复制 parent Map 的可见性区别是什么？
3. isolation label 应存在 Context、Fiber 还是 Service provider 上？
4. service 方法返回回调，回调晚些执行时应继承哪个调用 Context？

## 实现任务

1. 定义 root Context brand 和内部符号；
2. 实现 `extend` 及 metadata 链；
3. 实现 isolate/intercept 的不可变或持久链；
4. 建立 reflect proxy handler 的最小骨架；
5. 实现 service method 的 receiver 绑定和 trace；
6. 为 callable service 预留明确 invoke symbol/合同；
7. 测试跨多个子 Context 的隔离和异步 trace 不串线。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| root 内建服务 | 可访问且身份稳定 |
| extend 两层 | 子读父，父不读子 |
| 子注册/释放 | 只撤销子资源 |
| 两服务不同 isolate | 仅指定服务解析标签变化 |
| intercept 多层 | root-first 合并，near 覆盖 |
| 方法解构调用 | this 和 caller Context 正确 |
| callable service | 通过明确 invoke 合同调用 |
| 两条并行异步链 | trace 不串线 |
| 跨副本 brand | `Context.is` 等价判断成功 |
| disposed Context 注册 | 稳定拒绝 |

## 源码复盘

- [`vendor/cordis/src/context.ts`](../../deepseek-harness/vendor/cordis/src/context.ts)；
- [`vendor/cordis/src/service.ts`](../../deepseek-harness/vendor/cordis/src/service.ts)；
- [`vendor/cordis/src/reflect.ts`](../../deepseek-harness/vendor/cordis/src/reflect.ts)；
- [`vendor/cordis/src/utils.ts`](../../deepseek-harness/vendor/cordis/src/utils.ts) 的 traceable/shadow proxy。

## 完成标准

- 原型作用域、隔离、拦截和 trace 测试通过；
- 没有使用可变全局“current context”；
- Context brand 不只依赖 constructor identity；
- 能解释 Context 与 Fiber/Scope 的边界。

## 复盘问题

1. 为什么 Service 代理要知道 caller Context？
2. isolation 和 shadow 的语义区别是什么？
3. `AsyncLocalStorage` 可以替代所有显式 Context 传递吗？为什么不可以？
