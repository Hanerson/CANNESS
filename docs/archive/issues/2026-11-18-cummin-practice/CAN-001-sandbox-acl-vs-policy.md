# CAN-001 沙箱策略声明为 workspace-write，但 shell 无法写工作区（ACL 分裂）

| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P1**（原 P0；裁定归环境/DSH 侧） |
| 组件 | `dsh-sandbox-policy` / `canness-workspace` |
| 首次发现 | 2026-11-18，Cummin 实现（gen-d9175b4a 迭代） |
| 状态 | **fixed（规避式，2026-11-18 19:13）/ 残余移交 dsh** |
| 标签 | `sandbox`, `workspace`, `blocks-loop` |

## 处理情况（2026-11-18 16:20 复核）

**结论**：不由插件修复。`docs/superpowers/plans/2026-11-18-practice-issues.md` 的裁定为「environment/host ownership; diagnose rather than modify ACLs from plugin」，本轮 `git diff` 未触及任何 sandbox/ACL 相关代码，符合该裁定。

**为什么不阻塞了**：本条造成的两处后果已被别的修复部分绕开 —— 需要写的本地产物（golden 校验、打包）现在有官方通道（`check-golden.mjs`、`export_submission({wrapper})`），不再依赖 shell 往工作区写文件。

**仍需 DSH/沙箱侧处理**：`write` 工具新建的目录未把执行用户加入 ACL；建议启动时对新目录做一次写探针，失败则以 `blockedBy: sandbox-acl` 显式报错，并指向 `diagnose-windows-sandbox-acl`；ACL 失败也不要复用 `[sandbox: file access denied under <mode> mode]` 文案。

## 现象

会话 file policy 为 `workspace-write`，工作区为 `D:\projects\CANNESS`，且 `D:\projects\CANNESS\canness-workspace`
在其内部。但 `pwsh` 对该子树内**任何**文件写入都被拒：

```text
Set-Content : Access to the path 'D:\projects\CANNESS\canness-workspace\operators\gen-d9175b4a\op_kernel\kernel.cpp' is denied.
[sandbox: file access denied under workspace-write mode]
```

同时 `write` / `edit` 工具写同一路径**完全正常**；`g++` 也能正常读取。

