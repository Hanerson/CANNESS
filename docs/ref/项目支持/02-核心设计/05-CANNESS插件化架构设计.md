---
title: CANNESS 插件化架构设计（基于 deepseek-harness）
order: 5
relates_to:
  - "01-CANNESS总体设计方案.md"     # 被本篇部分取代的旧纲领
  - "02-CANNESS详细架构设计.md"     # 被本篇重新映射的旧详细设计
  - "03-闭环反馈系统设计指南.md"    # 反馈模式仍然适用，实现载体改为事件监听
  - "04-可行性评估与实施建议.md"    # MVP 范围不变，技术路线（§9.3）被本篇修订
---

# CANNESS 插件化架构设计（基于 deepseek-harness）

> 原独立 Harness 方案 → deepseek-harness（下称 dsh）插件方案的重构设计

- **日期**: 2026-10-29（同日修订：测试环节去掉平台依赖）
- **状态**: 设计草案（待团队评审）
- **前置阅读**: 01 → 02 → 03 → 04（本篇是对它们的重构，不替代 03/04 的方法论）

## 1. 背景与决策

2026-10-29 决定：CANNESS 不再做独立 Harness，改为 **dsh 插件**。

动机：

1. **国产替代** — 模型侧与运行时侧统一到 DeepSeek / deepseek-harness 生态。算子验证不绑定模力方舟或任何云平台，见 §5.3。
2. **通用层白送** — dsh 是"一切皆插件"的微内核架构（Cordis）：CLI 入口、配置管理、LLM 封装、Agent 编排循环、会话日志、权限/审批、Web UI 全部由 harness 承接。原设计中这四块（01 文档 §2.2 的 CLI 入口 / Orchestrator 底座 / 配置管理 / LLM 封装）不再开发。
3. **观察性内建** — dsh 的第一性约束"Model-visible means logged"（凡进入模型请求必可从会话日志重建）直接满足 MVP 验收目标"完整记录每一轮发生了什么"（04 文档 §7.3）。

**代价（必须正视）**：dsh 插件只能用 **TypeScript / ESM / Node** 编写（官方 Python 包仅是驱动 dsh 子进程的客户端 SDK，不能写插件）。原技术栈 Python 3.12 全栈方案在**插件层**作废，见 §6。

## 2. dsh 核心概念速览

| 概念 | 一句话 | 对 CANNESS 的意义 |
|------|--------|------------------|
| **Cordis 插件** | 一个导出 `apply(ctx, config)` 的 ES 模块；`inject` 声明依赖服务 | CANNESS 域逻辑的载体 |
| **Service / 能力缝** | 服务声明接口 → Provider 实现 → Consumer 使用；挂在 `ctx.<key>` | 知识库、执行器都做成服务 |
| **类型化事件** | `emit / parallel / serial / bail / waterfall` 五种分发；waterfall 是可短路的中间件 | 闭环反馈策略外挂为监听器，不改循环 |
| **bundle / profile** | bundle = 含补丁清单的 npm 包；profile = 有序 bundle 栈 | CANNESS 发布为一个 bundle，`dsh plugin add` 安装 |
| **Session Event Log** | append-only 会话日志，"模型可见即记录"，可重放 | 迭代留痕、中断恢复、复盘零成本 |
| **effect 可逆注册** | 经 `ctx` 注册的一切（工具/监听/定时器）随插件卸载自动撤销 | 配置热更新不残留脏状态 |

关键事件面（本设计用到）：`agent/pre-step`（注入上下文）、`agent/turn-stopping`（停机裁决）、`tools/pre-execute`（工具前置策略）、`tools/result`（观察评测结果）、`session/event`（持久事件流）。

本地克隆：`d:/SE_Tools/deepseek_harness/deepseek-harness`（读 `docs/cordis-tutorial/`、`docs/user/develop/basic/`、`docs/capability-seams.md`）。

## 3. 职责重新划分

### 3.1 交接给 harness 的（原设计删除）

