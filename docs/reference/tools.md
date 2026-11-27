# 工具与算子规格参考

工具由 dsh 会话调用。下面列出当前接口，详细返回字段以[生成工具](../../plugin/src/generator.ts)、[评测工具](../../plugin/src/eval.ts)和[知识检索工具](../../plugin/src/knowledge.ts)的 schema 为准。

## 知识检索

`kb_search` 至少接收 `operator_name` 或 `query`，可加 `hardware`、`dtype`、`layout`、`cann_version`、`kind` 和 `limit`。只传算子名返回兼容文本，其他合法调用返回含来源与证据的结构化命中。完整 [kb_search 契约](../design/06-knowledge-base.md)。

## 生成、打包与导出

- `submit_spec({ spec, reset?, detected_soc?, confirm_target? })` 校验算子规格并创建 generation。同名算子默认沿用预算，显式 `reset: true` 可重新计数。将远端预检返回的型号作为 `detected_soc`。型号与声明不同，或首次声明可移植目标时，先返回 `requiresConfirmation`、`detected` 和 `declared`。请用户确认目标后传 `confirm_target: true`，再创建 generation。确认会随规格保存在工作区状态及包配置中。
  - 迁移提示：`target_platform` 现在必须可解析。写 `arch_family`（`ascend910b`/`ascend910_93`/`ascend950`），或用 910B/A3/950 的短名与部件名（`Ascend910B2`、`Ascend910_9362`、`Ascend950PR_9579`）；其它型号（310P、910A 等）请显式声明 `mode: "portable"`，否则 `submit_spec` 与 `export_submission` 都会拒绝。
- `write_operator({ kernel, host, api, plugin, provenance? })` 将当前 generation 的四层源码写到 `op_kernel/kernel.cpp`、`op_host/host.cpp`、`op_api/api.cpp` 和 `op_plugin/plugin.py`。`provenance` 按层记录 `generated`、`adapted_from` 或 `copied_from`；后两者需要 `source`，可带 `sha256`。
- `write_package_file({ path: "golden.h", content })` 设置完整的精度参考，只接受 `golden.h`。它会更新生成目录以及已存在的包副本。之后运行 `build_test_package` 刷新包指纹。
- `build_test_package()` 渲染构建契约 v1，生成四层源码、`build.sh`、`run_once.sh`、`main.cpp`、`golden.h`、三个 tiling 头文件、`config.json` 和 `manifest.json`。manifest 记录文件清单、版本指纹、包指纹与来源信息。生成的 `.sh` 脚本一律为 LF；若模板仍带 CR，构建会拒绝写包。
- `repair_package({ drop?, write? })` 对**已构建**的包做受支持的后处理：`drop` 删除包内文件或目录，`write` 创建或替换文本文件（内容归一为 LF）。它会重签 manifest 和工作区包指纹。路径必须留在包内，`manifest.json` 由工具重写。再次运行 `build_test_package` 会从源码重建。通过此工具修改 `build.sh` 会更新评测包的构建。CANNBench 导出脚本由 `export_submission` 的 `build_script` 参数覆盖。
- `export_submission({ callable?, wrapper?, signature?, target_soc?, build_script? })` 按当前代的已构建测试包生成 CANNBench 源码与 ZIP。用 `build_script` 提供完整的导出构建脚本。返回导出路径、公开签名、目标平台及构建指纹。
  - 过期构建会被拒绝：若插件源码比 `lib/` 新，`export_submission` 与 `run_evaluation` 直接报 `staleBuild` 并提示在插件目录运行 `pnpm build`。这是为了不让"新模板 + 旧代码"以 `unbound CANNBench template token` 的形式失败。
  - 自定义 wrapper 的 `interface.attrs` 必须是公开签名的参数名；仅在 wrapper 内部使用的参数（例如由 `rotaryMode` 转成数值 `mode`）要写进 `support.wrapper_attrs`，否则导出报错，避免能力矩阵的行永远匹配不上。

### 算子规格

以下是 `submit_spec` 的 `spec` 示例。用时是目标值。

