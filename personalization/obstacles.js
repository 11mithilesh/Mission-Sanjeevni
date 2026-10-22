// Classifies a storm's pass by how close it came AT THE CROSSING FRAME (zc === 0, where
// d2 is purely lateral) and whether the ship was invulnerable then. The outcome is reported
// once, after the storm's collision radius is fully behind the ship (dzn >= 1). Judging it
// at the report frame instead would add dzn² >= 1 to d2, so nothing could be 'ignored' and
// near misses would be measured against wherever the ship had moved since.
// Call every frame after the hit check; it stores its bookkeeping on `e`.
export function classifyObstaclePass(e, { zc, rx, d2, invuln }) {
  if (e.passed) return null;
  if (zc === 0 && e.crossD2 === undefined) {
    e.crossD2 = d2;
    e.crossInvuln = invuln > 0;
  }
  if (zc / (rx + 0.8) < 1 || e.crossD2 === undefined) return null;
  e.passed = true;
  // A crossing inside the ellipsoid is a hit unless invulnerable, and hits are reported
  // by the caller's hit check (which removes the storm), so this only sees invulnerable ones.
  if (e.crossD2 < 1) return e.crossInvuln ? 'ignored' : null;
  return e.crossD2 < 2.25 ? 'nearMiss' : 'clean';
}
