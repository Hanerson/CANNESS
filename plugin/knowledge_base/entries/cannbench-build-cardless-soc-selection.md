---
{
  "schema_version": 1,
  "id": "cannbench-build-cardless-soc-selection",
  "title": "构建阶段不能查询 NPU 选 SoC：评测容器用空 ASCEND_RT_VISIBLE_DEVICES 跑 build.sh",
  "kind": "troubleshooting",
  "keywords": ["cardless", "ASCEND_RT_VISIBLE_DEVICES", "torch.npu.get_device_name", "soc.conf", "NPU_ARCH", "build.sh", "device fence", "SoC selection"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!build.sh#L5-L21",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    }
  ]
}
---

**适用条件**：CANNBench 的 `build.sh` 在评测 runner 的容器里执行，环境设置 `ASCEND_RT_VISIBLE_DEVICES=""`（设备隔离）；或本地构建机没有可见 NPU 时。

**结论**：不要在 build 阶段调用 `torch.npu.get_device_name(0)` / `npu-smi` 来自动探测 SoC。评测容器的设备隔离会让该调用必然失败，vendor 示例因此直接退出。可行做法是把 SoC 当配置：`NPU_ARCH=ascend950|ascend910b|ascend910_93`，或 `--soc=Ascend950PR_9579`，默认 `ascend950`；构建脚本只读配置/平台 ini，不碰 NPU。该 Exp 包在注释里明确「CARDLESS BY CONSTRUCTION」，并用 `tools/soc_probe.py` 在构建前生成 `csrc/common/cann_bench_platform.h`。

**核对方式**：读 `build.sh` 顶部注释与 `--soc=` 解析；在没有 NPU 的机器上执行 `ASCEND_RT_VISIBLE_DEVICES="" bash build.sh --soc=ascend950`，确认不因设备查询失败；检查 `cann_bench_platform.h` 是否由 `soc_probe.py` 生成，而不是由运行时设备名决定。
