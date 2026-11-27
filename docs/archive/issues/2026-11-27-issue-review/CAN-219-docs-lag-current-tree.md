# CAN-219 知识库索引、工具参考和 TODO 计数与当前树不一致

| 字段 | 值 |
|---|---|
| 类型 | 文档 |
| 优先级 | **P2** |
| 组件 | `tickets/TODO.md`、`docs/reference/tools.md`、`docs/reference/knowledge-base-index.md` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `docs` |
| 复核 | 2026-11-27。校验器当前为 20 条 |

## 现象

三处文档还停在更早的快照。

1. 知识库索引第 3 行写 16 条。2026-11-27 复核运行校验，结果是 20 条通过。`entries/` 现有 20 个文件。索引第 70–79 行写 `reported` 0、`reproduced` 0、没有 910B。`cannbench-host-copy-baseline-measured.md` 的 `evidence` 已是 `reproduced`，且针对 910B2。另有 `ascend910b-*` 与 ApplyRotary 的 910B2 条目。
2. `docs/reference/tools.md` 第 62 行写 `fetch_remote_file` 的范围偏窄。`plugin/src/eval.ts` 第 317–320 行的注释仍说兄弟 generation 会在传输前被拒绝。同文件 `remoteTargetAllowed`（约 336–353 行）已经放行 `readRoots` 以及 `knownGenerations` 的 inbox。工具参考落后于现行远端读取范围。
3. `tickets/TODO.md` 开篇写核对基线 `main@0ca2069`（v0.3.0），并写 22 个测试文件、189 项。当前是 `main@a86ca2c`、包 0.5.0、`plugin/tests` 下 39 个 `*.test.ts`。这些历史计数没有标注它们适用的时间或范围，读起来像当前树的现状。

README 对 Exp 性能分、A3 真机编译、ArgMax 官方评测的保留，和代码、TODO 的未完成项一致。本条不把 README 的验收范围判为过期。

## 证据

- `tickets/TODO.md` 第 3、7 行。`0ca2069` 有 25 个 TypeScript 测试文件。现有 20 条证据计数为 specification 5、source_inspection 11、reported 3、reproduced 1，旧索引四项均有出入。
- `git rev-parse --short HEAD` 为 `a86ca2c`，分支 `main`。
- `docs/reference/tools.md` 第 62 行。
- `plugin/src/eval.ts` 第 317–320 行与第 336–353 行。
- `docs/reference/knowledge-base-index.md` 第 3 行、第 18 行、第 70–79 行。
- 2026-11-27：`kb:validate` 20 条通过。`entries/` 共 20 个 markdown 文件。

## 影响

后续补条目的人会按索引以为仍是 16 条、910B 和复测仍是空白。代理会按工具参考避开已经放开的读取路径。TODO 里的 189 项和 22 个测试文件会被当成当前计数。

## 期望

索引条数与校验结果一致，当前是 20。工具参考的白名单句子与 `remoteTargetAllowed` 相同：outbox、已知 generation 的 inbox、`readRoots`。TODO 的历史计数标上适用的提交或版本；当前未完成项单独写，并标上 `a86ca2c` 或更新的 `main`。

## 复现

1. 数 `plugin/knowledge_base/entries/*.md`，并看校验输出 20。
2. 读索引第 3 行和第 76 行。
3. 读 `tools.md` 第 62 行，再读 `remoteTargetAllowed`。
4. 读 TODO 开篇的 189 项，看它没有写适用的提交。

## 建议修复

- 索引改成脚本输出，CI 里 `kb:validate` 对比已提交的索引，不一致则失败。
- 改 `tools.md` 与 `eval.ts` 顶部注释，使它们描述现行读取范围。
- TODO 的 22 个测试文件、189 项标明适用时间或 `main@0ca2069`。当前树的计数另起一行。

## 验收标准

- 索引条数等于 `entries/` 文件数，并与校验的 20 条一致。`reproduced` 计数与条目头一致。
- `tools.md` 写出现行远端读取范围：outbox、已知 generation 的 inbox、`readRoots`。
- TODO 里的历史计数带有适用的提交或日期。当前未完成项不再使用那组旧数字。

## 关联

CAN-207、CAN-210、CAN-211、CAN-216。

## 处置和验证

知识索引对齐 20 条及四种证据等级。工具参考已跟上读取范围，TODO 历史计数已更正并标明基线。
