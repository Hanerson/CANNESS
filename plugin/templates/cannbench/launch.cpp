#include <acl/acl.h>
#include <algorithm>
#include <cmath>
#include <cstdint>

#include "canness_tiling_host.h"

#define CANNESS_GM_ADDR __gm__ uint8_t*
extern "C" __global__ [aicore] void canness_kernel({{KERNEL_ARGS_DECL}});

extern "C" int canness_launch({{TENSOR_PTRS}}, uint32_t total, void* stream,
                              void* tilingDevice, uint64_t tilingCapacity{{ATTR_PARAMS}}) {
    try {
        constexpr uint32_t blocks = {{BLOCK_DIM}};
        constexpr uint64_t workspaceBytes = {{WORKSPACE_BYTES}};
        const auto blockLength = static_cast<uint32_t>((static_cast<uint64_t>(total) + blocks - 1) / blocks);
        const auto tileLength = {{TILE_LENGTH}};
        const CannessTilingData header{total, blockLength, tileLength, workspaceBytes};
        const GoldenAttr attrs[] = { {{ATTR_ROWS}} };
        const auto packed = cannessPackAttrs(attrs, {{ATTR_COUNT}});
        const auto offset = cannessAttrOffset(workspaceBytes);
        const auto size = offset + packed.size();
        if (size > tilingCapacity) return -1;
        std::vector<uint8_t> host(size, 0);
        std::memcpy(host.data(), &header, sizeof(header));
        std::memcpy(host.data() + offset, packed.data(), packed.size());
        const auto status = aclrtMemcpy(tilingDevice, tilingCapacity, host.data(), host.size(), ACL_MEMCPY_HOST_TO_DEVICE);
        if (status != ACL_SUCCESS) return static_cast<int>(status);
        canness_kernel<<<blocks, nullptr, static_cast<aclrtStream>(stream)>>>({{KERNEL_ARGS_CALL}});
        return ACL_SUCCESS;
    } catch (...) {
        return -2;
    }
}
