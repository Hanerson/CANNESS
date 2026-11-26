# 2026-11-25/26 ApplyRotaryPosEmb 实践问题归档

本轮在 Ascend910B2（CANN 9.2.1）上做 ApplyRotaryPosEmb，并按 CANNBENCH 格式向 A3（910C）提交。
共记录 9 条，其中 **7 条已在 2026-11-26 的补丁里闭环**，1 条残留（能力矩阵语义边界），1 条只有 workaround。

- 修复说明：[CHANGELOG](../../../../CHANGELOG.md)（`[Unreleased]`）
- 关联知识：[AscendC 编译与直连运行](../../../../plugin/knowledge_base/AscendC_Compile_Run.md)、
  [Level-2 调用开销](../../../../plugin/knowledge_base/entries/ascendc-level2-call-overhead.md)

## 条目

| ID | 优先级 | 标题 | 结论 |
|---|---|---|---|
| [CAN-018](../2026-11-25-a3-target-hardware/CAN-018-target-hardware-confirmation.md) | P1 | 导出把编译目标写死成 SoC 部件号；目标硬件只靠探测、无用户确认 | **fixed**：`arch_family`/`mode`/`confirmation`、`resolveSoc`、`submit_spec(detected_soc, confirm_target)` |
| [CAN-019](CAN-019-export-build-script-not-overridable.md) | P1 | `build.sh` 只能整体换模板，`repair_package` 改它对导出无效 | **fixed**：`export_submission({build_script})` + `provenance.build` + 提示 |
| [CAN-020](CAN-020-validator-device-and-lock-mismatch.md) | P1 | 校验器不继承 runner 的设备/锁，把环境占用报成 kernel 崩溃 | **fixed**：`--device`/`--lock`/flock + `device_fault`/`device_unavailable` |
| [CAN-021](CAN-021-export-package-outside-eval-loop.md) | P1 | 评测闭环只覆盖构建契约，导出包不在闭环内 | **fixed**：`run_evaluation({submission})` |
| [CAN-022](CAN-022-perf-report-missing-call-budget.md) | P1 | 报告缺调用预算与 tiling 回显 | **fixed（opt-in）**：`CANNESS_TILING_REPORT` → `analysis.kernelBudget`，模板不默认注入 |
| [CAN-023](CAN-023-no-official-cases-regression.md) | P1 | spec 只能声明一条 shape，官方多 case 无工具 | **duplicate of CAN-105**；`validate_submission({cases_file})` 已一并覆盖 |
| [CAN-024](CAN-024-kernel-support-matrix-not-declared.md) | P2 | 能力矩阵无结构化声明，wrapper 守卫手写且与能力脱节 | **fixed**：`spec.support` + 生成 `support.py` 守卫（语义边界见 CAN-024 的"残留"节） |
| [CAN-025](CAN-025-no-probe-sandbox-for-golden-substitutes.md) | P2 | 没有探针沙箱，验 intrinsic 只能手工改包/换 golden | **fixed**：`probe_run` + `kb_search({include_probes:true})` |
| [CAN-026](CAN-026-kb-missing-arch-mapping.md) | P1 | KB 把编译目标写成部件号，缺 910B/A3/950 微架构映射 | **fixed**：`AscendC_Compile_Run.md` 增加映射表与 `-xasc` 示例 |

## 与 2026-11-19 条目的去重

| 本轮 | 已存在 | 结果 |
|---|---|---|
| CAN-019 | CAN-103（无修包通道）、CAN-104（hash 三源） | 并入 CAN-103 的"导出侧"实例 |
| CAN-020 | CAN-106（输出截断/无 case 隔离） | 扩展 CAN-106：新增设备与锁维度 |
| CAN-021 | CAN-105（单 shape 闭环）、CAN-009、CAN-011 | 并入 CAN-105 的闭环范围 |
| CAN-022 | CAN-113（KB 与实测矛盾）、CAN-006（报告空字段） | 并入 CAN-113，补实测数据 |
| CAN-023 | CAN-105 | **重复**，保留 CAN-105 |
| CAN-024 | CAN-110（shape-changing 导出缺口） | 扩展 CAN-110 |
| CAN-025 | CAN-112（golden fixture 绑字面 shape） | 扩展 CAN-112 |
| CAN-026 | CAN-113（KB 缺口） | 作为子项，独立编号保留 |

## 实测数字（供后续算子对照）

- 官方评测 case 1（`[16,512,16,128]` fp16 layout0 half）：精度通过，kernel **1659 µs**，`aic_scalar_ratio 0.79`。
- 单次 AscendC Level-2 调用约 **1500–1800 个标量周期**，与元素数几乎无关；调用数降到 0.46 次/行后约 1.66 ms 见底。
- 组合覆盖：fp16/fp32/bf16 × layout 0/1 × half/interleaved 共 14 组通过；官方 20 条 case 通过 18 条，
  残留 2 条（fp32 + interleaved）各有 1 个元素差 1 ulp，MERE 1e-7。
