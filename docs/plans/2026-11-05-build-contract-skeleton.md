---
title: 构建契约补齐（方案 B：骨架 + 插槽）
date: 2026-11-05
status: 实施方案（待评审，未动手）
relates_to:
  - "../design/05-plugin-architecture.md §5.3"
  - "REPORT-A.md（任务 A：评测链路真实化）"
---

# 构建契约补齐实施方案（方案 B：骨架 + 插槽）

## 1. 问题

PR `v0.2.0`（`b037b84`）把评测侧改成 `remote/runner.py` 执行 **build contract v1**：

```
包内必须有 build.sh 与 run_once.sh，缺任一个 → compile_fail:
"package does not implement build contract v1"
build.sh     最后一行 stdout 打印可执行文件绝对路径
run_once.sh  stdout 打一行 CANNESS_RESULT {maxAbsErr, maxRelErr, badCount, total}
```

但生成侧 `build_test_package` 只复制四层文件 + `manifest.json`（`plugin/src/package-files.ts`），**没有任何工具能写出这两个脚本**。于是真实链路必然：

```
submit_spec → write_operator → build_test_package → run_evaluation
   ✅            ✅                 ✅（四层+manifest）      ❌ compile_fail（恒失败）
```

且该 `compile_fail` 计入 `compileRetries`，3 次后 `stopped: compileRetries`，闭环无法推进。

**根因**：任务 A 把"包怎么跑"的契约下放给了包本身，但"包怎么长出这些脚本"被划到任务 B 且尚未合入。

## 2. 方案取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| A（全交给模型） | 开写文件通道，模型自由写 `build.sh` / `main.cpp` | 否决：`write_operator` 只有四个必填参数，无写入通道；模型要重写 90% 重复的 ACL 骨架，且踩已记录在知识库的坑（`VecCore`、`AIV-only`、tiling 放 device） |
| B（纯模板库） | 插件按算子类型出完整模板 | 否决：算子多、阶段早，模板按类型爆炸 |
| **B′（骨架 + 插槽）** | **插件提供算子无关骨架，只有 golden 交给模型/知识库** | **采纳** |

B′ 的依据：build 契约里三件事的性质不同——

| 部分 | 性质 | 归属 |
|---|---|---|
| 编译编排（bisheng 参数、链接、exe 产物） | 算子无关 | 骨架 |
| 主程序（ACL 分配/拷贝/launch/同步/打点） | 结构与签名有关，流程固定 | 骨架 |
| **精度参考（golden）** | **每个算子一个公式** | **插槽** |

因此模板**不按算子类型分化**，只按"输入输出个数"泛化。

## 3. 做了什么

### 3.1 `build_test_package` 产出 build contract v1

`build_test_package` 在原有"复制四层 + 写 `manifest.json`"之后，追加渲染三个模板文件：

| 文件 | 来源 | 内容 |
|---|---|---|
| `build.sh` | 模板 | 编译 kernel + main → 链接 exe，最后一行打印 exe 绝对路径；`--soc` 可由 spec 的 `target_platform.soc_version` 推出，缺省 `Ascend910B2` |
| `run_once.sh` | 模板 | 跑 1 次 exe，解析 `CANNESS_RESULT`，`badCount != 0` 或超阈值时非 0 退出 |
| `main.cpp` | 模板 + 插槽 | ACL 骨架（`aclInit` → `aclrtMalloc` → 数据填充 → launch → `SynchronizeDevice` → 精度对比 → 打点）；`#include "golden.h"` 引入插槽 |

`golden.h` 同样由模板生成，但内容是**基于 spec 的兜底实现**（见 3.3），模型用 `write_package_file` 覆盖它即可替换为真实公式。

### 3.2 模板的分化粒度

模板只按 spec 的形状泛化，不按算子类型分化：

- 输入/输出张量个数：`input_specs.length` / `output_specs.length`
- 每个张量的 dtype：从 `TensorSpec.dtype` 映射（fp16 / bf16 / fp32）
- 每个张量的 shape：从 `TensorSpec.constraints` 取具体值；无约束的维度用安全默认（如 128），并在 `manifest.json.params` 里记录本次使用的具体 shape，便于复现
- tiling 结构：**统一使用 `totalLength / blockLength / tileLength` 的通用 `CannessTilingData`**，由模板提供 shim 头，不再要求每个算子自带 `GeluTilingData` 这类命名

### 3.3 golden 插槽

**判定口径（已确认）**：占位 golden 判 `accuracy_fail`，不判 `error`——它是"公式还没写"而不是"运行失败"。但报告必须带足信息，让模型和人都能判断差在哪：

| 字段 | 占位时的内容 |
|---|---|
| `status` | `accuracy_fail` |
| `summary` | `golden not implemented: fill golden.h in the package, then re-run build_test_package and run_evaluation` |
| `correctness.ok` | `false` |
| `correctness.maxRelativeError` | `main.cpp` 输出的原始 `maxRelErr`（可比较，不是 null） |
| `runRecord.params.golden` | `placeholder`（换成真实实现后为 `custom`） |

`main.cpp` 检测到占位时输出 `badCount: -1`、`total: <元素数>`，runner 现有逻辑（`badCount == 0` 才通过）自然会判 `accuracy_fail`，无需改 runner。

