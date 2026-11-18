# Practice issue fixes implementation plan

**Goal:** Match CAN-001–015 against current code and repair confirmed plugin defects without changing user profiles or sandbox policy.

**Architecture:** Retain the direct-launch kernel contract; explicitly classify host/api/plugin as documented-only. Keep workspace selection shared and honor explicit overrides. Separate diagnostic compilation, manual evaluation and automatic steering budgets; preserve artifact provenance.

**Spec:** User-provided C:/Users/71575/Desktop/canness-issues and WORKFLOW-REVIEW.md, verified against current source. User authorized direct execution on correspondence.

**Constraints:** No automatic ACL repair or privilege weakening. Do not silently rewrite user configuration. Do not invent hardware metrics or claim unexecuted submission validation. Retain existing tool compatibility.

## Tasks
- [ ] Generator: regression tests then preserve same-spec artifacts on reset, actionable missing-source errors, partial-layer writes with provenance.
- [ ] Remote runner: regression tests then compile-only diagnostics without evaluation counters; shared toolchain facts; truthful missing metrics, stable sampling, phase timings.
- [ ] Contract/export: regression tests then named attribute lookup, documented-only layer metadata, hashed custom wrapper and explicit public signature, batch golden API.
- [ ] Eval/policy/workspace: regression tests then session workspace coverage, explicit policy blocks, bounded forced retest, comparison identity, read-only configured roots and historical generation fetch with digests.
- [ ] Local validation: provide real golden host compilation checks without claiming stub checks prove target API support; document unsupported verification.
- [ ] Review all diffs, run full tests/types/build and record unresolved external/hardware limits.

## Review focus
- Explicit workspace override must not be silently ignored; cwd contexts without headers need coverage.
- Reset must never copy artifacts between incompatible tensor/attribute contracts.
- Force must not become unlimited automatic retry or bypass time/iteration safety ceilings.
- Remote read roots must use resolved containment and reject symlink escapes.
- Custom export source and validation inputs must participate in hashes; unverified outputs remain labeled unverified.

## Correspondence rulings
CAN-001: environment/host ownership; diagnose rather than modify ACLs from plugin. CAN-002: explicit overrides already work as designed; strengthen context coverage and configuration diagnostics. CAN-009: choose documented-only B rather than pretending arbitrary generated host code is executable under a universal ABI. Remaining enhancements implemented with truthful capability reporting, not mock validation.

## Final execution evidence

Implemented the tasks above and the user's revised CAN-016/017: template/code fingerprint separation and stale-build warnings; synchronous workspace task ownership guards; effective budget and persisted policy/ownership rejections. Compiled host and browser outputs rebuilt. Loaded `lib/package-files.js` directly: `codeSource=lib`, template content hash present, `staleBuild=false`.

Full Vitest suite: 33 files / 249 tests passed. Host and client TypeScript checks passed. Knowledge validation: 18 entries. Diff whitespace check passed (line-ending normalization notices only). No real NPU rerun because the revised issues report exhausted remote quota. Source remains uncommitted for user review.

Limits retained: CAN-001 and cross-tool dispatch are host/DSH-owned; missing profiler AIV/AIC facts are not inferred; CAN-015 implements real host golden validation plus remote kernel compile-only, not a universal fake AscendC CPU stub. Running dsh processes must reload the rebuilt module before new behavior becomes visible.

## Non-hardware completion follow-up

Per user instruction, completed CAN-006 sourced blockDim fallback and explicit kernel task subtype evidence, plus CAN-015 bounded multi-dtype host kernel syntax checker and NumPy scan/reduce simulation template. Both local golden and kernel checks integrate into preflight and evaluation gates; failed checks and transport rejections retain budget/owner metadata and lastBlocked. Invalid direct session cwd now falls through to valid header cwd.

Verification: 35 Vitest files / 255 tests passed, host/client checks and compiled build passed, 18 KB entries validated. New simulation Python tests 2/2 passed and NumPy example passed 28 cases. Kernel checker targeted rerun passed 3/3 after reserved-header hardening. No NPU connection, hardware profiling, or remote evaluation was performed. Host/DSH-owned ACL and cross-tool dispatch items remain assigned externally, as already ruled by the issue review.