| 旧设计组件（01/02 文档） | dsh 承接方式 |
|---|---|
| CLI 入口 `canness [command]` | `dsh` CLI + 专属 profile；交互入口即 dsh Web UI / 终端 |
| 配置管理（`~/.canness/config.yaml`、设置向导、`canness config`） | 插件 `Config` schema（Schemastery 校验、热更新）+ `cordis.yml` 分层覆盖 |
| LLM 封装（OpenAI SDK、重试） | `ctx.llm`（provider-neutral）+ `llm-retry`（步界重试）+ `token-meter` |
| Agent 编排引擎（CrewAI 原型 / LangGraph 生产） | dsh agent loop 本身；编排策略降级为事件监听器 |
| 迭代留痕、结构化日志 | Session Event Log（append-only、可重放） |
| 智能体间通信超时/重试（01 文档 §8） | harness 工具管线与 `llm-retry` 承接 |
| SSH 连接管理 | 不交给 dsh-ssh。`canness-eval` 用 `ssh2` SFTP 上传并等待（§5.3） |

### 3.2 CANNESS 插件保留的（领域部分）

| 领域能力（02 文档） | 去向 |
|---|---|
| 需求分析（NL → 规格书 JSON） | `canness-generator` 内：`submit_spec` 工具（schema 校验）+ CANN 规范知识注入 + 对话追问 |
| 四层算子代码生成 + 测试包构建 | `canness-generator`：`kb_search` / `write_operator` / `build_test_package` 工具 |
| 测试评估（编译→正确性→边界→性能→汇总报告） | `canness-eval`：`run_evaluation` 只经 SSH 上传测试包并等待结果；五步执行在远端，不在本地 |
| 失败分类与 prompt 增强（03 文档） | `canness-loop`：`tools/result` 监听 + `agent/pre-step` 注入增强块 |
| 迭代控制与停机条件 | `canness-loop`：`agent/turn-stopping` 监听（硬闸）+ 评测服务内规则（编译失败不计迭代） |
| RemoteExecutor 四实现 | **取消**。不再做本地 / SSH 逐步执行 / 华为云 / CANN Lab 四后端，只留通用 SSH 上传 + 等待（§5.3） |
| 知识库（规范/芯片/参考实现/tiling/错误模式） | `canness-knowledge` 服务 + 检索工具 |
| 任务级状态 JSON（04 文档 §6.1） | `canness-eval` 自管状态文件（会话日志之外的持久产物） |

### 3.3 降级为"数据"的（不是代码）

四层代码模板、测试脚本模板（`test_correctness.py.j2` 等）、参考实现库、芯片规格 JSON —— 它们是知识库**内容**，继续用 Python 写（跑在 NPU 机器上的是测试包，不是插件）。**Python 技能没有浪费，浪费的只是框架胶水层。**

## 4. 插件化架构

### 4.1 交付形态

一个独立仓库（如 `canness-dsh`），单个 npm 包 `dsh-canness`，声明为 bundle：

```jsonc
// package.json（节选）
{
  "name": "dsh-canness",
  "type": "module",
  "main": "lib/index.js",
  "engines": { "dsh": ">=0.2.0 <0.3.0" },          // 锁定 dsh 版本窗
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "...", "@deepseek-ai/dsh-tools": "..." }
}
```

```yaml
# cordis.patch.yml — bundle 补丁：插入四个插件行
- insert:
    - id: canness-knowledge
      name: dsh-canness/knowledge
      config: { kbRoot: './knowledge_base' }
    - id: canness-generator
      name: dsh-canness/generator
      inject: [tools, cannessKnowledge]
    - id: canness-eval
      name: dsh-canness/eval
      inject: [tools, cannessExecutor]
    - id: canness-loop
      name: dsh-canness/loop
      config: { maxIterations: 10, convergenceThreshold: 0.05 }
```

用户侧：`dsh plugin --profile canness add github:<org>/canness-dsh`（或本地 `link:` 路径），然后 `dsh --profile canness`。TS 源码分发需带自包含 `prepare` 构建脚本；或发布时构建好 `lib/`。

### 4.2 插件清单

| 插件模块 | 形态 | 注册的工具 | 监听的事件 |
|---|---|---|---|
| `canness-knowledge` | 函数 | `kb_search` | — |
| `canness-generator` | 函数 | `submit_spec`、`write_operator`、`build_test_package` | — |
| `canness-eval` | 函数 | `run_evaluation` | — |
| `canness-loop` | 函数 | — | `agent/pre-step`、`agent/turn-stopping` |

MVP 不挂 Cordis Service。四个插件共享 `{workspace}/.canness/state.json`。失败分类在 `run_evaluation` 里完成，不另听 `tools/result`。上面 §4.1 补丁里的 `inject` / `cannessExecutor` 是旧草图，以计划中的 `cordis.patch.yml` 为准。

### 4.3 一个典型回合（数据流）

