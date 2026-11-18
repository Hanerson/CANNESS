# 安装与配置

## 本地环境

项目使用 Node.js ≥ 24.9；CI 使用 Node.js 24 和 pnpm 11。插件清单声明 dsh `>=0.2.0 <0.3.0`，插件依赖对照 `0.2.1-rc.3`，验收记录中也使用过 `0.2.2-rc.2`。具体版本以[包声明](../../plugin/package.json)、[CI](../../.github/workflows/ci.yml)和[验收记录](../../tickets/TODO.md)为准。

在仓库根目录安装并构建插件：

```bash
pnpm --dir plugin install --frozen-lockfile
pnpm --dir plugin build
```

## dsh Web profile

```bash
dsh --profile canness-web --from-default-profile web --dump-config
dsh plugin --profile canness-web add "/absolute/path/to/CANNESS/plugin"
dsh --profile canness-web
```

Windows 路径可写成 `D:/projects/CANNESS/plugin`。使用 dsh 源码时，先构建 dsh，然后在其仓库用 `pnpm dsh` 运行同一组命令。保持 CANNESS 插件路径为绝对路径。

`--dump-config` 用于创建和检查 profile 组合，`plugin add` 将插件链接到该 profile。Web profile 应包含 `@deepseek-ai/dsh-web-app` 与 `dsh-canness`。启动后在 **设置 → CANNESS** 检查连接与目录设置，在会话中通过 `kb_search({ operator_name: "Exp" })` 检查插件和知识库路径。仅启用基础 bundle 的 CLI profile 需要从组合中移除依赖 `webServer` 的 `canness-remote` 行。

## 知识库与工作区路径

bundle 的 `kbRoot` 默认是 `./plugin/knowledge_base`，相对于 dsh 进程的当前目录。若从其他目录启动，或使用自定义语料，在 `~/.dsh/profiles/canness-web/cordis.patch.yml` 为知识插件设绝对路径：

```yaml
- id: canness-knowledge
  config:
    kbRoot: "/absolute/path/to/CANNESS/plugin/knowledge_base"
```

生成、评测和循环的 `workspace` 默认**就是会话工作目录**：`operators/`、`packages/`、`submissions/`、`.canness/` 直接位于该目录，不再嵌套 `canness-workspace/`。拿不到绝对会话目录时，插件使用进程 cwd。需要固定位置时，在 `canness-generator`、`canness-eval` 和 `canness-loop` 三行中设置相同的绝对路径。profile 补丁中的 `config` 会替换对应行的配置；手工覆盖评测或循环行时，保留该行已有的必填项。配置值见[配置参考](../reference/configuration.md)。

## 连接 NPU

### 直接 SSH

在设置卡填写 SSH 主机、端口、用户名和认证方式，再配置远端 `inbox` 与 `outbox`。使用对该账号可写的目录。自管目标机需要 Bash、Python、`base64`、`tar` 和包含 `bisheng`、`msprof` 的 CANN 环境。多套 toolkit 并存时可设 `setEnv` 选择其 `set_env.sh`。

配置了 `privateKeyPath` 时使用私钥。否则通过 dsh 凭据引用 `CANNNESS_SSH_PASSWORD` 解析密码，引用名可经 `passwordEnv` 配置。设置卡保存密码到 dsh 凭据存储，配置中保留引用。设置卡的连接测试用于 TCP 连通检查；有测试包后可以用 `preflight_evaluation({ remote: true })` 核对 SSH 认证和工具链。

### CANNLab

在 **设置 → CANNESS → CANNLab 云端环境** 中连接。插件使用浏览器 GitCode 授权、CANNLab 实例信息和官方 Dev Space 转发 helper 建立本地 SSH 隧道，并将连接参数保存到评测配置。

- 环境名留空时选择唯一运行的环境。有多个环境时填写名称或 ID。连接到明确选择的已停机实例时，插件可尝试启动并等待最多 90 秒。实例状态、额度和停机操作在 CANNLab 控制台查看。
- 浏览器 OAuth 使用本机回调端口 `3000`。连接尝试默认记录在 `~/.dsh/canness/cannlab/last-connect.log`。
- GitCode refresh token 保存到凭据引用 `CANNLAB_GITCODE_TOKEN`；access token 用于本次操作。临时私钥默认保存在 `~/.dsh/canness/cannlab/`，helper 默认缓存在 `~/.dsh/canness/devspace-helper/`。
- 连接丢失后，通过设置卡重连，再在原会话工作区重新调用评测工具。部署路径和恢复步骤见[远端评测指南](remote-evaluation.md)。
