# CAN-012 golden 接口是"逐元素求值"，累加类算子被迫自造 O(1) 缓存

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | **P2** |
| 组件 | 构建契约（`templates/build-contract/main.cpp` 的 golden 调用约定） |
| 首次发现 | 2026-11-18，Cummin 写 golden 时 |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `contract`, `golden`, `design` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`main.cpp` 增加 `CANNESS_GOLDEN_BATCH` 开关 —— 定义后每个 output 调用一次 `evaluate_all` / `evaluate_integer_all` 填满整块（count 用真实输出元素数），index-check 模式仍走 `verify_index`，未定义宏则完全保持逐元素旧行为；`docs/contracts/direct-launch.md` 写明调用顺序（先按 output、再按元素升序）、「每个可执行调用构造一个用例、不要用跨用例存活的进程级缓存」，以及批量回调的签名。

**结果**：扫描/归约类 golden 不再需要我这次手写的逐行增量缓存；我现有的 `golden.h` 未定义该宏，行为不变（兼容）。

**验证**：模板改动已进入重建包（`main.cpp` 含 `#ifdef CANNESS_GOLDEN_BATCH` 分支）；`vitest`/`tsc` 通过。

## 现象

`main.cpp` 的校验循环是：

```cpp
for (output …)
  for (element = 0; element < outputs[output]->elements; ++element)
    expected = canness_golden::evaluate(ctx, output, in, in_count, element);
```

一次问一个元素、按升序。对 elementwise 算子没问题；对**累加/扫描类**算子（cummin、cumsum、
cumprod、任意前缀归约）天然写法是每个元素重扫前缀：`O(N·A)`。本次基准 case 是 1 M 元素、
轴长 256；最坏 case（1 M 元素、轴长 1024）会变成 **1e9 次比较**，runner 大概率超时。

我只能在 `golden.h` 里自造增量的逐行缓存（`state.lineBase / state.pos / state.key / state.best`），
并且因为 values 与 indices 是两次独立遍历，还得给两个函数各自准备一份 static 缓存。

## 期望

契约文档显式说明调用顺序保证（"按升序逐元素调用，可以安全缓存"），或提供
"一次填满整个输出"的回调：

```cpp
inline void evaluate_all(GoldenCtx ctx, int out, const float* const* in, int in_count,
                         float* out_values);      // 或 int64 版本
```

## 影响

- 每个扫描类算子作者都要重写一遍缓存逻辑（易错：漏掉"跨 output 二次遍历"就要重扫）；
- 隐式性能悬崖：case 一大就超时，而 `timeout` 计入独立预算并会停机（`timeouts >= 2`）；
- 无法从文档得知"是否允许 static 状态"（多 output、多 case 复用进程时的正确性依赖它）。

## 复现

写一个每元素重扫前缀的 `golden.h`（最直白的实现），在 1 M 元素 / 轴 1024 的 case 上跑
`run_once.sh`，观察耗时接近超时。

## 建议修复

1. 文档补一节"golden 调用约定"：顺序、是否允许 static 缓存、跨 case 是否复用；
2. 增加 `evaluate_all` / `evaluate_integer_all` 可选入口（存在则优先使用，缺省回退逐元素）；
3. 模板里对 `badCount` 的统计逻辑复用同一入口。

## 验收标准

- 文档明确调用顺序与状态生命周期；
- 扫描类 golden 可以用一个批量入口实现，无需自造缓存；
- 1 M 元素/轴 1024 的 case 在 golden 阶段不产生可观的耗时。

## 关联

CAN-005（远端诊断能力）
