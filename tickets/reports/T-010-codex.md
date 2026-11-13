# T-010 完成报告

- 认领人：Codex；日期：2026-11-13
- 分支：`codex/tickets-t003-t014-20261113`；PR：未建；基线提交：`0acfb84`；本次提交：见分支最新提交

## 做了什么

主机驱动解析迭代次数，每次真实 launch 并同步，仅最终做一次精度判定、输出一行结果。`run_once.sh` 用稳定后的最后一次启动耗时估计采样预算；runner 默认请求 20 次，超过 1 ms 的算子按 20 ms 总预算降低次数，优先用实测值，旧包才按目标估计。`msprof` 汇总排除热身行并报告 min/avg/max，`runRecord` 记录请求数、实际数与依据。

## 验证记录

`pnpm test`：22 个文件、184 项通过。本地 runner 测试中 `sampleUs=10000` 使 20 次请求降为 2 次。真实 CANNLab ArgMaxProbe：`sampleUs=19.621`、`samplingBasis=measured-launch-wall-time`、实际 20 次；`msprof op_summary` 统计 20 行，排除 4 行热身，均值 3.40095 µs。精度仍 `correctness.ok=true`。

## 遗留问题

`sampleUs` 是主机启动加设备同步的墙钟耗时，用于保守预算；正式性能值仍仅来自 msprof。尚未在真实 >1 ms kernel 上测总时长比。
