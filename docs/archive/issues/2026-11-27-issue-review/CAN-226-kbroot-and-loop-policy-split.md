# CAN-226 默认知识库路径依赖进程 cwd

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `plugin/cordis.patch.yml`、`plugin/src/knowledge-entry.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `kb`, `config` |
| 复核 | 2026-11-27。预算策略拆到 CAN-230 |

## 现象

bundle 把 `kbRoot` 设为 `./plugin/knowledge_base`。这个相对路径按进程 cwd 解析。它只在 cwd 是 CANNESS 仓库根时存在。发布包的 `files` 把 `knowledge_base` 放在包根。路径不存在时，读取可能直接抛错。

README 已经提醒从其它目录启动要改绝对路径。安装进 dsh profile 之后，默认值仍然指向这个相对目录。

设置卡与 loop 预算的分叉见 [CAN-230](CAN-230-loop-eval-budget-split.md)。

## 证据

- `plugin/cordis.patch.yml` 第 7 行：`kbRoot: ./plugin/knowledge_base`。
- `plugin/package.json` 的 `files` 含 `knowledge_base`，不含 `plugin/` 前缀。
- `plugin/src/knowledge-entry.ts` 约第 107–108 行：字符串根原样返回。`knowledge-search.ts` 按该目录读文件。目录缺失时读取抛错。
- README 第 24 行写明从仓库根以外启动要另配知识库路径。

## 影响

从 `本机 dsh 源码检出` 或其他目录启动、且插件装在别的路径时，`kb_search` 使用的默认根不在 cwd 下。调用方会看到路径错误，而不是包内的 20 条条目。

## 期望

未覆盖 `kbRoot` 时，从包内位置解析到 `knowledge_base`。cwd 只作为显式覆盖。解析失败时错误信息写出尝试过的包内路径。

## 复现

1. cwd 设为用户主目录，不改 `kbRoot`，调用 `kb_search`。
2. 看默认路径落在 `<cwd>/plugin/knowledge_base`，而不是安装包里的 `knowledge_base`。

## 建议修复

- patch 去掉 `./plugin/knowledge_base`。
- 代码用 `new URL('../knowledge_base', import.meta.url)` 解析包内目录。
- 显式配置的绝对路径仍然优先。

## 验收标准

- 在任意 cwd 下，未覆盖 `kbRoot` 时能读到包内条目，例如 Exp。
- 显式绝对路径仍指向调用方指定的目录。
- 包内目录缺失时，错误信息含解析后的路径。

## 关联

CAN-207、CAN-230、CAN-218。

## 处置和验证

默认知识库相对插件包解析，支持显式覆盖并提供缺失路径诊断。
