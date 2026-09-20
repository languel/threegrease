# threegrease — agent/contributor guide

> Branded in the UI as **3𝜻**; threegrease stays the working project/repo
> name until it's ready to formally rename.

> **`docs/INSTALLATION.md` is the north star** — the interactive-installation
> use case this project exists for, what's built, and what's missing.
>
> **Start here, then read `docs/HANDOFF.md` (full technical handoff),
> `docs/PRD.md` (product vision & requirements), and
> `docs/IMPLEMENTATION_PLAN.md` (phased build plan with acceptance tests).
> Those three documents are the authoritative brief for all future work.**

Blender Grease Pencil reimplemented in three.js + TypeScript (Vite, no
framework), evolving into an interactive action-painting lab for live
performance. **PLAN.md** is the feature checklist + roadmap; **README.md**
is user-facing. Keep both updated when you add features.

## Commands

```bash
npm run dev          # dev server on port 5199 (see .claude/launch.json)
npm run typecheck    # tsc --noEmit — run before committing
npm run build        # typecheck + vite build
```

```bash
cd agent && npm install && node relay.js   # MCP/ACP bridge (docs/AGENT.md)
node agent/selftest.js                     # end-to-end agent bridge check
```

No test suite. Verification is done in the browser (see "Testing" below).

## Architecture (data-driven, one directional flow)

```
GPScene (plain JSON, src/core/types.ts)
  └─ objects → layers → frames (keyframes) → strokes → points
  └─ cameras[], canvases[], cursor, frame range
        │  tools mutate this data (never meshes) + push undo snapshots
        ▼
GPSceneRenderer.update()  (src/render/GPSceneRenderer.ts)
  – full rebuild of three.js meshes whenever markDirty() was called
  – per layer: evaluate modifier stack → build stroke ribbon geometry
    + earcut fill geometry → meshes with blend/stencil settings
        ▼
three.js render + per-object screen-space effects (src/fx/effects.ts)
```

Key invariants:
- **Everything user-visible lives in `GPScene`** and is JSON-serializable
  (`src/io/serialize.ts` — bump legacy migrations there, pattern:
  `scene.newField ??= default`).
- **Tools never touch meshes.** They mutate `GPScene` via `ctx` (an `AppCtx`,
  see `src/tools/context.ts`) and call `ctx.requestRender()` (= markDirty).
- **Undo is snapshot-based**: call `ctx.pushUndo()` BEFORE mutating.
- Rendering is a full rebuild per dirty frame — fine at sketch scale;
  incremental rebuilds are a planned perf task, don't micro-optimize
  elsewhere first.

## Directory map

| Path | What lives there |
| --- | --- |
| `src/core/` | data model (`types.ts`), CRUD helpers (`gpdata.ts`), math (`mathutil.ts`), undo (`history.ts`) |
| `src/render/` | stroke shader (`materials.ts`), geometry builders (`geometry.ts`), scene sync (`GPSceneRenderer.ts`), environment/IBL (`world.ts`) |
| `src/modifiers/` | the 14 GP modifiers — pure functions `strokes → strokes` |
| `src/fx/` | 9 screen-space visual effects (ping-pong pass pipeline) |
| `src/tools/` | per-mode tools. `toolsys.ts` (Tool interface + manager), `projection.ts` (screen↔world, drawing planes, STROKE-placement depth snapping), `context.ts` (Settings + AppCtx) |
| `src/anim/` | playback (`player.ts`), stroke interpolation (`interpolate.ts`), camera eval/keys (`camera.ts`) |
| `src/app/` | `main.ts` (App class: three setup, input routing, render loop), `ui.ts` (ALL DOM panels), `nav.ts` (views/gizmo/fly/ortho), `keymap.ts` (rebindable shortcuts), `styles.css` |
| `src/tools/snapping.ts` | the ONE magnet, as a function — every precise-placement tool calls it (`snapWorldPoint`), including the 3D cursor |
| `src/actor/` | rigged characters — skeleton (`skeleton.ts`), physics/kinematics (`solver.ts`), auto-rigging (`rig.ts`) |
| `src/agent/` | LLM agent interface — `tools.ts` (the ONE tool registry), `providers.ts` (local + hosted), `session.ts` (agent loop), `rpc.ts` (WS JSON-RPC), `webmcp.ts` (browser-native agent), `panel.ts` (chat state). See `docs/AGENT.md` |
| `agent/` | Node bridges: `relay.js`, `mcp-server.js`, `acp-server.js`, `selftest.js` |

## UI conventions (for UI-focused work)

- The whole UI is hand-rolled DOM in `src/app/ui.ts` — no framework. Helpers:
  `el()`, `btn()`, `slider()`, `numField()`, `checkbox()`, `colorField()`,
  `selectField()`, `panel()`.
- Panels are **rebuilt from scratch** on `UI.refresh()` (called via
  `ctx.refreshUI()`); don't keep references to DOM nodes across refreshes.
  The corollary that bites: a rebuilt scroll container is a NEW element, and
  a new element starts at `scrollTop` 0. Selecting an object triggers a
  refresh, so the outliner used to throw you back to the top the moment you
  clicked anything below the fold — and the row you had just clicked slid
  out from under the pointer. `UI.rememberScroll`/`restoreScroll` carry the
  offsets of `.sidebar-outliner` and `.props-content` across the rebuild;
  add any new scrollable region to `UI.SCROLLERS`. The one time the outliner
  SHOULD move is when the selection changed somewhere else — picking in the
  viewport used to leave the list wherever it was, which tells you nothing in
  a scene of sixty objects. `revealSelectedRow` scrolls to it only when the
  selection key actually changed AND the row is off screen; anything more
  eager is the original bug (the list moving out from under someone reading
  it) wearing a different hat. Frame-selection asks for it explicitly.
- **The top bar is laid out like Blender's 3D-view header**: the TOOL's
  settings on the left (brush, size, select mode…), WHERE THINGS LAND in the
  centre (`UI.placementCluster`: Placement, Plane, Guide, then the magnet),
  the VIEW on the right (shading); two `.grow` spacers keep the centre
  centred. Placement/Plane/Guide are global in Object, Draw and Edit mode
  because they decide where every placed OR MOVED point resolves — Edit
  mode's G unprojects both pointer positions through `screenToWorld` — and
  they used to be hidden in Edit mode while moving its points. The
  per-placement refinements (Lock, Smooth, Offset, Target, shape snapping)
  are a section at the foot of the Placement menu, and an orange dot on its
  bar icon says when any of them is away from its default: a hidden setting
  that is quietly ON is the worst kind.
  Placement, Plane, Guide and the magnet's Snap Target are ICON dropdowns
  (`UI.iconMenu`): the bar shows only the current choice's glyph (every
  choice has its own, in `icons.ts`), its name is the tooltip, and opening it
  lists every choice with icon AND name, the current one lit, with any
  further settings as sections below — Blender's transform header. Menus are
  centred under their button and then nudged back inside the window, since
  near either end of the bar (or on a wrapped second row) they ran off it.
  Top-bar fields are labelled by an ICON, the word moved into the tooltip
  (`tbField`: Brush, Size, Strength, Radius, Weight, Eraser, Select); a
  colour swatch needs no label at all. On/off settings are ONE icon button,
  lit when on (`iconToggle`: the magnet, Proportional, Multiframe) — a
  checkbox beside an icon said the same thing twice and read as two
  controls.
- **Opt+, . / ' open PIE menus** for Placement, Plane, Guide and Snap at
  the pointer (`UI.openTransformPie`; actions `placementPie`, `planePie`,
  `guidePie`, `snapPie`). Their choices come from the same
  `placementChoices`/`planeChoices`/`guideChoices`/`snapChoices` the top-bar
  dropdowns read, so the two cannot drift. Number keys pick by position; the
  Snap pie's centre toggles the magnet and picking a target turns it on.
  `comboFromEvent` recovers these keys from `e.code` — under Option a Mac
  reports `≤ ≥ ÷ æ` as `e.key`.
- **A checkbox's NAME goes in the label column and the box in the value
  column**, like every other row. It used to carry its own text, which put it
  the other way round — box first, name second, both adrift in the value
  column — so one row in three read backwards against the rest with no shared
  edge to scan down. `checkbox()` builds a normal `fieldRow` now and wires the
  name to toggle by hand (it is a span, not a `<label for>`).
- **`el.hidden` does nothing when a class sets a `display`.** The UA rule
  `[hidden] { display: none }` loses to any class rule with its own display,
  so `.actor-log { display: flex }` kept the monologue on screen while the
  attribute said otherwise. Every such class needs its own
  `.thing[hidden] { display: none }`.
- **Explanations hang off controls, never underneath them.** A paragraph in
  a panel is read once and then re-read every time you come back for the
  control it explains, and it pushes the actual settings off screen.
  `panelHint(...)` puts a panel's one-line summary on its header as a
  tooltip; `tip(node, text)` does the same for a single field (it also sets
  the title on the inner `select`/`input`, since that is what the pointer is
  usually over). Keep option labels to the NAME of the thing — "Kinematic",
  not "Kinematic (you move it)" — and put the explanation in the tip. Status
  and empty-state rows ("no clips yet", a vertex count) are not narrative and
  stay where they are.
- **Nothing may rebuild the panels while a value is being scrubbed.** Panels
  are rebuilt from scratch, so a refresh mid-drag replaces the very element
  that captured the pointer: the gesture then has nothing left to drag, and
  the detached widget keeps scrubbing its own dead copy. It reads as a slider
  that stutters, halts, or jumps to an end stop — nothing like "a rebuild
  happened". `UI.refresh()` therefore DEFERS while `numDragActive` (or while
  a numdrag type-in field is open) and runs once when the gesture ends. Fix
  the caller too where you can: `WorldManager.onChange` is wired to a full
  sidebar rebuild and was firing on every sky change, so it now fires only on
  a STATUS transition (loading -> ok, or an error), which is the only thing
  the panel actually has to learn about.
- The UI talks to the app only through the `AppHandle` interface (top of
  `ui.ts`) — add methods there, implement on `App` in `main.ts`.
- New keyboard shortcuts: add an `ActionDef` to `ACTIONS` in
  `src/app/keymap.ts` and a case in `App.runAction()` — that's it, the
  settings dialog and persistence pick it up automatically. Don't hardcode
  key checks in `onKey`.
- New user preference: add to `Settings` in `src/tools/context.ts` (+ default
  in `defaultSettings()`), expose in the settings dialog (`UI.openSettings`)
  or topbar.
- CSS variables for theming are at the top of `styles.css`.

## Testing / verifying changes

`window.__tg` is the App instance (set in `main.ts`) — drive the app from
the browser console or automated evals:
- Synthetic pointer events on `#gl` canvas draw strokes (use
  `pointerType: 'pen'`, `pointerId`, `isPrimary`). Note: pass real
  `getCoalescedEvents`-less events; the app falls back correctly.
- `__tg.ctx.scene` is the whole document; `__tg.ctx.settings` the prefs.
- Dev-server module URLs are importable in evals:
  `await import('/src/tools/editops.ts')`.

## Performance

- **The perf overlay** (View ▸ Performance overlay, Ctrl+Alt+F, pref
  `showPerf`; `app/perf.ts`) is the first thing to open when something is
  slow. The frame loop marks LAPS between its phases (`perf.lap('render')`),
  so it says WHERE a frame went: per-phase averages and maxima over the last
  second, the rAF-to-rAF interval against the loop's own CPU time (a large
  gap is flagged — the time is going to the GPU, an event handler, layout or
  a long task, not the loop), draw calls / triangles summed over EVERY pass
  (`renderer.info.autoReset` is off and reset per frame, or only the last
  pass would count), textures, geometries, programs, JS heap, long tasks, and
  counters (`perf.count`) — UI rebuilds per second and their ms. When adding
  a phase to the loop, give it a lap.
- **Render resolution** (`settings.renderScale`, View menu): the GL buffer is
  devicePixelRatio x scale and stretched to the canvas; the HUD stays at full
  resolution. On retina, 100% is four pixels per point and the look's post
  passes pay for all of them.
- **A live camera is copied only when it has a NEW frame**
  (`requestVideoFrameCallback` sets `fresh`). Copying every animation frame
  was what took the app to 1-2 fps with a camera open: a 30 fps camera was
  re-uploaded as a 720p texture 60x a second, and its frame counter ticked at
  the display rate, so capture ran MediaPipe on every display frame of an
  unchanged picture (measured 8.3 ms/frame for pose alone at 1280x720).
- **Capture detects on a snapshot at most 640 wide, ONE detector per display
  frame** (`MMCapture.round`): a new round starts only when the last is done,
  on the newest frame, and pose / hands / face each take a frame of it. Back
  to back they put ~30 ms into one frame; spread, the worst frame carries
  one (~10-13 ms). The landmark models resize to 256 px internally, and
  landmarks are normalised, so the smaller snapshot changes nothing
  downstream. MediaPipe still runs on the main thread — moving it into a
  worker is the next step (tasks-vision's loader uses importScripts, which a
  Vite module worker does not have, so it needs a classic worker build).
- Measured baselines (preview pane, retina): empty scene 1 ms/frame of loop;
  demo gallery (three actors, ~60 objects) 2.6 ms; 24 MB scan + live plane
  1.2 ms; all three landmark detectors on a camera 7 ms average.

## Gotchas (learned the hard way)

- `THREE.ShapeUtils.triangulateShape` **mutates its input** (pops a
  duplicated end point). Iterate `proj.length`, not the source array.
- Stroke-placement depth sampling must exclude the in-progress stroke
  (`setStrokeExclusion` in `projection.ts`) and snaps to ONE stroke at a
  time with sticky depth mid-draw — don't reintroduce cross-stroke
  averaging (causes depth drift).
