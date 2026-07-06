# threegrease — Product Requirements

*A platform for pedagogy and interactive art practice, built on an
expressive 3D drawing core. Owner: languel. Drafted 2026-07-06.*

## 1. Vision

One web-native environment where an artist-educator can: draw expressively
in 3D space the way Blender Grease Pencil allows, but live; sequence and
perform those drawings as *scores* that emit MIDI/OSC/WebSocket events the
way IanniX does; grow forms generatively (string art, wire art, attractor
systems); paint in and around captured reality (Gaussian splats); and hand
all of it to students in a browser with nothing to install.

The unifying idea: **every line is simultaneously an image, a path, an
instrument, and a constraint.** A stroke can be drawn for its look, ridden
by a cursor emitting music, used as a rail for an animated object, treated
as a string in a physical simulation, or counted as a chord in a
string-art solver. The platform makes those readings interchangeable.

## 2. Background — projects being unified

- **threegrease today**: feature-complete GP match (see docs/HANDOFF.md §2).
- **routional** (Blender addon by owner): bind incoming MIDI/OSC events to
  properties with learn-mode and range mapping. Here: incoming events bind
  to *any* scene/settings property (brush size, layer opacity, camera,
  modifier params) for live control.
- **iannix** (owner's fork of IanniX): curves + cursors + triggers score
  model emitting OSC. Here: strokes *are* the curves; cursors ride them on
  independent timelines; triggers fire on proximity/crossing.
- **mediamime** (owner's web app): shapes drawn over camera → MediaPipe
  recognition → Web MIDI. Here: interop peer — its events flow into the
  same bus, and threegrease can act as its 3D output.
- **String art** (Bridges 2022, Demoussel et al.): greedy chord selection
  to render a target image between pins. Here: generative solver whose
  output is ordinary stroke data — plus a *dynamic/simulated* variant.
- **Multi-view wire art** (Hsiao et al. 2018): one 3D curve that reads as
  different drawings from different viewpoints. Here: solver mapping 2–3
  user drawings + cameras to a single 3D stroke network.
- **Gaussian splats**: import/paint/edit/render splats alongside strokes
  (via the Spark three.js renderer).

## 3. Personas

1. **The educator** (owner's primary role): teaches interactive art /
   creative coding. Needs: zero-install, projectable, save/load, examples,
   every concept inspectable (data model is plain JSON on purpose).
2. **The live performer**: draws + triggers sound in front of an audience.
   Needs: presentation mode, low latency, rebindable controls, MIDI/OSC
   out, camera choreography, nothing that blocks the render loop.
3. **The artist-researcher**: explores form-finding (string/wire art,
   splat painting). Needs: solvers with exposed parameters, export to
   fabrication formats (OBJ/STL), Blender round-trip.
4. **The student**: follows along, remixes scenes. Needs: forgiving undo,
   readable UI, keyboard map discoverable in settings.

## 4. Product areas & requirements

Priorities: **P0** = core commitment, **P1** = strongly wanted, **P2** =
opportunistic. Each maps to a phase in IMPLEMENTATION_PLAN.md.

### A. Expressive drawing core (P0)
- A1. NPR brush engine: stamp-based brushes with spacing/angle/aspect/
  jitter/grain, scene-unit (world-space) widths, hardness; presets (Pen,
  Ink Rough, Marker, Charcoal, Airbrush); per-stroke baked style.
- A2. Blender-parity gaps: Cursor drawing plane, Surface offset +
  project-onto-selected, brush Advanced panel (size unit view/scene,
  spacing, angle/factor, aspect), draw on imported meshes.
- A3. Target: match Blender 5.x GP expressiveness for drawing feel;
  texture-sampled (image) brushes and paper grain as follow-on.

### B. Blender interop (P0)
- B1. Versioned `.threegrease.json` schema (already the native format).
- B2. Blender addon (Python, lives in `blender/` in this repo) that
  imports/exports that JSON to/from **GPv3** (Blender 4.3+/5.x: GreasePencil
  ID → layers → frames → Drawings on CurvesGeometry; map position, radius,
  opacity, vertex color, cyclic, materials, layer names/opacity/blend,
  keyframe numbers; coordinate convention Z-up matches our default).
- B3. Fidelity statement documented per attribute (what round-trips, what
  degrades). SVG import (P2) for paths from elsewhere.

### C. Event system — "scores" (P0; the IanniX inheritance)
- C1. **Event bus**: typed internal pub/sub; every emitter/consumer speaks
  it. Message = {source, type, channelish address, value(s), time}.
- C2. **Outputs**: Web MIDI (native), OSC + arbitrary JSON over WebSocket
  (browser can't UDP; ship a tiny Node bridge `bridge/` that relays
  WS↔UDP-OSC/MIDI for hardware), plus console/monitor panel (learnable).
- C3. **Cursors**: playheads attached to any stroke/path: independent
  speed/period/phase/loop/ping-pong/ease, own timeline not the GP frame
  clock; stream progress + world position as messages; visible as glyphs.
- C4. **Triggers**: point objects that fire when a cursor (or attached
  object) passes within radius / crosses a plane; one-shot/retrigger;
  message template per trigger.
- C5. **Path-attached objects**: any scene object (canvas plane, camera,
  splat, imported mesh, another GP object) rides a path with its own
  timeline; orientation follow (tangent/up), offset.
- C6. Transport: global play plus per-cursor independent transports;
  everything keyframable later.

### D. Property routing in (P0; the routional inheritance)
- D1. Routes: incoming MIDI/OSC/WS event → target property path (brush
  size, layer opacity, modifier param, camera FOV, cursor speed, …).
- D2. Learn mode (click property → wiggle controller), range mapping
  (raw/scale/clamp/wrap), monitor panel of recent events.
- D3. Routes persisted in scene JSON; safe when target path is missing.

### E. Generative form-finding (P1)
- E1. **String art solver**: pins on any closed stroke/canvas frame;
  greedy chord selection vs target image (imported bitmap or rendered
  layer); semi-transparent accumulation; stopping conditions; output =
  strokes (thus drawable/exportable/ridable by cursors). Dynamic variant:
  strings as physical constraints (springs) that relax/vibrate — usable as
  performance visual.
- E2. **Attractors/constraints**: point/curve attractors that deform or
  guide strokes toward target forms (generalizes E1; parameters routable
  from D).
- E3. **Multi-view wire art**: given 2–3 target drawings + their cameras,
  solve a connected 3D stroke network whose projections approximate the
  drawings (voxel greedy fill → connect via 3D pathfinding → spline fit,
  after Hsiao et al.). Manual-assist mode first (draw-from-view with
  multi-view residual overlay), full solver second.

### F. Gaussian splats (P1)
- F1. Import .ply/.spz/.splat/.ksplat/.sog via **Spark** (SplatMesh is an
  Object3D; renders alongside our meshes — confirmed feasible; do NOT
  write a custom splat renderer).
- F2. Splats as scene objects: transform, attach to paths (C5), draw on
  their apparent surface (depth from splat render), occlusion between
  strokes and splats.
- F3. Splat painting/editing (P2): select/delete/recolor splat regions;
  "paint splats" brush emitting new gaussians.

### G. Export (P1)
- G1. GLB (strokes as tubes/ribbons + fills as meshes; three
  GLTFExporter), OBJ, STL (fabrication: string/wire art results),
  PLY for splat scenes. PNG snapshot exists; frame-sequence export P2.

### H. mediamime interop (P2)
- H1. Its recognized-shape events arrive over WS into the bus (C1) —
  camera gestures trigger threegrease scores and vice versa; a shared
  message vocabulary documented in `docs/protocol.md` when built.

### I. Platform & pedagogy (cross-cutting)
- I1. Outliner panel (objects/layers/canvases/cameras/cursors/triggers).
- I2. Example scenes + short lesson notes per feature area.
- I3. Everything keyboard-rebindable; prefs persist; presentation mode
  covers all new visual objects (cursors/triggers hidden or stylized).
- I4. Perf: 60 fps drawing with ≥10k stamp quads on a mid laptop;
  incremental geometry rebuild (plan P10) before heavy generative scenes.

## 5. Non-goals (for now)

- Multi-user collaboration / networking beyond the WS bridge.
- Mobile/touch-first UI (pen+touch desktop browsers are in scope).
- Full Blender armature/lattice rigs; curve-edit mode on strokes.
- Audio synthesis in-app (we emit events; sound lives outside).
- Photoreal rendering; we are proudly NPR.

## 6. Success criteria

1. A performer draws a stroke, attaches a cursor at 0.5 Hz, and a synth
   (via the WS bridge or Web MIDI) plays it — under 3 minutes from blank
   scene, no code.
2. A scene authored in threegrease opens in Blender 5 via the addon with
   recognizably identical strokes (positions/widths/colors/layers), and
   a GP scene from Blender draws back the other way.
3. Ink Rough / Charcoal presets are visibly organic (grain, stamp
   rotation) and hold up under camera moves (scene-unit widths).
4. String-art solver reproduces a recognizable portrait with ≤3000 chords
   and exports an STL/OBJ pin+string layout.
5. A splat scan loads via Spark and strokes correctly occlude with it;
   a canvas-plane portal scene runs at 60 fps in presentation mode.
6. A student can open Settings and discover/rebind every shortcut.

## 7. Risks & mitigations

- **Scope**: each area is a product. Mitigation: phases are independently
  shippable; the event bus (C1) is the only hard cross-dependency.
- **Splat renderer coupling**: Spark's API may shift (2.0 preview).
  Mitigation: isolate behind `src/splats/` adapter; pin version.
- **Browser OSC**: requires the Node bridge for UDP hardware. Mitigation:
  WS-native path works without it; bridge is ~100 lines, documented.
- **GPv3 API churn** (Blender 5 renames). Mitigation: addon targets 4.3+
  API names with version guards; JSON schema is ours and stable.
- **Perf under stamps/solvers**: mitigation P10 moved before heavy
  generative work; solvers run in Web Workers.
- **Weaker implementing models**: mitigation — IMPLEMENTATION_PLAN.md
  specifies data models, file placement, acceptance tests, and forbidden
  shortcuts per phase; HANDOFF.md lists the landmines.
