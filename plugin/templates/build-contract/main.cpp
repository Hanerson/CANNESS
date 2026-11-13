// CANNESS build contract v1: universal host driver for {{OPERATOR_NAME}}.
//
// This file is generated from plugin/templates/build-contract/main.cpp. It is
// operator-independent: the operator is reached through the fixed kernel entry
// `canness_kernel` (inputs, then outputs, then tiling), implemented in
// op_kernel/kernel.cpp. Accuracy comes from golden.h.
//
// The program prints exactly one machine-readable line:
//
//   CANNESS_RESULT {"maxAbsErr":...,"maxRelErr":...,"badCount":...,"total":...,"golden":"..."}
//
// A placeholder golden.h forces badCount to -1, which the remote runner maps to
// `accuracy_fail` (never a pass).
#include <acl/acl.h>
#include <cmath>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>

#include "canness_tiling_common.h"
// Available in every custom golden.h, including files that replace the whole
// placeholder template. A mismatch becomes an explicit accuracy failure.
#define CANNESS_REQUIRE_SHAPE(condition) do { \
    if (!(condition)) throw std::runtime_error("golden shape assertion failed: " #condition); \
} while (0)
#include "golden.h"

// The host driver needs only the address-space spelling, not kernel_operator.h.
#define CANNESS_GM_ADDR __gm__ uint8_t*

#define CANNESS_OPERATOR {{OPERATOR_STRING}}
#define CANNESS_INPUT_COUNT {{INPUT_COUNT}}
#define CANNESS_OUTPUT_COUNT {{OUTPUT_COUNT}}
#define CANNESS_TOTAL_ELEMENTS {{TOTAL_ELEMENTS}}
#define CANNESS_BLOCK_DIM {{BLOCK_DIM}}
#define CANNESS_BLOCK_LENGTH {{BLOCK_LENGTH}}
#define CANNESS_TILE_LENGTH {{TILE_LENGTH}}
#define CANNESS_MAX_ABS_ERR {{MAX_ABS_ERR}}
#define CANNESS_INDEX_CHECK {{ACCURACY_MODE}}
#define CANNESS_INTEGER_OUTPUT {{INTEGER_OUTPUT}}
#define CANNESS_FLOAT_OUTPUT {{FLOAT_OUTPUT}}
#define CANNESS_SHAPE_RANK {{SHAPE_RANK}}
#define CANNESS_ATTR_COUNT {{ATTR_COUNT}}
// Scratch bytes appended to the tiling buffer (issue 013); 0 by default.
#define CANNESS_WORKSPACE_BYTES {{WORKSPACE_BYTES}}

// Use CCE's [aicore] spelling directly. The kernel headers define the
// __aicore__ macro but also introduce device globals, so keep them out of main.o.
extern "C" __global__ [aicore] void canness_kernel({{KERNEL_ARGS_DECL}});

enum class DType { F16, BF16, F32, I32, I64 };

static size_t dtype_size(DType dtype) {
    switch (dtype) {
        case DType::F16:
        case DType::BF16:
            return 2;
        case DType::F32:
        case DType::I32:
            return 4;
        case DType::I64:
            return 8;
    }
}

static uint16_t float_to_f16(float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const uint32_t sign = (bits >> 16) & 0x8000u;
    const uint32_t raw_exponent = (bits >> 23) & 0xffu;
    uint32_t mantissa = bits & 0x7fffffu;
    if (raw_exponent == 0xffu) {
        return static_cast<uint16_t>(sign | 0x7c00u | (mantissa == 0 ? 0u : 0x200u));
    }
    int32_t exponent = static_cast<int32_t>(raw_exponent) - 127 + 15;
    if (exponent >= 0x1f) return static_cast<uint16_t>(sign | 0x7c00u);
    if (exponent <= 0) {
        if (exponent < -10) return static_cast<uint16_t>(sign);
        mantissa |= 0x800000u;
        const uint32_t shift = static_cast<uint32_t>(14 - exponent);
        uint32_t rounded = mantissa >> shift;
        if ((mantissa >> (shift - 1)) & 1u) rounded += 1u;
        return static_cast<uint16_t>(sign | rounded);
    }
    uint32_t rounded = mantissa >> 13;
    if ((mantissa >> 12) & 1u) {
        rounded += 1u;
        if (rounded == 0x400u) {
            rounded = 0;
            exponent += 1;
            if (exponent >= 0x1f) return static_cast<uint16_t>(sign | 0x7c00u);
        }
    }
    return static_cast<uint16_t>(sign | (static_cast<uint32_t>(exponent) << 10) | rounded);
}

