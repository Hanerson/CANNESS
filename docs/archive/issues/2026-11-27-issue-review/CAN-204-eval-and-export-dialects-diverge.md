# CAN-204 默认评测构建使用 `-x cce`，默认导出会探测 `-xasc`

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/templates/build-contract/build.sh`、`plugin/templates/cannbench/build.sh` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **partial** |
| 标签 | `build`, `dialect`, `eval-loop` |
| 复核 | 2026-11-27。限定默认构建；同一算子的精度和性能差异未验证 |

## 现象

默认评测编译构建契约，契约脚本把参数写成 `-x cce --cce-soc-version=... --cce-soc-core-type=VecCore`。CANNBench 导出脚本会先试 `-xasc --npu-arch=...`，失败再退回旧方言，并把实际方言写进 `dist/build-env.txt`。评测脚本可以经 `repair_package` 替换，所以上面说的是默认构建，不是每次评测都改不了的命令。

2026-11-27 在 CANN 9.2.1 上，同一份带 AIV 类型声明的最小源码用两种方言都编译成功。7 份历史导出都选择了 `modern/dav-2201`。同一算子在两条默认路径上的精度、性能和完整构建是否有可归因的差异，尚未对照。

## 证据

- `plugin/templates/build-contract/build.sh` 第 33 行：`FLAGS=(-x cce -std=c++17 "--cce-soc-version=$SOC_VERSION" --cce-soc-core-type=VecCore)`。默认契约脚本没有 `-xasc` 探测。
- `plugin/templates/cannbench/build.sh` 第 9–10 行与第 107–143 行：先 `-xasc --npu-arch=`，再在需要时退到 `-x cce --cce-soc-version=`。
- `repair_package` 可以替换评测包里的构建脚本。替换之后，实际命令以包内脚本为准。
- CANN 9.2.1 上，同一份最小 AIV 源码以 `-x cce` 和 `-xasc` 编译均成功。
- 7 份历史导出的方言记录均为 `modern/dav-2201`。
- `plugin/src/package-files.ts` 在规格只写了家族 `ascend910b`、没有 B1/B2/B3/B4 部件号时，把评测编译目标写成 `DEFAULT_SOC_VERSION`（`Ascend910B2`）。

## 影响

默认契约评测和默认导出对同一份未替换的源码使用不同的方言探测。历史导出记录是现代方言。两条路径都能编过最小 AIV 源码。在同一算子上对照精度、性能和完整构建之前，不能从方言不同推出结果不同。

## 期望

报告写出这次实际使用的方言和架构参数。默认契约路径与默认导出路径使用的命令可以不同，但差异要出现在 `runRecord` 和 `dist/build-env.txt` 里，字段名一致。`repair_package` 替换过脚本时，报告以替换后的命令为准。

## 复现

1. 不调用 `repair_package`，看 `packages/<id>/build.sh` 的 `FLAGS`。
2. 看 `submissions/<id>/build.sh` 的探测分支。
3. 对照历史导出的 `build-env.txt`：7 份均为 `modern/dav-2201`。

## 建议修复

- 默认评测报告增加 `dialect` 与架构参数，和导出的 `build-env.txt` 用同一组字段名。
- 用同一算子、同一输入，分别走默认契约构建和默认导出构建，记录精度与性能。有可归因的差异再决定是否把探测抽成共用片段。
- 保留 `repair_package` 替换脚本的能力，并在报告里标出脚本已被替换。

## 验收标准

- 默认评测日志和导出 `build-env.txt` 都写出方言与架构参数。
- 同一算子的精度、性能和完整构建对照有记录；对照完成前，文档不把「方言不同所以结果不同」写成事实。
- 替换过评测脚本的包，报告里的命令与包内脚本一致。

## 关联

CAN-201、CAN-209。

## 处置和验证

默认构建和导出报告记录实际方言、架构、编译参数和构建脚本来源。历史两套方言编译证据与本地报告测试通过。同一算子的两条路径仍待真机精度和性能对照。 [远端验证边界](evidence/README.md)
