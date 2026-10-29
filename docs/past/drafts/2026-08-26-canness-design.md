# CANNESS 设计文档

> 多智能体的垂域软件开发系统 — CANN 算子优化专用 Harness

- **日期**: 2026-08-26
- **状态**: 设计确认
- **所属项目**: 南京大学大学生创新训练计划

## 1. 项目概述

CANNESS 是一个面向 **CANN 算子优化** 的专业化 CLI 工具。用户通过终端输入 `canness` 进入交互式开发状态，harness 自动理解用户需求，通过多智能体协作循环，自动生成或优化 CANN 算子代码，在昇腾算力环境（模力方舟 Ascend 910b）上验证，最终输出满足编译、精度、性能要求的算子。

### 目标

- 自动生成符合编译要求的 CANN 算子代码
- 在保证精度的前提下优化算子性能（latency / memory）
- 迭代次数可控，避免巨额 API 成本
- 支持用户自定义所有配置参数

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│                     CLI 入口                         │
│              canness [command]                       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  Orchestrator                        │
│           （迭代循环控制 + 停机判断）                  │
└──┬──────┬──────┬──────┬──────┬──────────────────────┘
   │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼
┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│需求 │ │代码 │ │测试 │ │性能 │ │配置 │
│分析 │ │生成 │ │执行 │ │分析 │ │管理 │
│Agent│ │Agent│ │Agent│ │Agent│ │模块 │
└────┘ └────┘ └────┘ └────┘ └────┘
                          │
                    ┌─────▼──────┐
                    │ 模力方舟    │
                    │ Ascend 910b │
                    └────────────┘
```

### 2.2 分层职责

| 层 | 职责 |
|------|------|
| **CLI 入口** | 命令解析、配置文件读写、初始化向导 |
| **Orchestrator** | 迭代循环的核心调度器，控制"生成→测试→分析→再生成"的流程，判断停机条件 |
| **Agent 层** | 每个智能体独立模块，标准输入/输出接口 |
| **配置管理** | 本地配置文件读写、设置向导、运行时参数覆盖 |
| **测试环境适配层** | 封装对模力方舟的连接，提供统一的"编译→运行→返回结果"接口 |

## 3. 智能体设计

### 3.1 需求分析器 (RequirementAnalyzer)

**职责**: 将用户的自然语言输入转化为结构化需求规格。

```python
class RequirementAnalyzer(Agent):
    async def analyze(self, user_input: str) -> RequirementSpec:
        ...
```

**输出**:
```python
@dataclass
class RequirementSpec:
    operator_type: str                # 算子类型，如 "MatMul", "Conv2D"
    optimization_target: str          # "latency" | "memory" | "balanced"
    constraints: dict                 # 精度、数据类型等约束
    original_code: str | None         # 用户提供的原始代码（可选）
    description: str                  # 用户原始需求描述
```

### 3.2 代码生成器 (CodeGenerator)

**职责**: 根据结构化需求生成 CANN 算子代码，并基于测试反馈持续优化。

```python
class CodeGenerator(Agent):
    async def generate(self, spec: RequirementSpec,
                       feedback: list[TestResult] | None = None) -> GeneratedCode:
        ...
```

**输出**:
```python
@dataclass
class GeneratedCode:
    source_code: str                  # 算子源代码
    compile_script: str               # 编译脚本
    metadata: dict                    # 版本号、生成策略等
```

- 第一次迭代: 根据 spec 从零生成
- 第 N 次迭代: 根据 spec + 前一次测试反馈生成优化版本

### 3.3 测试执行器 (TestExecutor)

**职责**: 将代码部署到昇腾环境，编译运行，返回结果。

```python
class TestExecutor(Agent):
    async def execute(self, code: GeneratedCode) -> TestResult:
        ...
```

**输出**:
```python
@dataclass
class TestResult:
    iteration: int
    compile_success: bool
    compile_error: str | None
    precision_pass: bool
    precision_metrics: dict
    latency_ms: float | None
    memory_mb: float | None
    raw_output: str
```

**关键规则**: 编译不通过 → 不算一次有效迭代，直接返回给 CodeGenerator 修复。

### 3.4 性能分析器 (PerformanceAnalyzer)

**职责**: 分析测试结果，生成结构化的优化建议反馈给 CodeGenerator。

```python
class PerformanceAnalyzer(Agent):
    async def analyze(self, result: TestResult,
                      history: list[TestResult]) -> AnalysisFeedback:
        ...
```

**输出**:
```python
@dataclass
class AnalysisFeedback:
    issues: list[str]
    suggestions: list[str]
    improvement_ratio: float
    should_stop: bool
```

## 4. 迭代控制 (Orchestrator)

### 4.1 主循环

```
用户输入需求
    │
    ▼
[需求分析器] → 结构化 spec
    │
    ▼
┌──────────────────────────────────────────────┐
│  for i in range(max_iterations):             │
│    ▼                                         │
│  [代码生成器] → 生成/优化代码                   │
│    ▼                                         │
│  [测试执行器] → 编译 → 运行                    │
│    │                                          │
│    ├─ 编译失败 → 不算迭代次数 → 重试            │
│    ├─ 精度不达标 → 记录结果 → 继续迭代          │
│    └─ 编译+精度通过 → 算一次有效迭代 → 分析性能  │
│    ▼                                         │
│  [性能分析器] → 分析结果 → 生成反馈             │
│    ▼                                         │
│  [迭代控制器] → 判断是否停机                    │
│    │                                          │
│    ├─ 到达 max_iterations → 停机              │
│    ├─ 收敛（提升<阈值×连续N次）→ 停机           │
│    ├─ 连续负增长 → 停机                       │
│    └─ 否则 → 继续循环                          │
└──────────────────────────────────────────────┘
    │
    ▼
