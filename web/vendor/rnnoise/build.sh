#!/usr/bin/env sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../../app/rnnoise.wasm"
COMMIT=1cbdbcf1283499bbb2230a6b0f126eb9b236defd
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
