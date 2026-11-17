---
{
  "schema_version": 1,
  "id": "cannbench-aclrtmemcpy-budget-zeroes-score",
  "title": "CANNBench 的 api_statistic.csv 单行 aclrtMemcpy* Count > 5 才触发反作弊并整算子 0 分",
  "kind": "benchmark",
  "keywords": ["aclrtMemcpy", "aclrtMemcpyAsync", "Count > 5", "cpu_fallback_detected", "n_no_perf_pass", "aggregate_eq4", "zeroed_by_no_npu_perf", "compile_passed", "api_statistic.csv", "perf_strategy.py", "anti-cheat", "host copy", "scalar by value"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/src/kernel_eval/base/perf_strategy.py#L738-L759",
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

**结论**：`perf_strategy.py` 逐行解析 `api_statistic.csv`：对每个 `API Name` 以 `aclrtMemcpy` 开头的行，独立读取该行的 `Count`，只要该行 `Count > 5`（≥6）就设置 `cpu_fallback_detected=True`、`elapsed_us=0.0`，并给出 `excessive aclrtMemcpy (N > 5)`。计数口径是单行、单 API 名，不是整 case 求和：`aclrtMemcpy` 3 次加 `aclrtMemcpyAsync` 3 次不会触发，同一个 API 名 6 次才会。评分侧 `cann_scoring.py` 只把精度通过（`case.success`）且 `elapsed_us<=0` 且 `perf_collection_failed` 不为 True 的 case 计入 `n_no_perf_pass`；`aggregate_eq4` 仅在 `compile_passed` 且 `n_no_perf_pass > 0` 时把编译、功能、性能、bonus 全部置 0 并返回 `zeroed_by_no_npu_perf`。所以整算子清零的前提是编译通过、相关用例通过精度检查且无采集故障；不是任何一次 memcpy 超限就无条件清零。可行做法：shape/tiling/系数按值传 kernel，host 只做 shape 代数和 launch，不在 host 读回输出或做额外 H2D/D2H。

**核对方式**：读 `perf_strategy.py` 的逐行循环与 `cann_scoring.py` 的 `n_no_perf_pass`/`aggregate_eq4`；构造同一 API 名（如 `aclrtMemcpy`）每用例 6 次的 plugin，确认 `cpu_fallback_detected` 为真、`elapsed_us=0`、`n_no_perf_pass>0` 且 `zeroed_by_no_npu_perf=True`；再构造 `aclrtMemcpy` 3 次加 `aclrtMemcpyAsync` 3 次的对照，确认两行都 ≤5、不触发。正常实现应把 tiling 按值作为 kernel 参数传入，`api_statistic.csv` 中只剩 ≤1 次 tiling H2D/repeat。
