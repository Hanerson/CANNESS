# 远端 NPU Runner（真实评测）

适用于「本地 Windows / 无 CANN，远端只有 SSH + NPU + CANN 工具链」的评测方式。

**本插件只在远端编译。** 本地 Windows 没有 CANN，`run_evaluation` 从不调用本地编译器；它把测试包用 SSH `exec` + base64 tar 送到远端，再由 `remote/runner.py` 依次执行 `build.sh`、`run_once.sh`、`msprof`，最后读回 `results.json`。

## 1. 目录布局

```
/tmp/canness-a/                     # A 的远端根目录（与 B 的 /tmp/canness-b 隔离）
├── inbox/<generationId>/attempt-<id>/<generationId>/  # 本次评测的测试包
│   ├── op_kernel/kernel.cpp
│   ├── op_host/host.cpp
│   ├── op_api/api.cpp
│   ├── op_plugin/plugin.py
│   ├── build.sh                    # 模板渲染：编译 + 链接，最后一行 stdout 是 exe
│   ├── run_once.sh                 # 模板渲染：跑 1 次，输出 CANNESS_RESULT
│   ├── main.cpp                    # 模板渲染：ACL 主机骨架
│   ├── golden.h                    # 占位或模型填写的精度参考
│   ├── canness_tiling.h            # 通用 CannessTilingData + GET_TILING_DATA shim
│   ├── config.json                 # 按 dtype 推导的 maxAbsErr 与 tiling 参数
│   └── manifest.json
├── outbox/<generationId>/attempt-<id>/<generationId>/results.json
├── runner-<uuid>.py                # 每次评测临时上传，结束后删除
└── .canness-upload-<uuid>.b64      # 上传用的 base64 tar，解包后删除
```

- 每次正式评测都有独立的输入和报告目录。用 `run_evaluation` 返回的 `resultsPath` 下载报告。
- `7` 是 runner 的默认设备编号，实际映射取决于部署。可用 `CANNESS_ASCEND_VISIBLE_DEVICES` 或 `--device` 设置；运行和采样在有 `flock` 时共享配置的锁。
- 登录信息只放在本地配置 / 凭据存储，**不得写入仓库**。

## 2. 测试包契约（v1）

包根目录必须包含（`build_test_package` 自动渲染，模型不需要逐算子重写）：

| 文件 | 约定 |
|---|---|
| `manifest.json` | 根级；runner 只依赖 `generationId` / `operatorName` / `performanceTargetUs`，可增量加字段；`files` 是实际落盘清单，`layers` 是四层 |
| `build.sh` | LF；渲染时写入 `soc_version` 与 bisheng 参数；成功时**最后一行 stdout** 打印可执行文件绝对路径；失败非 0 退出 |
| `run_once.sh` | LF；跑 1 次正确性，stdout 打印一行 `CANNESS_RESULT {...}`；`badCount==0` 时 exit 0 |
| `main.cpp` | LF；ACL 骨架：按 spec 的输入/输出个数与 dtype 分配、填充、launch、`aclrtSynchronizeDevice`、误差统计 |
| `golden.h` | 模型唯一可写的包内文件（`write_package_file` 白名单）；模板先给占位实现 |
| `canness_tiling.h` | 通用 `CannessTilingData { totalLength, blockLength, tileLength }` + `GET_TILING_DATA`；`GET_TILING_DATA` 带 `#ifndef` 守卫，kernel 自带的 shim 不会被覆盖 |
| `config.json` | `maxAbsErr` 按 dtype 推导；`params` 保存 blockDim / tileSize / blockLength / totalElements，`launch` 保存生效配置，`requestedLaunch` 保存 spec 显式指定的覆盖项 |

**kernel 入口约定**：`op_kernel/kernel.cpp` 必须导出固定符号
`extern "C" __global__ __aicore__ void canness_kernel(...)`，参数顺序为
**全部输入 → 全部输出 → tiling**（均为 `GM_ADDR`）。`main.cpp` 只按这个约定 launch。

`CANNESS_RESULT` 的 JSON 至少包含：

