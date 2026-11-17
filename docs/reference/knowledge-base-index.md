# 知识库条目索引

当前 **16 条**结构化条目，覆盖 ArgMax（5）、Exp（4）、GQA（4）与通用 CANNBench 评测器（3）。
每条都是 `plugin/knowledge_base/entries/<id>.md` 一个文件，字段与检索规则见
[知识库设计](../design/06-knowledge-base.md)，编写方法见[填充指南](../guides/knowledge-base-authoring.md)。

**本页由条目头部字段导出，不单独维护内容**：加条目时补一行，跑一次
`cd plugin && npm run kb:validate`；若本页与 `entries/` 不一致，**以 `entries/` 为准**。

## 用法

```text
kb_search(operator_name: "ArgMax", query: "并列 最大值")
kb_search(query: "aclrtMemcpy", kind: "benchmark")
kb_search(operator_name: "Exp", hardware: "950pr", dtype: "float16")
```

`hardware` / `dtype` / `layout` / `cann_version` 是**过滤**而不是加权：与条目声明冲突时该条直接退出候选，
所以查询时尽量带上已知条件。只传 `operator_name` 时返回兼容文本（结构化条目优先，没有则回退旧笔记）。

## 通用 CANNBench 评测器

| 条目 | 类型 | 证据 | 一句话结论 |
|---|---|---|---|
| [cannbench-aclrtmemcpy-budget-zeroes-score](../../plugin/knowledge_base/entries/cannbench-aclrtmemcpy-budget-zeroes-score.md) | `benchmark` | `source_inspection` | `perf_strategy.py` 对每个 `aclrtMemcpy` 开头的 API 行独立读 `Count`，`Count > 5` 即判 `cpu_fallback_detected` 并把 `elapsed_us` 归零，成绩直接作废 |
| [cannbench-build-cardless-soc-selection](../../plugin/knowledge_base/entries/cannbench-build-cardless-soc-selection.md) | `troubleshooting` | `source_inspection` | 构建期不要用 `torch.npu.get_device_name(0)` / `npu-smi` 探测 SoC——构建机上没有卡，必须走显式 `--soc` |
| [cannbench-operator-resolution-keyword-schema](../../plugin/knowledge_base/entries/cannbench-operator-resolution-keyword-schema.md) | `contract` | `source_inspection` | `cann_matcher.load_ai_operator` 先查 `torch.ops.cann_bench` 再查 `cann_bench` 模块，候选名由 snake_case + 小写名 + 原名 + schema 函数名组成 |

## ArgMax（950pr）

| 条目 | 类型 | 证据 | 一句话结论 |
|---|---|---|---|
| [argmax-950pr-tie-first-index-nan](../../plugin/knowledge_base/entries/argmax-950pr-tie-first-index-nan.md) | `contract` | `specification` | 唯一最大值并列时返回**首个**（最小索引），与 `torch.argmax` 一致；切片含 NaN 时 NaN 视为最大值并返回首个 NaN 下标；±Inf 按正常大小比较 |
| [argmax-950pr-dtype-contiguity-dispatch](../../plugin/knowledge_base/entries/argmax-950pr-dtype-contiguity-dispatch.md) | `implementation` | `source_inspection` | 按 `inner`（dim 之后所有维之积）是否为 1 分两套 kernel；这里「strided」指 reduce 维不在最内层，输入本身仍须 contiguous |
| [argmax-950pr-tiling-wave-quantization](../../plugin/knowledge_base/entries/argmax-950pr-tiling-wave-quantization.md) | `implementation` | `source_inspection` | 切分不要写死在 plugin 里：`TilingFunc` 用 `PlatformAscendC::GetCoreNum*` 按波次量化分配 |
| [argmax-950pr-calindex-two-preconditions](../../plugin/knowledge_base/entries/argmax-950pr-calindex-two-preconditions.md) | `troubleshooting` | `source_inspection` | `calIndex` 的下标不能无条件使用：含 NaN 的行先由 `Compare(NE)` 单独生成 mask 分支，否则并列与 NaN 都会取错位置 |
| [argmax-950pr-stale-build-not-recompiled](../../plugin/knowledge_base/entries/argmax-950pr-stale-build-not-recompiled.md) | `implementation` | `source_inspection` | 改完 `op_kernel` 必须删 `build/`：增量 cmake 不重编改过的 kernel，曾用新源码产出字节相同的库 |

## Exp（950pr）

