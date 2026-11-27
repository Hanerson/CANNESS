# CANNESS 本轮 Issue 复核反馈

复核日期为 2026-11-27，基准为 `main@a86ca2c`。范围为 Grok 提出的 CAN-201 至 CAN-228，共 28 条。原始问题单见 [Grok 评估索引](README.md)。

## 建议处置顺序

1. **先处理 CAN-225、CAN-221 至 CAN-224、CAN-205。** 分别涉及 CANNLab 配置读取、有效迭代计数、提交物验收、设备故障分类、性能采样和评测结果留存。
2. **将 CAN-201 从 P0 降为部署配置和预检识别问题。** 转发路径下插件预检已通过。宿主机直连也会返回 `ready: true`，但进入另一套工具链。验收应核对实际端点和工具链版本。
3. **合并重复条目。** CAN-214 并入已有 CAN-114。CAN-213 的重连内容归入同一处。CAN-203 的临时目录背景关联 CAN-014，新增工作聚焦远端产物回收。CAN-217 与 CAN-220 仅由一个条目跟踪 `--loop`。

## 逐条反馈

- **[CAN-201](CAN-201-ssh-does-not-reach-cann-921.md) · 降级并改写。** 经 `127.0.0.1:20022` 进入容器，插件的自动和显式 `setEnv` 预检均通过，`bisheng` 和 `msprof` 均位于 CANN 9.2.1 下。宿主机直连同样预检通过，其 `bisheng` 位于 `latest/compiler/ccec_compiler/bin/`。原报告中“宿主机缺少 bisheng，预检会失败”应删除。两侧都显示 clang 版本，建议在预检输出中单独报告 CANN 版本、编译器版本和工具链路径，并记录转发配置。
- **[CAN-202](CAN-202-soc-env-disagrees-with-910b2.md) · 保留预检缺口。** 容器中 8 张卡均为 Ascend 910B2，加载环境脚本前后 `SOC_VERSION` 均为 `ascend910b1`。预检报告 `detectedSoc: Ascend910B2` 和 `issues: []`。记录并对照两个值，实际运行影响另行验证。
- **[CAN-203](CAN-203-default-device-inbox-and-gc.md) · 拆分。** 容器实测 `/canness` 为独立挂载，默认 `/tmp/canness-a` 目录不存在，上传逻辑会创建目录。设备覆盖变量未设置，5 份历史性能报告均使用设备 7。保留远端尝试目录缺少回收的问题。路径、选卡和锁放入部署配置。
- **[CAN-204](CAN-204-eval-and-export-dialects-diverge.md) · 保留，限定默认构建。** 默认评测使用 `-x cce`，导出会探测 `-xasc`，评测脚本可经 `repair_package` 替换。同一份带 AIV 类型声明的最小源码在 CANN 9.2.1 上两种方言均编译成功。7 份历史导出均选 `modern/dav-2201`。同一算子的精度、性能和完整构建差异仍待对照。
- **[CAN-205](CAN-205-single-state-file-drops-results.md) · 优先处理。** 换代后旧评测仍返回报告与远端路径，本地状态没有该代结果，旧代预算变化和续轮信号也不会回写。文件直接覆盖写。验收应覆盖旧代报告可追溯、新代续轮不受影响、状态原子写入三个行为。
- **[CAN-206](CAN-206-symbolic-shape-silently-32768.md) · 保留并收窄。** 本地复现 `['B', '4096']` 静默具体化为 32768 个元素。张量各自按元素数分配，共用的是单用例的 shape 和启动几何。默认 golden 是会明确失败的占位。优先处理符号维静默回退，并明确自动导出的形状约束。
- **[CAN-207](CAN-207-hardware-filter-hides-contracts.md) · 保留。** 本地查询指定 `Ascend910B2` 后，Exp、ArgMax、GQA 均为零命中。建议支持硬件别名，并让验证过的通用契约独立可检索。硬件实测条目继续保留原有适用范围。
- **[CAN-208](CAN-208-gelu-formula-contradicts-code.md) · 修正文档。** GELU 文字推导的 tanh 输入多乘了一倍。取 `x=1`，错式约为 0.965585，正确公式与代码片段约为 0.841192。修正中间式并保留历史工具链记录。
- **[CAN-209](CAN-209-three-layers-never-compiled.md) · 保留为覆盖缺口。** 打包要求四层齐全，默认测试包编译 kernel 和通用驱动，导出采用另行生成的封装。以 host、API、plugin 缺少编译验证为验收目标。
- **[CAN-210](CAN-210-cannbench-note-stale.md) · 修正文档。** 旧目录结构与现行导出器不同。65.41 有单独的 910C 历史记载，30 对应较新的 `--no-perf` 交付。分别注明环境、评测模式和证据来源，65.41 的原始结果待补。
- **[CAN-211](CAN-211-provenance-is-self-reported.md) · 拆分并收窄。** 来源声明只做格式校验，产物字节有独立哈希。改写产物与原始来源的哈希允许不同。探针已要求实测通过并通过正确性检查，剩余问题是调用方自由文本和实测字段共享同一证据标签。golden 改动后需重建现已写入工具参考。
- **[CAN-212](CAN-212-ssh-accepts-any-host-key.md) · 保留。** 插件的 SSH 传输未配置主机密钥校验。远端复核时 OpenSSH 使用受信任的容器主机密钥进入。没有证据表明隧道每次重连都会换钥，删除该推断。
- **[CAN-213](CAN-213-settings-card-cannot-express-workflow.md) · 保留设置与确认问题。** 设置卡缺设备和工具链字段，`confirm_target` 由工具调用方提供，缺独立用户确认来源。重连内容归并 CAN-114。
- **[CAN-214](CAN-214-layer-carry-reconnect-reference.md) · 并入 CAN-114。** 属性变化使源码继承失效，工具缺少重连入口，`reference` 未进入预算校准。层继承只宜保留明确不依赖该属性的产物。
- **[CAN-215](CAN-215-roofline-only-original-910.md) · 保留。** 5 份 910B2 历史性能报告的 `analysis.rooflineUs` 均为空且标记为未采集。当前表只覆盖初代 Ascend910。优先显示缺值原因，有对应型号的带宽依据后再补数值。
- **[CAN-216](CAN-216-toolkit-root-hardcodes-921.md) · 保留并收窄。** 目录推导确有 `cann-9.2.1` 特判，主要影响自定义安装前缀和深层环境脚本路径。标准安装的位置已有默认读取根。验收应覆盖不同版本和脚本层级，并检查推导范围。
- **[CAN-217](CAN-217-python-validators-not-in-ci.md) · 保留。** 两份独立 Python 测试未进入 CI。已有诊断覆盖部分非零退出和精度失败。补 CI 接入，并分别添加构建超时、缺可执行文件、缺结果标记和坏 manifest 的断言。
- **[CAN-218](CAN-218-dsh-pin-lags-local-harness.md) · 改为兼容性验证任务。** 本机 dsh 为 `0.2.2-rc.2`，仓库钉扎 `0.2.1-rc.3`。抽查的事件接口仍兼容。立单目标是验证和记录版本组合，当前没有已复现的兼容性故障。
- **[CAN-219](CAN-219-docs-lag-current-tree.md) · 保留文档差异。** 知识索引仍记 16 条，当前校验 20 条。工具参考落后于现行远端读取范围。历史 TODO 的计数应标注适用时间或范围。
- **[CAN-220](CAN-220-hygiene-followups.md) · 保留低优先级。** 三个 N 是一致使用的可配置默认名。现行流程未调用 `--loop`。部分 Python 工作区文件有 CRLF，Git 索引为 LF，未复现所称 Bash 故障。刷新成功已有间接覆盖，仍缺刷新令牌轮换、失败回退与设置卡渲染测试。
- **[CAN-221](CAN-221-device-error-consumes-iteration.md) · 优先修。** 本地确认 `error` 会增加有效迭代，日志压缩也可能滤掉设备故障行。预算规则应区分基础设施故障与候选 kernel 故障，同包重复调用还受去重规则约束。
- **[CAN-222](CAN-222-kernel-pass-ignores-submission.md) · 优先定义提交模式。** 内核报告先写状态，提交验收随后挂到返回值。即使验收失败，当前循环仍可按内核成绩达到 `targetMet`。提交模式应使用包含验收结果的完成条件，纯内核评测保留现有完成语义。
- **[CAN-223](CAN-223-eight-mib-hides-device-fault.md) · 优先修。** 同一故障标记在短日志中被识别，在 8 MiB + 1 字节时只报超限。增加超限与设备故障并存的回归用例，保留日志上限。
- **[CAN-224](CAN-224-msprof-averages-unmatched-rows.md) · 优先修，历史结果需准确表述。** 5 份真实 profiler CSV 每份 24 行，全名均为 `canness_kernel`，与 manifest 的 `ApplyRotaryPosEmb` 零匹配。当前 runner 回放的回退均值与按内核名筛选的均值完全相同，因为采样只有目标内核。合成混合 CSV 则证明，无关的 10 和 50 µs 两行会被平均为 30 µs。验收应覆盖实际内核名匹配，以及零匹配时不会静默把混合任务算作目标耗时。
- **[CAN-225](CAN-225-cannlab-token-ref-dropped.md) · 优先修。** 本地确认钉扎版 Schemastery 的 volatile 字段对象通过 `.get()` 取值，而入口只收原始字符串。令牌引用及同路径处理的其他配置会被丢弃。用真实 Schema 产生的配置对象覆盖回归。
- **[CAN-226](CAN-226-kbroot-and-loop-policy-split.md) · 拆成两条。** 默认知识库路径依赖 cwd，路径不存在可能抛错。设置卡更新 eval 配置，续轮读取 loop 自有配置。分别验收包内路径解析和共享预算策略。
- **[CAN-227](CAN-227-ssh-exit-and-timeout-budget.md) · 拆成两条。** SSH 缺数字退出码时默认为 0，外层 1800 秒也可能先于内部阶段截止。4200 秒仅是三个阶段参数之和，尚未包含构建自检。连接泄漏未证实，提交验收已有独立截止时间。
- **[CAN-228](CAN-228-tiling-cache-commits-before-copy.md) · 保留缓存缺陷。** tiling 缓存在同步及 H2D 成功前提交，失败后重试可能跳过复制。验收应覆盖失败后重传。workspace 清零是单独的 scratch 初始化契约问题，当前规格未承诺每次清零。

## 验证记录与边界

- **本地。** TypeScript 类型检查通过，知识库校验 20 条通过。Python 独立单测 9 通过、1 跳过，runner 诊断 16 通过。Vitest 全量 280 通过、29 失败、8 跳过。失败集中在 Git Bash 被 Windows 沙箱拒绝、回环请求被拒绝和 OAuth 端口冲突相关的三套测试。排除这三套后，36 套测试为 274 通过、8 跳过。
- **远端。** 使用插件自身 SSH 路径对容器预检，另在宿主机运行同一 runner 对照。容器版本元数据为 CANN 9.2.1，NPU 型号为 Ascend 910B2。实际完成了临时编译和历史 CSV 回放，本轮未启动新的 NPU 计算或提交验收。
- **留待后续验证。** CAN-202 的环境变量差异是否影响实际算子。CAN-204 两种构建路径对同一算子的正确性和性能是否产生可归因的差异。CAN-223 真机日志触及上限的频率。CAN-218 与新 harness 的完整安装和运行兼容性。
