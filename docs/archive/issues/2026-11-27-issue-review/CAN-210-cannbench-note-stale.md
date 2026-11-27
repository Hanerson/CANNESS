# CAN-210 `CannBench_Submit.md` 的目录和分数记录与现行导出器并列不清

| 字段 | 值 |
|---|---|
| 类型 | 文档 |
| 优先级 | **P2** |
| 组件 | `plugin/knowledge_base/CannBench_Submit.md`、`plugin/src/submission.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `knowledge`, `docs`, `export` |
| 复核 | 2026-11-27。65.41 保留为独立的 910C 历史记录 |

## 现象

`kb_search("CannBench")` 没有同名结构化条目，会回退到根笔记。笔记里的四层目录是旧布局 `csrc/ops/<op>/...`。现行导出器写出 `build.sh`、`setup.py`、`cann_bench/__init__.py`、`csrc/launch.cpp`、`csrc/op_kernel/kernel.cpp`。

分数有两笔，环境不同：

- 65.41 有单独的 910C 历史记载，日期在笔记中的 2026-11-04 附近。原始结果文件本轮没有找到，不能改写成错误数字，也不能并进后来的交付。
- 30 对应较新的 `--no-perf` 交付：编译 5 + 运行 5 + 功能 20。README 与 CHANGELOG 记录的是这一笔，并写明官方性能分尚未验证。

笔记目前把目录和分数放在同一篇里，没有分开写环境、评测模式和证据来源。

## 证据

- `plugin/knowledge_base/CannBench_Submit.md` 第 3–4 行：score 65.41。第 14–24 行：旧的四层目录映射。
- `CHANGELOG.md:159` 记录 `--no-perf` 的 score 30，`README.md:42` 记录模式和待验证的性能分。`plugin/knowledge_base/Exp.md:21` 另记 65.41 及其 910C / CANN 9.0.0 环境。
- `plugin/src/submission.ts` 约 284–294 行写出 direct-launch 工程的 `build.sh`、`setup.py`、`cann_bench/__init__.py`、`csrc/launch.cpp`、`csrc/op_kernel/kernel.cpp`。
- `docs/reference/tools.md` 第 55 行链接到该笔记。
- 65.41 的原始结果仍缺。复核没有把它判定为抄写错误。

## 影响

模型按笔记改 host/api 目录时，改的是现行导出器不会生成的路径。读者也会把 65.41 和 score 30 看成同一次结果。两笔记录的硬件、模式和证据来源不同。

## 期望

笔记的文件表与 `submission.ts` 的当前输出一致，旧目录标明是历史布局。65.41 与 30 分成两行，分别写环境、评测模式和证据来源。65.41 的原始结果补上之前，该行保持「历史记载，原始结果待补」。

## 复现

1. 读笔记第 3–24 行。
2. 对照 README 的 `--no-perf` 和 CHANGELOG 中的 score 30。
3. 读 `submission.ts` 的导出文件列表。

## 建议修复

- 重写目录表，每一行对应现行导出器写入的路径。旧的 `csrc/ops/<op>/` 布局单独标成历史。
- 分数分成两行：910C 历史记载 65.41（原始结果待补）；较新 `--no-perf` 交付为 30。
- 增加结构化条目，避免根笔记成为唯一检索结果。

## 验收标准

- 笔记中的当前导出布局与 `submission.ts` 一致。旧目录若保留，标成历史布局。
- 65.41 与 30 分行书写，各自有环境、评测模式和证据来源。
- 65.41 在原始结果补上之前，不被改写成 30，也不被删成「错误分数」。

## 关联

CAN-209、CAN-219。

## 处置和验证

更新现行导出布局。历史 65.41 与较新 30 分分开记录，前者原始结果仍注明待补。
