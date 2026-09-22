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

### World & viewport shading
- [x] Viewport shading modes (Wireframe / Solid / Material / Rendered),
      topbar buttons + `Z` / `Shift+Z` to cycle
- [x] World panel (Scene tab): solid colour, gradient, equirectangular
      image, video / live capture, three.js physical sky
- [x] Environment lighting (IBL) with strength, plus background
      visibility / intensity / blur and rotation about the world up axis
- [x] 360 video environments, including live IBL from the footage
- [ ] Environment texture node graph (Blender-style mapping/coords)
- [ ] HDR/EXR loading (currently LDR images only)

### Interactive installation (north star — docs/INSTALLATION.md)
- [x] Trigger zones on any object, volume/plane/topology tested
- [x] Enter + leave events out over WS / OSC / MIDI
- [x] Capture-stream landmarks probe every zone automatically
- [x] Splat + mesh scan import (Kiri and similar work today)
- [x] Measure tool, display units, scale-the-scene-from-a-measurement
- [x] Measurements as OBJECTS: outliner row, transform, parent, colour,
      closed rings with area, and per-point BINDING (a point snapped to a
      vertex/surface/origin stays on it, an actor's point rides its joint)
- [x] Plane: Up from Ground — floor plan first, then lift walls straight up
- [x] Shape tools snap at their ends (Snap: Ends / Every point)
- [x] Drop files onto the viewport to place them (splats, models, images, GP json)
- [x] Splat Edit mode: box / lasso / circle select, delete (undoable, file untouched), point-cloud view, opacity (confidence) and size filters; export writes what is shown
- [x] Splats: select/delete filtered, crop to selection, separate selection into a new baked PLY
- [x] Measurements: rescale the attached object; align an object by paired measurements (scan pedestal onto a virtual one)
- [ ] Splats: move/rotate selected splats, live boolean crop/filter volumes
- [x] Time volumes: video/GIF as a space-time cube; position and time-map slices on any mesh; scrub and play
- [x] Time volumes: live camera recorded into a ring (freeze to hold)
- [x] Time volumes: surface slices (a bent time sheet), convert to splats (stride, brightness, motion)
- [x] Time volumes: ray-marched Volume display; filters (people via MediaPipe segmentation, colour key, brightness, motion) shared by display, slices and splats; source picker
- [x] Time volumes: playhead (crisp slice / cut block), scan axis, play / pause / scrub
- [ ] Time volumes: animated strokes/actors as sources, segmenting live volumes
- [x] Persistent file store (IndexedDB) and an asset Library with thumbnails, drag-to-place
- [x] Placement / Plane / Guide as a global top-bar cluster (Object, Draw, Edit)
- [x] Restyle selected strokes (Stroke Style panel)
- [x] Snapping: a drag no longer snaps to the object it is dragging; Vertex
      and Edge reach conventional meshes (budgeted, so a scan stays cheap);
      Nearest gains a Draw target
- [x] A sun's shadow box is fitted to the scene, with the bias scaled to
      the fit
- [x] AREA lights (three's RectAreaLight: a soft box with a real falloff,
      no shadows, meshes only) and an aim handle for every directional
      light — sun, spot and area
- [x] Plan inside a SCAN: imports open into a dollhouse view (single-sided,
      normals inward) and can be clicked and snapped THROUGH onto their own
      floor; imports get tint/opacity/two-sided/unlit/wireframe of their own
- [x] Per-instance video/GIF playback (play, pause, speed per object); the
      Library's own copies rest; texture slots pick from the Library
- [x] One selection mark everywhere: meshes take the render silhouette, and
      so does the object being drawn
- [x] Light gizmo: drag the cone, the blend and a point light's reach; aim a
      projector by dragging the spot it makes
- [x] Angles in degrees, with pi/deg/rad and arithmetic accepted in any
      angle field
- [x] Projector KEYSTONE: drag the four corners of the thrown picture onto
      the real corners of what it is aimed at (projection mapping), and aim
      a projector by dragging the spot it makes
- [x] Transform ORIENTATION (global / local / normal / gimbal / view /
      cursor / parent) and PIVOT (median / bounding box / cursor /
      individual origins / active) as top-bar dropdowns, driving every
      axis lock in both editors; N / Shift+N move along or across the
      normal; Ctrl inverts the magnet in every drag
- [x] Cameras are OBJECTS: outliner row, selection, transform widget,
      parenting and delete, with lens / focal length / clipping / keys in
      the properties panel
- [x] LENSES for cameras and projectors: equidistant / equisolid /
      polynomial (Bourke's measured form) fisheye, equirectangular,
      cylindrical, mirror ball — a dome projector and a 360 camera
- [x] Draw objects in place (plane, rect, triangle, n-gon, box, cylinder,
      pyramid, sphere, the four platonic solids) with the same placement,
      plane, guide and snapping as a stroke — blocking out a set is drawing it
- [x] Projectors: FLAT (unlit) projection, edge blending, masking, and
      "look through the light" (Ctrl+0) to aim one by flying it
- [x] PROJECTORS: a spot light that throws a picture — a gobo (a shape cut
      into the beam) or a projection (image, video, camera), at a real
      aspect, with the throw readout (distance and image size on what it
      hits) an installation is planned around
- [x] Library as a container: folders, drag to file, zip export/import,
      cameras and videos as live sources, render view / selection to it
- [ ] Pack a scene with its stored files for moving between machines
      (**the next phase's first blocker** — see docs/HANDOFF.md)
- [ ] Measurements: curved legs (arc/spline) and surface-following paths
- [x] Shared snapping module so every tool gets the one magnet
- [x] Semantic detection: open-vocabulary (text-query) streams feeding the
      existing zone/probe machinery — model loading unverified, see docs
- [x] Simulated tracking sources: any object (one point) or actor (full
      pose) drives a stream through a scene camera — build and test an
      installation with no hardware attached
- [x] Stock demo gallery scene (File ▸ New — Demo gallery scene): room,
      pedestals, trigger zone, visitor walking a path, security camera,
      driven POSE + DETECT streams, procedural scan placeholder
- [x] Camera plates: snapshot any camera's view as a perfectly-registered
      reference plane (the reference-photograph placeholder, and a real
      feature for freezing a viewpoint to build against)
- [ ] Tracking MAPPING layer: free / region / ground-homography modes
      (physical accuracy is one mode, not the goal — remote installations
      deliberately want non-physical scaling)
- [ ] Multi-person tracking with identity across frames
- [ ] ONNX Runtime Web + model registry (detection beyond MediaPipe)
- [ ] Photo → depth → point cloud (in-browser space capture)
- [ ] Reference-image workflow: several registered points of view
- [ ] Numeric entry while drawing; editable-mesh vertex snapping
- [ ] Gallery runtime: local models, kiosk boot, heartbeat

### Agent / assistant
- [x] In-app chat panel — local + hosted providers, native tool calling
- [x] MCP + ACP over a relay (Claude Code, Claude Desktop, Zed)
- [x] WebMCP — the same registry handed to the browser's own agent
- [x] Chat-shaped panel: bubbles, compact tool log, tooltips over prose
- [ ] Batch a whole prompt into ONE undo step (currently one per tool call)
- [ ] Streaming assistant text (replies land whole today)

### Actors (rigged characters)
- [x] Default humanoid mannequin (21 joints, 20 bones, joint limits)
- [x] Positional skeleton: joints as particles, bones as distance
      constraints — one solver for physics AND kinematics
- [x] Ragdoll: verlet + PBD projection, joint limits, muscle tone, floor
- [x] FABRIK IK on joint positions
- [x] Auto-rig from capture: MARKERS (1:1), ANGLES (retarget), IK
- [x] Size matching so a performer of any height drives any character
- [x] Live posing: drag a joint (Actor Pose tool), Shift+click to pin
- [x] MIDI/OSC/WS routes — `actor.<id>.joint.<name>.<x|y|z>` and physics
- [x] Agent tools `actor.create` / `actor.rig` / `actor.pose`
- [x] Attach any object to a rig control: COPY_LOCATION/COPY_ROTATION/
      TRACK_TO/LIMIT_DISTANCE/SPRING constraints can target a specific
      joint (not just the actor root) — props on a hand, a camera on
      the head, an empty tracking a foot for ground locking later
- [ ] Self-collision between limbs
- [ ] Pose library + keyframing an actor's pose onto the timeline
- [ ] Skinned mesh (bind an imported character to the skeleton)
- [ ] Foot IK / ground locking so feet stop sliding
- [ ] Hand and face rigs from the HAND_*/FACE streams

### Blender parity gaps spotted in use (reference screenshots 2026-07-06)
- [x] Drawing Plane: "Cursor" option (plane through the 3D cursor)
- [x] Surface placement: Offset distance (project-onto-selected pending)
- [x] Brush Advanced: Size Unit (View px vs Scene world units), Spacing,
      Angle/Factor, Aspect X/Y (see Blender's Ink Pen Rough panel) — done
      as part of the NPR brush engine below (StrokeStyle)
- [x] Draw on real mesh surfaces (cube etc.), not just canvas planes —
      SURFACE placement raycasts TGMesh/TGSplat draw targets
      (`ctx.surfaces`); canvas planes themselves are retired

## NPR brush engine
Goal: expressive natural-media brushes (ink, charcoal, marker, airbrush)
rendered in real time. Approach: per-stroke baked style, stamp-based
rendering along the stroke with procedural grain in the fragment shader.
- [x] Scene-unit stroke width (world-space radius in the ribbon shader)
- [x] Stroke style data (stamp mode, spacing, angle, aspect, jitter, grain)
- [x] Stamp geometry emission + rotated/aspect quads + grain fragment
- [x] Brush presets (Pen, Ink Rough, Marker, Charcoal, Airbrush) + UI
- [x] Textured strokes + fills via a shared image atlas (render/atlas.ts) —
      one atlas bound as uAtlas, per-vertex sub-rect, so a merged per-layer
      batch can still give every stroke its own texture (unblocks "N8")
- [x] Stroke/fill Style: Solid, Gradient (along + across), Texture
- [x] Variation along the stroke: random / curvature / draw speed (input
      sampling density, baked before simplify destroys it) / arc position,
      signed amounts for width + opacity, plus taper in/out
- [x] 8 expressive presets: Pencil Soft/Hard, Ink Pooling, Brush Pen,
      Chalk, Dry Brush, Fading Marker, Calligraphy
- [x] Non-overlapping stroke geometry: one miter-joined strip per stroke
      (was per-segment quads + a disc per point, which beaded at every join)
- [ ] Later: smudge/blend brushes, paper grain overlay, buildup blending,
      per-stroke overlap compositing (only matters below full opacity)

## Platform phases (docs/IMPLEMENTATION_PLAN.md) — status
- [x] P0 NPR brushes · [x] P1 Blender interop · [x] P2 event bus/IO
- [x] P3 scores (cursors/triggers/attachments) · [x] P4 routes
- [x] P5 string art solver + attractor string sim
- [x] P6 multi-view wire art · [x] P7 splats (Spark) · [x] P8 exporters
- [x] P9 mediamime protocol · [x] P10 perf pass (per-layer rebuild 10.2x;
      worker fill + stamp instancing deferred)

## Post-parity roadmap (the action-painting lab)
1. Performance: instanced segment rendering, dirty-region geometry updates,
   pointer-event coalescing + prediction, worker-side fill.
2. Gesture control (Mental-Canvas-like): camera bookmarks with animated
   transitions, canvas "billboards" you can grab/rotate in 3D, push/pull
   strokes between planes, two-finger navigation, pen+touch simultaneous.
3. Live performance: MIDI/OSC bindings for brush params, audio-reactive
   modifiers, timed replay of stroke capture (action painting playback).

## Editable generalized meshes (TGPolyMesh)
- [x] Persistent mixed-dimensional topology objects (0D/1D/2D in one mesh):
      isolated vertices, open chains, tris/quads/n-gons, non-manifold OK
- [x] POLY edit mode + Topology Pen (click builds chains/faces, click edge
      splits, drag vertex moves, drag boundary edge extrudes a quad)
- [x] Spatial query layer (distance / sphere intersection over points +
      segments + triangles) with TRIGGER-constraint integration
- [x] Draw-target faces, GLB export (faces + line/point primitives),
      serialization migration, verify doc (docs/verify/editable-generalized-mesh.md)
- [ ] Later: live source re-binding, BVH acceleration, loop/multi-edge ops
