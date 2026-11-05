# Exp（CANNBench L1 / Elementwise）

单输入逐元素指数：`y = exp((x * scale + shift) * ln(base))`；`base <= 0` 时用自然底数
（`ln(e) = 1`，等价于把 logBase 固定 1.0）。fp16 / bf16 / fp32 三种输入，20 个公开用例
（含 1D~5D、质数非对齐 shape、±Inf、NaN、fp16 边界 ±65504）。

## 契约要点

- attrs：`base`（默认 -1.0，≤0 表示自然底数）、`scale`（1.0）、`shift`（0.0）。
- 输出与输入同 shape、同 dtype、**必须 contiguous**。
- 精度阈值（MERE < thr，MARE < 10×thr）：fp16 `2^-10`、bf16 `2^-7`、fp32 `2^-13`。
- 特殊值按 IEEE：NaN→NaN，+Inf→Inf，-Inf→0；fp16 上溢到 Inf 与 golden 一致。

## 已验证实现（AscendC direct launch，910C 实测）

- host 侧把 `ln(base)` 折进一次乘法：`t = x*scale + shift; t *= logBase; y = Exp(t)`。
- kernel：`Cast(fp32) → Muls(scale) → Adds(shift) → Muls(logBase) → Exp → Cast(CAST_RINT)`；
  float 输入直接在同一 obuf 上算，不需要临时 tile。
- tiling：`tile = UB / (4 + 4/elemsize)`，32B 对齐；`blockDim = min(AIV 核数, ceil(N/1024))`；
  2 个 in + 2 个 out 队列 + 1 个 fp32 临时 tile。尾部用 `DataCopyPad`。
- 结果（官方 cann-bench 评测器，910C / CANN 9.0.0）：20/20 通过，score **65.41**，
  平均加速比 1.05×，最大 MARE `9.2e-4`（fp16 阈值 9.8e-3）。
  case 1（1M fp16）kernel 5.4 µs（baseline 4.1 µs）。

## 已知性能瓶颈

每 tile 串行 `MTE2 → V → MTE3`，TQue depth=2 没有真正预取。小 shape 明显吃亏
（case 1 比 baseline 慢 30%）。第二轮应做双缓冲：先发下一 tile 的 `DataCopyPad`，
再算当前 tile，最后统一 `FreeTensor`。大 shape（8192²）已接近 HBM 带宽上限。

## 参考

- 任务：`cann-bench/tasks/level1/exp/`（`proto.yaml` / `golden.py` / `cases.yaml` / `desc.md`）。
- 对比实现：`examples/triton_ascend_cann_example/cann_bench/exp.py`（Triton-Ascend 版本，
  思路相同，同样把 `log(base)` 折进 kernel 参数）。
