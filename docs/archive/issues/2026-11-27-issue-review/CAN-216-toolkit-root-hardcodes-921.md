# CAN-216 `readRoots` 对目录名 `cann-9.2.1` 有特判

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P2** |
| 组件 | `plugin/src/eval.ts` 的 `toolkitRoots` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `readRoots`, `cann-version` |
| 复核 | 2026-11-27。收窄到自定义前缀和深层脚本；标准安装已有默认根 |

## 现象

配置了 `setEnv` 时，插件从该路径推导一个可读的工具链根，供 `fetch_remote_file` 读取头文件。推导在「去掉文件名之后，最后一级目录正好叫 `cann-9.2.1`」时再向上剥一层。其它版本名不会剥。更深的 `set_env.sh`（例如 `cann-9.2.1/share/info/ascendnpu-ir/bin/set_env.sh`）会停在更深的一级。

标准安装已经把 `/usr/local/Ascend` 放进默认 `readRoots`。特判主要影响自定义安装前缀，以及环境脚本位于工具链根以下多层目录的情况。标准安装不依赖这条特判才能读到默认根。

## 证据

- `plugin/src/eval.ts` 第 327–333 行：

```ts
function toolkitRoots(setEnv: string): string[] {
  if (!setEnv.startsWith('/') || setEnv.endsWith('/')) return []
  const parts = setEnv.split('/').filter(Boolean)
  if (parts.length < 3) return []
  parts.pop()
  if (parts[parts.length - 1] === 'cann-9.2.1') parts.pop()
  return ['/' + parts.join('/')]
}
```

- 容器里还有 `/usr/local/Ascend/cann-9.2.1/share/info/ascendnpu-ir/bin/set_env.sh`。按上面的函数，推导根停在 `.../ascendnpu-ir/bin`。
- 同文件默认仍把 `/usr/local/Ascend` 放进 `readRoots`（`snapshot` 里与 `toolkitRoots` 拼接）。标准安装的读取根来自这个默认值。
- `plugin/tests/practice-policy.test.ts` 用 `/usr/local/Ascend/cann-9.2.1/compiler/...` 做允许用例，但测试显式传入 `/usr/local/Ascend`，只覆盖读取允许根，未覆盖 `toolkitRoots` 推导。

## 影响

自定义前缀或深层 `set_env.sh` 上，推导出的可读范围可能停在错误的一级。标准安装上的 `/usr/local/Ascend` 默认根仍然可用。版本号写进特判后，下一次目录名变化要改插件代码，影响的是推导范围。

## 期望

从 `set_env.sh` 向上找，直到某一级同时像工具链根（存在 `bin/bisheng` 或 `version.info`），把那一级放进 `readRoots`。找不到就不要猜，并在预检里说明推导范围。默认 `/usr/local/Ascend` 可以保留。

## 复现

1. 令 `setEnv = /opt/ascend/cann-8.0.1/set_env.sh`，看推导根停在哪一级。当前实现得到 `/opt/ascend/cann-8.0.1`。
2. 令 `setEnv` 为 `.../cann-9.2.1/share/info/ascendnpu-ir/bin/set_env.sh`，看推导根停在 `bin`。
3. 标准安装不设置自定义前缀时，确认默认 `readRoots` 仍含 `/usr/local/Ascend`。

## 建议修复

用「向上寻找工具链标记」替换字符串特判。验收覆盖不同版本的目录名和不同深度的脚本，并检查推导出来的根是否落在工具链根上。默认 `/usr/local/Ascend` 保留，并允许配置关闭。

## 验收标准

- 源码中 `toolkitRoots` 不再包含 `cann-9.2.1` 字面量。
- `cann-8.0.1/set_env.sh` 与 `cann-9.2.1/set_env.sh` 使用同一条推导规则，结果落在各自的工具链根。
- 深层脚本（IR 子目录里的 `set_env.sh`）推导到工具链根，而不是 `bin`。
- 标准安装在不配置 `setEnv` 特判时，默认读取根仍然是 `/usr/local/Ascend`。

## 关联

CAN-201、CAN-219。

## 处置和验证

从版本目录或脚本位置推导读取根，测试验证两个版本的嵌套位置、放行范围及兄弟目录拒绝。
