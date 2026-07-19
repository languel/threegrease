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


## Capture from URL/file video or animated webp/gif (no camera needed)
- The webcam can be replaced by a URL or local file as the capture
  source (`mmCapture.start(scene, {url}|{file})`, panel: URL field +
  play button + file… picker) — for testing/iterating in environments
  where camera access is blocked (e.g. the embedded verification
  browser), and for running detection over found footage.
- URL handling: fetched ONCE with CORS (pixel reads require CORS
  anyway, so failing early at fetch gives a clear error), then branched
  on the real content-type, not the extension. video/* plays from a
  blob URL (same-origin, so WebGL reads never taint); image/* (animated
  webp/gif/apng — which <video> cannot play) decodes frame-by-frame via
  the WebCodecs ImageDecoder onto a canvas, honoring each frame's own
  duration and looping forever; the canvas is fed to detectForVideo as
  the ImageSource. tick()'s new-frame check generalizes: video uses
  currentTime, canvas uses a frame counter. The panel previews
  whichever source element is live (video mirrored only for the actual
  selfie camera).
- Verified END-TO-END in the embedded browser (camera blocked there —
  the whole point): capture from https://i.giphy.com/Ju7l5y9osyymQ.webp
  → wasm loads from node_modules, pose model from Google CDN, 33-point
  pose detected within the first poll, 37 detection frames in 1.2s, the
  right-wrist landmark travels ~1.0 local units across 1.4s (he's
  dancing), confidence fade visible on the out-of-frame leg landmarks,
  zero console errors. First time the full native MediaPipe pipeline is
  verifiable headlessly.


## Face + iris streams, per-stream depth scale (flat pose by default)
- Root cause of "weird depth" on pose: MediaPipe's normalized-landmark z
  for POSE is hip-relative guesswork (and my aspect scaling amplified
  it), while hands/face/iris z is genuinely useful relative depth. New
  per-stream `depthScale` (numField in the panel) bakes into
  streamWorldMatrix alongside mirror, so render / world-landmark / bus
  emit all agree; POSE defaults to 0 (flat), everything else 1.
- New kinds: FACE (478 points via FaceLandmarker — the tasks-vision
  face model includes iris refinement, unlike HolisticLandmarker's face
  output) and IRIS (the 10 iris landmarks extracted from the same
  face result as their OWN stream, so an eye can drive a
  cursor/pen/trigger). ＋Face button adds both. Face defaults:
  pointSize 0.012 (478 pts at pose size would blob), emitBus OFF (478
  bus events/frame would swamp listeners — opt-in); IRIS emits.
- Verified live on the giphy webp: all three detectors run
  simultaneously (33/478/10 points), pose world-depth spread is exactly
  0 (flat), face spread ~0.57 world units when detected (real nose-to-
  ear relief), iris ~0.03 (both eyes near one plane); face detection is
  intermittent on that footage (small/turning face) and the
  empty-frame push correctly hides the points between detections;
  /mm/iris/N live on the bus, zero console errors.


## Playback speed control for URL/file capture sources
- New `mmCapture.playbackRate` (0.1×–3×): applies to `video.playbackRate`
  for video sources, and divides the animated-image frame delay
  (webp/gif/apng) for the WebCodecs decode loop — one control covers
  both source types transparently. No effect on the live webcam (not
  offered in the UI for that case).
- Panel: a "speed" slider + live ×-readout + 1× reset button, shown
  whenever a non-webcam capture is running. `App.mmSetPlaybackRate()`
  wired through so it's driveable from automation too.
- Verified live on the giphy webp: store-frame throughput scales with
  rate (7 frames/s at 0.25×, 31 at 1×, 58 at 3× — sub-linear at the top
  end since detection cost + a 15ms frame floor cap it, but the
  direction and rough magnitude track correctly); UI slider drives the
  same `mmSetPlaybackRate` path the automation check used.


## N-panel selected-object display, Shift+A adds at cursor, full Snap submenus
- **N-panel fix**: the Item section always read `activeObject(scene)` (the
  GP object), so selecting a mesh/splat/trigger in Object mode still
  showed "Pencil1". Now OBJECT mode reads the actual object-mode
  selection (`listSelectedObjects` + `getLastPicked()` as the active
  ref, same pattern as the multi-object Object Properties panel) and
  shows `Object: <name> (<KIND>)` with a live-editable transform for
  ANY selected kind via `getObjectTransform`/`setObjectTransform`; other
  modes still show the one active GP object being edited, unchanged.
- **Shift+A now adds at the 3D cursor** (Blender parity) instead of the
  mouse-pointer-projected position. Traveler/Trigger "here" stay
  pointer-relative on purpose — a traveler must land ON the actual
  stroke under the pointer to attach FOLLOW_PATH, and "Trigger here"
  is deliberately a different action from adding one at the cursor.
- **Full Blender-style Snap submenus**, both Object mode (RMB) and Edit
  mode Stroke Ops (RMB): Selection to Cursor / Grid / Cursor (Keep
  Offset) / Active, Cursor to Selected / World Origin / Grid / Active —
  8 items each, all newly added except the 2 that existed before (whose
  semantics were fixed in the process — see below). GP Edit mode gets 4
  more: Selection/Cursor to Stroke Start/End.
- **Real bug fixed while adding this, not just new features**: the
  pre-existing "Selection to Cursor" (both point-level and object-level)
  only ever implemented what Blender calls "Keep Offset" (the whole
  selection moves as a rigid group). Blender's actual default collapses
  every selected element individually onto the cursor. Fixed the default
  to collapse (matching Blender and the newly-added menu item's name)
  and moved the old rigid-group behavior to the new explicit "(Keep
  Offset)" item — `ops.snapToCursor(ctx, keepOffset)` and
  `snapSelectionToCursor(scene, keepOffset)` both default to `false`
  (collapse). The Stroke Ops panel's existing "Snap to 3D cursor" icon
  button keeps working (now correctly collapses, like Blender's
  toolbar).
- New ops: objectops.ts gained `snapSelectionToGrid/Active`,
  `snapCursorToWorldOrigin/Grid/Active` (all via a shared `worldPos`/
  `setWorldPos` pair so every ObjKind — GP/MESH/SPLAT/TRIGGER — works
  identically). editops.ts gained the point-level equivalents plus
  `snapSelectionToStrokeEnd`/`snapCursorToStrokeEnd` (per-stroke, so a
  multi-stroke selection snaps each stroke to its OWN start/end rather
  than one global point) — "active" for points is the last-touched
  selected point (no dedicated active-point tracking exists, same
  degradation object mode already uses for its own "active").
- Verified live: Shift+A → Box with the pointer far from the cursor
  spawned exactly at cursor coords, not the pointer; N-panel shows
  "Object: box (MESH)" after selecting a mesh (previously always
  "Pencil1"); object-mode Snap submenu renders all 8 items, and
  `snapSelectionToActive` moved a follower mesh exactly onto the active
  mesh's position; edit-mode Snap submenu renders all 12 items (8 + 4
  GP), and `snapCursorToStrokeEnd(ctx,'start')` moved the cursor to the
  exact stroke-start coordinate.


## New "Scene" sidebar tab (grid + background), grid step defaults to 1 + subdivisions
- New sidebar tab "Scene" (globe icon), placed FIRST in the vertical tab
  strip so it sits above Objects: Grid (Step, Subdivisions, Auto/manual
  color) and Background (color) — settings that were previously buried
  in the modal Settings dialog are now always one click away, Blender
  Scene-properties style.
- `gridStep` default changed 0.5 → 1; new `gridSubdivisions` setting
  (default 10, persisted) controls minor-line density between major grid
  lines. The visual grid was previously a hardcoded 20×40 GridHelper
  completely decoupled from the `gridStep` setting (which only drove
  magnet-snap increments) — real inconsistency fixed here: `makeGrid()`
  now sizes the grid as `gridStep * 20` major cells and
  `20 * gridSubdivisions` total divisions (clamped to 400 for perf), so
  the visual grid and the snap increment finally agree, and changing
  either setting calls the existing `rebuildGrid()` (GridHelper bakes
  colors/geometry at construction, so a value change means a new one).
- Removed the now-duplicate Grid step / Background / Auto-grid-color
  rows from the Settings dialog's Preferences body, replaced with a
  one-line pointer to the Scene tab; Theme (Accent/Highlight) and the
  rest of Preferences are unchanged.
- Verified live: fresh load (cleared localStorage prefs) shows
  gridStep=1, gridSubdivisions=10; Scene tab renders as the first/top
  tab with Step/Subdivisions/Auto-color/Background controls; changing
  gridSubdivisions from 10→2 measurably changes the GridHelper's vertex
  count (804 → 164) and rebuilding back to 10 restores it; Settings
  dialog confirmed to no longer contain the removed rows.


## MM streams: objects, binding, spatial events, clips (the big consolidation)
Design principle honored throughout: NO new parallel systems. Points are
splats, curves are paths, binding is constraints, events are triggers —
every new capability lands inside an existing concept.

- **Streams are first-class objects** ('STREAM' ObjKind + ParentRef kind):
  selectable (click/box-select/outliner, wave icon), transformable
  (G/R/S, widget, N-panel — grab the BB and place a stream anywhere),
  parentable, lockable, deletable, constraint-carrying. Selection glyph
  bounds come from the LIVE frame data (StreamPointsManager maintains
  geometry.boundingBox over the drawRange each buffer update; empty-box
  fallback now centers on the data-model world matrix since
  matrix-driven objects keep .position at 0).
- **FOLLOW_STREAM constraint** — binding = the existing constraint
  stack: streamId + landmark index drives the carrier to
  streamLandmarkWorld() with influence lerp; composes with SPRING
  (smoothed follow), TRACK_TO, LIMIT_DISTANCE etc. Constraint panel gets
  a stream dropdown + landmark field with common-index hints. Driven
  objects also register as trigger probes (like FOLLOW_PATH travelers).
- **Spatial events = TRIGGER constraints with SHAPES**: the carrier
  object's kind defines the zone — BOX/SPHERE/CYLINDER primitives test
  their actual local-bounds volume (originOffset-aware via
  meshLocalBounds), PLANE fires on side-CROSSING within its extent
  (lastSide tracking), anything else keeps the radius sphere. Probes now
  include every landmark of probe-enabled streams (per-stream `probe`
  toggle, FACE off by default — 478 probes/frame). New `leaveMessages`
  fire on exit. "RH enters a virtual box / body part crosses a plane" is
  now literally: box or plane mesh + TRIGGER constraint.
- **REAL BUG FOUND**: ConstraintEngine.update() was imported and
  documented as running in the frame loop ("runs AFTER ScoreEngine" per
  CLAUDE.md) but was NEVER actually called anywhere — constraints only
  ever applied through side paths (widget drag re-projection etc). Now
  wired into the loop after score.update + surfaces gathering, wrapped
  in try/catch like gp.update (loop-killing exceptions gotcha).
- **Clips** (`TGClip`, scene.clips): recorded point-sets-over-time in
  WORLD space [x,y,z,confidence] — "splats × time". ClipRecorder
  records a whole stream (sampled on store-version change = capture
  rate) or ANY object's origin trajectory (~60Hz — travelers, followers,
  anything). Playback reuses the stream concept: CLIP-source MMStream
  replays frames through the same streamStore with a traveler-style
  clock (play/pause, phase scrub, speed, LOOP/PINGPONG/ONCE via the
  score engine's advancePhase), so replays render/constrain/probe/emit
  exactly like live capture; the stream's own transform re-places the
  replay anywhere. Bake = clip → GP strokes (one per landmark,
  CONFIDENCE → PRESSURE) in a new GP object — recordings become paths
  the whole traveler/trigger ecosystem rides.
- **Clips panel** (MediaMime tab): ● record per stream row +
  record-selected-object; clip rows with rename, duration/points/frames,
  ▶ play-as-stream, bake-to-strokes, delete. CLIP stream rows grow the
  transport (pause/phase/speed/loop).
- Automation surfaces added to __tg (background-tab rAF throttle makes
  wall-clock waits unreliable; drive engines manually): `constraints`
  (engine), `mmRecorder`, `mmClipTick(dt)` alongside the existing
  `mmStore`.
- Verified headlessly, all through app-instance surfaces: STREAM
  selection glyph + transform moves the rendered cloud (matrix x 0→3);
  FOLLOW_STREAM sphere lands exactly on the landmark and tracks fresh
  frames; box zone fired /zone/enter then /zone/leave as a stream point
  passed through; plane zone fired /zone/cross on a z-sign flip within
  extent; 14-frame circle recording → CLIP replay orbits the circle
  under manual clip ticks → bake produced "clip: …" GP object, 14-point
  stroke, pressure 1.0→0.7 from the recorded confidence ramp; screenshot
  shows live point, replay point, transport UI, clips panel, and the
  baked stroke with visible pressure taper.

## Dashed grid subdivisions + snap-to-subdivision by default
- **Grid rendering rebuilt off `THREE.GridHelper`**: it bakes one flat
  vertex-colored geometry, so major and minor lines couldn't have
  different STYLES (only color, via the pre-existing main/sub tint) —
  dashing needs `computeLineDistances()` per `LineSegments` object.
  `makeGrid()` now builds a `THREE.Group` of two separate line objects:
  major lines (always solid) and minor/subdivision lines, whose material
  is chosen from the new `gridSubdivStyle` setting (`'dashed'` default,
  `'solid'` alternative) — `THREE.LineDashedMaterial` with dash/gap sized
  relative to the minor spacing, or a plain `LineBasicMaterial` tinted
  60% dim like before. `this.grid` is now `THREE.Group`, not
  `THREE.GridHelper`; `rebuildGrid()`'s disposal walks children instead
  of touching a single geometry/material.
- **Snap default fixed**: the INCREMENT magnet was snapping to
  `gridStep` (the major line spacing) everywhere — objectmodal.ts,
  transform.ts (EDIT-mode point drag), main.ts (3D-cursor drag + OBJECT
  widget), and the explicit "Selection/Cursor to Grid" ops all read
  `ctx.settings.gridStep` directly. New `snapIncrement(settings)`
  (tools/context.ts) returns `gridStep / gridSubdivisions` — the visible
  MINOR grid spacing — and every one of those six call sites now goes
  through it instead of the raw field. `gridStep` itself is unchanged
  (still the major cell size driving grid extent); only what the magnet
  targets moved to match what's actually drawn on the ground.
- New Scene-tab control: "Subdivision style" select (Dashed/Solid) next
  to Step/Subdivisions, plus an explanatory line noting the snap
  now targets the subdivision spacing.
- Verified live: grid renders with visibly dashed minor lines between
  solid majors (screenshot); toggling the style select swaps both
  minor-line materials to `LineBasicMaterial` and back to
  `LineDashedMaterial`; dragging a widget-snapped object from
  `[0.34,0.34,0.34]` with Step=1/Subdivisions=10 landed at
  `[0.3,0.3,0.3]` (0.1 spacing) instead of the old `[0,0,0]` (1.0
  spacing) — confirms `snapIncrement()` is live on the actual widget
  snap path, not just the exported helper.

## Face + iris streams, per-stream depth scale (flat pose by default) — carried over
(Live-pen, trigger-zone flash feedback, and clip trim were implemented in a
session that got interrupted before committing; verifying and landing them
now alongside the grid work above.)

- **Stream pen** (`src/mm/pen.ts`, `StreamPen`): a landmark can draw GP
  strokes LIVE instead of record→bake — the direct-drawing counterpart
  to clips. Per-stream `pen: {active, landmark, minConf}` config; while
  armed, `StreamPen.tick()` appends the chosen landmark's world position
  to a growing stroke in the ACTIVE GP object, using the current brush
  style exactly like `DrawTool` bakes it (`brushWidth`, hardness, style
  all copied from `ctx.settings.brush`). Confidence IS the pen state:
  below `minConf` lifts the pen (stroke ends, next confident sample
  starts fresh) and doubles as point pressure, same mapping as clip
  bake. A stale stream (>300ms without new frames) also lifts the pen
  so a dropped hand doesn't leave a frozen stroke growing. Panel gained
  a `pen` checkbox + landmark/min-conf fields per stream row, with
  common-index hints reused from the constraint UI.
- **Trigger-zone flash feedback**: `ConstraintEngine.fired` (cleared and
  repopulated every `update()`) records `{ref, kind: 'enter'|'leave'}`
  for every zone that changed state this frame. `App.updateZoneFlashes()`
  draws a fat-line (`LineSegments2`) outline around the carrier's
  bounding box in the highlight color (enter) or gray (leave), fading
  linearly over 450ms — so triggering a box/plane zone is visually
  obvious without opening the console/monitor. Reused `objectRoot()`
  (factored out of `syncSelectionGlyphs`) and `boxEdgePositions()`.
- **Clip trim**: non-destructive `trimStart`/`trimEnd` (0..1 of
  duration) on `TGClip`. Both `updateClipStreams()` (playback) and
  `bakeClipToStrokes()` (bake) honor the window — playback's phase
  clock runs over the trimmed duration only, bake filters frames to the
  window. New `cropClip()` makes it permanent (drops outside frames,
  retimes to 0). Clips panel gained in/out sliders per clip + a scissors
  "crop" button that only appears once a trim is actually set.
- Verified live (this session): armed a BUS stream's pen, pushed one
  frame above `minConf`, ticked the pen manually — produced exactly one
  stroke in the active GP object's current frame, `drawing` flag true,
  no exceptions. Flash/trim verified by code review + typecheck/build
  (both clean) since this session's browser time went to the grid
  feature; recommend a follow-up live pass on flash timing and trim
  playback specifically.

## Fix: MM stream outliner rows couldn't be unselected
- Root cause: the outliner's `toggleSel()` helper clears every OTHER
  kind's `.select` on a plain (non-shift) click, but the clear-all block
  predated `scene.mmStreams` (added when streams became first-class
  objects) and was never updated to include them. Streams could
  accumulate selected state across clicks and a plain click on one
  stream would never deselect the others — every click on a stream row
  just added to the pile, and since `apply(true)` always sets true on a
  non-shift click, there was no way to click a stream OFF either.
- Fix: one missing line — `for (const st of scene.mmStreams) st.select
  = false;` alongside the other four kinds already there.
  `deselectAllObjects()` (tools/objects.ts, used for viewport clicks)
  already included streams; this was a second, separate clear-loop
  local to the outliner that got missed during that change.
- Verified live: force-selected all 6 mmStream rows, clicked Pose's row
  — only Pose remained selected (5 others cleared); clicked a GP
  object's row — all stream selections cleared to 0, GP object
  selected. Both previously-impossible transitions now work.

## Delete last GP object, Object-mode lasso/circle select, three new shortcuts
- **Delete last GP object**: `deleteObject()` (tools/objects.ts) previously
  had no guard against removing the last remaining `GP` entry. First pass
  auto-recreated a blank `Pencil1` on empty — but that made Object mode
  incapable of ever showing zero GP objects; deleting the last one looked
  like a no-op in the outliner. Reworked: `deleteObject` now just splices
  and clamps `scene.activeObject`, full stop — Object mode and the
  outliner correctly show an empty scene. `App.setMode()` (main.ts)
  lazily creates a blank GP object only when switching INTO a mode that
  actually edits one (DRAW/EDIT/SCULPT/VERTEX/WEIGHT), so those tools
  never see an empty `scene.objects`. Guarded the remaining paths that
  read `activeObject(scene)` outside a mode gate and would otherwise
  throw on empty: `addKeyframe`/`removeKeyframe`/`jumpKey` (main.ts,
  reachable via the global `i`/`shift+i`/arrow-key bindings and timeline
  buttons even in Object mode) early-return; the sidebar's brush/data/mods
  tabs (ui.ts `buildSidebar`) show a "No GP object" placeholder instead of
  calling their panels; `drawTimeline()` (ui.ts, runs on every
  `UI.refresh()` regardless of active tab) skips the keyframe-dot pass
  when there's no active object.
- **Object mode lasso/circle select**: `ObjectSelectTool` (tools/objects.ts)
  generalized from box-only to a `kind: 'BOX'|'LASSO'|'CIRCLE'` family,
  mirroring EDIT mode's `SelectTool` (tools/select.ts) — same Ctrl-drag =
  lasso and `C` = circle-mode conventions on the box variant, same `[`/`]`
  circle-radius resize. Box/lasso region hit-testing is unified behind one
  predicate-based `refMatches`/`selectByRegion` (GP: any sampled stroke
  point matches; everything else: projected origin). Registered as three
  tool ids (`object-select`, `object-select-lasso`, `object-select-circle`)
  in `App` (main.ts) and the Object-mode toolbar row (ui.ts). The lasso/
  circle instances mirror their `lastPicked` into the canonical box
  instance's `onSelectionChange` so Ctrl+P parenting-target and the active-
  object outline don't lose track when the user switches select variant
  mid-workflow.
- **Three new Blender-parity shortcuts** (keymap.ts `ACTIONS` +
  `App.runAction()`, main.ts):
  - `Alt+Shift+Z` — `toggleInfoOverlay()`: hides the floor grid
    (`this.grid.visible`) and the bottom-left `#status` info overlay.
  - `` Ctrl+` `` — `toggleGizmoNav()`: locks the transform gizmo
    (`settings.showGizmo`, remembered and restored) and all mouse-driven
    camera navigation. `this.controls.enabled` alone isn't durable — the
    `cameraView` block reassigns it every frame regardless — so `loop()`
    gained `if (this.navLocked) this.controls.enabled = false;` after that
    block. The "Emulate 3-Button Mouse" alt-drag path and the nav-gizmo
    click-drag path both bypass OrbitControls entirely (handled directly
    in the canvas `pointerdown` listener), so both gained an explicit
    `!this.navLocked` guard at their entry point.
  - `Ctrl+Alt+Space` — `toggleMaximize` dispatches to the existing
    `togglePresentation()` (already hides panels/timeline/menus via the
    `#app.presentation` CSS rules in styles.css) rather than building new
    hide/show logic.
- Verified live via `__tg` + real `KeyboardEvent`/`dispatchEvent` (no test
  suite in this repo, so real user-input paths, not just calling internals
  directly): deleting the sole GP object via the `X` shortcut now leaves
  `scene.objects` genuinely empty and the outliner shows zero rows;
  switching to `data`/`brush`/`mods` tabs while empty shows the "No GP
  object" placeholder instead of throwing; pressing `i` (insertKey)
  globally with zero objects no-ops instead of throwing; switching to
  DRAW mode lazily creates one blank object, returning to Object mode
  keeps it. The Object-mode toolbar renders all three select tools (`Box
  select (Ctrl lasso, C circle)`, `Lasso select`, `Circle select ([ ]
  size)`). All three new shortcuts round-tripped correctly through both
  `runAction()` and simulated Mac-remapped `KeyboardEvent`s (Option held →
  `e.key` becomes an OS-layout character, `e.code` stays physical) —
  `toggleInfoOverlay` hid the grid + `#status`, `toggleGizmoNav` flipped
  `navLocked`/`controls.enabled`, `toggleMaximize` set `presentation` +
  the `#app` class — with no regression on the pre-existing
  `alt+a`/`alt+p`/`alt+tab` bindings.
  `npx tsc --noEmit` and `npx vite build` both clean.
- Follow-up: an empty GP object's selection outline (`syncSelectionGlyphs`,
  main.ts) fell back to a hardcoded 1×1×1 box when `Box3.setFromObject`
  found no geometry — sized right for matrix-driven objects with no mesh
  of their own (streams/triggers), but a full unit cube towering over a
  brand-new empty Pencil1 was clearly wrong. GP now gets a 0.15-unit
  marker in that fallback instead, matching Blender's "empty" object
  display size; streams/triggers keep the 1-unit box. Verified live
  (screenshot): selecting a fresh strokeless Pencil1 now shows a small
  compact outline instead of a room-sized cube.

## Shift+A on an empty scene, general Escape handling
- **Shift+A crashed with zero GP objects**: `drawingPlane()`
  (tools/projection.ts) read `activeObject(ctx.scene).translation`
  unconditionally to anchor the FRONT/SIDE/TOP drawing plane, called from
  `App.openAddMenu()`'s `screenToWorld()` on every Shift+A press.
  Falls back to the world origin when `scene.objects` is empty (Object
  mode legitimately allows that now — see the delete-last-GP-object fix
  above). Exceptions thrown inside a `window.addEventListener('keydown',
  ...)` callback don't propagate to the caller and don't show up in a
  synchronous try/catch around `dispatchEvent` — they only surface as an
  uncaught error in the console, which is why this one was easy to miss;
  found it by calling `App.openAddMenu()` directly in a try/catch.
- **General Escape handling**: added one capture-phase `keydown` listener
  in `App.bindEvents()` (main.ts), replacing the narrower SELECT-only
  blur it grew out of. Priority order per press: (1) if the focused
  element has its own `onkeydown` handler (e.g. the outliner's inline
  rename input, which needs Escape to CANCEL rather than commit-on-blur)
  leave it alone entirely; (2) else if focus is in any other
  INPUT/SELECT/TEXTAREA, blur it; (3) else if a context menu (`.menu-pop`)
  is open, close it; (4) else, if nothing else claimed it and no
  dialog/modal/pie/fly/object-picking state is active, deselect — objects
  in Object mode, points/strokes in Edit-like modes. Capture phase runs
  this before `App.onKey`'s own Escape branches (which run in bubble
  phase) and before the settings dialog / command palette / rebind-capture
  row's own window-capture Escape listeners registered later at runtime —
  since those all call `stopPropagation()` when they handle Escape
  themselves, and this new listener's dialog/modal checks make it a no-op
  whenever one of those owns the keystroke, they never fight.
- Verified live: rename-input Escape reverted the typed value instead of
  committing it (a real regression risk from an earlier version of this
  fix — fixed by the `onkeydown`-presence check); an open Add menu closed
  on Escape; a focused number field blurred; a fully-selected object
  deselected when nothing else was open/focused. `npx tsc --noEmit` and
  `npx vite build` both clean.

## Visual body-map picker for MediaPipe Pose landmarks
- Every landmark picker in the app was previously a bare
  `numField('landmark', ...)` (raw 0-32 number input) next to a static
  hint string — no name lookup, no visual reference. Replaced with a
  clickable humanoid body-map for POSE-kind streams specifically (hands/
  face keep the numeric field for now — noted as explicit follow-up work,
  same shape once this is proven out).
- `src/mm/poseLandmarks.ts`: the MediaPipe Pose 33-landmark topology as
  data — `POSE_LANDMARK_NAMES` (index → readable name), `POSE_LANDMARK_POS`
  (hand-authored humanoid layout in a fixed SVG viewBox — not a pixel
  match to any particular capture, just reads as a body at a glance), and
  `POSE_LANDMARK_EDGES` (MediaPipe's own `POSE_CONNECTIONS` pairs, so the
  skeleton lines are topologically correct: face chains, arm/hand
  triangles, torso, leg/foot triangles).
- `src/app/poseMap.ts`: `poseMapPicker(value, onChange)` — inline SVG
  (matches this codebase's icon-drawing convention in `icons.ts` over a
  canvas approach, since this is a fixed diagram with real per-point DOM
  nodes rather than something redrawn every frame). Three interchangeable
  ways to pick, per the request: (1) click a dot, (2) pick from a `<select>`
  of names below the map, (3) drag a dot and drop it back onto the widget.
  Hover tooltip is a native SVG `<title>` child (matches the app's
  existing native-`title`-attribute tooltip convention, no custom popover
  component). Picked point highlighted in red; drag payload carries a
  custom MIME (`POSE_LANDMARK_DRAG_MIME`, exported) alongside `text/plain`
  so a future drop target elsewhere (e.g. a constraint/binding row) can
  bind directly from a drag without touching the dropdown — scaffolding
  for the requested "drag it where it needs to connect" once other rows
  become drop targets too.
- Wired into both existing landmark pickers, gated on the target
  stream's `kind === 'POSE'` (falls back to the old numeric field
  otherwise): the FOLLOW_STREAM constraint editor (`ui.ts` — the stream
  `<select>` there now also triggers a refresh on change, since which
  picker to show depends on the newly-selected stream's kind) and the
  per-stream live "pen" landmark field.
- Verified live: added a POSE stream, armed its pen — body map rendered
  with all 33 dots and correct skeleton edges (screenshot); clicking a
  dot, picking from the dropdown, and a simulated HTML5 drag-drop onto
  the widget all correctly updated `st.pen.landmark` and the picked-dot
  highlight; hover `<title>` text correct (`"15: left wrist"` etc.); a
  HAND_LEFT stream added alongside still uses the plain numeric field
  (kind gate confirmed). `npx tsc --noEmit` and `npx vite build` clean.

## Body map as the MediaMime rig mapper (replaces the live-address list)
- Follow-up to the body-map picker above: its actual intended use is
  rigging any scene object to a MediaPipe landmark address, not drawing —
  `mediamimePanel()` (ui.ts) previously listed one row per currently-live
  `/mm/...` address (could be dozens once a POSE stream is running,
  screenshotted by the user as impractical), each with its own inline
  target dropdown + Attach button.
- Replaced with a single **rig mapper**: a `Source` kind dropdown (Pose/
  Hand L/Hand R/Face/Iris), the body map (or a numeric field for kinds
  without a visual picker yet — same POSE-only gate as the other two
  pickers) to pick the landmark, a line showing the resolved address
  (`${prefix}/${kind}/${landmark}`) plus its live position if currently
  seen on the bus, one target dropdown, and one Attach button (+ a
  Trigger button, carried over from the old per-row version) — click a
  point, pick a target, hit Attach. Picking a landmark on the map now
  triggers a full `this.refresh()` (rather than just updating its own
  DOM in place, unlike the other two call sites) since the address text
  and the Attach closure both need to follow the newly-picked landmark.
  Picker state (`mmRigKind`/`mmRigLandmark`) is a UI-only field on the
  `UI` class, not scene data — it's what's currently "loaded" for
  Attach, not something to serialize.
- The existing "Rigs (object ← address)" list (enable/scale/delete per
  already-created rig) is unchanged below the mapper.
- Verified live: added a mesh object, opened the MediaMime tab — mapper
  renders with the body map and "0 live addresses" (screenshot, matches
  the requested layout); clicking landmark 15 on the map resolved the
  address to `/mm/pose/15`, picking the mesh from the target dropdown
  and clicking Attach created rig `"/mm/pose/15 → mesh"` in
  `scene.mediamime.rigs`. `npx tsc --noEmit` and `npx vite build` clean.

## Hand + face landmark maps; combined body map for the rig mapper
- `src/mm/handLandmarks.ts`: MediaPipe Hand's 21-landmark topology (names,
  a layout matching the standard reference figure — wrist at bottom,
  fingers spread upward — and the official `HAND_CONNECTIONS` edges).
  Same shape for HAND_LEFT/HAND_RIGHT streams; the picker mirrors the
  layout horizontally for the right hand.
- `src/mm/faceLandmarks.ts`: a curated ~118-point subset of MediaPipe's
  478-point face mesh — face oval (36), both eyes (16 each), both irises
  (5 each: center + 4-point ring, indices 468-477 — the same indices
  `IRIS_INDICES` in `mm/streams.ts` already uses to pull iris points out
  of the FACE stream's packed frame), and the lips (20 outer + 20 inner).
  Positions are generated (points evenly spaced around authored ellipses
  in each feature's real MediaPipe contour order) rather than hand-typed
  per-point — the full 468 mesh is far too dense to click, so this
  intentionally shows only what the user asked for: eyes, iris, lips,
  face oval.
- `src/app/poseMap.ts` reworked around one core (`addLandmarks`) so pose/
  hand/face share the same click/hover/drag/dropdown machinery instead of
  three copies of it. New exports: `handMapPicker`, `faceMapPicker`
  (single-kind, same shape as `poseMapPicker`), `hasLandmarkMap(kind)` and
  `landmarkMapForKind(kind, value, onChange)` (kind-gated dispatch used
  by the two per-stream call sites — constraint editor, live-pen field —
  extending their previous POSE-only coverage to also cover HAND_LEFT/
  HAND_RIGHT/FACE; IRIS/CUSTOM still fall back to the numeric field).
- New `combinedBodyMapPicker(kind, landmark, onChange)`: pose + a hand
  attached at each wrist (translated/mirrored via an SVG group transform
  onto the pose's own wrist coordinates, scaled down) + the face attached
  above the head, all as ONE diagram in one `<svg>` — matches the user's
  literal ask ("add hands on each side of the pose drawing... add face
  above"). Every dot across all four sub-diagrams is tagged with its own
  `(kind, id)`, so a click anywhere returns both instead of just an
  index. This replaces the mediamime rig mapper's previous Source-
  dropdown + single-map-at-a-time design — Pose/Hand L/Hand R/Face are
  now all reachable by clicking the relevant part of one figure. Iris/
  custom addresses aren't on the diagram (no visual picker for the
  standalone 10-point IRIS stream yet), so a "manual address" checkbox
  swaps the diagram for a plain address text field when needed.
- Verified live: combined map renders 193 dots total (33 pose + 21×2
  hands + 118 face — screenshot showing the face oval/eyes/lips above
  the head and a hand flanking each side of the torso, matching the
  requested layout); clicking the right-iris-center dot (id 468, inside
  the face sub-diagram) correctly set both kind (`FACE`) and landmark
  (`468`), resolved to address `/mm/face/468`, and Attach created that
  rig; the manual-address toggle correctly swaps in a text field; a
  HAND_LEFT stream's live-pen field independently rendered its own
  21-point hand picker alongside the mediamime panel's combined map with
  no interference between the two. `npx tsc --noEmit` and
  `npx vite build` clean.

## Combined body map: fix overlaps (vitruvian layout)
- Follow-up to the combined map above: the face's eyes/lips were dense
  enough to visually merge into a blob (screenshotted by the user), and
  the full hand diagrams overlapped the pose's own crude hand-cluster
  points (17-22) sitting at the same spot.
- Root cause for the face: `addLandmarks` drew every dot at a fixed
  `r=8` regardless of a feature's own point spacing — fine for pose/hand
  (generous spacing) but the eye/lips loops' point-to-point distance was
  well under `2*r`, so neighboring dots literally overlapped. Added a
  per-`LandmarkSet` `dotRadius` (`faceLandmarks.ts` now also exports
  `FACE_DOT_RADIUS = 3`) and reworked the face layout's ellipse radii
  (`faceLandmarks.ts`) so every loop's spacing clears `2× dotRadius` with
  margin — oval/eyes/lips/iris now read as distinct rings instead of
  blobs. CSS gained `.pose-map-dot-sm` so hover/picked enlargement scales
  down proportionally for these smaller dots too (`styles.css`).
- Root cause for the hands: the combined pose sub-diagram still drew its
  own ids 0-10 (crude face cluster) and 17-22 (crude hand cluster) right
  where the detailed face/hand diagrams now sit — pure redundant clutter
  once those exist. `combinedBodyMapPicker` (poseMap.ts) now uses a
  dedicated `VITRUVIAN_POSE_POS` override (only ids 11-16, 23-32 —
  shoulders/elbows/wrists/hips/knees/ankles/heels/foot-index) with arms
  spread wide and legs apart, vitruvian-man style, instead of the
  standalone picker's more compact hanging-arm layout — gives the
  attached hands room to sit clear of the torso. `poseSet()` gained an
  optional id filter (and now filters its edge list to match) so this
  reduced point set doesn't drag in edges to now-absent points; the
  standalone `poseMapPicker` (constraint/pen fields) is untouched and
  still shows the full 33-point layout.
- The pose wrist dot and the attached hand's own wrist dot (id 0) are
  still placed exactly on top of each other by design — that's the same
  anatomical point, not a layout bug.
- Verified live: combined map now renders 176 dots (16 pose + 21×2 hands
  + 118 face, screenshot confirms clean vitruvian-style separation — face
  above with distinct oval/eyes/iris/lips, arms spread with hands clearly
  past the elbows). Programmatic check (JS in the browser, resolving each
  dot's transform-composed position and radius) found only two
  intentional wrist coincidences and a handful of sub-2-unit touches
  where the inner/outer lip loops naturally pinch at the mouth corners —
  no other pair anywhere in the 176-dot set overlaps. `npx tsc --noEmit`
  and `npx vite build` clean.
- Second pass (user feedback on the first): hands and head ~2x bigger
  relative to the pose (handScale 0.5→1, faceScale 0.72→1.4, viewBox
  grown to 900×840, widget 300×280px) with more air between them and the
  body — the arms now angle upward so the raised hands flank the face
  with clear gaps on all sides, easier to click freely. Hand mirroring
  flipped to anatomically correct palms-forward: the hand's local layout
  has the thumb at LOW x, so the image-LEFT hand is the mirrored one —
  thumb faces the body on both sides. Verified programmatically (thumb-
  tip x vs pinky-tip x, per side, transform-resolved): `thumbTowardBody:
  true` for both hands; clicking a thumb tip picks `HAND_LEFT 4`.

## Combined map: uniform dot size, another 2x on head/hands, +50% wide
- Third pass. Two asks: every dot the same size (previously face used a
  smaller radius than pose/hand to dodge overlap — see the vitruvian-
  layout entry above), and hands/head another 2x bigger with the whole
  diagram 50% wider.
- Unifying dot size meant the face layout could no longer lean on a
  smaller radius to avoid overlap — it had to carry that entirely on its
  own point spacing, at a size where the same `r=6` used for pose/hand
  actually fits. Recomputing that layout by hand (average circumference/
  point-count) turned out to be the wrong tool: an ellipse's real
  point-to-point spacing varies with local curvature and the average
  significantly overestimates the tightest gap, which is why the first
  attempt at this (screenshotted by the user) still had eye/lips points
  overlapping despite passing the earlier napkin math. Recomputed
  everything numerically instead — evaluated `ellipseRing()` in the
  browser console for candidate radii and took the actual minimum
  adjacent-point distance (and, for the two concentric lip loops, the
  actual minimum point-to-point distance ACROSS loops, not just within
  each) until every pair cleared `2×r` with margin. Final face constants
  (`faceLandmarks.ts`): oval (140,155), eyes (55,45, more circular than
  before — an elongated eye shape doesn't have room at this dot size),
  lips outer/inner (105,60)/(80,42), iris ring radius 18 (was 10 — the
  iris CENTER point sits exactly at that radius from every ring point,
  so it has the same `>2r` constraint as anything else, which the first
  pass's `IRIS_R=10 < 2×6` violated outright).
- `combinedBodyMapPicker` (poseMap.ts): `handScale` 1→2, `faceScale`
  2.2 (from 1.4 in the prior pass — this task's "2x bigger" is on top of
  that pass's sizing, not the original), viewBox widened and the
  vitruvian pose pushed down further to keep clear of the now-taller
  face. `DOT_R` is a single module constant (6) used everywhere;
  `LandmarkSet.dotRadius` and the `.pose-map-dot-sm` CSS variant it drove
  are gone.
- Verified live: rebuilt the SAME transform-resolving overlap check used
  in the prior pass against the live-rendered combined map (176 dots) —
  only the two intentional wrist-anchor coincidences remain, zero other
  pairs closer than `2×r`. Screenshot confirms the face reads as
  distinct oval/eyes/iris-rings/lips at the larger size, hands are
  clearly bigger and well clear of the torso, and clicking a thumb tip
  still correctly picks `HAND_LEFT 4`.

## Combined map: uniform pose/hand/face dot size, hug pose, tighter face
- **Pose dots were quietly smaller than hand/face dots** the whole time
  — `addLandmarks` drew every dot at the same LOCAL radius, but the pose
  sub-diagram's `<g>` has no scale (it's the base coordinate system the
  whole combined map is laid out in) while the hand/face groups are
  wrapped in `scale(handScale)`/`scale(faceScale)` — so a dot's radius
  scaled up right along with those groups' positions, and pose dots
  never got that multiplier. Fixed by having `addLandmarks` accept an
  explicit radius, and `combinedBodyMapPicker` compute
  `ON_SCREEN_DOT_R / groupScale` per sub-diagram (`ON_SCREEN_DOT_R = 12`)
  so every dot reads the same size regardless of which group it's in.
  Standalone `poseMapPicker`/`handMapPicker`/`faceMapPicker` are
  unaffected (still default to `DOT_R`, no enclosing scaled group).
- **Hands turned outward ("hug" pose)**: each hand's `<g transform>`
  gained `rotate(±90, 100, 210)` — the SAME pivot point the wrist sits
  at, so rotating doesn't move the wrist off the pose's own wrist, only
  swings the rest of the hand. First attempt got the right hand's sign
  backwards (rotated it inward, toward the torso, instead of outward) —
  caught by resolving the actual on-screen wrist→middle-fingertip vector
  for both hands (should point away from body center on both sides) and
  seeing the right hand's `dx` come out negative (toward center) instead
  of positive; fixed by flipping its rotation from `-90` to `90`
  (the left hand's own mirror `scale(-handScale, handScale)` means it
  needs the OPPOSITE rotation sign from the right hand's unmirrored one
  to land on the same "outward" direction — not symmetric the way it'd
  first look).
- **Eyes moved off the oval edge, mouth shrunk to fit**: per the user's
  own worked example — `dist(127, 158)` (oval point to a right-eye
  point) should equal `dist(472, 158)` (iris-ring point to that same
  eye point), i.e. the eye ring should sit roughly midway between the
  iris and the oval boundary instead of hugging the oval edge. Solved
  numerically (bisection on the eye scale factor) rather than by
  further hand-tuned guessing: `EYE_R` (55,45)→(44,36) makes both
  distances ≈26.2. Lips: found the smallest `LIPS_OUTER_R`/
  `LIPS_INNER_R` that still keeps every pair of the 40 lip points (both
  loops, including across the two loops) past `2×dotRadius` via a small
  grid search over candidate sizes rather than eyeballing — (105,60)/
  (80,42) → (70,56)/(43,42), visibly less like the mouth was crowding
  the face boundary.
- Verified live: transform-and-rotation-resolving overlap check (same
  approach as the prior pass, extended to account for the new `rotate()`
  in each hand's transform) found zero unintended overlaps across all
  176 dots — only the two wrist-anchor coincidences, now at `r=12` each.
  Screenshot confirms pose/hand/face dots read as visually the same
  size, hands open outward symmetrically, and the face reads noticeably
  less cramped. Clicking a hand dot after the rotation change still
  correctly resolves to the right `(kind, landmark)` pair (`HAND_LEFT 4`
  for a thumb tip, `HAND_LEFT 10` for a middle-finger PIP).

## Combined map: hands were clipped; more oval inner mouth; re-exported SVGs
- Rotating the hands outward (prior entry) changed their reach without
  anyone widening the viewBox to match — the fingers-up layout's
  horizontal footprint was `200×handScale`, but rotated 90° the "long"
  axis (finger length, ~`230×handScale`) now points sideways instead,
  and the old `viewBox="0 0 1400 1430"` clipped both hands at the edges
  (screenshotted by the user). Measured the actual on-screen bounding
  box of all 176 dots live (transform-and-rotation-resolved, same
  technique as the overlap checks) — content spans x -205..1575 — and
  widened/shifted the viewBox to `-220 0 1810 1430` so it's fully
  contained with margin.
- Inner mouth was nearly circular (43×42, ratio 1.02) — grid-searched
  for the most elongated `LIPS_INNER_R` that still keeps all 20 points
  (and their distance to the outer lip loop) past `2×dotRadius`; more
  eccentric shapes compress point spacing at the ellipse's flat ends, so
  this is close to the practical ceiling at this dot count/size, not an
  arbitrary pick — landed on 56×40 (ratio 1.4), a real visible
  improvement over 1.02 without reopening the overlap bug two passes
  ago.
- Regenerated both reference SVGs (`docs/assets/mediamime-body-map.svg`,
  `docs/assets/mediamime-body-map-large.svg`) against the current live
  layout — they were a snapshot of an older pass and had drifted.
  Verified live: full-dot-set overlap check still clean (only the two
  wrist-anchor coincidences); opened the regenerated large SVG directly
  in the browser and confirmed both hands render complete (no clipping)
  and the inner mouth reads as a clear oval.

## Capture panel UI cleanup: colors in-app, renaming, dropdown-attach flow
- **Combined map colors, in the app**: same scheme as the reference SVGs
  (left hand `#7aff99`, right hand `#ff7ab1`, body `#7ab4ff`, head
  `#fffb7a`), applied to the live interactive `combinedBodyMapPicker`.
  First attempt used the SVG `fill` presentation attribute and silently
  did nothing — presentation attributes lose to ANY stylesheet rule
  regardless of specificity, and `.pose-map-dot { fill: var(--accent2) }`
  already claims it. Inline `style.fill` would have gone too far the
  other way (inline style beats every stylesheet rule including
  `:hover`/`.picked`, breaking those). The fix that survives both
  directions of the cascade: four new CSS classes
  (`.pose-map-dot-pose/-handL/-handR/-face`, styles.css) declared BEFORE
  the existing `:hover`/`.picked` rules — same specificity (two classes),
  so source order lets hover/picked win on tie, same as a normal
  stylesheet without inline style involved at all. `addLandmarks`
  (poseMap.ts) takes a `colorClass` option instead of a `fill` string.
  Also, per the earlier "use body markers for wrists" ask: the hand's own
  wrist point (id 0) is now skipped entirely in the combined map (an
  `opts.skip` callback on `addLandmarks`), not just recolored — one
  marker at that shared point, not two.
- **Hover tooltips now show a resolvable address**, not just id+name:
  `RIG_KIND_PATH` (pose/hand-l/hand-r/face bus-path segments) moved from
  a copy living only in `ui.ts` to an export in `poseMap.ts`, so
  `combinedBodyMapPicker` (now taking a `prefix` param) can build titles
  like `"15 · left wrist · /mp/pose/15"` instead of `"15: left wrist"`.
  `ui.ts` imports the shared constant instead of keeping its own copy.
- **Renamed "MediaMime" to "Capture" in every user-facing string**: the
  menubar menu, its "Open MediaMime panel" item, the sidebar tab tooltip,
  the rig-mapper panel title, the outliner's trigger-row tooltip
  ("Static / MediaMime-rigged" → "Static / capture-rigged"), and the
  trigger info line ("MediaMime: {address}" → "Rig: {address}",
  "bind in the MediaMime panel" → "bind in the Capture panel"). Left the
  internal code/type/module naming (`scene.mediamime`, `MMRig`,
  `addMediaMimeRig`, the `mediamime` singleton, `src/io/mediamime.ts`)
  and the actual external-bridge GitHub link untouched — those aren't
  user-facing UI text, and renaming them would be a much larger, riskier
  refactor nobody asked for.
- **Default address prefix `/mm` → `/mp`**: three independent places had
  their own copy of the old default — `scene.mediamime.prefix`'s default
  in `gpdata.ts`, the standalone `MediaMimeEngine.prefix` field in
  `io/mediamime.ts` (confirmed synced from the scene value every frame
  via `mediamime.setPrefix()` in main.ts, so this was only ever a
  before-first-sync fallback, not a live source of truth), and the
  placeholder/fallback text scattered through `mediamimePanel()`. New
  scenes only — existing scenes keep whatever prefix they already have
  serialized, no migration needed since this is just a default.
- **Explanation rows moved to hover tooltips**: the always-visible
  "camera streams re-emit world-space landmarks on the bus..." row in
  the Streams panel is gone — its text is now the `title` on that
  panel's own `<h3>` header (grabbed via `panel(...).querySelector('h3')`
  post-construction rather than threading a new parameter through the
  shared `panel()` helper, which every panel in the app calls). Same
  treatment for the per-stream pen hint ("draws into the active GP
  object · ...") — now the `pen` checkbox's `title`, via
  `Object.assign(checkbox(...), {title: ...})` since the `checkbox()`
  helper doesn't take a title param. The "· uses the WS bridge below"
  aside became the address-prefix input's `title` the same way.
- **Rig-mapper target dropdown replaces the Attach button**: picking a
  target from the dropdown now performs the attach immediately — the
  dropdown gained a `(none)` option at the top (default), and its
  `onchange` calls `addMediaMimeRig` directly instead of a separate
  button. New checkbox "reset original transform on attach" (default
  ON, a new `mmRigResetTransform` UI-state field) — when checked,
  `setObjectTransform` zeroes the target's translation/rotation and
  resets scale to 1 before the rig is created, so a freshly-rigged
  object starts from a clean base instead of compounding with wherever
  it happened to be left. The dropdown resets to `(none)` after each
  attach so it's ready for the next pick. The Trigger button is
  unchanged (unrelated action — spawns a trigger primitive, doesn't
  bind an existing object).
- Verified live: menu bar reads "Capture" (not "MediaMime"); the
  Streams panel header carries the moved explanation as a real `title`
  attribute; address prefix defaults to `/mp` and the rig-mapper's
  resolved address updates accordingly; hovering a wrist dot shows
  `"15 · left wrist · /mp/pose/15"`; picking a mesh from the target
  dropdown (after giving it a nonzero test translation) immediately
  created the rig, zeroed the mesh's transform back to `[0,0,0]`, and
  reset the dropdown to `(none)` — no separate Attach click needed.
  `npx tsc --noEmit` and `npx vite build` both clean.

## Eye colors, checkbox restyle, further label cleanup
- **Distinct left/right eye colors**: `faceLandmarks.ts` exports
  `FACE_LEFT_EYE_IDS`/`FACE_RIGHT_EYE_IDS` (each eye ring + its iris);
  `poseMap.ts` uses them in a per-point `faceColorClass(id)` function
  (green `#2AFF00` left, red `#FF0D12` right, rest of the face stays
  yellow) rather than the flat per-kind color the other three regions
  use. `addLandmarks`'s `colorClass` option now accepts a function as
  well as a plain string so this could plug in without a parallel
  code path. Applied everywhere a face diagram appears: the combined
  rig-mapper picker AND the standalone `faceMapPicker` (constraint/pen
  fields) — while at it, gave `poseMapPicker`/`handMapPicker` their own
  kind colors too for consistency (`handMapPicker` gained a `side`
  param so `landmarkMapForKind` can color HAND_LEFT vs HAND_RIGHT
  correctly instead of both defaulting to the same color).
- **Checkboxes app-wide**: were already custom-styled (not the native OS
  control) but drew a checkmark tick inside a rounded box. Simplified to
  match the flat line-icon language elsewhere in the app — plain
  empty square (unchecked) vs. solid-filled square (checked), no drawn
  symbol, smaller radius. CSS-only change (`input[type="checkbox"]` in
  styles.css), so every checkbox in the app updated from one edit.
- **Long checkbox labels moved to hover tooltips**: `checkbox()`
  (ui.ts) gained an optional `title` param. Shortened labels + moved the
  parenthetical/descriptive part to the tooltip at every checkbox whose
  label was a full phrase rather than 1-2 words: the Capture panel's
  "manual address (iris, custom senders, ...)" → "manual address" and
  "reset original transform on attach" → "reset transform" (both new
  from the last pass), plus three pre-existing ones elsewhere in the app
  that were the same pattern — grid's "Auto color (matches Background)",
  and the nav-prefs "Trackpad navigation (two-finger orbit, Shift pan,
  Ctrl zoom)", "Emulate Numpad (digit-row view keys)", "Emulate 3-Button
  Mouse (Alt+LMB navigates)". Short 1-2 word labels (Retrigger, Mask,
  Visible, ...) were left alone — the ask was about long labels
  specifically, not tooltips on every checkbox regardless of length.
- Verified live: screenshot shows the rig mapper's face with a visibly
  green left eye and red right eye distinct from the yellow face/oval/
  lips, plain square checkboxes throughout (no checkmark glyph), and the
  shortened labels with their tooltips confirmed via
  `label.title`. A HAND_LEFT and HAND_RIGHT pen-field picker opened side
  by side correctly rendered green vs. pink. Clicking a left-eye dot on
  the combined map still correctly resolves to `FACE 249` with the
  `pose-map-dot-leye` class applied. `npx tsc --noEmit` and
  `npx vite build` both clean.

## Rig mapper: eyedropper, icon-only Trigger button, Clips reordered
- **Trigger button label → tooltip**: was `btn('＋Trigger', ...)`, wide
  enough to wrap onto two lines at the panel's width (screenshotted by
  the user). Now `btn(icon('plus'), ...)` — icon only, same as every
  other icon-btn in the app — with the label folded into the title as
  `"Trigger — spawn a trigger primitive rigged to this address"`.
- **Object eyedropper before the target dropdown**: turns out this
  repo already has the exact Blender pattern — `App.pickObject(cb)`
  (main.ts) arms `objectPicking`, the next viewport click resolves via
  the same raycast `ObjectSelectTool` already uses for click-select and
  calls back with the hit ref (or `null`), Esc cancels. It's already
  used by `objectPickerField()` (a constraint-target helper) elsewhere
  in ui.ts — the rig mapper just didn't have one yet. Added an eyedropper
  button (`◎`) before `targetSel`; factored the dropdown's own onchange
  and the eyedropper's callback through one shared `attachTarget(ref)`
  so both paths do the identical reset-transform-then-rig sequence
  instead of duplicating it.
- **Clips moved under the rig section**: sidebar tab's `build()` array
  reordered from `[streams, clips, rigMapper]` to
  `[streams, rigMapper, clips]`.
- Verified live: screenshot confirms panel order (Streams → Capture →
  Clips) and the eyedropper/dropdown/icon-only-Trigger row layout;
  clicking the eyedropper then dispatching a real `pointerdown` on the
  canvas at the test mesh's screen position correctly attached it
  (`rigs: ["/mp/pose/0"]`) and exited picking mode automatically.
  `npx tsc --noEmit` and `npx vite build` both clean.

## Landmark dropdown alongside the object picker, orange ring highlight
- **Landmark dropdown, next to the object eyedropper/dropdown**:
  `listRigLandmarks()` (poseMap.ts) exports every `(kind, id, name)` the
  combined map covers — 176 entries: 16 pose + 21 per hand (including
  each hand's own wrist, which has no dot of its own but is still a
  distinct valid address) + 118 face. `mediamimePanel()`'s new
  `landmarkSel` reads/writes the SAME `mmRigKind`/`mmRigLandmark` state
  the body map itself is driven by, so picking on the map or from the
  dropdown always agree — clicking a dot rebuilds the panel with that
  option selected, picking from the dropdown rebuilds the panel with
  the map's ring on that dot. No separate sync logic needed since both
  paths write the same two fields and `this.refresh()` does the rest.
  Hidden while `manual address` is checked (no body map to correspond
  to in that mode).
- **Orange ring instead of recoloring the dot**: previously "picked" on
  the combined map reused the shared `.picked` CSS class (recolors the
  dot red), which would have hidden the kind color the last few passes
  specifically added. Replaced with a separate `<circle class="pose-map-
  ring">` (stroke `#ff8c3b`, no fill, `r` = dot radius + 6) — one ring
  per sub-diagram group (pose/handL/handR/face), living in that group's
  own coordinate space so it's automatically transform-correct, shown/
  hidden/repositioned by copying the target dot's own `cx`/`cy` rather
  than recomputing position. The hand-wrist special case (no dot exists
  for id 0) redirects the ring to the corresponding pose wrist dot,
  matching where that address visually sits.
- Verified live: clicking a map dot (left elbow) correctly set
  `mmRigKind/mmRigLandmark` AND updated the dropdown's selected option
  text to `"POSE 13 · left elbow"`; picking `"HAND_RIGHT 8 · index tip"`
  from the dropdown moved the ring to `cx=50, cy=20`, exactly matching
  that dot's own position; computed style confirmed the ring renders
  `stroke: rgb(255,140,59)` (`#ff8c3b`), `fill: none`, `r: 18` vs. the
  dot's `r: 12`. `npx tsc --noEmit` and `npx vite build` both clean.

## Ring tweaks, deselect, per-rig reset transform, scale ordering, more labels-to-tooltips
- **Ring: white, thicker**: `.pose-map-ring` stroke `#ff8c3b`→`#ffffff`,
  `stroke-width` 2.5→4 (styles.css).
- **Click-away deselect**: the combined map's `<svg>` gained a click
  listener that only fires when `e.target === svg` (i.e. the literal
  background, not a dot or edge line bubbling up) — hides every ring.
  Purely visual: doesn't touch `mmRigKind`/`mmRigLandmark`, so there's
  always a last-picked address ready to attach even with nothing
  highlighted on the diagram.
- **`reset transform` moved from a global mapper setting to a per-rig
  field**: `MMRig` gains `resetTransform?: boolean` (types.ts, default
  `true`, including for scenes serialized before the field existed —
  read as `rig.resetTransform !== false`). Every new rig still starts
  from a zeroed transform at attach time (now unconditional — no more
  pre-attach toggle to gate it), but whether it KEEPS forcing
  rotation/scale to identity every subsequent frame is now this
  checkbox — genuinely live, not just a one-shot action, since
  `MediaMimeEngine.update()` (io/mediamime.ts) now checks it each frame:
  when true, rotation/scale are forced to `[0,0,0]`/`[1,1,1]` every
  update (prevents drift from anything else touching the object);
  when false, they're left alone (preserved from `getObjectTransform`),
  matching the old behavior. UI: the global checkbox+row is gone; each
  row in "Rigs (object ← address)" gained a second, label-less
  checkbox between the scale field and the delete button.
- **Rig scale now applies after the parent-local transform, not
  before**: previously `p * rig.scale + offset` happened entirely in
  world space before converting to the target's parent-local frame.
  Reordered to `((p + offset) → parent-local) * rig.scale` — scale now
  acts on the resulting local offset from the parent rather than
  distorting the raw landmark position itself, so it scales how far the
  rig moves relative to its parent instead of fighting the parent's own
  scale.
- **More checkboxes → hover tips**: the Streams panel's `conf→α`,
  `conf→size`, `mirror`, `probe`, `emit bus` checkboxes lost their
  visible labels (same treatment as the rig mapper's controls two
  passes ago) — tooltips read "confidence → opacity", "confidence →
  point size", "mirror", "probe: participates in trigger-zone events",
  "emit bus: re-broadcast landmarks at the address prefix so rigs/
  routes/triggers can ride them".
- **Address prefix moved under "Rigs (object ← address)"**: was above
  the rig mapper section; now sits directly under that header, above
  the rig rows it's the prefix for.
- Verified live: clicking a dot then attaching to the test mesh
  produced a rig row with exactly 2 checkboxes (enabled, reset-
  transform — confirmed via its tooltip text); clicking the map's
  background hid the ring; the Streams panel's five checkboxes render
  with empty label text and correct per-checkbox tooltips; screenshot
  confirms the reordered panel layout (Rig mapper → Rigs header →
  Address prefix → rig rows) and a visible white ring. `npx tsc
  --noEmit` and `npx vite build` both clean.

## Multi-landmark live pen + iris picker + humunculus stream colors

- **Pen toggle moved before record, label → hover tip**: the Streams
  panel's per-stream pen checkbox now sits in the top row, between the
  stream name and the record button (was its own row below, with a
  visible "pen" label). Same treatment as the other Streams checkboxes:
  empty label, full description in the tooltip.
- **Live pen now supports multiple landmarks per stream**: `MMStream.pen`
  changed from `{ landmark: number }` to `{ landmarks: number[] }`
  (`src/core/types.ts`); `src/io/serialize.ts` migrates old saved
  scenes (`pen.landmark` → `pen.landmarks: [landmark]`). `StreamPen`
  (`src/mm/pen.ts`) now keys its per-landmark state by
  `` `${streamId}:${landmarkId}` `` instead of by stream alone, so each
  selected landmark draws its own independent stroke concurrently.
  Recording already baked all landmarks by default
  (`bakeClipToStrokes(..., landmark = -1)`), so no changes were needed
  there — "pen and record all of them" was already true for record,
  and is now true for the live pen too.
- **New multi-select landmark picker** (`multiLandmarkMapForKind` in
  `src/app/poseMap.ts`): clicking a dot toggles its membership in the
  selection (vs. the existing single-select pickers, which replace the
  one picked value). No dropdown — a "`N` selected" label replaces it.
  Reuses a new `kindConfig(kind)` helper so the single- and multi-select
  pickers can't drift out of sync on set/color/size per kind.
- **New IRIS visual picker**: `src/mm/irisLandmarks.ts` defines the
  standalone IRIS stream's own 10-point local index space (0-9, right
  eye then left eye — distinct from the iris points embedded in FACE's
  478-point index space) as a small two-eye SVG diagram.
  `irisMapPicker`/`irisSet`/`irisColorClass` added to `poseMap.ts`
  (mirrors the existing `faceMapPicker` pattern); `hasLandmarkMap` and
  `landmarkMapForKind` now include `'IRIS'`.
- **Stream default colors now match the combined body-map picker**:
  `createStream()` in `src/mm/streams.ts` — POSE `#7ab4ff`, HAND_LEFT
  `#7aff99`, HAND_RIGHT `#ff7ab1`, FACE `#fffb7a` — so a stream's point
  color always agrees with its landmark picker's dot color.
- Verified live: created POSE + IRIS streams, confirmed their default
  colors (`#7ab4ff`, `#ff598c`) match the new `createStream()` map;
  armed the POSE pen with landmarks `[0, 15]` — the map rendered both
  nose and left-wrist dots highlighted red with a "2 selected" label;
  armed the IRIS pen and confirmed the new two-eye picker renders and
  highlights the selected landmark; clicked a second iris dot and
  confirmed the click toggled it into the selection (`pen.landmarks`
  went from `[0]` to `[0, 5]`); inspected the DOM and confirmed the pen
  checkbox is the 5th child of the top row — after the name, before the
  record button — with an empty label and the full description as its
  tooltip. `npx tsc --noEmit` and `npx vite build` both clean.

## UI aesthetic pass: Blender-style number fields, expanded snap targets, grid dashes

- **Blender-style drag-number widget replaces every numeric input**
  (`dragNumber()` in `src/app/ui.ts`; `slider()` and `numField()` are now
  thin wrappers over it, so all ~90 call sites converted without
  signature changes — no `<input type=range>` sliders remain). Label
  left / value right in one flat box, Blender-justified. Hover changes
  the background and reveals ‹ › nudge arrows; click-drag scrubs
  (2px/step, quantized to step; Shift = ×0.1 fine); plain click opens
  type-in editing (Enter commits, Esc cancels, blur commits);
  Backspace while hovering resets to the default (when the call site
  provides one via the new `def` option); right-click opens a context
  menu: Reset to Default Value (Backspace hint), Copy Value, and — when
  the call site passes a routional dot-path via the new `route` option —
  Add Route, which creates a `TGRoute` bound to that path and jumps to
  the Bindings tab (`numAddRouteHook`, set by the UI constructor).
  Sliders keep min/max as an accent fill bar. The N-panel inspector's
  300ms auto-rebuild now also pauses while a widget is being scrubbed
  (`numDragActive`) so periodic rebuilds can't kill a pointer-captured
  drag. Topbar brush Size/Strength carry `def` + `route`
  (`brush.size`/`brush.strength`); the capture playback-rate raw range
  input became a slider with `def: 1`.
- **Collapsible panel subsections persist**: `panel()` headers gained a
  rotating caret and store collapsed state per title in localStorage
  (`threegrease.panels`), surviving refreshes and sessions.
- **Blender-parity snap targets**: `settings.snap.mode` extended with
  `GRID`, `EDGE_CENTER`, `EDGE_PERP`, `FACE_CENTER`, `FACE_NEAREST`.
  INCREMENT is now RELATIVE (transform deltas move in step multiples,
  Blender semantics) while GRID snaps to the absolute lattice — for a
  cursor click both land on the lattice. New projection.ts helpers:
  `nearestStrokeSegmentAll` (returns the winning segment so callers
  derive midpoints/perpendicular feet; `nearestStrokeEdgeAll` is now a
  wrapper), `perpendicularFoot`, and `raycastFaceTriangle` (world-space
  hit triangle for Face Center = centroid / Face Nearest = closest
  point on the hit face to the pre-move position). Wired into all four
  consumers: 3D-cursor placement (`App.placeCursor`), edit-mode point
  transforms (`transform.ts snapDelta`), object-modal G moves
  (`objectmodal.ts snapMoveDelta`), and the translate widget
  (`App.snapWidgetPosition`, INCREMENT/GRID). Topbar dropdown lists all
  ten targets with Blender names (SURFACE relabeled "Face Project");
  the stroke-scope sub-select now also shows for the new edge modes.
- **Grid subdivision dashes scale with the grid unit**: dash = gap =
  gridStep/4 (was 0.35 × the subdivision spacing), so the step/2 period
  tiles each major cell exactly twice and dashes stay aligned with the
  grid at any subdivision count.
- Verified live: topbar Size box scrubbed 8→33 (quantized to step 1),
  Backspace-on-hover reset it to 8, click-type "12.5" committed on
  blur, right-click menu rendered all three items and Add Route created
  a `brush.size` route + switched to the Bindings tab; snap dropdown
  enumerates all 10 modes; Routes panel collapsed state survived a
  `ui.refresh()` and was stored in localStorage; grid dashes render
  long and grid-aligned; drew a stroke to confirm the draw path still
  works (2 points, no NaN). `npx tsc --noEmit` and `npx vite build`
  both clean.

## Defaults + route targets across the number fields (follow-up pass)

Small committed steps (one commit each) spreading the new widget's `def`
(Backspace/context-menu reset) and `route` (Add Route → routional)
options across the UI:
- Mode toolbars: eraser/sculpt/paint/weight radii + strengths get
  factory defaults; Brush-advanced panel fully covered (Hardness/
  Spacing/Angle/Aspect/Jitter/Grain/Grain scale/smoothing/Simplify/
  Stabilize radius), with routes on Hardness (`brush.hardness`),
  Jitter (`brush.style.jitter`), Grain (`brush.style.grain`).
- Scene grid Step/Subdivisions (defs 1/10, min-clamped), FOV fields
  (def 50, clamp 5–140, route `camera.0.fov`), timeline FPS (def 24).
- Layer opacity routes to `layer.<id>.opacity`; `paramEditors()` gained
  a `routePrefix` so EVERY numeric modifier/effect param offers Add
  Route (`modifier.<id>.<param>` / `effect.<id>.<param>`).
- Legacy score entities: traveler speed (`cursor.<id>.speed`), trigger
  radius (`trigger.<id>.radius`), attractor strength
  (`attractor.<id>.strength`).
- Constraint travelers/triggers (phase/speed/radius defaults), stream
  rows (per-kind point-size defaults, depth default, clip transport
  phase/speed, pen min conf).
Typecheck clean at every step; per user direction, no browser
verification this pass — committed in six standalone commits.

## Editable generalized meshes (TGPolyMesh) — phases 1-7

Persistent, interactively editable mixed-dimensional topology (isolated
vertices + open edges + n-gon faces in one object), built in seven
committed phases; design rationale in `docs/design/polymesh.md`, manual
test script in `docs/verify/editable-generalized-mesh.md`.

- **Phase 1 — data model**: `TGPolyMesh` in `scene.polyMeshes` (plain
  JSON; stable per-mesh element ids via `nextElemId`; faces store ordered
  boundaries, never triangulations; `rev` cache counter). Pure utilities
  in `src/core/polymesh.ts`: add/find/remove for all three element kinds
  (duplicate edges rejected orientation-independently), `splitEdge` with
  adjacent-face boundary patching, `mergeVertices` (extrusion release-
  snap), adjacency/boundary queries, degenerate/orphan cleanup,
  `validatePolyMesh` + load-time `sanitizePolyMesh`. Serialization:
  `polyMeshes ??= []`, per-mesh defaults, broken refs degrade to less
  topology. Bindings are provenance-only.
- **Phase 2 — object integration**: ObjKind/ParentRef `'POLY'` across
  objects.ts (select/transform/delete/allRefs/world matrix/parenting),
  Add Editable Mesh (Shift+A + palette), Shift+D duplication, outliner
  rows, properties section (counts/color/opacity/unlit/two-sided/
  wireframe/drawTarget).
- **Phase 3 — renderer**: `PolyMeshManager` — per-face triangulation
  (Newell-normal plane projection, ShapeUtils on fresh copies, fan
  fallback), triangle->face-id map, edge overlay LineSegments, instanced
  screen-scaled vertex handles with per-state colors, transient previews
  from the `polyOverlay` singleton; rebuilds only on `rev` change; wired
  into pickableMeshes + ctx.surfaces (overlays raycast-inert).
- **Phase 4 — picking**: `pickConstruction` unified hit (priority: poly
  vertex/edge/face -> mesh surface -> GP stroke with PathRef + t ->
  sampled splat center -> sticky plane -> camera plane), `noSnap` (Ctrl)
  and `excludeVertexIds`; `bindingFor()` provenance mapping; splat
  adapter caches <=5000 subsampled centers per splat.
- **Phase 5 — Topology Pen + POLY mode**: context-sensitive build/close/
  split/reuse/move/extrude/select/delete/cancel with one-undo-step modal
  commits (local snapshot -> pushUndo -> reapply; cancel pushes nothing).
- **Phase 6 — spatial queries**: `polyMeshWorldPrimitives`,
  `distancePointToPolyMesh` (min distance, closest point, dimension
  0/1/2, element id; ties prefer higher dimension),
  `intersectsSpherePolyMesh`; TRIGGER constraints on POLY carriers test
  probes against real topology (primitives cached per constraint/frame).
- **Phase 7 — export + docs**: GLB exports faces (triangulated, world
  transform, color) + face-less edges as line primitives + isolated
  vertices as point primitives; OBJ/STL/PLY faces only (documented, not
  silently converted). Verification doc + HANDOFF/PLAN updates.

Not verified live this pass (per current workflow: typecheck + build
only); the verify doc lists the exact manual steps. `npx tsc --noEmit`
and `npx vite build` clean after every phase.

## PolyQuilt parity pass (Topology Pen v2)

Matched the reference operations table (github.com/sakana3/PolyQuilt /
Dangry98's 4.0 fork): click / drag / hold(450ms, Alt=hold) / hold+drag
disambiguated per target. New: vertex move-merge on release, rigid edge/
face move on a camera plane, hold delete/dissolve (dissolveEdge merges
two adjacent faces into an n-gon, dissolveVertex fuses 2-edge pass-
throughs), vertex hold+drag edge extrusion, interior-edge hold+drag LOOP
CUT across quad strips (walkQuadLoop plan + aligned-t preview +
splitEdge/splitFace commit, closed loops OK), empty hold+drag KNIFE
(screen-line edge splitting + face-crossing connection), Shift+click
AutoQuad (U-close / tri-close / bridge / L parallelogram-complete from
nearby open edges), Ctrl+click element select, click-last-vertex chain
finalize, and EDIT-mode routing (Tab/'2' on an active poly mesh lands in
POLY editing). Utilities: dissolveEdge/dissolveVertex/splitFace in
core/polymesh.ts; walkQuadLoop/autoQuad in tools/polyops.ts. Skipped
(documented in the verify addendum): brushes, seam, fan cut, hold-lock.
Typecheck + build clean; manual steps 60-70 added to the verify doc.

## PolyQuilt v3: intent feedback, center-drag extrude, tool trio in EDIT

removeFaceCascade makes face deletion take its sole-use boundary edges
and now-orphaned vertices (shared topology survives). HUD intent colors:
red element highlight once a long-press matures (delete armed), yellow+
thick edge with a grab-point tick in the extrude zone. Edge drags now
split by grab position — center band extrudes (boundary) or loop-cuts
(interior), off-center moves. Plane placement honors settings.snap
(Increment/Grid in-plane lattice). PolyPenTool gained variants and ships
as three tools in the POLY AND EDIT toolbars: PolyQuilt (context pen),
Poly Build (Blender's mapping: Shift+click delete, boundary-edge drag
extrudes anywhere, click adds), Quad Patch (click = AutoQuad fill); from
EDIT mode they retopologize over the pencil/objects being edited and
ensureEditMesh creates a target mesh on first use. Verify steps 71-78.

## PolyQuilt v4: mode retired, Surface ⊥ placement, Empty objects

The standalone POLY editor mode is gone — the quilt trio lives in the
Draw AND Edit toolbars, overlays keyed to the active tool (setTool
targets the picked/selected/first editable mesh, other tools clear the
overlays); '6' became a Tools shortcut for the PolyQuilt pen, and "Edit
mode with a poly selected" / Add Editable Mesh land on the tool instead
of a mode. New Placement "Surface ⊥" (SURFACE_PERP): first point on the
surface, stroke/chain grows on the sticky standing plane through it
(contains the hit normal, view-facing; perpendicularPlaneAt in
projection.ts, per-stroke module state + per-chain BUILD plane). New
TGMesh kind EMPTY: Blender-style plain-axes null object (Add menus +
palette) for parenting/grouping/constraint anchoring — raycastable via
an invisible pick sphere, never a draw target, skipped by material/
origin sync. Verify steps 79-81.
