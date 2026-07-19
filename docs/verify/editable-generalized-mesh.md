# Verify: editable generalized meshes (TGPolyMesh)

Manual browser steps (dev server `npm run dev`, port 5199). The console
handle `window.__tg` exposes the app; `__tg.ctx.scene.polyMeshes` is the
persistent topology. Deletion semantics, undo model, and splat-picking
limitations are documented in `docs/design/polymesh.md`.

## Creation and topology

1. **Add an empty editable mesh** — Shift+A → *Editable Mesh* (or command
   palette F3 → "Add Editable Mesh"). Expect: a new `PolyMesh` row in the
   outliner, mode switches to the POLY topbar mode (wireframe icon, key
   `6`), tool = Topology Pen.
2. **Isolated vertex** — click once in empty space, press `Enter`.
   Expect: one cyan octahedron handle; `polyMeshes[0].vertices.length === 1`,
   no edges.
3. **Open chain** — click three spots, press `Enter`. Expect: 3 vertices,
   2 edges, 0 faces; the chain renders as cyan lines.
4. **Triangle** — click three spots, then click the FIRST vertex again
   (preview line turns into a closed loop when hovering it). Expect: 1
   face, 3 edges; face renders filled.
5. **Quad** — same with four clicks; expect a 4-vertex face boundary.
6. **N-gon** — same with six clicks; `faces[n].vertices.length === 6`.
7. **Disconnected components** — after finishing one face, start clicking
   elsewhere; all pieces live in the same object (`vertices/edges/faces`
   grow, outliner still one row).
8. **No duplicate edges** — build a triangle, then draw a chain that
   reuses two of its vertices consecutively. `edges` must not contain two
   entries with the same unordered vertex pair.
9. **Invalid face rejected** — click A, click B, click A (start, 2 verts).
   Expect: nothing happens (previewInvalid red when hovering the start
   with < 3 chain vertices); topology unchanged.

## Edge splitting

10-11. **Isolated edge** — build a 2-vertex chain (Enter), then click the
   middle of its edge to start a new chain. Expect: the edge becomes two
   edges around an inserted vertex, chain continues from it.
12-13. **Edge of one face** — click the midpoint of a triangle edge; the
   face's `vertices` array now contains the inserted vertex id between the
   old endpoints (check in console).
14-15. **Edge shared by two faces** — build two triangles sharing an
   edge, split that edge; BOTH face boundaries gain the inserted vertex.

## Vertex movement

16. Drag a vertex in empty space — it slides on the drawing plane.
17. Add a Box (Shift+A), drag a poly vertex over it — the vertex lands on
    the box surface (its `binding.kind === 'MESH'`).
18. Draw a GP stroke (mode 1), return to POLY (`6`), drag a vertex near
    the stroke — it snaps to the polyline (`binding.kind === 'GP_STROKE'`).
19. Load a splat, drag a vertex near it — snaps to the nearest SAMPLED
    center (approximate: clouds are subsampled to ≤5000 points).
20. Start a drag, press `Escape` mid-drag — the vertex returns to its
    exact prior position; no undo entry was created.
21. Complete a drag, Ctrl+Z once — the whole move reverts in ONE step;
    Ctrl+Shift+Z restores it.

## Construction cancellation

22-23. Click three chain points, press `Escape`. Expect: every vertex and
   edge created by the chain is gone; pre-existing topology untouched.
24-25. Long-press a boundary edge then drag (extrusion), press `Escape`
   mid-drag. Expect: vertex/edge/face counts identical to before.

## Boundary extrusion

26-28. Build a triangle. LONG-PRESS one of its edges then drag outward —
   or plain-drag it from its CENTER band (see step 74; off-center plain
   drag moves the edge instead). Expect: +2 vertices, +3 edges, +1
   quad face; the original edge still exists.
29. Build two triangles sharing an edge; hold+drag on the SHARED edge
   runs LOOP CUT instead (only boundary edges — fewer than two faces —
   extrude).
30. Extrude an edge and release with a new endpoint on top of an existing
   vertex — they merge; no duplicate edges or degenerate faces appear
   (`validatePolyMesh` from `/src/core/polymesh.ts` returns `[]`).

## Rendering and object integration

31. Object mode (Tab/`0`… use topbar): select the poly mesh, G/R/S moves
    the whole object; topology stays intact.
32. Drag its outliner row onto another object — parenting keeps world pose.
33-34. Outliner eye hides it; lock blocks viewport selection.
35-36. Properties panel: color/opacity apply live; Wireframe toggles.
37. Shift+D duplicates ("copy" suffix, offset +0.3 in X).
38. X deletes it (children unparent, kept in place).
39. Ctrl+S save, reload the page, Ctrl+O open — topology and element ids
    identical (`nextElemId` preserved).

## Drawing surface

40-41. Enable *Draw target* in properties, switch to DRAW mode with
    Placement = Surface, draw across a poly face — the stroke lands ON
    the face.
42. The stroke must not stick to edge/vertex overlays (they are
    raycast-inert).
43. Disable *Draw target* — strokes fall through to the drawing plane.

## Spatial queries (console)

```js
const { distancePointToPolyMesh, intersectsSpherePolyMesh } =
  await import('/src/core/polyspatial.ts');
const s = __tg.ctx.scene, pm = s.polyMeshes[0];
distancePointToPolyMesh(s, pm, [x, y, z]);
intersectsSpherePolyMesh(s, pm, [x, y, z], 0.5);
```

