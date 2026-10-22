/* =========================================================
   Player profile — exponentially-weighted statistics built
   from gameplay events. Forgetting factors (the `alpha`s) let
   the profile follow the player as they improve.
   The profile object itself is plain JSON (it is saved);
   transient per-session bookkeeping lives in the tracker.
   ========================================================= */

export const HEAT_COLS = 5;
export const HEAT_ROWS = 3;
export const BOUNDS = { x: 9, yMin: 0.9, yMax: 7.2 }; // mirrors main.js
export const RUN_HISTORY = 15;
// Struggling: each of the last STRUGGLE.recent runs is shorter than STRUGGLE.share × the
// median of the recorded runs (needs at least STRUGGLE.minRuns of history).
export const STRUGGLE = { recent: 3, share: 0.6, minRuns: 6 };
// Engagement: a ship moving at >= ACTIVE.speed counts as steering; `share` of time moving
// counts as fully engaged (also the starting value). EWMA over ~20 s of 0.2 s samples.
export const ACTIVE = { speed: 2, share: 0.2, alpha: 0.01 };
export const engagement = (p) => Math.min(1, p.activity / ACTIVE.share);

// How the player uses Shakti. Judged per USE (did it clear an imminent threat?), not per
// storm: one use clears every storm on screen, so even a pure panic use is mostly far clears
// by storm count (the per-storm clearThreatShare is kept for reference).
// 'panic'       mostly uses that clear an imminent threat (struggling: slight easing via
//               tension, base refills);
// 'convenience' mostly uses with no imminent threat, used often or with many storms on
//               screen (fewer refill offers, the controller pushes harder);
// 'mixed' otherwise, 'unknown' until enough uses are seen.
export const SHAKTI_STYLE = { minUses: 5, panicShare: 0.5, convenienceShare: 0.25, usesPerMin: 0.5, threat: 4 };
export function shaktiStyle(p) {
  const s = SHAKTI_STYLE;
  if (p.shaktiUses < s.minUses) return 'unknown';
  if (p.threatUseShare >= s.panicShare) return 'panic';
  if (p.threatUseShare < s.convenienceShare && (p.shaktiPerMin >= s.usesPerMin || p.shaktiThreat >= s.threat)) {
    return 'convenience';
  }
  return 'mixed';
}

export function defaultProfile() {
  return {
    reaction: 0.35,          // s from a new wave to the start of a dodge
    heat: new Array(HEAT_COLS * HEAT_ROWS).fill(1 / (HEAT_COLS * HEAT_ROWS)), // lane occupancy
    hitLeft: 0.15,           // hit rate for obstacles placed left of the predicted ship
    hitRight: 0.15,          // ... and right of it
    overshoot: 0.15,         // fraction of active steering samples that reverse direction
    reach: 6,                // typical distance travelled in ~1 s when moving
    recentHitRate: 0.15,     // per-obstacle hit rate
    runLength: 60,           // typical run duration (s)
    // Last RUN_HISTORY run durations (s), newest first; 0 = no run yet. Fixed length so
    // storage's type check keeps it.
    recentRuns: new Array(RUN_HISTORY).fill(0),
    recentScores: new Array(RUN_HISTORY).fill(0), // final scores, same layout as recentRuns
    bestScore: 0,            // best Adaptive score seen by the director
    boost: 0.1,              // fraction of time spent boosting
    activity: ACTIVE.share,  // fraction of time the ship is moving (steering engagement)
    shaktiThreat: 3,         // obstacles on screen when Shakti is used
    shaktiPerMin: 0.5,
    clearThreatShare: 0.5,   // share of Shakti-cleared storms that were imminent threats
    shaktiClears: 0,         // Shakti-cleared storms seen
    threatUseShare: 0.5,     // share of Shakti uses that cleared at least one imminent threat
    shaktiUses: 0,           // Shakti uses seen with clear outcomes (gates shaktiStyle)
    themes: {},              // storm theme -> hit rate
    observations: 0,         // obstacle outcomes seen (drives personalisation fade-in)
    runs: 0,
  };
}

const ewma = (old, value, alpha) => old + alpha * (value - old);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function heatCell(x, y) {
  const col = clamp(Math.floor(((x + BOUNDS.x) / (2 * BOUNDS.x)) * HEAT_COLS), 0, HEAT_COLS - 1);
  const row = clamp(Math.floor(((y - BOUNDS.yMin) / (BOUNDS.yMax - BOUNDS.yMin)) * HEAT_ROWS), 0, HEAT_ROWS - 1);
  return row * HEAT_COLS + col;
}

export function heatCellCenter(index) {
  const col = index % HEAT_COLS, row = Math.floor(index / HEAT_COLS);
  return {
    x: -BOUNDS.x + (col + 0.5) * (2 * BOUNDS.x / HEAT_COLS),
    y: BOUNDS.yMin + (row + 0.5) * ((BOUNDS.yMax - BOUNDS.yMin) / HEAT_ROWS),
  };
}

// +1 → obstacles to the player's right are harder to dodge, −1 → left.
export const weakSide = (p) => Math.tanh(4 * (p.hitRight - p.hitLeft));

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function isStruggling(p) {
  const runs = p.recentRuns.filter((d) => d > 0);
  if (runs.length < STRUGGLE.minRuns) return false;
  return runs.slice(0, STRUGGLE.recent).every((d) => d < STRUGGLE.share * median(runs));
}

