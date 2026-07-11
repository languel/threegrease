# threegrease event protocol (WS / OSC / MIDI)

All external IO speaks the bus vocabulary: `{address, args}` JSON frames on
WebSocket, the same shape as UDP OSC through `bridge/`. Addresses:

## Outbound (threegrease → world)
| address | args | when |
| --- | --- | --- |
| `/cursor/<id>/pos` | x y z t | cursor riding a stroke, at its `rate` Hz (t = 0–1 path phase) |
| `/trigger/<id>` | 1 | a cursor entered the trigger radius |
| `/midi/note/<ch>/<key>` | vel | forwarded to the MIDI output when emitted on the bus |
| `/midi/cc/<ch>/<num>` | val | " |

Message templates on cursors/triggers are editable per object; `{x} {y}
{z} {t} {id} {name}` substitute at fire time, so any address scheme
(SuperCollider, TouchDesigner, IanniX) can be matched without code.

## Inbound (world → threegrease)
Anything arriving on the WS (source `ws:in`) or MIDI input (`midi:in`)
can drive properties via Routes (learn mode + range mapping):
`brush.*`, `layer.<id>.opacity`, `modifier.<id>.<param>`,
`cursor.<id>.speed|phase|rate`, `trigger.<id>.radius`, `camera.<i>.fov`,
`canvas.<id>.tx..rz`, `attractor.<id>.x|y|z|strength|radius`,
`cursor3d.x|y|z`, `frame`.

## mediamime (P9)
mediamime emits shape events over the same WS bridge:

| address | args | meaning |
| --- | --- | --- |
| `/mm/shape/<id>/enter` | 1 | tracked subject entered shape `<id>` |
| `/mm/shape/<id>/leave` | 0 | subject left the shape |
| `/mm/shape/<id>/move` | x y | normalized 0–1 position inside the shape |

threegrease needs no code for this: connect both apps to the bridge and
map `/mm/shape/*` addresses to properties in the Routes panel (e.g.
`/mm/shape/1/move` → `cursor.2.speed` with SCALE 0–1 → 0–2). The reverse
direction (threegrease triggers driving mediamime) uses mediamime's MIDI
input via `/midi/...` bus events.