```
用户（dsh 会话）: "给一个 Conv2D, FP16, 910B, kernel_time ≤ 150us"
  │
  ▼ agent loop（harness）
  模型调用 submit_spec ──► 规格书 JSON 校验通过（缺字段 → 工具报错，模型追问用户）
  模型调用 kb_search   ──► cannessKnowledge 检索参考实现/tiling 模板（few-shot 注入）
  模型调用 write_operator + build_test_package ──► 四层代码 + 测试包落盘
  模型调用 run_evaluation ──► 本地只做两步：SSH 上传测试包 → 等待远端结果文件
  │                        └─► 拉回的评估报告 JSON 作为工具结果返回
  │                            （编译 / 正确性 / 边界 / 性能在远端完成，本地不编排）
  ▼ run_evaluation 内部计分（不另听 tools/result）
  编译失败、传输超时不计 validIterations；精度 / 性能 / 其它错误计数
  ▼ canness-loop 的 agent/turn-stopping
  预算未尽且最近一次不是 pass → steer 增强块，再跑一轮；否则回合结束
  ▼ 下一 step 的 agent/pre-step
  增强块还不在本步消息里才追加（steer 已经带上同一段时不重复）
  │
  ▼
  停机 → 输出迭代历史最优算子 + 评估报告（全程在 session log 可重放）
```

与旧设计（02 文档 §2.2）的差别：**循环驱动者从 Python 引擎变为模型**，但三类控制权全部收归代码——工具校验（什么能做）、事件监听（注入什么、停不停）、服务内部规则（什么算一次迭代）。模型只负责"下一步做什么"的决策，这是 agent loop 的本职。

## 5. 关键映射详解

### 5.1 三 Agent → 工具 + prompt + 事件

| 旧 Agent（02 文档 §3） | 新载体 | 说明 |
|---|---|---|
| 需求分析 Agent | `submit_spec` 工具 + 追问式对话 | 工具参数 schema 即规格书 schema（02 文档 §3.1 的 JSON 结构原样搬入）；字段缺失由校验失败驱动模型向用户追问，不再单独写追问策略代码 |
| 算子生成 Agent | `kb_search` + `write_operator` + `build_test_package` | 生成策略（检索模板 → 生成 → 修复）改由系统提示词 + 知识注入表达；编译修复由反馈回路驱动（§5.2） |
| 测试评估 Agent | `run_evaluation` 工具 + `cannessExecutor` 服务 | 测试包结构、评估报告 JSON（02 文档 §3.3）仍是领域契约。五步执行改在远端机器上完成；本地只上传并等待。停机判断从 Agent 内挪到 `turn-stopping` 监听 |

### 5.2 迭代控制（原 Orchestrator）

停机条件（01 文档 §4.2 / 02 文档 §3.3.4）挂在 `agent/turn-stopping` 上。dsh 0.2.1 里这个事件是 **serial**，在回合即将结束、且没有下一步输入时触发（`packages/core/agent-loop/src/agent.ts`）。它不是 waterfall：监听器 `return` **不会**停机，不调用 `next()`。要再跑一轮，必须 `agent.steer(...)`；什么都不做，回合就结束。

```ts
// canness-loop：预算未用尽且上一轮失败时，才 steer 续轮
ctx.on('agent/turn-stopping', ({ agent }) => {
  if (shouldSteer(taskState, config)) {
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: enhancementBlock(taskState) }],
      source: { kind: 'canness-loop', form: 'notice', summary: 'retry operator' },
    }))
  }
})
```

计数规则在评测服务里：编译失败、传输超时不进 `validIterations`。模型在预算已尽时再调 `run_evaluation`，工具直接返回错误，不上传。

通知策略（01 文档 §4.3）：每次评测结果随工具结果进入会话（模型可见、用户可见）。编译失败不计迭代，由 `turn-stopping` steer 再试，不在评估服务里偷偷重跑。`Ctrl+C` 中断与「输出当前最优」由 harness 会话中断 + 状态文件承接。字段级约定见 `docs/superpowers/plans/2026-10-29-dsh-canness-mvp.md`。

### 5.3 算子测试：通用 SSH，本地只上传并等待

2026-10-29 补充决定：**去掉模力方舟、华为云、CANN Lab 等平台依赖**。02 文档 §4 的四套执行器不再实现。测试机是任意一台能 SSH 上去、且自己装有 CANN 工具链的机器；插件不包含该平台的 SDK 或控制台流程。

