# 25：SDK 行协议、客户端进程生命周期与 ACP 自动化接口

## 本课定位

本课有两个对外表面：

1. DSH SDK 自有的轻量 newline JSON-RPC，适合启动一个 Runtime 并发送 prompt；
2. 标准 ACP v1 自动化服务器，支持一个连接多 Session、恢复、MCP、模型设置、取消和语义更新。

它们不复制 Agent 逻辑，只映射 05–24 的服务合同。

## SDK Protocol

### 分帧

每行一个以 `\n` 结束的 JSON-RPC 2.0 frame。带 id+method 是请求，仅 id 是响应，仅 method 是通知。传输 start 挂 listener；close 移除 listener、拒绝 pending requests，但不擅自销毁调用方拥有的 stream。

格式错误行的处理必须显式（固定上游忽略）；unknown method -32601，handler failure -32603；错误响应使匹配 request 以保留 code/data 的 JsonRpcResponseError 拒绝。

### 固定上游最小表面

client→server：

- `initialize`；
- `session/prompt` → 持久入队 receipt/messageId；
- `shutdown`。

server→client：

- `session.event`；
- `session.status`；
- `subagent.started`；
- `subagent.finished`。

messageId 只证明 prompt 已入队，不是 assistant reply/Turn result identity。当前固定协议没有取消、会话 list/load/fork 和版本协商；如果本项目扩展，必须增加 protocol version/capability negotiation，不能悄悄改变 v0.0.1 含义。

### Server

initialize 解析精确 provider/model/reasoning/maxTokens，并在成功前发布 Agent；缺 adapter/不支持能力不回退。prompt 验证完整文本/图片批次，图片先持久准入再入队。Stdout 只走协议，日志走 stderr。

## TypeScript SDK Client

### Low-level

拥有 child process/transport：lazy start、initialize、request、prompt receipt、notification subscription、close。区分 spawn/handshake/transport/timeout/JSON-RPC/remote error。订阅是有界 AsyncIterable，close 让 pending request/iterator 结算。

### 高层 run 边界

如果提供 `run(input)`：提交 prompt → 等 receipt → 收集到整个 Agent 下一次 idle。返回最后 committed assistant 和事件。必须说明它不是与单一 Prompt 严格因果一一对应：steer/inject/Goal/其他排队工作可能在 idle 前参与。需要精确因果必须使用 request-series/message source/Turn range。

### 子进程关闭

记忆化 close：请求 protocol shutdown → 关闭 stdin/等待 → TERM → KILL → 确认 exit。每阶段独立 deadline，stderr 只保留有界 tail。显式 env 的“完整替换还是 merge”要固定并安全 scrub；不能无意把父进程 secrets 全传给 child。

## ACP 自动化服务器

ACP 面向受信自动化，不是 DSH UI。一个连接可多 Session，各自独立：

- initialize/authenticate（当前服务可声明无需 auth，但远程部署另加）；
- session/new/list/resume/close；
- session/set_config_option（model/reasoning）；
- session/prompt、session/cancel/`$/cancel_request`；
- session/update：committed assistant/thought、通用 tool lifecycle、配置、context usage；
- session/request_permission 一次决定；
- new 时可挂 stdio/HTTP MCP（受信配置）。

不支持的能力必须不公布或明确拒绝：delete、fork、transcript replay、额外 cwd、SSE/ACP transport MCP、Plan/Terminal/Client FS/elicitation 等（按固定版本）。

### ACP Prompt 准入

每 Session 同时一个 prompt：

1. 全批内容/资源/图片校验；
2. snapshot 当前模型路由；
3. 重新确认同一 Agent/能力；
4. 持久化附件；
5. enqueue message；
6. 串行发送 committed semantic updates；
7. Agent idle 且更新 drain 后结算。

cancel 赢得准入竞态时不能留下迟到 prompt。路由 snapshot 固定该 Turn 各 Step；并发设置从下一 Turn 生效。

### ACP Session close

关闭新准入 → 取消 prompt/Agent → drain updates → child-first 释放 continuable descendants → flush persistence → dispose owned Agent Scope。只影响这一 Session，不结束其他 Session。关闭后持久会话仍可 list/resume。

ACP 只发送标准语义更新，不发原始 provider delta、retry attempt、DSH 私有 card/本体内部对象。

## 实现任务

1. newline transport/pending request/notification；
2. SDK protocol types/version strategy；
3. stdio server initialize/prompt/shutdown；
4. low-level client/lazy process/subscription；
5. close escalation + stderr tail；
6. high-level run range；
7. ACP multi-session records/ownership；
8. new/list/resume/close/config；
9. prompt content/route snapshot/update serial delivery；
10. cancel/permission/MCP composition；
11. capability honesty和 unsupported tests。

## 测试矩阵

| 场景 | 必须观察到 |
|---|---|
| partial/multiple/malformed lines | 正确分帧与错误策略 |
| unknown method/handler fail | -32601/-32603 |
| transport close | 全部 pending/iterators 结算 |
| initialize route invalid | prompt 前失败，不发布 Agent |
| prompt receipt | 只表示入队，不伪装回答 |
| child ignores shutdown/TERM | 最终 KILL 且无孤儿 |
| stderr flood | tail 有界，不阻塞 child |
| high-level run + competing input | 文档化 idle range 行为 |
| ACP 两 Session 并发 | 状态/更新/关闭互不污染 |
| prompt 与 cancel 竞争 | 要么接纳完整 batch，要么完全不入队 |
| config change during Turn | 当前路由固定，下 Turn 生效 |
| resume | 不回放旧 update，恢复持久状态 |
| close | descendants/flush/scope 完全停稳 |
| unsupported capability | 未公布/明确拒绝 |
| permission responder missing/error | fail-closed |

## 源码复盘

- [`packages/sdk/protocol/README.zh.md`](../deepseek-harness/packages/sdk/protocol/README.zh.md)；
- [`packages/sdk/server/README.zh.md`](../deepseek-harness/packages/sdk/server/README.zh.md)；
- [`packages/sdk/client/README.zh.md`](../deepseek-harness/packages/sdk/client/README.zh.md)；
- [`packages/acp/acp/README.zh.md`](../deepseek-harness/packages/acp/acp/README.zh.md) 与 `src/index/content/codec`；
- [`packages/subagent/subagent-acp`](../deepseek-harness/packages/subagent/subagent-acp)。

## 完成标准

- SDK 最小协议和自定义扩展明确分版；
- prompt receipt 语义不夸大；
- client close 无孤儿进程/未结算请求；
- ACP 多 Session/准入/更新/close 故障测试通过；
- capability advertisement 诚实；
- stdout 无日志污染。

## 复盘问题

1. SDK 自有协议和 ACP 为什么都需要存在？
2. prompt receipt、Turn completion、Agent idle 三者有什么差别？
3. ACP close 为什么必须等更新 drain 和 persistence flush？
