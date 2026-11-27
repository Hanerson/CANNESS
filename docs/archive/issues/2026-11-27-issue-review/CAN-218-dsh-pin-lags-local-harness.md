# CAN-218 记录插件 peer 0.2.1-rc.3 与本机 dsh 0.2.2-rc.2 的组合

| 字段 | 值 |
|---|---|
| 类型 | 验证 |
| 优先级 | **P3** |
| 组件 | `plugin/package.json`、本机 `deepseek-harness` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **verified** |
| 标签 | `dsh`, `dependencies`, `verification` |
| 复核 | 2026-11-27。改为兼容性验证。没有已复现的兼容性故障 |

## 现象

插件 `engines.dsh` 是 `>=0.2.0 <0.3.0`。peer 与锁精确钉住 `0.2.1-rc.3`。本机 harness 根版本是 `0.2.2-rc.2`。静态抽查显示插件用到的事件在本机 harness 中仍有相同的接口形状。本条的目标是把该组合验证并记录下来。当前没有已复现的兼容性故障。

| 包 | 插件 peer / 锁 | 本机 harness |
|---|---|---|
| 根 / `@deepseek-ai/dsh-tools`、`dsh-agent`、`dsh-llm`、`dsh-credentials` | `0.2.1-rc.3` | `0.2.2-rc.2` |
| `@deepseek-ai/cordis` | `4.0.5` | `vendor/cordis` `4.1.0` |
| `@deepseek-ai/schemastery` | `3.18.5` | `vendor/schemastery` `3.19.0` |

本机路径是 `本机 dsh 源码检出`。`engines.dsh` 决定能否加载，范围包含 `0.2.2-rc.2`。`@deepseek-ai/dsh-*` 的 peer 不参与这道运行时门禁。

volatile 配置的读取见 [CAN-225](CAN-225-cannlab-token-ref-dropped.md)。loop 与 eval 的预算字段见 [CAN-230](CAN-230-loop-eval-budget-split.md)。这两处是插件自己的配置读取，不是本条的 harness 故障。

## 证据

- `plugin/package.json` 的 `engines.dsh`、`peerDependencies`、`devDependencies`。
- 本机 `package.json` 根版本 `0.2.2-rc.2`。`vendor/cordis` 为 `4.1.0`，`vendor/schemastery` 为 `3.19.0`。
- 抽查：`defineTool` 仍导出；`Schema.role` 仍在；`PreStepDecision` 仍是 `{ kind: 'enter', messages, startsRequestSeries? }`；`agent/turn-stopping` 仍在。`plugin/src/loop.ts` 依赖的形状还在。
- 2026-11-27 的类型检查使用插件仓库现有依赖并已通过。本机 harness 组合只做了接口抽查，组合类型检查、完整安装和运行验证均待执行。
- 本机检出比 tag `dsh-v0.2.2-rc.2` 又多了提交（`dsh-v0.2.2-rc.2-166-ge8f7b93a34`）。各包的 `version` 字段仍是 `0.2.2-rc.2`。

## 影响

版本差异仍待实际集成验证。现有证据覆盖插件钉扎依赖下的类型检查，以及本机 harness 的接口抽查。

## 期望

把「宿主 0.2.2-rc.2 + 插件 peer 0.2.1-rc.3 + cordis 4.1.0 + schemastery 3.19.0」的类型检查和一次完整安装运行记在本条或 CI 日志里。有复现的兼容性故障时再改成缺陷。

## 复现

1. 读两边的 `package.json` 版本。
2. 在插件目录看锁文件里的 `@deepseek-ai/cordis` 是否仍为 4.0.5。
3. 对照 `loop.ts` 与本机 `PreStepDecision`。
4. 用仓库现有依赖执行插件类型检查，作为基线。另用目标 harness 组合执行类型检查与运行验证。

## 建议修复

- 增加一次对照记录：用本机 harness 安装插件并跑通预检或类型检查之外的启动路径。
- peer 版本可以保持 0.2.1-rc.3，直到记录写明剩余差异和原因。不要把 CAN-225、CAN-230 算进这次宿主升级。

## 验收标准

- 分别记录插件钉扎依赖基线的类型检查结果，以及本机 `0.2.2-rc.2` harness 与其 Cordis、Schemastery 组合的类型检查结果。
- 使用上述本机 harness 完整安装插件，记录一次实际启动和预检的结果。任一步尚未执行时，本条保持开放。
- 没有新的兼容性故障被复现时，不把本条标成缺陷。

## 关联

CAN-225、CAN-230。设置卡依赖的 client 包同样钉在 0.2.1-rc.3，一并记在验证记录里。

## 处置和验证

已验证本机 dsh 0.2.2-rc.2 的隔离离线源目录安装和 Web 启动，以及 Cordis 4.1.0、Schemastery 3.19.0 组合的类型检查和本地 preflight。未变更钉扎范围。
