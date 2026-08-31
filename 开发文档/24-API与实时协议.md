# API 与实时协议

## 目标

建立稳定的 Host API，使 Web、CLI 和 SDK 不直接持有 Runtime 对象。命令使用 JSON-RPC 2.0，请求和事件通过 WebSocket 传输；协议定义与服务实现分包。

## 前置条件

完成 [MCP 模块](23-MCP模块.md)。

## 第一版方法

| 领域 | 方法 |
|---|---|
| 初始化 | `initialize`、`health/get`、`models/list`、`presets/list` |
| Session | `session/create`、`session/resume`、`session/list`、`session/get`、`session/fork`、`session/export` |
| Agent | `agent/send`、`agent/cancel`、`agent/status`、`agent/inbox/get` |
| 交互 | `approval/resolve`、`question/answer`、`question/dismiss` |
| 状态 | `goal/*`、`todo/get`、`plan/get`、`jobs/*`、`subagents/list` |
| 本体 | `ontology/versions`、`ontology/facts/query`、`ontology/plans/get`、`ontology/decisions/get` |

方法名、参数和结果都由 Zod Schema 定义，生成客户端类型和运行时验证。错误使用 JSON-RPC error code + 稳定业务 `data.code`；不把内部堆栈发给普通客户端。

## 通知

`session/event`、`session/projection`、`agent/status`、`agent/inbox`、`approval/requested`、`question/asked`、`job/changed`、`subagent/changed` 和 `ontology/plan-changed` 都带 Host 连接级单调 cursor。客户端断线重连后先请求 Snapshot，再从 cursor 后补增量；无法补齐时明确要求全量刷新。

## 背压

每个连接有发送队列字节上限。高频 `assistant/chunk` 可以按连续文本块合并，但不能丢失最终 `assistant/message`、状态变化、审批和错误。慢客户端达到上限时关闭连接并返回可识别原因，不能拖垮 Agent Loop。

## 鉴权和授权

MVP 本地模式可使用随机启动 Token；远程模式必须有 TLS、用户身份、Workspace 权限和 Session owner 检查。RPC Handler 不自行判断工具权限，只负责调用 Runtime 服务；实际动作仍经过本体 Guard 和 Tool Runtime。

## 手写顺序

1. 定义 JSON-RPC envelope、request ID、notification 和错误 Schema。
2. 实现方法 Registry 和 Zod 入站/出站校验。
3. 实现 WebSocket connection、initialize 握手和连接清理。
4. 实现 Session/Agent 最小方法。
5. 实现通知总线、cursor、Snapshot + 增量恢复。
6. 实现背压、心跳、消息大小和速率限制。
7. 逐模块注册 Goal、Job、本体和 Subagent API。

## 测试与完成标准

覆盖未知方法、坏参数、重复 ID、超大帧、慢客户端、断线重连、cursor 过期、越权和 Handler 取消。完成后两个 WebSocket 客户端能观察同一 Session，但只有 owner 可提交输入和处理审批。

## DSH 与协议参考

- [DSH API Gateway](../deepseek-harness/packages/api/gateway/README.md)
- [DSH Host API Proxy](../deepseek-harness/packages/host/apiproxy/README.md)
- [JSON-RPC 2.0 规范](https://www.jsonrpc.org/specification)
