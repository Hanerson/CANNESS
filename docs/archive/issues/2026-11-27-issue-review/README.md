# CANNESS Issue 复核与修复归档

本轮评估与修复记录于 2026-11-27。以下环境与版本信息对应修复前的评估基线。

2026-11-27 按 [复核反馈](CANNESS-issue-review-feedback-2026-11-27.md) 改过一版。被复核否定的结论已从对应条目里删除或收窄。CAN-214 并入仓库已有的 CAN-114，不再作为新的开放缺陷。

| 项 | 值 |
|---|---|
| 仓库 | `CANNESS 仓库`，`main` @ `a86ca2c`，工作区干净 |
| 包 | `dsh-canness` 0.5.0（`plugin/`） |
| 本机 dsh | `本机 dsh 源码检出`，根版本 `0.2.2-rc.2` |
| 本机 cordis / schemastery | `4.1.0` / `3.19.0` |
| 插件钉扎 | dsh peer `0.2.1-rc.3`，cordis `4.0.5`，schemastery `3.18.5` |
| 远端 | `SSH 宿主机`（用户指定的私钥登录宿主机 22 端口） |
| 容器 | `canness-eval:9.2.1`，已运行（自 2026-11-23），`22/tcp` 映射到宿主机 `20022` |
| 真卡 | 8 × Ascend 910B2 |
| 容器工具链 | CANN `9.2.1`（`compiler/version.info`，`timestamp=20261026_000125081`），Python 3.12.16，torch `2.10.0+cpu`，torch_npu `2.10.0.post7` |

编号从 `CAN-201` 起，避免和仓库里已有的 `CAN-0xx`、`CAN-1xx` 撞号。各条保留原始现象与验收标准，并在末尾记录实际处置和验证。

## 复核时的建议处置顺序

1. 先处理 [CAN-225](CAN-225-cannlab-token-ref-dropped.md)、[CAN-221](CAN-221-device-error-consumes-iteration.md) 至 [CAN-224](CAN-224-msprof-averages-unmatched-rows.md)、[CAN-205](CAN-205-single-state-file-drops-results.md)。它们分别涉及 CANNLab 配置读取、有效迭代计数、提交模式、设备故障分类、性能采样和评测结果留存。
2. [CAN-201](CAN-201-ssh-does-not-reach-cann-921.md) 已从 P0 降为部署识别问题。转发进容器和宿主机直连的预检都是 `ready: true`，工具链不同。验收核对实际端点和工具链版本。
3. [CAN-214](CAN-214-layer-carry-reconnect-reference.md) 并入仓库 CAN-114。设置卡上的重连描述归入同一处。[CAN-203](CAN-203-default-device-inbox-and-gc.md) 只留远端产物回收；路径、选卡和锁见 [部署记录](NOTE-remote-deployment.md)，临时目录提示关联仓库 CAN-014。`--loop` 只由 [CAN-220](CAN-220-hygiene-followups.md) 跟踪。

## 索引

