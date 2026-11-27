# CAN-217 两份独立 Python 测试未进入 CI

| 字段 | 值 |
|---|---|
| 类型 | 测试 |
| 优先级 | **P2** |
| 组件 | `plugin/tests/*.py`、`.github/workflows/ci.yml`、`plugin/remote/runner.py` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `ci`, `runner`, `validate_submission` |
| 复核 | 2026-11-27。`--loop` 只由 CAN-220 跟踪 |

## 现象

`pnpm test` 只跑 Vitest，`vitest.config.ts` 的 include 是 `tests/**/*.test.ts`。CI 对 `remote/runner.py` 和 `remote/validate_submission.py` 只做 `py_compile`，对 `templates/cannbench/build.sh` 做 `bash -n`。

`plugin/tests/test_submission_validation.py` 和 `plugin/tests/test_algorithm_simulation.py` 没有 CI 步骤执行。已有的 runner 诊断覆盖了部分非零退出和精度失败。尚未单独断言的失败分支是：构建超时、缺少可执行文件、缺少结果标记、坏 manifest。

## 证据

- `plugin/package.json` 的 `test` 脚本是 `vitest run`。
- `plugin/vitest.config.ts` 只包含 `*.test.ts`。
- `.github/workflows/ci.yml` 第 49–54 行：`py_compile` 两个远端脚本，`bash -n` 一个 `build.sh`。没有 `unittest`。
- `plugin/tests/` 下有 39 个 `*.test.ts` 和 3 个 `*.py`。其中 `runner_diagnostics_test.py` 由 TypeScript 测试启动；另外两个 Python 文件没有被引用。
- 诊断测试已经覆盖部分非零退出和精度失败。构建超时、缺可执行文件、缺结果标记、坏 manifest 没有各自的断言。

`--loop` 的残留见 [CAN-220](CAN-220-hygiene-followups.md)。本条不跟踪它。

## 影响

`validate_submission` 的回归不在 CI 里。runner 把构建超时、缺可执行文件、缺结果标记或坏 manifest 分错类时，没有对应夹具拦住。已有诊断能拦住的非零退出和精度失败保持原覆盖。

## 期望

CI 在有 Python 时执行这两份 unittest。没有 Python 的 job 明确 skip 并在摘要里写出来。runner 为构建超时、缺可执行文件、缺结果标记、坏 manifest 各加一条断言。

## 复现

1. 读 CI 的 “Remote script syntax” 步骤。
2. 在仓库中搜索 `test_submission_validation` 的引用，只有文件自己。
3. 跑 `pnpm test` 不会执行该文件。

## 建议修复

- 在 `eval-runner.test.ts` 的同一风格下 `spawnSync` 这两份 unittest，失败则测试失败。
- 或 CI 增加 `python -m unittest discover -s tests -p 'test_*.py'`。
- 给上述四个失败分支各加一条夹具，断言 `status` 和 `summary`。

## 验收标准

- 故意让 `validate_submission` 的设备故障分类返回错误字符串时，CI 变红。
- `py_compile` 仍保留，同时有行为检查。
- 构建超时、缺可执行文件、缺结果标记、坏 manifest 各有一条断言。

## 关联

CAN-204、CAN-223。`--loop` 见 CAN-220。

## 处置和验证

CI 运行独立 Python 行为用例，并保留语法检查及 runner 诊断。
