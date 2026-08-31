# Workflow 模块

## 目标

提供显式的多 Agent 脚本编排，用于批量并行、汇合和流水线。Workflow 是用户或模型发起的临时编排；领域关键流程仍由本体计划模块持久化和验证。

## 前置条件

完成 [子 Agent 模块](20-子Agent模块.md)。

## Runtime API

- `agent(prompt, options?)`：启动一个 one-shot 子 Agent 并等待结果。
- `parallel(tasks)`：并发执行并在全部完成后返回，结果保持输入顺序。
- `pipeline(items, stages)`：每个 item 按阶段流动，item 之间受并发上限控制。
- `phase(title)`：发布当前阶段。
- `log(message)`：发布有界进度消息。

## 隔离模型

脚本在 Worker Thread 中执行，主线程只暴露上述 RPC。禁止提供 `require`、动态 import、process、fs、net、eval 和 Function。Worker 隔离主要用于故障和资源控制，不是恶意代码安全边界；不可信脚本需要独立进程或容器。

## 配额

每次 Workflow 配置 wall timeout、并发 Agent 上限、总 Agent 启动数、parallel/pipeline item 上限、脚本长度、日志字节、结果字节和 Worker 内存上限。达到任一限制都取消未开始工作并排空已开始子 Agent。

## 事件

记录 `workflow/start`、`phase`、`log`、`agent-start`、`agent-end` 和 `workflow/end`。事件带 Run ID 和单调 seq；Web UI 只从这些事件绘制进度。

## 手写顺序

1. 定义 Workflow Engine 接口和 Worker RPC 协议。
2. 实现 Worker 启动、Deadline、内存和关闭回收。
3. 实现 `agent()` host bridge。
4. 实现 parallel/pipeline 的有界调度和结果排序。
5. 实现 Observer 事件和 Session 持久化。
6. 注册模型工具；工具描述明确只在大型编排时使用。

## 测试与完成标准

覆盖顺序、并发上限、阶段、子 Agent 失败、脚本异常、超时、未 await promise、结果过大、取消和 Worker 崩溃。完成后运行“并行分析三个文件→汇总一个报告”的脚本，结果有序且所有子 Agent 可追踪。

## DSH 参考

- [Workflow Service](../deepseek-harness/packages/workflow/workflow/README.md)
- [Worker Thread Provider](../deepseek-harness/packages/workflow/workflow-worker-thread/README.md)
- [Workflow Tool](../deepseek-harness/packages/workflow/tool-workflow/README.md)
