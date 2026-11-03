# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [0.1.1] - 2026-11-03

### 新增

- **远端自举**：`run_evaluation` 首次上传前自动建目录、探测或拉起 inbox 消费者（`watch.py --loop`）；自举失败立即返回 `status: "error"`（`remote bootstrap failed: <原因>`），不再空等 `timeoutSec`，也不写状态文件、不消耗迭代预算。
- **配置**：`canness-eval` 新增 `bootstrap`（默认 `true`）与 `bootstrapCommand`（默认空，走内置 mock）。
- **连通性检查**：设置卡新增「测试联通」，经宿主侧 `/canness-probe <host> <port>` 命令做一次 TCP 连接（不验证登录）。
- `remote/watch.py` 新增 `--loop` / `--interval`，单轮异常不退出；`--once` 语义不变。

### 变更

- 设置卡重做：按「连接 / 凭据 / 远端目录」分组，认证方式改为密码或私钥单选，保存密码时清空私钥路径，并提示未就绪原因。
- `mkdirp` 在会话内缓存已确认目录，避免高延迟链路上的重复探测；目录权限错误不再被吞掉。
- 传输层 `close()` 幂等，`run_evaluation` 只关闭一次连接。

### 验证

- 单元测试 15 个文件 90 个用例全绿（`pnpm test`）；`pnpm check`、`pnpm build` 通过。
- 真机链路（`140.207.205.182:32222`，沐曦卡，不跑算子）：两次 `run_evaluation` 均为 `status: "pass"`；远端 `/tmp/canness/{inbox,outbox,watch.py,watch.pid,watch.log}` 齐备，测试包四层文件上传成功；第二次调用复用同一消费者（仅 1 个 `watch.py` 进程）；验证后已清理。

## [0.1.0] - 2026-11-02

首个公开版本，定位为**可运行的最小闭环**（MVP）。四个插件、五个工具、远端 mock 与 Web 设置卡均已实现，单元测试全部通过；真实 SSH 主机上的端到端验收尚未进行。

### 新增

- **插件拆分**：`dsh-canness` bundle 插入五行 —— `canness`（浏览器半区挂载点）、`canness-knowledge`、`canness-generator`、`canness-eval`、`canness-loop`。
- **工具**：`kb_search`、`submit_spec`、`write_operator`、`build_test_package`、`run_evaluation`。
- **规格书校验**：`submit_spec` 按字段路径逐项校验，缺字段即报 `missing <path>`，不写状态文件。
- **四层文件落盘**：`op_kernel/kernel.cpp`、`op_host/host.cpp`、`op_api/api.cpp`、`op_plugin/plugin.py`。
- **测试包封装**：复制四层文件并写入 `manifest.json`（generationId、operatorName、performanceTargetUs、files）。
- **远端评测**：基于 `ssh2` 的 SFTP 上传与结果轮询，本地不编译、不调用 CANN、不调用云 API。
- **认证**：私钥优先，其次从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）。
- **预算与停机**：`maxIterations`、`maxCompileRetries`、`negativeStreakLimit`、`convergenceThreshold`，外加超时累计与目标达成判定。
- **自动续轮**：`canness-loop` 监听 `agent/pre-step` 与 `agent/turn-stopping`，注入评测增强块并 `steer` 下一轮。
- **性能分析解析**：接受 msprof 形状的 `analysis`（bottleneck、aic 比例、cube 利用率等），`source` 为 `msprof` 或 `msprof-mock`。
- **Web 设置卡**：设置 → CANNESS，编辑 `canness-eval` 的全部字段；密码经凭据域写入，不进入配置文件；改动为 volatile，保存后立即生效。
- **远端 mock**：`plugin/remote/watch.py`，读取 inbox 中的 `manifest.json` 并写出 `results.json`。
- **文档**：设计文档 01–05 与实现计划；中英文 README；MIT 许可证。
- **CI**：GitHub Actions 上执行 `pnpm check`、`pnpm test`、`pnpm build`。

### 变更

- 仓库整理：移除与实现无关的 PDF/DOCX 参考资料与 `docs/past` 归档，`docs/` 归并为 `design/` 与 `plans/` 两个目录。
- `plugin/package.json` 补齐 `description`、`keywords`、`license`、`repository` 与 `files` 元信息。

### 已知限制

- 单轮生成、单候选；没有并行探索、tiling 搜索、向量知识库与 Dashboard。
- 只支持通用 SSH 上传 + 等待；不提供本地执行器，也不对接云平台。
- 远端 inbox 必须有消费者（cron 或常驻 watcher），否则 `run_evaluation` 会一直等到 `timeoutSec`。
- 依赖 dsh `0.2.1-rc.3` 一代的插件 API；dsh 升级时需要同步 `engines.dsh` 与 peer 版本。
