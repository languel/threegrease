# threegrease — Grease Pencil in three.js

Goal: a feature-complete match of Blender's Grease Pencil (per the
[manual](https://docs.blender.org/manual/en/latest/grease_pencil/index.html)),
implemented as a three.js library + interactive app, to serve as the foundation
for an interactive action-painting lab (live performance, Mental-Canvas-style
gesture control comes after parity).

## Architecture

```
src/
  core/        Data model (object → layers → keyframes → strokes → points),
               materials, selection, undo
  render/      Custom stroke shader (screen-space ribbons, per-point radius/
               color/opacity, round caps/joins, dot/square modes), fill
               triangulation (earcut), layer compositing (blend modes, tint,
               masks, order), onion-skin rendering
  modifiers/   Non-destructive modifier stack evaluated at render time
  tools/       Draw-mode tools (draw, erase, fill, tint, cutter, primitives,
               interpolate, eyedropper), edit-mode (select/transform/stroke
               ops), sculpt-mode brushes, weight/vertex paint
  anim/        Timeline, playback, keyframe management, interpolation
  io/          JSON serialize/deserialize of the whole scene
  app/         The lab UI: viewport, toolbar, sidebar panels, timeline strip
```

Data is plain-JSON-serializable; rendering is a pure sync from evaluated data
(after modifiers) to three.js meshes. Tools mutate data + push undo snapshots.

## Feature checklist (Blender GP manual → status)

### Structure & primitives
- [x] GP object with layers → keyframes → strokes → points
- [x] Point attributes: position, radius (pressure), opacity (strength), vertex color, selection
- [x] Stroke attributes: cyclic, material, base line width, hardness, fill vertex color
- [x] Multiple GP objects in one 3D scene

### Layers
- [x] Add/remove/duplicate/reorder, rename
- [x] Opacity, hide, lock, blend mode (Regular/Add/Multiply)
- [x] Tint color + factor, stroke thickness offset
- [x] Onion-skinning toggle per layer
- [x] Layer transform (offset/rotation/scale)
- [x] Autolock inactive layers option

### Materials
- [x] Stroke component: on/off, color+alpha, line mode (Line / Dots / Squares)
- [x] Fill component: on/off, solid color+alpha, gradient (linear/radial)
- [x] Holdout
- [x] Material list per object, assign to new strokes / selected strokes

### Draw mode
- [x] Draw tool: pressure → radius & opacity, active smoothing, stabilizer
      (lazy mouse), post-smooth + simplify
- [x] Erase: point / stroke / soft (stroke splitting on point erase)
- [x] Fill tool: raster flood fill of visible stroke outlines → new fill stroke
      (boundary trace + simplify), leak-size guard
- [x] Tint tool (vertex-color brush in draw mode)
- [x] Cutter (lasso trim strokes)
- [x] Eyedropper (pick material color from canvas)
- [x] Primitives: Line, Polyline, Arc, Curve (quadratic), Box, Circle
- [x] Interpolate tool (breakdown between neighboring keyframes)
- [x] Drawing planes (placement): View, Front, Side, Top (Y-up conventions),
      at Origin / 3D-cursor; Surface placement (raycast canvas planes/scene)
- [x] Stroke placement with target All Points / End Points / First Point
      (new strokes take depth from nearby existing strokes)
- [x] Guides: Circular, Radial, Parallel, Grid, Isometric

### Edit mode
- [x] Select: click, box, lasso, circle; point / stroke modes; grow/shrink,
      linked, all/none/invert
- [x] Transform: grab, rotate, scale (G/R/S with axis lock, numeric via drag),
      proportional editing (falloff)
- [x] Stroke ops: duplicate, delete (points/strokes), dissolve, split, join,
      copy/paste, merge by distance, subdivide, simplify, smooth, toggle
      cyclic, switch direction, set start point, normalize thickness/opacity
- [x] Arrange (bring to front / send to back, forward/backward)
- [x] Move to layer, assign material
- [x] Snap to grid / cursor
- [x] Multiframe editing (falloff across selected keyframes)

### Sculpt mode
- [x] Brushes: Smooth, Thickness, Strength, Randomize, Grab, Push, Twist,
      Pinch, Clone; pressure + invert (Ctrl), screen-space radius falloff

### Weight & vertex paint
- [x] Vertex paint mode: Draw/Blur/Average/Smear on point & fill colors
- [x] Weight paint: single "softness" group used by noise/opacity modifiers

### Animation
- [x] Keyframes per layer (add/remove/duplicate), keyframe types
- [x] Timeline: scrub, play (fps), frame range, auto-key on draw
- [x] Onion skinning: keyframe/frame mode, before/after counts + colors, fade
- [x] Interpolation: interpolate sequence (breakdowns), stroke matching &
      point resampling

### Modifiers (non-destructive stack, reorderable)
- [x] Noise, Smooth, Subdivide, Simplify, Thickness, Offset, Array, Mirror,
      Build, Tint, Opacity, Length, Time Offset, Lattice-lite (bend/taper via
      Curve-like deform: Wave)
- [x] Per-modifier layer/material filtering, influence

### Visual effects (object-level, post)
- [x] Wave distortion, Noise displacement (geometry-level)
- [x] Blur, Glow, Pixelate, Rim, Shadow, Colorize, Flip, Swirl (screen-space
      pass over the GP object's rendered layer)

### IO / misc
- [x] Save/load scene JSON, export PNG snapshot
- [x] Undo/redo (snapshot-based)
- [x] 3D cursor
- [ ] Import SVG / export SVG-PDF (post-parity)
- [ ] Curve edit mode on strokes (post-parity; Blender 4.3+ GPv3 dropped it too)
- [ ] Armature/lattice/hook full parenting (post-parity — needs rig system)

### Navigation & QoL (post-parity, done)
- [x] Emulate Numpad (digit-row 1/3/7/9/5/2/4/6/8 view keys) — toggle in topbar
- [x] Emulate 3 Button Mouse: Alt+LMB orbit, +Shift pan, +Ctrl zoom — toggle
- [x] Axis gizmo (click balls to snap views, animated transitions)
- [x] Ortho/perspective toggle
- [x] Flythrough mode (`, WASD+QE, pointer lock)
- [x] Canvas planes: drawable quads (add at cursor, per-plane orientation,
      pos/rot/size editable, saved in scene JSON) as Surface raycast targets
- [x] 3D-cursor snap modes: Plane / Grid / nearest Stroke point / Selection
- [x] Stroke placement snaps to stroke segments with HUD anchor indicator
- [x] Presentation/performance mode (P): UI-less viewport, shortcuts live
- [x] Scene cameras: multiple, keyframable transform+FOV, camera view (0),
      cycle (Shift+C), lock-to-view navigation incl. flythrough writeback,
      frustum gizmos, keys on timeline
- [x] Settings dialog with preferences + rebindable shortcuts (localStorage)

### Blender parity gaps spotted in use (reference screenshots 2026-07-06)
- [x] Drawing Plane: "Cursor" option (plane through the 3D cursor)
- [x] Surface placement: Offset distance (project-onto-selected pending)
- [ ] Brush Advanced: Size Unit (View px vs Scene world units), Spacing,
      Angle/Factor, Aspect X/Y (see Blender's Ink Pen Rough panel)
- [ ] Draw on real mesh surfaces (cube etc.), not just canvas planes

## NPR brush engine (the current focus)
Goal: expressive natural-media brushes (ink, charcoal, marker, airbrush)
rendered in real time. Approach: per-stroke baked style, stamp-based
rendering along the stroke with procedural grain in the fragment shader.
- [x] Scene-unit stroke width (world-space radius in the ribbon shader)
- [x] Stroke style data (stamp mode, spacing, angle, aspect, jitter, grain)
- [x] Stamp geometry emission + rotated/aspect quads + grain fragment
- [x] Brush presets (Pen, Ink Rough, Marker, Charcoal, Airbrush) + UI
- [ ] Later: texture-sampled stamps (image brushes), smudge/blend brushes,
      paper grain overlay, buildup blending

## Post-parity roadmap (the action-painting lab)
1. Performance: instanced segment rendering, dirty-region geometry updates,
   pointer-event coalescing + prediction, worker-side fill.
2. Gesture control (Mental-Canvas-like): camera bookmarks with animated
   transitions, canvas "billboards" you can grab/rotate in 3D, push/pull
   strokes between planes, two-finger navigation, pen+touch simultaneous.
3. Live performance: MIDI/OSC bindings for brush params, audio-reactive
   modifiers, timed replay of stroke capture (action painting playback).
