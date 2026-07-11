# threegrease bridge

Relays browser WebSocket JSON frames to UDP OSC (and back) so threegrease
can talk to SuperCollider, Max, TouchDesigner, IanniX, hardware, etc.

```bash
cd bridge && npm install
node index.js --ws 8765 --osc-out 127.0.0.1:57120 --osc-in 9000
```

In threegrease: Settings → IO → WebSocket URL `ws://localhost:8765`.
Frames are `{"address": "/cursor/1/pos", "args": [x, y, z, t]}`.
Incoming OSC on port 9000 appears on the app's event bus as source `ws:in`
(routable to any property via the Routes panel).