传输**不用** dsh `ssh` 包家族。`@deepseek-ai/dsh-ssh` 要求两端都是 Linux/macOS，还要在远端安装带 SHA-256 的 helper（`packages/ssh/ssh/README.md`）。开发机是 Windows，这和「通用 SSH、只上传再等待」相反。MVP 用 `ssh2` 做 SFTP：上传目录、轮询结果文件、拉回。本地在测试环节只有两步：

1. **上传**。把本轮测试包写到远端约定的 inbox 目录。
2. **等待**。轮询约定的结果路径，直到结果文件出现或超时，再拉回解析为评估报告 JSON。

编译、正确性、边界、性能都在远端发生。本地不逐条执行 cmake / kernel_eval，也不调用云 API。远端靠什么开始跑（目录监听，或那台机器上原有的 runner）是主机侧约定，不是 CANNESS 要适配的平台。

| 旧实现（02 文档 §4） | 处置 |
|---|---|
| `SSHExecutor` | 收成上面这一条。不再由本地通过 SSH 逐步驱动编译和评测命令 |
| `LocalExecutor` | 删除。本机不跑 CANN |
| `CloudAPIExecutor` | 删除。不对接华为云 |
| `ManualExecutor` | 删除。不再提示用户手工上传 CANN Lab |

MVP 不挂 `cannessExecutor` 服务。`run_evaluation` 直接上传，然后等待。配置是扁平字段，不用 dsh 的 ssh 主机表。预算四字段在 `canness-loop` 里再写一份相同的数。字段以计划为准，例如：

```yaml
# canness-eval config（节选）
host: npu-lab
port: 22
username: canness
privateKeyPath: C:/Users/me/.ssh/id_ed25519
inbox: /tmp/canness/inbox
outbox: /tmp/canness/outbox
timeoutSec: 1800
pollIntervalMs: 2000
maxIterations: 10
maxCompileRetries: 3
negativeStreakLimit: 3
convergenceThreshold: 0.05
```

### 5.4 知识库 → 服务 + 检索工具 + 上下文注入

- **载体**：`cannessKnowledge` Service 封装 `knowledge_base/` 目录（结构沿用 02 文档 §5.1），MVP 用文件级检索（关键词 + 算子类型索引），SQLite/向量库留到 Phase 3（04 文档 §7.2 本就暂缓）。
- **检索**：`kb_search` 工具（模型主动查）。
- **注入**：`agent/pre-step` waterfall 监听器按任务阶段自动注入芯片规格表、当前算子类型的 tiling 模板（被动知识），与主动检索互补——即 03 文档的 Prompt 增强策略，载体从"拼 prompt 字符串"变为"注入上下文块"。

### 5.5 留痕与恢复

- **每轮生成/prompt/评测结果/失败分析**（04 文档 Phase 2 验收项）：全部经工具结果与注入块进入会话 → 被 session log 持久化，天然满足"可追踪"。
- **任务级状态 JSON**（产物路径、generation_id、评测配置）：`canness-eval` 写入工作区状态文件，中断后重启动可续。
- **`generation_id`**：评测服务内部维护，随报告 JSON 一并写入日志。

## 6. 技术栈变更

| 层 | 旧（01/02 文档 §7/§6） | 新 | 说明 |
|---|---|---|---|
| 插件代码 | Python 3.12 | **TypeScript (ESM, Node)** | 硬约束：dsh 插件仅支持 TS；Python SDK 只是客户端 |
| Agent 编排 | CrewAI / LangGraph | dsh agent loop | 删除依赖 |
| LLM | OpenAI SDK | `ctx.llm` + provider 路由 | 用 dsh profile 配好的提供商。CANNESS 不绑定模力方舟或其他平台端点 |
| 配置 | YAML + Pydantic | `cordis.yml` + Schemastery | 机制对等，API 不同 |
| 远程执行 | paramiko；四后端含华为云 / CANN Lab | `ssh2` SFTP，只上传并等待结果 | 见 §5.3。不用 dsh-ssh helper，无平台 SDK |
| 测试脚本 / 参考实现 / 数据生成 | pytest / NumPy | **不变**（仍为 Python） | 属于测试包内容，跑在 NPU 环境 |
| 包管理 | pip / pyproject | pnpm / package.json | 团队需熟悉 |
| 教程基准 | 无 | `docs/cordis-tutorial/`（7 章） | 上手路径，无需 API key |