// Median of the recorded Adaptive scores (null until GOVERNOR_MIN_RUNS are recorded).
export const GOVERNOR_MIN_RUNS = 5;
export function scoreMedian(p) {
  const scores = p.recentScores.filter((s) => s > 0);
  return scores.length < GOVERNOR_MIN_RUNS ? null : median(scores);
}

// Occupancy-weighted mean position: where the player tends to sit.
export function preferredPosition(p) {
  let x = 0, y = 0, total = 0;
  p.heat.forEach((w, i) => { const c = heatCellCenter(i); x += c.x * w; y += c.y * w; total += w; });
  return total > 0 ? { x: x / total, y: y / total } : { x: 0, y: (BOUNDS.yMin + BOUNDS.yMax) / 2 };
}

export function createProfileTracker(profile) {
  const history = [];           // last ~1 s of ship samples (for reach)
  let pendingWaveAt = null;     // time of a wave spawn awaiting a dodge onset
  let lastSpeed = 0;
  let lastTvx = 0;
  let lastTx = null;
  let lastT = 0;
  let runShakti = 0;

  return {
    profile,
    update(e) {
      const p = profile;
      switch (e.type) {
        case 'run_start':
          history.length = 0; pendingWaveAt = null; lastTx = null; runShakti = 0;
          break;
        case 'run_end':
          p.runs++;
          p.runLength = ewma(p.runLength, e.duration, p.runs === 1 ? 0.5 : 0.2);
          p.recentRuns.pop();
          p.recentRuns.unshift(Math.max(e.duration, 0.001));
          p.recentScores.pop();
          p.recentScores.unshift(Math.max(e.score ?? 0, 0));
          p.bestScore = Math.max(p.bestScore, e.score ?? 0);
          p.shaktiPerMin = ewma(p.shaktiPerMin, runShakti / Math.max(e.duration / 60, 0.25), 0.2);
          break;
        case 'wave_spawn':
          if (lastSpeed < 4) pendingWaveAt = e.t;
          break;
        case 'obstacle_pass': {
          if (e.outcome === 'ignored') break;
          const hit = e.outcome === 'hit' ? 1 : 0;
          p.observations++;
          p.recentHitRate = ewma(p.recentHitRate, hit, 0.05);
          if (e.side > 0) p.hitRight = ewma(p.hitRight, hit, 0.04);
          else if (e.side < 0) p.hitLeft = ewma(p.hitLeft, hit, 0.04);
          if (e.theme) p.themes[e.theme] = ewma(p.themes[e.theme] ?? p.recentHitRate, hit, 0.05);
          break;
        }
        case 'shakti_used':
          runShakti++;
          p.shaktiThreat = ewma(p.shaktiThreat, e.threats ?? 0, 0.2);
          if (e.clears?.length) {
            p.shaktiUses++;
            p.threatUseShare = ewma(p.threatUseShare, e.clears.includes('cleared_threat') ? 1 : 0, 0.15);
          }
          break;
        case 'obstacle_clear':
          p.shaktiClears++;
          p.clearThreatShare = ewma(p.clearThreatShare, e.outcome === 'cleared_threat' ? 1 : 0, 0.1);
          break;
        case 'ship_sample': {
          const speed = Math.hypot(e.vx, e.vy);
          // Reaction: first movement onset after a wave appeared while the ship was settled.
          if (pendingWaveAt !== null && speed >= 4 && lastSpeed < 4) {
            const rt = e.t - pendingWaveAt;
            if (rt > 0.1 && rt < 1.5) p.reaction = ewma(p.reaction, rt, 0.05);
            pendingWaveAt = null;
          }
          lastSpeed = speed;
          p.activity = ewma(p.activity, speed >= ACTIVE.speed ? 1 : 0, ACTIVE.alpha);
          // Lanes: decayed occupancy heatmap.
          const cell = heatCell(e.x, e.y);
          for (let i = 0; i < p.heat.length; i++) p.heat[i] *= 0.998;
          p.heat[cell] += 0.002;
          // Reach: distance covered over the last ~1 s while actively moving.
          history.push(e);
          while (history.length && e.t - history[0].t > 1.05) history.shift();
          if (history.length > 1 && e.t - history[0].t > 0.85) {
            const d = Math.hypot(e.x - history[0].x, e.y - history[0].y);
            if (d > 0.5) p.reach = ewma(p.reach, d, 0.03);
          }
          // Overshoot: how often the steering target reverses while moving fast.
          if (lastTx !== null && e.t > lastT) {
            const tvx = (e.tx - lastTx) / (e.t - lastT);
            if (Math.abs(tvx) > 3) {
              p.overshoot = ewma(p.overshoot, Math.sign(tvx) !== Math.sign(lastTvx) && Math.abs(lastTvx) > 3 ? 1 : 0, 0.02);
            }
            lastTvx = tvx;
          }
          lastTx = e.tx; lastT = e.t;
          p.boost = ewma(p.boost, e.boost ? 1 : 0, 0.005);
          break;
        }
        default:
          break;
      }
    },
  };
}
