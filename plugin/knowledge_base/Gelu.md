# Gelu（tanh 近似，Ascend910B / CANN 9.1）

适用：float16，`[B, N]`，示例 `[8, 4096]`；目标 910B2 / 910B4。

## 公式

```text
Gelu(x) = 0.5 * x * (1 + tanh(sqrt(2/pi) * (x + 0.044715 * x^3)))
```

kernel 内不要直接依赖 `Tanh`：在 CANN 9.1 / 910B 上 `Tanh(float)` 会带来明显的 scalar 开销（实测 46.9us → 改用 `Exp` 后 32.2us）。推荐等价式：

```text
y = 2 * sqrt(2/pi) * (x + 0.044715 * x^3)
tanh(y) = 1 - 2 / (exp(2y) + 1)
Gelu(x) = 0.5 * x * (1 + tanh(y))
```

实现要点：

- `Exp` 用 float32，不要用 `Reciprocal` 的近似倒数（实测 `maxAbsErr` 掉到 0.008）；
- 用 `Duplicate(ones)` + `Div` 求 `1/(exp+1)`，精度回到 `maxAbsErr 0.00097`；
- 大 `|y|` 时 `exp` 溢出到 inf、下溢到 0，`2/(inf+1)=0`、`2/(0+1)=2`，两端自然饱和，不需要 clamp。

## AscendC 片段

```cpp
Cast(t1, xLocal, RoundMode::CAST_NONE, n);              // fp16 -> fp32
Mul(t2, t1, t1, n);
Mul(t2, t2, t1, n);                                     // x^3
Muls(t2, t2, 0.044715f, n);
Add(t2, t2, t1, n);                                     // x + 0.044715*x^3
Muls(t2, t2, 1.5957691216057308f, n);                   // 2*sqrt(2/pi)*(...)
Exp(t2, t2, n);
Adds(t2, t2, 1.0f, n);
Duplicate(t3, 1.0f, n);
Div(t3, t3, t2, n);                                     // 1/(exp+1)
Muls(t3, t3, -2.0f, n);
Adds(t3, t3, 2.0f, n);                                  // 1 + tanh
Mul(t1, t1, t3, n);
Muls(t1, t1, 0.5f, n);
Cast(yLocal, t1, RoundMode::CAST_RINT, n);
```

## Tiling（910B，[8, 4096]）

| 项 | 值 |
|---|---|
| blockDim | 16 |
| blockLength | 2048 元素 / block |
| tileLength | 1024 元素 |
| 每 block tile 数 | 2，`TQue` depth=2 双缓冲 |
| UB 预算 | 2 队列 × depth 2 × 2B + 3 个 fp32 临时 ≈ 20 B / 元素 |
| 实测 | avg 30.9us / min 30.1us / max 38.5us（100 次） |

经验：

- 8 block 只有 71.4us；32 block + tile512 是 35.2us；**16 block + tile1024 最稳**。
- 每 block 只做 1 个 tile 时（32 block / tile1024）能到 23.1us，但双缓冲没有实际重叠；要"真实双缓冲 + ≤40us"选 16/2048/1024。
- scalar 占比约 60%（20us），vector 仅约 1us；继续优化应减少 tile 循环 / 同步次数，而不是换公式。

## 必踩的坑

1. **必须声明 AIV-only**：`KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY);`。否则标量 `SetValue` 生效、`DataCopy` / `Cast` / `Mul` 全部静默不执行，无报错。
2. **编译 core type 必须是 `VecCore`**：`--cce-soc-core-type=VecCore`；`AiCore` / `VectorCore` / `AIC` / `AIV` 都不被接受，`--cce-aiv` 单独用会被静默忽略。
3. **soc 版本**：实机 910B2 可以编译 `Ascend910B2` 或 `Ascend910B4`，但 core type 不解决就白搭。
4. **tiling 必须放 device 内存**再传给 kernel；传 host 栈指针会报 `scalar instruction accesses an invalid GM address`。
5. 编译依赖生成物 `DTYPE_X` / `GET_TILING_DATA` / `GeluTilingData`，裸 kernel 编译不过；验证时用 shim 头，见 [`AscendC_Compile_Run.md`](AscendC_Compile_Run.md)。

## 正确性验证

- 参考：CPU `0.5*x*(1+tanh(0.7978845608*(x+0.044715*x^3)))`，float32 算、再转 fp16。
- 本算子：`maxAbsErr = 0.000972748`，`maxRelErr = 0.000470424`，`bad (>1e-3) = 0/32768`。
- 不要用 `Reciprocal` 近似倒数做精度验收，它会让 3650/32768 超差。