```json
{
  "operator_name": "Exp",
  "operator_type": "elementwise",
  "input_specs": [{"name": "x", "shape": ["4096"], "dtype": "float16"}],
  "output_specs": [{"name": "y", "shape": ["4096"], "dtype": "float16"}],
  "target_platform": {"chip": "910B", "arch_family": "ascend910b", "soc_version": "Ascend910B1"},
  "performance_target": {"metric": "kernel_time", "target_us": 50}
}
```

- 算子名、类型、非空输入输出数组、目标芯片、`kernel_time` 和正数 `target_us` 为必填。每个张量需有 `name`、字符串数组 `shape` 和 `dtype`。实际打包时用可运行的用例形状与受支持的 dtype。
- 可选的 `tiling_hints`、`target_platform.cann_version` 和 `performance_target.reference` 用于补充规格上下文。
- 目标硬件可用 `arch_family` 与部件名 `soc_version` 明确声明。保留已有的 `chip: "Ascend910B2"` 等明确写法。`mode: "portable"` 让同一 generation 按 `target_soc` 导出到多个微架构。可用 `chip` 或 `soc_version` 指定可移植 generation 的本地评测硬件。默认固定模式只允许兼容微架构的导出目标。910B 与 A3 都映射到 `dav-2201`，950 映射到 `dav-3510`。
- `launch.block_dim`、`launch.tile_length`（元素数）和 `launch.workspace_bytes` 可指定启动参数。kernel 通过 `GET_TILING_DATA(t, tiling)` 读取 tiling，使用 `CannessAttrs(tiling, t.workspaceSize)` 读取运行时属性。
- `attrs` 支持有限数值、布尔值及字符串，供 kernel 和 golden 使用。`attrs_derived` 目前支持将已声明的数值属性按 `log_positive_or_one` 在 host 侧变换。
- `accuracy.absThreshold` 和 `accuracy.relThreshold` 可覆盖浮点容差。`input_specs[i].input_values` 可注入边界值，包括 `"nan"`、`"+inf"`、`"-inf"`。
- `interface.defaults` 声明导出 callable 的属性默认值。`interface.dtypes` 用于输入输出 dtype 一致的多 dtype 导出，变体必须包含当前测试 dtype。
- `support.configurations` 声明可调用组合，例如 `[{"dtype":"float16","attrs":{"layout":0,"rotaryMode":"half"}}]`。每行的 dtype 和属性需同时匹配，匹配任一行即可。`support.min_align_bytes` 约束所有输入地址的对齐。`support.wrapper_attrs` 声明自定义 wrapper 额外公开的参数，例如由 wrapper 转换为内部数值的 `rotaryMode`。导出后的 callable 会在分配或启动前抛出 `UnsupportedConfiguration`。

### 构建 ABI 与精度

kernel 入口固定为 `extern "C" __global__ __aicore__ void canness_kernel(...)`。参数依次为所有输入、所有输出、tiling，每项类型为 `GM_ADDR`。工作缓冲由 tiling 契约承载。导出工程使用生成的直接启动 wrapper。

默认包中的占位 golden 会产生 `accuracy_fail`。浮点输出按元素使用绝对或相对误差阈值，参考值为零时用绝对误差。整数输出按原始整数值精确比较。若规格允许多个合法下标，可使用 `accuracyMode: "index-check"` 实现 `verify_index`；如果接口要求并列时取首个下标，golden 必须覆盖此规则。模板和 `GoldenCtx` 的定义见 [golden.h](../../plugin/templates/build-contract/golden.h)和[测试主程序](../../plugin/templates/build-contract/main.cpp)。

### CANNBench 交付

自动导出要求所有输入和输出张量形状一致。会改变形状的算子需要任务专用的导出或封装实现。用 `callable` 匹配官方 Python 入口，并将公开签名和 dtype 与任务规格核对。导出使用 Windows 的 `tar.exe` 或 Unix 的 `zip`。

把导出的工程送到目标 Linux NPU 环境，加载对应 CANN 工具链，在源码目录运行 `bash build.sh --soc=ascend910_93`（以 A3 为例）生成 `dist/cann_bench*.whl`。用匹配的 Python、PyTorch 和 torch-npu 环境安装，再执行对应版本的任务评测。导出工程包含 `provenance.json`，记录文件与构建脚本的 SHA-256、使用的模板指纹、目标平台和算子来源声明。默认脚本在构建日志中打印实际选择的编译器参数。平台和提交步骤见 [CANNBench 提交笔记](../../plugin/knowledge_base/CannBench_Submit.md)。

