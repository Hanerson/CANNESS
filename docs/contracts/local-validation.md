# Local validation without CANN

These commands run host checks without remote evaluation budgets. They do not validate NPU instruction support or execute the device kernel. Use the target compiler and NPU evaluation for those facts.

## Actual kernel syntax across dtypes

```sh
node plugin/scripts/check-kernel.mjs --package /path/to/packages/gen-deadbeef --dtypes float32,float16,bfloat16,int32 --compiler g++
```

The CLI compiles the actual `op_kernel/kernel.cpp` with `g++ -std=c++17 -fsyntax-only`, using the bounded API model in `plugin/templates/local-validation/kernel_operator.h`. It mirrors the package into a temporary directory, preserves package includes and common tiling declarations, and changes generated `DTYPE_X`/`DTYPE_Y` aliases per variant. Outputs matching the original input dtype vary with it; fixed output types remain fixed. Input tensor dtypes must be uniform. The source package stays unchanged.

Supported names are float32, float16, bfloat16, int32, and int64 (common aliases are normalized). Each requested variant has a pass/error result and compiler diagnostics. Exit codes are 0 for all variants passing, 1 for compiler failures, and 2 for invalid input. JSON includes `targetValidated:false`, source file hashes, stub hash, compiler executable, and each dtype result. Compilation is limited to 25 seconds per variant and 100 seconds total; the package copy is limited to 50 MB and rejects symlinks and non-regular files. `--compiler` defaults to `CXX` or `g++` and names an executable without shell arguments.

The model declares a limited typed subset: local/global tensors, buffers/queues/pipeline allocation, basic arithmetic/scalar/unary operations, copies, comparison/select/cast, event flags, and barriers. Unknown APIs and unmodeled overloads produce compiler diagnostics. They may be valid target APIs: an error means the host model cannot validate that source, not that CANN forbids it. No generic catch-all API signatures hide unknown calls. The bitwise model accepts only int16_t/uint16_t vector elements; this is a deliberate local restriction, not an assertion about every CANN target. `_Float16` requires host compiler support; bfloat16 is a distinct two-byte placeholder without arithmetic semantics. This is a syntax check, not an emulator. It catches common typos, tensor element mismatches and instantiated template errors but cannot establish target overload availability, address-space behavior, vector alignment, numerical correctness, or code generation validity. Uninstantiated template branches retain ordinary C++ syntax-check limitations.

An explicitly requested failing kernel check blocks remote evaluation before spending budget. Run `preflight_evaluation` with `kernel_dtypes` to inspect diagnostics, or supply `kernel_dtypes` on `run_evaluation` to gate that evaluation. When the model lacks an API required by the source, target compilation remains necessary; the tool does not silently accept it.

## Real golden reference

Use `check-golden.mjs --package DIR --fixtures reference.json` to compile the real golden against explicit independent reference vectors. It supports context and batch callbacks, nonfinite floats, exact int64 values supplied as decimal strings, and rounded half/bfloat16 raw inputs. See [the fixture format and contract](direct-launch.md#local-golden-validation-command). This validates only golden behavior on the supplied cases.

## Editable algorithm simulation

```sh
python -B plugin/templates/local-validation/algorithm-simulation.py --seed 42
# Optional, only when PyTorch is already installed:
python -B plugin/templates/local-validation/algorithm-simulation.py --seed 42 --torch
```

Copy this template into the task workspace and replace `candidate_scan_min` or `candidate_reduce_sum` with the algorithm actually used by the kernel. The supplied candidates demonstrate doubling scan and pairwise reduction in NumPy, checked against separate slow prefix/row references. Inputs cover axis lengths 1, 2, 3, 7, 16, 31, and 257, ties, NaNs, infinities, and deterministic random values. Scan-min uses the latest tied/NaN index. `--torch` adds an optional `torch.cummin` oracle. There are no automatic installations; missing NumPy or requested PyTorch returns JSON `status:unavailable` with exit code 2. Mismatches exit 1; passes exit 0. Every result says `targetValidated:false`.

The unchanged example is a template self-test, not validation of your kernel algorithm. It uses float64 host arithmetic and needs task-specific edits for target dtype rounding, tile boundaries, masking, multi-axis layouts, and actual vector schedules. Keep the independent reference unchanged while adapting the candidate. Do not equate a passing example with device correctness.
# Scope clarification

Dtype variants rewrite the generated `DTYPE_X`/`DTYPE_Y` aliases; hardcoded C++ tensor types in a kernel remain hardcoded. Packaged `kernel_operator.h` overrides are rejected so quoted includes cannot silently replace the bounded stub.
