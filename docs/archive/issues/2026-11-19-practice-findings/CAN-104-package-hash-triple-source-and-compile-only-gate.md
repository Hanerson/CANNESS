# CAN-104 `packageHash` 有三个真相源，且 `compile_only` 也被陈旧 state hash 拦住

| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | P1 |
| 组件 | `canness-eval`（`eval.ts`、`eval-run.ts`）、`canness-generator`（`submission.ts`）、`.canness/state.json` |
| 首次发现 | 2026-11-19 09:27 |
| 状态 | 已绕过（补丁顺带同步 state.json） |
| 标签 | `state`, `hash`, `diagnostics` |

## 现象

按 CAN-103 重签了 `manifest.packageHash` 后，评测仍然报同一句话。
原因不是 manifest，而是**工作区状态文件**里的旧 hash：

```json
// .canness/state.json（修复前）
"packageHash": "10ef350ade9982afb327b55832c9e231d05c21dd33de5e97e8dc298a204209fa"
// packages/<gen>/manifest.json（同时刻）
"packageHash": "cf9bfcb5e827bb37bc6ad86eb3912a3144fe73689e0a26c8a3195af91e1319cb"
```

`eval.ts::checkPackageHash()` 的逻辑是：

```ts
if ((manifest.packageHash !== undefined && manifest.packageHash !== hash)
    || (state.packageHash != null && state.packageHash !== hash)) throw ...
```

两份都要对。而 `state.packageHash` 只在**非** compile-only 的评测里被写
（`eval-run.ts`：`input.compileOnly ? input.state : { ...applyReport({ ...state,
packageHash: input.state.packageHash ?? packageHash(...) }) }`），
所以"重新打包 → 只跑 compile_only"这个最正常的诊断动作，会被**上一次的** hash 拦住。

## 影响

- `compile_only` 明明是"只编译、不占预算"的诊断通道，却被与编译无关的状态校验挡住；
- 用户看到的是同一句 `package changed after build_test_package`，
  但可能有三处不同的不匹配源（manifest / state / 导出 provenance），无从区分；
- 叠加 CAN-103 后，"修包"必须同时改两个内部文件，任何遗漏都表现为同一条错误。

## 证据

- `plugin/src/eval.ts` 第 ~226-234 行（`checkPackageHash`）；
- `plugin/src/eval-run.ts` 第 ~114-123 行（`fold` + 二次检查）；
- `plugin/src/submission.ts` 第 161 行（导出时第三次检查）。

## 建议修复

1. **单一真相源**：以 `manifest.packageHash` 为准，`state.packageHash` 仅作为
   "上次上传的包是谁"的缓存，不参与放行判定；
2. `compile_only` 不做 hash 门禁（它只读编译结果，不产生可比较的评测结论）；
3. 报错文案带上三方取值：
   `manifest=…, state=…, actual=…`，让人一眼看出该修哪边；
4. `build_test_package()` 主动刷新 `state.packageHash`（谁生成谁负责签名）。

## 验收标准

- 重新打包后立刻 `compile_only`，不出现 `package changed` 报错；
- 故意只改 `state.packageHash`，评测仍然通行（state 不再参与放行）；
- 故意只改 `manifest.packageHash`，报错信息里同时给出三方取值。
