# 部署记录：已脱敏宿主机 的评测端点

| 字段 | 值 |
|---|---|
| 类型 | 部署配置 |
| 状态 | 记录。不是产品缺陷 |
| 复核 | 2026-11-27 |
| 机器 | `SSH 宿主机`，容器 `canness-eval:9.2.1` |

本文件记下这台机器上已经核对过的路径、设备和锁。它们不单独立项。产品侧要修的回收见 [CAN-203](CAN-203-default-device-inbox-and-gc.md)。端点识别见 [CAN-201](CAN-201-ssh-does-not-reach-cann-921.md)。

## 已核对的事实

- `/canness` 是独立挂载，对应宿主机上的持久数据目录。
- 插件默认的 `/tmp/canness-a` 在容器里事先不存在。上传逻辑会创建这个目录。因此「默认目录不存在」本身不会让上传失败。
- 设备覆盖变量未设置。5 份历史性能报告都使用设备 7。这与 runner 在未传 `--device` 时的默认值一致（`plugin/remote/runner.py` 的 `DEFAULT_DEVICE = '7'`，锁默认 `/tmp/canness/davinci7.lock`）。
- 锁文件在容器自己的 `/tmp` 里。它只覆盖当前挂载命名空间里使用这把锁的进程。

## 和 CAN-014 的关系

仓库 CAN-014 已经处理临时工件提示：inbox 或 outbox 落在 `/tmp`、`/var/tmp` 时，评测返回 `artifactWarning`，并建议改成持久路径。生产环境应显式设置 inbox、outbox 和 device。插件不从「路径不在 `/tmp`」推断磁盘一定持久。

这台机器若要让产物留在 `/canness`、并避开默认的设备 7，在 profile 里填写：

- `inbox=/canness/inbox`
- `outbox=/canness/outbox`
- `device` 选本次允许使用的卡
- 容器评测使用转发到 `20022` 的端点，并带上容器内的 `setEnv`

这些值属于这台机器的配置，不改 bundle 默认值。

## 不在本记录里的产品问题

- 尝试目录不回收：CAN-203。
- 预检不报告工具链版本和转发配置：CAN-201。
- `SOC_VERSION` 与 `npu-smi` 芯片名未对照：CAN-202。
