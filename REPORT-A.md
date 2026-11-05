# 任务 A 交付报告：评测链路真实化

分支：`fix/eval-truthfulness`
范围：`plugin/` 的评测侧与远端执行；未触碰任务 B 的文件。

## 1. 结论

`上传 → 编译 → 正确性 → msprof → 回传` 现在是插件内唯一路径：

- `remote/watch.py`（把 `performanceTargetUs` 直接写成 `kernelTimeUs` 的 mock）已删除。
- `bootstrap` / `bootstrapCommand` 配置、`remote-bootstrap.ts` 与自动部署逻辑已删除。
- `run_evaluation` 上传测试包与 `remote/runner.py`，由 runner 执行包的 `build.sh`、
  `run_once.sh` 和真实 `msprof`；`kernelTimeUs` 只来自 `mindstudio_profiler_output/*.csv`
  的 `Task Duration(us)`，CSV 缺失一律 `status: "error"`。
- 上传默认走 SSH `exec` + base64 + 纯 JS POSIX tar，不依赖远端 `sftp-server`，本地也不
  调用外部 `tar` 进程。
- `results.json` 新增 `runRecord`（时间戳 / 主机 / 参数 / 工具链 / 耗时），并新增
  `fetch_remote_file` 工具把 CSV、日志拉回 workspace。

## 2. 分项改动与验证

| Issue | 改了什么 | 怎么验证 | 实测数据 |
|---|---|---|---|
| A1 (i2+i9) | 删除 mock 与 bootstrap；新增 `remote/runner.py`；`analysis.source` 只保留 `msprof`；缺 `build.sh`/`run_once.sh` → `compile_fail` + `package does not implement build contract v1` | `eval-runner.test.ts`：fixture 包 + 假 msprof（只写 CSV） | manifest 目标 40us、CSV 30.9us → `kernelTimeUs: 30.9`；CSV 缺失 → `status: error`、`kernelTimeUs: null` |
| A2 (i5+i10+i11.3) | runner 固化 `set_env.sh`、`ASCEND_VISIBLE_DEVICES=7`、flock、预建 msprof 目录、CSV 路径；`run_evaluation` 描述写明本地不编译 | `pnpm check`；`Remote_NPU_Runner.md` 文档复核 | 5 个隐性步骤全部落到 runner 与文档 |
| A3 (i11.3+i11.1) | `connectRemote` 改为 exec+base64 通道；`createTar` 纯 JS ustar；`MemoryRemote` 语义不变；错误带远端 stderr 前 20 行 | `ssh2-transport.test.ts`：tar 解析、命令序列、无 SFTP、stderr 截断；`openExecRemote` 断言从不调用 `sftp` | 失败信息含 `remote-line-20`、不含 `remote-line-21` |
| A4 (i11.9) | 新增 `fetch_remote_file`；`plugins.test.ts` 工具断言改为“包含这些名字” | `plugins.test.ts`：CSV 回传、缺失文件、路径逃逸 | 回传字节数一致；`../escape.csv` 被拒绝 |
| A5 (i11.7+i11.8) | runner 只 source `set_env.sh`，从不重排 `LD_LIBRARY_PATH`；统一从 `mindstudio_profiler_output/` 找 CSV | 文档 + runner 代码复核 | —（需真机复核 `npu-smi`） |
| A6 (i11.10) | `remote/` 只保留 `runner.py`；上传/下载内联在 JS；临时文件全部带 uuid | `ssh2-transport.test.ts` 断言 `.canness-upload-<uuid>.b64`；每个脚本有文件头 | 运行后临时 runner 脚本被删除 |
| A7 (i11.12) | runner 写 `runRecord`；`report.ts` 解析并透传 | `eval-report.test.ts`、`eval-runner.test.ts` | `params.blockDim=16 / tileSize=1024 / approximation=tanh`，含 host / toolchain / durationMs |
| A8 (i1+i4) | `run_evaluation` 描述写明四工具顺序、上传目录、远端步骤、失败返回；返回 `workspace` / `packageDir` / `resultsPath` | `plugins.test.ts` 路径断言 | 三个路径均为绝对/可拼接值 |

