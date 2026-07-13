# threegrease

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
  highlighted), keys marked on the timeline.
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
- **MediaMime bridge**: live tracked-landmark positions (from
  [mediamime](https://github.com/languel/mediamime) or any sender) arrive
  over the WS/OSC bridge and can rig any object's translation, or spawn a
  trigger at a landmark, from the MediaMime menu/panel.

See [PLAN.md](PLAN.md) for the feature checklist against the Blender manual.
The project brief lives in [docs/PRD.md](docs/PRD.md) (platform vision:
event scores, MIDI/OSC/WS, string/wire art solvers, Gaussian splats),
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) (phased plan),
and [docs/HANDOFF.md](docs/HANDOFF.md) (technical handoff for contributors).

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
