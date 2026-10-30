# dsh-canness

## 1. 测试并构建

```bash
cd plugin && pnpm test && pnpm build
```

## 2. 安装到 canness profile

有 `dsh` 时，在仓库根目录执行（`./plugin` 相对仓库根；不要在 `plugin/` 目录里再写一层 `./plugin`）：

```bash
dsh plugin --profile canness add ./plugin
dsh --profile canness --dump-config
```

期望输出含 `# == dsh-canness`。保留 dump 里的每一个键，只填写 `canness-eval` 的 `host`、`username` 和 `privateKeyPath`。不要把整段 `config` 改成只剩这三个字段。patch 替换整份 `config`，不能只加一个键。

`canness-eval` 的字段（`host`、`username`、`privateKeyPath`、`inbox`、`outbox`，以及超时与迭代参数）现在也可以在 Web 设置卡里改。设置卡保存后直接写入 profile 的 `cordis.patch.yml`，无需重启。

## 3. 认证：私钥或密码

`run_evaluation` 按以下优先级认证：配置了 `privateKeyPath` 时使用私钥；否则从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）作为密码；两者都没有时报 `ssh credentials missing`。

存密码（二选一）：

- Web UI：打开设置 → CANNESS 卡片，填入 SSH 密码后保存。密码进入 `~/.dsh/.credentials.yaml`，不写入任何配置文件。
- 命令行环境：`CANNNESS_SSH_PASSWORD=... dsh --profile canness`（环境变量是凭据存储的回退层）。

## 4. 远端

把 `plugin/remote/watch.py` 放到远端，放进 cron，或在上传后手动跑：

```bash
python3 watch.py --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --once
```

本机没有 CANN 时，这样就能等到 `status` 为 `pass`、`analysis.source` 为 `msprof-mock` 的 `results.json`。不调用 msprof。改用密码认证不影响这套 `watch.py` 流程。
