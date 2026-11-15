---
title: 远端自举（目录 + 消费者）修复提示词
date: 2026-11-03
status: 已执行（2026-11-03）
relates_to:
  - "../design/05-plugin-architecture.md §5.3.1"
---

# 远端自举修复提示词

> **历史文档（2026-11-05 标注）**：本方案已被 `fix/eval-truthfulness` 取代。
> `bootstrap` / `bootstrapCommand` 配置项、`remote-bootstrap.ts` 与 `remote/watch.py`
> 均已删除；远端不再自举任何消费者，改由 `run_evaluation` 上传
> `remote/runner.py` 并在一次 SSH `exec` 内完成真实评测。
> 本文仅保留作为历史记录，**不要**按这里的步骤实现。

把「1. 提示词正文」整段交给一个在 `D:\projects\CANNESS` 打开的编码 agent 执行。设计契约见 [`../design/05-plugin-architecture.md`](../design/05-plugin-architecture.md) §5.3.1；本文只负责把那份契约翻译成可执行的任务说明。

## 背景（实测）

远端 `140.207.205.182:32222` 能 SSH 登录、SFTP 可用，但：

- `/tmp/canness` 不存在；
- 没有 `watch.py`；
- 没有任何进程消费 inbox。

`run_evaluation` 的上传会自建 `{inbox}/{generationId}/`，所以流程"看起来在跑"，实际没人写 `results.json`，一次调用要等满 `timeoutSec`（默认 1800s）才返回 `status: "timeout"`。

## 1. 提示词正文

### 1.1 任务

修复 `dsh-canness` 插件：让 `run_evaluation` 在首次上传前对远端做一次**幂等自举**——目标目录不存在就建、消费 `inbox` 的 `watch.py` 缺失就上传并拉起；自举失败立即返回错误报告，绝不进入轮询干等。

只改 `plugin/` 下的代码、测试与文档；不改 profile 配置，不碰远端主机。

### 1.2 环境与约束

- 仓库：`D:\projects\CANNESS`；插件包在 `plugin/`（包名 `dsh-canness`，ESM，Node ≥ 24.9，pnpm）。
- 命令（在 `plugin/` 下）：`pnpm test`（Vitest）、`pnpm check`（tsc host + client 两份配置）、`pnpm build`（tsc → `lib/` + esbuild → `lib/client.js`）。当前基线：14 个测试文件、**72 个用例全绿**。
- 硬约束：
  - 只用 TypeScript / ESM；**不新增 npm 依赖**（`ssh2` 已装）；不使用 `@deepseek-ai/dsh-ssh`。
  - 远端是 Linux/POSIX shell；本地开发机是 Windows，路径拼接一律用 `node:path` 的 `posix` 语义处理远端路径。
  - 不硬编码任何主机、用户名、目录（全部来自配置）。
  - 不改 `run_evaluation` 的工具名与参数（仍是无参数）；输出 schema 保持向后兼容（可以加可选字段，不能改必填项）。
  - 不改客户端半区（`src/client/**`、设置卡）；新增配置项先只走 host 与文档。
  - 不在本地编译或执行 cmake / kernel_eval。

### 1.3 现状代码地图（先读这些）

| 文件 | 关键符号 |
|---|---|
| `plugin/src/remote.ts` | `RemoteFiles`（`uploadDir` / `readFile` / `removeFile` / `close`）、`MemoryRemote`、`waitForRemoteFile` |
| `plugin/src/ssh2-transport.ts` | `SftpLike`、`mkdirp`、`remoteFromSftp`、`connectSftp`、`openSftp`、`isMissingSftpError`、`defaultDial` |
| `plugin/src/eval.ts` | `Config`（schemastery，字段均为 volatile）、`snapshot`、`resolveAuth`、`apply(ctx, config, connect = connectSftp, dial?)`、工具 `execute` |
| `plugin/src/eval-run.ts` | `runEvaluation`（上传 → 删旧结果 → 轮询 → 解析） |
| `plugin/remote/watch.py` | `--inbox` / `--outbox` / `--once`；扫 `{inbox}/*/manifest.json`，写 `{outbox}/{gen}/results.json`，已存在则跳过 |
| `plugin/tests/plugins.test.ts` | `fakeCtx`、`evalConfig`（`vol()`）、`trackedRemote`、`readyPackage` |
| `plugin/tests/ssh2-transport.test.ts` | `fakeClient`、假的 `SftpLike` |
| `plugin/tests/watch.test.ts` | `spawnSync('python', …)` 跑 `watch.py --once` |

