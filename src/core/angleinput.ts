// ANGLES AS TYPED, ANGLES AS SHOWN.
//
// Rotations are stored in RADIANS — three.js wants them, every bit of maths
// in the app wants them, and the file format should not change because a
// panel changed its mind. But nobody thinks in radians: a wall is turned 30
// degrees, not 0.5236, and the G/R/S overlay has always said "Rot: 30.0°"
// while the field underneath it said 0.524. One of the two was lying about
// what the app works in, and it was the field.
//
// So the display unit is a SETTING (degrees by default) and the input
// accepts either, plus the two ways people actually write angles:
//
//   45        45 degrees (or radians, if the setting says so)
//   45deg     degrees, whatever the setting says
//   0.5rad    radians, whatever the setting says
//   pi/2      radians — pi is a radian unit, so it needs no suffix
//   0.5 pi    the same, written the way it is said out loud
//   -2*pi/3   arithmetic, because an angle is often a fraction of a turn
//
// The expression evaluator is a small recursive-descent parser rather than
// `eval` or `new Function`: a number field is a place a pasted string can
// land, and an app that evaluates arbitrary JavaScript there has handed the
// page to whatever wrote it.

export type AngleUnit = 'DEG' | 'RAD';

const DEG = Math.PI / 180;

/** What to show in the box for a stored (radian) value. */
export function formatAngle(rad: number, unit: AngleUnit): string {
  return unit === 'RAD' ? trim(rad, 4) : trim(rad / DEG, 2);
}

/** The suffix the box wears, so a bare number is never ambiguous. */
export function angleSuffix(unit: AngleUnit): string {
  return unit === 'RAD' ? ' rad' : '°';
}

function trim(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  // 45.00 -> 45, 45.50 -> 45.5: trailing zeros are noise in a field you
  // scrub, and they cost the width that makes -180.00 fit
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Parse typed text into RADIANS, or null if it is not an angle at all.
 * `unit` is what a bare number means.
 */
export function parseAngle(text: string, unit: AngleUnit): number | null {
  const raw = text.trim().toLowerCase();
  if (!raw) return null;
  // an explicit unit wins over the setting, wherever it is written
  let forced: AngleUnit | null = null;
  let body = raw;
  // NO LEADING \b: there is no word boundary between a digit and a letter,
  // so "45deg" and "0.5rad" — which is how anyone actually types them —
  // would not have matched, and the unit would have been silently ignored.
  const deg = /(°|deg(rees?)?)/;
  const rad = /rad(ians?)?/;
  if (deg.test(body)) { forced = 'DEG'; body = body.replace(deg, ' '); }
  else if (rad.test(body)) { forced = 'RAD'; body = body.replace(rad, ' '); }
  // PI IS ITSELF A UNIT. "pi/2" is 90 degrees in anyone's book, and reading
  // it as 1.57 DEGREES because the panel happens to be in degrees would be
  // the most confusing possible answer.
  // likewise "2pi": the pi is glued to the number that multiplies it
  const hasPi = /pi|π/.test(body);
  const value = evaluate(body);
  if (value === null) return null;
  const asRadians = forced === 'RAD' || (forced === null && (hasPi || unit === 'RAD'));
  return asRadians ? value : value * DEG;
}

/**
 * Arithmetic over + - * / ( ) with `pi`, including the implicit
 * multiplication in "0.5 pi" and "2pi". Returns null on anything it does
 * not understand, so a typo leaves the field alone instead of zeroing it.
 */
export function evaluate(src: string): number | null {
  const s = src.replace(/π/g, 'pi');
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => { ws(); return s[i]; };

  const primary = (): number | null => {
    ws();
    if (s[i] === '(') {
      i++;
      const v = expr();
      ws();
      if (s[i] !== ')') return null;
      i++;
      return v;
    }
    if (s.startsWith('pi', i)) { i += 2; return Math.PI; }
    const m = /^\d*\.?\d+(e[+-]?\d+)?/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };

  const unary = (): number | null => {
    ws();
    if (s[i] === '-') { i++; const v = unary(); return v === null ? null : -v; }
    if (s[i] === '+') { i++; return unary(); }
    return primary();
  };

  const term = (): number | null => {
    let v = unary();
    if (v === null) return null;
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        const r = unary();
        if (r === null) return null;
        v = c === '*' ? v * r : v / r;
      } else if (c === 'p' && s.startsWith('pi', i)) {
        // IMPLICIT MULTIPLICATION, but only against pi: "0.5 pi" is how the
        // angle is spoken, and "2pi" is how it is written. Allowing it
        // between any two numbers would make "1 5" mean 5, which is a typo
        // silently accepted.
        i += 2;
        v *= Math.PI;
      } else break;
    }
    return v;
  };

  const expr = (): number | null => {
    let v = term();
    if (v === null) return null;
    for (;;) {
      const c = peek();
      if (c !== '+' && c !== '-') break;
      i++;
      const r = term();
      if (r === null) return null;
      v = c === '+' ? v + r : v - r;
    }
    return v;
  };

  const out = expr();
  ws();
  // trailing junk means we did not understand the whole thing
  return i === s.length && out !== null && Number.isFinite(out) ? out : null;
}
