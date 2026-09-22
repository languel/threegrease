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
- **ANGLE FIELDS SHOW DEGREES; the data stays radians** (`core/angleinput.ts`,
  `settings.angleUnit`, `NumOpts.angle`). The G/R/S overlay always said
  "Rot: 30.0°" while the field under it said 0.524 — one of the two was
  lying about what the app works in, and it was the field. A field marked
  `angle: true` takes and returns RADIANS (so callers and the scene are
  unchanged) and works internally in the display unit, which is what makes
  scrubbing, the arrows, min/max and the reset value all land in whole
  degrees. The step is the display unit's own — a radian step shown in
  degrees scrubs at 57 degrees a pixel.
  Typing carries its own unit, so the setting only decides what a BARE
  number means: `30deg`, `0.5rad`, `pi/2`, `0.5 pi`, `2pi`, `-2*pi/3`.
  Three things it has to get right:
  - PI IS A RADIAN UNIT. `pi/2` read as 1.57 DEGREES because the panel
    happens to be in degrees is the most confusing answer available.
  - NO LEADING `\b` in the unit patterns: there is no word boundary between
    a digit and a letter, so `45deg` and `2pi` — which is how they are
    actually typed — matched nothing and the unit was silently ignored.
  - The evaluator is a small recursive-descent parser, NOT `eval` or `new
    Function`. A number field is somewhere a pasted string lands, and an app
    that evaluates arbitrary JavaScript there has handed the page over.
    Implicit multiplication is allowed ONLY against pi, or "1 5" would
    quietly mean 5.
- **The light GIZMO is draggable, Blender-style** (`App.lightHandlePoints` /
  `dragLightHandle`, rings in `LightManager.makeRing`): a spot's cone rim
  and the ring inside it where the soft edge begins, and a point light's
  reach. A cone angle typed into a field is a number you then have to go and
  look at; the ring IS the edge of the light on the wall. Everything is
  measured in the beam's own frame — the pointer ray is met with the PLANE
  the rings lie in, and the radius there says what the angle or the blend
  must be.
  A POINT light has no orientation, so its reach ring has no plane of its
  own that is not arbitrary: drawn in the lamp's own XY it is edge-on from
  any level view (which is most of them), where the ray never meets the
  plane and the drag silently does nothing. It faces the CAMERA instead
  (`LightManager.viewQuat`), and the drag uses the view plane to match.
  The ring is scaled to the beam, so its grab square is scaled back by the
  same factor to hold one size — and the square is built around its OWN
  origin and then positioned, because scaling geometry that carries the
  offset drags the handle toward the centre instead.
  All of these handles are grabbed in the CAPTURE phase and in order —
  keystone corner, then cone/blend, then the aim ring — since they sit on
  the same wall as each other and as the object picking underneath.

- **AN ICON-ONLY BUTTON IS FLAT** (`.ib`, `styles.css`): no frame and no
  fill at rest, a quiet fill on hover, and a SLIGHT accent-tinted fill when
  it is on — the Properties tabs' look, applied to every toolbar. A toolbar
  is a row of choices, and a box round every one of them drew the eye to the
  boxes; the selected one is the only one that should read as a shape.
  `btn()` sets `.ib` itself from what the button CONTAINS (an svg and no
  text), so a new toolbar button gets the look for free and a labelled
  button in a panel keeps its frame — there, the frame is what tells a
  clickable "Look through" from a line of text. The one exception is a
  button built EMPTY and filled afterwards (`UI.iconMenu`), which cannot be
  classified at construction and says `ib` in its own `cls`.
- **THERE IS ONE ADD LIST** (`UI.addMenuItems`), nested the way Blender's
  is: Stroke, Object ▸, Light ▸, Projector, Camera, Empty, Actor, From the
  Library ▸, Import ▸. There used to be two — the menubar's flat Add and
  Shift+A's popup — and they had already drifted (the platonics in one,
  Editable Mesh and the lights in the other, icons in only one). Both now
  build from this function: the menubar's Add opens the shared popup under
  its own button instead of a menubar list, since menubar lists carry
  neither icons nor submenus, and Shift+A appends only its pointer-relative
  entries (Traveler here, Trigger here, Move cursor). Lights wear the
  outliner's glyphs, so a light found in the menu looks like the light it
  becomes. "Grease Pencil" is called STROKE in the menu, which is what it
  is to anyone who has not used Blender.

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
- **Tools of one kind share ONE toolbar button** (`ToolGroup` in
  `TOOLS_BY_MODE`, `UI.toolGroupButton`), Blender's flyout: the button shows
  the member in use (else the last one picked, remembered in localStorage
  `threegrease.toolGroups`), a corner mark says there are more, and HOLDING
  it, right-clicking it or clicking the mark lists the family. W cycles the
  `select` family (`cycleSelectTool` -> `UI.cycleToolGroup`). The toolbar's
  30 px buttons sit in a 3 px gutter and the top bar's mode buttons
  (`tb-mode`) use the same size and gutter, so the two columns line up.
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
- **A SNAP MUST NOT SEE WHAT IT IS MOVING** (`setRaycastExclusion` /
  `ignoredBySnap` in `tools/projection.ts`). Every draw target is a snap
  target and the object being dragged is a draw target like any other, so
  with Surface or Face snapping the first thing under the pointer while you
  drag a sphere is THE SPHERE: the snap puts it on its own surface, which
  moves it closer to the eye, which puts it under the pointer again — it
  walks up the ray until it is wrapped around the camera. It reads as "the
  object snapped to the camera" and it is a snap chasing itself. A stroke
  already had this problem and this answer (`setStrokeExclusion`); this is
  the same rule one level up. The object modal, the transform widget and
  the object-draw draft all set it (the draft is a draw target from the
  moment it exists, so a Surface placement would grow it into its own face).
  The same filter drops EDITOR FURNITURE — anything `markOverlay`ed. The
  gizmo alone hides a 90,000-unit invisible drag plane, and a snap that can
  land on it can land anywhere.
