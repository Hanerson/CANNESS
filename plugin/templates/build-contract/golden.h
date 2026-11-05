// CANNESS build contract v1: accuracy reference for {{OPERATOR_NAME}}.
//
// This file is the only operator-specific file the model owns. Implement the
// formula for one output element and return it as a float:
//
//   out         output index (0-based) when the operator has several outputs
//   in          in[input][index] holds the inputs already converted to float
//   in_count    number of inputs
//   index       element index inside the tensors
//
// Example (Gelu, tanh approximation):
//   const float x = in[0][index];
//   return 0.5f * x * (1.0f + std::tanh(0.7978845608028654f *
//          (x + 0.044715f * x * x * x)));
//
// Replace the whole body and REMOVE the CANNESS_GOLDEN_PLACEHOLDER define.
// While the define is present the evaluation reports `accuracy_fail` with
// "golden not implemented" and never passes.
//
// Prefer write_package_file('golden.h', ...) over editing this file by hand in
// the package: the operator directory is the source build_test_package copies.
#pragma once

#include <cmath>
#include <cstdint>

#define CANNESS_GOLDEN_PLACEHOLDER 1

namespace canness_golden {
inline float evaluate(int out, const float* const* in, int in_count, int64_t index) {
    (void)out;
    (void)in;
    (void)in_count;
    (void)index;
    return 0.0f;
}
}  // namespace canness_golden
