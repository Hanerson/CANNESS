# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

（无）

## [0.3.0] - 2026-11-14

从「开发夹具」升级为「可交付流水线」：一条命令产出官方 CANNBench 格式算子包，
并在真实 NPU 上完成构建、安装与官方精度评测。

### 新增

- **`export_submission`**：把当前同 shape 算子包导出为官方 `direct_launch` 工程（9 文件 source + `cannbench.zip` + `provenance.json`），离线可用；`callable` 参数对齐官方任务签名（如 `exp`）。模板位于 `templates/cannbench/`（`build.sh` / `setup.py` / `launch.cpp` / `operator.py`）。
- **`preflight_evaluation`**：不消耗评测名额的体检。本地检查包完整性；`remote: true` 时再验 SSH、CANN 编译器、版本与 msprof，返回 `local.ok` / `ssh` / `cann.ready`。
- **attrs 真正到达 kernel**：`CannessAttrs` + `canness_tiling_host.h` 属性表，算子运行时能读到 `base` / `scale` / `shift`（此前 attrs 只喂给 golden，kernel 完全看不到）。
- **`launch.tile_length`**：tile 长度由 spec 决定并贯穿 `config` → `runRecord` → kernel tiling（此前固定 1024）。
- **`accuracy { absThreshold, relThreshold }`**：逐元素「绝对 **或** 相对」判定。fp16 正确实现的绝对误差 1.95e-3 会超过 2^-10，旧判据必挂；新判据下 `maxRelErr 4.879e-4` 通过。
- **`input_values`**：注入 NaN / ±Inf / ±65504 等边界值，报告里给出 `nonfiniteMismatches`。
- **`interface { defaults, dtypes }` 与 `attrs_derived`**：导出包的 callable 默认值改由任务契约提供（不再误用测试属性）；`ln(base)` 这类派生量在 host 侧预折叠。
- **来源溯源全链路**：`write_operator.provenance` → `operators/<gen>/layer-origins.json` → `manifest.provenance` → 导出 `provenance.json`，每文件 sha256，并记录与历史 generation 的行重合度。
- **`workspace.ts`**：工作区由 cwd 派生（默认 `canness-workspace`），配置项可省略；`cordis.patch.yml` 不再钉死绝对路径。
- **CANNLab 生命周期**：隧道断开时返回环境名、额度提示、上次成功连接时间、重连指引与 `pendingStage`；环境停机后可自动启动并恢复 SSH。

### 变更

- `run_evaluation` 支持 `pendingStage` 断点续跑：传输失败后重试同一份包可接着上次阶段。
- 远端指标采集区分 AIC / AIV：CANN 9.0 会把纯向量算子标成 `AI_CORE`，AIC 全零而 AIV 非零时改用 AIV 列归类。
- 版本 `0.2.1` → `0.3.0`。

### 修复

- **fp16 精度误判**：绝对误差阈值会把正确实现判错（见上）。
- **attrs 到不了 kernel**：`scale` / `shift` 现在真机生效，否则 golden 会差一个仿射变换、correctness 必挂。
- **tile 固定 1024**、**特殊值不可测**、**工作区双真相**：分别由 `tile_length`、`input_values`、`workspace.ts` 修掉。

### 验证

- 单元测试 25 个文件 **208 项全绿**；`pnpm check`（host + client 双 tsconfig）、`pnpm build` 通过。
- 真机闭环（`gen-2e1b3a97`，Ascend910 / CANN 9.0.0）：`pass`，`maxRelErr 4.879e-4`，`nonfiniteMismatches 0`，**49.872µs / 目标 50µs**，`bottleneck: scalar`，84.1 GB/s。
- 导出包真机构建：`cann_bench-1.0.0-py3-none-linux_aarch64.whl`（49,438 B）→ `pip install` → `import` 通过；精度矩阵 17/17，后续同 wheel **51/51**（fp16 / fp32 / bf16）。
- **官方 CANNBench（tasks-v2.1.0）Exp 精度评测：20/20 通过**，`pass_rate 1.0`，score 30（编译 5 + 运行 5 + 功能 20）；本轮为 `--no-perf`。
- CANNLab 停机 → 自动启动 → SSH 恢复：真机验证通过。
- 未验证：官方性能评分（`--no-perf`，当前 49.9µs 与参考实现 5.4µs 差约 9×，需双缓冲流水线）；loop 的停滞/续轮真机路径。

## [0.2.1] - 2026-11-06

### 新增

- **构建契约 v1**：`build_test_package` 在四层之外渲染 `build.sh`、`run_once.sh`、`main.cpp`、`golden.h`、`canness_tiling.h`，生成按 dtype 推导阈值的 `config.json`，并让 `manifest.json.files` 反映实际落盘清单（新增 `layers` / `buildContract` 字段）。tiling 统一用通用 `CannessTilingData`。
- **`write_package_file`**：模型唯一可写的包内文件是 `golden.h`；占位实现判 `accuracy_fail`，摘要为 `golden not implemented`，`runRecord.params.golden` 记录 `placeholder` / `custom`。
- **CANNLab 隧道健康检查**：`run_evaluation` 在连接前探测 helper 的 `/heartbeat` 并续约一次；隧道断开返回 `tunnel is down; reconnect from Settings → CANNESS`。

