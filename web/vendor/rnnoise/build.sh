#!/usr/bin/env sh
# Builds web/app/rnnoise.wasm from RNNoise (xiph.org, BSD-3-Clause) — the classic 2018 model,
# the one Mumble desktop ships. Needs either Zig (bundles clang + lld; a tarball from
# ziglang.org is enough, no install) or clang with the wasm32 target plus wasm-ld.
#
#   sh web/vendor/rnnoise/build.sh            # uses `zig` from PATH, or ZIG=/path/to/zig
#
# Output: web/app/rnnoise.wasm exporting rnnoise_get_size, rnnoise_init, rnnoise_process_frame,
# malloc and free. wasm32-wasi in reactor mode gives us libc/libm compiled in; the module needs
# no imports at runtime.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../../app/rnnoise.wasm"
COMMIT=1cbdbcf1283499bbb2230a6b0f126eb9b236defd   # "Correct #endif in rnn.h", 2021 — the classic model, the commit Jitsi pins
SRC=${RNNOISE_SRC:-/tmp/rnnoise-src}

if [ ! -d "$SRC/src" ]; then
  git clone -q https://github.com/xiph/rnnoise "$SRC"
  git -C "$SRC" checkout -q "$COMMIT"
fi

FILES="$SRC/src/denoise.c $SRC/src/rnn.c $SRC/src/rnn_data.c $SRC/src/pitch.c $SRC/src/celt_lpc.c $SRC/src/kiss_fft.c"
FLAGS="-O2 -fno-math-errno -DTRAINING=0 -I$SRC/include -I$SRC/src"
EXPORTS="-Wl,--strip-all -Wl,--export=rnnoise_get_size -Wl,--export=rnnoise_init -Wl,--export=rnnoise_process_frame -Wl,--export=malloc -Wl,--export=free -Wl,--no-entry"

if command -v "${ZIG:-zig}" >/dev/null 2>&1; then
  "${ZIG:-zig}" cc --target=wasm32-wasi -mexec-model=reactor $FLAGS $EXPORTS -o "$OUT" $FILES
elif command -v clang >/dev/null 2>&1 && command -v wasm-ld >/dev/null 2>&1; then
  clang --target=wasm32-wasi -mexec-model=reactor $FLAGS $EXPORTS -o "$OUT" $FILES
else
  echo "need zig (https://ziglang.org/download) or clang + wasm-ld" >&2; exit 1
fi
ls -la "$OUT"
