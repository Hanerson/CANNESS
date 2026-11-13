// POD tiling descriptor shared by the host driver and the Ascend C kernel.
// Keep kernel_operator.h out of the host translation unit: it defines global
// device symbols, including g_tilingKey, which must have only one definition.
#pragma once
#include <cstdint>

struct CannessTilingData {
    uint32_t totalLength;
    uint32_t blockLength;
    int64_t tileLength;
    uint64_t workspaceSize;
};

enum class GoldenAttrType { Number, Boolean, String };
struct GoldenAttr {
    const char* name;
    GoldenAttrType type;
    double number;
    bool boolean;
    const char* string;
};

struct GoldenCtx {
    const int64_t* shape;  // input 0; null when the spec is symbolic
    int32_t rank;
    int64_t attr_dim;
    int32_t attr_keepdim;
    const GoldenAttr* attrs;
    int32_t attr_count;
    // Raw host input buffers preserve integer values that float references
    // cannot represent exactly. Read elements with memcpy according to
    // input_dtype_names; byte buffers need not have int64 alignment.
    const void* const* raw_inputs;
    const char* const* input_dtype_names;
};