### 修复

- **kernel 入口签名校验**：包里的 `main.cpp` 只调用 `extern "C" __global__ __aicore__ void canness_kernel(<输入…>, <输出…>, GM_ADDR tiling)`，但此前没有任何环节保证 `kernel.cpp` 真的定义了它——写成 `void gelu(GM_ADDR x, GM_ADDR y, GM_ADDR workspace, GM_ADDR tiling)` 时链接会报 undefined symbol，读起来像工具链问题，模型改几轮也定位不到。`write_operator` 与 `build_test_package` 现在都在落盘前校验入口名、无 `workspace` 参数、末位为 `tiling`，不匹配直接报错并给出正确形式；`canness-loop` 的编译失败增强块也带上这条契约。
- **版本徽章漂移**：README 徽章停在 `v0.1.1`，与 `package.json` 的 `0.2.0` 不一致；随本次发布统一到 `v0.2.1`。

### 变更

- **`kernelTimeUs` 口径固定**：优先 `op_summary` 全部行的 `Task Duration(us)` 算术平均；只有聚合文件时取 `op_statistic` 的 `Avg` 列；两者都没有时 `status: "error"` 并列出搜索过的目录与 CSV。
- **`fetch_remote_file` 收紧**：`remotePath` 必须为绝对路径，读取范围仅限 `outbox` 与当前 generation 的 `inbox/<generationId>`。
- **移除 `bootstrap` / `bootstrapCommand` 与对应文档**：远端不再需要 inbox 消费者；评测由 `remote/runner.py` 执行包内构建契约。历史条目保留在 v0.1.1。
- **同批合入（原记录在 Unreleased，随 0.2.1 发布，此处补记）**：构建契约支持 `I32` / `I64` 真实缓冲与整数精确比较、`index-check` 精度模式、shape / attrs 的 `GoldenCtx`，未知 dtype 打包时拒绝（T-008/T-009）；性能采样默认 20 次、热身行不计入均值、实际次数写入 `runRecord`（T-010）；主机编译单元只引入共用 tiling 结构，链接不再使用 `--allow-multiple-definition`（T-011）；manifest 记录契约指纹、上传前校验包哈希、远端先编译最小 `DataCopy` 自检（T-012）；自动续轮只驱动最近一次评测的所属会话且一份报告只触发一次，旧 `state.json` 无 `ownerSessionId` 时需在该会话重新评测以认领（T-001/T-002）；同包重复评测返回上一份报告并标记 `duplicate: true`，`force: true` 可重测（T-004）；远端自动探测 `set_env.sh` 并记录实际路径，缺失时在编译日志列出搜索路径（T-006）。

### 清理

- **文档归位**：根 README、README.en.md、`plugin/README.md` 与 `docs/design/05` 里残留的 `watch.py` / `bootstrap` / `bootstrapCommand` / `msprof-mock` / SFTP 描述全部改为真实 runner 的说法；`docs/README.md` 把已作废的远端自举计划标记为历史，并登记构建契约与 PR 验收两份新文档。
- **删除死代码**：`probe-contract.ts` 的 `probeCommandLine`（客户端已改走 HTTP 路由）、`cannlab/api.ts` 的 `localSshTarget`（无调用方，随之移除两个未用导入）、`remote.ts` 的 `isRemoteHost`（类型守卫无调用方）。
- **构建残留**：删除 `lib/remote-bootstrap.*`（源码已删，重新 build 不再生成）。

## [0.2.0] - 2026-11-04

### 新增

- **CANNLab 连接**：设置卡新增「CANNLab 云端环境」，一键完成浏览器 GitCode 授权 → 列出账号内运行中的环境 → 取临时私钥与签名隧道地址 → 下载并启动官方 Dev Space 端口转发 helper → 把 `host` / `port` / `username` / `privateKeyPath` 回填并保存到 `canness-eval`。全程逐步文案（`checking-login` → `done`），失败也会写明停在哪一步。CANNLab 不开放入站 SSH，这是唯一的接入路径。
- **`canness-remote` 插件行**（`dsh-canness/remote-api`）：在 `webServer` 上注册 `POST /canness/probe`、`POST /canness/cannlab/connect`（SSE 逐步推送）、`POST /canness/cannlab/disconnect`、`GET /canness/cannlab/status`；每条路由先问 `connection.requestRejection`（Host/Origin 栅栏 + 浏览器凭据），再在 wire 边界校验方法与请求体。
- **连接轨迹落盘**：每次尝试写到 `~/.dsh/canness/cannlab/last-connect.log`，刷新页面或关面板都不丢，失败原因一并写入。
- **环境名选择**：账号同时有 CPU 与 NPU 两个环境在跑时，可在卡片上指定名字或 ID；留空用唯一运行中的那个。
- **配置**：`canness-remote` 提供 `tokenRef`、`cacheRoot`、`keyDir`、`logPath`、`instance`。

