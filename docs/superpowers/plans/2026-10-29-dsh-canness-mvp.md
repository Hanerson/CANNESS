# dsh-canness MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本仓库 `plugin/` 做出一个可单测的 `dsh-canness` 插件包，让模型提交规格书、写下四层文件、打成测试包，再经 SFTP 只上传并等待远端 `results.json`，失败时按预算 steer 续轮。

**Architecture:** 四个 Cordis 插件（knowledge / generator / eval / loop）共享 `{workspace}/.canness/state.json`，不另做 Cordis Service。评测传输是 `RemoteFiles` 接口：单测用内存实现，真机用 `ssh2` SFTP。本地不编译、不调用云 API。迭代策略是纯函数；`agent/turn-stopping` 只在策略要求续轮时 `steer`。

**Tech Stack:** TypeScript ESM、Node >= 24.9.0、Vitest、`ssh2`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`。dsh 版本窗 `>=0.2.0 <0.3.0`，对照克隆为 `d:/SE_Tools/deepseek_harness/deepseek-harness` 的 `0.2.1-rc.3`。

## Global Constraints

- 插件代码只写 TypeScript ESM。Python 只允许出现在 `plugin/remote/watch.py`（远端约定脚本）和知识库正文里。
- 包名 `dsh-canness`。`engines.node` 为 `>=24.9.0`。`engines.dsh` 为 `>=0.2.0 <0.3.0`。
- 不依赖模力方舟、华为云 REST、CANN Lab、paramiko、`@deepseek-ai/dsh-ssh`。
- 测试环节本地只做两步：SFTP 上传测试包目录，然后轮询结果文件。不在本地或通过 SSH 执行 cmake / kernel_eval。
- 规格书字段沿用 02 文档 §3.1，键名保持 snake_case。
- 四层路径固定为 `op_kernel/kernel.cpp`、`op_host/host.cpp`、`op_api/api.cpp`、`op_plugin/plugin.py`。
- 状态文件路径固定为 `{workspace}/.canness/state.json`。
- 默认预算：`maxIterations=10`，`maxCompileRetries=3`，`negativeStreakLimit=3`，`convergenceThreshold=0.05`，`timeoutSec=1800`，`pollIntervalMs=2000`。
- 编译失败和传输超时不增加 `validIterations`。超时累计到 2 次即停。
- 每个插件导出 Schemastery `Config`：`z.object`，字段 `.required()`，不用 `.default()`。预算四字段在 `canness-eval` 和 `canness-loop` 各写一份，两处数字必须相同。
- 知识库检索返回正文上限 8000 字符。
- 性能分析是独立模块 `analysis.ts`。插件只解析下面的规范化 JSON，不读 msprof 的 CSV。mock 和将来的真实采集器都产出这一结构。`policy` 不引用 CSV 列名。
- 本计划不实现 Dashboard、向量库、tiling 搜索、算子融合、容器沙箱，也不生成真实可编译的 AscendC。
- 每个任务末尾的提交只包含该任务的文件。不要把 `.idea/`、`.venv/`、`docs/past/` 里无关的暂存内容加进去。

不拆成四个计划：单独一个插件交付不了「上传并等到结果」这条验收。每个任务自己仍可测试。

---

## 还缺什么

写代码和单测不缺材料。下面两项只挡住最后的手工验收，不挡住 Task 1–11：

- 一台能 SSH 的 Linux 主机，以及本机 OpenSSH 私钥。没有 CANN 时跑 `watch.py`，它直接写评测结果和 msprof 形状的性能分析。
- 已安装的 `dsh` CLI，和一个配好模型密钥的 profile。插件不读密钥。

## 文件地图

| 文件 | 职责 |
|---|---|
| `plugin/package.json` | 包名、exports、`dsh.bundle`、引擎范围 |
| `plugin/tsconfig.json` | `NodeNext`，出 `lib/` |
| `plugin/vitest.config.ts` | 只跑 `plugin/tests` |
| `plugin/cordis.patch.yml` | 四行插件及默认配置 |
| `plugin/src/spec.ts` | 规格书解析 |
| `plugin/src/report.ts` | 结果 JSON 解析；本地合成的 timeout / malformed |
| `plugin/src/analysis.ts` | 性能分析的类型和解析。不认识传输，也不认识停机策略 |
| `plugin/src/policy.ts` | 计数、停机、续轮、增强文本。只读取 `analysis.summary` |
| `plugin/src/state-file.ts` | 读写状态文件 |
| `plugin/src/remote.ts` | `RemoteFiles`、内存实现、轮询 |
| `plugin/src/ssh2-transport.ts` | SFTP 实现 |
| `plugin/src/package-files.ts` | 写四层文件、组装测试包 |
| `plugin/src/knowledge.ts` | 检索纯函数 + `kb_search` 插件 |
| `plugin/src/generator.ts` | `submit_spec` / `write_operator` / `build_test_package` |
| `plugin/src/eval.ts` | `run_evaluation` |
| `plugin/src/loop.ts` | `agent/pre-step` 与 `agent/turn-stopping` |
| `plugin/knowledge_base/Add.md` | 一条检索夹具 |
| `plugin/remote/watch.py` | 远端 mock：看到 manifest 就写评测结果和 msprof 形状的性能分析。不调用 msprof |
| `plugin/tests/*.test.ts` | 与上面源文件一一对应 |

## 细节约定

### 规格书

`parseSpec` 接受未知 JSON。缺任一必填字段就 `throw new Error('missing <dotted.path>')`，消息里只报第一个缺的字段。必填：

- `operator_name`、`operator_type`：非空字符串
- `input_specs`、`output_specs`：非空数组；每项必填 `name`、`shape`（字符串数组）、`dtype`
- `target_platform.chip`：非空字符串
- `performance_target.metric`：只能是 `kernel_time`
- `performance_target.target_us`：有限正数
- `tiling_hints`：缺省写成 `null`；若给出则必须是字符串

可选且原样保留：`constraints`、`soc_version`、`cann_version`、`performance_target.reference`。

缺字段只报第一个。检查顺序：`performance_target.metric`、`performance_target.target_us`、`operator_name`、`operator_type`、`input_specs`、`output_specs`、`target_platform.chip`，最后才是给出了但不是字符串的 `tiling_hints`。

### 结果文件

远端路径：`{outbox}/{generationId}/results.json`。上传目录：`{inbox}/{generationId}/`。

```json
{
  "generationId": "gen-0123abcd",
  "status": "pass",
  "compile": { "ok": true, "log": "" },
  "correctness": { "ok": true, "maxRelativeError": 0 },
  "performance": { "kernelTimeUs": 150, "targetUs": 150 },
  "analysis": {
    "source": "msprof-mock",
    "bottleneck": "memory",
    "summary": "Task Duration 150us；aic_mte2_ratio 0.71，内存搬运为主，cube_utilization 18.4%。",
    "op": {
      "opName": "Add",
      "opType": "Add",
      "taskType": "AI_CORE",
      "taskDurationUs": 150,
      "taskWaitTimeUs": 2,
      "blockDim": 8,
      "aicoreTimeUs": 140,
      "aicMacRatio": 0.12,
      "aicMte2Ratio": 0.71,
      "aicScalarRatio": 0.09,
      "cubeUtilizationPct": 18.4
    }
  },
  "summary": "mock pass"
}
```

`status` 只允许 `pass`、`compile_fail`、`accuracy_fail`、`perf_fail`、`timeout`、`error`。其它值或非法 JSON：本地改写成 `status: "error"`，`summary` 为 `malformed result: <原因>`，不抛到工具外。轮询超时：本地合成 `status: "timeout"`，不要求远端写这个状态。

`analysis` 可以缺省，缺省解析为 `null`。给出了但 `source` 不是 `msprof-mock` 或 `msprof`、或 `bottleneck` 不在 `cube | memory | scalar | unknown` 中，也解析为 `null`，不把整份报告改成 error。`performance.kernelTimeUs` 对应官方列 `Task Duration(us)`。比率对应 `aic_mac_ratio`、`aic_mte2_ratio`、`aic_scalar_ratio`；`cubeUtilizationPct` 对应 `cube_utilization(%)`。这些列是否出现取决于 CANN 版本和 `--aic-metrics`，所以规范化字段允许为 `null`。前几版远端不跑 msprof，由 mock 填同一结构；以后换真实采集器时，插件解析和停机策略不动。

`bottleneck` 由远端填写：三个比率里最大的一项，`aic_mac_ratio` → `cube`，`aic_mte2_ratio` → `memory`，`aic_scalar_ratio` → `scalar`，都没有则 `unknown`。插件不重算。

### 迭代

`generationId` 在 `submit_spec` 成功时生成，格式 `gen-` 加 `randomUUID()` 去掉横线后的前 8 位。一次新规格书清空计数和上一份报告。

| 结果 | `validIterations` | 其它 |
|---|---|---|
| `compile_fail` | 不变 | `compileRetries += 1` |
| `timeout` | 不变 | `timeouts += 1` |
| `pass` | `+1` | `negativeStreak = 0`；若有 `kernelTimeUs`，刷新 `bestKernelTimeUs` 与 `previousPassKernelTimeUs` |
| `accuracy_fail` / `perf_fail` / `error` | `+1` | 有 `kernelTimeUs` 且严格小于 `best`：更新 best 并清零 streak；否则 `negativeStreak += 1`。没有时间数据：streak `+1` |

`stopReason` 按这个顺序返回第一个命中，否则 `null`：

1. `timeouts >= 2` → `timeouts`
2. `compileRetries >= maxCompileRetries` → `compileRetries`
3. `validIterations >= maxIterations` → `maxIterations`
4. `negativeStreak >= negativeStreakLimit` → `negativeStreak`
5. 最近两次 `pass` 的 `kernelTimeUs` 都有值，且 `abs(a-b)/max(a,1) < convergenceThreshold` → `converged`
6. 最近一次是 `pass`，且 `kernelTimeUs <= targetUs` → `targetMet`

`shouldSteer`：已有 `lastReport`，其 `status !== 'pass'`，且 `stopReason` 为 `null`。命中则 `turn-stopping` steer 一次增强文本；否则不调用 `steer`，回合结束。不监听 `tools/result`。分类在 `runEvaluation` 调用 `applyReport` 时完成。`agent/pre-step` 仅当这段增强文本还不在本步 messages 里时才追加，避免和刚才的 steer 重复。

`run_evaluation` 在 `stopReason` 已非空时不上传，返回 `status: "error"`、`summary` 为 `stopped: <reason>`，且不改计数。

### 传输

```ts
export interface RemoteFiles {
  uploadDir(localDir: string, remoteDir: string): Promise<void>
  readFile(remotePath: string): Promise<Uint8Array | null>
}
```

`readFile` 在文件不存在时返回 `null`，不抛 ENOENT。`waitForRemoteFile` 先读一次，没有则每 `intervalMs` 再读，超过 `timeoutMs` 抛 `Error('timeout')`。测试注入 `now` 和 `sleep`，不真的等待。

SFTP 用私钥，不用密码。`host` 为空时 `run_evaluation` 返回 `status: "error"`、`summary: "ssh host is empty"`，不连接。

### 状态文件

```ts
export interface TaskState {
  generationId: string | null
  spec: OperatorSpec | null
  validIterations: number
  compileRetries: number
  timeouts: number
  negativeStreak: number
  bestKernelTimeUs: number | null
  previousPassKernelTimeUs: number | null
  lastPassKernelTimeUs: number | null
  lastReport: EvalReport | null
}
```

文件不存在时 `loadState` 返回全空状态，不抛错。

---

### Task 1: 插件包脚手架

**Files:**
- Create: `plugin/package.json`
- Create: `plugin/tsconfig.json`
- Create: `plugin/vitest.config.ts`
- Create: `plugin/tests/scaffold.test.ts`
- Test: `plugin/tests/scaffold.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 可 `pnpm test` 的空包；后续任务往 `plugin/src` 加文件

- [ ] **Step 1: 写失败测试**

`plugin/tests/scaffold.test.ts`：

```ts
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('package declares the dsh bundle and four entries', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.name).toBe('dsh-canness')
  expect(pkg.type).toBe('module')
  expect(pkg.engines.node).toBe('>=24.9.0')
  expect(pkg.engines.dsh).toBe('>=0.2.0 <0.3.0')
  expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.exports['./knowledge']).toBe('./lib/knowledge.js')
  expect(pkg.exports['./generator']).toBe('./lib/generator.js')
  expect(pkg.exports['./eval']).toBe('./lib/eval.js')
  expect(pkg.exports['./loop']).toBe('./lib/loop.js')
})
```

- [ ] **Step 2: 跑测试，确认失败**

在 `plugin/` 下还没有 `package.json` 时，先在仓库根执行：

```bash
cd plugin && pnpm add -D vitest typescript @types/node && pnpm exec vitest run tests/scaffold.test.ts
```

Expected: FAIL，`package.json` 不存在或 `name` 不是 `dsh-canness`。若 `pnpm add -D` 因没有 `package.json` 失败，先写 Step 3 的 `package.json` 再装 Vitest，然后重跑，此时测试应 PASS。不要为了制造失败去删掉已经写对的 manifest。

- [ ] **Step 3: 写脚手架**

`plugin/package.json`：

```json
{
  "name": "dsh-canness",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24.9.0", "dsh": ">=0.2.0 <0.3.0" },
  "exports": {
    "./knowledge": "./lib/knowledge.js",
    "./generator": "./lib/generator.js",
    "./eval": "./lib/eval.js",
    "./loop": "./lib/loop.js"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "dependencies": {},
  "peerDependencies": {
    "@deepseek-ai/cordis": "0.2.1-rc.3",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.3",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.3",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "0.2.1-rc.3"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "0.2.1-rc.3",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.3",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.3",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/schemastery": "0.2.1-rc.3"
  }
}
```

peer 与 dev 同时声明，这是 dsh 对链接插件的要求。安装：

```bash
cd plugin
npm view @deepseek-ai/dsh-tools@0.2.1-rc.3 version
pnpm add -D typescript @types/node vitest
pnpm add -D @deepseek-ai/cordis@0.2.1-rc.3 @deepseek-ai/dsh-agent@0.2.1-rc.3 @deepseek-ai/dsh-llm@0.2.1-rc.3 @deepseek-ai/dsh-tools@0.2.1-rc.3 @deepseek-ai/schemastery@0.2.1-rc.3
```

`npm view` 的期望输出是 `0.2.1-rc.3`。若是 `404`，改用本地克隆：

```bash
pnpm add -D \
  @deepseek-ai/cordis@file:D:/SE_Tools/deepseek_harness/deepseek-harness/vendor/cordis \
  @deepseek-ai/schemastery@file:D:/SE_Tools/deepseek_harness/deepseek-harness/vendor/schemastery \
  @deepseek-ai/dsh-tools@file:D:/SE_Tools/deepseek_harness/deepseek-harness/packages/core/tools \
  @deepseek-ai/dsh-agent@file:D:/SE_Tools/deepseek_harness/deepseek-harness/packages/core/agent \
  @deepseek-ai/dsh-llm@file:D:/SE_Tools/deepseek_harness/deepseek-harness/packages/llm/llm
```

`plugin/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "lib",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

`plugin/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
```

- [ ] **Step 4: 再跑测试**

```bash
cd plugin && pnpm exec vitest run tests/scaffold.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/package.json plugin/pnpm-lock.yaml plugin/tsconfig.json plugin/vitest.config.ts plugin/tests/scaffold.test.ts
git commit -m "build: scaffold dsh-canness package"
```

### Task 2: 规格书解析

**Files:**
- Create: `plugin/src/spec.ts`
- Create: `plugin/tests/spec.test.ts`
- Test: `plugin/tests/spec.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseSpec(raw: unknown): OperatorSpec`，失败消息 `missing <path>`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from 'vitest'
import { parseSpec } from '../src/spec.ts'

const valid = {
  operator_name: 'Conv2D',
  operator_type: 'conv',
  input_specs: [{ name: 'input', shape: ['N', 'C', 'H', 'W'], dtype: 'float16' }],
  output_specs: [{ name: 'output', shape: ['N', 'C_out', 'H_out', 'W_out'], dtype: 'float16' }],
  target_platform: { chip: 'Ascend910B' },
  performance_target: { metric: 'kernel_time', target_us: 150 },
}

test('parses the 02 spec and defaults tiling_hints to null', () => {
  expect(parseSpec(valid).tiling_hints).toBeNull()
  expect(parseSpec(valid).performance_target.target_us).toBe(150)
})

test('reports the first missing field', () => {
  expect(() => parseSpec({ ...valid, operator_name: '' })).toThrow('missing operator_name')
  const { target_platform: _drop, ...rest } = valid
  expect(() => parseSpec(rest)).toThrow('missing target_platform.chip')
})

test('rejects a non-positive target', () => {
  expect(() => parseSpec({
    ...valid,
    performance_target: { metric: 'kernel_time', target_us: 0 },
  })).toThrow('missing performance_target.target_us')
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/spec.test.ts
```

Expected: FAIL，找不到 `../src/spec.ts`

- [ ] **Step 3: 实现 parseSpec**

`plugin/src/spec.ts`：

```ts
export interface TensorSpec {
  name: string
  shape: string[]
  dtype: string
  constraints?: Record<string, number | number[]>
}

export interface OperatorSpec {
  operator_name: string
  operator_type: string
  input_specs: TensorSpec[]
  output_specs: TensorSpec[]
  target_platform: { chip: string; soc_version?: string; cann_version?: string }
  performance_target: { metric: 'kernel_time'; target_us: number; reference?: string }
  tiling_hints: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function needString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing ${path}`)
  return value
}

function needTensor(value: unknown, path: string): TensorSpec {
  if (!isRecord(value)) throw new Error(`missing ${path}`)
  const shape = value.shape
  if (!Array.isArray(shape) || shape.some(item => typeof item !== 'string')) {
    throw new Error(`missing ${path}.shape`)
  }
  const tensor: TensorSpec = {
    name: needString(value.name, `${path}.name`),
    shape,
    dtype: needString(value.dtype, `${path}.dtype`),
  }
  if (value.constraints !== undefined) {
    if (!isRecord(value.constraints)) throw new Error(`missing ${path}.constraints`)
    tensor.constraints = value.constraints as TensorSpec['constraints']
  }
  return tensor
}

function needTensors(value: unknown, path: string): TensorSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`missing ${path}`)
  return value.map((item, index) => needTensor(item, `${path}.${index}`))
}

export function parseSpec(raw: unknown): OperatorSpec {
  if (!isRecord(raw)) throw new Error('missing operator_name')
  const platform = isRecord(raw.target_platform) ? raw.target_platform : {}
  const perf = isRecord(raw.performance_target) ? raw.performance_target : {}
  if (perf.metric !== 'kernel_time') throw new Error('missing performance_target.metric')
  if (typeof perf.target_us !== 'number' || !Number.isFinite(perf.target_us) || perf.target_us <= 0) {
    throw new Error('missing performance_target.target_us')
  }
  const spec: OperatorSpec = {
    operator_name: needString(raw.operator_name, 'operator_name'),
    operator_type: needString(raw.operator_type, 'operator_type'),
    input_specs: needTensors(raw.input_specs, 'input_specs'),
    output_specs: needTensors(raw.output_specs, 'output_specs'),
    target_platform: { chip: needString(platform.chip, 'target_platform.chip') },
    performance_target: { metric: 'kernel_time', target_us: perf.target_us },
    tiling_hints: raw.tiling_hints == null ? null : needString(raw.tiling_hints, 'tiling_hints'),
  }
  if (typeof platform.soc_version === 'string') spec.target_platform.soc_version = platform.soc_version
  if (typeof platform.cann_version === 'string') spec.target_platform.cann_version = platform.cann_version
  if (typeof perf.reference === 'string') spec.performance_target.reference = perf.reference
  return spec
}
```

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/spec.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/src/spec.ts plugin/tests/spec.test.ts
git commit -m "feat: parse operator spec json"
```

### Task 3: 结果解析与迭代策略

**Files:**
- Create: `plugin/src/analysis.ts`
- Create: `plugin/src/report.ts`
- Create: `plugin/src/policy.ts`
- Create: `plugin/tests/policy.test.ts`
- Test: `plugin/tests/policy.test.ts`

**Interfaces:**
- Consumes: 无（报告类型不引用 `OperatorSpec`）
- Produces: `parseAnalysis`、`parseReport`、`timeoutReport`、`malformedReport`、`emptyState`、`applyReport`、`stopReason`、`shouldSteer`、`enhancementBlock`、`TaskState`、`PolicyConfig`、`EvalReport`、`PerformanceAnalysis`

- [ ] **Step 1: 写失败测试**

`plugin/tests/policy.test.ts`：

```ts
import { expect, test } from 'vitest'
import { malformedReport, parseReport, timeoutReport, type EvalReport } from '../src/report.ts'
import { applyReport, emptyState, enhancementBlock, shouldSteer, stopReason, type PolicyConfig } from '../src/policy.ts'

const config: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
}

function report(over: Partial<EvalReport>): EvalReport {
  return {
    generationId: 'gen-0123abcd',
    status: 'pass',
    compile: { ok: true, log: '' },
    correctness: { ok: true, maxRelativeError: 0 },
    performance: { kernelTimeUs: 100, targetUs: 150 },
    analysis: null,
    summary: 'ok',
    ...over,
  }
}

test('compile failure does not spend a valid iteration', () => {
  const next = applyReport(emptyState(), report({ status: 'compile_fail', summary: 'cmake' }))
  expect(next.validIterations).toBe(0)
  expect(next.compileRetries).toBe(1)
  expect(shouldSteer(next, config)).toBe(true)
})

test('third compile failure stops without steering', () => {
  let state = emptyState()
  for (let i = 0; i < 3; i++) state = applyReport(state, report({ status: 'compile_fail' }))
  expect(stopReason(state, config)).toBe('compileRetries')
  expect(shouldSteer(state, config)).toBe(false)
})

test('two timeouts stop', () => {
  let state = applyReport(emptyState(), timeoutReport('gen-0123abcd', 1800))
  expect(state.validIterations).toBe(0)
  state = applyReport(state, timeoutReport('gen-0123abcd', 1800))
  expect(stopReason(state, config)).toBe('timeouts')
})

test('a passing kernel at or under target stops as targetMet', () => {
  const state = applyReport(emptyState(), report({ status: 'pass' }))
  expect(state.validIterations).toBe(1)
  expect(stopReason(state, config)).toBe('targetMet')
  expect(shouldSteer(state, config)).toBe(false)
})

test('two close passes converge', () => {
  const first = applyReport(emptyState(), report({
    status: 'pass',
    performance: { kernelTimeUs: 200, targetUs: 150 },
  }))
  expect(stopReason(first, config)).toBeNull()
  const second = applyReport(first, report({
    status: 'pass',
    performance: { kernelTimeUs: 198, targetUs: 150 },
  }))
  expect(stopReason(second, config)).toBe('converged')
})

test('worse kernel times build a negative streak', () => {
  let state = emptyState()
  for (const us of [100, 110, 120]) {
    state = applyReport(state, report({
      status: 'perf_fail',
      performance: { kernelTimeUs: us, targetUs: 150 },
    }))
  }
  expect(state.negativeStreak).toBe(2)
  expect(state.bestKernelTimeUs).toBe(100)
})

test('malformed remote json becomes an error report', () => {
  const parsed = parseReport({ status: 'shipped' })
  expect(parsed.status).toBe('error')
  expect(malformedReport('gen-1', 'no').status).toBe('error')
})

test('keeps an msprof-shaped analysis and drops a bad one', () => {
  const parsed = parseReport({
    generationId: 'gen-1',
    status: 'pass',
    analysis: {
      source: 'msprof-mock',
      bottleneck: 'memory',
      summary: 'aic_mte2_ratio 0.71',
      op: {
        opName: 'Add',
        opType: 'Add',
        taskType: 'AI_CORE',
        taskDurationUs: 150,
        taskWaitTimeUs: 2,
        blockDim: 8,
        aicoreTimeUs: 140,
        aicMacRatio: 0.12,
        aicMte2Ratio: 0.71,
        aicScalarRatio: 0.09,
        cubeUtilizationPct: 18.4,
      },
    },
  })
  expect(parsed.analysis?.bottleneck).toBe('memory')
  expect(parsed.analysis?.op?.aicMte2Ratio).toBe(0.71)
  expect(parseReport({ status: 'pass', analysis: { source: 'nope' } }).analysis).toBeNull()
})

test('enhancement names the status and does not steer before any report', () => {
  expect(shouldSteer(emptyState(), config)).toBe(false)
  const state = applyReport(emptyState(), report({ status: 'accuracy_fail', summary: 'err 0.2' }))
  expect(enhancementBlock(state)).toContain('accuracy_fail')
  expect(enhancementBlock(state)).toContain('err 0.2')
  expect(enhancementBlock(state)).toContain('性能分析：无')
  const analyzed = applyReport(emptyState(), report({
    status: 'perf_fail',
    analysis: {
      source: 'msprof-mock',
      bottleneck: 'memory',
      summary: 'aic_mte2_ratio 0.71',
      op: null,
    },
  }))
  expect(enhancementBlock(analyzed)).toContain('aic_mte2_ratio 0.71')
  expect(enhancementBlock(analyzed)).not.toContain('Task Duration')
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/policy.test.ts
```

Expected: FAIL，找不到模块

- [ ] **Step 3: 实现 analysis.ts、report.ts 与 policy.ts**

`plugin/src/analysis.ts`：

```ts
export interface MsprofOp {
  opName: string
  opType: string
  taskType: string
  taskDurationUs: number
  taskWaitTimeUs: number | null
  blockDim: number | null
  aicoreTimeUs: number | null
  aicMacRatio: number | null
  aicMte2Ratio: number | null
  aicScalarRatio: number | null
  cubeUtilizationPct: number | null
}

export interface PerformanceAnalysis {
  source: 'msprof-mock' | 'msprof'
  bottleneck: 'cube' | 'memory' | 'scalar' | 'unknown'
  summary: string
  op: MsprofOp | null
}

const SOURCES = ['msprof-mock', 'msprof'] as const
const BOTTLENECKS = ['cube', 'memory', 'scalar', 'unknown'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseOp(raw: unknown): MsprofOp | null {
  if (!isRecord(raw)) return null
  const taskDurationUs = numOrNull(raw.taskDurationUs)
  if (taskDurationUs == null) return null
  return {
    opName: text(raw.opName),
    opType: text(raw.opType),
    taskType: text(raw.taskType),
    taskDurationUs,
    taskWaitTimeUs: numOrNull(raw.taskWaitTimeUs),
    blockDim: numOrNull(raw.blockDim),
    aicoreTimeUs: numOrNull(raw.aicoreTimeUs),
    aicMacRatio: numOrNull(raw.aicMacRatio),
    aicMte2Ratio: numOrNull(raw.aicMte2Ratio),
    aicScalarRatio: numOrNull(raw.aicScalarRatio),
    cubeUtilizationPct: numOrNull(raw.cubeUtilizationPct),
  }
}

export function parseAnalysis(raw: unknown): PerformanceAnalysis | null {
  if (!isRecord(raw)) return null
  if (typeof raw.source !== 'string' || !(SOURCES as readonly string[]).includes(raw.source)) return null
  if (typeof raw.bottleneck !== 'string' || !(BOTTLENECKS as readonly string[]).includes(raw.bottleneck)) return null
  return {
    source: raw.source as PerformanceAnalysis['source'],
    bottleneck: raw.bottleneck as PerformanceAnalysis['bottleneck'],
    summary: text(raw.summary),
    op: parseOp(raw.op),
  }
}
```

`plugin/src/report.ts`：

```ts
import { parseAnalysis, type PerformanceAnalysis } from './analysis.ts'

export type ResultStatus = 'pass' | 'compile_fail' | 'accuracy_fail' | 'perf_fail' | 'timeout' | 'error'

export interface EvalReport {
  generationId: string
  status: ResultStatus
  compile: { ok: boolean; log: string }
  correctness: { ok: boolean; maxRelativeError: number | null }
  performance: { kernelTimeUs: number | null; targetUs: number | null }
  analysis: PerformanceAnalysis | null
  summary: string
}

const STATUSES: readonly ResultStatus[] = ['pass', 'compile_fail', 'accuracy_fail', 'perf_fail', 'timeout', 'error']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function malformedReport(generationId: string, detail: string): EvalReport {
  return {
    generationId,
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `malformed result: ${detail}`,
  }
}

export function timeoutReport(generationId: string, timeoutSec: number): EvalReport {
  return {
    generationId,
    status: 'timeout',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `timed out after ${timeoutSec}s`,
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseReport(raw: unknown): EvalReport {
  if (!isRecord(raw)) return malformedReport('unknown', 'not an object')
  const generationId = typeof raw.generationId === 'string' ? raw.generationId : 'unknown'
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as ResultStatus)) {
    return malformedReport(generationId, 'bad status')
  }
  const compile = isRecord(raw.compile) ? raw.compile : {}
  const correctness = isRecord(raw.correctness) ? raw.correctness : {}
  const performance = isRecord(raw.performance) ? raw.performance : {}
  return {
    generationId,
    status: raw.status as ResultStatus,
    compile: { ok: compile.ok === true, log: typeof compile.log === 'string' ? compile.log : '' },
    correctness: { ok: correctness.ok === true, maxRelativeError: numOrNull(correctness.maxRelativeError) },
    performance: { kernelTimeUs: numOrNull(performance.kernelTimeUs), targetUs: numOrNull(performance.targetUs) },
    analysis: parseAnalysis(raw.analysis),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
  }
}
```

`plugin/src/policy.ts`：

```ts
import type { EvalReport } from './report.ts'

export interface PolicyConfig {
  maxIterations: number
  maxCompileRetries: number
  negativeStreakLimit: number
  convergenceThreshold: number
}

export interface TaskState {
  generationId: string | null
  spec: null
  validIterations: number
  compileRetries: number
  timeouts: number
  negativeStreak: number
  bestKernelTimeUs: number | null
  previousPassKernelTimeUs: number | null
  lastPassKernelTimeUs: number | null
  lastReport: EvalReport | null
}

export type StopReason = 'timeouts' | 'compileRetries' | 'maxIterations' | 'negativeStreak' | 'converged' | 'targetMet'

export function emptyState(): TaskState {
  return {
    generationId: null,
    spec: null,
    validIterations: 0,
    compileRetries: 0,
    timeouts: 0,
    negativeStreak: 0,
    bestKernelTimeUs: null,
    previousPassKernelTimeUs: null,
    lastPassKernelTimeUs: null,
    lastReport: null,
  }
}

export function applyReport(state: TaskState, report: EvalReport): TaskState {
  const next: TaskState = { ...state, lastReport: report }
  if (report.status === 'compile_fail') {
    next.compileRetries += 1
    return next
  }
  if (report.status === 'timeout') {
    next.timeouts += 1
    return next
  }
  next.validIterations += 1
  const us = report.performance.kernelTimeUs
  if (report.status === 'pass') {
    next.negativeStreak = 0
    if (us != null) {
      next.previousPassKernelTimeUs = next.lastPassKernelTimeUs
      next.lastPassKernelTimeUs = us
      if (next.bestKernelTimeUs == null || us < next.bestKernelTimeUs) next.bestKernelTimeUs = us
    }
    return next
  }
  if (us != null && (next.bestKernelTimeUs == null || us < next.bestKernelTimeUs)) {
    next.bestKernelTimeUs = us
    next.negativeStreak = 0
  } else {
    next.negativeStreak += 1
  }
  return next
}

export function stopReason(state: TaskState, config: PolicyConfig): StopReason | null {
  if (state.timeouts >= 2) return 'timeouts'
  if (state.compileRetries >= config.maxCompileRetries) return 'compileRetries'
  if (state.validIterations >= config.maxIterations) return 'maxIterations'
  if (state.negativeStreak >= config.negativeStreakLimit) return 'negativeStreak'
  const prev = state.previousPassKernelTimeUs
  const last = state.lastPassKernelTimeUs
  if (prev != null && last != null && Math.abs(prev - last) / Math.max(prev, 1) < config.convergenceThreshold) {
    return 'converged'
  }
  const report = state.lastReport
  if (
    report?.status === 'pass'
    && report.performance.kernelTimeUs != null
    && report.performance.targetUs != null
    && report.performance.kernelTimeUs <= report.performance.targetUs
  ) return 'targetMet'
  return null
}

export function shouldSteer(state: TaskState, config: PolicyConfig): boolean {
  return state.lastReport != null && state.lastReport.status !== 'pass' && stopReason(state, config) === null
}

export function enhancementBlock(state: TaskState): string {
  const report = state.lastReport
  if (report == null) return ''
  return [
    `上次评测 ${report.status}（${report.generationId}）。`,
    `摘要：${report.summary}`,
    `编译日志：${report.compile.log.slice(0, 2000)}`,
    `maxRelativeError：${String(report.correctness.maxRelativeError)}`,
    `kernel_time_us：${String(report.performance.kernelTimeUs)}，目标 ${String(report.performance.targetUs)}`,
    `性能分析：${report.analysis?.summary ?? '无'}`,
    `有效迭代 ${state.validIterations}，编译重试 ${state.compileRetries}，超时 ${state.timeouts}，变差连续 ${state.negativeStreak}。`,
    '请修改四层代码后再次调用 build_test_package 和 run_evaluation。',
  ].join('\n')
}
```

`TaskState.spec` 在本任务固定为 `null`。Task 8 会把它改成 `OperatorSpec | null` 并在 `emptyState` 里保持 `null`。本任务的测试不读 `spec`。

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/policy.test.ts
```

Expected: PASS。`negativeStreak` 为 2：100 是 best 且清零，110 和 120 各加一。

- [ ] **Step 5: 提交**

```bash
git add plugin/src/report.ts plugin/src/policy.ts plugin/tests/policy.test.ts
git commit -m "feat: add eval report parsing and iteration policy"
```

### Task 4: 内存远端与轮询

**Files:**
- Create: `plugin/src/remote.ts`
- Create: `plugin/tests/remote.test.ts`
- Test: `plugin/tests/remote.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `RemoteFiles`、`MemoryRemote`、`waitForRemoteFile(files, remotePath, opts)`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { MemoryRemote, waitForRemoteFile } from '../src/remote.ts'

test('uploadDir then readFile round-trips bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-'))
  writeFileSync(join(dir, 'manifest.json'), '{"a":1}')
  const remote = new MemoryRemote()
  await remote.uploadDir(dir, '/inbox/gen-1')
  const body = await remote.readFile('/inbox/gen-1/manifest.json')
  expect(JSON.parse(Buffer.from(body!).toString())).toEqual({ a: 1 })
  expect(await remote.readFile('/inbox/gen-1/missing.json')).toBeNull()
})

test('waitForRemoteFile returns bytes that appear on a later read', async () => {
  const remote = new MemoryRemote()
  remote.appearOnRead('/out/gen-1/results.json', Buffer.from('{"ok":true}'), 2)
  let now = 0
  const body = await waitForRemoteFile(remote, '/out/gen-1/results.json', {
    timeoutMs: 10_000,
    intervalMs: 2000,
    now: () => now,
    sleep: async (ms) => { now += ms },
  })
  expect(Buffer.from(body).toString()).toBe('{"ok":true}')
  expect(remote.reads).toBe(2)
})

test('waitForRemoteFile throws timeout without sleeping for real', async () => {
  const remote = new MemoryRemote()
  let now = 0
  await expect(waitForRemoteFile(remote, '/out/missing', {
    timeoutMs: 4000,
    intervalMs: 2000,
    now: () => now,
    sleep: async (ms) => { now += ms },
  })).rejects.toThrow('timeout')
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/remote.test.ts
```

Expected: FAIL，找不到模块

- [ ] **Step 3: 实现 remote.ts**

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

export interface RemoteFiles {
  uploadDir(localDir: string, remoteDir: string): Promise<void>
  readFile(remotePath: string): Promise<Uint8Array | null>
}

export interface WaitOptions {
  timeoutMs: number
  intervalMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class MemoryRemote implements RemoteFiles {
  readonly files = new Map<string, Uint8Array>()
  reads = 0
  private staged: { path: string; bytes: Uint8Array; onRead: number } | null = null

  appearOnRead(path: string, bytes: Uint8Array, onRead: number): void {
    this.staged = { path, bytes, onRead }
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        const rel = relative(localDir, full).split('\\').join('/')
        this.files.set(posix.join(remoteDir, rel), new Uint8Array(readFileSync(full)))
      }
    }
    walk(localDir)
  }

  async readFile(remotePath: string): Promise<Uint8Array | null> {
    this.reads += 1
    if (this.staged && this.reads >= this.staged.onRead && remotePath === this.staged.path) {
      this.files.set(this.staged.path, this.staged.bytes)
    }
    return this.files.get(remotePath) ?? null
  }
}

export async function waitForRemoteFile(files: RemoteFiles, remotePath: string, opts: WaitOptions): Promise<Uint8Array> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const start = now()
  for (;;) {
    const body = await files.readFile(remotePath)
    if (body) return body
    if (now() - start >= opts.timeoutMs) throw new Error('timeout')
    await sleep(opts.intervalMs)
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/remote.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/src/remote.ts plugin/tests/remote.test.ts
git commit -m "feat: poll a remote result file"
```

### Task 5: run_evaluation

**Files:**
- Create: `plugin/src/eval-run.ts`
- Create: `plugin/tests/eval-run.test.ts`
- Test: `plugin/tests/eval-run.test.ts`

**Interfaces:**
- Consumes: `RemoteFiles`、`MemoryRemote`、`waitForRemoteFile`、`emptyState`、`applyReport`、`stopReason`、`timeoutReport`、`parseReport`、`PolicyConfig`、`TaskState`、`EvalReport`
- Produces: `runEvaluation(input: RunInput): Promise<{ report: EvalReport; state: TaskState }>`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runEvaluation } from '../src/eval-run.ts'
import { emptyState, type PolicyConfig } from '../src/policy.ts'
import { MemoryRemote } from '../src/remote.ts'

const config: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
}

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canness-pkg-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  return dir
}

test('uploads then parses a result that shows up later', async () => {
  const remote = new MemoryRemote()
  const generationId = 'gen-0123abcd'
  remote.appearOnRead(`/out/${generationId}/results.json`, Buffer.from(JSON.stringify({
    generationId,
    status: 'compile_fail',
    compile: { ok: false, log: 'error: x' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: 150 },
    summary: 'failed compile',
  })), 2)
  const { report, state } = await runEvaluation({
    files: remote,
    localPackageDir: pack(),
    generationId,
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 10_000,
    intervalMs: 1000,
    state: { ...emptyState(), generationId },
    config,
    now: (() => { let t = 0; return () => t })(),
    sleep: async () => {},
  })
  expect(report.status).toBe('compile_fail')
  expect(state.compileRetries).toBe(1)
  expect(remote.files.has('/in/gen-0123abcd/manifest.json')).toBe(true)
})

test('a poll timeout becomes a timeout report and does not throw', async () => {
  let t = 0
  const { report } = await runEvaluation({
    files: new MemoryRemote(),
    localPackageDir: pack(),
    generationId: 'gen-0123abcd',
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state: emptyState(),
    config,
    now: () => t,
    sleep: async (ms) => { t += ms },
  })
  expect(report.status).toBe('timeout')
})

test('refuses to upload when already stopped', async () => {
  const remote = new MemoryRemote()
  const state = { ...emptyState(), timeouts: 2 }
  const { report } = await runEvaluation({
    files: remote,
    localPackageDir: pack(),
    generationId: 'gen-0123abcd',
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state,
    config,
  })
  expect(report.summary).toBe('stopped: timeouts')
  expect(remote.files.size).toBe(0)
  expect(report.status).toBe('error')
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/eval-run.test.ts
```

Expected: FAIL，找不到 `eval-run.ts`

- [ ] **Step 3: 实现 eval-run.ts**

```ts
import { malformedReport, parseReport, timeoutReport, type EvalReport } from './report.ts'
import { applyReport, stopReason, type PolicyConfig, type TaskState } from './policy.ts'
import { waitForRemoteFile, type RemoteFiles } from './remote.ts'

export interface RunInput {
  files: RemoteFiles
  localPackageDir: string
  generationId: string
  inbox: string
  outbox: string
  timeoutMs: number
  intervalMs: number
  state: TaskState
  config: PolicyConfig
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export async function runEvaluation(input: RunInput): Promise<{ report: EvalReport; state: TaskState }> {
  const reason = stopReason(input.state, input.config)
  if (reason) {
    return {
      report: {
        generationId: input.generationId,
        status: 'error',
        compile: { ok: false, log: '' },
        correctness: { ok: false, maxRelativeError: null },
        performance: { kernelTimeUs: null, targetUs: null },
        analysis: null,
        summary: `stopped: ${reason}`,
      },
      state: input.state,
    }
  }
  const remoteDir = `${input.inbox}/${input.generationId}`
  const resultPath = `${input.outbox}/${input.generationId}/results.json`
  await input.files.uploadDir(input.localPackageDir, remoteDir)
  try {
    const body = await waitForRemoteFile(input.files, resultPath, {
      timeoutMs: input.timeoutMs,
      intervalMs: input.intervalMs,
      now: input.now,
      sleep: input.sleep,
    })
    const report = parseReport(JSON.parse(Buffer.from(body).toString('utf8')))
    return { report, state: applyReport(input.state, report) }
  } catch (error) {
    const report = error instanceof Error && error.message === 'timeout'
      ? timeoutReport(input.generationId, Math.round(input.timeoutMs / 1000))
      : malformedReport(input.generationId, error instanceof Error ? error.message : 'unknown')
    return { report, state: applyReport(input.state, report) }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/eval-run.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/src/eval-run.ts plugin/tests/eval-run.test.ts
git commit -m "feat: upload a package and wait for results.json"
```

### Task 6: ssh2 SFTP 适配

**Files:**
- Create: `plugin/src/ssh2-transport.ts`
- Modify: `plugin/package.json`（`pnpm add ssh2` 与 `pnpm add -D @types/ssh2` 会改依赖）
- Create: `plugin/tests/ssh2-transport.test.ts`
- Test: `plugin/tests/ssh2-transport.test.ts`

**Interfaces:**
- Consumes: `RemoteFiles`
- Produces: `connectSftp(opts: SftpOptions, dial?: Dial): Promise<RemoteFiles>`。`Dial` 默认连接真 `ssh2`，测试注入假客户端。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { connectSftp, type SftpLike } from '../src/ssh2-transport.ts'

test('uploads a tree and reads a missing file as null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-sftp-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  const stored = new Map<string, Buffer>()
  const sftp: SftpLike = {
    async mkdir() {},
    async fastPut(local, remote) { stored.set(remote, Buffer.from('{}')); expect(local).toContain('manifest.json') },
    async readFile(remote) { return stored.get(remote) ?? null },
  }
  const files = await connectSftp({
    host: 'npu', port: 22, username: 'canness', privateKey: 'KEY',
  }, async () => sftp)
  await files.uploadDir(dir, '/inbox/gen-1')
  expect(stored.has('/inbox/gen-1/manifest.json')).toBe(true)
  expect(await files.readFile('/inbox/gen-1/nope')).toBeNull()
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm add ssh2 && pnpm add -D @types/ssh2 && pnpm exec vitest run tests/ssh2-transport.test.ts
```

Expected: FAIL，找不到模块。`ssh2` 装成功后再看测试失败原因应是模块缺失，不是安装失败。

- [ ] **Step 3: 实现适配器**

`plugin/src/ssh2-transport.ts`：

```ts
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Client } from 'ssh2'
import type { RemoteFiles } from './remote.ts'

export interface SftpLike {
  mkdir(path: string): Promise<void>
  fastPut(local: string, remote: string): Promise<void>
  readFile(remote: string): Promise<Buffer | null>
}

export interface SftpOptions {
  host: string
  port: number
  username: string
  privateKey: string
}

export type Dial = (opts: SftpOptions) => Promise<SftpLike>

async function mkdirp(sftp: SftpLike, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let acc = dir.startsWith('/') ? '' : '.'
  for (const part of parts) {
    acc += `/${part}`
    try { await sftp.mkdir(acc) } catch { /* already exists */ }
  }
}

