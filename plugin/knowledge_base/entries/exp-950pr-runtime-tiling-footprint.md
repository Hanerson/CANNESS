---
{
  "schema_version": 1,
  "id": "exp-950pr-runtime-tiling-footprint",
  "title": "Exp 的 tile 按张量足迹与 UB 容量选：8MiB/64MiB 两个阈值，输入走 L2 bypass",
  "kind": "implementation",
  "operator": "Exp",
  "hardware": ["950pr"],
  "dtypes": ["float16", "float32", "bfloat16"],
  "keywords": ["tileElems", "UB", "AIV core", "aclrtGetDeviceInfo", "L2 bypass", "8MiB", "64MiB", "blockLength", "尾块"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/ops/exp/op_plugin/exp_plugin.cpp#L126-L157",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/ops/exp/op_kernel/exp_kernel.cpp#L119-L157",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    }
  ]
}
---

**适用条件**：950PR 上的 Exp，元素数 n>0，运行时可查询 AIV 核数与 UB 字节数时。

**结论**：host 先查 `ACL_DEV_ATTR_VECTOR_CORE_NUM` 与 `ACL_DEV_ATTR_LOCAL_MEM_PER_VECTOR_CORE`，按核数把 n 均分成 `blockLength`，再按 512 字节对齐并向上取整；然后按张量字节数选 tile：≤8MiB 时 n≤1Mi 选 4096，否则 8192；≤64MiB 时 f32 选 8192、16 位类型选 16384；更大时 f32 选 15360、16 位选 30720。tile 最终被 `UB/(4*elemBytes)` 的容量和 `blockLength` 夹住。输入用 `CACHE_MODE_DISABLE` 流式读，输出保持正常缓存；尾部用 `DataCopyPad` 处理非整 tile。

**核对方式**：读 `exp_plugin.cpp` 的 `desiredTile`/`capacityTile`/`tileElems` 计算；用 n=1M、8M、64M 的 f32 输入（4/32/256 MiB）核对 4096/8192/15360 三档，16 位类型在 8M/64M 期望 16384/30720；检查 kernel 的 `flags&1` 对输入设置 L2 cache hint，尾部走 `DataCopyPad`。
