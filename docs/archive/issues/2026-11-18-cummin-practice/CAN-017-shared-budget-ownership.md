# CAN-017 预算与归属状态按 workspace 共享：并行会话互相抢占，且被策略拒绝的报告不落盘

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | **P1** |
| 组件 | `canness-eval` / `canness-loop`（`state.json` 归属与预算） |
| 首次发现 | 2026-11-18 16:13，Cummin 包重建后再评测 |
| 状态 | **open（本次复核新增）** |
| 标签 | `policy`, `state`, `concurrency` |

## 处理情况（2026-11-18 16:20 复核）

**证据**：16:13 的 `run_evaluation({force:true})` 返回 `status: error` / `summary: stopped: maxIterations` / `pendingStage: run_evaluation`，但 `state.json` 显示 `validIterations: 5`、`negativeStreak: 2`、`ownerSessionId: session-51240fc1-…`（**非本会话**）、`lastReport.status: perf_fail`（**非本次被拒报告**）、mtime 与被拒调用同一秒。

**三个独立问题**：(1) 归属被另一会话持有；(2) 生效的 `maxIterations` 与仓库默认 10 不一致且报告里读不到；(3) 策略拒绝不落盘，事后无法从 state 复盘。

**建议**：报告带 `budget`/`ownerSession`；归属冲突单独 `blockedBy: ownership`；策略拒绝也持久化（`lastBlocked: {reason, at, session}`）；workspace 级互斥或按会话隔离预算。

**后果**：本次「用新模板重测算子」的回归验证无法执行，交付物停在「源码已重建、真机未复测」。

## 补充结案（2026-11-18 18:50）

实测 `run_evaluation({compile_only:true})` 的返回里已带上：

```json
"budget": {"maxIterations":5,"maxCompileRetries":3,"negativeStreakLimit":2,"convergenceThreshold":0.1,
           "validIterations":5,"compileRetries":0,"timeouts":0,"windowStartedAt":"2026-11-18T10:48:29.704Z"},
"ownerSession": "session-51240fc1-…"
```

据此按子问题结案：

| 原子问题 | 结案 | 依据 |
|---|---|---|
| (1) 归属被另一会话持有 | **部分解决**（可读，但无解释） | `ownerSession` 已进报告；且 `run_evaluation` 未被归属拦下 —— 归属守卫目前只作用于**写类**工具，只读/评测路径不受限 |
| (2) `maxIterations` 与仓库默认 10 不一致、报告读不到 | **已解释并解决** | **不是缺陷**：`~/.dsh/profiles/canness-web/cordis.patch.yml` 第 26/28/29 行把 eval 覆盖成 `maxIterations: 5`、`negativeStreakLimit: 2`、`convergenceThreshold: 0.1`（第 32/34/35 行才是 bundle 默认 10/3/0.05）。**我原先"被另一会话吃掉预算"的推断是错的**：真实原因是本会话 profile 的预算层只给了 5 次，5 次用完即停。现 `budget` 已直接暴露该值 |
| (3) 策略拒绝不落盘 | **已解决** | `assertTaskOwnership` 与 `eval.ts` 均写 `lastBlocked: {reason, at, session, blockedBy, budget}` |

**残留（低）**：归属冲突只在写类工具上抛 `OwnershipError`；`run_evaluation` 这类会推进 state 的
调用是否也要先过归属检查，需要把策略写明（当前行为：不拦）。

## 现象

同一 workspace 下第二次 `run_evaluation({force:true})` 直接返回：

```json
{"status":"error","summary":"stopped: maxIterations","pendingStage":"run_evaluation"}
```

而 `state.json` 的内容却是：

| 字段 | 值 |
|---|---|
| `validIterations` | **5** |
| `negativeStreak` | 2 |
| `bestKernelTimeUs` | 788.007 |
| `recentKernelTimeUs` | `[1243.63, 788.007, 788.874]` |
| `ownerSessionId` | **`session-51240fc1-…`（不是发起评测的会话）** |
| `lastReport.status` | `perf_fail`（**不是**刚才那条 `stopped` 报告） |
| `state.json` mtime | 16:13:44（与本次被拒的调用同一时刻） |

三个独立异常同时出现：

1. **归属不是本会话**：另一会话（16:00–16:09 修改插件的那一轮）在同一 workspace 上跑过评测并
   成为 `ownerSessionId`；
2. **预算口径不一致**：仓库内 `plugin/cordis.patch.yml` 写 `maxIterations: 10`，
   而状态里 5 次有效迭代就被判 `maxIterations`（生效配置与仓库默认值不一致，且无从在报告里读到）；
3. **被拒报告不落盘**：返回的是 `stopped: maxIterations`，但 `lastReport` 仍是上一条 `perf_fail`，
   因此事后从 state 里**看不出**发生过一次策略拒绝。

## 期望

1. 报告里带上预算口径与被拒证据：`budget: {validIterations, maxIterations, window, owner}`；
2. 归属冲突有明确文案（"workspace 由另一会话持有，本会话的预算是 X/Y"），而不是伪装成
   "你自己用完了"；
3. 策略拒绝也要持久化（至少 `lastBlocked: {reason, at, session}`），否则无法复盘；
4. 预算计数与 `ownerSessionId` 至少应能按会话隔离（或文档明确"一个 workspace 只能一个活跃任务"，
  并让第二个会话在 `run_evaluation` 前就被劝退）。

## 影响

- 本轮"最后一次回归验证"（用新模板重测我的 Cummin 包）直接无法执行，交付物停在
  "源码已重建、真机未复测"的状态；
- 两个会话（一个在做算子、一个在做插件修复）共用一个 workspace，**互相消耗预算并抢归属**；
- 被拒报告不落盘，导致"为什么跑不了"只能靠猜（我是靠对 mtime 和 `ownerSessionId` 才推出来的）。

## 复现

1. 在 workspace A 跑若干次 `run_evaluation`（会话 1）；
2. 同一 workspace 用**另一个会话**再跑一次（成为 owner，消耗窗口）；
3. 回到会话 1 再调用（带 `force:true`）→ `stopped: maxIterations`；
4. 读 `state.json`：`validIterations` 未超上限、`ownerSessionId` 是会话 2、`lastReport` 是旧报告。

## 建议修复

1. `EvalReport` 增加 `budget` 与 `ownerSession`（本条的修复在 `src` 里已部分完成：
   `blockedBy` / `stopReason` / `policyEvidence` —— 但见 CAN-016，未生效）；
2. 策略拒绝时仍写 `state.json` 的 `lastReport`（或单独的 `lastBlocked`）；
3. 归属冲突时优先返回 `blockedBy: "ownership"`（区别于 `policy` / `transport`）；
4. workspace 级互斥锁（一个任务一个 workspace），或让 `resolveWorkspace` 默认按会话隔离。

## 验收标准

- 两条并行会话各自的预算互不可见地消耗，或第二个会话被明确劝退；
- 任何被拒的评测都能在 state 里追溯（reason + session + 时间）；
- 报告能直接读出 `maxIterations` 的生效值与窗口起点。

## 关联

CAN-002（workspace 位置与并行干扰）、CAN-004（策略可观测性）、CAN-007（预算/口径）