```json
{"maxAbsErr":0.0009,"maxRelErr":0.00002,"badCount":0,"total":32768,"golden":"custom"}
```

`golden` 为 `placeholder` 时（或 `badCount < 0`），runner 判 `accuracy_fail`，摘要固定为
`golden not implemented: fill golden.h in the package, then re-run build_test_package and run_evaluation`，
`maxRelativeError` 保留原始数值，`runRecord.params.golden` 记录来源。

当前构建契约以 `config.json` 配置逐元素精度检查。浮点元素满足绝对或相对误差阈值即可，整数比较保持精确。旧包使用包内 `maxAbsErr` 阈值，缺省 `1e-3`。构建失败常见于：

- 缺 `build.sh` 或 `run_once.sh` → `compile_fail`，摘要固定为
  `package does not implement build contract v1`。
- `build.sh` 未打印可执行文件路径 / 打印的路径不存在 → `compile_fail`。

### 实际 tiling 与 Level-2 调用预算（可选）

通过 `repair_package` 自定义正确性驱动时，可在一次正确性检查的 stdout 中额外打印一行。下例对应 `block_dim: 2`：

```text
CANNESS_TILING_REPORT {"geometry":{"runRows":3,"cosWindowElements":384},"kernelBudget":{"elementBasis":"query elements","blocks":[{"blockIndex":0,"level2Calls":3,"elements":14,"callElements":30},{"blockIndex":1,"level2Calls":1,"elements":2,"callElements":2}]}}
```

- 报告描述一个 kernel launch。若驱动执行多次 launch，只为一个代表性 launch 输出一次该行。可以单独提供 `geometry` 或 `kernelBudget`。
- `geometry` 保存由实际 tiling 和 `CannessAttrs` 推导出的参数。允许 1–32 个数值键，每个键以英文字母开头，最多 48 个英文字母、数字或下划线。
- `blocks` 按 block ID 提供完整计数，包含尾块和空闲块。`elements` 是 `elementBasis` 指定的当前 block 工作元素数，`callElements` 逐次累加每个 Level-2 调用处理的元素数。每次调用的逻辑处理长度只计一次，避免把同一次二元调用的两个操作数重复计入。重复处理同一批元素的多次调用分别计入。`elementBasis` 最多 96 个可打印字符。
- 示例的 `perElementCalls` 为 `4/16 = 0.25`，`averageElementsPerCall` 为 `32/4 = 8`。runner 先跨 block 求和再做除法。分母为零时返回 `null`。
- 正确性通过后，runner 写入 `runRecord.params.tiling` 和 `runRecord.params.kernelBudget`。有性能分析时也写入 `analysis.kernelBudget`，来源为 `correctness-stdout`。重复、超过 16 KiB、格式错误或计数不完整的行会被忽略。`runRecord.params.launch` 单独记录 `config.json` 中的启动配置。

#### 在 kernel 里上报（模板没有默认注入）

模板不会替你计数，得自己加。最省事的方式是在 `Process()` 里用一个 compile-time 计数器包住每个 Level-2 调用，最后按 block 打印一次：

```cpp
// op_kernel/kernel.cpp
namespace {
__aicore__ inline int32_t BlockIndex()
{
    return static_cast<int32_t>(AscendC::GetBlockIdx());
}

// 每次 Level-2 调用加一次：把元素数记进 callElements
constexpr int32_t kLevel2CallsPerRow = 8;

__aicore__ inline void ReportBudget(int32_t rows, int64_t elements)
{
    if (BlockIndex() != 0) { return; }   // 只在 0 号 block 打印一个代表性 launch
    AscendC::PRINTF("CANNESS_TILING_REPORT {\"geometry\":{\"tileRows\":%d},"
                    "\"kernelBudget\":{\"elementBasis\":\"query elements\","
                    "\"blocks\":[{\"blockIndex\":0,\"level2Calls\":%d,\"elements\":%lld,"
                    "\"callElements\":%lld}]}}\n",
                    rows, rows * kLevel2CallsPerRow, static_cast<long long>(elements),
                    static_cast<long long>(elements) * kLevel2CallsPerRow);
}
}
```

