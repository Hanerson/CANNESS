# CAN-113 KB 缺 SwiGlu 条目，且现有 elementwise 性能结论与实测矛盾

| 字段 | 值 |
|---|---|
| 类型 | knowledge |
| 优先级 | P2 |
| 组件 | `canness-knowledge`（`plugin/knowledge_base/*`） |
| 首次发现 | 2026-11-19 09:14（`kb_search(operator_name="SwiGlu")` → 无条目） |
| 状态 | 未解决 |
| 标签 | `kb`, `benchmark`, `elementwise` |

## 现象

1. `kb_search({operator_name: "SwiGlu"})` → `no knowledge entry for SwiGlu`。
   于是"这个算子在 910B 上大概能跑多快、DMA 形态怎么选"只能靠猜。
2. 唯一相关的两条 elementwise 条目互相矛盾：
   - `Exp.md`：*"大 shape（8192²）已接近 HBM 带宽上限"*（对应 CANNESS 自家 kernel）；
   - `Gelu.md`：*"scalar 占比约 60%（20 us），vector 仅约 1 us；继续优化应减少 tile
     循环 / 同步次数"*。
   而本轮实测（同机、同 CANN，`tools/bench_compare.py`）：

   | 实现 | 8192×16384 fp16 |
   |---|---|
   | 我的 kernel（tile 16384，单缓冲） | 2199 us → 199 GB/s |
   | `torch_npu.npu_swiglu` | **508 us → 792 GB/s** |
   | torch `F.silu(x0)*x1`（fp32 中转） | 2506 us |

   即：手写 elementwise kernel 距离自家 ACLNN 还有 ~4×，而 KB 里没有这条"基线差"的
   量化事实，也没有"哪些形态在 910B 上是坑"的具体数字（多 burst 小 burst 会崩、
   拆分传输更慢、预取深度越大越慢）。
3. 性能优化需要的关键数据（roofline = 278 us、baseline = 748.86 us、
   `t_hw_us`/`baseline_perf_us` 的 20 条 case 值）其实**在检出目录里**
   （`ref`/`acceptance` 的 `tasks/metadata/910b2.json`），但 KB 与工具都不指向它，
   `analysis.baselineUs` 恒为 null。

## 影响

- 本轮 8 轮 A/B 实验里的"应该往哪调"全靠试；其中至少 3 轮（预取深度 2/4、
  拆分 4/16 笔传输）在有了 KB 结论后本可以直接跳过；
- 性能项占官方评分 0.5，缺基线与 roofline 等于半个评分维度没有反馈。

## 建议修复

1. 补一条 **benchmark** 条目：`910B elementwise 实测基线`（同机 `npu_exp` /
   `npu_swiglu` / torch 分解 / 手写 CANNESS kernel 四者的 us 与 GB/s，含 shape）；
2. 补一条 **troubleshooting** 条目：`910B elementwise 什么时候是 scalar-bound`，
   含判定方法（`aic_scalar_ratio` 与 `aic_mte2_ratio` 的组合）与实测的反直觉结论
   （多 burst 小 burst 崩、拆分传输更慢、深预取无效）；
3. 补一条 **contract** 条目：CANNBench 任务的 `cases` / `metadata`（`t_hw_us`、
   `baseline_perf_us`）在哪里取，如何据此设 `performance_target.target_us`；
4. `kb_search` 支持"没有该算子"时回退到 `operator_type` 级条目（例如
   `kind=implementation` + `elementwise`），而不是空结果。

## 验收标准

- `kb_search({operator_name: "SwiGlu"})` 至少返回 1 条（哪怕是"无专用条目，
  参见 elementwise 通用条目"）；
- 上述两张表进入 KB，且 `kb:validate` 通过；
- `run_evaluation` 的 report 里 `analysis.baselineUs` 非空（同机实测）。