export function remoteFromSftp(sftp: SftpLike): RemoteFiles {
  return {
    async uploadDir(localDir, remoteDir) {
      await mkdirp(sftp, remoteDir)
      const walk = async (dir: string): Promise<void> => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          const rel = relative(localDir, full).split('\\').join('/')
          const remote = `${remoteDir}/${rel}`
          if (statSync(full).isDirectory()) {
            await mkdirp(sftp, remote)
            await walk(full)
          } else {
            await sftp.fastPut(full, remote)
          }
        }
      }
      await walk(localDir)
    },
    readFile: remote => sftp.readFile(remote),
  }
}

export async function connectSftp(opts: SftpOptions, dial: Dial = defaultDial): Promise<RemoteFiles> {
  return remoteFromSftp(await dial(opts))
}

function defaultDial(opts: SftpOptions): Promise<SftpLike> {
  const client = new Client()
  return new Promise((resolve, reject) => {
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) { reject(error); return }
        resolve({
          mkdir: path => new Promise((res, rej) => sftp.mkdir(path, err => err ? rej(err) : res())),
          fastPut: (local, remote) => new Promise((res, rej) => sftp.fastPut(local, remote, err => err ? rej(err) : res())),
          readFile: remote => new Promise((res, rej) => {
            sftp.readFile(remote, (err, data) => {
              if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') res(null)
              else if (err) rej(err)
              else res(data)
            })
          }),
        })
      })
    }).on('error', reject).connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.privateKey,
    })
  })
}
```

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/ssh2-transport.test.ts
```

