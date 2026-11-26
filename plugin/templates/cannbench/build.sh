#!/usr/bin/env bash
# CANNBench direct-launch build for a CANNESS four-layer operator.
#
# The compile target is the AICore *micro-architecture*, not a SoC part number:
#
#   ascend910b / ascend910_93 (A3/910C)  ->  dav-2201   (both are the c220 core)
#   ascend950   (950PR / 950DT)          ->  dav-3510
#
# Modern bisheng uses `-xasc --npu-arch=…`. Older 910B toolkits require
# `-x cce --cce-soc-version=<910B part>` with the CCE fat-object linker.
#
# `--soc` accepts either the CANN short name (what the evaluation runner passes:
# ascend910b / ascend910_93 / ascend950) or a full part name (Ascend910_9362,
# Ascend910B2, Ascend950PR_9579, ...). A selected export target provides the
# default. Portable exports can use torch_npu and then npu-smi to identify a
# target when --soc is absent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

toolkit="${ASCEND_TOOLKIT_HOME:-${ASCEND_HOME_PATH:-/usr/local/Ascend/ascend-toolkit/latest}}"
compiler="${CANNESS_BISHENG:-bisheng}"
python="${PYTHON:-python3}"
platform="$(uname -m)-linux"
selected_soc="{{TARGET_SOC}}"
selected_arch="{{TARGET_NPU_ARCH}}"

soc=""
for arg in "$@"; do
  case "$arg" in
    --soc=*)
      soc="${arg#*=}"
      if [ -z "$soc" ]; then echo 'build.sh: --soc requires a value' >&2; exit 2; fi
      ;;
    --install) ;;  # accepted for compatibility with the CANNBench examples
    *) echo "build.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

detect_soc() {
  "$python" -c 'import torch, torch_npu; print(torch.npu.get_device_name(0))' 2>/dev/null || true
}

soc="${soc:-$selected_soc}"
if [ -z "$soc" ]; then
  soc="$(detect_soc)"
  if [ -z "$soc" ] || [[ "${soc,,}" == ascend910 ]]; then
    soc="$(npu-smi info 2>/dev/null | grep -oiE 'Ascend(910B|910_93|950)[A-Za-z0-9_]*' | head -1 || true)"
  fi
fi

if [[ "${soc,,}" =~ ^ascend910b[0-9]*$ ]]; then
  family="ascend910b"; npu_arch="dav-2201"
elif [[ "${soc,,}" =~ ^ascend910_93[0-9]*$ ]]; then
  family="ascend910_93"; npu_arch="dav-2201"
elif [[ "${soc,,}" =~ ^ascend950(pr|dt)?(_[0-9]+)?$ ]]; then
  family="ascend950"; npu_arch="dav-3510"
else
  echo "build.sh: unrecognized or unavailable SoC '${soc}'" >&2
  echo 'build.sh: pass --soc=ascend910b, --soc=ascend910_93 (A3, dav-2201), or --soc=ascend950 (dav-3510), or use a full part name' >&2
  exit 2
fi
if [ -n "$selected_arch" ] && [ "$selected_arch" != "$npu_arch" ]; then
  echo "build.sh: SoC $soc uses $npu_arch, but this export targets $selected_arch ($selected_soc)" >&2
  exit 2
fi
if ! command -v "$compiler" >/dev/null 2>&1; then
  echo 'build.sh: bisheng not found; source set_env.sh before building' >&2
  exit 127
fi

# Toolkit headers move between CANN releases (tikcpp/tikcfw in the classic
# layout, asc/include in 9.x, compiler/ascendc in the CMake-oriented layout);
# add every directory that exists instead of betting on one of them.
includes=(-I"$PWD/csrc" -I"$toolkit/include")
for dir in \
  "$platform/tikcpp/tikcfw" \
  "$platform/tikcpp/tikcfw/impl" \
  "$platform/tikcpp/tikcfw/interface" \
  "$platform/asc/include" \
  "$platform/asc/include/basic_api" \
  "$platform/include" \
  "compiler/tikcpp/include" \
  "compiler/ascendc/include/basic_api/impl" \
  "compiler/ascendc/include/basic_api/interface" \
  "compiler/ascendc/include/highlevel_api/impl" \
  "compiler/ascendc/include/highlevel_api/tiling" \
  "compiler/ascendc/impl/aicore/basic_api"; do
  if [ -d "$toolkit/$dir" ]; then
    includes+=(-I"$toolkit/$dir")
  fi
done

