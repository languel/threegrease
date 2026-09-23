# threegrease — Technical Handoff

*Written 2026-07-06 for successor models/agents of any capability level. Read
this first, then [PRD.md](PRD.md) for what we're building and
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for how. CLAUDE.md at the
repo root is the short-form working guide; this is the long form.*

## 1. What this is

threegrease is a from-scratch reimplementation of Blender's Grease Pencil in
three.js + TypeScript (Vite, zero UI frameworks), being grown into a
**platform for pedagogy and interactive art practice**: expressive 3D
drawing, live performance, event sequencing (MIDI/OSC/WebSocket), generative
form-finding (string art, wire art), and Gaussian-splat painting.

- Repo: `github.com/languel/threegrease` (private), branch `main`.
- Owner: languel (gh CLI authenticated). Commit style: descriptive body,
  push after every coherent feature pass. Always `npm run typecheck` first.
- Dev server: `npm run dev` → port 5199 (`.claude/launch.json` name "dev").

## 2. Feature inventory (all verified working as of `6385793`)

**Drawing**: pressure strokes (radius+opacity), stabilizer (lazy mouse),
active + post smoothing, RDP simplify, point/stroke/soft erasers with
splitting, raster bucket fill (marching-squares contour trace, leak guard),
tint brush, cutter (lasso trim), eyedropper, primitives (line, polyline,
arc, curve, box, circle with adjust phases + shift constraints), guides
(circular/radial/parallel/grid/iso).

**Placement**: Origin / 3D-Cursor / Surface (raycast canvas planes, sticky
per stroke, border-safe) / Stroke (depth inherited from nearest stroke
*segment*, single-stroke blending, sticky mid-draw, amber HUD anchor ring)
with All/Ends/First targets. Drawing planes View/Front/Side/Top follow the
world-up convention.

**Edit**: box/lasso/circle select tools (+Ctrl-lasso, C, `[`/`]`), point
and stroke select modes, G/R/S modal transforms with axis locks +
proportional editing + magnet snapping (Increment/Stroke point/Canvas),
the full stroke-op suite (subdivide, simplify, smooth, join, split,
merge-by-distance, dissolve, duplicate, arrange, cyclic, direction,
set-start, normalize, move-to-layer, assign material, snap to cursor/grid),
multiframe editing, copy/paste.

**Canvas planes**: scene-level quad objects — selectable (click, amber
highlight), transformable (G/R/S world-space), deletable (X), per-plane
Visible + Draw-target flags (reference planes vs drawing surfaces),
persisted in scene JSON, editable numerically in the Canvases panel.

**Modes**: Draw, Edit, Sculpt (9 brushes: smooth/thickness/strength/
randomize/grab/push/twist/pinch/clone), Vertex Paint (draw/blur/average/
smear), Weight Paint (single softness group feeding noise/opacity mods).

**Animation**: per-layer keyframes with types, timeline scrub/play,
auto-key, onion skinning (keyframes/frames modes, colors, fade),
interpolation (single breakdown + full sequence, stroke matching +
resampling). Scene cameras: multiple, named, keyframable (pos/rot/FOV,
slerped), camera view (`0`), cycle (`Shift+C`), lock-to-view navigation
including flythrough writeback, frustum helpers, keys on the timeline.

**Rendering**: custom screen-space ribbon shader (per-point radius/color/
opacity, round caps/joins, hardness, Line/Dots/Squares), earcut fills with
solid/linear/radial gradients, layer blend modes + tint + thickness offset,
stencil masks, holdout, 14 modifiers (evaluated non-destructively per
frame), 9 screen-space per-object effects (blur/glow/pixelate/rim/shadow/
colorize/flip/swirl/wave) via isolated-render composite.

**Navigation**: MMB orbit/RMB pan, Alt+LMB emulation (+Shift pan,
+Ctrl/Cmd zoom), trackpad two-finger orbit/Shift-pan/Ctrl-pinch-zoom
(toggleable), numpad-emulated view keys (1/3/7/9/5/2/4/6/8), clickable
axis gizmo with trackball drag, ortho toggle, animated view transitions,
flythrough (`~`, Enter accepts, Esc teleports back), world-up convention
setting (Z-up Blender default / Y-up three.js) driving all of the above.

**App**: presentation mode (`P`) hiding all chrome while shortcuts stay
live, N-panel inspector (live editable selection median/object/camera/
cursor), settings dialog (`,`) with preferences + fully rebindable keymap
(localStorage), preference persistence, scene JSON save/load with
migrations, PNG export, snapshot undo/redo.

## 3. Architecture (memorize this)

```
GPScene — plain JSON, the single source of truth (src/core/types.ts)
  objects[] → layers[] → frames[] (keyframes) → strokes[] → points[]
  cameras[], canvases[], cursor, frame range
      │   tools MUTATE DATA ONLY, ctx.pushUndo() BEFORE mutating,
      │   then ctx.requestRender()  (never touch meshes)
      ▼
GPSceneRenderer.update() — full rebuild when dirty (render/GPSceneRenderer.ts)
  per layer: remap time (TIME modifier) → clone strokes → run modifier
  stack → build ribbon geometry + earcut fills → meshes w/ blend/stencil
      ▼
three.js render → per-object screen-space effects composite (fx/effects.ts)
```

Iron rules:
1. **Everything user-visible lives in `GPScene`** and must survive
   `JSON.parse(JSON.stringify(scene))` — undo, save/load, and Blender
   interop all depend on this. New fields get `??=` migrations in
   `src/io/serialize.ts`.
2. **Stroke appearance is baked onto the stroke** at draw time (material
   index, width, hardness, future brush style). Never read live brush
   settings at render time.
3. Tools receive `AppCtx` (src/tools/context.ts) — scene, settings,
   history, camera, canvas, helpers. They never import from `src/app/`.
4. `ctx.camera` is reassigned every frame (persp or ortho); read fresh.
5. Canvas planes are **world-space scene objects** (`scene.canvases`),
   unlike stroke points which are object-space. `ctx.syncCanvases()`
   rebuilds their meshes after any mutation.
6. All keyboard shortcuts are keymap actions (`src/app/keymap.ts` ACTIONS
   + `App.runAction()` case). Never hardcode key checks.
7. All preferences go in `Settings` + `PREF_FIELDS` (context.ts) and are
   exposed in the settings dialog.

## 4. Module map

| Path | Contents | Extension points |
| --- | --- | --- |
| `src/core/types.ts` | entire data model | add fields here first |
| `src/core/gpdata.ts` | constructors, lookups (`frameAt`, `ensureFrame`, `activeCam`), cloning | |
| `src/core/mathutil.ts` | smoothing, RDP, resample, falloff, seeded RNG | |
| `src/core/history.ts` | snapshot undo | |
| `src/io/serialize.ts` | JSON save/load + **migrations** | version bumps |
| `src/render/materials.ts` | stroke + fill GLSL | new vertex kinds/uniforms |
| `src/render/geometry.ts` | ribbon + fill builders (BuildOptions) | stamp emission goes here |
| `src/render/GPSceneRenderer.ts` | data→mesh sync, onion, masks, overlays | |
| `src/modifiers/index.ts` | 14 modifiers, pure `strokes→strokes` + registry | add ModifierDef |
| `src/fx/effects.ts` | screen-space pass pipeline + registry | add shader + planEffect |
| `src/tools/context.ts` | Settings, AppCtx, prefs persistence | |
| `src/tools/projection.ts` | screen↔world, drawing planes, depth/canvas snapping, `pickCanvas` | |
| `src/tools/toolsys.ts` | Tool interface + manager | |
| `src/tools/{draw,fill,primitives,select,transform,editops,sculpt,paint}.ts` | per-mode tools | |
| `src/anim/{player,interpolate,camera}.ts` | playback, breakdowns, camera eval | |
| `src/app/main.ts` | App class: three setup, input routing, render loop, actions | |
| `src/app/ui.ts` | ALL DOM (panels, timeline, dialog, inspector) via `el()`/`btn()`/… helpers, rebuilt on `refresh()` | AppHandle interface |
| `src/app/nav.ts` | views, gizmo, fly, ortho, up-axis frame math | |
| `src/app/keymap.ts` | rebindable actions | |