**学习成本评估**：四个插件模块的 TS 面积不大（工具定义 + 服务类 + 事件监听，tutorial 覆盖全部所需语法）；真正的新概念只有 Cordis 生命周期/事件语义。对 Python 背景团队，预计 1–2 周 ramp-up，建议先用 tutorial 的 scratch 目录练手再动本仓库。

## 7. MVP 重排（对 04 文档 §7 的映射）

04 文档 MVP 范围（单轮生成 → 评测 → 失败分类 → 一次重试 → 留痕）**不变**，实现载体改为：

| MVP 必须项（04 文档 §7.1） | 新载体 |
|---|---|
| YAML 任务配置解析 | `cordis.yml` + `Config` schema |
| 统一生成器接口 / 单轮生成 | `write_operator` 工具 + 系统提示词 |
| submission 转换 / kernel_eval 封装 | `run_evaluation`：SSH 上传测试包，等待远端结果。kernel_eval 在远端跑，本地不封装平台调用 |
| stdout/stderr/exit code/产物路径保存 | 评估服务状态文件 + session log |
| 任务级状态 JSON | `canness-eval` 状态文件 |
| 超时控制 | 工具 `exec.signal` + 执行器超时 |
| 失败规则分类 + 一次自动重试 | `tools/result` 监听（分类）+ `agent/pre-step`（增强重试） |
| 完整记录每一轮 | session log（免费获得） |

暂缓项不变（Dashboard、并行融合、tiling 搜索、融合、向量 KB、容器沙箱）。**新 MVP 验收补一条**：`dsh --profile canness` 起 Web UI，跑通一个算子的完整闭环，且会话可重放。

## 8. 风险与待确认问题

| # | 问题 | 影响 | 缓解 |
|---|------|------|------|
| 1 | **远端结果契约**：结果路径、JSON 格式、超时，以及 inbox 无人消费时会一直等到超时 | 高，闭环的前提 | 第一周 spike：向一台 SSH 主机丢一个测试包，确认能等到结果文件 |
| 2 | 团队 Python → TS 转型 | 中 | tutorial 7 章练手；胶水层面积已压到最小（§6） |
| 3 | dsh 处于 Developer Preview，机制演进 | 中 | `engines.dsh` 锁版本窗；升级看 `docs/upgrade-guide/` |
| 4 | `agent/turn-stopping` 的裁决语义与预期不完全一致（如停机时如何"输出最优"） | 中 | spike 验证；兜底方案是 `canness-loop` 自管一轮"收尾请求" |
| 5 | 上传后的长时间等待与 agent loop 的配合（工具内阻塞 vs 拆两回合） | 中 | 用 `ctx.jobs.start`（后台任务）承载轮询，spike 验证 |
| 6 | 04 文档 §9.2 的既有确认项（kernel_eval 格式稳定性、失败日志样本、评测环境可重复性） | 不变 | 与插件化无关，维持原计划 |
| 7 | 外部 bundle 对 dsh 内部包的 peer 依赖在其发版后漂移 | 低 | peer+dev 双声明（官方建议做法），CI 里对锁定版本跑冒烟 |

## 9. 参考路径索引（本地克隆）

| 内容 | 路径（相对 `d:/SE_Tools/deepseek_harness/deepseek-harness`） |
|---|---|
| 插件框架教程（7 章，练手用） | `docs/cordis-tutorial/` |
| 最小 Harness 插件 / 工具 / 配置 / 打包 | `docs/user/develop/basic/{index,tool,config,publish}.md` |
| 工具 DSL 全参考 | `docs/cookbook/adding-a-tool.md` |
| LLM adapter | `docs/cookbook/adding-an-llm-adapter.md` |
| 能力缝 / 架构 | `docs/capability-seams.md`、`docs/architecture.md` |
| Cordis API | `docs/cordis-api/{context,events,service,registry,fiber}.md` |
| 事件生产/消费总表 | `docs/event-producer-consumer.md` |
| SSH provider 家族 | `packages/ssh/README.md`、`docs/subsystems/ssh.md` |
| LLM 包家族 | `packages/llm/README.md` |
| 现成小插件范例 | `packages/todo/tool-todo/` |
| bundle 清单范例 | `packages/bundle/base/cordis.patch.yml` |
| Python SDK（仅客户端） | `python/sdk/README.md` |

---

*本文取代 01/02 文档中的 CLI、配置、编排、LLM 层，以及其中的模力方舟 / 四执行器测试方案。规格书、评估报告、测试包、知识库结构继续以 01/02 为准。*
