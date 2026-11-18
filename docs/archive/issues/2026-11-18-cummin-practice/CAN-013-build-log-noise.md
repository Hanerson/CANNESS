# CAN-013 `build.sh` 每次产出 39 行 `cce_global` 噪音，真错误容易被淹

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | dx |
| 优先级 | **P2** |
| 组件 | 构建契约（`templates/build-contract/main.cpp`、`main.cpp` 的 `CANNESS_GM_ADDR`） |
| 首次发现 | 2026-11-18，每次 `run_evaluation` |
| 状态 | **fixed 且已生效** |
| 标签 | `contract`, `build`, `log-noise` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`templates/build-contract/build.sh` 对 `main.cpp` 的编译加 `-Wno-ignored-attributes`（`kernel.o` 未加，保留其告警）。

**为什么这条已生效**：模板在渲染时从 `plugin/templates/` 现读、不经过 `lib/`，所以我 16:13 重建的 `packages/gen-21916f68/build.sh` 已含该 flag —— 这是本轮唯一「既修了、又真的进了新包」的条目。

**未复测**：远端配额用尽，尚未在真机上确认 `compile.log` 行数降到个位数。

## 现象

每次成功编译都会打印 4 条同类告警（来自 `main.cpp` 的启动行强制转换）：

```text
main.cpp:365:65: warning: 'cce_global' attribute ignored when parsing type [-Wignored-attributes]
        canness_kernel<<<CANNESS_BLOCK_DIM, nullptr, stream>>>((CANNESS_GM_ADDR)in0.device, …);
                                                                ^~~~~~~~~~~~~~~
main.cpp:38:25: note: expanded from macro 'CANNESS_GM_ADDR'
#define CANNESS_GM_ADDR __gm__ uint8_t*
```

评测器自己的日志摘要就把它标成 boilerplate：`(39 lines, 39 boilerplate)`。
`compile_fail` 时这 39 行会把真正的 `error:` 推到视野之外（`condenseCompileLog` 保留尾部，
但人工看原始日志时噪音在前）。

## 期望

- 成功构建输出不超过 2 行（构建标记 + 可执行路径）；
- 失败时首屏即错误，不被同类 warning 占满。

## 影响

纯噪音，但出现频次高（每次评测）。对比收益很低，修起来也很便宜。

## 复现

任意 `build_test_package` + `run_evaluation`，看 `compile.log` 前 39 行。

## 建议修复

1. `build.sh` 的 `FLAGS` 加 `-Wno-ignored-attributes`（或对 `main.cpp` 单独加）；
2. 或在 `main.cpp` 里用 `reinterpret_cast` 到 `__gm__ uint8_t*` 的方式表达同一转换，
   避免触发该告警（注意：仓库注释里已记录过"`static_cast` 会因地址空间报 casts away qualifiers"，
   所以这里需要一个既合法又安静的三参写法）；
3. 顺带对 `kernel.o` 也保持同样策略。

## 验收标准

- 成功编译的 `compile.log` ≤ 5 行；
- 故意制造一个错误时，`error:` 出现在前 10 行内。

## 关联

CAN-005（编译反馈质量）
