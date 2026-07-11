# threegrease scene schema (format `threegrease-scene`, version 2)

The native file is `{ format, version, scene }` where `scene` is `GPScene`
(src/core/types.ts is normative; this file mirrors it for external tools,
notably the Blender addon in `blender/threegrease_io/`).

Conventions: **Z-up right-handed** by default (matches Blender). Distances
in scene/world units. Colors are linear floats 0–1. Angles radians.

## GPScene
| field | type | notes |
| --- | --- | --- |
| objects | GPObject[] | GP objects |
| activeObject | int | index |
| frame, frameStart, frameEnd, fps | int | timeline |
| cursor | vec3 | 3D cursor |
| canvases | CanvasPlane[] | world-space quads |
| cameras | GPCamera[]; activeCamera int | keyframable cameras |

## GPObject
`name, layers[] (index 0 = bottom), activeLayerId, materials[],
activeMaterial, modifiers[], effects[], translation vec3, rotation vec3
(XYZ euler), scale vec3, onion {enabled, mode, before, after, colorBefore,
colorAfter, opacity}`

## GPLayer
`id, name, frames[] (sorted, keyframe = last frame with frameNumber <= t),
opacity, hide, lock, useOnion, blendMode REGULAR|ADD|MULTIPLY, tint vec4
(rgb+factor), thicknessOffset px, translation/rotation/scale, useMask,
maskLayerIds[]`

## GPFrame
`frameNumber, keyframeType KEYFRAME|BREAKDOWN|EXTREME|JITTER|MOVING_HOLD,
strokes[], select`

## GPStroke
| field | type | notes |
| --- | --- | --- |
| id | int | unique in scene |
| points | GPPoint[] | object-space |
| cyclic | bool | |
| materialIndex | int | into object.materials |
| lineWidth | float | **px when style.unit=VIEW, world units when SCENE** |
| hardness | 0–1 | edge softness |
| fillVertexColor | vec4 | alpha 0 = use material fill |
| style | StrokeStyle | v2+; older files migrate to defaults |

## GPPoint
`co vec3 (object space), pressure (width multiplier), strength (opacity
0–1), vertexColor vec4 (alpha 0 = use material color), select, weight 0–1`

## StrokeStyle (v2)
`unit VIEW|SCENE, stamp bool, spacing (fraction of width), angle rad,
aspect 0.1–1, jitter 0–1, grain 0–1, grainScale`

## GPMaterial
`name, showStroke, strokeColor vec4, lineMode LINE|DOTS|SQUARES, showFill,
fillColor vec4, fillStyle SOLID|GRADIENT_LINEAR|GRADIENT_RADIAL,
fillColor2 vec4, gradientAngle, holdout`

## CanvasPlane
`id, name, translation, rotation, size [w,h], visible, select, drawTarget`

## GPCamera
`name, translation, rotation, fov (deg), keys[] {frame, translation,
rotation, fov}` — linear position/fov, slerped rotation between keys.

## Modifiers / Effects
`{id, type, name, enabled, layerFilter (layer id|null),
materialFilter (index|null), params {…}}` — types and param names in
src/modifiers/index.ts and src/fx/effects.ts.

## Blender GPv3 fidelity (import ⇄ export via the addon)
| attribute | roundtrip |
| --- | --- |
| stroke positions / cyclic / material index | full |
| radius: our lineWidth×pressure/2 ⇄ GPv3 per-point `radius` | full (SCENE unit); VIEW strokes convert via px→world option, back as SCENE |
| opacity (strength) ⇄ `opacity` | full |
| vertex color | full |
| layer name/opacity/hide/lock/blend | full (blend: regular/add/multiply) |
| keyframe numbers | full |
| materials stroke/fill color, show flags | full; gradients/holdout → nearest solid (lossy) |
| stroke style (stamps/grain) | Blender-side: dropped (kept in a `threegrease_style` custom prop for re-export) |
| modifiers/effects/cameras/canvases | not mapped v1; preserved only when re-exporting a file that came from threegrease |
