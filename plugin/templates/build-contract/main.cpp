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
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "canness_tiling.h"
#include "golden.h"

#define CANNESS_OPERATOR "{{OPERATOR_STRING}}"
#define CANNESS_INPUT_COUNT {{INPUT_COUNT}}
#define CANNESS_OUTPUT_COUNT {{OUTPUT_COUNT}}
#define CANNESS_TOTAL_ELEMENTS {{TOTAL_ELEMENTS}}
#define CANNESS_BLOCK_DIM {{BLOCK_DIM}}
#define CANNESS_BLOCK_LENGTH {{BLOCK_LENGTH}}
#define CANNESS_TILE_LENGTH {{TILE_LENGTH}}
#define CANNESS_MAX_ABS_ERR {{MAX_ABS_ERR}}
// Scratch bytes appended to the tiling buffer (issue 013); 0 by default.
#define CANNESS_WORKSPACE_BYTES {{WORKSPACE_BYTES}}

// Fixed kernel entry: every input, every output, then the tiling buffer.
extern "C" __global__ __aicore__ void canness_kernel({{KERNEL_ARGS_DECL}});

enum class DType { F16, BF16, F32 };

static size_t dtype_size(DType dtype) {
    switch (dtype) {
        case DType::F16:
        case DType::BF16:
            return 2;
        case DType::F32:
        default:
            return 4;
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

static void store_value(DType dtype, uint8_t* base, int64_t index, float value) {
    switch (dtype) {
        case DType::F16:
            reinterpret_cast<uint16_t*>(base)[index] = float_to_f16(value);
            break;
        case DType::BF16:
            reinterpret_cast<uint16_t*>(base)[index] = float_to_bf16(value);
            break;
        case DType::F32:
        default:
            reinterpret_cast<float*>(base)[index] = value;
            break;
    }
}

static float load_value(DType dtype, const uint8_t* base, int64_t index) {
    switch (dtype) {
        case DType::F16:
            return f16_to_float(reinterpret_cast<const uint16_t*>(base)[index]);
        case DType::BF16:
            return bf16_to_float(reinterpret_cast<const uint16_t*>(base)[index]);
        case DType::F32:
        default:
            return reinterpret_cast<const float*>(base)[index];
    }
}

struct Tensor {
    void* device = nullptr;
    std::vector<uint8_t> host;
    int64_t elements = 0;
    DType dtype = DType::F32;
};

// Deterministic inputs spread over [-2, 2]: wide enough to exercise tanh and
// polynomial paths, bounded enough to avoid saturation in every operator.
static float pattern_value(int64_t index) {
    const uint32_t hashed = static_cast<uint32_t>(index) * 2654435761u;
    return -2.0f + 4.0f * static_cast<float>(hashed % 1000u) / 999.0f;
}

static Tensor make_tensor(DType dtype, int64_t elements, bool input) {
    Tensor tensor;
    tensor.elements = elements;
    tensor.dtype = dtype;
    tensor.host.assign(static_cast<size_t>(elements) * dtype_size(dtype), 0);
    if (input) {
        for (int64_t index = 0; index < elements; ++index) {
            store_value(dtype, tensor.host.data(), index, pattern_value(index));
        }
    }
    return tensor;
}

static int fail(const char* step, int code) {
    std::printf("CANNESS_ERROR %s (code %d)\n", step, code);
    return 1;
}

int main() {
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

    canness_kernel<<<CANNESS_BLOCK_DIM, nullptr, stream>>>({{KERNEL_ARGS_CALL}});

    // SynchronizeDevice waits for every stream; SynchronizeStream can return
    // before the kernel has written the outputs.
    status = aclrtSynchronizeDevice();
    if (status != ACL_SUCCESS) return fail("aclrtSynchronizeDevice", static_cast<int>(status));

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
    for (size_t output = 0; output < outputs.size(); ++output) {
        for (int64_t element = 0; element < outputs[output]->elements; ++element) {
            ++total;
            const float actual = load_value(outputs[output]->dtype,
                                            outputs[output]->host.data(), element);
            const float expected = canness_golden::evaluate(
                static_cast<int>(output), input_pointers.data(),
                static_cast<int>(inputs.size()), element);
            const double abs_error = std::fabs(static_cast<double>(actual) -
                                               static_cast<double>(expected));
            const double denominator = std::fabs(static_cast<double>(expected));
            const double rel_error = denominator > 0.0
                ? abs_error / denominator
                : (abs_error > 0.0 ? 1.0 : 0.0);
            if (abs_error > max_abs) max_abs = abs_error;
            if (rel_error > max_rel) max_rel = rel_error;
            if (abs_error > CANNESS_MAX_ABS_ERR) ++bad;
        }
    }

#ifdef CANNESS_GOLDEN_PLACEHOLDER
    // Never let the placeholder read as a pass. The runner keeps the raw
    // maxRelErr for comparison and reports `golden not implemented`.
    bad = -1;
    const char* golden = "placeholder";
#else
    const char* golden = "custom";
#endif

    for (Tensor* tensor : outputs) aclrtFree(tensor->device);
    for (Tensor* tensor : inputs) aclrtFree(tensor->device);
    aclrtFree(tiling_device);
    aclrtDestroyStream(stream);
    aclrtResetDevice(0);
    aclFinalize();

    std::printf(
        "CANNESS_RESULT {\"maxAbsErr\":%.9g,\"maxRelErr\":%.9g,"
        "\"badCount\":%lld,\"total\":%lld,\"golden\":\"%s\"}\n",
        max_abs, max_rel, static_cast<long long>(bad),
        static_cast<long long>(total), golden);
    return 0;
}
