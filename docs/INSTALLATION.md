# Interactive installation — the north star

*The motivating use case for threegrease, and the roadmap toward it.*

Published analysis (same content, nicer to read):
<https://claude.ai/code/artifact/e4f580de-de2e-4a9b-bf9c-e73b58b9b340>

## The scenario

An interactive-installation class goes into a gallery. Students sketch the
space, build a simplified floor plan, and lay out installations that track
visitors — web cameras, depth cameras, physical-computing sensors — and
activate multimedia in response.

threegrease should be where that gets designed: block the room out in real
detail (reference photographs placed as 3D planes, or a 3D scan dropped in),
define 2D and 3D interactive regions, and have those regions emit events from
live people-tracking. Models run in or near real time in the browser, and the
workflow moves freely between 2D and 3D references.

## Where we actually stand

Verified by reading the source, August 2026.

### Already built

- **Blocking out**: reference photos as textured planes, GP strokes,
  editable meshes, `.glb/.gltf/.obj` import, and **splat import via Spark**
  (`.ply/.spz/.splat`) — so Kiri scans already work.
- **Interactive regions**: the `TRIGGER` constraint on *any* object. Box,
  sphere and cylinder primitives test their real volume; a plane fires on
  crossing; an editable mesh tests its own topology. Separate enter and leave
  messages, retrigger control, `{x} {y} {z} {id} {name}` substitution.
- **Probes**: every landmark of every capture stream automatically tests
  every zone. No wiring step — "a hand entering a virtual box" is a box with
  a TRIGGER on it.
- **Event I/O**: bus → WebSocket (bidirectional) → UDP OSC through
  `bridge/`, plus MIDI in and out, plus routes from incoming events onto
  scene properties.
- **Tracking**: MediaPipe pose/hand/face on the GPU delegate.
- **Rehearsal**: clips record world-space frames and replay through the same
  path as live data, so a piece can be tested without an audience.
- **Measurement** (new, see below).

### The blocker

**Nothing registers a camera to the room.** There is no calibration code in
the repository — a stream's placement is a hand-authored TRS you drag until
it looks right. Worse, monocular pose depth is a hip-relative guess, so the
POSE stream ships with its depth axis scaled to **zero** by default. A webcam
therefore produces a flat sheet of landmarks at whatever scale you dragged it
to. You cannot say "a person is standing at the door" in world coordinates.

Every other box in the installation pipeline already works. This is the one
that doesn't, and everything else is downstream of it.

**The fix is a ground-plane homography.** Everyone stands on the same floor,
so four clicked correspondences (a point in the camera image ↔ a point on the
floor plan) give a 3×3 matrix converting image position to floor position, in
metres, permanently. No depth sensor, no full calibration. It also *is* the
2D↔3D round trip the workflow wants: click in a photo, get a world position.

Its honest limit: a homography places **feet on the floor**. Height off the
ground is not recoverable from one RGB camera.

### The other gaps, ranked

1. **One person at a time.** `numPoses: 1`. Raising the cap is one line, but
   that is not the work: a stream holds *one* landmark set and zones key
   probes as `mm:<stream>:<landmark>`. Crowds need a person-instance concept
   with identity across frames, so a zone can report *who* entered and for
   how long.
2. **Detection is locked to MediaPipe**, loaded from Google's CDN at
   runtime. Adding ONNX Runtime Web plus a small model registry opens up
   person detection, segmentation and counting. The `CUSTOM` stream kind and
   its `[x,y,z,confidence]` packing were designed for this and are unused.
3. **Photo → 3D in the browser.** Smaller than it looks: painted point
   clouds (`TGPaintCloud`) are already a serializable, transformable,
   constraint-carrying container of arbitrary `[x,y,z,radius,r,g,b,a]` points
   that exports real 3DGS PLY. Depth Anything V2 (small) runs client-side
   via ONNX. So the work is depth model → unproject → write a paint cloud.
   No new rendering, no new data model.
4. **Surviving a gallery.** CDN model loading fails on hostile wifi. No
   kiosk mode, no autostart, no watchdog, no heartbeat for a piece running
   unattended.

### Sequence

1. **Register a camera to the floor** — unlocks everything downstream.
2. **Track several people with identity** — makes it a crowd piece.
3. **Capture the space faster** — depth-to-cloud, measuring affordances.
   Independent of 1 and 2; can lead if the teaching calendar wants it.
4. **Make it survive the run** — local models, kiosk boot, heartbeat, and a
   saved calibration that reloads with the scene.

### What not to overpromise

- In-browser photo→3D gives a depth-derived point cloud, **not** a match for
  a desktop reconstruction. Feed-forward splat generation from one image is
  active research and heavy for a browser.
- Multi-person IDs **will** swap under occlusion — exactly what galleries
  produce. Design pieces so a swap is survivable.
- Frame-rate budgets are unmeasured; detection, solver and renderer all want
  the same GPU.

## Blockout tooling (in progress)

The workflow being streamlined: bring in reference images from several points
of view, build the room from them by hand, then block out pedestals and wall
placements — with real-world dimensions throughout.

### Shipped

- **`tools/snapping.ts`** — the magnet as a reusable function. This logic
  used to be inline in `App.placeCursor`, which meant the 3D cursor was the
  only thing in the app that could snap to a vertex, edge, face or object
  origin. Every precise-placement tool now shares it, and the one magnet
  setting in the topbar still governs all of them.
- **Measure tool** (`tools/measure.ts`) — click points for a ruler.
  Per-segment lengths, interior angles (squaring a room off photographs is
  mostly a question of whether the corners are really 90°), and a running
  total. Points snap through the shared magnet, so a ruler lands on a real
  vertex rather than near one. Measurements are scene data: a blockout is
  built over days, so "that doorway is 900" has to survive a save.
- **Display units** — metres, centimetres, millimetres, feet, inches. The
  scene stays unitless with **1 unit = 1 metre** by convention (the actor
  mannequin is 1.8 tall, gravity is 9.81). Changing the unit never moves
  anything.
- **Scale the scene from a measurement** — the payoff. Build a room at
  whatever arbitrary size the eye produced, measure something you actually
  know, type the real figure, and every root object, camera, trigger radius
  and measurement rescales at once. Everything downstream then means
  something in metres.

### Next

- Reference-image workflow: place a photo plane from a known camera position,
  multiple points of view registered to each other.
- Vertex/edge snapping on editable meshes (currently GP strokes and mesh
  faces only).
- Numeric entry while drawing — type a wall length instead of eyeballing it.
- `viewAll` should include measurements in its bounds.
