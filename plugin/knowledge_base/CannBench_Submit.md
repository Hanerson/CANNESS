# CANNBench 提交（cannbench.com）

把 CANNESS 生成的四层算子提交到 CANN Bench 打榜的完整路径。2026-11-04 用 Exp 实测通过
（910C，20/20，score 65.41）。

## 平台契约

- 提交物是 **zip**（≤50 MB）；runner 解包后 `bash build.sh` 编译、装 wheel、跑精度+性能。
- 评分：编译 0.2 + 精度 0.3 + 性能 0.5；性能是 HAP（对 baseline 与 `t_hw_us` 锚定）。
- 编译失败整批 0 分——提交前必须在同架构机器上先跑通 `bash build.sh`。
- 支持的脚手架：`aclnn_launch` / `direct_launch` / `tilelang_cann` / `triton_ascend`。
  CANNESS 的四层最贴近 **direct_launch**（kernel + host tiling + plugin + python）。

## 四层 → direct_launch 映射

| CANNESS | 工程内 |
|---|---|
| `op_kernel/kernel.cpp` | `csrc/ops/<op>/op_kernel/<op>_kernel.cpp` |
| `op_host/host.cpp` | `csrc/ops/<op>/op_kernel/<op>_host.cpp` |
| `op_api/api.cpp` | `csrc/ops/<op>/op_plugin/<op>_plugin.cpp` |
| `op_plugin/plugin.py` | `cann_bench/__init__.py` |

`op_host`/`op_kernel` 走 bisheng（`-xasc`），`op_api`/plugin 走 g++；tiling 定义在
bisheng TU、被 g++ TU 调 `std::tuple` 返回值是可行的（官方 add 示例同样做法）。

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
