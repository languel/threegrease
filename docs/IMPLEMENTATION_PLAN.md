# threegrease — Implementation Plan

*Phased plan written for capable-but-less-advanced implementing models.
Each phase: goal, data model, files, steps, acceptance tests, guardrails.
Read docs/HANDOFF.md §3 (architecture rules) and §6 (gotchas) before ANY
phase. Never skip: `npm run typecheck` → browser-verify via `window.__tg`
→ update README/PLAN/HANDOFF → commit → push.*

**General guardrails (apply to every phase)**
- New persistent state goes in `GPScene` (types.ts) with `??=` migration in
  serialize.ts. New preferences go in `Settings` + `PREF_FIELDS`.
- New shortcuts = keymap ACTIONS entry + `App.runAction` case. Never inline.
- Tools mutate data only; `ctx.pushUndo()` before mutation;
  `ctx.requestRender()` (strokes) / `ctx.syncCanvases()` (canvases) after.
- Long computations (solvers) run in Web Workers; never block the rAF loop.
- Don't add dependencies without noting them in HANDOFF; prefer zero-dep.
- If a phase says "adapter", keep the external lib behind one file.

---

## P0 — NPR brush engine  *(started; spec below is binding)*

**Goal**: expressive natural-media brushes; per-stroke baked style.

**Data** (types.ts):
```ts
export interface StrokeStyle {
  unit: 'VIEW' | 'SCENE';   // px vs world-space width
  stamp: boolean;           // false = solid ribbon (current pipeline)
  spacing: number;          // stamp interval as fraction of width (0.05–2)
  angle: number;            // stamp rotation offset (rad); follows direction
  aspect: number;           // stamp x/y squash (0.1–1)
  jitter: number;           // 0–1 positional/rotational randomness
  grain: number;            // 0–1 procedural noise masking
  grainScale: number;       // noise frequency
}
// GPStroke gains: style: StrokeStyle  (migrate with a DEFAULT_STYLE ??=)
```
`Settings.brush` gains the same fields + `preset: string`. Presets in new
`src/core/brushes.ts`: Pen (solid VIEW), Ink Rough (stamp SCENE, spacing
0.12, grain 0.55, jitter 0.15), Marker (solid SCENE, hardness 0.85),
Charcoal (stamp, grain 0.9, aspect 0.6, angle follows), Airbrush (stamp,
hardness 0.15, strength 0.25, spacing 0.3).

**Renderer**:
1. `materials.ts`: vertex attrs `aRot` (float), `aAspect` (float), extend
   `aKind`: 3 = stamp. Rotate/scale `aCorner` in the vertex shader for
   dots/stamps. SCENE units: replace px offset with
   `aRadius * projectionMatrix[1][1] / clip.w` when new attr `aUnit`=1
   (both segment and dot paths).
2. `geometry.ts`: if `style.stamp`, skip segments/joins; walk arc length
   emitting stamps every `spacing * width`, interpolating position/radius/
   color; rotation = path direction + `angle` + jitter (seeded by
   stroke.id + index — NEVER Math.random in geometry); aspect per stamp.
3. Fragment: kind 3 = radial hardness falloff × grain mask
   `mix(1., valueNoise(vUv*grainScale + seed), grain)`; hash-based value
   noise, no textures yet.
4. DrawTool/primitives bake `settings.brush` → `stroke.style` on create.
   `cloneStroke` must deep-copy `style`.

**UI**: preset dropdown in DRAW topbar; "Brush" sidebar panel with the
advanced sliders (mirror Blender's Advanced panel: Size Unit, Spacing,
Active Smooth, Angle, Aspect, Hardness…).

**Also fold in (small parity items)**: drawing plane option `CURSOR`
(view-aligned plane through 3D cursor) in projection.ts + UI; Surface
`offset` setting applied along hit normal (flip toward camera).

**Accept**: draw with each preset — Ink Rough shows rotated grainy stamps
following the path; zoom in/out: SCENE strokes change apparent size, VIEW
strokes don't; save/load round-trips style; old scenes load (default
style); 5k-point stamp stroke stays >30 fps.

---

## P1 — Blender interop

**Goal**: round-trip scenes with Blender 4.3+/5.x GPv3.

1. Schema: bump serialize.ts `VERSION = 2`; write `docs/schema.md`
   documenting every field of GPScene (generate by hand, keep updated).
2. New top-level `blender/threegrease_io/` Python addon:
   - `__init__.py` (bl_info, register import/export operators + menu).
   - Import: JSON → `bpy.data.grease_pencils_v3.new()`; layers by name
     (opacity/blend/hide/lock), frames by number, drawings: build
     CurvesGeometry — `curve_offsets`, positions (Z-up: ours matches),
     `radius` (our lineWidth*pressure/2, converted px→world via a scale
     option on the importer, default 0.01), `opacity`=strength,
     `vertex_color`, `cyclic`, materials (stroke/fill colors, fill_id
     attribute per GPv3), stroke order preserved.
   - Export: reverse mapping to our JSON; unsupported Blender features
     (textures, curves fills, groups) flatten with a report listing drops.
   - Version guards: try `grease_pencils_v3` (4.3+) names first; document
     any 5.x renames encountered in comments.
3. Fidelity table appended to docs/schema.md (attribute → roundtrip: full/
   lossy/dropped). Cameras/canvases/scores export as empties + custom
   properties (`threegrease_*`) so nothing silently disappears.

**Accept**: scripted test scene (3 layers, keyframes, fills, vertex color,
cyclic strokes) → Blender import (run `blender --background --python
blender/tests/roundtrip.py`) → export → diff against original JSON:
positions within 1e-4, counts identical.

---

## P2 — Event bus + IO (foundation for C/D)

**Goal**: typed pub/sub + MIDI/OSC/WS in and out + monitor.

**Data/files**:
```ts
// src/events/bus.ts
export interface TGEvent {
  time: number;                 // performance.now()
  source: string;               // 'cursor:12' | 'midi:in' | 'ws' | 'ui' ...
  address: string;              // '/cursor/12/pos' | 'note/1/64' style
  args: (number | string)[];
}
export class EventBus {  on(pattern, cb): unsub; emit(ev): void;
  history(n): TGEvent[];  // ring buffer for the monitor
}
```
- `src/events/midi.ts`: Web MIDI in/out (requestMIDIAccess; note/cc both
  directions; device pickers). Feature-detect; degrade gracefully.
- `src/events/ws.ts`: WebSocket client (configurable URL, auto-reconnect)
  speaking JSON `{address, args}`; OSC framing left to the bridge.
- `bridge/` (Node, plain js, no deps beyond `ws` + `osc`): WS ⇄ UDP-OSC
  and WS ⇄ node-midi relay; README with 3-line run instructions. Keep
  under ~150 lines.
- Monitor panel in ui.ts (scrolling recent events, pause, filter).
- `scene.io: { wsUrl, midiInId, midiOutId, oscPrefix }` persisted.

**Guardrails**: bus emit must be allocation-light (no JSON.stringify per
event in the hot path); UI monitor samples, not subscribes-render.

**Accept**: browser sends `/hello` via WS to the bridge, arrives as UDP
OSC (verify with `oscdump`); MIDI note from a virtual device shows in the
monitor; 1000 events/sec doesn't drop the frame rate below 55.

---

## P3 — Scores: cursors, triggers, path-attached objects

**Goal**: the IanniX layer. Strokes become playable scores.

