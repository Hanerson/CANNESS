# CAN-016 `contractFingerprint()` 优先读 `plugin/lib/`，但模板读 `plugin/templates/`：改动未重建时形成静默的混合契约

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P1** |
| 组件 | `canness-generator`（`package-files.ts::contractFingerprint` / `buildTestPackage`） |
| 首次发现 | 2026-11-18 16:13，复核本轮源码改动时（Cummin 包重建后） |
| 状态 | **open（本次复核新增）** |
| 标签 | `contract`, `build`, `stale-artifact` |

## 处理情况（2026-11-18 16:20 复核）

**证据（可直接复现）**：`plugin/lib/*.js` mtime 11-17 14:34，`src/*.ts` mtime 11-18 15:59–16:09；`lib` 内不含 `attrs.find`、`compiledLayers`、`compile-only`、`carrySources`、`readFileWithin`；而 16:13 重建的 `packages/gen-21916f68` 里 `canness_tiling.h` **有** `find()`、`.contract-selfcheck/op_kernel/kernel.cpp` 仍是 `attrs.get(0/1/2)`、`manifest.json` **没有** `compiledLayers`/`documentedOnlyLayers`。即「模板新、生成代码旧」的混合契约。

**根因**：`contractFingerprint()` 优先 `lib/`，`templateBody()` 永远读 `templates/`；指纹只哈希 lib，不哈希模板。

**建议**：指纹覆盖 lib + templates 两部分；`lib` 早于 `src` 时构建告警（附 `pnpm build`）；或运行期直接吃 `src`/把模板打进 lib，消除双源。

## 现象

`package-files.ts` 里：

```ts
const libDir = join(pluginRoot, 'lib')
const sourceDir = join(pluginRoot, 'src')
const root = existsSync(libDir) ? libDir : sourceDir   // ← 运行期用 lib
```

而模板始终从 `plugin/templates/` 现读：

```ts
function templateBody(name: string) { return readFileSync(join(buildContractTemplateDir(), name), 'utf8') }
```

于是当 `src/` 改过、`lib/` 没重建时，**渲染由旧代码执行、模板由新文件提供**，形成混合契约，且没有任何提示。
本次实测：

| 证据 | 结果 |
|---|---|
| `plugin/lib/*.js` mtime | **11-17 14:34** |
| `plugin/src/*.ts` mtime | 11-18 15:59–16:09 |
| `lib/` 内是否含新符号 | `attrs.find("pattern")`、`compiledLayers`、`compile-only`、`carrySources`、`readFileWithin` **全部 absent** |
| 重建后的 `packages/gen-21916f68/canness_tiling.h` | **有** `find()`（来自新模板） |
| 同包 `.contract-selfcheck/op_kernel/kernel.cpp` | 仍是 `attrs.get(0/1/2)`（来自旧 lib 的生成代码） |
| 同包 `manifest.json` | **没有** `compiledLayers` / `documentedOnlyLayers` / `attrsDerived` |
| 同包渲染出的 `main.cpp` / `build.sh` | 已含新内容（batch golden 分支、`-Wno-ignored-attributes`） |

即：**模板是新的、生成代码是旧的**，而 `manifest.contract.libHash` 记录的还是旧 lib 的哈希 —— 一个"看起来一致、实际不一致"的指纹。

## 期望

1. 指纹覆盖**两部分**：`lib` 代码哈希 + `templates` 内容哈希（模板已经参与渲染，却没有参与指纹）；
2. 检测到 `lib` 比 `src` 旧时（mtime 或哈希比对）给出显式告警，或直接拒绝构建并提示 `pnpm build`；
3. 更彻底：运行期优先 `src`（需构建链支持）或把模板也打进 `lib`，消除双源。

## 影响

- 本轮另外 15 条 issue 的修复**全部在 `src` 里并通过测试**，但运行中的插件仍走旧 lib →
  `compile_only`、`blockedBy/stopReason`、`carrySources`、`attrs.find`、`interface.attrs`、
  `validate_submission` 在本会话里**一个都没生效**；只有"模板类"修复（CAN-013 的告警抑制、
  CAN-012 的 batch 分支、CAN-010 的 `find`）真正落到了新包里；
- 混合包让"这个包由哪一版契约生成"无法从 manifest 判断；
- 复核者会误判"已修复"。

## 复现

1. 改 `plugin/src/package-files.ts`（例如自检 kernel 改用 `attrs.find`），不执行 `pnpm build`；
2. `build_test_package()`；
3. 对比 `packages/<gen>/canness_tiling.h`（新：含 `find`）与
   `packages/<gen>/.contract-selfcheck/op_kernel/kernel.cpp`（旧：`attrs.get`），
   并检查 `manifest.json` 是否含 `compiledLayers`。

## 建议修复

1. `contractFingerprint()` 同时算 `lib`（或 `src`）与 `templates/**`，写进
   `contract.libHash` / `contract.templatesHash`；
2. `build_test_package` 在 `lib` 早于 `src` 时告警（"plugin sources are newer than the built
   lib; run pnpm build"），并可配置为硬失败；
3. 文档补一句"模板改动立即生效、代码改动需重建"，避免再次误判。

## 验收标准

- `manifest.contract` 能区分代码版本与模板版本；
- `lib` 陈旧时的构建要么告警要么失败，且报文给出重建命令；
- 重建前后同一 spec 生成的包，其 `contract` 字段可区分。

## 关联

CAN-004/005/011/015（其修复在当前会话未生效，皆因本条）、CAN-009（documented-only 字段同样没有出现）
