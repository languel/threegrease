# Testing an installation with nothing plugged in

*Step-by-step. For the design behind this, see [INSTALLATION.md](INSTALLATION.md)
("Simulated sources — a virtual placeholder for every input").*

The idea: every piece of a real installation — a tracked visitor, a camera,
a 3D scan — has a virtual stand-in that feeds the exact same code path a real
one would. So you can build and test a whole setup (zones, OSC output,
mappings) with no webcam, no scan, nothing plugged in, then swap one piece
for a real input at a time.

This walks through the stock demo, then how to build your own from scratch.

## 1. Load the stock demo

**File ▸ New — Demo gallery scene.**

This replaces the current scene (undoable — `Ctrl+Z` gets it back) with:

- a 7×5×2.6 m room (floor + 4 walls)
- two pedestals ("Pedestal A", "Pedestal B")
- a rigged mannequin ("Visitor") walking a loop between them
- a proximity trigger zone beside Pedestal A (see step 3 for why it's a
  separate object)
- a second camera ("Security Cam 1") mounted in a corner
- two streams driven by that camera: a full-skeleton pose stream and a
  single-point "detect" stream
- a hidden point cloud standing in for a 3D scan of the room

Switch to **Object mode** (toolbar, top-left arrow icon, or `Tab`/`1`) and
press **Space** to play. The mannequin should walk the oval loop between the
pedestals continuously.

If it's not moving: select "Visitor" in the outliner, open the **Actor**
tab (the standing-figure icon in the properties sidebar), and confirm
**Simulate** is checked under Physics.

## 2. Watch the simulated tracking work

Open the **Capture** tab (camera icon, "Capture — live landmarks & object
rigging") and find **Streams — native capture**. You'll see two rows:

- `Security Cam · Pose (sim)` — 33 points
- `Security Cam · Detect (sim)` — 1 point

Both carry an orange **SIM** badge, meaning they're driven from a virtual
source, not a webcam. Expand a row: under **Sim source** you'll see it's
set to the Visitor actor, `via camera` Security Cam 1.

Play the animation again and watch the stream row — the values update every
frame as the mannequin walks, exactly as if a real camera were tracking a
real person.

**Expected oddity:** the visible landmark dots won't sit *on* the mannequin.
A stream's landmarks are placed by that stream's own transform (position /
rotation / scale in its row), and a fresh camera stream defaults to standing
its cloud up in front of the origin. The simulation supplies the *content* of
the frame, not where the cloud lands in the room — exactly like a real
webcam, where you place the stream to match your space. Aligning those two is
the mapping work that doesn't exist yet (see INSTALLATION.md, "Mapping, not
calibration"). The zone in step 3 fires off the walking visitor directly, so
it's unaffected.

## 3. Watch the zone fire

Open the **Bindings** tab and find **Events / IO** near the bottom. There's
a live monitor showing the last 10 bus messages.

Play the animation. As the Visitor's loop passes Pedestal A you'll see the
zone open and close each lap:

```
13.4 constraint:1 /gallery/enter/pedestalA -1.801 0.976 0
15.0 constraint:1 /gallery/leave/pedestalA 1
21.8 constraint:1 /gallery/enter/pedestalA -1.8 0.977 0
```

The three numbers on `enter` are the probe's world position — where the
visitor actually was when they crossed in.

You should also see Pedestal A's zone flash briefly in the viewport when it
fires; that's the same feedback a real installation gets.

**This is the whole point.** A real webcam tracking a real person produces
*identical* messages on this bus. Run `bridge/` (see its README) and they go
straight out as OSC to Max / TouchDesigner / SuperCollider, with nothing else
changed.

### Why the zone is a separate object, not the pedestal

In the outliner you'll see **Zone · near Pedestal A** as its own (empty)
object rather than the trigger living on the pedestal itself. That's
deliberate, and it's a trap worth knowing about:

> A `TRIGGER` takes its **shape from its carrier**. On a box, sphere or
> cylinder it tests that primitive's actual volume and **ignores the
> `radius` field entirely**. Only a carrier with no geometry (an Empty)
> falls through to the sphere test where `radius` is what decides.

Hanging the trigger off the pedestal gave a zone the size of the pedestal —
the visitor walked past 0.8 m away and nothing ever fired, with no error to
explain why. If you want a proximity bubble, use an Empty. If you want
"inside this volume", use the box.

### If the monitor is drowning in traffic

The demo turns **emit bus** OFF on both streams. A pose stream re-broadcasts
all 33 landmarks every frame, which buries everything else in a 10-line
monitor. Streams still *probe* zones with it off — that's a separate switch —
so nothing is lost but noise. Turn it back on in the stream's row if you
want to see raw landmark traffic.

## 4. Try the semantic-detection placeholder

Same Streams panel, expand `Security Cam · Detect (sim)`. The **Look for**
box holds the text query (defaults to `a person`). This is where a real
`DETECT` stream's open-vocabulary query goes — "a person wearing a hat", "a
dog" — once a model is loading successfully (see the note at the bottom of
this doc).