Expected: PASS。此测试不打开网络。

- [ ] **Step 5: 提交**

```bash
git add plugin/src/ssh2-transport.ts plugin/tests/ssh2-transport.test.ts plugin/package.json plugin/pnpm-lock.yaml
git commit -m "feat: add an ssh2 sftp transport"
```

### Task 7: 知识库检索

**Files:**
- Create: `plugin/src/knowledge-search.ts`
- Create: `plugin/knowledge_base/Add.md`
- Create: `plugin/tests/knowledge.test.ts`
- Test: `plugin/tests/knowledge.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `searchKnowledge(root: string, operatorName: string): string`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from 'vitest'
import { searchKnowledge } from '../src/knowledge-search.ts'

test('returns the add note and a miss message', () => {
  const root = new URL('../knowledge_base/', import.meta.url)
  expect(searchKnowledge(root, 'Add')).toContain('float16')
  expect(searchKnowledge(root, 'MissingOp')).toBe('no knowledge entry for MissingOp')
})

test('caps the body at 8000 characters', () => {
  const root = new URL('../knowledge_base/', import.meta.url)
  expect(searchKnowledge(root, 'Add').length).toBeLessThanOrEqual(8000)
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/knowledge.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现检索与夹具**

`plugin/knowledge_base/Add.md`：

```markdown
# Add
AscendC add kernel: two tensors, same shape, float16.
```

`plugin/src/knowledge-search.ts`：

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CAP = 8000

export function searchKnowledge(root: URL | string, operatorName: string): string {
  const dir = root instanceof URL ? fileURLToPath(root) : root
  const needle = operatorName.toLowerCase()
  const hits: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (!statSync(full).isFile()) continue
    if (!name.toLowerCase().includes(needle)) continue
    hits.push(readFileSync(full, 'utf8'))
  }
  if (hits.length === 0) return `no knowledge entry for ${operatorName}`
  return hits.join('\n').slice(0, CAP)
}
```

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/knowledge.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugin/src/knowledge-search.ts plugin/knowledge_base/Add.md plugin/tests/knowledge.test.ts
git commit -m "feat: search the operator knowledge files"
```

### Task 8: 规格书、四层文件与测试包

**Files:**
- Modify: `plugin/src/policy.ts`（`TaskState.spec` 改为 `OperatorSpec | null`）
- Create: `plugin/src/state-file.ts`
- Create: `plugin/src/package-files.ts`
- Create: `plugin/src/ids.ts`
- Create: `plugin/tests/package-files.test.ts`
- Test: `plugin/tests/package-files.test.ts`

**Interfaces:**
- Consumes: `OperatorSpec`、`parseSpec`、`TaskState`、`emptyState`
- Produces: `newGenerationId(uuid: string): string`、`loadState`、`saveState`、`writeOperator`、`buildTestPackage`、`LAYER_FILES`

- [ ] **Step 1: 把 policy 里的 spec 字段改成真实类型**

`plugin/src/policy.ts` 顶部增加 `import type { OperatorSpec } from './spec.ts'`，把 `spec: null` 改成 `spec: OperatorSpec | null`。`emptyState` 仍写 `spec: null`。再跑：

```bash
cd plugin && pnpm exec vitest run tests/policy.test.ts
```

Expected: PASS

- [ ] **Step 2: 写失败测试**

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { newGenerationId } from '../src/ids.ts'
import { buildTestPackage, LAYER_FILES, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { emptyState } from '../src/policy.ts'
import { loadState, saveState } from '../src/state-file.ts'

test('generation ids keep the gen- prefix and 8 hex chars', () => {
  expect(newGenerationId('01234567-89ab-cdef-0123-456789abcdef')).toBe('gen-01234567')
})

test('writeOperator and buildTestPackage lay down the four layers and manifest', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-ws-'))
  const spec = parseSpec({
    operator_name: 'Add',
    operator_type: 'elementwise',
    input_specs: [{ name: 'x', shape: ['N'], dtype: 'float16' }],
    output_specs: [{ name: 'y', shape: ['N'], dtype: 'float16' }],
    target_platform: { chip: 'Ascend910B' },
    performance_target: { metric: 'kernel_time', target_us: 150 },
  })
  const opDir = writeOperator(workspace, 'gen-01234567', {
    kernel: 'K', host: 'H', api: 'A', plugin: 'P',
  })
  expect(readFileSync(join(opDir, LAYER_FILES.kernel), 'utf8')).toBe('K')
  const pkg = buildTestPackage(workspace, 'gen-01234567', spec)
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({
    generationId: 'gen-01234567',
    operatorName: 'Add',
    performanceTargetUs: 150,
  })
  expect(readFileSync(join(pkg, 'op_plugin/plugin.py'), 'utf8')).toBe('P')
})

test('state file round-trips and a missing file is empty', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-st-'))
  const path = join(workspace, '.canness', 'state.json')
  expect(loadState(path).generationId).toBeNull()
  const state = { ...emptyState(), generationId: 'gen-01234567' }
  saveState(path, state)
  expect(loadState(path).generationId).toBe('gen-01234567')
})
```

