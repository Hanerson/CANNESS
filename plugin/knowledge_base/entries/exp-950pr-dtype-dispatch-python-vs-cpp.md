---
{
  "schema_version": 1,
  "id": "exp-950pr-dtype-dispatch-python-vs-cpp",
  "title": "Exp 的 dtype 分派：top1 在 Python 按 dtype 加载 c1/c2/c3，top2 在 C++ 单注册",
  "kind": "implementation",
  "operator": "Exp",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16"],
  "keywords": ["dispatcher", "c1", "c2", "c3", "dtype dispatch", "_scalar_width", "_so_cache", "unsupported dtype", "ValueError"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/Exp.zip!cann_bench/exp/dispatcher.py#L12-L13",
      "sha256": "e14713e4518ffa1386d29d1afda3485ba502ae386dc9ce154da7aaf932cf8ed1"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top1/Exp.zip!cann_bench/exp/dispatcher.py#L38-L44",
      "sha256": "e14713e4518ffa1386d29d1afda3485ba502ae386dc9ce154da7aaf932cf8ed1"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/ops/exp/op_plugin/exp_plugin.cpp#L26-L29",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/ops/exp/op_plugin/exp_plugin.cpp#L82-L87",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    }
  ]
}
---

**适用条件**：从参考包选择 Exp 实现架构时；输入 dtype 确定，且需要决定「按 dtype 分文件」还是「单二进制内分派」。

**结论**：top1 是 Python 层分派：`_CLASSES = {'float16': 'c1', 'float32': 'c2', 'bfloat16': 'c3'}`，每次按 `x.dtype` 加载对应子目录的 `test_exp.py`，命中后缓存；dtype 不在表里直接 `ValueError`，不会静默回退。加载前安装 `_scalar_width` 与 `_so_cache` 两个运行时 shim。top2 是 C++ 单注册：`TORCH_LIBRARY_FRAGMENT` 只定义一次 `exp`，`exp_npu` 内用 `TORCH_CHECK` 限制 f32/f16/bf16，launch 再按 dtype code 选模板实例。前者适合三份独立 kernel/调优，后者适合一份 kernel 模板覆盖三种 dtype；两者都必须对不支持的 dtype 显式报错。

**核对方式**：读 top1 `dispatcher.py` 的 `_CLASSES` 与 `_load`，确认 c1/c2/c3 目录都存在；读 top2 `exp_plugin.cpp` 的 `m.def` 与 `exp_npu` 的 dtype 检查；用 fp64 输入分别验证 ValueError/TORCH_CHECK，而不是返回错误结果。
