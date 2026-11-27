# CAN-222 提交模式的完成条件尚未包含验收结果

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P1** |
| 组件 | `plugin/src/eval.ts`、`plugin/src/policy.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `eval-loop`, `submission`, `targetMet` |
| 复核 | 2026-11-27。优先定义提交模式。纯内核评测保留现有语义 |

## 现象

内核报告先写入状态，提交验收随后挂到当次返回值的 `submission` 字段，不改 `report.status`。`targetMet` 的条件是内核 `pass` 且 `kernelTimeUs <= targetUs`。验收失败时，循环仍可以按内核成绩达到 `targetMet`。

纯内核评测保持这套完成语义。缺的是提交模式：在要求提交物的运行里，完成条件还要包含验收结果。

没有 `submissions/<gen>-*` 时自动验收直接跳过。导出包构建失败、wheel 装不上、校验器返回 `blocked`，都只出现在那一次工具 JSON 的 `submission` 字段里。

## 证据

- `plugin/src/eval.ts` 第 800–818 行：条件满足时 `saveState`，`pendingSteer: !forcedAfterStop`，随后 `return attachSubmission(...)`。没有第二次 `saveState` 把验收结果写回内核状态。
- `plugin/src/policy.ts` 第 234–240 行：`targetMet` 的条件是内核 `pass` 且 `kernelTimeUs <= targetUs`。
- 同文件第 244–246 行：`shouldSteer` 在 `lastReport.status === 'pass'` 时为 false。

## 影响

在要求提交物的现有工作流中，内核评测通过可以在提交验收失败时结束迭代。纯内核评测若被改成同样等待验收，会改变当前不导出时的完成语义。两种模式需要分开的完成条件。

## 期望

定义提交模式。该模式达到 `targetMet` 要同时满足内核达标和 `submission.status === 'validated'`。验收失败或被阻塞时，若策略仍允许续轮，`shouldSteer` 应允许生成含验收摘要的提示，即使本次内核报告为 `pass`。纯内核评测继续只看内核 `status` 和 `kernelTimeUs`，不因没有导出而失去 `targetMet`。

## 复现

1. 为当前测试包准备同 generation、同包哈希的导出。在测试中令内核评测返回 `pass` 且低于目标，提交验收返回 `failed` 或 `blocked`，其余预算未触发停机。
2. 调用现有的 `run_evaluation`，让它自动选中导出，或明确指定 `submission.source_dir`。
3. 检查返回值的 `submission` 和 `.canness/state.json` 中的 `lastReport`。验收结果在返回值里，状态仍只保留内核通过。
4. 用该状态计算 `stopReason` 和 `shouldSteer`。当前仍可能得到 `targetMet`，且 `shouldSteer` 会因内核 `pass` 返回 false。

## 建议修复

- 明确记录本次任务是否要求提交物，使这一要求能在没有导出包时表达。
- 提交模式持久化 `attachSubmission` 的验收结果，并让 `targetMet` 与 `shouldSteer` 都读取它。只有内核达标且验收通过才算达标。
- 纯内核路径不读 `submission`，保持现有 `policy.ts` 条件。

## 验收标准

- 提交模式下，内核达标且验收 `validated` 时，可得到 `targetMet`。验收 `failed` 或 `blocked` 时不得得到 `targetMet`，在没有其他停机条件时 `shouldSteer` 允许下一轮，并带上验收摘要。
- 纯内核评测在内核达标时仍为 `targetMet`，不要求导出或验收。
- 未导出的提交模式返回值含 `not_exported`，停机原因不是达标。

## 关联

CAN-204。CAN-021 把验收接进了返回值；停机规则在提交模式下仍待把验收算进完成条件。

## 处置和验证

提交模式在验收开始前保存已完成的内核报告与预算。验收结果与导出来源和字节摘要绑定，只为未更改的同一份导出复用。未导出和验收失败可提示续轮，纯内核路径保持原有语义。
