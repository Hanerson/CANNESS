// CANNESS build contract v1: generic tiling shim.
//
// The kernel and the host driver share one operator-independent tiling struct,
// so a new operator does not need its own GeluTilingData-style type. This
// header is additive: if the kernel ships its own shim, the guarded macro
// below leaves it alone and the local struct name keeps working.
#pragma once

#include "kernel_operator.h"

using DTYPE_X = {{DTYPE_X}};
using DTYPE_Y = {{DTYPE_Y}};

// `workspaceSize` makes a scratch buffer available to the kernel WITHOUT adding
// a parameter to canness_kernel: main.cpp allocates sizeof(CannessTilingData) +
// workspaceSize bytes and passes the same pointer, so the kernel reaches the
// scratch area at
//     (__gm__ uint8_t *)tiling + sizeof(CannessTilingData)
// Kernels stay signature-compatible (issue 013); 0 means "no scratch".
struct CannessTilingData {
    uint32_t totalLength;
    uint32_t blockLength;
    int64_t tileLength;
    uint64_t workspaceSize;
};

// A __gm__ struct cannot be copied to local memory as a value, so read field
// by field. The internal pointer name is deliberately unlikely to collide with
// the caller's tiling variable (`GET_TILING_DATA(t, tiling)` must work).
#ifndef GET_TILING_DATA
#define GET_TILING_DATA(tilingData, tilingPtr)                                   \
    CannessTilingData tilingData;                                                \
    do {                                                                         \
        __gm__ CannessTilingData *canness_gm_tiling__ =                          \
            reinterpret_cast<__gm__ CannessTilingData *>(tilingPtr);             \
        tilingData.totalLength = canness_gm_tiling__->totalLength;               \
        tilingData.blockLength = canness_gm_tiling__->blockLength;               \
        tilingData.tileLength = canness_gm_tiling__->tileLength;                 \
        tilingData.workspaceSize = canness_gm_tiling__->workspaceSize;           \
    } while (0)
#endif
