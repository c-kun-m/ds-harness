# 09：系统提示词、动态上下文、工具目录与 Agent Preset

## 本课定位

模型一次请求看到的是一个整体：系统提示词、运行时上下文、历史和工具 schema。它们必须来自同一个作用域 snapshot，顺序稳定且可审计。Preset 负责在 Agent 发布前组合能力，不是可以在非空会话中随意更换的一段 persona。

## 学习目标

- 建立全局 + Agent Scope 的提示词注册表；
- 稳定排序 section、变量和工具 schema；
- 区分系统提示词 section 与动态 runtime context；
- 支持 scoped shadow、complete prompt 和 runtime-context suppression；
- 让 assemble waterfall 可扩展但仍保持确定性；
- 用事务挂载 Preset，失败不发布半配置 Agent；
- 记录足以重建请求的 assembly 证据。

## System Prompt 输入

### Section

每个 section 有唯一 name、有限数值 order、静态/动态 text，可选 `complete`。排序先按 order，再按 name 的稳定代码单元顺序。同 Scope 同名注册明确失败或精确 shadow；nearest Agent Scope 覆盖 global 同名项。

若一个有效 section 声明 `complete: true`，它成为精确完整系统提示词；同时有效的 complete section 超过一个必须失败。complete 不自动删除工具 schema 和动态上下文，除非你的公共合同明确如此并记差异。

### Variable

section 中的 `{{name}}` 在 render 阶段插值。未知变量、已注册但当前无值、格式错误占位都失败，不静默留原文。当前固定基线没有字面 `{{...}}` 转义；若你增加，要记录差异。

### Tool provider/order

工具 schema 与 section 在同一次 `assemble(scope)` 中求值。显式 `toolOrder` 要求名称不重复并且恰好一个 `<unlisted-tools>` 占位；列出的名称当前不可见/不存在时 assemble 失败，不静默丢弃。

## 两阶段组装

```text
assemble(scope)
  → merge global + scoped sections/variables/tool providers
  → evaluate dynamic text/values
  → stable sort sections and tools
  → system-prompt/assemble waterfall
  → enforce complete/suppression rules
  → return unrendered sections + variables + tools + runtime contexts

renderPrompt(assembly)
  → interpolate variables
  → drop empty sections
  → join with stable blank lines
```

分两阶段让测试可以验证“事实求值”和“字符串渲染”分别正确。

## Runtime Context

动态上下文不是 system section。它在 Loop 中作为带 source 的 user-role snapshot 写入/进入历史，例如 cwd、权限策略、本体事实版本、delegated subagent 限制。只有首次或事实变化时追加新完整 snapshot，避免每 Step 重复 token；请求需要能指出使用的是哪个 snapshot。

`suppressRuntimeContext(scope)` 只抑制模型呈现，不关闭拥有事实的服务；多个 suppression effect 独立，最后一个释放后恢复。

## Assembly waterfall

监听器可以观察/替换 assembly，但必须在 Agent Scope 下过滤。改变 section/tools 的监听器自己负责确定性。`system-prompt/change` 是无 filter 的变更通知，因为 global 注册变化可能影响所有 Agent；它不等同于每个 Agent 都立即追加上下文。

## Preset

Preset 描述 Agent setup 事务：persona、模型默认、工具限制、提示词、上下文贡献、权限策略、压缩、Subagent 能力等。它在私有 Agent Scope 中挂载；全部成功后 Agent 才发布。

- Preset 是受信任的代码/组合配置，不把任意 YAML JavaScript 当用户偏好执行；
- Session Header 记录稳定 preset/profile identity 和必要 revision；
- resume 必须解析兼容的 preset 或明确拒绝/迁移；
- 非空 Session 不原地切换整个能力世界；空 Session 切换也要销毁旧 Scope 后事务化新挂载；
- 两个 Agent 的 scoped 注册互不污染。

## 实现任务

1. Section/Variable/ToolProvider/RuntimeContext 注册表；
2. scoped shadow 和精确 disposer；
3. stable assemble + render + complete；
4. toolOrder 校验；
5. assemble waterfall/change observer；
6. dynamic context snapshot/suppression；
7. Preset schema、发现和 setup transaction；
8. Session header/resume compatibility；
9. minimal/standard 两个测试 Preset。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| order 相同/不同 | 数值后按 name 稳定 |
| scoped section/variable | 只影响目标 Agent并 shadow global |
| unknown/missing variable | render 明确失败 |
| 0/1/2 complete | 普通、精确、冲突失败 |
| toolOrder 缺/多余 marker | 配置失败 |
| 列出未知工具 | assemble 失败 |
| waterfall 修改/抛错 | 权威结果或稳定失败 |
| runtime context 未变化 | 不重复追加 |
| 多 suppression | 全部释放后才恢复 |
| 两 Agent 不同 Preset | 工具/提示词/策略互不污染 |
| setup 中某插件失败 | Scope 全回滚，Agent 不发布 |
| resume preset 不兼容 | fail-closed，不用当前默认偷换历史 |
| cache stability | 相同 assembly 字节稳定 |

## 源码复盘

- [`packages/core/system-prompt/README.zh.md`](../deepseek-harness/packages/core/system-prompt/README.zh.md) 与 [`src/index.ts`](../deepseek-harness/packages/core/system-prompt/src/index.ts)；
- [`packages/core/system-prompt/src/invariant.ts`](../deepseek-harness/packages/core/system-prompt/src/invariant.ts)；
- [`packages/preset/agent-presets/README.zh.md`](../deepseek-harness/packages/preset/agent-presets/README.zh.md)；
- [`packages/core/agent/src/model-selection.ts`](../deepseek-harness/packages/core/agent/src/model-selection.ts)；
- first-party prompt order 与 explicit tool order 的上游测试。

## 完成标准

- 相同 Scope/事实得到字节稳定 assembly；
- 任何变量、complete、tool order 错误都不调用模型；
- 动态上下文有 source 和变化快照；
- Preset setup 故障注入无残留；
- resume 不会用新默认静默改变旧会话能力。

## 复盘问题

1. 为什么 runtime context 不直接拼进 system prompt？
2. 工具 schema 与 prompt 为什么要在同一 assembly snapshot 求值？
3. Preset identity 和每个具体配置快照各解决什么恢复问题？
