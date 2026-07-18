// MediaPipe Hand (21-landmark) topology — mirrors poseLandmarks.ts. Same
// local layout for both HAND_LEFT/HAND_RIGHT streams; the picker mirrors
// it horizontally for the right hand so it reads as "the other hand."

export const HAND_LANDMARK_NAMES: string[] = [
  'wrist',
  'thumb CMC', 'thumb MCP', 'thumb IP', 'thumb tip',
  'index MCP', 'index PIP', 'index DIP', 'index tip',
  'middle MCP', 'middle PIP', 'middle DIP', 'middle tip',
  'ring MCP', 'ring PIP', 'ring DIP', 'ring tip',
  'pinky MCP', 'pinky PIP', 'pinky DIP', 'pinky tip',
];

export const HAND_VIEWBOX = '0 0 200 230';

// [x, y] per landmark id, 0..20 — wrist at bottom-center, fingers spread
// upward, matching the standard MediaPipe hand-landmark reference figure.
export const HAND_LANDMARK_POS: [number, number][] = [
  [100, 210],                          // 0 wrist
  [65, 195], [40, 165], [25, 130], [10, 95],       // 1-4 thumb
  [65, 115], [60, 80], [55, 50], [50, 20],         // 5-8 index
  [95, 100], [95, 60], [95, 30], [95, 5],          // 9-12 middle
  [125, 105], [130, 65], [133, 35], [135, 10],     // 13-16 ring
  [155, 120], [165, 90], [172, 65], [178, 40],     // 17-20 pinky
];

// MediaPipe's official HAND_CONNECTIONS.
export const HAND_LANDMARK_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
