# CANNESS

**面向昇腾 CANN 算子开发的智能体插件** —— 以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）插件形式交付。

把「提交规格书 → 生成四层算子 → 打测试包 → 上传远端 → 等待评测 → 按预算续轮」这条闭环，交给 dsh 的 agent loop 驱动；CANNESS 只负责其中的领域契约。

[![version](https://img.shields.io/badge/version-v0.2.1-blue.svg)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A524.9-brightgreen.svg)](https://nodejs.org/)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.3-purple.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![tests](https://img.shields.io/badge/tests-51%20passing-brightgreen.svg)](plugin/tests)

**简体中文** | [English](README.en.md)

---

## 目录

- [1. 为什么需要 CANNESS](#1-为什么需要-canness)
- [2. 特性](#2-特性)
- [3. 架构](#3-架构)
- [4. 一次完整回合](#4-一次完整回合)
- [5. 环境要求](#5-环境要求)
- [6. 快速开始](#6-快速开始)
- [7. 工具参考](#7-工具参考)
- [8. 配置参考](#8-配置参考)
- [9. 远端约定](#9-远端约定)
- [10. 认证与凭据](#10-认证与凭据)
- [11. 工作区结构](#11-工作区结构)
- [12. 开发](#12-开发)
- [13. 已知限制与路线图](#13-已知限制与路线图)
- [14. 常见问题](#14-常见问题)
- [15. 文档](#15-文档)
- [16. 许可](#16-许可)

## 1. 为什么需要 CANNESS

昇腾算子开发（AscendC）的循环很长：写规格书 → 实现 kernel / host / api / plugin 四层 → 编译 → 精度与性能验证 → 读 msprof 数据 → 改代码。真正昂贵的不是某一次编译，而是**每一轮都要人工搬运和判断**：复制文件、登录机器、等结果、读懂日志、决定下一步改哪里。

CANNESS 把这个循环交给智能体，但把边界划得很清楚：

| 归属 | 负责什么 |
|---|---|
| **dsh** | CLI、配置、LLM 路由、agent 编排、会话日志、Web UI、凭据存储 |
| **CANNESS 插件** | 领域契约：规格书、四层文件、测试包、评估报告、知识库、迭代预算 |
| **远端主机** | 真正跑编译、精度校验、性能采集与 msprof |

本地**不编译算子、不调用 CANN、不调用任何云 API**。评测只发生在远端那台装了 CANN 工具链（含 `bisheng` 与 `msprof`）的机器上，CANNESS 对它只有一个要求：能 SSH 登录。`run_evaluation` 上传测试包后，由 `remote/runner.py` 依次执行包内 `build.sh`、`run_once.sh` 与真实 `msprof`（见 [9.1](#91-目录布局)）。

## 2. 特性

- **规格书驱动** —— `submit_spec` 逐字段校验；缺字段直接失败并给出字段路径，由模型回头追问用户，不写半成品状态。
- **四层落盘** —— `write_operator` 一次写入 `op_kernel` / `op_host` / `op_api` / `op_plugin` 四个文件。
- **测试包自包含** —— `build_test_package` 组装四层文件、构建契约（`build.sh` / `run_once.sh` / `main.cpp` / `golden.h` / `canness_tiling.h`）、`config.json` 与 `manifest.json`，远端拿到即可编译运行。
- **通用 SSH 传输** —— 基于 `ssh2` 的 `exec` + base64 tar 上传（不依赖远端 `sftp-server`）+ 结果轮询；私钥与密码两种认证，密码走 dsh 凭据存储。
- **预算与停机** —— 有效迭代、编译重试、超时、性能连续变差、收敛、目标达成，六类条件独立判定。
- **自动续轮** —— `canness-loop` 在 `agent/turn-stopping` 处 `steer` 一轮带评测上下文的增强块，不需要用户手动催。
- **性能分析内建** —— 解析 msprof 形状的 `analysis`（瓶颈类型、MAC/MTE2/Scalar 比例、cube 利用率），失败原因直接进提示。
- **Web 设置卡** —— 设置 → CANNESS，改主机、路径、预算后保存即生效（volatile 配置），不用重启。
- **可重放** —— 每轮工具入参与结果都进 dsh 会话日志，「模型可见即已记录」。

## 3. 架构

```
┌───────────────────────────── dsh (deepseek-harness) ─────────────────────────────┐
│  CLI · 配置分层 · LLM 路由 · 会话日志 · Web UI · 凭据存储                        │
│                                                                                  │
│  agent loop ──► tool pipeline ──► 事件总线（agent/pre-step、agent/turn-stopping）│
│  工具注册 · 配置热更新 · 会话日志 · 凭据存储                                     │
└────────────────────────────────────────▲─────────────────────────────────────────┘
                                         │  工具调用 / 工具结果 / 事件
┌────────────────────────────────────────┴─────────────────────────────────────────┐
│ dsh-canness（bundle）                                                            │
│                                                                                  │
│  canness-knowledge  ──► kb_search                                                │
│  canness-generator  ──► submit_spec · write_operator · build_test_package        │
│                     ──► write_package_file（仅 golden.h）                        │
│  canness-eval       ──► run_evaluation · fetch_remote_file ─ SSH exec ─► NPU 主机│
│  canness-loop       ──► 预算与停机策略（两个事件监听器）                         │
│  canness (client)   ──► Web 设置卡                                               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 插件清单

| 插件 id | 入口 | 注册的工具 | 监听的事件 |
|---|---|---|---|
| `canness` | `dsh-canness` | — | — （只作为浏览器半区的挂载行） |
| `canness-knowledge` | `dsh-canness/knowledge` | `kb_search` | — |
| `canness-generator` | `dsh-canness/generator` | `submit_spec`、`write_operator`、`build_test_package`、`write_package_file` | — |
| `canness-eval` | `dsh-canness/eval` | `run_evaluation`、`fetch_remote_file` | — |
| `canness-loop` | `dsh-canness/loop` | — | `agent/pre-step`、`agent/turn-stopping` |
| `canness-remote` | `dsh-canness/remote-api` | — | — （在 `webServer` 上提供连通检查与 CANNLab 连接的路由，见 9.4） |

四个 host 插件共享 `{workspace}/.canness/state.json`；`canness` 这一行本身没有逻辑，但浏览器半区只挂在裸包名那一行上，删掉它设置卡就不会出现。`canness-remote` 是唯一需要 `webServer` 服务的行，无 Web 界面的 profile 不必加载它。

### 控制权划分

模型只决定「下一步做什么」，三类闸门都在代码里：

| 闸门 | 载体 | 作用 |
|---|---|---|
| 工具校验 | 工具参数 schema | 什么能做（例如未 `submit_spec` 不允许 `write_operator`） |
| 事件监听 | `agent/pre-step` / `agent/turn-stopping` | 注入什么上下文、要不要再跑一轮 |
| 服务内规则 | `policy.ts` | 什么算一次有效迭代、什么时候停 |

## 4. 一次完整回合

```mermaid
flowchart LR
  U[用户请求] --> S[submit_spec]
  S --> K[kb_search]
  K --> W[write_operator]
  W --> B[build_test_package]
  B --> E[run_evaluation]
  E -->|上传测试包 / 轮询| R[(远端 NPU 主机)]
  R -->|results.json| E
  E --> L{预算与停机}
  L -->|未达成| K
  L -->|达成或停机| O[输出最优算子与报告]
```

1. 用户提出需求：「Add，float16，910B，kernel_time ≤ 8us」。
2. `submit_spec` 校验规格书，生成 `generationId`（形如 `gen-1a2b3c4d`）并写状态文件。
3. `kb_search` 按算子名检索知识库，拿回参考实现与 tiling 提示。
4. `write_operator` 把四层文件写到 `{workspace}/operators/<generationId>/`。
5. `build_test_package` 组装 `{workspace}/packages/<generationId>/`：四层 + 构建契约 + `config.json` + `manifest.json`；模型需要时用 `write_package_file('golden.h', ...)` 填精度公式。
6. `run_evaluation` 上传到 `{inbox}/<generationId>/`，由远端 `runner.py` 执行 `build.sh` / `run_once.sh` / `msprof`，轮询 `{outbox}/<generationId>/results.json`，解析为评估报告作为工具结果返回。
7. `canness-loop` 依据报告与预算决定 `steer` 下一轮还是结束，并把失败上下文拼进增强块。

## 5. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | `>= 24.9.0` | 插件运行时 |
| pnpm | `>= 10` | 实测 `11.28.5` |
| dsh | `>= 0.2.0 < 0.3.0` | 对照版本 `0.2.1-rc.3` |
| 远端主机（可选） | Linux + sshd + NPU | 需要 CANN 工具链（`bisheng`、`msprof`）；编译与评测只在远端发生 |

dsh 有两种来源，任选一种，下文分别给出命令：

- **已安装的 CLI**：`dsh ...`
- **dsh 源码仓库**：`pnpm dsh ...`，需先在该仓库执行 `pnpm install && pnpm run build`

> **Windows** 建议使用 Git Bash。`dsh plugin add` 同时接受相对路径与绝对路径，本文统一使用绝对路径以免歧义。

## 6. 快速开始

五个步骤：构建插件 → 准备 profile → 固定绝对路径 → 启动 → 验证。

### 6.1 克隆并构建插件

```bash
git clone https://github.com/Hanerson/CANNESS.git
cd CANNESS/plugin
pnpm install
pnpm test
pnpm build
```

`pnpm build` 会编译 host 半区（`lib/*.js`）并用 esbuild 打包浏览器半区（`lib/client.js`）。dsh 加载的是 `lib/`，**改完源码必须重新 build**。`lib/` 与 `node_modules/` 已在 `.gitignore` 中，克隆后必须自行构建。

### 6.2 准备一个带 Web 界面的 profile

dsh 的「安装插件」= 把包链接进某个 profile，并把包名写进该 profile 的 `dsh.profile.bundles`。`dsh plugin add` 两件事一起做。

先建一个以 `web` 为模板的专用 profile（`canness-web`）：

```bash
# 已安装的 dsh
dsh --profile canness-web --from-default-profile web --dump-config

# 或：dsh 源码仓库根目录
pnpm dsh --profile canness-web --from-default-profile web --dump-config
```

`--dump-config` 只创建 profile 并打印组合结果，不启动服务。

然后安装插件（把路径换成你的克隆位置）：

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

安装成功后，`~/.dsh/profiles/canness-web/package.json` 的 `bundles` 应包含 `dsh-canness`：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-canness"]
```

> pnpm 会打印 peerDependencies 警告，这是正常的：这些 peer 由 dsh 运行时提供，不需要装进 profile。

### 6.3 在 profile 层固定绝对路径

bundle 自带的 [`plugin/cordis.patch.yml`](plugin/cordis.patch.yml) 使用相对路径：

```yaml
kbRoot: ./plugin/knowledge_base
workspace: ./canness-workspace
```

它们按 **dsh 进程的 cwd** 解析。从别处启动会指错目录，所以把下面这段写进 `~/.dsh/profiles/canness-web/cordis.patch.yml`（路径换成你的仓库位置）：

```yaml
# dsh 的 patch 会替换目标行的整个 config，因此每个键都要重述。
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

`canness-workspace/` 会在第一次生成算子时自动创建。也可以不写这份文件，改在 6.4 启动后的 **设置 → CANNESS** 卡片里填 —— 卡片保存的就是这份 patch。

### 6.4 启动

```bash
# 已安装的 dsh
dsh --profile canness-web

# 或：dsh 源码仓库根目录
pnpm dsh canness-web
```

终端会打印 `dsh web: http://127.0.0.1:<port>/?token=...`，用浏览器打开即可。常用参数：`--no-open` 不自动开浏览器，`--port 0` 由系统选空闲端口，`--host 127.0.0.1` 指定绑定地址。

### 6.5 验证

```bash
dsh --profile canness-web --dump-config | grep -A 8 "== dsh-canness"
```

应看到六行：`canness`、`canness-knowledge`、`canness-generator`、`canness-eval`、`canness-loop`、`canness-remote`。

启动后，**设置 → CANNESS** 应出现设置卡；对话里让模型调用 `kb_search` 等工具即可确认插件已加载。

## 7. 工具参考

### `kb_search`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `operator_name` | string | 是 | 算子名，例如 `Add` |

返回匹配条目的正文合并文本，上限 8000 字符。匹配方式是**文件名包含**（忽略大小写），例如 `Add.md`。没有命中时返回 `no knowledge entry for <name>`。

### `submit_spec`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `spec` | JSON | 是 | 算子规格书 |

返回 `{ generationId, operator_name }`。校验失败会抛出 `missing <字段路径>`，例如 `missing performance_target.metric`，不写状态文件。

规格书结构：

```json
{
  "operator_name": "Add",
  "operator_type": "elementwise",
  "input_specs": [
    { "name": "x", "shape": ["B", "N"], "dtype": "float16" },
    { "name": "y", "shape": ["B", "N"], "dtype": "float16" }
  ],
  "output_specs": [
    { "name": "z", "shape": ["B", "N"], "dtype": "float16" }
  ],
  "target_platform": { "chip": "Ascend910B", "soc_version": "Ascend910B4" },
  "performance_target": { "metric": "kernel_time", "target_us": 8 },
  "tiling_hints": "B*N 按 8192 分块，UB 内双缓冲"
}
```

| 字段 | 必填 | 约束 |
|---|---|---|
| `operator_name` / `operator_type` | 是 | 非空字符串 |
| `input_specs` / `output_specs` | 是 | 非空数组；每项含 `name`、`shape`（字符串数组）、`dtype`，`constraints` 可选 |
| `target_platform.chip` | 是 | 非空字符串；`soc_version`、`cann_version` 可选 |
| `performance_target.metric` | 是 | 目前只接受 `kernel_time` |
| `performance_target.target_us` | 是 | 有限正数 |
| `tiling_hints` | 否 | 字符串或 `null` |

### `write_operator`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kernel` | string | 是 | `op_kernel/kernel.cpp` 内容；必须定义 `void canness_kernel(<输入…>, <输出…>, GM_ADDR tiling)` |
| `host` | string | 是 | `op_host/host.cpp` 内容 |
| `api` | string | 是 | `op_api/api.cpp` 内容 |
| `plugin` | string | 是 | `op_plugin/plugin.py` 内容 |

返回 `{ operatorDir }`。未调用 `submit_spec` 时报 `submit_spec first`。

**kernel 入口是固定的**：包里的 `main.cpp` 是算子无关的宿主驱动，只认 `extern "C" __global__ __aicore__ void canness_kernel(...)`，参数顺序为「全部输入 → 全部输出 → tiling 指针」，不能带 `workspace` 参数。写成 `void gelu(...)` 会在链接时报 undefined symbol，看起来像工具链问题。`write_operator` 与 `build_test_package` 都会在打包前校验签名，不匹配直接报错并给出正确形式。

### `build_test_package`

无参数。返回 `{ packageDir }`。复制当前 generation 的四层文件，并渲染**构建契约 v1**：
`build.sh`、`run_once.sh`、`main.cpp`、`golden.h`、`canness_tiling.h`，再写 `config.json` 与
`manifest.json`。`main.cpp` 按 spec 的输入/输出个数与 dtype 生成；`build.sh` 固化
`soc_version` 与 bisheng 编译参数；`config.json` 按 dtype 给 `maxAbsErr`（fp16 `2^-10`、
bf16 `2^-7`、fp32 `2^-13`）。

```json
{
  "generationId": "gen-1a2b3c4d",
  "operatorName": "Add",
  "performanceTargetUs": 8,
  "buildContract": "v1",
  "layers": ["op_kernel/kernel.cpp", "op_host/host.cpp", "op_api/api.cpp", "op_plugin/plugin.py"],
  "files": [
    "build.sh", "canness_tiling.h", "config.json", "golden.h", "main.cpp",
    "manifest.json", "op_api/api.cpp", "op_host/host.cpp", "op_kernel/kernel.cpp",
    "op_plugin/plugin.py", "run_once.sh"
  ]
}
```

`files` 是**实际落盘清单**（含 `manifest.json` 自身），排序稳定；`layers` 单独保留四层。

### `write_package_file`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 只接受 `golden.h` |
| `content` | string | 是 | 完整的 `golden.h` 内容 |

模型唯一可写的包内文件。写入 `operators/<generationId>/golden.h`（以及已存在的
`packages/<generationId>/golden.h`），随后应重新 `build_test_package`。模板里的
`golden.h` 是占位实现：只要 `CANNESS_GOLDEN_PLACEHOLDER` 还在，评测就判
`accuracy_fail`、摘要为 `golden not implemented: ...`，不会假通过。

### `run_evaluation`

无参数。返回一份评估报告（结构见 [9.2](#92-结果文件)）。以下情况**不抛异常**，而是返回 `status: "error"` 的报告：`host` 为空、凭据缺失、CANNLab 隧道断开、SSH 连接失败、预算已耗尽。以下情况抛异常：未 `submit_spec`（`submit_spec first`）、未 `build_test_package`（`build_test_package first`）。

## 8. 配置参考

四个 host 插件各自的配置。除 `workspace` 外，`canness-eval` 的字段都是 **volatile** —— 设置卡保存后下一次操作立即读到新值，无需重启。

### `canness-knowledge`

| 字段 | 类型 | 说明 |
|---|---|---|
| `kbRoot` | string | 知识库目录。bundle 默认 `./plugin/knowledge_base` |

### `canness-generator`

| 字段 | 类型 | 说明 |
|---|---|---|
| `workspace` | string | 工作区根目录，状态文件与产物写在这里 |

### `canness-eval`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workspace` | string | — | 工作区根目录 |
| `host` | string | `""` | 远端主机名或 IP；为空时 `run_evaluation` 直接返回错误报告 |
| `port` | number | `22` | SSH 端口 |
| `username` | string | `""` | SSH 用户名 |
| `privateKeyPath` | string | `""` | 私钥文件路径；非空时优先用它认证 |
| `passwordEnv` | string | `CANNNESS_SSH_PASSWORD` | 凭据存储中的引用名，用于取 SSH 密码 |
| `inbox` | string | `/tmp/canness/inbox` | 远端接收测试包的目录 |
| `outbox` | string | `/tmp/canness/outbox` | 远端写回结果的目录 |
| `timeoutSec` | number | `1800` | 等待 `results.json` 的最长秒数 |
| `pollIntervalMs` | number | `2000` | 两次轮询之间的间隔 |
| `maxIterations` | number | `10` | 有效迭代上限 |
| `maxCompileRetries` | number | `3` | 编译失败累计上限 |
| `negativeStreakLimit` | number | `3` | 性能连续变差上限 |
| `convergenceThreshold` | number | `0.05` | 两次通过结果的相对差小于该值即判收敛 |

### `canness-loop`

`workspace` 加与 `canness-eval` 同名的四个预算字段。

> **预算字段写两份，数字必须一致。** `canness-eval` 用它们拒绝超预算调用并判定停机，`canness-loop` 用它们决定要不要 `steer`。两处不一致会出现「工具拒绝执行但循环仍在续轮」的错位。

### `canness-remote`

只影响设置卡上的连通检查与 CANNLab 连接，不参与评估流程。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tokenRef` | string | `CANNLAB_GITCODE_TOKEN` | 存 GitCode refresh token 的凭据引用名 |
| `cacheRoot` | string | `""` | 端口转发 helper 的下载解包目录；空 = `~/.dsh/canness/devspace-helper` |
| `keyDir` | string | `""` | 临时 SSH 私钥的落地目录；空 = `~/.dsh/canness/cannlab` |
| `logPath` | string | `""` | 连接轨迹文件；空 = `~/.dsh/canness/cannlab/last-connect.log` |
| `instance` | string | `""` | 默认连接的环境名或 ID；空 = 用唯一运行中的环境 |

### 停机条件

| 条件 | 触发阈值 | `lastReport.summary` |
|---|---|---|
| 超时累计 | `timeouts >= 2`（固定值） | `stopped: timeouts` |
| 编译失败累计 | `compileRetries >= maxCompileRetries` | `stopped: compileRetries` |
| 有效迭代 | `validIterations >= maxIterations` | `stopped: maxIterations` |
| 性能连续变差 | `negativeStreak >= negativeStreakLimit` | `stopped: negativeStreak` |
| 收敛 | 两次通过结果相对差 `< convergenceThreshold` | `stopped: converged` |
| 目标达成 | `kernelTimeUs <= targetUs`（最近一次为 `pass`） | `stopped: targetMet` |

### 计数规则

| 报告状态 | 有效迭代 | 其它计数 |
|---|---|---|
| `compile_fail` | 不增加 | `compileRetries + 1` |
| `timeout` | 不增加 | `timeouts + 1` |
| `pass` | +1 | `negativeStreak` 归零，记录最近与上一轮通过用时、刷新最优 |
| `accuracy_fail` / `perf_fail` / `error` | +1 | 用时优于历史最优则刷新最优并归零 streak，否则 `negativeStreak + 1` |

## 9. 远端约定

### 9.1 目录布局

```
{inbox}/{generationId}/op_kernel/kernel.cpp
{inbox}/{generationId}/op_host/host.cpp
{inbox}/{generationId}/op_api/api.cpp
{inbox}/{generationId}/op_plugin/plugin.py
{inbox}/{generationId}/build.sh          # 插件模板渲染：编译 + 链接
{inbox}/{generationId}/run_once.sh       # 插件模板渲染：跑 1 次并输出 CANNESS_RESULT
{inbox}/{generationId}/main.cpp          # 插件模板渲染：ACL 主机骨架
{inbox}/{generationId}/golden.h          # 占位或模型填写的精度参考
{inbox}/{generationId}/canness_tiling.h  # 通用 CannessTilingData + GET_TILING_DATA
{inbox}/{generationId}/config.json       # 按 dtype 推导的 maxAbsErr 与 tiling 参数
{inbox}/{generationId}/manifest.json
{inbox}/{generationId}/build.sh          # 构建契约 v1：最后一行 stdout 打印可执行文件路径
{inbox}/{generationId}/run_once.sh       # 构建契约 v1：输出 CANNESS_RESULT {...}

{outbox}/{generationId}/results.json
```

`run_evaluation` 每轮会先删除上一次的 `results.json` 再开始轮询，避免读到陈结果。包里的
`build.sh` / `run_once.sh` / `main.cpp` / `golden.h` 由 `build_test_package` 渲染，模型只通过
`write_package_file('golden.h', ...)` 填精度公式；kernel 入口固定为 `canness_kernel`
（输入 → 输出 → tiling）。

包上传后远端执行的是 `remote/runner.py`：依次 `bash build.sh`、`bash run_once.sh`、真实
`msprof`，再按 §9.3 的口径取 `kernelTimeUs`。**评测不依赖任何 inbox 消费者进程。**

若当前 SSH 端点是 CANNLab 隧道（`127.0.0.1:<helper 端口>`），`run_evaluation` 在连接前先
探测 helper 的 `/heartbeat` 并续约一次；隧道已断时返回 `status: "error"`、摘要为
`tunnel is down; reconnect from Settings → CANNESS`，而不是把它埋成 SSH 认证错误。

### 9.2 结果文件

```json
{
  "generationId": "gen-1a2b3c4d",
  "status": "pass",
  "compile": { "ok": true, "log": "" },
  "correctness": { "ok": true, "maxRelativeError": 0.0004 },
  "performance": { "kernelTimeUs": 7.6, "targetUs": 8 },
  "analysis": {
    "source": "msprof",
    "bottleneck": "memory",
    "summary": "Task Duration 7.6us；aic_mte2_ratio 0.71，内存搬运为主，cube_utilization 21.3%。",
    "op": {
      "opName": "Add",
      "opType": "Add",
      "taskType": "AI_CORE",
      "taskDurationUs": 7.6,
      "taskWaitTimeUs": 2,
      "blockDim": 8,
      "aicoreTimeUs": 7.6,
      "aicMacRatio": 0.12,
      "aicMte2Ratio": 0.71,
      "aicScalarRatio": 0.09,
      "cubeUtilizationPct": 21.3
    }
  },
  "summary": "passed"
}
```

| 字段 | 约束 |
|---|---|
| `status` | 六选一：`pass`、`compile_fail`、`accuracy_fail`、`perf_fail`、`timeout`、`error` |
| `compile` | `ok` 布尔，`log` 字符串（进入增强块时截断到 2000 字符） |
| `correctness.maxRelativeError` | 数字或 `null` |
| `performance.kernelTimeUs` / `targetUs` | 数字或 `null` |
| `analysis` | 可为 `null`；`source` 只能是 `msprof`；`bottleneck` ∈ `cube`、`memory`、`scalar`、`unknown`；`op` 可为 `null` |
| `runRecord` | 可选；`{ timestamp, host, params, toolchain, durationMs }`，`params.golden` 标明精度参考来源（`placeholder` / `custom`） |

字段不合法时不会抛错，而是返回 `status: "error"`、`summary` 为 `malformed result: <原因>` 的报告，让闭环继续跑而不是中断。

`golden.h` 还是占位实现时，报告为 `status: "accuracy_fail"`、`correctness.ok = false`、
`correctness.maxRelativeError` 保留原始数值，`summary` 固定为
`golden not implemented: fill golden.h in the package, then re-run build_test_package and run_evaluation`。

### 9.3 真实 runner 与产物

远端执行器是 [`plugin/remote/runner.py`](plugin/remote/runner.py)，`run_evaluation` 每次以
uuid 临时上传、结束后删除。它只认包内的构建契约，不拼编译命令：

1. `bash build.sh`，取**最后一行 stdout** 作为可执行文件路径；缺脚本或路径不存在 → `compile_fail`；
2. `bash run_once.sh`（同一把 `flock`、`ASCEND_VISIBLE_DEVICES=7`），解析 `CANNESS_RESULT`；
3. `msprof --application="<exe> 100" --output=<预建目录>`；
4. 读 `mindstudio_profiler_output/*.csv`：优先 `op_summary` 全部行的 `Task Duration(us)`
   算术平均；只有聚合文件时取 `op_statistic` 的 `Avg` 列；两者都没有 → `status: "error"`，
   摘要列出搜过的目录与文件名，绝不写成 `pass`；
5. 写 `{outbox}/<generationId>/results.json`（含 `runRecord`）。

`manifest.json` 的 `performanceTargetUs` 只写入 `performance.targetUs`，永远不会变成
`kernelTimeUs`。CSV 与日志可用 `fetch_remote_file` 拉回 workspace，读取范围仅限
`outbox` 与当前 generation 的 `inbox/<generationId>`，`remotePath` 必须是绝对路径。

### 9.4 连接 CANNLab（免费 NPU 云环境）

CANNLab 不开放入站 SSH：它只给一个签名隧道，入口是官方 AtomGit Dev Space 扩展里的端口转发 helper。CANNESS 把整条流程收进了设置卡，**不用装 VS Code，也不用手工敲命令**。

设置 → CANNESS →「CANNLab 云端环境」→ 点「连接到 CANNLab」：

1. 宿主进程在本机 `127.0.0.1:3000` 起一次性回调服务，并打开系统浏览器做 GitCode 授权（带 `state` 校验）；
2. 用 access token 调 CANNLab openapi 列出账号下的环境，选出运行中的那个；
3. 取该环境的临时私钥和签名隧道地址，下载 Dev Space 扩展包、解出官方 `port-forward-hub.js` 并启动；
4. 把远端 `22` 映射到一个本地随机端口，**自动回填并保存 `host` / `port` / `username` / `privateKeyPath`** 到 `canness-eval`，之后的 `run_evaluation` 就走这条隧道。

必须知道的几件事：

| 项 | 说明 |
|---|---|
| 回调端口 | 固定 `3000`（官方 OAuth 客户端注册的地址，不能改）。被占用时日志会直说；关闭设置面板会立刻释放，不会堵住下一次 |
| 选择环境 | 默认用唯一「运行中」的环境；账号里同时有 CPU 和 NPU 两个在跑时，在「环境名」里写名字或 ID |
| 登录凭据 | 只持久化 refresh token，存进 dsh 凭据存储的 `CANNLAB_GITCODE_TOKEN`，**不写配置文件**；access token 只在内存里活一次操作 |
| 临时私钥 | 每次连接写到 `~/.dsh/canness/cannlab/<实例 id>/id_*`，权限 `0600`；旧目录可以直接删 |
| 首次开销 | 第一次会下载扩展包（约 2 MB）并解包到 `~/.dsh/canness/devspace-helper`；之后复用 |
| 连接日志 | 卡片里逐条显示当前阶段；同时落盘到 `~/.dsh/canness/cannlab/last-connect.log`，刷新页面或关面板都不会丢，**失败原因也在里面** |
| 断开 | 卡片上的「断开隧道」调 `delete-forward-hub`；helper 空闲 10 分钟也会自行退出 |
| 计费 | 免费额度 100 卡时，实例不关就一直烧。CANNESS **不替你开关机**，用完请去 CANNLab 控制台关机 |

CANNLab 环境里的路径和常见主机不同，写远端脚本时注意：

- CANN 在 `/home/developer/Ascend`（不是 `/usr/local/Ascend`），编译前需 `source /home/developer/Ascend/ascend-toolkit/set_env.sh`；
- 只有 `/mnt/workspace` 持久化，`/home/developer` 关机即丢，代码和产物要落在前者；
- `~/.bashrc` 有非交互式 guard，`ssh host 'cmd'` 拿不到 `/etc/profile` 里的 PATH，需要编译工具链的命令要用 `bash -lc` 包一层。

## 10. 认证与凭据

`run_evaluation` 的认证优先级：

1. 配置了 `privateKeyPath` → 用私钥；
2. 否则从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）→ 用密码；
3. 都没有 → 返回 `ssh credentials missing` 的错误报告。

存密码有两种方式：

- **Web UI（推荐）** —— 设置 → CANNESS → 打开「使用密码认证」，填入密码后保存。密码写入 `~/.dsh/.credentials.yaml`，**不进入任何配置文件**，也不会回显。
- **环境变量** —— `CANNNESS_SSH_PASSWORD=... dsh --profile canness-web`。环境变量是凭据存储的回退层。

> 卡片上的「使用密码认证」开关只决定显示哪个输入框，服务端优先级始终是私钥优先。两者都配置时以私钥为准。

CANNLab 连接另有一套凭据，与 SSH 认证互不影响：

- **GitCode 刷新令牌** —— 第一次点「连接到 CANNLab」时在浏览器完成授权，只把 refresh token 存进凭据存储的 `CANNLAB_GITCODE_TOKEN`（可用 `canness-remote` 的 `tokenRef` 改名）。access token 不落盘，一次操作后丢弃。
- **临时 SSH 私钥** —— 由 CANNLab 按实例签发，写在 `~/.dsh/canness/cannlab/<实例 id>/` 下并自动填入 `privateKeyPath`。它和手工配置的私钥等价：`run_evaluation` 只是读该路径。

## 11. 工作区结构

```
{workspace}/
├── .canness/
│   └── state.json                 # 当前 generation、规格书、计数、最近一次报告
├── operators/
│   └── <generationId>/            # 四层算子文件
│       ├── op_kernel/kernel.cpp
│       ├── op_host/host.cpp
│       ├── op_api/api.cpp
│       └── op_plugin/plugin.py
└── packages/
    └── <generationId>/            # 测试包：四层文件 + manifest.json
```

`state.json` 字段：

| 字段 | 说明 |
|---|---|
| `generationId` | 当前轮次 id，由 `submit_spec` 生成 |
| `spec` | 规格书原文 |
| `validIterations` | 有效迭代计数 |
| `compileRetries` | 编译失败累计 |
| `timeouts` | 超时累计 |
| `negativeStreak` | 性能连续变差计数 |
| `bestKernelTimeUs` | 历史最优 kernel 用时 |
| `previousPassKernelTimeUs` / `lastPassKernelTimeUs` | 最近两次通过用时，用于收敛判定 |
| `lastReport` | 最近一次评估报告 |

删掉 `state.json` 等于重开一局；`operators/` 与 `packages/` 可以随意清理。

## 12. 开发

```bash
cd plugin
pnpm test     # Vitest，11 个文件 / 51 个用例
pnpm check    # host + client 两份 tsconfig 类型检查
pnpm build    # tsc + esbuild，产出 lib/
```

开发循环：

1. 改 `plugin/src/`；
2. `pnpm test && pnpm check && pnpm build`；
3. 重启 dsh（patch 配置会热加载，模块代码不会）。

profile 里装的是**符号链接**，指向 `plugin/` 目录，所以不需要反复 `plugin add`；但**必须重新 `pnpm build`**，dsh 才能看到新的 `lib/`。

### 目录结构

```
CANNESS/
├── plugin/                        # npm 包 dsh-canness
│   ├── src/                       # host 半区
│   │   ├── index.ts               # 裸包名入口（浏览器半区的挂载行）
│   │   ├── knowledge.ts           # kb_search
│   │   ├── knowledge-search.ts    # 文件级检索
│   │   ├── generator.ts           # submit_spec / write_operator / build_test_package / write_package_file
│   │   ├── spec.ts                # 规格书校验
│   │   ├── package-files.ts       # 四层落盘与测试包
│   │   ├── eval.ts                # run_evaluation
│   │   ├── eval-run.ts            # 上传 → 轮询 → 解析
│   │   ├── ssh2-transport.ts      # ssh2 传输适配（exec + base64）
│   │   ├── remote.ts              # RemoteFiles 接口 + 内存实现
│   │   ├── report.ts              # 评估报告结构与解析
│   │   ├── analysis.ts            # msprof 形状的性能分析
│   │   ├── policy.ts              # 计数、停机、增强块
│   │   ├── loop.ts                # 两个事件监听器
│   │   ├── state-file.ts          # state.json 读写
│   │   ├── ids.ts                 # generationId
│   │   └── client/                # 浏览器半区（Web 设置卡）
│   ├── tests/                     # Vitest 单元测试
│   ├── knowledge_base/            # 知识库条目
│   ├── remote/runner.py           # 远端真实评测器（build.sh → run_once.sh → msprof）
│   ├── templates/build-contract/  # build.sh / run_once.sh / main.cpp / golden.h / tiling shim 模板
│   ├── scripts/build-client.mjs   # 浏览器半区打包脚本
│   ├── cordis.patch.yml           # bundle 默认配置层
│   └── package.json
├── docs/
│   ├── design/                    # 01–05 设计文档，05 为实施基准
│   └── plans/                     # 实现计划与提案
├── .github/workflows/ci.yml       # CI：check + test + build
├── CHANGELOG.md
├── LICENSE
├── README.md                      # 本文件
└── README.en.md
```

### 约束

- 插件代码只能是 **TypeScript / ESM**；Python 只出现在 `remote/runner.py` 与知识库正文里。
- 浏览器半区只能 value-import dsh 冻结模块表里的包（`react`、`cordis`、`dsh-client-*` 等），其余由 esbuild 内联。
- 预算四字段在 `canness-eval` 与 `canness-loop` 各写一份，两处数字必须相同。
- 新增工具或字段时同步更新 [docs/design/05-plugin-architecture.md](docs/design/05-plugin-architecture.md) 与 README 的配置表。

### 测试策略

- `remote.ts` 的 `MemoryRemote` 让上传 / 轮询 / 超时可以在内存里跑完整回合，不需要网络。
- `ssh2-transport.ts` 通过 `Dial` 注入点替换真实连接，只验协议组装与错误映射。
- `policy.ts` 的计数与停机是纯函数，覆盖每个停机分支。
- 设置卡用 `SettingFormModel` 的假 scope 驱动，不启动浏览器。

## 13. 已知限制与路线图

### 当前限制

- **单轮单候选**：一次生成一个算子，没有并行候选、tiling 搜索、融合策略。
- **只支持通用 SSH**：本地执行器、华为云、CANN Lab 等后端均已取消；远端怎么启动编译是主机侧的事。
- **知识库是文件级检索**：文件名匹配 + 正文截断，没有向量检索或结构化索引。
- **没有 Dashboard**：迭代历史看会话日志与 `state.json`。
- **真实主机验收未完成**：单元测试覆盖了协议与策略，但真实 SSH 主机 + 真实 CANN 工具链的端到端验证还没做。

### 路线图

| 阶段 | 目标 |
|---|---|
| v0.2（当前） | 构建契约 + 真实 msprof 评测；CANNLab 隧道接入 |
| 下一步 | 真实主机端到端验收；失败分类细化；增强块按失败类型分化 |
| v0.3 | 知识库结构化索引；参考实现与 tiling 模板自动注入 |
| 之后 | 并行候选、搜索、Dashboard、更多算子类型 |

## 14. 常见问题

**Q：`dsh web --patch ./plugin/cordis.patch.yml` 报 `Cannot find package 'dsh-canness'`？**

`--patch` 只贡献配置行，模块解析仍发生在 profile 目录。这个包有多个子路径入口，必须先 `dsh plugin add` 进对应 profile。

**Q：`pnpm dsh canness` 启动了但没有任何界面？**

只含 `dsh-base + dsh-canness` 的 profile 没有 app 层。用本文的 `canness-web`（以 `web` 为模板），或给 profile 的 bundles 补 `@deepseek-ai/dsh-web-app`。

**Q：知识库搜不到 / 工作区写到了奇怪的位置？**

bundle 默认的相对路径按 dsh 进程 cwd 解析。按 [6.3](#63-在-profile-层固定绝对路径) 在 profile 的 `cordis.patch.yml` 里写绝对路径。

**Q：启动时报 `Cannot find module .../lib/index.js`？**

没有构建。在 `plugin/` 下执行 `pnpm build`。

**Q：`run_evaluation` 一直等到超时？**

先看报告 `summary`：以 `package does not implement build contract v1` 开头说明包缺
`build.sh` / `run_once.sh`，重新跑 `build_test_package`；以 `tunnel is down` 开头说明
CANNLab 隧道已断，回设置卡重新连接；其余情况用 `fetch_remote_file` 把
`{outbox}/<generationId>/results.json` 和 runner 日志拉回来看。

**Q：pnpm 警告 peerDependencies 未解析？**

正常。dsh 运行时提供这些 peer，`plugin add` 使用链接安装，不会把 peer 装进 profile。

**Q：dsh 版本不满足 `engines.dsh`？**

插件声明 `>=0.2.0 <0.3.0`。换用 `0.2.1-rc.3` 附近的 dsh，或同步修改 `plugin/package.json` 的 `engines.dsh` 与 peer 版本。

## 15. 文档

| 文档 | 内容 |
|---|---|
| [docs/README.md](docs/README.md) | 文档索引与阅读路径 |
| [docs/design/05-plugin-architecture.md](docs/design/05-plugin-architecture.md) | **实施基准**：插件边界、工具契约、事件映射、技术栈 |
| [docs/design/01–04](docs/design/) | 总体设计、详细架构、闭环反馈方法论、可行性评估 |
| [docs/plans/](docs/plans/) | MVP 实现计划、SSH 凭据设计提案与实现计划 |
| [plugin/README.md](plugin/README.md) | 包级说明：构建、profile 安装、远端 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

`01`–`04` 是插件化改造前的设计，其中 CLI、配置、编排、LLM 层的结论已被 `05` 取代；读 `05` 时不必先读它们。

## 16. 许可

[MIT](LICENSE) © 2026 CANNESS Contributors

---

本项目源于南京大学大学生创新训练计划「基于大模型智能体的软件开发系统 / 多智能体的垂域软件开发」。
