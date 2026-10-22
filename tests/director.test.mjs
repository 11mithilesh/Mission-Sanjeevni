import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirector, defaultModel, LIMITS, CLASSIC, RING } from '../personalization/director.js';
import { createStorage } from '../personalization/storage.js';
import { createRecorder } from '../personalization/recorder.js';
import { isStruggling, createProfileTracker, shaktiStyle } from '../personalization/profile.js';
import { seeded, memoryBackend } from './helpers.mjs';

const ship = { x: 0, y: 4, vx: 0, vy: 0 };

function makeDirector({ rng = seeded(1), model = null } = {}) {
  const backend = memoryBackend();
  const storage = createStorage({ defaults: defaultModel, backend });
  if (model) storage.save(model);
  // Every game personalised (rule 2 off), so these tests exercise personalisation.
  return createDirector({ storage, rng, recorder: createRecorder(), personalBlock: 1 });
}

// Today's spawnWave() selection, copied verbatim from the original main.js.
function classicArm(runTime, d, r) {
  if (runTime > 12 && r < 0.18 + d * 0.1) return 'wall';
  if (r < 0.5) return 'scatter';
  if (r < 0.78) return 'snake';
  return 'gate';
}

test('cold start: every output equals the hand-tuned game', () => {
  const rng = seeded(42);
  const reference = seeded(42); // must stay in lock-step: no extra random draws
  const director = makeDirector({ rng });
  assert.equal(director.fresh, true);
  director.onEvent({ type: 'run_start' });
  assert.equal(director.confidence, 0);

  for (const t of [0, 10, 75, 150, 400]) {
    assert.equal(director.personalRamp(t), Math.min(1, t / 150));
  }
  assert.equal(director.speedMultiplier(), 1);
  assert.equal(director.spawnGapMultiplier(), 1);
  assert.equal(director.steeringFollow(), CLASSIC.follow);

  for (let i = 0; i < 200; i++) {
    const runTime = i * 1.3;
    const wave = director.chooseWave({ runTime, shield: 10, powerCharges: 0, obstacles: 12 });
    assert.equal(wave.arm, classicArm(runTime, Math.min(1, runTime / 150), reference()));
    assert.equal(wave.variant, null);

    const proposal = { waveId: wave.id, x: 3.3, y: 2.2, z: -240, s: 1.1, sy: 2, xRange: [-8.5, 8.5], yRange: [1.3, 6.8], ship, speed: 60 };
    const placed = director.placeObstacle(proposal);
    assert.deepEqual([placed.x, placed.y, placed.z, placed.s, placed.sy], [3.3, 2.2, -240, 1.1, 2]);
    assert.deepEqual(director.placeRing({ x: 1, y: 3, z: -260, xRange: [-5.5, 5.5], yRange: [2.4, 5.6], ship, speed: 60 }, 'ram'), { x: 1, y: 3 });
    assert.deepEqual(director.fruitPath({ x: -2, y: 5, xRange: [-7, 7], yRange: [2, 6] }), { x: -2, y: 5 });
    const gaps = new Set([1, 2]);
    assert.equal(director.wallGaps({ cols: [-8, -4, 0, 4, 8], gaps, ship, speed: 60, z: -230 }), gaps);
    assert.equal(director.regionInterval(), 40 + reference() * 20);
    assert.equal(director.pickStormTheme(['a', 'b', 'c', 'd']), Math.floor(reference() * 4));
  }
  assert.equal(rng(), reference(), 'director drew extra random numbers in cold start');
});

test('cold start stays classic for the whole first run even as data arrives', () => {
  const director = makeDirector();
  director.onEvent({ type: 'run_start' });
  for (let i = 0; i < 600; i++) {
    director.onEvent({ type: 'obstacle_pass', outcome: i % 5 ? 'clean' : 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.15], side: 1 });
    director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
  }
  assert.equal(director.speedMultiplier(), 1);
  assert.equal(director.personalRamp(75), 0.5);
  director.onEvent({ type: 'run_end', duration: 20, score: 100, cause: 'shield' });
  director.onEvent({ type: 'run_start' });
  assert.ok(director.confidence > 0, 'personalisation fades in on the next run');
});