### 1.4 行为规格

`run_evaluation` 的 `execute` 顺序变为：配置快照 → 状态/包检查 → 停机判断 → 认证 → SSH 连接 → **自举** → 上传/轮询 → `saveState` → `close`（`finally`）。

自举函数（新模块 `plugin/src/remote-bootstrap.ts`）必须满足：

1. **建目录**：对 `inbox`、`outbox` 做 SFTP `mkdirp`（复用现有 `mkdirp` 语义），已存在不报错。`bootstrap: false` 时跳过本步与后续所有远端准备。
2. **消费者探测（只读）**，满足任一即视为"已在跑"，直接复用（`consumer: 'reused'`）：
   - `${baseDir}/watch.pid` 存在且 `kill -0 $(cat <pidfile>)` 成功；
   - `pgrep -f '[w]atch.py'` 命中（方括号技巧，避免匹配到本次 `sh -c` 自己的命令行）。
   `baseDir = dirname(inbox)`（默认 `/tmp/canness`）。
3. **补消费者**（探测不到时）：
   - `bootstrapCommand` 非空：执行该命令（POSIX sh），要求退出码 0；不启动内置 mock、不覆盖任何文件。
   - `bootstrapCommand` 为空（默认）：若 `${baseDir}/watch.py` 不存在，把插件包内的 `remote/watch.py` 上传到该路径（按 `import.meta.url` 定位，相对于 `lib/`：`new URL('../../remote/watch.py', import.meta.url)`）；**已存在则保留不动**。然后启动：
     ```sh
     nohup <python> '<watch>' --inbox '<inbox>' --outbox '<outbox>' --loop --interval 2000 >> '<baseDir>/watch.log' 2>&1 &
     echo $! > '<baseDir>/watch.pid'
     ```
     `<python>` 依次尝试 `python3`、`python`（`command -v` 探测）；都不存在则失败。
   - 所有远端路径用单引号包裹并对内部单引号转义；命令必须是 POSIX sh 可执行的。
4. **就绪确认**：启动后 10 秒内轮询 pid 存活（`kill -0`），存活即成功（`consumer: 'started'`）；进程立即退出则失败。
5. **失败语义**：自举任一步失败 → `await files.close()` 后返回 `status: "error"` 的报告，`summary` 形如 `remote bootstrap failed: <原因>`，**不写状态文件**（`saveState` 不执行，不消耗迭代预算，不进入轮询）。连接失败与自举失败都要保证 `close()` 只调一次。
6. **幂等**：同一远端反复调用不重复拉起进程；第二次看到 pid 存活即 `reused`。

失败原因要可操作，例如：`mkdir <path>: Permission denied`、`python3 not found on remote`、`consumer exited immediately after start`、`bootstrapCommand exited 127: <stderr 摘要>`。

### 1.5 实现步骤

1. **`plugin/src/remote.ts`**：新增远端执行能力接口，保持 `RemoteFiles` 不变：

   ```ts
   export interface RemoteShell {
     exec(command: string): Promise<{ code: number; stdout: string; stderr: string }>
   }
   export interface RemoteHost extends RemoteFiles, RemoteShell {
     mkdirp(remoteDir: string): Promise<void>
     put(localPath: string, remotePath: string): Promise<void>
     stat(remotePath: string): Promise<{ isFile: boolean; isDirectory: boolean } | null>
   }
   export function isRemoteHost(files: RemoteFiles): files is RemoteHost
   ```

   `MemoryRemote` 实现 `RemoteHost`：`put` 记录到 `files`，`stat` 查映射，`exec` 交给可注入的处理器（默认返回 `{ code: 0, stdout: '', stderr: '' }`），并暴露 `execCalls: string[]` 供测试断言。

2. **`plugin/src/ssh2-transport.ts`**：新增 `connectRemote(opts)`（返回 `RemoteHost`），`connectSftp` 保留以兼容现有调用与测试。`exec` 用 `client.exec`，累计 stdout/stderr，`exit` 事件取退出码，`close` 时 resolve；`put` 用 `sftp.fastPut`；`stat` 用 `sftp.stat`（`NO_SUCH_FILE`/`ENOENT` → `null`，复用 `isMissingSftpError`）；`close()` 仍只 `client.end()` 一次。

