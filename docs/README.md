# CANNESS 文档

[项目首页](../README.md) · [English README](../README.en.md) · [更新日志](../CHANGELOG.md)

## 使用与开发

- [安装与配置](guides/setup.md)涵盖构建、dsh profile、工作区路径和连接设置。
- [远端评测](guides/remote-evaluation.md)说明预检、runner、性能口径、断线恢复和常见故障。
- [知识库填充](guides/knowledge-base-authoring.md)提供条目模板和从 `ref/` 提取证据的流程。
- [知识库条目索引](reference/knowledge-base-index.md)按算子列出全部条目的一句话结论、类型与证据等级。
- [工具与算子规格参考](reference/tools.md)列出工具、构建 ABI、精度检查和 CANNBench 导出条件。
- [profile 配置参考](reference/configuration.md)列出插件行、默认值和预算规则。

## 当前设计

- [插件架构](design/05-plugin-architecture.md)说明 dsh、CANNESS 和远端 runner 的职责，以及状态与产物如何流转。
- [知识库与 kb_search](design/06-knowledge-base.md)定义条目结构、适用条件、证据与检索契约。

## 验收与历史

- [验收记录与待办](../tickets/TODO.md)记录已有真机证据和待补项。[知识库填充交接](../tickets/knowledge-base-handoff.md)记录后续条目生产计划。
- [2026-11-18 Cummin 实践问题归档](archive/issues/2026-11-18-cummin-practice/README.md)保存一轮算子实现中 15 条已修复问题的证据与复盘，并列出仍未闭环的 4 条及其归属。
- [历史归档](archive/README.md)保存早期设计、实施计划、PR 审查和评测链路交付报告，供追溯设计演变。
