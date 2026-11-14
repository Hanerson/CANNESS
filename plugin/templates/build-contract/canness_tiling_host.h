// Host-side packing shared by the evaluation driver and direct launchers.
#pragma once

#include <cstddef>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>

#include "canness_tiling_common.h"

inline size_t cannessAttrOffset(uint64_t workspaceBytes) {
    const auto end = sizeof(CannessTilingData) + workspaceBytes;
    return static_cast<size_t>((end + CANNESS_ATTR_ALIGNMENT - 1) & ~(CANNESS_ATTR_ALIGNMENT - 1));
}

inline std::vector<uint8_t> cannessPackAttrs(const GoldenAttr* attrs, size_t count) {
    constexpr auto maxBytes = std::numeric_limits<uint32_t>::max();
    if (count > (maxBytes - sizeof(CannessAttrTable)) / sizeof(CannessDeviceAttr)) {
        throw std::length_error("too many CANNESS attributes");
    }
    std::vector<uint8_t> buffer(sizeof(CannessAttrTable) + count * sizeof(CannessDeviceAttr), 0);
    const CannessAttrTable table{static_cast<uint32_t>(count), 0};
    std::memcpy(buffer.data(), &table, sizeof(table));
    const auto appendText = [&](const char* text, uint32_t length, uint32_t& offset, uint32_t& size) {
        const size_t bytes = length == 0 ? std::strlen(text) : length;
        if (bytes >= maxBytes - buffer.size()) throw std::length_error("CANNESS attributes exceed 4 GiB");
        offset = static_cast<uint32_t>(buffer.size());
        size = static_cast<uint32_t>(bytes);
        buffer.insert(buffer.end(), text, text + bytes);
        buffer.push_back(0);
    };
    for (size_t index = 0; index < count; ++index) {
        const GoldenAttr& source = attrs[index];
        CannessDeviceAttr dest{};
        dest.type = source.type;
        appendText(source.name, source.nameLength, dest.nameOffset, dest.nameLength);
        switch (source.type) {
            case GoldenAttrType::Number: {
                std::memcpy(&dest.numberBits, &source.number, sizeof(dest.numberBits));
                constexpr float largestFloat = std::numeric_limits<float>::max();
                constexpr float infinity = std::numeric_limits<float>::infinity();
                dest.number = source.number > largestFloat ? infinity
                            : source.number < -largestFloat ? -infinity
                            : static_cast<float>(source.number);
                if (source.number >= -0x1p63 && source.number < 0x1p63) {
                    dest.integer = static_cast<int64_t>(source.number);
                    dest.hasInteger = static_cast<double>(dest.integer) == source.number;
                }
                break;
            }
            case GoldenAttrType::Boolean:
                dest.boolean = source.boolean;
                break;
            case GoldenAttrType::String:
                appendText(source.string, source.stringLength, dest.textOffset, dest.textLength);
                break;
            case GoldenAttrType::Missing:
                throw std::invalid_argument("missing CANNESS attribute value");
        }
        std::memcpy(buffer.data() + sizeof(table) + index * sizeof(dest), &dest, sizeof(dest));
    }
    return buffer;
}
