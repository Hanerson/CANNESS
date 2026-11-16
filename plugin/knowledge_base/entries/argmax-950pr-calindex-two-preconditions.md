---
{
  "schema_version": 1,
  "id": "argmax-950pr-calindex-two-preconditions",
  "title": "950PR 上 ReduceMax(calIndex) 可用，但仅限单 chunk 且最大值高于 -FLT_MAX 种子",
  "kind": "troubleshooting",
  "operator": "ArgMax",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16", "int32", "int64"],
  "layouts": ["contiguous"],
  "keywords": ["calIndex", "ReduceMax", "GetMinValue", "-FLT_MAX", "all -inf", "smoke-04", "lane order", "chunk", "首个下标"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/ArgMax.zip!csrc/ops/arg_max/op_kernel/arg_max_kernel.cpp#L1697-L1766",
      "sha256": "41770bf8d9be241320092c5f56ca3ffac092301e7868b8cbe7675acdd34bfc55"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/ArgMax.zip!csrc/ops/arg_max/op_kernel/arg_max_kernel.cpp#L51-L68",
      "sha256": "41770bf8d9be241320092c5f56ca3ffac092301e7868b8cbe7675acdd34bfc55"
    }
  ]
}
---

**适用条件**：950PR、`ReduceMax<TC>(dst, src, work, nLanes, calIndex=true)` 路径；R 不大于单 chunk lane 数，或 R 跨 chunk 时。

**结论**：calIndex 返回的下标不能无条件使用，只有两个前提同时成立才是答案：(1) `chunks == 1`——跨 chunk 时 lane 顺序不等于绝对下标顺序，lane 2 的值可能对应绝对下标 4098，calIndex 取最小 lane 会错；(2) 行最大值严格大于 reduce 种子——float 的种子是 `GetMinValue<float>() = -FLT_MAX`（0xFF7FFFFF），不是 -inf；如果整行都是 -inf，或最大值不超过种子，reduce 会把 lane 抬到种子且索引不更新，calIndex 返回 0。任一前提不成立时退回 recovery：先 `ReduceMax(..., false)` 求最大值，再 `Compare(EQ)` + `Select` 出候选下标，最后 `ReduceMin` 取最小绝对下标。

**核对方式**：读 `arg_max_kernel.cpp` 中 `useRecovery` 的判定和 `ArgMaxReduceSeed()`；用 [63] fp32 全 -inf、仅 index 40 为 -FLT_MAX 的输入（期望 40，不是 0）和跨 chunk 并列（期望 3 而非 4098）复现；检查 `chunks` 与 `mxFast > seed` 两个条件。