**Data** (all in GPScene, all JSON-safe):
```ts
export interface PathRef { objectIndex: number; layerId: number;
  strokeId: number; }            // resolve defensively: stroke may be gone
export interface TGCursor { id; name; path: PathRef;
  speed: number;                 // path lengths per second (can be <0)
  phase: number; loop: 'LOOP'|'PINGPONG'|'ONCE'; ease: 'LINEAR'|'SMOOTH';
  running: boolean; messages: MsgTemplate[]; color: Vec3; }
export interface TGTrigger { id; name; position: Vec3; radius: number;
  retrigger: boolean; messages: MsgTemplate[]; }
export interface TGAttachment { id; target: {kind:'CANVAS'|'CAMERA'|'SPLAT'
  |'OBJECT'; id:number}; path: PathRef; cursorLike: {speed;phase;loop};
  orient: 'NONE'|'TANGENT'; offset: Vec3; }
export interface MsgTemplate { address: string;  // supports {id} {t} {x}...
  argExprs: string[]; }          // tiny substitution, NOT eval
scene.score = { cursors: [], triggers: [], attachments: [] }
```
- `src/score/engine.ts`: advance cursors each frame by dt (own clock —
  independent of GP frame playback); arc-length parametrize stroke once
  and cache keyed by stroke id + point-count (invalidate on markDirty);
  emit position messages at a configurable rate (default 30 Hz, not every
  frame); test triggers against cursor world positions (sphere), fire
  through the bus.
- Rendering: cursor glyphs + trigger spheres as an overlay group in
  GPSceneRenderer (respect presentation-mode styling toggle).
- UI: Score panel (list cursors/triggers/attachments; add-cursor from
  selected stroke; per-item transport, speed, message editor); trigger
  placement = place at 3D cursor.
- Attachments drive canvas planes / cameras (sets translation/rotation
  each frame BEFORE render; when target is the viewed camera it becomes a
  dolly rig).

**Accept**: cursor on a drawn stroke emits `/cursor/1/pos x y z t` at
30 Hz over WS (observed in monitor + oscdump); trigger fires exactly once
per pass with retrigger off; a canvas plane rides a circle stroke with
TANGENT orient; ALL of it survives save/load; deleting the stroke leaves
a paused cursor, not a crash.

---

## P4 — Property routing in (routional)

**Goal**: incoming events drive properties, learn mode included.

```ts
export interface TGRoute { id; enabled: boolean;
  match: { source: 'MIDI'|'OSC'|'WS'; address: string };  // glob ok
  target: string;               // dot-path: 'settings.brush.size',
                                // 'scene.objects.0.layers.<id>.opacity',
                                // 'score.cursors.<id>.speed'
  mapping: { inMin; inMax; outMin; outMax;
             mode: 'RAW'|'SCALE'|'CLAMP'|'WRAP' }; }
scene.routes: TGRoute[]
```
- `src/events/routes.ts`: subscribe to bus; resolve target path through a
  **whitelisted resolver** (explicit table of settable roots — never
  arbitrary object walking into functions); apply mapping; mark dirty /
  syncCanvases as appropriate per root.
- Learn mode: "learn" button on route → next bus event fills `match`.
- Routes panel with monitor-linked highlighting.

**Accept**: CC1 mapped to brush size changes live drawing width; OSC
`/layer/opacity` fades a layer during playback; broken target path logs
once and disables the route (no crash, no spam).

---

## P5 — String art & attractors

**Goal**: Bridges-2022 greedy solver + dynamic string simulation.

- `src/solvers/stringart.worker.ts` (Web Worker):
  input {pins: Vec2[] (from a selected cyclic stroke or canvas rect,
  N configurable), target: ImageData (imported image or a rendered layer
  snapshot via existing PNG path), opacity, maxChords, minGain};
  greedy loop: for current pin, evaluate candidate chords by residual
  darkness integral (sample along line), pick best, subtract, repeat;
  stop on maxChords or gain < minGain. Post progress every 100 chords.
- Output = one GPStroke per chord (or one polyline stroke chaining pins)
  into a new layer "StringArt" — ordinary data afterwards.
- Dynamic variant `src/solvers/strings.ts`: strings as verlet springs
  between their two pins; attractor/repulsor points (new scene list
  `scene.attractors`) pull midpoints; step in rAF at fixed dt with substep
  cap; writes point positions each frame to a dedicated layer (this layer
  flagged `simulated: true` so undo snapshots skip churn).
- UI: Solver panel (pick target image, pin count, run/cancel, progress).

**Accept**: 300-pin, 2000-chord portrait recognizable in <20 s on a mid
laptop, UI responsive throughout (worker); attractor dragged in edit mode
visibly bends the string field live; export of result via P8 works.

---

## P6 — Multi-view wire art (anamorphic)

**Goal**: one 3D stroke network matching 2–3 view drawings.

Stage 1 (assist, ship first): "view lock" workflow — store target drawing
per scene camera (imported image or GP layer); when drawing from camera A,
render residual overlay of camera B's target (what's still unmatched)
projected into the current view; artist connects manually.
Stage 2 (solver, worker): voxelize the intersection of the 2–3 view
silhouette extrusions (visual hull of the line drawings, dilated);
greedy-select voxels covering the drawings; connect components with A*
through the hull; fit Catmull-Rom through the path; project-and-compare
refinement (gradient-free jitter accept/reject). Output: strokes.

**Accept** (stage 2): the classic test — "3" from front, "S" from side —
produces a connected curve whose renders from the two stored cameras match
the inputs by >80% pixel overlap at 512².

---

## P7 — Gaussian splats (Spark adapter)

**Goal**: import/transform/occlude splats; paint later.

- Add dependency `@sparkjsdev/spark` (pin exact version).
- `src/splats/index.ts` adapter ONLY file importing spark: load url/file →
  `SplatMesh`, add under a `splatsGroup`; scene data:
  `scene.splats: {id, name, src (url or 'embedded'), translation, rotation,
  scale, visible}[]` (embedded = object URL from a File; warn not saved).
- SplatMesh is an Object3D → attachments (P3) and G/R/S selection follow
  the canvas-plane pattern (world-space branch in ModalTransform).
- Depth interplay: render order + depthWrite per Spark docs; verify
  strokes behind/in front of splats resolve correctly; document limits.
- Stroke-on-splat drawing (P2 of this phase): sample depth under cursor
  from a depth render of the splat pass, reuse STROKE-placement sticky
  machinery with splat depth as anchor.

**Accept**: a .spz scan loads, transforms with G/R/S, rides a path via an
attachment, occludes strokes plausibly, and the scene (with src URL)
reloads after save.

---

## P8 — Exporters

- `src/io/export3d.ts` using three's GLTFExporter/OBJExporter/STLExporter
  (import from examples/jsm — already vendored via three).
- Strokes → geometry: ribbons as-is for GLB (flat shading), plus a "tube"
  option (TubeGeometry along points, radius from width) for OBJ/STL
  fabrication; fills as meshes; option: selected-only / per-layer.
- Splats: re-export source file as-is (no re-encoding v1); note in UI.
- UI: File section in topbar → Export dialog (format, tube radius scale,
  selection scope).

**Accept**: STL of a string-art result opens manifold in a slicer;
GLB opens in Blender with colors; export of a 50k-point scene <5 s.

---

## P9 — mediamime bridge

- Define `docs/protocol.md`: shared WS vocabulary
  (`/mm/shape/<id>/enter|leave|move`, args normalized 0–1 coords).
