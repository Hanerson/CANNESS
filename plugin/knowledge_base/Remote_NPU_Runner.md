# 远端 NPU Runner（无 SFTP 场景）

适用于「本地 Windows / 无 CANN，远端只有 SSH + NPU + 编译器」的评测方式。

不要依赖插件内置的 `watch.py`：它是 mock，会把耗时直接写成 manifest 里的目标值。在这种机器上把 `canness-eval` 的 `bootstrap` 设为 `false`，或给 `bootstrapCommand` 一个真实 runner 命令，避免 mock 伪造 `pass`。

## 连接与上传

远端可能没有 `sftp-server`：

```text
Received exit code 127 while establishing SFTP session
```

此时 SFTP 上传不可用，用 `ssh exec` + base64 传输：

1. 本地把目录打成 **POSIX tar**（不要依赖 `child_process`，沙箱会 EPERM；纯 Node 写 tar 头即可，远端 `tar -xf` 不要求 gzip）。
2. 分块 `printf '%s' '<base64>' >> /tmp/upload.b64`。
3. 远端 `base64 -d /tmp/upload.b64 | tar -xf - -C <dir>`。

下载同理：`base64 -w 0 <remote_file>`，本地解码写文件。

## 执行脚本

- 所有 `.sh` 必须 **LF** 换行；PowerShell 默认 CRLF 会让远端 `tail -n 40` 报 `invalid number of lines: '40\r'`。
- 不要把复杂 shell 内联进 PowerShell → Node → bash 三层引号；写成本地 `.sh` 文件，base64 传过去再 `bash /tmp/run.sh`。
- 远端 `tail -40` 不一定支持，统一写 `tail -n 40`。

## 运行环境

```bash
source /usr/local/Ascend/ascend-toolkit/set_env.sh
export ASCEND_VISIBLE_DEVICES=7     # 容器只映射了 /dev/davinci7 时必须
```

注意：

- 不要手动把 CANN 的 `lib64` 放到 `LD_LIBRARY_PATH` 最前面，会让 `npu-smi` 报 `undefined symbol: dms_get_util_from_udis`；用 `set_env.sh` 的顺序即可。
- `aclInit` 报 `chipType=0 does not support get device msg feature` 通常是设备没映射，不是 CANN 版本问题。

## 一次完整评测的步骤

```text
1. 上传四层代码 + 验证骨架（main.cpp / tiling shim）
2. bisheng 编译 kernel -> kernel.o
3. bisheng 编译 main -> main.o
4. bisheng 链接 -lascendcl -lruntime -> demo
5. 运行 demo 1 次：对照 CPU 参考，输出 maxAbsErr / bad 数
6. msprof --output=<预建目录> ... demo 100
7. 读取 op_statistic / op_summary / task_time CSV
8. 回传 CSV + 控制台日志到本地
```

编译命令、tiling shim 与 launch 细节见 [`AscendC_Compile_Run.md`](AscendC_Compile_Run.md)。

## 正确性参考（Gelu）

```python
0.5 * x * (1.0 + torch.tanh(0.7978845608028654 * (x + 0.044715 * x**3)))
```

用 float32 算参考、再转 fp16；验收 `maxAbsErr <= 1e-3`。本算子实测 `0.000972748`，`bad = 0/32768`。

## 性能基线（910B，[8, 4096]，fp16）

| 配置 | avg us | max us |
|---|---|---|
| 8 block / tile1024 / Tanh | 71.4 | 79.7 |
| 32 block / tile512 / Tanh | 46.9 | 52.6 |
| 32 block / tile512 / Exp+Reciprocal | 32.2 | 41.2 |
| 32 block / tile512 / Exp+Div | 35.2 | 43.9 |
| 32 block / tile1024 单 tile | 23.1 | 31.6 |
| **16 block / tile1024 双 tile** | **30.9** | **38.5** |

结论：小 shape 上 blockDim 不是越多越好；16 block + 每块 2 tile 兼顾双缓冲与开销。scalar 占比约 60%，vector 仅约 1us，优化方向是减少循环 / 同步，不是换数学公式。