static uint16_t float_to_bf16(float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const uint32_t rounded = bits + 0x7fffu + ((bits >> 16) & 1u);
    return static_cast<uint16_t>(rounded >> 16);
}

static float f16_to_float(uint16_t value) {
    const uint32_t sign = (static_cast<uint32_t>(value) & 0x8000u) << 16;
    uint32_t exponent = (static_cast<uint32_t>(value) >> 10) & 0x1fu;
    uint32_t mantissa = static_cast<uint32_t>(value) & 0x3ffu;
    uint32_t bits = 0;
    if (exponent == 0) {
        if (mantissa == 0) {
            bits = sign;
        } else {
            exponent = 127 - 15 + 1;
            while ((mantissa & 0x400u) == 0) {
                mantissa <<= 1;
                exponent -= 1;
            }
            mantissa &= 0x3ffu;
            bits = sign | (exponent << 23) | (mantissa << 13);
        }
    } else if (exponent == 0x1f) {
        bits = sign | 0x7f800000u | (mantissa << 13);
    } else {
        bits = sign | ((exponent - 15 + 127) << 23) | (mantissa << 13);
    }
    float result = 0.0f;
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}

static float bf16_to_float(uint16_t value) {
    const uint32_t bits = static_cast<uint32_t>(value) << 16;
    float result = 0.0f;
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}

template <typename T>
static void store_typed(uint8_t* base, int64_t index, T value) {
    std::memcpy(base + static_cast<size_t>(index) * sizeof(T), &value, sizeof(T));
}

template <typename T>
static T load_typed(const uint8_t* base, int64_t index) {
    T value;
    std::memcpy(&value, base + static_cast<size_t>(index) * sizeof(T), sizeof(T));
    return value;
}

static void store_value(DType dtype, uint8_t* base, int64_t index, float value) {
    switch (dtype) {
        case DType::F16:
            store_typed(base, index, float_to_f16(value));
            break;
        case DType::BF16:
            store_typed(base, index, float_to_bf16(value));
            break;
        case DType::F32:
            store_typed(base, index, value);
            break;
        case DType::I32:
            store_typed(base, index, static_cast<int32_t>(value));
            break;
        case DType::I64:
            store_typed(base, index, static_cast<int64_t>(value));
            break;
    }
}

static float load_value(DType dtype, const uint8_t* base, int64_t index) {
    switch (dtype) {
        case DType::F16:
            return f16_to_float(load_typed<uint16_t>(base, index));
        case DType::BF16:
            return bf16_to_float(load_typed<uint16_t>(base, index));
        case DType::F32:
            return load_typed<float>(base, index);
        case DType::I32:
            return static_cast<float>(load_typed<int32_t>(base, index));
        case DType::I64:
            return static_cast<float>(load_typed<int64_t>(base, index));
    }
    return 0.0f;
}

static int64_t load_integer(DType dtype, const uint8_t* base, int64_t index) {
    if (dtype == DType::I32) return load_typed<int32_t>(base, index);
    return load_typed<int64_t>(base, index);
}

struct Tensor {
    void* device = nullptr;
    std::vector<uint8_t> host;
    int64_t elements = 0;
    DType dtype = DType::F32;
};

