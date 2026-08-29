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
