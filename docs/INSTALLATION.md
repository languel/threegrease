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

### The gap: mapping the camera into the space

> Superseded in part — see "Mapping, not calibration" below. The original
> framing treated physical accuracy as the goal; it is one mode among
> several. The underlying gap is real either way.

**Nothing maps a camera into the room in a controllable way.** A stream's
placement is a hand-authored TRS you drag until it looks right, with no
notion of what region of the frame corresponds to what region of the space.
Monocular pose depth is a hip-relative guess, so the POSE stream ships with
its depth axis scaled to **zero** by default: a webcam produces a flat sheet
of landmarks at whatever scale you dragged it to.

For the cases where the zone really does have to line up with a doorway, the
answer is a **ground-plane homography**. Everyone stands on the same floor,
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
2. ~~**Detection is locked to MediaPipe**~~ — addressed by the semantic
   detection stream below, though model loading still needs verifying on
   real hardware. MediaPipe models are still CDN-loaded at runtime.
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

1. **The mapping layer** (free / region / homography) — unlocks the rest.
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

### Semantic detection (shipped, model loading UNVERIFIED)

`src/mm/detect.ts` — open-vocabulary detection: find things by *describing*
them. The queries are free text matched by CLIP's text tower, so "a person
wearing a hat" is as valid a class as "dog". A `DETECT` stream packs each hit
at its box centre into the same normalized convention MediaPipe uses, so
every downstream consumer — trigger zones, routes, clips — works on semantic
detections with no changes. A zone firing when "a person carrying a bag"
enters is an ordinary trigger zone.

Runs on its own interval, asynchronously, one inference in flight at a time.
This is **not** frame-rate work and the UI treats the interval as a real dial.

**What is verified:** the integration (pipeline name, options, packing), the
lazy chunking (transformers.js is a separate 568 KB chunk), the WebGPU→WASM
fallback path, and the whole UI.

**What is NOT verified:** that any model actually runs. `Xenova/owlvit-base-patch32`
— the most-cited model — fails session creation on transformers.js 4.2 with
`Could not find an implementation for Cast(13)`, identically on WebGPU and
WASM: its ONNX export predates the runtime. The `onnx-community/*-ONNX`
re-exports are current and now lead the list, but the embedded test browser
has a broken Cache API, so each attempt re-downloads hundreds of MB and the
probe could not be completed. **Model choice needs testing on the target
machine** — which is why it is a dropdown, and why a load failure now reports
"This model did not load in this browser — try another from the list"
rather than an ONNX graph-pass stack trace.

**Known limitation:** trigger zones key enter/leave state by probe INDEX, so
a detection set that reshuffles between frames reads as objects teleporting.
Hits are sorted by horizontal position, which is stable for well-separated
subjects and not a substitute for real tracking. That is the same identity
problem multi-person pose has, and it wants the same fix.

### Simulated sources — a virtual placeholder for every input

`src/actor/simstream.ts` + `src/app/demoscene.ts`.

The principle: **every key input has a virtual stand-in**, so a whole
installation — room, zones, mappings, event wiring — can be built and
exercised with nothing plugged in, then have any ONE piece swapped for a
real input with nothing else changing.

That works because a simulated source is not a special case anywhere. It
writes to the same `streamStore` MediaPipe writes to, in the same packing,
so every consumer downstream (trigger zones, routes, clips, the body-map
picker, the pen) genuinely cannot tell the difference.

Two source shapes:

- **ACTOR** — a full 33-point POSE, mapping joints back to landmark indices.
  This is the inverse of `rig.ts`'s `POSE_MAP`: there a landmark drives a
  joint, here the actor is the source of truth and the stream is synthesized
  from it.
- **OBJECT** — ANY object as ONE tracked point. This is what makes "any
  object is a tracking source" literal rather than actor-only: put a box on
  a `FOLLOW_PATH` and it *is* a visitor as far as a zone is concerned.

Both are sampled through a **scene camera**, not the app's viewport camera,
so the synthetic feed represents what a fixed camera in the room would see
regardless of where you happen to be looking while authoring. Landmarks
behind the camera or out of frame report low confidence rather than a
position that is silently wrong — the same contract a real detector's
low-confidence points carry.

Sampling runs *after* the constraint pass, because a `FOLLOW_PATH`-driven
actor's transform and its solved pose both have to be final for the frame
before they are read. That means a sim landmark reaches TRIGGER probing one
frame later than the capture it stands in for — irrelevant for a test
source, and cheaper than reordering the constraint pass for a feature most
scenes never use.

Wiring a stream to a sim source is **runtime state, not scene data**
(`App.setStreamDriver`) — the same category as "the webcam is running".

**File ▸ New — Demo gallery scene** builds the worked example: a 7×5×2.6 m
room, two pedestals, a trigger zone with enter/leave OSC, a rigged visitor
walking a GP loop, a security camera, that camera driving both a POSE and a
DETECT stream, and a hidden procedural point cloud standing in for a 3D
scan. It is deliberately code rather than a saved `.json`: a saved file
would rot silently the first time a field is added, and reading the builder
is the fastest way to see a worked example of every piece.

Placeholder coverage today:

| Input | Real | Virtual placeholder |
| --- | --- | --- |
| Body tracking | webcam + MediaPipe | actor sampled as a 33-point pose |
| Object/person position | detector | any object as one tracked point |
| Semantic detection | OWL-ViT queries | actor driving the DETECT stream |
| 3D scan | Kiri / splat import | procedural room point cloud |
| Camera | installed webcam | scene camera ("Security Cam 1") |
| Room geometry | photos / scan | modelled walls + pedestals |

**Camera plates** (📷 in the timeline camera cluster, `App.captureCameraPlate`)
close the reference-photograph gap and are a real feature beyond the sim:
snapshot any scene camera's view as a reference plane placed in front of it,
sized to fill the frustum exactly so it lines up pixel for pixel with what
that camera sees. It is the only reference plane guaranteed to be perfectly
registered to the space, because it was rendered *from* the space rather
than photographed *of* it. Virtually, it stands in for "go stand there and
take a photo"; with real geometry it is how you freeze a viewpoint to draw
over.

Still missing a placeholder: the mapping modes below, which do not exist yet.

### Mapping, not calibration

A correction to the earlier analysis. Registration was framed as "get to
physical truth", treating the hand-placed stream transform as a deficiency.
But a webcam watching one room can drive an installation in another, and
there deliberately flattening or non-physically scaling the tracking input is
the *point*. So the goal is not calibration; it is a **legible, controllable
mapping layer** in which physical accuracy is one mode among several:

- **Free** — place and scale the tracking volume by hand (what exists today)
- **Region** — map a crop of the camera frame into a target object's bounds,
  stretched or aspect-preserved. This is the remote-installation case.
- **Ground homography** — four image↔floor correspondences, for when the
  zone really does have to line up with a doorway.

`depthScale` is already the flattening dial and stays.

### Next

- Reference-image workflow: place a photo plane from a known camera position,
  multiple points of view registered to each other.
- Vertex/edge snapping on editable meshes (currently GP strokes and mesh
  faces only).
- Numeric entry while drawing — type a wall length instead of eyeballing it.
- `viewAll` should include measurements in its bounds.

## Walkthrough

Step-by-step instructions for setting up and running a fully virtual test —
loading the stock demo, watching the simulated tracking and zones work, and
swapping pieces for real inputs one at a time — are in
[VIRTUAL_TEST_WALKTHROUGH.md](VIRTUAL_TEST_WALKTHROUGH.md).
