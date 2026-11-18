# CAN-007 采样口径不一致：`runs` 20→15、`kernelTimeUs` 与 `sampleUs` 差 ~6%、无分阶段耗时

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | bug + enhancement |
| 优先级 | **P1** |
| 组件 | `canness-eval`（runRecord / analysis） |
| 首次发现 | 2026-11-18，Cummin 的 4 次 perf_fail 报告 |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `report`, `benchmark`, `comparability` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`runner.py` 删掉 `PROFILE_BUDGET_US` 的目标估计逻辑，`runs = args.runs` 固定；`samplingBasis` 改为常量 `fixed-requested-runs`，新增 `metricBasis: msprof-task-duration-us`、`warmupRuns`、`device`、`phaseTimingsMs{buildMs,accuracyMs,profileMs}`、`wallTimeMinusKernelUs`（墙钟减 msprof）、`opStatistic`。

**可比性判定**：`policy.ts` 的 `basis()` 把 host/toolchain/runs/samplingBasis/metricBasis/warmupRuns/device 编成指纹，变更即开新窗 —— 直接消除了「15 次 vs 20 次」造成的假变差。

**验证**：`practice-policy.test.ts`（口径变更重置）、`runner_diagnostics_test.py`（a measured slow launch preserves the requested sampling protocol）。

## 现象

同一次会话里 `runRecord.params` 的采样口径变过：

```json
{"runs":15,"requestedRuns":20,"samplingBasis":"target-estimate"}
{"runs":20,"requestedRuns":20,"samplingBasis":"measured-launch-wall-time"}
```

即"目标估计"阶段先按 15 次采样，之后才按 20 次。两次的统计量（avg/min/max 与
`kernelTimeUs`）因此不可严格比较。

同时计分口径与墙钟口径稳定地差 ~6%：

| 轮次 | `performance.kernelTimeUs`（msprof） | `runRecord.params.sampleUs`（单次墙钟） |
|---|---|---|
| 1 | 1231.4 | 1257.7 |
| 2 | 1240.1 | 1261.8 |
| 3 | 788.0 | 806.7 |
| 4 | 788.9 | 837.9 |

并且 `analysis` 只给整段 `Task Duration` 与两个比例（`aic_scalar_ratio`、
`aic_mte2_ratio`），没有分阶段（build / 精度 / profile）与 `op_statistic` 分块，
在"差 13 倍"这种量级上不足以定位。

## 期望

1. 采样口径在报告里显式可比：`runs` 变化时给出 `comparableWith: <上一次同口径轮次>`，
   或固定采样数；
2. 明确"计分用哪个数"并给出两者差值（`kernelTimeUs` vs `sampleUs`），或提供
   `metric: "msprof" | "wallTime"` 开关；
3. `analysis` 增补分阶段耗时与 msprof `op_statistic` 的主要行（至少 aiv/aic busy cycle、
   mte2/mte3 字节数），用于判断瓶颈归属。

## 影响

- 15/20 次的混用让我在"1240 vs 1231 是不是真变差"上做了错误归因（当时正好在判断
  int64 写法的收益，见 CAN-004 的消融表）；
- `sampleUs` 与 `kernelTimeUs` 的 6% 差在"贴着目标设 target"时可能决定过不过；
- 缺分阶段/字节数，我只能用 `aic_scalar_ratio 0.87 + MTE2 0.003` 反推"发射瓶颈"，
  这在复盘里是结论性的判断，但证据强度偏低。

## 复现

连续两轮 `run_evaluation`：一次在"目标估计"阶段（15 次），一次在"实测墙钟"阶段（20 次），
比对 `runRecord.params.runs` / `samplingBasis` / `sampleUs` 与 `performance.kernelTimeUs`。

## 建议修复

1. `runRecord.params` 增加 `metricBasis` 字段说明计分来源，并同时保留两条时间；
2. 固定 `runs`（或把"估计阶段"的样本数与主测量分开命名，如 `probeRuns`）；
3. `analysis.phases = {buildMs, accuracyMs, profileMs}`，`analysis.opStatistic` 附关键行。

## 验收标准

- 相邻两轮的 `runs`/`samplingBasis` 一致，或在报告中显式标注不可比；
- 报告同时呈现 msprof 与墙钟两条时间及其差值；
- `analysis` 含分阶段耗时，且 `op_statistic` 的关键列可达。

## 关联

CAN-004（假变差导致策略停机）、CAN-006（字段缺失）
