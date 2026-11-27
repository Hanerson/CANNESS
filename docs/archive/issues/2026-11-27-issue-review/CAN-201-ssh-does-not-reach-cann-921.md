# CAN-201 两条 SSH 预检都返回 ready，输出不区分工具链版本和转发配置

| 字段 | 值 |
|---|---|
| 类型 | 设计 |
| 优先级 | **P2** |
| 组件 | `canness-eval` 预检、远端部署 |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `remote`, `preflight`, `toolchain` |
| 复核 | 2026-11-27。由 P0 降为部署识别问题 |

## 现象

插件评测经 SSH 在远端会话里找 `set_env.sh`、`bisheng` 和 `msprof`。2026-11-27 复核在这台机器上跑了插件自己的预检，两条端点都返回 `ready: true`。

- 经 `127.0.0.1:20022` 进入容器：自动发现和显式 `setEnv` 两次预检都通过。`bisheng` 与 `msprof` 位于 CANN 9.2.1 目录下。
- 宿主机直连同样 `ready: true`。它的 `bisheng` 位于 `latest/compiler/ccec_compiler/bin/`，是另一套工具链。

两侧都打印 clang 版本。预检已返回 `endpoint`、`compiler`、`msprof`、`setEnv` 和 `searchedEnv`。`toolchain` 可能是 CANN 版本，也可能是编译器版本。缺少独立的 `cannVersion`、`compilerVersion` 和 `toolkitHome`。手工 SSH 转发的拓扑由部署配置说明。

## 证据

2026-11-27 复核：

- 容器经 `127.0.0.1:20022`：插件自动预检与显式 `setEnv` 预检均为通过。`bisheng`、`msprof` 在 CANN 9.2.1 下。容器 `compiler/version.info` 为 `Version=9.2.1`。
- 宿主机直连：同一 runner 预检 `ready: true`。`bisheng` 路径为 `latest/compiler/ccec_compiler/bin/`。
- 两侧 `bisheng --version` 都显示 clang。
- `plugin/cordis.patch.yml` 默认端口是 22。`plugin/src/eval-run.ts` 的 `runnerCommand` 在 SSH 会话里启动 `runner.py`。仓库没有 `docker exec` 传输。

复核订正：初稿写「宿主机缺少 `bisheng`，预检会失败」。复核两条路径都是 `ready: true`。宿主机直连是另一套仍显示就绪的工具链。

## 影响

`ready: true` 不能说明当前会话用的是容器内 CANN 9.2.1。宿主机 `latest` 工具链同样能通过预检。后续编译、性能和提交验收会落在操作者没有从预检里读出来的那套编译器上。

## 期望

预检分别报告 CANN 版本、编译器版本、工具链路径，并记录转发配置：端口、`setEnv` 的最终路径、会话是宿主机直连还是进入容器。两条端点的记录彼此独立。

## 复现

1. 对容器转发 `127.0.0.1:20022` 做自动预检和显式 `setEnv` 预检。
2. 对宿主机 22 端口再做一次预检。
3. 对照两份 JSON 里的 `ready`、`bisheng` 路径和版本字段。

## 建议修复

- 保留既有端点和路径字段，预检补充独立 `cannVersion`、`compilerVersion` 和 `toolkitHome`。
- 文档把「宿主机 22」和「容器 20022」写成两个要核对的端点，并写明各自的工具链路径。
- 默认端口 22 的配置说明指向宿主机工具链；使用容器时显式写转发端口和 `setEnv`。

## 验收标准

- 一次预检的 JSON 能读出实际端点、CANN 版本、编译器版本和 `bisheng` 路径。
- 容器端点的 `bisheng` 位于 CANN 9.2.1 下；宿主机直连端点单独报告 `latest/compiler/ccec_compiler/bin/`。
- 两份结果都是 `ready: true` 时，报告仍能看出它们不是同一套工具链。

## 关联

CAN-202、[部署记录](NOTE-remote-deployment.md)。

## 处置和验证

预检单列 CANN 版本、编译器版本和工具链根，保留实际 SSH 端点。宿主机和容器均已远端复验。手工转发拓扑见部署说明。 [修复前预检](evidence/preflight.json) [修复后预检](evidence/preflight-after.json)
