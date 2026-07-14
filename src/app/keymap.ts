// Central, rebindable keyboard shortcuts. Bindings persist to localStorage.

export interface ActionDef {
  id: string;
  label: string;
  combo: string;   // default combo, e.g. 'ctrl+shift+z', 'space', 'arrowup'
  category: string;
}

export const ACTIONS: ActionDef[] = [
  // General
  { id: 'undo', label: 'Undo', combo: 'ctrl+z', category: 'General' },
  { id: 'redo', label: 'Redo', combo: 'ctrl+shift+z', category: 'General' },
  { id: 'save', label: 'Save scene', combo: 'ctrl+s', category: 'General' },
  { id: 'open', label: 'Open scene', combo: 'ctrl+o', category: 'General' },
  { id: 'newScene', label: 'New scene', combo: 'ctrl+alt+n', category: 'General' },
  { id: 'settings', label: 'Open settings', combo: ',', category: 'General' },
  { id: 'palette', label: 'Command palette', combo: 'f3', category: 'General' },
  { id: 'inspector', label: 'Toggle inspector panel', combo: 'n', category: 'General' },
  { id: 'presentation', label: 'Presentation mode', combo: 'p', category: 'General' },
  // Modes
  { id: 'toggleEdit', label: 'Toggle last two modes', combo: 'tab', category: 'Modes' },
  { id: 'modeObject', label: 'Object mode', combo: '', category: 'Modes' },
  { id: 'modePie', label: 'Mode pie menu', combo: 'alt+tab', category: 'Modes' },
  { id: 'modeDraw', label: 'Draw mode', combo: '1', category: 'Modes' },
  { id: 'modeEdit', label: 'Edit mode', combo: '2', category: 'Modes' },
  { id: 'modeSculpt', label: 'Sculpt mode', combo: '3', category: 'Modes' },
  { id: 'modeVertex', label: 'Vertex paint mode', combo: '4', category: 'Modes' },
  { id: 'modeWeight', label: 'Weight paint mode', combo: '5', category: 'Modes' },
  // Tools
  { id: 'toolDraw', label: 'Draw tool', combo: 'd', category: 'Tools' },
  { id: 'toolErase', label: 'Erase tool', combo: 'e', category: 'Tools' },
  { id: 'toolFill', label: 'Fill tool', combo: 'f', category: 'Tools' },
  // Edit
  { id: 'move', label: 'Move (grab)', combo: 'g', category: 'Edit' },
  { id: 'rotate', label: 'Rotate', combo: 'r', category: 'Edit' },
  { id: 'scale', label: 'Scale', combo: 's', category: 'Edit' },
  { id: 'selectAll', label: 'Select all', combo: 'a', category: 'Edit' },
  { id: 'selectNone', label: 'Select none', combo: 'alt+a', category: 'Edit' },
  { id: 'selectInvert', label: 'Invert selection', combo: 'ctrl+i', category: 'Edit' },
  { id: 'selectLinked', label: 'Select linked (whole stroke)', combo: 'l', category: 'Edit' },
  { id: 'selectConnected', label: 'Select connected strokes', combo: 'ctrl+l', category: 'Edit' },
  { id: 'join', label: 'Join selected strokes', combo: 'ctrl+j', category: 'Edit' },
  { id: 'split', label: 'Split selection into strokes', combo: 'y', category: 'Edit' },
  { id: 'separate', label: 'Separate to new object (Edit mode)', combo: 'p', category: 'Edit' },
  { id: 'renameObject', label: 'Rename active object', combo: 'f2', category: 'Edit' },
  { id: 'selectMore', label: 'Select more', combo: '=', category: 'Edit' },
  { id: 'selectLess', label: 'Select less', combo: '-', category: 'Edit' },
  { id: 'delete', label: 'Delete selected', combo: 'x', category: 'Edit' },
  { id: 'duplicate', label: 'Duplicate', combo: 'shift+d', category: 'Edit' },
  { id: 'toggleSnap', label: 'Toggle magnet snapping', combo: 'shift+tab', category: 'Edit' },
  { id: 'addMenu', label: 'Add menu (at mouse)', combo: 'shift+a', category: 'General' },
  { id: 'addTriggerAtCursor', label: 'Add trigger at 3D cursor', combo: 'shift+t', category: 'General' },
  { id: 'addTravelerNearestStroke', label: 'Add traveler on nearest stroke', combo: 'shift+g', category: 'General' },
  { id: 'copy', label: 'Copy strokes', combo: 'ctrl+c', category: 'Edit' },
  { id: 'paste', label: 'Paste strokes', combo: 'ctrl+v', category: 'Edit' },
  // Object mode
  { id: 'parentSet', label: 'Parent selected to active (object mode)', combo: 'ctrl+p', category: 'Edit' },
  { id: 'applyTransform', label: 'Apply transform', combo: 'ctrl+a', category: 'Object' },
  { id: 'parentClear', label: 'Clear parent (object mode)', combo: 'alt+p', category: 'Edit' },
  // Animation
  { id: 'play', label: 'Play / pause', combo: 'space', category: 'Animation' },
  { id: 'insertKey', label: 'Insert keyframe', combo: 'i', category: 'Animation' },
  { id: 'removeKey', label: 'Remove keyframe', combo: 'shift+i', category: 'Animation' },
  { id: 'nextKey', label: 'Next keyframe', combo: 'arrowup', category: 'Animation' },
  { id: 'prevKey', label: 'Previous keyframe', combo: 'arrowdown', category: 'Animation' },
  { id: 'nextFrame', label: 'Next frame', combo: 'arrowright', category: 'Animation' },
  { id: 'prevFrame', label: 'Previous frame', combo: 'arrowleft', category: 'Animation' },
  // View / camera
  { id: 'fly', label: 'Flythrough (Enter accepts, Esc teleports back)', combo: '~', category: 'View' },
  { id: 'cameraView', label: 'Look through camera', combo: '0', category: 'View' },
  { id: 'cycleCamera', label: 'Next camera', combo: 'ctrl+shift+c', category: 'View' },
  { id: 'viewAll', label: 'Frame all (view fit)', combo: 'home', category: 'View' },
  { id: 'centerCursorViewAll', label: 'Center cursor & frame all', combo: 'shift+c', category: 'View' },
];