## 5. Verification workflow (no test suite — the browser is the test rig)

`window.__tg` is the App instance. From `preview_eval` / devtools console:

```js
const app = window.__tg, ctx = app.ctx;
// draw a stroke synthetically (pen events; pointerId anything — capture is safe)
const c = document.getElementById('gl'), r = c.getBoundingClientRect();
const ev = (t,x,y,p=0.7,extra={}) => c.dispatchEvent(new PointerEvent(t,
  {bubbles:true, clientX:r.left+x, clientY:r.top+y, button:0, buttons:1,
   pressure:p, pointerId:1, pointerType:'pen', isPrimary:true, ...extra}));
ev('pointerdown',300,300); ev('pointermove',360,320); ev('pointerup',360,320);
// inspect data
ctx.scene.objects[0].layers[0].frames[0].strokes
// import any module live
const ops = await import('/src/tools/editops.ts');
// keyboard
window.dispatchEvent(new KeyboardEvent('keydown', {key:'g'}));
```

Rules: `location.reload()` before eval-testing if files changed (hot reload
wipes state and races synthetic events); check `preview_console_logs` for
errors; screenshot for visuals but assert on data.

## 6. Gotchas (every one of these cost real debugging time)

- `THREE.ShapeUtils.triangulateShape` **mutates its input** (pops duplicated
  end point). Iterate the projected array's length, not the source.
- Stroke placement: in-progress stroke must be excluded from its own depth
  sampling (`setStrokeExclusion`); depth snaps to ONE stroke with sticky
  depth mid-draw. Don't reintroduce cross-stroke averaging.
- Surface placement: sticky per stroke; canvas borders have raycast
  disabled; never add "helper" meshes to `ctx.surfaces`.
- OrbitControls caches its up-frame at construction — up-axis changes must
  go through `App.applyUpAxis()` which recreates it. All nav math runs in a
  Y-up reference frame via `Navigation.frameQuat()`.
- Pointer lock swallows Esc: fly-cancel is detected via `pointerlockchange`
  + `flyStopping` flag in nav.ts.
- `setPointerCapture` throws on synthetic pointer ids — always use
  `App.capture()`.
- Uncaught exceptions in the rAF loop kill it silently; `gp.update` stays
  wrapped in try/catch.
- With Emulate Numpad on, digit keys are views — mode shortcuts shadowed
  (intentional; Blender does the same).
- Multiply blend + radial gradients are approximations; holdout paints
  background color rather than true punch-through.
- Full geometry rebuild per dirty frame is the perf ceiling — planned
  incremental rebuild (see plan P10); don't micro-optimize elsewhere.

## 7. UI conventions (for delegated UI work)

Hand-rolled DOM in `ui.ts`. Helpers: `el(tag, attrs, ...children)`,
`btn(label, onclick, {active,title,cls})`, `slider`, `numField`,
`checkbox`, `colorField`, `selectField`, `panel(title, ...children)`.
Panels rebuild wholesale on `refresh()` — never cache node references.
UI ↔ app only via the `AppHandle` interface (top of ui.ts). CSS variables
at the top of `styles.css`. The N-panel inspector re-renders at ~3 Hz but
pauses while one of its inputs has focus.

## 8. External references driving the roadmap

