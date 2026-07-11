# P6 verification — multi-view wire art

Assist: set a target image on a camera (Solvers panel), enter camera view
(0) — the target overlays the viewport at the set opacity; trace it, switch
cameras, connect strokes in 3D (Stroke placement helps).

Solver: targets on 2-3 cameras -> "Solve wire". Acceptance test (headless
version lives in git history): "3" on a front camera + "S" on a side
camera, grid 56, 300 voxels -> single 746-pt wire in ~0.8s whose
projections cover 99%/97% of the two targets (bar: 80%).
Note: compute camera rotations via lookAt when scripting — hand-written
XYZ eulers for side views are error-prone.
