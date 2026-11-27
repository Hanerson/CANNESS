# CAN-227 SSH 没有数字退出码时按 0 处理

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P2** |
| 组件 | `plugin/src/ssh2-transport.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `ssh`, `exit-code` |
| 复核 | 2026-11-27。超时预算拆到 CAN-231。连接泄漏未证实 |

## 现象

`shellFromClient` 把退出码初值设为 0。只有 `exit` 事件给出数字才更新。`close` 时按当前值结束。信号杀死的进程（退出码为 null）会变成 0。随后若 `results.json` 还不存在，`runEvaluation` 进入 `waitForRemoteFile`，再等满默认超时。

外层超时与阶段截止见 [CAN-231](CAN-231-outer-timeout-before-stage-deadlines.md)。

## 证据

- `plugin/src/ssh2-transport.ts` 第 257–269 行：`let code = 0`，`exit` 仅在 `typeof exitCode === 'number'` 时赋值，`close` 调用 `finish()`。
- `plugin/src/eval-run.ts` 第 172–183 行：码为 0 且没有结果文件时等待整个 `timeoutMs`。

复核订正：初稿写连接失败路径会泄漏 socket。复核没有证实泄漏，该说法删除。

## 影响

远端进程没有数字退出码时，传输层向评测报告成功。评测接着按成功路径等待结果文件，直到超时配置用完。

## 期望

`exit` 为 null，或只有 `close` 没有数字 `exit` 时，退出码是失败。这条路径不按成功去轮询结果文件。

## 复现

在传输单测里发 `close` 且不发数字 `exit`，看当前实现是否 resolve 成码 0。现有 `plugin/tests/ssh2-transport.test.ts:147–154` 已把该行为断言为 0，修复时需要同步改预期，并补信号退出与显式退出码用例。

## 建议修复

- `code` 初值改为未设置。`close` 时若仍未设置，resolve 为非 0 或 reject。
- 非 0 时走已有的失败报告，不进入「码为 0 且等待结果文件」的分支。

## 验收标准

- 无数字 `exit` 的关闭得到非 0 退出码。
- 该关闭不会进入按成功等待结果文件的轮询。

## 关联

CAN-231、CAN-212。

## 处置和验证

SSH 缺数字退出码或收到信号时按失败处理，保留显式数字退出码，测试已调整。
