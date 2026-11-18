# CAN-011 导出把内部 tiling 属性暴露成公开签名；无 wrapper 注入；产物从未被编译/执行验证

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | bug + enhancement |
| 优先级 | **P1** |
| 组件 | `canness-generator`（`submission.ts`）/ `templates/cannbench/operator.py` |
| 首次发现 | 2026-11-18，Cummin 导出（gen-21916f68-dYksQm） |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `export`, `cannbench`, `unverified-artifact` |

## 处理情况（2026-11-18 16:20 复核）

**A. 签名**：`spec.interface.attrs` 显式选出并排序公开参数（`spec.ts` 校验其唯一且已声明），未列入的 attr 由生成 wrapper 内联为常量，因此签名可以只写 `cummin(input, dim)`。

**B. wrapper 注入**：`exportSubmission(..., { wrapper, signature })` —— 自定义 wrapper 必须同时给 `signature`；不提供 wrapper 时 `signature` 作为对生成签名的严格断言；wrapper 与签名都进 `provenance.json` 哈希（`publicSignatureHash`），`bindings` 标注「user-provided wrapper」。

**C. 诚实标注**：导出物固定写 `validation: { status: unverified, reason: export does not compile or execute the submission }`；新增 `validate_submission` 工具（本地先校验 provenance 哈希、拒 symlink、拒未哈希文件；远端 `remote/validate_submission.py` 建 wheel + 隔离 venv 安装 + 可选 task 比对器）。

**D. dtype**：`interface.dtypes` 只要求**输入**同 dtype，输出可为 int64 等固定类型 —— 解除了「cummin 的 int64 索引导致无法多 dtype 导出」的限制。

**验证**：`submission.test.ts`（更新）、`submission-validation.test.ts`、`test_submission_validation.py`（新增）。

## 现象

### A. 签名泄漏内部属性

`export_submission({callable:"cummin"})` 返回：

```json
{"signature":"cummin(input, axis, dim, inner, outer)"}
```

而任务接口是 `cann_bench.cummin(Tensor input, int64 dim)`。原因是 `operator.py` 的
`{{PY_PARAMS}}` = 输入名 + **spec.attrs 的全部键**。对"需要从形状推几何"的算子，这等于把
tiling 细节变成公开 API，且顺序还是字母序（CAN-010）。

### B. 没有 wrapper 注入点

`cann_bench/__init__.py` 完全由模板渲染，`op_plugin/plugin.py` 不参与导出。我只能手工把
`__init__.py` 替换成"从张量现算 (outer, axis, inner) + 保持官方签名"的版本，然后手动重打 zip：

```bash
tar.exe -a -cf cannbench.zip <files…>
```

代价：`provenance.json` 的 `fileHashes` 与改后文件**不再匹配** —— 交付物自带一条失效的
溯源记录。

### C. 产物从未被验证

导出后没有"上传 → `build.sh` → 装 wheel → 小例调用 → 与 golden 比对"的环节。
`run_evaluation` 只跑构建契约包（kernel + `main.cpp`），完全没碰过 `csrc/launch.cpp` 与
`cann_bench/__init__.py`。所以导出包**在这台机器上从未编译成功过**，签名错、少一个 `csrc`
文件都不会被发现，直到官方评测。

## 期望

1. `export_submission({wrapper})` 允许提供自定义 `cann_bench/__init__.py`（参与打包与哈希），
   或提供 `signature` 覆盖（把 attrs 从 Python 签名里移除，由 wrapper 内部计算）；
2. `validate_submission()`：上传导出源码到 host → `bash build.sh` → `pip install` wheel →
   跑一个小 case（含 NaN/并列）→ 与 golden 比对 → 返回与 `run_evaluation` 等价的报告；
3. 导出报告里断言"公开签名 == 任务接口"，不一致时拒绝导出或明确告警。

## 影响

- 交付物"看起来可提交、实际没跑过"，这是本次最弱的一环；
- 手工改包破坏了 provenance，削弱了"来源可追溯"这一契约价值；
- 多 dtype 提交不可行：`interface.dtypes` 要求所有张量同 dtype，而 `indices` 固定 int64，
  校验必然失败（本次只能单 dtype 导出，官方多种 dtype 用例覆盖不到）。

## 复现

1. spec 含 `attrs`（如本次四个），`export_submission({callable:"cummin"})`；
2. 读 `cann_bench/__init__.py` → 签名含 `axis/dim/inner/outer`；
3. 与 `plugin.py` 里写的 `cummin(input, dim)` 对比 → 两份互不相干的入口；
4. 尝试在 host 上构建导出包 → 当前无任何工具支持。

## 建议修复

1. 模板增加 `{{PY_ATTRS_INTERNAL}}` 语义：attrs 仍传给 `canness_launch`，但**不进入** Python
   签名；由 wrapper（或生成的代码）从张量推导；
2. `export_submission` 支持 `wrapper` 参数与 `signature` 断言；
3. 落地 `validate_submission`（复用 runner 的 build/install 能力，独立于迭代预算）。

## 验收标准

- 导出的公开签名与任务接口一致（如 `cummin(input, dim)`）；
- 自定义 wrapper 参与打包，`provenance.json` 哈希自洽；
- 存在一条命令能在 host 上完成"构建 + 安装 + 小例比对"；
- 多 dtype 用例可导出（或明确列出限制与替代路径）。

## 关联

CAN-009（几何无通道 → 只能进 attrs）、CAN-010（attrs 顺序）、CAN-005（远端探测能力）
