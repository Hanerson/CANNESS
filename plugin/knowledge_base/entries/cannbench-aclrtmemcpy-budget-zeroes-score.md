---
{
  "schema_version": 1,
  "id": "cannbench-aclrtmemcpy-budget-zeroes-score",
  "title": "CANNBench 每用例 aclrtMemcpy* 超过 5 次触发 CPU-fallback 反作弊，整算子 0 分",
  "kind": "benchmark",
  "keywords": ["aclrtMemcpy", "cpu_fallback_detected", "n_no_perf_pass", "aggregate_eq4", "api_statistic.csv", "perf_strategy.py", "anti-cheat", "host copy", "scalar by value"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/base/perf_strategy.py#L735-L759",
      "sha256": "4cd5d7b41615e95725028c45d2a4795eb5834a632e95c5f789fb924598a97e70"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/benches/cann_scoring.py#L544-L560",
      "sha256": "8ba8f051006bce9729eda47d1ce82c9d7ac52f0333caa8711020617f64c8c8cb"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/benches/cann_scoring.py#L407-L422",
      "sha256": "8ba8f051006bce9729eda47d1ce82c9d7ac52f0333caa8711020617f64c8c8cb"
    }
  ]
}
---

**适用条件**：CANNBench 提交的任意算子，profiler 产出 `api_statistic.csv`，plugin/host 侧准备用 `aclrtMemcpy*` 搬运中间结果或标量参数时。

**结论**：`perf_strategy.py` 解析 `api_statistic.csv`，对 `API Name` 以 `aclrtMemcpy` 开头的行取 `Count`；超过 5 次（≥6 次）就设置 `cpu_fallback_detected=True`、`elapsed_us=0.0`，并给出 `excessive aclrtMemcpy (N > 5)`。评分时 `cann_scoring.py` 把 `elapsed_us<=0` 且 `perf_collection_failed` 不为 True 的精度通过 case 计入 `n_no_perf_pass`；`aggregate_eq4` 只要看到 `n_no_perf_pass>0`，就把编译、功能、性能、bonus 全部置 0 并返回 `zeroed_by_no_npu_perf`。所以这不是单 case 扣分，而是整算子 0 分。可行做法：shape/tiling/系数按值传 kernel，host 只做 shape 代数和 launch，不在 host 读回输出或做额外 H2D/D2H。

**核对方式**：读 `perf_strategy.py` 的 `api_statistic.csv` 分支与 `cann_scoring.py` 的 `n_no_perf_pass` 聚合；在 NPU 上构造一个每用例 6 次 `aclrtMemcpy` 的 plugin，确认 `perf_result.metadata["cpu_fallback_detected"]` 为真且 `total_score` 为 0；正常实现应把 tiling 按值作为 kernel 参数传入，`api_statistic.csv` 中只剩 ≤1 次 tiling H2D/repeat。