### 变更

- **连通性检查改走 HTTP 路由**：原「测试联通」经 `/canness-probe` 会话命令执行，必须存在活跃 agent 会话，且会向会话日志写入 `command/run` / `command/done`；现改为 `POST /canness/probe`，与对话无关。旧的 `src/client/probe-remote.ts` 及其测试已删除。
- **设置卡重排**：改为「状态条 → CANNLab → 连接 → 凭据 → 远端目录 → 高级」一条阅读线。层次只靠字号与字重（19 / 13 / 12 / 11.5px，600 / 500 / 400），颜色全部取自 `--dsw-alias-*` token，无自造色值。就绪状态收进一条带边框的状态条（点 + 目标 + 就绪标签 + 认证方式），「测试联通」和结果并排在其中；长长的说明文案（认证方式、CANNLab 连接过程、环境名）折进 `<details>`；连接日志默认折叠，**失败时自动展开**（那时它才是重点）。CANNLab 日志摘要行直接显示步数 + 最后一步，不必展开就能看出卡在哪。
- GitCode 凭据只持久化 refresh token，存进凭据引用 `CANNLAB_GITCODE_TOKEN`；access token 不落盘。

### 修复

- **「连接失败: `"path" argument must be of type string. Received an instance of Object`」**：`canness-remote` 的 `.volatile()` 配置经 Loader 校验后并不总是原始字符串，`logPath` / `cacheRoot` / `keyDir` / `instance` 之一以对象形态传到了 `node:path`，连接在写出第一行日志前就中断。现在所有配置读取都经过类型收口（`setting()` / `pathOption()`），非字符串一律回落默认值；`startAttemptLog()` 也改为失败时返回空 appender——**写日志永远不能让连接失败**。已加回归测试：把五个配置项全传对象，断言流程仍能走到 `login-awaiting`。
- **临时私钥在 Windows 上对外部工具不可用**：`0600` 在 Windows 上无效，文件保留目录继承的 ACL（含所有人可读的沙箱/用户组），OpenSSH 因此拒绝该私钥（`UNPROTECTED PRIVATE KEY FILE`）。插件自身用 `ssh2` 不受影响，但用户手动 `ssh`/`scp`/VS Code 全部被挡。现在写盘后按平台收口：POSIX 走 `0600`，Windows 用 `icacls /inheritance:r` + 只授予当前账号 `(R)`；收口失败时连接照旧成功，但日志会 `warn` 说明外部 ssh 可能拒绝该文件。
- **「测试联通」在无会话时不可用**：根因是命令链路依赖活跃 agent，现由宿主进程直接应答。
- **OAuth 回调端口不释放**：原实现 `server.close()` 会被浏览器 keep-alive 连接拖住，导致第二次连接报 `port 3000 is busy`；现在回包带 `connection: close`、`closeAllConnections()` 后再 `close()`，并且等监听真正关闭才让登录结算。
- **关面板会堵死下一次连接**：面板关闭即中断流程并释放回调端口，不再留下最多 5 分钟的悬挂监听。
- **建隧道失败留残留**：hub 与心跳在失败路径上会被清理，并输出一句可读的原因（签名地址过期与实例已关机都长这样）。

### 验证

- 单元/集成测试 20 个文件 131 个用例全绿（`pnpm test`）；`pnpm check`、`pnpm build` 通过。
- **真实 CANNLab 环境端到端验证（Windows → DevEnvC_J2Hn2 / Ascend910 A3）**：浏览器授权 → 实例发现 → 隧道 `127.0.0.1:20022 -> 22` → 回填保存，链路全通；远端 `whoami`/`npu-smi`（2×Ascend910，CANN 9.0.0，镜像 `py3.11-a3-arm-20261019`）、`g++` 编译运行、`numpy 1.26.4`、`/mnt/workspace` 读写均实测通过；私钥 ACL 收口后用系统 `ssh` 登录亦成功。
- 路由集成测跑在真实 HTTP 监听上：SSE 帧序、探活成功/拒绝、方法 405、媒体类型 415、以及「拒绝的 peer 一个 handler 都不执行」。
- 真机验证（Windows）：Dev Space 扩展下载与解包（v1.0.12，走 `tar -xf`，无需 unzip）、helper 启动与 `/heartbeat`、`create-forward-hub` 的失败路径；全流程编排用打桩的 GitCode/CANNLab 接口 + 真实回调服务器跑通到 WebSocket 建立为止。
- **未完成**：尚无用真实隧道跑过一次 `run_evaluation`（上传测试包并取回 `results.json`）；连接本身已在真机验证。

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
