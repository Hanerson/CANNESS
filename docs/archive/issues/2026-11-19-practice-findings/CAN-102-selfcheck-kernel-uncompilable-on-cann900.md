# CAN-102 契约自检 kernel 在 CANN 9.0.0 上不可编译，而 runner 把它当硬门禁

| 字段 | 值 |
|---|---|
| 类型 | bug |
| 优先级 | **P0（阻塞全部评测，且伪装成"模板坏了"）** |
| 组件 | `canness-generator` / `package-files.ts::writeContractSelfCheck` / `templates/build-contract/canness_tiling.h` / `remote/runner.py` |
| 首次发现 | 2026-11-19 09:25（修完 CAN-101 后立刻暴露） |
| 状态 | 已打补丁（从包里删掉自检目录并重签 hash），根因未修 |
| 标签 | `build`, `contract`, `device-api` |

## 现象

修掉 CAN-101 后，`compile_only` 仍然 `compile_fail`，但报错来自**自检目录**而不是我的 kernel：

```text
op_kernel/kernel.cpp:6:35: error: cannot initialize a parameter of type 'const char *'
    with an lvalue of type 'const __gm__ char[8]'
  const auto pattern = attrs.find("pattern");
                      ^~~~~~~~~
.../canness_tiling.h:69:58: note: passing argument to parameter 'key' here
  __aicore__ inline CannessDeviceAttr find(const char* key) const {
```

第 6/7/8 行分别是 `attrs.find("pattern")` / `("scale")` / `("enabled")` ——
都是 `writeContractSelfCheck()` 自动生成的，和我写的算子无关。

## 证据

- 生成文件：`packages/<gen>/.contract-selfcheck/op_kernel/kernel.cpp`（由 `package-files.ts`
  里硬编码的字符串数组拼出）；
- 门禁位置：`plugin/remote/runner.py` 在跑包自己的 `build.sh` **之前**执行
  `.contract-selfcheck/build.sh`，非 0 就 `make_report(status='compile_fail',
  summary='contract template itself broken: minimal kernel did not compile')` 并直接返回；
- 编译器：`clang version 15.0.5`（CANN 9.0.0 自带 bisheng），它把字符串字面量放进
  GM 地址空间，类型是 `const __gm__ char[N]`，不能隐式转 `const char*`。

## 根因

两层问题叠加：

1. **模板 API 设计**：`CannessAttrs::find(const char* key)` 要求"普通指针"，而设备代码里
   唯一现成的名字来源是 GM 里的字面量。同插件的 KB
   `AscendC_Compile_Run.md` 正是教用户写 `attrs.find("dim")` —— 教了一个编译不过的写法。
2. **门禁语义**：自检是"验证工具链能编译"的手段，却因为自身代码不合规，
   把所有生成的包判成"模板坏了"。它验证的不是用户代码，自己也从不被用户代码路径覆盖。

## 影响

- 本轮第二次 compile-only 又白跑；如果没注意日志里是 `.contract-selfcheck`，
  会误判成 kernel 语法问题而反复改算子；
- 对所有在这个工具链上用该插件的会话都成立（不是本算子特有）。

## 我用的临时补丁

把 `.contract-selfcheck/` 整个删掉，并重签 `manifest.packageHash` 与 `.canness/state.json`
（见 CAN-103 的 `tools/rehash.mjs`）。runner 只在
`if selfcheck.is_file():` 时才做门禁，目录不存在即跳过，主编译照常进行。

> 注意：这是"绕过门禁"，不是"修好门禁"。如果自检本身有价值（它确实顺手验证了
> attr 表打包/读取），更该修它而不是绕它。

## 建议修复

1. `canness_tiling.h` 增加可编译的重载：
   `find(const __gm__ char* key, uint32_t length)`，或提供 `find(uint32_t index)`
   并把"属性顺序稳定"写进契约（顺序问题见 archive 的 CAN-010）；
2. `writeContractSelfCheck` 的 kernel 改为局部 `char key[8] = {'p','a',...}` 再调用 find；
3. 把自检变成**软失败**：`summary` 里区分"自检失败（模板问题）"与"用户 kernel 失败"，
   并且自检失败时仍然尝试编译用户的 kernel（当前是提前 return）；
4. 发布门禁：记录一份"目标工具链指纹 → 自检可编译"矩阵，换 CANN 版本时先跑自检。

## 验收标准

- 在 CANN 9.0.0 / clang 15.0.5 上，新生成包的自检 `build.sh` 返回 0；
- KB 中"读 attrs"的示例代码可直接编译（建议把示例本身纳入自检）；
- 自检失败不再阻止用户 kernel 的编译尝试（或至少在 summary 里明确指向模板）。
