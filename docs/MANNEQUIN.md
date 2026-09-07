# The mannequin — every number that shapes it

A parameter sheet for iterating on the figure's LOOK without reading the
renderer. Everything here is a shape decision; nothing here changes how a
character moves.

Three ways to work on it:

1. **Change a number below**, reload, look. Each row says which file and what
   it does.
2. **Export the mesh** — `File ▸ Export ▸ GLB (recommended for Blender)` or
   `OBJ` now includes every visible actor, posed as it stands (T-pose it
   first from the Actor panel for a clean reference). Sculpt or annotate
   there, and come back with either new numbers or a picture.
3. **Say what is wrong in words.** The vocabulary below ("the profile's
   widest point sits too high", "the collar tube is too fat relative to the
   head") maps one-to-one onto a value, which is most of why this file
   exists.

All skeleton lengths are FRACTIONS OF HEIGHT — a 1.8 m figure multiplies
every number by 1.8 — so the proportions hold at any scale. Axes are authored
`[right, forward, up]`.

---

## 1. Proportions — `src/actor/skeleton.ts`

`SPINE_SPECS` and `limbSpecs()`: where each joint sits and how big its bead
is. The canonical figure is 7.5 heads tall, and the head's `radius: 0.067` is
the number everything else is measured against (`actorScale` derives an
actor's size from it, so changing it rescales the whole figure's sense of
proportion).

| joint | up (of height) | radius | note |
| --- | --- | --- | --- |
| `head` | 0.930 | 0.067 | crown lands at 1.0 — the figure is as tall as it claims |
| `neck` | 0.845 | 0.034 | deliberately unbound by capture rigs |
| `chest` | 0.806 | 0.072 | ON the shoulder line (binds to the shoulder midpoint) |
| `spine` | 0.665 | 0.070 | |
| `hips` | 0.530 | 0.075 | |
| `shoulder` | 0.806, ±0.105 | 0.042 | |
| `elbow` | 0.644, ±0.116 | 0.034 | |
| `wrist` | 0.500, ±0.124 | 0.026 | |
| `hand` | 0.444, ±0.127 | 0.030 | |
| `hip` | 0.528, ±0.055 | 0.048 | |
| `knee` | 0.285, ±0.058 | 0.042 | |
| `ankle` | 0.045, ±0.058 | 0.034 | |
| `foot` | 0.030, ±0.058, fwd 0.075 | 0.030 | **must be ≥ its own radius** — below that the floor lifts the toe and the knees buckle |

`SPINE_BONES` / `limbBones()`: the TUBE radius per bone (display only).

| bone | radius | |
| --- | --- | --- |
| hips→spine | 0.070 | |
| spine→chest | 0.075 | |
| chest→neck | 0.028 | the collar. Was 0.045 and read as a funnel |
| neck→head | 0.030 | ~45% of the drawn head — above ~0.7 it stops being a neck |
| chest→shoulder | 0.050 | |
| shoulder→elbow | 0.040 | |
| elbow→wrist | 0.032 | |
| wrist→hand | 0.028 | |
| hips→hip | 0.055 | |
| hip→knee | 0.052 | |
| knee→ankle | 0.042 | |
| ankle→foot | 0.030 | |

Bone radii are BAKED into an actor when it is created, so changing one here
affects new actors; existing ones keep theirs (serialize.ts migrates only the
two neck bones and the foot rest, and only when they still hold the old
default).

---

## 2. Looks — `src/render/actorlooks.ts`

A look is multipliers on the proportions above, never its own geometry —
which is what keeps a look from drifting away from the figure it draws.

| field | what it does |
| --- | --- |
| `limb` | × every bone tube radius |
| `joint` | × every joint bead radius |
| `taper` | tube's top/bottom ratio; <1 thins INTO the child joint |
| `capped` | closed tube ends |
| `emphasis` | per-JOINT size, by name prefix (`{ head: 1.85 }`) |
| `limbEmphasis` | per-BONE thickness, keyed by the joint the bone ENDS at |
| `headOvoid` | stretch the head along its own up axis; 1 is a ball |
| `face` / `faceRelief` | carve the face, and how deep |
| `blob` | draw the body as one implicit surface instead of parts |
| `roughness` `metalness` `flat` `unlit` `color` | material |

Current presets:

| | limb | joint | taper | head emphasis | ovoid | relief | blob |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mannequin | 1 | 0.55 | 1 | 1.85 | 1 | 1 | – |
| Wooden | 0.92 | 0.86 | 0.68 | 1.05 | 1.32 | 1.1 | – |
| Minimal | 0.3 | 0.42 | 1 | 1.75 | 1 | – | – |
| Clay | 1.12 | 1.05 | 0.9 | 1.6 | 1.1 | 0.8 | yes |

A drawn bead is `joint.radius × emphasis × spec.joint`, which is the sum that
catches people out: Mannequin's head at emphasis 1.15 came out SMALLER than
the neck tube under it.

---

## 3. The head — `buildFaceHead()` in `src/render/actors.ts`

One unit sphere, displaced. Authored looking down **+Z** with **+Y** up.

**Profile** (`PROFILE`, width against height, 0 = chin, 1 = crown). This is
what stops the head reading as an egg — an egg is widest in the middle and
closes symmetrically; a carved head is broad high on the cranium and narrows
into a jaw.

```
0.00 → 0.52   chin
0.18 → 0.68
0.35 → 0.84   jaw
0.55 → 0.97
0.72 → 1.05   widest point — high, not central
0.88 → 1.02
1.00 → 0.96   crown
```

**Eyes**: direction `(±0.40, 0.10, 0.86)`, `EYE_R 0.36` (angular radius, ~21°),
`EYE_DEPTH 0.19` (fraction of the head radius, pressed IN).

**Nose**: an arc of samples from `(0, 0.10, 0.98)` to `(0, -0.30, 0.94)`, each
with its own width `0.09 + 0.08t` and rise `(0.030 + 0.075t) × min(1, t/0.22)`,
where `t` runs 0 at the brow to 1 at the tip. Take the STRONGEST sample, never
the sum. Constant width plus a run up to the brow is what made it read as a
crest.

Resolution is `SphereGeometry(1, 40, 30)` — 2320 triangles, chosen for looks
rather than fidelity.

---

## 4. The clay surface — `src/render/blob.ts`

Field sources at every joint and along every bone, polygonised each frame.
No skinning is involved (there is none in this project); this is how limbs
merge where they meet.

| constant | value | what it does |
| --- | --- | --- |
| `RES` | 36 | grid per axis. Coarse on purpose — the faceting reads as clay |
| `SUBTRACT` | 64 | falloff. A source reaches `sqrt((iso+sub)/sub)` × its radius and everything inside ADDS: at 10 the figure inflates into a snowman |
| `isolation` | 80 | the level the surface is drawn at; strength for a radius is `(iso+sub)·r²` |
| `SPACING` | 0.45 | sources along a bone, as a fraction of its radius. Too sparse and a limb is a string of pearls |
| `PAD` | 1.35 | box slack, or the field is clipped flat at the edges |

---

## 5. What is NOT here

- **Motion.** Gait, steering, poses and the solver are shape-independent; see
  CLAUDE.md.
- **Skinning.** There is none — no bind pose, no weights, no rotations to
  skin against. The blob is the answer to the same want.
- **The face's orientation.** Derived from the shoulder line crossed with the
  neck-to-head direction, so it follows the body with nothing to author.
