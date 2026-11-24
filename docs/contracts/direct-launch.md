# Direct launch, attributes, and submission exports

Build contract v1 compiles `op_kernel/kernel.cpp` with the generated `main.cpp` host driver. `op_host/host.cpp`, `op_api/api.cpp`, and `op_plugin/plugin.py` are **documented-only** sources: they are copied and hashed for provenance but are not compiled, imported, or executed by evaluation or automatic export. Manifest `compiledLayers` and `documentedOnlyLayers` make that distinction explicit. Put executable launch geometry in `spec.launch`, runtime attributes in `spec.attrs`, and supported numeric transformations in `spec.attrs_derived`. Arbitrary host geometry code needs a custom submission wrapper and separate validation.

Attribute table indices follow the parsed JSON object's enumeration order for `attrs`, followed by `attrs_derived`. JavaScript orders integer-like keys numerically; serialization may also reorder object keys. Kernels should use `attrs.find("dim")` instead of relying on an index. Device string literals live in global memory, so `find` is a member template over the character type; `attrs.find("dim")`, a `const __gm__ char[]`, and a locally built `char key[]` all bind without an address-space conversion. It is one template rather than two overloads because CANN 8.0.1/9.2.1 expand `__gm__` to an attribute, and attributes do not participate in overload resolution. A missing name returns `GoldenAttrType::Missing`; test that tag before reading its value. Strings are length-delimited. Positional `get(index)` remains available for compatibility.

`interface.attrs` explicitly selects and orders public attribute parameters. Omitted attributes keep their spec values inside the generated wrapper. This is suitable for fixed internal constants; geometry that depends on input shape requires a custom wrapper. Existing specs without `interface.attrs` expose all attrs as before. Defaults must follow required public attrs. A generated wrapper accepts only same-shape tensors. `interface.dtypes` varies uniform input dtypes and outputs matching the original input dtype; fixed output dtypes such as int64 remain fixed.

`exportSubmission(workspace, generationId, spec, callable?, { wrapper?, signature? })` accepts complete Python module source as `wrapper`. Custom source requires an explicit `signature`, such as `cummin(input, dim)`, and is responsible for shape checks, output allocation, internal geometry, and calling the supplied launch library correctly. It can export shape-changing operators. Without custom source, a supplied signature is an exact assertion against the generated signature. Custom signature text is a declaration, not proof that the Python module implements it. The source file and public signature have SHA-256 provenance hashes. Exports are explicitly `validation.status = "unverified"`: successful packaging and kernel evaluation do not establish that the wheel builds or its Python interface works on an NPU.

# Golden reference callbacks

The default callbacks run output by output in ascending output index, then element by element in ascending element index. Each executable invocation constructs one test case. Avoid process-global cached state that survives cases in another harness; initialize caches from each callback's inputs and context.

For scans and reductions define `CANNESS_GOLDEN_BATCH` in custom `golden.h` and implement callbacks for each output category your spec uses:

```cpp
inline void evaluate_all(GoldenCtx ctx, int out, const float* const* in,
                         int in_count, float* destination, int64_t count);
inline void evaluate_integer_all(GoldenCtx ctx, int out, const float* const* in,
                                 int in_count, int64_t* destination, int64_t count);
```

Each applicable callback runs once per output and fills exactly `count` values. It receives the real output element count, which can differ from input size. Existing tolerance, integer exactness, and mismatch accounting remain the same. Index-check mode retains `verify_index` and does not invoke batch callbacks. Without the macro, the existing per-element API remains unchanged. Golden shape assertions still become explicit accuracy failures.

For local checks, compile the **real** custom `golden.h` in a small host C++ harness including `canness_tiling_common.h`, and compare its filled outputs with a trusted task-specific reference (including ties, NaN, infinities, and dtype boundaries). This repository does not provide a universal mathematical oracle or claim AscendC support from host stubs. Kernel API availability still requires the target compiler. Submission validation must separately compile the exported launch source, install the wheel in an isolated environment, and execute an explicit task-specific correctness script on the target.

# Local golden validation command

After `build_test_package`, run (no CANN installation required):

```sh
node plugin/scripts/check-golden.mjs --package /path/to/packages/gen-deadbeef --fixtures /path/to/reference.json --compiler g++
```

`--compiler` defaults to `CXX` or `g++`. It must name an executable, without shell arguments. The command compiles the actual package `golden.h` against the actual generated host/common headers, then executes it against explicit input vectors and compares its results with supplied expected vectors. Temporary compiler outputs are removed. Compilation and execution each have a 60 second timeout. It returns JSON and exit code 0 for pass, 1 for mismatches, or 2 for malformed inputs, missing compiler, compilation errors, or execution errors. `kernelValidated` is always false. The package remains unchanged; no remote evaluation budget is consumed.

Fixture format:

```json
{
  "absThreshold": 0.000001,
  "relThreshold": 0.000001,
  "cases": [{
    "inputs": [[1, "nan", "+inf"]],
    "expected": [[1, "nan", "+inf"]]
  }]
}
```

Vectors follow manifest input/output order and must match each tensor's literal element count. Generate these vectors with an independent trusted reference such as a task-specific PyTorch program. No reference is invented by the checker. For exact integer values outside JSON's safe integer range use decimal strings, e.g. `"9007199254740993"`; int64 minima/maxima are supported without conversion through floating point. Floating-point special values use `"nan"`, `"+inf"`, and `"-inf"`. NaNs match NaNs, and infinity signs must match. Finite float comparisons use `absThreshold + relThreshold * abs(expected)`. Integer outputs compare exactly. Float16/bfloat16 inputs are rounded to their actual storage formats before golden sees either float inputs or raw buffers.

Context callbacks receive manifest input dtype names, raw input buffers, first-input shape, and attributes. A fixture may override `attrs` and `shape` for its context; shape overrides do not resize any tensor vectors. The batch callbacks described above are supported. Placeholder golden, symbolic tensor sizes, and index-check mode are explicitly rejected. For index-check correctness write task-specific tests that accept all valid tied indices. This command validates only golden behavior on the supplied vectors. It does not validate AscendC syntax, device API support, kernel correctness, submission imports, or NPU execution.
