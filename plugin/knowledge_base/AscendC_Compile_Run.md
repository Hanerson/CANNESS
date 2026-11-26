# AscendC 编译与直连运行（910B、A3、950）

不依赖 msopgen 工程、直接把 `kernel.cpp` 编译成可执行程序的最小路径。适用于「本地无 CANN、远端只有 NPU + 编译器」的场景。

## 环境

```bash
source /usr/local/Ascend/ascend-toolkit/set_env.sh
which bisheng        # /usr/local/Ascend/cann-9.1.0/bin/bisheng（实际是 tools/bisheng_compiler）
cmake --version      # 4.4.3
g++ --version        # 12.3.1
```

CANN 9.1 的头文件位置（不是老的 tikcfw 单一路径）：

```text
/usr/local/Ascend/cann-9.1.0/aarch64-linux/tikcpp/tikcfw
/usr/local/Ascend/cann-9.1.0/aarch64-linux/tikcpp/tikcfw/impl
/usr/local/Ascend/cann-9.1.0/aarch64-linux/tikcpp/tikcfw/interface
/usr/local/Ascend/cann-9.1.0/aarch64-linux/asc/include
/usr/local/Ascend/cann-9.1.0/aarch64-linux/asc/include/basic_api
/usr/local/Ascend/cann-9.1.0/aarch64-linux/include
/usr/local/Ascend/cann-9.1.0/include
```

## 选择 SoC 与编译参数

| 平台 | CANNBench `--soc` 短名 | 部件名示例 | 现代毕昇编译参数 |
| --- | --- | --- | --- |
| 910B | `ascend910b` | `Ascend910B2`、`Ascend910B4` | `-xasc --npu-arch=dav-2201` |
| A3 / 910C | `ascend910_93` | `Ascend910_9362` | `-xasc --npu-arch=dav-2201` |
| 950PR / 950DT | `ascend950` | `Ascend950PR_9579` | `-xasc --npu-arch=dav-3510` |

910B 和 A3 共享 c220 微架构。CANN 9.2.1 上已验证这两个目标短名都能用 `dav-2201` 编译。A3 的 CANNBench 对照包 `job_0d0d14053670` 也使用这组参数。950 的映射供选目标使用，实际编译和运行要在目标工具链和设备上验证。

导出脚本优先使用调用方的 `--soc`，其次使用导出时明确选定的 SoC。可移植导出没有选定 SoC 时依次尝试 `torch.npu.get_device_name(0)` 和 `npu-smi`。`npu-smi` 可能只显示 `Ascend910`，这个名称无法区分 910B 和 A3，应显式传 `--soc`。通过预检获得的型号用于提示。发现探测型号与声明不同，或选择可移植模式时，先请用户确认预期目标再创建 generation。

工具链支持现代参数时，kernel 和 launch 源文件使用同一微架构参数。例如，A3 和 910B 都可以用下列命令编译 kernel。

```bash
bisheng -xasc --npu-arch=dav-2201 -std=c++17 \
  -include /path/to/gelu_tiling.h \
  -c -I... kernel.cpp -o kernel.o
```

已验证的旧版 910B2 工具链（CANN 8.0.1）需要 `-x cce` 和完整部件名。导出脚本先用独立源文件探测编译器支持的参数，再编译算子。旧版运行库通过 `--cce-fatobj-link` 链接。

```bash
bisheng -x cce -std=c++17 \
  --cce-soc-version=Ascend910B2 \
  --cce-soc-core-type=VecCore \
  -include /path/to/gelu_tiling.h \
  -c -I... kernel.cpp -o kernel.o
```

- 旧版 `--cce-soc-core-type=VecCore` 是**向量核**的合法值。`AiCore` / `VectorCore` / `AIC` / `AIV` 都报 `soc_core_type ... is not supported`。
- `--cce-aiv` 单独使用不会改变产物（同一份 `.o` 的 md5 不变），不要依赖它。
- 链接需要 `-lascendcl -lruntime`，否则 `rtDevBinaryRegister` / `rtKernelLaunch` 未定义。
- 旧版 `--cce-soc-version` 要和工具链支持的部件及实际目标匹配。910B4 用 `Ascend910B4`，A3 的工具链可能拒绝 `Ascend910B2`。

## 与插件构建契约的接口

`build_test_package` 会把 `canness_tiling.h` 放进测试包，并作为 `-include` 传给 kernel 编译。
新算子不需要自带 tiling 头：

