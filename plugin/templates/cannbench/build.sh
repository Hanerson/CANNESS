#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

toolkit="${ASCEND_TOOLKIT_HOME:-${ASCEND_HOME_PATH:-/usr/local/Ascend/ascend-toolkit/latest}}"
compiler="${CANNESS_BISHENG:-bisheng}"
python="${PYTHON:-python3}"
platform="$(uname -m)-linux"
arch="{{SOC_VERSION}}"
for arg in "$@"; do
  case "$arg" in
    --soc=ascend910b) [[ "$arch" == Ascend910B* ]] || exit 2 ;;
    --soc=ascend910_93) [[ "$arch" == Ascend910_93* ]] || exit 2 ;;
    --soc=ascend950) [[ "$arch" == Ascend950* ]] || exit 2 ;;
    --soc=*) [[ "${arg#*=}" == "$arch" ]] || exit 2 ;;
    *) echo "Unknown build.sh option: $arg" >&2; exit 2 ;;
  esac
done
includes=(-I"$PWD/csrc" -I"$toolkit/include")
for dir in tikcpp/tikcfw{,/impl,/interface} asc/include{,/basic_api} include; do
  includes+=(-I"$toolkit/$platform/$dir")
done
flags=(-x cce -std=c++17 -fPIC "--cce-soc-version=$arch" --cce-soc-core-type=VecCore)
mkdir -p build
for variant in {{VARIANTS}}; do
  header="$PWD/csrc/$variant/canness_tiling.h"
  if [[ "$variant" == default ]]; then header="$PWD/csrc/canness_tiling.h"; fi
  entry="-Dcanness_kernel=canness_kernel_$variant"
  "$compiler" "${flags[@]}" "${includes[@]}" "$entry" -c csrc/launch.cpp -o "build/launch-$variant.o"
  "$compiler" "${flags[@]}" "${includes[@]}" "$entry" -include "$header" \
    -c csrc/op_kernel/kernel.cpp -o "build/kernel-$variant.o"
  link_libs=(-L"$toolkit/$platform/lib64" -L"$toolkit/$platform/devlib" -L"$toolkit/lib64"
    -lascendcl -lruntime -lstdc++ -lpthread -ldl -lm
    "-Wl,-rpath,$toolkit/$platform/lib64:$toolkit/lib64")
  # CANN 8.0.1 resolves the device runtime only through the CCE fat-object
  # linker; CANN 9.x links directly. Shared libraries allow undefined symbols by
  # default, so --no-undefined is what makes the 8.0.1 failure visible and
  # triggers the fallback instead of shipping a .so that fails to load.
  if ! "$compiler" -shared -Wl,--no-undefined "build/launch-$variant.o" "build/kernel-$variant.o" \
      -o "cann_bench/libcanness-$variant.so" "${link_libs[@]}"; then
    echo "build.sh: plain link failed; retrying with --cce-fatobj-link (CANN 8.x runtime)" >&2
    "$compiler" --cce-fatobj-link -shared "build/launch-$variant.o" "build/kernel-$variant.o" \
      -o "cann_bench/libcanness-$variant.so" "${link_libs[@]}"
  fi
done
"$python" setup.py bdist_wheel --dist-dir dist
