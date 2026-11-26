# CAN-101 契约模板 `build.sh` 是 CRLF：生成的包在 Linux 上 100% 编译失败

| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P0（阻塞全部评测）** |
| 组件 | `canness-generator` / `package-files.ts` / `templates/build-contract/build.sh` |
| 首次发现 | 2026-11-19 09:25，SwiGlu 第一次 `run_evaluation({compile_only:true})` |
| 状态 | 已打补丁（模板改 LF），根因未修 |
| 标签 | `build`, `windows`, `line-endings` |

## 现象

第一次 `run_evaluation({compile_only: true})` 直接返回 `compile_fail`，编译日志只有一行：

```text
/tmp/canness/inbox/gen-aa5bc51e-compile-8ef65dfc/.contract-selfcheck/build.sh: line 9: set: pipefail
: invalid option name
/tmp/.../build.sh: line 9 是 `set -euo pipefail`
```

不是自检脚本写错，是**行尾**：模板被 Windows checkout 成了 CRLF，`\r` 粘在
变量名后面，bash 把 `pipefail\r` 当成非法选项。

## 证据

```powershell
# 插件模板
build.sh:                     lf=52  crlf=52      <-- 全部 CRLF
main.cpp:                     lf=498 crlf=498
canness_tiling.h:             lf=92  crlf=92
run_once.sh:                  lf=27  crlf=0       <-- 这个恰好是 LF（所以没人早发现）
canness_tiling_host.h:        lf=64  crlf=0
# 生成出的包
packages/gen-aa5bc51e/build.sh:                crlf=52
packages/gen-aa5bc51e/.contract-selfcheck/build.sh: crlf=52
```

## 根因

`package-files.ts::templateBody()` 直接 `readFileSync(...)` 后渲染，**不做行尾归一**；
而同一插件的 `submission.ts::render()` 明确做了 `.replace(/\r\n/g, '\n')`。
两份渲染路径不对称，于是"测试包"这条路径继承了 Windows 工作树的行尾。

`run_once.sh` 恰好是 LF 纯属运气（那两个文件的 checkout 状态不同），
意味着同一批模板里行尾是**混合**的 —— 换个模板文件被改，问题会以不同面貌复现。

## 影响

- 任何在 Windows 工作树上生成的包都无法在 Linux 目标机编译 → 整条评测链路 0 产出；
- 因为它同时命中 `.contract-selfcheck`，报错文案是
  `contract template itself broken: minimal kernel did not compile`，
  很容易被误读成"我的 kernel 有问题"，实际与算子无关；
- 本轮因此白跑 1 次 compile-only（好在 compile-only 不占额度）。

## 我用的临时补丁

把 `D:/projects/CANNESS/plugin/templates/build-contract/build.sh` 重写为 LF
（`[System.IO.File]::WriteAllText($p, $t.Replace("\r\n","\n"))`），
之后 `build_test_package()` 重新渲染即恢复正常。

## 建议修复

1. `templateBody()` 与 `render()` 统一走一个 `normalizeEol()`；
2. `build_test_package` 在写盘前断言：所有 `.sh` 不含 `\r`（一行 `includes('\r')` 即报错）；
3. `plugin/tests/package-files.test.ts` 增加"生成包脚本必须 LF"的断言，
   并用**故意 CRLF 的 fixture 模板**覆盖它（否则在 Linux CI 上永远不触发）。

## 验收标准

- 在 CRLF 工作树上生成包，`packages/<gen>/build.sh` 与 `.contract-selfcheck/build.sh` 均无 `\r`；
- 该断言有单测覆盖，且在 Windows 与 Linux 两种 checkout 下都通过。
