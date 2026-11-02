---
title: 闭环反馈系统设计指南
order: 3
relates_to:
  - "01-overall-design.md"    # 整体架构背景
  - "02-detailed-architecture.md"    # Agent 与执行器设计
  - "04-feasibility-assessment.md"   # 对本文方案的可行性分析
---

# CANN 算子自动化生成 Harness 设计指导

> 基于 `auto_pipeline` 的逆向分析与经验提炼  
> 目标：构建一个具备**闭环反馈能力**的 CANN 算子自动生成系统

---

## 目录

1. [架构总览](#1-架构总览)
2. [可借鉴的设计模式](#2-可借鉴的设计模式)
3. [细节优化点汇编](#3-细节优化点汇编)
4. [核心新增：闭环反馈机制](#4-核心新增闭环反馈机制)
5. [反馈驱动的 Prompt 工程](#5-反馈驱动的-prompt-工程)
6. [实施路线图建议](#6-实施路线图建议)

---

## 1. 架构总览

### 1.1 核心数据流（建议）

```
                         ┌─────────────────────────────┐
                         │      Knowledge Base          │
                         │  (历史失败模式 / 最佳实践)    │
                         └──────────┬──────────────────┘
                                    │ 注入
                                    ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ 任务解析  │ → │ 生成器    │ → │ 格式转换  │ → │ 评测引擎  │
  │ YAML →   │   │ LLM/AKG  │   │ (submission)│  │ kernel_   │
  │ 算子列表  │   │ 生成代码  │   │ 格式归一化 │   │ eval      │
  └──────────┘   └──────────┘   └──────────┘   └─────┬────┘
                                                      │
                                                      ▼
                                            ┌──────────────────┐
                                            │  反馈分析器       │ ←── 核心新增
                                            │  分类·归因·增强   │
                                            └────────┬─────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────┐
                          ▼                          ▼                  ▼
                   ┌────────────┐           ┌──────────────┐   ┌──────────────┐
                   │ 正确性失败  │           │ 性能不达标    │   │ 编译/运行时   │
                   │ → 注入diff  │           │ → 注入profile │   │ 错误         │
                   │ → 重试      │           │ → 重试        │   │ → 修复env    │
                   └────────────┘           └──────────────┘   └──────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │ 成功·记录基线  │
                   │ 更新Knowledge │
                   │ 更新Leaderboard│
                   └──────────────┘
```

### 1.2 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│  CLI / API 层                                                 │
│  参数解析、运行控制、monitor、kill、retry、可视化 dashboard     │
├──────────────────────────────────────────────────────────────┤
│  编排层 (Orchestrator)                                       │
│  任务队列、设备池、并发控制、状态管理、超时/熔断              │
├──────────────────────────────────────────────────────────────┤
│  生成器层 (Generator)                                        │
│  可插拔：AKG / LLM(PyPTO) / 模板 / 混合                      │
├──────────────────────────────────────────────────────────────┤
│  转换层 (Converter)                                          │
│  产物格式归一化、submission 打包                              │
├──────────────────────────────────────────────────────────────┤
│  评测层 (Evaluator)                                          │
│  kernel_eval 封装、perf 采集、profiler 数据解析               │
├──────────────────────────────────────────────────────────────┤
│  反馈层 (Feedback Loop)           ←── 核心新增                │
│  失败分类、归因分析、Prompt 增强、重试策略、基线管理          │
├──────────────────────────────────────────────────────────────┤
│  持久层 (Persistence)                                        │
│  运行状态、评测结果、性能基线、Knowledge Base                 │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 可借鉴的设计模式

以下是从 `auto_pipeline` 中提取的、值得在新的 harness 中保留或改良的设计逻辑。

### 2.1 配置驱动 + 运行时覆写

**现有做法**：`SimpleConfig` 从 YAML 中解析静态配置，CLI 参数 (`--devices`, `--parallel`, `--model`) 通过 `_runtime_options()` 运行时覆写，最后 `_parse_config()` 合并两者。

```
YAML 配置 (静态)          CLI 参数 (动态)
     │                        │
     └────────┬───────────────┘
              ▼
        SimpleConfig
     (不可变 frozen dataclass)
```

**可借鉴的点**：
- 配置与代码分离，新加一个算子benchmark只需要写 YAML，不需要改代码
- `frozen dataclass` 确保配置在运行时不会被意外修改
- 运行时覆写的键有白名单校验 (`_reject_unknown_keys`)，避免拼写错误

**建议改进**：增加配置继承机制（base config → operator-specific override），减少重复。

### 2.2 进程隔离 + 进程树追踪

**现有做法**：`_run_cases_with_device_pool()` 使用 `multiprocessing.Process` 为每个任务启动独立子进程，`_ProcessFamilyTracker` 后台线程追踪子进程衍生的所有后代进程。

```python
# 核心：multiprocessing.Process 隔离
process = multiprocessing.Process(target=_run_task_process, args=(...))
process.start()

# 后台线程追踪进程树
tracker = _ProcessFamilyTracker(process, ...)
tracker.start()  # 每 0.5s 扫描 /proc 发现新后代
```

**可借鉴的点**：
- 每个任务在独立进程中运行，崩溃不影响其他任务
- 进程树追踪确保 kill 时子子孙孙都被清理干净
- 两阶段终止：SIGTERM → 等待 grace_sec → SIGKILL

**建议改进**：考虑用 `concurrent.futures.ProcessPoolExecutor` + 超时包装，减少手动管理 dequeue 的代码量。

### 2.3 设备池管理

**现有做法**：`devices` 用 `deque` 实现独占分配，任务完成时释放回池。

```python
available_devices = deque(spec.devices)  # 初始队列
device_id = available_devices.popleft()  # 分配
# ... 任务完成 ...
available_devices.append(device_id)      # 归还
```

**可借鉴的点**：
- 设备独占模式 vs 共享模式 (`--share-device`) 用布尔开关切换，设计简洁
- 任务数 > 设备数时自动排队，不浪费一张卡
- 索引映射 `device_id = devices[index % len(devices)]` 在共享模式下做 round-robin

**建议改进**：
- 增加设备健康检查（任务失败后标记设备故障，不再分配）
- 增加 NUMA 亲和性感知（同一算子 pin 到同一设备，利用缓存）

### 2.4 状态持久化 + 断点续跑

**现有做法**：`state.py` 通过 JSON 文件记录每个任务的生命周期状态。

```
.auto_pipeline/runs/
  run_20260827_173000_abc12345/
    run.json          # 运行元数据 + 聚合状态
    tasks/
      level1_exp.json    # 每个任务独立状态
      level2_softmax.json
```

**可借鉴的点**：
- 状态文件可读，调试时直接用 `cat` 查看
- 原子写入 (`_atomic_write_text`: 先写 `.tmp` 再 `os.replace`)，避免部分写入
- 每次状态变更都写文件，即使进程崩溃也能从最新状态恢复
- `retry` 命令可以直接读取任务状态文件，知道哪些任务需要重试

**建议改进**：
- 改用 SQLite 替代 JSON 文件，支持更复杂的查询（"过去 7 天所有 matmul 算子的性能趋势"）
- 增加 WAL 模式，支持并发读取

### 2.5 可插拔生成器注册

**现有做法**：`registry.py` 维护工厂函数字典，通过字符串名称查找。

```python
register_runner("opencode", _create_opencode)
register_generator("akg-agent", _create_akg)
register_generator("pypto", _create_pypto)

def create_generator(generator_type, cfg):
    factory = _GENERATOR_FACTORIES[normalize(generator_type)]
    return factory(cfg)
```

**可借鉴的点**：
- 新增生成器只需要写一个类 + 注册一行，不破坏现有代码
- 配置中 `agent.type: pypto` 即可切换，不需要改编排逻辑
- 所有生成器统一实现 `Generator` Protocol，接口契约清晰

**建议改进**：
- 支持生成器优先级和自动回退（首选 AKG，失败则 fallback 到 LLM）
- 支持生成器组合（先用 AKG 生成模板，再用 LLM 填空）

### 2.6 三层 Prompt 材料构建

**现有做法**：`prompt/builders.py` 将原始任务文件转化为可供 LLM 消费的 `CaseMaterial`。

```
原始文件                        CaseMaterial
  proto.yaml             →      op_name
  cases.yaml/csv         →      task_files (路径列表)
  golden.py              →      require_text (REQUIRE.md 格式)
  desc.md                →      prompt_context (结构化上下文)
```

**可借鉴的点**：
- Prompt 材料与生成器分离：同一个 CaseMaterial 可以喂给 AKG 或 LLM
- `require_text` 是完整的 REQUIRE.md，包含 schema、操作签名、用例预览、golden 参考——所有信息在一个自包含文档中
- `prompt_context` 分为 `case_task_files_text`（文件列表）和 `case_detail_sections`（详细内容），支持模板化拼接

**建议改进**：
- 增加 `failure_context` 字段：记录历史失败原因，作为新 prompt 的负例
- 增加 `optimization_hints` 字段：针对特定硬件/算子的最佳实践

### 2.7 评测隔离沙箱

**现有做法**：`CannBenchClient._build_eval_env()` 为每个评测任务创建隔离的 `pip_target` 目录，并通过 pip shim 拦截所有 pip 安装请求。

```python
isolation_dir = reports_dir / f"_eval_isolation_{uuid.uuid4().hex}"
pip_target = isolation_dir / "pip_target"
pip_shim_dir = isolation_dir / "pip_shim"
# ... 将 pip_shim 插入 PYTHONPATH 最前面 ...
```

**可借鉴的点**：
- 每次评测有独立的依赖安装目录，不会污染系统环境
- pip shim 机制确保评测期间安装的包只影响本次评测
- 评测结束后整个隔离目录可一键清理

**建议改进**：
- 增加缓存层：如果两次评测的依赖相同，复用 pip_target，避免重复下载
- 增加容器化支持（可选）：Docker 或 Sandbox 提供更强的隔离

---

## 3. 细节优化点汇编

### 3.1 并发控制

| 优化点 | 现有做法 | 建议 |
|--------|----------|------|
| 任务并行度 | `min(任务数, 并行度, 设备数)` | 增加动态调整：根据前 N 个任务的平均耗时动态扩容 |
| 类并发度 | `ThreadPoolExecutor(max_workers=4)` | 可配置，且根据算子复杂度自动调整 |
| I/O 等待 | `time.sleep(0.1)` 轮询子进程 | 改用 `multiprocessing.connection.wait()` 或 `select` 事件驱动 |
| 设备分配 | 简单 deque 分配 | 增加设备亲和性：连续重试固定同一设备，利用缓存 |

### 3.2 超时管理

| 优化点 | 现有做法 | 建议 |
|--------|----------|------|
| 超时值 | 统一 `gen_timeout=10800s` | 按算子难度级别动态设定（Level 1: 600s, Level 4: 3600s） |
| 超时行为 | 直接标记失败 | 超时后自动延长 50% 重试一次，同时记录"首次超时" |
| 超时穿透 | 仅捕获 `TimeoutExpired` | 增加 watchdog 线程：定期检查是否有进程卡死超过 2 倍超时 |

### 3.3 错误处理

| 优化点 | 现有做法 | 建议 |
|--------|----------|------|
| 异常分类 | 统一的 `_exception_entry`，记录 `error_type` + `error` | 增加结构化错误分类：编译错误 / 运行时错误 / 精度错误 / 性能错误 |
| 错误传播 | 子进程异常 → 序列化到 entry JSON → 父进程读取 | 增加错误栈的完整序列化，包含 stdout/stderr 的截断保留 |
| 重试策略 | 手动 `retry` 命令，指定 `--task` | 自动重试：编译错误 1 次，精度错误 2 次，性能不达标 3 次 |

### 3.4 日志与可观测性

| 优化点 | 现有做法 | 建议 |
|--------|----------|------|
| 实时监控 | CLI monitor 定时刷新表格 | 增加 WebSocket 推送 + 浏览器 dashboard |
| 子过程日志 | `background.log` 文件，append 模式 | 增加结构化日志（JSON lines），支持 logstash/fluentd 接入 |
| 进度追踪 | status_callback 写入 JSON 状态文件 | 增加每个阶段的详细进度百分比（如 "Stage 4/7: 代码生成 60%"） |
| Token 统计 | 从 OpenCode session 导出 | 独立统计模块，按生成器/算子/模型汇总 |

### 3.5 产物管理

| 优化点 | 现有做法 | 建议 |
|--------|----------|------|
| 产物快照 | `_snapshot_pypto_custom_artifact` 复制到 output 目录 | 增加 Git 追踪：每次生成自动 commit，方便 diff 回滚 |
| 产物文件 | 固定文件名 `{op_name}_impl.py` | 增加 `generation_id` 命名空间，支持多版本并行 |
| 产物清理 | 无自动清理 | 增加保留策略：保留最近 N 次成功产物，自动清理旧的 |

---

## 4. 核心新增：闭环反馈机制

这是现有流水线最大的缺失，也是新 harness 的核心价值所在。

### 4.1 反馈循环架构

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Generator │───→│ Converter│───→│ Evaluator │
└─────┬────┘    └──────────┘    └─────┬────┘
      │                               │
      │  ┌───────────────────────────┐│
      │  │     Feedback Analyzer      ││
      │  │                           │▼
      │  │  ┌─────────────────┐   ┌──────┐
      │  │  │ FailureClassifier│   │Performance│
      │  │  │ 认 = 编译错误     │   │Benchmarker │
      │  │  │ 认 = 精度不匹配   │   │ 对比基线   │
      │  │  │ 认 = 运行时崩溃   │   │ 计算差距   │
      │  │  │ 认 = 性能不达标   │   │ 瓶颈分析   │
      │  │  └────────┬────────┘   └──┬───┘
      │  │           │               │
      │  │           ▼               ▼
      │  │  ┌──────────────────────────┐
      │  │  │   Prompt Augmenter       │
      │  │  │  ┌──────────────────────┐│
      │  │  │  │ 编译错误 → 注入修复  ││
      │  │  │  │ 精度错误 → 注入 diff ││
      │  │  │  │ 性能不足 → 注入 profile││
      │  │  │  └──────────────────────┘│
      │  │  └──────────┬───────────────┘
      │  │             │
      │◄─┘─────────────┘
      │    (增强后的 prompt → 重新生成)
      ▼
  [Regeneration Controller]
  决定：重试？换模型？换生成器？放弃？
```

### 4.2 反馈分析器设计

#### 4.2.1 失败分类器

```python
@dataclass
class FailureAnalysis:
    category: FailureCategory       # 失败类别
    confidence: float               # 分类置信度
    summary: str                    # 一句话摘要
    detail: str                     # 详细分析
    suggested_action: str           # 建议行动
    augmented_prompt: str           # 增强后的 prompt 片段
    should_retry: bool              # 是否建议重试
    retry_count: int                # 已重试次数
    max_retries: int                # 最大重试次数

class FailureCategory(Enum):
    COMPILATION_ERROR = "compilation_error"     # 编译错误
    RUNTIME_CRASH = "runtime_crash"             # 运行时崩溃
    ACCURACY_MISMATCH = "accuracy_mismatch"     # 精度不匹配
    PERFORMANCE_BELOW_THRESHOLD = "perf_below"  # 性能不达标
    TIMEOUT = "timeout"                         # 超时
    UNKNOWN = "unknown"                         # 无法分类
```

**分类策略**：

| 信号 | 类别 | 置信度判断 |
|------|------|-----------|
| stderr 包含 `error:`、`Traceback`、`compile` | COMPILATION_ERROR | 高 |
| stderr 包含 `Segmentation fault`、`core dump`、`abort` | RUNTIME_CRASH | 高 |
| eval 报告 accuracy < 99.5% | ACCURACY_MISMATCH | 中（需确认阈值） |
| 性能 < 基线 80% 或超时 | PERFORMANCE_BELOW_THRESHOLD | 中 |
| 进程被 kill 或超时 | TIMEOUT | 高 |
| 其他 | UNKNOWN | 低 |

#### 4.2.2 Prompt 增强器

根据失败类别，自动生成增强 prompt 片段：

**编译错误增强**：
```python
def augment_compilation_error(analysis: FailureAnalysis) -> str:
    return f"""
[前次编译错误]
错误信息:
```
{analysis.detail[:2000]}
```
请在生成时特别注意：
1. 检查 Tensor 的 shape 和 dtype 是否与 schema 一致
2. 确保所有算子调用在 CANN 上都有对应的实现
3. 避免使用不支持的 Python 语法或 built-in 函数
"""
```

**精度错误增强**：
```python
def augment_accuracy_error(analysis: FailureAnalysis) -> str:
    return f"""
[前次精度验证失败]
差异摘要: {analysis.summary}
具体差异:
```
{analysis.detail[:2000]}
```
请在生成时特别注意：
1. 检查 reduce 操作的 axis 是否正确
2. 确认 float32/float16 的精度截断策略
3. 参考 golden.py 的实现逻辑，确保算法等价
"""
```

**性能不达标增强**：
```python
def augment_perf_error(analysis: FailureAnalysis) -> str:
    return f"""
[前次性能未达标]
基线性能: {analysis.detail.get('baseline', 'N/A')}
当前性能: {analysis.detail.get('current', 'N/A')}
差距: {analysis.detail.get('gap_pct', 'N/A')}%

请在生成时特别注意：
1. 使用 tiling 策略适配输入 shape
2. 启用 double buffer 隐藏访存延迟
3. 考虑 vectorization 宽度
4. 避免不必要的同步操作
"""
```

### 4.3 重试策略控制器

```
                    ┌──────────────┐
                    │ 生成失败      │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ 失败分类      │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │编译错误   │ │精度错误   │ │性能不足   │
       │max_retry=1│ │max_retry=2│ │max_retry=3│
       └────┬─────┘ └────┬─────┘ └────┬─────┘
            │            │            │
            ▼            ▼            ▼
       ┌──────────────────────────────────┐
       │  Prompt 增强 + 重新生成           │
       │  (增量注入失败信息，不覆盖原始信息) │
       └──────────────┬───────────────────┘
                      │
            ┌─────────┴─────────┐
            ▼                   ▼
       ┌──────────┐      ┌──────────┐
       │ 重试成功  │      │ 达到上限  │
       │ → 更新基线 │      │ → 标记失败 │
       │ → 记录经验 │      │ → 记录到 KB │
       └──────────┘      └──────────┘
```

**重试退避策略**：
- 第 1 次重试：正常 prompt 增强 + 立即重试
- 第 2 次重试：增加负面示例 + 降低温度参数
- 第 3 次重试：切换生成器（如 AKG → PyPTO）或切换模型

### 4.4 性能基线管理

```python
@dataclass
class PerfBaseline:
    operator: str
    benchmark_name: str
    best_latency_us: float        # 历史最佳延迟 (μs)
    best_throughput: float        # 历史最佳吞吐 (ops/s)
    best_generation_id: str       # 最佳产物的生成 ID
    last_updated: str             # 时间戳
    history: List[PerfRecord]     # 历史记录（最多 100 条）
    
    @property
    def regression_threshold(self) -> float:
        """如果新生成延迟 > 基线 110%，标记为回归"""
        return self.best_latency_us * 1.10
```

**基线更新策略**：
- 新生成性能优于基线 5%+ → 更新基线，保存新 kernel
- 新生成性能在基线的 ±5% 内 → 记录但不更新基线
- 新生成性能低于基线 10%+ → 标记回归，但不删除基线

### 4.5 Knowledge Base 设计

```
knowledge_base/
  operators/
    exp/
      best_kernel.py          # 当前最佳 kernel
      failures.json            # 历史失败记录
      perf_history.json        # 性能历史
      tips.md                  # 人工撰写或自动总结的优化技巧
    softmax/
      ...
  cross_operator/
    fusion_patterns.md         # 融合模式总结
    common_errors.md           # 常见错误模式
    best_practices.md          # 通用最佳实践
```

**Knowledge Base 的自动更新**：
- 每次成功生成后，提取该算子的优化技巧（通过 LLM 总结生成过程中的关键决策）
- 每次失败后，记录失败模式，用于后续同类算子的负面示例
- 跨算子分析：识别出"所有 reduce 类算子都有 bank conflict 问题"这类通用模式

---

## 5. 反馈驱动的 Prompt 工程

### 5.1 Prompt 结构演进

```
基础 Prompt (第 1 次生成):
  proto.yaml + golden.py + cases.yaml + 通用指令

增强 Prompt (第 2 次生成，如果第 1 次失败):
  基础 Prompt + 失败分析 + 修复建议

深度增强 Prompt (第 3 次生成，如果第 2 次仍然失败):
  增强 Prompt + 负面示例 + 更激进的优化指令

跨算子 Prompt (同类型算子的后续生成):
  基础 Prompt + 同类算子成功经验 + 已知陷阱
```

### 5.2 注入策略

```python
class PromptAugmenter:
    """增强 prompt，不破坏原始内容的结构化注入器。"""
    
    def augment(
        self,
        base_prompt: str,
        analysis: FailureAnalysis,
        kb_context: Optional[KnowledgeContext] = None,
    ) -> str:
        sections = [base_prompt.strip()]
        
        # 1. 注入失败上下文
        if analysis.should_retry:
            sections.append(self._build_failure_section(analysis))
        
        # 2. 注入 KB 上下文
        if kb_context:
            sections.append(self._build_kb_section(kb_context))
        
        # 3. 注入优化提示
        if analysis.category == FailureCategory.PERFORMANCE_BELOW_THRESHOLD:
            sections.append(self._build_perf_hints(analysis))
        
        # 4. 注入迭代指示
        sections.append(self._build_retry_instruction(analysis.retry_count))
        
        return "\n\n".join(sections)
```

### 5.3 负面示例库

```python
# 负面示例条目
@dataclass
class NegativeExample:
    operator_pattern: str        # 匹配模式（正则或通配符）
    failure_type: FailureCategory
    symptom: str                # 失败表现
    root_cause: str             # 根因分析
    bad_code_snippet: str       # 错误的代码片段
    good_code_suggestion: str   # 正确的做法
    weight: float               # 重要性权重 [0, 1]
```

**注入策略**：
- 权重 > 0.8 的条目直接注入到每次 prompt 的系统提示中
- 权重 0.3-0.8 的条目在匹配 `operator_pattern` 时注入
- 权重 < 0.3 的条目仅在重试时注入

---

## 6. 实施路线图建议

### Phase 1: 脚手架（2-3 周）

| 模块 | 说明 |
|------|------|
| 配置解析 | 基于 YAML + CLI 覆写，直接复用现有设计 |
| 任务队列 | 基于 `multiprocessing` 的并发执行器 |
| 设备池 | 独占/共享模式，基础分配/回收 |
| 状态管理 | JSON 文件持久化，原子写入 |
| 评测沙箱 | pip 隔离，环境隔离 |

**里程碑**：能跑通单算子单轮生成 → 评测全过程

### Phase 2: 闭环反馈（3-4 周）

| 模块 | 说明 |
|------|------|
| 失败分类器 | 解析 kernel_eval 输出，分类失败原因 |
| Prompt 增强器 | 根据失败类别注入修复建议 |
| 重试控制器 | 自动重试 + 退避策略 |
| 简单基线 | 内存中的性能基线，基本对比 |

**里程碑**：能自动重试失败的算子，有可观测的效果提升

### Phase 3: 知识积累（2-3 周）

| 模块 | 说明 |
|------|------|
| Knowledge Base | 文件系统或 SQLite 存储 |
| 负面示例库 | 自动从失败记录中提取 |
| 跨算子学习 | 从同类算子中提取通用模式 |
| 性能基线持久化 | 跨运行的基线管理 |

**里程碑**：同类型算子第二轮生成时，首次成功率明显提升

### Phase 4: 高级优化（持续）

| 模块 | 说明 |
|------|------|
| 异构生成器融合 | 同时启动多个生成器，取最优 |
| 搜索式调优 | 对 tiling 参数做网格搜索 |
| 自动融合探索 | 识别相邻算子，尝试融合 |
| Profile 引导优化 | 解析 profiler 输出，定向优化 |
| Dashboard | 实时可视化运行状态和历史趋势 |

---

## 附录 A：与现有流水线的对比

| 维度 | 现有流水线 | 新 Harness |
|------|-----------|-----------|
| 生成策略 | 一次生成，失败即止 | 闭环反馈，多轮迭代 |
| 性能优化 | Stage 7 纯 LLM 内部调优 | Profile 引导 + 搜索 + 基线对比 |
| 知识复用 | 无跨算子学习 | Knowledge Base + 负面示例库 |
| 错误处理 | 统一 exception_entry | 结构化分类 + 定向修复 |
| 可观测性 | CLI monitor + JSON 日志 | Dashboard + 结构化事件流 |
| 扩展性 | 可插拔生成器 | 可插拔生成器 + 可插拔反馈策略 |
| 产物管理 | 单版本，覆盖模式 | 多版本，基线管理，Git 追踪 |

## 附录 B：关键设计决策记录

| 决策 | 选项 | 推荐 | 理由 |
|------|------|------|------|
| 状态存储 | JSON / SQLite | SQLite | 支持复杂查询，WAL 模式支持并发，不需要额外依赖 |
| 进程隔离 | multiprocessing / 容器 | multiprocessing（Phase 1）→ 容器（Phase 4） | 渐进式，初期不增加运维复杂度 |
| 反馈策略 | 内置规则 / LLM 判断 | 混合：规则分类 + LLM 增强 | 分类需要确定性，增强需要灵活性 |
| 基线存储 | 内存 / 文件 / 数据库 | SQLite | 持久化 + 查询能力，轻量级 |
| 生成器间通信 | 共享文件 / 消息队列 | 共享文件（Phase 1-2） | 简单可靠，满足初期需求 |

---

> **文档版本**: v1.0  
> **基于代码库**: `auto_pipeline` (commit-level analysis)  
> **适用场景**: CANN 算子自动生成 + 评测的完整 harness 设计