| 条目 | 类型 | 证据 | 一句话结论 |
|---|---|---|---|
| [exp-950pr-base-scale-shift-formula](../../plugin/knowledge_base/entries/exp-950pr-base-scale-shift-formula.md) | `contract` | `specification` | `base > 0` 时 `y = exp((x*scale + shift) * ln(base))`；`base <= 0` 时走自然底数 `y = exp(x*scale + shift)` |
| [exp-950pr-base-one-preserves-nan](../../plugin/knowledge_base/entries/exp-950pr-base-one-preserves-nan.md) | `troubleshooting` | `specification` | `base=1` 且 x 有限时 `y=1`；x 含 ±Inf/NaN 时对应位置是 NaN（`±Inf*0=NaN`），与 golden 一致，不能优化成常量 1 |
| [exp-950pr-dtype-dispatch-python-vs-cpp](../../plugin/knowledge_base/entries/exp-950pr-dtype-dispatch-python-vs-cpp.md) | `implementation` | `source_inspection` | top1 在 Python 层按 `x.dtype` 加载 `c1/c2/c3` 子目录并缓存；dtype 不在表里直接 `ValueError`，不静默回退 |
| [exp-950pr-runtime-tiling-footprint](../../plugin/knowledge_base/entries/exp-950pr-runtime-tiling-footprint.md) | `implementation` | `source_inspection` | 先读 `ACL_DEV_ATTR_VECTOR_CORE_NUM` 与 `LOCAL_MEM_PER_VECTOR_CORE` 均分并对齐 512B，再按张量字节数选 tile（≤8MiB 4096、≤64MiB f32 8192 / 16 位 16384、更大 15360 / 30720） |

## GQA（950pr）

| 条目 | 类型 | 证据 | 一句话结论 |
|---|---|---|---|
| [gqa-950pr-golden-shape-scale-causal](../../plugin/knowledge_base/entries/gqa-950pr-golden-shape-scale-causal.md) | `contract` | `specification` | `scaleValue <= 0`（默认 -1.0）时自动取 `1/sqrt(D)`；显式正值原样使用 |
| [gqa-950pr-output-contiguous](../../plugin/knowledge_base/entries/gqa-950pr-output-contiguous.md) | `contract` | `source_inspection` | golden 把 `[B,N_kv,G,S,D]` permute 回 `[B,S,N_q,D]` 后显式 `.contiguous()`：输出契约要求连续布局 |
| [gqa-950pr-probe-strided-heads](../../plugin/knowledge_base/entries/gqa-950pr-probe-strided-heads.md) | `contract` | `source_inspection` | strided 用例不是「非 contiguous」的同义词：probe 分配 `[..., nq*2, D]` 后取 `[:, :, ::2, :]` 让 head stride 翻倍，并改写 q/k/v 与 `scaleValue` |
| [gqa-950pr-all-masked-row-zero](../../plugin/knowledge_base/entries/gqa-950pr-all-masked-row-zero.md) | `troubleshooting` | `specification` | causal 且 `S > S_kv` 时整行被屏蔽，softmax 0/0 得 NaN；官方 golden 直接 `raise ValueError("causal GQA requires S <= S_kv")` |

## 覆盖分布

| 类型 | ArgMax | Exp | GQA | 通用 | 合计 |
|---|---|---|---|---|---|
| `contract` | 1 | 1 | 3 | 1 | **6** |
| `implementation` | 3 | 2 | 0 | 0 | **5** |
| `troubleshooting` | 1 | 1 | 1 | 1 | **4** |
| `benchmark` | 0 | 0 | 0 | 1 | **1** |
| 合计 | **5** | **4** | **4** | **3** | **16** |

| 证据等级 | 条目数 |
|---|---|
| `specification`（规范明文） | 6 |
| `source_inspection`（读源码得出） | 10 |
| `reported`（材料里的自报成绩） | 0 |
| `reproduced`（我们独立复测） | 0 |

## 下一步的缺口

1. **没有 `reported` / `reproduced` 条目**：现有 16 条只说明「规范怎么要求、别人怎么实现」，
   还缺「这套实现在什么硬件上跑出多少、我们用 CANNESS 复测是多少」。官方基线需等 CANNBench
   社区维护结束后补，`reproduced` 条目可以直接用 `run_evaluation` 的 `runRecord` 做来源。
2. **覆盖面偏窄**：三个算子 × 单一平台（950pr）。910B / 910C 的差异条目还没有。
3. **没有一条关于 `kb_search` 自身体验的条目**（什么问法能查到），可考虑把常用问法固化成本节示例。
