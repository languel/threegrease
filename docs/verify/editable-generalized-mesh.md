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
24-25. Start dragging a boundary edge, press `Escape` mid-drag. Expect:
   vertex/edge/face counts identical to before the drag.

## Boundary extrusion

26-28. Build a triangle. Drag one of its edges outward. Expect: +2
   vertices, +3 edges, +1 quad face; the original edge still exists.
29. Build two triangles sharing an edge; dragging the SHARED edge does
   nothing (only boundary edges — fewer than two faces — extrude).
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
