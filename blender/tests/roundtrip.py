"""Headless roundtrip test:
  blender --background --python blender/tests/roundtrip.py
Imports a generated threegrease scene, exports it, and diffs.
Exits non-zero on failure.
"""
import json
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from threegrease_io import export_scene, import_scene  # noqa: E402


def make_test_scene():
    def pt(x, y, z, pressure=1.0, strength=1.0, vc=(0, 0, 0, 0)):
        return {"co": [x, y, z], "pressure": pressure, "strength": strength,
                "vertexColor": list(vc), "select": False, "weight": 1}

    strokes = [
        {  # open pressure-varied stroke
            "id": 10, "cyclic": False, "materialIndex": 0, "lineWidth": 0.2,
            "hardness": 1, "fillVertexColor": [0, 0, 0, 0], "select": False,
            "style": {"unit": "SCENE", "stamp": False, "spacing": 0.12,
                      "angle": 0, "aspect": 1, "jitter": 0, "grain": 0,
                      "grainScale": 6},
            "points": [pt(i * 0.1, 0, math.sin(i / 3), 0.3 + 0.7 * (i / 20))
                       for i in range(21)],
        },
        {  # cyclic colored stroke
            "id": 11, "cyclic": True, "materialIndex": 1, "lineWidth": 0.1,
            "hardness": 1, "fillVertexColor": [0, 0, 0, 0], "select": False,
            "style": {"unit": "SCENE", "stamp": True, "spacing": 0.2,
                      "angle": 0.3, "aspect": 0.7, "jitter": 0.1,
                      "grain": 0.5, "grainScale": 8},
            "points": [pt(math.cos(a / 8 * math.tau),
                          math.sin(a / 8 * math.tau), 1.0,
                          1.0, 0.8, (1, 0.4, 0.1, 0.9)) for a in range(8)],
        },
    ]
    mat = lambda name, sc, fill: {  # noqa: E731
        "name": name, "showStroke": True, "strokeColor": sc,
        "lineMode": "LINE", "showFill": fill,
        "fillColor": [0.9, 0.9, 0.9, 1], "fillStyle": "SOLID",
        "fillColor2": [1, 1, 1, 1], "gradientAngle": 0, "holdout": False}
    scene = {
        "objects": [{
            "name": "TestGP",
            "layers": [{
                "id": 1, "name": "L1",
                "frames": [
                    {"frameNumber": 1, "keyframeType": "KEYFRAME",
                     "strokes": strokes, "select": False},
                    {"frameNumber": 10, "keyframeType": "KEYFRAME",
                     "strokes": [strokes[0]], "select": False},
                ],
                "opacity": 0.8, "hide": False, "lock": False,
                "useOnion": True, "blendMode": "REGULAR",
                "tint": [0, 0, 0, 0], "thicknessOffset": 0,
                "translation": [0, 0, 0], "rotation": [0, 0, 0],
                "scale": [1, 1, 1], "useMask": False, "maskLayerIds": []}],
            "activeLayerId": 1,
            "materials": [mat("Black", [0, 0, 0, 1], False),
                          mat("Red", [0.9, 0.1, 0.1, 1], False)],
            "activeMaterial": 0, "modifiers": [], "effects": [],
            "translation": [0.5, 0, 0], "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
            "onion": {"enabled": False, "mode": "KEYFRAMES", "before": 1,
                      "after": 1, "colorBefore": [0, 1, 0],
                      "colorAfter": [0, 0, 1], "opacity": 0.5}}],
        "activeObject": 0, "frame": 1, "frameStart": 1, "frameEnd": 250,
        "fps": 24, "cursor": [0, 0, 0], "canvases": [],
        "cameras": [{"name": "Camera 1", "translation": [0, -6, 2],
                     "rotation": [1.249, 0, 0], "fov": 50, "keys": []}],
        "activeCamera": 0,
    }
    return {"format": "threegrease-scene", "version": 2, "scene": scene}


def main():
    tmp = tempfile.mkdtemp()
    src = os.path.join(tmp, "in.json")
    dst = os.path.join(tmp, "out.json")
    with open(src, "w") as fh:
        json.dump(make_test_scene(), fh)

    import_scene(src)
    export_scene(dst)

    with open(src) as fh:
        a = json.load(fh)["scene"]
    with open(dst) as fh:
        b = json.load(fh)["scene"]

    errs = []
    ao, bo = a["objects"][0], b["objects"][0]
    la, lb = ao["layers"][0], bo["layers"][0]
    if len(bo["layers"]) != len(ao["layers"]):
        errs.append("layer count")
    if len(lb["frames"]) != len(la["frames"]):
        errs.append("frame count")
    for fa, fb in zip(la["frames"], lb["frames"]):
        if fa["frameNumber"] != fb["frameNumber"]:
            errs.append("frame numbers")
        if len(fa["strokes"]) != len(fb["strokes"]):
            errs.append(f"stroke count @f{fa['frameNumber']}")
            continue
        for sa, sb in zip(fa["strokes"], fb["strokes"]):
            if sa["cyclic"] != sb["cyclic"]:
                errs.append("cyclic")
            if sa["materialIndex"] != sb["materialIndex"]:
                errs.append("materialIndex")
            if len(sa["points"]) != len(sb["points"]):
                errs.append("point count")
                continue
            for pa, pb in zip(sa["points"], sb["points"]):
                if any(abs(x - y) > 1e-4 for x, y in zip(pa["co"], pb["co"])):
                    errs.append(f"position {pa['co']} vs {pb['co']}")
                    break
                if abs(pa["strength"] - pb["strength"]) > 1e-3:
                    errs.append("strength")
                    break
            # width roundtrip: lineWidth*pressure products should match
            wa = [sa["lineWidth"] * p["pressure"] for p in sa["points"]]
            wb = [sb["lineWidth"] * p["pressure"] for p in sb["points"]]
            if any(abs(x - y) > 1e-4 for x, y in zip(wa, wb)):
                errs.append("width products")
    if abs(la["opacity"] - lb["opacity"]) > 1e-4:
        errs.append("layer opacity")

    if errs:
        print("ROUNDTRIP FAILED:", errs[:10])
        sys.exit(1)
    print("ROUNDTRIP OK")


if __name__ == "__main__":
    main()
