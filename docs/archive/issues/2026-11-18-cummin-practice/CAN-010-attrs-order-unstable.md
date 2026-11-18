# CAN-010 `attrs` 顺序在管线中不稳定，而契约自带的示例 kernel 按 index 读 attr

> **归档（2026-11-18）**：本条已修复并通过门禁（`tsc --noEmit`、`vitest` 255 项、`kb:validate` 18 条），
> 且经 live `lib` 渲染验证（`staleBuild: false`）。修复说明见
> [docs/contracts/practice-fixes.md](../../../contracts/practice-fixes.md)；下文保留原始发现过程与证据。


| 字段 | 值 |
|---|---|
| 类型 | design + docs |
| 优先级 | **P1** |
| 组件 | 构建契约（`canness_tiling.h` 的 `CannessAttrs::get`、`package-files.ts`、自检 kernel） |
| 首次发现 | 2026-11-18，Cummin 导出时发现签名顺序变化 |
| 状态 | **fixed-in-src（未生效，见 CAN-016）** |
| 标签 | `contract`, `attrs`, `footgun` |

## 处理情况（2026-11-18 16:20 复核）

**改动**：`templates/build-contract/canness_tiling.h` 新增 `CannessAttrs::find(const char* key)`（按名线性查找，未命中返回 `GoldenAttrType::Missing`，注释写明顺序按 JSON 枚举序、序列化可能重排、请用名字）；`package-files.ts::writeContractSelfCheck` 的自检 kernel 由 `attrs.get(0/1/2)` 改为 `attrs.find` 按名取 `pattern`/`scale`/`enabled`；`docs/contracts/direct-launch.md` 记录该约定与「先判 type 再取值」。

**我复核的边界情况**：属性名是查询串的前缀（`scale` vs `scaleValue`）与查询串是属性名的前缀（`sc` vs `scale`）都被正确拒绝，`bytes[j]` 不会越界读。

**残留**：`get(index)` 保留以兼容旧 kernel（合理）。注意自检 kernel 的改动来自 lib 代码，本次重建的包里仍是旧写法（见 CAN-016 的证据表）。

## 现象

我提交的 spec 是 `attrs: {"dim":2, "outer":16, "axis":256, "inner":256}`，导出物给出的
Python 签名却是：

```text
cummin(input, axis, dim, inner, outer)
```

即 `attrs` 被**重新排序成字典序**（`axis, dim, inner, outer`）。`package-files.ts` 里
`Object.entries(spec.attrs)` 的渲染顺序、`main.cpp` 的 `GoldenAttr` 数组顺序、导出的
`launch.cpp` 行顺序都跟着这个顺序 —— 三者彼此一致，所以不会自相矛盾；**但作者声明的顺序
并不保留**。

风险在于契约自带的示范代码正是按位置读：

```cuda
const auto pattern = attrs.get(0);
const auto scale   = attrs.get(1);
const auto enabled = attrs.get(2);
```

（`package-files.ts::writeContractSelfCheck` 生成的自检 kernel。）

本次我在 kernel 里是**按名字**读（`NameIs(attrs.name(attr), …, "outer")`），因此免疫；
一旦按 index 读，就会静默拿到错位的数据 —— 精度失败但看不出原因，而且要花一轮评测才发现。

## 期望

1. 明确契约：attrs 顺序**不保证**与声明一致（写入文档 + 类型注释）；
2. 示范代码改为按名字读，或提供 `CannessAttrs::find("outer")` 之类的按名接口；
3. 若决定保留顺序，则从 spec 到导出全程保序（并在报告里断言）。

## 影响

- 静默错位：值类型都是 Number，按 index 读不会报错，只会算错；
- 与 CAN-009 叠加：attrs 是几何的唯一通道，错位等于整个 kernel 用了错误几何。

## 复现

1. `submit_spec` 的 attrs 用非字母序（如 `dim, outer, axis, inner`）；
2. `export_submission` 后看 `cann_bench/__init__.py` 的签名与 `csrc/launch.cpp` 的行顺序；
3. 观察到 `axis, dim, inner, outer`（字母序）。

## 建议修复

1. `CannessAttrs` 增加 `__aicore__ inline CannessDeviceAttr find(const char* name) const;`
   （kernel 侧按名查找，长度用 `strlen` 或显式长度模板）；
2. 自检 kernel 与文档示例统一改成按名读；
3. 报告里附 `attrsOrder: ["axis","dim","inner","outer"]`，便于排查。

## 验收标准

- 文档显式声明顺序不保证；
- 示范/自检 kernel 不再按 index 读；
- 提供按名查找接口并被至少一个模板使用。

## 关联

CAN-009（几何只能走 attrs）、CAN-011（导出签名）
