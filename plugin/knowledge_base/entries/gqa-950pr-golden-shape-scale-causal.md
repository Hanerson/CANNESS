---
{
  "schema_version": 1,
  "id": "gqa-950pr-golden-shape-scale-causal",
  "title": "GQA 官方契约：scaleValue<=0 取 1/sqrt(D)，causal 掩码按右下角对齐且要求 S<=S_kv",
  "kind": "contract",
  "operator": "GQA",
  "dtypes": ["float16", "bfloat16"],
  "keywords": ["scaleValue", "1/sqrt(D)", "is_causal", "right-bottom", "右下角对齐", "S<=S_kv", "golden", "BSND", "N_q % N_kv"],
  "evidence": "specification",
  "sources": [
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level4/gqa/desc.md#L60-L93",
      "sha256": "f4e181de4bb4fdb9957b0b4c4c7aa9ba3b7ebb08c356d8c3950037c8e1f9294d"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level4/gqa/desc.md#L108-L114",
      "sha256": "f4e181de4bb4fdb9957b0b4c4c7aa9ba3b7ebb08c356d8c3950037c8e1f9294d"
    },
    {
      "ref": "https://gitcode.com/cann/cann-bench/blob/53ea611a1b88da922b82812f2721dd0b2fa33476/tasks/level4/gqa/golden.py#L35-L39",
      "sha256": "c86aaa0bd0c24bc73fe53058a17a6cabfae853e97bcf9259a9e4aeec646381df"
    }
  ]
}
---

**适用条件**：GQA 官方任务，query `[B,S,N_q,D]`、key/value `[B,S_kv,N_kv,D]`，dtype fp16/bf16；`scaleValue` 与 `is_causal` 为调用参数。 公式与语义来自任务规范；各型号的硬件实测需要独立证据。

**结论**：`scaleValue <= 0`（默认 -1.0）时自动取 `1/sqrt(D)`；显式正值必须原样使用。`N_q` 必须能被 `N_kv` 整除，`G = N_q // N_kv`，每个 KV head 被 G 个 Q head 共享；`N_kv == N_q` 退化为 MHA，`N_kv == 1` 退化为 MQA。`is_causal=True` 时掩码按右下角对齐：`j > i + (S_kv - S)` 的位置在 softmax 前置 -inf，并要求 `S <= S_kv`；违反时部分 query 行被全屏蔽，softmax 出现 NaN。输出 shape `[B,S,N_q,D]`、dtype 与 query 相同。

**核对方式**：读 desc.md 的数学公式/接口/规则（L60-L93）与支持范围约束（L108-L114）、golden.py 的 `Nq % Nk` 与 `is_causal and S > Sk` 检查；用 S=3、S_kv=5 构造可区分左上/右下对齐的输入；用 scaleValue=0.125 与默认值对比；用 S>S_kv 确认 golden 拒绝。
