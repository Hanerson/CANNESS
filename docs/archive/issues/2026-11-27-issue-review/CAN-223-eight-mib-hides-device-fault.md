# CAN-223 超过 8 MiB 的验收日志只报告超限，设备故障标记不再出现

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P1** |
| 组件 | `plugin/remote/validate_submission.py` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `validate_submission`, `device_fault` |
| 复核 | 2026-11-27。短日志能识别同一标记。优先修。保留 8 MiB 上限 |

## 现象

设备故障的正则在读输出时按行匹配。短日志里的 `aicore exception` 会被识别为 `device_fault`。输出体积达到 8 MiB + 1 字节时，读取函数抛错，调用方把 markers 清掉，只报告超限。同一份先含故障标记、再超过上限的输出，结果里没有 `device_fault`。

8 MiB 上限保留。缺的是超限与设备故障同时存在时的分类。

## 证据

- `plugin/remote/validate_submission.py` 第 24–28 行：`MAX_OUTPUT_BYTES = 8 * 1024 * 1024`，`DEVICE_ERRORS` 含 `vector core exception`、`aicore exception`、`GM address accessed by scalar exceeds`。
- 第 41–44 行：`read_command_output` 在 `size > MAX_OUTPUT_BYTES` 时抛 `ValueError`，抛出点在按行扫描之前。
- 第 275–276 行：等待循环里体积超限同样抛错。
- 第 292–296 行：`read_command_output` 再抛时 `markers = []`，`failure` 换成超限文案。
- 第 326–339 行：只有 `evidence` 里已有 kind 才返回 `blocked`。
- 2026-11-27 复核：同一故障标记在短日志中被识别；构造 8 MiB + 1 字节时只报告超限。

`test_submission_validation.py` 若只用数千行噪声断言 `device_fault`，覆盖不到 8 MiB 这条路径。该文件目前也不在 CI 里，见 CAN-217。真机日志触及上限的频率本轮没有统计。

## 影响

CAN-020 把设备故障和用例失败分开。超长日志在这条路径上只留下超限。短日志的设备故障分类仍然有效。

## 期望

保留 8 MiB 上限。超限与设备故障同时出现时，状态为 `blocked`，错误文本同时保留超限和 `device_fault`。扫描使用已写入的前缀或含设备模式的行。

## 复现

1. 构造一次校验，stdout 先打印一行 `aicore exception`，长度停在 8 MiB 以内。确认 kind 为 `device_fault`。
2. 同一标记之后再写到 8 MiB + 1 字节。确认当前结果只报超限。

## 建议修复

- 在截断或抛错之前，对已有字节跑 `DEVICE_ERRORS`。
- 超限与设备故障同时出现时，状态为 `blocked`，错误文本同时保留两者。上限数值保持 8 MiB。
- 加一条「超限与 `device_fault` 并存」的回归，并让它进入 CI（CAN-217）。

## 验收标准

- 短日志中的 `aicore exception` 仍被识别为 `device_fault`。
- 8 MiB + 1 字节且前缀含该标记时，结果同时含超限和 `device_fault`，状态为 `blocked`。
- 输出上限仍是 8 MiB。超过的字节不进入完整日志。

## 关联

CAN-217、CAN-221。

CAN-106 和 CAN-020 已覆盖一般超限和设备故障。本条复现二者在同一份日志并存时的分类丢失。

## 处置和验证

输出超过上限时仍检查有界前缀，保留超限与设备故障分类。短日志和 8 MiB + 1 字节均已复现并回归。 [本地复现脚本](evidence/validation-output-limit.py)
