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
| `build_test_package` | 组装四层 + 构建契约 + `config.json` / `manifest.json` / assemble the build-contract package |
| `write_package_file` | 只写 `golden.h`（精度参考的唯一模型扩展点）/ write `golden.h` only |
| `run_evaluation` | 上传测试包，远端 `build.sh → run_once.sh → msprof`，等待 `results.json` |

## 3. 认证 / Authentication

`run_evaluation` 优先使用 `privateKeyPath`；未配置时从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）；两者都没有时报 `ssh credentials missing`。

The password can be stored from the Web UI (Settings → CANNESS, written to `~/.dsh/.credentials.yaml`) or supplied as the `CANNNESS_SSH_PASSWORD` environment variable.

CANNLab 连接的 GitCode 凭据是另一套：只持久化 refresh token，引用名 `CANNLAB_GITCODE_TOKEN`（`canness-remote` 的 `tokenRef` 可改名），access token 不落盘。

The CANNLab connection uses a separate credential: only the refresh token is persisted, under `CANNLAB_GITCODE_TOKEN` (renameable via `canness-remote`'s `tokenRef`); the access token never touches disk.

## 4. 远端 / Remote

`build_test_package` 在四层之外渲染**构建契约 v1**：`build.sh`、`run_once.sh`、`main.cpp`、
`golden.h`、`canness_tiling.h`，并写 `config.json`（按 dtype 推导 `maxAbsErr`）与
`manifest.json`（`files` 为实际落盘清单，`layers` 为四层）。`main.cpp` / `build.sh` 是算子
无关的骨架；kernel 入口固定为 `canness_kernel`（输入 → 输出 → tiling）。模型只通过
`write_package_file('golden.h', ...)` 填精度公式；占位实现会让评测返回 `accuracy_fail`
与 `golden not implemented`，不会假通过。

```bash
# 远端手工复现（runner 由 run_evaluation 以 runner-<uuid>.py 上传到 dirname(inbox)）
python3 /tmp/canness/runner-<uuid>.py \
  --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --generation <gen> --once
```

`run_evaluation` 上传测试包后，由 [`remote/runner.py`](remote/runner.py) 执行包的
`build.sh`、`run_once.sh` 和真实 `msprof`，`kernelTimeUs` 只来自
`mindstudio_profiler_output/*.csv`。若 SSH 端点是 CANNLab 隧道，连接前会检查 helper 心跳；
隧道断开时返回 `status: "error"` 与 `tunnel is down; reconnect from Settings → CANNESS`。

`build_test_package` renders build contract v1 on top of the four layers: `build.sh`,
`run_once.sh`, `main.cpp`, `golden.h`, `canness_tiling.h`, plus `config.json` (dtype-derived
`maxAbsErr`) and `manifest.json` (`files` = actual on-disk list, `layers` = the four layers).
`main.cpp` / `build.sh` are operator-independent; the kernel entry is fixed to `canness_kernel`
(inputs, then outputs, then tiling). The model only owns `golden.h` through
`write_package_file`; the placeholder yields `accuracy_fail` / `golden not implemented`, never a
fake pass. `run_evaluation` uploads the package, then `remote/runner.py` runs `build.sh`,
`run_once.sh` and the real `msprof`; `kernelTimeUs` comes only from
`mindstudio_profiler_output/*.csv`. A CANNLab tunnel is heartbeat-checked before connecting, and a
dead tunnel returns `status: "error"` with `tunnel is down; reconnect from Settings → CANNESS`.

### 连接到 CANNLab / Connect to CANNLab

CANNLab 不开放入站 SSH，只提供经由官方 Dev Space 扩展的签名隧道。设置卡上的「连接到 CANNLab」把这条路走完：浏览器 GitCode 授权 → 列出账号里运行中的环境 → 拉临时私钥与隧道地址 → 下载并启动官方端口转发 helper → 把 `host`/`port`/`username`/`privateKeyPath` 回填到 `canness-eval` 并保存。整条流程需要宿主侧的 `canness-remote` 行（`dsh-canness/remote-api`，Web profile 才有 `webServer`）。

CANNLab has no inbound SSH, only a signed tunnel through the official Dev Space extension. The card's “Connect to CANNLab” runs the whole path: browser GitCode authorization → list the running environment → fetch its temporary key and tunnel URL → download and start the official forwarding helper → fill `host`/`port`/`username`/`privateKeyPath` into `canness-eval` and save. It needs the Host-side `canness-remote` row (`dsh-canness/remote-api`), which requires the `webServer` service a Web profile provides.

每次尝试的完整轨迹（含失败原因）写在 `~/.dsh/canness/cannlab/last-connect.log`；refresh token 只存进凭据引用 `CANNLAB_GITCODE_TOKEN`。细节见根目录 README 的 [9.4](../README.md#94-连接-cannlab免费-npu-云环境)。

Every attempt is traced, failure reason included, in `~/.dsh/canness/cannlab/last-connect.log`; the refresh token lives only in the credential reference `CANNLAB_GITCODE_TOKEN`. Details: [9.4](../README.en.md#94-connecting-to-cannlab-free-cloud-npu).

## 5. 开发 / Development

```bash
pnpm test     # Vitest
pnpm check    # host + client 两份 tsconfig
pnpm build    # tsc + esbuild → lib/
```

`lib/` 是 dsh 实际加载的产物，改完源码必须重新 build。The profile links this directory, so `plugin add` is not needed again after the first install.

## 6. 许可 / License

[MIT](../LICENSE)
