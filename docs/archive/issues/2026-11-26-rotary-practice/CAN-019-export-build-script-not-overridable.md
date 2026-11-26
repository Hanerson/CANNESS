# CAN-019 导出的 `build.sh` 只能整体替换模板，没有算子级/平台级覆盖通道

> 去重：本条与既有 **CAN-103**（无受支持的修包/重签通道）、**CAN-104**（packageHash 三源）重叠，建议并入 CAN-103 并保留本文件作为「导出侧 build.sh 由模板重渲染」的实例证据。

| 字段 | 值 |
|---|---|
| 类型 | enhancement（设计缺陷） |
| 优先级 | **P1** |
| 组件 | `canness-generator`（`submission.ts` 的 `exportSubmission`、`templates/cannbench/build.sh`） |
| 首次发现 | 2026-11-25，ApplyRotaryPosEmb 需要 A3 编译（`-xasc --npu-arch=dav-2201`） |
| 状态 | workaround-in-template（模板已改；仍然没有 per-operator 通道） |
| 标签 | `export`, `build`, `template`, `arch` |

## 现象

要修 A3 编译，只能改**全局模板** `templates/cannbench/build.sh`。这带来三个问题：

1. `export_submission` 永远用模板重新渲染 `build.sh`（`submission.ts` 里 `files['build.sh'] = render('build.sh', values)`），所以 **`repair_package({write:[build.sh]})` 对导出包无效** —— 我第一次就是这么试的，白忙一轮。
2. 模板是全局的：改一处会影响**所有算子**、所有历史 generation 的下一次导出，没有版本门禁，也没有"这个算子用哪套构建"的记录。
3. `values` 只注入 `SOC_VERSION`、`VARIANTS` 两个与构建有关的量；算子的真实构建差异（arch 族、链接库、额外 include、是否需要 `--cce-fatobj-link`）无法从 spec 表达。

本轮实际需要的构建差异就有三类：arch 族映射（910B/A3 同 `dav-2201`，950 是 `dav-3510`）、`-xasc` 而不是 `-x cce`、以及三套 toolkit 头文件布局（`tikcpp/tikcfw` / `asc/include` / `compiler/ascendc`）。

## 期望

- `exportSubmission(..., { buildScript })` 允许算子级覆盖，参与 `provenance.json` 哈希；
- 或者 spec 增加 `build: { arch_family?, extra_includes?, link_libs?, compiler_flags? }`，由模板参数化渲染；
- 无论哪种，`repair_package` 对 `build.sh` 的修改应当**在导出时生效**（或明确报错说明会被模板覆盖）；
- 导出报告里回显"用了哪套构建参数"，可追溯。

## 影响

- 当前只能靠改全局模板绕过，任何回退都会让 A3/950 重新不可编；
- 用户/模型会误以为 `repair_package` 能修构建脚本（我踩了）；
- 历史包与新模板解耦，无法复现"当时是怎么编的"。

## 复现

1. `export_submission(...)` → 得到 `source/build.sh`（模板渲染版）；
2. `repair_package({ write: [{ path: 'build.sh', content: <改过的> }] })` → 包内已改；
3. 再次 `export_submission(...)` → `source/build.sh` 又变回模板版本（修改丢失）。

## 建议修复

1. `SubmissionExportOptions` 增加 `buildScript?: string`（与 `wrapper` 同等对待：参与哈希、`bindings` 标注）；
2. 或让模板读取 spec 的 `build` 段；
3. `repair_package` 若检测到 `build.sh`，在结果里提示"导出时会被模板覆盖"；
4. `manifest.json` / `provenance.json` 记录构建参数指纹。

## 验收标准

- 同一 generation 能导出两种 arch 族（910B/A3 与 950）的包，且 `provenance` 记录各自构建参数；
- 修 `build.sh` 的算子级覆盖在导出后仍然存在；
- 改模板不再静默影响其它算子的行为（或至少在导出报告里标出模板 version/hash）。

## 关联

CAN-018（arch 写死 + 用户确认）、CAN-016（lib/templates 混用契约）
