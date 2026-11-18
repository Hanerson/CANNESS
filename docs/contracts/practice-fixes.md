# 2026-11-18 实践问题修复

继续依据桌面 canness-issues 的复核版实施。CAN-001 依照该版裁定保留为 dsh/宿主环境问题，插件不修改 ACL 或安全策略。CAN-008 的跨工具 schema 派发同样不在插件内修复。

- CAN-002：共享解析器支持 session.cwd 与 header.cwd，显式配置优先。旧 profile 中的绝对 workspace 不自动迁移；一个 workspace 承载一个活跃任务。
- CAN-003/008：同契约续代/reset 复制源文件及来源声明；返回 carriedLayers/needsLayers；支持单层更新，缺文件报错指向 write_operator。
- CAN-004/017：相邻候选明显回退才累计负向趋势，同包重测不算新候选；采样口径改变重开比较窗口。force 只能跨一次软停机，不能跨超时和资源预算上限。策略拒绝保存 lastBlocked；归属冲突明确拒绝，不能悄悄接管别人的预算。
- CAN-005：run_evaluation({compile_only:true}) 是独立诊断，不更新评测计数、不覆盖正式结果。fetch_remote_file 可读取本地已知历史代及显式 readRoots，解析远端符号链接后限制范围，限 8 MiB 并返回 SHA-256。
- CAN-006/007：共享环境探测、未采集指标标记、固定请求采样数、计分/墙钟口径和差值、分阶段时间与原始统计行。blockDim 优先使用 profiler 数据，缺失时回填启动配置并标记 blockDimSource；kernelTaskType 从源码明确的 AIV/AIC 声明读取并附来源，原始 taskType 不被覆盖。没有证据时保留未知。
- CAN-009/010：direct-launch 契约明确仅 kernel 编译，host/api/plugin 为 documented-only；attrs 通过 find(name) 查找，公开顺序使用 interface.attrs。
- CAN-011：自定义 wrapper/signature 纳入来源哈希，导出默认为 unverified。validate_submission 在独立目录校验源码指纹、构建 wheel、隔离 venv 安装，用户提供的参考比对脚本必须输出 CANNESS_VALIDATION；未提供脚本不宣称精度通过。
- CAN-012/013：可选批量 golden 入口；仅宿主驱动抑制已知 ignored-attributes 噪音。
- CAN-014：报告提示临时工件风险。生产环境应显式设置持久化 inbox/outbox；插件不能从非 /tmp 路径推断磁盘一定持久化。
- CAN-015：check:golden 编译实际 golden，对独立参考向量比对，覆盖原始 int64 和特殊浮点数。check:kernel 使用受限的宿主 API stub 对实际 kernel 做多 dtype 语法检查。preflight_evaluation/run_evaluation 可传 golden_fixtures、kernel_dtypes；失败不消耗远端预算。stub 检查不证明目标端 API 支持、设备执行语义或性能，目标验证另用真实 compile_only。
- CAN-016：contract 同时记录实际执行代码哈希与模板内容哈希；lib 陈旧时返回明确 warnings，源码测试不会谎报使用 lib。代码更新后需重建并重新加载插件；正在运行的旧进程不会自动替换模块。

## 调用

`run_evaluation({compile_only:true})`：诊断编译。

`preflight_evaluation({golden_fixtures:"checks/reference.json"})`：本地 golden 检查，可再传 remote:true。

`preflight_evaluation({kernel_dtypes:["float16","float32","bfloat16","int32"]})`：本地 kernel 语法检查。`run_evaluation` 可接受同样字段，在本地检查失败时拒绝远端执行。

`validate_submission({source_dir:"submissions/.../source",test_script:"..."})`：隔离构建安装与参考比对，不修改系统 Python。

`export_submission({callable:"cummin",wrapper:"...",signature:"cummin(input, dim)"})`：自定义接口。wrapper 负责从张量推导内部几何。

远端额度耗尽的事实意味着本轮不能声称完成真机回归。自动化测试、构建产物检查和真实 NPU 验证必须分别报告。