- mediamime side (separate repo, coordinate with owner): add WS output of
  its shape events. threegrease side: nothing new — P2 WS + P4 routes
  already consume them; add an example scene mapping shape events to
  cursor speed/layer opacity.

**Accept**: mediamime demo drives a threegrease scene through the bridge
using only routes UI (no code).

---

## P10 — Performance pass (schedule before heavy generative scenes)

1. Incremental rebuild: per-layer dirty flags (draw touches one layer —
   rebuild only it; keep meshes per layer keyed by layer id + frame).
2. In-progress stroke fast path: append-only geometry buffer for the
   stroke being drawn (no full-layer rebuild per pointermove).
3. Bucket fill in a worker (transfer ImageData).
4. Stamp instancing: InstancedBufferGeometry for kind-3 stamps.
5. Budget: 60 fps with 100k stamp quads + 4 cursors + simulation layer.
Measure with a scripted scene (`window.__tg` eval) before/after; record
numbers in this file.

**Status (2026-07): items 1 shipped** — per-layer cached groups in
GPSceneRenderer with `markDirty(layerId?)`; drawing + string sim use the
scoped path. Measured on a 19,200-point scene: full rebuild 27.6 ms,
single-layer 2.7 ms (10.2x). Items 2-4 (append-only in-progress buffer,
worker fill, stamp instancing) remain open for a future pass.

---

## Cross-cutting tasks (do alongside phases)

- **Outliner** panel (objects/layers/canvases/cameras/splats/cursors/
  triggers; select/rename/visibility) — do with or right after P3.
- **Docs upkeep**: every phase updates README (user-facing), PLAN.md
  (checklist), HANDOFF.md (§2 inventory, §6 new gotchas), and this file
  (mark phase done, note deviations).
- **Examples**: one saved scene per shipped phase in `examples/`.
- **Testing habit**: every phase lands with a browser-eval verification
  snippet committed into `docs/verify/<phase>.md` so weaker models can
  re-run regression checks verbatim.


---

# Next phases (N-series, added 2026-07-12) — Blender-parity axis

Read PRD §1b/§1c first. Order below = impact order. Keep steps small,
commit each; typecheck+build always, deep verification only when cheap.

## N1 — Command palette (F3)  **[SHIPPED f1336bc]**
- `src/app/commands.ts`: registry `{ id, title, keywords, run(ctx, args?) }`.
  Sources: every keymap ACTION (auto-registered via runAction), every menu
  item, parameterized commands (add-object kinds, set brush preset,
  select object by name, mode switches).
- Palette UI: overlay input + fuzzy-filtered list (substring+initials
  scoring is enough), arrows+Enter, Esc closes; F3 + menubar Help entry.
- **Agent surface**: `window.__tg.execute('command id or title', args?)`
  resolving through the same registry; return value serializable. Document
  in HANDOFF as the official automation entrypoint.
- Later: command history, argument prompts ("add box at 1,2,0").

