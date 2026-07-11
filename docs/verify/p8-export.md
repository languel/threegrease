# P8 verification — 3D export

Topbar GLB/OBJ/STL buttons download files. Console check:
```js
const ex = await import('/src/io/export3d.ts');
const glb = await ex.exportGLB(__tg.ctx);          // magic bytes 'glTF'
const obj = ex.exportOBJ(__tg.ctx);                 // contains 'v ' lines
const stl = ex.exportSTL(__tg.ctx);                 // DataView (binary)
```
Strokes export as Catmull-Rom tubes (mean width; SCENE widths direct,
VIEW widths via pxToWorld 0.005), fills as earcut meshes, colors as
MeshStandardMaterial. Modifier-evaluated current frame, visible layers.
