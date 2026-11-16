---
{
  "schema_version": 1,
  "id": "gqa-950pr-all-masked-row-zero",
  "title": "GQA 全掩码行 softmax 会得 NaN：causal 必须 S<=S_kv，包内 golden 还会置 0 保护",
  "kind": "troubleshooting",
  "operator": "GQA",
  "hardware": ["950pr"],
  "dtypes": ["float16", "bfloat16"],
  "keywords": ["all masked", "全掩码", "NaN", "softmax", "F217", "sparse_flash_attention", "causal", "padding mask", "S>S_kv"],
  "evidence": "specification",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level4/gqa/desc.md#L108-L114",
      "sha256": "ae7b53cc5dc581771930016c090f91bd2ffe5bd35b8d554998ebf1ef3192dc85"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level4/gqa/golden.py#L35-L39",
      "sha256": "c86aaa0bd0c24bc73fe53058a17a6cabfae853e97bcf9259a9e4aeec646381df"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/GQA.zip!checks/golden.py#L69-L74",
      "sha256": "fcb9f3a41630fd3ad18cdd9a36f6c4948e7b33838658fc880937299bddc5b430"
    }
  ]
}
---

**适用条件**：GQA `is_causal=True` 且 `S > S_kv`（违反官方约束），或 scores 某行因额外 mask/全 -inf 输入全为 -inf 时。

**结论**：官方规则要求 causal 时 `S <= S_kv`，否则部分 query 行会被全部屏蔽，softmax 计算 0/0 得 NaN；官方 golden 直接 `raise ValueError("causal GQA requires S <= S_kv")`。参考包的 golden 额外做了防御：检测 `scores.max() == -inf` 的行并把权重置 0（注释 F217，对齐 sparse_flash_attention），这样即使出现全 mask 行也不会把 NaN 传播到输出。候选实现应先校验/拒绝 `S > S_kv`；若保留容错，则必须做同样的全 mask 行零权重保护，不能依赖硬件 softmax 自己处理。

**核对方式**：读 desc.md 的约束（L108-L114）、golden.py 的 `if is_causal and S > Sk: raise`、包内 golden.py 的 `all_masked`/`torch.where`；构造 S=5、S_kv=3 的 causal 输入确认官方 golden 拒绝；构造一行全 -inf scores 确认有保护时输出 0 而不是 NaN。
