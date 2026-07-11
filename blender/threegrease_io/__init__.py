"""threegrease ⇄ Blender Grease Pencil v3 interop.

Import/export the threegrease-scene JSON (docs/schema.md) to/from GPv3
(Blender 4.3+ / 5.x). Install this folder as an addon, or run headless:
  blender --background --python blender/tests/roundtrip.py

Both coordinate systems are Z-up right-handed; positions pass through
unchanged. Stroke radius: threegrease stores width (diameter); Blender
stores per-point radius. VIEW-unit (px) strokes convert via px_to_world.
"""

bl_info = {
    "name": "threegrease I/O",
    "author": "threegrease",
    "version": (0, 1, 0),
    "blender": (4, 3, 0),
    "location": "File > Import/Export > threegrease (.json)",
    "description": "Exchange scenes with threegrease (Grease Pencil v3)",
    "category": "Import-Export",
}

import json
import math

import bpy
from bpy.props import FloatProperty, StringProperty
from bpy_extras.io_utils import ExportHelper, ImportHelper

PX_TO_WORLD_DEFAULT = 0.005  # 1 px of VIEW-unit width ~ 5 mm world


# --------------------------------------------------------------- helpers

def _new_gp_data(name):
    # 4.3+: grease_pencils_v3; some 5.x builds expose it as grease_pencils
    coll = getattr(bpy.data, "grease_pencils_v3", None)
    if coll is None:
        coll = bpy.data.grease_pencils
    return coll.new(name)


def _gp_material(ob, tg_mat):
    """Create a Blender material with grease-pencil settings from ours."""
    mat = bpy.data.materials.new(tg_mat.get("name", "Material"))
    bpy.data.materials.create_gpencil_data(mat)
    gp = mat.grease_pencil
    sc = tg_mat.get("strokeColor", [0, 0, 0, 1])
    fc = tg_mat.get("fillColor", [0.5, 0.5, 0.5, 1])
    gp.show_stroke = bool(tg_mat.get("showStroke", True))
    gp.show_fill = bool(tg_mat.get("showFill", False))
    gp.color = (sc[0], sc[1], sc[2], sc[3])
    gp.fill_color = (fc[0], fc[1], fc[2], fc[3])
    ob.data.materials.append(mat)
    return mat


_BLEND_TO_BL = {"REGULAR": "REGULAR", "ADD": "ADD", "MULTIPLY": "MULTIPLY"}
_BLEND_FROM_BL = {v: k for k, v in _BLEND_TO_BL.items()}