3. **新文件 `plugin/src/remote-bootstrap.ts`**：

   ```ts
   export interface BootstrapInput {
     inbox: string
     outbox: string
     command: string      // bootstrapCommand；'' = 内置 mock
     enabled: boolean     // bootstrap
   }
   export type BootstrapResult =
     | { ok: true; consumer: 'reused' | 'started' | 'command' }
     | { ok: false; reason: string }
   export async function ensureRemoteConsumer(host: RemoteHost, input: BootstrapInput): Promise<BootstrapResult>
   ```

   抽出并导出 `shellQuote`、`pythonCommand` 等纯函数便于单测。

4. **`plugin/src/eval.ts`**：`Config` 增加两个 volatile 字段（必须带默认值，保证现有 profile 补丁不写这两个键也能启动）：

   ```ts
   bootstrap: z.boolean().default(true).volatile(),
   bootstrapCommand: z.string().default('').volatile(),
   ```

   `snapshot()` 带上它们；`connect` 类型改为返回 `RemoteHost`；`execute` 在连接成功后、`runEvaluation` 之前调用自举；失败返回新的 `bootstrapFailedReport(generationId, reason)`（结构同 `connectFailedReport`，`summary` 前缀 `remote bootstrap failed: `）。

5. **`plugin/remote/watch.py`**：新增 `--loop` 与 `--interval`（毫秒，默认 2000），循环扫描、逐轮容错（单轮异常不退出），`--once` 语义保持不变（不传 `--loop` 时仍是扫一次退出）。结果文件已存在仍跳过。

6. **`plugin/cordis.patch.yml`**：`canness-eval` 的默认行补上 `bootstrap: true`、`bootstrapCommand: ""`。

### 1.6 测试要求（全部在 `plugin/tests/`）

- 新增 `remote-bootstrap.test.ts`，用 `MemoryRemote` 覆盖：
  1. 目录缺失 → 两次 `mkdirp`（inbox、outbox）；
  2. pid 存活 → `reused`，不执行启动命令；
  3. `pgrep` 命中 → `reused`；
  4. 全缺 → 上传 `watch.py`（内容非空）、执行启动命令、`started`；
  5. `watch.py` 已存在但进程没跑 → 不覆盖文件，仍启动；
  6. `bootstrap: false` → 不建目录、不 `exec`；
  7. `bootstrapCommand` 非空且退出码 0 → `command`，不部署 mock；退出码非 0 → 失败并带 stderr 摘要；
  8. `python3`/`python` 都不存在 → 失败，reason 含 `python`；
  9. 进程启动后立即消失（`kill -0` 失败）→ 失败。
- `plugins.test.ts`：`evalConfig` 补 `bootstrap`/`bootstrapCommand` 的 `vol()`；`trackedRemote` 升级为 `RemoteHost`（或新增 `trackedHost`）；补一条：自举失败时 `execute` 返回 `error` 报告、**未写状态文件**、未上传、未轮询；再补一条：`bootstrap: false` 时行为与当前一致（上传 → 轮询 → 结果）。
- `ssh2-transport.test.ts`：为 `exec` 增加假 client 用例（正常退出码、非 0、stderr 汇总、`close` 只 end 一次）。
- `watch.test.ts`：保留 `--once` 用例；如果环境有 `python`，再加一条 `--loop` 的短跑用例（`spawn` 后 300ms 内产出结果、`kill` 退出），没有 python 时 `skipIf`。
- 保持现有 72 个用例全绿。

### 1.7 文档更新（与代码同一次提交）

- `README.md`（根）：§8 `canness-eval` 配置表加 `bootstrap`、`bootstrapCommand` 两行；§9.1 的「**远端必须有人消费 inbox。** … 不通过 SSH 执行任何命令」改写成：除首次自举外不执行命令，以及自举会自动建目录、补 `watch.py`、失败即时报错；§9.3 补一句 mock 消费者会被自动部署。
- `README.en.md`：同步同一处英文。
- `plugin/README.md` §4「远端」：说明默认自举行为与关闭方式。
- `docs/design/05-plugin-architecture.md` §5.3/§5.3.1 已写好契约，核对实现与之一致即可，不要改写结论。
- `docs/README.md` 已收录本提示词，无需新增。

### 1.8 验收标准