- **Placement: Nearest has a Target** (`settings.nearestTarget`,
  `pickElement` in `polypick.ts`): Element (the old priority chain), Vertex,
  Edge, Face, and DRAW TARGET — "anything I could draw on", the same list
  Surface placement uses, which is how you put one object ON another
  whatever it happens to be made of. A camera is never a draw target, so it
  is never in it.
  VERTEX and EDGE reach CONVENTIONAL MESHES, not just the things whose
  points live in `GPScene`. They used to offer poly vertices, stroke points,
  splat centres and the corners of whichever triangle was UNDER the pointer
  — so snapping to the corner of a plinth meant hovering one of its faces
  first, and a corner approached through empty space offered nothing, which
  is most of what a blockout is made of. `meshElements` walks the render
  geometry in screen space instead.
  **THE BUDGET IS THE WHOLE DESIGN THERE**: walking a geometry per
  pointer-move is fine for primitives (a box is 24 vertices, a UV sphere
  561) and absurd for a room scan (162k, on every move, while dragging), so
  a mesh over `VERT_BUDGET` (3000) is skipped and keeps the
  triangle-under-the-pointer answer — exact where you are pointing, one
  raycast. Small things you snap to from anywhere; enormous things you snap
  to by pointing at them. Mesh "edges" are still the renderer's triangles,
  so a box face's diagonal counts.
- **SELECTING A CAMERA DOES NOT MAKE IT ACTIVE.** It used to, on the theory
  that "the camera I am working on" and "the camera the scene renders
  through" should be one thing. They are not: selecting is how you reach a
  camera's properties, move it or parent it, and having the render jump
  every time you touch one is a change you did not ask for. Making it active
  is its own button on the row, with its OWN icon (`cameraActive`, a camera
  body with a filled centre) — beside the visibility eye, a second eye read
  as a second visibility toggle. Clicking it when it is already active looks
  through it.
  `lookThroughCamera(on?)` takes an explicit state for callers that just
  switched which camera is active — "look through camera 2" while already
  looking through camera 1 must not read as "you are looking through
  something, so stop". With no argument it toggles, which is what the
  outliner wants. It used to re-apply the pose when already in camera view,
  so "Stop looking" could never stop: a toggle that cannot untoggle.
- **A new object's colour is WHITE.** For an IMPORT the field is a TINT that
  multiplies the file's own colours, so anything else quietly darkens every
  scan and model brought in — the old blue-grey default took them to 62%
  before they had been looked at. For a primitive it is the base colour, and
  white is what anyone expects to then paint. One default, and it is the
  identity for both meanings.
- **The app opens in OBJECT mode**, not DRAW. The first thing anyone does
  with a scene is look at it and move something; opening with a pencil in
  hand means the first click draws a stroke nobody asked for.
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
  Neither a camera nor a lamp wears the selection BOX: a box round a helper
  describes the helper's arbitrary drawing size, not anything in the scene,
  and both of them are already nothing but an outline. The origin dot stays.
  Its Properties panel carries what a projector's does, because a lens is
  ONE model read in two directions: the same `lensRows` (type, presets, the
  Bourke polynomial, shift), plus field of view shown BOTH ways — degrees and
  the 35 mm-equivalent focal length, `12 / tan(fov/2)`, since three's fov is
  VERTICAL and 35 mm film is 24 mm tall (using the 18 mm half-WIDTH there
  calls a normal lens 75 mm) — the clipping range (`near`/`far`, applied
  while looking through and restored on the way out), and the key count with
  Key here / Clear. The Scale row is hidden for a camera, which has no
  size and would not have accepted the value.

- **Shift+D's last branch must not be "anything else is a mesh".**
  `duplicateSelectedObjects` ended in an `else` that looked the ref up in
  `scene.meshes`, so every kind it did not name — LIGHT, CAMERA, ACTOR,
  STREAM, TRIGGER — found nothing and was skipped in silence. Duplicating a
  projector simply did nothing, with no error anywhere. (A MEASURE had hit
  this before and was fixed by adding one more branch above the trap rather
  than removing it.) Each kind is named now and the shared branch copies
  through its own list; a TRIGGER's position field is `position`, not
  `translation`.

