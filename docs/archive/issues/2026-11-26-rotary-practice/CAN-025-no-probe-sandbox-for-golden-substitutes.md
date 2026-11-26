# CAN-025 没有"探针沙箱"：为验证 intrinsic 语义必须手工改包 / 换 golden，且与真源脱节

> 去重：本条扩展既有 **CAN-112**（golden fixture 绑字面 shape）与 CAN-103，建议并入 CAN-112，作为「identity golden 探针」需求。

| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | **P2** |
| 组件 | `canness-generator`（`write_package_file` 只接受 `golden.h`）/ `canness-eval` |
| 首次发现 | 2026-11-25，验证块跨步 `DataCopy` 与 Level-0 广播语义 |
| 状态 | **open**（用户侧 workaround：`dev/try.sh` 复制包目录 + 替换 kernel/golden） |
| 标签 | `probe`, `golden`, `sandbox`, `debuggability` |

## 现象

写 tile 级 kernel 前必须先确认两个原语的语义：块跨步 `DataCopyParams` 的 stride 是"间隔"还是
"绝对块号"、Level-0 `Mul(dst,src0,src1,mask,repeatTimes,BinaryRepeatParams)` 的 mask 是位模式
还是计数。正确做法是"用 identity golden 跑一个纯拷贝 kernel"——但插件里没有合法通道：

- `write_package_file` 只接受 `golden.h`，换 golden = 破坏当前 operator 的精度参考；
- 没有"一次性沙箱"：不能在不污染 `operators/<gen>`、不消耗迭代预算的前提下，用
  (kernel, golden, spec) 三元组跑一次。

我实际的做法是 `dev/try.sh`：

```bash
cp -r /root/rotary-dev/gen-… /root/rotary-dev/try-$name
cp probe_kernel.cpp  $dst/op_kernel/kernel.cpp
cp probe_golden.h    $dst/golden.h
bash build.sh && ./canness_run 2
```

代价：探针包完全游离于插件之外（不进 `provenance`、不进知识库、别人看不到），而且我一度
把"旧探针的数学写错"当成"Level-0 语义不通"，多绕了半天（探针 r1/r2 用的是未修 partner 的
公式，导致 ~50% lane 不对的假象）。

## 期望

- 提供 `probe_run({ kernel, golden, spec?, args? })`：在临时沙箱里构建并运行，返回
  `badCount/maxAbsErr` 等，**不写** `operators/`、**不消耗**评测预算、结果可丢弃；
- 或者 `write_package_file(path, variant: "operator" | "probe")`，probe 变体不影响 golden 真源；
- 探针运行成功时，允许把结论一键记进知识库（`kb_search` 可检索），避免每个算子重做同类探针。

## 影响

- 每个算子都要自己造探针工具，且结论不留痕；
- 探针与真源容易不一致（我本地 `dev/probe_*` 与远端 `/root/rotary-dev/*` 就有多份副本）；
- 探针写错时会得出错误结论（本轮真实发生：错把 Level-0 判成"语义不明"，实际上探针公式错了）。

## 复现

1. 想验证 `DataCopyParams` 语义 → 现有工具里没有入口；
2. 唯一能做的是复制包目录并改 kernel/golden（本轮 `dev/try.sh`）；
3. 这些改动不会被任何报告/溯源记录，跑完即丢。

## 建议修复

- 新增 `probe_run` 工具（复用 runner 的 build/run 能力，设备与锁同 CAN-020）；
- 探针结果里带 `kernelSha`/`goldenSha`，可归档；
- 提供 `kb_record` 通道，把"某 intrinsic 在某 CANN 版本上的实测语义"沉淀成知识条目。

## 验收标准

- 不改 `operators/`、不动当前 golden 就能跑任意 (kernel, golden) 探针；
- 探针结论可检索（知识库），同类验证不必重复做；
- 探针运行不消耗迭代预算，且不影响当前 generation 的哈希/报告。

## 关联

CAN-020（设备/锁）、CAN-021（闭环）、CAN-022（可观测性）
