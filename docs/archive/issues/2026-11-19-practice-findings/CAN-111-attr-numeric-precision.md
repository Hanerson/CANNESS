# CAN-111 运行时属性只有 `float` + `integer/hasInteger`：>2^24 的整数必须"知道内情"

| 字段 | 值 |
|---|---|
| 类型 | doc |
| 优先级 | P2 |
| 组件 | `canness_tiling_common.h`（`CannessDeviceAttr`）、`canness_tiling.h`（`CannessAttrs`）、`package-files.ts::renderBuildContract` |
| 首次发现 | 2026-11-19 09:20（设计 tiling 通道时） |
| 状态 | 已绕过（kernel 里读 `hasInteger/integer`） |
| 标签 | `abi`, `attrs`, `precision` |

## 现象

设备侧属性记录是：

```cpp
struct CannessDeviceAttr {
    GoldenAttrType type;
    uint32_t nameOffset, nameLength, textOffset, textLength;
    float number;      // <-- host 的 double 被压成 float
    int64_t integer;
    uint64_t numberBits;
    uint32_t hasInteger;
    uint32_t boolean;
};
```

而 SwiGLU 需要的几何量 `L = half * inner` 最大可到 2^29（例如
`[8192, 16384]` 拆 `dim=0` 时 `L = 4096*16384 = 67,108,864`）。
2^24 以上的整数在 `float number` 里**不精确**（67,108,864 恰好可表示，
但 67,108,865 不行；很多真实 shape 会踩到）。要走精确通道必须：

```cpp
const int64_t value = attr.hasInteger ? attr.integer : (int64_t)attr.number;
```

这个事实只能靠读 `canness_tiling_common.h` + `package-files.ts::cannessPackAttrs`
推出来；`docs/contracts/direct-launch.md` 只写了"属性按名字找、缺失类型是 Missing"，
没写数值通道与精度。

## 影响

- 我第一版 tiling 直接把 `half` 当 `float` 用，若 shape 落在非 2^24 精确点会**静默**
  算错地址（不是报错，是结果错位）——这类 bug 在远端表现为随机精度失败；
- 属性顺序不稳定（archive CAN-010）＋ 无索引 API，导致"按名字找"成为唯一可靠方式，
  而按名字找的推荐 API 本身编译不过（CAN-102）。

## 我用的临时补丁

kernel 侧自写 `FindNumber(attrs, value, which)`：按 `nameLength==4` + 首字节匹配
（"half"/"mode"），并一律用 `hasInteger ? integer : number` 取值。
同时把属性名都选成 4 字符，使匹配逻辑不依赖字面量（避开 CAN-102）。

## 建议修复

1. 在 `docs/contracts/direct-launch.md` 增加"数值通道"小节：
   `number` 是 float、`integer/hasInteger` 才是精确整数通道；
2. `canness_tiling.h` 提供 `__aicore__ int64_t CannessAttrs::intValue(const char* name, int64_t fallback)`
   之类的**可编译**辅助函数（内部处理 hasInteger）；
3. 可选：给 `spec.attrs` 增加显式整数类型（`{"half": {"int": 8192}}`），
   或按字符串传大整数；
4. 生成侧对 `|value| > 2^24` 的数值属性给出 warning（提示会丢精度）。

## 验收标准

- kernel 里读几何量只需一行、且对 2^53 内的整数精确；
- 文档里能查到 `hasInteger` 语义；
- 生成侧对超精度范围的属性有 warning。
