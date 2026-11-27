# CAN-211 来源声明的 sha256 只做格式校验

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/src/provenance.ts`、`package-files.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `provenance`, `integrity` |
| 复核 | 2026-11-27。探针标签拆到 CAN-229；golden 重建已在工具参考中 |

## 现象

`write_operator.provenance` 里的 `sha256` 只检查是不是 64 位十六进制，不读层文件。产物字节另有独立哈希。`repair_package` 改写层文件后会更新产物摘要并打 `modifiedByRepair`，同时留下原来的 `declared.kind` 和 `source`。

改写后的产物哈希与原始来源声明里的哈希可以不同。格式校验不会发现声明的哈希和当前字节不一致，也不会发现声明的哈希和原始文件不一致。

## 证据

- `plugin/src/provenance.ts` 第 31–38 行：sha256 的检查是 `/^[0-9a-f]{64}$/i` 一类格式判断，没有文件读取。
- `plugin/src/package-files.ts` 第 741–744 行附近：repair 更新产物摘要、标记 `modifiedByRepair`，保留 `declared`。
- `plugin/src/knowledge-entry.ts` 约第 88 行：来源 sha256 做格式校验。
- 产物字节的哈希在打包路径上单独计算，和声明字段不是同一次核对。

复核订正：golden 改动后需要重建，已经写在 `docs/reference/tools.md`。本条不再把它列为开放缺陷。探针的证据标签见 [CAN-229](CAN-229-probe-evidence-label.md)。

## 影响

`copied_from` 可以带上任意 64 位十六进制，调用方看不出它是否对过源文件。修包之后，来源故事仍是修包前的 `declared`，产物摘要已经是新字节。现有 `declared.sha256` 和顶层 `sha256` 已分别表达声明来源和当前产物。待补的是对声明来源的校验结果。

## 期望

声明的 sha256 在能读到源文件时与该源文件字节一致，否则标成 `unchecked` 并写明没有源文件。repair 之后保留修包前的声明，同时用单独字段记下当前产物哈希。两个哈希允许不同，字段名把它们分开。

## 复现

1. `write_operator` 时给一个与文件内容不符的 sha256，观察被接受。
2. `repair_package` 改写层文件后，看 `declared` 仍在，产物摘要已更新。

repair 的 `modifiedByRepair` 有测试。声明哈希与源文件字节的核对没有对应负例。

## 建议修复

- 源文件存在时计算 sha256，与声明不符则拒绝写入。
- 源文件不存在时保存声明，并标 `unchecked`。
- repair 后的产物哈希写入独立字段，不覆盖原始声明。

## 验收标准

- 源文件存在且声明哈希与字节不符时，`write_operator` 拒绝。
- 源文件不存在时，条目标 `unchecked`，格式正确的声明可以留下。
- repair 之后能同时读到原始声明和当前产物哈希，二者允许不同。

## 关联

[CAN-229](CAN-229-probe-evidence-label.md)、CAN-219。

## 处置和验证

可显式为声明提供工作区内 sourceFile 并验证 SHA-256，无法核实的声明标为 unchecked。修包后产物哈希与声明哈希单独记录。
