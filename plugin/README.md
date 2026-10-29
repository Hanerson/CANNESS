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

## 3. 远端

把 `plugin/remote/watch.py` 放到远端，放进 cron，或在上传后手动跑：

```bash
python3 watch.py --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --once
```

本机没有 CANN 时，这样就能等到 `status` 为 `pass`、`analysis.source` 为 `msprof-mock` 的 `results.json`。不调用 msprof。
