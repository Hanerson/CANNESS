# 工作流逐步复盘：Cummin 一轮实践（2026-11-18）

对象是插件设计的**完整工作流**，逐步给"设计意图 / 本轮实际 / 评级 / 卡点"。
评级：✅ 顺畅　⚠️ 能用但有摩擦　❌ 卡住或产出不可信。

打分只看"这一步是否按设计意图完成、并给出可信反馈"，不评价算子本身的性能。

---

## 0. `kb_search`（知识检索）　⚠️

**设计意图**：开工前拿到算子契约、实现套路、评测器口径。

**本轮实际**：16 条条目里没有 Cummin；命中的是 3 条通用 CANNBench 评测器条目
（其中最有用的是 `cannbench-operator-resolution-keyword-schema`：解释了评测器如何按
snake_case+小写名+schema 名解析 callable，这条在我导出时确实用上了）。

**卡点**：知识库回答"规范怎么要求/别人怎么实现"，但**不回答"这台机器支持什么"**——
而那才是本轮最大的未知（int32 bitwise / masked Select 不支持，两次 compile_fail）。
→ CAN-005。

## 1. `submit_spec`（建代 + 预算 + 几何）　⚠️

**设计意图**：声明形状/ dtype / attrs / launch，拿一个 `generationId` 与预算窗口。

**本轮实际**：校验没有误拒；`launch.block_dim`、`attrs`、`input_values` 都按预期进入了
`main.cpp` / `config.json` / `CANNessAttrTable`；`reset:true` 按文档"开始新的预算窗口"生效。

**卡点**：
- `reset` 不携带四层源码，导致下一步直接 ENOENT（CAN-003）；
- 我提交的 attrs 顺序 `dim,outer,axis,inner` 被规范化成字母序，而契约自带的示范 kernel
  按 index 读 attr —— 这是个静默错位陷阱（CAN-010）。

## 2. `write_operator`（四层源码）　⚠️

**设计意图**：把 kernel / host / api / plugin 落到 `operators/<gen>/`。

**本轮实际**：**入口校验是整套工具里最好的一处**。我第一次只写了半个 kernel（还没有
`canness_kernel`），它给的错误精确到因果：

> `op_kernel/kernel.cpp must define "void canness_kernel(<inputs>, <outputs>, GM_ADDR tiling)" …`
> `(found: SyncVtoS, …, RowMode)`

这直接省掉一轮链接失败。

**卡点**：只能整体四层（改一行 kernel 重发 35 KB）；偶发被派发到 `write` 的 schema
（报 `file_path/content` 缺失）（CAN-008）；写进去的三层其实不会被编译（CAN-009）。

## 3. `write_package_file(golden.h)`　✅

**设计意图**：唯一由模型拥有的精度参考；占位符必须显式移除才可能通过。

**本轮实际**：语义干净。`CANNESS_GOLDEN_WITH_CONTEXT` 这个开关是我这次的关键支点
（golden 需要 shape + 原始 int32 缓冲），文档里写明了、也确实生效；
placeholder 检测让人不可能"忘写 golden 还蒙过"。

**卡点**：只有一处 —— 逐元素调用约定对扫描类算子不友好（CAN-012，属契约非本工具）。

## 4. `build_test_package`（渲染构建契约）　✅ / ⚠️

**设计意图**：把四层 + 模板渲染成一个可上传的包，带指纹与自检。

**本轮实际**：确定性好（同一输入同一 `packageHash`）、`.contract-selfcheck` 让我知道模板
本身能编、`manifest.json` 的 `layers/provenance/contract` 一目了然；`golden.h` 覆盖逻辑
（operator 目录优先）正确。

**卡点**：源码缺失时抛裸 Node `ENOENT`（CAN-003）；自检 kernel 用 index 读 attrs，
等于示范了不安全写法（CAN-010）。

## 5. `preflight_evaluation`（本地 + 远端预检）　⚠️

**设计意图**：不消耗预算地确认"包完整 + 目标机可用"。

**本轮实际**：本地检查干净；`remote:true` 正确报出
`ssh: connected` / `cann.ready: true` / `setEnv` / `compiler` / `msprof` 路径，
省掉"先跑一次看连不连得上"。

**卡点**：**不编译**（CAN-005）；探测到的 toolchain 与最终报告里的
`"CANN (version unknown)"` 不一致（CAN-006）。

## 6. `run_evaluation`（上传 → 编译 → 精度 → msprof）　✅

