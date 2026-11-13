# T-009 完成报告

- 认领人：Codex；日期：2026-11-13
- 分支：`codex/tickets-t003-t014-20261113`；PR：未建；基线提交：`0acfb84`；本次提交：见分支最新提交

## 做了什么

`OperatorSpec.attrs` 接受有限数字、布尔和字符串；`GoldenCtx` 传递输入 0 的 shape/rank、dim/keepdim 及类型化属性数组。浮点 golden 保留旧签名，通过 `CANNESS_GOLDEN_WITH_CONTEXT` 选择新签名。`CANNESS_REQUIRE_SHAPE` 在自定义 golden 中也可用，断言失败转成明确的精度失败。

## 验证记录

`pnpm test`：22 个文件、184 项通过。真实 CANNLab：形状 32 的参考验收 `pass`；把 spec 改成形状 64 而保留断言 32，报告 `accuracy_fail`，摘要包含 `golden shape assertion failed`，没有得到假 `badCount=0`。本地边界测试覆盖非法 attrs、无效 shape、特殊字符串转义。

## 遗留问题

符号形状无法在主机驱动分配出具体尺寸，`GoldenCtx.rank=0`；需先把符号实例化为数值尺寸才能做真实评测。
