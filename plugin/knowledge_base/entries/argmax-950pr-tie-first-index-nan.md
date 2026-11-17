---
{
  "schema_version": 1,
  "id": "argmax-950pr-tie-first-index-nan",
  "title": "ArgMax 官方契约：并列取最小下标，NaN 视为最大值且首个 NaN 获胜",
  "kind": "contract",
  "operator": "ArgMax",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16", "int32", "int64"],
  "layouts": ["contiguous"],
  "keywords": ["torch.argmax", "first index", "第一个最大值", "最小索引", "tie-break", "NaN", "index_gather", "desc.md", "并列"],
  "evidence": "specification",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level2/arg_max/desc.md#L61-L65",
      "sha256": "5eac9e7eea1fe0b3967550786147e773a03a4f56357f16b24670c793147ea867"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level2/arg_max/desc.md#L45-L58",
      "sha256": "5eac9e7eea1fe0b3967550786147e773a03a4f56357f16b24670c793147ea867"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level2/arg_max/proto.yaml#L42-L55",
      "sha256": "fdabd96afdffd859eeaf7aa53af90da9dd8f19ca804d9aeea69d3bc1f974388d"
    }
  ]
}
---

**适用条件**：ArgMax 官方任务（该参考包为 950PR），输入 dtype 为 fp16/fp32/bf16/int32/int64，rank 0–8；查询任意 dim 的返回下标时。

**结论**：官方 desc.md 明文规定：`dim` 维上存在多个相同最大值时，返回第一个（最小索引）出现的位置，与 `torch.argmax` 一致；切片含 NaN 时 NaN 视为最大值，返回首个 NaN 的索引；±Inf 按正常大小参与比较。输出 `indices` 固定 int64；rank=0 的标量输入 `dim` 可取 0 或 -1，输出为值为 0 的 int64 标量。`proto.yaml` 说明官方 checker 不做逐元素并列顺序比对，而用 `index_gather`：`input.gather(dim, indices) == input.amax(dim, keepdim=True)`，因此「评测通过」只保证索引指向最大值，不保证最小索引；要满足契约仍需实现首个下标。

**核对方式**：读 `tasks/level2/arg_max/desc.md` 的规则与约束（L61-L65）、输出/数据类型表（L45-L58）与 `proto.yaml` 的 `index_gather` 注释（L42-L55）；用全相等、跨 tile 并列、all-NaN、NaN 与数值混合四类输入对比 `torch.argmax`；对 rank-0 输入检查 `dim=0/-1` 输出 shape `[]`、dtype int64、值为 0。
