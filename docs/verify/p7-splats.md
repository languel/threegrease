# P7 verification — Gaussian splats (Spark)

Splats panel -> ＋URL https://sparkjs.dev/assets/splats/butterfly.spz
(177k gaussians). Expect: renders alongside strokes with sensible depth
(stroke drawn across it occludes/gets occluded per geometry); transform
via panel fields; attachable to a path (Score panel target "Splat: ...").
Gotcha: SparkRenderer MUST be created explicitly with our WebGLRenderer
(SplatManager.init) — auto-detection does not fire in our render loop.
File splats use object URLs: session-only, dropped on save/load.