- The world-up convention is a **setting** (`settings.upAxis`, default 'Z'
  = Blender-style Z-up RH; 'Y' = three.js). All navigation math works in a
  Y-up reference frame transformed by `Navigation.frameQuat()`; drawing
  planes/views/grid/canvas orientation switch on it. OrbitControls caches
  its up-frame at construction, so `App.applyUpAxis()` RECREATES the
  controls — route any up-axis change through it.
- Preferences persist via `loadPrefs`/`savePrefs` in `tools/context.ts`
  (localStorage `threegrease.prefs`); add new pref fields to `PREF_FIELDS`.
- Digit keys are view keys while `settings.emulateNumpad` is on (mode
  shortcuts shadowed — that's intentional, like Blender).
- `ctx.camera` is reassigned every frame (`nav.active`, persp OR ortho) —
  always read it fresh, never cache.
- Uncaught exceptions in the render loop kill the rAF chain; `gp.update`
  is wrapped in try/catch — keep it that way.
- Vite hot-reload wipes app state; browser-eval tests should
  `location.reload()` first if files changed mid-session. Also NEVER
  `import('/node_modules/...')` in an eval — vite re-optimizes deps and
  silently reloads the page mid-test (state loss looks like a heisenbug).
- **In an eval, reach module singletons through `window.__tg.sys`, never
  through `import()`.** After ANY file is edited in a session vite serves
  modules at `?t=<stamp>` URLs, so `await import('/src/mm/streams.ts')`
  returns a SECOND instance of the module with its OWN `streamStore` /
  `actorSolver` / etc. Writes into it are invisible to the running app and
  nothing throws — the feature under test just silently does nothing.
  `App.sys` re-exports the app's own instances for exactly this.
- Fly mode (Blender semantics): `~` starts, Enter/click accepts, Esc
  teleports back to the start pose. Pointer lock swallows the Esc keydown,
  so cancel is detected via `pointerlockchange` + the `flyStopping` flag in
  `nav.ts` — don't remove that flag.
  **`requestPointerLock()` CAN FAIL, and it fails SILENTLY.** Chrome refuses
  it when the document is not focused and enforces a cooldown after an
  Esc-driven exit ("requested too soon after exiting"); a refusal fires
  `pointerlockerror` and NOT `pointerlockchange`, so nothing downstream ever
  learns. What you get is fly mode WITHOUT the lock, which reads as a
  completely different bug: the mouse is free to wander off the window (the
  giveaway — a locked pointer cannot), and every scroll is eaten by the
  fly-speed ratchet instead of zooming. `flySpeed` is a
  PERSISTENT scalar with no other display and nothing else that writes it,
  so one trackpad flick (25 ticks, x0.85 each) takes it from 3 m/s to its
  0.1 floor — 3% of normal — and leaves it there for the rest of the
  session. The symptom is "WASD suddenly barely moves and only a reload
  fixes it". So the lock request is checked (promise rejection AND
  `pointerlockerror`), and the wheel SAYS the speed through
  `Navigation.onNotice` — an invisible number a stray gesture can ratchet is
  a number that will read as a broken app.
  **A refusal must NOT refuse to fly.** Making the lock a precondition is
  the obvious next move and it is wrong: mouse-look reads `movementX/Y`,
  which a free cursor still reports, so fly mode WORKS without a lock and
  always did — an embedded or previewing browser may never grant one, and
  blocking the mode there trades a subtle bug for no flying at all. A
  refused lock just says so ("the cursor stays visible") and flies.
  `lockHeld` is what keeps the Esc semantics honest across that: losing a
  lock we ACTUALLY HELD is the user cancelling and teleports back, while a
  flight that never had one must not be cancelled by someone else's lock
  ending. Verified with no lock at all: W moves at the full 3 m/s, release
  stops dead, Enter exits, and a held lock lost mid-flight teleports back to
  0.000 m from the start.
  **A blurred window never delivers KEYUP**, so a key held while the mouse
  leaves stays held forever. A stuck `w` is not "the camera runs away" — it
  silently cancels every `s` you press and movement reads as DEAD, which is
  the same symptom wearing a different hat. `blur` clears `flyKeys` — and
  only that: ending the flight there races the lock's own async grant and
  kills the mode on the way in.

- **Plane: Up from Ground (`UPRIGHT`) is floor-plan-then-walls.** Its resting
  plane is the FLOOR at height zero (not a plane through the active object),
  so a stroke's first point lands on the grid — or on whatever the Placement
  snaps it to — and the rest of the stroke lives on the VERTICAL plane
  through that point, captured once per stroke through the same sticky slot
  VIEW_ORIGIN uses. The normal is the view direction with its up component
  REMOVED: View at Origin faces the camera outright, so from any raised
  viewpoint its plane leans back (22.8 degrees at a normal working angle)
  and a line drawn up from the floor goes up and away. Verified: first point
  exactly (1,1,0), every point 0.00000 off the vertical plane. Pair it with
  Placement NEAREST to start a lift on an existing plan line (lands at
  z = 0); STROKE is a poor fit — it returns a point at a stroke's DEPTH, not
  on the stroke, and measured 8 cm under the floor.
- **A SHAPE snaps at the points you PLACE, not at every sample**
  (`settings.shapeSnap`, default `ENDS`; `PrimitiveTool.shapeFromEnds`).
  Line, polyline, box, arc, curve and circle used to resolve each of their
  samples through the Placement independently, so under a target-seeking
  placement (Stroke, Surface, Splat, Nearest) a line dragged between two
  wall tops snapped its MIDDLE onto whatever stroke lay behind it on screen
  — measured: one sample of nine jumped 5 m back to a far wall. Now only
  the placed points resolve; straight edges are a world lerp between them
  (the exact 3D line, and it still projects to the line you dragged), and a
  curve's interior is cast at a depth running smoothly from one end's to the
  other's. Same test: all nine points 0.000 m off the straight edge. A box's
  two corners you did not place sit at the mean depth of the two you did; a
  circle, having no placed point on it, lies flat at the start corner's
  depth. Sticky-plane modes (View at Origin, Up from Ground, the two ⊥
  placements) and Origin/Cursor cannot hop between targets, so their
  interiors still resolve normally. `EVERY` keeps the old draping on
  purpose — a line that clings to what it crosses is an effect worth having,
  just not the default.
  A PLACED point under Placement: Stroke lands ON the stroke it is near
  (`strokeAnchorPoint`, within 28 px), not merely at that stroke's depth
  along the pointer's own ray — which is what left a visible gap whenever a
  line was released a few pixels short of a wall edge. The tie-break is the
  judgement: screen distance alone picks whichever line passes closest,
  and in a wireframe the strokes BEHIND your target peek out beside it
  (measured: an end released 15 px short of a near wall landed on a stroke
  5 m behind). So every stroke in range offers its best point and, among
  those within 10 px of the closest, the one nearest the CAMERA wins —
  precise aim still reaches a far stroke. Cmd/Ctrl held as a point is
  placed opts that point out; the choice is frozen per anchor, and the
  release REBUILDS the shape so the modifier at release is the one that
  counts. The PENCIL does the same for its first and last points
  (`DrawTool.anchor`): its body keeps Stroke placement's per-sample depth,
  but its ends land ON the strokes they start and stop near — pinned again
  AFTER smoothing and simplifying, which would pull them back off, and with
  the sticky plane re-seated through an anchored start
  (`reseatStickyPlane`) so the rest of the mark does not kink away from it.
  Verified: released 12 and 15 px short, both ends landed exactly on the
  lines; Cmd at release left the end where it was.
  **Strokes can be restyled after drawing** (Stroke Style panel, Edit mode):
  every stroke already carries its own brush record — `lineWidth`,
  `hardness`, `style` — so this edits that record on all selected strokes
  at once: a preset, "Match current brush", or single fields. Switching unit
  keeps the apparent width on the brush convention (30 px == 0.3 m). Edits
  within 800 ms share one undo step, so a scrub is one undo, not hundreds.
  Ortho trap in the depth helper: an ortho ray starts
  on the NEAR PLANE, not at the camera, so depth must be measured from the
  same point on both sides or every point lands short by the near distance.
- Agent tools (`src/agent/tools.ts`) are the SINGLE registry behind the
  in-app chat, MCP, ACP and WebMCP — adding one there exposes it to Claude
  Code, Zed and the browser's own agent with no Node-side change.
  WebMCP (`src/agent/webmcp.ts`) registers the same tools with
  `document.modelContext` (the spec's entry point, and what Chrome's origin
  trial ships — earlier prototypes used `navigator`, so it feature-detects
  both). Unregistration is by aborting the AbortSignal passed to
  registerTool; there is no unregisterTool. Tool names must match
  `[A-Za-z0-9_.-]{1,128}` or registration throws and takes the batch with
  it. It is opt-in per session, never automatic — these tools mutate the
  user's document. `mutates: true` gets pushUndo +
  requestRender from the dispatcher; never open-code either in a handler.
  Image tool results must NOT be stringified into a tool message (~500KB
  of base64 breaks chat templates) — the session converts them to a real
  image part instead.
- **Stroke shader attribute budget is full.** WebGL guarantees only 16
  vertex attributes and the stroke shader is the entire per-stroke
  parameter channel (a layer's strokes share one merged buffer and one
  material). Scalars are PACKED — `aMisc` = (kind, hardness, unit, seed),
  arc rides in `aCorner.z`. Exceeding the limit does NOT throw: the
  program silently fails to link ("Too many attributes") and nothing
  draws at all while the geometry looks perfect. Pack, don't add.
- LINE strokes render as ONE miter-joined triangle strip, not per-segment
  quads plus a disc per point. The old topology overlapped itself
  everywhere, and since strokes are translucent every overlap composited
  again and joins showed as bright beads. Don't reintroduce per-point
  discs in LINE mode; the miter is clamped at 1.5x because an unbounded
  one fires visible spikes off sharp corners.
- A pointer with no pressure sensor reports `pressure` **exactly 0.5**
  (Pointer Events spec) — that means "no data", not "half". Treating it
  as real halved every mouse stroke's width and opacity. Only `pen`
  carries real pressure (`App.toolEvent`).
- Canvas planes are RETIRED: serialize.ts migrates them to PLANE mesh
  objects on load (ids preserved; attachments/routes rewritten). The
  canvas code paths remain but always see an empty list — don't build new
  features on `scene.canvases`; use TGMesh with material fields (texture/
  unlit/doubleSided/billboard) instead.