const STORAGE_KEY = 'threegrease.keymap';

/** Normalized combo from a keyboard event: 'ctrl+shift+z', 'space', 'arrowup'. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (['control', 'meta', 'alt', 'shift'].includes(key)) return ''; // modifier alone
  // shifted symbols ('~', '+', '?') already encode shift in the character
  if (key.length === 1 && !/[a-z0-9]/.test(key)) {
    const i = parts.indexOf('shift');
    if (i >= 0) parts.splice(i, 1);
  }
  parts.push(key);
  return parts.join('+');
}

export class Keymap {
  private bindings = new Map<string, string>(); // actionId -> combo

  constructor() {
    for (const a of ACTIONS) this.bindings.set(a.id, a.combo);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      for (const [id, combo] of Object.entries(saved)) {
        if (this.bindings.has(id)) this.bindings.set(id, combo as string);
      }
    } catch { /* corrupted storage: keep defaults */ }
  }

  comboFor(id: string): string { return this.bindings.get(id) ?? ''; }

  /** Action bound to a combo, or null. */
  actionFor(combo: string): string | null {
    if (!combo) return null;
    for (const [id, c] of this.bindings) if (c === combo) return id;
    return null;
  }

  /** Rebind an action; clears any other action using the same combo. */
  rebind(id: string, combo: string): void {
    for (const [other, c] of this.bindings) {
      if (other !== id && c === combo) this.bindings.set(other, '');
    }
    this.bindings.set(id, combo);
    this.save();
  }

  reset(): void {
    for (const a of ACTIONS) this.bindings.set(a.id, a.combo);
    localStorage.removeItem(STORAGE_KEY);
  }

  private save(): void {
    const out: Record<string, string> = {};
    for (const a of ACTIONS) {
      const cur = this.bindings.get(a.id) ?? '';
      if (cur !== a.combo) out[a.id] = cur;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  }
}