- **A transform has a FRAME and a PIVOT, and they are settings**
  (`settings.transformOrientation` / `transformPivot`, the maths in
  `tools/orientation.ts`, the two icon dropdowns to the LEFT of the
  placement cluster). They are a step earlier in the same sentence the
  placement cluster finishes: these decide the frame a transform is
  expressed in, the placement decides where the result lands.
  - ONE representation: a world-space orthonormal BASIS (Global, Local,
    Normal, Gimbal, View, Cursor, Parent), and `constrainDelta` projects the
    world delta into it, keeps what the lock allows and brings it back.
    GLOBAL is the IDENTITY, so the plain world-axis masking both modals used
    to do by hand falls out of the general case unchanged — which is what
    makes this safe to put under every existing gesture.
  - Both modals read this file (`objectmodal.ts` for objects,
    `transform.ts` for stroke points and mesh vertices), so the two editors
    cannot drift into meaning different things by "X".
  - The basis is FROZEN when the gesture starts, as Blender does: changing
    the header mid-drag must not swing what is already moving.
  - Scaling along a LOCAL or NORMAL axis is `B·S·B⁻¹` about the pivot, not a
    world-axis scale — the world-axis form shears the object as soon as the
    basis is turned.
  - GIMBAL is an ALIAS for Local, on purpose: our rotations are stored as
    XYZ eulers, whose first axis IS the local X. Listing it keeps the menu
    Blender's without pretending to a decomposition we do not have. CURSOR
    is the world's basis AT the cursor for the same kind of reason —
    `scene.cursor` is a Vec3 and carries no rotation to orient by — and it
    still differs from Global as a PIVOT, which is the half people reach for.
  - PIVOT: Median (the average of the origins, what the app always did),
    Bounding Box (the centre of everything the selection spans — a different
    point whenever the selection is lopsided, verified: 2.5 against the
    median's 3.0 with one box scaled x3), Cursor, Active, and INDIVIDUAL,
    which has no single point at all. For that one the modal hands the App a
    delta PER OBJECT (`onDeltaEach`, `applyWorldDelta` takes a factory), each
    about its own origin: verified as four boxes turning in place, positions
    unchanged and every rotation 90 degrees.
- **N moves along the NORMAL, Shift+N across it** (`setNormal` on both
  modals). It is the move no axis lock can name once a surface is turned,
  and pulling a wall straight out of itself is most of what blocking out a
  room consists of. In OBJECT mode the normal is the object's own +Z — a
  plane, a panel, a projection screen and a dropped picture all face that
  way; in mesh EDIT it is the average normal of the SELECTED FACES, by
  Newell's method so a slightly non-planar n-gon still answers, and with
  only vertices selected it falls back to the mesh's own up. N and the axis
  keys share one slot, so either clears the other. Verified on a panel
  turned 45 degrees: along-normal motion came out exactly parallel to the
  normal, Shift+N exactly perpendicular (dot product 0), and a box face
  extruded with N moved purely along its own local X with y and z at zero.
- **Ctrl inverts the magnet in EVERY drag, not just the object modal.** It
  already did there; the stroke/mesh modal (`ModalTransform.snapInvert`) and
  the transform WIDGET (`App.modKeys`, since TransformControls never hands
  us the event) were the two places the same key did nothing. Verified with
  the magnet off: a free drag landed at 2.506 and the same drag with Ctrl at
  exactly 2.500.

- **The outliner has keyboard focus when the last pointerdown was in it**
  (`App.outlinerFocused`; rows are divs rebuilt on every refresh, so DOM
  focus cannot say). X, Delete and Cmd+Backspace then delete the SELECTED
  OBJECTS in any mode — in Draw or Edit mode X otherwise means "delete
  strokes", which is not what clicking a row in the object list asks for. A
  drawing mode that deletes its last pencil gets a fresh one.
- **A NEW OBJECT ARRIVES IN YOUR HAND** (`App.placeNew` / `placeArmed`).
  Everything added from a menu lands at the 3D cursor, which is almost never
  where it goes, so every add was followed by the same three steps: find it,
  select it, press G. Now the new object is selected and a MOVE is ARMED —
  the next pointer move over the viewport picks it up, a click puts it down,
  and Escape leaves it at the cursor, the one position you are sure of. The
  whole gesture is the existing object modal, so axis locks, N, the magnet,
  typed values and Ctrl-inverts-snap all come with it.
  ARMED, NOT BEGUN, is the trick: the pointer is over the MENU when the
  object is added, so a modal started there measures its delta from a
  position the object has nothing to do with, and the thing JUMPS the moment
  the cursor comes back over the viewport. Waiting for the first move starts
  the gesture exactly where the pointer is.
  The grab passes `undo: false` (`ObjectModalTransform.begin`), because the
  add already pushed a step — two would mean an undo that puts the object
  back at the cursor and leaves it there. Verified: one undo removes the
  whole add. A DROPPED asset is not armed: it is already where you put it.
- **A PROJECTOR IS AIMED BY DRAGGING THE SPOT IT MAKES** (`App.aimHandleAt`
  / `aimLightAt`, the ring in `LightManager.makeAimHandle`). A lamp has no
  face to grab: the transform widget turns it about its origin, and you have
  to already know which way its -Z went to predict what that does, so aiming
  through the widget is guesswork; "look through the light" (Ctrl+0) works
  but means leaving the view you were working in. The handle is the beam's
  own target, drawn where the beam LANDS — `projectorThrow` measures it, so
  the ring sits on the wall being lit — and dragging it turns the lamp to
  keep pointing at it, which is how a real one is aimed: by watching the
  light. The drag aims at whatever SURFACE is under the pointer, so the spot
  follows the geometry across a room, and falls back to the view plane at
  the current throw distance over open space. `Aim at cursor` in the panel
  is the exact form of the same thing (verified: the beam lands on the
  cursor to 3 decimal places).
  Two things it has to get right: the handle is grabbed in the CAPTURE phase
  before anything else can claim the click, since it sits on a wall and the
  wall would be picked instead; and the rotation is written in the light's
  PARENT space like every other object's, or a projector filed under a group
  aims somewhere else entirely.

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
- **A SUN IS INFINITE, so its shadow box has to be FITTED** (the
  DirectionalLight branch of `LightManager.apply`, fed by
  `App.shadowFocus`). Its shadow camera is ORTHOGRAPHIC and three fits it to
  nothing: the fixed box this used to carry (24 m square, 60 deep, hung at
  the lamp's own position) ends somewhere in the middle of any real scene,
  and the edge is VISIBLE — a straight line across the floor with shadows on
  one side and none on the other. The unshadowed side reads as BRIGHTER,
  which makes it look like a mysterious half-plane "behind the sun" rather
  than like a frustum running out.
  The box is fitted to the scene's bounding SPHERE, which is the one shape
  that needs no re-fitting as the light turns: the extents are its radius
  from any direction, and near/far span it along the light's own axis. The
  lamp is NOT moved to fit — a directional light's shadow depends only on
  its direction and this box, and moving it would move the glyph someone
  placed. `Box3.setFromObject` reads each geometry's cached bounding box, so
  recomputing per frame costs a matrix transform rather than a walk over a
  162k-triangle scan.
  **THE BIAS HAS TO FOLLOW THE BOX.** `shadowBias` is in the shadow map's
  own depth units, so one value cannot serve a 10 m box and a 100 m one:
  fitted to a big scene the texels cover tens of centimetres and a flat
  floor shadows ITSELF everywhere inside the frustum. That is invisible as
  acne and very visible as a STEP at the frustum's edge — measured on a 60 m
  floor, 210-214 inside against 225 outside, which is the same "half-plane"
  symptom wearing a second hat. `normalBias` is in WORLD units, so scaling
  it with the texel's world size holds across any fit.
- **The default AMBIENT and SUN are not in the same place.** An ambient
  light has no position — it is uniform — but its glyph has to be
  somewhere, and sitting it exactly on the sun's put two different lights
  under one ring: clicking picked whichever was tested first, and the scene
  looked like it had one lamp.
- **A new scene has exactly one camera, on purpose.** `activeCam` and the
  timeline's camera row assume one exists, and `deleteObject` refuses to
  remove the last — a scene with no camera would need every one of those
  paths to grow an empty case for no gain. Blender ships a default camera
  for the same reason.
- **A `TRIGGER` takes its SHAPE from its carrier, and `radius` is often
  ignored.** On a BOX/SPHERE/CYLINDER mesh it tests that primitive's own
  local bounds; on a PLANE it is a crossing detector; on a POLY it tests the
  topology. `radius` ONLY applies in the fallback sphere case — a carrier
  with no geometry (an EMPTY). Putting a proximity zone on a box therefore
  silently gives you a box-sized zone and no error. Use an EMPTY for
  "within N metres of", a primitive for "inside this volume".
- **A new primitive is STOOD UP when it is created** (`standUpRotation` in
  `render/meshes.ts`, used by `createMeshObject`): every caller that cared
  used to fix the Y-up convention by hand afterwards and the Add menu did
  not, so Add ▸ Cylinder gave you a column lying on the floor and Add ▸
  Pyramid one on its side. A SPHERE is in the list too, and not for looks:
  its poles (and so the whole UV seam a 360 panorama is wrapped on) ran
  along X. BOX and the platonics are not — they have no meaningful axis to
  stand up, and turning them would only re-label which face is the top.
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
  THE SELECTION HULL IS RETIRED: a mesh wears the render SILHOUETTE with
  everything else now. The hull is drawn IN the scene, so against a room
  scan its rim is cut by whatever stands in front — a box being placed on a
  scanned floor came out half outlined — while the silhouette renders the
  object ALONE into a mask and shows the whole shape through anything. It
  also means one mark reads as "selected" everywhere: a mesh, a drawing, a
  scan and a character all look the same. The hull stays for HOVER
  (`MeshManager.setHover`), where it costs nothing and is never occluded for
  long, and an EMPTY keeps its line glyph since it has no surface at all.
  THE OBJECT BEING DRAWN wears it too, before it is selected
  (`ObjectDrawHost.drafting` -> `App.draftRef`, applied in
  `syncTransientHighlights`): the thing you are dragging out is the one
  thing on screen that has to be readable, and on a scanned floor it is a
  pale box against a pale floor. Because the rim comes from the object
  rendered alone, you can drag a plinth out behind an existing one and
  still see its shape.
  The inverted hull's own history is worth keeping, since the reasons still
  apply to the hover: Selection used to be a world-axis-aligned
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
  - A MEASUREMENT ATTACHED TO ONE OBJECT (`App.measureTarget`: every bound
    point on the same object; free points allowed) can move that object:
    - "is really N" rescales the OBJECT (default) or the whole scene, about
      the measurement's first point (`scaleObjectToMeasure`).
    - ALIGN pairs its points with another measurement's BY CLICK ORDER and
      moves, turns and (optionally) scales the object so they coincide —
      corners of a pedestal in a scan onto the same corners of a virtual box
      of known size (`alignByMeasures`, `core/align.ts`: Horn's quaternion
      closed form, least squares, reports RMS and worst residual). A unit
      quaternion cannot mirror, so there is no reflection case to guard.
      Verified: an exact pair lands to 5e-16 and recovers scale 0.625 for a
      1.6x-oversized copy; eight corners picked ±2 cm fit to 9 mm RMS with
      scale 0.623. Because the source points are bound, they ride the
      object and visibly land on the targets.
    - ANY TWO MEASUREMENTS ALIGN, not just identical ones (`alignShapes`
      in core/align.ts), in stages:
      1. same count: every ORDER (all permutations up to 8, every start and
         direction beyond), and the order AS CLICKED wins whenever it is as
         good as the best — a box has 24 equally exact orders, and only
         yours keeps the scan's contents the way round you meant;
      2. different counts: HYPOTHESISE AND VERIFY — the widest triangle of
         the smaller set against every ordered triple of the larger, each
         transform verified by every smaller point landing on a DISTINCT
         larger one. Needs FOUR points: with three, the seed triangle is all
         there is to verify with and any similar triangle passes (along a
         traced edge there are plenty, at the wrong scale). Ties are broken
         by COVERAGE — the unpaired points must lie on the other shape, or
         four corners fit a traced outline's midpoint square exactly, 45
         degrees round and √2 small — and then by the least turn;
      3. otherwise a SHAPE FIT: principal axes for a first guess (all 24
         relabellings), then ICP with correspondences taken BOTH ways and
         onto the other measurement's LEGS, not its samples — one-way ICP
         with free scale shrinks the source into a corner, and snapping to
         samples read a traced L 6% small.
      AMONG EQUALLY GOOD FITS THE LEAST TURN WINS (`leastTurn`): a flat
      measurement cannot say which side the object is on, and a shape fit is
      as happy with the pedestal hanging upside down from its own top.
      Verified against a known answer (a scan 1.6x oversize, turned 63
      degrees): 8 corners shuffled, 6 of 8, a top outline from another start,
      4 corners against an outline traced with midpoints — all exact; 5 of 8
      picked ±1.5 cm off — within 9 mm; a 9-point traced L against its 3
      corners — scale 0.6249 of 0.625.
    - THE MAGNET'S VERTEX / EDGE MODES ARE THE ELEMENT PICKER
      (`pickElement` in polypick.ts, exported for it): they used to offer
      stroke points only, so over a mesh the magnet did nothing and a
      measurement point slid over the surface under Placement: Surface —
      no way to put one exactly on a pedestal's corner. Now every vertex the
      app knows competes by screen distance (poly vertices, stroke points,
      splat centres, primitive corners within VERT_BUDGET, and on a big
      scan the corners of the triangle under the pointer), and the hit
      carries its OBJECT (`ConstructionHit.ref`) so the point binds.
      Verified: a click 11 px off a box's top corner landed on box-local
      (0.5, 0.5, 0.5) exactly, bound to the box.
    - WHAT THE MAGNET CATCHES IS A GLYPH AND A CURSOR, not a word
      (`drawSnapGlyph` / `snapCursor` in snapping.ts, `App.drawSnapHover`):
      the same shapes as the Snap Target icons — ring = vertex (empty, so
      the vertex shows through), rails = edge, ring on a diagonal =
      midpoint, right-angle corner = perpendicular, square with a dot = face
      centre, square = surface / face, hexagon with a dot = origin, # =
      grid — drawn round the target with a leash back to the pointer, and
      worn by the cursor itself (an SVG data-URL cursor, one per kind) for
      every tool that places points. A label was legible only when nothing
      else was near it. The hover is re-snapped only when the pointer or
      the camera moves.
    - A point placed ON A SCAN binds to it: the magnet's Vertex and Surface
      modes fall back to the nearest splat centre and carry the splat as the
      hit's ref (a scan that is not a draw target has no surface to raycast,
      and without the ref the point was free and the scan could not be
      aligned by it).
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
- **AN IMPORT IS SINGLE-SIDED, and that is the DOLLHOUSE VIEW.** A room
  scan is captured with its normals facing INWARD, so with backface culling
  the wall between you and the room is simply not drawn and you look
  straight into it from outside — how a scanned space is planned in, and
  what Blender gives you for free. `createMeshObject` therefore defaults
  `doubleSided` to FALSE for anything with a `src`; forced two-sided (what
  it used to do) the same scan is a sealed box you can only see the outside
  of.
  It is not only a display choice: **three's raycaster honours
  `material.side`**, so a wall you can see through is a wall you can reach
  THROUGH. Verified on a 162k-triangle gallery scan — a ray through the
  middle of the view lands on the FLOOR at z = 0.09, not on the near wall,
  and Nearest snapping (Element / Vertex / Edge / Face) lands there too,
  because every one of those paths goes through a raycast. That is the
  whole of the "culling" a staging tool needs: no separate facing test, and
  nothing that can disagree with what is on screen.
- **An import's DISPLAY is ours; its materials are the file's**
  (`UI.importDisplayRows`, the MODEL branch of `MeshManager.apply`). An
  import is usually reference — a scan to plan inside, a backdrop, something
  to trace — so it needs the same view controls as everything else, applied
  ON TOP of what the file says rather than replacing it: the tint
  MULTIPLIES the file's own colour (kept once in `userData.baseColor`, so
  white restores the import exactly), Unlit moves the file's map into
  EMISSION rather than swapping the material class and losing its maps, and
  opacity, two-sided and wireframe are direct.
  WIREFRAME shading wins over the object's own flag and is UNTEXTURED, like
  Blender's: a wireframe that still samples the map paints every line with
  the picture, and at a scan's density (160k triangles for one room) the
  lines cover the surface completely — it looks exactly like the solid view
  it was meant to replace. The map is stashed in `userData.baseMap` and put
  back on the way out.
  Anything that changes the shader PROGRAM — adding or removing a map —
  is done only on the transition, with `needsUpdate` set there and nowhere
  else. Setting it every frame is a recompile every frame, which reads as
  "the app got slow after I imported a scan".
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
- **A PLACED VIDEO IS ITS OWN PLAYER** (`instanceMediaSrc` in
  `render/meshes.ts`, `UI.mediaInstanceRows`). A camera is one device and
  everything showing it shares the frame; a VIDEO or GIF is not — two
  planes showing the same file are two screens in a room, and one of them
  held on a frame while the other runs is the normal case, not an exotic
  one. An object's media texture is therefore tagged with the object's own
  id (`live:media:<ref>#<id>`) and gets its own player, position, rate and
  paused state; the panel carries Play/Pause and Speed for THAT object.
  Verified with two planes on one file: pausing one froze it at 0 frames
  while the other kept advancing at 0.25x.
  THE LIBRARY'S OWN COPY RESTS: a tile is a picture of what the file is,
  not a screen, and twenty tiles decoding at once cost the frame budget of
  the scene you are working in. Speed for a GIF divides each frame's stated
  duration, since its clock is ours; for a video it is `playbackRate`.
