---
{
  "schema_version": 1,
  "id": "argmax-950pr-tiling-wave-quantization",
  "title": "ArgMax 的 reduce 轴切分要在 op_host 按核数重算：波数按 ceil(jobs/lanes) 量化",
  "kind": "implementation",
  "operator": "ArgMax",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16", "int32", "int64"],
  "layouts": ["contiguous"],
  "keywords": ["parts", "r_chunk", "ws_rows", "ws_cols", "GetCoreNumAic", "28 AI cores", "56 vector cores", "wave quantization", "ceil(jobs/lanes)", "尾块", "workspace"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/ArgMax.zip!csrc/ops/arg_max/op_host/arg_max_float_contiguous.cpp#L37-L80",
      "sha256": "50eeeec32de73edb4f74f1dd8d0e83c9e20faa4dbdaee680afa39565029052d5"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/ArgMax.zip!csrc/ops/arg_max/op_plugin/arg_max_plugin.cpp#L63-L68",
      "sha256": "50eeeec32de73edb4f74f1dd8d0e83c9e20faa4dbdaee680afa39565029052d5"
    }
  ]
}
---

**适用条件**：950PR（包内注释：Ascend950PR_957c，28 个 AI core，对应 56 个 vector core）上，ArgMax 的 reduce 轴长度为 R、输出元素数为 out_count，host 侧准备传 `parts/r_chunk/ws_rows/ws_cols` 时。

**结论**：不要在 plugin 里写死切分。该包在 `TilingFunc` 里用 `PlatformAscendC::GetCoreNumAic()*2` 得到 vector lane 数。launch grid 先给每个 core `floor(jobs/lanes)` 个 job，前 `jobs % lanes` 个 core 再多一个，所以总波数是 `ceil(jobs/lanes)`：64 个 job 在 64 lane 上一波，在 28-core（56 lane）部件上却要两波，耗时按 112 个 job 算；多一个 job 会多一整波。因此按 wave 数 1..4 搜索 `split`，试算 `used = ceil(out_count*split/lanes)` 与 `cost = used*(ceil(R/split)+8192)`，取 cost 最小的 split，再由 chunk 反推 parts、r_chunk、ws_rows、ws_cols。combine 会无条件读每一行 workspace，所以 parts 必须覆盖整个 reduce 轴，不能有 part 落在轴外。

**核对方式**：读 `arg_max_float_contiguous.cpp` 的 `TilingFunc` 中 1..4 wave 搜索与 `parts/r_chunk` 反推；用 28 AI core（56 lane）、out_count=32，对比 R=16384（split=1，parts=1）与 R=32768（split=3，parts=3）的 tiling；检查 workspace 大小按 `ws_rows*ws_cols*(sizeof(float)+sizeof(int32_t))` 分配。