# Probe the compiler dialect with a standalone translation unit so a bad operator
# never looks like a dialect problem. A device kernel is the faithful probe; an
# empty file is only used to tell "these flags work" apart from "these headers
# are missing", which is the operator's problem, not the flag set's.
probe_dir="$(mktemp -d)"
trap 'rm -rf -- "$probe_dir"' EXIT
cat > "$probe_dir/probe.cpp" <<'PROBE'
#include "kernel_operator.h"
extern "C" __global__ __aicore__ void canness_dialect_probe(GM_ADDR input)
{
    (void)input;
}
PROBE
printf '\n' > "$probe_dir/empty.cpp"
flags=(-xasc -std=c++17 -fPIC "--npu-arch=$npu_arch")
dialect=""
if "$compiler" "${flags[@]}" "${includes[@]}" -c "$probe_dir/probe.cpp" -o "$probe_dir/probe.o" >"$probe_dir/modern.log" 2>&1; then
  dialect="modern"
elif "$compiler" "${flags[@]}" -c "$probe_dir/empty.cpp" -o "$probe_dir/empty.o" >"$probe_dir/modern-empty.log" 2>&1; then
  dialect="modern"
  echo "build.sh: warning: -xasc --npu-arch=$npu_arch works, but the AscendC probe did not compile (check the toolkit headers)" >&2
fi
if [ "$dialect" = modern ]; then
  echo "build.sh: dialect=modern soc=$soc --npu-arch=$npu_arch"
  link_flags=(-Wl,--no-undefined)
else
  if [ "$family" != ascend910b ]; then
    cat "$probe_dir/modern.log" >&2
    echo "build.sh: $soc requires bisheng with -xasc --npu-arch=$npu_arch support" >&2
    exit 2
  fi
  legacy_soc="$soc"
  if [[ "${legacy_soc,,}" == ascend910b ]]; then
    legacy_soc="$selected_soc"
    if [[ ! "${legacy_soc,,}" =~ ^ascend910b[0-9]+$ ]]; then legacy_soc="$(detect_soc)"; fi
  fi
  if [[ ! "${legacy_soc,,}" =~ ^ascend910b([0-9]+)$ ]]; then
    cat "$probe_dir/modern.log" >&2
    echo 'build.sh: this bisheng needs a full 910B part name, e.g. --soc=Ascend910B2' >&2
    exit 2
  fi
  legacy_soc="Ascend910B${BASH_REMATCH[1]}"
  flags=(-x cce -std=c++17 -fPIC "--cce-soc-version=$legacy_soc" --cce-soc-core-type=VecCore)
  if ! "$compiler" "${flags[@]}" "${includes[@]}" -c "$probe_dir/probe.cpp" -o "$probe_dir/probe.o" >"$probe_dir/legacy.log" 2>&1 \
    && ! "$compiler" "${flags[@]}" -c "$probe_dir/empty.cpp" -o "$probe_dir/empty.o" >"$probe_dir/legacy-empty.log" 2>&1; then
    cat "$probe_dir/modern.log" "$probe_dir/legacy.log" >&2
    echo "build.sh: bisheng rejected both compiler dialects for $legacy_soc ($npu_arch)" >&2
    exit 2
  fi
  dialect="legacy"
  echo "build.sh: dialect=legacy soc=$legacy_soc --cce-soc-version=$legacy_soc (architecture $npu_arch)"
  link_flags=(--cce-fatobj-link)
fi

# Record what this wheel was built with: the dialect is only known on the target
# machine, so the archive has to carry the evidence.
mkdir -p dist
{
  echo "soc=$soc"
  echo "family=$family"
  echo "npu_arch=$npu_arch"
  echo "dialect=$dialect"
  echo "flags=${flags[*]}"
  echo "toolkit=$toolkit"
  echo "compiler=$("$compiler" --version 2>/dev/null | head -1)"
} > dist/build-env.txt

mkdir -p build
for variant in {{VARIANTS}}; do
  header="$PWD/csrc/$variant/canness_tiling.h"
  if [[ "$variant" == "default" ]]; then header="$PWD/csrc/canness_tiling.h"; fi
  entry="-Dcanness_kernel=canness_kernel_$variant"
  "$compiler" "${flags[@]}" "${includes[@]}" "$entry" -c csrc/launch.cpp -o "build/launch-$variant.o"
  "$compiler" "${flags[@]}" "${includes[@]}" "$entry" -include "$header" \
    -c csrc/op_kernel/kernel.cpp -o "build/kernel-$variant.o"
  link_libs=(-L"$toolkit/$platform/lib64" -L"$toolkit/$platform/devlib" -L"$toolkit/lib64"
    -lascendcl -lruntime -lstdc++ -lpthread -ldl -lm
    "-Wl,-rpath,$toolkit/$platform/lib64:$toolkit/$platform/devlib:$toolkit/lib64")
  "$compiler" "${link_flags[@]}" -shared "build/launch-$variant.o" "build/kernel-$variant.o" \
    -o "cann_bench/libcanness-$variant.so" "${link_libs[@]}"
done
"$python" setup.py bdist_wheel --dist-dir dist
