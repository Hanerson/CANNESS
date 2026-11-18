# CAN-014 远端工件默认落 `/tmp`（CANNLab 重启即失），且 `fetch_remote_file` 只允许 outbox / 当前代 inbox

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | **P2** |
| 组件 | `canness-eval`（inbox/outbox 配置）/ `fetch_remote_file` |
| 首次发现 | 2026-11-18，会话复盘 |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `remote`, `persistence`, `dx` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`eval.ts` 的 `withPaths` 增加 `artifactsPersistent` 与 `artifactWarning`（检测 `/tmp`、`/var/tmp`，提示改用 `/mnt/workspace` 这类持久挂载）；`fetch_remote_file` 允许当前代 + 历史代（从 `operators/`、`packages/` 枚举，正则限制 `gen-[A-Za-z0-9-]+`）+ `readRoots`，返回 `sha256`，落盘改为 `wx` 临时文件 + `rename`。

**残留**：默认仍是 `/tmp`（按「不静默改用户配置」的约束只做提示）。

**验证**：`remote-read.test.ts`（新增）+ 已有的路径包含性测试。

## 现象

默认远端目录是 `/tmp/canness-a/inbox|outbox/<generationId>`；`fetch_remote_file` 只允许这两个
子树。本次 3.5 小时、6 次评测没有触发重启，但：

- 长任务一旦 CANNLab 重启，`results.json`、`.msprof-*` 目录、包本体全部消失（文档也提到
  需手动配置可持久路径 —— 属于"知道要配、容易忘"的隐性要求）；
- 想取回**非本轮生成**的诊断材料会失败：例如上一代的 msprof CSV、导出的 zip、或工具链
  头文件（后者见 CAN-005）。

## 期望

1. 首次评测时若检测到 inbox/outbox 位于 `/tmp`，给出一次显式提示（含"如何配置持久路径"），
   或在 CANNLab 环境里默认选一个可持久目录；
2. `fetch_remote_file` 的允许范围扩展到：当前 workspace 下的全部代（`inbox/*`、`outbox/*`）
   + 可配置白名单（如 `$ASCEND_TOOLKIT_HOME/**`、导出目录），并对读取记录 sha256；
3. 报告里记录 `resultsPath` 与"是否 tmpspace"，便于事后判断工件是否已失效。

## 影响

- 一次重启就可能让"复现某个数字"变成不可能（只有报告里的数字留下，原始 CSV 没了）；
- 与 CAN-005 同源：只读范围过窄，让所有远端事实都必须通过"打包-评测"这条昂贵通道获得。

## 复现

1. 任意 `run_evaluation`，从返回的 `resultsPath` 看到 `/tmp/...`；
2. 尝试 `fetch_remote_file` 一个上一代的 `results.json` 或 `/home/developer/Ascend/...` 下的文件 → 被拒。

## 建议修复

1. 配置项 `inbox`/`outbox` 之外增加 `persistRoot`；CLI/设置卡提供一键切换；
2. `fetch_remote_file` 的路径校验改为"白名单前缀集合"，默认包含 workspace 全部代；
3. 报告标注 `artifactsPersistent: true|false`。

## 验收标准

- 默认或一次配置后，工件在实例重启后仍可取回；
- 能取回任意历史代的 `results.json` 与 msprof CSV；
- 报告能说明本次工件是否位于临时目录。

## 关联

CAN-005（远端只读探测）、CAN-002（workspace 位置）
