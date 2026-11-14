# CANNESS 剩余待办

核对基线为 `main@0ca2069`（v0.3.0）。根据原 `tickets.zip`、合入 `main` 的实现、工单报告和 CI，只保留尚未实现或缺少验收证据的事项。优先级按对日常开发和原事故复验的影响排序。[main CI](https://github.com/Hanerson/CANNESS/actions/runs/43437048089) · [工单报告](reports/)

## 先做

- [x] **Windows 测试自动找到 Git Bash 工具（T-013）**。测试只为 Runner 子进程加入 Git Bash 自带工具目录。PowerShell 原有 PATH 下用 pnpm 11.1.2 和 npm 分别运行全量测试，均为 22 个测试文件、189 项通过。类型检查和构建通过。[Runner 测试](../plugin/tests/eval-runner.test.ts)
- [x] **真实 DSH 会话复验续轮（T-001 / T-002 / T-003）**。在 DSH 0.2.2-rc.2 的 `canness-web` profile 上，用隔离工作区创建两个真实会话。静置 10 分钟零提示。会话 A 通过 CANNLab SSH 得到新的 `perf_fail` 后，由验收脚本经 DSH 事件分派器触发回合结束，A 收到 1 次续轮，B 收到 0 次。同一报告再次触发回合结束没有多发提示。[续轮监听器](../plugin/src/loop.ts)

## 有 CANNLab 时一起验收

- [x] **在 CANNESS 上覆盖 CANNBench ArgMax 的 20 组规格（T-008 / T-009）**。CANNLab 上使用公开用例的 shape、dtype、axis 与值域生成验收输入，用探针算子和独立 CPU 检查验证索引，20 组 `badCount=0`。其中 4 个 BF16 用例以位模式转换绕过 CANN 9.0 的标量 BF16 cast 限制。额外验证了 `keepdim`、并列首位置、NaN / ±Inf，以及拒绝错误下标。[CANNBench 官方基准](https://cannbench.com/benchmarks) · [T-008](reports/T-008-codex.md) · [T-009](reports/T-009-codex.md)
- [x] **用交付版算子跑通官方 CANNBench 流水线（Exp）**。`export_submission` 产出的同 shape 包在 CANNLab 上构建为 wheel（`cann_bench-1.0.0-py3-none-linux_aarch64.whl`，49,438 B）、安装、导入，官方 tasks-v2.1.0 Exp 精度评测 **20/20 通过**（`pass_rate 1.0`，score 30；编译 5 + 运行 5 + 功能 20），本轮 `--no-perf`。证据见本机验收工作区 `canness-workspace/reports/exp-official-1794665147286/official.json` 与 `canness-workspace/submissions/gen-afaaa563-ON19IJ/cannbench.zip`（该工作区被 Git 忽略，仅保留在本机）。
- [ ] **用交付版 ArgMax 跑官方 CANNBench 评测（含性能分）**。ArgMax 的**契约级**验证已有 20 组真机 `badCount=0`（上一条），但官方评测器尚未跑过 ArgMax，性能分也仍未采集（Exp 那一轮是 `--no-perf`）。
- [x] **采集一次非零 AIV 指标（T-007）**。CANN 9.0 把 Add 标为 `AI_CORE`，原始 CSV 的 AIC 指标全零，AIV 指标非零。修复后重放 20 条有效采样，AIV Scalar 平均 `0.954`，MTE2 平均 `0.05265`，归类 `scalar`。原始 CSV 保存在本地验收工作区。[T-007](reports/T-007-codex.md)
- [x] **完成慢算子同机耗时对照（T-010）**。Add 核函数真机耗时约 111.879 ms，Runner 基于 111.937 ms 的实测启动耗时把 20 次请求降到 1 次，得到 1 条有效采样，端到端耗时 21.521 s。同机同用例的单次采样基线（构建、精度、profile）为 18.376 s，比值约 1.17，低于 1.5。单独比较 profiler，1 次耗时 9.019 s，20 次耗时 12.028 s，两次各输出一行精度结果。[T-010](reports/T-010-codex.md)
- [x] **真实去重和连续停滞（T-004 / T-005）**。通过 DSH 强制重测三次，真机耗时依次为 226.410、226.349、226.270 µs。重复调用返回 `duplicate: true`，远端 inbox 和 `results.json` 的 mtime、ctime 均不变，有效迭代保持 3。下一次强制调用返回 `stopped: stalled`，并给出目标差距和后续选项。[T-004](reports/T-004-codex.md) · [T-005](reports/T-005-codex.md)

## 收尾

- [x] **让旧工作区的任务归属易于排查（T-001）**。每次加载插件后，未认领的旧评测任务只在日志中提示一次，要求在目标会话重新运行 `run_evaluation`。双会话集成测试覆盖提示一次、旧任务不续轮和认领后正常续轮。[循环监听器](../plugin/src/loop.ts)

## 核对记录

已移出待办的原工单包括 T-000 的构建基线、T-006 的环境探测、T-011 的重复符号、T-012 的构建契约自检，以及 T-014 的文档和知识库。其余工单仅保留上面列出的缺口。T-011 的头文件拆分和 T-012 的远端自检均为原工单允许的实现方案，已有真机验收记录。

新一轮真机验收同时修复了 CANN 9.0 主机声明需要 `[aicore]`、纯整数 Golden 被要求定义浮点评估函数，以及 Runner 把零误差容限误读为默认容限的问题。验收脚本、原始 CSV 和会话记录保存在被 Git 忽略的 `canness-workspace/.canness/acceptance/`。

v0.3.0 起官方评测流水线已跑通（Exp，20/20 精度，`--no-perf`），因此上面「官方评测」一项拆成两行：流水线验证已完成，ArgMax 的官方精度 + 性能分仍待跑。
