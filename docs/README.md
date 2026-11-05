# 文档索引

本目录保存 CANNESS 的设计与实现记录。代码本身在 [`../plugin/`](../plugin/)，面向使用者的说明在仓库根目录的 [`README.md`](../README.md)。

## 阅读路径

| 你是 | 建议顺序 |
|---|---|
| 第一次接触本项目 | 根目录 [README](../README.md) → [`design/05-plugin-architecture.md`](design/05-plugin-architecture.md) |
| 要改插件代码 | [`design/05-plugin-architecture.md`](design/05-plugin-architecture.md) → [`plans/2026-10-29-dsh-canness-mvp.md`](plans/2026-10-29-dsh-canness-mvp.md) |
| 要了解为什么这样分层 | `design/01` → `design/02` → `design/03` → `design/04` → `design/05` |
| 要接远端评测主机 | [`design/05-plugin-architecture.md`](design/05-plugin-architecture.md) §5.3（含 §5.3.1 远端自举）→ 根目录 README 的「远端约定」 |

## design/ — 架构设计

| # | 文档 | 内容 | 状态 |
|---|---|---|---|
| 01 | [总体设计方案](design/01-overall-design.md) | 项目概述、四层架构、智能体定义、迭代控制、配置管理 | CLI / 配置 / 编排 / LLM 层已被 05 取代 |
| 02 | [详细架构设计](design/02-detailed-architecture.md) | 三层架构展开、Agent 详细设计、远程执行器、知识库 | 执行器部分已被 05 取代；领域契约仍然有效 |
| 03 | [闭环反馈系统设计指南](design/03-closed-loop-feedback.md) | 反馈循环模式提炼、Prompt 增强、性能基线 | 方法论有效，载体改为事件监听 |
| 04 | [可行性评估与实施建议](design/04-feasibility-assessment.md) | 技术可行性、风险、实施路线、MVP 范围 | MVP 范围有效，技术路线被 05 修订 |
| 05 | [插件化架构设计](design/05-plugin-architecture.md) | 基于 deepseek-harness 的重构：职责重划、插件清单、事件映射、技术栈 | **当前实施基准** |

`05` 不推翻 `01`–`04` 的领域契约（规格书、四层代码、测试包、评估报告、知识库结构），只重划实现载体：不再做独立 Harness，通用层交给 dsh。

## plans/ — 实现计划与提案

| 文档 | 内容 |
|---|---|
| [2026-10-29 dsh-canness MVP](plans/2026-10-29-dsh-canness-mvp.md) | MVP 的分任务实现计划（TDD 步骤、验收断言） |
| [2026-10-30 SSH 凭据设计提案](plans/2026-10-30-canness-ssh-credentials-design.md) | SSH 密码认证与 Web 设置卡的设计取舍 |
| [2026-10-30 SSH 密码认证实现计划](plans/2026-10-30-canness-ssh-password-auth.md) | 上一份提案的实现计划与偏差记录 |
| ~~[2026-11-03 远端自举修复提示词](plans/2026-11-03-remote-bootstrap.md)~~ | **已作废**：`watch.py` / `bootstrap` 方案已删除，改为真实 runner。仅保留作历史记录 |
| [2026-11-05 构建契约补齐（方案 B）](plans/2026-11-05-build-contract-skeleton.md) | 当前阻断项的设计：`build_test_package` 补出构建契约（骨架 + golden 插槽） |
| [2026-11-05 PR v0.2.0 验收意见](plans/2026-11-05-pr-v0.2.0-review.md) | 对外部 PR 的逐条修改指导（M1/M2/M3） |

## 约定

- 设计文档按 `NN-<slug>.md` 编号，编号增大表示越晚、越贴近实现。
- 计划文档按 `YYYY-MM-DD-<slug>.md` 命名，是**当时**的实施记录，不作为当前契约。
- 当前契约以 `design/05` 与代码为准；两者冲突时以代码为准，并修正文档。