## 3. 测试与静态检查

```text
pnpm check   ✅ 通过（host + client 两份 tsconfig）
pnpm test    ✅ 20 个文件、133 个用例全绿
             （Windows 本地跑 E2E 需 CANNESS_TEST_PYTHON 指向 python.exe）
```

说明：本机默认 PATH 下 Node 找不到 Python（Git Bash 的 PATH 是 POSIX 形式），E2E 用例会
`skipIf`；用 Windows 形式 PATH + `CANNESS_TEST_PYTHON` 运行后 4 条 E2E 全部执行并通过。
Linux CI 自带 `python3`，无需这些变量。

## 4. 与任务书的两处必要偏差

1. **正确性阈值来源**：本地 `spec.ts`（B 所有）没有容差字段，runner 无法从 spec 读取。
   现在从包内 `config.json` / `manifest.json` 的 `maxAbsErr`（`tolerance.maxAbsErr` 亦
   可）读取，缺省 `1e-3`，并在 runner 与知识库中写明。没有由 runner 编造数值。
2. **`tests/policy.test.ts` 两处 fixture**：`source: 'msprof-mock'` → `'msprof'`。
   这是删除枚举后无法避免的同步；该文件虽在 B 的清单里，但只改了两个字符串，未改断言
   结构与 loop 逻辑。

## 5. 未完成 / 需要真机复核

本环境没有任务书中的 NPU 主机与登录凭据，以下验收项未执行：

- 远端真实 Gelu 包端到端：`results.json` 的 `kernelTimeUs` 与手工 `msprof` 一致（±1us）。
- 无 `sftp-server` 的真实目标机上传 / `fetch_remote_file`。
- 只有 `/dev/davinci7` 时的设备选择，以及同一 shell 先 msprof 再 `npu-smi info`。
- `bisheng` 实际编译参数（runner 不拼编译命令，由包的 `build.sh` 决定）。

复现步骤（合并后在真实远端执行）：

```bash
# 1. 上传包由 run_evaluation 自动完成；手工复现：
python3 /tmp/canness-a/runner-<uuid>.py \
  --inbox /tmp/canness-a/inbox --outbox /tmp/canness-a/outbox \
  --generation <gen> --once
# 2. 对比手工 msprof：
flock /tmp/canness/davinci7.lock \
  -c 'source /usr/local/Ascend/ascend-toolkit/set_env.sh; \
      ASCEND_VISIBLE_DEVICES=7 msprof --application="<exe> 100" --output=/tmp/msprof-check'
# 3. 读取 /tmp/msprof-check/mindstudio_profiler_output/*.csv 的 Task Duration(us)
# 4. 拉回结果：
#    fetch_remote_file remotePath=/tmp/canness-a/outbox/<gen>/results.json localPath=results/<gen>.json
```

## 6. 文件清单

新增：`plugin/remote/runner.py`、`plugin/tests/eval-runner.test.ts`、
`plugin/tests/eval-report.test.ts`、`plugin/tests/fixtures/eval-contract/*`、`REPORT-A.md`、
`.gitattributes`（`*.sh` / `*.py` 强制 LF，避免 Windows checkout 把远端脚本变成 CRLF）。

删除：`plugin/remote/watch.py`、`plugin/src/remote-bootstrap.ts`、
`plugin/tests/remote-bootstrap.test.ts`、`plugin/tests/watch.test.ts`。

修改：`plugin/src/{eval,eval-run,report,analysis,remote,ssh2-transport}.ts`、
`plugin/cordis.patch.yml`、`plugin/knowledge_base/Remote_NPU_Runner.md`、
`plugin/tests/{plugins,eval-run,ssh2-transport,policy}.test.ts`、
`docs/design/03-closed-loop-feedback.md`、`docs/plans/2026-11-03-remote-bootstrap.md`。
