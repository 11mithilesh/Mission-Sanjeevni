/* =========================================================
   Wave bandit — Thompson sampling over wave types.
   Each arm keeps Beta(hits, clean) evidence on "this wave
   type hit the player". We pick the arm whose SAMPLED hit
   probability is closest to the director's target risk, with
   10% uniform exploration. Evidence is decayed once it exceeds
   ~60 effective samples so the posterior keeps adapting.
   ========================================================= */

export const ARMS = ['wall', 'scatter', 'snake', 'gate'];
export const PRIOR = { a: 1, b: 4 };     // mild: ~20% hit rate, worth 5 samples
export const MAX_EVIDENCE = 60;
export const EXPLORE = 0.1;

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

export function chooseArm(bandit, targetRisk, allowed = ARMS, rng = Math.random) {
  if (rng() < EXPLORE) return allowed[Math.floor(rng() * allowed.length)];
  let best = allowed[0], bestGap = Infinity;
  for (const arm of allowed) {
    const gap = Math.abs(sampleBeta(bandit[arm].a, bandit[arm].b, rng) - targetRisk);
    if (gap < bestGap) { bestGap = gap; best = arm; }
  }
  return best;
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
