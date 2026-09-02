# 24：Host Typed API、Remote Stream 与连接代次

## 本课定位

Web/桌面 Client 不直接持有 Runtime 对象。固定上游的 Host API 使用生成的 typed invocation descriptor + HTTP unary + WebSocket multiplexed streams，而 SDK stdio 在 25 使用另一套 newline JSON-RPC。不要把两种传输和错误语义混在一个“大协议”里。

本项目可以采用 JSON-RPC Web API，但若目标是学习/复刻 DSH 核心，应先理解 typed Gateway 的行为，再在差异账本记录协议选择。

## 学习目标

- 让 Host/Client 共用生成的 endpoint/codec 描述；
- 在 Host 调用前后双向校验参数和结果；
- 通过 lookup resolver 将 wire identity 解析为授权 Session/Agent/Context；
- 将 AbortSignal 作为 descriptor 元数据注入，而不是 wire 参数；
- 多路复用逻辑流并正确处理物理连接代次；
- 提供 snapshot/journal stream 的 baseline + delta + gap repair；
- 让 carrier failure 与业务 RemoteError 分开；
- 连接释放时中止调用/流并等待 iterator 停稳。

## Host Gateway

### Descriptor

每个 Remote method 有稳定 namespace/name、mode（unary/stream）、参数名和输入/输出 codec、lookup/Context 参数、是否注入 signal。严格模式只接受生成 descriptor；开发 SRC fallback 只能支持简单标识符参数和 JSON-safe 值，不能假装拥有完整类型校验。

一旦观测到 strict definition 后撤回，不降级到 SRC；明确失败，避免校验强度静默下降。

### Invoke

```text
resolve current descriptor and service method
→ exact named-argument validation
→ resolve lookup identities / RemoteScope Context
→ inject caller-owned AbortSignal as final Host argument
→ invoke business service
→ validate result codec
→ map stable RemoteError / gateway error
```

Resolver 拥有 live-only、cold-resume、owner fence 等业务选择；Gateway 不能只凭可猜 SessionId 返回对象。业务 RemoteError code 原样过线；未知内部错误只发稳定 gateway/internal，不泄漏 stack/cause。

### Stream

stream method 返回 Iterable/AsyncIterable，每项经 result codec。多个逻辑流共享一个 `/api/remote.mux` WebSocket；每流独立取消。Host heartbeat 使用 Ping/Pong，超时关闭物理连接，不向业务流伪造普通 data frame。

## Client Remote

### Mount 生命周期

生成贡献挂载到调用 Fiber：创建具体 namespace methods；重复 endpoint/namespace conflict/缺 codec 在可调用前失败。unmount 同时撤销 descriptor/method、中止在途调用/流；外部保留的旧 method 句柄之后调用稳定拒绝，不能落到新世代。

### Unary 结果

carrier/Remote 失败折入：

```text
{ ok: true, value }
{ ok: false, error: RemoteError }
```

普通网络断线不 reject；只有本地装配错误（参数个数、未挂载、缺 adapter）reject。这样消费方可以区分远程失败与本地编程错误。

### Stream 与 generation

`RemoteStream` 跨物理连接代次，Host 在线时可一次立即重试，离线等待 Connection 下一 generation。每项标注/受当前 generation 约束；业务错误终止，carrier loss 只触发 retry callback，不伪装成终态 RemoteError，重试耗尽才变终态。

`RemoteSnapshotStream`：每代 opening snapshot + subsequent deltas；consumer 验证 opening 后才发布 generation。

`RemoteJournalStream`：先 follow listener 再分页 baseline，使用领域 entry 闭区间追赶；完整重复丢弃，gap/倒序/部分重叠拒绝并重新 snapshot/repair。Gateway 不猜领域 cursor 语义。

### Host events

唯一 `$events` source：同步挂增量 listener 后才读取 baseline/发布 ready，避免 snapshot-listener gap。opening ready 提供 clientId 和 host facts；事件 payload 由各业务包定义，Gateway 不自动脱敏/投影。普通通知不重放，pending scoped waterfall 可用稳定 event id 按合同重放。