- [ ] **Step 3: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/package-files.test.ts
```

Expected: FAIL，找不到模块

- [ ] **Step 4: 实现**

`plugin/src/ids.ts`：

```ts
export function newGenerationId(uuid: string): string {
  return `gen-${uuid.replaceAll('-', '').slice(0, 8)}`
}
```

`plugin/src/state-file.ts`：

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptyState, type TaskState } from './policy.ts'

export function loadState(path: string): TaskState {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

export function saveState(path: string, state: TaskState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
}
```

`plugin/src/package-files.ts`：

```ts
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OperatorSpec } from './spec.ts'

export const LAYER_FILES = {
  kernel: 'op_kernel/kernel.cpp',
  host: 'op_host/host.cpp',
  api: 'op_api/api.cpp',
  plugin: 'op_plugin/plugin.py',
} as const

export type LayerName = keyof typeof LAYER_FILES

function writeRel(root: string, rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

export function writeOperator(workspace: string, generationId: string, files: Record<LayerName, string>): string {
  const root = join(workspace, 'operators', generationId)
  for (const key of Object.keys(LAYER_FILES) as LayerName[]) writeRel(root, LAYER_FILES[key], files[key])
  return root
}

export function buildTestPackage(workspace: string, generationId: string, spec: OperatorSpec): string {
  const src = join(workspace, 'operators', generationId)
  const dest = join(workspace, 'packages', generationId)
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({
    generationId,
    operatorName: spec.operator_name,
    performanceTargetUs: spec.performance_target.target_us,
    files: Object.values(LAYER_FILES),
  }, null, 2))
  return dest
}
```

