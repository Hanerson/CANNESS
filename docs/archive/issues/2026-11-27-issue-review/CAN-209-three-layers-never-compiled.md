# CAN-209 host、API、plugin 缺少编译验证

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/src/package-files.ts`、`generator-sources.ts`、`templates/build-contract/build.sh` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `layers`, `build-contract` |
| 复核 | 2026-11-27。保留为覆盖缺口 |

## 现象

打包要求 host、API、plugin、kernel 四层源码都在。默认测试包编译的是 kernel 和通用驱动 `main.cpp`。manifest 把 host、API、plugin 标成 `documentedOnlyLayers`。导出使用另行生成的封装，不编译这三份层文件本身。

因此这三层是打包门禁，默认评测和默认导出都没有对它们做编译验证。

## 证据

- `plugin/src/package-files.ts` 第 620–621 行：`compiledLayers: [LAYER_FILES.kernel]`，`documentedOnlyLayers: [LAYER_FILES.host, LAYER_FILES.api, LAYER_FILES.plugin]`。
- `plugin/templates/build-contract/build.sh` 第 2–6 行与第 36–42 行：编译 `op_kernel/kernel.cpp` 和通用 `main.cpp`。
- `plugin/src/generator-sources.ts` 第 31–32 行附近：缺任一层就不能打包（`missingLayers`）。
- 导出工程由 `submission.ts` 另行生成封装，编译的是导出模板，不是这三份层文件。
- `package-files.test.ts` 断言了 `documentedOnlyLayers`。

## 影响

缺任一层会让 `build_test_package` 失败。四层都在时，默认评测只证明 kernel 和通用驱动能编。host、API、plugin 的编译错误要到另有编译步骤时才会出现。

## 期望

工具描述和 manifest 对每一层使用同一句话：参与编译，或只作记录。host、API、plugin 若仍是必选源码，就要有编译或接口检查；若保持不编译，就不再作为打包失败条件。

## 复现

1. 只写 kernel，调用 `build_test_package`，观察因缺层失败。
2. 四层都写上，看默认 `build.sh` 的编译列表是 kernel 与 `main.cpp`。
3. 看导出目录是另行生成的封装。

## 建议修复

- 在契约自检里编译或解析 host 与 API，失败写入 `contractSelfCheck`。
- 或者 `missingLayers` 只强制 kernel，其余层在有内容时进入 provenance，并在 manifest 里标明未编译。

## 验收标准

- 验收目标是 host、API、plugin 获得编译验证，或被明确标成不参与编译且缺了也不失败。
- 默认测试包对 kernel 和通用驱动的编译保持现状，直到上面的选择落地。

## 关联

CAN-204、CAN-210、仓库 CAN-114。

重开 CAN-009 的设计取舍。默认编译和归档此前已明确 documented-only，本条跟踪打包门禁与执行范围是否一致。

## 处置和验证

采纳 CAN-009 直接启动的后续方案：默认只要求 kernel，已提供的 host、API、plugin 继续作为可追溯源码随包保存，manifest 和导出保留哈希。