- **Quad view routes input per PANE by impersonation** (`App.withPane`).
  Tools read the pointer against `ctx.canvas.getBoundingClientRect()` and
  unproject through `ctx.camera` in ~60 places; in quad view both were the
  whole canvas and the perspective camera whichever pane you touched, so a
  mark landed where the pointer would be if the persp view filled the window.
  For the length of one event, `ctx.camera` becomes the pane's camera and
  `ctx.canvas` a Proxy whose bounding rect IS the pane. The pane is chosen at
  pointerdown and kept for the whole gesture (hover follows the pointer).
  Two traps: `resize()` early-outs on an unchanged size, so toggling quad view
  must reset `this.sized` or the pane rects are never computed; and an ortho
  pane camera's matrixWorld is only updated by the quad render, so
  `withPane` updates it itself (a click before the first frame unprojected
  through identity and put the point at infinity).
  `tools.lastPointer` is PANE-relative after that, so everything that reads
  it back — the plane and depth helpers, the placement preview, a tool's
  HUD — goes through `withPane(this.pointerPane)` (`paneHud` for the 2D
  part: translated and clipped to the pane), or it lands where the pointer
  would be in the full-size view.
  Everything else that reads the pointer goes through the pane too: the
  G/R/S modals (begun through `pointerPane`, which stays frozen while one
  runs, and updated through it), their axis keys and radius wheel, Shift+RMB
  cursor placement, object picking, and the `hud._pointer` the brush circles
  read — that one was set from the raw event, so in a side pane the circle
  drew offset from the pointer and the brush seemed not to follow it. The
  mode pie is placed in the PAGE, so it takes `canvasPointer()` (the
  pane-relative pointer added back to the pane's corner).
  LEAVING quad view with the pointer over an ortho pane makes that view the
  single view (`Navigation.adoptOrthoView`, Maya's rule): its direction,
  framing and target, but at the current orbit distance — a pane camera sits
  hundreds of units out, which as an orbit distance would make every later
  orbit swing wildly. `hoverPane` is cleared on pointerleave, so toggling
  from the menu bar keeps the perspective view.
  Measurements are drawn in EVERY pane (`eachPaneHud`) — they are scene
  objects that happen to be drawn on the HUD, so a quad view must show them
  through all four cameras, draft included.
- **The magnet applies to DRAWING** (`magnetPoint` in `tools/snapping.ts`).
  It used to reach only the 3D cursor, the transform tools and the ruler, so
  a line drawn with Grid snap on landed wherever the pointer was. Now every
  PLACED point of a shape (line/polyline ends, box corners, arc/curve ends)
  and the pen's first and last points go through it after the Placement has
  resolved them; Cmd opts a point out of both. A lattice snap ROUNDS the
  resolved point rather than re-resolving it, so it composes with any
  Placement; a vertex/edge/face snap replaces it. Freehand samples between
  the ends are not snapped (a staircase is not a stroke).
  THE LATTICE LIVES IN THE PLANE the point is going on (`snapToLattice`): it
  used to raycast the floor whatever the Plane said, so a Top plane through
  an object 1 m up snapped down to z = 0. An axis-aligned plane rounds its
  two in-plane world coordinates; a tilted one (Up from Ground's wall) rounds
  in its own up/across basis counted from the sticky SEED, so a lift stays
  exactly above its snapped floor point. A stroke's FIRST point snaps on the
  RESTING plane (the floor), because its own resolution has already captured
  the wall. And a shape's first point is resolved ONCE per shape
  (`PrimitiveTool.firstWorld`): re-resolving it each rebuild went through the
  wall it had itself just raised and crept 4 cm up it.
  Plane: NONE has no plane of its own — Placement, magnet and guide decide,
  an uncaught point faces the camera (as View does), and the grid rounds all
  three coordinates.
- **Edit mode on a MESH is a vertex / edge / face editor** (`tools/meshedit.ts`,
  ops in `core/polyedit.ts`). Entering Edit with a poly mesh selected opens
  it; with a PRIMITIVE selected (box, sphere, cylinder, the platonics) the
  primitive is CONVERTED in place to a TGPolyMesh first (`render/polyconvert.ts`,
  one undo step back) — name, transform, material, parent and constraints
  carried over, and every `{ kind: 'MESH', id }` reference in the scene
  re-pointed to the new `{ kind: 'POLY', id }`. The conversion welds three's
  triangle soup (vertex keys rounded with -0 folded into 0, or seams stay
  split) and merges each EXACTLY coplanar edge-connected region into one
  n-gon, so the topology is Blender's: box 6 quads, cylinder 24 quads + two
  24-gon caps, dodecahedron 12 pentagons, UV sphere 704 quads + 64 pole
  triangles. A loose coplanarity test (0.9999) folded the pole fans into
  bent quads; it is 1e-6 and a matching plane offset now.
  - Selection is kept consistent across the three kinds by
    `flushSelection(pm, mode)` after EVERY change, because the transform only
    reads vertices: edge/face picks select their vertices; in vertex mode an
    edge is selected when both ends are. Switching mode flushes from vertices
    first, then from the new mode's elements.
  - G / R / S go through the SAME `ModalTransform` the stroke editor uses:
    `beginMesh` gives it the mesh's local->world matrix and an onChange that
    bumps `rev` (a poly mesh only redraws on a rev change). For a mesh the
    axis locks are WORLD axes (Blender's default for G) — a stood-up
    cylinder's local Z points sideways. Shift+X/Y/Z locks to the plane in
    both editors now.
  - E extrudes by mode and starts a grab; ONE undo step (the extrude pushes,
    the grab is begun with `undo: false`). A face region extrude KEEPS the
    original faces, turned over, so a floor becomes a closed block —
    Blender leaves that hole open.
  - The top bar carries Blender's two rows: Vertex / Edge / Face (a cube
    with that element filled in) and the five box-select operations
    (`settings.selectOp`: Set, Extend, Subtract, Difference, Intersect —
    two squares with the result region filled). Shift / Ctrl still force
    Extend / Subtract for one drag. Icons can carry a FILLED region now
    (`FILLS` in icons.ts, evenodd to punch out an overlap) — the outline-only
    set could not draw "which part is selected".
  - SEPARATE (P, or the right-click menu, which on a mesh is now a MESH
    menu — it used to be the stroke editor's and did nothing to the mesh):
    `separatePoly` splits the selection, or every edge-connected piece, into
    NEW TGPolyMeshes with the source's transform, look and element ids. A
    vertex on the border between a leaving and a staying face is DUPLICATED
    (Blender does too), so both halves stay whole; an edge or vertex leaves
    the source only if nothing that stays still uses it. Strokes separate by
    Selection, By Material (`separateByMaterial`: one object per material
    slot used, across every layer and keyframe, named after the material)
    or By Loose Parts (the existing `separateConnectedIntoObjects`).
  - Faces have no colour channel in the overlay, so a selected face is
    filled on the HUD by the tool.
  - `App.meshEditId` (not the overlay target, which follows the TOOL) says
    Edit is on a mesh, so picking Measure mid-edit keeps the mesh toolbar.
- Outliner rows carry ICONS, not words: a light's kind (and a projector's
  own glyph when it throws a picture) rather than the words "ambient",
  "sun", "spot", which read as labels instead of a column you can scan. The
  GP export button is gone from the row — it is on the right-click menu.
- **Sculpt is an Edit-mode tool**, not a mode: its brushes are in the Edit
  toolbar and the top bar shows them when it is active. The SCULPT mode
  still exists in the type for old scenes; the mode button and pie slot are
  gone, and the `modeSculpt` action opens Edit with the tool.
- **Poly Build drags take G's axis locks** (`PolyPenTool.axisLock`): X / Y /
  Z mid-drag locks a vertex move, a vertex extrude, an edge/face move or a
  boundary extrusion to that WORLD axis, Shift+ to the plane square to it,
  the same key again frees it; drawn as a coloured axis line with a label.
  Under Plane: Up from Ground an edge or face drag STARTS locked to the up
  axis — lifting a plan into walls is what that plane is for. The axis
  point is the skew-line solve against the pointer ray (not a plane hit),
  and grid rounding is done along the lock in WORLD space, so on a rotated
  mesh the components across the lock stay exactly zero. Tool keys are
  dispatched through `withPane`, since a lock re-runs the drag. Verified: an
  edge lifted under Up from Ground and one locked with Z both kept x and y
  exactly; Shift+Z kept z at 0.
- **A box on a PLANE is a rectangle IN that plane**, edges along the plane's
  own axes (up-in-plane and across; X and Y on the floor), not the screen
  rectangle cast onto it — under perspective that is a trapezoid, and on Up
  from Ground's wall it came out a parallelogram. Verified: corners square to
  0.00000, bottom edge on the floor. Target-seeking placements keep the old
  screen-built box.
- **Placement: Nearest has a Target** (`settings.nearestTarget`,
  `pickElement` in `polypick.ts`): Element (the old priority chain), Vertex
  (poly vertex, stroke point, splat centre, or the corner of the mesh
  triangle under the pointer), Edge (poly edge, anywhere along a stroke, the
  nearest side of that triangle), Face (poly face, mesh surface). Mesh
  "edges" are the renderer's triangles, so a box face's diagonal counts.
- **A CAMERA is an object** (`ObjKind` `'CAMERA'`), not just an entry in
  `scene.cameras`. It gained an `id` (serialize.ts assigns them to old
  scenes and rewrites `score.attachments` from index to id), plus
  `select`/`lock`/`parent`/`constraints`, so the outliner row, selection,
  the transform widget, G/R/S, parenting, grouping and delete all come from
  the same machinery every other kind uses — `getObjectTransform` reports
  unit scale (a camera has none) and `deleteObject` refuses the LAST camera.
  Two things a camera cannot share: it is drawn as a WIRE frustum, so there
  is no surface to fatten into an inverted hull — it says it is selected by
  going the selection colour (`syncCameraHelpers`); and it has nothing to
  raycast, so `ObjectSelectTool.pick` tests screen distance to where it
  stands, the way the score glyphs are picked. Lights were in exactly the
  same position and are picked the same way now. Adding one leaves it
  SELECTED with the widget on it, because a camera added "at the current
  view" is otherwise invisible — it is exactly where your eye is.

- **The outliner has keyboard focus when the last pointerdown was in it**
  (`App.outlinerFocused`; rows are divs rebuilt on every refresh, so DOM
  focus cannot say). X, Delete and Cmd+Backspace then delete the SELECTED
  OBJECTS in any mode — in Draw or Edit mode X otherwise means "delete
  strokes", which is not what clicking a row in the object list asks for. A
  drawing mode that deletes its last pencil gets a fresh one.
- **A new pencil continues the last one** (`App.newPencil`): its material
  slots and active slot are copied from the GP object last active
  (`lastPencil`, held by reference so a deleted object still answers), not
  reset to the black-pen defaults.
- `setPointerCapture` is wrapped in `App.capture()` (throws on synthetic
  pointer ids) — use it, never call setPointerCapture directly.
- Object mode: unified selection over GP/canvas/splat/mesh/trigger
  objects lives in `src/tools/objects.ts` (`ObjKind`, includes
  `'TRIGGER'`); the TransformControls widget applies DELTAS from a proxy
  at the pivot (see `App.applyWidgetDrag`). GP object-group transforms
  are re-applied every frame in the loop (the renderer only sets them on
  rebuild). Mesh objects need the scene lights.
- **Pointer listener order matters for hijacking a button/modifier
  combo**: `OrbitControls` registers its own `pointerdown` at
  construction, before `App.bindEvents` runs. A same-phase (bubble)
  listener added later CANNOT stop a control OrbitControls already
  claimed that pointer event for (e.g. RIGHT = PAN) — you must add a
  **capture-phase** listener with `stopImmediatePropagation()` to
  intercept it first. See the Shift+RMB cursor-drag handler in
  `main.ts` for the pattern.
- Object constraints (`src/score/constraints.ts`, `TGConstraint` on
  GP/mesh/splat/trigger) run in their own `ConstraintEngine.update()`
  pass AFTER `ScoreEngine.update()` in the frame loop — order matters
  because TRIGGER constraints test proximity against travelers gathered
  during that same pass (FOLLOW_PATH objects + legacy score cursors).
  Legacy `score.cursors`/`score.triggers` are a SEPARATE system that
  still runs in parallel; don't assume one implies the other.
- The scene **world** (`scene.world`, `src/render/world.ts`) funnels every
  mode — solid, gradient, equirect image, 360 video, physical sky — into
  ONE texture that drives both `scene.background` and, via PMREM,
  `scene.environment`. Viewport shading (`settings.shading`) is a VIEW
  pref, not scene data: Solid/Wireframe ignore the world and use a fixed
  studio light; only Material/Rendered show it. Four things here all fail
  as an entirely black viewport, meshes included, and none of them throw:
  - `PMREMGenerator` sizes its cube from `image.width / 4`, so a 2px-wide
    ramp yields a degenerate atlas that lights everything black. Keep the
    synthetic maps 256 wide even though the content doesn't need it.
  - A `<video>` element reports `width`/`height` **0** — the real size is
    `videoWidth`/`videoHeight`. PMREM on one gives a zero-height atlas →
    `CUBEUV_MAX_MIP = Infinity` → the fragment shader fails to LINK, and
    a failed link paints nothing while logging only to the console.
  - `scene.background` can't carry a MOVING equirect: three converts it to
    a cube once, caches it, and skips the conversion while `image.height`
    is 0. Video worlds use their own inside-out sphere instead — spin it
    about object Y (the pole), then re-frame about X for the up-axis;
    spinning about Z tips the pole onto the horizon.
  - three always puts an equirect's zenith at world **+Y**, so a Z-up
    scene needs the env re-framed. `backgroundRotation`/`environmentRotation`
    are Eulers three NEGATES and applies to the lookup direction, so the
    spin sign is inverted relative to the image.
  Also: `DataTexture` defaults `flipY:false`, so row 0 is v=0, which
  `equirectUv` maps to `dir.y = -1` — fill these maps NADIR-first or the
  sky renders upside down.
- **The viewport background is `scene.world.color` and nothing else.** There
  used to be a second copy as a view pref (`settings.background`, shown as
  Scene ▸ Background ▸ Color) — one value under two names, and they drifted:
  editing the World panel left the pref stale, and a HOLDOUT material paints
  whichever copy the renderer was handed, so a holdout stroke could punch a
  hole in the wrong colour. The world's own Color row is shown in EVERY mode
  now, because it is the background in every mode: the world itself in Solid,
  and what Solid/Wireframe shading and a hidden background fall back TO in the
  others. The auto grid colour reads it too.
- **`ctx.requestRender()` is a GP GEOMETRY rebuild, not "redraw the
  viewport".** With no layer id it sets `dirtyAll`, and the next frame
  re-evaluates every layer's modifier stack and rebuilds its stroke ribbons
  and earcut fills. The frame loop draws every frame regardless, so anything
  that is NOT stroke data — the world, a light, a material — needs no call at
  all. Two things this cost: the physical-sky sliders rebuilt the whole GP
  scene per pixel of a drag (which is what made them stutter and halt while
  the Lighting sliders stayed smooth), and `actorSolver.update` asked for one
  on EVERY frame an actor was moving, so a scene with a character in it was
  rebuilding all of its grease pencil sixty times a second forever. A GP
  object bound to a joint follows through its GROUP TRANSFORM, which the loop
  re-applies each frame — verified by binding one to `hand.L` and watching it
  track with zero rebuilds — so the pose has no claim on stroke geometry.
- **The physical sky is built ONCE and re-rendered, never rebuilt.** `Sky` is
  a ShaderMaterial: constructing one per slider tick means a program compile
  and a fresh cube target before the six face renders. `WorldManager.skyObj`
  and `skyRT` are kept, so a change costs one cube render; the IBL (the
  expensive half) is skipped entirely when `w.lighting` is off and throttled
  when it is on, with a PENDING flag so the last change of a drag still gets
  its lighting — without it the key already matches and nothing would ever
  rebuild. The cube is 1024 per face because 512 left the sun a visible
  staircase, and the sun's smoothstep is widened into a soft limb for the
  same reason. `sunDisc` scales that term to zero — the glow, the gradient
  and the IBL are unaffected, only the disc goes. `skyStylize` keeps the
  physical LUMINANCE and replaces the hue, mixing two tints by height: a flat
  pink wash is not a sky, but a pink sky with the gradient, the glow and the
  darkening overhead still reads as one.
- **Scene-level look is a SECOND fx axis** (`src/fx/scenefx.ts`,
  `scene.post`), distinct from `fx/effects.ts`, which isolates and composites
  ONE GP object. This one treats the finished frame as an image: bright-pass
  bloom, a two-colour duotone ramp, ink edges, grain and a vignette, driven
  by presets (`POST_PRESETS`) rather than by a pile of sliders — what someone
  wants is "a Turrell room" or "a line drawing", and the numbers that get
  there are a package. Editing any of them flips the preset to CUSTOM so the
  panel never claims to be a look it no longer is.
  - FOG IS NOT POST. It lives in `world.fog`/`world.fogColor` and becomes
    `scene.fog`, because fog has to be LIT — a depth haze applied after the
    fact cannot know a light is shining through it, and the Turrell look is
    mostly that. Post supplies the bloom and the palette on top.
  - EDGES come from DEPTH AND NORMALS, never from colour: a colour-difference
    detector misses the boundary between two objects of the same colour
    (most of a grey scene) and invents lines inside textures. That costs one
    extra render of the scene with a normal+depth override material, only
    when `edge > 0`. Normals find creases, depth finds silhouettes, and
    either alone looks broken.
  - THE PREPASS MUST DRAW WHAT THE REAL RENDER DRAWS, and
    `scene.overrideMaterial` makes that untrue by default: it replaces each
    object's material outright, so `visible`, `colorWrite`, `depthWrite` and
    the object's OWN VERTEX SHADER all go with it. Grease pencil is the loud
    casualty — a stroke's ribbon is built in its vertex shader from a
    centreline plus corner attributes, so under a foreign material only the
    raw centreline survives and is drawn as plain triangles: a stroke made on
    the view plane becomes a big flat polygon at one constant depth, and what
    you see is a giant square ruled across the middle of the room with
    nothing inside it, flickering as the camera moves. Nothing is wrong with
    the geometry and nothing draws a pixel of it in colour. `hideNonDrawing`
    turns off, for that one pass, everything whose material says it does not
    shape the depth buffer (`visible: false`, `colorWrite: false`, or
    `depthWrite: false` while transparent) plus the outline shells; object
    visibility is checked BEFORE the override is consulted, so `visible` is
    the only lever that still works there. Measured on the demo scene: the
    prepass read a flat 14.1 m across the middle of the floor and jittered
    frame to frame, against a smooth 21.2 -> 23.4 with the cull in place.
    POINT SPRITES are the sneaky member of that family and were the last
    mysterious square: a point's size comes from `gl_PointSize`, written by
    the material's OWN vertex shader, and an override material writes none —
    an unwritten `gl_PointSize` is undefined and on this driver comes out
    enormous, so ONE point becomes a hard-edged screen-aligned square that
    flattens depth and normals under it and takes the ink with it. The
    SELECTION ORIGIN DOT is a single-vertex `THREE.Points`, so selecting
    anything hung a phantom square on its pivot that tracked the camera and
    vanished when the pivot left the frame. Measured: hiding that one dot
    moved the frame from 20,818 inked pixels to 23,216; with the fix the
    count is identical (18,557) whether nothing, a sensor or a mesh is
    selected. `Points` and `Sprite` are skipped outright now — a sprite has
    no silhouette and no normal to contribute to a line drawing anyway.
    EDITOR FURNITURE is excluded from the pass by `userData.overlay`
    (`markOverlay` in main.ts: the transform gizmo, the plane and depth
    helpers, the camera frusta, the selection glyphs, the 3D cursor) — a line drawing of the scene should not
    contain a drawing of the tools, and the gizmo alone carries a
    90,000-unit invisible drag plane.
  - **`__tg.whatIsHere()` is how a viewport artefact gets diagnosed** rather
    than guessed at. With the artefact under the pointer it reports the edge
    prepass's own depth and normal at that pixel, then every object along the
    ray with the material flags that decide visibility, and marks the one
    sitting at exactly the prepass depth (`isEdgeSurface`). The object that
    IS the edge surface but is not `inColourPass` is the phantom, named. No
    flag can decide this alone — a mesh whose shape comes out of its own
    vertex shader, or one masked by a stencil, passes every check and still
    draws something else entirely under an override material. A prepass depth
    that matches NO hit is itself the answer: whatever draws there is not
    raycastable (points, lines, or shader-built geometry).
  - DEPTH PRECISION is the trap. The prepass stores view depth in the alpha
    channel, and a HALF float carries about three decimal digits — across a
    20 m room that quantises depth to centimetres, and the edge pass reads
    the quantisation as detail: ink speckle crawling over every big flat
    surface as the camera moves, which reads exactly like z-fighting on a
    plane. The buffer is FULL float, and the depth test is RELATIVE (the jump
    as a fraction of the sample's own distance) because an absolute threshold
    cannot serve both ends of a room — tuned for a near fold it inks the far
    floor, tuned for the far floor it misses the fold.
  - THE GRADE (levels, then brightness/contrast/saturation) sits after bloom
    and BEFORE the ink, so a line keeps exactly the ink colour it was given —
    crushing the blacks of a drawing should darken the paper, not repaint the
    pen. Levels run first because a gamma only means anything on a signal
    already normalised to 0..1, and contrast pivots on MIDDLE GREY (pivoting
    on black is a brightness control wearing the wrong name). An identity
    grade is skipped on the CPU (`gradeActive`) rather than computed and
    thrown away.
  - GRAIN is dither, not texture. A smooth gradient across a thousand pixels
    BANDS in 8 bits, which is exactly the image a light-field look produces.
  - Ordering matters: edges are read from the untouched image (before bloom
    smears it), then colour is remapped, then bloom adds, then grain and
    vignette land on everything.
  - The per-object FX composite into whatever render target is BOUND
    (`EffectsPipeline.apply` restores it), so binding the post target first
    puts them inside the look rather than making them the one thing it never
    touches.
- Background-tab rAF throttle (see Testing above) applies to constraint
  verification too — drive `constraintEngine.update(...)` and
  `score.update(...)` manually in a loop rather than awaiting wall-clock
  frames when testing FOLLOW_PATH/TRIGGER behavior headlessly.

- **Actors** (`scene.actors`, `src/actor/`) are rigged characters whose
  skeleton is POSITIONAL: a joint is a particle, a bone is a distance
  constraint. That is what lets ONE solver do ragdoll physics, 1:1 marker
  capture, angle retargeting and IK (FABRIK is native to positions).
  Rotations are DERIVED for display, never stored. Things to know:
  - Nothing writes `actor.pose` directly. Rigs, the pose tool and MIDI/OSC
    routes all push `JointTarget`s into `actorSolver`, so the body answers
    with physics instead of the joint tearing off the skeleton. A pinned
    joint has zero inverse mass, which is what makes a pinned wrist DRAG
    the arm rather than the arm dragging the wrist.
  - Positions are ACTOR-LOCAL, so the object transform (and any parent's)
    carries the whole ragdoll. Gravity is rotated into that space; steps
    run at a fixed 1/120 so stiffness does not track the frame rate.
  - `physics.tone` (pull toward the rest pose) is the difference between a
    character and a heap: at 0 it collapses, at ~0.06 it holds a stance.
  - Joint NAMES are the auto-rig table's keys and match the MediaPipe pose
    vocabulary deliberately. `chest` sits ON the shoulder line because it
    binds to the shoulder MIDPOINT (a pose model has no chest point); if
    its rest position were anatomically lower, angle retargeting would
    shorten the figure every frame. `neck` is intentionally unbound.
  - `rig.matchScale` rescales captured data to the actor about the
    PERFORMER'S FEET before any mode sees it. Without it every mode
    inherits the performer's dimensions — MARKERS stretches bones, IK
    leaves the character floating.
  - Any object can attach to a JOINT, not just an actor's root: give a
    COPY_LOCATION/COPY_ROTATION/TRACK_TO/LIMIT_DISTANCE/SPRING constraint
    a `target` of kind `ACTOR` plus `targetJoint` (a joint name). Position
    comes straight from the live pose; `jointWorldMatrix()`
    (`src/actor/skeleton.ts`) DERIVES an orientation for COPY_ROTATION
    from the bone leading into that joint, since joints store no rotation
    of their own — a prop parented to `hand.R` therefore also tips with
    the forearm, not just translates with the hand.

- **A rest pose the FLOOR cannot accept bends the whole figure.** The foot
  joint was authored at 0.012 of height with a collision radius of 0.030, so
  it sat inside the floor: the floor constraint lifted the toe by 0.032, that
  pivoted the foot onto its toes, dragged the ankle up with it, and the knee
  buckled to 154 degrees to absorb the difference. It looks like the ragdoll
  misbehaving and it is arithmetic — any joint's rest position along the up
  axis must be at least its own radius. Fixed at 0.030 (knees now 178) and
  migrated for saved actors.
- **A head is a BALL, so which way it faces has to be derived.** The minimal
  face (`buildFaceHead` in `render/actors.ts`, on by default for every look
  but MINIMAL) exists for exactly that: a bare sphere gives you no way to read a
  head turn, and a figure with its back to you looks like one facing you. The
  basis comes from the SHOULDER LINE crossed with the neck-to-head direction,
  so the face follows the body for free. Two traps: features are placed in
  HEAD-RADIUS units against a unit sphere (`jointGeo`), so anything under 1.0
  is buried inside the head and simply never appears; and the re-squared
  basis must be `x = y CROSS z`, because the other order gives determinant
  -1 — a REFLECTION, which `setFromRotationMatrix` cannot express, so it
  returns something near identity and the face lands on top of the head
  rather than on the front of it. Same trap as the VRM `toRig` mirror.
  The face is CARVED, not added: the head's own sphere has its vertices
  displaced (sockets pressed in, a ridge raised between them) rather than
  three extra meshes stuck to the front, so there is nothing to keep aligned
  and no extra draw. Shape it with ANGULAR radii and a smoothstep, never
  `dot(v, c)` raised to a power — at the exponent needed to keep a feature
  small it lands on a handful of vertices and reads as nothing at all.
  The same pass carries the head's PROFILE (width against height): a sphere,
  or an ovoid, reads as an EGG, and an egg has no chin — widest in the middle
  and closing symmetrically at both ends. The profile squeezes the horizontal
  axes by a curve so the head is broad across the cranium and narrows through
  the jaw, which is most of what makes a head read as carved. Apply it BEFORE
  the features and measure their falloff against the vertex's DIRECTION, or
  the sockets come out oval wherever the profile has narrowed the head.
  Two shaping traps: a nose ridge of constant width running up to the brow is
  a CREST down the skull rather than a nose (taper its width and rise toward
  the tip, and fade it in only at the brow — fading at BOTH ends puts a zero
  exactly where the nose should be strongest and the feature disappears);
  and take the STRONGEST ridge sample rather than the sum, or the overlapping
  ones stack into a hard spine.
  Poly counts here are an AESTHETIC choice, not a precision one: the head is
  40x30 (2320 triangles, down from 96x72), joints 12x9, limbs 8-sided, the
  clay blob's grid 36. A whole actor is ~7k triangles and the faceting reads
  as carving.
- **`Object3D.lookAt` branches on `isCamera`.** A camera is oriented so
  **-Z** faces the target (the direction it looks); everything else so +Z
  does. Building a camera's transform from a plain `new THREE.Object3D()`
  therefore yields a camera rotated 180 degrees, pointing at the wall behind
  it. This does not look like a wrong transform — it looks like "tracking
  silently never sees anything". Use a real camera object (see
  `lookRotation` in `app/demoscene.ts`).
- **A `TRIGGER` takes its SHAPE from its carrier, and `radius` is often
  ignored.** On a BOX/SPHERE/CYLINDER mesh it tests that primitive's own
  local bounds; on a PLANE it is a crossing detector; on a POLY it tests the
  topology. `radius` ONLY applies in the fallback sphere case — a carrier
  with no geometry (an EMPTY). Putting a proximity zone on a box therefore
  silently gives you a box-sized zone and no error. Use an EMPTY for
  "within N metres of", a primitive for "inside this volume".
- **Primitive geometries are authored Y-UP, so in a Z-up scene a CYLINDER or
  PYRAMID lies on its side.** CylinderGeometry's axis and ConeGeometry's apex
  both run along +Y, and nothing rotates them for you: an unrotated column in
  a Z-up scene is a disc lying on the floor, and scaling it "taller" only
  widens the disc. Stand them up with +90 degrees about X — and remember
  scale is then in the primitive's OWN axes (Y is the height), because
  `composeLocal` builds T*R*S.
- **A PLANE mesh's `scale` is its HALF size.** `PlaneGeometry(2, 2)` (see
  `render/meshes.ts`) means the primitive spans -1..1 before scaling, so a
  7 m wall is `scale.x = 3.5`. BOX/SPHERE/CYLINDER are unit-sized, so their
  scale IS their size — the two conventions sit next to each other in the
  same switch. Getting it wrong builds everything at double size, which is
  invisible in a screenshot of an empty room and only shows up when
  something authored at true scale (a scan, a collision test) sits well
  inside the walls.
- **To stand a plane up and turn it, the yaw goes in the Y Euler slot, not
  Z.** Euler order XYZ composes as Rx·Ry·Rz, so Rz is applied FIRST: a
  rotation of `(90, 0, yaw)` yaws the plane while it is still lying flat and
  then tips the result onto its side. `(90, yaw, 0)` is the one that means
  "stand it up, then turn it".
- **A joint limit cannot express a hinge on its own, and the ones that
  shipped were aimed at the wrong bones.** Two compounding traps:
  - The angle between two bones is UNSIGNED, so a knee bent 40 degrees
    forward and one bent 40 degrees backward both measure the same and both
    pass any min/max. The two are mirror images about the root-to-tip line
    and nothing preferred either — which is why a limb sat double-jointed
    and snapped between them on every step. `TGJointLimit.pole` is the
    actor-local direction the hinge is allowed to stick out in, and the
    solver ROTATES the middle joint about the root-to-tip axis into the
    plane that axis and the pole span. Keeping the along-axis and
    perpendicular distances makes it a pure rotation, so both bone lengths
    survive exactly and the correction vanishes as the limb straightens.
    Testing only the SIGN of `perp.dot(pole)` is not enough and was the
    first attempt at this: it fixes the backwards fold but leaves the whole
    sideways swing free, and this skeleton's knee swung further sideways
    (+/-0.25) than it ever bent forwards (0.18) — the twist that reads as
    the joint spinning 180 degrees.
  - A limit names its bones by the joint they END at. `(knee, hip)`
    therefore resolved to `hip->knee` and `hips->hip`, which measures the
    HIP's abduction; the knee and elbow were never constrained by anything.
    To limit a knee you name the bone BELOW it: `(ankle, knee)`. Limits are
    rebuilt from joint names by `rebuildLimbLimits` rather than hand-listed,
    and serialize.ts rebuilds any actor whose limits predate poles.
- **A neck is not a column, and a look's multipliers can hide a bad base.**
  The neck bones shipped at 0.045 and 0.050 against a head of radius 0.067,
  so the tube holding the head up was as WIDE as the head and the collar
  nearly twice it — a funnel with a ball on top, and every head turn swept a
  cone. It survived because three of the four looks divided it back down in
  their own `limbEmphasis` (WOOD 0.55/0.62, CLAY 0.5/0.5, MINIMAL through a
  0.3 global limb); DEFAULT was the only one that did not, so the mannequin
  wore the fault alone. Fixed at the base (0.028/0.030) with the other looks
  rebalanced to land within a few percent of where they were. The same
  arithmetic explains why DEFAULT's head looked small: beads are drawn at
  `joint * emphasis * spec.joint`, and 0.55 of the joint radius at 1.15
  emphasis came out at 0.042 — SMALLER than the 0.050 tube beneath it.
  Bone radii are display-only but are BAKED into an actor when it is created,
  so serialize.ts rewrites the two, and only when they still hold the old
  default for that actor's own height (a deliberately fat neck survives).
- **A pose has to be HELD, not written.** `physics.tone` pulls every joint
  toward its REST position, so writing a T-pose and walking away gives you a
  stance again within half a second (measured: 90 degrees to 4). `TGActor.hold`
  is a pose by joint name that `pushHeldPoses` feeds to the solver as TARGETS
  every frame — the same door capture, the pose tool and MIDI use — so a held
  pose is weighed against the gait rather than fighting it, and a mixer mask
  can hold the arms while the legs walk. Two traps: `applyTargets` CLAMPS the
  weight to 1 and treats 1 as a hard pin, so a "stronger" weight above 1 is
  arithmetic that never happens; and tone must be SKIPPED for held joints,
  because pulling a held joint along the chord toward its rest position
  shortens the limb rather than lowering it — every arm bone measured 7%
  short at any weight until tone stood down. With both right, T lands at 90
  and A at 45 with bone lengths within 0.1%.
- **A leaf bone needs its DIRECTION held, and `tone` fights it.** Nothing
  below a foot or a hand pulls it into shape, and tone pulls a joint toward
  its fixed rest POSITION — so swinging the ankle 0.4 m forward drags the
  foot back toward where it stands at rest, which puts it BEHIND the ankle.
  A foot pointing backwards on a third of the frames is the visible result.
  `TGBone.trackRest` (0..1) holds the bone's rest direction, ROTATED by
  wherever the parent limb has got to — the minimal rotation from the parent
  bone's rest direction to its current one. Held in the actor's own frame
  instead (as it was first written), a hand goes on pointing at the floor
  while the arm swings out to a T, so the wrist visibly breaks, and the same
  pull dragged a held pose 15% short of the angle asked for. "A hand
  continues the arm" is a direction relative to the FOREARM.
  `physics.hinges = false` turns off both this and the poles, restoring the
  free-bending version deliberately — it looks good on anything that isn't
  a person.
- **Imported motion is SAMPLED into a pose clip, not played live**
  (`src/actor/gltfclip.ts`). A glTF clip is rotation curves on a bone
  hierarchy; our skeleton has no rotations at all. Rather than keep a
  parallel three.js animation system alive in the frame loop, the clip is
  sampled once at import into named joint positions — which is exactly what
  a CLIP mixer layer already plays, so imported motion trims, blends, bakes
  and saves like a take you performed yourself. `MeshManager.modelAnimations`
  keeps `gltf.animations` (they used to be dropped on the same line that
  added the geometry, which is why a Mixamo export imported as a statue).
  Four ways to get an import that "works" and moves wrong:
  - NAMING. Mixamo's `LeftArm` is the UPPER ARM, so it maps to our
    `shoulder.L`; its `LeftShoulder` is the clavicle and has no home here.
    Off by one bone gives elbows where shoulders should be.
  - SIDES. **This skeleton's `.L` is the +X side, which is anatomically the
    character's RIGHT** (it faces +Y with +Z up, so left is -X). That is a
    pre-existing naming quirk, not something the importer should propagate:
    it compares the source's ankle-to-ankle direction against the actor's
    and swaps the NAMES when the two rigs label sides oppositely. Mirroring
    the geometry instead would give a character whose knees bend outward.
  - THE BIND POSE. Scale, facing and ground must be measured BEFORE the
    mixer exists. Sampling the clip's first frame reads whatever pose the
    animation opens in, and a clip that starts mid-stride hands you a
    "forward" taken from a leg swung 30 degrees out — the whole character
    imports rotated, and it looks like bad retargeting rather than a bad
    measurement.
  - GROUND. Anchor at the actor's ANKLE REST HEIGHT, not at zero. The ankle
    joint sits above the sole, so grounding at the floor plane sinks the
    figure — the same trap the gait hit planting feet.
  Horizontal root travel is stripped: the clip is an actor-LOCAL pose, and
  travel belongs to whatever drives the root.
- **Generated motion has a backend seam** (`src/actor/generate.ts`):
  `MotionRequest {prompt, seconds, joints[], goal?} -> TGClip` of named
  joint positions. Three backends answer it — a procedural synthesiser, an
  HTTP service, and **ARDY Mini** (`src/actor/ardy.ts`), a real diffusion
  model running on WebGPU. Things to know:
  - The vendored runtime (`src/vendor/ardy/`) is intsuc's Apache-2.0 code,
    copied UNMODIFIED. Do not "tidy" it — the DDIM update, the window
    recentring and the latent quantisation are numerical details that fail
    silently (the motion just looks slightly off). Our adapter is separate.
  - **The browser export is TEXT-ONLY.** Upstream ARDY takes waypoints and
    keyframes; these graphs have no such input. It answers "move like this",
    never "go there" — which only works here because travel belongs to the
    ROOT and the pose is a separate layer.
  - The WEIGHTS are not Apache-2.0: composite NVIDIA Open Model + Meta Llama
    3 Community terms. Nothing downloads until the user picks that backend,
    and `ARDY_NOTICES` must stay rendered next to the choice.
  - ORT loads its wasm host BY URL, not through the bundler, so
    `scripts/copy-ort-assets.mjs` stages it into `public/ort/` on dev/build
    (gitignored, 66 MB).
- **There is ONE generated-motion layer per actor, and a new one crossfades
  the old out.** Appending instead of swapping is what makes a character look
  "conflicted": every press of a Motion button used to add another CLIP layer
  at full weight, and the solver dutifully averaged ten different walks into
  one that was none of them. `App.swapGeneratedLayer` fades the previous out
  and prunes it on the NEXT swap, so at most two exist at a time and no timer
  is needed. Layers made this way carry `generated: true`; hand-authored CLIP
  layers (an import masked to the upper body, say) are left alone.
- **A clip that TRAVELS is phased by distance, not by time**
  (`TGActorLayer.phaseBy`, `TGClip.impliedSpeed`). Play a 1.4 m/s walk on a
  character moving at 0.7 and, timed, its feet skate; distance-phased it takes
  half-length steps — which is exactly what the gait has always done, so the
  two locomotion systems finally behave the same way. `impliedSpeed` is
  measured in `retarget.ts` from the source's own travel BEFORE that travel is
  stripped, so glTF imports and generated clips both get it for free. A clip
  that stays put (a wave, a sit) must stay on the clock or it freezes the
  moment the character stops — hence the 0.35 m/s threshold when a generated
  layer picks its mode.
- **`src/actor/retarget.ts` is the ONE retargeter** for foreign motion —
  frames of named joint positions in, a pose clip on our skeleton out. Both
  the glTF importer and ARDY go through it. The traps it encodes: scale
  about the FEET, facing recovered from the BIND pose (frame 0 of a clip
  that opens mid-stride gives a "forward" from a swung leg), ground at the
  ankle's REST height, and the `.L`-is-+X side swap. `groundRef` is the one
  real difference between sources: a glTF rig's bind pose shares a world
  with its animation, while ARDY's neutral pose is a hips-centred TEMPLATE,
  so its floor has to come from the frames.
- **The animation mixer** (`src/actor/mixer.ts`) is where every source of
  motion is weighed. Sources ask `gain(actor, source, jointName)` for their
  own multiplier rather than the mixer calling them, so each producer keeps
  its own state (the gait keeps advancing while muted, so unmuting picks up
  mid-stride) and an actor with no layer stack gets 1 and behaves as before.
  Layers are scene data; crossfades (`fadeTo`) are runtime and must stay out
  of the undo snapshot. The SOLVER does the actual combining: contributions
  to one joint resolve to a weighted MEAN with the summed weight as the
  pull, because applying them in sequence made the last source to run win
  and the outcome depend on frame order. CLIP layers are the one source the
  mixer drives itself, matching `TGClip.joints` by NAME — a pose clip is
  ACTOR_LOCAL (`TGClip.space`) so it replays where the character stands
  rather than dragging it back to where it was performed.
- **FOLLOW_PATH `orient` points an object's FORWARD axis down the tangent,
  and "forward" is not universal.** An ACTOR's skeleton is authored +Y
  forward in Z-up (-Z in Y-up); everything else has no anatomy and keeps the
  historical +X. Turning an actor's +X down the path is what makes a walking
  figure CRAB SIDEWAYS along it — the gait lays its footfalls along the
  body's forward axis, so a 90-degree error in the carrier reads as a broken
  gait rather than as a wrong rotation. `orientToTangent` in
  `score/constraints.ts` builds a basis rather than yaw/pitch eulers, which
  is also what makes a sloped path work: pitch in the X euler slot is applied
  about the WORLD x-axis and is only correct while the yaw is zero.
- **A FOLLOW_PATH traveller does NOT collide with anything.** Collision lives
  in the shared walking body that steering and possession use; the constraint
  engine simply sets the transform. So a path is the AUTHOR'S PROMISE that
  the route is walkable, and it is easy to break that promise silently — the
  demo's old oval passed through the ziggurat, the stairs, the platform and a
  column, and just looked like a ghost. If you move the furniture, re-check
  the route (`walkLoopPoints` in demoscene.ts was verified against every
  prop's footprint plus the walker's body radius).
- **The viewport says what characters are DOING, in two registers**: the
  first-person log (`app/actorlog.ts`) is what they INTEND, emitted where the
  goal is actually set so it cannot drift from behaviour; the per-actor badge
  (`actor/state.ts`, drawn on the HUD) is what is actually happening to them,
  including WHICH system is posing them — gait / synth / ARDY / capture /
  import / you. Take the LOUDEST clip layer when deciding that, not the
  first: during a crossfade two are live, and the first is the one on its way
  out, so the badge kept naming the backend that had just been replaced.
  The two disagreeing — "I'm going to climb the stairs" over a badge reading
  `stuck` — is the most useful thing on the screen.
- **An actor's ROOT has exactly three drivers, and they are the same
  shape**: a FOLLOW_PATH constraint (a recorded route), possession
  (`app/possess.ts`, your hands), and steering (`actor/steering.ts`, a
  destination). None of them touches the pose — the gait sees the root move
  and produces the walking — which is why all three read as one character.
  `ConstraintEngine.driven` (runtime, a Set) stands an object's transform
  constraints down while another driver owns it; the object is STILL fed to
  the trigger probes, because a visitor entering a zone should not depend on
  who is walking it. A steer goal suppresses the path even AFTER arrival, on
  purpose: otherwise the old path grabs the character the instant it reaches
  where you sent it, which looks like the goal was ignored.
- **Steering, not pathfinding.** No navmesh, no A*: seek, arrival ramp,
  wall-slide, and a three-whisker look-ahead that ROTATES the desired
  direction around an obstacle. Two traps worth keeping: (a) ADDING a
  lateral force to the seek force does not work — at a box sitting on the
  straight line to the goal the two cancel and the character grinds into it;
  rotating makes the forward component fall away as the obstacle closes;
  (b) re-picking the side to pass on every frame flickers when the two sides
  measure the same, so the side is committed until the way is clear. When it
  wedges anyway it does not simply give up: a reactive steerer WILL find
  local minima (an inside corner, a gap it keeps re-entering), and the way
  out of one is not to push harder but to go somewhere else briefly and
  re-approach. It takes up to three sideways DETOURS, alternating sides and
  biased backwards since the wedge is in front, resetting its progress
  accounting each time — and only then sets `stuck`. Arrival always tests
  the REAL goal, never the detour. Verified: open routes arrive with no
  detour at all, and a goal reachable only by stairs tries twice, says so,
  and gives up in a bounded 23 s instead of shuffling forever. The heading turns at a bounded
  RATE — snapping it spins the body under a world-locked stance foot.
- **Loose props** (`actor/props.ts`, `TGMesh.body`) fall, roll and get kicked.
  The design falls out of one observation: an actor is ALREADY a set of joint
  spheres with radii and a solved position every frame, so prop-vs-character
  contact needs no new representation — sphere against sphere, with the
  impulse taken from how fast that joint happens to be moving. Walking into a
  ball nudges it, a swinging foot launches it, a hand bats it, and none of
  those are special cases. Only the component of the joint's motion heading
  INTO the prop counts, or a foot brushing past flings things it never hit.
  What it is NOT: no rotational dynamics, no resting-contact solver, and
  every prop collides as a SPHERE whatever it is drawn as — a cube will not
  topple onto a face. That is deliberately the same fidelity the character's
  own world-AABB collision has; pairing a rigid-body engine with a capsule
  that push-outs of boxes would be worse, not better.
  You can also drag one by hand: the Pose tool grabs props as well as joints
  (`tools/actorpose.ts`), and the two are the same gesture on purpose —
  neither one WRITES a position. A joint gets a solver target; a prop gets a
  velocity toward the cursor (`propEngine.hold`), so it still meets the room
  on the way and stops at the wall instead of ending up inside it. Letting go
  simply stops steering it, which is why the throw needs no extra code: the
  chase velocity IS the throw. A held prop carries no gravity, so it stays
  where you park it in mid-air until you release — staging a scene wants
  that, and falling on release is the same rule as everything else.
  **A missed resize STRETCHES the render and drifts every overlay.**
  `glRenderer.setSize(w, h, false)` deliberately leaves the canvas ELEMENT at
  its CSS size, so when the viewport changes size without `resize()` running,
  the drawing buffer keeps the old dimensions and the browser scales it to
  fit. Nothing clips and nothing letterboxes — the image is simply stretched,
  and the HUD (drawn in buffer px) parts company with `objectToScreen`
  (computed from the element's bounding rect) by a factor that grows with the
  distance from the top-left. A highlight that sits below and larger than the
  thing it marks, while clicking that thing still works, is this and not a
  HUD-maths bug: the pick runs in the same space as the projection. A window
  resize is only one of the ways it happens (panels, the sidebar drag, the
  timeline, browser zoom), so `#viewport` is watched with a ResizeObserver
  and `resize()` early-outs when the size is unchanged.
  Two things the highlight taught: a sphere's SILHOUETTE is not its centre
  projected plus a projected radius — under perspective an off-axis sphere
  projects to an ellipse displaced outward, and the visible radius is the
  tangent cone's, up to ~20% larger than the distance to a point one radius
  sideways. `screenDisc` projects the real tangent circle instead, and refuses
  to answer for a prop the eye is inside or that straddles the near plane
  (that case reported a 49,000 px disc that swallowed every other pick).
  The outline is a SHADER, and both halves of that matter. It draws with
  `depthTest: false` so a selected object stays outlined from behind a wall —
  an outline you cannot see is exactly the one you were looking for — and a
  per-object STENCIL ref is what keeps that from painting the shape as a
  solid blob: pass one stamps the object's own pixels, pass two draws the
  shell only where the stencil does NOT match. Each outlined object gets its
  own ref (rotating 1..250), because with one shared value the second
  object's mask sits in the buffer where they overlap and eats the first
  one's rim. And the shell is fattened in SCREEN PIXELS by offsetting each
  vertex along its projected normal, not by scaling the mesh: a percentage
  makes the rim proportional to the object, so a crate 400 px across gets a
  fat band while a marble 20 px across gets half a pixel and the highlight
  vanishes on exactly the small things you are hunting for.
  `MeshManager.outlineResolution` must track the viewport (App.resize) or the
  width drifts.
  **Everything drawable without a surface to fatten wears a SILHOUETTE**
  (`render/outline.ts`, `App.silhouetteRoot`): grease pencil, splats, paint
  clouds, actors, and editable (poly) meshes — those can be anything down to
  one flat face, which an inverted hull cannot outline, so they wore a box
  until they joined this pass. The selected roots are rendered ALONE — isolated by
  visibility, the same lever the per-object FX pass uses — with their OWN
  materials into a mask, and a rim is drawn wherever a pixel outside the
  mask has a neighbour inside it (16 directions on two rings). Their own
  materials, never an override: an override is what turns a GP stroke into
  a slab and a point sprite into a square, and would outline something that
  was never drawn. Two traps: Spark draws EVERY splat through one
  SparkRenderer object, which is a SIBLING of the splat meshes rather than
  an ancestor, so the isolation must leave it on (`userData.splatRenderer`)
  while the other splat meshes go dark; and a SplatMesh's own geometry is ONE
  instanced quad, so `Box3.setFromObject` put its bounding box small at the
  origin whatever the cloud looked like — `computeObjectBox` asks Spark's
  `getBoundingBox(true)` instead, once per mesh. The rim is drawn AFTER the
  scene look, because selection is interface, not part of the picture; it
  is not drawn in quad view. Verified: a GP path's rim hugs the stroke (no
  box) and an active actor's shows through the column in front of it,
  18,939 pixels of rim against a frame without it; a 100k-splat scan wears
  a ragged rim like Blender's.
  THE COST IS PIXELS, not objects: the rim shader reads the mask 32 times
  per pixel, so a full-screen pass is most of a millisecond at retina
  resolution even when the selection is a speck (measured ~0.7 ms at
  964x1454 before the fix). Both passes now run in a SCISSOR round the
  selection's projected bounds, grown by a 24 px margin (a stroke's ribbon
  spills past the centreline its box measures) and, for the mask, by the rim
  width again so the composite's outermost samples read pixels the mask pass
  actually cleared. A too-small scissor does not cost time, it CUTS THE
  OUTLINE OFF — so any root without trustworthy bounds (an actor, today)
  means the whole frame, and a splat uses Spark's FULL extent
  (`splatReach`, gaussians included) rather than the centres-only box the
  Dimensions readout wants.
  In the end the 2D marker went away entirely: the inverted hull is now the
  ONE outline in the app — `MeshManager.setHover` for what is under the
  cursor and `setSelectionOutlines` for what is selected, any colour, and the
  hover wins where they overlap. Selection used to be a world-axis-aligned
  Box3, which is a lie about most shapes and became a visible one when props
  started to tumble: a rotated dodecahedron wore a loose cage that grew and
  shrank as it rolled. Two kinds still keep the line outline, and should:
  an EMPTY has no surface, and a PLANE has no THICKNESS — an inverted hull of
  a flat quad is coincident with the quad and z-fights instead of making a
  rim, while a flat thing's edge loop already IS its silhouette.
  `MeshManager.setHover` draws an INVERTED HULL — the object's own geometry again, fattened ~4.5%, back
  faces only — so the highlight is the real silhouette of whatever shape is
  under the cursor, rides the object's transform (including the physics
  moving it), and has no projection left to get wrong. Every 2D approach
  before it failed the same way: a circle fits a sphere, and every primitive
  reports the same unit box from `meshLocalBounds`, so a tetrahedron's
  "radius" is its box's — over twice the silhouette it draws. The trap when
  parenting a shell inside the object: `MeshManager.apply` traverses the
  whole entry tree each sync and repaints every material from the object's
  data, which turned the thin rim into a solid block of colour over the whole
  prop. Shells are marked `userData.hoverShell` and skipped there.
  And ALT IS NOT AVAILABLE as a viewport modifier: `emulate3Button` (on by
  default) makes Alt+LMB orbit, so an Alt gesture never reaches a tool at all.
  Prop positions are read and written THROUGH the parent transform, because
  `mesh.translation` is parent-local and one Cmd-G puts every ball under an
  empty; the simulation itself works in world space.
  **Three body kinds, and STATIC is the absence of a body.** `TGMesh.body`
  present means the simulation moves it: `type: 'DYNAMIC'` (falls, is pushed,
  the default when the field is absent) or `'KINEMATIC'` (keeps whatever
  position you, a constraint or an animation give it, and shoves dynamics
  aside without ever being shoved back). No `body` at all is STATIC — it
  still collides, as part of the same world AABBs the characters walk on,
  which is why balls bounce off a floor that has no physics settings of its
  own. A kinematic prop needs no mass, bounce or friction, because nothing
  ever pushes back on it; it reuses `hitJoint`, since "a moving sphere that
  imparts its own velocity and does not react" is exactly what a character's
  joint already is. Dragging a prop is the same thing with the cursor
  supplying the motion.
  A loose prop is GROUND but never a WALL: you can stand on a crate, and you
  walk THROUGH a ball rather than edging round it, because the joints are
  what move it and stopping the body would prevent the contact that does the
  work. Steering's whiskers skip them for the same reason.
- **There are TWO physics backends behind one seam** (`actor/physics.ts`),
  chosen by `scene.physicsEngine` — scene data, not a preference, because a
  scene staged in one does not behave the same in the other. Both answer the
  same three questions: step the world, hold a prop under the cursor, let it
  go. `SIMPLE` is `props.ts` above. `RAPIER` (`actor/rapierphys.ts`) is a real
  rigid-body world and is what to reach for when you need what the sphere
  model cannot give: true convex shapes, rotation (a crate lands on a FACE),
  stacks that hold, and a fixed-step deterministic solver.
  - Rapier owns a world built FROM `GPScene`, never the other way round —
    every step writes back into the scene, so undo, save, load, the outliner
    and the transform widget all keep working. No `body` -> fixed; DYNAMIC ->
    dynamic; KINEMATIC -> kinematicPositionBased driven from the data; every
    actor JOINT -> a kinematic ball, so kicking still needs no special case.
  - An EXTERNAL edit is detected against the last transform WE wrote, not
    against the previous frame: a falling body rewrites its own translation
    every step, so "changed since last frame" is true of everything in
    motion. Anything that differs from OUR value came from the widget, a
    constraint, an undo or a load, and must be applied as a teleport with the
    velocities cleared, or the body springs back.
  - A held prop stays DYNAMIC with gravity scaled to 0 and its velocity
    steered. Making it kinematic is the obvious move and is wrong: kinematic
    bodies pass through everything, so the ball you are dragging ends up
    inside the wall.
  - A PLANE's collider is a thin slab SUNK by its own half-thickness, so the
    top face is exactly the plane you can see. Centre it instead and the whole
    room rests 2 cm in the air, which reads as floaty contact rather than as a
    collider in the wrong place. The platonics have no analytic collider and
    become convex hulls built from `primitiveGeometry` — the same factory the
    renderer draws from, so the two can never disagree.
  - DETERMINISM is per input, not per wall clock: the same scene stepped by
    hand at a fixed dt is bit-identical run to run (verified: three runs, zero
    drift), but ACTORS are an input. A scene with characters walking in it
    reproduces only if their motion does.
  - `body.shape` picks the COLLIDER: AUTO gives the analytic shape matching
    what the object is drawn as (and a hull for a MODEL, whose triangles only
    exist in the render tree — `MeshManager.collisionMesh` hands them over,
    so the physics never reaches into the renderer). The overrides are
    ball/box/capsule/cylinder/cone/hull/trimesh, because collision fidelity
    is a choice: a hull of a lamp-post is cheap and right, a hull of a chair
    is a wedge you cannot sit in. **A TRIMESH IS A SURFACE, NOT A SOLID** —
    it has no inside, so a dynamic body built from one sinks through whatever
    it lands on; a moving body silently gets the hull of the same triangles
    instead, and exact collision stays for the room.
  - Not yet on Rapier: the ACTOR solver. `actor/solver.ts` is positional
    (a joint is a particle, a bone a distance constraint) and Rapier's
    ragdoll would be bodies + joints with real angular state — a different
    representation of the same character, not a setting.
- **There is NO SKINNING.** A body is capsules per bone and beads per joint —
  no bind pose, no weights, and the skeleton stores no rotations to skin
  against. The CLAY look answers the same want a different way
  (`render/blob.ts`): field sources at every joint and along every bone,
  polygonised each frame with MarchingCubes, so limbs MERGE where they meet —
  the thing skinning is usually for — straight from the positional skeleton
  with no rigging step. ~1.1 ms per actor per frame at resolution 48, so it
  is opt-in per look (`LookSpec.blob`). The two numbers that matter and why:
  a source's surface sits where `strength/d^2 - subtract == isolation`, so
  the strength for a wanted radius is `(isolation + subtract) * r^2` —
  leaving isolation out draws every limb at a THIRD of its thickness while
  the joints, where fields overlap and sum, still bulge (a stick figure with
  knobbles). And a source REACHES `sqrt((isolation + subtract) / subtract)`
  times its radius with everything inside that adding, so a low `subtract`
  inflates the whole figure into a snowman with its arms absorbed; 64 keeps
  the reach at 1.5 radii and confines merging to where parts actually meet.
- **The mannequin's shape parameters are catalogued in `docs/MANNEQUIN.md`** —
  proportions, look multipliers, the head's profile and face relief, and the
  clay surface's constants, each with what it controls and which file it is
  in. Update it when you change one; it exists so shape feedback can name a
  number instead of a feeling.
  `selectedOnly` narrows every kind, not just strokes: an object that is
  itself selected exports whole, and a GP object that is not can still
  contribute individually selected strokes (edit-mode selection, which
  predates it). `App.export3D(format, selectedOnly)` is the one door — the
  File menu and the viewport right-click both go through it and share
  `EXPORT_FORMATS`, so the two lists cannot drift.
  The 3D exporters INCLUDE actors (`ctx.actorRoots()` hands the live meshes
  to `buildExportGroup`), because an actor's geometry is built by the
  renderer and nowhere else — rebuilding it in the exporter would be a second
  copy that drifts from the one you are looking at. MarchingCubes hands back
  a fixed-size buffer and reports the real extent in `drawRange`, so a blob
  body must be trimmed to that or the file carries tens of thousands of
  degenerate triangles at the origin.
- **A MEASUREMENT is an object, and its points can be BOUND**
  (`scene.measures`, `core/measures.ts` for the data, `tools/measure.ts` for
  the tool). It is a pen with a readout: the same magnet
  (`snapWorldPoint`) places every point, and it carries a transform, a
  parent, a name, a colour and the usual visible/lock, so `ObjKind` gains
  `'MEASURE'` and the outliner, selection, grouping, deletion and
  frame-selection all come for free.
  - THE BIND IS THE POINT. A snap is a one-off — it puts the point where the
    corner WAS. A bind is the same gesture KEPT: `TGMeasureBind` stores the
    point in the TARGET's own local space and resolves it every frame, so
    moving, rotating or rescaling the wall carries the dimension on it.
    Measured: a bound leg on a plinth translated with it exactly, kept its
    length through a 90-degree rotation, and read 1.6 m instead of 0.8 after
    the plinth was scaled x2 — which is right, because it is measuring the
    plinth. A free ruler in the same scene did not move at all. Without this
    a set of dimensions is only true of the blockout you had at the moment
    you drew them, and the blockout is the thing that keeps moving.
  - AN ACTOR NEEDS A JOINT, not a matrix. A body deforms, so a point bound to
    one stores the nearest joint's name plus an offset in the actor's frame;
    an object matrix would leave a dimension on a shoulder floating where the
    shoulder used to be. Verified on a walking character: the reading tracked
    the stride while the points travelled 1.3 m across the room.
  - `SnapHit.ref` is how the identity gets out of the magnet, and it is
    OPTIONAL on purpose: raycasts and object origins can say what they hit,
    while the plane and lattice modes honestly cannot, and a point placed
    that way is free. `refOfObject3D` is the one Object3D -> ObjRef walk,
    shared with picking so the two cannot disagree.
  - A BOUND POINT IGNORES THE MEASURE'S OWN TRANSFORM — the target owns it —
    which is the same rule a constrained object already follows. Free points
    are stored in the measure's space, and `recentre` puts a new ruler's
    origin on its own centroid so the transform widget appears where the
    thing you selected actually is rather than at the world origin.
  - IT HAS NO MESH. Measurements are drawn on the HUD canvas, above the GL
    canvas, so they read over the scene AND over whatever the scene look did
    to it — an annotation a bloom pass can smear is not an annotation. That
    also means `App.drawHud` draws them in EVERY mode and the tool draws them
    itself while it is active (adding the rubber-band leg); a dimension
    visible only inside one tool is a mode, not an annotation. A bound point
    is drawn FILLED and a free one hollow, because which is which decides
    whether the dimension survives the next edit.
  - `closed` turns a path into a ring: perimeter plus AREA, by NEWELL's
    method — the cross-product sum is twice the area vector, so it is right
    at any orientation and sane for the slightly non-planar ring that tracing
    a real corner always gives. Projecting onto a coordinate plane instead
    reports a wall's area as zero the moment it stands up (verified: a 2x3
    ring reads 6 m2 flat on the floor and 6 m2 stood on end).
  - Measure is a tool in OBJECT and EDIT mode, and `UI.placementControls`
    (Placement, Plane, Guide and their options) shows for it in both — the
    same group Draw mode shows, because a ruler resolves its points through
    exactly the same chain as a stroke. Two things a ruler needed to behave
    like one: the GUIDE is applied to the pointer before the magnet (measured
    from the previous point, as a stroke's is from its start), and each draft
    opens a sticky placement SESSION (`setStrokeExclusion(-1)`) — the planes
    captured from a first point (Up from Ground, View at Origin, the two ⊥
    placements) only engage while one is open, so without it every point of
    a ruler fell back to the floor. Cmd/Ctrl held on the RELEASE of a click
    (or Cmd+Enter) finishes the ruler CLOSED — a room's outline and its area
    in one gesture; the draft is drawn closed the moment Cmd is down, and two
    points finish as a plain ruler since they enclose nothing. Verified: Up from Ground takes a ruler
    from (1,1,0) straight up to 2.34 m; a Parallel guide flattens an
    off-axis click onto the horizontal.
  - `scaleSceneToMeasure` no longer special-cases them: a measurement is a
    root object, so the same loop scales it, and a bound point needs no
    scaling at all because whatever it is stuck to was just scaled underneath
    it. Curved legs and surface-following paths are not built; the data shape
    (a list of points with binds) admits them.
- **Files are STORED, not linked** (`io/blobstore.ts`). A picked or dropped
  file used to become a `blob:` URL, valid only while the tab was open, so
  every scan in a scene vanished on reload ("session only"), and
  localStorage (~5 MB for the whole app) could not hold one 24 MB scan. File
  bytes now live in IndexedDB, keyed by SHA-256, and a scene refers to one as
  `store:<hash>/<filename>` — the hash de-duplicates, and the FILENAME is kept
  because three's and Spark's loaders pick a parser by extension and an
  object URL has none (which is why an .obj picked from disk used to go to the
  glTF loader and fail). `resolveSrc` turns a reference into an object URL,
  so MeshManager and the splat manager load asynchronously; the splat manager
  keeps a `pending` set so a second sync cannot start a second load. A saved
  scene .json still only carries references — it is portable within this
  browser, not to another machine, until scenes can be packed.
- **Drop to place** (`App.importFiles`, `App.dropTarget`, `io/dropfiles.ts`).
  Files dropped on the viewport land where they are dropped: on whatever the
  ray meets (meshes and splats), else the ground plane, else the 3D cursor.
  `.ply` is two formats under one name — a splat scan or a triangle mesh — so
  the HEADER decides (f_dc_0 / scale_0 / rot_0 mean splat). glb/gltf/obj/fbx/
  vrm are Y-up by convention and are stood up in a Z-up scene. A model is SET
  DOWN once its geometry loads (`settlePlacements`): lifted until its lowest
  point rests at the drop height, since its origin is usually its centre and
  would otherwise bury half of it; verified to 0.2 mm. An image hangs ON the
  wall it is dropped on (1 mm proud, upright, facing out), and on open floor
  stands up facing the camera. Two loader traps found on the way: a file
  with no normals lights solid BLACK (normals are computed on load), and OBJ
  and FBX arrive with PHONG materials, which ignore the environment map that
  is all of Solid shading's light — also black; they are converted to
  Standard.
- **The Library** (`io/assets.ts`, the Library tab) is object DEFINITIONS
  plus thumbnails in IndexedDB — the files themselves are in the store, so an
  entry stays small and a scan is kept once however often it is placed.
  Drag a tile into the viewport to place it at the pointer (payload
  `ASSET_MIME`), click to place at the 3D cursor; "Save selected" adds every
  selected drawing, model and scan (copying any legacy blob: file into the
  store first, or the entry would point at nothing after a reload). The old
  localStorage library is migrated on first load. Thumbnails are the object
  rendered ALONE (isolated by visibility, lights and Spark's renderer kept)
  from a three-quarter view — framed for a scan by the 5th-95th percentile of
  its splat centres (`splatCore`), because a capture's FLOATERS reach metres
  out and a picture fitted to them shows the room as a speck (measured: core
  ~1.4 x 2.3 x 2.3 m against a full reach of ~18 x 17 x 17).
- **The Library is a CONTAINER; dropping on it does not place anything**
  (`App.importToLibrary`). Files dropped on the Library panel become entries
  and stay out of the scene — they used to go through the viewport's
  importer, so a drop on the Library also placed the file. Pictures come
  from a private STUDIO (`App.studioThumb`): its own MeshManager or
  SplatManager, lights and the scene's environment, polled until the thing
  has loaded, rendered, then thrown away — nothing enters the scene, the
  outliner or the undo history. A splat needs a couple of renders before
  the kept one (Spark sorts during a render, so the first can be empty).
  A tile is placed by DRAG (where it is dropped) or DOUBLE-click — a single
  click used to place it, and a stray one put things in the scene. Double-
  click places at the 3D cursor through `App.cursorTarget`: the magnet's
  lattice rounds the point, and the PLANE decides how an image faces (Up from
  Ground stands it on the floor facing the view, Top lays it flat —
  `DropTarget.flat` — Front/Side hang it on that plane, View/None face the
  camera). The Guide has nothing to act on for a single point.
  Measured: a 24 MB scan pictured in ~0.5 s with the scene untouched, and
  the main scene's splats unaffected by the studio's own SparkRenderer. An
  image's picture is the image itself. Placing a PLANE asset orients it like
  a direct drop (on a wall, or upright facing the camera).
  **In an eval, the Library's `listAssets` must be read through the DOM or
  the app** — `import('/src/io/assets.ts')` is a second module instance with
  its own empty cache (the general trap above).
- **Videos and GIFs are live SOURCES too** (`liveSources.openMedia`, key
  `media:<store ref>`): mp4/webm/mov/m4v/ogv through a looping muted
  <video> (rVFC-gated like a camera), GIFs decoded frame by frame with each
  frame's own duration (WebCodecs ImageDecoder). They play by default, pause
  and resume, texture objects and feed capture exactly like a camera — and
  need no permission, so `textureFor` OPENS a media key on first use: a plane
  saved with a video plays again after a reload untouched. `classifyFile`
  calls them MEDIA (a GIF is always MEDIA: a still one is a one-frame loop).
  Dropped on the Library they become STREAM assets with a first-frame thumb;
  dropped on the viewport, a plane that takes the media's aspect once its
  first frame arrives (`App.fitToMedia`).
- **No prompt() / confirm() in the Library** — an embedded browser (the app's
  own preview pane) can refuse them, and New folder, rename and remove all
  silently did nothing there. Names are edited INLINE (`UI.inlineEdit`; the
  panel's refresh waits while a `.lib-rename` field exists, and the field
  removes itself before committing so the refresh it triggers is not
  deferred forever); removal is immediate, with "Restore last removed" in
  the ⋯ menu. A tile drag must allow 'copyMove': with only 'copy' allowed the
  browser refuses every drop onto a folder (which accepts a 'move'), and a
  synthetic-event test does not enforce that, so it passed while the real
  gesture failed. Tiles multi-select (click, Shift/Cmd-click); a drag or a
  removal acts on the whole selection when the tile is part of it.
- **A poly mesh's cyan edge overlay shows only while it is selected or
  edited** — it was on for every mesh in every shading mode, so a finished
  box read as a wireframe diagram — unless the mesh has loose edges (a wire
  or chain), which are its drawing.
- Test media for this project lives OUTSIDE the repo (the user's
  ~/Desktop/_tmpassets); copy what a test needs into `public/_tmp*`, which is
  gitignored, and serve it from there.
- **The TEST CAMERA and TEST CARD** (palette: "Add test camera", "Add test
  card"; also in the Library's Camera menu) are first-class sources, not test
  scaffolding: `liveSources.openTest()` is a GENERATED 1280x720 source at 30
  fps (bars, a sweeping marker, timecode, frame count) that behaves exactly
  like a webcam — tile, planes, capture, pause — with no device or
  permission; `testCardDataUrl()` is a still 16:9 image (grid, bars, grey
  ramp, a circle for aspect, a corner mark for orientation) added to the
  Library as an image. Use them to verify camera work in the preview pane.
- **Library extras** (`io/assets.ts`, `App.renderToLibrary`):
  - Editable meshes save as `POLY` assets; "Add to Library" and "Render
    selection to Library" are on the object right-click menu, which the
    outliner shares.
  - RENDER VIEW keeps the view as it looks minus editor furniture (grid,
    gizmo, `markOverlay`ed helpers, the hull rims); RENDER SELECTION renders
    the selection alone on a transparent background, cropped to what it drew
    (+8 px). Both become image assets (the look/post is not applied). Two
    traps found on the way: reading pixels back from an MSAA render target
    came out BLACK with correct alpha, so the target is plain; and isolating
    by visibility must WALK INTO a group that holds lights (Solid shading's
    studio rig) rather than hide it — hiding it rendered every isolated
    object black, thumbnails included (`hasLight`).
  - FOLDERS are a name on each asset (`TGAsset.folder`) plus a localStorage
    list so an empty folder survives; drag a tile onto a folder header or
    grid to file it, onto Unfiled to take it out; double-click a folder to
    rename; removing one leaves its assets unfiled.
  - EXPORT is one zip: `library.json` (records, thumbnails, folders) plus
    `files/<hash>/<name>` for every stored file an asset refers to — the scans
    and models are the point of moving a library. Stored uncompressed (the
    media is already compressed). IMPORT takes that zip, or a FOLDER of the
    same, adding beside what is there with fresh ids; a zip or folder with no
    library.json is imported as loose files (scans, models, images).
- **LENSES** (`render/lens.ts`, `TGLens` on a camera and on a projection):
  installations are full of curved optics — a dome, a fisheye projector, a
  360 camera, a mirror ball — and none of them are a frustum. ONE model
  serves both ends, because they are the same function read in opposite
  directions: a camera asks "this pixel is at radius r — which direction?"
  (the model inverted), a projector asks "this surface is at angle θ — where
  in the picture?" (the model forward).
  - The polynomial is Paul Bourke's published fisheye-correction form
    (paulbourke.net/dome/fisheyecorrect): r(θ) = k0 + k1θ + k2θ² + k3θ³ +
    k4θ⁴, θ in RADIANS from the axis, r NORMALISED with 1 the edge of the
    image circle — which is how real lenses are measured, so a published set
    pastes straight in (his measured 190° lens is a preset). Blender's
    "Fisheye Lens Polynomial" is the same polynomial with r in sensor mm;
    k0 is its offset term, kept for that reason. Equisolid can be given as
    focal + sensor mm instead, which decides the covered angle
    (`effectiveFov`: θ = 4·asin(sensor / 4f)).
  - A CAMERA with a curved lens cannot be rasterised — a GPU draws straight
    lines — so the scene is rendered into a CUBE and one full-screen pass
    asks the lens where each pixel looks (`LensCamera`). Six faces a frame is
    the honest cost. The cube is world-aligned and the camera's rotation is a
    uniform (`uOrient`), so turning the view costs nothing extra. Outside the
    image circle is BLACK, not "far". The selection rim stands down under a
    curved lens: it re-renders through the view camera, which this is not.
  - A PROJECTOR with a curved lens is the easy direction and needs no
    inversion: the flat-projector shader takes the point into the
    projector's own frame and calls the forward model (`lensProject`). That
    is a real dome/fisheye projector. It REQUIRES the flat path (three's lit
    spot is a frustum), so choosing a curved lens turns Flat on and the
    picture round; and its beam is not blocked by anything, since the spot's
    shadow map is a frustum that cannot match it.
  - Two shader traps, both from injecting code BEFORE a material's own
    source: three's `<common>` (which defines PI) has not been included yet,
    so the chunk carries its own `LENS_PI`; and `unpackRGBAToDepth` lives in
    `<packing>`, which some materials have and others (MeshBasicMaterial) do
    not — the flat projector unpacks depth itself rather than including it.
- **DRAW an object where it goes** (`tools/objectdraw.ts`, Object mode's
  toolbar): Add ▸ Box gives you a cube at the cursor that then has to be
  moved, turned and scaled — three operations to say one thing. These draw it
  in place, resolving every point through the SAME chain a stroke does
  (Placement, Plane, Guide, the magnet), so a panel drawn with Up from Ground
  stands on the floor (verified: bottom exactly at z = 0, normal horizontal,
  its own up axis up, grid-snapped) and one drawn under Placement: Surface
  lies on the scan. Cmd skips the magnet, Shift squares a footprint, Esc
  cancels the draft, and the finished object is selected.
  - Three gestures by what the thing is: FLAT (plane, rect, triangle,
    polygon) is one drag; RAISED (box, cylinder, pyramid) drags the base then
    moves away from the plane to raise the height — measured as the
    skew-line solve against the pointer's ray, because the height runs along
    the view as often as across it; RADIAL (sphere and the four platonic
    solids) is one drag from the centre, a radius, and they are set down ON
    the plane rather than sunk half-way into it.
  - The flat n-gons are EDITABLE meshes, not primitives: the next thing you
    do to a blockout panel is drag one of its corners onto the real corner of
    the room. `settings.polygonSides` (top bar, Object mode) sets the n.
  - Primitive orientation is the trap the rest of the file already documents:
    a PLANE's normal is its own +Z so it takes the plane's basis (u, v, n),
    while a CYLINDER and a PYRAMID are built Y-UP and must stand their Y on
    the normal instead; a cylinder's geometry is also 1.2 tall, so its height
    scale is h / 1.2.
- **A PROJECTOR is a SPOT light that throws a picture** (`TGProjection` on
  `TGLight`, painted in `render/lights.ts`): one mechanism for both a GOBO (a
  shape cut into the beam, greyscaled, tinted by the light's own colour) and
  a PROJECTION (an image, a video, a camera thrown onto the room), because
  they differ only in what the picture means. Add ▸ Projector makes one aimed
  at the origin with shadows ON — a projector nothing can stand in front of
  is no use for planning an installation.
  - three maps a spot light's texture over its SQUARE frustum and the cone
    cuts the inscribed circle out of it, so the picture is laid into a
    rectangle INSCRIBED IN THAT CIRCLE (its diagonal spans the cone) on a
    1024px canvas with black — "no light" — around it. That is what makes the
    lit patch the projector's rectangle rather than three's circular spot.
    `aspect: 0` keeps the circle, which is the round-gobo case.
  - `light.map` works WITHOUT castShadow (three updates the light matrix for
    a map alone), but shadows are what let objects block the beam.
  - A live source (camera, video, GIF) repaints the canvas on its frame
    counter; a still image is painted once, and again when it finishes
    loading. The beam glyph is rebuilt only when its angle or aspect change.
  - `App.projectorThrow` measures the beam CENTRE to the first thing it
    hits and reports the picture's size there ("throw 6.03 m · image
    5.06 × 2.85 m") — the number an installation is planned around, and one
    a cone cannot show. Dropping a picture on a selected spot light sets its
    projection (and takes the picture's own aspect).
  - Lamps only light the scene in RENDERED shading, so the panel says so and
    offers the switch — otherwise a working projector reads as a broken one.
  - **FLAT projection** (`projection.flat`, `render/projectors.ts`) is the
    second half of the feature: the picture is ADDED to surfaces after
    lighting — undimmed, untinted, unaffected by anything else in the room —
    which is how a projection looks in a blacked-out room and how you want to
    see media while placing it. It is projective texturing patched into the
    materials the scene already uses (`receiveProjection` from
    materialManager.apply, one shared uniform block, so a projector moving or
    changing picture recompiles nothing), NOT a separate pass. Measured in a
    blacked-out room: flat 9.4 against 6.5 for the lit path at full lamp
    power and 4.4 for nothing. Because it lives in the material and not in
    the lamp, it shows in EVERY shading mode.
    - The projection matrix IS three's `light.shadow.matrix` (world -> the
      spot's [0,1] frustum) — the same matrix three samples a spot map with.
    - Occlusion reads the light's OWN shadow map (RGBA-packed depth,
      `unpackRGBAToDepth`), so a flat projection is blocked by objects only
      when the light casts shadows (measured: 10.9 -> 9.7 with a box in the
      beam). Two shader traps: `#include <packing>` is ALREADY in every
      material three builds, and including it again redefines every one of
      its functions; and three's loop unroller only substitutes the index
      inside `[ i ]`, so a bound test has to be written
      `UNROLLED_LOOP_INDEX < uFlatCount` or `i` comes out undeclared.
    - MAX_FLAT is 4 (a sampler array cannot be indexed dynamically, so the
      loop is unrolled); patched materials cover meshes and poly meshes —
      grease pencil, splats and actors do not receive flat projections yet.
  - **Edge blend and mask are painted into the projector's canvas**, not into
    a shader, so BOTH paths (the lamp's own map and the flat projector) read
    one picture and cannot disagree. The mask multiplies (black hides, white
    shows, invertible); each edge ramps to black over a fraction of the
    picture with a gamma curve, which is what makes two overlapping
    projectors join without a bright seam. Verified on the painted canvas:
    edge 5, quarter-in 129, centre 255; a half-black mask gives 0 / 255.
  - **Look through a light** (Ctrl+0, `App.toggleViewThrough`): the viewport
    camera BECOMES the light, so orbiting, panning and flying aim it, and a
    spot's cone becomes the field of view — a projector cannot be aimed any
    other way, since you have to stand behind it. Whatever moved the camera
    is written back each frame (through the parent's space when it has one),
    and zooming the view opens the beam.
- **Dropping an image or camera ON a selected object textures it**
  (`App.textureTargetAt` / `applyTexture`): a Library image or camera asset,
  or a single image file from Finder, dropped on a SELECTED primitive mesh
  (not a MODEL or EMPTY), editable mesh or pencil becomes its texture instead
  of a new picture plane. Only selected targets, so a drop near something you
  were not working on still hangs as a picture. A mesh gets it in its
  material's base slot — its OWN material (a shared one is copied first) and
  a NEW image datablock (never overwriting one in use), base colour set to
  white so the image is not tinted. An unrotated SPHERE is stood up (+90 X)
  in a Z-up scene, because three builds it Y-up and a 360 panorama would
  otherwise come out with its horizon vertical (verified: sky on top). A
  pencil gets it on the stroke texture (and the fill when shown); in Edit
  mode with strokes selected, those strokes move to a new material slot so
  the rest of the drawing is untouched. Cameras cannot texture strokes yet
  (the stroke atlas is static).
- **A camera is a Library ASSET** (`io/livesources.ts`), not something the
  capture panel owns. `liveSources.open(deviceId?)` opens a webcam as a
  source keyed `cam:<deviceId>`; each source draws its video into its OWN
  canvas every frame and exposes a CanvasTexture over it. A mesh shows one
  through a texture src of `live:<key>` (`materialManager.textureForSrc`
  resolves it), so the same camera can be on several planes AND under
  detection at once. PAUSE stops the camera and stops redrawing, so every
  consumer holds the last frame — that indirection is why it is a canvas and
  not the video element. Several cameras can be open; the Library's Camera
  button opens the default, or asks which when there is more than one. A
  STREAM asset records `{key, label, deviceId}` and outlives the stream: a
  closed camera's tile reopens it on click, and a saved plane shows a grey
  placeholder until then. Library tiles and the capture preview repaint
  small `canvas[data-live]` copies (`App.paintLivePreviews`) — the source
  canvas itself must never be moved into the DOM, every texture reads it.
  MMCapture takes `{ live: key }` and READS that source (`external`),
  detecting on its frame counter; with none named it uses whichever camera
  is open, else opens the default. The preview browser pane blocks camera
  access: verify with a `canvas.captureStream()` stand-in for getUserMedia.
- **An actor can be a DRAW TARGET** (`TGActor.drawTarget`, the pencil icon on
  its outliner row). `ActorManager.drawTargets` joins the mesh, splat and poly
  lists in `ctx.surfaces`, so Placement: Surface lands strokes on the body
  like any other geometry — verified by drawing across a chest and measuring
  every point 0.4-0.9 mm from the surface. The stick overlay is excluded
  (`sticks.raycast = () => {}`): it is an annotation, and a stroke landing on
  a debug line rather than on the body is not a thing anyone wants. Strokes
  stay in WORLD space; a note that should travel with the character needs the
  GP object parented to a joint, which is the existing constraint and stays a
  separate decision.
- **The shared walking body** (`actor/locomotion.ts`) is where collision and
  ground live, so a character does not collide differently depending on who
  is steering it. `walkVolume.gather(scene, frame)` is idempotent per frame.
- **Possession** (`src/app/possess.ts`) is fly mode driving a body. Fly mode
  owns pointer lock, mouse-look, the WASD key set and the
  Esc-through-pointer-lock cancel; `Navigation.walkDriver` replaces only the
  last step, handing the look angles and keys to a driver that walks an
  actor and then places the camera (1st/3rd person). Nothing there poses the
  character — the gait engine sees the root move and answers, so driving and
  FOLLOW_PATH are the same animation. Collision is world-AABB push-out over
  `meshLocalBounds` (the TRIGGER zones' own bounds), NOT a physics engine;
  anything whose top is within a step height counts as ground rather than a
  wall, which is what makes floors, pedestals and steps all one rule.
  It shares its collision with steering (see above).
- **Simulated tracking sources** (`src/actor/simstream.ts`) let ANY object,
  or an actor's whole skeleton, drive an `MMStream` — sampled through a
  SCENE camera, written into `streamStore` in MediaPipe's exact packing.
  Nothing downstream can tell a simulated visitor from a webcam, which is
  the point: build/test an installation with no hardware, then swap one
  piece for a real input. Driver wiring is RUNTIME state, not scene data
  (`App.setStreamDriver`), so it is re-established after a scene load rather
  than living in the undo snapshot. Sampling runs AFTER the constraint pass
  (a FOLLOW_PATH actor's transform and solved pose must be final first), so
  sim landmarks reach TRIGGER probing one frame late — deliberate.
  `File ▸ New — Demo gallery scene` (`app/demoscene.ts`) is the worked
  example and is code, not a saved .json, so it cannot rot as shapes change.
  Everything in it is filed under EMPTY groups at the origin — Room, Props,
  Cast, Drawing, Sensors — with identity transforms, so parenting is filing
  and not a transform. Sixty objects in a flat list is a scene you navigate
  by reading names. The cast is three characters in three looks (wooden on
  rails, clay on a script, a MINIMAL stick figure on a shorter round that
  crosses the others' paths on purpose).

## Where to pick up (roadmap, rough priority)

NPR brush engine, canvas retirement, object mode, and the N1–N8 Blender-
parity series are all done — see `docs/HANDOFF.md` "Session log" for the
full list of what shipped and its detail lives in
`docs/IMPLEMENTATION_PLAN.md` (one `##` heading per feature, in commit
order). Don't re-derive status from this file; it drifts, HANDOFF is the
live source.

Open items, current priority order:

1. **N8 splat nibs** (paint with splats): the texture-atlas prerequisite
   is DONE (`src/render/atlas.ts` — one atlas bound as `uAtlas`, per-vertex
   `aTexRect`), so what remains is the Spark in-memory splat-construction
   research spike (existing splat code only reads via `forEachSplat` for
   PLY export).
2. **Perf pass** (before heavy scenes): incremental/dirty-region geometry
   rebuilds in `GPSceneRenderer` (currently full rebuild per dirty
   layer), instanced segments, worker-side bucket fill.
3. **Legacy traveler/trigger consolidation**: `score.cursors` /
   `score.triggers` (Bindings tab) and the new constraint system
   (`src/score/constraints.ts`, FOLLOW_PATH/TRIGGER on any object) run
   side by side. Now that constraints are proven out, consider migrating
   the legacy entities onto constraints to collapse the duplication.
4. **Camera bookmark transitions**: eased "jump to camera N over t
   seconds" action for live performance (nav has `startAnim` easing to
   build on).
5. **Live performance**: audio-reactive modifier params, timed
   stroke-replay (action painting playback) — MIDI/OSC binding already
   exists via routes.
6. **Parity leftovers** (PLAN.md unchecked): SVG import/export, curve
   edit mode, armature/lattice parenting.

## Repo hygiene

- Private repo `github.com/languel/threegrease`, branch `main`.
- Run `npm run typecheck` before committing; commit messages describe the
  feature set; push after each coherent feature pass.
