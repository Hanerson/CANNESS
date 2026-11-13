# T-012 完成报告

- 认领人：Codex；日期：2026-11-13
- 分支：`codex/tickets-t003-t014-20261113`；PR：未建；基线提交：`0acfb84`；本次提交：见分支最新提交

## 做了什么

`manifest.contract` 记录 schema、模板修改时间、运行时 lib 哈希和插件版本，`build_test_package` 工具返回该指纹。`run_evaluation` 上传前核对 `manifest.packageHash`，修改后的包需重新打包。包里自带最小 `DataCopy` kernel；无本地 CANN 编译器时，远端 runner 在正式 kernel 前编译自检并把失败明确归因于契约模板。

## 验证记录

`pnpm test`：22 个文件、184 项通过。本地篡改包测试在调用上传前抛错、假远端文件数为 0；不支持的 dtype 不替换旧包。真实 CANNLab 上，自检与正式算子均 `compile.ok=true`；故意在自检 main 中加入编译错误，报告 `compile_fail`、摘要为 `contract template itself broken: minimal kernel did not compile`，正式 kernel 未进入编译。

## 遗留问题

本地没有 CANN 编译器，所以模板损坏在远端 `run_evaluation` 的自检阶段发现，不能在本机 `build_test_package` 当场编译失败；这采用了票据允许的远端方案。
