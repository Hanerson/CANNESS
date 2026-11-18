# 2026-11-18 Cummin 实践问题归档

本轮实现 Cummin 算子（Ascend 910B2 / CANN 9.0.0）时记录 19 条实践问题，其中 **16 条已修复并验证**，
归档于此；**3 条仍未闭环**，跟踪在仓库之外的桌面 `canness-issues/`（属 dsh 侧或待修）。

- 修复说明（做了什么、怎么验证）：[docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)
- 契约细节：[direct-launch.md](../../../contracts/direct-launch.md)、[local-validation.md](../../../contracts/local-validation.md)
- 同批工作流复盘：[WORKFLOW-REVIEW.md](WORKFLOW-REVIEW.md)
- 文档索引：[docs/README.md](../../../README.md) · [历史归档](../README.md)

## 已归档（16）

| ID | 优先级 | 标题 | 结论 |
|---|---|---|---|
| [CAN-001](CAN-001-sandbox-acl-vs-policy.md) | P1（原 P0） | 沙箱声明 workspace-write 但 shell 写不进工作区 | icacls 证实授权只在根上；改为产物=会话 cwd、删除嵌套目录（规避式修复），DSH 侧限制移交 |
| [CAN-002](CAN-002-workspace-follow-cwd.md) | P2 | workspace 跟随 cwd（原描述已更正） | 修正原描述；改为 `session.cwd ?? header.cwd`，残留并入 CAN-017 |
| [CAN-003](CAN-003-reset-drops-layers.md) | P0 | `submit_spec(reset)` 不携带四层源码 | 同契约续代复制四层 + golden + provenance；返回 `carriedLayers`/`needsLayers` |
| [CAN-004](CAN-004-policy-deadlock-pendingstage.md) | P0 | `negativeStreak`/`force`/`reset` 死锁 | `blockedBy`/`stopReason`/`policyEvidence`；有界 force；协议变更另开窗 |
| [CAN-005](CAN-005-no-compile-only-probe.md) | P1 | 缺 compile-only / 远端只读通道 | `compile_only` 独立诊断；`readRoots` + `readFileWithin` + sha256 |
| [CAN-006](CAN-006-report-null-fields.md) | P1 | 报告字段 `null`/`0`/`unknown` | 共享环境探测；`blockDim` 回填并标来源；`kernelTaskType` 读源码声明；`notCollected` |
| [CAN-007](CAN-007-sampling-basis-inconsistent.md) | P1 | 采样口径漂移、缺分阶段耗时 | 固定请求采样数；`metricBasis`/`wallTimeMinusKernelUs`/`phaseTimingsMs`/`opStatistic` |
| [CAN-009](CAN-009-layers-never-compiled.md) | P1 | 四层里只有 kernel 被编译 | 方案 B：manifest 标 `compiledLayers`/`documentedOnlyLayers` + direct-launch 契约 |
| [CAN-010](CAN-010-attrs-order-unstable.md) | P1 | attrs 顺序不稳定 | `CannessAttrs::find(name)`；自检 kernel 改按名读；文档声明顺序不保证 |
| [CAN-011](CAN-011-export-signature-and-validation.md) | P1 | 导出签名泄漏、产物未验证 | `interface.attrs` 选公开参数；wrapper/signature 入哈希；`unverified` 标注；`validate_submission` |
| [CAN-012](CAN-012-golden-api-elementwise.md) | P2 | golden 逐元素调用 | `CANNESS_GOLDEN_BATCH` 批量回调；原行为兼容 |
| [CAN-013](CAN-013-build-log-noise.md) | P2 | 39 行 `cce_global` 噪音 | `main.cpp` 编译加 `-Wno-ignored-attributes` |
| [CAN-014](CAN-014-remote-artifacts-tmp.md) | P2 | 远端工件在 `/tmp`、读取范围窄 | `artifactsPersistent`/`artifactWarning`；历史代可取回；sha256 |
| [CAN-015](CAN-015-no-local-prevalidation.md) | P2 | 缺本地预验证 | `check:golden` + `check:kernel` + 算法模拟模板；不谎报目标端验证 |
| [CAN-016](CAN-016-lib-templates-mixed-contract.md) | P1 | lib/templates 双源 → 混合契约 | 契约同时记录代码哈希与模板哈希；`staleBuild`/`warnings` |
| [CAN-017](CAN-017-shared-budget-ownership.md) | P1 | 预算/归属共享、被拒不落盘 | `budget`/`ownerSession` 进报告；`lastBlocked` 落盘；归属守卫 |

## 仍开放（3，不在本仓库跟踪）

| ID | 优先级 | 标题 | 现状 |
|---|---|---|---|
| CAN-008 | P1 | 跨工具被派发到 `write` 的 schema | 插件侧已完成单层更新；派发归 dsh，未修 |
| CAN-018 | P0 | 本地 kernel 检查误报且默认拦截评测 | `check-kernel.mjs` 缺 `-include canness_tiling.h`；`run_evaluation` 无条件先跑它 |
| CAN-019 | P2 | 未加载 canness 的 profile 下只报 `unknown tool` | 原归因（插件重建）已撤回；需错误带 profile/bundles 诊断 |

## 归档口径

- **归档条件**：源码已改、门禁通过、且在 live `lib` 渲染出的包里可观察（不采信"源码改了但未生效"）。
- **保留原貌**：每份文件保留当时的现象、证据原文（含真实报错）与建议修复，只在标题下加归档说明。
- **证据等级**：文中 `reported` / `source_inspection` / 复测三类保持原标注，不因归档升级证据等级。
- **未完成的验证**：Cummin 包在本轮**未做真机复测**（远端额度用尽），tickets 与修复说明里均按"未复测"记录。
