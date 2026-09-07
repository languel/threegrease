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
- **A leaf bone needs its DIRECTION held, and `tone` fights it.** Nothing
  below a foot or a hand pulls it into shape, and tone pulls a joint toward
  its fixed rest POSITION — so swinging the ankle 0.4 m forward drags the
  foot back toward where it stands at rest, which puts it BEHIND the ankle.
  A foot pointing backwards on a third of the frames is the visible result.
  `TGBone.trackRest` (0..1) holds the bone's rest direction in the actor's
  own frame instead, which is what "a foot points forward" actually means.
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
