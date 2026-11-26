# 2026-11-19 插件体检问题归档

SwiGLU 实践收尾时对插件本身做的一轮体检，共 14 条（`CAN-101` ~ `CAN-114`），
其中 3 条 P0 直接阻塞评测。多数在当时的实践侧被绕过，**根因仍由插件承担**。
2026-11-26 的补丁闭环了其中的 CAN-105/106/103/112/113 的一部分，见
[rotary-practice 的去重表](../2026-11-26-rotary-practice/README.md#与-2026-11-19-条目的去重)。

| ID | 优先级 | 标题 | 结论 |
|---|---|---|---|
| [CAN-101](CAN-101-crlf-template-breaks-linux-build.md) | P0 | 契约模板 `build.sh` 是 CRLF，Linux 上必然编译失败 | 模板改 LF（`.gitattributes` 兜底），根因未修 |
| [CAN-102](CAN-102-selfcheck-kernel-uncompilable-on-cann900.md) | P0 | 自检 kernel 在 CANN 9.0.0 不可编，却当作硬门禁 | 已打补丁，根因未修 |
| [CAN-103](CAN-103-no-supported-package-repair-path.md) | P0 | 没有受支持的修包/重签通道 | 已绕过；2026-11-26 提供 `repair_package` 与导出侧覆盖 |
| [CAN-104](CAN-104-package-hash-triple-source-and-compile-only-gate.md) | P1 | `packageHash` 三个真相源 | 已绕过 |
| [CAN-105](CAN-105-single-shape-evaluation-vs-multi-case-task.md) | P0 | 闭环只覆盖单 shape，任务是 20 case | 2026-11-26：`validate_submission({cases_file})` + `run_evaluation({submission})` |
| [CAN-106](CAN-106-validate-submission-output-truncation-and-no-case-isolation.md) | P1 | 校验器只留末尾 4 KB、无 case 隔离 | 2026-11-26：每 case 独立进程 + 证据化输出 + 状态分类 |
| [CAN-107](CAN-107-no-local-kernel-lint.md) | P1 | 缺本地 kernel 接口 lint | 未解决（`check:kernel` 仅覆盖部分） |
| [CAN-108](CAN-108-read-roots-empty-blocks-header-inspection.md) | P1 | `readRoots` 默认空，读不到头文件 | 未解决 |
| [CAN-109](CAN-109-profiler-csv-unreachable.md) | P1 | msprof 产物不可猜，取不回来 | 未解决 |
| [CAN-110](CAN-110-shape-changing-export-template-gap.md) | P2 | shape-changing 导出无模板与 ABI 文档 | 已绕过；2026-11-26 增加 `support` 声明 |
| [CAN-111](CAN-111-attr-numeric-precision.md) | P2 | 属性只有 `float` + `integer`，大整数要"知道内情" | 已绕过（读 `hasInteger/integer`） |
| [CAN-112](CAN-112-golden-fixtures-tied-to-literal-shape.md) | P2 | golden fixture 绑字面 shape | 已绕过；2026-11-26 增加 `probe_run` |
| [CAN-113](CAN-113-kb-gaps-for-elementwise-perf.md) | P2 | KB 缺条目、结论与实测矛盾 | 部分修复（arch 映射、Level-2 调用开销已补） |
| [CAN-114](CAN-114-minor-workflow-friction.md) | P3 | 其余工作流摩擦 | 部分绕过 |
