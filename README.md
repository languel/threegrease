# threegrease

*Also carrying the mark **3𝜻** — the working project name is still threegrease
while the app matures; 3𝜻 is the branding it's growing into.*

A feature-complete implementation of **Blender Grease Pencil** in **three.js** —
the foundation for an interactive action-painting lab.

```bash
npm install
npm run dev     # open http://localhost:5199
```

## What's inside

- **Data model** mirroring Blender: object → layers → keyframes → strokes →
  points (position, pressure→radius, strength→opacity, vertex color, weight).
- **Renderer**: custom screen-space ribbon shader (per-point radius/color,
  round caps & joins, hardness, Line/Dots/Squares modes), earcut-triangulated
  fills with solid/linear/radial gradient styles, layer blend modes
  (Regular/Add/Multiply), tint, thickness offset, stencil-based layer masks,
  holdout, onion skinning.
- **Draw mode**: pressure-sensitive draw with stabilizer + active smoothing +
  post smooth/simplify, point/stroke/soft erasers, raster bucket fill with
  leak detection, tint brush, cutter, eyedropper, primitives (line, polyline,
  arc, curve, box, circle), drawing guides (circular/radial/parallel/grid/iso),
  placement planes (view/front/side/top × origin/cursor/surface).
- **Edit mode**: point/stroke select (click/box/lasso/circle), G/R/S modal
  transforms with axis locks and proportional editing, full stroke-op suite
  (subdivide, simplify, smooth, join, split, merge, dissolve, duplicate,
  arrange, cyclic, direction, normalize, move-to-layer, snap), multiframe
  editing, copy/paste.
- **Sculpt mode**: smooth, thickness, strength, randomize, grab, push, twist,
  pinch, clone brushes.
- **Vertex/Weight paint**: draw/blur/average/smear color brushes; weight
  group used by noise/opacity modifiers.
- **Animation**: per-layer keyframes with types, timeline scrub/playback,
  auto-key, onion skinning (frames/keyframes), interpolation (single
  breakdown + full sequence).
- **Modifiers** (non-destructive, reorderable, layer/material filtered):
  noise, smooth, subdivide, simplify, thickness, offset, array, mirror,
  build, tint, opacity, length, time offset, wave.
- **Visual effects** (screen-space, per object): blur, glow, pixelate, rim,
  shadow, colorize, flip, swirl, wave.
- **IO**: JSON scene save/load, PNG snapshot, snapshot undo/redo.
- **Navigation & QoL**: Blender-style *Emulate Numpad* (digit-row view keys)
  and *Emulate 3 Button Mouse* (Alt+drag orbit / +Shift pan / +Ctrl zoom —
  trackpad friendly), clickable axis gizmo with animated view transitions,
  ortho/perspective toggle, flythrough mode (`~`), **reference planes**
  (textured quads — world/face-view/camera-locked, optional raycast target
  for Surface placement), and **Stroke placement** with All/End/First-point
  targets so new strokes inherit depth from existing ones (grow forms in
  3D) — depth snaps to the nearest stroke only (against stroke *segments*,
  with a live HUD indicator showing the anchor point) and holds while
  drawing past its edges. The 3D cursor (`Shift+RMB`, drag to move it
  continuously) follows the single global magnet — off moves freely on the
  drawing plane, on snaps to Grid (the visible floor, Blender-style),
  Stroke point, Object origin, or Surface (mesh/3DGS raycast).
- **Presentation / performance mode** (`P`): all UI panels, grid, gizmo and
  overlays disappear — just rendered strokes on a solid background while
  every shortcut keeps working. Made for live drawing.
- **Scene cameras**: multiple transformable, keyframable cameras (`0` to
  look through the active one, `Shift+C` to cycle, dropdown + `＋Cam`/`－Cam`
  in the timeline; `＋Cam` captures the current view). With *Lock* on, normal
  viewport navigation — including flythrough — moves the camera; `＋CamKey`
  keyframes it and playback interpolates position/rotation/FOV between keys
  (slerped rotation). Every camera shows as a frustum gizmo (active one
  highlighted), keys marked on the timeline. A camera is a full **object**:
  an outliner row, selection (click its frustum), the transform widget,
  G/R/S, parenting and delete, with a Properties panel carrying the lens,
  field of view in degrees *and* 35 mm-equivalent focal length, the
  clipping range and its keys.
- **Settings dialog** (`,` or ⚙): preferences plus a full shortcut list —
  click any binding and press a new key to rebind it. Custom bindings and
  preferences persist in localStorage; one-click reset to defaults.
