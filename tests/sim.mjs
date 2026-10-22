/* =========================================================
   Headless simulation: bot players vs. the director.
   Mirrors main.js gameplay (speeds, spawn spacing, wave shapes,
   collision ellipsoids, shield/invulnerability, gates) without
   Three.js. Run: node tests/sim.mjs  (checks A–H on seeds 0–4; exit code 1 on any
   failed check; SIM_SEED shifts the seeds, SIM_VERBOSE=1 prints runs)
   ========================================================= */

import { createDirector, defaultModel, LIMITS } from '../personalization/director.js';
import { createStorage } from '../personalization/storage.js';
import { createRecorder } from '../personalization/recorder.js';
import { classifyObstaclePass } from '../personalization/obstacles.js';
import { seeded, memoryBackend } from './helpers.mjs';

const BOUNDS = { x: 9, yMin: 0.9, yMax: 7.2 };
const MID_Y = (BOUNDS.yMin + BOUNDS.yMax) / 2;
const SPAWN_Z = -230;
const DESPAWN_Z = 14;
const DT = 1 / 30;
const RUNS = 50;
const MAX_RUN = 420; // s — safety cap so a perfect bot cannot run forever
const THEMES = ['storm_abyss.glb', 'storm_crimson.glb', 'storm_obsidian.glb', 'storm_venom.glb', 'storm_void.glb'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;

// ---------- Bot: reaction delay + steering/perception noise ----------
function createBot(skill, rng) {
  const reaction = 0.55 - 0.4 * skill;     // s
  const noise = 1.8 * (1 - skill);          // steering jitter (units)
  const perception = 1.2 * (1 - skill);     // misjudged obstacle position (units)
  const horizon = 0.5 + 1.3 * skill;        // s of look-ahead
  const margin = 1.3 + 0.9 * (1 - skill);   // squared clearance kept; skilled players cut closer
  const queue = [];                          // delayed steering commands
  let decideTimer = 0;
  let aim = { x: 0, y: MID_Y };
  const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());

  function decide(world) {
    const threats = [];
    for (const e of world.entities) {
      if (e.type !== 'crystal' || e.passed) continue;
      const tta = -e.z / world.speed;
      if (tta < 0 || tta > horizon) continue;
      if (e.seenX === undefined) { e.seenX = e.x + gauss() * perception; e.seenY = e.y + gauss() * perception * 0.5; }
      threats.push({ e, w: 1 + (horizon - tta) });
    }
    if (!threats.length) {
      // Idle: drift around the middle like a relaxed player.
      if (rng() < 0.05) aim = { x: clamp(world.ship.x + gauss() * 2, -6, 6), y: clamp(MID_Y + gauss(), 2, 6) };
      return aim;
    }
    let best = aim, bestCost = Infinity;
    for (let x = -BOUNDS.x; x <= BOUNDS.x; x += 1.5) {
      for (let y = BOUNDS.yMin; y <= BOUNDS.yMax; y += 1.25) {
        let cost = 0.04 * Math.hypot(x - world.ship.x, y - world.ship.y);
        for (const { e, w } of threats) {
          const dx = (e.seenX - x) / (e.rx + 1.0), dy = (e.seenY - y) / (e.ry + 0.3);
          const d2 = dx * dx + dy * dy;
          if (d2 < margin) cost += w * (margin - d2);
        }
        if (cost < bestCost) { bestCost = cost; best = { x, y }; }
      }
    }
    aim = best;
    return aim;
  }

  return {
    skill,
    // Frustration: weaker players are likelier to close the game after a short, tense run.
    quits(run) { return run.cause === 'shield' && run.duration < 40 && rng() < 0.5 * (1 - skill); },
    reset() { queue.length = 0; decideTimer = 0; aim = { x: 0, y: MID_Y }; },
    steer(world, dt) {
      decideTimer -= dt;
      if (decideTimer <= 0) {
        decideTimer = 0.1;
        const d = decide(world);
        queue.push({ at: world.time + reaction, x: d.x + gauss() * noise, y: d.y + gauss() * noise * 0.5 });
      }
      while (queue.length > 1 && queue[1].at <= world.time) queue.shift();
      const cmd = queue[0] && queue[0].at <= world.time ? queue[0] : null;
      if (cmd) {
        world.target.x = clamp(cmd.x, -BOUNDS.x, BOUNDS.x);
        world.target.y = clamp(cmd.y, BOUNDS.yMin, BOUNDS.yMax);
      }
    },
  };
}

