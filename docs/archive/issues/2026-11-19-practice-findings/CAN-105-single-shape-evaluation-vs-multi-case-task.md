# CAN-105 评测闭环只覆盖 spec 的字面 shape，而任务是 20 个 case；插件没有 case sweep

| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | **P0（会让"插件内全绿"的算子在正式评测里大面积失败）** |
| 组件 | `submit_spec` / `build_test_package` / `run_evaluation` / `export_submission` 的整体闭环 |
| 首次发现 | 2026-11-19（实现完成后第一次多 shape 自检） |
| 状态 | 已绕过（工作区自建多 case 校验器），插件未提供 |
| 标签 | `evaluation`, `coverage`, `workflow` |

## 现象

插件的评测闭环是**单 shape** 的：`build_test_package` 把 spec 里的字面 shape
写死进 `main.cpp`（`CANNNESS_TOTAL_ELEMENTS`、`CANNESS_SHAPE_VALUES`），
`run_evaluation` 就跑这一个 shape。

而 CANNBench 的一个算子有 **20 个 case**：rank 2–5、`dim ∈ {-1, 0, 1, 2}`、
fp16/fp32/bf16、最大 1,000,003×…、总元素到 ~134M（官方 metadata
`tasks/metadata/910b2.json` 的 `level1.swi_glu` 里 20 条 `t_hw_us` 从 1.0 到 278.3 us）。

后果：我的算子在插件闭环里 `correctness.ok = true`（8192×16384, dim=-1, fp16），
但我自己扫了 17 个 shape 后发现 **5 个 shape 会让 vector core 异常 / 精度错**：

```text
[2,4096,3] dim=1 fp32      -> vector core exception (507035)
[255,64]   dim=-1 fp32     -> NaN pattern mismatch
[2,4,5,8]  dim=3 bf16      -> vector core exception
[2,3,4,6]  dim=2 fp16      -> vector core exception
[1000003,8] dim=1 fp16     -> vector core exception
```

也就是说：插件说"过了"，正式评测会掉 5~8 个 case 的精度分，甚至（如果评测器
把所有 case 跑在同一进程里）被一次设备异常污染掉整轮。

## 证据

- `package-files.ts::launchGeometry()` / `renderBuildContract()`：
  `SHAPE_VALUES`、`TOTAL_ELEMENTS` 均来自 `spec.input_specs[0].shape`；
- `main.cpp` 模板只构造一组 `in0/out0`；
- `config.json` 里 `params.inputValues`、`accuracy` 也只针对这一组；
- 官方 case 数量与量级来自 `ref` 里的 metadata（见上）。

## 影响

- "插件内通过"与"正式评测得分"之间没有任何覆盖关系保证 —— 这是最伤的一类错，
  因为它在最贵的环节（正式提交）才暴露；
- 用户会自然地把 `run_evaluation` 当成"精度已验证"，从而停止做 shape 覆盖；
- 我最终不得不把 `validate_submission` 当作主循环（它免费、可跑任意 case 矩阵），
  但这在文档里是"可选/未验证"的定位，不是设计上的主力路径。

## 我用的临时补丁

工作区自建 `tools/validate_cases.py` + `tools/bench_compare.py`：

- 用 `export_submission` 出可安装的 wheel，再交给 `validate_submission` 在真机跑；
- 内置一张 case 矩阵（rank/dim/dtype/边界 shape）；
- **每个 case 一个子进程**（见 CAN-106），一次设备异常只毁一个 case；
- 同时把 `torch_npu.npu_swiglu` / torch 分解实现放在同一进程里计时，
  得到"基线到底多快"（这是性能评分锚点，插件侧完全没有）。

## 建议修复

1. `submit_spec` 支持 `case_matrix`（或 `shapes` 列表），`build_test_package` 生成
   多 case 的 `main.cpp`（循环跑、每 case 打印一行 `CANNESS_RESULT`）；
2. `run_evaluation` 的 report 里按 case 聚合（现成的 `per_case_scores` 结构在
   官方 `cann_scoring.py` 里已有，可以对齐）；
3. 把 `validate_submission` 提升为一等公民，并在 `preflight_evaluation` 里提示
   "spec shape 只是单个 proxy case"；
4. 内置"基线对照"：同一 shape 跑 `torch_npu` 对应算子，把 baseline 写进 report
   （现在 `analysis.baselineUs` 恒为 null）。

## 验收标准

- 一次 `run_evaluation` 能给出 ≥5 个 case 的精度/性能行；
- report 里 `baselineUs` 非空（同机实测，而非文档里的估计值）；
- 新增一个"未覆盖 case"的提示：spec shape 与 case 矩阵不一致时 `preflight` 给 warning。
