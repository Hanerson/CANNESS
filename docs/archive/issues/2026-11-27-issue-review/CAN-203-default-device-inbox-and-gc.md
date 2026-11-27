# CAN-203 远端评测与校验的尝试目录没有回收

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P2** |
| 组件 | `plugin/src/eval-run.ts`、远端 attempt 目录 |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `gc`, `inbox`, `validate_submission` |
| 复核 | 2026-11-27。路径、选卡和锁改记部署配置；本条只留回收 |

## 现象

评测上传的 attempt 目录和 `submission-validation-*` 在结果写完后留在远端。`eval-run.ts` 的 `finally` 只尝试删除已上传到远端的临时 runner 脚本。

这台机器上的目录、设备和锁是部署配置，记在 [部署记录](NOTE-remote-deployment.md)。`/canness` 是独立挂载。默认 `/tmp/canness-a` 事先不存在，上传逻辑会创建它。设备覆盖变量未设置，5 份历史性能报告使用设备 7。临时目录提示的背景是仓库里已有的 CAN-014：`/tmp` 与 `/var/tmp` 会带 `artifactWarning`，默认路径仍可由配置改成持久目录。

## 证据

- `plugin/src/eval-run.ts` 的 `finally` 只 `removeFile(runnerPath)`。上传的 attempt 目录和 `submission-validation-*` 没有对应删除。
- 2026-11-27：容器内默认 `/tmp/canness-a` 不存在。`/canness` 为独立挂载。`/canness/inbox` 已有多份 `submission-validation-*`。
- 设备覆盖未设置。5 份历史性能报告的设备号为 7，与 runner 未传 `--device` 时的默认一致。
- 仓库 CAN-014（`docs/archive/issues/2026-11-18-cummin-practice/CAN-014-remote-artifacts-tmp.md`）已要求对 `/tmp` 给出提示。`plugin/src/eval.ts` 约 461–463 行在路径匹配 `/tmp` 或 `/var/tmp` 时设置 `artifactWarning`。

## 影响

同一 generation 的正式评测在 `inbox/<generation>/` 下累积 `attempt-*`，提交验收在 inbox 根目录下累积 `submission-validation-*`。两类包体和日志都占用远端磁盘。

## 期望

评测和校验结束后删除本次 attempt，或提供显式回收并默认保留最近 N 次。失败时保留日志、删除包体。路径、设备和锁由部署配置填写，不在本条里改默认值。

## 复现

1. 对同一 generation 发起多次会实际运行的评测，并执行多次提交验收。评测需避开同包结果缓存。
2. 分别统计远端 `inbox/<generation>/attempt-*` 和 `inbox/submission-validation-*`，确认两类目录随实际运行累积。
3. 确认远端临时 runner 脚本已清理，已完成的尝试目录仍在。

## 建议修复

- 成功写出 `results.json` 后按策略删除本次 attempt 与 validation 目录。
- 失败时保留日志、删除包体。
- 回收策略写成配置项，默认有上界。

## 验收标准

- 对同一 generation 执行超过保留上限的正式评测，并执行超过上限的提交验收。回收后分别统计 `inbox/<generation>/attempt-*` 和 `inbox/submission-validation-*`，两类已完成目录数量均符合配置的保留上限。
- 回收不影响进行中的任务和仍在保留期内的结果路径。成功包体按策略到期清理，失败仍能取回保留期内的日志。

## 关联

仓库 CAN-014、[部署记录](NOTE-remote-deployment.md)。

## 处置和验证

保留最近的已完成评测和提交验收，自定义上限可关闭。回收仅匹配合法尝试目录和完整标记，保留当次结果、在途记录及未知目录。只用本地夹具验证删除。