test('classic mode never personalises or learns', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000;
  trained.director.speedMul = 1.3;
  trained.classic = true;
  const director = makeDirector({ model: trained });
  director.onEvent({ type: 'run_start' });
  assert.equal(director.confidence, 0);
  assert.equal(director.speedMultiplier(), 1);
  director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0, 0, 0, 0, 1, 0, 0] });
  assert.equal(director.model.risk.n, 0);
  assert.equal(director.recorder.size, 0);
});

test('tension controller outputs stay within their clamps', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000; // fully personalised
  const rng = seeded(5);
  const director = makeDirector({ model: trained, rng });
  const outcomes = ['hit', 'nearMiss', 'clean', 'clean', 'clean'];
  for (let run = 0; run < 30; run++) {
    director.onEvent({ type: 'run_start' });
    const calm = run % 3 === 0; // alternate very calm and very tense runs
    for (let i = 0; i < 3000; i++) {
      if (rng() < 0.3) {
        const outcome = calm ? 'clean' : outcomes[Math.floor(rng() * outcomes.length)];
        director.onEvent({ type: 'obstacle_pass', outcome, features: [1, rng(), rng(), 0, 0.5, 1, 0, 0.2], side: 1 });
      }
      director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
      const d = director.model.director;
      assert.ok(director.tension >= 0 && director.tension <= 1);
      for (const key of ['speedMul', 'riskMul', 'gapMul']) {
        assert.ok(d[key] >= LIMITS[key][0] - 1e-12 && d[key] <= LIMITS[key][1] + 1e-12, `${key}=${d[key]}`);
      }
      const follow = director.steeringFollow();
      assert.ok(follow >= LIMITS.follow[0] && follow <= LIMITS.follow[1]);
    }
    director.onEvent({ type: 'run_end', duration: 100, score: 0, cause: run % 4 === 0 ? 'quit' : 'shield' });
    const d = director.model.director;
    assert.ok(d.targetTension >= LIMITS.targetTension[0] && d.targetTension <= LIMITS.targetTension[1]);
    assert.ok(d.skill >= LIMITS.skill[0] && d.skill <= LIMITS.skill[1]);
    const region = director.regionInterval();
    assert.ok(region >= LIMITS.region[0] && region <= LIMITS.region[1]);
  }
});

