---
{
  "schema_version": 1,
  "id": "exp-950pr-base-scale-shift-formula",
  "title": "Exp 官方契约：base<=0 表示自然底数，y=exp((x*scale+shift)*ln(base))",
  "kind": "contract",
  "operator": "Exp",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16"],
  "keywords": ["base", "scale", "shift", "ln(base)", "natural base", "自然底数", "proto.yaml", "exp formula"],
  "evidence": "specification",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/desc.md#L21-L40",
      "sha256": "d0838f790d60cf92d636a3bc16e8b3b3dd967ac27460b3dc7c5d3d122e476209"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/desc.md#L74-L80",
      "sha256": "d0838f790d60cf92d636a3bc16e8b3b3dd967ac27460b3dc7c5d3d122e476209"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level1/exp/proto.yaml#L15-L31",
      "sha256": "fb59ee9dd31199548780c57019c28d71500712ea51880929425eb6379eab59d3"
    }
  ]
}
---

**适用条件**：Exp 官方任务，schema 为 `exp(Tensor x, float base=-1.0, float scale=1.0, float shift=0.0) -> Tensor y`，dtype 为 fp16/fp32/bf16。

**结论**：官方公式：`base > 0` 时 `y = exp((x*scale + shift) * ln(base))`；`base <= 0` 时用自然底数，`y = exp(x*scale + shift)`。默认 `base=-1.0` 就是自然 exp，不是无效值。输出 shape/dtype 与输入完全一致。特殊情况表：base<=0,scale=1,shift=0 → e^x；base>0,scale=1,shift=0 → base^x；base=1 且 x 有限 → 1；base=1 且 x 含 ±Inf/NaN → NaN；scale=0 且 x 有限 → base^shift。

**核对方式**：读 desc.md 的公式/特殊情况表与 proto.yaml 的 schema/attrs；用 base=-1、base=2、base=10、scale=0、shift≠0 五组与 golden.py 对比；检查输出 dtype/shape 与输入一致。
