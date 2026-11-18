# CAN-015 缺少本地预验证通道：每次事实性错误都要用远端预算换

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | **P2** |
| 组件 | `canness-eval` / 插件工具集 |
| 首次发现 | 2026-11-18，Cummin 实现过程中手工搭建后 |
| 状态 | **部分 fixed-in-src（仅 golden 侧）** |
| 标签 | `dx`, `verification`, `budget` |

## 处理情况（2026-11-18 16:20 复核）

**已补**：`plugin/scripts/check-golden.mjs`（`npm run check:golden`）—— 用真实 `golden.h` + 生成的头文件在本机编译成宿主程序，对显式 fixtures 跑并比对，返回 `kernelValidated: false`；`local-validation.ts::checkGolden` 把它接进 `run_evaluation({golden_fixtures})`，失败则「no remote budget spent」；`docs/contracts/direct-launch.md` 明确写了「host stub 不能证明 AscendC 支持，kernel API 必须由目标编译器确认」——与我的结论一致。

**仍未做**：kernel 的多 dtype **stub 语法检查**（我这次手写的 `stub/kernel_operator.h` 那套），以及把 numpy 逐 op 算法模拟产品化。这两项是「本地挡住逻辑错误」的主力，建议优先补 stub 检查。

**验证**：`local-validation.test.ts`（新增）。

## 现象

本轮为了在"没有本地 CANN 工具链"的 Windows 侧拿到反馈，我手工搭了两套脚手架
（现在放在 workspace 里，属于**绕路产物**，不是一个有意的产品能力）：

1. `stub/kernel_operator.h` —— 一个 AscendC API 的语法桩（`LocalTensor`/`GlobalTensor`/`TBuf`/
   `Compare`/`Select`/`Cast`/`DataCopy*`/`SetFlag` …），配合
   `g++ -fsyntax-only -DCANNESS_STUB_DTYPE=half|float|bfloat16_t|int32_t`，
   能在**本地**发现：模板笔误、类型不匹配、`if constexpr` 分支写错、未定义符号。
   它还可以把目标端约束写成 `static_assert`（我后来就把"bitwise 只支持 int16"加进去了，
   用来防止回归）；
2. `stub/golden_check.py` + `stub/golden_test.cpp` —— 用 g++ 把**真实的 `golden.h`** 编成宿主程序，
   逐元素按 `main.cpp` 的顺序调用，再和 `torch.cummin` 对比（本次 164 万元素）；
3. `sim_cummin.py` / `sim_tile_scan.py` —— 用 numpy 逐 op 模拟 kernel 的向量语义，
   和 `torch.cummin` 对比（本次 835 万 / 1918 万元素）。

这三样在本次起了决定性作用：**扫掉了全部逻辑错误，只把"目标端 API 支持范围"留给远端**。
但它们是我临时写的，没有校验、没有文档、也不在插件的能力集里。

## 期望

把"本地能验证的尽量本地验证"变成产品能力，例如：

1. `lint_skill` / 插件工具 `check_kernel()`：用 stub 头对 `op_kernel/kernel.cpp` 做
   `-fsyntax-only`（多 dtype 展开），返回诊断；
2. `check_golden()`：把 `golden.h` 编成宿主程序，对若干随机 case（含 NaN/并列/±Inf/边界 dtype）
   与 torch 参考比对；
3. 提供"算法模拟"模板（numpy 逐 op 模拟 + 与 torch 对比），供扫描/归约类算子复用；
4. 在 `run_evaluation` 之前把上述结果作为 preflight 的一部分（失败则不消耗远端预算）。

## 影响

- 没有本地验证时，任何笔误都要一次 `compile_fail`（4.3 s + 1/3 编译预算）；
- 语义错误（如本次的"按 8 元素对齐的 Kogge-Stone 只能覆盖 p, p-8, …"）在远端只表现为
  `badCount`，定位成本极高 —— 而 numpy 模拟可以在 10 秒内暴露它；
- 与 CAN-001 叠加：本地编译产物一度因 ACL 写不进工作区，等于把本地通道也堵了。

## 复现

现状下：改一行 kernel，不做任何本地检查，直接 `build_test_package` + `run_evaluation`，
观察每个笔误的代价。

## 建议修复

1. 插件内置 stub 头（覆盖常用 AscendC 子集）
   + `check_kernel({dtype_variants})` 工具；
2. 内置 golden 宿主程序模板（本次 `golden_test.cpp` 可直接泛化：形状/dim/dtype 由参数给）；
3. 文档把"本地预验证"写成流程的第 0 步（在 `build_test_package` 之前）；
4. stub 里维护目标端约束的 `static_assert`（与 CAN-005 的远端探测结果同源更新）。

## 验收标准

- 存在一条命令，能在无 CANN 的宿主上对 kernel 做多 dtype 语法检查；
- 存在一条命令，能把 `golden.h` 与 torch 对比（含特殊值）；
- preflight 报告里包含这两项结果，失败时 `run_evaluation` 不消耗预算。

## 关联

CAN-005（远端 compile-only / 只读探测）、CAN-001（本地写权限）
