# CANNESS 远端主机凭据配置设计

日期：2026-10-30
状态：已批准
分支：feat/canness-ssh-password-auth
前置：dsh-canness MVP（Task 1–12 已完成并合入 main）

## 1. 背景与目标

MVP 里 `canness-eval` 的远端主机配置只能手改 profile 的 `cordis.patch.yml`，且传输层只支持私钥认证。目标：

1. `run_evaluation` 支持 SSH 密码认证（用户场景：远端主机只给了密码登录）
2. 在 dsh 的 Web UI 设置面板里提供一张 CANNESS 专属设置卡（类似 VS Code 的显式配置入口），host/port/username/认证凭据一次填好，不用再碰配置文件

**非目标**：localStorage 存储（双进程架构下 Node 侧读不到，且 XSS 暴露）；TUI/headless 下的表单；改 `RemoteFiles` 接口或迭代策略。

## 2. 决策记录

| 决策点 | 选择 |
|---|---|
| 凭据存储 | dsh credentials 缝：值进 `~/.dsh/.credentials.yaml`，配置里只存引用名 |
| UI 形态 | 插件自带 Web UI 设置卡（`dsh.client` browser bundle + `settings.section` 插槽） |
| 认证优先级 | 配置了 `privateKeyPath` 用私钥；否则用密码；都没有报 `ssh credentials missing` |
| 非敏感配置存储 | 设置卡直改 profile 的 `cordis.patch.yml`（settings remote API），配置真相保持一份 |

## 3. 架构

```
┌─ Web UI (browser) ─────────────────┐      ┌─ Node host ─────────────────────┐
│ dsh-canness browser bundle          │      │ dsh-canness (canness-eval)      │
│  ├─ settings.section 插槽注册        │ RPC  │  ├─ Config: + passwordEnv 字段  │
│  │   "CANNESS 远端主机" 设置卡        │ ───▶ │  │   (role 'credential-ref')     │
│  ├─ 表单: host/port/username/       │      │  ├─ run_evaluation 执行时:      │
│  │   密码(掩码)/privateKeyPath/      │      │  │   resolve(passwordEnv) 取密码 │
│  │   inbox/outbox                   │      │  │   → connectSftp({password})  │
│  └─ 保存: settings 写回 + credentials.set │  └─ ssh2 password auth           │
└─────────────────────────────────────┘      └─────────────────────────────────┘
```

- 密码 → `ctx.remote.credentials.set(CANNNESS_SSH_PASSWORD, value)` → host 凭据文件
- 其余字段 → settings remote API 写回 `~/.dsh/profiles/canness/cordis.patch.yml` 的 `canness-eval` 段
- 插件 Node 侧只新增一个 `passwordEnv` 配置字段和 `ctx.credentials.resolve()` 调用，无自建存储

## 4. Node 侧改动（`plugin/src/`）

### 4.1 `ssh2-transport.ts`

- `SftpOptions` 增加 `password?: string`
- `defaultDial` 的 `connect()` 传 `password`（ssh2 原生支持，与 `privateKey` 并存；两者都不给时 ssh2 自己报 All configured authentication methods failed）

### 4.2 `eval.ts`

- `Config` 增加 `passwordEnv: z.string().role('credential-ref').default('CANNNESS_SSH_PASSWORD').volatile()`
  - `.default()` 让纯 CLI 用户零配置即可用
  - `.volatile()` 每次操作重新读，改密码不重启生效
- `apply(ctx, config, connect)` 的 `connect` 注入参数保持不变（测试已依赖）
- 认证解析（在 `execute` 内）：
  1. `privateKeyPath` 非空 → 读私钥文件，走私钥认证（现状不变）
  2. 否则 `ctx.get('credentials')` 服务存在且 `resolve(passwordEnv)` 有值 → 密码认证
  3. credentials 服务不存在（极简 profile）或 resolve 无值 → 按"未配置密码"降级，不崩
  4. 两者都没有 → 返回 `status: 'error'`，`summary: 'ssh credentials missing'`，不建连
- 现有 `host === ''` → `ssh host is empty` 路径保留，检查顺序在凭据检查之前

## 5. Web UI 侧（新增 `plugin/client/`）

### 5.1 包声明

`plugin/package.json`：

- `dsh.client`: `{ "platform": "web" }`（含构建产出的 `./client` 导出）
- `exports` 增加 `"./client": "./lib/client.js"`
- 构建链：tsdown 打 browser bundle（对齐 dsh 客户端插件的构建要求：`pnpm build` 产出 `lib/client.js`）

### 5.2 设置卡

- 注册 `settings.section` 插槽：dsh Settings 面板出现 "CANNESS" 页签
- 卡片字段（VS Code 设置风格，逐行 label + input）：
  - 认证方式（单选：私钥 / 密码）
  - host（text）
  - port（number，默认 22）
  - username（text）
  - privateKeyPath（text，认证方式=私钥时显示）
  - 密码（password 掩码输入，认证方式=密码时显示；永远空回显，占位符显示"已配置"与否）
  - inbox / outbox（text）
  - timeoutSec / pollIntervalMs / maxIterations / maxCompileRetries / negativeStreakLimit / convergenceThreshold（高级区折叠，默认收起）
- 保存逻辑：
  - 密码 → `ctx.remote.credentials.set('CANNNESS_SSH_PASSWORD', value)`（空输入跳过）
  - 其余字段 → settings remote API 写回 patch.yml 的 `canness-eval.config`（**整段替换**，不合并——与 dsh patch 语义一致）
- 只读回显：从 settings mirror 读当前 `canness-eval` config 渲染；密码框永远不回显真值

### 5.3 多语言

卡片文案中文为主（团队成员中文背景），保留 locales 结构以便后续加英文。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 密码错误（ssh2 auth failure） | `run_evaluation` 返回 `status: 'error'`，summary 带 auth 失败原因，透传给模型 |
| credentials 服务不存在 | 视为未配置密码，按优先级降级；不抛异常 |
| UI 保存密码失败 | 卡片内联报错，不静默 |
| UI 写回 config 失败 | 卡片内联报错，不静默 |
| UI 读 config 失败 | 表单显示空值 + 提示，不崩 |

## 7. 测试

- `ssh2-transport.test.ts`：密码认证路径（注入假 dial 验证 `password` 透传；`SftpLike` 接口不变）
- `plugins.test.ts`：
  - `passwordEnv` 默认值解析
  - 优先级用例：有 privateKeyPath → 私钥；无私钥有密码 → 密码；双缺失 → `ssh credentials missing`
  - credentials 服务缺失时降级不崩
- UI 侧：设置卡保存分流逻辑（密码进 credentials、其余进 settings 写回）的单元测试；不测 dsh 框架本身的插槽机制
- 全量回归：`pnpm test` + `tsc --noEmit`

## 8. 交付物

- 密码认证全链路（Node 侧）
- Web UI 设置卡（browser bundle）
- README 更新：UI 配置入口的使用说明
- 手工验收：web profile 下设置卡填密码 → 保存 → headless `run_evaluation` 走密码认证连通远端