| ID | 优先级 | 类型 | 状态 | 标题 |
|---|---|---|---|---|
| [CAN-201](CAN-201-ssh-does-not-reach-cann-921.md) | P2 | 设计 | fixed | 两条 SSH 预检都返回 ready，输出不区分工具链版本和转发配置 |
| [CAN-202](CAN-202-soc-env-disagrees-with-910b2.md) | P2 | 缺陷 | fixed | 预检报告 910B2 且 `issues` 为空，不对照 `SOC_VERSION=ascend910b1` |
| [CAN-203](CAN-203-default-device-inbox-and-gc.md) | P2 | 缺陷 | fixed | 远端评测与校验的尝试目录没有回收 |
| [CAN-204](CAN-204-eval-and-export-dialects-diverge.md) | P2 | 设计 | partial | 默认评测构建使用 `-x cce`，默认导出会探测 `-xasc` |
| [CAN-205](CAN-205-single-state-file-drops-results.md) | P1 | 缺陷 | fixed | 换代后旧评测的报告仍返回，但本地状态不留该代结果，写入也不原子 |
| [CAN-206](CAN-206-symbolic-shape-silently-32768.md) | P1 | 设计 | fixed | 符号维在打包时静默变成 32768 个元素 |
| [CAN-207](CAN-207-hardware-filter-hides-contracts.md) | P1 | 设计 | fixed | 查询指定 Ascend910B2 时，Exp、ArgMax、GQA 为零命中 |
| [CAN-208](CAN-208-gelu-formula-contradicts-code.md) | P2 | 缺陷 | fixed | `Gelu.md` 的文字推导把 tanh 的输入多乘了一倍 |
| [CAN-209](CAN-209-three-layers-never-compiled.md) | P2 | 设计 | fixed | host、API、plugin 缺少编译验证 |
| [CAN-210](CAN-210-cannbench-note-stale.md) | P2 | 文档 | fixed | `CannBench_Submit.md` 的目录和分数记录与现行导出器并列不清 |
| [CAN-211](CAN-211-provenance-is-self-reported.md) | P2 | 设计 | fixed | 来源声明的 sha256 只做格式校验 |
| [CAN-212](CAN-212-ssh-accepts-any-host-key.md) | P2 | 安全 | fixed | 插件的 SSH 传输不校验主机密钥 |
| [CAN-213](CAN-213-settings-card-cannot-express-workflow.md) | P2 | 设计 | fixed | 设置卡没有设备和工具链字段，目标确认没有独立的用户来源 |
| [CAN-214](CAN-214-layer-carry-reconnect-reference.md) | — | 合并记录 | 并入 CAN-114 | 层继承、重连入口、`reference` 校准归回仓库 CAN-114 |
| [CAN-215](CAN-215-roofline-only-original-910.md) | P2 | 设计 | fixed | 910B2 历史报告的屋顶线为空，表里只有初代 Ascend910 |
| [CAN-216](CAN-216-toolkit-root-hardcodes-921.md) | P2 | 缺陷 | fixed | `readRoots` 对目录名 `cann-9.2.1` 有特判 |
| [CAN-217](CAN-217-python-validators-not-in-ci.md) | P2 | 测试 | fixed | 两份独立 Python 测试未进入 CI |
| [CAN-218](CAN-218-dsh-pin-lags-local-harness.md) | P3 | 验证 | verified | 记录插件 peer 0.2.1-rc.3 与本机 dsh 0.2.2-rc.2 的组合 |
| [CAN-219](CAN-219-docs-lag-current-tree.md) | P2 | 文档 | fixed | 知识库索引、工具参考和 TODO 计数与当前树不一致 |
| [CAN-220](CAN-220-hygiene-followups.md) | P3 | 卫生 | partial | 凭据名三个 N、未调用的 `--loop`、刷新与设置卡的测试缺口 |
| [CAN-221](CAN-221-device-error-consumes-iteration.md) | P1 | 缺陷 | fixed | `error` 计入有效迭代，日志压缩会丢掉设备故障行 |
| [CAN-222](CAN-222-kernel-pass-ignores-submission.md) | P1 | 设计 | fixed | 提交模式的完成条件尚未包含验收结果 |
| [CAN-223](CAN-223-eight-mib-hides-device-fault.md) | P1 | 缺陷 | fixed | 超过 8 MiB 的验收日志只报告超限，设备故障标记不再出现 |
| [CAN-224](CAN-224-msprof-averages-unmatched-rows.md) | P1 | 缺陷 | fixed | 零匹配时 `summary_durations` 会把混合任务的时长平均进去 |
| [CAN-225](CAN-225-cannlab-token-ref-dropped.md) | P1 | 缺陷 | fixed | `canness-remote` 只接受原始字符串，volatile 配置被丢掉 |
| [CAN-226](CAN-226-kbroot-and-loop-policy-split.md) | P2 | 设计 | fixed | 默认知识库路径依赖进程 cwd |
| [CAN-227](CAN-227-ssh-exit-and-timeout-budget.md) | P2 | 缺陷 | fixed | SSH 没有数字退出码时按 0 处理 |
| [CAN-228](CAN-228-tiling-cache-commits-before-copy.md) | P2 | 缺陷 | fixed | tiling 缓存在同步和 H2D 成功之前提交 |
| [CAN-229](CAN-229-probe-evidence-label.md) | P2 | 设计 | fixed | 探针的自由文本和实测字段共用 `reproduced` 标签 |
| [CAN-230](CAN-230-loop-eval-budget-split.md) | P2 | 设计 | fixed | 设置卡更新 eval 预算，续轮读取 loop 自己的配置 |
| [CAN-231](CAN-231-outer-timeout-before-stage-deadlines.md) | P2 | 缺陷 | fixed | 外层 1800 秒可能先于内部阶段截止 |

归档统计为 27 条已修复、1 条已验证、2 条部分完成、1 条并入旧单。部署记录不计入工单。

## 拆分与合并

- CAN-211 只保留来源声明的格式校验。探针证据标签为 CAN-229。golden 改动后需要重建，已经写在工具参考里。
- CAN-226 只保留默认知识库路径。共享预算策略为 CAN-230。
- CAN-227 只保留 SSH 缺数字退出码时默认为 0。外层超时为 CAN-231。连接泄漏未证实。提交验收已有自己的截止时间。
- CAN-214 并入仓库 `docs/archive/issues/2026-11-19-practice-findings/CAN-114-minor-workflow-friction.md`。层继承只保留明确不依赖该属性的产物。CAN-213 的重连描述归入这里。

## 这次核对过、不再立案的事