// A player who never steers: the ship stays where each run starts. Never quits.
function createIdleBot() {
  return { skill: 'idle', quits: () => false, reset() {}, steer() {} };
}

// ---------- Guardrails: every clamped value, checked every tick ----------
const EPS = 1e-9;
function guard(violations, name, value, [lo, hi]) {
  if (!(value >= lo - EPS && value <= hi + EPS) && violations.length < 10) violations.push(`${name}=${value} outside [${lo}, ${hi}]`);
}
function checkGuardrails(director, t, violations) {
  const d = director.model.director;
  for (const key of ['speedMul', 'riskMul', 'gapMul', 'targetTension', 'skill']) guard(violations, key, d[key], LIMITS[key]);
  guard(violations, 'speedMultiplier()', director.speedMultiplier(), LIMITS.speedMul);
  guard(violations, 'spawnGapMultiplier()', director.spawnGapMultiplier(), LIMITS.gapMul);
  guard(violations, 'steeringFollow()', director.steeringFollow(), LIMITS.follow);
  guard(violations, 'personalRamp()', director.personalRamp(t), [0, 1]);
  guard(violations, 'tension', director.tension, [0, 1]);
}

// ---------- One run (mirrors main.js frame/updateEntities/wave*) ----------
function playRun(director, bot, rng) {
  const rand = (a, b) => a + rng() * (b - a);
  const world = {
    time: 0, speed: 26, entities: [], ship: { x: 0, y: MID_Y, vx: 0, vy: 0 }, target: { x: 0, y: MID_Y },
  };
  const st = { shield: 100, invuln: 1, runTime: 0, dist: 0, nextSpawn: 40, powerCharges: 3 };
  let gateCount = 0;
  const waveStats = new Map(); // wave id -> did any of its obstacles hit the player?
  const wavePredicted = new Map(); // wave id -> predicted P(wave hits) at placement: 1 − Π(1 − risk)
  const calibration = [];        // [predicted risk at placement, hit?] per resolved obstacle
  const violations = [];
  let nearMisses = 0;
  let tensionSum = 0, brakeTime = 0;
  let stormRisk = 0, stormClassicRisk = 0; // placed vs. classic-proposal risk, summed over storms
  let hits = 0, passes = 0, riskSum = 0, riskTime = 0, waves = { wall: 0, scatter: 0, snake: 0, gate: 0 };

  bot.reset(); // world time restarts at 0 each run
  director.onEvent({ type: 'run_start' });
  let nextRegion = director.regionInterval();
  let theme = THEMES[0];

  const shipCtx = () => ({ ...world.ship });
  const crystal = (wave, x, y, z, s, sy, xRange = null, yRange = null, count = 1) => {
    const p = director.placeObstacle({ waveId: wave.id, x, y, z, s, sy, xRange, yRange, count, fixed: !xRange, ship: shipCtx(), speed: world.speed });
    wavePredicted.set(wave.id, 1 - (1 - (wavePredicted.get(wave.id) ?? 0)) * (1 - p.risk));
    stormRisk += p.risk; stormClassicRisk += p.classicRisk;
    world.entities.push({
      type: 'crystal', x: p.x, y: p.y, z: p.z, rx: 1.9 * p.s, ry: 1.1 * p.s * p.sy,
      passed: false, waveId: wave.id, features: p.features, side: p.side, theme, risk: p.risk,
    });
  };
  const ring = (x, y, z, variant) => world.entities.push({ type: 'ring', x, y, z, variant, passed: false });

  const W = {
    scatter(d, wave) {
      const n = 2 + Math.floor(d * 4 + rng() * 2);
      for (let i = 0; i < n; i++) crystal(wave, rand(-8.5, 8.5), rand(1.3, 6.8), SPAWN_Z - rand(0, 28), rand(0.8, 1.25), rand(1.3, 2.4), [-8.5, 8.5], [1.3, 6.8], n);
    },
    snake(d, wave) {
      if (d > 0.25) {
        const n = 1 + Math.floor(d * 2.5);
        for (let i = 0; i < n; i++) crystal(wave, rand(-8, 8), rand(1.5, 6.5), SPAWN_Z - rand(5, 40), rand(0.8, 1.1), rand(1.4, 2), [-8, 8], [1.5, 6.5], n);
      }
    },
    gate(d, wave) {
      const z = SPAWN_Z - 30;
      const alternate = gateCount++ % 2 === 0 ? 'ram' : 'seeta';
      const variant = wave.variant ?? alternate;
      const { x, y } = director.placeRing({ x: rand(-5.5, 5.5), y: rand(2.4, 5.6), z, xRange: [-5.5, 5.5], yRange: [2.4, 5.6], ship: shipCtx(), speed: world.speed }, variant);
      ring(x, y, z, variant);
      if (d > 0.4) crystal(wave, clamp(x + (rng() < 0.5 ? -1 : 1) * 4.6, -9, 9), y, z, 1, 1.6);
    },
    wall(d, wave) {
      const cols = [-8, -4, 0, 4, 8];
      const gap = Math.floor(rand(0, 5));
      let gaps = new Set([gap]);
      if (d < 0.5) gaps.add(gap === 4 ? 3 : gap + 1);
      gaps = director.wallGaps({ cols, gaps, ship: shipCtx(), speed: world.speed, z: SPAWN_Z });
      cols.forEach((x, i) => { if (!gaps.has(i)) crystal(wave, x, MID_Y, SPAWN_Z, 1, 3.3); });
    },
  };

  const report = (e, outcome) => {
    director.onEvent({ type: 'obstacle_pass', waveId: e.waveId, features: e.features, side: e.side, outcome, theme: e.theme });
    if (outcome !== 'ignored') { passes++; if (outcome === 'hit') hits++; if (outcome === 'nearMiss') nearMisses++; }
    if (outcome !== 'ignored') calibration.push([e.risk, outcome === 'hit']);
    if (e.waveId !== null && outcome !== 'ignored') waveStats.set(e.waveId, (waveStats.get(e.waveId) || false) || outcome === 'hit');
  };

  while (st.shield > 0 && st.runTime < MAX_RUN) {
    world.time += DT;
    st.runTime += DT;
    if (st.runTime >= nextRegion) {
      theme = THEMES[director.pickStormTheme(THEMES)];
      const interval = director.regionInterval();
      guard(violations, 'regionInterval', interval, LIMITS.region);
      nextRegion = st.runTime + interval;
    }
    const d = director.personalRamp(st.runTime);
    const targetSpeed = (38 + d * 55) * director.speedMultiplier();
    world.speed += (targetSpeed - world.speed) * (1 - Math.exp(-2 * DT));
    const dz = world.speed * DT;
    st.dist += dz;
    if (st.dist >= st.nextSpawn) {
      let obstacles = 0;
      for (const e of world.entities) if (e.type === 'crystal') obstacles++;
      const wave = director.chooseWave({ runTime: st.runTime, shield: st.shield, powerCharges: st.powerCharges, obstacles });
      waves[wave.arm]++;
      W[wave.arm](wave.d, wave);
      director.onEvent({ type: 'wave_spawn', id: wave.id, arm: wave.arm });
      st.nextSpawn = st.dist + lerp(70, 34, d) * director.spawnGapMultiplier();
    }

    // Ship
    bot.steer(world, DT);
    const follow = 1 - Math.exp(-director.steeringFollow() * DT);
    const px = world.ship.x, py = world.ship.y;
    world.ship.x += (world.target.x - world.ship.x) * follow;
    world.ship.y += (world.target.y - world.ship.y) * follow;
    world.ship.vx = (world.ship.x - px) / DT;
    world.ship.vy = (world.ship.y - py) / DT;
    if (st.invuln > 0) st.invuln -= DT;

    // Entities
    for (let i = world.entities.length - 1; i >= 0; i--) {
      const e = world.entities[i];
      const zOld = e.z;
      e.z += dz;
      const zc = clamp(0, zOld, e.z);
      if (e.type === 'crystal') {
        const dx = (e.x - world.ship.x) / (e.rx + 1.0);
        const dy = (e.y - world.ship.y) / (e.ry + 0.3);
        const dzn = zc / (e.rx + 0.8);
        const d2 = dx * dx + dy * dy + dzn * dzn;
        if (st.invuln <= 0 && d2 < 1) {
          report(e, 'hit');
          st.shield -= 34; st.invuln = 1.2;
          world.entities.splice(i, 1);
          continue;
        }
        const outcome = classifyObstaclePass(e, { zc, rx: e.rx, d2, invuln: st.invuln });
        if (outcome !== null) report(e, outcome);
      } else if (e.type === 'ring' && !e.passed && zOld < 0 && e.z >= 0) {
        e.passed = true;
        const through = (world.ship.x - e.x) ** 2 + (world.ship.y - e.y) ** 2 < 2.1 * 2.1;
        director.onEvent({ type: 'gate', passed: through, variant: e.variant });
        if (through) {
          st.shield = Math.min(100, st.shield + 15);
          if (e.variant === 'seeta') st.powerCharges = Math.min(3, st.powerCharges + 1);
        }
      }
      if (e.z > DESPAWN_Z) world.entities.splice(i, 1);
    }

    director.tick(DT, { playing: true, ship: world.ship, target: world.target, boost: false });
    if (director.confidence > 0) { riskSum += director.model.director.riskMul * DT; riskTime += DT; }
    tensionSum += director.tension * DT; brakeTime += director.brake > 0 ? DT : 0;
    checkGuardrails(director, st.runTime, violations);
  }

  const duration = st.runTime;
  const cause = st.shield > 0 ? 'cap' : 'shield';
  director.onEvent({ type: 'run_end', duration, score: 0, cause });
  director.save();
  const m = director.model.director;
  // Storm-carrying waves that reached the player: realised hit vs. predicted wave risk at placement.
  const faced = [...waveStats].filter(([id]) => wavePredicted.has(id));
  return {
    duration, cause, hits, passes, nearMisses, waves, calibration, violations, stormRisk, stormClassicRisk,
    waveHits: [...waveStats.values()].filter(Boolean).length, wavesFaced: waveStats.size,
    targetedWaves: faced.length,
    targetedHits: faced.filter(([, hit]) => hit).length,
    targetedRiskSum: faced.reduce((s, [id]) => s + wavePredicted.get(id), 0),
    riskMul: riskTime ? riskSum / riskTime : null,
    meanTension: tensionSum / Math.max(st.runTime, DT), brakeShare: brakeTime / Math.max(st.runTime, DT),
    speedMul: director.speedMultiplier(), rawSpeedMul: m.speedMul, gapMul: m.gapMul,
    skill: m.skill, targetTension: m.targetTension, confidence: director.confidence,
  };
}

