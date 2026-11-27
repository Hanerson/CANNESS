# CANNESS 插件架构

CANNESS 以 `dsh-canness` bundle 接入 DeepSeek Harness。dsh 提供会话、模型路由、工具调度、Web UI 和凭据存储。CANNESS 管理算子规格、生成产物、评测与迭代策略。远端 Linux 昇腾主机执行 CANN 编译、精度检查和性能采集。

## 插件入口

- `canness` 挂载 Web 设置卡。
- `canness-knowledge` 根据任务条件检索知识库。条目携带适用范围与证据引用，详见[知识库设计](06-knowledge-base.md)。
- `canness-generator` 负责规格、四层源码、构建契约和 CANNBench 出包。
- `canness-eval` 负责本地包检查、远端工具链检查、SSH 评测和诊断文件下载。
- `canness-loop` 监听 dsh 的 `agent/pre-step` 和 `agent/turn-stopping`，将适当的诊断带入所属会话并决定是否续轮。
- `canness-remote` 在 dsh 的 `webServer` 上注册 TCP 探测和 CANNLab 连接路由。路由先校验请求来源与宿主会话凭据，再处理请求。

完整配置见 [profile 配置参考](../reference/configuration.md)，工具输入和产物见[工具参考](../reference/tools.md)。

## 工作区与产物

生成、评测和循环服务使用同一个工作区。默认工作区**就是会话工作目录**：产物直接落在该目录，不再嵌套 `canness-workspace/`；无法获取绝对会话目录时退到进程 cwd。工作区可以通过三个服务的 `workspace` 配置显式指定（相对路径按会话目录解析）。

> 为什么不再嵌套：Windows 沙箱的进程可写授权只落在会话工作区根（外加每会话私有 temp）上。嵌套目录在授权落地之前已存在时不会补到该授权，于是插件自身的文件写入成功、而 `bash`/`pwsh` 里的构建、拷贝、打包步骤被拒。产物回到根上后，这一类拒绝不再出现。详见[实践问题归档 CAN-001](../../docs/archive/issues/2026-11-18-cummin-practice/CAN-001-sandbox-acl-vs-policy.md)。

```text
<session cwd>/          ← 工作区即会话目录
├── .canness/state.json
├── operators/<generationId>/
├── packages/<generationId>/
├── submissions/<generationId>-<suffix>/
└── remote-files/
```

`state.json` 保存当前 generation、规格、预算计数、包指纹、待评测阶段和最近的报告。每个工作区有一份当前任务状态。需要并行处理独立任务时，可使用不同的会话目录或独立配置的工作区。

`operators/` 保存 kernel 和已提供的 host、API、plugin 源码，以及可选的 golden 和来源声明。构建工具将这些产物与测试驱动、编译脚本、配置和 manifest 打包到 `packages/`。默认 build 编译 kernel 和通用驱动，随包保留的其他源码列在 `documentedOnlyLayers`。本地预检与上传使用同一包指纹。支持的同形状算子可导出到 `submissions/`，再到目标环境构建 CANNBench wheel。

## 评测与续轮

评测服务确认当前包后，通过 SSH exec 上传并启动临时 runner。runner 编译包、执行精度检查和 `msprof`，将结果写入远端 outbox。CANNESS 解析报告并将当前包和待执行阶段写回工作区。传输中断可以在原工作区对同一包重试。报告和采样口径见[远端评测指南](../guides/remote-evaluation.md)。

重复评测由包指纹识别。相同包已有报告且没有待执行阶段时，工具复用报告并标记 `duplicate: true`。需要重测时使用 `force: true`，评测仍受停止规则约束。连续提交同名算子默认沿用预算和近期性能窗口。自动续轮需要新报告、匹配的会话归属和允许继续的预算状态。旧状态缺少归属时，在目标会话重新运行评测可明确归属。

## 来源记录

知识条目依据规格、源码观察、报告或复测记录给出证据状态。算子源码可通过 `write_operator.provenance` 声明来源，打包时记录文件散列，并跟踪同层文件与历史 generation 的重合度。CANNBench 导出包包含 `provenance.json`。评测报告里的 `runRecord` 保存环境、启动参数、采样信息和运行耗时。
