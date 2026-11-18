# CAN-008 / CAN-018 / CAN-019 本地修复结果

2026-11-18，按用户授权同时修改 CANNESS 与本机 dsh 源码；未连接 NPU，未重启正在运行的 dsh。

## CAN-018

本地 kernel 检查按真实 build.sh 契约依次强制包含 stub 和 canness_tiling.h。回归覆盖源码显式 include、完全依赖强制 include、生成的 contract-selfcheck，以及真正的未知 API/类型错误。

原有 packages/gen-21916f68 Cummin 包在 float16、float32、bfloat16、int32 四种宿主语法检查中通过。该结果不等于目标端验证。检查仍仅在调用方显式提供 kernel_dtypes 时启用。

CANNESS 全量：35 文件、257 用例通过；host/client 类型检查通过，lib 已重建。

## CAN-008（dsh 诊断部分）

本机 D:/SE_Tools/deepseek_harness/deepseek-harness 的 ToolArgsError 在注册工具执行校验失败时附目标工具名及实参顶层键，不输出参数值；INVALID_ARGS、violations 和旧构造调用保持兼容。

这是明确校验归属的诊断修复，不声称已复现或定位历史上的偶发派发异常。测试验证两个相似名称工具独立校验、校验先于执行、连续 20 次调用及旧接口兼容。

## CAN-019（dsh）

现有 plugin-manager 工具组件新增只读 profile_status：报告 launcher profile、startupBundles、configuredBundles 与调用作用域注册工具。启动事实和下一次启动配置明确区分，不把配置成功当成已加载证明。

UNKNOWN_TOOL 保留原错误身份，附当前 profile 和启动 bundles，并提示使用 profile_status。标准 web 的工具组件可在未加载 CANNESS 时提供该诊断。

dsh tools + plugin-manager 完整模块回归：27 文件、719 通过、3 跳过。Windows Git 回滚测试需将本次测试超时设为 15 秒；未改项目超时配置。两个模块类型检查和构建完成；编译模块直接调用已确认包含新错误诊断。工具目录与双语模块说明已同步。

重建后的 profile_status 也已在最小单元测试上下文直接调用，返回 web、启动 bundles 和作用域工具清单。官方双语配对检查已对 tools README、plugin-manager README、生成工具目录三组全部通过。首次完整测试中的目录预期差异已同步；两条 Windows Git 回滚用例的 5 秒超时在上述 15 秒重跑中通过。

## 生效边界

两个仓库均未提交。重建产物可供新进程加载，但现有 dsh 模块缓存未被替换。用户下次重启时应继续选择 canness-web；本轮没有停止服务、切换 profile、改预算或重连隧道。
