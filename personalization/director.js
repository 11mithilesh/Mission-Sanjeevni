/* =========================================================
   Director — the only module the game asks for decisions.
   Owns the tension controller and blends between TODAY's
   hand-tuned behaviour (CLASSIC) and personalised choices.

   Fade-in: `confidence` is frozen at each run start from how
   many obstacle outcomes the model has seen. With no saved
   model it is 0, so every output equals the classic game and
   no extra random numbers are drawn; personalisation then
   fades in over the following runs. Even at full confidence
   ~10% of decisions stay classic, as exploration.

   Objective: the shield takes 3 hits, so hits are far too
   rare and too costly to steer by. Tension comes from near
   misses (and calms on clean waves); the controller aims it
   at `targetTension`. A hit only engages a fixed 8 s brake
   that eases difficulty. The resulting "felt" level drives
   both the in-run controller and the between-run `skill`
   update.

   Difficulty is relative to Classic: storms aim at the
   classic proposal's risk × `riskMul` (never below its floor
   × classic), walls keep the classic gap unless riskMul > 1,
   and the wave mix targets riskMul × the classic mix's rate.
   Speed, spacing and ramp go easier than Classic only for
   players flagged as struggling (see profile.isStruggling),
   who are also the only ones offered rescue कवच gates.
   Seeta refills are offered sparingly (see SEETA); storms a
   player clears with Shakti are classified as imminent
   threats (tension, like a near miss) or far clears.
   ========================================================= */

import { createStorage, SCHEMA_VERSION } from './storage.js';
import { createRecorder } from './recorder.js';
import {
  defaultProfile, createProfileTracker, weakSide, heatCellCenter, isStruggling, engagement, shaktiStyle, BOUNDS,
} from './profile.js';
import { defaultRisk, riskFeatures, predictRisk, updateRisk } from './models/risk.js';
import { ARMS, defaultBandit, updateBandit, chooseArm, banditMean } from './models/bandit.js';
import { predictShip, missProbability } from './models/reach.js';

// Today's hand-tuned constants (cold start must reproduce these exactly).
export const CLASSIC = {
  follow: 8, rampSeconds: 150, regionMin: 40, regionMax: 60,
  speedMul: 1, gapMul: 1, skill: 1,
};
export const FADE_OBSERVATIONS = 250;   // obstacle outcomes until fully personalised
export const CANDIDATES = 24;
export const VISIBLE_Z = 130;            // roughly where storms emerge from the fog
export const CLASSIC_SHARE = 0.1;        // share of decisions left classic at full confidence
// riskMul scales storm risk RELATIVE to the classic proposal: each storm aims at
// classicRisk × riskMul, and is never placed below riskMul's floor × classicRisk.
export const LIMITS = {
  speedMul: [0.75, 1.35], riskMul: [0.7, 1.5], gapMul: [0.7, 1.5],
  targetTension: [0.15, 0.5], skill: [0.5, 2.5], follow: [5, 12], region: [30, 70],
};
// Tension controller tuning: gain per unit error, and max change per second.
const CONTROL = {
  speedMul: { gain: 0.05, rate: 0.01 },
  riskMul: { gain: 0.08, rate: 0.012 },
  gapMul: { gain: -0.1, rate: 0.015 },
};
// Tension is near-miss driven; hits never add to it.
const TENSION = { nearMiss: 0.12, clean: -0.03, decay: 0.15 };
// Hit brake: a hit eases at a fixed strength for `seconds` of play. Further hits restart the
// timer; they never extend or strengthen it. While engaged the controller can only ease.
const BRAKE = { seconds: 8, weight: 0.5 };
// Pushing harder runs at this share of the easing rate. Near-miss tension sits below target
// for most players, so with symmetric rates the controller settles where half of play is
// braked (a hit every 2 × BRAKE.seconds), far harder than Classic. At 1/4 it settles at
// 20% braked: a hit every ~40 s. Players hit more often than that in Classic are eased;
// players hit less often are pushed.
const PUSH_SHARE = 1 / 4;
const SKILL_RATE = 0.25; // log-skill change per run at a fully saturated controller push
const RESCUE = { interval: 30, shield: 40 }; // s of run time per rescue gate; shield at or below
// Director-offered Seeta Shakti refills: only at 0 charges, one in flight at a time, and at
// least `cooldown` s of run time between offers (so never more than 1 per 30 s).
// Shakti style (profile.shaktiStyle): convenience users (mostly far clears) get refills
// `convenienceSlower`× less often and a faster push; panic users (mostly imminent clears) keep
// the base refill rate (no extra refills for struggling) and ease via threat-clear tension.
const SEETA = { cooldown: 30, convenienceSlower: 3 };
const CONVENIENCE_PUSH = 1.5;

