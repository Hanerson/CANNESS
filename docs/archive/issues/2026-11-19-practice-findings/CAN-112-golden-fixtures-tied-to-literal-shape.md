# CAN-112 本地 golden 校验的 fixture 被绑在 spec 的字面元素数上，大 shape 无法校验

| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | P2 |
| 组件 | `plugin/scripts/check-golden.mjs`、`docs/contracts/direct-launch.md`（Local golden validation） |
| 首次发现 | 2026-11-19 09:23 |
| 状态 | 已绕过（自写 C++ harness + torch 对照） |
| 标签 | `golden`, `validation`, `dx` |

## 现象

文档写得很清楚：

> Vectors follow manifest input/output order and **must match each tensor's literal
> element count**.

我的 spec 是 `[8192, 16384]`（输入 134,217,728 个元素），于是 fixture JSON 要带
1.34 亿个数字才能跑本地 golden 校验 —— 实际上不可能。

而"先写小 shape 的 spec 校验 golden、再改成大 shape 评测"又会触发 CAN-103/104
（重新打包 + hash）并浪费一次 `submit_spec`（预算沿用但 generation 变了）。

## 影响

- 精度参考（`golden.h`）这个"唯一由模型拥有"的文件，反而没有可用的本地校验路径；
- `golden.h` 写错时，远端会报 `accuracy_fail`，而 `badCount` 只有一个总数，
  分不清是"kernel 错"还是"golden 错"——本轮我差点在这上面白烧一轮评测；
- 我最终是**自己**用 g++ 编了一个 harness（`local-golden-test/check.cpp`），
  再用本地 torch(CPU) 逐步对照，才确认 golden 对 9 组 shape/dim 全对（worst_rel 1.6e-7）。

## 我用的临时补丁

`local-golden-test/check.cpp` + `compare.py`：

- 直接 `#include` 包里的 `golden.h`，用 `GoldenCtx` 构造 rank/dim/attr；
- 输入用确定性公式生成，输出打印成文本；
- `compare.py` 用 `torch` 的 `F.silu(x0)*x1` 复算并逐元素比对（含 NaN 语义）。

## 建议修复

1. `check-golden.mjs` 支持 fixture 里带 `shape`/`attrs` 覆盖，并**按覆盖后的 shape
   重新分配张量**（文档已说"shape overrides do not resize any tensor vectors"，
   正是缺的那一块）；
2. 或者提供 `--shape` 参数：用 fixture 的元素按指定 shape 重排，忽略 spec 的字面 shape；
3. 支持 fixture 生成器（"给小 shape 生成随机向量"），别让用户手写 1.34 亿个数；
4. `accuracy_fail` 的 report 里区分"golden 断言失败 / golden 与 kernel 不一致"，
   并给出前若干个不匹配的 index 与数值（现在只有 maxAbsErr/badCount）。

## 验收标准

- spec 为 1.34 亿元素时，仍能用 1024 元素的 fixture 校验 `golden.h`；
- 校验失败时能定位到具体 index/输入值；
- 不需要用户自己写 C++ harness。
