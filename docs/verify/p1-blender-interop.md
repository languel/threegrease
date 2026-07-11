# P1 verification — Blender interop

```
/Applications/Blender511.app/Contents/MacOS/Blender --background \
  --factory-startup --python blender/tests/roundtrip.py
```
Expected output: `ROUNDTRIP OK` (positions within 1e-4, counts identical,
width products preserved). Interactive: install blender/threegrease_io as
an addon → File > Import > threegrease (.json).
