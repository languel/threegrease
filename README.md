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
  ortho/perspective toggle, flythrough mode (`~`), **canvas planes**
  (drawable quads placed at the 3D cursor — raycast targets for Surface
  placement), and **Stroke placement** with All/End/First-point targets so
  new strokes inherit depth from existing ones (grow forms in 3D) — depth
  snaps to the nearest stroke only (against stroke *segments*, with a live
  HUD indicator showing the anchor point) and holds while drawing past its
  edges. The 3D cursor (`Shift+RMB`) has snap modes: Plane, Grid, nearest
  Stroke point, Selection center.
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
- **Canvas planes are objects**: click to select them in edit mode (amber
  highlight), transform with `G`/`R`/`S`, delete with `X`. A per-canvas
  *Draw target* flag turns a canvas into a pure reference plane that
  Surface placement ignores.
- **Magnet snapping** (`Shift+Tab` or 🧲 in the edit topbar): during moves,
  snap the selection to grid increments, the nearest stroke point, or a
  point on a canvas plane. Cursor grid-snap works within the drawing plane
  (no more off-plane jumps to the invisible 3D lattice).

See [PLAN.md](PLAN.md) for the full feature checklist against the Blender
manual and the post-parity roadmap (performance, Mental-Canvas-style gesture
navigation, live-performance bindings).

## Shortcuts

All bindings below are defaults — open Settings (`,`) to rebind any of them.

| Key | Action |
| --- | ------ |
| `1–5` / `Tab` | modes (Draw/Edit/Sculpt/Vertex/Weight; Tab toggles Draw↔Edit) |
| `D/E/F` | draw / erase / fill tools |
| `G/R/S` + `X/Y/Z` | move/rotate/scale with axis lock (Edit) |
| `A` / `Shift+A` / `Ctrl+I` / `L` | select all / none / invert / linked |
| `X` | delete selected · `Shift+D` duplicate |
| `Ctrl+C/V` `Ctrl+Z` | copy/paste, undo |
| `I` / `Shift+I` | insert / remove keyframe |
| `Space` `←→` `↑↓` | play, step frame, jump keyframe |
| MMB / RMB | orbit / pan · `Shift+RMB` place 3D cursor |
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