- `agent/pre-step` 与 `agent/turn-stopping` 在本机 dsh 0.2.2-rc.2 里仍在，`PreStepDecision` 仍是 `{ kind: 'enter', messages, startsRequestSeries? }`。续轮监听器的形状没有被这次版本差直接打断。版本组合的验证任务见 CAN-218。
- `defineTool` 仍从 `@deepseek-ai/dsh-tools` 导出，schemastery `3.19.0` 仍有 `Schema.role`。复核的 TypeScript 类型检查通过。
- 生成物没有入库：`plugin/lib`、`node_modules`、`__pycache__`、`ref/`、`submissions/` 都在 `.gitignore` 里。`ref/season1-950PR` 约 213 个 zip、34 MB，外加 `__MACOSX`，当前未跟踪。
- CI 存在（Ubuntu + Windows，Node 24，pnpm 11，`pnpm check` / `pnpm test` / `kb:validate` / `py_compile` / `pnpm build` / `staleBuild`）。`typescript@7.0.2` 是锁文件里的真包。两份独立 Python 测试仍未进入 CI，见 CAN-217。
- 已提交文件里没有扫到私钥、`AKIA`、`ghp_`、`sk-`。`BEGIN OPENSSH` 只出现在测试夹具。
- 默认凭据名 `CANNNESS_SSH_PASSWORD`（三个 N）在代码、测试和文档里是一致的可配置默认名。提示容易配成两个 N，所以留在 CAN-220，不单独立成「拼写错误」。
- CHANGELOG `[Unreleased]` 已标修复的 CAN-018～CAN-026、CAN-108、CAN-109 没有整条重开。CAN-105 的符号维静默回退收窄为 CAN-206。CAN-114 仍以仓库原编号跟踪，桌面 CAN-214 只是合并记录。
- 容器里的 torch 是 `+cpu` 配 `torch_npu`。这是昇腾常见装法，这次不把它当成缺陷。
- 容器经 `127.0.0.1:20022` 的插件预检，以及宿主机直连的同一 runner，都返回 `ready: true`。容器内 `bisheng` 与 `msprof` 位于 CANN 9.2.1 下。宿主机 `bisheng` 位于 `latest/compiler/ccec_compiler/bin/`。两侧都显示 clang 版本。识别问题见 CAN-201。
- 没有证据表明转发隧道每次重连都会更换主机密钥。插件传输本身仍不校验主机密钥，见 CAN-212。
- 连接泄漏未证实，不单独立项。
- 工作区部分 Python 文件是 CRLF、Git 索引是 LF。所称 Bash 故障未复现，见 CAN-220。
- workspace 清零是单独的 scratch 初始化契约，当前规格未承诺每次清零。CAN-228 验收失败后的 tiling 重传，以及复用同一缓冲时的并发调用顺序。

## 复核验证记录

[复核证据](evidence/README.md)

- **本地。** TypeScript 类型检查通过。知识库校验 20 条通过。Python 独立单测 9 通过、1 跳过。runner 诊断 16 通过。Vitest 全量 280 通过、29 失败、8 跳过。失败集中在 Git Bash 被 Windows 沙箱拒绝、回环请求被拒绝、OAuth 端口冲突这三套。排除这三套后，36 套测试为 274 通过、8 跳过。
- **远端。** 使用插件自身 SSH 路径对容器预检，另在宿主机运行同一 runner 对照。容器版本元数据为 CANN 9.2.1，NPU 型号为 Ascend 910B2。完成了临时编译和历史 CSV 回放。本轮未启动新的 NPU 计算或提交验收。
- **留待后续验证。** CAN-202 的环境变量差异是否影响实际算子。CAN-204 两种默认构建路径对同一算子的正确性和性能是否产生可归因的差异。CAN-223 真机日志触及 8 MiB 上限的频率。CAN-218 与本机 harness 的完整安装和运行兼容性。

## 修复后验证

- Vitest 全量 361 项通过、2 项跳过，共 39 套。Windows 环境下独立 Python 测试 13 项通过、2 项跳过，runner 诊断 28 项通过。
- Host 和 Client TypeScript 类型检查、知识库 20 条校验、插件构建与契约新鲜性检查均通过。
- 新构建插件通过已钉扎主机密钥的 SSH 转发完成真实容器预检。容器工具链为 CANN 9.2.1，宿主机直接预检显示另一套工具链。容器原始环境的 SoC 不一致告警已远端复验。
- 当前 runner 从历史 profiler CSV 重放得到 1653.454 µs。提交验证的 8 MiB + 1 字节日志仍保持输出上限，同时保留设备故障分类。
- CAN-204 还需同一算子的真机对照。CAN-220 还需设置卡实际渲染测试。CAN-214 继续由原 CAN-114 跟踪。
