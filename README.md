# CANNESS

面向昇腾 CANN 算子开发的多智能体辅助系统，以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）插件的形式交付。

- 仓库地址：<https://github.com/Hanerson/CANNESS>
- 插件包：`plugin/`，包名 `dsh-canness`
- 设计基准：[`docs/ref/项目支持/02-核心设计/05-CANNESS插件化架构设计.md`](docs/ref/项目支持/02-核心设计/05-CANNESS插件化架构设计.md)
- 当前状态：MVP、SSH 密码认证与 Web 设置卡已实现，单元测试全绿；真实 SSH 主机上的端到端验收尚未进行

## 目录

- [1. 这个仓库是什么](#1-这个仓库是什么)
- [2. 目录结构](#2-目录结构)
- [3. 环境要求](#3-环境要求)
- [4. 从克隆到本地启动](#4-从克隆到本地启动)
- [5. 怎么用](#5-怎么用)
- [6. 认证与远端](#6-认证与远端)
- [7. 开发](#7-开发)
- [8. 常见问题](#8-常见问题)
- [9. 文档索引](#9-文档索引)

## 1. 这个仓库是什么

CANNESS 把「提交规格书 → 生成四层算子代码 → 打测试包 → 上传远端 → 等待评测结果 → 按预算续轮」这条流程做成 dsh 插件的工具集：

| 插件 | 提供的工具 | 职责 |
|---|---|---|
| `dsh-canness/knowledge` | `kb_search` | 检索算子知识库 |
| `dsh-canness/generator` | `submit_spec`、`write_operator`、`build_test_package` | 规格书解析、四层文件落盘、组装测试包 |
| `dsh-canness/eval` | `run_evaluation` | SFTP 上传测试包并轮询 `results.json` |
| `dsh-canness/loop` | — | 读取评测结果，按预算 steer 续轮 |

插件不负责通用能力：CLI、配置、LLM、会话、日志、凭据都由 dsh 提供。本地不编译算子、不调用 CANN、不调用云端 API；真实评测只发生在远端主机上。

## 2. 目录结构

```
CANNESS/
├── plugin/                        # dsh-canness 插件包
│   ├── src/                       # TypeScript 源码（host 半区 + client 半区）
│   │   └── client/                # Web 设置卡（浏览器半区）
│   ├── tests/                     # Vitest 单元测试
│   ├── knowledge_base/            # 知识库夹具
│   ├── remote/watch.py            # 远端 mock 结果生成器
│   ├── scripts/build-client.mjs   # 浏览器半区打包脚本
│   ├── cordis.patch.yml           # bundle 的默认配置层
│   └── README.md                  # 包级说明
├── docs/
│   ├── ref/项目支持/02-核心设计/  # 01–05 设计文档，05 为实施基准
│   └── superpowers/               # spec 与实现计划
└── README.md                      # 本文件
```

## 3. 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | `>= 24.9.0` |
| pnpm | `>= 10`（实测 `11.28.5`） |
| dsh | `>= 0.2.0 < 0.3.0`（当前对照版本 `0.2.1-rc.3`） |
| 远端主机（可选） | Linux + sshd；真实 CANN/msprof 可选，mock 不需要 |

dsh 有两种来源，任选一种：

- **已安装的 CLI**：命令写作 `dsh ...`
- **dsh 源码仓库**：命令写作 `pnpm dsh ...`，需要先在该仓库执行 `pnpm install && pnpm run build`

下文两个版本都会给出。

> Windows 建议使用 Git Bash。`dsh plugin add` 既接受相对路径（相对执行命令时的目录），也接受绝对路径；为避免歧义，下文统一使用绝对路径。

## 4. 从克隆到本地启动

整个过程分五步：构建插件 → 准备 profile → 固定绝对路径 → 启动 → 验证。

### 4.1 克隆并构建插件

```bash
git clone https://github.com/Hanerson/CANNESS.git
cd CANNESS/plugin
pnpm install
pnpm test
pnpm build
```

`pnpm build` 会编译 host 半区（`lib/*.js`）并用 esbuild 打包 Web 设置卡（`lib/client.js`）。dsh 加载的是 `lib/`，**每次改完源码都要重新 build**。`lib/` 和 `node_modules/` 已被 `.gitignore` 忽略，克隆后必须自己构建。

### 4.2 准备一个带 Web 界面的 profile

dsh 的「安装插件」= 把包链接进某个 profile，并把包名写进该 profile 的 `dsh.profile.bundles`。`dsh plugin add` 会同时完成这两件事。

先创建一个以 Web 为模板的专用 profile（`canness-web`）：

```bash
# 已安装的 dsh
dsh --profile canness-web --from-default-profile web --dump-config

# 或：dsh 源码仓库根目录
cd /path/to/deepseek-harness
pnpm dsh --profile canness-web --from-default-profile web --dump-config
```

`--dump-config` 只创建 profile 并打印组合结果，不启动服务；去掉它也可以，只是会直接拉起 Web。

然后把插件装进去（把 `/abs/path/to/CANNESS/plugin` 换成你克隆后的绝对路径）：

```bash
# 已安装的 dsh
dsh plugin --profile canness-web add /abs/path/to/CANNESS/plugin

# 或：dsh 源码仓库根目录
pnpm dsh plugin --profile canness-web add /abs/path/to/CANNESS/plugin
```

Windows 示例：

```bash
pnpm dsh plugin --profile canness-web add D:/projects/CANNESS/plugin
```

安装成功后，`~/.dsh/profiles/canness-web/package.json` 的 `bundles` 会变成：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-canness"]
```

> pnpm 会打印 peerDependencies 警告。这是正常的：dsh 运行时提供这些 peer，不需要装进 profile。

### 4.3 在 profile 层固定绝对路径

插件 bundle 自带的 `cordis.patch.yml` 使用相对路径：

```yaml
kbRoot: ./plugin/knowledge_base
workspace: ./canness-workspace
```

这些值按 **dsh 进程的 cwd** 解析。从 dsh 仓库启动时，它们会指错目录。把下面这段写进 `~/.dsh/profiles/canness-web/cordis.patch.yml`（路径换成你的仓库位置）：

```yaml
# dsh 的 patch 会替换目标行的整个 config，所以每个键都要重述。
- id: canness-knowledge
  config:
    kbRoot: D:/projects/CANNESS/plugin/knowledge_base

- id: canness-generator
  config:
    workspace: D:/projects/CANNESS/canness-workspace

- id: canness-eval
  config:
    workspace: D:/projects/CANNESS/canness-workspace
    host: ''
    port: 22
    username: ''
    privateKeyPath: ''
    inbox: /tmp/canness/inbox
    outbox: /tmp/canness/outbox
    timeoutSec: 1800
    pollIntervalMs: 2000
    maxIterations: 10
    maxCompileRetries: 3
    negativeStreakLimit: 3
    convergenceThreshold: 0.05

- id: canness-loop
  config:
    workspace: D:/projects/CANNESS/canness-workspace
    maxIterations: 10
    maxCompileRetries: 3
    negativeStreakLimit: 3
    convergenceThreshold: 0.05
```

`canness-workspace/` 会在第一次生成算子时自动创建。

### 4.4 启动

```bash
# 已安装的 dsh
dsh --profile canness-web

# 或：dsh 源码仓库根目录
pnpm dsh canness-web
```

终端会打印 `dsh web: http://127.0.0.1:<port>/?token=...`，用浏览器打开即可。常用参数：`--no-open` 不自动打开浏览器，`--port 0` 让系统选空闲端口，`--host 127.0.0.1` 指定绑定地址。

### 4.5 验证安装

```bash
# 已安装的 dsh
dsh --profile canness-web --dump-config | grep -A 8 "== dsh-canness"

# 或：dsh 源码仓库根目录
pnpm dsh --profile canness-web --dump-config | grep -A 8 "== dsh-canness"
```

应该看到五行：`canness`、`canness-knowledge`、`canness-generator`、`canness-eval`、`canness-loop`。

启动后，在 Web UI 的 **设置 → CANNESS** 可以看到设置卡；对话里让模型调用 `kb_search`、`submit_spec` 等工具即可验证插件已加载。

## 5. 怎么用

典型流程（由模型在对话中驱动，也可以手工调用工具）：

1. `submit_spec`：提交算子规格书，写入 `{workspace}/.canness/state.json`。
2. `write_operator`：写入四层文件：
   - `op_kernel/kernel.cpp`
   - `op_host/host.cpp`
   - `op_api/api.cpp`
   - `op_plugin/plugin.py`
3. `build_test_package`：把四层文件和 `manifest.json` 组装到 `{workspace}/packages/<generationId>/`。
4. `run_evaluation`：按配置的 SFTP 连接上传测试包，轮询远端 `results.json`。
5. `canness-loop`：读取结果，按 `maxIterations`、`maxCompileRetries`、`negativeStreakLimit`、`convergenceThreshold` 决定是否续轮。

`kb_search` 可随时检索 `knowledge_base/` 下的算子知识，返回正文上限 8000 字符。

评测结果的结构、状态字段和续轮规则见设计文档 02/03。

## 6. 认证与远端

### 6.1 SSH 认证

`run_evaluation` 的认证优先级：

1. 配置了 `privateKeyPath` → 用私钥；
2. 否则从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）→ 用密码；
3. 两者都没有 → 报 `ssh credentials missing`。

存密码有两种方式：

- **Web UI**：设置 → CANNESS 卡片，填入 SSH 密码后保存。密码写入 `~/.dsh/.credentials.yaml`，不进入任何配置文件。
- **环境变量**：`CANNNESS_SSH_PASSWORD=... dsh --profile canness-web`（凭据存储的回退层）。

### 6.2 远端 mock

没有 CANN 环境时，用 `plugin/remote/watch.py` 模拟评测结果。把脚本放到远端，然后：

```bash
python3 watch.py --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --once
```

放进 cron 或在上传后手动执行。插件只做两件事：SFTP 上传、轮询结果文件；不在本地或通过 SSH 执行 cmake / kernel_eval，也不调用 msprof。mock 产出的 `results.json` 中 `status` 为 `pass`、`analysis.source` 为 `msprof-mock`。

## 7. 开发

```bash
cd plugin
pnpm test          # Vitest，全部单测
pnpm check         # host + client 两份 tsconfig 类型检查
pnpm build         # tsc + esbuild，产出 lib/
```

开发循环：

1. 修改 `plugin/src/`；
2. `pnpm test && pnpm check && pnpm build`；
3. 重启 dsh（profile 的 patch 配置会热加载，但模块代码不会重载）。

profile 里安装的是**符号链接**，指向 `plugin/` 目录，所以不需要反复 `plugin add`；但**必须重新 `pnpm build`**，dsh 才能看到新的 `lib/`。

约束：

- dsh 插件只能写 TypeScript/ESM；Python 只出现在 `plugin/remote/watch.py` 和知识库正文里。
- 浏览器半区只能 value-import dsh frozen module table 里的包（`react`、`cordis`、`dsh-client-*` 等），其余由 esbuild 内联。
- 预算四字段在 `canness-eval` 和 `canness-loop` 各写一份，两处数字必须相同。

## 8. 常见问题

**Q：`dsh web --patch ./plugin/cordis.patch.yml` 报 `Cannot find package 'dsh-canness'`？**

`--patch` 只贡献配置行，模块解析仍发生在 profile 目录。这个插件有多个子路径入口，必须先 `dsh plugin add` 进对应 profile。

**Q：`pnpm dsh canness` 启动了但没有任何界面？**

`canness` profile 只有 `dsh-base + dsh-canness`，没有 app 层。用本文的 `canness-web`（`--from-default-profile web`）启动，或给 profile 的 bundles 补 `@deepseek-ai/dsh-web-app`。

**Q：知识库搜不到 / 工作区写到了奇怪的位置？**

bundle 默认的相对路径按 dsh 进程 cwd 解析。按 4.3 在 profile 的 `cordis.patch.yml` 里写绝对路径。

**Q：启动时报 `Cannot find module .../lib/index.js`？**

没有构建。在 `plugin/` 执行 `pnpm build`。

**Q：pnpm 警告 peerDependencies 未解析？**

正常。dsh 运行时提供这些 peer，`plugin add` 使用链接安装，不会把 peer 装进 profile。

**Q：dsh 版本不满足 `engines.dsh`？**

插件声明 `>=0.2.0 <0.3.0`。换用 `0.2.1-rc.3` 附近的 dsh，或同步修改 `plugin/package.json` 的 `engines.dsh` 与 peer 版本。

## 9. 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/ref/项目支持/02-核心设计/05-CANNESS插件化架构设计.md`](docs/ref/项目支持/02-核心设计/05-CANNESS插件化架构设计.md) | 当前实施基准：插件边界、工具契约、状态与传输 |
| [`docs/superpowers/plans/2026-10-29-dsh-canness-mvp.md`](docs/superpowers/plans/2026-10-29-dsh-canness-mvp.md) | MVP 实现计划（TDD 步骤） |
| [`docs/superpowers/specs/2026-10-30-canness-ssh-credentials-design.md`](docs/superpowers/specs/2026-10-30-canness-ssh-credentials-design.md) | SSH 密码认证与设置卡设计 |
| [`docs/superpowers/plans/2026-10-30-canness-ssh-password-auth.md`](docs/superpowers/plans/2026-10-30-canness-ssh-password-auth.md) | SSH 密码认证与设置卡实现计划 |
| [`plugin/README.md`](plugin/README.md) | 包级构建、profile 安装与远端说明 |

01–04 是插件化改造前的总体设计，读 05 时不必先读它们；涉及 CLI、配置、编排、LLM 层的旧结论已被 05 取代。
