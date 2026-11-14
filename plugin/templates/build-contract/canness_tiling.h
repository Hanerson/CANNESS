// CANNESS build contract v1: generic tiling shim.
//
// The kernel and the host driver share one operator-independent tiling struct,
// so a new operator does not need its own GeluTilingData-style type. This
// header is additive: if the kernel ships its own shim, the guarded macro
// below leaves it alone and the local struct name keeps working.
#pragma once

#include "kernel_operator.h"
#include "canness_tiling_common.h"

using DTYPE_X = {{DTYPE_X}};
using DTYPE_Y = {{DTYPE_Y}};

// `workspaceSize` makes a scratch buffer available to the kernel WITHOUT adding
// a parameter to canness_kernel. The kernel reaches the scratch area at
//     (__gm__ uint8_t *)tiling + sizeof(CannessTilingData)
// Kernels stay signature-compatible (issue 013); 0 means "no scratch".
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

// The aligned attribute table follows scratch. Read GM fields individually
// so neither the descriptor nor a record is copied across address spaces.
class CannessAttrs {
public:
    __aicore__ inline CannessAttrs(GM_ADDR tiling, uint64_t workspaceBytes) {
        const uint64_t end = sizeof(CannessTilingData) + workspaceBytes;
        const uint64_t offset = (end + CANNESS_ATTR_ALIGNMENT - 1) & ~(CANNESS_ATTR_ALIGNMENT - 1);
        base_ = tiling + offset;
    }

    __aicore__ inline uint32_t count() const {
        return reinterpret_cast<__gm__ const CannessAttrTable*>(base_)->count;
    }

    __aicore__ inline CannessDeviceAttr get(uint32_t index) const {
        CannessDeviceAttr result{};
        result.type = GoldenAttrType::Missing;
        if (index >= count()) return result;
        __gm__ const CannessDeviceAttr* attr =
            reinterpret_cast<__gm__ const CannessDeviceAttr*>(base_ + sizeof(CannessAttrTable)) + index;
        result.type = attr->type;
        result.nameOffset = attr->nameOffset;
        result.nameLength = attr->nameLength;
        result.textOffset = attr->textOffset;
        result.textLength = attr->textLength;
        result.number = attr->number;
        result.integer = attr->integer;
        result.numberBits = attr->numberBits;
        result.hasInteger = attr->hasInteger;
        result.boolean = attr->boolean;
        return result;
    }

    __aicore__ inline __gm__ const uint8_t* name(const CannessDeviceAttr& attr) const {
        return attr.nameOffset == 0 ? nullptr : base_ + attr.nameOffset;
    }

    __aicore__ inline __gm__ const uint8_t* text(const CannessDeviceAttr& attr) const {
        return attr.textOffset == 0 ? nullptr : base_ + attr.textOffset;
    }

private:
    GM_ADDR base_;
};