- **模型替换**：新增 `write_package_file(path, content)` 工具，只允许写包目录内、白名单仅 `golden.h`。模型按知识库里的算子公式填写后重新 `build_test_package` 或直接覆盖再评测。
- **模型可见的注释（已确认）**：不靠"开更多插槽"来解决泛化，而是把信息以注释形式写进模板产物——`golden.h` 头部说明"填什么、阈值是多少、怎么验证"，`main.cpp` / `build.sh` 里标注"这段不要改；如果这个算子确实需要改，请先说明理由"。**模板本身保持通用，只有确需修改时才改模板**，不在首版预留覆盖口子。
- 这样"模型什么都不做"时会**明确失败**而不是假通过；"模型想做"时有精确、最小的改动面。

### 3.4 精度阈值的来源

`spec.ts` 目前没有容差字段。改为：

- 由模板按输入 dtype 推导默认：fp16 `2^-10`、bf16 `2^-7`、fp32 `2^-13`（与 `Exp.md` 的实测口径一致）
- 写入包内 `config.json` 的 `maxAbsErr`，runner 已有的读取逻辑不变
- 不在 `spec.ts` 增加字段（若将来要自定义，再作为可选字段加入）

### 3.5 契约错误的预算归属

`package does not implement build contract v1` 是**包缺文件**，属契约错误：**不计 `compileRetries`**，单独计数并计入 `lastReport`，避免把真实的编译重试预算耗光。

`golden not implemented` 判 `accuracy_fail`，按现有计数规则走（`validIterations + 1`）。理由：模型已经能改 `golden.h`，这是可自主修复的缺口，不该免费；真正的修复路径是补公式，不是一个回合就重试一次编译。如果实测发现模型反复补不上、把 `maxIterations` 耗尽，再单独评估是否给它单独预算。

### 3.6 文档与知识库

- `Remote_NPU_Runner.md` 补充"包内文件由 `build_test_package` 生成"与 `golden.h` 插槽说明
- 根 README §7 工具表新增 `write_package_file`；§9 远端约定与 `manifest.json` 字段说明同步
- `docs/design/05-plugin-architecture.md` §5.3 增加"构建契约由骨架承接"一段
- `write_operator` / `build_test_package` 的工具描述写明 contract v1 的位置（工具描述是模型可见上下文，比知识库更可靠触达）

## 4. 解决了什么

| 问题 | 状态变化 |
|---|---|
| 真实链路 100% `compile_fail` | **消失**：包内必带 `build.sh` / `run_once.sh` / `main.cpp` |
| 模型要重写公共编译编排、易踩坑 | **消失**：bisheng 参数、ACL 流程、tiling shim、精度对比全部由骨架承担 |
| 模板按算子类型爆炸 | **避免**：只有 golden 一处随算子变化 |
| 算子未实现时可能"假通过" | **堵死**：占位 golden 判 `accuracy_fail` + `summary` 明说 `golden not implemented`，并保留 `maxRelativeError` 与 `runRecord.params.golden` 供比较 |
| 契约错误吃掉编译重试预算 | **修正**：缺 `build.sh`/`run_once.sh` 不计 `compileRetries` |
| 模型不知道该改什么、要不要改模板 | **改善**：模板内注释写明各段职责与改动条件，信息随包走 |
| `manifest.json.files` 与实际包不一致 | **修正**：`files` 改为实际落盘清单（含模板产物） |

## 5. 不解决什么（明确边界）

- **不保证任意算子一次编译通过**：kernel/host 四层仍由模型编写，编译错误仍归 `compile_fail`。
- **不生成算子本体**：只补"包怎么运行"，不改变四层代码的生成质量。
- **不覆盖多算子融合 / 动态 shape / 带 attrs 的算子**：首版模板只覆盖"张量进、张量出"的形态。这类算子**首版先不改模板、也不开覆盖窗口**——模板里用注释告诉模型现状，确实需要时再单独评估改模板。
- **不替代真机验证**：模板正确性只能在有 CANN 的机器上体现。

## 6. 逃生舱（首版后）

首版**只开 `golden.h`**，把变量面压到最小。`main.cpp` / `build.sh` 不开放给模型覆盖，模板里用注释写明"这些部分通用，确实需要改时再改模板"。

若后续出现模板确实覆盖不了的情况（多 kernel、多流、特殊 launch），再按需扩展：

- `write_package_file` 白名单扩展为 `main.cpp` / `build.sh`
- 或 `build_test_package` 增加可选 `overrides: { path: content }`

**原则：先改模板，后开窗口。** 每一步都要有对应的算子作为证据，不预先设计。

## 7. 验收

1. `build_test_package` 产物含 `build.sh` / `run_once.sh` / `main.cpp` / `golden.h` / `manifest.json` / 四层文件；`manifest.json.files` 与实际一致。
2. 单元测试：模板渲染结果包含 contract v1 必要元素（exe 路径打印、`CANNESS_RESULT`、`CANNESS_RESULT` 缺字段判定）；占位 golden 产出 `status: accuracy_fail` + `summary` 含 `golden not implemented` + `runRecord.params.golden == "placeholder"`。
3. 真实链路：用现有 Gelu generation（`canness-workspace/gen-741d0f76`，四层已存在）跑一次 `run_evaluation`，期望得到 `accuracy_fail: golden not implemented: …`（`maxRelativeError` 为数值而非 null，证明骨架能编译、能运行、能对比，只差公式），随后补 `golden.h` 再跑得到真实 `pass` / `perf_fail`。
4. `pnpm test` / `pnpm check` / `pnpm build` 全绿。

## 8. 落地顺序

1. 模板与渲染（`plugin/templates/build-contract/`，`package-files.ts` 接入；模板注释按 §3.3 写）
2. `write_package_file`（白名单仅 `golden.h`）
3. 精度阈值推导 + `config.json`
4. 契约错误的预算归属（`policy.ts`）
5. 文档与知识库
6. 真机验证（Gelu）
