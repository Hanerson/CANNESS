# CAN-228 tiling 缓存在同步和 H2D 成功之前提交

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P2** |
| 组件 | `plugin/templates/cannbench/launch.cpp` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `export`, `tiling`, `launch` |
| 复核 | 2026-11-27。验收覆盖失败后重传与同一缓冲的并发调用 |

## 现象

`CannessTilingChanged` 在锁内发现 host 镜像变化后，立刻 `cached = host` 并返回 true。`aclrtSynchronizeDevice` 和 `aclrtMemcpy` 在锁外。同步或拷贝失败时函数返回错误码，缓存却已经记下「这块和 host 一样」。下一次相同 host 镜像会返回 false，跳过拷贝。

workspace 是否每次清零，是单独的 scratch 初始化契约。当前规格没有承诺每次调用都清零。那件事不在本条的期望和验收里。

## 证据

- `plugin/templates/cannbench/launch.cpp` 第 34–42 行：相等则 false；否则 `cached = host` 后 return true。
- 第 59–72 行：`CannessTilingChanged` 为 true 才同步并 `aclrtMemcpy`。拷贝失败直接 `return`，没有回滚缓存。
- 第 62–73 行：比较与拷贝不在同一把锁里。
- `plugin/src/submission-rules.ts` 检查源码里出现 `CannessTilingChanged` 和一次 `aclrtSynchronizeDevice`。它不检查缓存提交顺序。

## 影响

拷贝失败后的重试会跳过 H2D，随后的 launch 可能使用未更新的设备 tiling。并发调用复用同一个缓冲且要求不同 tiling 时，仅移动缓存提交点仍可能出现复制与 kernel 入队交错，导致一次调用使用了另一份 tiling。

## 期望

缓存只记录已成功上传、且仍对应当前设备缓冲的内容。同步或 H2D 失败后，重试仍会上传。并发复用同一缓冲时，每次 kernel 都应看到本次调用的 tiling，已入队 kernel 仍在使用的内容不会被后续调用提前覆盖。

## 复现

1. 让 `aclrtMemcpy` 第一次返回失败，host 镜像不变。
2. 第二次调用应再次拷贝。按当前代码，`CannessTilingChanged` 返回 false。
3. 并发用例让两个调用使用同一设备缓冲和不同属性，在复制与 kernel 入队之间控制交错，检查每次 launch 读到的 tiling。

## 建议修复

- 按设备缓冲协调比较、必要的同步和复制、缓存提交及 kernel 入队。发送不同 tiling 前，确保此前已入队的 kernel 不再读取该缓冲，或者为重叠的调用使用独立缓冲。
- 复制返回 `ACL_SUCCESS` 后才记为已上传。失败路径不能把未成功上传的内容标成可复用。

## 验收标准

- 模拟 memcpy 失败后，下一次相同 host 镜像仍会拷贝。
- 拷贝成功且设备缓冲仍保存相同镜像时，可跳过重复拷贝。
- 两个调用在同一缓冲上使用不同属性时，受控交错测试确认各自读取自己的 tiling，已有 kernel 未读完时缓冲不会被覆盖。

## 关联

CHANGELOG 里按属性集缓存 aclrtMemcpy 的修复。本条是那次缓存的提交点。

## 处置和验证

同步与复制成功后提交缓存，复用设备缓冲时协调复制、缓存和 kernel 入队。失败重试、多 dtype 及并发路径有本地夹具。
