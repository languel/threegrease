# P5 verification — string art + attractors

1. Draw/select a cyclic frame stroke (the pin ring), load a target image in
   Solvers panel, Run. Expect: "StringArt" layer with a chord polyline;
   disc test image = 432 chords in ~43ms (120 pins, 160px target).
2. Chords are subdivided (~0.4u) so the sim can bend them.
3. ＋Attractor at cursor, enable "Simulate strings": interior points within
   the attractor radius move toward it (verified delta ~[0.19,-0.34,-0.21]
   at d=0.5), chord endpoints stay pinned, no undo churn.
4. attractor.<id>.x/strength routable from MIDI/OSC (Routes panel).
