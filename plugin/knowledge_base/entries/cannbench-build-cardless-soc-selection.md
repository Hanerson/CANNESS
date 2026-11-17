---
{
  "schema_version": 1,
  "id": "cannbench-build-cardless-soc-selection",
  "title": "构建阶段不能查询 NPU 选 SoC：--arch 选架构族，--soc 指定具体平台 ini",
  "kind": "troubleshooting",
  "keywords": ["cardless", "ASCEND_RT_VISIBLE_DEVICES", "torch.npu.get_device_name", "soc.conf", "NPU_ARCH", "--arch=ascend950", "--soc=Ascend950PR_9579", "CANN_BENCH_SOC", "ascend950.ini", "build.sh", "device fence", "SoC selection"],
  "evidence": "source_inspection",
  "sources": [
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!build.sh#L5-L21",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!build.sh#L31-L41",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!tools/soc_probe.py#L84-L160",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    },
    {
      "ref": "ref/season1-950PR/season1-950PR-top2/Exp.zip!csrc/common/cann_bench_platform.json#L1-L14",
      "sha256": "8b8d687f77eff5d2886de0be98fdb39549f8f43bc70694cb8ebc96ade2b31ffa"
    }
  ]
}
---

**适用条件**：CANNBench 的 `build.sh` 在评测 runner 的容器里执行，环境设置 `ASCEND_RT_VISIBLE_DEVICES=""`（设备隔离）；或本地构建机没有可见 NPU 时。

**结论**：不要在 build 阶段调用 `torch.npu.get_device_name(0)` / `npu-smi` 来自动探测 SoC。评测容器的设备隔离会让该调用必然失败，vendor 示例因此直接退出。可行做法是把 SoC 当配置，但要区分两个参数：`--arch=ascend950` 设置架构族 `NPU_ARCH`（默认 `ascend950`，用于 `Ascend950PR_*.ini` 族匹配和 bisheng `--npu-arch`）；`--soc=Ascend950PR_9579` 设置具体平台的 `CANN_BENCH_SOC`（对应 `platform_config/Ascend950PR_9579.ini`）。`--soc=ascend950` 不是 ini basename，`soc_probe.py` 会去找不存在的 `ascend950.ini`，然后依次回退到 `soc.conf`、随包 sidecar、该架构族所有 ini 的最小值（family MIN，会选到族里最小 die）或 FALLBACK；这可能静默按族内最小 die（例如 4 核）而不是实际 28/36 核构建。该 Exp 包在注释里明确「CARDLESS BY CONSTRUCTION」，构建前用 `tools/soc_probe.py` 生成 `csrc/common/cann_bench_platform.h`，全程不碰 NPU。

**核对方式**：读 `build.sh` 的参数解析与 `tools/soc_probe.py` 的 SoC 解析顺序；在没有 NPU 的机器上执行 `ASCEND_RT_VISIBLE_DEVICES="" bash build.sh --arch=ascend950 --soc=Ascend950PR_9579`，确认不因设备查询失败；检查生成的 `csrc/common/cann_bench_platform.h` 的 `CANN_BENCH_SOC_NAME`/`ai_core_cnt` 是否符合预期（该包 sidecar 为 `Ascend950PR_9599` / `ai_core_cnt=36`，以包内 `csrc/common/cann_bench_platform.json` 为准）；查看 `soc_probe` 的 notes 是否采用 `$CANN_BENCH_SOC`；再试 `--soc=ascend950`，应看到 `ascend950.ini` 不存在并回退的警告。
