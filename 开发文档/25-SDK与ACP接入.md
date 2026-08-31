# SDK 与 ACP 接入

## 目标

提供程序化客户端：TypeScript SDK 负责完整 Runtime 控制；ACP Server 提供自动化工具所需的兼容子集。两者都使用 24 中的协议，不复制 Agent 逻辑。

## 前置条件

完成 [API 与实时协议](24-API与实时协议.md)。

## 低层 HarnessClient

低层客户端提供 `start/initialize/request/prompt/subscribe/close`。`prompt()` 只在 Runtime 接受消息入队后返回 Message ID，不等待 Agent 答案。订阅接口提供 async iterator、`next()` 和非阻塞 `tryNext()`，并暴露传输关闭、请求超时、协议错误和 JSON-RPC 错误的不同类型。

## 高层 AgentRuntime

高层 `run(input, options)` 拥有一个活动区间：提交输入、等待该 Message ID 的 inbox receipt，然后收集到整个 Agent 下一次 idle。返回最后提交的 Assistant Message、事件和通知。文档必须明确：这不是与单个 Prompt 严格因果对应的结果，steer、inject、Goal 或其他排队消息可能在 idle 前参与。

## 子进程生命周期

SDK 懒启动 Runtime。`close()` 依次请求协议 shutdown、关闭 stdin、等待、TERM、再 KILL，直到子进程真正退出。每个阶段有独立 deadline；stderr 只保留有界尾部。显式传入 env 时视为完整替换，不与父环境意外合并。

## ACP Server

ACP 第一版只实现 initialize、session/new、session/prompt、session/cancel、session/update 和一次性 permission request。明确不支持 Session load/list/delete/fork、多工作区、客户端传入 MCP Server、编辑器/终端/文件系统能力。ACP Prompt 输出只发送已提交 Assistant Message，原始 delta 和内部本体事实不直接泄露。

## 手写顺序

1. 实现 JSON-RPC stdio transport 和 Low-level Client。
2. 实现订阅、请求超时和关闭阶梯。
3. 实现 High-level session handle 和 run 区间收集。
4. 写 Runtime 单文件假进程做协议和回收测试。
5. 实现 ACP adapter，方法逐个映射到 Agent/Session Service。
6. 实现 ACP 取消和权限桥接，保证一个 Session 同时只有一个 ACP prompt。

## 测试与完成标准

覆盖懒启动、握手失败重启、请求 timeout、传输断开、通知顺序、run 收集边界、EOF/TERM/KILL 回收和 ACP cancel。完成后外部脚本能启动 Runtime、创建 Session、运行一次任务并在退出时无孤儿进程。

## DSH 参考

- [TypeScript SDK Client](../deepseek-harness/packages/sdk/client/README.md)
- [SDK Protocol](../deepseek-harness/packages/sdk/protocol/README.md)
- [ACP Server](../deepseek-harness/packages/acp/acp/README.md)
