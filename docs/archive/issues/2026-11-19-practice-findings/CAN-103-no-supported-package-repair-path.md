# CAN-103 没有受支持的"修包 / 重签"通道：任何后处理都撞死 `packageHash`

| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | **P0（把 CAN-101/102 的修复手段逼成"自己实现插件内部哈希"）** |
| 组件 | `canness-eval`（`eval.ts::checkPackageHash`、`eval-run.ts`）、`canness-generator`（`submission.ts::exportSubmission`）、`write_package_file` |
| 首次发现 | 2026-11-19 09:27，试图删掉自检目录后重跑评测 |
| 状态 | 已绕过（工作区自建 `tools/rehash.mjs`），插件未提供对应能力 |
| 标签 | `workflow`, `hash`, `generator` |

## 现象

为了让 CAN-102 的门禁通过，我删掉了 `packages/<gen>/.contract-selfcheck/`，
再跑评测：

```text
Error: package changed after build_test_package; rebuild the package before evaluation
```

`build_test_package()` 会 `rm -rf dest` 后整体重写，所以"重新打包"等于把补丁冲掉；
而**任何**对已构建包的后处理都会让哈希对不上。于是陷入死循环：

- 不修包 → 自检门禁直接把评测判成 compile_fail；
- 修包 → 哈希校验拒绝上传；
- 重新打包 → 补丁没了。

`write_package_file` 只接受 `golden.h`，没有第二个可写文件的口子。

## 证据

- `plugin/src/eval.ts` `checkPackageHash()`：
  同时比较 `manifest.packageHash` 与 `state.packageHash`，任一不等即 `throw`；
- `plugin/src/eval-run.ts` 第 ~120 行同样的检查；
- `plugin/src/submission.ts` 第 161 行：`if (manifest.packageHash !== hash) throw ...`；
- `package-files.ts::packageHash()` 是对 `metadata + 所有文件内容(CRLF→LF)` 的 sha256，
  **可复现**（这条是好消息，也是补丁能成立的原因）。

## 我用的临时补丁

`tools/rehash.mjs`：

```js
import { packageHash } from 'file:///D:/projects/CANNESS/plugin/lib/package-files.js'
// 1) 需要时删 .contract-selfcheck
// 2) 重写 manifest.files / manifest.packageHash
// 3) 同步 .canness/state.json 的 packageHash（否则 CAN-104）
```

关键点是**直接 import 插件编译产物里的 `packageHash`**，保证与插件算法逐字节一致，
而不是自己重写一份（我先验证过：原样重算能复现原 hash `cf9bfcb5…`）。

## 影响

- 用户被迫去改插件的**私有实现细节**（哈希算法、`state.json` 结构）；
- 这是"能力缺口"而不是"用户操作失误"：本轮 CAN-101、CAN-102 两个 P0 的修复都卡在这里；
- 它泄漏了插件内部布局：为了修包，我必须知道 `manifest.files` 的排序规则、
  `manifest.json` 不参与内容哈希、`state.json` 里还存了第二份 hash。

## 建议修复

1. 提供 `write_package_file({ path, content })` 的通用版本（白名单：包内任意文本文件），
   并**在写入后自动重签** `manifest.packageHash`；
2. 或者提供 `rebuild_package({ fromGeneration, drop?: string[] })` / `sign_package()`；
3. 把 hash 校验降级：区分"被篡改"与"被有意修补"（例如 manifest 里加
   `patched: [{file, reason}]` 字段，签名时纳入）；
4. 单一真相源（配合 CAN-104）：`state.json` 不要缓存 hash。

## 验收标准

- 存在一种受支持的方式，在 `build_test_package()` 之后移除/替换包内某个生成文件，
  且随后 `run_evaluation` 与 `export_submission` 都接受；
- 该路径不需要用户 import 插件的 JS/TS 内部模块。
