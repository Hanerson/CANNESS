# CAN-024 kernel 的"能力矩阵"没有结构化声明：wrapper 守卫靠手写，能力与守卫容易脱节

> 去重：本条扩展既有 **CAN-110**（shape-changing 导出缺口），建议并入 CAN-110：能力矩阵不止「同 shape」，还包括 dtype × layout × mode。

| 字段 | 值 |
|---|---|
| 类型 | enhancement（设计缺陷） |
| 优先级 | **P2**（但会直接制造误判） |
| 组件 | `canness-generator`（`spec.ts`、`submission.ts`、`templates/cannbench/operator.py`） |
| 首次发现 | 2026-11-25，把 wrapper 守卫抛的 `ValueError` 误判成 device 崩溃 |
| 状态 | **open** |
| 标签 | `spec`, `support-matrix`, `wrapper`, `false-negative` |

## 现象

`interface` 里只有 `attrs` / `defaults` / `dtypes`，没有"这个 kernel 支持哪些
layout × mode × 对齐"的声明。于是导出包的能力边界只能写在自定义 wrapper 里，手写成：

```python
if layout != 0: raise ValueError("layout=1 is a known kernel defect")
if rotaryMode != "half": raise ValueError("interleaved is a known ABI defect")
if launch is None: raise ValueError("bfloat16 is a known kernel defect")
```

我在排查时对着这份守卫跑了矩阵，看到 `call ...` 之后进程退出、没有 traceback（脚本
把 stderr 过滤了），就**把三个组合判成"device crash"**，实际是守卫在正常拒绝。为此多花了
近一小时，也写错了报告（"layout=1/interleaved/bf16 会崩"）——后来用绕过 wrapper 的
`probe_all.py` 直接调 `canness_launch`，14/14 全过。

根源不是"守卫不该写"，而是**守卫是手写的、和 kernel 的实际能力没有绑定**：

- kernel 已经支持 14/14 组合，wrapper 还只放行 3 类；
- 反过来，如果 kernel 退化，守卫不会跟着变，导出物会"看起来支持"。

## 期望

- spec 增加 `support: { layouts?: [0,1], modes?: ["half","interleaved"], dtypes?: [...], min_align_bytes?: 32 }`；
- 导出时用它**生成** wrapper 守卫（不支持的组合给出统一错误类型，例如
  `UnsupportedConfiguration`，并在错误信息里列出支持矩阵）；
- `validate_submission` 的覆盖矩阵自动来自 `support`，报告里直接写"覆盖 n/m"；
- 不支持的组合要能被评测器区分为 `unsupported`，而不是 `failed`（现在两者混在 `ValueError` 里）。

## 影响

- 能力边界不可追溯，交付物与 kernel 实际能力脱节（本轮 wrapper 落后 kernel 整整 11 个组合）；
- 错误类型不区分"不支持"与"实现错误"，排查时极易误判（本轮实际发生）。

## 复现

1. 取 `submissions/gen-5942c07f-hAA1ol/source/cann_bench/__init__.py`（守卫版）；
2. 用 `layout=1` 调 → `ValueError`（不是崩溃）；
3. 用同一份 kernel 绕过 wrapper，直接 `canness_launch(..., layout=1, ...)` → 结果正确。

## 建议修复

1. `spec.support` 声明 + 导出时生成守卫；
2. 统一错误类型：`UnsupportedConfiguration`（带 support matrix）vs `ImplementationError`；
3. 验证器把 `unsupported` 计为"跳过"而非"失败"，并在报告里显式列出。

## 验收标准

- 一份导出包的守卫与 kernel 能力**自动一致**（改 spec 即改守卫）；
- 调用不支持组合时抛 `UnsupportedConfiguration`，消息里含支持矩阵；
- 验证报告同时给出"supported n/m passed" 与 "unsupported k skipped"。

## 关联

CAN-023（覆盖矩阵）、CAN-021（闭环验证）