- [ ] **Step 5: 跑测试并提交**

```bash
cd plugin && pnpm exec vitest run tests/package-files.test.ts tests/policy.test.ts
git add plugin/src/policy.ts plugin/src/ids.ts plugin/src/state-file.ts plugin/src/package-files.ts plugin/tests/package-files.test.ts
git commit -m "feat: write the four operator layers into a test package"
```

Expected: PASS，然后提交成功。

### Task 9: 四个插件入口

**Files:**
- Create: `plugin/src/knowledge.ts`
- Create: `plugin/src/generator.ts`
- Create: `plugin/src/eval.ts`
- Create: `plugin/src/loop.ts`
- Create: `plugin/cordis.patch.yml`
- Create: `plugin/tests/plugins.test.ts`
- Test: `plugin/tests/plugins.test.ts`

**Interfaces:**
- Consumes: Task 2–8 的全部导出，加上 `defineTool`（`@deepseek-ai/dsh-tools`）、`createUserMessage`（`@deepseek-ai/dsh-llm`）
- Produces: 四个 `apply(ctx, config)`。工具名 `kb_search`、`submit_spec`、`write_operator`、`build_test_package`、`run_evaluation`。

- [ ] **Step 1: 写失败测试**

测试不启动 dsh。它调用 `apply`，用一个只记录 `register` 和 `on` 的假上下文。

