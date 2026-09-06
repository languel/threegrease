# Vendored: ARDY Mini browser runtime

`web/src/runtime/*` from [`intsuc/ardy-mini`](https://github.com/intsuc/ardy-mini),
copied **unmodified**. Every file keeps its original SPDX header:

    SPDX-FileCopyrightText: Copyright (c) 2026 intsuc
    SPDX-License-Identifier: Apache-2.0

`LICENSE` and `NOTICE.upstream` are the upstream copies.

## Why vendored rather than reimplemented

This is the reference implementation of the inference loop: the DDIM update,
the autoregressive window recentring, and the latent quantisation. Those are
exactly the kind of numerical detail that is easy to get subtly wrong and
very hard to notice — the motion would simply look a bit off, with nothing
to point at. Copying the Apache-2.0 original is both cheaper and more
honest than a paraphrase of it.

The adapter that maps it onto this project's own skeleton and clip format is
ours, and lives in `src/actor/ardy.ts`.

## The MODEL is a separate matter

The runtime is Apache-2.0. The WEIGHTS it downloads are not: they are
governed by `ardy-mini-composite-model-terms`, which layers the **NVIDIA
Open Model License**, the **Meta Llama 3 Community License**, Apache-2.0 and
CC-BY-4.0. The re-packager's own grant explicitly "does not alter, replace,
or expand rights under the NVIDIA or Meta terms."

Nothing is downloaded until a user chooses the on-device backend, and the
required attributions are shown in the UI next to that choice (see
`ARDY_NOTICES` in `src/actor/ardy.ts`). **Read the upstream licences before
shipping this anywhere public or commercial** — that call is not one this
code can make for you.

## Updating

Re-copy the same file list from upstream `web/src/runtime/`; the only
external imports are `onnxruntime-web/webgpu` and `@huggingface/tokenizers`.
