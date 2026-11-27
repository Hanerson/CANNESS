# CAN-207 查询指定 Ascend910B2 时，Exp、ArgMax、GQA 为零命中

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P1** |
| 组件 | `plugin/src/knowledge-search.ts`、`plugin/knowledge_base/entries/` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `knowledge`, `910B`, `retrieval` |
| 复核 | 2026-11-27。本地查询已复现零命中 |

## 现象

本地对知识库查询并指定 `Ascend910B2` 时，Exp、ArgMax、GQA 都是零命中。这三条的结构化契约把 `hardware` 写成 `["950pr"]`。过滤器在已知硬件对不上时丢掉该条。查询里除了算子名还有别的字段时，空的结构化结果就是最终结果，不会再返回根目录笔记。

910B 上已有别的条目，例如 `ascend910b-int32-bitwise-support`、`ascend910b-select-dtype-support`，以及 ApplyRotary 的调用预算条目。缺的是上述算子契约在这个查询下的命中。

## 证据

- 2026-11-27 本地查询：`hardware` 为 `Ascend910B2` 时，Exp、ArgMax、GQA 均为零命中。
- `plugin/src/knowledge-search.ts` 第 67–69 行：`known` 里没有请求的硬件时 `return -1`。
- 同文件第 112–131 行：结构化命中非空时直接返回，不读根目录。
- 同文件第 134–137 行：带了 `operator_name` 以外的字段时走 `searchStructured`，空结果就是空结果。
- `plugin/knowledge_base/entries/exp-950pr-base-scale-shift-formula.md` 第 8 行：`"hardware": ["950pr"]`。ArgMax、GQA 条目同样只写 950pr。
- `docs/reference/knowledge-base-index.md` 第 18 行把 hardware 说明成硬过滤。

## 影响

在 910B2 上按文档带上硬件条件查询 Exp、ArgMax 或 GQA，得不到公式、并列下标或 NaN 契约。这些契约的正文没有因此被改写，只是当前过滤器不返回它们。

## 期望

查询支持硬件别名，使 `910B`、`Ascend910B2` 这类写法能命中同一条已声明的适用范围。已经验证、且不依赖单一硬件的通用契约可以不带硬件条件单独检索。带有硬件实测范围的条目继续只在原有适用范围下命中。

## 复现

1. 调用等价于 `kb_search({ operator_name: "Exp", hardware: "Ascend910B2" })` 的查询。ArgMax、GQA 同样查询。
2. 观察三条都是零命中。

`knowledge.test.ts` 覆盖了过滤机制本身，没有「910B2 查询仍须看到通用契约，实测条目保持原范围」的用例。

## 建议修复

- 为硬件名增加别名表，别名只展开到条目已经声明的范围。
- 通用契约与硬件实测条目分开标记。实测条目保持 `hardware` 原值。
- 过滤未命中时，返回被排除的条目 id 和排除原因。

## 验收标准

- `Exp`、`ArgMax`、`GQA` 在 `Ascend910B2` 查询下，若正文是通用契约，则能检索到，并带有适用性说明。
- 硬件实测条目在别名查询下仍只命中其原始适用范围，不会因为别名被当成所有 910B 都已复测。

## 关联

CAN-210、CAN-219。

关联 CAN-026、CAN-108 和 CAN-113 的知识库覆盖与回退规则。本条补硬件筛选和可复用契约。

## 处置和验证

补硬件别名、副型号匹配和 Exp、ArgMax、GQA 的通用契约检索。硬件实测条目保留自身筛选范围。
