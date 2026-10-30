# dsh-canness

## 1. 测试并构建

```bash
cd plugin && pnpm test && pnpm build
```

## 2. 安装到 dsh profile

安装 = 把包链接进 profile，并把 `dsh-canness` 写进该 profile 的 `dsh.profile.bundles`。先建一个带 Web 界面的 profile：

```bash
dsh --profile canness-web --from-default-profile web --dump-config
dsh plugin --profile canness-web add <CANNESS 仓库绝对路径>/plugin
```

从 dsh 源码仓库运行时，把 `dsh` 换成 `pnpm dsh`。完整的克隆→构建→启动流程（含 workspace 绝对路径配置）见仓库根目录的 [`README.md`](../README.md)。

注意：只有 `dsh-base + dsh-canness` 的 profile（例如 `canness`）没有 app 层，启动后没有界面；用于实际运行时要像上面这样以 `web` 为模板。

期望 `dsh --profile canness-web --dump-config` 的输出含 `# == dsh-canness` 和五行插件。`canness-eval` 的 `host`、`username`、`privateKeyPath`、`inbox`、`outbox` 以及超时与迭代参数可以在 Web 设置卡里改，保存后直接写入 profile 的 `cordis.patch.yml`，无需重启；也可以直接改该文件，但 patch 替换整份 `config`，不能只加一个键。

## 3. 认证：私钥或密码

`run_evaluation` 按以下优先级认证：配置了 `privateKeyPath` 时使用私钥；否则从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）作为密码；两者都没有时报 `ssh credentials missing`。

存密码（二选一）：

- Web UI：打开设置 → CANNESS 卡片，填入 SSH 密码后保存。密码进入 `~/.dsh/.credentials.yaml`，不写入任何配置文件。
- 命令行环境：`CANNNESS_SSH_PASSWORD=... dsh --profile canness-web`（环境变量是凭据存储的回退层）。

## 4. 远端

把 `plugin/remote/watch.py` 放到远端，放进 cron，或在上传后手动跑：

```bash
python3 watch.py --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --once
```

本机没有 CANN 时，这样就能等到 `status` 为 `pass`、`analysis.source` 为 `msprof-mock` 的 `results.json`。不调用 msprof。改用密码认证不影响这套 `watch.py` 流程。
