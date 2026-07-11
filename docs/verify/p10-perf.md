# P10 verification — per-layer incremental rebuild

Benchmark scene: 4 layers x 60 strokes x 80 pts (19,200 points, one stamp
layer). Measured (M-series laptop, 2026-07):
- full rebuild (markDirty()):            27.6 ms
- single-layer rebuild (markDirty(id)):   2.7 ms   -> 10.2x speedup
Drawing and the string sim use the layer-scoped path; everything else
(mode/frame/undo/load) stays global. Regression checks: hide/show layer
via global path rebuilds correctly; draw + undo round-trip intact.
Deferred (documented in IMPLEMENTATION_PLAN): worker bucket fill,
instanced stamp geometry, in-progress-stroke append-only buffer.