test('hits brake instead of adding tension; near misses drive tension', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000;
  Object.assign(trained.director, { riskMul: 1.3, speedMul: 1.05, gapMul: 0.95 });
  const director = makeDirector({ model: trained });
  const tick = (seconds) => {
    for (let i = 0; i < seconds * 30; i++) director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
  };
  director.onEvent({ type: 'run_start' });
  assert.equal(director.struggling, false);
  director.onEvent({ type: 'obstacle_pass', outcome: 'nearMiss', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  const afterNearMiss = director.tension;
  assert.ok(afterNearMiss > 0);
  assert.equal(director.brake, 0);

  director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  assert.equal(director.tension, afterNearMiss, 'a hit adds no tension');
  assert.equal(director.brake, 8);
  assert.equal(director.model.director.riskMul, 1.3, 'no immediate cut; easing is the brake');

  // While braked the controller only eases, but never below Classic for a non-struggling player.
  tick(7);
  const d = director.model.director;
  assert.ok(d.riskMul < 1.3);
  assert.equal(d.speedMul, 1, 'speed eased down to Classic, not below');
  assert.equal(d.gapMul, 1, 'spacing eased up to Classic, not beyond');
  assert.ok(director.felt > d.targetTension);

  // A second hit restarts the 8 s; it does not add to it.
  director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  assert.equal(director.brake, 8);
  tick(8.1);
  assert.equal(director.brake, 0, 'released after at most 8 s');
  assert.ok(director.felt < d.targetTension, 'calm again: the controller may push harder');
});

test('only struggling players are eased below Classic speed, spacing and ramp', () => {
  for (const struggling of [false, true]) {
    const trained = defaultModel();
    trained.profile.observations = 10000;
    trained.profile.recentRuns = struggling ? [10, 12, 20, 60, 60, 60, 60, 0, 0, 0, 0, 0, 0, 0, 0] : new Array(15).fill(60);
    Object.assign(trained.director, { speedMul: 0.8, gapMul: 1.4, skill: 0.6 }); // stored while struggling
    const director = makeDirector({ model: trained });
    director.onEvent({ type: 'run_start' });
    assert.equal(director.struggling, struggling);
    for (let i = 0; i < 20; i++) {
      director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
      for (let j = 0; j < 60; j++) director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
    }
    director.onEvent({ type: 'run_end', duration: 60, score: 0, cause: 'shield' });
    const d = director.model.director;
    if (struggling) {
      assert.ok(d.speedMul < 1 && d.gapMul > 1 && d.skill < 1, JSON.stringify(d));
    } else {
      assert.ok(d.speedMul >= 1 && d.gapMul <= 1 && d.skill >= 1, JSON.stringify(d));
    }
  }
});

test('saved models from older limits are clamped on load', () => {
  const old = defaultModel();
  old.director.riskMul = 3;
  const director = makeDirector({ model: old });
  assert.equal(director.model.director.riskMul, LIMITS.riskMul[1]);
});

test('storms aim relative to the classic proposal and never below the floor', () => {
  for (const riskMul of [0.7, 1, 1.5]) {
    const trained = defaultModel();
    trained.profile.observations = 10000;
    trained.director.riskMul = riskMul;
    const director = makeDirector({ model: trained, rng: seeded(3) });
    director.onEvent({ type: 'run_start' });
    let placed = 0, classic = 0;
    for (let i = 0; i < 500; i++) {
      const px = -8 + (i % 17), py = 1.5 + (i % 5);
      const p = director.placeObstacle({ waveId: 0, x: px, y: py, z: -200, s: 1, sy: 1.8, xRange: [-8.5, 8.5], yRange: [1.3, 6.8], count: 3, ship, speed: 60 });
      assert.ok(p.risk >= LIMITS.riskMul[0] * p.classicRisk - 1e-12, `risk ${p.risk} < floor of ${p.classicRisk}`);
      placed += p.risk; classic += p.classicRisk;
    }
    // ~10% of placements stay classic (ratio 1); the rest aim at riskMul.
    const ratio = placed / classic;
    assert.ok(Math.abs(ratio - (0.9 * riskMul + 0.1)) < 0.2, `riskMul ${riskMul}: mean risk ratio ${ratio}`);
  }
});

test('walls keep the classic gap unless the controller is pushing harder', () => {
  const wall = { cols: [-8, -4, 0, 4, 8], ship: { x: 0, y: 4, vx: 0, vy: 0 }, speed: 60, z: -230 };
  for (const riskMul of [0.7, 1]) {
    const trained = defaultModel();
    trained.profile.observations = 10000;
    trained.director.riskMul = riskMul;
    const director = makeDirector({ model: trained, rng: seeded(4) });
    director.onEvent({ type: 'run_start' });
    for (let i = 0; i < 50; i++) {
      const gaps = new Set([i % 5]);
      assert.equal(director.wallGaps({ ...wall, gaps }), gaps);
    }
  }
  const trained = defaultModel();
  trained.profile.observations = 10000;
  trained.director.riskMul = 1.5;
  const director = makeDirector({ model: trained, rng: seeded(4) });
  director.onEvent({ type: 'run_start' });
  let moved = 0;
  for (let i = 0; i < 100; i++) {
    const gaps = i % 2 ? new Set([i % 5]) : new Set([i % 4, (i % 4) + 1]);
    const chosen = director.wallGaps({ ...wall, ship: { ...wall.ship, x: -8 + (i % 17) }, gaps });
    const last = director.decisions.at(-1);
    if (chosen === gaps) continue; // classic exploration share, or classic already nearest
    moved++;
    const classicRisk = last.target / 1.5;
    assert.ok(last.risk >= LIMITS.riskMul[0] * classicRisk, 'never below the floor');
    assert.ok(Math.abs(last.risk - last.target) < Math.abs(classicRisk - last.target), 'only moves to get nearer the goal');
  }
  assert.ok(moved > 0, 'pushing harder moves some gaps');
});

test('about 10% of decisions stay classic at full confidence', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000;
  trained.director.riskMul = 1.5; // so personalised placements move away from the classic spot
  const director = makeDirector({ model: trained, rng: seeded(9) });
  director.onEvent({ type: 'run_start' });
  assert.equal(director.confidence, 1);
  let classic = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const p = director.placeObstacle({ waveId: 0, x: 3.3, y: 2.2, z: -240, s: 1, sy: 1.8, xRange: [-8.5, 8.5], yRange: [1.3, 6.8], count: 3, ship, speed: 60 });
    if (p.x === 3.3 && p.y === 2.2) classic++;
  }
  assert.ok(Math.abs(classic / N - 0.1) < 0.02, `classic share ${classic / N}`);
});

