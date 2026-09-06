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
  wedges anyway it sets `stuck` rather than shuffling forever while the gait
  dutifully animates a walk going nowhere. The heading turns at a bounded
  RATE — snapping it spins the body under a world-locked stance foot.
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
