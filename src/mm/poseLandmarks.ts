// MediaPipe Pose (33-landmark) topology: index -> name/position/skeleton
// edges, for the visual body-map picker (poseMap.ts). Positions are a
// hand-authored humanoid layout in a fixed SVG viewBox — not meant to
// pixel-match a live capture, just to read as a body at a glance.

export const POSE_LANDMARK_NAMES: string[] = [
  'nose',
  'left eye (inner)', 'left eye', 'left eye (outer)',
  'right eye (inner)', 'right eye', 'right eye (outer)',
  'left ear', 'right ear',
  'mouth (left)', 'mouth (right)',
  'left shoulder', 'right shoulder',
  'left elbow', 'right elbow',
  'left wrist', 'right wrist',
  'left pinky', 'right pinky',
  'left index', 'right index',
  'left thumb', 'right thumb',
  'left hip', 'right hip',
  'left knee', 'right knee',
  'left ankle', 'right ankle',
  'left heel', 'right heel',
  'left foot index', 'right foot index',
];

export const POSE_VIEWBOX = '0 0 300 560';

// [x, y] per landmark id, 0..32.
export const POSE_LANDMARK_POS: [number, number][] = [
  [150, 84],                                       // 0 nose
  [163, 60], [176, 57], [189, 62],                 // 1-3 left eye inner/center/outer
  [137, 60], [124, 57], [111, 62],                 // 4-6 right eye inner/center/outer
  [205, 72], [95, 72],                             // 7 left ear, 8 right ear
  [135, 100], [165, 100],                          // 9 mouth left, 10 mouth right
  [95, 180], [205, 180],                           // 11 left shoulder, 12 right shoulder
  [60, 240], [240, 240],                           // 13 left elbow, 14 right elbow
  [35, 300], [265, 300],                           // 15 left wrist, 16 right wrist
  [15, 320], [285, 320],                           // 17 left pinky, 18 right pinky
  [25, 335], [275, 335],                           // 19 left index, 20 right index
  [45, 320], [255, 320],                           // 21 left thumb, 22 right thumb
  [110, 320], [190, 320],                          // 23 left hip, 24 right hip
  [100, 420], [200, 420],                          // 25 left knee, 26 right knee
  [95, 510], [205, 510],                           // 27 left ankle, 28 right ankle
  [80, 530], [220, 530],                           // 29 left heel, 30 right heel
  [110, 535], [190, 535],                          // 31 left foot index, 32 right foot index
];

// MediaPipe's official POSE_CONNECTIONS, [a, b] index pairs.
export const POSE_LANDMARK_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [15, 21], [17, 19],
  [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [27, 31], [29, 31], [28, 30], [28, 32], [30, 32],
];
