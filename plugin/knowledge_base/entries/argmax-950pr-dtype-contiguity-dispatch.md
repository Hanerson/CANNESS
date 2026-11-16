---
{
  "schema_version": 1,
  "id": "argmax-950pr-dtype-contiguity-dispatch",
  "title": "ArgMax 只接受 contiguous 输入，按 dtype 与 inner 是否大于 1 分派 10 个 kernel",
  "kind": "implementation",
  "operator": "ArgMax",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16", "int32", "int64"],
  "layouts": ["contiguous"],
  "keywords": ["inner==1", "contiguous", "strided kernel", "bfloat16 bit view", "int64 two int32 planes", "INT32_MAX", "rank 8", "empty dim"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/ArgMax.zip!csrc/ops/arg_max/op_plugin/arg_max_plugin.cpp#L141-L149",
      "sha256": "50eeeec32de73edb4f74f1dd8d0e83c9e20faa4dbdaee680afa39565029052d5"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/ArgMax.zip!csrc/ops/arg_max/op_plugin/arg_max_plugin.cpp#L181-L214",
      "sha256": "50eeeec32de73edb4f74f1dd8d0e83c9e20faa4dbdaee680afa39565029052d5"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/ArgMax.zip!csrc/ops/arg_max/op_plugin/arg_max_plugin.cpp#L91-L101",
      "sha256": "50eeeec32de73edb4f74f1dd8d0e83c9e20faa4dbdaee680afa39565029052d5"
    }
  ]
}
---

**适用条件**：950PR ArgMax，输入 x 为 contiguous，rank ≤ 8，reduce 维非空；dtype 为 fp16/fp32/bf16/int32/int64。

**结论**：先按 `inner`（dim 之后所有维的乘积）是否等于 1 分成 contiguous 与 strided 两套 kernel，再按 dtype 选具体符号，共 10 个入口。contiguous 路径对 bf16 做 `view(at::kShort)` 的仅元数据位视图（kernel 按单调 int16 key 归约），对 int64 做 `view(at::kInt)` 并把元素数翻倍（用两个 int32 word plane 模拟 64 位比较）。因此 int64 contiguous 还要求 `2*numel <= INT32_MAX`，否则生成的 tiling ABI 溢出。rank>8、非 contiguous、空 reduce 维都会在 host 直接 `TORCH_CHECK` 报错，不进入 kernel。

**核对方式**：读 `check_contract` 与 `arg_max_npu` 的 if/else 链；对 bf16/int64 检查 `view` 后 `stride()` 与元素数（int64 应翻倍）；构造 rank=9、非 contiguous、空 reduce 维和 `numel > 2^30` 的 int64 输入，确认报错信息来自 host。
