# CAN-230 设置卡更新 eval 预算，续轮读取 loop 自己的配置

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/src/loop.ts`、`plugin/src/eval.ts`、`plugin/src/client/index.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `config`, `loop`, `budget` |
| 复核 | 2026-11-27。从 CAN-226 拆出 |

## 现象

设置卡绑定 `canness-eval`。评测侧的预算字段是 volatile，用 `.get()` 读取，保存后下一次评测能看到。`canness-loop` 的同名预算是挂载时的普通数字，`shouldSteer` 直接读这份 `config`。

两边在 yml 中各有配置，默认数字相同。设置卡改的是 eval 的预算，续轮仍读 loop 自己的预算。重新挂载 loop 只会重新读它自己的配置，评测和续轮仍可能分叉。

默认知识库路径见 [CAN-226](CAN-226-kbroot-and-loop-policy-split.md)。

## 证据

- `plugin/src/loop.ts` 第 23–28 行：`maxIterations` 等是 `.required()` 的普通数字。第 72 行把这份 `config` 交给 `shouldSteer`。
- `plugin/src/eval.ts` 第 87–90 行与第 158–163 行：评测策略是 volatile 并 `.get()`。
- `plugin/src/client/index.ts` 约第 60 行：卡片挂在 `canness-eval`。
- 设置卡的保存目标是 eval 的配置路径。loop 即使能热读自己的字段，也不会收到写往 eval 路径的值。

## 影响

卡片把 `maxIterations` 改成 3 之后，下一次评测按 3 停。续轮仍按 loop 挂载时的数字（默认 10）继续提示。两边的预算策略在同一次会话里不再是同一份。

## 期望

eval 与 loop 共用一份预算策略。设置卡保存后，下一次评测停机和续轮判断读到同一个 `maxIterations`、同一组 stall 参数。

## 复现

1. 在设置卡把 `maxIterations` 改为 1，不重启 dsh。
2. 跑一次未达标的评测，看评测侧按新上限处理。
3. 看下一轮续轮是否仍按 loop 挂载时的旧上限提示。

## 建议修复

- 让评测和续轮从同一个策略来源读取当前值，例如由 eval 提供策略快照，或由共享服务提供策略。设置卡只写这一个来源。

## 验收标准

- 在存在一次未达标评测的会话里，只保存一次设置卡，将 `maxIterations` 从 10 改为 1。无需重启或重新挂载，评测与续轮都按同一个新上限判断。
- stall 相关参数更新后，两条路径同样读取共享策略。

## 关联

CAN-213、CAN-221、CAN-225、CAN-226。

CAN-017 判定 profile 覆盖 bundle 默认值是配置分层。本条涉及同一次设置改变后 eval 与 loop 使用不同来源。

## 处置和验证

评测和续轮通过共享策略读取最新设置，离线测试可在不重新挂载的情况下改变续轮判断。
