# CAN-114 其余工作流摩擦：层不能跨代继承 / 断开无程序化重连 / target_us 无校准

| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | P3 |
| 组件 | `submit_spec` / `write_operator` / `run_evaluation` / `canness-remote` |
| 首次发现 | 2026-11-19（分别在第 09:44 / 10:04 / 09:16 遇到） |
| 状态 | 部分绕过 |
| 标签 | `workflow`, `dx`, `budget` |

本轮还遇到三件小事，都影响"理想工作流"，但影响面小于 CAN-101~105。

## 114.1 改一个 attr 就要整份重写四层；没有"从上一代继承"

**现象**：为了加一个诊断属性 `mode`，必须 `submit_spec` 出新 generation
（`carriedOver: true, carriedLayers: false, needsLayers: true`），
而 `write_operator` 只能整份重新传 layer 文本（我的 kernel 已 15~19 KB）。
我的做法是绕过工具**直接在磁盘上 cp**：

```powershell
Copy-Item -Recurse operators\gen-aa5bc51e\op_kernel operators\gen-d72dad54\op_kernel
```

它能成立，只因为 `build_test_package` 是从 `<workspace>/operators/<gen>` 读文件；
但这条路会让 `layer-origins.json`（provenance）**没有**对应声明，等于静默跳过来源记录。

**建议**：`submit_spec` 支持 `layers: "carry"`（把上一代的四层带过来），
或 `write_operator({ from: generationId })`；文档明确"generation 目录就是真相源"。
**验收**：改 spec 后一次调用即可拿到带 provenance 的完整 generation。

## 114.2 传输断开只能人工重连

**现象**：`run_evaluation` 返回

```text
{"status":"error","blockedBy":"transport",
 "summary":"ssh connect failed for 127.0.0.1:20022: connect ECONNREFUSED …
            CANNLab environment \"DevEnvC_qUR8w\" is running … Reconnect from Settings → CANNESS."}
```

预算处理是对的（`validIterations` 没增加，`pendingStage: run_evaluation` 保留），
但 agent 侧没有任何工具能触发重连/CANNLab tunnel renew。

**建议**：`reconnect_remote()` 工具（等价于 UI 上那次点击），或 `run_evaluation`
在 `blockedBy: transport` 时自动尝试一次 `tunnel.renew()`（`eval.ts` 里
`tunnel.health()/renew()` 逻辑已存在，只是没在评测路径上自动使用）。
**验收**：隧道断开后，一次工具调用即可自愈，无需人工点 UI。

## 114.3 `performance_target.target_us` 没有校准辅助

**现象**：我按 roofline 猜了 450 us（`t_hw_us = 278`），而实测基线
`torch_npu.npu_swiglu = 508 us`。目标定得比基线还激进，导致每轮都是 `perf_fail`，
而 `perf_fail` 在报告里看起来和"差 10 倍"没有区别。官方 metadata 里其实给了
每个 case 的 `t_hw_us` 与 `baseline_perf_us`。

**建议**：`submit_spec` 接受 `performance_target.reference`（已存在于 schema）并
在同机跑一次基线，自动给出 `target_us = baseline × α`；或至少
`preflight_evaluation` 提示"target 比该机基线更激进"。
**验收**：新算子的 `target_us` 有同机依据（`runRecord` 里能看到基线测量）。

## 关联

CAN-101/102（P0 阻塞）、CAN-103/104（修包受限）、CAN-105（单 shape 覆盖）
是最该先修的四条；本文件三条属于"打磨"。
