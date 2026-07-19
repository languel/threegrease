# Design note: TGPolyMesh — editable generalized topology

## Why a separate object type

`TGMesh` represents *closed-form* geometry: a primitive kind (`PLANE`/`BOX`/
`SPHERE`/`CYLINDER`) or an imported model URL. Its shape is derived, not
authored — the scene stores parameters, the renderer synthesizes geometry.
Editable topology is the opposite: the scene stores the authored vertices,
edges, and faces themselves, elements need stable IDs for picking and undo,
and the object participates in spatial queries at the *element* level.
Overloading `TGMesh` would force every consumer (renderer, export, origin
ops, texture/billboard fields) to branch on "is this authored or derived",
so we add a distinct `TGPolyMesh` living in `scene.polyMeshes`, with its own
`ObjKind: 'POLY'` in the unified object system.

## Data model

Plain JSON in `GPScene.polyMeshes` (src/core/types.ts):

- `TGPolyVertex { id, co: Vec3 (object-local), select?, binding? }`
- `TGPolyEdge   { id, v: [vertexId, vertexId], select? }` — orientation is
  storage order only, identity is the unordered pair; duplicates rejected.
- `TGPolyFace   { id, vertices: vertexId[] (ordered boundary, ≥3 unique), select? }`
  Faces store polygon boundaries; triangulation is derived (render/export/
  spatial queries) and never written back.
- `TGPolyMesh` carries the standard object fields (TRS, visible/select/lock/
  parent/constraints) plus mesh-look fields matching `TGMesh` conventions
  (drawTarget, wireframe, color, opacity, unlit, doubleSided) and a `rev`
  counter bumped by every topology mutation so the renderer can cache.

Mixed dimensionality is intentional: isolated vertices, dangling edges, open
chains, non-manifold sharing, and disconnected components are all valid.
`src/core/polymesh.ts` holds the pure topology utilities (add/remove/split/
adjacency/validate) — no UI or three.js imports.

## Element IDs

Per-mesh monotonic counter `nextElemId` (persisted). All three element kinds
share one ID space within a mesh, so a `(dimension, id)` pair is never
ambiguous and IDs stay stable across save/load and undo snapshots.

## Vertex bindings: provenance only

`binding` records where a vertex came from (`FREE`/`PLANE`/`GP_STROKE`/
`SPLAT`/`MESH`). Chosen behavior for this phase (the conservative option):

- the explicit local `co` is always authoritative;
- the binding is written when the construction hit created/last snapped the
  vertex and is **not** re-evaluated when the source moves or disappears;
- a missing/invalid binding is ignored everywhere (never an error);
- future phases may add opt-in live re-snapping without a data migration.

## Undo for modal edits

`History` is snapshot-push-only (no discard), so cancelable modal operations
(build sequence, vertex move, boundary extrusion) snapshot **just the poly
mesh** locally at operation start, mutate live for preview, and on commit:
restore the pre-state → `ctx.pushUndo()` → re-apply the final state. Cancel
restores the pre-state and pushes nothing — no no-op undo entries.

## Deletion semantics

- delete face → removes only that face;
- delete edge → removes the edge and any face whose boundary uses it;
- delete vertex → removes the vertex, its edges, and faces using it;
- orphan cleanup (removing vertices left unreferenced by a deletion) is a
  separate explicit utility, not an automatic side effect.

## Splat picking

Approximate by design: splat centers are sampled (stride so ≤ ~5000 points
per splat), cached per splat id + transform, projected to screen per query.
Precision is "nearest sampled center within a pixel radius", not a surface
hit. Documented limitation; the adapter (`src/tools/splatpick.ts`) is the
only splat-aware code in the poly system.
