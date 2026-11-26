# CAN-018 导出把编译目标写死成 SoC 部件号；目标硬件只靠主动探测、没有用户二次确认 → A3 平台编译静默失败

| 字段 | 值 |
|---|---|
| 类型 | bug + enhancement |
| 优先级 | **P1** |
| 组件 | `canness-generator`（`templates/cannbench/build.sh`、`submission.ts`）/ `canness-eval`（`preflight_evaluation`） |
| 首次发现 | 2026-11-25，ApplyRotaryPosEmb 提交 CANNBENCH「A3」平台（job 对照：`job_0d0d14053670`，A3 可编译通过） |
| 状态 | **partially-fixed-in-template（arch 映射已改；用户确认流程仍未实现）** |
| 标签 | `arch`, `cannbench`, `target-platform`, `confirm`, `silent-failure` |

## 现象

在 910B2 的 devspace 上导出的 ApplyRotaryPosEmb 包，提交到 CANNBENCH 的 A3（910C，SoC `Ascend910_93`）平台后**编译不通过，且日志里几乎没有编译器输出**。同一份 kernel 源码在一份历史 A3 通过包（Exp）里，用同样的 CANN 工具链是能编过的。

### A. `build.sh` 用部件号白名单，A3 直接静默 `exit 2`

导出模板（旧）渲染出的 `build.sh`：

```bash
arch="{{SOC_VERSION}}"                       # 实际 = Ascend910B2（spec 里写死）
--soc=ascend910_93) [[ "$arch" == Ascend910_93* ]] || exit 2 ;;
--soc=*)           [[ "${arg#*=}" == "$arch" ]]   || exit 2 ;;
```

CANNBENCH runner 按平台传 `--soc=ascend910_93`（A3 的短名），条件不成立 → **`exit 2`，bisheng 一次都没被调用**。这类失败在 CI 日志里表现为「compile_fail 但看不出原因」。

### B. 编译目标用了具体 SoC 部件号，而不是微架构

旧模板的编译参数是：

```bash
flags=(-x cce -std=c++17 -fPIC "--cce-soc-version=$arch" --cce-soc-core-type=VecCore)
```

`--cce-soc-version=Ascend910B2` 是 910B2 的**部件号**，A3 的 toolkit 里没有这个 SoC → `soc version is not supported`。而对照包（A3 通过）的做法是把平台映射到 **AICore 微架构**：

```cmake
# ref: job_0d0d14053670 / CMakeLists.txt:31-42
# ascend910b / ascend910_93 → dav-2201 (910B 和 910_93 共享 c220 微架构)
set(KERNEL_COMPILE_FLAGS "--npu-arch=${BISHENG_NPU_ARCH} -xasc")
```

即 `ascend910b|ascend910_93 → dav-2201`、`ascend950 → dav-3510`，编译参数是 `-xasc --npu-arch=dav-2201`，**完全不出现部件号**。这也说明：910B 与 A3 的产物本可以是同一份编译参数，差异在运行期由驱动按 die 处理。

### C. 目标硬件只有「主动探测」，没有「用户确认」

现状：
- `target_platform.soc_version` 是 spec 的一个自由字段，没有校验、没有默认值来源、也不会和实际提交平台对照；
- `preflight_evaluation(remote:true)` 只探测**远端设备**状态，探测结果既不回写 spec，也不参与导出决策；
- 导出物里没有任何地方记录「这个包是为哪一族硬件编的」，`provenance.json` 只有文件哈希；
- 用户必须自己去查「A3 = 910C = Ascend910_93 = dav-2201」，插件全程不提示。

结果就是本次事故：**用户在 CANNBENCH 选了 A3，插件按 910B2 出包，双方都没有一个环节发现不一致。**

## 期望（这是本条的核心诉求）

