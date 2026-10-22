export function classifyObstaclePass({ zc, rx, d2, passed }) {
  if (passed || zc / (rx + 0.8) < 1) return null;
  return d2 < 1 ? 'ignored' : d2 < 2.25 ? 'nearMiss' : 'clean';
}