## HTTP/WebSocket Host

底层 webserver 是具名 route registry：exact 优先，再 longest prefix，再唯一 fallback；upgrade 只 exact。route registration 是 Effect，重复路径失败。绑定 `0.0.0.0` 不自动提供 TLS/auth/origin policy；远程部署必须由 route owner/反向代理增加。

服务器 dispose 关闭 listener、普通连接和显式追踪的 upgraded sockets，Promise 只在全部关闭后兑现。

## 业务 Remote 规划

先实现最小集合，不从 UI 页面倒推一个巨型 controller：

- Session create/list/inspect/resume/fork；
- Agent input/cancel/status/inbox；
- projections/journal；
- approval/question scoped waterfall；
- Goal/Plan/Todo/Jobs/Subagent/Workflow views；
- Ontology snapshot/decision/plan views；
- settings/model/preset inventory。

每个 endpoint 的 owner package 自己定义 codec、lookup policy、auth 和错误，不由 Gateway 发明第二份类型。

## 背压与大小

- 每逻辑 stream/Client 有有界队列；
- 高频 chunk 可按协议安全合并，但 terminal message、status、approval、error 不丢；
- 慢客户端达到上限，终止该 stream/connection并给出稳定 carrier reason，不阻塞 Agent Loop；
- frame/request/result/queue 都有限制；
- 断线后由 snapshot/journal 恢复，不指望普通通知无限缓存。

## 实现任务

1. descriptor/codec/generator；
2. Host invoke/stream + lookup/Context/signal；
3. RemoteError/gateway code；
4. Client mount/unmount/unary result；
5. shared mux + logical stream cancellation/heartbeat；
6. connection generation/retry；
7. snapshot/journal stream gap algorithm；
8. Host event source ready/baseline/delta；
9. route registry/upgrade/dispose；
10. business remotes + owner checks；
11. backpressure/limits/security。

## 测试矩阵

| 场景 | 必须观察到 |
|---|---|
| descriptor 参数/结果错误 | 调用前/返回前稳定失败 |
| strict definition 撤回 | 不降级 SRC |
| lookup 越权/stale identity | owner resolver 拒绝 |
| abort wire | signal 不序列化，Host 操作被取消并停稳 |
| unary carrier loss | RemoteResult error，不普通 reject |
| local mount misuse | reject，区分本地故障 |
| 多逻辑流/单 socket | 独立取消，不互相结束 |
| heartbeat miss/reconnect | 新 generation，旧项不进入新 store |
| snapshot listener gap | follow-before-baseline 无丢增量 |
| journal duplicate/gap/overlap | 去完整重复，拒绝缺口/部分重叠 |
| unmount/old method handle | 在途取消，旧句柄不调用新 endpoint |
| slow client/oversize frame | 有界关闭，不拖 Agent |
| route exact/prefix/fallback | 匹配确定，重复注册失败 |
| server dispose upgraded socket | 全部连接关闭后才兑现 |

## 源码复盘

- [`packages/api/gateway/README.zh.md`](../deepseek-harness/packages/api/gateway/README.zh.md)；
- [`packages/typert/protocol/README.zh.md`](../deepseek-harness/packages/typert/protocol/README.zh.md) 与 generator/registry；
- [`packages/api/remotes/README.zh.md`](../deepseek-harness/packages/api/remotes/README.zh.md)；
- [`packages/host/webserver/README.zh.md`](../deepseek-harness/packages/host/webserver/README.zh.md)；
- `packages/client/connection` 与 Remote snapshot/journal 测试。

## 完成标准

- strict codec/lookup/signal 全部生效；
- carrier failure 和业务错误可区分；
- generation store 不消费旧连接帧；
- snapshot/journal 无 gap；
- slow/恶意 Client 不能阻塞 Runtime；
- teardown 后无 socket/iterator/pending call。

## 复盘问题

1. 为什么 Gateway 不应该拥有 SessionId 的授权策略？
2. unary RemoteResult 不 reject 有什么好处，哪些错误仍应 reject？
3. snapshot stream 的 listener 为什么要先于 baseline 注册？
