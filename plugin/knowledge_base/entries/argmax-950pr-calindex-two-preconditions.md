---
{
  "schema_version": 1,
  "id": "argmax-950pr-calindex-two-preconditions",
  "title": "950PR 的 ReduceMax(calIndex) 快路径：无 NaN、单 chunk、超类型种子且 lanePos 在界内",
  "kind": "troubleshooting",
  "operator": "ArgMax",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16", "int32", "int64"],
  "layouts": ["contiguous"],
  "keywords": ["calIndex", "ReduceMax", "ArgMaxReduceSeed", "-FLT_MAX", "INT32_MIN", "INT64_MIN", "NaN 行", "smoke-04", "lane order", "chunk", "lanePos", "首个下标"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/ArgMax.zip!csrc/ops/arg_max/op_kernel/arg_max_kernel.cpp#L1697-L1766",
      "sha256": "41770bf8d9be241320092c5f56ca3ffac092301e7868b8cbe7675acdd34bfc55"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/ArgMax.zip!csrc/ops/arg_max/op_kernel/arg_max_kernel.cpp#L1661-L1695",
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

**结论**：calIndex 返回的下标不能无条件使用。含 NaN 的行先走单独分支：`Compare(NE)` 生成 nanMask，把 NaN lane 的下标置 sentinel，再 `ReduceMin` 取最小下标，不使用 calIndex。无 NaN 的行只有三个条件同时成立才能直接采用 calIndex：(1) `chunks == 1`——跨 chunk 时 lane 顺序不等于绝对下标顺序，lane 2 的值可能对应绝对下标 4098，取最小 lane 会错；(2) `mxFast > ArgMaxReduceSeed<TC>()`——float 的种子是 `-FLT_MAX`（0xFF7FFFFF），不是 -inf；整行 -inf 或最大值不超过种子时，reduce 把 lane 抬到种子且索引不更新，calIndex 返回 0；(3) `0 <= lanePos < nLanes`。种子按类型取：float 为 `-FLT_MAX`，int32 为 `INT32_MIN`，int64 为 `INT64_MIN`。对整数，种子就是类型最小值，`mxFast <= seed` 意味着整行都是该值，返回 0 恰好正确；float 则必须走 recovery。任一条件不成立时退回 recovery：先 `ReduceMax(..., false)` 求最大值，再 `Compare(EQ)` + `Select` 出候选下标，最后 `ReduceMin` 取最小绝对下标。

**核对方式**：读 `arg_max_kernel.cpp` 的 NaN 分支、`useRecovery` 判定和 `ArgMaxReduceSeed()`；用含 NaN 行、[63] fp32 全 -inf 且 index 40 为 -FLT_MAX（期望 40 而非 0）、跨 chunk 并列（期望 3 而非 4098）复现；检查 `chunks == 1`、`mxFast > seed`、`0 <= lanePos < nLanes` 三个条件。
