/* =========================================================
   Wave bandit — per-wave-type hit statistics.
   Each arm keeps Beta(hits, clean) evidence on "this wave
   type hit the player". Waves are drawn from the classic mix
   tilted toward or away from risky types so the mix's expected
   hit rate matches the director's target (relative to the
   classic mix's own rate). Every type keeps a share, which is
   the exploration. Evidence is decayed once it exceeds ~60
   effective samples so the estimates keep adapting.
   ========================================================= */

export const ARMS = ['wall', 'scatter', 'snake', 'gate'];
export const PRIOR = { a: 1, b: 4 };     // mild: ~20% hit rate, worth 5 samples
export const MAX_EVIDENCE = 60;
export const TILT_LIMIT = 8;

export function defaultBandit() {
  return Object.fromEntries(ARMS.map((arm) => [arm, { a: PRIOR.a, b: PRIOR.b }]));
}

export function updateBandit(bandit, arm, hit) {
  const p = bandit[arm];
  if (!p) return;
  if (hit) p.a++; else p.b++;
  const total = p.a + p.b;
  if (total > MAX_EVIDENCE) { p.a *= MAX_EVIDENCE / total; p.b *= MAX_EVIDENCE / total; }
}

// Tilts a baseline mix (e.g. the classic one) so its expected hit rate is `target`:
// p(arm) ∝ base[arm] × exp(λ × mean[arm]), with λ found by bisection within ±TILT_LIMIT.
// At target = the baseline's own rate the mix is unchanged; every arm keeps some share.
export function tiltedMix(bandit, base, target, allowed = ARMS) {
  const means = allowed.map((arm) => banditMean(bandit[arm]));
  const weightsAt = (lambda) => allowed.map((arm, i) => (base[arm] ?? 0) * Math.exp(lambda * means[i]));
  const rateAt = (lambda) => {
    const w = weightsAt(lambda);
    const total = w.reduce((s, v) => s + v, 0) || 1;
    return w.reduce((s, v, i) => s + v * means[i], 0) / total;
  };
  let lo = -TILT_LIMIT, hi = TILT_LIMIT;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (rateAt(mid) < target) lo = mid; else hi = mid;
  }
  const w = weightsAt((lo + hi) / 2);
  const total = w.reduce((s, v) => s + v, 0) || 1;
  return Object.fromEntries(allowed.map((arm, i) => [arm, w[i] / total]));
}

export function chooseArm(bandit, base, target, allowed = ARMS, rng = Math.random) {
  const mix = tiltedMix(bandit, base, target, allowed);
  let pick = rng();
  for (const arm of allowed) if ((pick -= mix[arm]) < 0) return arm;
  return allowed[allowed.length - 1];
}

export const banditMean = (p) => p.a / (p.a + p.b);

// Beta(a, b) via two Gamma draws (Marsaglia–Tsang), with an injectable RNG for tests.
export function sampleBeta(a, b, rng = Math.random) {
  const x = sampleGamma(a, rng), y = sampleGamma(b, rng);
  return x / (x + y);
}

function sampleGamma(k, rng) {
  if (k < 1) return sampleGamma(k + 1, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box–Muller standard normal
      x = Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
