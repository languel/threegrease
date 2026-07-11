# P4 verification — property routing

Console (or Routes panel + a MIDI controller):
- CC1 route -> brush.size, SCALE 0..127 -> 1..60: send 64 => size 30.7
- WS route -> layer.<id>.opacity CLAMP: 0.35 => 0.35; 5 => 1
- target 'layer.99999.opacity' disables itself after one warn, no crash
- Learn: set routes.learningRouteId, next midi:in/ws:in event fills match
- cursor.<id>.speed routable (events modulate the score system)
