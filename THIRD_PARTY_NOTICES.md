# Third-party notices

threegrease (3𝜻) itself is proprietary — see [LICENSE](LICENSE). The
components below are not, and this file records what they are and what each
one requires.

There are three distinct categories here, and the distinction is the whole
point of the document:

| | What it means |
| --- | --- |
| **A. Bundled dependencies** | Installed from npm, compiled into a build. Redistributed if you distribute a build. |
| **B. Vendored source** | Third-party source code *copied into this repository*. Redistributed whenever the repo is. |
| **C. Fetched at runtime** | Never in this repository and never served by us. The user's browser downloads it from a third party, on demand. |

---

## A. Bundled dependencies (npm)

| Package | Licence |
| --- | --- |
| `three` | MIT |
| `onnxruntime-web` | MIT |
| `@sparkjsdev/spark` | MIT |
| `@huggingface/tokenizers` | Apache-2.0 |
| `@huggingface/transformers` | Apache-2.0 |
| `@mediapipe/tasks-vision` | Apache-2.0 |

Full licence texts ship inside each package under `node_modules/`. The
Apache-2.0 packages require their `LICENSE`/`NOTICE` files to travel with any
redistribution of a build.

`public/ort/` holds ONNX Runtime's WebAssembly host, copied out of
`node_modules` by `npm run ort-assets` because ORT loads it by URL rather
than through the bundler. It is gitignored and regenerated, but it *is* part
of a built site, and it is MIT alongside the rest of `onnxruntime-web`.

---

## B. Vendored source

### ARDY Mini browser runtime — `src/vendor/ardy/`

Copyright (c) 2026 intsuc. **Apache-2.0.**
Source: <https://github.com/intsuc/ardy-mini> (`web/src/runtime/`)

Copied **unmodified**, with every SPDX header intact. The upstream `LICENSE`
and `NOTICE` are kept alongside as `src/vendor/ardy/LICENSE` and
`src/vendor/ardy/NOTICE.upstream`, which is what Apache-2.0 §4 asks for.

This is the one third-party component this repository actually
redistributes. See `src/vendor/ardy/README.md` for why it is vendored rather
than reimplemented.

---

## C. Models fetched at runtime — not redistributed here

**No model weights are stored in this repository, committed to git, or
served by this project.** Each of the following is downloaded by the user's
own browser, directly from the third party that hosts it, and only once the
user takes an action that needs it. Nothing is fetched on load.

### ARDY Mini — the on-device motion model

- Fetched from `huggingface.co/intsuc/Llama-3-ARDY-Mini-Core40-Browser`
- ~653 MiB (fp16) on first use, then cached in the browser
- **Only** when a user selects the "ARDY Mini (on-device model)" backend in
  `Actor ▸ Generate`

Its terms are `ardy-mini-composite-model-terms`, which layer:

- the **NVIDIA Open Model License** (the ARDY weights, from
  `nvidia/ARDY-Core-RP-20FPS-Horizon40`),
- the **Meta Llama 3 Community License** (Llama-3-derived text conditioning),
- Apache-2.0 (the re-packager's own conversion work),
- CC-BY-4.0 (dataset annotations).

The re-packager's Apache-2.0 grant explicitly *does not* alter or expand the
NVIDIA or Meta terms. The attributions those licences require are displayed
in the app next to the backend selector (`ARDY_NOTICES` in
`src/actor/ardy.ts`) and reproduced here:

> Motion model: Llama 3 ARDY Mini Core40 Browser (intsuc), built from NVIDIA
> ARDY-Core-RP-20FPS-Horizon40.
>
> Licensed by NVIDIA Corporation under the NVIDIA Open Model License.
>
> Built with Meta Llama 3. Meta Llama 3 is licensed under the Meta Llama 3
> Community License, Copyright © Meta Platforms, Inc. All Rights Reserved.
>
> Browser runtime © 2026 intsuc, Apache-2.0.

### MediaPipe tracking models (Google)

Pose, hand and face landmarkers, fetched from
`storage.googleapis.com/mediapipe-models/…` when a capture stream is started.
Governed by Google's terms for those model files.

### Open-vocabulary detection models (Hugging Face)

`Xenova/owlvit-base-patch32`, `onnx-community/owlvit-base-patch32-ONNX`,
`onnx-community/owlv2-base-patch16-ensemble-ONNX`,
`onnx-community/grounding-dino-tiny-ONNX` — fetched only when semantic
detection is enabled on a stream. Each carries its own terms on its model
card; check the card for the one you actually enable.

---

## If you ever mirror a model

Category C holds **only** while the weights are fetched from their original
host. Self-hosting them — a local mirror for a class demo on bad wifi, an
offline build, bundling them into a distributable — makes this project a
**redistributor**, and the redistribution obligations in the NVIDIA and Meta
licences then apply in a way they currently do not. That is a real and
likely thing to want; it is just a different licensing position, and worth
deciding deliberately rather than discovering.