// A permutation of 32768 distinct finite fp16 values in [-2, 2]. Every
// contiguous row of at most 32768 elements has no ties even after fp16/bf16
// storage; this avoids accidental argmax tie semantics in ordinary probes.
static float pattern_value(DType dtype, int64_t index) {
    const uint32_t slot = (static_cast<uint32_t>(index) * 20077u + 17u) & 0x7fffu;
    if (dtype == DType::I32 || dtype == DType::I64) {
        return static_cast<float>(static_cast<int32_t>(slot) - 16384);
    }
    const uint16_t magnitude = static_cast<uint16_t>(1u + (slot & 0x3fffu));
    const uint16_t bits = static_cast<uint16_t>(magnitude | (slot & 0x4000u ? 0x8000u : 0u));
    return dtype == DType::BF16 ? bf16_to_float(bits) : f16_to_float(bits);
}

static const int64_t canness_shape[] = { {{SHAPE_VALUES}} };
static const GoldenAttr canness_attrs[] = {
    {{ATTR_ROWS}}
};
static const char* canness_input_dtype_names[] = { {{INPUT_DTYPE_NAMES}} };
static GoldenCtx golden_context(const void* const* raw_inputs) {
    GoldenCtx ctx = {};
    ctx.shape = CANNESS_SHAPE_RANK ? canness_shape : nullptr;
    ctx.rank = CANNESS_SHAPE_RANK;
    ctx.attr_dim = {{ATTR_DIM}};
    ctx.attr_keepdim = {{ATTR_KEEPDIM}};
    ctx.attrs = CANNESS_ATTR_COUNT ? canness_attrs : nullptr;
    ctx.attr_count = CANNESS_ATTR_COUNT;
    ctx.raw_inputs = raw_inputs;
    ctx.input_dtype_names = canness_input_dtype_names;
    return ctx;
}

static Tensor make_tensor(DType dtype, int64_t elements, bool input) {
    Tensor tensor;
    tensor.elements = elements;
    tensor.dtype = dtype;
    tensor.host.assign(static_cast<size_t>(elements) * dtype_size(dtype), 0);
    if (input) {
        for (int64_t index = 0; index < elements; ++index) {
            store_value(dtype, tensor.host.data(), index, pattern_value(dtype, index));
        }
    }
    return tensor;
}

static int fail(const char* step, int code) {
    std::printf("CANNESS_ERROR %s (code %d)\n", step, code);
    return 1;
}

