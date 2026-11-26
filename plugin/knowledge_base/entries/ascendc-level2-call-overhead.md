---
{"schema_version":1,"id":"ascendc-level2-call-overhead","title":"Ascend910B2 上 ApplyRotaryPosEmb 的 Level-2 调用预算实测","kind":"troubleshooting","operator":"ApplyRotaryPosEmb","hardware":["Ascend910B2"],"cann_versions":["9.2.1"],"dtypes":["float16"],"keywords":["Level-2","scalar","call budget","tiling","Cast","CANNESS_TILING_REPORT","msprof"],"evidence":"reported","sources":[{"ref":"ApplyRotaryPosEmb practice report, 2026-11-25, sections 0-A and 4; CAN-022"}]}
---

ApplyRotaryPosEmb 实践报告在 Ascend910B2 和 CANN 9.2.1 上比较了逐行和分块实现。fp16 官方用例 1 使用 48 个 AIV block，输入形状为 `[16,512,16,128]`。逐行实现每行 16 次 Level-2 调用，耗时约 16.08 ms，msprof 标量时间占比约 95%。每行 3 次调用的对照耗时约 8.45 ms。把多个行聚合到一个 tile 并复用 cos/sin 窗口后的实现耗时约 1.65 ms。

实践报告根据对照实验估算每次调用约 600–1800 个标量周期，其中第 2 轮估算约 1700 周期。这个估算依赖该 kernel 的 API 组合、tiling、硬件和工具链。遇到类似的高标量占比时，记录每个 block 的 Level-2 调用次数、工作元素数和调用实际处理的元素总数，再比较调整 tile 前后的调用预算和 msprof 数据。同一算子的不同实现也应使用相同的元素口径。