// ---------- Experiment ----------
// One bot plays RUNS runs. When it rage-quits, the session ends and the next run starts a
// new session whose director reloads the saved model (exercises cross-session learning).
// `classic` runs the same bot and seed with Classic mode on, as the baseline for check C.
function runBot(skill, seed, { classic = false } = {}) {
  const rng = seeded(seed);
  const storage = createStorage({ defaults: defaultModel, backend: memoryBackend() });
  const newDirector = (s) => createDirector({ storage, rng: seeded(seed + 1000 + s), recorder: createRecorder() });
  let sessions = 1;
  let director = newDirector(sessions);
  if (classic) director.setClassic(true); // saved, so later sessions load it too
  const bot = skill === 'idle' ? createIdleBot() : createBot(skill, seeded(seed + 2000));
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const run = playRun(director, bot, rng);
    runs.push(run);
    if (bot.quits(run)) {
      run.quit = true;
      director.onEvent({ type: 'session_end' });
      director.save();
      director = newDirector(++sessions);
    }
  }
  return { runs, sessions };
}

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / Math.max(xs.length, 1);
const sum = (xs, fn) => xs.reduce((s, x) => s + fn(x), 0);
const f = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
// Spread of run lengths across bots: coefficient of variation of the per-bot mean lengths
// (scale-free, so a director that lengthens everyone's runs is not penalised for that alone).
const spread = (lengths) => {
  const m = mean(lengths);
  return Math.sqrt(mean(lengths.map((l) => (l - m) ** 2))) / m;
};

