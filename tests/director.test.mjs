import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirector, defaultModel, LIMITS, CLASSIC } from '../personalization/director.js';
import { createStorage } from '../personalization/storage.js';
import { createRecorder } from '../personalization/recorder.js';
import { seeded, memoryBackend } from './helpers.mjs';

const ship = { x: 0, y: 4, vx: 0, vy: 0 };

function makeDirector({ rng = seeded(1), model = null } = {}) {
  const backend = memoryBackend();
  const storage = createStorage({ defaults: defaultModel, backend });
  if (model) storage.save(model);
  return createDirector({ storage, rng, recorder: createRecorder() });
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
      for (const key of ['speedMul', 'targetRisk', 'gapMul']) {
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
  trained.director.targetRisk = 0.12;
  const director = makeDirector({ model: trained });
  director.onEvent({ type: 'run_start' });
  director.onEvent({ type: 'obstacle_pass', outcome: 'nearMiss', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  const afterNearMiss = director.tension;
  assert.ok(afterNearMiss > 0);
  assert.equal(director.brake, 0);

  director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  assert.equal(director.tension, afterNearMiss, 'a hit adds no tension');
  assert.ok(director.brake > 0);
  const [lo] = LIMITS.targetRisk;
  assert.ok(Math.abs(director.model.director.targetRisk - (lo + (0.12 - lo) / 2)) < 1e-12, 'hit cuts the risk budget');

  // While braked the controller only eases, even though near-miss tension is below target.
  const before = { ...director.model.director };
  for (let i = 0; i < 60; i++) director.tick(1 / 30, { playing: true, ship, target: { x: 0, y: 4 }, boost: false });
  assert.ok(director.model.director.speedMul < before.speedMul);
  assert.ok(director.model.director.targetRisk < before.targetRisk);
  assert.ok(director.model.director.gapMul > before.gapMul);

  const firstBrake = director.brake;
  director.onEvent({ type: 'obstacle_pass', outcome: 'hit', features: [1, 0.1, 0.1, 0, 0.2, 1, 0, 0.1] });
  assert.ok(director.brake - firstBrake > 1.5, 'second hit of the run brakes harder');
});

test('saved models from older limits are clamped on load', () => {
  const old = defaultModel();
  old.director.targetRisk = 0.45;
  const director = makeDirector({ model: old });
  assert.equal(director.model.director.targetRisk, LIMITS.targetRisk[1]);
});

test('about 10% of decisions stay classic at full confidence', () => {
  const trained = defaultModel();
  trained.profile.observations = 10000;
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
