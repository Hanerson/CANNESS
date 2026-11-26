# CANNESS

[English](README.en.md) · [文档索引](docs/README.md) · [更新日志](CHANGELOG.md) · [CI](https://github.com/Hanerson/CANNESS/actions/workflows/ci.yml)

CANNESS 是面向昇腾 CANN 算子开发的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。它把算子规格、四层实现、测试包、远端 NPU 评测和按预算迭代连成一条工作流，并可将符合当前导出契约的算子打包为 CANNBench 提交工程。

## 快速开始

插件包版本为 `0.5.0`。本地需要 Node.js ≥ 24.9、pnpm 11 和 dsh 0.2.x。知识检索、打包、导出和本地预检可以离线运行，模型调用由 dsh 配置决定。真机评测需要可通过 SSH 访问的 Linux 昇腾 NPU 环境，也可通过 CANNLab 隧道连接。

在已安装 dsh 的终端运行：

```bash
git clone https://github.com/Hanerson/CANNESS.git
cd CANNESS
pnpm --dir plugin install --frozen-lockfile
pnpm --dir plugin build

dsh --profile canness-web --from-default-profile web --dump-config
dsh plugin --profile canness-web add "/absolute/path/to/CANNESS/plugin"
dsh --profile canness-web
```

把安装路径换成实际绝对路径。Web 界面打开后，在 **设置 → CANNESS** 配置 SSH 或连接 CANNLab。从仓库根目录启动时可直接使用默认知识库路径。若从其他目录或 dsh 源码运行，按[安装与配置指南](docs/guides/setup.md)配置知识库绝对路径。

可以先在会话中请求「调用 `kb_search` 查询 Exp」，验证插件已加载。测试包生成后，先运行 `preflight_evaluation()` 校验本地包，再按需通过 `preflight_evaluation({ remote: true })` 检查远端工具链。

## 开发工作流

1. **提交规格并查资料。** 用 `submit_spec` 声明输入输出、**目标硬件**与性能目标。目标硬件写 `arch_family`
   或用 910B/A3/950 的短名/部件名；探测到的型号只作为建议，与声明不一致时 `submit_spec` 会先返回比较结果，
   由你确认后再传 `confirm_target: true` 创建 generation。可移植场景显式声明 `mode: "portable"`。
   用 `kb_search` 按算子、关键词、硬件、dtype 和布局获取带来源的知识条目。
2. **生成与打包。** 用 `write_operator` 写入 kernel、host、API 和插件四层，通过 `write_package_file` 填写精度参考 `golden.h`，再用 `build_test_package` 生成可在目标机运行的测试包。需要声明能力边界时用 `spec.support` 写 dtype × 属性矩阵与对齐要求，导出时会生成守卫。
3. **评测与迭代。** `run_evaluation` 通过 SSH 调用远端 runner，编译算子，检查精度并读取真实 `msprof` 采样。连接中断后可在同一工作区重试。达到停机条件时结束迭代，自动续轮只针对本次评测所属会话。目标机上的方言与参数会写进 `dist/build-env.txt`，kernel 打印 `CANNESS_TILING_REPORT` 后报告会给出每 block 的调用预算。
4. **导出与验收。** 用 `export_submission` 生成 CANNBench `direct_launch` 源工程、ZIP 和来源记录（可用 `build_script` 覆盖构建脚本、`target_soc` 选目标微架构）。在目标环境构建 wheel，再用对应版本的官方任务评测器验证；`validate_submission({ cases_file })` 可按官方 cases 逐条回归，`run_evaluation({ submission })` 会把验收并进同一份报告。

dsh 负责模型调用、会话、工具调度和凭据。CANNESS 定义算子契约、工作区、评测与停止规则。远端执行器负责生成编译、精度和性能证据。详见[架构设计](docs/design/05-plugin-architecture.md)和[工具参考](docs/reference/tools.md)。

## 当前验收范围

- **Exp** 已在 NPU 上完成导出包构建、安装与官方 CANNBench `tasks-v2.1.0` 精度评测，20/20 通过。该次运行使用 `--no-perf`，官方性能评分尚待验证。
- **ArgMax** 已在 CANNESS 构建契约下验证 20 组公开规格。官方任务评测及性能分仍是待办，当前 CANNBench 导出器要求各张量形状一致。
- **ApplyRotaryPosEmb** 已在 910B2 上验证 fp16/fp32/bf16 × `layout` 0/1 × `half`/`interleaved` 共 14 组组合、官方 20 条 case 中 18 条逐位/1e-7 级一致；导出包经 `validate_submission` 验收为 `validated`（14/14），官方评测精度通过、kernel 1659 µs。残留 2 条 fp32+interleaved 各有 1 个元素差 1 ulp（近零抵消放大 MARE）。
- **目标硬件** 910B 与 A3（910C）共用 `dav-2201`：同一份导出包在 A3 上用 `bash build.sh --soc=ascend910_93` 可编译出 wheel（已在 910B2 上验证同一方言与参数，A3 真机编译待回归）。
- **远端迭代** 已有 CANNLab 连接恢复和真实 dsh 会话续轮、重复评测去重及停滞停止的验收记录。
- **提交包验收** `validate_submission` 支持多 case（`cases_file`）与设备锁；设备故障与设备不可用分开报告。
- **知识库** 已支持结构化条目和带条件检索。条目按证据逐步补充，编写方法见[知识库填充指南](docs/guides/knowledge-base-authoring.md)。

验收口径和记录见[工单与待办](tickets/TODO.md)。发布版本记录见[更新日志](CHANGELOG.md)。

## 本地开发

在仓库根目录运行：

```bash
cd plugin
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm kb:validate
```

CI 在 Ubuntu 和 Windows 上执行类型检查、测试、构建、知识库校验与远端脚本语法检查。Runner 回归测试使用本地夹具，完整测试还需要 Python、Bash 和可用的 localhost。dsh 加载 `plugin/lib/`，修改插件源码后需重新构建并重载；`build_test_package` 会报告 `staleBuild`，导出与评测在过期构建上直接拒绝。

## 文档

- [安装、profile 与连接配置](docs/guides/setup.md)
- [远端评测与故障定位](docs/guides/remote-evaluation.md)
- [工具与算子规格参考](docs/reference/tools.md)
- [知识库设计](docs/design/06-knowledge-base.md)和[条目编写](docs/guides/knowledge-base-authoring.md)
- [文档索引](docs/README.md)和[历史归档](docs/archive/README.md)

[MIT License](LICENSE)
