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
static_assert(sizeof(CannessTilingData) == 24, "tiling descriptor layout changed");

enum class GoldenAttrType : uint32_t { Number, Boolean, String, Missing };
struct GoldenAttr {
    const char* name;
    GoldenAttrType type;
    double number;
    bool boolean;
    const char* string;
    // Zero lengths let callers supply ordinary NUL-terminated C strings.
    uint32_t nameLength = 0;
    uint32_t stringLength = 0;
};

// GM payload stores fixed-width values and byte offsets, never host pointers.
struct CannessAttrTable {
    uint32_t count;
    uint32_t reserved;
};

struct CannessDeviceAttr {
    GoldenAttrType type;
    uint32_t nameOffset;
    uint32_t nameLength;
    uint32_t textOffset;
    uint32_t textLength;
    float number;
    int64_t integer;
    uint64_t numberBits;  // original binary64 value, including signed zero
    uint32_t hasInteger;
    uint32_t boolean;
};

static_assert(sizeof(CannessAttrTable) == 8 && sizeof(CannessDeviceAttr) == 48,
              "device attribute layout changed");

constexpr uint64_t CANNESS_ATTR_ALIGNMENT = 64;

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
