// What kind of thing a file is, so a drop can do the right thing with it.
//
// Mostly by extension — except .ply, which is two unrelated formats wearing
// one name: a Gaussian-splat scan and an ordinary triangle mesh. The header
// tells them apart. A splat PLY declares the Gaussian's own properties
// (f_dc_0 colour coefficients, scale_0, rot_0, opacity) on its vertices; a
// mesh PLY has x/y/z and maybe colours, and a `face` element.

export type DropKind = 'SPLAT' | 'MODEL' | 'IMAGE' | 'GP_JSON';

const SPLAT_EXT = ['spz', 'splat', 'ksplat', 'sog'];
const MODEL_EXT = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'vrm'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'];

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export async function classifyFile(file: File): Promise<DropKind | null> {
  const ext = extOf(file.name);
  if (SPLAT_EXT.includes(ext)) return 'SPLAT';
  if (MODEL_EXT.includes(ext)) return 'MODEL';
  if (IMAGE_EXT.includes(ext) || file.type.startsWith('image/')) return 'IMAGE';
  if (ext === 'json') return 'GP_JSON';
  if (ext === 'ply') return (await isSplatPly(file)) ? 'SPLAT' : 'MODEL';
  return null;
}

/** Read the PLY header and look for the properties only a splat has. */
async function isSplatPly(file: File): Promise<boolean> {
  const head = await file.slice(0, 16384).text();
  const end = head.indexOf('end_header');
  const header = end >= 0 ? head.slice(0, end) : head;
  return /property\s+\w+\s+(f_dc_0|scale_0|rot_0)\b/.test(header);
}

/**
 * Glb, glTF, OBJ and FBX are Y-UP by convention (glTF by specification);
 * STL comes out of CAD packages Z-up, and a mesh PLY is usually a scan in
 * whatever frame took it. A Y-up model in a Z-up scene lies on its back, so
 * the importer stands it up — the same +90 degrees about X the primitives
 * need.
 */
export function isYUpModel(name: string): boolean {
  return ['glb', 'gltf', 'obj', 'fbx', 'vrm'].includes(extOf(name));
}
