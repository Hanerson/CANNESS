# CAN-004 `negativeStreak` / `force` / `reset` 构成死锁，且 `pendingStage` 语义被重载

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | design + bug |
| 优先级 | **P0** |
| 组件 | `canness-loop`（policy）/ `canness-eval` |
| 首次发现 | 2026-11-18，Cummin 实现的第 4 轮之后 |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `policy`, `loop`, `state`, `blocks-loop` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`report.ts` 增 `blockedBy: 'policy'|'transport'`、`stopReason`、`policyEvidence`；`eval.ts` 的 `stoppedReport` 带 `blockedBy:'policy'` 与证据；`policy.ts` 新增 `canForceEvaluation`（每个预算窗口允许 1 次显式重测，且只跨越 `negativeStreak/stalled/converged/targetMet`，不越过资源上限）；`applyReport` 里重复测量（包指纹相同）与「测量协议变更」（host/toolchain/runs/samplingBasis/metricBasis/warmupRuns/device 变化）另开窗，负向连击只在**相邻**候选劣化 >3% 时累加。

**验证**：`plugin/tests/practice-policy.test.ts`（新增）覆盖重复测量不计变差、协议变更重置、force 仅一次。

**残留**：被拒报告仍不写 state（`lastReport` 停在旧值）→ CAN-017 第 3 点。

## 现象

连续三轮"未改善"后评测直接拒绝执行：

```json
{"status":"error","summary":"stopped: negativeStreak","pendingStage":"run_evaluation"}
```

而这三轮的实际内容是**同一算法的三次消融**（换 int64 索引写法、换并行度），精度一直通过：

| 轮次 | 变更 | kernelTimeUs |
|---|---|---|
| 1 | int64 Cast + 2D DataCopy | 1231.4 |
| 2 | 双 32-bit 平面 strided 写 | 1277.8 |
| 3 | 常量 lane 数 + 恢复 Cast | 1240.1 |

三轮都被计入 `negativeStreak`（`recentKernelTimeUs` 1231 → 1277 → 1240），于是：

- `run_evaluation({force:true})` 也被拒（`force` 只跳过包去重，不跳停机规则）；
- 唯一出路是 `submit_spec({reset:true})`（进而触发 CAN-003）；
- 该 `error` 报告同时带 `pendingStage: "run_evaluation"`，而文档对该字段的定义是
  **连接/传输失败后恢复重试**（"若结果报告 `pendingStage: "run_evaluation"`，检查 SSH、
  隧道和 CANN 状态"）—— 本次网络全程正常，按文档排查会白查一趟。

## 期望

1. 策略停机不应把"主动做实验"与"调参调崩"混为一谈；
2. 停机后的显式重测请求（`force`）应当被允许，至少允许一次；
3. `pendingStage` 只表达传输/连接态；策略拒绝用独立字段。

## 影响

- 直接掐断了最有价值的迭代方式（提出假设 → 测量 → 回退），本次被迫提前收敛到 789 µs 的版本；
- 恢复路径 `reset` 会丢源码（CAN-003）；
- `pendingStage` 误导排查方向。

## 复现

1. 让连续 3 轮 `perf_fail` 且 `kernelTimeUs` 不下降（哪怕是为做消融而有意为之）；
2. `run_evaluation()` → `stopped: negativeStreak`；
3. `run_evaluation({force:true})` → 同样被拒；
4. 观察返回里仍带 `pendingStage: "run_evaluation"`。

## 建议修复

1. **区分失败类型**：`status: "perf_fail"` 但"算法未变（包指纹未变/仅内部常量变化）"时，
   不计入 `negativeStreak`，或改用"包指纹变化 → 重新开窗"的规则；
2. `force: true` 至少放行一次（例如 `forceAllowAfterStop: true` 或 `maxForcedRuns`）；
3. 新增 `blockedBy: "policy" | "transport"` 与 `stopReason`（policy 里已有 `StopReason`
   枚举，把它透出到报告即可），`pendingStage` 仅在传输失败时出现；
4. 报告里附"为什么被计为变差"的证据（`recentKernelTimeUs` 目前在 state.json 里，报告里没有）。

## 验收标准

- 同一包指纹重复测量不计入变差；
- 停机后 `force` 能跑通一次并给出新数字；
- 策略停机的报告不含 `pendingStage`，且带 `stopReason: "negativeStreak"` 与 `blockedBy: "policy"`。

## 关联

CAN-003（reset 丢源码）、CAN-007（采样口径影响可比性，会额外制造"假变差"）
