# 远端 NPU Runner（真实评测）

适用于「本地 Windows / 无 CANN，远端只有 SSH + NPU + CANN 工具链」的评测方式。

**本插件只在远端编译。** 本地 Windows 没有 CANN，`run_evaluation` 从不调用本地编译器；它把测试包用 SSH `exec` + base64 tar 送到远端，再由 `remote/runner.py` 依次执行 `build.sh`、`run_once.sh`、`msprof`，最后读回 `results.json`。

## 1. 目录布局

```
/tmp/canness-a/                     # A 的远端根目录（与 B 的 /tmp/canness-b 隔离）
├── inbox/<generationId>/           # 测试包：manifest.json / build.sh / run_once.sh / 四层代码
├── outbox/<generationId>/results.json
├── runner-<uuid>.py                # 每次评测临时上传，结束后删除
└── .canness-upload-<uuid>.b64      # 上传用的 base64 tar，解包后删除
```

- 远端临时文件一律带 uuid，并发评测不会互相覆盖。
- `/dev/davinci7` 是唯一映射的设备；任何 NPU 操作前先抢锁：
  `flock /tmp/canness/davinci7.lock -c '<command>'`（runner 自动加锁，`--lock ''` 可关闭）。
- 登录信息只放在本地配置 / 凭据存储，**不得写入仓库**。

## 2. 测试包契约（v1）

包根目录必须包含：

| 文件 | 约定 |
|---|---|
| `manifest.json` | 根级；runner 只依赖 `generationId` / `operatorName` / `performanceTargetUs`，可增量加字段 |
| `build.sh` | LF；成功时**最后一行 stdout** 打印可执行文件绝对路径；失败非 0 退出 |
| `run_once.sh` | LF；跑 1 次正确性，stdout 打印一行 `CANNESS_RESULT {...}`；`badCount==0` 时 exit 0 |

`CANNESS_RESULT` 的 JSON 至少包含：

```json
{"maxAbsErr":0.0009,"maxRelErr":0.00002,"badCount":0,"total":32768}
```

正确性阈值：`maxAbsErr` 上限从包内 `config.json` 的 `maxAbsErr` / `tolerance.maxAbsErr`（或 `manifest.json` 的同名字段）读取，缺省 `1e-3`。runner **不会**自己编造阈值，也不会在缺少脚本时猜编译命令：

- 缺 `build.sh` 或 `run_once.sh` → `compile_fail`，摘要固定为
  `package does not implement build contract v1`。
- `build.sh` 未打印可执行文件路径 / 打印的路径不存在 → `compile_fail`。

## 3. runner 的调用方式

`run_evaluation` 内部等价于：

```bash
PY=$(command -v python3 || command -v python)
timeout --kill-after=10s 1800s "$PY" /tmp/canness-a/runner-<uuid>.py \
  --inbox  /tmp/canness-a/inbox \
  --outbox /tmp/canness-a/outbox \
  --generation <generationId> \
  --once
```

