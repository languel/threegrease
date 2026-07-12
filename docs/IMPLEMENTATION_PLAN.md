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
