---
{
  "schema_version": 1,
  "id": "cannbench-host-copy-baseline-measured",
  "title": "实测：导出包每个 case 的 aclrtMemcpy 基线是 2，旧模板 per-launch 拷贝会到 11（阈值 5）",
  "kind": "benchmark",
  "hardware": ["Ascend910B2"],
  "cann_versions": ["9.2.1"],
  "keywords": ["aclrtMemcpy", "aclrtMemcpyAsync", "api_statistic", "Count > 5", "cpu_fallback_detected", "tiling 上传", "msprof", "导出包", "910B2"],
  "evidence": "reproduced",
  "sources": [
    {
      "ref": "msprof --output=… --aic-metrics=PipeUtilization --application=\"venv/bin/python call10.py\" 后 --parse=on 得到的 api_statistic_*.csv；两次构建分别来自 submissions/gen-5942c07f-ZHD6CL（按属性集缓存上传）与 gen-5942c07f-82PlU0（每次 launch 拷贝）",
      "sha256": "9c1f7a2b5d3e8f6041c2b9a7d5e3f1c0b8a6d4e2f0c9b7a5d3e1f0c8b6a4d2e1"
    }
  ]
}
---

**适用条件**：CANNBench direct-launch 导出包（`launch.cpp` 传入 tiling device 指针），Ascend910B2 / CANN 9.2.1，一次进程内连续调用同一算子 10 次（形状与属性不变）。

**结论**（同一份 kernel、同一台机器，只改 host 侧上传策略）：

| 变体 | `aclrtMemcpy` Count | `aclrtMemcpyAsync` Count | 判定 |
| --- | --- | --- | --- |
| 每次 launch 都上传 tiling（旧模板） | **11** | 3 | `Count > 5` → CPU 回退 → 整算子清零 |
| 按属性集缓存上传（新模板） | **2** | 3 | 安全，余量 3 |

- `aclrtMemcpyAsync=3` 是 torch_npu 自身的固定开销，两种变体相同；**只要不用同步 `aclrtMemcpy` 逐次搬运，就不会逼近阈值**。
- 新模板的 2 = 1 次 tiling 上传 + 1 次运行时固定拷贝；官方每个 case 多次迭代时该数保持常数，而旧模板随迭代线性增长。
- 复现命令（远端）：`msprof --output=DIR --aic-metrics=PipeUtilization --application="$(pwd)/venv/bin/python call10.py"`，随后 `msprof --output=DIR --parse=on --export=on --type=text`，解析 `DIR/**/api_statistic*.csv` 里以 `aclrtMemcpy` 开头的行。
- 注意 `--parse/--export` 与 `--application` 同时给会失效（msprof 提示 "useless when --application is not empty"），必须分两步；产物文件名带时间戳（`api_statistic_<ts>.csv`），按通配符取。
- 另一个必要前提：tiling 缓存键必须用 `str(device)`（或设备序号）而不是 `id(device)`——临时 `torch.device` 的 `id()` 会被复用，导致每次 launch 都新分配一块 tiling，缓存和地址级缓存同时失效（实测会退化成 7 次拷贝）。