- **Trackpad navigation** (on by default): two-finger drag orbits,
  `Shift`+two-finger pans, `Ctrl`+two-finger (or pinch) zooms — alongside
  Alt-drag combos and MMB/RMB. The axis gizmo snaps on ball clicks and acts
  as a trackball when you drag its disc.
- **World up convention**: Z-up right-handed (Blender, the default) or
  Y-up (three.js) — switch in Settings. Affects views, orbit, fly, grid,
  drawing planes, and canvas orientation. Optional world axes overlay; the
  floor grid passes through the origin.
- **Inspector panel** (`N`): Blender-style N-panel with live editable values
  — selection median, object transform, active camera transform + FOV,
  viewport position, 3D cursor.
- **Select tool family** (edit mode toolbar): box, lasso, and circle brush
  (`[`/`]` resize) as explicit tools; box keeps Ctrl-drag lasso and `C`.
- **Reference / image planes**: textured planes (Add menu) with a
  Blender-lite per-object Material panel — color, opacity, texture,
  unlit, two-sided, wireframe, world/face-view/camera lock, draw-target
  flag. Old canvas planes migrate automatically into these.
- **Assistant** (Agent tab): a chat panel that drives the scene through the
  same 24 tools everything else uses — draw, inspect, transform, rig. Point
  it at a local model (Ollama, LM Studio, oMLX, Unsloth) or a hosted one
  (Anthropic, OpenAI, Google, OpenRouter). Under **Connections** the same
  tools can also be handed to:
  - **WebMCP** — the browser's own agent, no extra process. Opt-in per
    session; needs a browser that ships `document.modelContext` (Chrome 149
    / Edge 150 origin trial at time of writing).
  - **the relay** — Claude Code, Claude Desktop or Zed over MCP/ACP, via
    `node agent/relay.js`. See [docs/AGENT.md](docs/AGENT.md).

  Whoever calls a tool, it shows up in the same transcript, tagged.
- **Actors** (Add ▸ Actor, then the Actor tab): a rigged mannequin you can
  throw around, pose by hand, or drive from a webcam. The skeleton is
  *positional* — joints are particles, bones are distance constraints — so
  one solver covers ragdoll physics, motion capture and IK. **Simulate**
  turns on gravity and joint limits; **Tone** is muscle tone (0 collapses
  into a heap, the default holds a stance). Four ways to drive it:
  - **Markers** — every joint pinned 1:1 to a capture landmark. Exact.
  - **Angles** — copies bone *directions* but keeps the character's own
    limb lengths, so a tall performer can drive a short character.
  - **IK** — wrists, ankles and head as goals; the limbs are solved.
  - **Manual** — the Actor Pose tool (Object mode toolbar): drag any joint
    and the rest of the body follows through the bones; Shift+click pins a
    joint so the rest hangs off it. MIDI/OSC can drive joints too, via
    `actor.<id>.joint.<name>.<x|y|z>` routes.

  Auto-bind maps joints to the standard 33-point pose model by name, and
  **Match size** rescales the captured body to your character so it never
  stretches or floats.

  Any object can also attach to a specific joint instead of the actor's
  root: on the object's Constraints tab, add Copy Location (or Copy
  Rotation, Track To, Limit Distance, Spring), set its Target to the
  actor, and a **Joint** dropdown appears — pick `hand.R` for a held prop,
  `head` for a first-person camera, and so on. The object rides that
  joint's live pose, physics included.
- **World & viewport shading** (Scene tab): the environment behind the
  scene and the light it casts. Pick a flat colour, a sky/ground gradient,
  an equirectangular (2:1 lat-long) image, a **360 video** — a file, a URL,
  or the live camera — or a physical sky with a movable sun. Whatever you
  choose lights the meshes too, with strength, rotation, and background
  visibility/brightness/blur as separate controls. The four shading
  buttons at the right of the topbar (or `Z` / `Shift+Z`) switch between
  Wireframe, Solid (a fixed studio light, world ignored — the modelling
  view), Material (world, no scene lights), and Rendered (world + lights
  + shadows). Local video opens as a session-only handle, so a saved
  scene keeps the settings but not the file.
- **Magnet snapping** (`Shift+Tab` or 🧲 in the topbar, works in every
  mode): one setting drives point moves (Edit `G/R/S`), the object
  translate widget (Object mode), and the 3D cursor drag (`Shift+RMB`).
  Targets: grid increments (the visible floor, Blender-style), nearest
  stroke point, nearest object origin, or a mesh/3DGS surface.