// ---------- Acceptance thresholds ----------
const BOTS = [[0.2, 11], [0.5, 22], [0.9, 33]];
const IDLE = ['idle', 44];       // E: a bot that never steers
// Adaptive ÷ Classic mean run length (last TAIL runs), and minimum storm-risk ratio.
const RATIO = { idleMax: 1.1, capableMax: 1.2, weakMin: 1.0, weakMax: 2.0, stormRiskMin: 0.7 };
const BASE_SEED = Number(process.env.SIM_SEED || 0);
const SEEDS = [0, 1, 2, 3, 4].map((s) => BASE_SEED + s);
const VERBOSE = process.env.SIM_VERBOSE === '1';
const TAIL = 20;                 // checks A, B and the spread in C use each bot's last 20 runs
const TRACK_TOL = 0.05;          // A: |realised wave hit rate − mean predicted wave risk at placement|
// B: obstacles binned by the risk model's prediction at placement; a bin passes when its
// observed hit rate is within max(CAL_TOL, CAL_SE × standard error) of its mean prediction.
const CAL_BINS = [0, 0.02, 0.05, 0.1, 0.2, 1];
const CAL_MIN_N = 100;           // smaller bins are reported but not judged
const CAL_TOL = 0.03;
const CAL_SE = 3;

function calibrationBins(records) {
  return CAL_BINS.slice(0, -1).map((lo, i) => {
    const hi = CAL_BINS[i + 1];
    const inBin = records.filter(([p]) => p >= lo && (p < hi || (hi === 1 && p <= 1)));
    const n = inBin.length;
    const predicted = n ? sum(inBin, ([p]) => p) / n : NaN;
    const observed = n ? inBin.filter(([, hit]) => hit).length / n : NaN;
    const se = n ? Math.sqrt(Math.max(predicted * (1 - predicted), 1e-4) / n) : NaN;
    const tol = Math.max(CAL_TOL, CAL_SE * se);
    const judged = n >= CAL_MIN_N;
    return { lo, hi, n, predicted, observed, tol, judged, ok: !judged || Math.abs(observed - predicted) <= tol };
  });
}

