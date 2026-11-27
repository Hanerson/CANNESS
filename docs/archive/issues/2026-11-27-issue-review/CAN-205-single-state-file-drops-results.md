# CAN-205 换代后旧评测的报告仍返回，但本地状态不留该代结果，写入也不原子

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P1** |
| 组件 | `plugin/src/workspace.ts`、`generator.ts`、`eval.ts`、`state-file.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `state`, `budget`, `concurrency` |
| 复核 | 2026-11-27。优先处理。工具返回值里仍有旧代报告 |

## 现象

一个工作区只有 `.canness/state.json`，里面只有一个 `generationId`。`submit_spec` 用一份新状态覆盖整文件。`run_evaluation` 结束时再读磁盘，只有 generation 和 `packageHash` 仍与开跑时一致才把结果写入状态。

换代之后，旧评测的工具返回值里仍有报告和远端路径。本地状态没有该代结果。旧代的预算变化和续轮信号也不会回写。`saveState` 直接 `writeFileSync`，没有临时文件替换。

正式评测按工作区串行。`compile_only` 不排队。

## 证据

- `plugin/src/workspace.ts` 第 25–26 行：`statePath` 固定为 `join(workspace, '.canness', 'state.json')`。
- `plugin/src/generator.ts` 第 105–135 行：`saveState` 从 `emptyState()` 铺开，只把预算计数从同名算子带过来，`pendingSteer` 置为 `false`，`generationId` 换成新的。
- `plugin/src/eval.ts` 第 800–816 行：`latest.generationId === state.generationId && latest.packageHash === state.packageHash` 才 `saveState`。不相等时仍把报告返回给调用方，不写回状态，也不写回旧代的预算和 `pendingSteer`。
- `plugin/src/eval.ts` 第 475–476 行：`compile_only === true` 时直接 `evaluate`，不进入 `pendingEvaluations` 队列。
- `plugin/src/state-file.ts` 第 14–16 行：`mkdirSync` 后 `writeFileSync` 整文件。

## 影响

长评测期间再次 `submit_spec`，调用方当次还能看到旧报告和远端路径。循环接下来读的是新一代状态：没有旧代的 `lastReport`，旧代预算没有记上，`pendingSteer` 也不会按旧代结果置位。进程在 `writeFileSync` 中途退出会留下半截 JSON，下一次 `loadState` 抛错。

## 期望

旧代报告留在该代自己的状态里，并能从本地追溯到远端路径。新一代的续轮只看新一代的信号。状态写入先写临时文件再替换。

## 复现

1. 对 generation A 启动 `run_evaluation`，在它返回前对同工作区 `submit_spec` 得到 generation B。
2. 等 A 的 runner 写出 `results.json`。
3. 看工具返回值里仍有 A 的报告和远端路径。
4. 读 `.canness/state.json`：`generationId` 为 B，没有 A 的 `lastReport`，A 的预算变化和续轮信号没有写回。

现有测试 `generator-ownership.test.ts`、`generator-budget.test.ts` 只覆盖单会话归属，没有这条交错。

## 建议修复

- `.canness/generations/<id>.json` 存该代的报告、预算快照和远端路径。
- `.canness/current.json` 只存当前指针。`submit_spec` 改指针，不擦掉上一代文件。
- `saveState` 写 `path.tmp` 再 `rename`。
- 拒绝属主的路径不要改状态文件。非属主更新 `lastBlocked` 的写落到同一把锁下。

## 验收标准

- 旧代报告可追溯：换代后仍能从该代状态读到报告和远端路径。
- 新代续轮不受影响：旧代的 `pendingSteer` 和预算变化不驱动新一代。
- 状态原子写入：写到一半被打断后，磁盘上是旧的完整 JSON 或新的完整 JSON。

## 关联

仓库 CAN-114（层继承也建立在当前这一代上）。本条的追踪在桌面合并记录 [CAN-214](CAN-214-layer-carry-reconnect-reference.md)。

## 处置和验证

使用原子更新写当前状态，另为每代保留评测状态和远端结果路径。旧代结束不会覆盖新代或驱动新代续轮。
