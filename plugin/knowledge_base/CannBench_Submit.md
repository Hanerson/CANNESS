# CANNBench 提交（cannbench.com）

用 CANNESS 的 `export_submission` 生成 CANNBench `direct_launch` 源工程和 ZIP，在目标环境构建并运行对应版本的官方任务评测。

## 平台契约

- 提交物是 **zip**（≤50 MB）；runner 解包后 `bash build.sh` 编译、装 wheel、跑精度+性能。
- 评分规则以任务版本和运行模式为准。`--no-perf` 只报告编译、运行和功能分。
- 编译失败整批 0 分——提交前必须在同架构机器上先跑通 `bash build.sh`。
- 支持的脚手架：`aclnn_launch` / `direct_launch` / `tilelang_cann` / `triton_ascend`。
  CANNESS 自动导出 **direct_launch** 工程，包含算子 kernel、生成的启动代码和 Python 封装。

## 现行 direct_launch 布局

| 工程路径 | 用途 |
|---|---|
| `build.sh` | 选择目标平台和编译参数，构建 wheel |
| `setup.py` | 定义 Python 包和构建入口 |
| `cann_bench/__init__.py` | 导出公开 Python callable |
| `csrc/launch.cpp` | 提供生成的 host launch 和 tiling 对接 |
| `csrc/op_kernel/kernel.cpp` | 算子 kernel 源码 |
| `csrc/canness_tiling.h`、`csrc/canness_tiling_common.h`、`csrc/canness_tiling_host.h` | 构建契约所需的 tiling 头文件 |
| `csrc/<dtype>/canness_tiling.h` | 启用 dtype 变体时生成的 tiling 定义 |
| `provenance.json` | 记录公开签名、目标平台、构建脚本和文件散列 |

导出器以测试包中的 kernel 源码为输入，生成 `csrc/launch.cpp` 和默认的 `cann_bench/__init__.py`。已提供的 host、API 与 plugin 源码随原测试包保存，其散列和来源列入导出工程的 `provenance.json`。详见[导出实现](../src/submission.ts)。

## Exp 评测记录

| 记录 | 环境 | 模式和结果 | 证据 |
|---|---|---|---|
| 2026-11-04 历史记录 | 910C / CANN 9.0.0 | 官方评测 20/20，score 65.41；原始报告未找到，具体参数与计分明细待核实 | [Exp 实践笔记](Exp.md) |
| v0.3.0 交付验收 | CANNLab NPU；同轮发布记录中的闭环环境为 Ascend910 / CANN 9.0.0 | 官方 `tasks-v2.1.0`，`--no-perf`，20/20，score 30（编译 5 + 运行 5 + 功能 20），官方性能分待验证 | [发布记录](../../CHANGELOG.md#030---2026-11-14)与[验收记录](../../tickets/TODO.md#有-cannlab-时一起验收) |

## 提交接口

```text
POST https://cannbench.com/api/submissions   (Bearer <CANNBench Token>)
  file=@x.zip, source=cli, benchmark_slug=official-tasks,
  target_hardware=910c|950pr|950dt, job_tag=..., aggregation_token=<可选>
GET  https://cannbench.com/api/jobs/<id>     # 轮询到终态
```

Token 在站点 Account 页签发（GitCode 登录后，只显示一次），CLI 用
`CANN_BENCH_TOKEN`。`target_hardware` 必须与编译架构一致：910c→`ascend910_93`，
950→`ascend950`。

## 真机验证

```bash
bash build.sh --soc=ascend910_93
bash ~/cann-bench/scripts/run_evaluation.sh --source-dir ~/work/<proj> --operator <Op> --device-id 0
# 只验精度加 --no-perf；报告落在 ~/cann-bench/reports/cann_final_eval_*.json
```

评测仓只拷 `tasks/ scripts/ src/ requirements.txt` 即可，不必 docker。
`run_evaluation.sh` 会自己卸载并重装 `cann_bench`，所以先装 wheel 只为跑本地自检。

## 坑位

1. **CRLF**：Windows checkout 的 `.sh` 到 Linux 会报 `$'\r': command not found`；
   打包/同步时统一转 LF（`sed -i 's/\r$//'`）。
2. **CANN 9.1.0 限制只针对 aclnn 示例**（`aclnn_kernels/contiguous.h`）；
   direct_launch 在 9.0.0 上可跑。
3. **不要按评测仓 requirements 升级 torch**：CANNLab 镜像是 2.7.1，
   评测仓钉 2.10；只跑 direct_launch 不需要升级，升级反而破坏 ABI。
4. 被要求 `aggregation_token` 时，去 Workspace 建/选一个聚合方案再提交。