function summarise(skill, { runs, sessions }) {
  const tail = runs.slice(-TAIL);
  const targetedWaves = sum(tail, (r) => r.targetedWaves);
  return {
    skill, sessions, runs,
    realised: targetedWaves ? sum(tail, (r) => r.targetedHits) / targetedWaves : NaN,
    target: targetedWaves ? sum(tail, (r) => r.targetedRiskSum) / targetedWaves : NaN,
    targetedWaves,
    bins: calibrationBins(tail.flatMap((r) => r.calibration)),
    lenFirst10: mean(runs.slice(0, 10).map((r) => r.duration)),
    lenLast10: mean(runs.slice(-10).map((r) => r.duration)),
    lenTail: mean(tail.map((r) => r.duration)),
    stormRiskRatio: sum(tail, (r) => r.stormRisk) / Math.max(sum(tail, (r) => r.stormClassicRisk), 1e-12),
    violations: runs.flatMap((r) => r.violations),
    last: runs[runs.length - 1],
  };
}

function printRuns(res, label) {
  console.log(`\n  ${label}: bot skill ${res.skill}  (${res.sessions} sessions)`);
  console.log('    run  len(s)  waveHits/waves  hits/near/passes     riskMul  speed×  gap×  skill  targetTension  tension  braked  conf');
  res.runs.forEach((r, i) => {
    if (i < 5 || i % 5 === 4) {
      console.log(`    ${String(i + 1).padStart(3)}  ${f(r.duration, 0).padStart(6)}${r.quit ? 'q' : ' '} ${`${r.waveHits}/${r.wavesFaced}`.padStart(14)}  ${`${r.hits}/${r.nearMisses}/${r.passes}`.padStart(16)}  ${f(r.riskMul).padStart(10)}  ${f(r.speedMul).padStart(6)}  ${f(r.gapMul).padStart(4)}  ${f(r.skill).padStart(5)}  ${f(r.targetTension).padStart(13)}  ${f(r.meanTension).padStart(7)}  ${f(r.brakeShare).padStart(6)}  ${f(r.confidence)}`);
    }
  });
}

