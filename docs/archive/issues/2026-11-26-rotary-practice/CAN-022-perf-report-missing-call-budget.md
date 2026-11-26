# CAN-022 性能报告只给"带宽/标量占比"，缺"调用预算"与 tiling 参数回显，导致定位方向错在前两轮

> 去重：本条扩展既有 **CAN-113**（KB 性能结论与实测矛盾）与仓库 **CAN-006**（报告字段为空），建议并入 CAN-113 并补入「每调用 ~1.7k cycles」实测。

| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | **P1** |
| 组件 | `canness-eval`（`analysis` 生成）/ `canness-generator`（`config.json`/`manifest.json`） |
| 首次发现 | 2026-11-25，ApplyRotaryPosEmb 第 1 轮 16.08 ms → 第 2 轮 1.88 ms 的定位过程 |
| 状态 | **open** |
| 标签 | `perf`, `analysis`, `observability`, `tiling` |

## 现象

第 1 轮报告给的是：

```
bottleneck: "scalar", aic_scalar_ratio 0.95, aic_mte2_ratio 0.001, achievedBandwidthGBps 8.35
```

这些数字能说明"卡在标量"，但**不能说明为什么卡**。真正的根因是"单次 AscendC Level-2 调用
≈1500–1800 个标量周期，与元素数无关"，我为此手工做了 4 组对照 kernel（纯拷贝 / 每行 3 次调用 /
每行 16 次调用 / tile 级大算子）才量出来，花掉两轮时间：

| 实验 | 时间 |
|---|---|
| 拷贝基线 8 KiB / 32 KiB / 48 KiB+双缓冲 | 792 / 224 / 198 µs |
| 每行 16 次调用（第 1 轮 kernel） | 16082 µs |
| 每行 3 次调用（对照） | 8454 µs |
| tile 级（每次 16384 元素） | 445 µs |

另外报告里 `runRecord.params` 只有 `blockDim / tileSize / blockLength / totalElements`，
**没有** kernel 实际用的 tiling（本轮是 `runRows`、每 run 调用数、cos/sin 窗口大小），
复现性能结论时得回读源码。

## 期望

1. 报告增加 `kernelBudget`（由 kernel 自报，或由生成器静态统计）：每个 block 的 Level-2 调用
   次数、每元素调用数、每调用平均元素数；
2. `runRecord.params` 回显 spec 的 `launch`（block_dim / tile_length）**以及** kernel 里由
   `CannessAttrs` 推导出的 tiling（可通过一个约定的 `CANNESS_TILING_REPORT` 输出行上报）；
3. `analysis` 增加一条判定：`perElementCalls > 0.1` 时提示"调用开销可能主导，优先加大每次调用
   的元素数"，而不是只写 "scalar"。

## 影响

- 前两轮把方向押在"算法/tile 大小"，实际瓶颈是 API 调用次数；
- 每个算子都要重做同一套对照实验，知识无法复用（本轮我把它写进了报告，但插件不采集）。

## 复现

1. 任一小 tile、多次 Level-2 调用的 kernel 跑 `run_evaluation`；
2. 看 `analysis`：只有 `scalar` 与带宽，没有调用计数；
3. 把 kernel 改成 tile 级（调用数降 10 倍）再跑，`aic_scalar_ratio` 从 0.95 → 0.79，
   但报告不会告诉你"剩下 0.79 里有多少是调用开销"。

## 建议修复

- `run_once.sh` 允许 kernel 打印一行 `CANNESS_TILING {...}`，runner 解析后进 `params`；
- `analysis` 增加"调用预算"章节（可从 `params` 或代码扫描得到）；
- 知识库补一条 `ascendc-call-overhead`（每调用 ~1.5k cycles 的实测事实），供后续算子直接引用。

## 验收标准

- 报告能直接回答"这个 kernel 每元素几次 API 调用、每次调用多少元素"；
- 同类算子的性能定位不需要再手搓对照 kernel；
- tiling 参数在报告里可见，且与 `config.json` 一致。

## 关联

CAN-018（另一个"插件不告诉用户关键事实"的例子）