| Reference | What we take from it |
| --- | --- |
| [Blender GPv3](https://developer.blender.org/docs/release_notes/4.3/grease_pencil/) | data model target for interop: GreasePencil ID → LayerGroups/Layers → frames → Drawings built on CurvesGeometry; per-curve attributes (fill_id etc.) |
| [languel/routional](https://github.com/languel/routional) | Blender addon: route incoming MIDI/OSC to properties; learn mode; range mapping (raw/scaled/clamp/wrap); MIDI-file→F-curves; monitor panel. We reimplement the *concept* natively. |
| [languel/iannix](https://github.com/languel/iannix) (fork of IanniX) | score model: **curves** (paths), **cursors** (playheads with own speed/period traveling curves, streaming positional messages), **triggers** (points firing when a cursor passes). OSC/MIDI out. This is the event-system blueprint. |
| [languel/mediamime](https://github.com/languel/mediamime) | web app: draw shapes over live camera; MediaPipe recognition; shapes → Web MIDI messages; Edit/Perform modes. Interop target via shared event bus / WS. |
| [Bridges 2022 #63](https://archive.bridgesmathart.org/2022/bridges2022-63.html) | Demoussel, Larboulette, Dattatreya, *A Greedy Algorithm for Generative String Art*: pins on a frame, greedily pick next chord minimizing residual vs target image, semi-transparent strings, stopping conditions. |
| [Multi-view Wire Art](https://cgv.cs.nthu.edu.tw/projects/recreational_graphics/MVWA) | Hsiao/Huang/Chu SIGGRAPH Asia 2018: voxels consistent with 2–3 view drawings → connected via constrained 3D pathfinding → spline skeleton optimized to match views. Anamorphic wire art blueprint. |
| [Spark](https://sparkjs.dev) ([github](https://github.com/sparkjsdev/spark)) | three.js 3DGS renderer: SplatMesh extends Object3D, renders alongside meshes, formats .ply/.spz/.splat/.ksplat/.sog/.rad, programmable "dyno" GPU graphs, LoD in 2.0. **Decision: use Spark, don't write our own splat renderer.** |
| Browser constraints | Web MIDI API native (Chrome); raw UDP OSC impossible in browser → WebSocket bridge required (small Node relay, see plan P2). |

## 9. Platform phases — ALL SHIPPED (2026-07-11, commits 30743e8..b4d0002)

P0 NPR brushes (stamps/grain/scene-units/presets) · P1 Blender GPv3 addon
(roundtrip passes vs Blender 5.1.1) · P2 event bus + MIDI/WS + OSC bridge
· P3 scores (cursors/triggers/attachments) · P4 routes (learn mode) ·
P5 string art + attractor sim · P6 multi-view wire art (99%/97% on 3/S) ·
P7 splats via Spark (three→0.180) · P8 GLB/OBJ/STL export · P9 protocol
doc · P10 per-layer rebuild (10.2x hot path). Per-phase regression
scripts: docs/verify/*.md.

New gotchas from the platform build:
- SparkRenderer must be constructed explicitly with our WebGLRenderer
  (SplatManager.init) — Spark's auto-detection never fires in our loop.
- Modifier evaluation preserves stroke ids (cloneStroke normally regens)
  so stamp jitter/NOISE seeds stay deterministic across rebuilds.
- markDirty(layerId) is the drawing/sim hot path; anything cross-layer
  (frame, mode, masks, undo, load) must stay global markDirty().
- Background browser tabs throttle rAF — headless verification must step
  engines manually (sim.step / gp.update), never await wall-clock frames.
- Wire-art scripting: compute camera eulers via lookAt, never by hand.

## Session log (2026-07-12 → 2026-07-13)

Full detail for each item lives in IMPLEMENTATION_PLAN.md under its own
`## heading`, in commit order — this is the short index.

**N-series (object-mode parity + AI surface)**
- N1 command palette (F3) + `window.__tg.execute('id | title | fuzzy', args?)`
  — the official automation/agent entrypoint (src/app/commands.ts)
- N2 orange selection outlines/origin dots, OBJECT cursor snap, OBJECT
  magnet-snap for point transforms
- N3 properties editor: icon tabs, later upgraded to a Blender-style
  vertical tab column (see Constraints below)
- N4 Ctrl+A apply transform (GP bakes points; mesh/splat fold TRS into a
  `baked` 4x4 inside worldMatrixOf) + per-modifier Apply (bake into
  keyframes)
- N5 everything-is-a-surface: splat drawTargets in ctx.surfaces,
  trigger/attractor `follow`, stroke-as-trigger-zone (TGTrigger.zone)
- N6 hierarchy outliner (tree, drag-to-parent, rename) + asset library
  (src/io/assets.ts, localStorage `threegrease.assets`)
- N7 icon-first pass: mode/widget buttons + Stroke Ops panel
- N8 splat nibs: NOT started (needs a texture-atlas redesign of the
  stroke shader + a Spark in-memory splat construction spike — scoped
  but out of budget so far)

**P11 MediaMime integration** — src/io/mediamime.ts: live landmark
registry over the existing WS/OSC bus; scene.mediamime.rigs (MMRig)
binds any object's translation to a live address; triggers are a full
ObjKind ('TRIGGER') — selectable/draggable/parentable/in the outliner;
MediaMime menu + 🎥 panel.

**Object right-click context menu** — viewport RMB + outliner row RMB
(object mode): Set Origin / Mirror / Clear / Apply / Snap
(src/tools/objectops.ts + ui.ts openContextMenu()).

**Global Snap + 3D cursor fixes** — two real bugs fixed, not just
features: (1) Shift+RMB only placed the cursor once on pointerdown, so
a held drag fell through to OrbitControls' RMB-pan — fixed with a
capture-phase pointerdown that claims Shift+RMB before OrbitControls
sees it. (2) grid snap rounded on a lattice over the current drawing
plane (view-aligned by default) instead of the visible floor grid — now
raycasts the world ground plane (X·Y for Z-up, X·Z for Y-up) and rounds
the two in-plane coordinates, matching Blender. The old `cursorSnap`
setting is retired; the 3D cursor now follows the single global magnet
(off = free move, on = Grid/Stroke point/Object origin/Surface).
SURFACE mode added (mesh/3DGS raycast via projection.ts
raycastSurfaces()). Cursor visual redrawn to match Blender (red/white
dashed ring + crosshair ticks, constant screen size).

**Terminology** — TGCursor (a stroke-riding playhead) is labeled
"Traveler" in all UI text; "cursor" is reserved for the 3D cursor.
Shift+T / Shift+G drop a trigger/traveler at the current 3D cursor.

**Constraint system (Blender-style)** — src/score/constraints.ts: any
object (GP/mesh/splat/trigger) can carry a constraint stack now, evaluated
every frame. FOLLOW_PATH = traveler (rides a stroke on its own clock),
TRIGGER = proximity zone (tested against every traveler, including
legacy score cursors). Also COPY_LOCATION/ROTATION/SCALE, TRACK_TO,
LIMIT_DISTANCE, SHRINKWRAP, FLOOR, SPRING. Properties editor is now a
vertical icon-tab column (Blender look) with a Constraints tab (⛓️) and
the grouped Add Object Constraint dropdown. Drag-along-path:
widget-dragging a Follow Path object re-projects onto its stroke and
edits the phase instead of pulling it off the path. Shift+A opens an
Add menu at the mouse; on-stroke detection spawns travelers/triggers at
the clicked arc-length position. Object target fields (constraint
targets, and reusable anywhere else) got a Blender-style picker:
eyedropper (crosshair pick-mode via App.pickObject) + dropdown + editable
name field (src/app/ui.ts objectPickerField()).
NOT migrated: legacy score.cursors/score.triggers still run side by
side with the new constraint system — nothing auto-converts, and only
constraint-based travelers support drag-along-path.

**Blender G/R/S modal transform** — src/tools/objectmodal.ts: object
mode now transforms Blender-style (G/R/S, axis/plane locks, RR
trackball, numeric input, Shift precision, Ctrl inverts the magnet
mid-gesture); gizmo hidden behind the new showGizmo pref (topbar 🧭);
header overlay + status hints during the modal; shared
App.applyWorldDelta() so gizmo and modal apply deltas identically
(parenting + Follow-Path leash).

**Mode pie menu + Tab history** — Alt+Tab opens a Blender-layout radial
mode picker (ui.openModePie): click a wedge or press its numpad-style
digit, works as a blind chord too (Alt+Tab 8 → Draw before the menu even
paints). Wedge labels are short (Draw/Sculpt/Object/Edit, "Mode" dropped)
with Weight Paint/Vertex Paint spread further from Draw so it isn't
crowded. Tab no longer hardcodes Draw↔Edit — App tracks a 2-slot mode
history and toggles back to whichever mode you were actually in before.
Object mode got its first keyboard entry point (`modeObject` action,
unbound by default — 1-5 are taken — but reachable via the pie).
Platform caveat on record: Ctrl+Tab is a browser tab-cycle shortcut and
doesn't reliably reach the page, which is why the default moved to Alt+Tab.

**Edge snap + stroke-point snap bug fix** — the reported "picks a random
stroke and won't attach to any other" bug was real: every POINT-snap call
site routed through `gatherDepthCandidates`, which is deliberately scoped
to `activeObject()` (correct for draw-time depth, wrong for magnet
snapping). New `nearestStrokePointAll`/`nearestStrokeEdgeAll`
(projection.ts) search every GP object directly, with an Any-GP/Selected-
only scope (`settings.snap.strokeScope`). Edge snap is new: continuous
closest-point-on-segment, not just vertices — the "Vertex" (renamed from
"Stroke point") vs "Edge (along path)" distinction now matches Blender.
Wired into all three magnet call sites (object modal, EDIT-mode point
transform, 3D-cursor drag).

**Multi-select fixes** — Cmd/Ctrl-click now aliases Shift for add-to-
selection (was Shift-only); box-select now sets the active/target object
(`objectPick.lastPicked`) like click-select already did; the brighter
"active" selection-outline color generalized from GP-only
(`scene.activeObject`) to any kind via `lastPicked`.

**Stroke Ops right-click menu (Edit mode) + Separate** — RMB in Edit mode
opens the full stroke-op set with shortcut hints auto-shown. New
`editops.ts separateSelected()` = Blender GP Separate (P, shadows the
global Presentation-mode binding while in Edit mode — same shadow
pattern as Emulate Numpad). Y (Split) already existed.

**Auto-Separate Connected Strokes (object menu) + Origin to First Point**
— `objectops.ts separateConnectedIntoObjects()`: Blender "Separate by
Loose Parts" for GP, partitions the CURRENT FRAME's strokes into
connected components by endpoint proximity (every stroke is a flood-fill
seed — generalizes selectConnected/Ctrl+L's grow-from-selection graph
into a full partition), each component beyond the first becomes a new GP
object, and EVERY resulting object gets its origin retargeted to its own
first point (`originToFirstPoint`, also added standalone to the Set
Origin submenu). Scoped to the current frame only — documented, not
silently wrong for animated content.

**Multi-object Object Properties** — selecting 2+ objects used to
collapse the panel to a dead "N selected" message. Now shows the active
(last-picked) object's Loc/Rot/Scale, and editing a field applies that
value ABSOLUTELY to every selected object on that axis independently
("type 0 in Z, everyone drops to the ground plane, each keeps its own
X/Y"). `App.getLastPicked()` exposes the active ref to ui.ts.

**UI cleanup pass** — icon-only Snap toggle (was "🧲 Snap" text);
resizable sidebar (`#sidebar-resize` drag handle, 200-640px, persisted);
two real bugs fixed, not just polish: (1) a focused `<select>` silently
disabled every keyboard shortcut until a manual click into the viewport
(App.onKey bails on SELECT/INPUT/TEXTAREA targets) — fixed by blurring
any SELECT on `change` and on Escape; (2) right-click "Rename…" did
nothing because it used `window.prompt()`, which is silently blocked/
no-op in sandboxed embeds — replaced with `renameObjectInline()` reusing
the outliner's already-working double-click field; F2 now renames the
active object from anywhere. Default GP object names changed
GreasePencil→PencilN.

Where next: N8 splat nibs (needs the atlas/Spark spikes above); rest of
PRD §1b vision items (worker fill, stamp instancing, texture stamps,
curve edit); consider migrating legacy score cursors/triggers onto the
constraint system now that it's proven out, to collapse the two
parallel traveler/trigger implementations into one; Blender's post-
transform redo panel (re-editable numeric readout after G/R/S confirms)
isn't built, only the live-modal HUD exists.

## Session log (2026-07-14)

Full detail for each item lives in IMPLEMENTATION_PLAN.md under its own
`## heading`, in commit order — this is the short index.

**Selection outline + theme colors** `[14bda5f, 2b2f561, 9025a01]` —
root-caused "whole object highlighted instead of outlined": MeshManager
was applying an emissive tint on top of the existing Box3Helper outline;
removed the tint. New Theme settings (uiAccent/uiHighlight/gridColor)
drive both CSS vars and three.js selection-glyph colors; grid
auto-contrasts against background unless overridden. The outline itself
was then rebuilt on `LineSegments2`/`LineMaterial` (three/examples/jsm/
lines) because `LineBasicMaterial.linewidth` is a WebGL no-op on every
platform — the old outline was correct in color but invisible at 1px.
Two follow-on color bugs, both from the same root cause: outliner-row
selection was hardcoded to a stale blue instead of `var(--accent)`, and
`THREE.Color`'s default constructor treats numbers as already-linear,
silently brightening gamma-encoded settings colors on every round trip
— fixed with a `srgbColor()` helper used everywhere a settings color
becomes a `THREE.Color`.

**Set Origin for MESH objects + Origin to Geometry (Base)** `[3daa1ec]`
— Set Origin (Geometry/Cursor) previously GP-only; extended to
primitive MESH kinds (image planes included, they're PLANE mesh objects
post canvas-retirement). Primitive geometry is procedural, not
persisted per-vertex, so a new `TGMesh.originOffset` field mirrors GP's
retargetOrigin point-shift trick, baked into the geometry incrementally
by `MeshManager.sync()`. New op: Origin to Geometry (Base) — pivot to
the bottom-face XY-center, for staging/floor-placement.

**Aesthetic pass: icons, checkboxes, outliner view/lock** `[5e31c94]` —
new `src/app/icons.ts`, a curated Heroicons-style inline SVG set;
replaced every emoji/unicode icon app-wide (toolbar, mode switcher,
gizmo/widget buttons, mode pie, sidebar tab strip, outliner, layers,
stroke ops, playback) with it. `btn()`/`iconCheckbox()` now accept a
`Node` label. Checkboxes restyled globally via CSS
(`appearance: none` + drawn checkmark), zero call-site changes. Every
outliner row gained a consistent eye/lock icon pair: GP objects and
triggers gained object-level `hide`/`lock` (GP visibility was
previously per-layer only; triggers had neither); mesh/splat gained
`lock`. Lock blocks viewport click/box-select
(`isObjectLocked()`/`objects.ts`) but the outliner row itself stays
selectable — Blender's "lock guards against stray clicks" semantics,
not "unselectable everywhere."

Where next: same as above (N8 splat nibs, PRD §1b vision items, legacy
score/constraint consolidation, post-transform redo panel) — nothing
in this session changed those priorities.

## Session log (2026-07-18): editable generalized meshes (TGPolyMesh)

New object type for authored topology, distinct from primitive/imported
`TGMesh` (design note: `docs/design/polymesh.md`; manual verification
script: `docs/verify/editable-generalized-mesh.md`).

- **Data**: `scene.polyMeshes: TGPolyMesh[]` — plain-JSON vertices/edges/
  faces with stable per-mesh element ids (`nextElemId`), mixed 0D/1D/2D
  topology by design, faces store polygon BOUNDARIES (triangulation always
  derived). `rev` counter drives renderer cache invalidation. Pure
  topology utilities in `src/core/polymesh.ts` (add/remove/split/merge/
  adjacency/validate/sanitize); vertex `binding` records provenance only
  (never re-evaluated when sources move).
- **Object system**: ObjKind/ParentRef `'POLY'` participates everywhere —
  selection, G/R/S, parenting, outliner (color/drawTarget/eye/lock),
  duplication, deletion, constraints, save/load migration.
- **Renderer**: `PolyMeshManager` (`src/render/polymesh.ts`) — triangulated
  face meshes (Newell-plane + ShapeUtils on copies), edge LineSegments,
  instanced screen-scaled vertex handles, hover/select/active/invalid
  states, transient previews via the `polyOverlay` singleton (the tool<->
  renderer channel; nothing transient touches GPScene).
- **Tool**: POLY mode (key `6`) + Topology Pen (`src/tools/polytool.ts`):
  click-to-build chains, close faces on the start vertex, edge split on
  click, modal vertex move (Ctrl = no snapping), single-boundary-edge
  extrusion with release merge, Shift+click element select + Delete
  cascades, Enter finishes open chains, Escape restores the exact
  pre-op state. Modal undo = local mesh snapshot -> pushUndo -> reapply
  (one step per op, none on cancel).
- **Picking**: `pickConstruction` (`src/tools/polypick.ts`) unified hit
  with fixed priority (poly vert/edge/face -> mesh -> GP stroke w/ PathRef
  -> splat -> sticky plane -> view plane). Splat adapter
  (`src/tools/splatpick.ts`): cached, subsampled (<=5000) center
  projection — approximate by design, the only Spark-aware poly code.
- **Spatial queries**: `src/core/polyspatial.ts` —
  `distancePointToPolyMesh` (dimension + element id, ties prefer faces),
  `intersectsSpherePolyMesh`; TRIGGER constraints on POLY carriers test
  probes against actual topology inflated by the radius.
- **Export**: GLB carries faces + face-less edges (lines) + isolated
  vertices (points); OBJ/STL/PLY export faces only (documented).
- **Deferred**: live re-binding/resnap of bound vertices, BVH/accel
  structures, loop cut/multi-edge extrusion and the rest of the explicit
  out-of-scope list, N-panel poly element inspector.

## Session log (2026-07-19): PolyQuilt parity + UI restructure

TGPolyMesh gained full PolyQuilt-style interaction (see
IMPLEMENTATION_PLAN entries "PolyQuilt parity" through "v4" + the UI
polish pass): operations-table pen (click/drag/hold/hold+drag per
element), dissolve/loop cut/knife/AutoQuad, intent-colored HUD
feedback, center-band edge drags, Surface ⊥ placement (SURFACE_PERP),
Empty null objects, no standalone POLY mode (quilt trio lives in the
DRAW and EDIT toolbars, '6' jumps to the pen), snap-respecting drags,
outliner pinned above the properties tabs, Constraints folded into the
Modifiers tab, instructional rows converted to header tooltips.
Verify doc: docs/verify/editable-generalized-mesh.md steps 1-81.

## Session log (2026-07-27): materials, NPR brushes, stroke renderer

Five material phases, then the brush/stroke work they enabled. Detail
lives in IMPLEMENTATION_PLAN; this is the shape of it.

**Materials (phases 1-5).** Shared `TGMaterial`/`TGImage` datablocks with
PBR slots (`render/materialmgr.ts`, one image cache replacing two
duplicate `textureFor` maps); persisted per-face-corner UVs plus unwrap
operators (`core/uvunwrap.ts`); brush tips and stencil painting
(`tools/stencil.ts` — image, live video, or an object silhouette rendered
to an RT and read back); lights as first-class objects with shadows
(`render/lights.ts`); and projection/texture baking (`render/bake.ts` —
UV-space G-buffer, then reproject the source through the camera, then
dilate so seams don't bake black).

**NPR brushes.** `render/atlas.ts` packs every image a GP material samples
into one atlas bound as `uAtlas`, with each vertex carrying its material's
sub-rect — this is what unblocked per-stroke textures ("N8") without
splitting the merged per-layer batch. Materials gained stroke/fill Style
(Solid / Gradient / Texture). Brushes gained variation along the stroke
driven by a chosen signal (random, curvature, draw speed, arc position),
plus taper, and eight presets on top of the original five.

**Stroke renderer rewrite.** LINE mode is now ONE miter-joined triangle
strip instead of per-segment quads plus a disc at every point. See the
CLAUDE.md gotchas — the short version is that the old topology overlapped
itself everywhere, and strokes are translucent, so joins composited into
visible beads.

**Three bugs worth remembering**, all of which presented as something
other than their cause:
- A mouse reports `pressure` exactly 0.5 ("no sensor"), which was taken
  literally and halved every stroke's width AND opacity. That is why
  "opaque" strokes looked translucent, and it was also the entire reason
  stroke self-overlap was visible — at true alpha 1 an overlap is
  invisible for free.
- `clonePoint` enumerates GPPoint's fields explicitly and the modifier
  stack clones every stroke before rendering, so a new field reaches the
  data model but silently never reaches geometry.
- Exceeding the 16 vertex-attribute limit doesn't throw; the program
  fails to link and nothing draws while the geometry looks correct.

**Deploy.** `.github/workflows/pages.yml` publishes `dist/` to GitHub
Pages on push to `main` (feature branches build but don't deploy).
`vite.config.ts` uses `base: './'` so the bundle runs from any subpath;
verified by serving a production build under `/threegrease/`.

## Session log (2026-08-22): viewport shading + scene world

Blender's four viewport-shading modes and a World panel. Detail in
IMPLEMENTATION_PLAN.md under "Viewport shading + scene world".

- `TGWorld` on `GPScene` with five modes: solid colour, gradient,
  equirectangular image, video/live, and three's physical sky. One source
  feeds both the background and (via PMREM) the IBL.
- `settings.shading` (`WIREFRAME`/`SOLID`/`MATERIAL`/`RENDERED`) with
  buttons at the right end of the topbar and `Z` / `Shift+Z` to cycle.
  Solid and Wireframe use a fixed studio light and ignore the world.
- 360 video works, including as image-based light (re-derived at 2.5Hz
  from a downscaled scratch canvas). Local files open as `blob:` URLs,
  which `serializeScene` strips so a saved scene never carries a dead
  handle.
- New agent tool `world.set` (rotation in degrees on the wire, radians in
  the model) — reaches MCP/ACP for free, like every other tool.

**The lesson from this one:** four separate bugs all presented as a black
viewport, and none of them was where the black was. Three came down to
three.js sizing something from `image.width`/`image.height` — values that
are 0 on a `<video>` element and near-zero on a 2px ramp — and the fourth
was a shader that failed to compile, which does not throw. When the whole
viewport goes black, check the console for a shader link failure before
suspecting the thing you just changed.

## Session log (2026-08-22b): actors — rigged characters

New subproject. Detail in IMPLEMENTATION_PLAN.md under "Actors".

- `TGActor` in `scene.actors`, a first-class object (`ObjKind` 'ACTOR'):
  selection, transform, parenting, outliner, constraints.
- `src/actor/` — `skeleton.ts` (the default 21-joint mannequin),
  `solver.ts` (verlet + PBD + FABRIK), `rig.ts` (auto-rigging).
- Viewport shading, physics params and rig setup live in a new Actor tab.
- Actor Pose tool for dragging joints; `actor.*` route targets for
  MIDI/OSC; `actor.create/rig/pose` agent tools.

**The design point worth keeping:** the skeleton is positional, not
rotational, and nothing writes the pose — every input (capture, mouse,
MIDI, agent) pushes a target into one solver. That is why a captured wrist
drags the whole arm instead of tearing off the skeleton, and why adding a
new input source needs no new posing code.

**The lesson:** three of the four bugs in the rigging pass were modelling
errors that looked like physics bugs. The figure kept shrinking, and the
cause was that `chest` binds to the shoulder MIDPOINT while its rest
position sat anatomically below the shoulders — the captured direction and
ours disagreed, so retargeting lost height every frame. When a rig drifts,
suspect the correspondence between joint and landmark before the solver.

## Session log (2026-08-29): WebMCP + chat-shaped agent panel

Detail in IMPLEMENTATION_PLAN.md under "WebMCP + a chat-shaped assistant
panel".

- `src/agent/webmcp.ts` registers the existing `AGENT_TOOLS` with
  `document.modelContext`, so the browser's own agent drives the scene with
  no relay and no Node process. Fourth consumer of one registry.
- The assistant panel is now a real chat: bubbles on opposite sides, a
  compact tool log badged by caller, a pinned composer. Settings folded
  away; all explanatory prose replaced with hover tooltips.

**The lesson from this one:** the API's entry point is
`document.modelContext`, and essentially every secondary source says
`navigator.modelContext`. Reading the actual spec (and Chrome's own docs,
which agree) was the difference between working and failing silently —
`registerTool` on the wrong object never runs and throws nothing. When a
standard is young enough that the blog posts outnumber the implementations,
the blog posts are describing an older draft.

Second lesson, smaller: verifying against a mock is worth doing even when
you cannot test the real thing. The mock caught two genuine result-shape
bugs — a screenshot going out as base64 text instead of an image block, and
handlers that return `{error}` rather than throwing being reported to the
agent as successes.

## Session log (2026-09-19): planning a room — quad view, mesh editing, the Library, projectors, lenses, cameras

A long arc aimed at one use: BLOCKING OUT AN INSTALLATION and seeing what
it would look like. Detail in IMPLEMENTATION_PLAN.md under "Quad view",
"The magnet reaches drawing", "Mesh edit mode", "The Library as a
container", "Live sources", "Perf pass", "Projectors", "Draw objects in
place", "Lenses" and "Cameras are objects".

What shipped, in commit order:

- **Quad view you can work in**: input routed per pane by impersonation
  (`App.withPane`), with the helpers, HUD, modals, picking and brush
  circles all following the pointer's pane; leaving quad view adopts the
  hovered ortho view, Maya-style.
- **Precision drawing**: the magnet now reaches DRAWING, the grid lattice
  lives in the active plane, `Plane: None`, `Placement: Nearest` targets
  (Element / Vertex / Edge / Face), rectangles that are rectangles in their
  plane, and pie menus (Opt+, . / ') for Placement, Plane, Guide and Snap.
- **Mesh edit mode**: vertex / edge / face selection, G/R/S with world-axis
  and plane locks, extrude, fill, delete, Separate (mesh and strokes, by
  selection / loose parts / material), primitives converting in place to
  editable meshes, and Sculpt folded in as an Edit tool.
- **The Library as a container**: drop to keep rather than to place, studio
  thumbnails, folders with drag to file, multi-select, zip export/import,
  render view / render selection into it, and double-click to place at the
  3D cursor through the placement chain.
- **Live sources**: cameras, videos and GIFs as Library assets with pause
  and freeze, feeding planes, textures and capture alike; a generated test
  camera and test card so camera work is verifiable in the preview pane.
- **A perf pass with an instrument**: the frame-breakdown overlay
  (Ctrl+Alt+F), render resolution, and the two real costs it found — a live
  camera copied every animation frame, and MediaPipe detecting on every
  display frame of an unchanged picture. 1–2 fps back to 60.
- **Projectors**: a spot light that throws a gobo or a picture at a real
  aspect, with the throw readout, flat (unlit) projection, edge blending,
  masking, and look-through-light aiming.
- **Draw objects in place**: twelve kinds through the same placement chain
  as a stroke, so blocking out a set is drawing it.
- **Lenses** for cameras and projectors: fisheye (equidistant, equisolid,
  Bourke polynomial), equirectangular, cylindrical, mirror ball — a dome
  projector and a 360 camera out of one model read in two directions.
- **Cameras are objects**: outliner row, selection, widget, parenting,
  delete, and a properties panel with the lens, focal length, clipping and
  keys.

**The lesson from this one, in three parts.**

*Every viewport assumption is a global.* Quad view broke sixty call sites
that all did the same innocent thing — read the pointer against the canvas
and unproject through the camera. The fix that worked was not touching the
sixty; it was making those two answers lie correctly for the duration of an
event. When a new mode contradicts an assumption that old code makes
everywhere, moving the assumption beats visiting every caller.

*A setting that is visibly on and does nothing is worse than a missing
feature.* The magnet applied to the cursor and the transform tools but not
to drawing; the grid lattice raycast the floor whatever the Plane said. Both
read as "snapping is broken" rather than as an absent feature, and neither
throws. The same shape recurs through this arc: the Library's silently
refused `prompt()`, a drag the browser rejects over `effectAllowed`, a
projector that works only in Rendered shading. The panel has to say so.

*Measure before optimising, and build the instrument first.* The 1–2 fps
report could have been blamed on any of a dozen things. The lap breakdown
named it in one run, twice — and both causes were doing correct work at the
wrong RATE, not doing anything wrong.

## Session log (2026-09-20): lighting a real room — projectors, transforms, scans

Detail in IMPLEMENTATION_PLAN.md under "Projectors: aiming, keystone, and
which way up the picture lands", "A transform has a frame and a pivot",
"Angles in degrees, typed in whatever you like", "Scans: the dollhouse view,
and reaching through a wall", "A placed video is its own player" and "One
mark for 'selected', and one for 'being made'".

This is the session where the tool met a real room: a 162k-triangle scan of
the gallery an actual student show is being planned in.

- **Cameras became objects** (outliner, selection, widget, parenting,
  delete) with lens, focal length, clipping and keys in their panel.
- **Projectors became aimable**: drag the ring the beam draws on what it is
  lighting, or Aim at cursor. Then KEYSTONE — drag the four corners of the
  thrown picture onto the real corners of the screen, the doorway or the
  next projector's edge, which is projection mapping.
- **The quarter-turn bug**: the picture landed rotated 90 degrees because
  three's shadow camera resolves its roll against world +Y, which is
  sideways in a Z-up scene. Both projection paths sample through that
  matrix, so both were wrong together.
- **Transform orientation and pivot** as header settings, driving every axis
  lock in both editors through one shared basis; N / Shift+N along and
  across the normal; Ctrl inverts the magnet in every drag.
- **Angles are degrees**, with `pi/2`, `30deg`, `0.5rad` and arithmetic
  accepted in any angle field.
- **The light gizmo is draggable** — cone, blend, and a point light's reach.
- **Scans work**: imports are single-sided, so a room scan opens into the
  dollhouse view AND you can reach through the near wall to place things on
  the floor. Imports gained their own display controls; Wireframe shading
  reaches them, untextured.
- **Added objects arrive in your hand** — selected with a move armed, so
  placing is one gesture rather than find/select/G.
- **Per-instance video**, and texture slots that pick from the Library.
- **One selection mark everywhere**: meshes take the render silhouette, and
  so does the object being drawn.

**The lesson from this one: the bug is usually in what the library assumes,
not in the arithmetic.** Three separate "wrong rotation" bugs this session
were all the same shape — `lookAt` and three's shadow camera resolve ROLL
against an `up` vector that defaults to +Y, which in a Z-up scene is
sideways or degenerate. None of them looked like a rotation bug: one was "a
new projector throws its picture on its side", one was "the picture is a
quarter-turn out", one was "aiming does nothing". The fix each time was to
hand the library the scene's own up.

The second lesson is cheaper: **the interaction half of the dollhouse view
cost nothing, because three's raycaster already honours `material.side`.**
The culling that makes a scanned room readable is the same culling that lets
you click through it. Reaching for a bespoke facing test would have built a
second source of truth that could disagree with the screen.

## Session log (2026-09-21): the room lit, the snapping honest

Detail in IMPLEMENTATION_PLAN.md under "Lighting a room", "Snapping that
does not chase its own tail" and "Camera and lens corrections".

A pass of corrections found by USING the thing on a real gallery scan
rather than by reading it:

- **The sun was not infinite.** Its shadow box was fixed, so it ended in the
  middle of the room with a visible edge — and the unshadowed side read as
  brighter, which is why it looked like a half-plane rather than a frustum.
  Fitted to the scene now, with the bias scaled to the fit (the second
  layer: a big box puts the same step back as self-shadowing acne).
- **Area lights** (three's RectAreaLight) with their limits stated in the
  panel: no shadows, standard materials only.
- **An aim handle for every light with a direction** — sun, spot, area.
- **Snapping was chasing the object being dragged**, walking it up the ray
  into the camera. Drags exclude what they drag; editor furniture is
  excluded from every snap raycast.
- **Vertex and Edge snapping reach conventional meshes**, with a vertex
  budget so a 162k scan costs one raycast rather than a walk per mouse move.
- **A polynomial lens is normalised to its own edge**, which fixes both the
  collapsed fisheye and the Field of view control that did nothing.
- Cameras: selecting one no longer makes it active, "Stop looking" stops,
  lenses can be saved by name.

**The lesson from this one: the symptom names the wrong culprit almost every
time.** "It snapped to the camera" was a snap chasing the dragged object up
its own ray. "There is a shadow half-plane behind the sun" was a shadow
frustum ending, and then — once fitted — the same line again from shadow
acne, which is a different cause with an identical picture. "The fisheye
zoomed to the centre" was a polynomial that never reaches the edge of the
image circle. In each case the fix was found by MEASURING the thing the
picture was actually made of (the shadow matrix's uv, the lit-pixel
histogram either side of the seam, r(θ) at the half angle) rather than by
adjusting what the symptom pointed at.

## Session log (2026-09-21, later): splats you can edit, scans you can register

Detail in IMPLEMENTATION_PLAN.md under "Tool families and one Add list",
"Splat Edit mode", "Registration by measurements" and "Snapping you can see".

- **UI**: flat icon buttons on every toolbar; one nested Add list shared by
  the menu bar and Shift+A; tools of one kind share a toolbar button with a
  flyout (W cycles selection); a narrower toolbar aligned with the mode
  buttons; distinct Object and Library tab icons.
- **Splat Edit mode**: box / lasso / circle select through the cloud,
  select inside a box / sphere / cylinder or in front of a plane, delete,
  crop, separate into a new baked PLY. Deletions are a bitmask-or-runs
  string of source indices on `TGSplat.removed` — the file is untouched,
  undo works, Restore brings everything back.
- **Splat display**: splats or point cloud, splat scale, opacity
  multiplier, min-opacity (confidence) and max-size filters, select / delete
  filtered. Everything is rebuilt from the packed array AS LOADED.
- **Registration**: a measurement attached to one object can rescale that
  object, and ALIGN it onto any other measurement — order-free pairing,
  subset matching (hypothesise and verify), or a shape fit (ICP onto the
  other's legs, both ways), least turn among ties.
- **Snapping**: the magnet's Vertex / Edge reach mesh elements and splat
  centres and carry the object hit so measurement points bind; the catch is
  shown as a glyph and as the cursor.

**The lesson from this one: an ambiguity is not an error, and it has to be
broken on purpose.** A box has 24 equally exact corner orderings, a square
top fits four ways, a flat outline cannot say which side the object is on,
and four corners fit a traced outline's midpoints as exactly as its corners.
Every one of those passed the obvious test (the residual is zero) and gave
the wrong answer. What breaks them is what the person meant: the order they
clicked, the points left over lying on the shape, and the object having been
put in roughly the right way up — in that priority.

## Session log (2026-09-21, late): time volumes

Detail in IMPLEMENTATION_PLAN.md under "Time volumes (space-time cubes)" and
"Time volume filters, the Volume display and the source picker".

A film as a space-time cube (after Cassinelli's Khronos Projector): a VOLUME
object kind, sliced by any mesh (position, time map, or a bent time surface
that sweeps through as you scrub), recorded live from a camera into a ring,
filtered (people via MediaPipe, colour key, brightness, motion), shown as a
see-through ray-marched block, and convertible to a splat cloud.

Later in the same session: a PLAYHEAD in the Volume display (a crisp slice
through a ghost of the block, or the block cut open at the current frame —
the car-4d look) that plays, pauses and scrubs through time or across the
picture; the ghost kept as a cloud but floored per ray so it reaches the
box; Escape no longer deselects after a panel edit (its fallback belongs to
the viewport); the Speed row fixed (a grouped slider took its standalone
width and hid the play button).

Where to pick up on volumes: animated strokes and actors as sources;
segmenting LIVE volumes (people only works on files today); carrying panel
focus across a rebuild, app-wide.

**The lesson: test an effect with material that does not already look like
the effect.** The first test clip was a render of this very idea, so it
looked right however the cube was built. A dancer moving in place is the
honest test: an oblique slice has to show two dancers at two moments, and a
surface bump has to push part of one into the past.

## Session log (2026-09-22): the mesh editor made honest, and one brush for everything

Detail in IMPLEMENTATION_PLAN.md under "Poly Edit mode: picking, dissolve
and welds", "Material shading's missing light", "Poke, and two-click cuts
that join the topology", "E is Extrude everywhere; the eraser moves to
hold-D", "Vertex and Weight paint stop being modes", "Sculpt across kinds,
and Relax", and "Measure wherever points are placed".

A day of the poly editor being wrong in ways that all looked like different
bugs and were mostly one: geometry that LOOKED joined and was not. A click
into a face dropped a free vertex that only appeared to belong to it; a
two-click line between two existing points made an edge with no face on
either side; a vertex you had just added mid-edge could not be dissolved
without taking the whole face; corners built as separate chains sat
coincident and unwelded. Each fix is small; together they are the
difference between a topology tool and a drawing of one.

Then the keys. E meant Extrude in one editor and the eraser in another, so
E is Extrude everywhere and the eraser moved to hold-D + right-drag. Vertex
and Weight paint turned out to be modes wrapping tools that already sat in
Draw's own toolbar, with the top bar already wired for them — half a
refactor someone had left, finished here. And Sculpt, which had only ever
reached grease-pencil points, now brushes whatever Edit mode is actually
editing, with RELAX as a real brush beside Smooth.

Where to pick up: Thickness, Strength and Clone are still stroke-only (they
say so on a mesh rather than doing nothing); sculpting an imported MODEL is
deliberately out (no conversion, and a 162k-triangle scan is not per-move
work); a Relax that also honours a crease INSIDE a surface, not just its
border, is the obvious next refinement.

**Three lessons, all the same shape: a fix that looks right can quietly
break the thing next to it.**

- Making the extrude+grab one undo step by pointing the drag's snapshot at
  the pre-extrude state ALSO pointed the drag's per-vertex position lookup
  there — and the extruded vertices had no entry in it, so they never moved.
  It reads as "the axis lock snapped my face to the ground". One field
  serving two roles is the whole bug; splitting it is the whole fix.
- A relax brush that slides vertices "anywhere but along the normal" eats
  its own mesh, because a free border contracts under a Laplacian: a
  3.0-wide row came out 0.04 wide, perfectly evenly spaced. And pinning the
  border is not enough — an unpinned CORNER cuts itself off and bows the
  edges beside it.
- Test an effect against material that does not already look like the
  effect (carried over from the volumes session, earned again here): the
  first cut test used a quad whose two endpoints happened to share a face,
  which the narrow fix handled and the real case did not.

## Session log (2026-09-22, later): output windows

Detail in IMPLEMENTATION_PLAN.md under "Output windows".

The first thing a show needs that the editor never had: a clean picture to
send somewhere. An output is a window rendering one camera at its own
resolution and its own shading — the projector can be Rendered with the
scene look on while you model in Wireframe — with nothing of the editor in
it. Record it, fullscreen it onto a detected projector, or let OBS capture
it. It keeps running while the editor is hidden.

The design constraint was to stay on the GPU: each window has its own
renderer drawing the one shared scene into a canvas in its own document,
and nothing crosses between windows. What that costs is a list of things in
the scene graph that are not simply "the scene" — the world's environment
map (black in a second context), the lamps, the baked-in wireframe, and a
dozen untagged editor glyphs — each swapped for the output's draw and put
back. An output costs about what the main view's draw does (~0.25 ms CPU
on the demo gallery).

Where to pick up: per-object FX in outputs; confirm splats render in a
second context; a kiosk path that reopens outputs without a click; per
output edge blend and warp (the projector keystone work, but on the whole
frame).

**The lesson: a second view on shared state is a promise to put everything
back.** The test that matters is not "does the output look right" but "is
the MAIN view byte-identical before and after the output drew".

---

# THE NEXT PHASE: planning a real show in a real room

Everything above was tooling. The next phase has a deadline and a room: a
student show, in the gallery whose scan now loads. The work is whatever
stands between "the scan is in" and "here is the plan, and here is what it
will look like".

## What is already true

- A scan loads, opens into a dollhouse view, and can be clicked through onto
  its own floor. Placement, all four Nearest snap targets and Poly Build
  resolve against it.
- Plinths and panels can be DRAWN in place at real sizes, and the scene can
  be scaled to a measurement so the metres mean metres.
- Projectors throw images, video, GIFs and cameras, are aimed by dragging the
  spot, and keystone onto a real surface. Flat projection shows the media as
  it will look in a blacked-out room.
- Characters walk the space, so scale and sightlines can be checked with a
  body rather than by eye.

## What the next phase needs, in order

1. **PACK A SCENE WITH ITS FILES.** A saved scene carries `store:`
   references, and the files live in this browser's IndexedDB. The scan, the
   videos and the images do not travel with the .json — so a plan cannot be
   sent to a collaborator, opened on the gallery's laptop, or archived. This
   is the first thing that will hurt, and it blocks every collaboration.
   (Shape: a .zip of the scene plus `files/<hash>/<name>`, exactly as the
   Library export already does.)
2. **A SHOW IS A LIST OF WORKS, not a pile of objects.** A plan needs to say
   "Ana's video, 2.4 x 1.35 m, projected on the north wall, 4.1 m throw" and
   print it. The data is all there (objects, measurements, projector throw);
   what is missing is the notion of a WORK — a named entry with an artist, a
   medium, dimensions and a place — and a way to get it out as a sheet.
3. **SIGHTLINES AND WALKTHROUGH.** Possession already walks the room. What is
   missing is the question a curator asks: from where can you see this piece,
   and what do you see behind it? A camera bookmark per viewpoint plus the
   existing render-to-Library is most of the answer.
4. **MULTIPLE PROJECTORS ON ONE SURFACE.** Edge blending exists per
   projector; two projectors overlapping on one wall need their blend
   regions to be derived from the overlap rather than typed. The throw
   readout and the keystone corners give the geometry to do it.
5. **LIGHTING AS A PLAN.** A room's lighting is a list of fixtures with
   positions, angles and gels. The gizmo now shapes them; a schedule that
   can be handed to whoever hangs them is the missing half.
6. **PERFORMANCE WITH A SCAN IN THE SCENE.** 162k triangles is one room.
   Measure before optimising, with the overlay: the known costs are the
   silhouette pass on a large selection (scissored, but a selected scan is
   the whole frame) and the per-frame GP rebuild, which a scan does not
   touch but a drawing over it does.

## Traps the next phase will hit

- **A scan is a MODEL, and a MODEL's geometry only exists in the render
  tree.** Anything that needs its triangles (physics colliders, export,
  bake) goes through `MeshManager.collisionMesh`. There is no vertex data in
  `GPScene` to reach for.
- **The dollhouse view depends on the scan's own normals.** A scan exported
  without inward normals will look solid from outside and single-sided from
  inside; the fix is in the exporter, or Two-sided on the object.
- **POLY meshes have no facing test.** Raycasts honour `material.side` for
  meshes and imports, but a scan CONVERTED to an editable mesh picks its
  elements from the data, which knows nothing about culling.
- **Physics and scans do not mix by default.** A MODEL's collider is a hull
  unless told otherwise, and a hull of a room is a solid block. Use TRIMESH
  for the room, and remember a trimesh is a surface, not a solid: a dynamic
  body built from one falls through it.
- **Scenes are portable within this browser only** until (1) is done. Do not
  plan a rehearsal on another machine before then.


---

# TURNING TO GAUSSIAN SPLATS: where that work starts

The next stretch of work is splats. What follows is the ground, so it does
not have to be re-derived.

## What exists

- **`src/splats/` is the only place Spark lives.** `spark.ts` is the sole
  importer of `@sparkjsdev/spark`; `index.ts` is a lazy FACADE that
  dynamic-imports it the first time a scene actually contains a splat.
  That is not tidiness — Spark is ~4.9 MB, about 80% of the production
  bundle, and it cuts first load from ~2.0 MB gzipped to ~0.33 MB for
  everyone who is only drawing. **Nothing outside `index.ts` may import
  `spark.ts` statically**, or that saving is silently undone.
- A splat is an ordinary scene object (`TGSplat`, `ObjKind` 'SPLAT'): it has
  a transform, a parent, selection, the outliner row, the Library, drop-to-
  place, and it wears the render silhouette when selected.
- It is a DRAW TARGET, so Placement: Surface, the magnet and the new Nearest
  targets already land on one.
- `SplatMesh` is a `THREE.Object3D` and renders alongside the stroke meshes,
  so strokes and splats occlude each other correctly.
- Reading the actual gaussians is possible but ONE-WAY today:
  `packedSplats.forEachSplat(...)` is walked for PLY export and for the
  centres-only bounding box. Nothing constructs or edits splats in memory.

## The traps already paid for

- **Spark draws EVERY splat through one `SparkRenderer`**, which is a
  SIBLING of the splat meshes rather than an ancestor. Anything that
  isolates objects by visibility (the selection silhouette, thumbnails,
  render-to-Library) must leave that renderer ON or nothing draws.
- **A `SplatMesh`'s own geometry is one instanced quad**, so
  `Box3.setFromObject` gives a tiny box at the origin whatever the cloud
  looks like. Ask Spark: `getBoundingBox(true)`.
- A capture's FLOATERS reach metres past the room, so framing anything to
  its full extent shows the room as a speck. `splatCore` (5th-95th
  percentile of centres) is what thumbnails and framing use; `splatReach`
  (full extent, gaussians included) is what the selection scissor needs.
- `.ply` is two formats under one name — the HEADER decides (`f_dc_0`,
  `scale_0`, `rot_0` mean splat, not mesh).

## The open question

**N8 splat nibs** — painting WITH splats — is the standing roadmap item, and
its prerequisite (the texture atlas) is done. What remains is a research
spike: Spark offers no documented in-memory construction path, and the
existing code only ever READS through `forEachSplat`. Before designing a
brush, find out whether a `PackedSplats` can be built or appended to at
runtime, and what it costs to re-upload when it changes. If it cannot, the
honest fallback is to author splats in our own buffer and hand Spark a
freshly built mesh per stroke, which changes the performance conversation
entirely.

Second question, and the one the gallery work makes urgent: **a scan is
currently either a mesh or a splat, and the show wants both** — the mesh for
snapping and collision, the splat for how the room actually looks. Whether
that is two objects with a shared transform, or one object with two
representations, is a data-model decision worth making deliberately rather
than by accident.