const started = Date.now();
const overview = []; // [seed, check, ok]
for (const seed of SEEDS) {
  const personal = BOTS.map(([skill, s]) => summarise(skill, runBot(skill, s + seed)));
  const classic = BOTS.map(([skill, s]) => summarise(skill, runBot(skill, s + seed, { classic: true })));
  const idle = summarise(IDLE[0], runBot(IDLE[0], IDLE[1] + seed));
  const idleClassic = summarise(IDLE[0], runBot(IDLE[0], IDLE[1] + seed, { classic: true }));
  const checks = [];
  const check = (id, label, ok) => { checks.push([id, label, ok]); overview.push([seed, id, ok]); };

  console.log(`\n================ SEED ${seed} ================`);
  if (VERBOSE) {
    [...personal, idle].forEach((r) => printRuns(r, 'Adaptive'));
    [...classic, idleClassic].forEach((r) => printRuns(r, 'Classic'));
  }

  console.log(`  bot   realised  predicted  waves   len first10→last10  len(last ${TAIL}) adaptive / classic  ratio  storm risk×  skill  speed×`);
  [...personal, idle].forEach((r, i) => {
    const c = i < personal.length ? classic[i] : idleClassic;
    console.log(`  ${String(r.skill).padEnd(4)}  ${f(r.realised, 3).padStart(8)}  ${f(r.target, 3).padStart(9)}  ${String(r.targetedWaves).padStart(5)}  ${`${f(r.lenFirst10, 0)} → ${f(r.lenLast10, 0)}`.padStart(19)}  ${`${f(r.lenTail, 0)} / ${f(c.lenTail, 0)}`.padStart(28)}  ${f(r.lenTail / c.lenTail).padStart(5)}  ${f(r.stormRiskRatio).padStart(11)}  ${f(r.last.skill).padStart(5)}  ${f(r.last.speedMul).padStart(6)}`);
  });

  // A. Realised wave hit rate tracks the wave risk predicted when the waves were placed.
  for (const r of personal) {
    const gap = Math.abs(r.realised - r.target);
    check('A', `bot ${r.skill}: |realised ${f(r.realised, 3)} − predicted ${f(r.target, 3)}| = ${f(gap, 3)} ≤ ${TRACK_TOL}`, gap <= TRACK_TOL);
  }

  // B. Risk-model calibration per predicted-risk bin.
  console.log(`  calibration (last ${TAIL} runs): bin  n  predicted → observed  (tol)`);
  for (const r of personal) {
    for (const b of r.bins) {
      if (!b.n) continue;
      console.log(`    bot ${r.skill}  [${b.lo}, ${b.hi})  ${String(b.n).padStart(5)}  ${f(b.predicted, 3)} → ${f(b.observed, 3)}  (±${f(b.tol, 3)})${b.judged ? (b.ok ? '' : '  OFF') : '  (too few, not judged)'}`);
    }
    const judged = r.bins.filter((b) => b.judged);
    const bad = judged.filter((b) => !b.ok).map((b) => `[${b.lo}, ${b.hi})`);
    check('B', `bot ${r.skill}: ${judged.length - bad.length}/${judged.length} judged risk bins calibrated${bad.length ? ` (off: ${bad.join(' ')})` : ''}`,
      judged.length > 0 && bad.length === 0);
  }

  // C. Mid bot's runs don't get shorter; spread across bots shrinks vs. Classic mode.
  const mid = personal[1];
  check('C', `mid bot runs do not get shorter (${f(mid.lenFirst10, 0)}s → ${f(mid.lenLast10, 0)}s)`, mid.lenLast10 >= mid.lenFirst10);
  const sp = spread(personal.map((r) => r.lenTail)), sc = spread(classic.map((r) => r.lenTail));
  check('C', `run-length spread across bots (CV) ${f(sp)} < classic ${f(sc)}`, sp < sc);

  // D. Guardrail clamps never exceeded (personalised and classic runs, every tick).
  for (const [label, set] of [['personal', [...personal, idle]], ['classic', [...classic, idleClassic]]]) {
    const v = set.flatMap((r) => r.violations);
    check('D', `${label}: guardrail clamps never exceeded${v.length ? ` (${v.slice(0, 3).join('; ')})` : ''}`, v.length === 0);
  }

  // E–G. Adaptive must not be easier than Classic for players who don't need it.
  const ratio = (r, c) => r.lenTail / c.lenTail;
  const e = ratio(idle, idleClassic);
  check('E', `non-steering bot: adaptive/classic run length ${f(e)} ≤ ${RATIO.idleMax}`, e <= RATIO.idleMax);
  for (const i of [1, 2]) {
    const x = ratio(personal[i], classic[i]);
    check('F', `bot ${personal[i].skill}: adaptive/classic run length ${f(x)} ≤ ${RATIO.capableMax}`, x <= RATIO.capableMax);
  }
  const g = ratio(personal[0], classic[0]);
  check('G', `weak bot: adaptive/classic run length ${f(g)} within [${RATIO.weakMin}, ${RATIO.weakMax}]`, g >= RATIO.weakMin && g <= RATIO.weakMax);

  // H. Storms stay at least 0.7 × as risky as the classic proposals they replace.
  for (const i of [1, 2]) {
    const h = personal[i].stormRiskRatio;
    check('H', `bot ${personal[i].skill}: mean storm risk ${f(h)} × classic proposal ≥ ${RATIO.stormRiskMin}`, h >= RATIO.stormRiskMin);
  }

  console.log('  ACCEPTANCE');
  for (const [id, label, ok] of checks) console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}`);
}

console.log('\nOVERVIEW (seed × check: failures / total)');
console.log(`  seed  ${['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((c) => c.padStart(5)).join('')}`);
for (const seed of SEEDS) {
  const cells = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => {
    const rows = overview.filter(([s, c]) => s === seed && c === id);
    const failed = rows.filter(([, , ok]) => !ok).length;
    return `${failed ? `${failed}✗` : '✓'}/${rows.length}`.padStart(5);
  });
  console.log(`  ${String(seed).padStart(4)}  ${cells.join('')}`);
}
const failures = overview.filter(([, , ok]) => !ok).length;
console.log(`\n${failures ? `FAILED: ${failures} of ${overview.length} checks` : `ALL ${overview.length} CHECKS PASSED`}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (failures) process.exit(1);
