# AscendC 编译与直连运行（910B / CANN 9.1）

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

## 编译命令（关键）

```bash
bisheng -x cce -std=c++17 \
  --cce-soc-version=Ascend910B2 \
  --cce-soc-core-type=VecCore \
  -include /path/to/gelu_tiling.h \
  -c -I... kernel.cpp -o kernel.o
```

- `--cce-soc-core-type=VecCore` 是**向量核**的唯一合法值；`AiCore` / `VectorCore` / `AIC` / `AIV` 都报 `soc_core_type ... is not supported`。
- `--cce-aiv` 单独使用不会改变产物（同一份 `.o` 的 md5 不变），不要依赖它。
- 链接需要 `-lascendcl -lruntime`，否则 `rtDevBinaryRegister` / `rtKernelLaunch` 未定义。
- 910B2 和 910B4 都可选 `--cce-soc-version=Ascend910B2|Ascend910B4`。

## 裸 kernel 缺的三个生成物

直接编译 `op_kernel/kernel.cpp` 会报：

```text
use of undeclared identifier 'DTYPE_X'
use of undeclared identifier 'GET_TILING_DATA'
unknown type name 'GeluTilingData'
```

它们由 msopgen 的 tiling 头生成。最小 shim：

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

#define GET_TILING_DATA(tilingData, tilingPtr)                    \
    GeluTilingData tilingData;                                    \
    do {                                                          \
        __gm__ GeluTilingData *t =                                \
            reinterpret_cast<__gm__ GeluTilingData *>(tilingPtr); \
        tilingData.totalLength = t->totalLength;                  \
        tilingData.blockLength = t->blockLength;                  \
        tilingData.tileLength = t->tileLength;                    \
    } while (0)
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
bisheng -x cce -std=c++17 --cce-soc-version=Ascend910B2 --cce-soc-core-type=VecCore \
  -include gelu_tiling.h -c -I... kernel.cpp -o k.o
bisheng -x cce -std=c++17 --cce-soc-version=Ascend910B2 --cce-soc-core-type=VecCore \
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