更具体的一处：`write` 工具新建的 `canness-workspace\stub\` 目录，`pwsh` 在其中 `Copy-Item` / `Set-Content` 同样被拒：

```text
Copy-Item : Access to the path 'D:\projects\CANNESS\canness-workspace\stub\canness_tiling_common.h' is denied.
UnauthorizedAccessException
```

而 `$env:TEMP` 下的写入正常（`$env:TEMP\dbg.py`、`$env:TEMP\canness-golden-check\*.exe` 均可写可执行）。

## 期望

策略声明与实际权限一致：`workspace-write` 下，会话工作区（含本次会话新建的子目录）对
shell、编译器、打包命令均可写。

## 影响

本该是两条普通步骤、却被迫两次 `sandbox_permissions: danger-full-access` 升级（每次弹审批）：

1. `submit_spec(reset:true)` 新建了 `operators/gen-21916f68/`，需要把上代四层源码 + `golden.h`
   复制进去（见 CAN-003），`Copy-Item` 被拒；
2. 需要在工作区内编译本地校验程序（`stub/golden_test.exe`）、重打 CANNBench zip，均被拒。

在一个 3.5 小时、6 次评测的闭环里，这条把"能自己验证的环节"推到了远端，等于**用沙箱错误
换来了远端编译预算的消耗**（与 CAN-005 叠加）。

## 复现

1. 会话策略 `workspace-write`，工作区为含子目录 `canness-workspace` 的仓库；
2. 用 `write` 工具在 `canness-workspace/sub/` 建一个文件（成功）；
3. 用 `pwsh` 执行 `"x" | Set-Content canness-workspace/sub/b.txt` → denied；
4. 用 `pwsh` 执行 `Set-Content $env:TEMP/b.txt "x"` → 成功。

第 2、3 步的组合（工具能建目录、shell 不能写该目录）说明不是"路径不在白名单"，而是
**新建目录的 ACL 未授予沙箱执行用户**，即继承问题，而非策略问题。

## 定位线索

- 仓库里已有专门 skill：`diagnose-windows-sandbox-acl`（"workspace writes or listing fail …
  inspects the path and every ancestor and repairs the ACL problems it proves in that run"）。
  本次没有任何提示把这条 skill 关联到这个症状。
- 症状与"策略拒绝"（policy denial）在文本上被区分：policy denial 打印
  `[sandbox: file access denied under <mode> mode]`，而这里是 PowerShell 的
  `UnauthorizedAccessException` **外加**一条 sandbox 提示 —— 两者混在同一 stderr 里，
  容易被当成"策略不让写"。

## 建议修复

1. `write` 工具创建目录/文件时，把沙箱执行用户加入 ACL（或使用与工作区根一致的显式 ACL），
   而不是依赖继承；
2. 沙箱启动时自检：在**新创建**的子目录里做一次写探针，失败则以 `blockedBy: sandbox-acl`
   显式报错并指向 `diagnose-windows-sandbox-acl`，而不是让每条命令各自报 UnauthorizedAccess；
3. 区分文案：ACL 失败不要复用 `[sandbox: file access denied under <mode> mode]`，否则用户
   无法判断该改策略还是修 ACL。

## 验收标准

- `workspace-write` 下，`pwsh` 可对 `write` 工具新建的工作区子目录写入、复制、执行编译产物；
- 故意破坏子目录 ACL 后，报错文案指向 ACL 修复路径，而非策略；
- 上述场景不再需要 `danger-full-access` 升级。

## 修复记录（2026-11-18 19:13：已闭环）

**硬证据（`icacls`，本机实测）**

```text
D:\projects\CANNESS                     S-1-4-915212864-956664120:(OI)(CI)(W,D,DC)   ← 授权在根上
D:\projects\CANNESS\canness-workspace   （无任何 S-1-4- 条目）                       ← 子目录未获得授权
```

进程可写授权只落在会话工作区根（外加每会话私有 temp）；`canness-workspace` 这类**早于授权存在的嵌套目录**
不会补上该 ACE。插件自身的文件写入走普通用户令牌，所以出现"文件工具能写、`pwsh` 不能写"的分裂。
这也解释了为什么连新建的 `stub/` 都写不进去：父目录不可写，创建本身就被拒。

**采用的处理：让产物回到授权根，不再制造嵌套目录**（不改 ACL、不提权）

- `plugin/src/workspace.ts`：默认工作区 = 会话 cwd 本身；显式 `workspace` 的相对路径按会话目录解析；
  `tests/practice-policy.test.ts` 同步改写并新增断言「结果不以 `canness-workspace` 结尾」；
- 仓内旧目录 `D:\projects\CANNESS\canness-workspace\` **已迁出并删除**：`operators/`、`packages/`、
  `submissions/`、`.canness/` 移至仓库根（即会话 cwd），开发脚手架移至 `.canness/tools/`；
- `.gitignore` 改为忽略四个产物目录；`docs/{guides/setup,reference/configuration,design/05-plugin-architecture}.md`
  与 `CHANGELOG` 同步；
- 验证：`tsc --noEmit` 干净、`vitest` 255 项通过；重建 `lib` 后直接调用 `resolveWorkspace`，三种输入分别得到
  会话 cwd、另一会话 cwd、`<cwd>/artifacts`。

**残余（移交 dsh，不再阻断本项目）**：Windows 上"额外可写目录"仍只对文件工具生效
（`sandbox-policy/src/index.ts:69`），沙箱进程只能写会话根与私有 temp。任何把产物放到会话根之外的配置都会
重新触发本条；DSH 侧修法见上文"建议修复"的 A（文案区分）与 B（为额外根落 ACE）。

## 关联

CAN-002（workspace 位置）、CAN-003（reset 丢源码）、CAN-005（远端编译预算）
