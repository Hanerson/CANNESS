# CAN-021 评测闭环只覆盖构建契约（kernel + main.cpp），导出包（launch.cpp + cann_bench）不在闭环内

> 去重：本条与既有 **CAN-105**（闭环只覆盖单 shape）及仓库 **CAN-009 / CAN-011** 重叠，建议并入 CAN-105 的「闭环范围」章节。

| 字段 | 值 |
|---|---|
| 类型 | enhancement（闭环设计） |
| 优先级 | **P1** |
| 组件 | `canness-eval`（`run_evaluation`）/ `canness-generator`（`export_submission`） |
| 首次发现 | 2026-11-25，`run_evaluation` 连续通过（精度 PASS），而导出包属性传递/设备问题反复失败 |
| 状态 | **open** |
| 标签 | `eval-loop`, `export`, `contract-mismatch` |

## 现象

`run_evaluation` 编译并运行的是**构建契约包**：`op_kernel/kernel.cpp` + `main.cpp`（自带
固定 attrs、固定 tliling、固定 `DataCopy` 输入）。它完全绕过了导出包真正运行时的路径：

- `csrc/launch.cpp`（`canness_launch`：**由 wrapper 逐次传入 attrs**）；
- `cann_bench/__init__.py`（ctypes 绑定 + 几何推导 + 守卫）；
- `build.sh` 的 arch 映射与 wheel 打包。

本轮的证据链：
- `run_evaluation` 从第 1 轮起就 PASS（1659 µs、badCount 0），但导出包在同一台机器上
  因为 wrapper/设备问题 `validate_submission` 连挂三次；
- 反过来，`interleaved`/`layout=1` 在 `main.cpp`（build-contract）里 badCount 0，但经
  wrapper 调用曾表现为"崩"（后经 CAN-024 定位是 wrapper 守卫抛 ValueError，而不是 kernel）。
- `CAN-011` 当时引入 `validate_submission` 是为了补这个洞，但**它没有接进迭代闭环**：
  既不是 `run_evaluation` 的一部分，也不在 `export_submission` 时自动触发，全靠人记得跑。

## 影响

- "评测通过" 与 "提交物可用" 是两件事，前者很容易给出虚假信心；
- 每轮都要人工手搓"导出 → scp → 手工 build → 写脚本跑"，且不受迭代预算/策略保护。

## 期望

1. `run_evaluation` 在构建契约通过后，**自动**对同一 generation 的导出包做一次
   build + 安装 + 最小 smoke（可用同一设备与锁），结果作为报告的 `submission` 字段；
2. 或 `export_submission` 默认触发 `validate_submission`（可用 `skipValidation` 关闭）；
3. 报告里明确区分三列：`kernel`（契约）/ `package`（导出包构建）/ `submission`（安装后调用）。

## 复现

1. 任一算子 `run_evaluation` → PASS；
2. `export_submission` → `validation: unverified`；
3. 不手工验证直接提交 → 官方侧才暴露 launch/wrapper/build.sh 的问题（本轮 3 次失败）。

## 建议修复

- 把 `validate_submission` 的 runner 逻辑复用进 `run_evaluation` 的最后一个阶段（设备/锁一致，见 CAN-020）；
- 阶段失败不占用精度/性能预算，但计入 `submission` 状态；
- `export_submission` 的返回值里带上 `validation` 结果而不是固定 `unverified`。

## 验收标准

- 一次 `run_evaluation` 之后，报告能回答"这个包能不能装、能不能调、能不能算对"；
- 导出包路径上的 bug（launch 的 attrs 顺序、wrapper 守卫、build.sh arch）在插件内就能暴露；
- 预算策略明确区分"精度/性能迭代"与"打包验证"。

## 关联

CAN-011（导出物的验证缺口）、CAN-020（验证环境不一致）、CAN-019（build.sh 通道）
