# Verification — connected strokes, stroke events, parenting, box select, PLY

A. Chain of 3 touching strokes + 1 far: select first, Ctrl+L -> chain
   selected, far untouched. Ctrl+J -> 4 strokes become 2 (chain merged,
   6 pts). Stroke panel sets name/address; Y splits selected points off.
B. Parenting (object mode): setParentKeepWorld preserves world pose
   (local rewritten via parent inverse); moving parent moves child 1:1
   (verified +2 z); cycles rejected; Alt+P clears keeping world pose;
   Ctrl+P parents selected to last-picked. Managers (canvas/splat/mesh)
   and GP groups all place via worldMatrixOf.
C. Box select: drag in object mode selects everything whose projection
   falls in the rect (meshes/canvases/splats by center, GP by stroke pts).
D. File > Export > PLY (geometry) emits binary PLY; splat ⬇.ply is
   standard uncompressed 3DGS PLY — loads in PlayCanvas/SuperSplat
   (which also produce compressed .ply and .sog; Spark imports both).
