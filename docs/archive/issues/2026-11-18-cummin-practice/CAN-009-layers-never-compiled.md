# CAN-009 契约要求四层，但只有 `op_kernel/kernel.cpp` 会被编译：host/api/plugin 是死代码

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | **P1** |
| 组件 | 构建契约 v1（`templates/build-contract/build.sh`、`templates/cannbench/launch.cpp`） |
| 首次发现 | 2026-11-18，Cummin 首轮读 build.sh 时 |
| 状态 | **fixed-in-src（采纳方案 B：documented-only）** |
| 标签 | `contract`, `design`, `export` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：契约显式区分「被编译」与「仅文档」——`manifest.json` 新增 `compiledLayers: [op_kernel/kernel.cpp]` 与 `documentedOnlyLayers: [op_host, op_api, op_plugin]`，并额外记录 `attrsDerived`；导出 provenance 同步记录这两个字段；新增 `docs/contracts/direct-launch.md` 明确说明「三层仅被复制与哈希，不参与评测或自动导出」，并给出「任意 host 几何代码需要自定义 wrapper + 独立校验」。

**结果**：不再存在「写了、从不验证、却暗示生效」的层；几何仍走 attrs（CAN-010 提供按名读取，缓解了该风险）。

**验证**：`tsc` 干净、`vitest` 243 项通过；`docs/contracts/direct-launch.md` 为本条的文档载体。

## 现象

`build.sh` 只编译两个 TU：

```bash
"$BISHENG" … -c op_kernel/kernel.cpp -o kernel.o
"$BISHENG" … -c main.cpp -o main.o
"$BISHENG" main.o kernel.o -o canness_run …
```

导出的 CANNBench 包同样只编 `csrc/op_kernel/kernel.cpp` + `csrc/launch.cpp`。也就是说
`op_host/host.cpp`、`op_api/api.cpp`、`op_plugin/plugin.py` 在整个生命周期里**从未被编译或执行**，
但契约要求每代都写、manifest 把它们列为 `layers`、`provenance` 也按层记录。

后果是结构性的：我在 `op_host` 里算好的 `(outer, axis, inner)` **无法到达 kernel**，
因为 `launch.cpp` 只传 `total`（元素数）与 spec 的静态 `attrs`。真正的几何只能靠运行时
attrs 传（本次做法），这又直接导致了导出签名失真（CAN-011）。

## 期望

二选一，不能停在中间态：

- **A**：把 host/api 接进构建 —— 导出包的 `cannbench_launch` 调用 host 侧的 tiling 计算，
  kernel 从 tiling 结构体读几何（形状/外内轴、dim 归一化都在 host 完成）；
- **B**：契约明确声明这三层是**文档层**（不进构建、不参与评分），并删除 manifest 里
  "layers 参与构建"的暗示。

## 影响

- 每代 ~3 层 300 行是纯手写文档，却没有任何编译/执行校验（写错也不会有反馈）；
- 几何通路只能靠 attrs 偷渡 → 导出签名异常（CAN-011）、attr 顺序敏感（CAN-010）；
- `plugin.py` 里我写的 `cummin()` 与导出真正使用的 `cann_bench/__init__.py` 是两份互不相干的实现，
  官方签名对不上也没有任何提示。

## 复现

1. 在 `op_host/host.cpp` 里写一段无法编译的代码（例如未定义符号）；
2. `build_test_package` + `run_evaluation` → 依然 `compile.ok: true`；
3. 导出后审 `csrc/` 目录，确认 host/api/plugin 均未参与。

## 建议修复

1. 若选 A：`CannessTilingData` 增加形状通道（如 `int64_t shape[8]; int32_t rank; int64_t dim;`
   或一个 `geometry{outer,axis,inner}` 三元组），由 host 侧 tiling 写入；`launch.cpp` 改为
   调用 host 层；`op_host`/`op_api` 进 build.sh；
2. 若选 B：manifest 增加 `documentedOnly: ["op_host/host.cpp", …]`，文档同步；
3. 无论哪种：`plugin.py` 与导出的 `cann_bench/__init__.py` 至少共享同一条签名来源（见 CAN-011）。

## 验收标准

- A：host 里故意写坏 → 构建失败；kernel 从 tiling 里读到形状而非 attrs；
- B：manifest/文档明确三层不参与构建，且 `provenance` 里标注 `documented`；
- 不存在"写了但从不被验证"的层。

## 关联

CAN-010（attrs 顺序）、CAN-011（导出签名与验证）
