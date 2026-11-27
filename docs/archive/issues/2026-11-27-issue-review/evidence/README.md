# 复核证据

- `preflight.json` 记录修复前的两端 runner 预检。宿主机私有主目录路径以 `<remote-home>` 表示。
- `op-summary.csv` 投影一份已有 ApplyRotaryPosEmb 性能记录的三列。24 行均为 `canness_kernel`，去掉 4 行预热后平均为 1653.454 µs。
- `validation-output-limit.py` 是 CAN-223 的本地边界对照。以 CANNESS 仓库根为 cwd 执行，会打印短日志及超限日志的分类结果。
- preflight-after.json 是修复后已验证的插件、宿主机及容器继承环境输出。
