# CAN-003 `submit_spec(reset: true)` 不携带四层源码，报错点落在下游 build_test_package

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P0** |
| 组件 | `canness-generator`（`submit_spec` / `build_test_package`） |
| 首次发现 | 2026-11-18，Cummin 实现（gen-21916f68 建立时） |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `generator`, `state`, `blocks-loop` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：新增 `plugin/src/generator-sources.ts`（`sameSourceContract` / `carrySources` / `missingLayers` / `writePartialOperator`）；`generator.ts` 在 `submit_spec` 里对「同算子 + 源契约兼容」的续代调用 `carrySources` 复制四层 + `golden.h` + `layer-origins.json`，返回值新增 `carriedLayers` / `needsLayers`；`build_test_package` 缺层时抛 `generation <id> is missing <files>; call write_operator for this generation first`。

**实现比建议更保守**：`sameSourceContract` 只忽略 `performance_target`，形状/attrs/dtype 任何差异都不搬运（避免跨契约复制）。

**验证**：`plugin/tests/generator-artifacts.test.ts`（新增）；`vitest` 243 项全绿。

**未生效原因**：运行期读 `plugin/lib/`，而 lib 停留在 11-17 14:34 → CAN-016。

## 现象

`run_evaluation` 被 `negativeStreak` 拒绝（CAN-004）后，唯一可用的恢复路径是
`submit_spec({spec, reset: true})`。它成功返回：

```json
{"generationId":"gen-21916f68","workspace":"…","operator_name":"Cummin","carriedOver":false,"relaxedTargetFromUs":null}
```

但新一代目录里**只有目录、没有源码**（上代 `gen-d9175b4a/` 里已有完整的四层 + `golden.h`
+ `layer-origins.json`）。随后 `build_test_package` 抛裸 Node 错误：

```text
Error: ENOENT: no such file or directory, open 'D:\projects\CANNESS\canness-workspace\operators\gen-21916f68\op_kernel\kernel.cpp'
```

## 期望

两种行为任一即可：

- **A（推荐）**：同一算子续代（`carriedOver` 语义）时，把上一代的四层源码 + `golden.h`
  复制到新代（"reset 只重置预算，不重置产物"）；
- **B**：`submit_spec` 明确提示"新一代需要重新 `write_operator`（和 `write_package_file`）"。

## 影响

- `reset` 是策略停摆后**唯一**的恢复手段（见 CAN-004），而它顺手删掉了本轮 3 小时的产出；
- 恢复产出的动作（复制目录）又撞上沙箱 ACL（CAN-001），只能走 `danger-full-access` 升级；
- 报错信息不含因果：`ENOENT … kernel.cpp` 看起来像"文件丢了"，实际是"新代还没写"。

## 复现

1. 某代已完成 `write_operator` + `write_package_file` + `build_test_package`；
2. `submit_spec({spec, reset:true})` → 新 `generationId`；
3. 直接 `build_test_package()` → 上述 ENOENT。

## 建议修复

1. `submit_spec` 在续代时复制 `operators/<prev>/` 到 `operators/<new>/`（保留 `layer-origins.json`）；
2. 若选择不复制，`build_test_package` 的错误文案改为
   `"operators/<gen>/op_kernel/kernel.cpp not found: call write_operator for this generation first"`；
3. `submit_spec` 返回值加 `carriedLayers: bool` / `needsLayers: bool`，让调用方无需试错。

## 验收标准

- 续代 `reset` 后，`build_test_package` 直接成功（A），或首错文案直接指向 `write_operator`（B）；
- 返回值能区分"新一代是否已有源码"。

## 关联

CAN-004（策略死锁，触发本次 reset）、CAN-001（复制动作被 ACL 拒绝）
