/* =========================================================
   Risk model — online logistic regression P(hit | features),
   trained by SGD with L2 shrinkage and clamped weights.
   Features (computed against the PREDICTED ship position at arrival):
   [1, |dx|/9, |dy|/3, sign(dx)*weakSide, (speed-26)/90, obstacleSize,
    approachVelocityTowardObstacle/40, recentHitRate]
   ========================================================= */

export const FEATURE_NAMES = ['bias', '|dx|', '|dy|', 'weakSide', 'speed', 'size', 'approach', 'hitRate'];
export const LEARNING_RATE = 0.05;
export const L2 = 1e-4;
export const WEIGHT_LIMIT = 6;

// A gentle prior so predictions are sensible before any data: close obstacles are risky.
export function defaultRisk() {
  return { w: [-0.5, -4, -2, 0.5, 0.5, 0.5, 1, 1], n: 0 };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function riskFeatures({ dx, dy, weakSide, speed, size, approach, recentHitRate }) {
  return [
    1,
    Math.abs(dx) / 9,
    Math.abs(dy) / 3,
    Math.sign(dx) * weakSide,
    (speed - 26) / 90,
    size,
    approach / 40,
    recentHitRate,
  ];
}

export function predictRisk(model, x) {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += model.w[i] * x[i];
  return sigmoid(z);
}

export function updateRisk(model, x, y, lr = LEARNING_RATE, l2 = L2) {
  const err = y - predictRisk(model, x);
  for (let i = 0; i < x.length; i++) {
    const w = model.w[i] + lr * (err * x[i] - l2 * model.w[i]);
    model.w[i] = Math.min(WEIGHT_LIMIT, Math.max(-WEIGHT_LIMIT, w));
  }
  model.n++;
}
