---
{
  "schema_version": 1,
  "id": "gqa-950pr-output-contiguous",
  "title": "GQA 输出契约要求 contiguous：golden 末尾显式 .contiguous()，S=2 才触发非连续 view",
  "kind": "contract",
  "operator": "GQA",
  "hardware": ["950pr"],
  "dtypes": ["float16", "bfloat16"],
  "keywords": ["contiguous", "stride", "issue #146", "output layout", "permute", "view", "BSND", "S=2", "N_q != N_kv", "G>1", "is_contiguous"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/GQA.zip!checks/golden.py#L78-L80",
      "sha256": "fcb9f3a41630fd3ad18cdd9a36f6c4948e7b33838658fc880937299bddc5b430"
    }
  ]
}
---

**适用条件**：GQA 返回 `[B,S,N_q,D]` 输出，`N_q = N_kv * G`，评测器会检查输出 stride，或下游按 contiguous 读取时。

**结论**：golden 在把 `[B,N_kv,G,S,D]` permute 回 `[B,S,N_q,D]` 之后，显式调用 `.contiguous()`，注释说明输出契约要求 contiguous（issue #146）。只做 `permute + reshape` 可能返回非连续 view；数值看似正确但布局不符合契约。触发非连续需要 S>=2：以 B=1、N_kv=2、G=2、D=64（N_q=4）为例，S=1 时 permute + reshape 已是连续的，S=2 时结果非连续——`is_contiguous()==False`，S 维 stride 是 D（64），而连续布局要求 `N_q*D`（256）。只在 S=2 这类用例上，`.contiguous()` 才会把 stride 复制成 `(S*N_q*D, N_q*D, D, 1)` 并令 `is_contiguous()==True`。在 NPU 上如果 kernel 按 `[B,S,N_q,D]` 连续写回，而实际输出张量 stride 不同，评测器的逐元素比较或后续算子可能读错。

**核对方式**：读 `checks/golden.py` 最后一行；用 B=1、N_kv=2、G=2、D=64、S=2 跑 golden 尾段，在 `.contiguous()` 前后检查 `stride()` 与 `is_contiguous()`（前：False，S 维 stride=64；后：True，stride=(512,256,64,1)）；再用 S=1 对照，确认它本来就是连续的，不能作为触发用例。
