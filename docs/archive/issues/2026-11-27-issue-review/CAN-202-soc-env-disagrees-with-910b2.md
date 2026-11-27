# CAN-202 预检报告 910B2 且 `issues` 为空，不对照 `SOC_VERSION=ascend910b1`

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P2** |
| 组件 | 容器环境、`plugin/remote/runner.py` 的 `detect_soc` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `soc`, `910B2`, `preflight` |
| 复核 | 2026-11-27。保留预检缺口；运行影响未验证 |

## 现象

容器里 8 张卡都是 Ascend 910B2。加载环境脚本前后，`SOC_VERSION` 都是 `ascend910b1`。插件预检报告 `detectedSoc: Ascend910B2`，`issues` 为 `[]`。探测只解析 `npu-smi` 文本，不读进程实际继承的 `SOC_VERSION`，也不把两个值放在一起比较。

构建契约脚本会把 `SOC_VERSION` 设成规格里的型号，再传给 `--cce-soc-version`。这只覆盖契约编译那一条命令。

## 证据

- 容器内 8 张卡的芯片名均为 Ascend 910B2。
- `source` 环境脚本之前和之后，`SOC_VERSION` 均为 `ascend910b1`。`set_env.sh` 没有把型号改成 910B2。
- 预检输出含 `detectedSoc: Ascend910B2`，`issues: []`。
- `plugin/remote/runner.py` 的 `detect_soc`（约 365–391 行）只跑 `npu-smi info -t board` 和 `npu-smi info`，用正则抽芯片名。
- `plugin/templates/build-contract/build.sh` 第 15 行把 `SOC_VERSION` 设成模板变量，第 33 行用于 `--cce-soc-version`。这不改容器里其他进程的环境。
- `plugin/src/package-files.ts` 的 `DEFAULT_SOC_VERSION` 是 `Ascend910B2`。规格没写型号时，契约编译参数来自这个默认值，和容器环境变量是两个来源。

## 影响

预检在两个值不一致时仍给出空的 `issues`。依赖 `SOC_VERSION` 的进程和依赖 `npu-smi` 芯片名的预检会各看各的。这个差异是否改变实际算子的编译或运行，本轮没有验证。

## 期望

预检同时记录并对照：`npu-smi` 芯片名、环境脚本之后的 `SOC_VERSION`、本次构建将传入的 `--cce-soc-version` 或 `--npu-arch`。不一致时 `ready` 仍可为真，`issues` 里有一条写明两个值的警告。

## 复现

1. 在容器里打印 `SOC_VERSION`，`source` 工具链的 `set_env.sh` 后再打印。
2. 对照 `npu-smi` 的芯片名。
3. 看预检 JSON 的 `detectedSoc` 与 `issues`。

## 建议修复

- `inspect_environment` 在 source 之后打印 `SOC_VERSION`，并与 `detect_soc` 的结果做同一套比较。
- 警告文本写明环境变量和 `npu-smi` 芯片名。是否改镜像里的 `SOC_VERSION` 属于部署；插件侧仍应把差异写进 `issues`。

## 验收标准

- 在当前容器上，预检 JSON 同时含 `detectedSoc` 与 `socVersionEnv`。
- 二者不一致时，`issues` 包含这条差异。
- 验收不要求证明算子已被误编译。运行影响另作验证。

## 关联

CAN-201。目标确认逻辑在 `plugin/src/spec.ts` 的 `compareTargetPlatform`。

CAN-018 已处理声明目标与探测目标的确认流程。本条补的是加载环境后的 SOC_VERSION 与实卡对照。

## 处置和验证

预检报告 SSH 会话继承的 SOC_VERSION。实卡与环境值不一致时给出警告。容器继承环境的真实差异已复验，普通 SSH 会话的未设置状态也已确认。 [修复后预检](evidence/preflight-after.json)