- **A texture slot picks from the LIBRARY first, a file second**
  (`UI.pickPicture`). Every slot used to open a file dialog, which is the
  wrong way round once a Library exists — the picture is nearly always one
  you have already brought in, and a file dialog cannot offer a CAMERA or a
  video at all. "From a file…" is still there and adds what it picks to the
  Library on the way past, so the second use of a picture is a click.
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
    k4θ⁴, θ in RADIANS from the axis. Blender's "Fisheye Lens Polynomial" is
    the same polynomial with r in sensor mm; k0 is its offset term, kept for
    that reason. Equisolid can be given as focal + sensor mm instead, which
    decides the covered angle (`effectiveFov`: θ = 4·asin(sensor / 4f)).
  - **A POLYNOMIAL IS NORMALISED TO ITS OWN EDGE**, r(θ) / r(fov/2). It
    gives the SHAPE of the mapping, not an absolute screen radius: a
    published set is a fit over that lens's own range in whatever units it
    was measured in, and Bourke's own 190° example only ever reaches
    r = 0.73 — it turns over at about 72° and is negative by 180°. Read as
    screen radius directly (what this did at first), everything past
    r = 0.73 has NO solution: Newton walks off, those pixels sample
    backwards, and the picture collapses into a small disc in the middle of
    a black frame. It reads as "the fisheye zoomed to the centre", and
    scrubbing the coefficients to fix it only makes it worse.
    Dividing by the value at the half field puts the image circle exactly at
    the half field — and it is also what makes FIELD OF VIEW mean something
    for this type, which it previously did not: the shader used it only as a
    Newton seed, so the control sat there doing nothing. The inverse solves
    poly(t) = r · poly(halfFov) the same way.
  - **Your own lenses can be saved** (`customLenses` / `saveCustomLens` in
    `render/lens.ts`, "Save this lens as…" in the presets menu). A dome
    projector or a 360 camera in a real room is a specific piece of glass,
    measured once — often by the person using it, off a photograph of a grid
    — and used for years. They live in localStorage, not in the scene,
    because a lens belongs to the room's equipment rather than to one plan
    of one show, and they are named INLINE rather than through `prompt()`,
    which an embedded browser can refuse.
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
  - The aim ring, the cone and blend rings and the keystone corners all wear
    the light's SELECTION colour: they are parts of one gizmo, and a second
    accent would read as a different kind of thing.
  - Lamps only light the scene in RENDERED shading, so the panel says so and
    offers the switch — otherwise a working projector reads as a broken one.
    That rule is about the LIGHT, not the glyph: hiding the whole group
    (`lights.group.visible`) took the wire beam with it, so in Solid or
    Wireframe a projector was a selection dot with no beam — nothing to see
    it by and nothing to aim. `LightManager.lightsEnabled` stands the lamps
    down instead, and the glyph is drawn in every shading mode like a
    camera's frustum.
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
  - **WHICH WAY UP THE PICTURE LANDS is the SHADOW CAMERA's business, not
    the light's rotation.** Both paths sample through `light.shadow.matrix`
    — three's own spot map does, and so does the flat projector — and that
    matrix comes from a lookAt whose ROLL is resolved against
    `shadow.camera.up`, which three leaves at world +Y. In a Z-up scene that
    is sideways, so every projector threw its picture a quarter-turn over.
    Measured on the shadow matrix before the fix: moving UP in the world
    raised its u and moving RIGHT lowered its v. `LightManager.apply` points
    that up at the LAMP's own +Y instead, so the picture follows the
    projector's roll the way a real one does — and it is what makes
    `projection.rotation` and the beam glyph's up arrow agree with what
    lands on the wall.
    The same trap in the other direction is `App.aimRotation` (shared by
    `addProjector` and `aimLightAt`): `lookAt` resolves ITS roll against the
    object's `up`, which defaults to +Y, and a projector aimed across a Z-up
    room looks almost exactly along that — leaving the roll arbitrary. The
    up reference has to be the SCENE's. A new projector used to be built
    inline without that and came out rolled.
  - **KEYSTONE: the four corners of the picture are draggable**
    (`TGProjection.corners`, `drawQuad` in lights.ts, the handles in
    `App.keystoneCorners` / `setKeystoneCorner`). A projector is hardly ever
    square to what it throws at — it hangs above the screen, it sits off to
    one side, it shares a wall with another one — so the picture lands as a
    trapezium, and pulling each corner onto the real corner of the screen,
    the doorway or the next projector's edge is what projection mapping IS.
    - A corner is stored as (u, v) in the BEAM's own square frustum, so the
      shape survives moving and re-aiming the projector (verified); its
      world position is derived by casting the beam's own ray for that
      (u, v), never stored.
    - Canvas 2D has no projective transform — `setTransform` is affine, and
      an affine map cannot turn a rectangle into a trapezium — so the image
      is subdivided 16x16 and each cell drawn affinely through the true
      HOMOGRAPHY's corner points. A bilinear blend of the four corners is
      the obvious cheap version and is the wrong map: it bends straight
      lines, and the whole point is that the picture's edges land straight
      on the edges of the thing being projected at. Cells are drawn with a
      hair of overlap and clipped to their own triangle, or the seams show.
    - It is painted INTO the same canvas inside the same clip, so Rotate,
      Mirror, the mask and the edge blend all compose with it and both the
      lit and flat paths see one picture.
    - The beam glyph draws the KEYSTONED quad, not the rectangle it would
      have been — a wireframe still showing a rectangle after the corners
      were pulled is a drawing of a projector nobody has.
  - **Edge blend and mask are painted into the projector's canvas**, not into
    a shader, so BOTH paths (the lamp's own map and the flat projector) read
    one picture and cannot disagree. The mask multiplies (black hides, white
    shows, invertible); each edge ramps to black over a fraction of the
    picture with a gamma curve, which is what makes two overlapping
    projectors join without a bright seam. Verified on the painted canvas:
    edge 5, quarter-in 129, centre 255; a half-black mask gives 0 / 255.
  - **A curved lens is DERIVED as round and flat, never written into the
    record.** The panel used to set `aspect: 0, flat: true` when you picked a
    fisheye, and nothing put them back: switching to a pinhole again left the
    picture round and unlit, which reads as "the projector broke". The stored
    Shape and Flat stay the user's; `applyProjection`, `paintProjection` and
    `syncFlatProjectors` each ask `isCurved(p.lens)` at the point of use, and
    the panel shows the overridden values with a tip saying the lens is
    deciding. The paint key carries the lens type too, or the canvas is not
    repainted on a swap.
  - **A lamp that is not carrying the picture is turned OFF** (`light.visible
    = false` while flat or curved). Otherwise it washes the wall with a plain
    white cone BESIDE the picture the material pass is drawing — the "a
    light's spot appears" bug, and it is worst under a curved lens, where the
    frustum spot has nothing to do with where the picture lands. A projector
    with no source at all lights normally again.
  - **The beam glyph carries an UP ARROW while it throws a picture.** A
    projector is the one light whose ROLL matters and a cone cannot show it —
    a frame hung upside down or quarter-turned looks exactly like a correct
    one until you light it. The arrow rides just outside the beam's edge at
    the far end, along the picture's own up. That direction is +y in the
    light's frame: the canvas is painted y-DOWN and a CanvasTexture is
    uploaded flipped, so v = 1 (the canvas's top row) lands at +y, and the
    paint's `rotate(θ)` takes the image's top to (sin θ, cos θ) there. MIRROR
    is NOT part of it — `scale(-1, 1)` negates x only, so a rear-projected
    picture reads backwards but stands the same way up, and folding the flip
    in pointed the arrow at the floor. Verified by sampling the painted
    canvas through three's own shadow matrix at points around the beam: at 0
    the picture's top lands up and the arrow is world +z; at 90 degrees both
    move to +x; at 180 both point down; mirrored, both stay up.
  - **THE AIM HANDLE IS FOR ANYTHING WITH A DIRECTION**, not just a
    projector: a SUN and an AREA light get one too. A sun's position means
    nothing to the lighting and everything to the PLANNING — "the light
    comes from over there, at that angle" is the thing being decided — and
    turning it through the transform widget means already knowing which way
    its -Z went. `App.beamReach` puts the handle where the beam actually
    lands (a spot has its throw readout; a sun and an area light have no
    falloff, so it is simply the first thing they are pointed at, or an
    arm's length over open space). Only AMBIENT and POINT have nothing to
    aim.
  - **AREA lights are three's `RectAreaLight`**, and the limits are real
    enough to say in the panel rather than let someone discover: it casts
    NO SHADOW of any kind, and only standard/physical materials respond to
    it — so grease pencil, splats and anything unlit are untouched. It is
    the right light for the soft wash a real soft box gives a wall, and the
    wrong one when the shadow is the point. Two more things it needs:
    `RectAreaLightUniformsLib.init()` must run once before any of them can
    be lit (without it the light is silently BLACK, which reads as a broken
    light rather than a missing init), and its intensity is radiance over
    its own surface, so a big soft box at a point light's 20 blows the room
    out — the default is 6. `width`/`height` are scene data in metres and
    the glyph IS that rectangle, scaled to match.
  - **Look through a light** (Ctrl+0, `App.toggleViewThrough`): the viewport
    camera BECOMES the light, so orbiting, panning and flying aim it, and a
    spot's cone becomes the field of view — a projector cannot be aimed any
    other way, since you have to stand behind it. Whatever moved the camera
    is written back each frame (through the parent's space when it has one),
    and zooming the view opens the beam.
- **Dropping an image or camera ON an object textures it**
  (`App.textureTargetAt` / `applyTexture`): a Library image or camera asset,
  or a single image or media file from Finder, dropped on a primitive mesh
  (not a MODEL, which carries its own materials, nor an EMPTY, which has no
  surface), editable mesh, pencil or PROJECTOR becomes its texture — or, for
  a projector, the picture it throws — instead of a new picture plane.
  **The target LIGHTS UP while you drag over it** (`App.dropHighlight`,
  applied per frame in `syncDropHighlight`): the same inverted hull, render
  silhouette and lamp-glyph tint the selection and hover already use, in the
  accent colour, so it reads as "this one" rather than as a new kind of
  marker. A PLANE takes the render silhouette rather than the hull — it has
  no thickness for a hull to stand off, and it is the most common thing
  anyone drops a picture on. The payload cannot be read during a drag (the
  browser hands over only `types` until the drop), so the highlight cannot
  tell a picture from a model and lights anything that could take one; that
  is honest, since the drop is what decides what it means.
  That highlight REPLACED the old safety rule, which was that only a
  SELECTED object took a dropped picture — there to stop a stray drop
  repainting whatever was behind the pointer. With the target lit while you
  hover, requiring a selection as well is the surprising half: the thing is
  glowing under the cursor and still refuses.
  A PROJECTOR is tested FIRST, by screen distance to where the lamp stands.
  Picking raycasts the meshes and returns the first hit, and a lamp is a
  wire glyph with nothing to raycast, so a projector standing in front of
  the wall it lights (which is every projector) could never be the target —
  the wall behind it answered first. A mesh gets it in its
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
- **A SPLAT HAS AN EDIT MODE, and nothing it does touches the file**
  (`tools/splatedit.ts`, `splats/edit.ts`, `SparkSplats.applyEdits`). Edit
  with a splat selected (the one you last clicked wins over a selected mesh)
  opens a region selector: box / lasso / circle under one toolbar button (W
  cycles), Blender's five select operations in the top bar, A / Alt+A /
  Ctrl+I, X deletes. Selection goes THROUGH the cloud, like X-ray, because
  the floaters are what hide behind the surface you can see.
  - EVERY DISPLAY IS REBUILT FROM THE PACKED ARRAY AS LOADED (`orig`):
    deleted and filtered splats get opacity 0, selected ones are tinted, and
    none of it is ever read back as input. The trap: writing
    `packedSplats.packedArray` and setting `needsUpdate` does NOTHING on its
    own — Spark keeps drawing the old generation until the mesh's
    `updateVersion()` is called too. And it lands a frame later, so the
    panel's counts are refreshed from `onApplied`, not after the edit.
  - A DELETION IS `TGSplat.removed`, a STRING: a base64 bitmask or varint
    runs, whichever is shorter. Runs of numbers looked right and were not —
    a scan's splats are not stored in spatial order, so half a room is ~25k
    scattered runs (48k numbers in every undo snapshot); the bitmask is
    bounded at n/6 characters.
  - FILTERS are `TGSplat.display`: Min opacity (a faint splat is one the
    capture was unsure of, so this is the confidence filter), Max size in
    metres (floaters and sky blobs), compared in the packed BYTE domain so a
    million splats cost one log, not three million. Show as POINT CLOUD fades
    the gaussians (`mesh.opacity = 0`) and draws a child `THREE.Points` of the
    shown centres, so it rides the mesh's transform and outline. Its raycast
    is off: a Points threshold is in WORLD units and hits everything.
  - LOOK: `splatScale` multiplies every gaussian's size as a SHIFT of the
    packed log-scale bytes (all three axes by one factor = one added
    constant; a zero byte stays zero), and `opacity` is `SplatMesh.opacity`,
    which takes values above 1 and lifts the faint majority of a capture.
    Points take the multiplier too, capped at 1, with the dot's alpha test
    lowered to match or faded dots vanish instead of fading. Both are the
    view, so Export writes the file's own sizes and opacities.
  - Picking and snapping read the same state (`pickSplatPoint` over every
    shown centre, one composed matrix, strided only past 250k), so a scan is
    clicked where it IS in Object mode and a deleted splat cannot be snapped
    to. Export writes what is shown, from the original colours.
  - FILTERED IS NOT DELETED: the selection tools only reach SHOWN splats, so
    whatever a filter hides survives a lasso-and-delete and comes back when
    the filter is relaxed. `removedMask` is what tells "deleted" from
    "filtered" (`alive` is 0 for both). Select filtered / Delete filtered
    make a filter permanent (still restorable); a hidden splat that is
    selected is tinted the moment a filter lets it back into view.
  - CROP deletes everything unselected (restorable, like any deletion).
    SEPARATE is the way to take a crop on: the selection is written to a new
    stored PLY (`exportPly(id, only)`, original colours) and becomes a new
    splat object with the source's transform and look, and leaves the
    source as a restorable deletion.
  - SELECT INSIDE a volume (`App.splatSelectInside`): any BOX, SPHERE or
    CYLINDER mesh selects the splats inside it, a PLANE the ones in front of
    it (+Z). The volume is an ordinary object on purpose — placed, turned,
    scaled and snapped with the tools that already exist, and kept in the
    scene to crop the next take the same way. Tested in the primitive's own
    unit space (box ±0.5, sphere r 0.5, cylinder r 0.5 × 1.2 along Y).
  - Not built: moving splats (G/R/S says so) and a LIVE crop volume (a
    filter that follows the box as it moves, rather than a one-off select).
- **A TIME VOLUME is a film as a SPACE-TIME CUBE** (`render/timevolume.ts`,
  `scene.volumes` / `TGVolume`, ObjKind `'VOLUME'`) — the Khronos Projector's
  idea: a video or GIF's frames stacked into one `Data3DTexture`
  (width × height × time), and what you see is whatever SURFACE passes
  through it. It is an object kind of its own (outliner, selection,
  transform, parenting, constraints, duplicate, delete all name it — the
  "anything else is a mesh" fall-through in objects.ts would otherwise have
  swallowed it), and it IS the cube: local x = picture across, z = up,
  y = TIME (front face = first frame), unit-sized so scale is its size. Its
  own faces sample it (Faces), or only its edges show (Wire).
  - A SLICE is `TGMesh.timeSlice` on ANY mesh, so every surface the app can
    make can cut one: POSITION — where the surface is inside the cube decides
    (u, v, t), so a plane is a frame, a tilted one an oblique cut, a curved
    one a curved cut, and outside the cube is discarded; MAP — the surface's
    own UVs are the picture and TIME is a map's luminance × gain + offset
    (image, video or camera: Khronos proper). `Add slice` parents a plane to
    the volume in the cube's own unit space, so its local Y IS its time.
    Both scrub (`time`) and play (`rate`, films a second).
  - The slice material REPLACES the mesh's own (`applySlice`, hooked first
    in `MeshManager.apply`) and puts it back when the slice goes.
  - A SURFACE slice (`mode: 'FIELD'`) is the car demo: a time surface drawn
    INSIDE the cube, each picture point at its own depth in time by a shape
    (flat, bump, tilt, wave, ripple, map). The mesh's own geometry is swapped
    for a 96×96 grid and the vertex shader lays it out in the CUBE's space
    (its own transform is ignored, so `frustumCulled` is off); the fragment
    then samples exactly where each point lies. Scrub moves the whole sheet
    through the film. Videos and GIFs become volumes from Add ▸ Time volume,
    a Library tile's cube button, or its right-click menu.
  - A VOLUME HAS A FILTER (`TGVolume.filter`), and it applies EVERYWHERE the
    film is read — its faces, every slice, the Volume display and Convert to
    splats — by one shader function (`passes`) and its CPU twin, so what you
    convert is what you see. PEOPLE is MediaPipe's selfie segmenter, run
    once per frame AS THE FILE DECODES, its confidence written into the
    layer's ALPHA (the key gains `|people`, so turning it on decodes again).
    The layers are stored bottom-row-first, and a segmenter finds people
    upside down badly — each frame is turned upright for it and the mask
    turned back. Live volumes are not segmented. COLOUR KEY keeps or removes
    one colour within a tolerance; BRIGHTNESS a range; MOTION what changed
    since the previous frame. The two most recent UNUSED decodes are kept,
    so toggling People off and on does not segment every frame twice.
  - VOLUME DISPLAY ray-marches the cube (160 steps, front to back,
    filtered voxels empty), drawn from its BACK faces so it works with the
    eye inside it and depthWrite off. With a filter on, only what passes is
    left — people floating in space-time.
  - A new volume comes from Add ▸ Time volume EMPTY; its SOURCE (a Library
    video or GIF, a file — which also goes into the Library — or a live /
    test camera) is picked in its panel, not from a menu listing the Library.
  - CONVERT TO SPLATS (`App.volumeToSplats`): every sampled voxel — one
    pixel of one frame — becomes a gaussian at its place in the cube, sized
    to the sampling spacing, written as a standard 3DGS PLY into the store
    and added as a new splat object (the volume stays), so every splat tool
    applies. Density: pixel stride, frame stride, a brightness floor, and
    MOTION (keep a voxel only where it differs from the previous sampled
    frame: the still background vanishes, what moved is a trail through
    time). The cube's non-uniform size is BAKED into the positions — a splat
    object has one uniform scale. Trap: the PLY body starts wherever the text
    header ends, rarely 4-byte aligned, so it is copied in as bytes (a
    Float32Array view on it throws). Measured on a giphy dance (256×256×34):
    step 2 gave 241k splats, motion 0.08 gave 29k.
  - THE VOLUME IS A TEXTURE ARRAY, NOT A 3D TEXTURE: one layer per frame,
    and the shader blends the two neighbouring layers itself (an array does
    not filter across layers). A 3D texture filters time for free but can
    only be re-uploaded WHOLE, and a LIVE volume — a camera (`live:<key>`)
    recorded into a ring of N layers, time 0 the oldest and 1 now — writes a
    frame thirty times a second: 9 MB a frame whole, one layer with
    `addLayerUpdate`. `uStart` is the ring's oldest layer (0 for a file).
    Freeze stops recording. The ring is allocated when the camera's first
    frame says what shape it is. Verified with the test camera: the newest
    layer advanced 23 frames a second and old and middle layers differed.
    TEST WITH A CLIP THAT IS NOT ALREADY SPACE-TIME: car-4d.gif is itself a
    render of this effect, so it looks right however the cube is built — a
    giphy dance (a figure moving in place) shows an oblique slice as two
    dancers at two moments.
  - Decoding is ONCE per (file, resolution, frames): GIFs through
    ImageDecoder (COMPOSITED frames — a GIF frame is usually only what
    changed), videos by seeking a hidden <video> to the middle of each slot
    (never exactly `duration`, which decodes black). Flipped so v = 0 is the
    bottom, sRGB, inside a 256 MB budget. A new volume takes its picture's
    aspect when the decode lands (`fitVolumes`, once).
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
