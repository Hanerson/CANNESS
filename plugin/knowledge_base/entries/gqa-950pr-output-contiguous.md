---
{
  "schema_version": 1,
  "id": "gqa-950pr-output-contiguous",
  "title": "GQA 输出契约要求 contiguous：golden 末尾显式 .contiguous()",
  "kind": "contract",
  "operator": "GQA",
  "hardware": ["950pr"],
  "dtypes": ["float16", "bfloat16"],
  "keywords": ["contiguous", "stride", "issue #146", "output layout", "permute", "view", "BSND"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/GQA.zip!checks/golden.py#L78-L80",
      "sha256": "fcb9f3a41630fd3ad18cdd9a36f6c4948e7b33838658fc880937299bddc5b430"
    }
  ]
}
---

**适用条件**：GQA 返回 `[B,S,N_q,D]` 输出，评测器会检查输出 stride，或下游按 contiguous 读取时。

**结论**：golden 在把 `[B,N_kv,G,S,D]` permute 回 `[B,S,N_q,D]` 之后，显式调用 `.contiguous()`，注释说明输出契约要求 contiguous（issue #146）。只做 `permute + reshape` 可能返回非连续 view 或带额外 stride；数值看似正确但布局不符合契约。在 NPU 上如果 kernel 按 `[B,S,N_q,D]` 连续写回，而实际输出张量 stride 不同，评测器的逐元素比较或后续算子可能读错。

**核对方式**：读 `checks/golden.py` 最后一行；对返回 tensor 检查 `is_contiguous()` 与 `stride()`；构造 `N_q != N_kv`、`G>1` 的用例，确认 permute 后的 view 不是 contiguous，再验证 `.contiguous()` 会复制成标准布局。