输出迭代历史中最好的算子代码
```

### 4.2 停机条件

```python
def should_stop(history: list[TestResult], iteration: int,
                max_iterations: int) -> StopReason:
    # 条件1: 达到用户指定的最大迭代次数
    if iteration >= max_iterations:
        return StopReason.MAX_ITERATIONS

    # 条件2: 连续负增长（优化反而变差）
    recent = history[-3:]
    if len(recent) >= 3 and all(r.regression for r in recent[-3:]):
        return StopReason.NEGATIVE_STREAK

    # 条件3: 收敛（提升幅度 < 阈值，连续多次）
    if len(history) >= 3:
        improvements = [history[i].improvement for i in range(-3, 0)]
        if all(imp < convergence_threshold for imp in improvements):
            return StopReason.CONVERGED

    return StopReason.CONTINUE
```

### 4.3 通知策略

- 每次有效迭代完成 → 通知用户当前结果（latency、精度、相比上次提升）
- 编译失败 → 静默重试，不打扰用户
- 停机时 → 展示迭代历史摘要，输出最优算子
- 用户可随时 Ctrl+C 中断，输出当前最优结果

## 5. 配置管理

### 5.1 设计原则

- 所有参数用户可自定义，工具只提供推荐值
- 首次启动时显示设置向导引导用户完成配置
- 通过 `canness config` 命令随时修改
- 配置保存在 `~/.canness/config.yaml`，用户可手工编辑

### 5.2 配置结构

```yaml
# ~/.canness/config.yaml

llm:
  api_key: ""                    # 必填
  api_base: ""                   # 可选，默认使用模型厂商 API
  model: "claude-3.5-sonnet"     # 推荐值

iteration:
  max_iterations: 10             # 推荐值
  convergence_threshold: 0.05    # 推荐值，提升低于 5% 视为收敛
  negative_streak_limit: 3       # 推荐值，连续负增长次数

optimization:
  primary: "latency"             # latency | memory | precision
  secondary: "memory"
  tertiary: ""

test_env:
  platform: "moark"              # 模力方舟
  instance_type: "ascend-910b"
```

### 5.3 CLI 命令

```
canness                         # 首次启动进入设置向导，后续进入交互模式
canness run "需求描述"           # 运行一次优化任务
canness run "需求描述" --iterations 20 --target memory  # 运行时覆盖配置
canness config                  # 查看当前配置
canness config edit             # 重新进入设置向导
canness config show             # 打印当前配置
canness config set key value    # 快速修改单项
```

## 6. 项目结构

```
CANNESS/
├── CANNess/                 # 主源代码
│   ├── __init__.py
│   ├── main.py              # CLI 入口
│   ├── agents/              # 智能体定义
│   │   ├── __init__.py
│   │   ├── base.py          # Agent 基类
│   │   ├── requirement_analyzer.py
│   │   ├── code_generator.py
│   │   ├── test_executor.py
│   │   └── performance_analyzer.py
│   ├── orchestrator/        # 编排逻辑
│   │   ├── __init__.py
│   │   ├── engine.py        # 迭代主循环
│   │   └── stop_condition.py # 停机判断
│   ├── core/                # 核心框架
│   │   ├── __init__.py
│   │   ├── config.py        # 配置管理
│   │   ├── models.py        # 数据模型定义
│   │   └── llm.py           # LLM 调用封装
│   └── tools/               # 工具函数
│       ├── __init__.py
│       └── ...
├── targetWorkspace/         # 生成的算子代码输出
├── tests/                   # 测试
├── docs/                    # 文档
├── CLAUDE.md                # 编码准则
└── log.md                   # 编码日志
```

## 7. 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | Python 3.12+ |
| CLI 框架 | argparse / click / typer |
| LLM 调用 | OpenAI SDK（兼容模力方舟 API） |
| 配置管理 | PyYAML |
| 异步支持 | asyncio |
| 测试 | pytest |
| 代码格式化 | ruff / black |

## 8. 错误处理与容错

- 智能体间通信设超时和重试机制
- 编译失败不计入迭代次数，自动重试
- LLM 调用失败时自动重试（指数退避）
- 用户可随时 Ctrl+C 中断，保留当前最优结果
- 所有智能体输出结构化日志，便于调试

## 9. 迭代计划（建议）

| 阶段 | 内容 | 预估 |
|------|------|------|
| **Phase 1** | 核心框架：CLI 入口、配置管理、数据模型、LLM 封装 | 基础 |
| **Phase 2** | 智能体实现：需求分析器、代码生成器、性能分析器 | 核心 |
| **Phase 3** | 测试执行器 + 模力方舟对接 | 验证 |
| **Phase 4** | Orchestrator 迭代循环 + 停机条件 | 闭环 |
| **Phase 5** | 打磨：错误处理、用户体验、测试覆盖 | 完善 |