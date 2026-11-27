# CAN-224 零匹配时 `summary_durations` 会把混合任务的时长平均进去

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P1** |
| 组件 | `plugin/remote/runner.py` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `msprof`, `perf` |
| 复核 | 2026-11-27。优先修。历史 CSV 的回退均值与筛选均值相同 |

## 现象

性能时间来自 op_summary CSV 里匹配算子名的 `Task Duration(us)` 的平均。匹配名用的是 manifest 的 `operatorName`。契约内核入口是 `canness_kernel`。任何一个 CSV 都没有匹配行时，`any_match` 为假，函数改用该文件的全部行。

2026-11-27 回放了 5 份真实 profiler CSV。每份 24 行，Op Name 全是 `canness_kernel`，与 manifest 的 `ApplyRotaryPosEmb` 零匹配。因为采样里只有目标内核，按全部行回退得到的均值，和按内核名 `canness_kernel` 筛选得到的均值相同。这 5 份历史结果的数值没有因此偏离目标内核的时长。

合成的混合 CSV 能走出另一条路径：无关的 10 µs 与 50 µs 两行会被平均成 30 µs。零匹配时，混合任务会被当成目标耗时。

## 证据

- `plugin/remote/runner.py` 第 548–564 行：`summary_durations` 在 `any_match` 为假时 `use = file_rows`。
- 第 530–533 行：`row_matches` 要求 `opName` 或 `opType` 等于算子名，或以前缀相等。
- `plugin/src/package-files.ts` 第 609 行把 `operatorName: spec.operator_name` 写入 manifest。内核符号是 `canness_kernel`。
- 5 份真实 CSV：每份 24 行，Op Name 均为 `canness_kernel`，与 `ApplyRotaryPosEmb` 零匹配。回退均值等于按 `canness_kernel` 筛选的均值。
- 合成 CSV：两行无关任务，时长 10 µs 和 50 µs，零匹配时平均为 30 µs。
- 第 1036–1038 行用 `kernel_time_us` 计算 `achievedBandwidthGBps`。

## 影响

历史的 5 份 ApplyRotary 采样只含 `canness_kernel`，回退没有改写那几次的时长。匹配集合若不包含实际内核名，下一次 CSV 里同时有目标内核和其他任务时，零匹配会把混合时长写成 `kernelTimeUs`。带宽使用同一个时间。

## 期望

匹配实际内核名，至少包含 `canness_kernel`。规格名与内核名不同时，manifest 把两者都写上。零匹配时不把混合任务的平均时长当作目标耗时：`kernelTimeUs` 为空，`status` 为 `error`，摘要列出见到的 Op Name。

## 复现

1. 回放 5 份历史 CSV，确认 Op Name 只有 `canness_kernel`，回退均值与按该名筛选的均值相同。
2. 用合成 CSV：行分别为无关任务 10 µs 和 50 µs，manifest 算子名与这两行都不匹配。看当前平均为 30 µs。
3. 再准备一份同时含 `canness_kernel` 与其他任务、且算子名写的是 `ApplyRotaryPosEmb` 的 CSV，确认当前因零匹配走全表。

## 建议修复

- 匹配集合为 `[operatorName, 'canness_kernel', 导出内核符号]`。
- `any_match` 为假时返回错误和看到的名字列表，不使用全表平均。
- 单测使用合成混合 CSV，断言零匹配时不会得到 30 µs。另用只含 `canness_kernel` 的 CSV，断言规格名为 `ApplyRotaryPosEmb` 时仍计入该内核。

## 验收标准

- 匹配实际内核名：规格名为 `ApplyRotaryPosEmb`、Op Name 为 `canness_kernel` 时，时长只来自该内核。
- 零匹配时不把混合任务算作目标耗时。合成的 10 µs 与 50 µs 不会平均成 `kernelTimeUs = 30`。
- 历史 5 份只含 `canness_kernel` 的 CSV 在修复后得到与当时筛选均值相同的时长。

## 关联

CAN-215、CAN-222。

## 处置和验证

兼容真实 canness_kernel 名，只计算匹配行。零匹配报告错误。历史 CSV 证据与混合行回归均纳入。 [历史 CSV 摘录](evidence/op-summary.csv)
