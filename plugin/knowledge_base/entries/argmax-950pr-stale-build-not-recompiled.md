---
{
  "schema_version": 1,
  "id": "argmax-950pr-stale-build-not-recompiled",
  "title": "改动 kernel 后必须删除 build 目录：增量 cmake 不会重编 kernel，能产出与旧源码相同字节的库",
  "kind": "implementation",
  "operator": "ArgMax",
  "hardware": ["950pr"],
  "keywords": ["rm -rf build dist", "增量编译", "stale build", "bit-identical library", "build.sh --soc=ascend950", "dav-3510", "缓存命中", "编出来的库没变化"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/ArgMax.zip!build.sh#L55-L58",
      "sha256": "41770bf8d9be241320092c5f56ca3ffac092301e7868b8cbe7675acdd34bfc55"
    }
  ]
}
---

**适用条件**：在 950PR 上用 cmake 驱动的 CANNBench 提交包（`./build.sh --soc=ascend950`，`ascend950` 映射到 bisheng `--npu-arch=dav-3510`）反复迭代 kernel 时。

**结论**：改动 `op_kernel` 后不能复用已有 `build/`。该包的构建入口在编译前无条件执行 `rm -rf build dist`，注释给出的理由是「增量 cmake 不会重新编译被修改的 kernel —— 一个陈旧的 build 目录曾经用已改动的源码产出过字节完全相同的库」。这种现象会让「改了很多轮、耗时一点不动」看起来像算法没有效果，实际只是测到了旧产物；先怀疑构建缓存，再怀疑算法。同一个包还把 24 个文件写进 `SHA256SUMS`，因此每次构建后可以用散列确认产物真的变了，而不是靠时间戳。

**核对方式**：读 `build.sh` 中 `rm -rf build dist` 前后的注释；对比 `SHA256SUMS` 与本次 `dist/` 产物的散列；若要复用缓存，至少确认 kernel 目标文件的 mtime 与散列都发生变化。