手工复现时也可以直接跑上面的命令。主要参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--runs` | `100` | 传给 `msprof` 的应用迭代次数（`--application="<exe> 100"`） |
| `--device` | `7` | 导出为 `ASCEND_VISIBLE_DEVICES` |
| `--lock` | `/tmp/canness/davinci7.lock` | `run_once.sh` 与 `msprof` 的 flock 文件；空字符串关闭 |
| `--set-env` | `/usr/local/Ascend/ascend-toolkit/set_env.sh` | 存在才 source |
| `--msprof` | `msprof` | 可换成绝对路径 |
| `--bash` | `bash` | 跑包内脚本的 shell（Windows 本地做 fixture 测试时用绝对路径指向 Git Bash） |

## 4. 运行环境（i10 的隐性步骤）

```bash
source /usr/local/Ascend/ascend-toolkit/set_env.sh
export ASCEND_VISIBLE_DEVICES=7     # 容器只映射了 /dev/davinci7 时必须
```

- **不要**手动把 CANN 的 `lib64` 放到 `LD_LIBRARY_PATH` 最前面，会让 `npu-smi` 报
  `undefined symbol: dms_get_util_from_udis`；以 `set_env.sh` 给出的顺序为准，runner 不会重排。
- tiling 必须放 device 内存（由 `run_once.sh` / kernel 侧保证）。
- 同步用 `aclrtSynchronizeDevice()`，不是 `aclrtSynchronizeStream()`。
- `aclInit` 报 `chipType=0 does not support get device msg feature` 通常是设备没映射，不是 CANN 版本问题。
- 已验证的编译参数（写进 runner 文档，不在插件里拼命令）：
  `bisheng -x cce -std=c++17 --cce-soc-version=Ascend910B2 --cce-soc-core-type=VecCore`，
  链接 `-lascendcl -lruntime`。

## 5. 上传 / 下载：不依赖 SFTP

评测机常常没有 `sftp-server`：

```text
Received exit code 127 while establishing SFTP session
```

因此默认传输通道是 `ssh exec` + base64：

1. 本地用**纯 JS** 生成 POSIX tar（不调用外部 `tar` 进程；沙箱会 `spawnSync tar EPERM`）。
2. 分块 `printf '%s' '<base64>' >> <uuid>.b64`。
3. 远端 `base64 -d < <uuid>.b64 | tar -xf - -C <inbox>/<generationId>`。
4. 下载反过来：`base64 -w 0 <remote_file>`，本地解码写盘。

失败信息包含远端 stderr 前 20 行。`fetch_remote_file` 工具用于把 CSV / 日志拉回本地 workspace。

## 6. msprof 与 CSV（i11.8）

runner 预建输出目录后执行：

```bash
msprof --application="<exe> 100" --output=<预建目录>
```

- CSV 统一从 `<输出目录>/mindstudio_profiler_output/` 下递归查找。
- 控制台出现 `no summary data` 属正常；只有 **CSV 缺失**才是错误：
  `results.json` 的 `status` 为 `error`，`kernelTimeUs` 为 `null`，绝不写成 pass。
- `kernelTimeUs` = CSV 中 `Task Duration(us)` 的平均值（按 `Op Name` 匹配 `operatorName`；匹配不到就取全部行）。
- `analysis.source` 只允许 `msprof`；`manifest` 的 `performanceTargetUs` 只写入 `performance.targetUs`，不会写入 `kernelTimeUs`。

## 7. 一次完整评测的步骤

```text
1. 上传四层代码 + build.sh / run_once.sh / manifest.json（exec + base64 tar）
2. 远端 bash build.sh，取最后一行 stdout 作为 exe
3. 远端 flock + bash run_once.sh，解析 CANNESS_RESULT
4. 远端 flock + msprof --application="<exe> 100" --output=<预建目录>
5. 读 mindstudio_profiler_output/*.csv，算 Task Duration 平均值
6. 写 outbox/<gen>/results.json（含 runRecord）
7. run_evaluation 轮询并解析 results.json
```

`results.json` 的 `runRecord` 记录时间戳、主机名、编译/分块参数（manifest 或 config 的
`params` / `blockDim` / `tileSize` / `approximation`）、CANN 版本与总耗时，便于多版本 diff。

## 8. 正确性参考（Gelu）

```python
0.5 * x * (1.0 + torch.tanh(0.7978845608028654 * (x + 0.044715 * x**3)))
```

用 float32 算参考、再转 fp16；验收 `maxAbsErr <= 1e-3`。本算子实测 `0.000972748`，`bad = 0/32768`。

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
30.9us；CSV 缺失必须是 `error`。Linux CI 直接运行；Windows 本地需要
`CANNESS_TEST_PYTHON` 指向 `python.exe`，并让 PATH 能解析 Git Bash（或设
`CANNESS_TEST_BASH`）。
