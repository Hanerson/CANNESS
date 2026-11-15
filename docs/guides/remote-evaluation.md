# 远端评测与故障定位

远端评测使用 Linux 昇腾 NPU 上的 CANN 工具链。配置直接 SSH 或 CANNLab 隧道的步骤见[安装与配置](setup.md)。

## 开始评测

1. 提交规格、写入算子和自定义 `golden.h`，然后执行 `build_test_package()`。如果改动了已经构建的包，重新打包以更新清单与指纹。
2. 执行 `preflight_evaluation()` 检查当前工作区里的包。需要检查目标机时传入 `remote: true`，查看 `remote.ssh` 和 `remote.cann.ready`。
3. 执行 `run_evaluation()`。插件将包上传到 `<inbox>/<generationId>/`，启动临时 [runner.py](../../plugin/remote/runner.py)，从 `<outbox>/<generationId>/results.json` 读取报告。

上传经 SSH exec 传递 base64 编码的 tar。runner 按次启动。它先运行构建契约的最小编译自检，再用包内 `build.sh` 编译并获取可执行文件路径，调用 `run_once.sh` 解析 `CANNESS_RESULT`。精度通过后用真实 `msprof` 采样。

runner 根据 `setEnv` 或探测结果加载 CANN。设备选择和锁可按[runner 参数](../../plugin/remote/runner.py)与主机配置调整。bundle 远端目录默认位于 `/tmp/canness-a/`，若需跨 CANNLab 重启保留文件，使用控制台确认可持久化的可写路径。

## 阅读结果

- `compile_fail` 表示构建失败，先读 `compile.log`。缺少构建脚本、编译自检失败或找不到构建产出的可执行文件也会落入该类。
- `accuracy_fail` 表示精度未通过。确认 golden 已实现，检查 shape、dtype、属性、边界用例和误差阈值。
- `perf_fail` 表示精度通过，实测时间超过目标。结合 `analysis` 的瓶颈与 AIC/AIV 指标定位成本。
- `pass` 表示完成编译、精度和性能检查。`timeout` 和 `error` 需要查看 `summary`、待执行阶段和可取得的日志。

`kernelTimeUs` 来自 `msprof` CSV。优先使用 `op_summary` 的有效 `Task Duration(us)`，在有对应行时排除热身后求平均；无有效 summary 行时使用 `op_statistic` 的聚合时长。缺少有效时长则报告错误。规格中的性能目标单独保存在 `performance.targetUs`。runner 默认请求 20 次应用迭代，可按用例的运行时间调整，实际次数见 `runRecord.params.runs`。

原始 CSV 由 runner 写在该包下的 `.msprof-*` 输出目录。用 `fetch_remote_file` 拉取已知路径的 CSV 或 `results.json`。报告中的 `workspace`、`packageDir` 和 `resultsPath` 可用于定位当前代。

## 恢复与重测

- 如果结果报告 `pendingStage: "run_evaluation"`，检查 SSH、隧道和 CANN 状态。恢复连接后在同一工作区重试当前包。
- 如果得到 `duplicate: true`，插件返回同一包的已有结果。确认需要新样本后再用 `run_evaluation({ force: true })`。停机仍由[预算策略](../reference/configuration.md#迭代预算与停机)决定。
- 如果 CANNLab 连接失败，从设置卡重连并检查 `last-connect.log`。若选中的环境已停机，连接流程可尝试启动。配额和实例状态以控制台为准。
- 如果 `remote.ssh` 已连接但 CANN 检查失败，查看探测到的环境脚本和工具路径。多套 toolkit 并存时设置 `setEnv`，再执行预检。
- 如果旧工作区的评测没有触发续轮，在目标会话对该任务运行评测以登记归属。用独立工作区隔离并行任务。
