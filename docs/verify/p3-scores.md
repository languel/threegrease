# P3 verification — scores

Draw a cyclic stroke, then Score panel → "＋Cursor on stroke".
Console assertions (full script in git history of this file):
- cursor.phase advances at `speed` loops/sec and wraps per loop mode
- bus receives /cursor/<id>/pos [x y z t] at ~`rate` Hz (monitor panel)
- a trigger placed on the path fires once per pass (source trigger:<id>)
- a CAMERA/CANVAS attachment updates the target transform each frame,
  TANGENT orient aligns to the path
- score survives save/load; deleting the ridden stroke pauses sampling
  without crashing; glyphs (octahedron cursors, wireframe triggers) track