```ts
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import * as knowledge from '../src/knowledge.ts'
import * as generator from '../src/generator.ts'
import * as evalPlugin from '../src/eval.ts'
import * as loop from '../src/loop.ts'

function fakeCtx() {
  const tools: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }[] = []
  const listeners: { event: string; fn: Function }[] = []
  return {
    tools: { register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) { tools.push(tool) } },
    on(event: string, fn: Function) { listeners.push({ event, fn }) },
    toolsRegistered: tools,
    listeners,
  }
}

test('registers the five tools and two loop listeners', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const kb = fakeCtx()
  knowledge.apply(kb as never, { kbRoot: new URL('../knowledge_base/', import.meta.url).pathname })
  const gen = fakeCtx()
  generator.apply(gen as never, { workspace })
  const ev = fakeCtx()
  evalPlugin.apply(ev as never, {
    workspace, host: '', port: 22, username: '', privateKeyPath: '',
    inbox: '/tmp/canness/inbox', outbox: '/tmp/canness/outbox', timeoutSec: 1800, pollIntervalMs: 2000,
    maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  })
  const lp = fakeCtx()
  loop.apply(lp as never, {
    workspace, maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  })
  expect(kb.toolsRegistered.map(tool => tool.name)).toEqual(['kb_search'])
  expect(gen.toolsRegistered.map(tool => tool.name)).toEqual(['submit_spec', 'write_operator', 'build_test_package'])
  expect(ev.toolsRegistered.map(tool => tool.name)).toEqual(['run_evaluation'])
  expect(lp.listeners.map(item => item.event)).toEqual(['agent/pre-step', 'agent/turn-stopping'])
})

test('submit_spec rejects the first missing field and writes no state', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const gen = fakeCtx()
  generator.apply(gen as never, { workspace })
  const submit = gen.toolsRegistered.find(tool => tool.name === 'submit_spec')!
  await expect(submit.execute({ spec: { operator_name: 'Add' } })).rejects.toThrow('missing performance_target.metric')
  expect(existsSync(join(workspace, '.canness', 'state.json'))).toBe(false)
})

test('run_evaluation with an empty host does not throw and reports ssh host is empty', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const ev = fakeCtx()
  evalPlugin.apply(ev as never, {
    workspace, host: '', port: 22, username: '', privateKeyPath: '',
    inbox: '/in', outbox: '/out', timeoutSec: 1, pollIntervalMs: 1,
    maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  })
  const tool = ev.toolsRegistered[0]!
  const value = await tool.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh host is empty' })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/plugins.test.ts
```

