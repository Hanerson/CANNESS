---
{
  "schema_version": 1,
  "id": "exp-950pr-base-one-preserves-nan",
  "title": "Exp 的 base=1：有限输入得 1，±Inf/NaN 必须保持 NaN",
  "kind": "troubleshooting",
  "operator": "Exp",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16"],
  "keywords": ["base==1", "NaN", "constant fill", "mode 18", "x*0+1", "IEEE", "特殊值", "非有限输入"],
  "evidence": "specification",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/desc.md#L36-L40",
      "sha256": "ac76a9d0b711934727c0e0e66a0baf6d9d022cc12fe0de1c4b54c851a141c90c"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/golden.py#L54-L57",
      "sha256": "3549ad7ddd315c58d6c4ab4a526ffd802c168ce61b4396a62aefc63aed1c27f3"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/ops/exp/op_plugin/exp_plugin.cpp#L121-L124",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/ops/exp/op_kernel/exp_kernel.cpp#L73-L111",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    }
  ]
}
---

**适用条件**：Exp 的 `base == 1`，且输入可能含 NaN/±Inf 时。

**结论**：官方特殊情况表明文：base=1 且 x 为有限值时 y=1；base=1 且 x 含 ±Inf/NaN 时对应位置 y=NaN（±Inf*0=NaN，与 golden 一致）。表里的「任意 scale, shift」按有限系数理解：scale/shift 非有限时，golden 的中间量已非有限，乘 `ln(1)=0` 仍得 NaN；实现也只在系数有限时走 mode=18。因此不能用常量 1 填充输出。参考包的实现把 base=1 且系数有限的情况设成 mode=18，kernel 用 `Muls(x,0) → Adds(1)` 让非有限值经 IEEE 算术变成 NaN，有限值得 1；fp16 走 `fused_baseone_half` 的原生 half 指令，bf16/fp32 走 `fused_baseone` 的 Cast 路径。

**核对方式**：读 desc.md 的特殊情况表、golden.py 的 base>0 分支与 top2 kernel 的 `fused_baseone*`；用 `[NaN, +Inf, -Inf, 0.0, -0.0]` 查询，期望 NaN/±Inf → NaN，有限值 → 1；再补 `x=0`、`scale=Inf`（或 `shift=NaN`），期望 NaN；常量 fill 版本会把非有限值也填成 1。
