# CAN-110 shape-changing 算子导出：只有一条报错，没有模板，也没有运行时 ABI 文档

| 字段 | 值 |
|---|---|
| 类型 | doc / design |
| 优先级 | P2 |
| 组件 | `canness-generator`（`submission.ts::exportSubmission`）、`templates/cannbench/*` |
| 首次发现 | 2026-11-19 09:29 |
| 状态 | 已绕过（自写 wrapper，靠读源码推出 ABI） |
| 标签 | `export`, `wrapper`, `abi`, `docs` |

## 现象

SwiGLU 是 **shape-changing**（输出在 `dim` 上折半），自动导出直接被拒：

```text
Error: automatic CANNBench export currently supports same-shape inputs and outputs
```

源码里确实给了出路（`exportSubmission(..., { wrapper, signature })`），但：

1. 没有 wrapper 模板/骨架（`templates/cannbench/operator.py` 是**生成**用的，
   自定义 wrapper 要整份重写，包括 ctypes 绑定、argtypes、tiling buffer、stream 获取）；
2. 没有文档说明**唯一的运行时几何通道**是 `canness_launch` 的 `double attr*` 参数：
   `launch.cpp` 把 `blocks`（`BLOCK_DIM`）和 `tileLength` 写成**编译期常量**
   （`constexpr uint32_t blocks = {{BLOCK_DIM}};`、`const CannessTilingData header{...}`），
   所以 20 个 case 只有 `total`（调用时才传）是可变的，`half/L` 必须借道 attrs；
3. `signature` 与 wrapper 的一致性只靠**字符串/AST 比对**（`validate_submission.py`
   用 `ast.dump(args)` 对比），写错时报错在很远的地方；
4. wrapper 里能/不能做什么（`.contiguous()` 算不算"包装层做实质变换"）没有明确边界，
   我只能按 `docs/guide/submission_rules.md` 的散文自行判断。

## 影响

- 形状变化类（chunk/split/reshape/slice + 规约）在 LLM 算子里非常常见，
  每一个都要重新推导一遍 ABI；
- 推错的代价很高：`dim`/`half` 传反 → 精度测试在远端才炸，或者更糟——不炸但结果错位；
- 本轮我花在"读 `submission.ts` + `launch.cpp` 反推参数顺序"的时间，
  比写 kernel 的数学（5 行）还多。

## 我用的临时补丁

手写 `cann_bench/__init__.py`（存于 `tools/wrapper.py`，导出时作为 `wrapper` 传入）：

- 按 dtype 绑 `libcanness-<variant>.so`；
- `argtypes = [in, out, total, stream, tiling, capacity, dim, half]`
  —— 顺序由 `launch.cpp` 的 `ATTR_ROWS`（= `spec.attrs` 的插入顺序）决定；
- 每次调用 `torch.empty` 出 256B tiling buffer，`current_stream().npu_stream`；
- 对不支持的几何显式 `ValueError`（避免设备异常）。

## 建议修复

1. 增加 `templates/cannbench/wrapper_shape_changing.py` 骨架（含 ctypes 绑定、
   attr 运行时通道、错误处理、`__all__`）；
2. 文档补一节"Runtime geometry ABI"：哪些字段编译期固定、哪些可运行时传、
   attrs 的 `double` 语义与精度陷阱（配 CAN-111）；
3. `export_submission` 在 `wrapper` 缺 `signature` / 参数名不匹配时**立即**报错
   （现在靠远端 AST 比对，反馈太晚）；
4. 明确 wrapper 的允许/禁止清单（`contiguous()`、`view`、dtype 转换、allocator 缓存）。

## 验收标准

- 用模板骨架 30 行内能写出一个 shape-changing wrapper；
- `signature` 不匹配在 `export_submission` 阶段就报错；
- 文档里能查到 `blocks`/`tileLength` 是编译期常量这一事实。