Expected: FAIL，找不到插件模块

- [ ] **Step 3: 实现四个入口和 patch**

工具登记用 `defineTool`。`execute` 返回与 `output.schema` 一致的对象。下面每个 `apply` 都是完整文件。

`plugin/src/knowledge.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchKnowledge } from './knowledge-search.ts'

export const name = 'canness-knowledge'
export const inject = ['tools']

export interface Config { kbRoot: string }

export const Config: z<Config> = z.object({
  kbRoot: z.string().required(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: 'Search CANNESS knowledge notes by operator name.',
    parameters: {
      operator_name: { type: 'string', required: true, description: 'Operator name, for example Add' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return searchKnowledge(config.kbRoot, args.operator_name)
    },
  }))
}
```

`plugin/src/generator.ts`：

```ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { newGenerationId } from './ids.ts'
import { buildTestPackage, writeOperator } from './package-files.ts'
import { emptyState } from './policy.ts'
import { parseSpec } from './spec.ts'
import { loadState, saveState } from './state-file.ts'

export const name = 'canness-generator'
export const inject = ['tools']

export interface Config { workspace: string }

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
})

function statePath(workspace: string): string {
  return join(workspace, '.canness', 'state.json')
}

function render(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function apply(ctx: Context, config: Config): void {
  const path = statePath(config.workspace)
  ctx.tools.register(defineTool({
    name: 'submit_spec',
    description: 'Validate an operator spec and start a new generation.',
    parameters: {
      spec: { type: 'json', required: true, description: 'Operator spec JSON from design doc 02 section 3.1' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generationId: { type: 'string', required: true },
          operator_name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const spec = parseSpec(args.spec)
      const generationId = newGenerationId(randomUUID())
      saveState(path, { ...emptyState(), generationId, spec })
      return { generationId, operator_name: spec.operator_name }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write_operator',
    description: 'Write the four operator layer files for the current generation.',
    parameters: {
      kernel: { type: 'string', required: true, description: 'op_kernel/kernel.cpp body' },
      host: { type: 'string', required: true, description: 'op_host/host.cpp body' },
      api: { type: 'string', required: true, description: 'op_api/api.cpp body' },
      plugin: { type: 'string', required: true, description: 'op_plugin/plugin.py body' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { operatorDir: { type: 'string', required: true } },
      },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const state = loadState(path)
      if (state.generationId == null || state.spec == null) throw new Error('submit_spec first')
      const operatorDir = writeOperator(config.workspace, state.generationId, {
        kernel: args.kernel, host: args.host, api: args.api, plugin: args.plugin,
      })
      return { operatorDir }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'build_test_package',
    description: 'Copy the current operator layers into a package directory and write manifest.json.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { packageDir: { type: 'string', required: true } },
      },
      render: (_args, value) => render(value),
    },
    async execute() {
      const state = loadState(path)
      if (state.generationId == null || state.spec == null) throw new Error('submit_spec first')
      return { packageDir: buildTestPackage(config.workspace, state.generationId, state.spec) }
    },
  }))
}
```

`plugin/src/eval.ts`：

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runEvaluation } from './eval-run.ts'
import { loadState, saveState } from './state-file.ts'
import { connectSftp } from './ssh2-transport.ts'
import type { EvalReport } from './report.ts'
import type { PolicyConfig } from './policy.ts'

export const name = 'canness-eval'
export const inject = ['tools']

export interface Config extends PolicyConfig {
  workspace: string
  host: string
  port: number
  username: string
  privateKeyPath: string
  inbox: string
  outbox: string
  timeoutSec: number
  pollIntervalMs: number
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  host: z.string().required(),
  port: z.number().required(),
  username: z.string().required(),
  privateKeyPath: z.string().required(),
  inbox: z.string().required(),
  outbox: z.string().required(),
  timeoutSec: z.number().required(),
  pollIntervalMs: z.number().required(),
  maxIterations: z.number().required(),
  maxCompileRetries: z.number().required(),
  negativeStreakLimit: z.number().required(),
  convergenceThreshold: z.number().required(),
})

function emptyHostReport(generationId: string | null): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: 'ssh host is empty',
  }
}

export function apply(ctx: Context, config: Config): void {
  const path = join(config.workspace, '.canness', 'state.json')
  const policy: PolicyConfig = {
    maxIterations: config.maxIterations,
    maxCompileRetries: config.maxCompileRetries,
    negativeStreakLimit: config.negativeStreakLimit,
    convergenceThreshold: config.convergenceThreshold,
  }
  ctx.tools.register(defineTool({
    name: 'run_evaluation',
    description: 'Upload the current test package over SFTP and wait for results.json. Does not compile locally.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generationId: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['pass', 'compile_fail', 'accuracy_fail', 'perf_fail', 'timeout', 'error'],
          },
          compile: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              ok: { type: 'boolean', required: true },
              log: { type: 'string', required: true },
            },
          },
          correctness: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              ok: { type: 'boolean', required: true },
              maxRelativeError: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          performance: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kernelTimeUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              targetUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          analysis: {
            required: true,
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', required: true, enum: ['msprof-mock', 'msprof'] },
                  bottleneck: { type: 'string', required: true, enum: ['cube', 'memory', 'scalar', 'unknown'] },
                  summary: { type: 'string', required: true },
                  op: {
                    required: true,
                    oneOf: [
                      { type: 'null' },
                      {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          opName: { type: 'string', required: true },
                          opType: { type: 'string', required: true },
                          taskType: { type: 'string', required: true },
                          taskDurationUs: { type: 'number', required: true },
                          taskWaitTimeUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          blockDim: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicoreTimeUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicMacRatio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicMte2Ratio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicScalarRatio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          cubeUtilizationPct: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const state = loadState(path)
      if (config.host === '') return emptyHostReport(state.generationId)
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(config.workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) throw new Error('build_test_package first')
      const files = await connectSftp({
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: readFileSync(config.privateKeyPath, 'utf8'),
      })
      const { report, state: next } = await runEvaluation({
        files,
        localPackageDir,
        generationId: state.generationId,
        inbox: config.inbox,
        outbox: config.outbox,
        timeoutMs: config.timeoutSec * 1000,
        intervalMs: config.pollIntervalMs,
        state,
        config: policy,
      })
      saveState(path, next)
      return report
    },
  }))
}
```

`plugin/src/loop.ts`：

```ts
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { enhancementBlock, shouldSteer, type PolicyConfig } from './policy.ts'
import { loadState } from './state-file.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'canness-loop': { kind: 'canness-loop'; form: 'notice'; summary: string }
  }
}

export const name = 'canness-loop'
export const inject = [] as const

export interface Config extends PolicyConfig { workspace: string }

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  maxIterations: z.number().required(),
  maxCompileRetries: z.number().required(),
  negativeStreakLimit: z.number().required(),
  convergenceThreshold: z.number().required(),
})

function notice(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'canness-loop' as const, form: 'notice' as const, summary: 'retry operator' },
  })
}