44-47. Query a point nearest an isolated vertex → `dimension: 0` + that
   vertex id; nearest an open edge → `dimension: 1`; over a face →
   `dimension: 2` + the face id. Distances match visual expectation.
48-49. Sphere intersection true within radius of a point/edge/face,
   false outside.

**Trigger seam**: give the poly mesh a TRIGGER constraint (Constraints
tab) and run a traveler/stream landmark through it — it fires when the
probe comes within the constraint radius of ANY vertex/edge/face.

## Compatibility

50. Open a scene saved before this feature — loads clean,
    `scene.polyMeshes` defaults to `[]`.
51-55. Primitive meshes, imported models, splats, GP draw/edit, and
    existing constraints/triggers behave as before (no code paths were
    removed; POLY is additive).

## Export

56-58. Export GLB with a poly face mesh in the scene; open in Blender —
   triangulated faces, correct world transform and orientation, object
   color preserved.
59. Face-less edges export as GLTF line primitives and fully isolated
   vertices as point primitives (Blender imports them as edge-only /
   vertex-only meshes). OBJ/STL/PLY: faces only; points and open edges
   are skipped there (exporter limitation), never converted into other
   geometry.

## PolyQuilt parity addendum

The Topology Pen now follows PolyQuilt's operations table (hold = press
≥450ms without moving; Alt = hold-equivalent modifier):

60. **Vertex merge on move** — drag a vertex and release it on top of
    another; they fuse (edges rewired, no duplicates; degenerate faces
    cleaned).
61. **Edge move** — plain-drag an edge; both endpoints translate rigidly
    on a camera-facing plane.
62. **Face move** — drag inside a face; the whole boundary translates.
63. **Hold-delete/dissolve** — long-press a vertex/edge/face and release
    without moving: an edge shared by two faces DISSOLVES into one merged
    n-gon; a 2-edge pass-through vertex fuses its edges into one; anything
    else deletes with the documented cascades. Face hold deletes the face.
64. **Vertex hold+drag = edge extrude** — long-press a vertex then drag:
    a new vertex + connecting edge follows the cursor; releasing over an
    existing vertex connects instead of duplicating.
65. **Edge hold+drag** — boundary edge: quad extrusion (as before);
    INTERIOR edge (2 faces): loop cut — a preview line runs across the
    quad strip, pointer position along the edge sets the cut ratio,
    release splits every crossed edge and face (closed loops supported;
    walk stops at boundaries/non-quads).
66. **Knife** — long-press in empty space then drag: dashed HUD line;
    release splits every crossed edge and connects cut pairs through
    their shared faces. One undo step.
67. **AutoQuad (Shift+click)** — with open edges near the cursor: a
    3-edge "U" closes into a quad; two edges converging on one vertex
    close into a triangle; two facing edges bridge into a quad; an
    "L"-corner parallelogram-completes with one new vertex. Nothing
    within ~90px → no-op.
68. **Ctrl+click = select toggle** (moved from Shift+click, which
    AutoQuad now owns). Delete/X still removes the selection.
69. **Chain finalize** — while building, clicking the LAST placed vertex
    ends the open chain (same as Enter).
70. **Edit-mode routing** — in object mode select an editable mesh, press
    Tab / `2` (Edit mode): you land in POLY topology editing; with a GP
    object active you get the normal GP edit mode.

Not ported from PolyQuilt (documented): relax/move brushes, seam tool,
fan cut, empty-drag view rotation (navigation stays on MMB/RMB), Alt
double-click hold lock, and the Blender tool-palette sub-tools — the
single context-sensitive pen covers the workflow at our sketch scale.

## v3 addendum: intent feedback, center-drag, cascade delete, tool trio

71. **Cascade face delete** — build a lone triangle, long-press inside it
    and release: face, its 3 edges, AND its 3 vertices are gone. Build two
    triangles sharing an edge, delete one face: the SHARED edge and its
    vertices survive; only the sole-face edges/verts go.
72. **Red delete feedback** — press and HOLD on a vertex/edge/face without
    moving: after ~450ms it turns red (thick red segment / red ring / red
    outline+tint). Releasing deletes; dragging away instead cancels the
    red and runs the drag op.
73. **Yellow extrude feedback** — hover an edge near its MIDDLE: it turns
    yellow and thicker with a dot at the grab point (boundary edges
    brighter). Hover near an endpoint: no yellow (that zone moves).
74. **Center-drag extrude** — plain-drag a boundary edge from its middle:
    quad extrusion, no long-press needed. Plain-drag the same edge near
    an endpoint: the edge MOVES. Center-drag an interior (2-face) edge:
    loop cut.
75. **Snap-guideline placement** — enable the magnet with Increment or
    Grid: clicked construction points land on the grid lattice (in-plane
    rounding); vertex drags onto empty space do too.
76. **Tool trio in DRAW mode** — the toolbar shows PolyQuilt / Poly
    Build / Quad Patch below Interpolate, ruled off by a separator; the
    DRAW topbar's Placement/Plane/Guide options apply to poly
    construction too (e.g. Guide = Circular constrains chain clicks to
    the circle around the 3D cursor). Click near a GP stroke: vertices
    snap to it; with no editable mesh in the scene the first click
    creates one.
77. **Poly Build mapping** — with the Poly Build tool: Shift+click an
    element deletes it; dragging a boundary edge extrudes from ANY grab
    point; click/Ctrl+click adds geometry.
78. **Quad Patch** — with open edges around the cursor, a single click
    fills the inferred patch (same inference as Shift+click AutoQuad).
