# WholeReduce*：repeat 与缓冲别名

在 910B / CANN 9.0.0 的 ArgMax 实测中，`WholeReduceMax` / `WholeReduceMin`
单次调用的 `repeatTimes` 安全上限是 **64**。设为 128 时编译、链接、运行均不报错，
却出现每个 tile 第 4 行恒错（`bad=512/2048`）。

拆成两次 64 仍不能保证正确：若同一 `LocalTensor` 的一段同时充当上一调用的
src 和下一调用的 dst，可能出现别名相关错误。给两次调用独立缓冲；若必须复用，
在依赖边界加入 `PipeBarrier<PIPE_V>()` 并用精度测试验证。

这些是上述芯片与工具链上的观察值。换版本时应重新做包含边界值 64、65、128 的精度测试。