## N2 — Selection look & pivots  **[SHIPPED 42366e3 + OBJECT magnet snap]** (silhouette-quality outline still open — current is a Box3Helper, not a true selection silhouette)
- Orange outline on selected objects. Cheap pass: per selected object a
  Box3Helper (#ff7a00) sized to its world bounds, refreshed with glyphs;
  GP objects use their layer-group bounds. (True silhouette outline via
  postprocess later.)
- Pivot/origin dot per object (small orange dot at worldMatrix position,
  like Blender's origin) — becomes a snap target: extend cursorSnap +
  magnet snap modes with OBJECT (origins) alongside stroke points.

## N3 — Properties editor restructure  **[SHIPPED 5894e4a — sidebar-wide icon tabs; per-selection Bindings subsection still open]**
- Object mode right panel becomes tabs (icons): Object (transform/parent)
  · Material · Data (per-kind: GP layers?, splat info) · **Bindings**
  (routes touching this object, cursors/triggers/attachments referencing
  it, quick-create) · Modifiers.
- Wire/string/IanniX panels fold in as Bindings subsections when the
  selection is relevant (keep the standalone Score/Solvers panels until
  parity is comfortable, then retire).

## N4 — Modifier stack + Apply  **[SHIPPED: Ctrl+A c9c4cfa; per-modifier Apply a358f4d]**
- GP modifier stack exists; add per-object "Apply" for individual
  modifiers (bake evaluated strokes into the keyframe, remove modifier).
- Ctrl+A Apply Transform: GP = bake object matrix into stroke points and
  reset transform. MESH primitives = fold rotation+scale into a baked
  matrix? (three geometry is procedural — store a bakedMatrix on TGMesh
  applied before transform). SPLAT = fold transform into per-splat data
  via PackedSplats.forEachSplat/setSplat if feasible; else keep transform
  and report. The 3DGS import→scale→apply flow is the acceptance test.

## N5 — Everything-is-a-surface/field  **[SHIPPED: drawTarget + follow 16a2254; stroke-as-trigger-zone via TGTrigger.zone]**
- TGSplat.drawTarget flag → include SplatMesh in ctx.surfaces (Spark
  supports raycast; verify once). GP drawing lands on splat surfaces.
- Attractors + triggers gain `follow?: ObjRef` — position tracks the
  object's world matrix each frame (splat/mesh/GP as moving attractor or
  trigger zone). Cursors colliding with objects = trigger.follow.
- Stroke-as-trigger-zone: fire enter/leave when a cursor crosses within
  radius of ANY point of a named stroke (uses stroke.address).

## N6 — Hierarchy tree + assets  **[SHIPPED db124ac + d5f4010 — tree/drag-parent/rename; localStorage asset library]**
- Outliner: indented tree by parent, expand/collapse, drag-to-parent,
  double-click rename. Asset concept: "save object as asset" = GP-object
  JSON / mesh def stored in an assets list (localStorage or files dir),
  Add menu gains an Assets section.

## N7 — Icon pass  **[SHIPPED: mode/widget buttons + Stroke Ops panel icon-first; timeline/solver panels remain labeled by design (rare, one-off actions)]**
- Replace label buttons with icon+tooltip progressively (modes, panels,
  timeline). Keep a small icon helper (emoji or inline SVG map) — no
  icon-font dependency.

## N8 — Splat nibs (paint with splats)  **[scoped, not started]**
- StrokeStyle.texture (image stamp) first. Architectural note from
  inspecting materials.ts: the stroke shader is ONE ShaderMaterial shared
  across every stroke in a layer/blend group (per-stroke params ride
  vertex attributes: aStamp, aSeed, aColor, ...). A per-stroke image
  therefore needs a shared brush-texture ATLAS + a per-vertex atlas-UV
  attribute, not just a sampler2D uniform — real scope, not a one-line
  add. Do this before splat nibs, as a dedicated pass with its own
  verification (atlas packing, UV migration, GPSceneRenderer batching).
- Then "splat nib": stamps emitted as small gaussian clusters (writes a
  TGSplat per stroke or a generated splat set). Needs a research spike
  into Spark'''s in-memory splat construction API (existing code only
  reads via forEachSplat for PLY export — no write/construct path
  explored yet) before implementation.


## P11 — MediaMime integration  **[SHIPPED]**
- `src/io/mediamime.ts`: live landmark registry fed by the existing WS/OSC
  bus (no direct MediaPipe dep — threegrease consumes `<prefix>/...`
  addresses whose args are x,y[,z]; mediamime, or anything else, is the
  sender). Configurable prefix (default `/mm`) on `scene.mediamime`.
- `MMRig` (`scene.mediamime.rigs`): the mapping/rigging system — binds a
  live address to any object's translation (GP/mesh/splat/trigger), with
  offset + scale, parent-aware (world → parent-local each frame).
- Triggers are now a full `ObjKind` ('TRIGGER'): selectable, draggable via
  the transform widget, parentable, shown in the outliner tree — "every
  trigger is an editable primitive object in the hierarchy."
- MediaMime menu (menubar) + panel (🎥 properties tab): live address
  table with per-row ＋Trigger (spawn+rig in one step) / ＋Rig (attach an
  existing object), rig list with enable/scale/delete.
- Rig target picker is now an inline dropdown + Attach button (was a
  `prompt()` list). GP-stroke-vs-trigger proximity is now wired: any
  stroke point (sampled, ~60/stroke cap, parent-aware world matrix)
  within a trigger's radius fires it, same hysteresis/retrigger semantics
  as cursor-vs-trigger (score/engine.ts).
- Not done: no in-browser MediaPipe capture (intentionally protocol-only,
  matches the P9 design note).


## Object right-click context menu  **[SHIPPED]**
- src/tools/objectops.ts: Blender Object-menu operators — mirrorObject
  (flip a scale axis), clearObjectTransform (Loc/Rot/Scale/All),
  applyObjectTransformPartial (Loc/Rot/Scale — GP bakes into stroke
  points via a derived S⁻¹·R·S map so world position is preserved
  correctly under non-uniform scale; ALL delegates to the existing
  objects.ts full apply), snapSelectionToCursor / snapCursorToSelectionMedian.
  GP origin ops (originToGeometry / geometryToOrigin / originToCursor) use
  a shared retargetOrigin() that moves the local translation while
  shifting stroke points by the R·S⁻¹-transformed delta, so world-space
  geometry never jumps when the origin moves — verified numerically
  in-browser against hand-derived expected values for all three, plus
  mirror/clear/apply-scale/snap.
- ui.ts: generic openContextMenu(x, y, items) — flat items + one level of
  ▶ submenus, reuses the menubar's menu-pop/menu-item CSS. Wired to:
  viewport right-click in object mode (main.ts tracks RMB down/up,
  treats a <5px move as a click — a real drag still pans via
  OrbitControls, RMB context menu only fires on a stationary click), and
  outliner row right-click (selects the row first if not already
  selected). Verified end-to-end with real right_click/hover/left_click
  automation, not just unit-level ops.
- Blender's Center of Mass Set-Origin variants were intentionally
  dropped — GP strokes have no mass model, only Geometry↔Origin and
  Origin↔Cursor are implemented.


## Global Snap menu + cursor drag fixes  **[SHIPPED]**
- Root-caused and fixed 'cursor not snapping consistently': Shift+RMB
  only ever placed the cursor once on pointerdown; a held drag fell
  through to native OrbitControls RMB-pan instead of continuing to
  reposition the cursor. main.ts now tracks a cursorDrag state and calls
  placeCursor() on every pointermove until release.
- New CursorSnap 'SURFACE' (projection.ts raycastSurfaces()) — the 3D
  cursor (and the whole drag) can now ride a mesh or 3DGS surface, not
  just strokes/grid/plane.
- The magnet (settings.snap) is no longer EDIT-mode-only: it's a single
  always-visible topbar cluster (Cursor snap + 🧲 Magnet + target) that
  now also drives the OBJECT-mode translate widget
  (main.ts snapWidgetPosition(), INCREMENT/OBJECT targets) — one magnet
  setting, both modes, matching the ask for a Blender-style global snap
  that works in object and drawing modes. Verified live: two boxes
  dragged within 0.5 world units of each other snapped to the exact
  same Loc.
- Terminology: TGCursor (a stroke-riding playhead) is now labeled
  'Traveler' everywhere in the UI, reserving 'cursor' for the 3D cursor.
  Default new-traveler OSC address changed /cursor/{id}/pos ->
  /traveler/{id}/pos (only affects newly-created travelers; internal
  type/field names (score.cursors, TGCursor) are untouched — a full
  rename would ripple through serialize.ts and the Blender addon for no
  runtime benefit).
- New Shift+T 'Add trigger at 3D cursor' / Shift+G 'Add traveler on
  nearest stroke' — the drag-then-drop workflow: Shift+RMB drags the
  cursor along a stroke or surface, a keypress drops a marker where it
  landed. Both auto-registered in the command palette via the keymap.


## 3D cursor: real fix + Blender visual  **[SHIPPED]**
- The remaining cursor-drag bug: OrbitControls registers its pointerdown
  at construction (RIGHT = PAN), BEFORE App.bindEvents — so on Shift+RMB
  the camera pan started first and our bubble-phase handler could never
  stop it (the camera slid under the cursor drag; looked like broken
  snapping). Fixed with a capture-phase pointerdown that claims
  Shift+RMB via stopImmediatePropagation before OrbitControls sees it.
- Snap unification: the separate cursorSnap setting is RETIRED (removed
  from Settings/PREF_FIELDS/topbar/settings dialog). The 3D cursor now
  follows the ONE global magnet, like Blender: magnet off = free move on
  the drawing plane; magnet on = snap per mode. Magnet modes are now
  Grid / Stroke point / Object origin / Surface (mesh/3DGS raycast;
  legacy CANVAS prefs value treated as SURFACE everywhere).
- Verified with a synthetic Shift+RMB drag, gridStep 0.5: cursor stepped
  exactly 0 -> 0.5 -> 1.0 AND the camera position was bit-identical
  before/after (the old code panned it).
- Cursor visual: Blender-style red/white dashed ring + dark crosshair
  ticks, billboarded to the view and held at ~10px screen radius for
  both persp and ortho (updateCursorMarker in the render loop).


## Grid snap = the visible floor grid  **[SHIPPED aa3ae18]**
- Bug: INCREMENT snap rounded on a lattice laid over the CURRENT DRAWING
  PLANE (view-aligned by default), so the cursor snapped to an invisible
  grid floating in front of the camera instead of the visible floor.
- Fix: raycast the world ground plane (X·Y for Z-up, X·Z for Y-up) and
  round the two in-plane coordinates. Grazing views (front/side, floor
  edge-on and unhittable) fall back to the drawing-plane lattice, which
  in those views IS the vertical grid Blender shows in ortho.
- Verified live two ways: perspective drag landed on z=0 with x/y on the
  0.5 lattice at every sampled step; front-view drag held y constant
  with x/z on-lattice.

## Constraint system (Blender-style)  **[SHIPPED c1b511d..a8df48f]**
- ANY object can now be a traveler or a trigger: per-object constraint
  stack (TGConstraint on GP/mesh/splat/trigger, src/score/constraints.ts,
  evaluated every frame after ScoreEngine). Types: FOLLOW_PATH (traveler),
  TRIGGER (proximity zone vs all travelers incl. legacy score cursors),
  COPY_LOCATION/ROTATION/SCALE, TRACK_TO, LIMIT_DISTANCE, SHRINKWRAP,
  FLOOR, SPRING (damped, dt-clamped).
- Properties editor tabs are now a vertical icon column (Blender look);
  new Constraints tab (⛓️) with the grouped Add Object Constraint
  dropdown and per-constraint panels.
- Drag-along-path: widget-dragging a Follow Path object re-projects onto
  its stroke (ScoreEngine.nearestPhase) and edits the PHASE — travelers
  are leashed to their path; composes with the grid magnet.
- Shift+A Add menu at the mouse; on-stroke detection spawns travelers/
  triggers exactly at the clicked arc-length position.
- The legacy score cursors/triggers (Bindings tab) still work and remain
  the reference/event-dispatch panel; new work should prefer constraints.
  NOT migrated: existing TGTrigger entities and score.cursors are not
  auto-converted to constraints (both systems run side by side); legacy
  score-cursor glyphs cannot be dragged along paths (only constraint
  travelers can).

## Blender-style object target picker  **[SHIPPED 812db3e]**
- Constraint targets (and any future "pick an object" control) get three
  ways in, matching Blender's object field: an eyedropper (App.pickObject
  arms crosshair pick-mode; next viewport click resolves via the
  existing ObjectSelectTool.pick() raycast/proximity logic; Esc cancels),
  a dropdown of every GP/mesh/splat/trigger in the scene (self excluded),
  and an editable name field (exact-match on commit; an unmatched name
  reverts instead of silently clearing the target).
- src/app/ui.ts objectPickerField() is the reusable widget; the
  constraint panel's targetField() now just delegates to it. The
  MediaMime rig-target dropdown is the obvious next thing to upgrade to
  this widget if wanted — not done yet, kept as its own simpler flow.
- Verified live: armed the eyedropper, synthetic click on a sphere set
  the constraint target to that exact mesh id and the cursor reverted
  from crosshair; typing a valid object name retargeted it; typing a
  bogus name reverted the field rather than nulling the target.


## Blender G/R/S modal transform (object mode)  **[SHIPPED d0374cc]**
- src/tools/objectmodal.ts: the primary transform interface is now the
  Blender modal, not the gizmo. G/R/S -> mouse drives, LMB/Enter
  confirm, RMB/Esc cancel-and-restore. X/Y/Z axis lock, Shift+axis =
  plane lock, same key clears. G/R/S switch mid-modal, RR = trackball,
  digits = exact numeric (G X 2 / R Z 45 / S 3), Shift = precision.
- Ctrl INVERTS the global magnet during the gesture (both directions).
  Move snaps per magnet mode (grid / stroke point / object origin /
  surface); rotate 5-degree steps; scale 0.1 steps. This enables the
  "make an object, snap to stroke, attach to a GP, set as trigger" flow.
- App.applyWorldDelta() extracted from applyWidgetDrag — one shared
  path for gizmo + modal, so parenting and Follow-Path drag-as-phase-
  edit behave identically in both.
- Gizmo hidden by default (settings.showGizmo pref, topbar 🧭 toggle in
  object mode + settings checkbox); orange outline + origin dot remain.
  During a modal: Blender-style header overlay (Dx/Dy/Dz (len), angle,
  scale, 🧲 flag) + modifier hints in the status bar.
- Capture-phase pointerdown claims the confirm/cancel click before
  OrbitControls (same pattern as the Shift+RMB cursor drag).
- Not done: local-axis orientation on double axis-press (X X in
  Blender), B set-snap-base, automatic-constraint MMB. Edit-mode point
  modal (tools/transform.ts) still has its own simpler implementation.


## Fix: stroke-point snap only searched the active GP object  **[SHIPPED 9ce61f2]**
- gatherDepthCandidates() (projection.ts) is scoped to activeObject() by
  design (draw-time depth sampling), but every magnet/cursor POINT-snap
  call site routed through it too, so snapping silently ignored every
  GP object except whichever one was active - explains the reported
  "picks a random stroke and won't attach to any other" behavior.
- New nearestStrokePointAll(ctx, x, y, radius, scope) scans every
  scene.objects entry directly; scope ANY (default) or SELECTED.
  settings.snap.strokeScope wired into object modal, EDIT-mode point
  transform, and 3D-cursor drag - one shared setting, topbar dropdown
  shown when magnet mode is Stroke point.
- Verified against the exact reported scenario: two GP objects, only
  one active, dragging a mesh snapped onto the INACTIVE object's stroke.


## Mode pie menu + Edge snap  **[SHIPPED 1634824, f782d2f]**
- Ctrl+Tab opens a Blender-layout radial mode picker (ui.openModePie):
  Draw N/8, Sculpt S/2, Object W/4, Edit E/6, Weight NW/7, Vertex NE/9.
  Click a wedge or press its digit - works as a blind chord too, since
  Ctrl+Tab opens synchronously and starts listening before the next
  keydown lands. Tab is no longer hardcoded Draw<->Edit: App tracks a
  2-slot mode history and toggles back to whatever the previous mode
  actually was. Object mode gained its first keyboard entry point.
- Edge snap target added alongside Vertex (renamed from "Stroke
  point"): projection.ts nearestStrokeEdgeAll() finds the closest point
  on any stroke SEGMENT (not just its vertices), across every GP object,
  honoring the same Any/Selected scope. Wired into all three magnet call
  sites. This is what lets an object snap anywhere along a path, the way
  travelers already ride it continuously.


## Multi-select: Cmd/Ctrl alias + generalized active-object highlight  **[SHIPPED cb7e29c]**
- Investigated the report that shift/cmd multi-select "doesn't work":
  Shift-click multi-select was already correct in ObjectSelectTool, but
  Cmd/Ctrl-click was never wired as an alias (Mac users reaching for Cmd
  first found nothing), box-select never set an active/target object at
  all, and the brighter "active" selection-outline color only ever
  compared against scene.activeObject - i.e. GP objects only, so
  selecting a mesh/splat/trigger as the last-touched object never showed
  it as visually distinct even though parentSet (Ctrl+P) already
  correctly used objectPick.lastPicked as its target internally.
- Fixed: e.ctrl (already ctrlKey||metaKey) now also triggers add-to-
  selection; box-select sets lastPicked to the last matched ref;
  syncSelectionGlyphs' isActive check now compares against
  objectPick.lastPicked (falling back to the active GP) instead of
  scene.activeObject, so the active/target highlight works for any kind.
- Mode pie default combo moved from Ctrl+Tab to Alt+Tab (Ctrl+Tab is a
  browser-level tab-cycle shortcut that does not reliably reach page JS).
- Verified live: Cmd-click added a sphere to an existing box selection
  without deselecting the box, and the sphere (last-touched) picked up
  the bright active outline color while the box kept the dimmer
  selected color - read directly off the actual Box3Helper materials.


## Stroke Ops right-click menu + Separate  **[SHIPPED 1a82d80]**
- editops.ts separateSelected(): Blender GP Separate - moves the
  selection into a new GP object (same world transform, cloned
  materials so materialIndex stays valid, one new layer per source
  layer). Point-mode partial selections split first (reuses splitRuns),
  so only the selected run leaves.
- P is context-dependent: globally bound to Presentation mode, shadowed
  to Separate in Edit mode - same pattern as Emulate Numpad shadowing
  digit keys. Y (Split) already existed.
- ui.openStrokeOpsContextMenu(): RMB in Edit mode opens the full Stroke
  Ops set (transform, duplicate/delete/dissolve, split/separate/join/
  merge, subdivide/simplify/smooth, cyclic/direction/start-point,
  Normalize/Arrange/Snap/Move-to-Layer submenus) with shortcut hints
  auto-shown for every keymap-bound item.
- Verified live: whole-stroke separate and partial-point separate both
  correct (materials/positions checked exactly); P in Edit -> Separate,
  P in Object -> Presentation; live menu rendered all 20 items with
  correct shortcuts.


## Auto-Separate Connected Strokes + Origin to First Point  **[SHIPPED 19dfc40]**
- objectops.ts originToFirstPoint(): GP origin -> first point of the
  first stroke, geometry held fixed in world space. Added to the Set
  Origin submenu alongside the existing Geometry/Cursor variants.
- objectops.ts separateConnectedIntoObjects(): Blender Separate-by-
  Loose-Parts for GP. Partitions the CURRENT FRAME's strokes (every
  layer) into connected components by endpoint proximity - every stroke
  is a flood-fill seed (generalizes selectConnected/Ctrl+L's grow-from-
  selection graph into a full partition). Each component beyond the
  first becomes a new GP object (world transform + cloned materials
  preserved); EVERY resulting object gets its origin retargeted to its
  own first point. Scoped to the current frame only - documented as a
  deliberate limitation, not silently wrong for animated content.
- New object-menu item Auto-Separate Connected Strokes (single GP
  object). Verified live: 2-stroke connected chain + 1 isolated stroke
  -> exactly 1 new object; world-space geometry checked unchanged on
  both sides after the origin retarget.


## Multi-object Object Properties transform  **[SHIPPED c73b5a0]**
- Selecting 2+ objects used to collapse Object Properties to a dead
  "N selected - properties need one" message. New
  multiObjectTransformPanel(): shows the active/last-picked object's
  Loc/Rot/Scale; editing a field writes that value ABSOLUTELY to the
  same axis on every selected object (independent per axis) - type 0
  in Z, everyone drops to the ground plane, each keeping its own X/Y.
- App.getLastPicked() exposes the active/target ref to ui.ts.
- Verified live: 3 meshes at different Z, all selected, active shows
  its own Loc; typing Z=0 set all three to Z=0 exactly while X/Y per
  object stayed untouched.


## UI cleanup: icon Snap, resizable sidebar, dropdown focus, F2 rename  **[SHIPPED e68986b]**
- iconCheckbox() helper; magnet toggle is icon-only (tooltip carries the
  label), matching the rest of the icon-first topbar.
- #sidebar-resize drag handle, 200-640px clamp, persisted to
  localStorage (threegrease.sidebarWidth), calls resize() during drag.
- Root-caused a real bug, not just added a feature: App.onKey bails on
  every keystroke when e.target is SELECT/INPUT/TEXTAREA, but a
  <select> keeps focus after a pick or after Escape closes its native
  popup - silently killing every shortcut until a manual click into the
  viewport. Global change-listener blurs any SELECT after a pick;
  capture-phase Escape listener blurs a focused SELECT too.
- Root-caused "right-click rename does nothing": renameViaPrompt() used
  window.prompt(), which is silently blocked/no-op in sandboxed embeds -
  no error, no dialog, just nothing, which is exactly what was reported.
  Replaced with renameObjectInline(), reusing the outliner's existing
  working double-click-to-edit field (row located via a new data-ref
  attribute); F2 is a new keymap action calling it on the active/last-
  picked object from anywhere; the context-menu item now shares the
  same path and hints "(F2)".
- Verified live: icon-only checkbox render; sidebar drag 288->368px +
  persisted; SELECT focus lost on both change and Escape (checked via
  document.activeElement); F2 and right-click Rename both open the real
  inline field and commit correctly (verified with a real blur
  FocusEvent, since .blur() itself does not synchronously fire in this
  headless harness).


## Selection outline only + theme-aware colors  **[SHIPPED 14bda5f]**
- Root-caused "whole object highlighted instead of an outline like
  Blender": MeshManager.apply() was setting an emissive tint on every
  selected mesh's material, on top of the existing Box3Helper outline -
  the tint dominated visually. Removed it; selection feedback is now
  the outline + origin dot only.
- Added Theme settings (context.ts): uiAccent, uiHighlight (Vec3, drive
  both --accent/--accent2 CSS vars via App.applyThemeColors() and the
  three.js selection glyph colors via App.highlightColor()), gridColor
  (Vec3 | null - null means auto-contrast against settings.background
  luminance).
- GridHelper bakes vertex colors at construction, so recoloring means
  disposing and rebuilding (App.rebuildGrid()); called from
  setBackground() and from the new Settings dialog rows.
- Settings dialog gained a "Theme" section: Accent + Highlight color
  fields, and an "Auto grid color (matches Background)" checkbox that
  reveals a manual Grid color field when unchecked.
- Verified live: selected plane shows outline-only (no fill wash);
  Settings dialog Theme rows render; changing Highlight recolors the
  selection outline live; toggling Auto grid color off + setting a
  manual grid color rebuilds the grid with the new color; restored
  defaults after testing.


## Set Origin for MESH objects + Origin to Geometry (Base)
- Set Origin (Origin to Geometry, Origin to 3D Cursor) previously only
  worked on GP objects — disabled for mesh/plane objects, including
  image planes (which are PLANE mesh objects post canvas-retirement).
  Extended objectops.ts's origin ops to primitive MESH kinds
  (PLANE/BOX/SPHERE/CYLINDER; MODEL/loaded geometry stays unsupported —
  no known local bounds without a runtime geometry query).
- Primitive geometry is procedural (built fresh from `kind` in
  render/meshes.ts, not persisted per-vertex like GP strokes), so moving
  its origin without moving the geometry needed a new persisted field:
  TGMesh.originOffset (Vec3, default [0,0,0]) — the MESH-kind analog of
  GP's retargetOrigin point-shift, baked into the geometry's vertex
  buffer incrementally by MeshManager.sync() (geometry.translate() by
  the delta between old/new offset) whenever originOffset changes.
- New op: Origin to Geometry (Base) — moves the origin to the XY-center
  of the object's bottom face (min along the up axis), for staging/
  floor-placement. Works for GP (from point bounds) and primitive MESH
  (from a canonical per-kind local-bounds table matching the
  primitiveGeometry() constructors in meshes.ts).
- Verified live: added a box, moved it to [2,3,5], ran Origin to
  Geometry (Base) — origin landed at [2,3,4.5] (bottom face) with
  world-space bounding box unchanged ([1.5,2.5,4.5]..[2.5,3.5,5.5]);
  Origin to 3D Cursor for MESH also verified (world bounds pinned,
  translation moved to cursor); confirmed through the real right-click
  Set Origin submenu (both new/extended items enabled for a MESH
  selection, GP-only items correctly still disabled); undo correctly
  reverts both translation and originOffset.


## Aesthetic pass: consistent icons, prettier checkboxes, outliner view/lock
- New src/app/icons.ts: a curated set of Heroicons-style outline SVGs
  (24x24 grid, 1.6 stroke, round joins — same visual language as
  heroicons.com, redrawn inline since the app has no external asset
  fetching at runtime). icon(name) returns a fresh <svg>, sized/colored
  via CSS (.hi { stroke: currentColor }) so it follows button/text color
  including hover/active/disabled states automatically.
- btn() now accepts a Node label (not just string), so call sites can
  pass icon('eye') etc. Swapped every emoji/unicode glyph icon-btn in
  ui.ts (close/delete, eye/eyeOff, lock, chevron up/down, play/pause,
  download, outliner kind icons, draw-target/wireframe toggles) for the
  new icon set — one visual language app-wide instead of mismatched
  platform emoji rendering.
- Checkboxes: replaced the OS-native control with a CSS-only prettied
  one (input[type=checkbox] { appearance:none } + a hand-drawn checkmark
  and --accent fill) — applies globally with zero call-site changes,
  themes off the same accent color as everything else.
- Outliner view/lock: GP objects and triggers gained object-level
  hide/lock fields (previously GP visibility was per-layer only, and
  triggers had neither); mesh/splat gained lock (visible already
  existed). Every outliner row now has a consistent eye/lock icon pair
  (viewLockBtns() in ui.ts) — eye toggles rendering (GPSceneRenderer
  respects ob.hide via group.visible; mesh/splat already read
  .visible), lock blocks viewport click/box-select
  (isObjectLocked()/objects.ts, checked in ObjectSelectTool.onUp) while
  the outliner row itself remains clickable — Blender's "lock guards
  against stray clicks, not every path to selection" behavior.
- Verified live: box hidden via row eye icon (mesh disappears, outline
  glyph still shows since still selected); box locked via row lock icon
  then viewport click on it left select:false (blocked), outliner-row
  click still set select:true while lock:true (Blender-style), unlock
  via the row icon restored viewport click-select.


## Aesthetic pass part 2: convert every remaining icon app-wide
- Extended src/app/icons.ts with the rest of the app's icon vocabulary
  (eraser, line/polyline/arc/curve/hand tool glyphs, folder, wrench,
  compass, rotate, gear, floppy, photo, target, skipBack, check, invert,
  arrow up/down/right) so every icon-btn/toolbar/mode/pie/tab-strip glyph
  in the app now draws from the same Heroicons-style set, not just the
  outliner (previous entry).
- Converted: draw-mode toolbar (12 tools), edit/sculpt/vertex/weight
  toolbars, topbar mode buttons + gizmo/widget buttons, magnet snap
  checkbox, mode pie menu (6 slots), sidebar tab strip (8 tabs), Stroke
  Ops panel (18 icon buttons), texture load/clear, onion toggle, layer
  move up/down, modifier apply/reorder, camera-view/settings-gear/
  playback-skip topbar icons, mask-remove chip, string-art/camera-target
  image buttons, event-monitor play/pause. iconLabel() helper added for
  buttons needing icon+text together (e.g. "replace texture…").
- Left as plain text (no icon conversion): the standard ✓ menu-checkmark
  prefix (CtxItem.label is string-only; converting would mean a larger
  CtxItem-type change for one glyph) and a few decorative panel-title
  emoji prefixes, which were simply removed rather than iconified.
- Verified live: reloaded and screenshotted Draw/Object/Edit modes, the
  mode pie, and Data/Stroke-Ops panels — no emoji glyphs remain in any
  toolbar, mode switcher, tab strip, or icon-btn; tsc + vite build clean.


## Fix G-modal axis/plane lock: object now tracks the actual constraint plane/line
- Root cause: Shift+axis (plane lock) and plain axis lock both derived
  their delta from `viewPlaneHit` — a ray intersected with a
  VIEW-ALIGNED plane through the pivot — then post-filtered by
  subtracting/keeping the locked axis's component. That view plane only
  coincides with the real constraint plane when looking straight down
  the locked axis; from any other angle the filtered point drifts away
  from where the mouse ray actually meets the real plane/line, which is
  what "the motion seems relative" was describing (Shift+Z should put
  the object exactly under the cursor on the world XY plane).
- Fix (src/tools/objectmodal.ts): two new projections — `axisPlaneHit`
  (ray ∩ the REAL plane through the pivot, normal = locked axis, for
  Shift+axis) and `axisLineHit` (closest point on the 3D line through
  the pivot along the axis, standard skew-line closest-point solve, for
  plain axis lock). `projectedHit()` picks the right one (or falls back
  to the view plane when unconstrained). `setAxis()` now re-anchors
  `startWorld` through the NEW projection at the gesture's start
  pointer whenever the lock changes — mixing anchors from two different
  projections (old bug) is what caused the drift; recomputing from a
  single consistent projection removes it.
- Verified live via `tg.objModal` directly (begin/setAxis/update):
  Shift+Z keeps Dz exactly 0 and the result is PATH-INDEPENDENT (same
  end pointer via a direct jump vs. 4 intermediate moves produces
  bit-identical translation) — confirms it's a true absolute ray/plane
  intersection, not an accumulating relative delta. Plain Z lock keeps
  Dx/Dy exactly 0. Mid-drag lock toggle produces no NaN. HUD/viewport
  screenshot confirms the box lands exactly on the ground plane under
  the cursor's direction.


## Fix Origin to Geometry (Base) for rotated objects + real edge-outline for box/plane
- Root-caused "Base puts origin on the unrotated object's base, not the
  rotated bounding box's": `originToGeometryBase` computed the LOCAL
  bounds' min corner (a single point), then transformed just that one
  point to world via the object's full matrix. Rotation doesn't commute
  with "take the min corner then transform" — the local-min corner
  generally stops being the world-space-lowest corner once rotated
  (`localMin.applyMatrix4(rotated)` != `worldBox.min`). Fixed with a new
  `worldAABB()` (objectops.ts) that transforms all 8 corners of the
  local box and takes the AABB of the results, so "Base" now means the
  rotated object's actual lowest world point, matching the rotated
  bounding box shown in the second reference screenshot. Applies to
  both GP (localBoundsGP) and primitive MESH (meshLocalBounds).
- Added a real per-edge outline (Blender-style, matching the requested
  reference image) for BOX/PLANE mesh objects: `meshEdgePositions()` in
  main.ts builds a `THREE.EdgesGeometry` of the object's ACTUAL geometry
  and transforms every edge point through the object's world matrix, so
  a rotated box outlines its own rotated edges instead of an
  axis-aligned bounding box. Scoped to flat-faced primitives only
  (BOX/PLANE) — their edges genuinely ARE the visual silhouette from any
  angle; SPHERE/CYLINDER/MODEL keep the bounding-box outline since a
  literal wireframe of a curved/arbitrary mesh doesn't read as a
  silhouette (true screen-space outline detection is a separate, bigger
  feature, out of scope here).
- Verified live: rotated a box (rotation [0.6, 0.4, 0.3]), ran Origin to
  Geometry (Base) — origin dot lands exactly on the rotated box's lowest
  world corner, touching the grid (screenshot); selection outline traces
  the box's actual rotated edges, not an axis-aligned box; a sphere
  selected alongside it still renders (falls back to bbox outline, no
  crash).


## Timeline transport bar: icons, uniform sizing, frame label cleanup
- Icon-ified the remaining timeline-control glyphs: prev/next keyframe
  (◀◀/▶▶ → chevronsLeft/chevronsRight), +Key/+Dup/−Key/Interpolate/
  Sequence/+Cam/−Cam/+CamKey/−CamKey now use iconLabel() (icon + short
  text) instead of plain-text buttons with ASCII +/− glyphs. Added
  chevronsLeft/chevronsRight/minus/key/duplicate to icons.ts.
- New `.tl-transport` CSS class (28x26px, flex-centered) applied to the
  four playback-scrubber buttons (jump-to-start, prev-keyframe, play/
  pause, next-keyframe) so they're uniform size regardless of icon
  shape — previously mixed icon-only and ASCII-text buttons of
  different widths.
- Removed the "Frame" text label before the frame-number readout (just
  shows the number now); added a `title="Current frame"` hover tooltip
  in its place.
- Play/pause was already wired correctly (icon + title flip via
  `isPlaying()` on every refreshTimelineControls() call, driven by the
  render loop while playing) — verified explicitly since it was called
  out: clicking Play starts playback and swaps to the pause icon/title
  ("Pause (Space)"), frame counter advances live during playback,
  clicking again stops it and swaps back to "Play (Space)".


## Timeline transport bar: icon-only (no text labels)
- Dropped the icon+text (iconLabel) buttons added in the previous pass
  in favor of icon-only, per feedback — e.g. the camera icon alone for
  Add/Delete Camera instead of a "Cam" text label. Insert/Duplicate/
  Delete Keyframe now use key/duplicate/trash icons; Interpolate/
  Sequence use arrowsRightLeft/link; Camera Key add/remove reuse key/
  trash (position + tooltip disambiguate from the stroke-keyframe
  versions, matching how the rest of the icon-only toolbar already
  works). Auto-key and Lock stay as labeled checkboxes (a toggle state
  needs its label; there's no unambiguous single icon for either).
- Verified live: timeline row renders as a compact icon-only strip;
  read every button's title attribute via the DOM to confirm tooltips
  still fully describe each action (Jump to start / Previous keyframe /
  Play / Next keyframe / Insert-Duplicate-Delete keyframe / Interpolate
  / Sequence / camera-view toggle / Add-Delete camera / camera keyframe
  add-remove / Settings).


## Timeline: dedupe icons + reliable custom hover tooltips
- De-duplicated the timeline transport bar's icons — Add/Delete Camera
  and Add/Remove Camera-Key were reusing camera/key/trash from other
  buttons in the same row. Remapped to plus/xMark (camera add/delete)
  and pin/minus (camera-key add/remove) so all 15 buttons in the row
  now use distinct icon paths (verified live: 0 duplicate `<path d>`
  values across every #tl-controls button).
- Native `title`-attribute tooltips are slow/inconsistent (especially
  in embedded/preview contexts), which read as "no hover tips" on an
  icon-only toolbar with no visible text to fall back on. Added a
  CSS-only instant tooltip (`content: attr(title)` on `::after`) for
  `.icon-btn`, `.tl-transport`, and `.props-tab` — reuses the existing
  title attributes app-wide, no per-callsite changes, appears
  immediately above the button on hover.
- Verified live: hovering Play shows a "Play (Space)" tooltip rendered
  above the button; icon audit script confirms zero duplicate icon
  paths in the timeline row.


## Icon-ify the Shift+A Add-at-pointer context menu
- Missed in the earlier icon sweeps: the Shift+A "Add — at pointer/on
  stroke" menu (main.ts openAddMenu()) still had emoji-prefixed labels
  (🚶/◎/✏️/⬛/⚪/⬭/⌖). Added an optional `icon?: IconName` field to
  CtxItem (ui.ts) and render it in openContextMenu()'s row builder
  (`.menu-icon` span before the label) — a general mechanism any
  context menu can now opt into, not just this one.
- Mapped each item to a distinct icon: Traveler→cursorArrow,
  Trigger→boltCircle (matches the outliner's trigger icon), Grease
  Pencil→pencil, Plane/Box/Sphere→square/cube/circle, Cylinder→new
  `cylinder` icon (added to icons.ts), Move 3D cursor here→target
  (matches the actual 3D-cursor crosshair glyph in-viewport).
- Verified live: opened the menu via `tg.openAddMenu()` — every row
  shows a clean outline icon consistent with the rest of the app, no
  emoji remaining.


## Fix sidebar hover-tip clipping: JS position:fixed tooltip
- The CSS-only `::after` tooltip (previous entry) was clipped by any
  ancestor with overflow:hidden/auto — the sidebar tab strip
  (`.props-tabs { overflow-y: auto }`) cut it off exactly as reported
  ("hover tips in the sidebar icons are getting cropped"). z-index
  can't fix this: overflow clipping happens regardless of stacking
  order for a descendant of the clipped box.
- Replaced with a JS-driven tooltip (`UI.initHoverTips()`): on
  mouseover of `.icon-btn/.tl-transport/.props-tab[title]`, spawns a
  `position: fixed` div appended directly to `<body>` (not a descendant
  of any clipped container), positioned from the hovered button's
  `getBoundingClientRect()`, clamped to the viewport, flips below the
  button if there's no room above. Single delegated listener on
  `document.body`, no per-button wiring.
- Verified live: hovered the Data tab (sidebar) and MediaMime tab —
  both tooltips now render fully, floating over the viewport past the
  sidebar's own bounds, matching the reported crop exactly reproduced
  and fixed.


## Native MediaMime milestone 1: landmark streams as scene point clouds (branch: mediamime)
- New direction (branch `mediamime`): instead of bridging an external
  mediamime app, landmark capture is NATIVE — in-app webcam + MediaPipe
  tasks-vision (new dep, lazy-imported so the main bundle only pays for
  it when capture starts; wasm served from node_modules in dev with a
  pinned-CDN fallback, .task models from Google's model CDN).
- Data model: `MMStream` (core/types.ts) + `scene.mmStreams` — a live
  landmark stream (POSE 33 pts / HAND_LEFT / HAND_RIGHT 21 pts / FACE /
  CUSTOM) as a first-class scene citizen with its own transform, mirror,
  and splat look. Only CONFIG persists; live frames are runtime-only in
  `StreamStore` (src/mm/streams.ts), packed [x,y,z,confidence] per point
  in stream-local Y-up coords — the stream's transform places it in
  world (default rotation stands figures upright in Z-up scenes, same
  trick as createDefaultCamera).
- Two sources for the same representation: CAMERA (src/mm/capture.ts,
  MMCapture: getUserMedia + Pose/Hand landmarkers, per-landmark
  visibility as confidence, handedness score for hands, empty-frame push
  when a hand leaves) and BUS ('<address>/<index>' events x,y[,z[,conf]]
  — the old bridge path now feeds the native representation, and is the
  headless test path).
- Visualization: src/mm/points.ts StreamPointsManager — one THREE.Points
  per stream, custom soft-gaussian sprite shader ("splat" look),
  CONFIDENCE EMBEDDED per point as a vertex attribute modulating sprite
  alpha and/or size (per-stream toggles). Buffers update in place on a
  store version bump — no scene rebuild for live data. Point size is
  world-space, correct for persp AND ortho (projectionMatrix[1][1]/w).
- Streams as pens/cursors/travelers, step 1: CAMERA streams re-emit
  world-space landmarks onto the event bus ('<prefix>/pose/<i>' etc.,
  emitBus toggle, 250ms freshness gate so a stopped camera doesn't
  re-broadcast its last pose forever) — the EXISTING rig/route/trigger
  machinery rides them today; deeper native bindings (stream landmark as
  draw-pen, FOLLOW_STREAM constraint) are the next milestones.
- UI: "Streams — native capture" panel (MediaMime tab): Start/Stop
  camera with status + error row + live preview video, ＋Pose/＋Hands/
  ＋Bus-stream, per-stream rows (eye, color, live point count, size,
  conf→α, conf→size, mirror, emit bus, delete).
- Gotcha reinforced twice during verification: after ANY mid-session
  file edit, import('/src/...') in evals returns a DIFFERENT module
  instance than the app's (vite ?t= timestamps) — singletons diverge
  silently. App now exposes `__tg.mmStore` for automation; use __tg
  surfaces, never fresh imports, for app-state singletons.
- Verified live (headless, camera blocked in the embed): BUS stream
  renders an 8-point ring with visible confidence fade; CAMERA-kind
  stream fed via __tg.mmStore renders and re-emits; panel shows live
  addresses in world coords; a GP object rigged to /mm/pose/0 lands at
  the streamed head (0,0,1.8) and TRACKS a fresh frame (mirror math
  confirmed: local +0.25 → world −0.5 at scale 2); camera-denied path
  degrades to a "! Permission denied" row without killing the loop.
