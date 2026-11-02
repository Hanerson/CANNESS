# dsh-canness

CANNESS 的插件包：把昇腾 CANN 算子开发的「规格书 → 四层代码 → 测试包 → 远端评测 → 按预算续轮」闭环做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 工具集。

The plugin package behind CANNESS: a DeepSeek Harness toolset for the Ascend CANN operator loop. 完整的架构、配置与远端约定见仓库根目录的 [README](../README.md)（[English](../README.en.md)）。

## 1. 安装 / Install

```bash
pnpm install
pnpm test
pnpm build
```

```bash
# 先建一个带 Web 界面的 profile，再把包链接进去
dsh --profile canness-web --from-default-profile web --dump-config
dsh plugin --profile canness-web add <CANNESS 仓库绝对路径>/plugin
```

从 dsh 源码仓库运行时，把 `dsh` 换成 `pnpm dsh`。`canness-web` 启动后的验证方式、workspace 绝对路径配置与常见问题，见根目录 README 的「快速开始」。

Only `dsh-base + dsh-canness` (for example a profile named `canness`) has no app layer and shows no UI; use the `web` template as above.

## 2. 工具 / Tools

| Tool | Purpose |
|---|---|
| `kb_search` | 按算子名检索知识库 / search the knowledge base by operator name |
| `submit_spec` | 校验规格书并开启新一轮 / validate a spec and start a generation |
| `write_operator` | 写入 kernel / host / api / plugin 四层文件 |
| `build_test_package` | 组装测试包与 `manifest.json` / assemble the test package |
| `run_evaluation` | SFTP 上传测试包并等待 `results.json` / upload and wait for the result |

## 3. 认证 / Authentication

`run_evaluation` 优先使用 `privateKeyPath`；未配置时从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）；两者都没有时报 `ssh credentials missing`。

The password can be stored from the Web UI (Settings → CANNESS, written to `~/.dsh/.credentials.yaml`) or supplied as the `CANNNESS_SSH_PASSWORD` environment variable.

## 4. 远端 / Remote

把 [`remote/watch.py`](remote/watch.py) 放到远端即可在没有 CANN 的机器上模拟评测：

```bash
python3 watch.py --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --once
```

Put it in cron, or run it manually after an upload. It writes `results.json` with `status: "pass"` and `analysis.source: "msprof-mock"`; it does not call msprof.

## 5. 开发 / Development

```bash
pnpm test     # Vitest
pnpm check    # host + client 两份 tsconfig
pnpm build    # tsc + esbuild → lib/
```

`lib/` 是 dsh 实际加载的产物，改完源码必须重新 build。The profile links this directory, so `plugin add` is not needed again after the first install.

## 6. 许可 / License

[MIT](../LICENSE)
