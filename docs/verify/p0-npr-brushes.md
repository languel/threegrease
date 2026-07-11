# P0 verification — NPR brushes

Reload app, then in console:
```js
const app = window.__tg, ctx = app.ctx;
const { BRUSH_PRESETS } = await import('/src/core/brushes.ts');
const p = BRUSH_PRESETS.find(x => x.name === 'Ink Rough');
Object.assign(ctx.settings.brush, { preset: p.name, size: p.size, strength: p.strength, hardness: p.hardness, style: { ...p.style } });
// draw synthetically (see HANDOFF §5), then:
const s = ctx.scene.objects[0].layers[0].frames[0].strokes.at(-1);
console.assert(s.style.stamp && s.style.unit === 'SCENE');
const mesh = ctx.gp.objectGroups[0].children.find(m => m.geometry?.attributes?.aKind);
console.assert(Array.from(mesh.geometry.attributes.aKind.array).some(k => k === 3)); // stamps
// determinism: two rebuilds give identical positions
// roundtrip: deserializeScene(serializeScene(scene)) preserves stroke.style
// migration: deleting stroke.style from JSON loads with defaultStyle()
```
Expected: grainy rotated stamps along the path; SCENE strokes change
apparent size when dollying, VIEW strokes do not.
