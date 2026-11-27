# CAN-231 外层 1800 秒可能先于内部阶段截止

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P2** |
| 组件 | `plugin/src/eval-run.ts`、`plugin/remote/runner.py` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `timeout`, `runner` |
| 复核 | 2026-11-27。从 CAN-227 拆出。4200 秒只是三个阶段参数之和 |

## 现象

bundle 的 `timeoutSec` 是 1800。`runnerCommand` 用同一个秒数套 `timeout --kill-after=10s`。runner 内部默认是 build 1800、run 600、msprof 1800。这三个参数相加是 4200 秒，还没有把构建自检算进去。外层可以在 runner 自己的阶段截止之前 SIGKILL。

退出码 124 直接记 `timeout`，不读可能已经写好的 `results.json`。策略里 `timeouts >= 2` 写死，force 不能越过超时次数。

提交验收通过自己的 `--timeout-sec` 设置截止时间。集成路径显式传入 profile 的 `timeoutSec`，helper 仅在调用方未传入时回退到 600 秒。

缺少数字退出码时按 0 处理，见 [CAN-227](CAN-227-ssh-exit-and-timeout-budget.md)。

## 证据

- `plugin/src/eval-run.ts` 第 66–67 行与第 161 行：外层 `timeout` 使用 `timeoutSec`。第 168–170 行：码 124 即 `timeoutReport`。
- `plugin/cordis.patch.yml` 第 19 行：`timeoutSec: 1800`。
- `plugin/remote/runner.py` 第 1158–1160 行：`--build-timeout` 1800、`--run-timeout` 600、`--msprof-timeout` 1800。三者之和为 4200，构建自检不在这三项里。
- `plugin/src/policy.ts` 第 224 行：`timeouts >= 2`。第 248–252 行：force 的白名单没有 `timeouts`。
- `plugin/src/eval.ts` 第 508 行将 profile 的 `timeoutSec` 传给验收。`plugin/src/submission-validation.ts` 第 46、69 行在未传值时回退到 600 秒，并将实际值传给远端 `--timeout-sec`。

## 影响

一次走完编译、运行和 msprof 的评测，外层 1800 秒可以先杀掉进程。已写出的 `results.json` 在退出码 124 时不被采用。两次这样的超时之后，任务停在超时次数上。验收命令使用自己的截止时间，不受这层 1800 秒包装。

## 期望

构建自检、编译、运行和 profiler 的阶段预算与总截止一致。可以扩充外层预算，也可以从固定总预算中分配阶段时间。外层应为终止子进程和写出报告留出余量。遇到 124 时，优先读取本次尝试已完整写出的 `results.json`。

## 复现

1. 对一个会跑满编译加 msprof 的包，把 `timeoutSec` 留在 1800。
2. 看进程是否在内部阶段截止之前被外层杀掉并记 `timeout`。
3. 在结果文件已经写好时再触发外层 124，看报告是否仍忽略该文件。

## 建议修复

- `runnerCommand` 的 `timeout` 改为各内部阶段之和再加上构建自检和余量，或把内部默认值改成从外层预算切分。
- 124 的分支先 `readFile(resultPath)`，文件完整则采用。
- 文档写明 4200 只是三个阶段参数之和。

## 验收标准

- 用缩短的测试时限模拟构建自检和后续阶段接近已分配的截止，确认阶段预算符合总时限、外层留出写报告的余量，超出总时限的尝试仍会结束。
- 外层返回 124 时，能采用本次尝试已经完整落盘的 `results.json`。缺文件或文件不完整时按超时报告处理。
- 提交验收仍独立执行 `--timeout-sec`。测试覆盖集成路径传入 profile 时限与 helper 未收到时限的回退。

## 关联

CAN-227、CAN-221。

## 处置和验证

阶段共享总截止并为报告留出宽限，124 时只接受本次完整结果，验收使用独立时限。