- 多 block 时要为每个 block 各输出一条 `blocks` 项（`blockIndex` 必须从 0 连续），否则整行被忽略——尾块与空闲块也要包含。
- `elements` 用固定口径（上例是 query 元素数）；`callElements` 逐次累加每次调用实际处理的元素数，同一次二元调用只计一次长度。
- 该行只用于诊断，不影响精度与性能判定；不需要时不要打印。

## 3. runner 的调用方式

`run_evaluation` 内部等价于：

```bash
PY=$(command -v python3 || command -v python)
timeout --kill-after=10s 1800s "$PY" /tmp/canness-a/runner-<uuid>.py \
  --inbox  /tmp/canness-a/inbox/<generationId>/attempt-<id> \
  --outbox /tmp/canness-a/outbox/<generationId>/attempt-<id> \
  --generation <generationId> \
  --once
```

手工复现时也可以直接跑上面的命令。主要参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--runs` | `20` | 请求的应用迭代次数，慢用例可缩减，实际次数见 `runRecord.params.runs` |
| `--device` | `CANNESS_ASCEND_VISIBLE_DEVICES` 或 `7` | 导出为 `ASCEND_VISIBLE_DEVICES` |
| `--lock` | `CANNESS_DAVINCI_LOCK` 或 `/tmp/canness/davinci<device>.lock` | `run_once.sh` 与 `msprof` 的 flock 文件；空字符串关闭；设备列表沿用默认的 `davinci7.lock` |
| `--set-env` | 环境变量或自动探测 | 指定 CANN `set_env.sh`，对应评测插件的 `setEnv` |
| `--msprof` | `msprof` | 可换成绝对路径 |
| `--bash` | `bash` | 跑包内脚本的 shell（Windows 本地做 fixture 测试时用绝对路径指向 Git Bash） |
| `--accuracy-only` | 关闭 | 执行编译和正确性检查，跳过 profiling。与 `--compile-only` 互斥。 |

## 4. 运行环境（i10 的隐性步骤）

```bash
source /usr/local/Ascend/ascend-toolkit/set_env.sh
export ASCEND_VISIBLE_DEVICES=7     # 容器只映射了 /dev/davinci7 时必须
```

- **不要**手动把 CANN 的 `lib64` 放到 `LD_LIBRARY_PATH` 最前面，会让 `npu-smi` 报
  `undefined symbol: dms_get_util_from_udis`；以 `set_env.sh` 给出的顺序为准，runner 不会重排。
- tiling 必须放 device 内存（`main.cpp` 用 `aclrtMalloc` + `aclrtMemcpy` 分配并传入）。
- 同步用 `aclrtSynchronizeDevice()`，不是 `aclrtSynchronizeStream()`。
- `aclInit` 报 `chipType=0 does not support get device msg feature` 通常是设备没映射，不是 CANN 版本问题。
- 已验证的编译参数固化在构建契约模板 `templates/build-contract/build.sh`（runner 只调用包内脚本，不拼命令）：
  `bisheng -x cce -std=c++17 --cce-soc-version=<spec.soc_version> --cce-soc-core-type=VecCore`，
  链接 `-lascendcl -lruntime`。

## 5. 上传 / 下载：不依赖 SFTP

评测机常常没有 `sftp-server`：

```text
Received exit code 127 while establishing SFTP session
```

因此默认传输通道是 `ssh exec` + base64：

1. 本地用**纯 JS** 生成 POSIX tar（不调用外部 `tar` 进程；沙箱会 `spawnSync tar EPERM`）。
2. 分块 `printf '%s' '<base64>' >> <uuid>.b64`。
3. 远端 `base64 -d < <uuid>.b64 | tar -xf - -C <本次上传目录>`。
4. 下载反过来：`base64 -w 0 <remote_file>`，本地解码写盘。

失败信息包含远端 stderr 前 20 行。`fetch_remote_file` 工具用于把 CSV / 日志拉回本地 workspace。

## 6. msprof 与 CSV（i11.8）

runner 预建输出目录后执行：

```bash
msprof --application="<exe> <实际迭代次数>" --output=<预建目录>
```

- CSV 统一从 `<输出目录>/mindstudio_profiler_output/` 下递归查找。
- 控制台出现 `no summary data` 属正常；只有 **CSV 缺失 / 没有时长行**才是错误：
  `results.json` 的 `status` 为 `error`，`kernelTimeUs` 为 `null`，绝不写成 pass。
- **`kernelTimeUs` 口径**：优先读 `op_summary_*.csv`，按 `Op Name`（或 `Op Type`）匹配
  `operatorName`，取匹配行的有效 `Task Duration(us)`，排除热身行后求平均；匹配不到就取可用行。
  只有完全没有 `op_summary` 行时才读 `op_statistic_*.csv` 的 `Avg` 列（聚合值，不与其他文件
  混算）。两者都没有 → `status: error`，摘要列出搜过的目录与 CSV 文件名。
  `analysis.summary` 写明来源与参与平均的行数（如 `op_summary ... over 3 rows`）。
- `analysis.source` 只允许 `msprof`；`manifest` 的 `performanceTargetUs` 只写入 `performance.targetUs`，不会写入 `kernelTimeUs`。

## 7. 一次完整评测的步骤

```text
1. 上传四层代码 + 构建契约 + config.json + manifest.json（exec + base64 tar）
2. 远端 bash build.sh，取最后一行 stdout 作为 exe
3. 远端 flock + bash run_once.sh，解析 CANNESS_RESULT（含 golden 来源）
4. 远端 flock + msprof，按实际迭代次数采样
5. 读 CSV：op_summary 有效采样行求平均；只有聚合文件时取 op_statistic 的 Avg
6. 写本次评测的 results.json（含 runRecord.params.golden）
7. run_evaluation 轮询并解析 results.json
```

`results.json` 的 `runRecord` 记录时间戳、主机名、编译/分块参数（manifest 或 config 的
`params` / `blockDim` / `tileSize` / `approximation`）、CANN 版本与总耗时，便于多版本 diff。

## 8. 正确性参考（Gelu）

```python
0.5 * x * (1.0 + torch.tanh(0.7978845608028654 * (x + 0.044715 * x**3)))
```

用 float32 算参考、再转 fp16；本算子实测 `0.000972748`，`bad = 0/32768`。
fp16 的包内阈值由模板写成 `2^-10`（`config.json.maxAbsErr`）。`golden.h` 保留占位实现时，
runner 判 `accuracy_fail` 并在摘要里写 `golden not implemented`，不会假通过。

## 9. 性能基线（910B，[8, 4096]，fp16）

| 配置 | avg us | max us |
|---|---|---|
| 8 block / tile1024 / Tanh | 71.4 | 79.7 |
| 32 block / tile512 / Tanh | 46.9 | 52.6 |
| 32 block / tile512 / Exp+Reciprocal | 32.2 | 41.2 |
| 32 block / tile512 / Exp+Div | 35.2 | 43.9 |
| 32 block / tile1024 单 tile | 23.1 | 31.6 |
| **16 block / tile1024 双 tile** | **30.9** | **38.5** |

结论：小 shape 上 blockDim 不是越多越好；16 block + 每块 2 tile 兼顾双缓冲与开销。scalar 占比约 60%，vector 仅约 1us，优化方向是减少循环 / 同步，不是换数学公式。

## 10. 本地契约测试（无 NPU）

`plugin/tests/eval-runner.test.ts` 用 `tests/fixtures/eval-contract/` 包和一个假
`msprof`（只写 CSV）跑通整条链路：manifest 目标 40us、CSV 30.9us 时报告必须是
30.9us；多行 CSV（10/20/30）必须是平均值 20；只有 `op_statistic` 时取 Avg 列；
CSV 缺失必须是 `error`；占位 golden（`badCount:-1`）必须是 `accuracy_fail` 且摘要含
`golden not implemented`。Linux CI 直接运行；Windows 本地需要 `CANNESS_TEST_PYTHON`
指向 `python.exe`，并让 PATH 能解析 Git Bash（或设 `CANNESS_TEST_BASH`）。
