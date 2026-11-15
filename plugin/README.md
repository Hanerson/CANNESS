# dsh-canness

The [CANNESS](../README.en.md) plugin package for DeepSeek Harness. It provides operator generation, local packaging and checks, remote Ascend NPU evaluation, and CANNBench export.

## Build and load

Run these commands from this package directory. Node.js ≥ 24.9 and pnpm 11 are used for development.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm kb:validate
```

Link this directory into a dsh profile with `dsh plugin --profile canness-web add "/absolute/path/to/CANNESS/plugin"`. The Web profile provides the CANNESS settings card and the CANNLab connection service. See the [setup guide](../docs/guides/setup.md) for profile creation, path resolution, and credentials.

dsh loads `lib/`. Rebuild and reload after editing `src/`. The next tool call reads changes to knowledge entries and package templates from disk.

## Tool groups

- `canness-knowledge` provides `kb_search`.
- `canness-generator` provides `submit_spec`, `write_operator`, `build_test_package`, `write_package_file`, and `export_submission`.
- `canness-eval` provides `preflight_evaluation`, `run_evaluation`, and `fetch_remote_file`.
- `canness-loop` applies the session-scoped iteration policy. `canness` and `canness-remote` provide the Web settings entry and the host-side connection routes.

See the [tool reference](../docs/reference/tools.md) for arguments, the kernel ABI, and artifact formats, and the [remote guide](../docs/guides/remote-evaluation.md) for runner behavior.

## Package layout

- `src/` contains the plugin entries, tool schemas, and evaluation and knowledge logic. `src/client/` contains the settings UI.
- `templates/build-contract/` contains the test harness. `templates/cannbench/` contains the direct-launch export skeleton.
- `remote/runner.py` executes the test package on the NPU host.
- `knowledge_base/` contains structured entries and legacy notes. Add entries with the [authoring guide](../docs/guides/knowledge-base-authoring.md).
- `tests/` contains unit tests and local integration fixtures.

[MIT License](../LICENSE)
