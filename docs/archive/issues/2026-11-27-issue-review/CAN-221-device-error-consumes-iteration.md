# CAN-221 `error` 计入有效迭代，日志压缩会丢掉设备故障行

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P1** |
| 组件 | `plugin/remote/runner.py`、`plugin/src/policy.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `device`, `budget`, `steer` |
| 复核 | 2026-11-27。本地已确认。优先修 |

## 现象

`run_once.sh` 非零退出时，runner 写 `status: "error"`，`compile.ok` 仍为 true。`applyReport` 对除 `compile_fail` 和 `timeout` 以外的状态执行 `validIterations += 1`。本地已确认：`error` 会增加有效迭代。

同包普通调用可能在 `run_evaluation` 中直接返回缓存报告，此时不会再进入 `applyReport` 或增加计数。如果同包重测实际执行并进入 `applyReport`，且 `packageHash === lastEvaluatedHash`，策略先增加 `validIterations`，再按重复测量处理比较窗口。

续轮压缩日志时，编译成功只保留匹配 `error|failed|FAILED|warning:` 的行。`CANNESS_ERROR` 和 `vector core exception` 对不上。日志里只要有一行 `warning:`，就不会退回最后三行。设备故障行因此可以从续轮摘要里消失。

## 证据

- `plugin/remote/runner.py` 第 934–938 行：`returncode != 0` 时 `status='error'`，`compile_ok=True`，摘要为 `run_once.sh exited {code}`。
- `plugin/src/policy.ts` 第 126–136 行：只有 `compile_fail` 和 `timeout` 提前返回；其余状态执行 `validIterations += 1`。本地用该函数确认 `error` 使计数加一。
- `plugin/src/eval.ts` 第 747–758 行的同包缓存分支直接返回此前的报告，不调用 `applyReport`。
- `plugin/src/policy.ts` 第 140 行用 `packageHash === lastEvaluatedHash` 识别已实际执行的重复测量。第 149–158 行在重复测量时更新少量最优值后返回。
- 同文件第 223–226 行：`validIterations >= maxIterations` 停机。第 248–252 行：`canForceEvaluation` 的可越过原因不包括 `maxIterations`。
- 同文件第 266–268 行与第 291–302 行：`isSignal` 的正则，以及 `ok && !isSignal` 时丢弃该行。本地确认压缩可以滤掉设备故障行。

`policy.test.ts` 断言编译失败不消耗迭代。没有 `status: 'error'` 或 `CANNESS_ERROR` 的用例。

## 影响

归为 `error` 且进入 `applyReport` 的基础设施故障会占用默认 10 次有效迭代额度。实际执行的同包重测也可能增加计数，即使比较窗口没有加入新的候选。续轮摘要可能只剩 warning 或其他信号行，设备故障原文会丢失。

## 期望

预算规则把基础设施故障和候选 kernel 故障分开。设备不可用、传输和环境故障不增加候选迭代。可归因于候选 kernel 的失败沿用对应的预算规则。保留工具层同包缓存和策略层重复测量判断，并在实际重测分类后决定是否计数。日志里的设备故障模式进入续轮摘要。

## 复现

1. 让 `run_once.sh` 以非零退出，stdout 含 `CANNESS_ERROR` 或 `vector core exception`，并带一行 `warning:`。
2. 看报告 `status` 为 `error`，`applyReport` 后 `validIterations` 加一。
3. 普通重调同一个已完成包，确认工具命中缓存且计数不增加。另在策略单测中向 `applyReport` 传入相同 `packageHash` 的实际重测报告，观察当前计数增加，但比较窗口仍按重复测量处理。
4. 看 `condenseCompileLog(log, true)` 的输出可以不含那条设备故障。

## 建议修复

- 把可判定的基础设施故障以结构化分类传给 `applyReport`，避免仅按 `device_fault` 日志字样归因。
- 保留工具层缓存和策略层比较去重，各自覆盖独立的计数行为。
- `isSignal` 识别构建契约的 `CANNESS_ERROR` 和 `validate_submission.py` 中已有的设备故障诊断模式。运行失败走保留尾部的路径，即使 `compile.ok` 为 true。

## 验收标准

- 基础设施故障连续出现时，不因 `maxIterations` 把候选迭代用完。
- 可归因于候选 kernel 的运行失败仍按现有规则计数，编译失败继续使用编译重试预算。
- 普通同包缓存命中不增加计数。实际同包重测保留比较窗口去重，是否计数由故障分类决定。两条路径分别有测试。
- 续轮文本里能看到 `CANNESS_ERROR` 或设备故障原文的一行。

## 关联

CAN-223、CAN-217。

## 处置和验证

runner 将内层超时归入超时预算，结构化设备不可用不消耗候选迭代，并允许同包重试。日志保留设备异常信号。