def import_scene(filepath, px_to_world=PX_TO_WORLD_DEFAULT, report=print):
    with open(filepath, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("format") != "threegrease-scene":
        raise ValueError("Not a threegrease scene file")
    scene = data["scene"]
    created = []

    for tg_ob in scene.get("objects", []):
        gpd = _new_gp_data(tg_ob.get("name", "threegrease"))
        ob = bpy.data.objects.new(tg_ob.get("name", "threegrease"), gpd)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = tg_ob.get("translation", [0, 0, 0])
        ob.rotation_euler = tg_ob.get("rotation", [0, 0, 0])
        ob.scale = tg_ob.get("scale", [1, 1, 1])
        # stash full source for lossless re-export of unmapped features
        ob["threegrease_source"] = json.dumps(
            {k: tg_ob.get(k) for k in ("modifiers", "effects", "onion")})

        for m in tg_ob.get("materials", []):
            _gp_material(ob, m)

        # threegrease lists bottom-first; Blender's .new() appends on top —
        # inserting in order gives the same visual stacking.
        for tg_layer in tg_ob.get("layers", []):
            layer = gpd.layers.new(tg_layer.get("name", "Layer"))
            layer.opacity = tg_layer.get("opacity", 1.0)
            layer.hide = bool(tg_layer.get("hide", False))
            layer.lock = bool(tg_layer.get("lock", False))
            try:
                layer.blend_mode = _BLEND_TO_BL.get(
                    tg_layer.get("blendMode", "REGULAR"), "REGULAR")
            except Exception:
                pass  # enum name drift between versions

            for tg_frame in tg_layer.get("frames", []):
                frame = layer.frames.new(int(tg_frame.get("frameNumber", 1)))
                drawing = frame.drawing
                strokes = tg_frame.get("strokes", [])
                if not strokes:
                    continue
                drawing.add_strokes([len(s["points"]) for s in strokes])
                for si, tg_stroke in enumerate(strokes):
                    st = drawing.strokes[si]
                    style = tg_stroke.get("style", {}) or {}
                    unit_scale = (1.0 if style.get("unit") == "SCENE"
                                  else px_to_world)
                    half = tg_stroke.get("lineWidth", 8) * unit_scale * 0.5
                    st.cyclic = bool(tg_stroke.get("cyclic", False))
                    st.material_index = int(tg_stroke.get("materialIndex", 0))
                    for pi, p in enumerate(tg_stroke["points"]):
                        bp = st.points[pi]
                        bp.position = p["co"]
                        bp.radius = max(1e-5, half * p.get("pressure", 1.0))
                        bp.opacity = p.get("strength", 1.0)
                        vc = p.get("vertexColor", [0, 0, 0, 0])
                        try:
                            bp.vertex_color = (vc[0], vc[1], vc[2], vc[3])
                        except Exception:
                            pass
                    # keep NPR style for round-trip
                    try:
                        st["threegrease_style"] = json.dumps(style)
                    except Exception:
                        pass
        created.append(ob)
    report(f"threegrease: imported {len(created)} object(s)")
    return created


def export_scene(filepath, world_to_px=1.0 / PX_TO_WORLD_DEFAULT,
                 report=print):
    """Export all GPv3 objects in the scene to threegrease JSON."""
    objects = [o for o in bpy.context.scene.objects
               if getattr(o.data, "layers", None) is not None
               and o.type == "GREASEPENCIL"]
    tg_objects = []
    next_id = [1]

    def gen_id():
        next_id[0] += 1
        return next_id[0]

    for ob in objects:
        gpd = ob.data
        materials = []
        for slot_mat in gpd.materials:
            gp = getattr(slot_mat, "grease_pencil", None)
            if gp is None:
                continue
            materials.append({
                "name": slot_mat.name,
                "showStroke": bool(gp.show_stroke),
                "strokeColor": list(gp.color),
                "lineMode": "LINE",
                "showFill": bool(gp.show_fill),
                "fillColor": list(gp.fill_color),
                "fillStyle": "SOLID",
                "fillColor2": [1, 1, 1, 1],
                "gradientAngle": 0,
                "holdout": False,
            })
        if not materials:
            materials = [{
                "name": "Black", "showStroke": True,
                "strokeColor": [0, 0, 0, 1], "lineMode": "LINE",
                "showFill": False, "fillColor": [0.5, 0.5, 0.5, 1],
                "fillStyle": "SOLID", "fillColor2": [1, 1, 1, 1],
                "gradientAngle": 0, "holdout": False,
            }]

        layers = []
        for layer in gpd.layers:
            frames = []
            for frame in layer.frames:
                drawing = frame.drawing
                strokes = []
                for st in drawing.strokes:
                    pts = list(st.points)
                    if not pts:
                        continue
                    max_r = max(p.radius for p in pts) or 1e-5
                    width = max_r * 2.0  # SCENE units
                    style = {"unit": "SCENE", "stamp": False,
                             "spacing": 0.12, "angle": 0, "aspect": 1,
                             "jitter": 0, "grain": 0, "grainScale": 6}
                    try:
                        style.update(json.loads(st["threegrease_style"]))
                    except Exception:
                        pass
                    strokes.append({
                        "id": gen_id(),
                        "points": [{
                            "co": list(p.position),
                            "pressure": p.radius / max_r,
                            "strength": float(getattr(p, "opacity", 1.0)),
                            "vertexColor": list(getattr(p, "vertex_color",
                                                        (0, 0, 0, 0))),
                            "select": False,
                            "weight": 1,
                        } for p in pts],
                        "cyclic": bool(st.cyclic),
                        "materialIndex": int(st.material_index),
                        "lineWidth": width,
                        "hardness": 1,
                        "fillVertexColor": [0, 0, 0, 0],
                        "select": False,
                        "style": style,
                    })
                frames.append({
                    "frameNumber": int(frame.frame_number),
                    "keyframeType": "KEYFRAME",
                    "strokes": strokes,
                    "select": False,
                })
            layers.append({
                "id": gen_id(),
                "name": layer.name,
                "frames": sorted(frames, key=lambda f: f["frameNumber"]),
                "opacity": float(layer.opacity),
                "hide": bool(layer.hide),
                "lock": bool(layer.lock),
                "useOnion": True,
                "blendMode": _BLEND_FROM_BL.get(
                    str(getattr(layer, "blend_mode", "REGULAR")), "REGULAR"),
                "tint": [0, 0, 0, 0],
                "thicknessOffset": 0,
                "translation": [0, 0, 0], "rotation": [0, 0, 0],
                "scale": [1, 1, 1],
                "useMask": False, "maskLayerIds": [],
            })

        tg_objects.append({
            "name": ob.name,
            "layers": layers,
            "activeLayerId": layers[-1]["id"] if layers else 0,
            "materials": materials,
            "activeMaterial": 0,
            "modifiers": [], "effects": [],
            "translation": list(ob.location),
            "rotation": list(ob.rotation_euler),
            "scale": list(ob.scale),
            "onion": {"enabled": False, "mode": "KEYFRAMES", "before": 1,
                      "after": 1, "colorBefore": [0.145, 0.815, 0.137],
                      "colorAfter": [0.125, 0.349, 0.867], "opacity": 0.5},
        })

    scene = {
        "objects": tg_objects,
        "activeObject": 0,
        "frame": int(bpy.context.scene.frame_current),
        "frameStart": int(bpy.context.scene.frame_start),
        "frameEnd": int(bpy.context.scene.frame_end),
        "fps": int(bpy.context.scene.render.fps),
        "cursor": list(bpy.context.scene.cursor.location),
        "canvases": [],
        "cameras": [{"name": "Camera 1", "translation": [0, -6, 2],
                     "rotation": [1.249, 0, 0], "fov": 50, "keys": []}],
        "activeCamera": 0,
    }
    with open(filepath, "w", encoding="utf-8") as fh:
        json.dump({"format": "threegrease-scene", "version": 2,
                   "scene": scene}, fh)
    report(f"threegrease: exported {len(tg_objects)} object(s)")
    return filepath


# --------------------------------------------------------------- operators

class IMPORT_OT_threegrease(bpy.types.Operator, ImportHelper):
    bl_idname = "import_scene.threegrease"
    bl_label = "Import threegrease (.json)"
    filename_ext = ".json"
    filter_glob: StringProperty(default="*.json", options={"HIDDEN"})
    px_to_world: FloatProperty(
        name="Px to world", default=PX_TO_WORLD_DEFAULT,
        description="World units per pixel for VIEW-unit stroke widths")

    def execute(self, context):
        import_scene(self.filepath, self.px_to_world,
                     report=lambda m: self.report({"INFO"}, m))
        return {"FINISHED"}


class EXPORT_OT_threegrease(bpy.types.Operator, ExportHelper):
    bl_idname = "export_scene.threegrease"
    bl_label = "Export threegrease (.json)"
    filename_ext = ".json"
    filter_glob: StringProperty(default="*.json", options={"HIDDEN"})

    def execute(self, context):
        export_scene(self.filepath,
                     report=lambda m: self.report({"INFO"}, m))
        return {"FINISHED"}


def _menu_import(self, context):
    self.layout.operator(IMPORT_OT_threegrease.bl_idname,
                         text="threegrease (.json)")


def _menu_export(self, context):
    self.layout.operator(EXPORT_OT_threegrease.bl_idname,
                         text="threegrease (.json)")


def register():
    bpy.utils.register_class(IMPORT_OT_threegrease)
    bpy.utils.register_class(EXPORT_OT_threegrease)
    bpy.types.TOPBAR_MT_file_import.append(_menu_import)
    bpy.types.TOPBAR_MT_file_export.append(_menu_export)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(_menu_import)
    bpy.types.TOPBAR_MT_file_export.remove(_menu_export)
    bpy.utils.unregister_class(IMPORT_OT_threegrease)
    bpy.utils.unregister_class(EXPORT_OT_threegrease)


if __name__ == "__main__":
    register()
