# T-007 完成报告

- 认领人：Codex；日期：2026-11-13
- 分支：`codex/tickets-t003-t014-20261113`；PR：未建；基线提交：`0acfb84`；本次提交：见分支最新提交

## 做了什么

审查 AIV 指标优先级、全零比率归类和带宽 / roofline 字段；没有权威 910B 峰值带宽时保留 `rooflineUs:null`。

## 验证记录

`pnpm test`：22 个文件、184 项通过。真实 ArgMaxProbe 的 `msprof` 报告：3.40095 µs、20 行；72 字节输入输出，`achievedBandwidthGBps=0.021170555286023025`，与手算 `72/(3.40095×1000)` 一致（相对误差 0）。AIC 比率全零时 `bottleneck=unknown`，`rooflineUs=null`、`baselineUs=null`，没有把向量算子误判为 Cube。

## 遗留问题

该 CANNLab profile 的管线指标未采集到非零值；有值的 AIV CSV 归类由本地测试验证。
