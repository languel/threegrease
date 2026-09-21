// REGISTRATION: the rotation, uniform scale and translation that carry one
// set of points onto another, matched by index. It is how a scan is fitted
// to the thing it is a scan of — pick the corners of a pedestal in the scan,
// the same corners on a virtual box of known size, and the scan is moved,
// turned and scaled so the two sets coincide as closely as they can.
//
// Horn's closed form (1987, "Closed-form solution of absolute orientation
// using unit quaternions"): the best rotation is the eigenvector of the
// largest eigenvalue of a symmetric 4x4 built from the cross-covariance of
// the two centred sets, so there is no SVD to write and no reflection to
// guard against — a unit quaternion cannot mirror. Given that rotation the
// least-squares scale is Σ b'·Ra' / Σ|a'|², and the translation takes one
// centroid onto the other.
import * as THREE from 'three';

export interface AlignResult {
  /** world matrix taking source points onto the target: T · s·R */
  matrix: THREE.Matrix4;
  scale: number;
  /** root-mean-square distance left between the pairs, after alignment */
  rms: number;
  /** the worst pair's distance */
  max: number;
}

/** Largest-eigenvalue eigenvector of a symmetric 4x4 (Jacobi). */
function topEigenvector(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Fit `source` onto `target` (same length, paired by index, at least 3
 * points that are not all on one line). `allowScale: false` fits a rigid
 * motion only — for a scan already in true units.
 */
export function alignPoints(
  source: THREE.Vector3[], target: THREE.Vector3[], allowScale = true,
): AlignResult | null {
  const n = source.length;
  if (n < 3 || target.length !== n) return null;
  const ca = new THREE.Vector3(), cb = new THREE.Vector3();
  for (let i = 0; i < n; i++) { ca.add(source[i]); cb.add(target[i]); }
  ca.divideScalar(n); cb.divideScalar(n);
  const A = source.map((p) => p.clone().sub(ca));
  const B = target.map((p) => p.clone().sub(cb));

  // cross-covariance S[i][j] = Σ a_i b_j
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let aa = 0;
  for (let k = 0; k < n; k++) {
    const a = A[k].toArray(), b = B[k].toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += a[i] * b[j];
    aa += A[k].lengthSq();
  }
  if (aa < 1e-12) return null;
  const [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = S;
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const [w, x, y, z] = topEigenvector(N);
  const q = new THREE.Quaternion(x, y, z, w).normalize();

  let s = 1;
  if (allowScale) {
    let num = 0;
    for (let k = 0; k < n; k++) num += B[k].dot(A[k].clone().applyQuaternion(q));
    s = num / aa;
    if (!(s > 1e-9)) return null;
  }
  const t = cb.clone().sub(ca.clone().applyQuaternion(q).multiplyScalar(s));
  const matrix = new THREE.Matrix4().compose(t, q, new THREE.Vector3(s, s, s));

  let sum = 0, max = 0;
  for (let k = 0; k < n; k++) {
    const d = source[k].clone().applyMatrix4(matrix).distanceTo(target[k]);
    sum += d * d;
    max = Math.max(max, d);
  }
  return { matrix, scale: s, rms: Math.sqrt(sum / n), max };
}
