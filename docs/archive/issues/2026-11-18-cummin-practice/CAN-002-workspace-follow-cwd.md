# CAN-002 workspace 根目录落在插件源码树内，应跟随 DSH 会话工作目录

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | **P2**（原 P0；原描述已更正） |
| 组件 | `canness-generator` / `canness-eval` / `canness-loop`（workspace 解析） |
| 首次发现 | 2026-11-18，Cummin 实现（会话复盘） |
| 状态 | **corrected + 部分修（P0→P2）** |
| 标签 | `workspace`, `design`, `sandbox` |

## 处理情况（2026-11-18 16:20 复核）

**结论**：本条原描述有误（workspace 本来就跟随会话 cwd），已在本文件「更正」一节改写；代码层只修了 cwd 解析健壮性。

**改动**：`plugin/src/workspace.ts::resolveWorkspace` 由 `session?.header?.cwd` 改为 `session?.cwd ?? session?.header?.cwd`（取不到仍退回 `process.cwd()`）。对应风险是「会话 cwd 只暴露在 `session.cwd` 时静默落到错误目录」。

> **2026-11-18 19:13 补充**：本条的"未改"结论已作废——默认工作区已改为**会话 cwd 本身**
> （不再拼 `canness-workspace`），仓内旧目录已删除。修复记录见 [CAN-001](CAN-001-sandbox-acl-vs-policy.md)。

**未改**：默认值仍是 `resolve(cwd, configured || 'canness-workspace')`，符合「工作目录跟 DSH 一致」的诉求，无需改动。

**残留**：一个 workspace 只应承载一个活跃任务 —— 已单独记入 CAN-017（本会话实测被并行会话抢走预算与归属）。

## 现象

会话 cwd 是 `D:\projects\CANNESS`（插件仓库本体），而所有生成物落在仓库内固定的
`D:\projects\CANNESS\canness-workspace\`：

```text
canness-workspace/
├── .canness/state.json
├── operators/gen-d9175b4a, gen-21916f68, …      # 14 个历史代
├── packages/gen-*/                              # 构建契约包
├── submissions/gen-21916f68-dYksQm/             # 导出物
└── audit-e2e/, sim_*.py, stub/                  # 本次新增的校验脚手架
```

`docs/reference/configuration.md` 写的是"默认从会话目录派生 `canness-workspace`"，但实际行为
是**恒定落在插件源码目录旁**：把 cwd 换成桌面某个文件夹，生成物依然在插件树里，这与文档
描述不符，也与用户对"我的项目在哪里"的直觉不符。

## 期望

工作目录 = DSH 会话工作目录（或其下的约定子目录），与 `pwd` 一致：
用户在桌面某个文件夹里开会话，`operators/ packages/ submissions/` 就出现在那里。

## 影响

1. **冗余**：插件仓库里多一棵与源码无关的产物树（现有 14 个历史代），`git status` 噪音、
   打包/检索都会被污染；
2. **放大了 CAN-001**：评测工件落进仓库树，于是沙箱 ACL 分裂正好打在评测闭环的文件
   操作上（拷源码、重打 zip、本地编译校验）；
3. **远端回传位置**：`fetch_remote_file` 默认落 `remote-files/<basename>`，同样跟着插件树走；
4. **多任务互相干扰**：`workspace` 是单例，两个并行算子任务要么串行、要么共用同一棵
   `operators/` 与 `state.json`。

## 复现

在任意目录 `cd` 到一个空文件夹后开会话（或直接改会话 cwd），执行 `submit_spec` +
`build_test_package`，观察产物落点：仍在插件源码目录旁的 `canness-workspace/`。

## 建议修复

1. workspace 解析改为**唯一规则**：`cwd`（可被显式配置覆盖），删掉"插件相对路径"这一支；
2. 迁移旧目录时给出一次性提示（"检测到仓库内旧 workspace，是否移动到 `<cwd>/canness-workspace`"）；
3. 三个插件（generator / eval / loop）共用同一解析函数，避免各自默认值漂移
   （配置文档已警告"三处应指向同一目录"，说明已有漂移风险）。

## 验收标准

- 在空目录开会话：`operators/`、`packages/`、`submissions/` 出现在该目录下的 workspace 中，
  插件源码树零新增文件；
- 旧 workspace 存在时给出迁移提示而非静默使用；
- 两个并行会话各自 cwd 不同 → 各自独立的 generation 与 state，互不影响。

## 更正（2026-11-18 16:20，复核源码后）

**本条原描述有一处错误**：workspace **本来就是**"会话 cwd + `canness-workspace`"
（`resolveWorkspace` 一直是 `resolve(cwd, configured || 'canness-workspace')`）。
本次产物看起来"落在插件源码树内"，是因为**该会话的 cwd 恰好就是插件仓库根目录**
（`D:\projects\CANNESS`），两者重合，不是硬编码。

真正的缺陷只有一处，且已被修复（在 `src`，见 CAN-016 关于未生效的说明）：

```ts
// 修复前：只认 header.cwd，取不到就退回 process.cwd()
const cwd = context?.agent?.session?.header?.cwd
// 修复后：优先会话级 cwd
const cwd = session?.cwd ?? session?.header?.cwd
```

即：当会话 cwd 只暴露在 `session.cwd` 而不在 `header.cwd` 时，旧代码会静默退回
`process.cwd()` —— 若两者不同，产物会落到**错误的位置**。这才是本条要保留的部分。

因此本条的定位应从"P0 设计缺陷"降为"**P2：cwd 解析健壮性 + 并行会话隔离**"，
并且"把默认值改成会话 cwd"这一诉求**不需要改**（已经是了）。
真正仍需保留的是"一个 workspace 只能承载一个活跃任务"的隐忧 → 已单独记为 CAN-017。

## 关联

CAN-001（沙箱 ACL）、CAN-014（远端工件落点）、CAN-017（共享预算与归属，本条的真实风险）