int main(int argc, char** argv) {
    int runs = 1;
    if (argc > 2) return fail("expected at most one runs argument", 2);
    if (argc == 2) {
        char* end = nullptr;
        errno = 0;
        const long parsed = std::strtol(argv[1], &end, 10);
        if (errno != 0 || end == argv[1] || *end != '\0' || parsed < 1 || parsed > 100000) {
            return fail("runs must be an integer in 1..100000", 2);
        }
        runs = static_cast<int>(parsed);
    }
    const int warmup = std::min(5, runs / 5);
    aclError status = aclInit(nullptr);
    if (status != ACL_SUCCESS) return fail("aclInit", static_cast<int>(status));
    status = aclrtSetDevice(0);
    if (status != ACL_SUCCESS) return fail("aclrtSetDevice", static_cast<int>(status));
    aclrtStream stream = nullptr;
    status = aclrtCreateStream(&stream);
    if (status != ACL_SUCCESS) return fail("aclrtCreateStream", static_cast<int>(status));

    {{TENSOR_SETUP}}

    std::vector<Tensor*> inputs = {{INPUT_LIST}};
    std::vector<Tensor*> outputs = {{OUTPUT_LIST}};

    for (Tensor* tensor : inputs) {
        status = aclrtMalloc(&tensor->device, tensor->host.size(), ACL_MEM_MALLOC_HUGE_FIRST);
        if (status != ACL_SUCCESS) return fail("aclrtMalloc(input)", static_cast<int>(status));
        status = aclrtMemcpy(tensor->device, tensor->host.size(), tensor->host.data(),
                             tensor->host.size(), ACL_MEMCPY_HOST_TO_DEVICE);
        if (status != ACL_SUCCESS) return fail("aclrtMemcpy(input)", static_cast<int>(status));
    }
    for (Tensor* tensor : outputs) {
        status = aclrtMalloc(&tensor->device, tensor->host.size(), ACL_MEM_MALLOC_HUGE_FIRST);
        if (status != ACL_SUCCESS) return fail("aclrtMalloc(output)", static_cast<int>(status));
        status = aclrtMemcpy(tensor->device, tensor->host.size(), tensor->host.data(),
                             tensor->host.size(), ACL_MEMCPY_HOST_TO_DEVICE);
        if (status != ACL_SUCCESS) return fail("aclrtMemcpy(output)", static_cast<int>(status));
    }

    // Tiling lives in device memory: a host stack pointer triggers
    // "scalar instruction accesses an invalid GM address".
    // When the spec asks for scratch (launch.workspace_bytes > 0) the allocation
    // grows by that many bytes and the kernel finds the area at
    // (uint8_t *)tiling + sizeof(CannessTilingData) -- no extra kernel parameter,
    // so existing kernels keep their signature (issue 013).
    CannessTilingData tiling_host = {};
    tiling_host.totalLength = static_cast<uint32_t>(CANNESS_TOTAL_ELEMENTS);
    tiling_host.blockLength = static_cast<uint32_t>(CANNESS_BLOCK_LENGTH);
    tiling_host.tileLength = CANNESS_TILE_LENGTH;
    tiling_host.workspaceSize = static_cast<uint64_t>(CANNESS_WORKSPACE_BYTES);
    const size_t tiling_bytes = sizeof(CannessTilingData) + static_cast<size_t>(CANNESS_WORKSPACE_BYTES);
    void* tiling_device = nullptr;
    status = aclrtMalloc(&tiling_device, tiling_bytes, ACL_MEM_MALLOC_HUGE_FIRST);
    if (status != ACL_SUCCESS) return fail("aclrtMalloc(tiling)", static_cast<int>(status));
    // Only the descriptor comes from the host stack; the scratch tail stays as
    // device memory and belongs to the kernel to initialise.
    status = aclrtMemcpy(tiling_device, sizeof(CannessTilingData), &tiling_host,
                         sizeof(CannessTilingData), ACL_MEMCPY_HOST_TO_DEVICE);
    if (status != ACL_SUCCESS) return fail("aclrtMemcpy(tiling)", static_cast<int>(status));

    double last_launch_us = 0.0;
    for (int iteration = 0; iteration < warmup + runs; ++iteration) {
        const auto launch_start = std::chrono::steady_clock::now();
        canness_kernel<<<CANNESS_BLOCK_DIM, nullptr, stream>>>({{KERNEL_ARGS_CALL}});
        // Each launch is a separate msprof sample. SynchronizeDevice waits for
        // completion before the next iteration and before the final copy.
        status = aclrtSynchronizeDevice();
        if (status != ACL_SUCCESS) return fail("aclrtSynchronizeDevice", static_cast<int>(status));
        if (iteration >= warmup) {
            last_launch_us = std::chrono::duration<double, std::micro>(
                std::chrono::steady_clock::now() - launch_start).count();
        }
    }

    for (Tensor* tensor : outputs) {
        status = aclrtMemcpy(tensor->host.data(), tensor->host.size(), tensor->device,
                             tensor->host.size(), ACL_MEMCPY_DEVICE_TO_HOST);
        if (status != ACL_SUCCESS) return fail("aclrtMemcpy(result)", static_cast<int>(status));
    }

    std::vector<std::vector<float>> input_values(inputs.size());
    std::vector<const float*> input_pointers(inputs.size(), nullptr);
    for (size_t index = 0; index < inputs.size(); ++index) {
        input_values[index].resize(static_cast<size_t>(inputs[index]->elements));
        for (int64_t element = 0; element < inputs[index]->elements; ++element) {
            input_values[index][element] =
                load_value(inputs[index]->dtype, inputs[index]->host.data(), element);
        }
        input_pointers[index] = input_values[index].data();
    }

    double max_abs = 0.0;
    double max_rel = 0.0;
    int64_t bad = 0;
    int64_t total = 0;
    bool golden_error = false;
    std::vector<const void*> raw_input_pointers(inputs.size(), nullptr);
    for (size_t index = 0; index < inputs.size(); ++index) {
        raw_input_pointers[index] = inputs[index]->host.data();
    }
    const GoldenCtx ctx = golden_context(raw_input_pointers.data());
    try {
        for (size_t output = 0; output < outputs.size(); ++output) {
            for (int64_t element = 0; element < outputs[output]->elements; ++element) {
                ++total;
#if CANNESS_INDEX_CHECK
                const int64_t actual = load_integer(outputs[output]->dtype,
                                                    outputs[output]->host.data(), element);
                const bool valid = canness_golden::verify_index(
                    ctx, static_cast<int>(output), input_pointers.data(),
                    static_cast<int>(inputs.size()), element, actual);
                if (!valid) { ++bad; max_abs = 1.0; max_rel = 1.0; }
#else
                if (outputs[output]->dtype == DType::I32 || outputs[output]->dtype == DType::I64) {
#if CANNESS_INTEGER_OUTPUT
                    const int64_t actual = load_integer(outputs[output]->dtype,
                                                        outputs[output]->host.data(), element);
                    const int64_t expected = canness_golden::evaluate_integer(
                        ctx, static_cast<int>(output), input_pointers.data(),
                        static_cast<int>(inputs.size()), element);
                    if (actual != expected) {
                        ++bad;
                        const double error = std::fabs(static_cast<double>(actual) - static_cast<double>(expected));
                        max_abs = std::max(max_abs, error);
                        max_rel = 1.0;
                    }
#endif
                } else {
#if CANNESS_FLOAT_OUTPUT
                    const float actual = load_value(outputs[output]->dtype,
                                                    outputs[output]->host.data(), element);
#ifdef CANNESS_GOLDEN_WITH_CONTEXT
                    const float expected = canness_golden::evaluate(
                        ctx, static_cast<int>(output), input_pointers.data(),
                        static_cast<int>(inputs.size()), element);
#else
                    const float expected = canness_golden::evaluate(
                        static_cast<int>(output), input_pointers.data(),
                        static_cast<int>(inputs.size()), element);
#endif
                    if (!std::isfinite(actual) || !std::isfinite(expected)) {
                        ++bad; max_abs = std::max(max_abs, CANNESS_MAX_ABS_ERR + 1.0); max_rel = 1.0;
                        continue;
                    }
                    const double abs_error = std::fabs(static_cast<double>(actual) -
                                                       static_cast<double>(expected));
                    const double denominator = std::fabs(static_cast<double>(expected));
                    const double rel_error = denominator > 0.0
                        ? abs_error / denominator
                        : (abs_error > 0.0 ? 1.0 : 0.0);
                    if (abs_error > max_abs) max_abs = abs_error;
                    if (rel_error > max_rel) max_rel = rel_error;
                    if (abs_error > CANNESS_MAX_ABS_ERR) ++bad;
#endif
                }
#endif
            }
        }
    } catch (const std::exception& error) {
        std::printf("CANNESS_GOLDEN_ERROR %s\n", error.what());
        golden_error = true;
        bad = -2;
    }

#ifdef CANNESS_GOLDEN_PLACEHOLDER
    // Never let the placeholder read as a pass. The runner keeps the raw
    // maxRelErr for comparison and reports `golden not implemented`.
    bad = -1;
    const char* golden = "placeholder";
#else
    const char* golden = golden_error ? "shape_error" : "custom";
#endif

    for (Tensor* tensor : outputs) aclrtFree(tensor->device);
    for (Tensor* tensor : inputs) aclrtFree(tensor->device);
    aclrtFree(tiling_device);
    aclrtDestroyStream(stream);
    aclrtResetDevice(0);
    aclFinalize();

    std::printf(
        "CANNESS_RESULT {\"maxAbsErr\":%.9g,\"maxRelErr\":%.9g,"
        "\"badCount\":%lld,\"total\":%lld,\"golden\":\"%s\",\"sampleUs\":%.9g}\n",
        max_abs, max_rel, static_cast<long long>(bad),
        static_cast<long long>(total), golden, last_launch_us);
    return 0;
}
