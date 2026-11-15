# 工具与算子规格参考

工具由 dsh 会话调用。下面列出当前接口，详细返回字段以[生成工具](../../plugin/src/generator.ts)、[评测工具](../../plugin/src/eval.ts)和[知识检索工具](../../plugin/src/knowledge.ts)的 schema 为准。

## 知识检索

`kb_search` 至少接收 `operator_name` 或 `query`，可加 `hardware`、`dtype`、`layout`、`cann_version`、`kind` 和 `limit`。只传算子名返回兼容文本，其他合法调用返回含来源与证据的结构化命中。完整 [kb_search 契约](../design/06-knowledge-base.md)。

## 生成、打包与导出

- `submit_spec({ spec, reset? })` 校验算子规格并创建 generation。同名算子默认沿用预算，显式 `reset: true` 可重新计数。输出含 `generationId`、绝对工作区路径及预算沿用信息。
- `write_operator({ kernel, host, api, plugin, provenance? })` 将当前 generation 的四层源码写到 `op_kernel/kernel.cpp`、`op_host/host.cpp`、`op_api/api.cpp` 和 `op_plugin/plugin.py`。`provenance` 按层记录 `generated`、`adapted_from` 或 `copied_from`；后两者需要 `source`，可带 `sha256`。
- `write_package_file({ path: "golden.h", content })` 设置完整的精度参考，只接受 `golden.h`。它会更新生成目录以及已存在的包副本。之后运行 `build_test_package` 刷新包指纹。
- `build_test_package()` 渲染构建契约 v1，生成四层源码、`build.sh`、`run_once.sh`、`main.cpp`、`golden.h`、三个 tiling 头文件、`config.json` 和 `manifest.json`。manifest 记录文件清单、版本指纹、包指纹与来源信息。
- `export_submission({ callable? })` 按当前代的已构建测试包生成 CANNBench 源码与 ZIP。返回 `sourceDir`、`archivePath`、`packageDir`、`callable` 和 `signature`。

### 算子规格

以下是 `submit_spec` 的 `spec` 示例。用时是目标值。

```json
{
  "operator_name": "Exp",
  "operator_type": "elementwise",
  "input_specs": [{"name": "x", "shape": ["4096"], "dtype": "float16"}],
  "output_specs": [{"name": "y", "shape": ["4096"], "dtype": "float16"}],
  "target_platform": {"chip": "910B", "soc_version": "Ascend910B1"},
  "performance_target": {"metric": "kernel_time", "target_us": 50}
}
```

- 算子名、类型、非空输入输出数组、目标芯片、`kernel_time` 和正数 `target_us` 为必填。每个张量需有 `name`、字符串数组 `shape` 和 `dtype`。实际打包时用可运行的用例形状与受支持的 dtype。
- 可选的 `tiling_hints`、`target_platform.cann_version` 和 `performance_target.reference` 用于补充规格上下文。
- `launch.block_dim`、`launch.tile_length`（元素数）和 `launch.workspace_bytes` 可指定启动参数。kernel 通过 `GET_TILING_DATA(t, tiling)` 读取 tiling，使用 `CannessAttrs(tiling, t.workspaceSize)` 读取运行时属性。
- `attrs` 支持有限数值、布尔值及字符串，供 kernel 和 golden 使用。`attrs_derived` 目前支持将已声明的数值属性按 `log_positive_or_one` 在 host 侧变换。
- `accuracy.absThreshold` 和 `accuracy.relThreshold` 可覆盖浮点容差。`input_specs[i].input_values` 可注入边界值，包括 `"nan"`、`"+inf"`、`"-inf"`。
- `interface.defaults` 声明导出 callable 的属性默认值。`interface.dtypes` 用于输入输出 dtype 一致的多 dtype 导出，变体必须包含当前测试 dtype。

### 构建 ABI 与精度

kernel 入口固定为 `extern "C" __global__ __aicore__ void canness_kernel(...)`。参数依次为所有输入、所有输出、tiling，每项类型为 `GM_ADDR`。工作缓冲由 tiling 契约承载。导出工程使用生成的直接启动 wrapper。

默认包中的占位 golden 会产生 `accuracy_fail`。浮点输出按元素使用绝对或相对误差阈值，参考值为零时用绝对误差。整数输出按原始整数值精确比较。若规格允许多个合法下标，可使用 `accuracyMode: "index-check"` 实现 `verify_index`；如果接口要求并列时取首个下标，golden 必须覆盖此规则。模板和 `GoldenCtx` 的定义见 [golden.h](../../plugin/templates/build-contract/golden.h)和[测试主程序](../../plugin/templates/build-contract/main.cpp)。

### CANNBench 交付

自动导出要求所有输入和输出张量形状一致。会改变形状的算子需要任务专用的导出或封装实现。用 `callable` 匹配官方 Python 入口，并将公开签名和 dtype 与任务规格核对。导出使用 Windows 的 `tar.exe` 或 Unix 的 `zip`。

把导出的工程送到目标 Linux NPU 环境，加载对应 CANN 工具链，在源码目录运行 `bash build.sh` 生成 `dist/cann_bench*.whl`。用匹配的 Python、PyTorch 和 torch-npu 环境安装，再执行对应版本的任务评测。导出工程包含 `provenance.json`，记录实际文件的 SHA-256 与算子来源声明。平台和提交步骤见 [CANNBench 提交笔记](../../plugin/knowledge_base/CannBench_Submit.md)。

## 预检、评测与诊断

- `preflight_evaluation({ remote? })` 本地检查包、指纹和 golden 状态；`remote: true` 另外探测 SSH 及 CANN 工具链。预检无需编译，也不消耗评测轮数。
- `run_evaluation({ force? })` 上传并评测当前包，返回编译、精度、性能、诊断和路径。相同包已有报告时可能返回 `duplicate: true`。`force: true` 要求重新测量，仍受停止规则约束。
- `fetch_remote_file({ remotePath, localPath? })` 下载远端诊断文件。`remotePath` 必须为绝对路径，限配置的 outbox 和当前 generation 的 inbox。`localPath` 相对于工作区，默认 `remote-files/<basename>`。

报告字段、远端目录和断点恢复见[远端评测指南](../guides/remote-evaluation.md)。