**设计意图**：一次调用拿到编译日志、精度结论、性能数字与分析。

**本轮实际**：整套里最扎实的一环。6 次调用零传输失败，单轮 13–33 s；
`compile.log` 的 `static_assert` 精确到目标端头文件与行号；精度侧给出
`maxRelativeError / badCount / nonfiniteMismatches / golden:"custom"`；
性能侧给出 msprof 的 `Task Duration`（含 warmup 排除）与
`aic_scalar_ratio 0.87 / aic_mte2_ratio 0.003` —— 后面"发射瓶颈而非 DMA"的判断完全建立在这两个比例上。

**卡点**：
- 报告字段有 `null`/`0`/`unknown`（CAN-006）与采样口径漂移（CAN-007）；
- 与策略耦合后，`negativeStreak` 会让它直接拒绝执行（CAN-004）。

## 7. 迭代策略（steer / 停机）　❌

**设计意图**：没有改善就提示、太差就停，避免无脑调参。

**本轮实际**：提示文案是准的（"距离目标超过一倍时，小步调参通常无效：优先考虑换算法或换数据切分"，
事后看完全正确，我确实靠换算法从 1243 µs 到 789 µs）。但**判定信号是错的**：
我三轮同算法消融（1231 → 1277 → 1240）被累计成 `negativeStreak`，第 3 次直接停机，
`force` 也穿不过，只能 `reset`（再触发 CAN-003）。

**结论**：策略的"提示"有价值，"停机"的输入信号不可信（既没有用包指纹区分"是否真的换了实现"，
也没有把采样口径变化排除掉）→ CAN-004 + CAN-007。

## 8. `fetch_remote_file`（诊断回传）　⚠️

**本轮实际**：一次也没在关键路径上用到 —— 因为想取的东西都不在白名单里
（工具链头文件、上一代结果、导出 zip）。最终所有远端事实都靠"打包-评测"这条昂贵通道获得。

→ CAN-014（范围）+ CAN-005（只读探测）。

## 9. `export_submission`（CANNBench 交付）　❌

**设计意图**：一键产出可直接构建的官方提交包。

**本轮实际**：
1. 签名变成 `cummin(input, axis, dim, inner, outer)`（内部 tiling 属性泄漏成公开 API，
   且顺序是字母序）；
2. 我手工把 `cann_bench/__init__.py` 换成"从张量现算几何 + 保持 `cummin(input, dim)`"的版本，
   再手动重打 zip → `provenance.json` 的 `fileHashes` 失效；
3. 整个过程**没有一次编译/执行校验**（`run_evaluation` 只跑构建契约包，从不碰导出物）。

**结论**：交付物"看起来可用、实际未验证"，是本次最弱的一环 → CAN-011（+ 根因 CAN-009/CAN-010）。

---

## 横向观察

### A. 工作流假设"四层都重要"，实际只有一层生效
`kernel.cpp` + `golden.h` 决定一切；`host/api/plugin` 从未编译执行。这既浪费作者精力，
也让"几何/签名"这类跨层契约失去落点（CAN-009 是 CAN-010、CAN-011 的上游）。

### B. 缺少"第 0 步"：本地预验证
本轮真正救命的不是远端，而是我在本地 hand-roll 的三件套：
stub 头多 dtype 语法检查、`golden.h` 与 torch 对比（164 万元素）、numpy 逐 op 模拟
（835 万 / 1918 万元素）。它们把**逻辑错误**全部留在了本地，只把**目标端 API 事实**留给远端。
这套东西应该有产品化版本（CAN-015）。

### C. 状态机比能力更脆弱
15 条 issue 里没有一条是"远端跑不起来"。出问题的都是**信息通道**（CAN-005/006/007/014/015）
与**状态机**（CAN-003/004）：即"我该知道的事拿不到、我该能重试的地方被锁死"。

### D. 数字可信，但不可比
同一份报告里同时存在 msprof 时间、墙钟时间、15/20 次采样三种口径（CAN-007），
在"差 13 倍"这种量级下不影响结论，但在"贴着目标"的调参阶段会直接决定过不过。

## 如果只修三条

1. **CAN-001 + CAN-002**：工作区跟随 cwd、权限与声明一致 —— 所有后续文件操作的基础；
2. **CAN-004 + CAN-003**：解除策略死锁、reset 不丢产出 —— 否则一次停机就报废一轮工作；
3. **CAN-005 + CAN-015**：给"事实"和"逻辑"各一条非预算的验证通道 —— 直接决定每轮迭代的成本。

