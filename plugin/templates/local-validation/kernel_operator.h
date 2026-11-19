// Host syntax model only. Not a target toolkit, emulator, or API support oracle.
// Declarations are deliberately bounded: unknown APIs/overloads fail compilation.
#pragma once
#include <cstdint>
#include <type_traits>
// The host model erases address spaces, so the device-only __gm__ overload in
// canness_tiling.h would collapse into a duplicate of the generic overload.
// Tell that header it is being compiled against the bounded host stub.
#define CANNESS_LOCAL_VALIDATION 1
#define __gm__
#define __aicore__
#define __global__
#define GM_ADDR uint8_t*
#define KERNEL_TASK_TYPE_DEFAULT(task)
#define KERNEL_TYPE_AIV_ONLY 0
using half = _Float16;
// Keep bfloat16 distinct from half for overload/type checking. No numeric model.
struct bfloat16_t {
    uint16_t representation;
    bfloat16_t() = default;
    bfloat16_t(float);
    operator float() const;
};
namespace AscendC {
constexpr int32_t EVENT_ID0=0;
constexpr int32_t EVENT_ID1=1;
enum class HardEvent { MTE1_MTE2, MTE2_V, MTE3_V, V_MTE3, V_S, S_V, V_MTE2, MTE2_MTE3 };
enum class CMPMODE { LT, LE, GT, GE, EQ, NE };
enum class SELMODE { VSEL_TENSOR_TENSOR_MODE, VSEL_TENSOR_SCALAR_MODE };
enum class RoundMode { CAST_NONE, CAST_RINT, CAST_FLOOR, CAST_CEIL, CAST_TRUNC };
enum class TPosition { VECCALC, VECIN, VECOUT };
enum class QuePosition { VECIN, VECOUT };
enum class PipeBarrierMode { PIPE_ALL, PIPE_V, PIPE_MTE2, PIPE_MTE3 };
constexpr PipeBarrierMode PIPE_ALL=PipeBarrierMode::PIPE_ALL;
constexpr PipeBarrierMode PIPE_V=PipeBarrierMode::PIPE_V;
struct DataCopyParams { uint16_t blockCount, blockLen, srcStride, dstStride; };
struct DataCopyExtParams { uint16_t blockCount; uint32_t blockLen, srcStride, dstStride, rsv; };
template<class T> struct DataCopyPadExtParams { bool isPad; uint8_t leftPadding,rightPadding; T paddingValue; };
template<class T> class GlobalTensor {
public:
    void SetGlobalBuffer(T*,int64_t);
    GlobalTensor operator[](int64_t) const;
    T GetValue(int64_t) const;
    void SetValue(int64_t,T);
};
template<class T> class LocalTensor {
public:
    LocalTensor()=default;
    LocalTensor operator[](int64_t) const;
    T GetValue(int32_t) const;
    void SetValue(int32_t,T);
    template<class U> LocalTensor<U> ReinterpretCast() const;
};
template<TPosition position> class TBuf {
public: template<class T> LocalTensor<T> Get() const;
};
template<QuePosition position,int depth> class TQue {
public:
    template<class T> LocalTensor<T> AllocTensor();
    template<class T> void EnQue(LocalTensor<T>);
    template<class T> LocalTensor<T> DeQue();
    template<class T> void FreeTensor(LocalTensor<T>);
};
class TPipe {
public:
    template<TPosition P> void InitBuffer(TBuf<P>&,int32_t);
    template<QuePosition P,int depth> void InitBuffer(TQue<P,depth>&,int32_t,int32_t);
};
#define CANNESS_STUB_BINARY(name) template<class T> void name(const LocalTensor<T>&,const LocalTensor<T>&,const LocalTensor<T>&,int32_t);
CANNESS_STUB_BINARY(Add)
CANNESS_STUB_BINARY(Sub)
CANNESS_STUB_BINARY(Mul)
CANNESS_STUB_BINARY(Div)
CANNESS_STUB_BINARY(Max)
CANNESS_STUB_BINARY(Min)
#undef CANNESS_STUB_BINARY
#define CANNESS_STUB_SCALAR(name) template<class T> void name(const LocalTensor<T>&,const LocalTensor<T>&,const T&,int32_t);
CANNESS_STUB_SCALAR(Adds)
CANNESS_STUB_SCALAR(Muls)
CANNESS_STUB_SCALAR(Maxs)
CANNESS_STUB_SCALAR(Mins)
#undef CANNESS_STUB_SCALAR
#define CANNESS_STUB_UNARY(name) template<class T> void name(const LocalTensor<T>&,const LocalTensor<T>&,int32_t);
CANNESS_STUB_UNARY(Exp)
CANNESS_STUB_UNARY(Ln)
CANNESS_STUB_UNARY(Abs)
CANNESS_STUB_UNARY(Sqrt)
CANNESS_STUB_UNARY(Reciprocal)
#undef CANNESS_STUB_UNARY
// This local model intentionally admits only integer 16-bit bitwise elements.
// Passing this restriction does not establish target/device compatibility.
template<class T> constexpr void require_bitwise_type() {
    static_assert(std::is_same<T,int16_t>::value || std::is_same<T,uint16_t>::value,
                  "local stub bitwise model requires int16_t/uint16_t");
}
#define CANNESS_STUB_BITWISE(name) template<class T> void name(const LocalTensor<T>&,const LocalTensor<T>&,const LocalTensor<T>&,int32_t){require_bitwise_type<T>();}
CANNESS_STUB_BITWISE(And)
CANNESS_STUB_BITWISE(Or)
CANNESS_STUB_BITWISE(Xor)
#undef CANNESS_STUB_BITWISE
template<class T> void Not(const LocalTensor<T>&,const LocalTensor<T>&,int32_t){require_bitwise_type<T>();}
template<class T> void Duplicate(const LocalTensor<T>&,const T&,int32_t);
template<class T> void Compare(const LocalTensor<uint8_t>&,const LocalTensor<T>&,const LocalTensor<T>&,CMPMODE,int32_t);
template<class T> void CompareScalar(const LocalTensor<uint8_t>&,const LocalTensor<T>&,const T&,CMPMODE,int32_t);
template<class T> void Select(const LocalTensor<T>&,const LocalTensor<uint8_t>&,const LocalTensor<T>&,const LocalTensor<T>&,SELMODE,int32_t);
template<class T> void Select(const LocalTensor<T>&,const LocalTensor<uint8_t>&,const LocalTensor<T>&,const T&,SELMODE,int32_t);
template<class T,class U> void Cast(const LocalTensor<T>&,const LocalTensor<U>&,RoundMode,int32_t);
template<class T> void DataCopy(const LocalTensor<T>&,const GlobalTensor<T>&,const DataCopyParams&);
template<class T> void DataCopy(const GlobalTensor<T>&,const LocalTensor<T>&,const DataCopyParams&);
template<class T> void DataCopy(const LocalTensor<T>&,const GlobalTensor<T>&,uint32_t);
template<class T> void DataCopy(const GlobalTensor<T>&,const LocalTensor<T>&,uint32_t);
template<class T> void DataCopy(const LocalTensor<T>&,const LocalTensor<T>&,uint32_t);
template<class T> void DataCopyPad(const LocalTensor<T>&,const GlobalTensor<T>&,const DataCopyExtParams&,const DataCopyPadExtParams<T>&);
template<class T> void DataCopyPad(const GlobalTensor<T>&,const LocalTensor<T>&,const DataCopyExtParams&);
template<HardEvent E> void SetFlag(int32_t);
template<HardEvent E> void WaitFlag(int32_t);
template<PipeBarrierMode P> void PipeBarrier();
int64_t GetBlockIdx();
int64_t GetBlockNum();
} // namespace AscendC
