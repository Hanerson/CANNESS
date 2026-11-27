# dsh profile 配置参考

bundle 配置以 [cordis.patch.yml](../../plugin/cordis.patch.yml) 与各插件的 `Config` 声明为准。相对路径与覆盖方式见[安装与配置](../guides/setup.md)。

## 知识库与生成

- `canness-knowledge.kbRoot` 可覆盖知识库根目录。缺省或留空时使用安装包内的 `knowledge_base`；显式相对路径按 dsh 进程的当前目录解析。
- `canness-generator.workspace`、`canness-eval.workspace`、`canness-loop.workspace` 采用相同的工作区解析规则。默认工作区是会话工作目录本身——`operators/`、`packages/`、`submissions/`、`.canness/` 直接位于该目录，不再嵌套 `canness-workspace/`。拿不到绝对会话目录时退到进程 cwd；显式覆盖时相对路径按会话目录解析，三处应指向同一目录。详见[插件架构](../design/05-plugin-architecture.md#工作区)。

## 远端评测

- `host`、`port`、`username` 指定 SSH 端点。bundle 默认主机和用户名为空，端口为 `22`。
- `privateKeyPath` 默认空。配置私钥时优先使用私钥，否则从 `passwordEnv` 指定的 dsh 凭据引用解析密码。默认引用为 `CANNNESS_SSH_PASSWORD`。
- 直接 SSH 和手工转发默认需要 `hostFingerprint`，填写通过受信任渠道取得的 OpenSSH `SHA256:…` 主机密钥指纹。旧配置确实需要临时放行时，可显式设置 `allowUnpinnedSsh: true`。通过设置卡创建的 CANNLab 托管转发沿用其连接方式。
- `targetApproval` 是用户在设置卡中保存的目标确认编号。核对 `submit_spec` 返回的声明目标与探测硬件后再保存。清空编号会撤销后续提交的确认。
- `inbox`、`outbox` 采用 bundle 的 `/tmp/canness-a/inbox` 与 `/tmp/canness-a/outbox`，可改为账号可写的远端绝对路径。
- `timeoutSec` 默认 `1800` 秒，runner 在自检、构建、运行和 profiler 阶段共用该预算，远端外层给结束与写报告留出余量。提交验收也从配置读取时限，通过独立的 `--timeout-sec` 执行。`pollIntervalMs` 默认 `2000` 毫秒。
- `setEnv` 默认空，由 runner 探测 CANN 环境脚本。多套工具链可用显式路径固定版本。
- `device` 可指定一个远端设备编号，例如 `"7"`。`deviceLock` 可指定同一设备使用的远端共享锁路径。留空时读取远端 `CANNESS_ASCEND_VISIBLE_DEVICES` 和 `CANNESS_DAVINCI_LOCK`，再回退到设备 7 或所选设备对应的 `/tmp/canness/davinci<ID>.lock`。正式评测、提交验收和独立探针使用同一组设置。
- `readRoots` 默认放行 CANN 安装树 `/usr/local/Ascend`，并从 `setEnv` 推导它所属的工具链根目录，因此知识库让你读 toolkit 头文件、示例或 profiler CSV 时不再需要额外配置；路径仍会规范化并拒绝符号链接逃逸，`/` 永远不放行。
- `retainAttempts` 默认保留最近 8 个已完成的尝试，正式评测按 generation 计算，提交验收按 inbox 计算。`0` 禁用回收。没有完整结果文件的目录保留供排查，已完成且超出保留范围的目录和其远端路径会到期。
- `canness-knowledge.workspace` 仅在搜索本地探针记录时使用。若评测插件显式覆盖了工作区，知识库插件也应指向同一目录。

## 迭代预算与停机

同时调整 `canness-eval` 和 `canness-loop` 的共享预算键，保持评测拒绝条件与会话续轮判断一致。下列值来自 bundle 或代码默认值。

- `maxIterations: 10` 限制有效迭代数。编译失败和超时分别计入自己的计数。
- `maxCompileRetries: 3` 限制累计编译失败次数。累计超时达到 2 次也会停止。
- `negativeStreakLimit: 3` 限制未改善的非通过结果连续次数。
- `convergenceThreshold: 0.05` 是最近两次通过用时的相对差阈值。
- `stallRounds: 2`、`stallGain: 0.03`、`stallGap: 1.5` 配合判断停滞。默认需要最近两轮各自改善小于 3%，且最新用时至少为目标的 1.5 倍。
- 最近报告通过且用时达到目标时，停机条件包含 `targetMet`。多个条件同时满足时，工具使用[策略实现](../../plugin/src/policy.ts)规定的优先级。
- `minSteerIntervalMs: 30000` 和 `maxSteerPerReport: 3` 仅用于 `canness-loop`，限制自动提示密度。会话归属与报告待消费标记决定是否可以续轮。

`submit_spec` 对同名算子默认保留预算。显式传入 `reset: true` 可开始新的预算窗口。`run_evaluation({ force: true })` 跳过包去重，仍受预算约束。

## CANNLab 连接服务

`canness-remote` 依赖 dsh 的 `webServer`。其配置包括 `tokenRef`（默认 `CANNLAB_GITCODE_TOKEN`）、`cacheRoot`、`keyDir`、`logPath` 与 `instance`。容量、状态和连接诊断见[安装指南](../guides/setup.md#cannlab)。
