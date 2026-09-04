# RNNoise

`web/app/rnnoise.wasm` is [RNNoise](https://gitlab.xiph.org/xiph/rnnoise) — Jean-Marc Valin's
recurrent-network noise suppressor, the one Mumble desktop ships — compiled to WebAssembly from
the classic model (xiph/rnnoise commit `1cbdbcf`, BSD-3-Clause, see `LICENSE`). 125 KB, no
imports, ~0.1 ms per 10 ms frame.

It runs inside the capture AudioWorklet (`web/app/worklets.js`): 480-sample blocks in 16-bit
scale in, denoised blocks out, plus a voice probability per block that the voice gate uses.

Rebuild with `sh web/vendor/rnnoise/build.sh` — needs Zig (a tarball from ziglang.org is enough)
or clang with the wasm32 target and wasm-ld. The script clones the pinned commit itself.
