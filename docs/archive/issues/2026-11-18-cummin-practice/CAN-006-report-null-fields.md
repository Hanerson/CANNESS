# CAN-006 报告字段出现 `null` / `0` / `"unknown"`，且被下游当作事实使用

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P1** |
| 组件 | `canness-eval`（report / analysis） |
| 首次发现 | 2026-11-18，Cummin 的 4 次 perf_fail 报告 |
| 状态 | **大部分 fixed-in-src / blockDim 与 taskType 仍在** |
| 标签 | `report`, `observability` |

## 处理情况（2026-11-18 16:20 复核）

**已改**：`runner.py` 抽出 `inspect_environment()`，`record()` 用 `args.environment_facts['toolchain']` 写入 `runRecord.toolchain`（不再 `CANN (version unknown)`）；`aicoreTimeUs == 0` 归一为 `None`；`build_profile` 汇总 `notCollected`（analysis 顶层与 `op.*` 两级）；`profile_from_csv` 增加 `opStatistic` 证据行。

**验证**：`runner_diagnostics_test.py` 覆盖「全零流水线指标 → bottleneck unknown」「AIV 指标不依赖 cube 计数器」两例。

**未改**：`analysis.op.blockDim` 仍取自 msprof CSV 的 `blockDim` 列，列缺失时依旧 `null`（建议回填 spec 的 `launch.block_dim`）；`taskType` 仍是 CSV 字面（本次为 `AI_CORE`，而 kernel 是 `KERNEL_TYPE_AIV_ONLY`），未区分 AIV/AIC。

## 现象

同一次评测里，`preflight_evaluation({remote:true})` 明明探测到了完整工具链：

```json
{"toolchain":"2026-04-25T15:46:25+08:00 clang version 15.0.5 (clang-5c68a1cb1231 flang-5c68a1cb1231)",
 "setEnv":"/home/developer/Ascend/ascend-toolkit/set_env.sh",
 "compiler":"/home/developer/Ascend/cann-9.0.0/bin/bisheng",
 "msprof":"/home/developer/Ascend/cann-9.0.0/bin/msprof"}
```

但 `runRecord` 里：

```json
{"toolchain":"CANN (version unknown)"}
```

同一份报告里还有：

| 字段 | 实际值 | 问题 |
|---|---|---|
| `analysis.op.blockDim` | `null` | 想确认"40 个 block 里只有 16 个在干活"只能靠手算 |
| `analysis.op.aicoreTimeUs` | `0`（而 `taskDurationUs` = 788.9） | 0 与 788 并存，整组比例的可信度被打折 |
| `analysis.op.taskType` | `AI_CORE` | 实际是 `KERNEL_TYPE_AIV_ONLY`（AIV），名称容易误读 |
| `analysis.rooflineUs` / `baselineUs` | `null` | 无法判断离带宽上限多远 |

## 期望

- 凡"未采集"与"真值为 0"要区分：用 `null` + `notCollected: [...]`，或显式 `"unknown"` 并说明原因；
- `toolchain` 与 preflight 探测结果一致（同一探测函数）；
- `blockDim`、`taskType` 取自 msprof 的实际行，而不是留空。

## 影响

- `toolchain: unknown` 让"这条数字是哪个 CANN 跑出来的"无法沉淀为 KB 的 `reproduced` 证据；
- `blockDim: null` 直接挡住"并行度是否吃满"的判断 —— 这正是我这次花最多时间排查的方向；
- `aicoreTimeUs: 0` 会让人误以为 kernel 没执行（而 `taskDurationUs` 又很正常）。

## 复现

任意一次 `run_evaluation`（status 为 `perf_fail`/`pass`），对同一环境先跑
`preflight_evaluation({remote:true})`，再比对 `results.json` 的
`runRecord.toolchain` 与 `analysis.op.blockDim`。

## 建议修复

1. 复用 preflight 的探测结果写入 `runRecord.toolchain`（含 `setEnv` 路径）；
2. `blockDim` 从 runner 的启动参数回填（`CANNESS_BLOCK_DIM` 已知，无需依赖 msprof）；
3. `aicoreTimeUs` 若不可得则给 `null`，不要给 0；
4. `taskType` 用 runner 已知的 task type（AIV/AIC）覆盖，或在报告里同时给出 `kernelTaskType`。

## 验收标准

- 同一环境的 `preflight` 与 `runRecord` 的 `toolchain` 字符串一致；
- `blockDim` 非 null，且等于 spec 的 `launch.block_dim`；
- 所有 `null` 字段旁边有 `notCollected` 说明。

## 关联

CAN-007（采样口径）
