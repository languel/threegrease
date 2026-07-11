# P2 verification — event bus + IO

1. `cd bridge && npm install && node index.js` (ws 8765, osc-out 57120, osc-in 9000)
2. In-app: Events/IO panel → WS `ws://localhost:8765` → Connect (status ● on)
3. Console:
```js
const { bus } = await import('/src/events/bus.ts');
bus.send('test', '/cursor/1/pos', 1, 2, 3);   // arrives as UDP OSC on 57120
```
4. Reverse: send OSC to udp:9000 → appears in bus.history() with source
   'ws:in' and in the monitor panel.
5. Perf: 1000 bus.send in <10ms (measured 2.3ms).
MIDI: pick devices in the panel; incoming notes/cc appear as
/midi/note|cc/<ch>/<n>; emitting /midi/... events sends to the output.
