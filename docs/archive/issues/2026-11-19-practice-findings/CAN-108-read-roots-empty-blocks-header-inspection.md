# CAN-108 `readRoots` 默认空：KB 让你"读头文件"，但读不到

| 字段 | 值 |
|---|---|
| 类型 | config |
| 优先级 | P1 |
| 组件 | `canness-eval`（`readRoots`）、`fetch_remote_file`、`ssh2-transport` |
| 首次发现 | 2026-11-19 09:39 |
| 状态 | 未解决（本轮硬卡住一次根因定位） |
| 标签 | `remote`, `read`, `header` |

## 现象

为了搞清 `DataCopy` 多 burst 的真实约束（burst 长度、`srcStride` 单位、
`blockCount` 上限），我想读目标机已安装的头文件：

```text
fetch_remote_file({
  remotePath: "/home/developer/Ascend/cann-9.0.0/aarch64-linux/tikcpp/tikcfw/interface/kernel_operator_data_copy_intf.h"
})
-> Error: remotePath is outside the allowed remote directories (outbox and inbox/<generationId>)
```

但同一插件的 KB 条目 `CAN-005`（archive）明确写着：

> 只读的远端探测：`fetch_remote_file` 增加只读白名单目录（默认 `$ASCEND_TOOLKIT_HOME/**`，可配置），
> 并对读到的文件记录 sha256；**用 `fetch_remote_file` after configuring the precise toolchain readRoots**

即："先配 `readRoots` 再读头文件"是**设计上的预期路径**，但
`cordis.patch.yml` 的 `canness-eval` 段里没有 `readRoots`，默认值是空数组 →
预期路径开箱不可用，而 agent 侧没有任何工具能改 profile 配置。

## 影响

- 本轮直接后果：我无法确认 `DataCopy` 多 burst 的合法参数范围，
  只能靠"小 burst 会崩"的黑箱经验设计 tiling（见下一条 CAN-109 的连锁）；
- 白名单默认值的选择把"最需要读的目录"（CANN 头文件）排除在外，
  而它恰恰是 KB 反复推荐的信息源；
- `preflight_evaluation({remote:true})` 已经能探测到
  `setEnv=/home/developer/Ascend/ascend-toolkit/set_env.sh`，
  说明插件**知道**工具链根目录，却没把它用作只读白名单。

## 我用的临时补丁

没有可用补丁：我改用 KB 里的二手结论 + 实验法（A/B 探测哪些 burst 长度会崩）。
代价是 CAN-109 里那条"参数扫描"实验，以及至少 2 轮 validate 周期。

## 建议修复

1. `readRoots` 默认包含 `$ASCEND_TOOLKIT_HOME/**`（只读、拒绝符号链接逃逸、
   单文件限长、返回 sha256 —— 这些 `ssh2-transport` 里已经实现了，只是没被默认启用）；
2. `preflight_evaluation({remote:true})` 的返回里列出 `readRoots` 实际生效值；
3. `fetch_remote_file` 报错时给出"当前白名单 + 如何配置"的提示，而不是只说不允许；
4. 允许 agent 通过工具（而不是 UI 配置）追加**临时只读根**，作用域限定本次会话。

## 验收标准

- 新会话默认就能 `fetch_remote_file` 读到 `$ASCEND_TOOLKIT_HOME` 下的任意 `.h`；
- 读取结果带 sha256，可直接作为 KB 条目的 `source`；
- 越界读取的报错文案包含可用白名单与配置方法。
