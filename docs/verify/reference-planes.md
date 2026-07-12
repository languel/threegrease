# Verification — reference planes + object material panel

- Legacy scenes: canvases auto-migrate to PLANE meshes on load (same ids;
  size 4x2 -> scale [2,1]; CANVAS attachments -> MESH; canvas.* routes ->
  mesh.*; scene.canvases empties). Verified via crafted v2 file.
- Add > Reference/image plane…: textured, unlit, aspect-sized, non-draw-
  target plane at the cursor (texture stored as dataURL = persists).
- Properties panel (object mode, one selection): Loc/Rot/Scale + Material
  (color, opacity, texture load/replace/clear, Unlit, Two-sided,
  Wireframe, Lock, Draw target). Unlit swaps Basic/Standard material both
  ways; FACE_VIEW billboards to 0.0000 rad of the camera; CAMERA lock
  makes the transform a view-space offset (follows orbit, moved 2.31).
- mesh.<id>.tx..rz/opacity are routable (MIDI/OSC-drivable planes).
