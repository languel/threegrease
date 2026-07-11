# Object mode verification

1. Object mode button (first in topbar). Add… -> Box/Sphere at 3D cursor;
   Model… imports .glb/.obj; Import GP appends a .threegrease.json GP
   object with remapped layer/stroke ids (verified: no id collisions,
   strokes copied, activeLayerId valid).
2. Click picks meshes/canvases (raycast), GP objects (stroke proximity),
   splats (center proximity); Shift extends. Transform widget attaches to
   the selection pivot; Move/Rotate/Scale buttons or G/R/S switch modes;
   drags write back to data with undo (verified sphere -1.5 -> -0.75 on a
   +0.75 proxy drag); X deletes selection.
3. Mesh objects: drawTarget flag feeds Surface placement — drawing on a
   BOX put stroke points on its face (x in [1.24,1.56] for a unit box at
   x=1.5). Wireframe flag = reference look.
4. Splat PLY: outliner ⬇.ply exports standard 3DGS PLY (177,132 gaussians,
   9.9 MB); round-trip: the exported file loads back through Spark's
   reader with identical splat count and no errors.
