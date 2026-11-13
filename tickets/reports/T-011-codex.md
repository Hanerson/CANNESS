# T-011 完成报告

- 认领人：Codex；日期：2026-11-13
- 分支：`codex/tickets-t003-t014-20261113`；PR：未建；基线提交：`0acfb84`；本次提交：见分支最新提交

## 做了什么

先在真实 CANNLab 编译器探测 `--cce-fatobj-link`：参数存在，但原头文件仍引入两个 `g_tilingKey`，链接失败。因此采用票据备选方案，拆出不依赖 `kernel_operator.h` 的 `canness_tiling_common.h`，主机编译单元只包含共用 POD；删除 `--allow-multiple-definition`。

## 验证记录

`pnpm test`：22 个文件、184 项通过。真实 CANNLab 多次最小包和 ArgMaxProbe `compile.ok=true`、精度通过。远端 `nm` 对同一包的结果：`main.o:0`、`kernel.o:1` 个 `g_tilingKey` 定义；链接无需放宽选项。

## 遗留问题

推荐的单次 fatobj 编译方案在此 CANN 9.1 环境下未解决重复符号；已采用头文件拆分方案。
