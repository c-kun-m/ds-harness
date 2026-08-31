# 提示词、上下文与 Preset

## 目标

把系统提示词、工具 Schema、工作区说明、Persona 和运行时上下文装配成稳定、可审计的请求前缀，并让不同 Session 使用不同能力组合。

## 前置条件

完成 [Agent 循环与输入队列](08-Agent循环与输入队列.md)。

## Prompt Assembly

`SystemPromptRegistry` 按稳定的数值 order 和唯一 name 注册 section。每个 section 可以是静态文本或在指定 Agent scope 下解析的函数。最终 assembly 包含有序 section、当前可见 Tool Schema、provider/model/cwd 等变量以及每一段的来源元数据。

## Context Provider

Context Provider 不直接改 Agent Loop，而是在 pre-step 时生成可记录的用户上下文。第一版实现工作目录、项目指令和本体状态摘要三类 Context。进入模型的实际文本必须先形成 `request/context` 或 `user/message` 事件，再由 Session 投影进入请求。

## Preset

Preset 是一个声明式组合：工具插件、Persona、Prompt section、Context Provider、Compaction 策略、Subagent 能力和权限策略。Preset ID 写入 Session Header。一个 Session 第一次产生内容后禁止切换 Preset；空白 Session 可以通过销毁旧作用域并事务化挂载新作用域来切换。

## 手写顺序

1. 实现 section Registry、排序、重复名检测和模板变量替换。
2. 实现 Tool Schema 与 section 的同一 assembly 快照。
3. 实现项目指令发现：从工作区根到当前目录逐级加载 `AGENTS.md`，同层规则按明确顺序组合。
4. 实现 Preset Schema 和磁盘目录发现。
5. 实现每 Session 的 Preset mount；每个挂载得到独立子作用域。
6. 实现 Session Header 的 Preset ID 和 resume 时同 Preset 校验。
7. 实现 assembly 审计事件，保存影响模型的配置摘要和内容来源。

## 安全和信任

Preset 能挂载 Shell、MCP 或自定义插件，因此是受信任代码级配置，不是普通偏好设置。路径必须限制在配置根目录，配置解析不执行任意 JavaScript。需要条件配置时使用显式字段，不接受 YAML 代码标签。

## 测试与完成标准

验证 section 稳定排序、变量缺失失败、子作用域覆盖、两个 Agent 使用不同 Preset 互不污染、非空 Session 切换失败、resume Preset 不一致失败。完成后提供 `minimal` 和 `standard` 两个 Preset：前者只有 echo，后者增加文件读取和本体 Context。

## DSH 参考

- [System Prompt 子系统](../deepseek-harness/packages/core/system-prompt/README.md)
- [Agent Preset](../deepseek-harness/packages/preset/agent-presets/README.md)
- [Standard Preset](../deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml)