1. `cd plugin; pnpm test` 全绿（72 + 新增）；`pnpm check` 无类型错误；`pnpm build` 成功（`lib/` 更新，`lib/client.js` 仍在）。
2. 代码中没有主机名、用户名、`/tmp/canness` 硬编码（除 schema 默认值外）。
3. 自举失败时 `run_evaluation` 在数秒内返回 `status: "error"`、`summary` 以 `remote bootstrap failed: ` 开头，且工作区 `.canness/state.json` 未被修改。
4. 对一台空白的 Linux 主机（无 `/tmp/canness`、无 `watch.py`）：一次 `run_evaluation` 后 `/tmp/canness/{inbox,outbox,watch.py,watch.pid,watch.log}` 齐备，`results.json` 由 mock 写入，工具返回 `status: "pass"`；第二次调用不重复拉起进程。
5. 已有真实 runner 的主机设 `bootstrapCommand` 或 `bootstrap: false` 后，插件不下载、不覆盖、不启动任何 mock。

### 1.9 不要做的事

- 不要为了自举引入新依赖、不要起额外的 SSH 连接（复用同一个 `ssh2` Client）。
- 不要在 `run_evaluation` 里做 `sleep` 式长轮询改造（那是另一个议题）；只加自举。
- 不要把自举失败计入 `validIterations` / `timeouts`。
- 不要覆盖远端已存在的 `watch.py`，不要 `rm -rf` 远端任何目录。
- 不要在日志或报告里输出密码、私钥或完整命令行中的凭据。
- 不要修改客户端设置卡来暴露新字段。

### 1.10 交付

改完请报告：改动文件清单、新增/修改的测试用例名、`pnpm test`/`pnpm check`/`pnpm build` 的实际输出摘要，以及一段自举失败的示例报告 JSON。

## 2. 执行结果（2026-11-03）

- **代码**：`plugin/src/remote.ts`（`RemoteShell` / `RemoteHost` / `isRemoteHost`；`MemoryRemote` 支持 `mkdirp` / `put` / `stat` / `exec`）、`plugin/src/ssh2-transport.ts`（`SftpLike.stat`、`shellFromClient`、`openRemote` / `connectRemote`）、`plugin/src/remote-bootstrap.ts`（新增）、`plugin/src/eval.ts`（两个 volatile 配置、自举接入、`remote bootstrap failed:` 报告）、`plugin/remote/watch.py`（`--loop` / `--interval`）、`plugin/cordis.patch.yml`。
- **测试**：新增 `tests/remote-bootstrap.test.ts`（11 条）；`tests/plugins.test.ts` +2（自举失败不写状态/不上传/不轮询；`bootstrap: false` 保持原行为）；`tests/ssh2-transport.test.ts` +4（exec 退出码与 stderr、默认 0 与 reject、mkdirp 已存在与权限错误、close 只 end 一次）；`tests/watch.test.ts` +1（`--loop` 持续运行）。共 15 个文件 **90 用例全绿**（基线 72）。
- **文档**：根 `README.md` / `README.en.md`（§7 错误清单、§8 配置表、§9.1、§9.3、FAQ）、`plugin/README.md` §4、`CHANGELOG.md`。
- **与提示词的偏差**（都是收紧语义，未改契约）：
  1. `mkdirp` 不再吞掉所有错误：失败后用 `stat` 确认“已是目录”才放行，否则抛出——否则“目录权限”类失败会被静默忽略，与 §1.4 的失败原因要求矛盾。
  2. 传输层的 `end` 与 `execute` 的 `close` 都做了幂等保护，保证只 `client.end()` 一次。
  3. `--once` 优先：同时给 `--once` 和 `--loop` 时只扫一轮。
  4. 自举前用 `isRemoteHost` 判断传输是否具备 `mkdirp`/`put`/`stat`/`exec`；只实现 `RemoteFiles` 的传输退化为原来的“上传即等待”。
  5. `bootstrap: false` 返回 `consumer: 'reused'`（表示未启动任何消费者）。
- **自举失败示例报告**：

```json
{
  "generationId": "gen-1a2b3c4d",
  "status": "error",
  "compile": { "ok": false, "log": "" },
  "correctness": { "ok": false, "maxRelativeError": null },
  "performance": { "kernelTimeUs": null, "targetUs": null },
  "analysis": null,
  "summary": "remote bootstrap failed: python3 not found on remote"
}
```

- **未做**：真实 Linux 主机上的端到端验收（提示词要求不碰远端主机）；并发多会话共用同一远端目录的互斥（§5.3.1 已列为已知限制）。