## 预检、评测与诊断

- `preflight_evaluation({ remote?, submission_source_dir? })` 检查本地包、指纹和 golden。传入导出目录可读取该提交包选定的目标，`remote: true` 会与探测到的 NPU 架构比较。预检无需编译，也不消耗评测轮数。
- `run_evaluation({ force?, compile_only? })` 上传并评测当前包，返回编译、精度、性能、诊断和路径。相同包已有报告时可能返回 `duplicate: true`。`force: true` 要求重新测量，仍受停止规则约束。`compile_only: true` 只做编译诊断：不消耗评测轮数、不使用精度/性能结果，也不做包哈希门禁（便于在修包前直接试编译）。
- 评测以 `manifest.packageHash` 为唯一放行依据；`.canness/state.json` 里的 `packageHash` 只是上次评测的缓存，不再参与判定。哈希不符时错误会同时给出 manifest、state 与实际值。
- `fetch_remote_file({ remotePath, localPath? })` 下载远端诊断文件。`remotePath` 必须为绝对路径，限配置的 outbox 和当前 generation 的 inbox。`localPath` 相对于工作区，默认 `remote-files/<basename>`。

报告字段、远端目录和断点恢复见[远端评测指南](../guides/remote-evaluation.md)。

### 提交包验收

- `validate_submission({ source_dir, test_script?, cases_file?, case_timeout_sec? })` 验证导出源码的哈希，在目标机生成 wheel 并安装到隔离虚拟环境。返回 `stages`，分别报告构建、安装、公开接口调用和精度比对。缺少比较脚本时，报告保留精度未验证状态。
- `test_script` 是完整的 Python 源码。它需要调用安装后的 `cann_bench` 公开接口、在需要时同步设备、和独立参考比对，并输出一条 `CANNESS_VALIDATION {"ok":true,"mere":0.0,"mare":0.0}`。`mere` 和 `mare` 可省略。
- 传入工作区中的官方 `cases_file` 时，CSV 必须有 `case_id` 列。验证工具为每个受支持的用例启动独立进程。比较脚本从 `json.loads(os.environ["CANNESS_CASE_JSON"])` 读取当前行，包含 `input_shape`、`dtype`、`attrs`、`value_range` 等字段。报告列出各例结果、跳过的组合和覆盖数。
- 在 `run_evaluation({ submission: { source_dir, test_script?, cases_file? } })` 中传入同一 generation 和包哈希的导出目录，可在 kernel 精度通过后把验收结果附到 `submission`。验收阶段不额外计入性能预算，也可单独重跑。
  - `run_evaluation` 默认就做这件事：不传 `submission` 时，它自动挑出同一 generation、同一包哈希的最新导出，跑一次构建 + 安装 + 公开接口调用，结果附到 `submission` 并带 `auto: true`。`compile_only` 不触发验收。
- 导出前会按 CANNBENCH 评分规则自检：`aclrtmemcpy-budget`（每个 API 名的 host 拷贝不超过一次且位于属性缓存之后）、`aclrtmemcpy-ordering`（拷贝前需 `aclrtSynchronizeDevice`）、`tiling-lifetime`（wrapper 不得在 callable 内分配 tiling）、`utf8`（源文件必须是合法 UTF-8）。违反时导出直接失败，并给出规则 id 以便回溯知识库条目。
- 导出前还会用 `ast.parse` 校验 wrapper：必须恰好一个模块级同步函数、参数与声明的公开签名一致；无解释器时退化为结构检查并在结果里标注 `wrapperCheck.mode = "syntax-only"`。

### 独立 NPU 探针

`probe_run({ kernel, golden, spec?, record? })` 在临时目录构建探针并运行精度比对。省略 `spec` 时沿用当前规格。报告给出 kernel 与 golden 的 SHA-256 及远端结果路径。探针跳过性能采样，不修改当前 generation 或预算。传入 `record: { title, conclusion }` 时，通过的探针可存为工作区知识条目，通过 `kb_search({ query, include_probes: true })` 检索。
