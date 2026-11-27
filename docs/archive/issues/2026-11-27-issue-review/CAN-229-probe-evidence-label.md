# CAN-229 探针的自由文本和实测字段共用 `reproduced` 标签

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/src/probe-knowledge.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `probe`, `evidence` |
| 复核 | 2026-11-27。从 CAN-211 拆出 |

## 现象

`probe_run` 已经要求实测通过，并通过正确性检查，才会记录探针条目。调用方还可以带上自由文本 `note.conclusion`。记录条目时，这段自由文本和实测字段写在同一个 `evidence: 'reproduced'` 下面。

来源声明的格式校验见 [CAN-211](CAN-211-provenance-is-self-reported.md)。本条只处理探针标签。

## 证据

- `plugin/src/probe-knowledge.ts` 第 19–31 行：记录条目使用调用方 `note.conclusion`，证据等级写 `reproduced`。
- 探针路径在写入前检查实测通过和正确性。自由文本不单独占一个证据等级。

## 影响

`kb_search({ include_probes: true })` 会把实测结论和调用方句子放在同一个 `reproduced` 标签下。读者无法从标签区分哪一句是工具算出来的，哪一句是调用方写的。

## 期望

实测通过和正确性结果继续作为探针的准入条件。调用方自由文本使用单独字段，不与实测字段共用 `reproduced`。`reproduced` 只标在工具生成的比较结果上。

## 复现

1. 对一次已通过正确性检查的探针调用 `probe_run({ record })`，传入一段与数值无关的 `note.conclusion`。
2. 看工作区条目的 `evidence` 仍是 `reproduced`，正文同时含实测字段和这段文字。

## 建议修复

- 实测状态、误差和比较结果写入 `evidence: reproduced` 的字段。
- `note.conclusion` 写入 `note` 或 `comment`，证据等级不标成 `reproduced`。

## 验收标准

- 探针条目的 `reproduced` 只覆盖工具生成的实测字段。
- 自由文本仍可保存，并带有不同于 `reproduced` 的标记。
- 未通过实测或正确性检查的运行仍然不会记成探针证据。

## 关联

CAN-211、CAN-207。

项目 docs/design/06-knowledge-base.md 要求每条知识只有一个证据等级，混合等级拆为独立条目。

## 处置和验证

实测结果和调用方结论为不同证据条目，兼容旧条目的保守读取。
