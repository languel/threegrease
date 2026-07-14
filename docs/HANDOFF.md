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