test('struggling: each of the last 3 runs under 0.6 × the median run length', () => {
  const profile = defaultModel().profile;
  const withRuns = (runs) => ({ ...profile, recentRuns: [...runs, ...new Array(15 - runs.length).fill(0)] });
  assert.equal(isStruggling(withRuns([10, 10, 10, 60, 60])), false, 'too little history');
  assert.equal(isStruggling(withRuns([10, 12, 20, 60, 60, 60, 60])), true);
  assert.equal(isStruggling(withRuns([10, 40, 20, 60, 60, 60, 60])), false, 'one recent run was fine');
  assert.equal(isStruggling(withRuns(new Array(15).fill(30))), false);

  const tracker = createProfileTracker(defaultModel().profile);
  for (const d of [50, 40, 30]) tracker.update({ type: 'run_end', duration: d });
  assert.deepEqual(tracker.profile.recentRuns.slice(0, 4), [30, 40, 50, 0], 'newest first, fixed length');
  assert.equal(tracker.profile.recentRuns.length, 15);
});

function strugglingDirector(recentRuns) {
  const trained = defaultModel();
  trained.profile.observations = 10000;
  trained.profile.recentRuns = [...recentRuns, ...new Array(15 - recentRuns.length).fill(0)];
  const director = makeDirector({ model: trained });
  director.onEvent({ type: 'run_start' });
  return director;
}

test('rescue gates: only for struggling players, low shield, one per 30 s of run time', () => {
  const offers = (director, runTime, shield = 30) =>
    director.chooseWave({ runTime, shield, powerCharges: 3, obstacles: 12 }); // no Seeta refills

  const fine = strugglingDirector([60, 60, 60, 60, 60, 60, 60]);
  assert.equal(fine.struggling, false);
  for (let t = 0; t < 300; t += 5) assert.equal(offers(fine, t).offered, false);

  const weak = strugglingDirector([10, 12, 20, 60, 60, 60, 60]);
  assert.equal(weak.struggling, true);
  assert.equal(offers(weak, 20).offered, false, 'none in the first 30 s');
  assert.equal(offers(weak, 35, 80).offered, false, 'shield not low');
  const first = offers(weak, 35);
  assert.deepEqual([first.offered, first.arm, first.variant], [true, 'gate', 'ram']);
  assert.equal(offers(weak, 50).offered, false, 'cooldown');
  assert.equal(offers(weak, 66).offered, true);
});

test('Seeta refills: only at 0 charges, one in flight, ≥ 30 s apart; never in Classic', () => {
  const director = strugglingDirector([60, 60, 60, 60, 60, 60, 60]);
  const wave = (runTime, powerCharges = 0) =>
    director.chooseWave({ runTime, shield: 100, powerCharges, obstacles: 12 });
  const seeta = (w) => w.offered && w.variant === 'seeta';

  assert.equal(seeta(wave(10)), false, 'nothing in the first 30 s');
  assert.equal(seeta(wave(31, 1)), false, 'charges left');
  const first = wave(31);
  assert.ok(seeta(first) && first.arm === 'gate');
  assert.equal(director.seetaPending, true);
  assert.equal(seeta(wave(70)), false, 'one already in flight');
  director.onEvent({ type: 'gate', passed: false, variant: 'seeta', offered: true }); // missed it
  assert.equal(director.seetaPending, false);
  assert.equal(seeta(wave(60)), false, 'cooldown: 29 s since the last offer');
  assert.ok(seeta(wave(61.5)));

  // Over a long run with 0 charges every wave: at most 1 per 30 s.
  const d2 = strugglingDirector([60, 60, 60, 60, 60, 60, 60]);
  let offered = 0;
  for (let t = 0; t <= 300; t += 1.5) {
    const w = d2.chooseWave({ runTime: t, shield: 100, powerCharges: 0, obstacles: 12 });
    if (seeta(w)) { offered++; d2.onEvent({ type: 'gate', passed: true, variant: 'seeta', offered: true }); }
  }
  assert.ok(offered <= 300 / 30, `offered ${offered}`);

  const classic = makeDirector(); // cold start: confidence 0
  classic.onEvent({ type: 'run_start' });
  for (let t = 0; t < 300; t += 2) assert.equal(classic.chooseWave({ runTime: t, shield: 10, powerCharges: 0, obstacles: 12 }).offered, false);
});

