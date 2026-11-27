# CAN-215 910B2 历史报告的屋顶线为空，表里只有初代 Ascend910

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/remote/runner.py` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `perf`, `roofline`, `910B2` |
| 复核 | 2026-11-27。5 份历史报告已核对为空 |

## 现象

报告会算达到的带宽 `achievedBandwidthGBps`。屋顶线时间 `rooflineUs` 只在芯片名命中表时才有值。表里只有 `Ascend910: 1200.0`。注释写明这是初代 910 的 GM→UB 1.2 TB/s，未知芯片保持 null。

5 份 910B2 历史性能报告的 `analysis.rooflineUs` 都是空，并标成未采集。manifest 的 `chip` 通常是 `ascend910b` 或 `Ascend910B2`，对不上键 `Ascend910`。

## 证据

- `plugin/remote/runner.py` 第 66–70 行：`PEAK_BW_GBPS = {'Ascend910': 1200.0}`，注释说明不是 910B。
- 同文件第 1036–1048 行：`peak_bw = PEAK_BW_GBPS.get(str(manifest.get('chip', '')))`，`rooflineUs` 在 `peak_bw` 为空时为 null，`baselineUs` 置 `None`，`notCollected` 包含 `baselineUs`。
- 2026-11-27：5 份 910B2 历史性能报告的 `analysis.rooflineUs` 为空，标记为未采集。

## 影响

瓶颈分类仍然来自 msprof 占比。屋顶线在这 5 份 910B2 报告里没有数。摘要若只写「未采集」，读者会把它理解成 profiler 没采到，而不是表里没有该型号的带宽。

## 期望

没有该型号的带宽依据时，字段保持空，摘要写明缺值原因是「未配置该芯片带宽」。有对应型号的带宽依据之后再写入数值。初代 910 的 1200 继续只用于键 `Ascend910`。

## 复现

1. 用 `chip: Ascend910B2` 的 manifest 走分析路径。
2. 看 `rooflineUs` 为空、`achievedBandwidthGBps` 仍可能有值。
3. 对照 5 份历史 910B2 报告，`analysis.rooflineUs` 为空且标为未采集。

## 建议修复

- 保持全字符串匹配，避免 `Ascend910` 误匹配 `Ascend910B2`。
- `notCollected` 写明 `notInChipTable`，与 profiler 没有采到带宽区分开。
- 910B2 的带宽数字只有在带来源的条目落地后才写入 `PEAK_BW_GBPS`。

## 验收标准

- 910B2 报告的 `analysis.summary` 或 `notCollected` 说明屋顶线缺失是因为没有该芯片的峰值带宽。
- 没有任何路径把 1200 GB/s 填进 910B2 的 `rooflineUs`。
- 在该型号的带宽依据落地之前，表里不增加 910B2 的数值。

## 关联

仓库 CAN-114 的 `reference` / `baselineUs`。CAN-202。

CAN-006 已要求缺数据时报告空值和 notCollected。本条补缺值原因，保留已有缺值语义。

## 处置和验证

屋顶线缺参考带宽时报告对应原因，继续保留该型号的空值，未引入无依据的估计值。