1. **插件必须知道目标硬件环境**：`submit_spec` 要求显式声明目标平台（至少 arch 族 + 具体 SoC/部件名），缺失时拒绝而不是默认 `Ascend910B2`。
2. **硬件环境必须由用户二次确认，而不是简单主动探测**：
   - 探测（`torch.npu.get_device_name(0)` / `npu-smi`）只能作为**建议值**返回；
   - 当「探测到的设备」与「spec 声明的目标」不一致时，必须让用户确认（例如 `submit_spec` 返回 `detected` / `declared` / `requiresConfirmation`，未带 `confirm` 时拒绝创建 generation）；
   - 确认结果落盘（`.canness/state.json` + `config.json` + `provenance.json`），后续导出直接引用，不再二次猜。
3. **导出用微架构、不用部件号**：`build.sh` 由 arch 族映射到 `dav-2201` / `dav-3510`，并接受 `--soc=ascend910b|ascend910_93|ascend950` 与完整部件名；不认识的 `--soc` 要打印明确错误（含期望值），不能再静默 `exit 2`。
4. **提交前给出可判定的一致性检查**：`preflight_evaluation` / `export_submission` 在「目标 arch ≠ 远端/声明平台」时直接报错，并提示「A3 需要 ascend910_93 → dav-2201」。

## 影响

- A3 / 950PR / 950DT 平台**全部不可用**（只要 spec 里写的是 910B2），而这正是打榜的主战场；
- 失败形态是「静默 exit 2」，用户无法从日志判断是代码问题还是平台问题，排查成本极高；
- 已有的 `Ascend910B2` 默认值让错误是**沉默的**：不声明也能导出，导出的东西天然只能在 910B 上编。

## 复现

1. spec 不带 `soc_version`（或写 `Ascend910B2`）→ `export_submission`；
2. 看导出 `build.sh`：`arch="Ascend910B2"` + `--cce-soc-version=$arch`；
3. 在 A3 runner 上 `bash build.sh --soc=ascend910_93` → 静默 `exit 2`；
4. 对照 `job_0d0d14053670`（A3 通过包）：`build.sh` 无白名单、自动探测、`--npu-arch=dav-2201 -xasc`。

## 建议修复

1. `templates/cannbench/build.sh`：改为 arch 映射（**已改，2026-11-25**），`--soc` 接受短名/部件名/`--install`，未知值打印错误后 `exit 2`，并回显 `soc -> --npu-arch=`。
2. `submission.ts`：把 `target_platform`（arch 族 + 部件名）写进 `provenance.json` 与 `config.json`，导出时校验二者一致。
3. `spec.ts`：`soc_version` 收窄为「arch 族（ascend910b / ascend910_93 / ascend950）+ 可选部件名」的枚举/正则，并在 `submit_spec` 里强制声明。
4. 新增确认步骤：`submit_spec` 返回 `detected` 与 `declared` 的比较结果；不一致或缺失时要求显式 `confirm: true`（或专门的 `confirm_target_platform` 工具），确认结果持久化。
5. `preflight_evaluation(remote:true)`：额外比较「远端设备名（torch_npu 全名）」与「声明的 arch 族」，不一致即 `ok:false` 并给出映射建议。

## 验收标准

- spec 未声明目标硬件时 `submit_spec` 拒绝，错误信息给出可选项（ascend910b / ascend910_93 / ascend950）；
- 探测结果一律是「建议」，必须经用户确认后才进入导出；
- 导出 `build.sh` 里不出现 `--cce-soc-version=<部件号>`，只出现 `--npu-arch=dav-2201|dav-3510`；
- 同一份导出包在 910B 与 A3 上 `bash build.sh --soc=ascend910b|ascend910_93` 都能编译（编译参数相同，仅运行期设备不同）；
- `preflight` 能在提交前发现「包 arch ≠ 目标平台」。

## 本次已做的临时动作

- 模板 `templates/cannbench/build.sh` 已按对照包重写：arch 映射、`--soc` 白名单改为映射 + 明确报错、`-xasc --npu-arch`、多套 toolkit 头文件布局自适应；
- ApplyRotaryPosEmb 已用新模板重新导出（`submissions/gen-5942c07f-ymyWaO`）；
- 尚未做：用户二次确认流程（第 2、4 条），以及 A3 真机 `compile_only` 验证（CANNLab devspace 已停机，见邮件）。

## 关联

CAN-011（导出物从未被验证）、CAN-005（远端探测能力）、CAN-016（lib/templates 混用契约）