Right now the sim path bypasses the model entirely: it drives the stream
from the Visitor's position directly, so you can test that zones/routes
respond to a DETECT-kind stream before any model is involved.

## 5. Look through the security camera

Timeline camera row (bottom of the screen): the camera dropdown lists
"Camera 1" and "Security Cam 1". Pick the latter, then press **0** (or the
camera icon button) to look through it. You should see the room from a
high corner angle with the Visitor walking below.

Click the **photo icon** next to the camera controls (📷, "Snapshot this
camera's view…") to bake that exact view into a reference plane placed in
front of the camera. This is the virtual stand-in for "go stand there and
take a photo" — the resulting plane is pixel-registered to the room, so you
can draw or block out against it later.

## 6. Look at the scan placeholder

In the outliner, find **Room scan (simulated)** — it's a paint-cloud object,
hidden by default. Click its eye icon to show it. You'll see a scattered
point cloud over the floor and walls, standing in for what a real Kiri /
3D-Gaussian-Splat capture of the room would look like once imported.

Use this to sanity-check that measuring, snapping and zone placement behave
sensibly against noisy scan-like data, before you actually go scan the room.

## 7. Walk the room yourself

The simulated visitor is on rails, which is the point when you want a
repeatable test — but you also want to walk the space and see what a
person actually sees, and to author a path by walking it rather than by
drawing an oval and hoping.

Select the **Visitor** actor, open the **Actor** tab, and hit **Possess —
take the controls** (or press `Shift+P` with the actor selected):

| Key | Does |
| --- | --- |
| mouse | look — and the character turns to face where you look |
| `W` `A` `S` `D` | walk, relative to where you're looking |
| `Shift` | run |
| `V` | switch first ↔ third person |
| `R` | start/stop recording this walk as a clip |
| `Enter` | done — leave the camera where it is |
| `Esc` | done — put the camera back where it was |

Things worth noticing while you drive:

- **The legs walk.** Nothing about possession poses the character: the gait
  engine sees the root move and generates the walk cycle, exactly as it
  does for the actor on its path. Steering and path-following are the same
  animation, so what you see driving is what you'll get on playback.
- **You bump into things.** Walls and pedestals block; a low platform is
  something you step onto rather than into. Collision is world-AABB
  push-out against mesh objects — conservative for rotated geometry, exact
  for the axis-aligned rooms people actually build. To let the character
  walk through a piece of reference geometry, turn off **Collide** on that
  mesh.
- **Zones fire for you too.** Walk into the bubble by Pedestal A and the
  event monitor shows `/gallery/enter/pedestalA`, same as when the
  simulated visitor passes through it. That is the whole test: an
  installation should not be able to tell the difference between a
  scripted visitor, a simulated one and you.
- **The actor's own constraints stand down while you drive.** If you
  possess an actor that has a `FOLLOW_PATH`, it stops following for the
  duration instead of snapping back onto the path under you. Release and
  it picks the path up again.

### Sending it somewhere instead of driving it

Release the controls and open **Actor ▸ Go to**. Set the goal to **A
point**, put the 3D cursor where you want the character to end up
(Shift+RMB in the viewport), and hit **Send to the 3D cursor** — it walks
there on its own, easing into the goal so the last stride shortens instead
of the walk stopping dead. Set the goal to **An object** and it walks to
wherever that object is *now*, which is what you want for "meet the
visitor" or "return to the plinth".

You can also say it in words: the `actor.goto` agent tool takes a point or
an object, so the same instruction works from the in-app chat, from Claude
Code over MCP, or from anything else driving the agent bridge.

Worth knowing:

- **This is steering, not pathfinding.** It seeks, slides along what it
  brushes, and steps around what is directly in its way. That covers a room
  with furniture in it. It will not solve a maze, and if it wedges in a
  concave corner it stops and reports **stuck** rather than shuffling in
  place forever while the legs dutifully animate a walk going nowhere.
- **A goal takes the character off its path** — and keeps it off after it
  arrives, until you clear the goal. Otherwise the old `FOLLOW_PATH` would
  grab it the instant it got where you sent it.
- **Turn rate is deliberately not instant.** A body that snaps round spins
  under its own planted foot and visibly scuffs.

### Recording a walk, and turning it into the loop

Press `R` (or **Record this walk**) while possessed, walk the route you
want, press `R` again. That commits a clip of the path you walked. Then:

1. **Capture** tab ▸ **Clips** ▸ the pencil icon on your clip — bakes it to
   a GP stroke, one point per recorded frame.
2. Edit that stroke like any other: **smooth** it to take the wobble out of
   a hand-driven path, **sculpt** it to nudge a corner wide.
3. Select the stroke, then on the actor's **Constraints** tab add ▸ **Follow
   Path** ▸ *Use selected stroke*, and set the speed.

The actor now re-walks the route you walked, with the gait regenerating the
footfalls at whatever speed you set. This is usually a better loop than a
drawn oval, because a walked path already has the pauses and the wide
corners a person actually takes.

## 8. Swap one piece for something real

Everything above works because a simulated source and a real one are
indistinguishable to the rest of the app. To replace a piece:

- **Replace the tracked visitor with a real webcam**: in the Streams panel,
  on the `Pose (sim)` row, click the **✕** next to "Sim source" to clear the
  driver. Then use **+Pose** in the same panel and **Camera** to start a real
  webcam capture into a new POSE stream.
- **Replace the room with a real scan**: File ▸ Import ▸ Splat
  (`.ply/.spz/.splat` — a Kiri export works directly), or Model
  (`.glb/.gltf/.obj`). Hide or delete the procedural walls/scan placeholder
  once the real one is in.
- **Replace the security camera with a photo you actually took**: File ▸
  Import ▸ GP object, or just drag a photo in as a reference plane (Add
  menu ▸ Plane, then set its texture in Object Properties), positioned and
  scaled by eye or using the **Measure** tool (Scene tab) to get it to real
  dimensions.
- **Point a zone at a real object** instead of a pedestal: select any mesh,
  open its **Constraints** tab, and add a `TRIGGER` constraint the same way
  Pedestal A already has one.

Nothing about the zone, the route, or the OSC output needs to change when
you do this — that's the guarantee the whole simulated-source design is
built around.

## Building your own scene from scratch (not the stock demo)

1. **Add ▸ Actor (mannequin)** — a rigged visitor. In its **Actor** tab,
   turn on **Simulate**, turn on **Walk** (the gait), and give it a route:
   either possess it and record one (step 7), or draw a loop, select it,
   and Constraints tab ▸ Add Object Constraint ▸ Follow Path ▸ "Use
   selected stroke".
2. **Add a camera** where you want the "installed webcam" to stand — the
   timeline camera row's **+** button adds one at the current view.
3. **Capture tab ▸ +Pose** (or +Detect) to create a stream, source =
   Camera.
4. In that stream's row, under **Sim source**, pick your actor (or any
   other object — a box on a path works too, for testing a simpler
   "detected object" case) and the camera you added in step 2.
