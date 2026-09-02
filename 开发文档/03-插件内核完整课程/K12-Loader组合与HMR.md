# K12：Loader、声明式组合与 HMR 原子替换

## 这一课解决什么

内核 API 可以手动 `ctx.plugin()`，但产品需要从配置加载插件组、解析模块导出、观察文件变化并替换运行世代。HMR 最大的风险是“先卸载旧，再发现新模块坏了”，导致原本工作的服务被一次编辑永久打断。

本课学习完整语义；产品首版可以不默认开启 watcher，但 Loader/HMR 的行为不能从核心设计中删掉。

## Loader 职责

- 解析声明式条目：id/name/config/disabled/group；
- 加载 ESM 模块并规范化导出；
- 将配置 schema、inject metadata 和 plugin definition 交给 Registry；
- 维护配置条目与运行实例映射；
- 更新、启停、重排和组级释放；
- HMR 发现变更、构造新世代、原子切换；
- 给出可诊断的加载错误，不泄露半成品。

## HMR 事务

理想顺序取决于同名服务是否允许暂时双持有。你需要设计 staging：

1. 读取新模块并验证导出/配置；
2. 在私有或隔离 staging Context 中完成可提前完成的 setup；
3. 到达切换屏障；
4. 关闭旧实例新工作并释放冲突能力；
5. 发布新世代；
6. 任何失败按差异账本定义保留/恢复旧世代。

若无法做到真正零停机，必须明确“失败保留旧实例”和“成功切换短暂不可用窗口”，不能伪称原子。

## 功能合同

- MUST：配置 entry id 是稳定身份，不能只用数组位置；
- MUST：模块导出规范化确定，default/named 冲突明确；
- MUST：无效新模块在卸载旧实例前尽早失败；
- MUST：新 setup 失败不留下服务、监听器或 watcher；
- MUST：旧 disposer 不能撤销新世代注册；
- MUST：连续文件事件合并/串行，避免多次交错 HMR；
- MUST：group disable/dispose 等待所有成员停稳；
- MUST：Loader 自身 dispose 先停止 watcher/新加载，再排空在途事务；
- MUST：加载错误带 entry/module/phase/cause；
- SHOULD：已知不可热替换的插件可以声明 full restart required。

## 你先做的设计题

1. staging plugin 需要访问真实外部服务时，如何避免提前产生副作用？
2. 同名 service 的旧/新 provider 不能共存，切换怎样保持可恢复？
3. 模块加载成功、apply 失败，旧实例应否继续？怎样证明没有混合世代？
4. 文件保存常产生多次 watcher event，如何去抖又不丢最后版本？

## 实现任务

1. 定义 LoaderConfigEntry 和稳定 entry id；
2. 实现 ESM export normalization；
3. 实现 group/disabled/start/stop/update；
4. 建立每 entry 串行更新队列或 generation controller；
5. 实现 HMR staging/cutover/rollback 策略；
6. 实现 watcher 抽象，测试用 fake watcher；
7. 实现 Loader dispose 的完全停稳；
8. 写 HMR 能力与限制文档。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 正常配置加载 | entry 与 Fiber 映射稳定 |
| 模块不存在/导出非法 | 旧实例不受影响，错误可定位 |
| 配置非法 | apply 前失败 |
| 新 apply 失败 | 新世代回滚，旧世代按合同保留/恢复 |
| 成功 HMR | 只一个权威世代对外可见 |
| 旧 disposer 晚到 | 不删除新服务 |
| watcher burst A/B/C | 最终 C，事务不交错 |
| update 与 disable 竞争 | 终态确定，无幽灵实例 |
| group dispose | 所有成员停稳，组不可再接纳 |
| Loader dispose 中有在途 import | 取消/等待后完全停稳 |
| observer 抛错 | 不破坏 entry/实例映射 |

## 源码复盘

- Cordis composition/HMR 教程；
- [`vendor/cordis/src/registry.ts`](../../deepseek-harness/vendor/cordis/src/registry.ts) 与 Fiber update；
- DSH Typert loader、boot/app-boot 和插件 inventory 作为产品级参考；
- 上游 HMR 测试中“失败保留”和 disposer 身份场景。

## 完成标准

- fake watcher 的 burst/竞争测试稳定；
- 失败 HMR 无能力泄漏；
- 文档明确是否零停机、回滚能保证到什么程度；
- Loader dispose 后无 watcher/import/update 任务。

## 复盘问题

1. 原子替换的“原子”对哪个观察者成立？
2. 为什么 HMR 依赖 K01 的精确 disposer？
3. 哪些副作用无法可靠 staging，应该要求进程重启？