---

# 附录：复核结果（2026-11-18 16:20）

另一会话依据本文件 + `canness-issues/` 提交了修复（`plugin/src` 20 个文件改动、16 个新文件）。
下面把上文 9 个步骤与修复结果对齐——也就是「设计意图里缺的那一环，现在补上了没有」。

| # | 步骤 | 原评级 | 对应 issue | 修复后状态 |
|---|---|---|---|---|
| 0 | `kb_search` | ⚠️ | CAN-005、CAN-006 | 新增 2 条 KB（`ascend910b-int32-bitwise-support`、`ascend910b-select-dtype-support`），且明确标 `evidence: reported` + 「不是对所有 CANN 版本的结论」；KB 校验 18 条通过。**仍不覆盖"这台机器支持什么"的在线查询** → 靠 `compile_only` + `readRoots` 补。 |
| 1 | `submit_spec` | ⚠️ | CAN-003、CAN-010 | 续代可搬运四层 + `golden.h`（`carrySources`，只在源契约兼容时）；返回值新增 `carriedLayers`/`needsLayers`；attrs 顺序改为文档化 + 按名读取。**源码已修，未生效（CAN-016）** |
| 2 | `write_operator` | ⚠️ | CAN-008 | 四层改可选、未提供层与 provenance 保持不变；错误前缀带 `write_operator:`。**派发错 schema 仍属 DSH 侧** |
| 3 | `write_package_file(golden)` | ✅ | CAN-012 | 新增 `CANNESS_GOLDEN_BATCH` 批量回调（每 output 一次），文档写明调用顺序与「勿用跨用例进程缓存」；旧行为保持兼容 |
| 4 | `build_test_package` | ✅/⚠️ | CAN-003、CAN-009、CAN-010 | 缺层报错改成可操作文案；manifest 增 `compiledLayers`/`documentedOnlyLayers`/`attrsDerived`；自检 kernel 改按名读 attr |
| 5 | `preflight_evaluation` | ⚠️ | CAN-005、CAN-006 | `preflight` 与报告共用 `inspect_environment()`，toolchain 不再 `unknown`；**但 preflight 仍不编译**（用 `run_evaluation({compile_only})` 替代） |
| 6 | `run_evaluation` | ✅ | CAN-004、CAN-006、CAN-007 | 固定采样 20 次 + `metricBasis`/`warmupRuns`/`phaseTimingsMs`/`wallTimeMinusKernelUs`/`opStatistic`；`aicoreTimeUs 0→None`；`notCollected` 两级标注。**`blockDim` 仍取 msprof 列** |
| 7 | 迭代策略 | ❌ | CAN-004 | `blockedBy`/`stopReason`/`policyEvidence`；`canForceEvaluation` 每窗口 1 次；重复测量与协议变更另开窗；负向连击只在相邻劣化 >3% 时累加。**这是本轮最实质的修复** |
| 8 | `fetch_remote_file` | ⚠️ | CAN-005、CAN-014 | 允许历史代 + `readRoots`；`readFileWithin` 做 resolve 后包含判定、拒 symlink、限长、回传 sha256；落盘改原子替换；新增 `artifactsPersistent`/`artifactWarning` |
| 9 | `export_submission` | ❌ | CAN-009、CAN-011 | `interface.attrs` 选出公开参数（签名可回到 `cummin(input, dim)`）、`{wrapper, signature}` 注入并进哈希、`validation.status = "unverified"` 如实标注、`dtypes` 只要求输入同 dtype；新增 `validate_submission`（远端建 wheel + 隔离 venv + 可选比对器） |

**结论**：上文的 A/B/C/D 四条横向观察里，B（缺第 0 步）与 C（状态机脆弱）已实质改善，
A（四层只有一层生效）以「documented-only」正式定案，D（数字可比性）已修。
新增的两条 issue（CAN-016 混合契约、CAN-017 共享预算/归属）不是新缺陷类型，而是**复核过程本身**
暴露的两个"看起来已完成、实际没生效"的陷阱——正好是本文反复强调的那类问题：
信息通道与状态机比能力更容易坏。

**仍未闭环**：修复停留在 `plugin/lib` 之外（CAN-016）；`blockDim`/taskType 未回填；
`kernel` 的本地 stub 语法检查仍未产品化（CAN-015 剩余项）；真机复测因配额与预算未能执行（CAN-017）。