test('Shakti style from clears, uses per minute and storms on screen', () => {
  const p = (over) => ({ ...defaultModel().profile, shaktiUses: 20, ...over });
  assert.equal(shaktiStyle(p({ shaktiUses: 3 })), 'unknown');
  assert.equal(shaktiStyle(p({ threatUseShare: 0.7 })), 'panic');
  assert.equal(shaktiStyle(p({ threatUseShare: 0.1, shaktiPerMin: 1.2 })), 'convenience');
  assert.equal(shaktiStyle(p({ threatUseShare: 0.1, shaktiPerMin: 0.2, shaktiThreat: 6 })), 'convenience');
  assert.equal(shaktiStyle(p({ threatUseShare: 0.1, shaktiPerMin: 0.2, shaktiThreat: 2 })), 'mixed');
  assert.equal(shaktiStyle(p({ threatUseShare: 0.35 })), 'mixed');

  // A pure panic user: every use clears one imminent threat among four far storms on screen.
  const tracker = createProfileTracker(defaultModel().profile);
  for (let i = 0; i < 20; i++) {
    tracker.update({ type: 'shakti_used', threats: 5, clears: ['cleared_threat', 'cleared_far', 'cleared_far', 'cleared_far', 'cleared_far'] });
    for (const outcome of ['cleared_threat', 'cleared_far', 'cleared_far', 'cleared_far', 'cleared_far']) tracker.update({ type: 'obstacle_clear', outcome });
  }
  assert.ok(tracker.profile.clearThreatShare < 0.3, 'mostly far clears by storm count');
  assert.equal(shaktiStyle(tracker.profile), 'panic', 'but every use was a panic use');
});

test('convenience Shakti users get rarer refills and a faster push; panic users the base rate', () => {
  const run = (over) => {
    const trained = defaultModel();
    trained.profile.observations = 10000;
    Object.assign(trained.profile, { shaktiUses: 20, shaktiPerMin: 1.5, recentRuns: new Array(15).fill(60) }, over);
    const director = makeDirector({ model: trained });
    director.onEvent({ type: 'run_start' });
    const offers = [];
    for (let t = 0; t <= 200; t += 1) {
      const w = director.chooseWave({ runTime: t, shield: 100, powerCharges: 0, obstacles: 12 });
      if (w.offered && w.variant === 'seeta') {
        offers.push(t);
        director.onEvent({ type: 'gate', passed: true, variant: 'seeta', offered: true });
      }
    }
    // Calm (no tension, no brake): measure the push on speed over 10 s.
    const before = director.model.director.speedMul;
    for (let i = 0; i < 300; i++) director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
    director.onEvent({ type: 'obstacle_pass', outcome: 'clean', features: [1, 1, 1, 0, 0, 1, 0, 0] }); // engage
    for (let i = 0; i < 300; i++) director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
    return { style: director.shaktiStyle, offers, push: director.model.director.speedMul - before };
  };
  const panic = run({ threatUseShare: 0.8 });
  const convenience = run({ threatUseShare: 0.05 });
  assert.equal(panic.style, 'panic');
  assert.equal(convenience.style, 'convenience');
  assert.deepEqual(panic.offers, [30, 60, 90, 120, 150, 180]);
  assert.deepEqual(convenience.offers, [90, 180]);
  assert.ok(convenience.push > panic.push * 1.4, `${convenience.push} vs ${panic.push}`);
});