export function apply(ctx: Context, config: Config): void {
  const path = join(config.workspace, '.canness', 'state.json')
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = loadState(path)
    const text = enhancementBlock(state)
    if (!text || state.lastReport == null || state.lastReport.status === 'pass') return decision
    const already = decision.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text === text),
    )
    if (already) return decision
    return {
      kind: 'enter',
      ...(decision.startsRequestSeries ? { startsRequestSeries: true as const } : {}),
      messages: [...decision.messages, notice(text)],
    }
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = loadState(path)
    if (!shouldSteer(state, config)) return
    agent.steer(notice(enhancementBlock(state)))
  })
}
```

`plugin/cordis.patch.yml`：

```yaml
- insert:
    - id: canness-knowledge
      name: dsh-canness/knowledge
      config:
        kbRoot: ./plugin/knowledge_base
    - id: canness-generator
      name: dsh-canness/generator
      config:
        workspace: ./canness-workspace
    - id: canness-eval
      name: dsh-canness/eval
      config:
        workspace: ./canness-workspace
        host: ""
        port: 22
        username: ""
        privateKeyPath: ""
        inbox: /tmp/canness/inbox
        outbox: /tmp/canness/outbox
        timeoutSec: 1800
        pollIntervalMs: 2000
        maxIterations: 10
        maxCompileRetries: 3
        negativeStreakLimit: 3
        convergenceThreshold: 0.05
    - id: canness-loop
      name: dsh-canness/loop
      config:
        workspace: ./canness-workspace
        maxIterations: 10
        maxCompileRetries: 3
        negativeStreakLimit: 3
        convergenceThreshold: 0.05
```

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/plugins.test.ts && pnpm exec tsc -p tsconfig.json --noEmit
```

Expected: 测试 PASS，`tsc` 退出码 0。`tsc` 的 `include` 只有 `src`，能编过四个入口即可。

- [ ] **Step 5: 提交**

```bash
git add plugin/src/knowledge.ts plugin/src/generator.ts plugin/src/eval.ts plugin/src/loop.ts plugin/cordis.patch.yml plugin/tests/plugins.test.ts
git commit -m "feat: register the four canness plugins"
```

### Task 10: 远端 mock 脚本

**Files:**
- Create: `plugin/remote/watch.py`
- Create: `plugin/tests/watch.test.ts`
- Test: `plugin/tests/watch.test.ts`

**Interfaces:**
- Consumes: 结果 JSON 约定
- Produces: `python plugin/remote/watch.py --inbox <dir> --outbox <dir> --once`。看到 `manifest.json` 就写 pass 结果：`kernelTimeUs` 等于 `performanceTargetUs`，并附上 `source: "msprof-mock"` 的性能分析。不调用 msprof。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('watch.py writes a pass result from the manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'canness-watch-'))
  const inbox = join(root, 'inbox', 'gen-01234567')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'manifest.json'), JSON.stringify({
    generationId: 'gen-01234567',
    performanceTargetUs: 150,
  }))
  const outbox = join(root, 'outbox')
  const run = spawnSync('python', [
    'remote/watch.py', '--inbox', join(root, 'inbox'), '--outbox', outbox, '--once',
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  expect(run.status).toBe(0)
  const result = JSON.parse(readFileSync(join(outbox, 'gen-01234567', 'results.json'), 'utf8'))
  expect(result).toMatchObject({
    generationId: 'gen-01234567',
    status: 'pass',
    performance: { kernelTimeUs: 150, targetUs: 150 },
    summary: 'mock pass',
    analysis: {
      source: 'msprof-mock',
      bottleneck: 'memory',
      op: {
        taskDurationUs: 150,
        aicMacRatio: 0.12,
        aicMte2Ratio: 0.71,
        aicScalarRatio: 0.09,
        cubeUtilizationPct: 18.4,
      },
    },
  })
  expect(result.analysis.summary).toContain('Task Duration')
  expect(result.analysis.summary).toContain('aic_mte2_ratio')
  expect(result.analysis.summary).toContain('cube_utilization')
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd plugin && pnpm exec vitest run tests/watch.test.ts
```

Expected: FAIL，`watch.py` 不存在或退出码非 0

- [ ] **Step 3: 写 watch.py**

```python
#!/usr/bin/env python3
"""Host-side mock runner. Writes an eval report plus an msprof-shaped analysis. Does not call msprof."""

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--inbox', required=True)
    parser.add_argument('--outbox', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    inbox = Path(args.inbox)
    outbox = Path(args.outbox)
    if not inbox.exists():
        return
    for manifest in inbox.glob('*/manifest.json'):
        generation = manifest.parent.name
        dest = outbox / generation / 'results.json'
        if dest.exists():
            continue
        data = json.loads(manifest.read_text(encoding='utf-8'))
        target = data.get('performanceTargetUs')
        name = data.get('operatorName') if isinstance(data.get('operatorName'), str) else generation
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({
            'generationId': data.get('generationId', generation),
            'status': 'pass',
            'compile': {'ok': True, 'log': ''},
            'correctness': {'ok': True, 'maxRelativeError': 0},
            'performance': {'kernelTimeUs': target, 'targetUs': target},
            'analysis': {
                'source': 'msprof-mock',
                'bottleneck': 'memory',
                'summary': f'Task Duration {target}us；aic_mte2_ratio 0.71，内存搬运为主，cube_utilization 18.4%。',
                'op': {
                    'opName': name,
                    'opType': name,
                    'taskType': 'AI_CORE',
                    'taskDurationUs': target,
                    'taskWaitTimeUs': 2,
                    'blockDim': 8,
                    'aicoreTimeUs': target,
                    'aicMacRatio': 0.12,
                    'aicMte2Ratio': 0.71,
                    'aicScalarRatio': 0.09,
                    'cubeUtilizationPct': 18.4,
                },
            },
            'summary': 'mock pass',
        }), encoding='utf-8')


if __name__ == '__main__':
    main()
```

`--once` 被接受但循环只走一遍，脚本本来就不是常驻进程。常驻留给以后；MVP 由人在远端先跑一次，或放进 cron。插件仍然只上传和等待。

- [ ] **Step 4: 跑测试**

```bash
cd plugin && pnpm exec vitest run tests/watch.test.ts
```

Expected: PASS。本机需要 `python` 在 PATH 上。

- [ ] **Step 5: 提交**

```bash
git add plugin/remote/watch.py plugin/tests/watch.test.ts
git commit -m "feat: add the remote msprof mock result writer"
```

### Task 11: 全量单测与类型检查

**Files:**
- Modify: 仅当 Task 1–10 的测试或 `tsc` 失败时，改对应源文件
- Test: `plugin/tests`

**Interfaces:**
- Consumes: 前面每个任务的导出
- Produces: `pnpm test` 与 `pnpm exec tsc -p tsconfig.json --noEmit` 都成功

- [ ] **Step 1: 跑全量测试**

```bash
cd plugin && pnpm test && pnpm exec tsc -p tsconfig.json --noEmit
```

Expected: 全部 PASS，`tsc` 退出码 0

- [ ] **Step 2: 失败就修到通过**

只修失败断言指向的那个函数。不要放宽断言来换通过。修完重复 Step 1。

- [ ] **Step 3: 有改动才提交**

```bash
git add plugin
git commit -m "fix: make the canness plugin tests pass together"
```

工作区没有 `plugin/` 的新改动时，不要空提交。

### Task 12: 手工验收（有主机和 dsh 才做）

**Files:**
- Create: `plugin/README.md`
- Test: 下面两条命令的输出

**Interfaces:**
- Consumes: `cordis.patch.yml`、`watch.py`、`connectSftp`
- Produces: 一份把 profile 安装和 mock 闭环写清楚的 README

- [ ] **Step 1: 写 README**

`plugin/README.md` 写这三步，不要写第二套传输：

1. `cd plugin && pnpm test && pnpm build`
2. 有 `dsh` 时：`dsh plugin --profile canness add ./plugin`，然后 `dsh --profile canness --dump-config`。期望输出含 `# == dsh-canness`。把 profile 的 `canness-eval` 行整段重写成自己的 `host`、`username`、`privateKeyPath`；patch 替换整份 `config`，不能只加一个键。
3. 远端：`python3 watch.py --inbox /tmp/canness/inbox --outbox /tmp/canness/outbox --once` 放进 cron 或在上传后手动跑。本机没有 CANN 时这样就能等到 `status` 为 `pass`、`analysis.source` 为 `msprof-mock` 的 `results.json`。不调用 msprof。

- [ ] **Step 2: 有 dsh 就核对 dump**

```bash
dsh plugin --profile canness add ./plugin
dsh --profile canness --dump-config
```

Expected: 输出包含 `canness-knowledge`、`canness-generator`、`canness-eval`、`canness-loop`。没有 `dsh` 就在 README 顶部写上「本机未安装 dsh，跳过 dump」，不要把命令改成别的安装器。

- [ ] **Step 3: 提交**

```bash
git add plugin/README.md
git commit -m "docs: describe the canness profile install"
```

---

## 自检

- 05 的四插件、规格书、四层文件、上传后等待、编译失败不计迭代、预算停机：Task 3、5、8、9。
- 不用模力方舟 / dsh-ssh：Task 6 只用 `ssh2`，空 host 不连接。
- `agent/turn-stopping` 用 `steer` 而不是 `return` 停机：Task 9 的 `loop.ts`。
- 会话日志不另写存储：工具结果进入 dsh session，计划里没有第二份日志器。
- 真实 AscendC 与 CANN 编译不在本计划内。远端 mock 只证明结果 JSON 和性能分析契约，不调用 msprof。
- 不监听 `tools/result`。失败分类在 `runEvaluation` → `applyReport`。`pre-step` 看到本步消息里已有同一段增强文本就不再追加。
- 四个入口都有完整源码，并导出 Schemastery `Config`。预算四字段在 eval 与 loop 的 patch 里各写一份。