- kernel 入口固定为
  `extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR in0, ..., GM_ADDR out0, ..., GM_ADDR tiling)`
  （**全部输入 → 全部输出 → tiling**）；
- tiling 用通用 `CannessTilingData { totalLength, blockLength, tileLength }`，
  `GET_TILING_DATA` 由包内 shim 提供；`DTYPE_X` / `DTYPE_Y` 也由它定义。

## 裸 kernel 缺的三个生成物

直接编译 `op_kernel/kernel.cpp` 会报：

```text
use of undeclared identifier 'DTYPE_X'
use of undeclared identifier 'GET_TILING_DATA'
unknown type name 'GeluTilingData'
```

它们由 msopgen 的 tiling 头生成。若 kernel 仍自带旧式 shim，注意两点：
`GET_TILING_DATA` 用 `#ifndef` 守卫（包内 shim 先定义时不要重复定义），内部指针名不要用
`t`（否则会和 `GET_TILING_DATA(t, tiling)` 的调用变量重名）：

```cpp
// gelu_tiling.h
#pragma once
#include "kernel_operator.h"

using DTYPE_X = half;
struct GeluTilingData {
    uint32_t totalLength;
    uint32_t blockLength;
    int64_t tileLength;
};

#ifndef GET_TILING_DATA
#define GET_TILING_DATA(tilingData, tilingPtr)                    \
    GeluTilingData tilingData;                                    \
    do {                                                          \
        __gm__ GeluTilingData *canness_gm_tiling__ =              \
            reinterpret_cast<__gm__ GeluTilingData *>(tilingPtr); \
        tilingData.totalLength = canness_gm_tiling__->totalLength;\
        tilingData.blockLength = canness_gm_tiling__->blockLength;\
        tilingData.tileLength = canness_gm_tiling__->tileLength;  \
    } while (0)
#endif
```

注意：`__gm__` 结构体不能按值拷贝到 local，必须逐字段读。

## 直连 launch 的 5 个坑

1. **AIV-only**：kernel 入口加 `KERNEL_TASK_TYPE_DEFAULT(KERNEL_TYPE_AIV_ONLY);`，否则标量写生效、向量 / MTE 指令静默不执行。
2. **设备可见性**：容器里只有 `/dev/davinci7` 时，运行前 `export ASCEND_VISIBLE_DEVICES=7`；否则 `aclInit` 报 `chipType=0 does not support get device msg feature`（错误信息有误导性）。
3. **tiling 放 device**：`aclrtMalloc` + `aclrtMemcpy` 到 device 再传指针；传 host 栈指针会触发 `scalar instruction accesses an invalid GM address`。
4. **同步**：`<<<blockDim, nullptr, stream>>>` 之后用 `aclrtSynchronizeDevice()`；只 `aclrtSynchronizeStream(stream)` 可能在 kernel 完成前就读回。
5. **host 侧声明**：`__gm__` 必须写在参数上，不能藏在 `using GM_ADDR = ...` 别名里；`void*` 转 `__gm__ uint8_t*` 用 C 风格 cast。

## 编译 + 链接（可执行）

```bash
flags=(-xasc --npu-arch=dav-2201 -std=c++17)
bisheng "${flags[@]}" \
  -include gelu_tiling.h -c -I... kernel.cpp -o k.o
bisheng "${flags[@]}" \
  -c -I... main.cpp -o main.o
bisheng main.o k.o -o demo \
  -L$CANN/aarch64-linux/lib64 -L$CANN/aarch64-linux/devlib \
  -lascendcl -lruntime -lstdc++ -lpthread -ldl -lm \
  -Wl,-rpath,$CANN/aarch64-linux/lib64:$CANN/aarch64-linux/devlib
```

## msprof

```bash
mkdir -p /tmp/msprof_out          # 必须先建，否则 Analysis output path does not exist
msprof --output=/tmp/msprof_out --aic-metrics=PipeUtilization \
       --parse=on --export=on --type=text /tmp/demo 100
```

真正的时间在：

```text
/tmp/msprof_out/PROF_*/mindstudio_profiler_output/op_statistic_*.csv   # 聚合 avg/min/max
/tmp/msprof_out/PROF_*/mindstudio_profiler_output/op_summary_*.csv     # 逐次 + scalar/vec/mte 占比
/tmp/msprof_out/PROF_*/mindstudio_profiler_output/task_time_*.csv
```

控制台的 `There is no summary data to export` 不代表失败，继续找上面的 CSV。
