# CAN-023 spec 只能声明一条用例形状；官方 cases.csv 的多形状/特殊值回归没有工具化

> ⚠️ **重复**：与既有 **CAN-105** 是同一问题（且 CAN-105 论证更充分、含 17 shape 的实测）。建议删除本条，把 dev/official_cases.py / probe_all.py 作为 CAN-105 的现成绕过物引用。

| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | **P1** |
| 组件 | `canness-generator`（`spec.ts`/`build_test_package`）/ `canness-eval`（`run_evaluation`） |
| 首次发现 | 2026-11-25，ApplyRotaryPosEmb 需要验收 CANNBench 的 20 条官方 cases |
| 状态 | **open**（用户侧 workaround：`dev/official_cases.py` + `dev/probe_all.py` + 逐进程循环脚本） |
| 标签 | `cases`, `regression`, `cannbench`, `coverage` |

## 现象

`spec.input_specs[].shape` 是字面量，构建契约包只生成**一条** shape 的 `main.cpp`。而
CANNBench 的 `tasks/level2/<op>/cases.csv` 有 20 条：不同 `B/S/N/D`、三种 dtype、两种 layout、
两种 mode，还带 `inf` / `nan` / 全零三类特殊值。

于是本轮我不得不：

1. 手写 `official_cases.py`（把 20 条 case 的 shape/dtype/layout/mode/value_range 抄进来）；
2. 手写 `probe_all.py`（dtype × layout × mode 的 14 组合矩阵）；
3. 每例**单开一个进程**跑（否则一个 device fault 会把后面全遮住）；
4. 再手写 `fullcheck.sh` 把它们串起来。

代价：这些脚本只在我本地/远端临时目录里，没进包、没进报告，别人复现要重写一遍；而且
"kernel 覆盖 20 条 cases 里的几条"这个事实在插件里没有任何记录。

## 期望

1. `run_evaluation` / `preflight_evaluation` 支持 `cases_file`（官方 `cases.yaml`/`cases.csv`），
   生成多条 shape 的精度回归（**不消耗**性能迭代预算，或单独计数）；
2. 报告里给每例的 `MERE/MARE/pass`，并汇总"覆盖 n/20"；
3. `build_test_package` 允许 `spec.cases` 列表（多条 shape），把 `main.cpp` 里 shape 参数化
   （`ctx.shape` 已经支持 `CANNESS_SHAPE_RANK`，只差驱动）；
4. 特殊值（inf/nan/零）作为 `input_values` 已支持，但需要能**按 case** 组合。

## 影响

- 正确性结论依赖用户手写脚本，无法作为交付物的一部分；
- 官方只挑一条 shape 的评测（本算子 case 1）会掩盖 layout=1 / interleaved / 特殊值的缺陷
  —— 本轮 case5/case17 的 1-ulp 问题就是这样在"官方评测 PASS"之后才被发现的。

## 复现

1. `export_submission` → `provenance.json` 里只有一条 shape 的 `tensorSpecs`；
2. 跑官方 20 条 cases → 需要外部脚本；
3. 报告 `correctness` 只有一条 shape 的 `badCount`。

## 建议修复

- `spec.cases: [{shape, dtype, attrs, input_values}]`，构建契约与导出都按 cases 展开；
- `run_evaluation({cases: "official"})` 从 CANNBench 任务目录自动读取（远端已有 `cann_bench` 仓）；
- 报告增 `cases: [{id, pass, mere, mare}]` 与 `coverage: "18/20"`。

## 验收标准

- 一条命令得到"20 条官方 cases 的逐例通过情况"，且结论进报告；
- 特殊值 case 能作为独立 case 声明，而不是塞进 `input_values` 手工构造；
- 覆盖矩阵（dtype × layout × mode）能由 spec 自动生成并报告缺口。

## 关联

CAN-021（闭环）、CAN-024（覆盖矩阵声明）
