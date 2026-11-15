# 转交任务：CANNESS 结构化知识库条目生产

> 交接人：Hanerson ｜ 接手：知识库小组 ｜ 起稿：2026-11-15
> 相关文档：[设计说明](../docs/design/06-knowledge-base.md) ｜ [编写指南](../docs/guides/knowledge-base-authoring.md) ｜ [示范条目](../plugin/knowledge_base/entries/argmax-950pr-stale-build-not-recompiled.md)

## 1. 为什么做这件事

插件闭环里，模型在**写算子之前**要能查到「在什么条件下该怎么做，以及这个结论凭什么可信」。
旧知识库是 8 篇自由格式笔记，`kb_search` 只能按算子名做文件名匹配，返回整篇文本——
检索不到、也无法判断某条结论是否适用于当前硬件/dtype。

结构化条目把三件事变成机器可判的字段：**适用范围**（`hardware` / `dtypes` / `layouts` / `cann_versions`）、
**结论类型**（`kind`）、**证据强度**（`evidence` + 可核对的 `sources`）。

## 2. 输入材料

| 材料 | 位置 | 说明 |
|---|---|---|
| 参考提交包 | `ref/season1-950PR/season1-950PR-top1/`、`.../top2/` | 每个算子一个 ZIP（含「隐藏」变体）。`ref/` 已被 `.gitignore` 忽略，**不进仓库** |
| 编写指南 | [docs/guides/knowledge-base-authoring.md](../docs/guides/knowledge-base-authoring.md) | 四步法：盘点证据 → 拆可检索结论 → 按模板写 → 离线验收 |
| 字段与检索规则 | [docs/design/06-knowledge-base.md](../docs/design/06-knowledge-base.md) | 字段约束、排序规则、预算 |
| 示范条目 | `plugin/knowledge_base/entries/argmax-950pr-stale-build-not-recompiled.md` | 照这个结构写 |
| 校验器 | `cd plugin && npm run kb:validate` | 与运行时同一个解析器 |

`ref/season1-950PR/__MACOSX/` 是 macOS 打包残留，**不要**当材料用。

## 3. 任务范围与顺序

| 批次 | 算子 | 目标条目数 | 建议类型 |
|---|---|---|---|
| 1（已起步） | ArgMax | 3~5 | `contract`（并列取首个 / int64 输出）+ `implementation`（tiling、dtype×连续性分派）+ 示范条目 |
| 2 | Exp | 3~5 | `contract`（`base<=0` 走自然底数、`scale/shift` 语义）+ `implementation` |
| 3 | GQA | 3~5 | `contract`（golden / probe 的输入条件）+ `troubleshooting` |
| 4（可选） | 通用 | 2~3 | `troubleshooting`（如「`--allow-multiple-definition` 之外的重复符号」）、`benchmark` |

一条目一文件，文件名 = `id`。**先小步提交**：一个算子一个 PR，让评审能把条目和原包逐条对上。

## 4. 交付标准（硬性）

### 4.1 格式

- [ ] `npm run kb:validate` 通过，且条目数按预期增加（当前基线 1 条）；
- [ ] 文件名与 `id` 一致；`id` 用小写字母/数字/连字符，≤80 字符，**改措辞不改 id**；
- [ ] `sources` 每项都有 `ref`，并带 `sha256`（**ZIP 用整包散列**，64 位小写十六进制）；
- [ ] `ref` 用 `路径/包.zip!包内路径#符号或行范围` 的形式，能让同事在自己机器上一跳就到；
- [ ] 正文 1–1800 字符，去掉首尾空白。

### 4.2 内容

- [ ] **一条一个结论**。不同 `evidence` 等级的结论拆成多条；
- [ ] `evidence` 如实填写：只读了源码 = `source_inspection`；材料里有作者的分数 = `reported`；我们有独立复测 = `reproduced`；规范明文要求 = `specification`；
- [ ] 正文必须能独立回答：「什么条件下、用什么做法、怎么核对」，即**适用条件 / 结论 / 核对方式**三段；
- [ ] 平台专属结论必须显式写 `hardware`；适用条件随硬件或 dtype 变化时拆条目，不要写「视情况而定」；
- [ ] `aliases` 只在拼写或语义确实等价时填，**不要把算子变种当别名**。

### 4.3 检索验收（四步，缺一不可）

1. **正向**：用真实算子名 + 一个关键词查询，目标条目出现在前几条；
2. **别名/报错片段**：换一种说法（报错签名、中英文术语）仍能命中；
3. **负向**：把 `hardware` 或 `dtype` 换成与条目冲突的值，该条目必须**退出**候选；
4. **串扰**：查另一个算子，不能因为名字相近而误命中。

命令样例（在 `plugin/` 下，`npm run build` 之后）：

```powershell
node --input-type=module -e "import { queryKnowledge } from 'file:///D:/projects/CANNESS/plugin/lib/knowledge-search.js'; console.log(JSON.stringify(queryKnowledge('D:/projects/CANNESS/plugin/knowledge_base', { operator_name: 'ArgMax', query: '增量编译', hardware: '950pr' }), null, 2))"
```

### 4.4 提交物

- PR 内包含：条目文件、`kb:validate` 输出、四步验收的查询结果（贴 JSON 摘要即可）；
- PR 描述写清：读了哪个包（散列）、结论的适用边界、**哪些地方没把握**。

## 5. 红线（违反即打回）

1. **不把原包内容大段抄进知识库**——只写可检索的结论，原件留在 `ref/`；
2. **不编造 `sha256` / 行号 / 符号名**，引用必须是真读过的；
3. **不把作者自报成绩写成 `reproduced`**；
4. **不写没有适用条件的通论**（「一般先做 tiling」这类没有信息量的句子）；
5. **不在 `entries/` 里放模板或说明文件**——校验器把该目录下每个 `.md` 都当正式条目。

## 6. 已知环境问题

- `npm run kb:validate` 的脚本直接 `import` 了 `src/knowledge-entry.ts`，依赖 **Node 原生 TS 类型剥离**（本机 v24.18、CI node 24 均正常）。用 Node 20/22 会直接失败，遇到时先升级 Node。
- `ref/` 下的「隐藏」变体文件名在 Windows 控制台可能显示为乱码（UTF-8 被按 GBK 解码），**按路径和散列区分，不要按显示名区分**。

## 7. 一手参考：示范条目怎么写的

`argmax-950pr-stale-build-not-recompiled`（`implementation`，证据 `source_inspection`）：

- 结论来自 `top2/ArgMax.zip` 的 `build.sh` 注释——增量 cmake 不重编改过的 kernel，曾用已改动的源码产出**字节相同**的库；
- `sources` 只写一条精确引用（整包散列 + `build.sh#L55-L58`）；
- 正文三段：适用条件（950PR + `--soc=ascend950` + 反复迭代）、结论（删 `build/`，并用 `SHA256SUMS` 确认产物真变了）、核对方式（读注释、比散列、看目标文件 mtime+散列）。

照这个粒度写就行：**能被下一次查询命中，能被同事验证，能让人少踩一次坑**。
