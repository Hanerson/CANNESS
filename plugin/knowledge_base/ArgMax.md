# ArgMax（CANNBench L2 / SortSelect）

返回张量沿 `dim` 的最大值下标，输出 int64；并列取**首个**（与 `torch.argmax` 一致）。
cannbench 公开集的 20 个用例覆盖 1–5 维、dim ∈ {-1,0,1,2}、fp16/fp32/bf16/int32/int64、
以及 ±Inf / NaN / 宽值域。

## 契约要点（dsh-canness 构建契约 v1）

- 入口：`extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR in, GM_ADDR out, GM_ADDR tiling)`；
- 输出 dtype 声明为 int64，但**构建契约会把 int64 映射成 F32 缓冲**（`cppDtype()` 只认 f16/bf16，
  其余一律 float）——kernel 必须把下标当 float 写回，否则按 float 解释会得到次正规数。
  这是 issue 005，提交 cannbench 前必须改回真正的 int64；
- `blockDim` 与 workspace 由 `spec.launch` 声明（issue 006 / 013 已实现）：
  ```json
  "launch": { "block_dim": 40, "workspace_bytes": 0 }
  ```

## 实测（910B，40 AIV，CANN 9.0.0，bisheng 15.0.5）

用例 `[2048,2048] fp32 dim=-1`（16 MiB）：

| 实现 | kernel 时间 |
|---|---|
| 厂商 `ArgMaxV2` + `Cast`（aclnnArgMax，msprof 实测） | **46.2 + 1.9 = 48.1 µs** |
| 本仓库实现（两行/次归约，8 行/tile，40 块） | 349.6 µs |
| 同实现，blockDim=16（契约旧默认） | 686 µs |
| 早期写法（逐行 `ReduceMax(count=2048)` + Compare + `ReduceMin`） | 2433 µs |

结论：**本写法受限于"取不到 reduce-with-index"，不是算法思路**；厂商 48 µs ≈ 22 ns/行，
只可能来自一条归约同时返回值+下标的硬件指令。

## 关键坑（每一条都让"看起来对"的实现静默出错）

### 1. `calIndex` 拿不到 index（5 条路径全部无效）

| 路径 | 现象 |
|---|---|
| `ReduceMax(dst, src, work, count, calIndex=true)` | 值正确，`dst[1] ≡ 0` |
| `ReduceMax(dst, src, work, uint64_t mask[], repeat, stride, true)` | 同上 |
| `GetReduceRepeatMaxMinSpr(value, index)` | value 正确，index ≡ 0 |
| `WholeReduceMax(..., ReduceOrder::ORDER_INDEX_VALUE)` | 只把 value 换到奇位 |
| `Gather` / `GatherMask` | mask 必须是编译期常量模式，接不了运行时掩码 |

因此「首个最大值下标」只能写成
`idx = min(x == max ? i : BIG)`：`CompareScalar(EQ)` → `Select(idx, BIG)` → `WholeReduceMin`。

### 2. `Compare*` / `Select` 的 mask 是**按位打包**

1 bit/元素。手写字节掩码（如 even/odd 交替）会被解释成"每 16 个选 1 个"，
症状是**只有部分元素参与**、结果看似随机。要么让 `CompareScalar` 产生掩码，
要么用 `Add` 加常量模式来抵消填充位。

### 3. `WholeReduce*` 的 dst 是 `(value, pad)` 对，`srcRepStride` 单位是 32B block

fp32 一次 repeat 覆盖 64 元素 = 8 block，所以 `srcRepStride=8` 才是"逐组前进"；
写 1 会得到步进 8 个元素的错误分组（值看起来"有点像"但全错）。

### 4. 单次调用的 `repeatTimes` 实测上限 64

128 次会**静默丢掉最后 32 次**（本任务里表现为"每 tile 第 4 行恒错"，`got=1e9`）。
无编译/运行期报错。

### 5. 同一缓冲的多个偏移视图不能混用

把 `pair[0..127]` 和 `pair[128..255]` 分别作为两次 `WholeReduce*` 的 dst，
会出现**部分行恒错**（本任务 496/2048）。给每次调用独立缓冲即可消失。

### 6. `ReduceMax/ReduceMin(count)` 比两段 `WholeReduce*` 慢一个数量级

内部按 64 元素串行：2048 元素 ≈ 7 µs/行；一次 `WholeReduce*(repeatTimes=32)` ≈ 0.7 µs。

### 7. 开销模型（用于判断优化方向）

单次 AscendC 向量调用 ≈ 0.6–1.5 µs（**与数据量弱相关**，主要看调用次数）。
所以优化顺序是：**减少调用次数 > 减少向量遍数 > 减少同步次数**。
本任务实测：把同样的操作拆细/合并成更少次数都会变慢，唯一的量级收益来自
blockDim（16→40 = 1.96×）。

## 推荐结构（349.6 µs 版本）

- 8 行/tile，一次 64 KiB `DataCopy`；
- 每 **2 行**共用一次 `WholeReduceMax(64-groups, 64 repeats)` → 1 次 `Add(±BIG 抵消 pad)`
  → 1 次 `WholeReduceMax(8 repeats)` 得到 8 个行最大值；
- 每行 `CompareScalar(EQ)` + `Select(idx, BIG)`，再按 2 行一组 `WholeReduceMin`
  → `Add` → `WholeReduceMin` 得到 8 个首个下标；
- 每 tile 2 次 V→S 同步（不是每行 2 次）。

## 待解

拿到 reduce-with-index 的低层 intrinsic（VCGMAX 一类）后，每行可降到 ~1.5 次调用，
按 48 µs 的厂商水平估算，`[2048,2048]` 有望从 350 µs 进到 60–90 µs。
本机 `tikcfw` 里没有 `ArgMax` 符号、`calIndex` 的实现也不在头文件（只有编译好的库）。
