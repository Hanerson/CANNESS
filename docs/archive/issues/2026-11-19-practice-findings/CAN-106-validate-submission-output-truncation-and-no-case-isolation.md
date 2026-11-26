# CAN-106 `validate_submission` 只保留末尾 4 KB 输出、且无 case 隔离

| 字段 | 值 |
|---|---|
| 类型 | design |
| 优先级 | P1 |
| 组件 | `remote/validate_submission.py`、`submission-validation.ts`、test script 契约 |
| 首次发现 | 2026-11-19 09:31（第一个多 shape 校验脚本被设备异常打断） |
| 状态 | 已绕过（每个 case 起子进程），插件未提供 |
| 标签 | `diagnostics`, `device-fault`, `output` |

## 现象

`validate_submission({test_script})` 把我的脚本当**一个进程**跑：脚本里第 4 个 case
触发 vector core 异常后，同进程后续所有 case 全部失败（`AclrtSynchronizeDeviceWithTimeout`,
error 507035），我拿到的唯一结论是"test must emit exactly one CANNESS_VALIDATION JSON
object with ok:true"，而**前面哪些 case 通过**已经被截断掉了：

```text
steps[].output = text[-4000:]   # validate_submission.py::read_command_output / run()
```

即：越界/异常时最有价值的信息（"在第几个 case 上炸的、之前哪些是好的"）刚好被丢在最前面。

## 证据

- `remote/validate_submission.py`：`read_command_output()` 限 8 MiB，
  `output.seek(max(0, size - 16000))` 只回传尾部；`run()` 里
  `report['steps'].append({'step': name, 'code': …, 'output': text[-4000:]})`；
- 设备异常会毒化进程：`vector core exception` 之后同一进程内所有后续 kernel 都 507035
  （我实测：第一个坏 case 之后 10 个 case 全部同样报错）。

## 影响

- 一次多 shape 校验最多只能"二分"出一个坏 case，成本变成 O(n) 轮；
- 我用"每 case 一个 `subprocess.run([sys.executable, '-c', ...])`"绕过后，
  一次就能拿到 17 个 case 的完整结论 —— 这说明隔离应该在插件侧，而不是每个用户自己写；
- 另外：test script 必须是**单文件自包含**（没有 fixture 目录、没有依赖注入），
  且不能用相对路径 import 本地模块，稍微复杂一点的校验就要靠字符串拼 Python 源码。

## 我用的临时补丁

`tools/validate_cases.py`：

```python
for shape, dim, dtype in CASES:
    proc = subprocess.run([sys.executable, "-c", CHILD % case], capture_output=True)
    # 父进程汇总 CHILD_DATA 行；子进程崩溃只影响这一条
```

子进程里在**每个 case 之前** `print("CASE …", flush=True)`，这样即使整进程被杀，
"最后一个 CASE 行"就是崩点。

## 建议修复

1. `test_script` 支持"每 case 子进程"模式（或允许脚本返回结构化的 per-case 列表，
   插件负责切分/隔离）；
2. `steps[].output` 保留全量到远端文件并在 report 里给路径（配合 CAN-109 的 fetch），
   而不是截 4 KB；
3. 允许 `test_script` 附带 `extra_files`（fixtures、参考向量），当前只能塞进一个字符串；
4. 设备异常时在 report 里明确标记"该 case 之后的结果不可信"，避免把毒化结果当结论。

## 验收标准

- 一个 20 case 的校验脚本，其中第 7 个 case 故意触发设备异常，report 仍能给出
  1–6 的结论且指明 7 崩、8–20 未执行；
- test script 可以引用同目录的 fixture 文件。
