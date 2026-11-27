# CAN-225 `canness-remote` 只接受原始字符串，volatile 配置被丢掉

| 字段 | 值 |
|---|---|
| 类型 | 缺陷 |
| 优先级 | **P1** |
| 组件 | `plugin/src/remote-api.ts` |
| 首次发现 | 2026-11-27 只读评估 |
| 状态 | **fixed** |
| 标签 | `cannlab`, `config`, `dsh` |
| 复核 | 2026-11-27。本地已确认。优先修 |

## 现象

`canness-remote` 的 `tokenRef`、`cacheRoot`、`keyDir`、`logPath`、`instance` 都是 `.volatile()`。`setting()` 只接受非空字符串，其它值用 fallback。钉扎的 Schemastery 对 volatile 字段给出的是带 `.get()` 的对象，不是裸字符串。本地已确认：对象上的 `.get()` 才返回快照，入口却只收原始字符串。

`storeOf` 对空引用改用 `FileTokenStore`，不再解析 dsh 凭据。bundle 里的 `tokenRef: CANNLAB_GITCODE_TOKEN` 因此到不了 `createTokenStore`。同一路径上的 `cacheRoot`、`keyDir`、`logPath`、`instance` 同样被丢掉。

`canness-eval` 已经用 `.get()` 读自己的 volatile 字段。remote 这一侧没有。这在插件钉着的 schemastery 3.18.5 和本机 3.19.0 上都成立，见 CAN-218 的版本记录。

## 证据

- `plugin/src/remote-api.ts` 第 55–60 行：五个字段都 `.volatile()`。
- 第 69–83 行：`setting()` 对非字符串返回 fallback。
- 第 154–157 行：`setting(config.tokenRef, '')` 为空则 `new FileTokenStore()`。
- `plugin/cordis.patch.yml` 第 36 行：`tokenRef: CANNLAB_GITCODE_TOKEN`。
- `plugin/src/eval.ts` 第 129–137 行：评测配置用 `.get()`。
- 2026-11-27 本地确认：钉扎版 Schemastery 的 volatile 字段对象通过 `.get()` 取值。把该对象交给 `setting()` 时得到 fallback。

## 影响

设置里保存的 GitCode 令牌引用不会被 CANNLab 路由使用。连接会去读文件令牌库。非空的 `cacheRoot`、`keyDir`、`logPath`、`instance` 回到默认位置。

## 期望

与 `eval.ts` 的 `snapshot()` 一样，先取 volatile 快照再交给 `setting()`。空字符串仍表示使用默认。五个字段走同一条解包。

## 复现

1. 用插件钉扎的 Schemastery 构造真实的 `canness-remote` 配置对象，`tokenRef` 设为 `CANNLAB_GITCODE_TOKEN`。
2. 在 `apply` 入口看 `config.tokenRef` 的类型，并调用 `setting(config.tokenRef, '')`。
3. 观察取值不是字符串，store 走 `FileTokenStore`。`cacheRoot` 等其余四个字段同样落到 fallback。

## 建议修复

五个字段先取快照再交给 `setting()`。回归测试使用 Schema 产生的配置对象，覆盖 `tokenRef` 与另外四个字段。手写的 `{ get: () => ... }` 只能作为补充，不能作为唯一夹具。

## 验收标准

- 真实 Schema 产生的配置对象中，`tokenRef` 解析到凭据存储里的 `CANNLAB_GITCODE_TOKEN`，store 为 `createTokenStore`。
- 同一对象上的 `cacheRoot`、`keyDir`、`logPath`、`instance` 使用配置里的值。
- 显式空字符串仍使用文件库或文档中的默认。

## 关联

CAN-218。本条是插件没有按 volatile 契约读取。

## 处置和验证

CANNLab 配置读取 Schemastery volatile 的取值快照，保留异常对象回退。真实 Schema 集成测试通过。
