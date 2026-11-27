# CAN-214 并入仓库 CAN-114

| 字段 | 值 |
|---|---|
| 类型 | 合并记录 |
| 优先级 | 不单独立项 |
| 组件 | 仓库 `docs/archive/issues/2026-11-19-practice-findings/CAN-114-minor-workflow-friction.md` |
| 首次发现 | 2026-11-19 实践；2026-11-27 只读评估曾改编号为 CAN-214 |
| 状态 | **并入 CAN-114** |
| 标签 | `layers`, `cannlab`, `budget` |
| 复核 | 2026-11-27。不再作为新的开放缺陷 |

桌面评估一度把仓库 CAN-114 重新编号为 CAN-214。复核要求并回原条目。后续追踪以仓库 CAN-114 为准。CHANGELOG `[0.5.0]` 仍把 CAN-114 列在「仍未修」。

本记录只保留复核收窄后的三点，避免和原条目的建议分叉。

## 114.1 属性变化使源码继承失效

`sameSourceContract` 忽略 `performance_target` 和 `confirmation`。改一个 `attrs`（例如 axis）得到 `needsLayers: true`，四层要重传。

层继承只宜保留明确不依赖该属性的产物。依赖该属性的层继续重传，并在 provenance 里记下属性差。

证据：`plugin/src/generator-sources.ts` 第 7–17 行；`plugin/tests/generator-artifacts.test.ts` 第 27–31 行把 `attrs: { axis: 1 }` 断言为 `carriedLayers: false, needsLayers: true`。

## 114.2 工具缺少重连入口

CANNLab 隧道状态为 `down` 时，评测返回去设置里重连。`renew()` 仅在已经是 `up` 时调用（`plugin/src/eval.ts` 第 219–224 行）。设置卡没有代为重连的动作。原 CAN-213 里的重连描述归入这里，设置卡本身的字段和确认问题仍在 [CAN-213](CAN-213-settings-card-cannot-express-workflow.md)。

期望保持仓库 CAN-114 的验收：隧道断开后，一次工具调用可以发起已有的 connect，失败再提示人。

## 114.3 `reference` 未进入预算校准

`performance_target.reference` 会被保存（`plugin/src/spec.ts` 约第 300 行）。全库没有读取它来校准 `target_us`。停机仍看手填的 `target_us`。

`reference` 若保留，就要进入目标比较；否则从规格里去掉。屋顶线数值见 [CAN-215](CAN-215-roofline-only-original-910.md)，不要把空的 `baselineUs` 当成已经校准。

## 验收（记在 CAN-114 上）

- 只改 `performance_target.target_us` 时层仍沿用。这项已经成立。
- 属性变化时，只沿用明确不依赖该属性的产物；依赖该属性的层重传，provenance 记下差异。
- 隧道 `down` 时有一次工具级重连入口。
- `reference` 要么影响停机说明，要么规格拒绝这个字段。

## 关联

仓库 CAN-114。桌面相关条目：CAN-205、CAN-209、CAN-213、CAN-215。

## 处置和验证

层继承、工具重连和参考目标校准继续由 CAN-114 跟踪。
