# CAN-109 msprof 产物落在不可猜的临时目录：`fetch_remote_file` 取不到，指令级归因做不了

| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | P1 |
| 组件 | `remote/runner.py`（`profile_executable` / `profile_from_csv`）、`fetch_remote_file` |
| 首次发现 | 2026-11-19 09:45（想查 81% scalar 到底花在哪） |
| 状态 | 未解决 |
| 标签 | `profiling`, `artifacts`, `diagnostics` |

## 现象

官方 `run_evaluation` 给出的分析只有三个抓取到的比率：

```text
aic_scalar_ratio 0.808, aic_mte2_ratio 0.038, aic_mac_ratio null
achievedBandwidthGBps 199.0（roofline 278 us ≈ 1.45 TB/s）
```

结论只有"scalar 是瓶颈"。要看逐行/逐指令信息就得读 msprof 的 CSV，但：

- runner 把输出写在**包目录里**：`outdir = package / f'.msprof-{uuid4().hex}'`
  （`runner.py::profile_executable`），目录名每次都不同；
- `results.json` 里没有这些路径（只有 `runRecord.params.opStatistic: []` 之类）；
- `fetch_remote_file` 只允许 `<outbox>` 与当前代 `<inbox>/<generationId>`；
- 包目录在 `<inbox>/<generationId>`，说明**理论上**能读，但 `.msprof-<32 hex>` 猜不到；
  而且 `artifactWarning` 提示产物在临时目录，随时可能被清。

## 影响

- 本轮性能从 3.2 ms 优化到 2.0 ms 后卡住，剩下的 4× 差距无法定位到具体指令
  （我做了 8 轮 A/B：DMA 形态、预取深度 1/2/4、拆分传输、tile 大小、数学强度，
  结论只有"数学占 18%、每 tile 开销主导"，再往下必须看 profile）；
- 官方评分的一半（`wp = 0.5`）直接依赖这个数，取不到等于摸黑调参；
- 属于"数据可得性"问题，不是算子问题。

## 我用的临时补丁

没有可用补丁。只能退化成"黑箱 A/B"：把 kernel 做成多 `mode`（`MUL_ONLY`、
预取深度、拆分传输），用 `validate_submission` 的 wall-clock 对比。

## 建议修复

1. runner 把 `mindstudio_profiler_output/*.csv`（`op_summary`、`op_statistic`、
   `api_statistic`）**复制到 `<outbox>/<generationId>/`**；
2. `results.json` 增加 `artifacts: {opSummary: <abs path>, …}`；
3. `fetch_remote_file` 允许读 `<outbox>/**` 任意文件（当前只允许根级/固定名），
   或提供 `list_remote_files(dir)`；
4. `run_evaluation` 增加 `keepArtifacts: true`（包目录保留 + 路径回传）。

## 验收标准

- 一次 `run_evaluation` 之后，`results.json.artifacts.opSummary` 指向一个可
  `fetch_remote_file` 到的绝对路径；
- 用户能据此自己算 `aic_*_time` 或导出 `PipeUtilization`；
- `fetch_remote_file` 对 outbox 下任意文件都成功（含子目录）。
