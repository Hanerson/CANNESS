# CAN-020 `validate_submission` 不继承 runner 的设备/锁配置：共享 devspace 上把"环境占用"报成 kernel 崩溃

> 去重：本条扩展既有 **CAN-106**（validate_submission 输出截断 / 无 case 隔离），新增「设备与锁未继承 runner」维度；建议作为 CAN-106 的第二组验收标准。

| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P1** |
| 组件 | `canness-eval`（`validate_submission` → `remote/validate_submission.py`） |
| 首次发现 | 2026-11-25，ApplyRotaryPosEmb 导出包验证连续 3 次 `failed` |
| 状态 | **open**（用户侧 workaround：在 test script 里 `os.environ["ASCEND_VISIBLE_DEVICES"]="7"`） |
| 标签 | `validate`, `device`, `flock`, `false-positive` |

## 现象

同一份 wheel、同一台机器：

- `validate_submission` → `failed`，设备报
  `The GM address accessed by scalar exceeds 48 bits` / `aivec error` / `vector core exception`；
- 把同一份源码用 `bash build.sh` 手工构建、在 `ASCEND_VISIBLE_DEVICES=7` 下用同一套
  `probe_all.py` 跑 → **14/14 组合全部通过**；
- 最终让 `validate_submission` 通过的办法是：在 **test script 开头**（import torch 前）设
  `ASCEND_VISIBLE_DEVICES=7` / `ASCEND_RT_VISIBLE_DEVICES=7`。

关键差异：`run_evaluation` 的 runner 会 `export ASCEND_VISIBLE_DEVICES=<device-id>` 并且用
`flock <device>.lock` 串行化（`remote/runner.py: shell_env_prefix` / `run_command`），
而 `remote/validate_submission.py` **既不设设备也不加锁**，于是在这块 8 die 的共享
devspace 上落到了别的会话正在用的 die。

## 影响

- 失败形态与真实的 kernel 崩溃（越界、UB 溢出）完全一样，**无法区分**；
- 本轮我据此误判了两次（先怀疑 UB 溢出、又怀疑 tile 路径在 fp32 上崩），把 1 个多小时的
  定位花在"其实是环境"的方向上；
- 更严重的是：`validate_submission` 的结论被当作"提交物是否可用"的唯一门禁，误报会让
  正确的包被判死。

## 期望

1. `validate_submission` 复用 runner 的设备解析（`--device-id` 默认同 `canness-eval.device`）
   与 `flock` 锁文件，沿用同一套 `shell_env_prefix`；
2. 报告里区分三类失败：`device_unavailable` / `device_fault`（真的崩了）/ `build` /
   `install` / `assert`；设备类失败不要写成 `failed`，应写 `blocked` 并给出 device id；
3. test script 的运行环境里注入 `ASCEND_VISIBLE_DEVICES`，不要依赖用户脚本自己设。

## 复现

1. 在共享 devspace（多 die、有其它会话占用）上 `validate_submission(...)`（不带设备参数）；
2. 观察 stderr 出现 `vector core exception` / `GM address ... exceeds 48 bits`；
3. 同一份 source 手工在 die 7 上跑 → 通过；
4. 在 test script 里 pin die 7 → `validate_submission` 返回 `validated`。

## 建议修复

- `validate_submission.py` 增加 `--device-id`（默认取配置），并在命令前缀里
  `source set_env.sh; export ASCEND_VISIBLE_DEVICES=<id>; flock <lock> …`，与 runner 保持一致；
- 失败分类：把 `aclrtSynchronize*`/`vector core exception` 识别为 `device_fault`，
  把 "no visible device"/"device busy" 识别为 `device_unavailable`；
- 报告 `steps` 里带上设备 id 与锁路径，便于回溯。

## 验收标准

- 同一包在共享 devspace 上连续 3 次 `validate_submission` 结果一致（不因别的会话而失败）；
- 人为占用 die 7 时，报告是 `blocked/device_unavailable` 而不是 `failed`；
- 真 kernel 崩溃仍能被识别为 `device_fault` 并附最小复现信息。

## 关联

CAN-011（导出物从未被验证）、CAN-005（远端探测能力）
