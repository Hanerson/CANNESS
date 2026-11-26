# CAN-107 没有本地 kernel 接口 lint：三种纯编译错误全靠远端往返发现

| 字段 | 值 |
|---|---|
| 类型 | enhancement |
| 优先级 | P1 |
| 组件 | `canness-eval`（`preflight_evaluation.kernel_dtypes`）、`plugin/scripts/check-kernel.mjs`、`templates/local-validation/kernel_operator.h` |
| 首次发现 | 2026-11-19 09:24 / 09:47 / 09:56（三次远端 compile-only） |
| 状态 | 未解决 |
| 标签 | `dx`, `compile`, `lint` |

## 现象

`preflight_evaluation({ kernel_dtypes })` 的定位是"host-stub 的有限语法 lint"
（描述："No NPU connection required"），但它没有拦住下面三种**纯语法/接口**错误，
每一种都要一次远端 `compile_only` 才发现：

1. **设备代码里字符串字面量的地址空间**
   ```text
   error: cannot initialize a parameter of type 'const char *'
       with an lvalue of type 'const __gm__ char[8]'
   ```
2. **依赖模板调用需要 `template` 关键字**（我的 `SwiGLU` 体是模板，`TQue` 的类型依赖
   模板参数 `DEPTH`）
   ```text
   error: use 'template' keyword to treat 'AllocTensor' as a dependent template name
   error: use 'template' keyword to treat 'DeQue' as a dependent template name
   ```
3. **`DataCopyPad` 重载数量**（3 参 vs 4 参，UB→GM 与 GM→UB 不同）
   ```text
   error: no matching function for call to 'DataCopyPad'
   ... candidate function template not viable: requires 4 arguments, but 3 were provided
   ```
   （这一类在 archive 的 `audit-e2e/issues-lAf9YO/evaluation.json` 里也出现过，说明是复发问题）

## 影响

- 每次 4~8 s 往返 + 一次 mind 上下文切换；本轮共 3 次，其中第 1 次还叠加了 CAN-101/102；
- 更贵的是**误判成本**：错误信息里出现的是模板/头文件路径，很容易被当成"工具链不兼容"；
- stub 的局限在 archive 的 CAN-005 里已经记过一次（stub 放过 int32 的 `And/Xor`），
  这次是同一类问题的另一面：stub **缺**了真实头文件的重载集合。

## 证据

- `plugin/templates/local-validation/kernel_operator.h`（stub 只有极简声明）；
- `preflight_evaluation({kernel_dtypes})` 返回 `ok`（因为 `.cpp` 里没有语法错误），
  远端 bisheng 才报错；
- 三次错误文本见上（均可复现）。

## 建议修复

1. 用**录制版真实头文件**替换手写 stub：从目标机 `fetch_remote_file` 抓
   `tikcpp/tikcfw/{interface,impl}` + `asc/include` 的声明（.h 文本），
   做成只读的 lint 头集合，随插件版本固定并记录 sha256；
2. lint 至少覆盖 build-contract 生成的三件事：
   `GET_TILING_DATA` / `CannessAttrs::find` / `DataCopy(Pad)` 重载；
3. `preflight` 输出改成"编译通过 / 未知"两态，别给"ok"（当前 stub 通过会被误读成可编译）；
4. 把这三类错误沉淀成 KB troubleshooting 条目，并在 kernel 模板里直接给正确写法。

## 验收标准

- 把上面三段错误代码放进 `op_kernel/kernel.cpp`，`preflight_evaluation({kernel_dtypes})`
  在**不连 NPU** 时能报出同样的错误；
- lint 头集合有版本指纹，CANN 版本变化时提示刷新。
