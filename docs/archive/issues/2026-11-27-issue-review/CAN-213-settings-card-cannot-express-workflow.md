# CAN-213 设置卡没有设备和工具链字段，目标确认没有独立的用户来源

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/src/client/EvalCard.tsx`、`eval-card-controller.ts`、`generator.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `ui`, `settings`, `target` |
| 复核 | 2026-11-27。重连内容归入仓库 CAN-114 |

## 现象

插件对外的设置卡能填 SSH 端点、密钥或密码、inbox、outbox、超时、轮询，以及四项预算。评测还依赖 `device`、`deviceLock`、`setEnv`、`readRoots`。这些只能改 profile，卡片上没有设备和工具链字段。

目标硬件不一致时，`submit_spec` 返回比较结果，随后的 `confirm_target: true` 来自工具调用方。卡片不展示 `declared` 和 `detected`，也没有单独的确认动作。没有另一条用户确认来源。

隧道断开后的重连入口记在仓库 CAN-114，见 [CAN-214](CAN-214-layer-carry-reconnect-reference.md)。本条不再跟踪重连。

## 证据

- `plugin/src/client/eval-card-controller.ts` 第 30–45 行的 `EvalSettings` 字段与第 222 行附近的表单一致。没有 `device`、`setEnv`。
- `plugin/src/eval.ts` 第 49–53 行以及 `cordis.patch.yml` 有 `setEnv`。设备来自 config，未配置时由 runner 使用默认设备，见 [部署记录](NOTE-remote-deployment.md)。
- `plugin/src/generator.ts` 第 84–86 行：需要确认时，缺少 `confirm_target: true` 会先返回比较结果。`detected_soc` 单独不能越过该门禁。

## 影响

在这台机器上，设备、`setEnv` 和端点决定评测落在哪套工具链上（CAN-201、CAN-202、部署记录）。设置卡表达不了设备和工具链。目标确认由同一次工具调用的参数完成时，卡片上没有用户确认记录。

## 期望

卡片补齐与评测共用的设备、锁、`setEnv`。目标确认来自卡片或另一条用户动作，并写入状态。工具调用方单独传入的 `confirm_target: true` 不能充当这次用户确认。

## 复现

1. 打开设置 → CANNESS，对照 `eval.ts` 的 config 字段。卡片上没有 device 和 setEnv。
2. 在 `requiresConfirmation` 的返回之后，由工具调用方传入 `confirm_target: true` 再调 `submit_spec`。
3. 观察 generation 被创建，卡片上没有确认记录。

`eval-card.test.ts` 覆盖现有字段的保存，没有「缺字段」断言。

## 建议修复

- 表单增加 device、deviceLock、setEnv。
- `submit_spec` 在需要确认时返回比较结果并不写 generation。下一次调用只有在状态里已经有用户确认记录时才创建。

## 验收标准

- 不改 yml，只在卡片上把设备设为 `0`、`setEnv` 设为容器内脚本，下一次评测使用这些值。
- 工具调用方单独传 `confirm_target: true` 不能完成首次不一致确认。

## 关联

CAN-201、[部署记录](NOTE-remote-deployment.md)、仓库 CAN-114。

## 处置和验证

设置卡可编辑设备、锁及工具链脚本。目标冲突和 portable 申请须由用户从设置保存与该工作区、会话及端点绑定的确认编号。回归测试覆盖单独传工具布尔值、重试省略探测值以及探测目标改变的情况。