- **Object mode**: unified selection/transform over GP objects, meshes,
  splats, and triggers — outliner with hierarchy/parenting/drag-to-parent,
  a right-click context menu (viewport or outliner row) with Set Origin,
  Mirror, Clear, Apply, and Snap submenus, and a save/instance asset
  library.
- **Constraints** (Constraints tab, vertical icon column like Blender's
  Properties editor): any object can carry a stack — *Follow Path* rides
  a GP stroke on its own clock (making the object a "traveler"), *Trigger*
  turns an object's origin into a proximity zone, plus Copy
  Location/Rotation/Scale, Track To, Limit Distance, Shrinkwrap, Floor,
  and Spring. Grab a Follow Path object with the transform widget and drag
  it *along* its path to retime it. Object/target fields have a Blender-
  style picker: eyedropper, dropdown, or type a name.
- **Plan inside a scan**: a `.glb` of a real room opens into a **dollhouse
  view** — scans are captured with their normals facing inward, so the wall
  between you and the room is culled and you see straight in from outside —
  and you can click, place and snap *through* that wall onto the floor.
  Imports carry their own display controls (tint, opacity, two-sided, unlit,
  wireframe) applied over the file's own materials, so a scan works as
  reference or backdrop.
- **Transform orientation and pivot** (top bar, Blender's pair): Global,
  Local, Normal, Gimbal, View, Cursor, Parent; Median, Bounding Box, Cursor,
  Individual Origins, Active. `N` / `Shift+N` during a transform move along
  or across the normal of whatever you are dragging, and `Ctrl` inverts the
  magnet in any drag.
- **Angles are degrees** everywhere, and any angle field takes `pi/2`,
  `0.5 pi`, `30deg`, `0.5rad` or arithmetic like `-2*pi/3` (Settings ▸
  Angles switches what a bare number means).
- **Projector keystone**: drag the four corners of the thrown picture onto
  the real corners of the screen, the doorway, or the next projector's edge.
  Aim a projector by dragging the spot it makes on the wall; drag the cone,
  blend and reach handles on any light.
- **Per-instance media**: two planes showing one video are two players —
  play, pause and speed are per object, and the Library's own copies stay
  paused.
- **Quad view** (`Ctrl+Alt+Q`): draw, edit and measure in any pane —
  input, helpers, HUD and modals all follow the pointer's viewport. Leaving
  quad view keeps the view you were hovering, Maya-style.
- **Mesh edit mode**: enter Edit with a mesh selected and it becomes a
  vertex / edge / face editor — a primitive converts in place to an
  editable mesh, keeping its name, transform, material and parenting.
  G/R/S with world-axis and plane locks, extrude, fill, delete, and
  Separate (by selection, loose parts, or material for strokes).
- **Draw objects in place** (Object mode toolbar): planes, rectangles,
  triangles, n-gons, boxes, cylinders, pyramids, spheres and the four
  platonic solids, drawn through the same placement, plane, guide and
  snapping chain as a stroke — so blocking out a set is drawing it.
- **Projectors**: a spot light that throws a gobo or a picture (image,
  video, camera) at a real aspect, with the throw readout — distance and
  image size on whatever it hits — plus **flat** (unlit) projection for
  judging the media itself, edge blending, masking, and *look through the
  light* (`Ctrl+0`) to aim one by flying it.
- **Lenses** for cameras and projectors: fisheye (equidistant, equisolid,
  and Paul Bourke's measured polynomial form), equirectangular,
  cylindrical and mirror ball — a 360 camera and a dome projector out of
  one model read in two directions.
- **Library** (Library tab): an asset container, not an inbox — drop files
  to keep them (with rendered thumbnails), drag a tile into the viewport
  to place it or double-click to place at the 3D cursor, folders with drag
  to file, render view / render selection into it, and export or import
  the whole library as a zip. Cameras, videos and GIFs live there too as
  playable sources with pause and freeze, feeding planes, textures,
  projectors and tracking alike.
- **Gaussian splat editing**: Edit a selected scan to box, lasso or circle
  select its splats (through the cloud, like X-ray; `W` cycles the tools)
  or select everything inside any box, sphere or cylinder in the scene, or
  in front of a plane. Delete, **Crop** to the selection, or **Separate** it
  into a new splat of its own — every deletion is undoable and restorable,
  and the scan file itself is never touched. Show a scan as **splats or a
  point cloud**, scale the gaussians or the dots, multiply its opacity,
  and hide faint (low-confidence) or oversized splats with filters — then
  **Select / Delete filtered** to make a filter permanent. Export PLY writes
  what is shown.
- **Registration with measurements**: a measurement placed on an object
  sticks to it. Type the real length of one and it rescales just that
  object (or the whole scene). Pair two measurements — corners of a
  pedestal in a scan, and the same pedestal as a virtual box of known size
  — and **Align** moves, turns and scales the scan onto it. The two need not
  match point for point: the order is found, a subset of corners is matched
  to the full set, and anything else is fitted by shape, with the residual
  reported.
- **Snapping you can see**: the magnet's Vertex and Edge modes reach mesh
  vertices and edges (and splat centres), and what it would catch is shown
  as a glyph round the target and as the cursor itself — ring for a vertex,
  square with a dot for a face centre, and so on, the same shapes as the
  Snap Target icons.
- **Performance overlay** (`Ctrl+Alt+F`): per-phase frame breakdown, the
  gap between the loop and what you actually get, draw calls, memory and
  long tasks — plus a render-resolution setting for retina.
- **MediaMime bridge**: live tracked-landmark positions (from
  [mediamime](https://github.com/languel/mediamime) or any sender) arrive
  over the WS/OSC bridge and can rig any object's translation, or spawn a
  trigger at a landmark, from the MediaMime menu/panel.

See [PLAN.md](PLAN.md) for the feature checklist against the Blender manual.
The project brief lives in [docs/PRD.md](docs/PRD.md) (platform vision:
event scores, MIDI/OSC/WS, string/wire art solvers, Gaussian splats),
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) (phased plan),
and [docs/HANDOFF.md](docs/HANDOFF.md) (technical handoff for contributors).

## Characters and motion

Actors are rigged characters with a **positional** skeleton (a joint is a
particle, a bone is a distance constraint), so one solver covers ragdoll
physics, motion capture, IK and retargeting. Their root has exactly three
drivers, and none of them touches the pose — a procedural gait watches the
root move and produces the walking, so all three read as one character:

- a **Follow Path** constraint (a recorded route),
- **possession** — `Shift+P`, then mouse to look, WASD to move, `V` for
  first/third person, `R` to record the walk, `Enter`/`Esc` to hand back,
- a **destination** — `Actor ▸ Go to`, or the Direct tool's HUD, where you
  arm a verb (walk / run / sneak / march / jump / look) and click the space.

Pose comes from an **animation mixer**: layers with weights and body masks,
so a capture can own the upper body while the walk owns the legs. Sources
include the capture rig, the gait, recorded takes, imported `.glb`
animation, and generated clips.

### Generated motion

The **Motion** tab is where you say what a character should do, in words. It
turns a description into a clip on a mixer layer, and lets you save any
phrase as a reusable **button** — those live in the scene, so a piece
travels with its own vocabulary rather than with whoever authored it. Three
interchangeable backends answer the same request:

- **Built-in** — procedural synthesis, not a learned model, and labelled as
  such everywhere it appears. Instant, no download.
- **ARDY Mini** — a real diffusion model running locally on WebGPU (see
  below).
- **Remote** — any service you point at, for weights that cannot run here.

Generation is *in place*. Travel stays the root's job, which is what lets a
generated style and a destination combine instead of competing.

#### About the on-device model

Choosing **ARDY Mini** downloads roughly **653 MiB** the first time and
caches it in your browser; it needs **WebGPU**. Nothing is fetched until you
pick that backend.

It is [ARDY](https://research.nvidia.com/labs/sil/projects/ardy/) (NVIDIA,
SIGGRAPH 2026) — autoregressive diffusion for interactive human motion — in
[intsuc's browser export](https://huggingface.co/intsuc/Llama-3-ARDY-Mini-Core40-Browser),
which is only possible because it distils ARDY's gated Llama-3-8B text
encoder down to MiniLM. **It is text-only:** upstream ARDY accepts waypoints
and keyframes, this export does not, so it says *how* to move and never
*where* to go. Steering already handles the where.

The model's weights are **not** part of this repository and are not
redistributed by it — your browser fetches them from Hugging Face. They
carry composite **NVIDIA Open Model** and **Meta Llama 3 Community** terms
rather than the Apache-2.0 of the runtime code. The required attributions
are shown in the app beside the backend selector.

### Watching what characters do

Two visitors run in the stock demo scene: **Walker** follows a drawn route,
**Wanderer** is handed goals by a script and steers, climbs and avoids its
own way there. Same skeleton, same gait, same solver — the two ways of
driving a character, side by side.

The viewport reports in two registers. The **log** (top left) is each
character's running commentary in the first person — what it intends, said
at the moment the goal is set. The **badge** above each head is what is
actually happening to it: *on route*, *walking*, *climbing*, *looking*,
*idle*, *stuck*, *driving* — and **which system is producing the pose**:
*gait*, *synth*, *ARDY*, *capture*, *import*, *you*. Synth and ARDY answer
the same request through the same seam, so from the outside they are
otherwise indistinguishable; the badge is how you tell. When the intent and
the state disagree, that is the bug.

The stock choreography uses the built-in synthesiser, so it runs the moment
you open it with nothing downloaded — and upgrades itself to the on-device
model the instant you load that in the Motion panel.

### Loose props

`File ▸ New — Gallery + loose props` is the same gallery with a floor full
of things that fall over: ten balls across a wide size range, plus a crate
and the platonic solids. Characters push, kick and scatter them, and can
stand on them. Mass is roughly volume, so a small ball skitters off a shin
while a big one has to be leaned into.

It is a small simulation and honest about it: no rotational dynamics, and
every prop collides as a sphere whatever it is drawn as, which is the same
fidelity the characters' own collision has.

### Grouping

Select anything and press `Ctrl+G` (or **Group selection under a new
empty**). It creates an empty at the selection's horizontal centre and its
LOWEST point — a pivot you can drop on a floor and rotate about, rather than
a centroid floating inside the geometry — and parents everything to it,
preserving world positions.

## Licensing

threegrease is proprietary — see [LICENSE](LICENSE). It is an internal
research and teaching tool, not an open-source release.

Third-party components, and the distinction between what this repository
*redistributes* and what your browser merely *fetches at runtime*, are
recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The short
version: one Apache-2.0 runtime is vendored into `src/vendor/ardy/`, npm
dependencies are bundled as usual, and every **model** — motion, tracking
and detection alike — is downloaded on demand from its own host and never
stored here.

## Shortcuts

A Blender-style menubar (File / Edit / Add / View / Help) holds save/load,
import/export (GP JSON, models, splats, GLB/OBJ/STL/PNG), add-object, and
view commands — each item shows its shortcut. All bindings below are
defaults — open Settings (`,`) to rebind any of them.

| Key | Action |
| --- | ------ |
| `1–5` / `Tab` | modes (Draw/Edit/Sculpt/Vertex/Weight; Tab toggles Draw↔Edit) |
| `D/E/F` | draw / erase / fill tools |
| `G/R/S` + `X/Y/Z` | move/rotate/scale with axis lock (Edit) |
| `A` / `Alt+A` / `Ctrl+I` / `L` | select all / none / invert / linked |
| `Shift+A` | Add menu at the mouse (objects, or a traveler/trigger *on* the stroke under the pointer) |
| `X` | delete selected · `Shift+D` duplicate |
| `Ctrl+C/V` `Ctrl+Z` | copy/paste, undo |
| `Ctrl+S` / `Ctrl+O` | save / open scene |
| `Home` / `Shift+C` | frame all / center cursor & frame all |
| `Z` / `Shift+Z` | cycle viewport shading forward / back |
| `I` / `Shift+I` | insert / remove keyframe |
| `Space` `←→` `↑↓` | play, step frame, jump keyframe |
| MMB / RMB | orbit / pan · `Shift+RMB` drag-place the 3D cursor (snaps per the magnet) · plain `RMB` opens the object context menu |
| `Shift+T` / `Shift+G` | add a trigger at the 3D cursor / add a traveler on the nearest stroke |
| `Alt+LMB` | orbit (trackpad) · `+Shift` pan · `+Ctrl/Cmd` zoom |
| two-finger drag | orbit · `+Shift` pan · `+Ctrl`/pinch zoom |
| `1/3/7` | front/right/top view (`Ctrl` = opposite) · `9` flip |
| `5` | ortho ↔ perspective |
| `2/4/6/8` | orbit view in 15° steps |
| `~` | flythrough (WASD + Q/E, wheel = speed; `Enter`/click accepts, `Esc` teleports back) |
| `P` | presentation/performance mode (UI off, shortcuts live) |
| `0` / `Shift+C` | look through the active camera / cycle cameras |
| `,` | settings & shortcut editor |
| `N` | inspector panel (selection median, object/camera transforms, 3D cursor) |
