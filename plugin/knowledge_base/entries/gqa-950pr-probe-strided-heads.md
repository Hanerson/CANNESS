---
{
  "schema_version": 1,
  "id": "gqa-950pr-probe-strided-heads",
  "title": "GQA probe 的 strided 用例：先分配 2 倍 head 再隔列切片，设备端要重建同样的物理 stride",
  "kind": "contract",
  "operator": "GQA",
  "hardware": ["950pr"],
  "dtypes": ["float16", "bfloat16"],
  "layouts": ["contiguous", "strided"],
  "keywords": ["probe", "strided", "stride(2)", "head stride", "physical stride", "device transfer", "scaled mode", "zero mode"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/GQA.zip!checks/probe.py#L31-L45",
      "sha256": "fcb9f3a41630fd3ad18cdd9a36f6c4948e7b33838658fc880937299bddc5b430"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/GQA.zip!checks/probe.py#L54-L61",
      "sha256": "fcb9f3a41630fd3ad18cdd9a36f6c4948e7b33838658fc880937299bddc5b430"
    }
  ]
}
---

**适用条件**：GQA 的 probe/性能用例（`checks/probe.py`）在 `strided=True` 时；或候选实现接收来自 slice 的非标准 head stride 输入时。

**结论**：strided 输入不是简单的 `.contiguous()` 反面：probe 先分配 `[..., nq*2, D]`，再取 `[:, :, ::2, :]`，使 head 维 stride 翻倍；`scaled` 模式还把 q 乘 0.0625、k 乘 4、v 乘 0.25，并把 `scaleValue` 从默认 -1 改成 0.125。搬到设备时 probe 不依赖普通 `.npu()` 保留这个物理 stride：它重新构造 2 倍 head 的 buffer、写入后再 `[..., ::2, :]` 切片，并断言 `stride(2)==2*D`。候选 kernel/plugin 若先对输入做 `.contiguous()`，就会悄悄把 strided 用例变成 contiguous 用例，测不到真实布局；若按 `stride(2)==D` 写死寻址，则读到错位数据。

**核对方式**：读 `probe.py` 的 `inputs()` 与 `device()`；打印 `q.stride()`，确认 `stride(2)==2*D` 且 `is_contiguous()==False`；用同一数值的 strided/contiguous 两份输入对比输出，确认 kernel 按实际 stride 寻址。
