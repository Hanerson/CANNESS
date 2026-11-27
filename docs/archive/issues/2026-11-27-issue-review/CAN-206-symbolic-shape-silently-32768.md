# CAN-206 符号维在打包时静默变成 32768 个元素

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P1** |
| 组件 | `plugin/src/spec.ts`、`package-files.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `spec`, `shape`, `export` |
| 复核 | 2026-11-27。收窄到符号维静默回退和自动导出的形状约束 |

## 现象

`TensorSpec.shape` 允许符号维。本地复现：shape `['B', '4096']` 在打包时静默具体化为 32768 个元素，没有错误。32768 来自 Gelu 示例 `[8, 4096]` 的元素数。

每个张量按自己的元素数分配缓冲区。一次默认用例里，各张量共用这一份具体化之后的 shape，启动几何也按这一份来。默认 golden 是占位实现，对不上时会明确失败，不会假装算过。

自动 CANNBench 导出要求全部张量同 shape。这个限制写在导出阶段。符号维在更早的打包步骤已经换成 32768，调用方看不到「这一维仍是符号」。

## 证据

- 本地复现：输入 shape `['B', '4096']`，`build_test_package` 使用 32768 个元素，打包成功。
- `plugin/src/spec.ts` 第 216–229 行：shape 元素可以是正整数或非空符号。
- `plugin/src/package-files.ts` 第 84 行：`DEFAULT_TOTAL_ELEMENTS = 32768`。第 198–200 行：`numericElementCount` 遇非数字维返回 null，`elementCount` 于是返回 32768。
- `plugin/src/submission.ts` 第 57–62 行：非自定义 wrapper 时，任一张量 shape 与第 0 个输入不同就抛出 `automatic CANNBench export currently supports same-shape inputs and outputs`。
- `docs/reference/tools.md` 第 53 行写明自动导出要求同 shape。这句和代码一致。
- 默认 golden 在结果不符时失败，是占位而不是静默通过。

## 影响

带符号维的规格会在 32768 个元素上进入评测，调用方没有收到「符号维未实例化」的错误。自动导出的同 shape 约束要到导出时才出现。

## 期望

存在符号维且未给出具体实例时，`build_test_package` 失败并指出哪一维。32768 只在规格或实例里显式写出时使用。自动导出的形状约束在 `submit_spec` 的返回值里写明。

## 复现

1. `submit_spec`，输入 shape 为 `['B', '4096']`。
2. `build_test_package`。
3. 看生成的元素数为 32768，且没有错误。

`spec.test.ts` 保证符号维能通过解析。没有「禁止静默 32768」的负例。

## 建议修复

- `elementCount` 在存在符号维时抛错，指出张量和轴，并要求在测试前提交显式的正整数维。
- `submit_spec` 对无法自动导出的 shape 关系返回 `exportable: false` 及原因。

## 验收标准

- 含符号维且未给实例的规格不能打包。
- `submit_spec` 的返回值写明自动导出的同 shape 约束。
- 32768 只作为显式实例出现。

## 关联

仓库 CAN-105。本条只处理符号维静默回退，以及把自动导出的形状约束提前说清楚。

范围外观察，不在本条验收内：契约 `main.cpp` 把 `totalLength` 截成 `uint32_t`，导出路径的 `operator.py` 对 `numel > 0xffffffff` 会抛错。那是另一处元素数上限，和符号维回退分开处理。

CAN-105、CAN-110 和 CAN-112 记录单 shape、整数输出与签名约束。本条聚焦符号维的静默具体化。

## 处置和验证

打包拒绝 unresolved shape，错误指出张量及维度。规格返回自动导出的形状兼容性提示。
