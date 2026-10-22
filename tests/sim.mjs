/* =========================================================
   Headless simulation: bot players vs. the director.
   Mirrors main.js gameplay (speeds, spawn spacing, wave shapes,
   collision ellipsoids, shield/invulnerability, gates) without
   Three.js. Run: node tests/sim.mjs  (exit code 1 on failure)
   ========================================================= */

import { createDirector, defaultModel } from '../personalization/director.js';
import { createStorage } from '../personalization/storage.js';
import { createRecorder } from '../personalization/recorder.js';
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

// ---------- One run (mirrors main.js frame/updateEntities/wave*) ----------
function playRun(director, bot, rng) {
  const rand = (a, b) => a + rng() * (b - a);
  const world = {
    time: 0, speed: 26, entities: [], ship: { x: 0, y: MID_Y, vx: 0, vy: 0 }, target: { x: 0, y: MID_Y },
  };
  const st = { shield: 100, invuln: 1, runTime: 0, dist: 0, nextSpawn: 40, powerCharges: 3 };
  let gateCount = 0;
  const waveStats = new Map(); // wave id -> did any of its obstacles hit the player?
  let nearMisses = 0;
  let hits = 0, passes = 0, riskSum = 0, riskTime = 0, waves = { wall: 0, scatter: 0, snake: 0, gate: 0 };

  bot.reset(); // world time restarts at 0 each run
  director.onEvent({ type: 'run_start' });
  let nextRegion = director.regionInterval();
  let theme = THEMES[0];

  const shipCtx = () => ({ ...world.ship });
  const crystal = (wave, x, y, z, s, sy, xRange = null, yRange = null, count = 1) => {
    const p = director.placeObstacle({ waveId: wave.id, x, y, z, s, sy, xRange, yRange, count, fixed: !xRange, ship: shipCtx(), speed: world.speed });
    world.entities.push({
      type: 'crystal', x: p.x, y: p.y, z: p.z, rx: 1.9 * p.s, ry: 1.1 * p.s * p.sy,
      passed: false, waveId: wave.id, features: p.features, side: p.side,
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
    director.onEvent({ type: 'obstacle_pass', waveId: e.waveId, features: e.features, side: e.side, outcome, theme });
    if (outcome !== 'ignored') { passes++; if (outcome === 'hit') hits++; if (outcome === 'nearMiss') nearMisses++; }
    if (e.waveId !== null && outcome !== 'ignored') waveStats.set(e.waveId, (waveStats.get(e.waveId) || false) || outcome === 'hit');
  };

  while (st.shield > 0 && st.runTime < MAX_RUN) {
    world.time += DT;
    st.runTime += DT;
    if (st.runTime >= nextRegion) {
      theme = THEMES[director.pickStormTheme(THEMES)];
      nextRegion = st.runTime + director.regionInterval();
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
          report(e.passed ? { ...e, waveId: null } : e, 'hit');
          st.shield -= 34; st.invuln = 1.2;
          world.entities.splice(i, 1);
          continue;
        }
        if (!e.passed && zOld < 0 && e.z >= 0) {
          e.passed = true;
          report(e, d2 < 1 ? 'ignored' : d2 < 2.25 ? 'nearMiss' : 'clean');
        }
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
    if (director.confidence > 0) { riskSum += director.model.director.targetRisk * DT; riskTime += DT; }
  }

  const duration = st.runTime;
  const cause = st.shield > 0 ? 'cap' : 'shield';
  director.onEvent({ type: 'run_end', duration, score: 0, cause });
  director.save();
  const m = director.model.director;
  return {
    duration, cause, hits, passes, nearMisses, waves,
    waveHits: [...waveStats.values()].filter(Boolean).length, wavesFaced: waveStats.size,
    targetRisk: riskTime ? riskSum / riskTime : null,
    speedMul: director.speedMultiplier(), rawSpeedMul: m.speedMul, gapMul: m.gapMul,
    skill: m.skill, targetTension: m.targetTension, confidence: director.confidence,
  };
}

// ---------- Experiment ----------
// One bot plays RUNS runs. When it rage-quits, the session ends and the next run starts a
// new session whose director reloads the saved model (exercises cross-session learning).
function runBot(skill, seed) {
  const rng = seeded(seed);
  const storage = createStorage({ defaults: defaultModel, backend: memoryBackend() });
  const newDirector = (s) => createDirector({ storage, rng: seeded(seed + 1000 + s), recorder: createRecorder() });
  let sessions = 1;
  let director = newDirector(sessions);
  const bot = createBot(skill, seeded(seed + 2000));
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
const f = (v, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));
// Hit rate = share of obstacle-carrying waves that hit the player (targetRisk is per wave).
const waveHitRate = (rs) => rs.reduce((s, r) => s + r.waveHits, 0) / Math.max(1, rs.reduce((s, r) => s + r.wavesFaced, 0));
const obstacleHitRate = (rs) => rs.reduce((s, r) => s + r.hits, 0) / Math.max(1, rs.reduce((s, r) => s + r.passes, 0));

const results = [];
const started = Date.now();
const SEED = Number(process.env.SIM_SEED || 0); // vary to check robustness
for (const [skill, seed] of [[0.2, 11], [0.5, 22], [0.9, 33]]) {
  const { runs, sessions } = runBot(skill, seed + SEED);
  const tail = runs.slice(-20);
  const head10 = runs.slice(0, 10), tail10 = runs.slice(-10);
  const last = runs[runs.length - 1];
  const res = {
    skill, sessions,
    hitRateAll: waveHitRate(runs),
    hitRateLast20: waveHitRate(tail),
    obstacleHitRateLast20: obstacleHitRate(tail),
    targetRiskLast20: mean(tail.map((r) => r.targetRisk ?? 0)),
    lenFirst10: mean(head10.map((r) => r.duration)),
    lenLast10: mean(tail10.map((r) => r.duration)),
    lenAll: mean(runs.map((r) => r.duration)),
    finalSkill: last.skill,
    finalTargetTension: last.targetTension,
    finalSpeedMul: last.speedMul,
    waves: runs.reduce((acc, r) => { for (const k in r.waves) acc[k] = (acc[k] || 0) + r.waves[k]; return acc; }, {}),
  };
  results.push(res);
  console.log(`\nBot skill ${skill}  (${sessions} sessions)`);
  console.log('  run  len(s)  waveHits/waves  hits/near/passes  targetRisk  speed×  gap×  skill  targetTension  conf');
  runs.forEach((r, i) => {
    if (i < 5 || i % 5 === 4) {
      console.log(`  ${String(i + 1).padStart(3)}  ${f(r.duration, 0).padStart(6)}${r.quit ? 'q' : ' '} ${`${r.waveHits}/${r.wavesFaced}`.padStart(14)}  ${`${r.hits}/${r.nearMisses}/${r.passes}`.padStart(16)}  ${f(r.targetRisk).padStart(10)}  ${f(r.speedMul).padStart(6)}  ${f(r.gapMul).padStart(4)}  ${f(r.skill).padStart(5)}  ${f(r.targetTension).padStart(13)}  ${f(r.confidence)}`);
    }
  });
}

console.log('\nSUMMARY (last 20 runs unless noted)');
console.log('  bot  waveHitRate  obstacleHitRate  targetRisk  meanLen(all)  len first10→last10  skill  targetTension  speed×  waves(all)');
for (const r of results) {
  console.log(`  ${r.skill.toFixed(1)}  ${f(r.hitRateLast20).padStart(11)}  ${f(r.obstacleHitRateLast20).padStart(15)}  ${f(r.targetRiskLast20).padStart(10)}  ${f(r.lenAll, 0).padStart(12)}  ${`${f(r.lenFirst10, 0)} → ${f(r.lenLast10, 0)}`.padStart(18)}  ${f(r.finalSkill).padStart(5)}  ${f(r.finalTargetTension).padStart(13)}  ${f(r.finalSpeedMul).padStart(6)}  ${JSON.stringify(r.waves)}`);
}

// Acceptance. "Target band" = the targetRisk clamp [0.05, 0.45]; the stricter tracking of the
// director's current targetRisk is reported alongside for information.
const BAND = [0.05, 0.45];
const checks = [];
for (const r of results) {
  checks.push([`bot ${r.skill}: wave hit rate ${f(r.hitRateLast20)} within ±0.08 of target band [${BAND}]`,
    r.hitRateLast20 >= BAND[0] - 0.08 && r.hitRateLast20 <= BAND[1] + 0.08]);
}
const weak = results[0], strong = results[2];
checks.push([`weak bot runs get longer (${f(weak.lenFirst10, 0)}s → ${f(weak.lenLast10, 0)}s)`, weak.lenLast10 > weak.lenFirst10]);
checks.push([`strong bot speed multiplier above 1 (${f(strong.finalSpeedMul)})`, strong.finalSpeedMul > 1]);
console.log('\nACCEPTANCE');
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
console.log('\nINFO: tracking of the current targetRisk (|waveHitRate − targetRisk| ≤ 0.08)');
for (const r of results) {
  const gap = Math.abs(r.hitRateLast20 - r.targetRiskLast20);
  console.log(`  ${gap <= 0.08 ? 'ok  ' : 'off '}  bot ${r.skill}: ${f(r.hitRateLast20)} vs ${f(r.targetRiskLast20)}`);
}
console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
