---
{
  "schema_version": 1,
  "id": "exp-950pr-base-scale-shift-formula",
  "title": "Exp 官方契约：base<=0 走自然底数 exp(x*scale+shift)，base>0 走 exp((x*scale+shift)*ln(base))",
  "kind": "contract",
  "operator": "Exp",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16"],
  "keywords": ["base", "scale", "shift", "ln(base)", "natural base", "自然底数", "scale=0", "base^shift", "exp(shift)", "golden.py", "proto.yaml", "exp formula"],
  "evidence": "specification",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/desc.md#L21-L41",
      "sha256": "d0838f790d60cf92d636a3bc16e8b3b3dd967ac27460b3dc7c5d3d122e476209"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/desc.md#L74-L80",
      "sha256": "d0838f790d60cf92d636a3bc16e8b3b3dd967ac27460b3dc7c5d3d122e476209"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/golden.py#L54-L57",
      "sha256": "2c98c2f3e508616841c066ab66a2ee69465d8edfb72e3e8d8294ecc9e1cf0659"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/proto.yaml#L15-L31",
      "sha256": "fb59ee9dd31199548780c57019c28d71500712ea51880929425eb6379eab59d3"
    }
  ]
}
---

**适用条件**：Exp 官方任务，schema 为 `exp(Tensor x, float base=-1.0, float scale=1.0, float shift=0.0) -> Tensor y`，dtype 为 fp16/fp32/bf16。

**结论**：官方公式按底数分支：`base > 0` 时 `y = exp((x*scale + shift) * ln(base))`；`base <= 0` 时用自然底数，`y = exp(x*scale + shift)`。默认 `base=-1.0` 是自然 exp，不是无效值；输出 shape/dtype 与输入一致。特殊情况表里 `scale=0 且 x 有限（任意 base）→ base^shift` 与分段公式及 golden 冲突：golden 先算 `temp = scale*x + shift`，再按底数分支，所以 scale=0 时 `base <= 0` 的结果是 `exp(shift)`，只有 `base > 0` 才是 `base^shift`。其余特殊值：base<=0,scale=1,shift=0 → e^x；base>0,scale=1,shift=0 → base^x；base=1 且 x 有限 → 1；base=1 且 x 含 ±Inf/NaN → NaN。

**核对方式**：读 desc.md 的公式/特殊情况表与 golden.py 的分支；用 base=-1、base=2、base=10、scale=0/shift≠0，以及 base=-1、scale=0、shift=1 与 golden 对比，最后一组期望 e（约 2.71828），不是 -1；检查输出 dtype/shape 与输入一致。