const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;

// Probabilities of today's spawnWave() selection (see chooseWave) at this point of a run.
function classicArmWeights(runTime, d) {
  const wall = runTime > 12 ? 0.18 + d * 0.1 : 0;
  return { wall, scatter: 0.5 - wall, snake: 0.28, gate: 0.22 };
}

export function defaultModel() {
  return {
    version: SCHEMA_VERSION,
    classic: false,
    profile: defaultProfile(),
    risk: defaultRisk(),
    bandit: defaultBandit(),
    director: {
      targetTension: 0.25, skill: 1, speedMul: 1, gapMul: 1, riskMul: 1,
    },
  };
}

export function createDirector({
  storage = createStorage({ defaults: defaultModel }), rng = Math.random,
  recorder = createRecorder({ persistSummaries: typeof indexedDB !== 'undefined' }),
} = {}) {
  let { model, fresh } = storage.load();
  // Models saved under older limits are pulled into range.
  for (const key of ['speedMul', 'riskMul', 'gapMul', 'targetTension', 'skill']) {
    model.director[key] = clamp(model.director[key], LIMITS[key]);
  }
  let tracker = createProfileTracker(model.profile);
  let confidence = 0;
  let tension = 0;
  let brake = 0;
  let struggling = false;  // frozen at run start from the profile's recent run lengths
  let lastRescueAt = 0;    // run time of the last rescue gate (0: none before RESCUE.interval)
  let lastSeetaAt = 0;     // run time of the last offered Seeta ring (0: none before the cooldown)
  let seetaPending = false; // an offered Seeta ring is still in flight
  let style = 'unknown';   // Shakti style, frozen at run start
  let clock = 0;           // run time as seen by the director
  let sampleTimer = 0;
  let nextWaveId = 1;
  const waves = new Map(); // id -> { arm, pending, hit, cleared }
  const decisions = [];    // last 10 placements, for the debug overlay
  let run = null;          // per-run tension bookkeeping
  let lastRunEnd = null;   // { at (ms), endFelt } for quit detection

  const D = () => model.director;
  const personalising = () => confidence > 0 && rng() < Math.min(confidence, 1 - CLASSIC_SHARE);
  const learning = () => !model.classic;

  function computeConfidence() {
    return model.classic ? 0 : clamp(model.profile.observations / FADE_OBSERVATIONS, [0, 1]);
  }

  function logDecision(entry) {
    decisions.push(entry);
    if (decisions.length > 10) decisions.shift();
  }

  // Feature vector for an obstacle at (x, y) given the predicted ship position.
  function featuresFor(x, y, ctx, pred) {
    const ship = ctx.ship;
    const ux = x - ship.x, uy = y - ship.y;
    const len = Math.hypot(ux, uy) || 1;
    return riskFeatures({
      dx: x - pred.x,
      dy: y - pred.y,
      weakSide: weakSide(model.profile),
      speed: ctx.speed,
      size: (ctx.s ?? 1) * (ctx.sy ?? 1.8) / 1.8,
      approach: (ship.vx * ux + ship.vy * uy) / len,
      recentHitRate: model.profile.recentHitRate,
    });
  }

  const arrival = (ctx) => Math.max(0.2, -ctx.z / Math.max(ctx.speed, 1));

  function registerObstacle(waveId) {
    const wave = waves.get(waveId);
    if (wave) wave.pending++;
  }

  function resolveWave(id, wave) {
    waves.delete(id);
    if (!learning()) return;
    // A "clean pass" is a whole wave cleared without a hit or near miss. Counting it per
    // obstacle would make denser (harder) play read as calmer and run the controller away.
    if (!wave.hit && !wave.nearMiss && !wave.cleared) addTension(TENSION.clean);
    if (wave.hit) updateBandit(model.bandit, wave.arm, true);
    else if (!wave.cleared) updateBandit(model.bandit, wave.arm, false);
  }

  function addTension(amount) {
    tension = Math.min(1, Math.max(0, tension + amount));
  }

  // The one signal both the in-run controller and the between-run skill update steer by.
  // Without a brake it is the near-miss tension. With one it never reads below target
  // (so the controller cannot push harder) and sits a fixed BRAKE.weight above it.
  function felt() {
    return brake > 0 ? Math.max(tension, D().targetTension) + BRAKE.weight : tension;
  }

  function applyBrake() {
    brake = BRAKE.seconds;
  }

  // Easing below Classic speed, spacing or ramp is only for players flagged as struggling.
  // Storm risk eases below Classic only as far as the player is steering: someone who
  // doesn't move gets no easier storms (riskMul >= 1), an engaged player down to the floor.
  function limit(key) {
    const [lo, hi] = LIMITS[key];
    if (key === 'riskMul') return [lerp(1, lo, engagement(model.profile)), hi];
    if (struggling) return LIMITS[key];
    if (key === 'speedMul' || key === 'skill') return [Math.max(lo, CLASSIC[key]), hi];
    if (key === 'gapMul') return [lo, Math.min(hi, CLASSIC.gapMul)];
    return LIMITS[key];
  }

  // A knob's step this frame as a share of its easing rate limit, signed toward "harder":
  // in [-1, PUSH_SHARE]. Both the controller and the skill update use it.
  function push(key, err) {
    const { gain, rate } = CONTROL[key];
    const p = clamp(Math.abs(gain) * err / rate, [-1, 1]);
    return p > 0 ? p * PUSH_SHARE * (style === 'convenience' ? CONVENIENCE_PUSH : 1) : p;
  }

  function stepController(dt) {
    const err = D().targetTension - felt();
    for (const key of Object.keys(CONTROL)) {
      const { gain, rate } = CONTROL[key];
      D()[key] = clamp(D()[key] + Math.sign(gain) * push(key, err) * rate * dt, limit(key));
    }
  }

  // How hard the controller is pushing toward "harder", averaged over knobs. Skill learns
  // from this, so a brief brake spike weighs no more than it does in the controller.
  function drive() {
    const err = D().targetTension - felt();
    const keys = Object.keys(CONTROL);
    return keys.reduce((s, k) => s + push(k, err), 0) / keys.length;
  }

  function endRun(e) {
    if (!run) return;
    const duration = Math.max(e.duration ?? clock, 0.001);
    // Averaged over the same engaged time the controller runs in, so the opening seconds
    // before any obstacle arrives don't read as "too calm".
    const meanFelt = run.feltSum / Math.max(run.engagedTime, 0.001);
    const meanDrive = run.driveSum / Math.max(run.engagedTime, 0.001);
    const endFelt = run.recent.length
      ? run.recent.reduce((s, v) => s + v, 0) / run.recent.length : felt();
    if (learning() && duration > 10 && run.engagedTime > 5) {
      // Skill: ramp faster next time when the controller spent the run pushing harder,
      // slower when it spent it easing or braking.
      D().skill = clamp(D().skill * Math.exp(SKILL_RATE * meanDrive), limit('skill'));
      // Target tension, learned from how runs end.
      if (e.cause === 'quit' && endFelt > D().targetTension) D().targetTension -= 0.02;
      else if (duration > 1.3 * model.profile.runLength && meanFelt >= 0.9 * D().targetTension) {
        D().targetTension += 0.01;
      }
      D().targetTension = clamp(D().targetTension, LIMITS.targetTension);
    }
    recorder.saveSummary?.({
      at: Date.now(), duration, score: e.score, cause: e.cause, hits: run.hits,
      clearedThreat: run.clearedThreat, clearedFar: run.clearedFar,
      meanFelt, skill: D().skill, targetTension: D().targetTension,
    });
    lastRunEnd = { at: Date.now(), endFelt, quitHandled: e.cause === 'quit' };
    // Waves still in flight: keep a hit, drop unresolved clean ones (the run ended first).
    for (const [id, wave] of waves) {
      if (wave.hit) resolveWave(id, wave); else waves.delete(id);
    }
    run = null;
  }

  const director = {
    get model() { return model; },
    get fresh() { return fresh; },
    get confidence() { return confidence; },
    get tension() { return tension; },
    get brake() { return brake; },
    get struggling() { return struggling; },
    get seetaPending() { return seetaPending; },
    get shaktiStyle() { return style; },
    // This run's Shakti clears so far: { threat, far }.
    get runClears() { return { threat: run?.clearedThreat ?? 0, far: run?.clearedFar ?? 0 }; },
    get felt() { return felt(); },
    get decisions() { return decisions; },
    get recorder() { return recorder; },

    // ---------- Decisions ----------
    chooseWave(ctx) {
      const id = nextWaveId++;
      const d = director.personalRamp(ctx.runTime);
      let arm, variant = null;
      const ringVariant = director.shouldOfferRing(ctx);
      if (ringVariant) {
        arm = 'gate'; variant = ringVariant;
      } else if (personalising()) {
        const allowed = ctx.runTime > 12 ? ARMS : ARMS.filter((a) => a !== 'wall');
        // Relative target: the classic mix tilted to riskMul × its own expected hit rate.
        const mix = classicArmWeights(ctx.runTime, d);
        const classicHitRate = allowed.reduce((s, a) => s + mix[a] * banditMean(model.bandit[a]), 0);
        arm = chooseArm(model.bandit, mix, classicHitRate * D().riskMul, allowed, rng);
      } else {
        // Today's spawnWave() selection, unchanged.
        const r = rng();
        if (ctx.runTime > 12 && r < 0.18 + d * 0.1) arm = 'wall';
        else if (r < 0.5) arm = 'scatter';
        else if (r < 0.78) arm = 'snake';
        else arm = 'gate';
      }
      waves.set(id, { arm, pending: 0, hit: false, nearMiss: false, cleared: false });
      return { id, arm, variant, d, offered: !!ringVariant };
    },

    // ctx: { waveId, x, y, z, s, sy, xRange, yRange, count, ship:{x,y,vx,vy}, speed, fixed }
    // x/y/z/s/sy are the classic proposal; returned unchanged unless personalising.
    placeObstacle(ctx) {
      registerObstacle(ctx.waveId);
      const t = arrival(ctx);
      const pred = predictShip(model.profile, ctx.ship, t);
      let { x, y } = ctx;
      let features = featuresFor(x, y, ctx, pred);
      let risk = predictRisk(model.risk, features);
      const classicRisk = risk;
      let personal = false, goal = classicRisk;
      if (!ctx.fixed && ctx.xRange && personalising()) {
        personal = true;
        // Aim at the classic proposal's risk scaled by riskMul (±5% jitter). The classic spot
        // is the fallback, and no candidate below the floor is ever taken.
        goal = classicRisk * D().riskMul * (1 + (rng() - 0.5) * 0.1);
        const floor = LIMITS.riskMul[0] * classicRisk;
        let bestGap = Math.abs(classicRisk - goal);
        // Half the candidates slide the classic spot along the line from the predicted ship
        // (risk falls with distance, so this reaches the goal precisely); half are random.
        const radial = CANDIDATES / 2;
        for (let i = 0; i < CANDIDATES; i++) {
          const k = 0.4 * Math.pow(4, i / (radial - 1)); // 0.4× … 1.6× the classic distance
          const cx = i < radial ? clamp(pred.x + (ctx.x - pred.x) * k, ctx.xRange) : lerp(ctx.xRange[0], ctx.xRange[1], rng());
          const cy = i < radial ? clamp(pred.y + (ctx.y - pred.y) * k, ctx.yRange) : lerp(ctx.yRange[0], ctx.yRange[1], rng());
          const f = featuresFor(cx, cy, ctx, pred);
          const r = predictRisk(model.risk, f);
          if (r >= floor && Math.abs(r - goal) < bestGap) {
            bestGap = Math.abs(r - goal);
            x = cx; y = cy; features = f; risk = r;
          }
        }
      }
      if (!ctx.fixed) logDecision({ kind: 'obstacle', x, y, risk, target: goal, personal });
      return { x, y, z: ctx.z, s: ctx.s, sy: ctx.sy, features, risk, classicRisk, side: Math.sign(x - pred.x) };
    },

    // Choose wall gap column(s). ctx: { cols, gaps (classic), ship, speed, z }
    // The classic gap stays unless the controller is pushing harder (riskMul > 1); then the
    // gap whose miss risk is nearest classicRisk × riskMul (never below the floor) is used.
    wallGaps(ctx) {
      if (!personalising()) return ctx.gaps;
      const pred = predictShip(model.profile, ctx.ship, arrival(ctx));
      const warning = Math.min(arrival(ctx), VISIBLE_Z / Math.max(ctx.speed, 1));
      const riskOf = (gaps) => {
        const gx = gaps.reduce((s, i) => s + ctx.cols[i], 0) / gaps.length;
        return missProbability(model.profile, Math.abs(gx - pred.x), warning, gaps.length === 1 ? 1.1 : 3.1);
      };
      const classicRisk = riskOf([...ctx.gaps]);
      let best = ctx.gaps, bestRisk = classicRisk, goal = classicRisk;
      if (D().riskMul > 1) {
        goal = classicRisk * D().riskMul;
        const floor = LIMITS.riskMul[0] * classicRisk;
        let bestGap = Math.abs(classicRisk - goal);
        ctx.cols.forEach((_, i) => {
          for (const gaps of i < ctx.cols.length - 1 ? [[i], [i, i + 1]] : [[i]]) {
            const risk = riskOf(gaps);
            if (risk >= floor && Math.abs(risk - goal) < bestGap) { bestGap = Math.abs(risk - goal); best = new Set(gaps); bestRisk = risk; }
          }
        });
      }
      logDecision({ kind: 'wall', x: [...best].join('+'), y: '', risk: bestRisk, target: goal, personal: best !== ctx.gaps });
      return best;
    },

    // Returns the variant of a director-offered ring, else null. The game marks the wave
    // `offered`: such rings never score; 'ram' only restores shield, 'seeta' only a charge.
    // - 'ram' (rescue कवच): players flagged as struggling, shield low, ≤ 1 per RESCUE.interval s.
    // - 'seeta' (refill): 0 charges, none already in flight, ≥ SEETA.cooldown s since the last.
    shouldOfferRing(ctx) {
      if (confidence <= 0) return null;
      if (struggling && ctx.shield <= RESCUE.shield && ctx.runTime - lastRescueAt >= RESCUE.interval) {
        lastRescueAt = ctx.runTime;
        return 'ram';
      }
      const cooldown = SEETA.cooldown * (style === 'convenience' ? SEETA.convenienceSlower : 1);
      if (ctx.powerCharges === 0 && !seetaPending && ctx.runTime - lastSeetaAt >= cooldown) {
        lastSeetaAt = ctx.runTime;
        seetaPending = true;
        return 'seeta';
      }
      return null;
    },

    // ctx: { x, y, z (classic proposal), xRange, yRange, ship, speed }
    placeRing(ctx, variant) {
      if (!personalising()) return { x: ctx.x, y: ctx.y };
      const pred = predictShip(model.profile, ctx.ship, arrival(ctx));
      const want = model.profile.reach * lerp(0.8, 0.9, rng());
      const start = rng() * Math.PI * 2;
      let best = { x: ctx.x, y: ctx.y }, bestGap = Infinity;
      for (let i = 0; i < 8; i++) {
        const a = start + (i / 8) * Math.PI * 2;
        const x = clamp(pred.x + Math.cos(a) * want, ctx.xRange);
        const y = clamp(pred.y + Math.sin(a) * want, ctx.yRange);
        const gap = Math.abs(Math.hypot(x - pred.x, y - pred.y) - want);
        if (gap < bestGap) { bestGap = gap; best = { x, y }; }
      }
      logDecision({ kind: `ring:${variant}`, x: best.x, y: best.y, risk: 0, target: want, personal: true });
      return best;
    },

    // Anchor for a fruit trail, nudged toward lanes the player under-uses.
    // ctx: { x, y (classic proposal), xRange, yRange }
    fruitPath(ctx) {
      if (!personalising()) return { x: ctx.x, y: ctx.y };
      const heat = model.profile.heat;
      const max = Math.max(...heat);
      const weights = heat.map((h) => max - h + 0.02);
      let pick = rng() * weights.reduce((s, w) => s + w, 0), cell = 0;
      while (cell < weights.length - 1 && (pick -= weights[cell]) > 0) cell++;
      const c = heatCellCenter(cell);
      return {
        x: clamp(c.x + (rng() - 0.5) * 2, ctx.xRange),
        y: clamp(c.y + (rng() - 0.5) * 1, ctx.yRange),
      };
    },

    speedMultiplier() { return lerp(CLASSIC.speedMul, D().speedMul, confidence); },
    spawnGapMultiplier() { return lerp(CLASSIC.gapMul, D().gapMul, confidence); },
    personalRamp(runTime) {
      const skill = lerp(CLASSIC.skill, D().skill, confidence);
      return Math.min(1, runTime * skill / CLASSIC.rampSeconds);
    },
    steeringFollow() {
      const mapped = clamp(CLASSIC.follow * Math.sqrt(0.15 / Math.max(model.profile.overshoot, 0.03)), LIMITS.follow);
      return lerp(CLASSIC.follow, mapped, confidence);
    },
    regionInterval() {
      const classic = CLASSIC.regionMin + rng() * (CLASSIC.regionMax - CLASSIC.regionMin);
      if (confidence <= 0) return classic;
      const base = clamp(model.profile.runLength / 2.5, LIMITS.region);
      return clamp(lerp(classic, base * lerp(0.8, 1.2, rng()), confidence), LIMITS.region);
    },
    // Index into `available` (theme names). Shifts at most 20% of the weight toward
    // themes the player does well in; every theme keeps at least 80% of its share.
    pickStormTheme(available) {
      const n = available.length;
      if (confidence <= 0 || n < 2) return Math.floor(rng() * n);
      const skillIn = available.map((name) => 1 - (model.profile.themes[name] ?? model.profile.recentHitRate));
      const total = skillIn.reduce((s, v) => s + v, 0) || 1;
      const shift = 0.2 * confidence;
      const weights = skillIn.map((v) => (1 - shift) / n + shift * v / total);
      let pick = rng(), i = 0;
      while (i < n - 1 && (pick -= weights[i]) > 0) i++;
      return i;
    },

    // ---------- Updates ----------
    // ctx: { playing, ship:{x,y,vx,vy}, target:{x,y}, boost }
    tick(dt, ctx) {
      if (!ctx.playing) return;
      clock += dt;
      tension *= Math.exp(-TENSION.decay * dt);
      brake = Math.max(0, brake - dt);
      // Hold the controller until obstacles actually reach the player this run: the empty
      // opening seconds would otherwise read as "too calm" every run and wind difficulty up.
      if (confidence > 0 && run?.engaged) stepController(dt);
      if (run) {
        if (run.engaged) {
          run.engagedTime += dt;
          run.feltSum += felt() * dt;
          run.driveSum += drive() * dt;
        }
        run.recentTimer += dt;
        if (run.recentTimer >= 0.5) {
          run.recentTimer = 0;
          run.recent.push(felt());
          if (run.recent.length > 20) run.recent.shift(); // last 10 s
        }
      }
      sampleTimer += dt;
      if (sampleTimer >= 0.2) {
        sampleTimer = 0;
        director.onEvent({
          type: 'ship_sample', x: ctx.ship.x, y: ctx.ship.y, vx: ctx.ship.vx, vy: ctx.ship.vy,
          tx: ctx.target.x, ty: ctx.target.y, boost: ctx.boost,
        });
      }
    },

    onEvent(e) {
      if (e.t === undefined) e.t = clock;
      if (e.type === 'run_start') {
        confidence = computeConfidence();
        struggling = confidence > 0 && isStruggling(model.profile);
        style = confidence > 0 ? shaktiStyle(model.profile) : 'unknown';
        lastRescueAt = 0;
        lastSeetaAt = 0;
        seetaPending = false;
        // A player no longer struggling loses any below-Classic easing learned meanwhile.
        if (learning()) for (const key of ['speedMul', 'gapMul', 'skill', 'riskMul']) D()[key] = clamp(D()[key], limit(key));
        // Tension and the brake carry over between runs (they only decay during play), so
        // the strain of a death still counts when the player restarts straight away.
        clock = 0; e.t = 0; sampleTimer = 0;
        waves.clear();
        run = {
          engagedTime: 0, feltSum: 0, driveSum: 0, recent: [], recentTimer: 0, hits: 0, engaged: false,
          clearedThreat: 0, clearedFar: 0,
        };
      }
      if (!learning()) {
        if (e.type === 'run_end') run = null;
        return;
      }
      recorder.push(e);
      if (e.type === 'run_end') endRun(e); // before the profile updates its run length
      if (e.type === 'session_end') {
        // Quitting soon after a tense death counts like a quit.
        if (lastRunEnd && !lastRunEnd.quitHandled && Date.now() - lastRunEnd.at < 20000
          && lastRunEnd.endFelt > D().targetTension) {
          D().targetTension = clamp(D().targetTension - 0.02, LIMITS.targetTension);
          lastRunEnd.quitHandled = true;
        }
        return;
      }
      tracker.update(e);
      if (e.type === 'wave_spawn') {
        const wave = waves.get(e.id);
        if (wave && wave.pending === 0) resolveWave(e.id, wave);
      } else if (e.type === 'obstacle_pass') {
        const hit = e.outcome === 'hit';
        if (e.outcome === 'nearMiss') addTension(TENSION.nearMiss);
        if (run) { run.engaged = true; if (hit) run.hits++; }
        if (hit) applyBrake();
        if (e.features && e.outcome !== 'ignored') updateRisk(model.risk, e.features, hit ? 1 : 0);
        const wave = waves.get(e.waveId);
        if (wave) {
          wave.hit ||= hit;
          wave.nearMiss ||= e.outcome === 'nearMiss';
          if (e.outcome === 'ignored') wave.cleared = true;
          if (--wave.pending <= 0) resolveWave(e.waveId, wave);
        }
      } else if (e.type === 'shakti_used') {
        for (const id of e.waveIds ?? []) {
          const wave = waves.get(id);
          if (!wave) continue;
          wave.cleared = true;
          if (--wave.pending <= 0) resolveWave(id, wave);
        }
        // One outcome per storm still ahead (see classifyShaktiClear). Recorded as their own
        // events; they never label the risk model (the storm's fate is unknown).
        for (const outcome of e.clears ?? []) director.onEvent({ type: 'obstacle_clear', outcome });
      } else if (e.type === 'obstacle_clear') {
        // Clearing an imminent hit is as tense as a near miss.
        const threat = e.outcome === 'cleared_threat';
        if (threat) addTension(TENSION.nearMiss);
        if (run) { run.engaged = true; if (threat) run.clearedThreat++; else run.clearedFar++; }
      } else if (e.type === 'gate') {
        if (e.offered && e.variant === 'seeta') seetaPending = false;
      }
    },

    // ---------- Persistence & settings ----------
    save() { fresh = false; return storage.save(model); },
    reset() {
      storage.reset();
      recorder.clear();
      recorder.clearSummaries?.();
      const classic = model.classic;
      model = defaultModel();
      model.classic = classic;
      tracker = createProfileTracker(model.profile);
      fresh = true;
      confidence = 0;
      tension = 0;
      brake = 0;
      waves.clear();
      decisions.length = 0;
    },
    setClassic(on) {
      model.classic = !!on;
      if (on) confidence = 0;
      storage.save(model);
    },
  };
  return director;
}