5. Build your zones: select any object, **Constraints** tab, Add Object
   Constraint ▸ Trigger. Set its radius and the OSC/bus message address.
6. Play, and watch **Bindings ▸ Events / IO** for the messages.

## Known gaps (see INSTALLATION.md for detail)

- **Semantic detection models are not yet verified loading.** The most-cited
  OWL-ViT export fails to load in this browser/runtime combination; the
  dropdown lists alternatives to try on your actual machine. Until one
  loads, use the simulated DETECT stream (step 4 above) to test the
  plumbing.
- **No camera-to-room registration (mapping) modes yet.** Placing a stream's
  camera and scale is still by hand. A ground-plane homography mode (click
  4 points in a photo, click the matching 4 points on the floor plan) is
  planned but not built.
- **Multi-person tracking** doesn't exist — one pose stream tracks one
  skeleton, real or simulated.
- **The character controller is deliberately barebones.** No gravity and no
  jumping: you are placed on the surface under you, never falling off it.
  Collision is axis-aligned bounding boxes, so a rotated box blocks a
  slightly larger area than it looks like, and imported `MODEL` meshes have
  no collision at all (box a stand-in around them if you need one). The
  third-person camera pulls its boom in when a wall is behind you rather
  than sweeping around obstacles.
- **The gait doesn't shorten its stride when cornering.** Real walkers take
  smaller steps around a tight turn; this one keeps its stride and a
  world-locked stance foot visibly swings in body space when the actor
  turns more than ~30° in a stride. Give paths room, or slow them down.
