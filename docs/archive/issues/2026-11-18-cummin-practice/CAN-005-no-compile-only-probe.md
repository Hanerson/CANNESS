# CAN-005 缺少"只编译 / 只探测"的远端通道：唯一的学习手段是消耗编译预算

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | **P1** |
| 组件 | `canness-eval` / `remote/runner.py` / `fetch_remote_file` |
| 首次发现 | 2026-11-18，Cummin 首次 compile_fail |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `remote`, `dx`, `budget` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`run_evaluation({compile_only:true})` —— 用独立远端目录 `<inbox>/<gen>-compile-<rand>`，只跑 `.contract-selfcheck` + `build.sh`，不跑 `run_once.sh`/msprof，不写 `lastReport`，不占 `compileRetries`/迭代数；`eval-run.ts` 传 `--compile-only`，`runner.py` 增加对应分支（`status: pass`，summary 明确「correctness and performance were not evaluated」）。

**同时补齐只读通道**：新增配置 `readRoots`；`RemoteHost.readFileWithin()` 在 `remote.ts`（内存实现）与 `ssh2-transport.ts`（远端 python 脚本 `resolve()` 后判包含、拒根目录、限长、回传 sha256）两侧实现；`fetch_remote_file` 白名单扩展到历史代 + `readRoots`。

**验证**：`plugin/tests/remote-read.test.ts`、`plugin/tests/runner_diagnostics_test.py`（新增）。

**残留**：工具链头文件不在默认白名单，仍需显式配 `readRoots`；两条结论已沉淀进 KB。

## 现象

本次 6 次评测里有 2 次 `compile_fail`，两次的错误都是**目标端 API 支持范围**这一类事实，
而不是我的逻辑错误：

```text
xor.h:55:5: error: static assertion failed … current api support data types are int16_t/uint16_t
dav_c220/kernel_operator_vec_binary_impl.h:336:5: error: … Failed to check dtype in And …
dav_c220/kernel_operator_vec_cmpsel_impl.h:167:14: error: the 1st parameter maybe need a type '__ubuf__ half *'
```

这类事实只要**读一眼远端头文件**就能得到（`…/tikcpp/tikcfw/include/adv_api/math/xor.h`、
`…/impl/basic_api/dav_c220/kernel_operator_vec_cmpsel_impl.h`）。但当前能力集里没有：

- `fetch_remote_file` 只允许 `<outbox>` 与当前代 `<inbox>`，读不到工具链；
- `preflight_evaluation({remote:true})` 只查 SSH / 编译器 / 版本 / msprof 路径，**不编译**；
- `run_evaluation` 没有 `compile_only` 模式，失败还要计入 `maxCompileRetries: 3`。

于是"这台机器支持哪些 dtype / 哪些 intrinsic"必须用预算换。本次 3 次编译重试用掉 2 次。

## 期望

1. `run_evaluation({compile_only: true})`（或 `preflight_evaluation({remote: true, compile: true})`）
   —— 只走 `build.sh` 拿 `compile.log`，不跑精度/性能，不占 `maxCompileRetries`、不占迭代数；
2. 只读的远端探测：`read_remote(path)`（白名单到 `$ASCEND_TOOLKIT_HOME`、`$CANNESS_*`），
   用于查 API 支持表、平台 ini、`soc_probe` 结果；
3. 可选：`run_remote_script(snippet, {
   quota})` —— 在 host 上以 `set_env.sh` 环境跑一段 python/shell 并回传 stdout。

## 影响

- 一次 compile_fail ≈ 4.3 s + 1 次重试额度；两次就是 2/3 的编译预算；
- 更贵的隐性成本：为了避开不确知的 API，我在本地自建了 stub（`stub/kernel_operator.h`），
  把"目标端支持范围"写成了我**以为**的样子 —— 它能挡住我自己笔误，挡不住真实的 API 约束
  （本次就是 stub 放过了 int32 的 `And/Xor` 与 `Select`）；
- 与 CAN-001 叠加：本想用本地编译校验来省远端预算，本地编译产物又因 ACL 写不进工作区。

## 复现

1. 写一个故意使用 `And(int32Tensor, …)` 的 kernel；
2. `build_test_package` + `run_evaluation` → `compile_fail`，`compileRetries` 1/3；
3. 想先确认"int32 支持什么"→ 没有任何工具可查。

## 建议修复

1. runner 增加 `compile_only` 阶段（只 `build.sh`，把 stdout/stderr 全文回传），
   与预算解耦：不计 `compileRetries`，但记一条 `probe` 记录以防滥用；
2. `fetch_remote_file` 增加只读白名单目录（默认 `$ASCEND_TOOLKIT_HOME/**`，可配置），
   并对读到的文件记录 sha256（便于沉淀成 KB 证据）；
3. 把"编译错误归类"落地成 KB 条目（本次两条：`int32 bitwise/select 不支持`、
   `Cast(int32→int64) 是标量实现`），让下一次不必再花预算。

## 验收标准

- 存在一种不消耗 `maxCompileRetries`、不消耗迭代数的远端编译通道；
- 能在不打包的前提下读取工具链头文件（至少 `$ASCEND_TOOLKIT_HOME/include` 与 `tikcpp`）；
- 至少 2 条 API 支持范围条目进入 KB，并被 `kb_search` 检索到。

## 关联

CAN-001（本地校验被 ACL 挡住）、CAN-009（四层里只有 kernel 参与编译）
