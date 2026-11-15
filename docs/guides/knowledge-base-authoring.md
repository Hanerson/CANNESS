# 从 ref 参考资料编写知识库条目

本指南面向从算子提交中提炼知识的开发者。字段、校验和查询行为见[知识库设计](../design/06-knowledge-base.md)。

## 1. 盘点候选证据

从 `ref/season1-950PR/` 选一个算子，对照 `season1-950PR-top1/` 和 `season1-950PR-top2/` 中的普通包及带「隐藏」后缀的包。保留实际文件名和 ZIP 的 SHA-256。遇到重名或乱码后缀时，通过完整路径和散列区分版本；散列相同的 ZIP 保留一个代表引用即可。不同散列可以再比对 ZIP 内文件路径和内容，确认变化集中在哪一层。

首批可从 ArgMax 的 host/kernel 和自检入手，验证契约与实现条目的写法。随后用 Exp 对照构建和 dtype 分派，用 GQA 的 golden、probe 和配置检验复杂输入条件能否被准确描述和检索。逐个算子校验和提交，可让审阅者把条目与原包逐一核对。

在仓库根目录下可用 PowerShell 列出匹配包，先把 `ArgMax` 换成要考察的算子名。下面的命令只读取归档清单和散列。

```powershell
$operator = 'ArgMax'
$packages = Get-ChildItem -LiteralPath ref/season1-950PR -Recurse -File -Filter '*.zip' |
  Where-Object { $_.BaseName -like "$operator*" }
$packages | Get-FileHash -Algorithm SHA256
tar -tf $packages[0].FullName
```

## 2. 读实现并拆出可检索结论

- 从 `README`、Python 入口、注册代码和检查脚本确认签名、dtype、布局、属性和边界语义。用例只证明它实际覆盖的范围。
- 顺着 host tiling、launch、kernel 和 plugin 追踪分支。记录分支的触发条件，例如连续性、归约轴长度、dtype、尾块、workspace 或硬件。两份提交做法不同时，先定位代码差别，再记录各自的适用条件。
- 从 `build.sh`、CMake 和平台配置确认目标 SoC 与已知工具链。包目录名可以用来定位材料；适用范围以包内声明和证据为准。
- 从 `checks/`、golden、probe 或报告提取如何验证结论。只有源码就标 `source_inspection`。包内有作者给出的成绩就标 `reported`，附上可找到的硬件、输入、评测器版本和计时口径。后续有独立复测记录时，可以写 `reproduced` 条目并链接报告。证据缺失处在正文明确写出。

每条先写一个 agent 会问的问题，再判断正文能否独立回答它。优先记录具体条件和符号，以及哪些检查能找出错误。参考包中的架构专用策略应同时写到 `hardware` 和正文条件中。若同一策略只适用于某种硬件与 dtype 的组合，为该组合单独建条目。

## 3. 按模板新增条目

复制下面的空白模板到 `plugin/knowledge_base/entries/<id>.md`，替换所有占位内容，按需要添加可选字段。确保文件名与 `id` 一致。模板属于编写指南，真实知识条目才放进 `entries/`。

```markdown
---
{
  "schema_version": 1,
  "id": "replace-with-stable-id",
  "title": "<描述可检索的问题>",
  "kind": "implementation",
  "operator": "<规范算子名>",
  "hardware": ["<目标硬件>"],
  "keywords": ["<API、错误签名或中英术语>"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/<目录>/<包名>.zip!<包内路径>#<符号或行范围>",
      "sha256": "<ZIP 的 64 位十六进制 SHA-256>"
    }
  ]
}
---

**适用条件**：<输入、平台、版本及分支条件。>

**结论**：<可以采用的做法、算法决策或观察。>

**核对方式**：<应阅读的符号、检查用例或测量记录。>
```

`!` 后面写 ZIP 内实际路径，`#` 后面写能定位的符号、配置项或行范围。引用多个版本时，每个版本分别填 `ref` 与散列。将原 ZIP 留在本地 `ref/`，写入插件的内容使用可分发的摘要、引用与自有实测记录。如果摘要限内部使用，可以把条目放进本地知识库并将 dsh 的 `kbRoot` 指向该目录。

## 4. 离线验收

1. 在 `plugin/` 运行 `npm run kb:validate`，检查文件名、字段、来源和正文大小。自建语料可以传入 `npm run kb:validate -- <kbRoot>`。
2. 正向查询用真实的算子名、硬件和一个关键词。确认预期条目位于前几条，正文和来源足以回答问题。再用别名、报错片段或不同语言表述测一次。
3. 把目标硬件、dtype 或布局替换成一个与条目声明冲突的值，确认该条目退出候选。查另一个算子，确认没有因名称相似而误命中。
4. 校对 ZIP 路径、包内路径、符号与 SHA-256。确认引用能让同事在同一份材料中复查结论。

可在 DSH 中调用 `kb_search` 验收。也可在 `plugin/` 先运行 `npm run build`，再用与插件相同的检索函数做离线查询。示例中的名称和检索词换成实际条目的值。

```powershell
node --input-type=module -e 'import { queryKnowledge } from "./lib/knowledge-search.js"; console.log(JSON.stringify(queryKnowledge("knowledge_base", {operator_name:"ExampleOp", query:"TailMask", hardware:"950pr"}), null, 2))'
```
