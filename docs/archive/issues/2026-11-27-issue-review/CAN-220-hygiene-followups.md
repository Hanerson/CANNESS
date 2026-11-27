# CAN-220 凭据名三个 N、未调用的 `--loop`、刷新与设置卡的测试缺口

| 字段 | 值 |
|---|---|
| 类型 | 卫生 |
| 优先级 | **P3** |
| 组件 | 凭据名、`runner.py`、CANNLab OAuth、EvalCard |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **partial** |
| 标签 | `hygiene`, `tests` |
| 复核 | 2026-11-27。Bash 换行故障未复现；`--loop` 只在本条跟踪 |

这几件都不阻塞 9.2.1 评测。修的时候可以拆开提交。

## 1. 凭据名是 `CANNNESS_SSH_PASSWORD`（三个 N）

`plugin/src/eval.ts` 第 74 行、设置卡 `DEFAULT_PASSWORD_REF`、测试和 `docs/reference/configuration.md` 都使用这个拼写。它是一致使用的可配置默认名。人在环境里导出 `CANNESS_SSH_PASSWORD`（两个 N）时，插件读不到，报的是 `ssh credentials missing`。

建议：在设置卡和文档提示里写出完整的三个 N。默认名保持不变。

验收：提示文本包含 `CANNNESS_SSH_PASSWORD`。只导出两个 N 的名字时，错误信息指出插件读取的是三个 N 的这个默认名。

## 2. 现行流程不调用 `--loop`

树里没有 `plugin/remote/watch.py`。`eval-run.ts` 发出的命令带 `--generation` 和 `--once`。`runner.py` 的 `main()` 仍保留 `--loop`。现行评测路径不调用它。

本条是 `--loop` 的唯一跟踪条目。CAN-217 不再写它。

建议：删除 `--loop` / `--interval` 和无 generation 的扫描，或在 `--help` 里标成手工批跑并补测试。归档文档不动。

验收：`runner.py --help` 的模式与 `runnerCommand` 能发出的参数一致；若保留 `--loop`，帮助文本写明现行流程不调用它。

## 3. 工作区里部分 Python 文件是 CRLF，Git 索引是 LF

`.gitattributes` 把 `*.py` 和 `*.sh` 标成 `eol=lf`。索引是 LF，`git status` 干净。本机 `core.autocrlf=true` 时，工作区里的 `plugin/remote/validate_submission.py`、`plugin/tests/test_submission_validation.py`、`plugin/tests/test_algorithm_simulation.py` 是 CRLF。`plugin/templates/local-validation/algorithm-simulation.py` 里混有 CR。`runner.py` 与 `templates/cannbench/build.sh` 的工作区是 LF。

提交进 Git 的 blob 是 LF。2026-11-27 复核没有复现「工作区 CRLF 导致远端 Bash 失败」。

建议：本机使用 `core.autocrlf=input`，避免把 CRLF 再提交进去。在复现出 Bash 故障之前，不把换行当成评测缺陷。

验收：新提交的 `*.py` / `*.sh` blob 仍是 LF。

## 4. 刷新成功已有间接覆盖，轮换和失败回退仍缺

`plugin/src/cannlab/oauth.ts` 有 `refreshAccessToken`。`connect.ts` 的回访路径用 `silentAccessToken`。刷新成功已有间接覆盖。`cannlab-oauth.test.ts` 仍缺这三块直接断言：refresh token 轮换写回、刷新失败再退回登录、空 `access_token` 不写成已连接。

建议：用假 `fetcher` 补这三条。不要为了补测试去打真实 GitCode。

验收：刷新返回空 `access_token` 时，状态回到需要登录，且不把空令牌写成已连接。轮换后的 refresh token 写回存储。刷新失败时退回登录。

## 5. EvalCard 视图没有渲染测试

`EvalCard.tsx` 只被 `client/index.ts` 引用。`eval-card.test.ts` 和 `eval-card-cannlab.test.ts` 测的是控制器。错误时展开日志、断开按钮是否在已连接后出现、`apply()` 的 slot 订阅没有执行到。`pnpm check` 会类型检查 client。

建议：对错误态日志和「已连接才显示断开」做一次渲染测试。控制器测试不必重写。

验收：断开按钮在未连接时不在树上；连接状态变为已连接后出现。

## 关联

CAN-212、CAN-213、CAN-217。CAN-101 的模板 CRLF 已在 0.5.0 修过。本条第 3 点只记录工作区换行，复核未复现 Bash 故障。

## 处置和验证

补了离线刷新轮换、失败回退和空令牌测试。保留可配置的三个 N 默认名，runner --loop 标为手工模式。尚未补齐设置卡错误态及断开按钮的真实渲染测试。
