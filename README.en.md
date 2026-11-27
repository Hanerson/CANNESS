# CANNESS

[简体中文](README.md) · [Documentation](docs/README.md) · [Changelog](CHANGELOG.md) · [CI](https://github.com/Hanerson/CANNESS/actions/workflows/ci.yml)

CANNESS is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin for Ascend CANN operator development. It turns an operator specification into a kernel and test package, evaluates it on a remote NPU, and iterates within a budget. It can also export operators that fit its current export contract as CANNBench submissions.

## Quick start

The plugin package version is `0.5.0`. The local environment needs Node.js ≥ 24.9, pnpm 11, and dsh 0.2.x. Knowledge search, packaging, export, and local preflight work offline. Model calls follow the dsh configuration. Hardware evaluation needs an SSH-accessible Linux Ascend NPU host or a CANNLab tunnel.

With dsh installed, run:

```bash
git clone https://github.com/Hanerson/CANNESS.git
cd CANNESS
pnpm --dir plugin install --frozen-lockfile
pnpm --dir plugin build

dsh --profile canness-web --from-default-profile web --dump-config
dsh plugin --profile canness-web add "/absolute/path/to/CANNESS/plugin"
dsh --profile canness-web
```

Replace the plugin path with your absolute checkout path. In the Web UI, open **Settings → CANNESS** to configure SSH or connect to CANNLab. The plugin uses its bundled knowledge base by default. To use a custom knowledge base, set its path as shown in the [setup guide](docs/guides/setup.md).

Ask the agent to call `kb_search` for Exp to check that the plugin loaded. After building a test package, use `preflight_evaluation()` to check it locally and `preflight_evaluation({ remote: true })` to check the remote toolchain.

## Workflow

1. **Submit a specification and find evidence.** Use `submit_spec` to set the tensor contracts, target platform, and performance goal. Use `kb_search` to retrieve sourced entries by operator, keyword, hardware, dtype, and layout.
2. **Generate and package.** Use `write_operator` to write the kernel. You can also include host, API, and plugin source for reference. Supply the correctness reference in `golden.h` with `write_package_file`, then run `build_test_package`.
3. **Evaluate and iterate.** `run_evaluation` invokes the remote runner over SSH, compiles the operator, checks correctness, and reads real `msprof` samples. Retry from the same workspace after a connection interruption. The loop stops under the configured policy and automatically retries only in the session that owns the evaluation.
4. **Export and verify.** Use `export_submission` to produce a CANNBench `direct_launch` source tree, ZIP, and provenance record. Build the wheel in the target environment and verify it with the matching official task evaluator.

dsh provides model calls, sessions, tool dispatch, and credentials. CANNESS owns the operator contract, workspace, and evaluation policy. The remote runner produces build, correctness, and performance evidence. See the [architecture](docs/design/05-plugin-architecture.md) and [tool reference](docs/reference/tools.md).

## Verification status

- **Exp** was built, installed, and evaluated on an NPU. It passed 20/20 official CANNBench correctness cases on `tasks-v2.1.0`. That run used `--no-perf`, so official performance scoring is pending.
- **ArgMax** passed CANNESS build-contract checks for 20 public case specifications. Official task evaluation and performance scoring remain open. The current CANNBench exporter requires identical tensor shapes.
- **Remote iteration** has acceptance records for CANNLab connection recovery, dsh session-scoped continuation, duplicate evaluation reuse, and stall detection.
- **Knowledge base** supports structured entries and applicability filters. Coverage grows as contributors add documented evidence. See the [authoring guide](docs/guides/knowledge-base-authoring.md).

See the [acceptance backlog](tickets/TODO.md) for evidence and open work and the [changelog](CHANGELOG.md) for release records.

## Local development

From the repository root:

```bash
cd plugin
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm kb:validate
```

CI type-checks, tests, and builds on Ubuntu and Windows. Runner regression tests use local fixtures. Running the full suite also requires Python, Bash, and working localhost connections. dsh loads `plugin/lib/`, so rebuild and reload after editing plugin source.

## Documentation

- [Installation, profiles, and connections](docs/guides/setup.md)
- [Remote evaluation and troubleshooting](docs/guides/remote-evaluation.md)
- [Tool and specification reference](docs/reference/tools.md)
- [Knowledge base design](docs/design/06-knowledge-base.md) and [authoring guide](docs/guides/knowledge-base-authoring.md)
- [Documentation index](docs/README.md) and [archive](docs/archive/README.md)

[MIT License](LICENSE)
