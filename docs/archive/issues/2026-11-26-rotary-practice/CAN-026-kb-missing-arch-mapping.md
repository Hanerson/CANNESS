# CAN-026 知识库把编译目标写成 SoC 部件号，缺 910B/A3/950 的微架构映射，照着做在 A3 上必挂

> 去重：本条属于既有 **CAN-113**（KB 缺口）的一个子项，但影响面大（直接决定 A3/950 能否编译），建议保留独立编号。

| 字段 | 值 |
|---|---|
| 类型 | bug（知识缺陷） |
| 优先级 | **P1** |
| 组件 | `canness-knowledge`（`knowledge_base/AscendC_Compile_Run.md`） |
| 首次发现 | 2026-11-25，按 KB 写法产出 A3 不可编的包 |
| 状态 | **open**（用户侧 workaround：照对照包改成 `-xasc --npu-arch=dav-2201`） |
| 标签 | `knowledge`, `arch`, `bisheng`, `a3` |

## 现象

`knowledge_base/AscendC_Compile_Run.md` 给出的编译命令是：

```bash
bisheng -x cce -std=c++17 \
  --cce-soc-version=Ascend910B2 \
  --cce-soc-core-type=VecCore ...
```

这在本机（910B2）成立，但它是**部件号**写法，且 KB 里没有任何"910B / 910_93(A3) / 950 该用什么"
的映射。后果：

- 我把这套参数写进了导出模板（`templates/cannbench/build.sh`），A3 runner 传
  `--soc=ascend910_93` 时白名单 `exit 2`，即使绕过，A3 toolkit 也没有 `Ascend910B2` 这个 SoC；
- 真正正确的写法是**微架构**：`ascend910b` 与 `ascend910_93` 同属 c220 → `--npu-arch=dav-2201`，
  `ascend950` → `dav-3510`，配 `-xasc`（这是对照包 `job_0d0d14053670` 在 A3 上实测通过的写法）；
- 还有一个 KB 没写的坑：`npu-smi` 只报基类名（`Ascend910`），区分不了 910B 与 910_93 子型号，
  要用 `torch.npu.get_device_name(0)`（给出 `Ascend910_9362` 之类）。

## 影响

- 直接导致本轮 A3 编译失败（静默 `exit 2`），并让"平台选 A3"这条路径整体不可用；
- KB 是唯一的编译参考，写错了会**被插件模板化**（模板就是按它写的），错误被固化；
- 同一事实（c220 家族）在三个地方（KB、模板、issue）各写一遍，没有单一真源。

## 复现

1. 按 `AscendC_Compile_Run.md` 的命令在 A3（`Ascend910_93`）环境编译任意 kernel →
   `soc version is not supported` 或参数被拒；
2. 改成 `-xasc --npu-arch=dav-2201` → 通过（本轮已在 910B2 上验证同一组参数可编可跑，
   对照包在 A3 上验证过）。

## 建议修复

- KB 增加一张映射表（并标注 CANN 版本与实测来源）：

  | 平台 | SoC 短名 | 部件名示例 | bisheng 参数 |
  |---|---|---|---|
  | 910B | ascend910b | Ascend910B1..B4 | `-xasc --npu-arch=dav-2201` |
  | A3 / 910C | ascend910_93 | Ascend910_9362 等 | `-xasc --npu-arch=dav-2201` |
  | 950PR / 950DT | ascend950 | Ascend950PR_9579 等 | `-xasc --npu-arch=dav-3510` |

- 明确"`--cce-soc-version=<部件号>` 只在同族同代内可用，跨平台会失败"；
- 记录探测优先级：`--soc` 参数 > `torch.npu.get_device_name(0)` > `npu-smi`（只能兜底）；
- 与 `CAN-018` 的"目标硬件必须用户确认"对齐，避免"自动探测 + 猜默认值"。

## 验收标准

- 只读 KB 就能在 910B 与 A3 上各编出一个可运行的 kernel；
- KB 明确写出探测器优先级与"为什么不写死部件号"；
- 模板、KB、issue 三处的 arch 事实一致（单一真源在 KB）。

## 关联

CAN-018（arch 写死 + 用户确认）、CAN-019（build.sh 通道）