test('Shakti clears: threats add near-miss tension and are counted; nothing labels the risk model', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000;
  const director = makeDirector({ model: trained });
  director.onEvent({ type: 'run_start' });
  const riskN = director.model.risk.n;
  director.onEvent({ type: 'shakti_used', threats: 3, waveIds: [], clears: ['cleared_far', 'cleared_far'] });
  assert.equal(director.tension, 0);
  director.onEvent({ type: 'shakti_used', threats: 2, waveIds: [], clears: ['cleared_threat', 'cleared_far'] });
  assert.ok(director.tension > 0);
  assert.deepEqual(director.runClears, { threat: 1, far: 3 });
  assert.equal(director.model.risk.n, riskN);
  assert.equal(director.model.profile.shaktiClears, 4);
  assert.equal(director.recorder.recent(10, 'obstacle_clear').length, 4);
});

test('rings never land on a ship that is not moving (any learned reach, classic share too)', () => {
  for (const reach of [0.5, 1.5, 2.5, 6]) {
    const trained = defaultModel();
    trained.profile.observations = 10000;
    trained.profile.reach = reach;
    const director = makeDirector({ model: trained, rng: seeded(21) });
    director.onEvent({ type: 'run_start' });
    const rng = seeded(5);
    for (let i = 0; i < 400; i++) {
      const parked = { x: -6 + (i % 13), y: 2 + (i % 5) * 1.2, vx: 0, vy: 0 };
      const proposal = { x: -5.5 + 11 * rng(), y: 2.4 + 3.2 * rng() };
      const ring = director.placeRing({ ...proposal, z: -260, xRange: [-5.5, 5.5], yRange: [2.4, 5.6], ship: parked, speed: 60 }, 'seeta');
      const d = Math.hypot(ring.x - parked.x, ring.y - parked.y);
      assert.ok(d >= RING.minOffset - 1e-9 && d > RING.pass, `reach ${reach}: ring ${d.toFixed(2)} from the ship`);
      assert.ok(ring.x >= -5.5 && ring.x <= 5.5 && ring.y >= 2.4 && ring.y <= 5.6);
    }
  }
});

test('personal-best governor: off below the median, full at 0.8 × best; no easing, no rings', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000;
  trained.profile.recentScores = [...new Array(10).fill(1000), ...new Array(5).fill(0)];
  trained.profile.bestScore = 2000;
  trained.profile.recentRuns = new Array(15).fill(60);
  const director = makeDirector({ model: trained });
  director.onEvent({ type: 'run_start' });
  const tick = (score, n = 1) => {
    for (let i = 0; i < n; i++) director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false, score });
  };
  tick(900);
  assert.equal(director.governor, 0, 'below the median');
  tick(1300);
  assert.ok(Math.abs(director.governor - 0.5) < 1e-9, 'halfway from median to 0.8 × best');
  tick(1700);
  assert.equal(director.governor, 1);

  // A hit would normally brake (ease); with the governor at 1 play gets harder instead.
  director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  const before = { ...director.model.director };
  const speedBefore = director.speedMultiplier();
  tick(1700, 60);
  assert.ok(director.speedMultiplier() > speedBefore, 'pushes despite the brake');
  assert.ok(director.model.director.speedMul >= before.speedMul, 'learned values never ease meanwhile');
  assert.equal(director.model.director.riskMul, before.riskMul);
  // …and offers no rescue or refill rings.
  for (let t = 30; t < 200; t += 5) {
    assert.equal(director.chooseWave({ runTime: t, shield: 10, powerCharges: 0, obstacles: 12 }).offered, false);
  }
  // The push is this run's only: the next run starts from the learned values.
  director.onEvent({ type: 'run_end', duration: 60, score: 1700, cause: 'shield' });
  director.onEvent({ type: 'run_start' });
  assert.equal(director.speedMultiplier(), director.model.director.speedMul);
  assert.equal(director.governor, 0);

  // No history yet: no governor.
  const fresh = makeDirector({ model: { ...defaultModel(), profile: { ...defaultModel().profile, observations: 10000 } } });
  fresh.onEvent({ type: 'run_start' });
  fresh.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false, score: 1e6 });
  assert.equal(fresh.governor, 0);
});

test('reset forgets everything but keeps the classic preference', () => {
  const trained = defaultModel();
  trained.profile.observations = 999;
  const director = makeDirector({ model: trained });
  assert.equal(director.fresh, false);
  director.setClassic(true);
  director.reset();
  assert.equal(director.fresh, true);
  assert.equal(director.model.profile.observations, 0);
  assert.equal(director.model.classic, true);
});
