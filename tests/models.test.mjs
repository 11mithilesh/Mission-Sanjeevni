import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultRisk, predictRisk, updateRisk, riskFeatures, WEIGHT_LIMIT,
} from '../personalization/models/risk.js';
import {
  defaultBandit, chooseArm, tiltedMix, updateBandit, sampleBeta, MAX_EVIDENCE,
} from '../personalization/models/bandit.js';
import { createRecorder } from '../personalization/recorder.js';
import { seeded } from './helpers.mjs';

test('logistic regression learns a synthetic separable rule', () => {
  const rng = seeded(7);
  const model = { w: new Array(8).fill(0), n: 0 };
  // Rule: hit iff the obstacle is closer than 2.5 units horizontally to the predicted ship.
  const sample = () => {
    const dx = (rng() - 0.5) * 18;
    const x = riskFeatures({ dx, dy: (rng() - 0.5) * 6, weakSide: 0, speed: 26 + rng() * 90, size: 1, approach: 0, recentHitRate: 0.15 });
    return { x, y: Math.abs(dx) < 2.5 ? 1 : 0 };
  };
  for (let epoch = 0; epoch < 20000; epoch++) {
    const { x, y } = sample();
    updateRisk(model, x, y);
  }
  let correct = 0;
  for (let i = 0; i < 2000; i++) {
    const { x, y } = sample();
    if ((predictRisk(model, x) > 0.5 ? 1 : 0) === y) correct++;
  }
  assert.ok(correct / 2000 > 0.95, `accuracy ${correct / 2000}`);
  assert.ok(model.w.every((w) => Math.abs(w) <= WEIGHT_LIMIT));
});

test('risk weights stay clamped under extreme inputs', () => {
  const model = defaultRisk();
  for (let i = 0; i < 5000; i++) updateRisk(model, [1, 50, 50, 1, 50, 50, 50, 1], i % 2);
  assert.ok(model.w.every((w) => Math.abs(w) <= WEIGHT_LIMIT));
});

test('tilted wave mix: unchanged at the baseline rate, hits the target otherwise', () => {
  const bandit = defaultBandit();
  const truth = { wall: 0.6, scatter: 0.2, snake: 0.05, gate: 0.02 };
  for (const [arm, p] of Object.entries(truth)) { bandit[arm].a = p * 50; bandit[arm].b = (1 - p) * 50; }
  const base = { wall: 0.25, scatter: 0.25, snake: 0.28, gate: 0.22 };
  const baseRate = Object.entries(base).reduce((s, [arm, w]) => s + w * truth[arm], 0);

  const same = tiltedMix(bandit, base, baseRate);
  for (const arm of Object.keys(base)) assert.ok(Math.abs(same[arm] - base[arm]) < 1e-6, arm);

  for (const k of [0.7, 1.5]) {
    const mix = tiltedMix(bandit, base, baseRate * k);
    const rate = Object.entries(mix).reduce((s, [arm, w]) => s + w * truth[arm], 0);
    assert.ok(Math.abs(rate - baseRate * k) < 1e-6, `×${k}: ${rate} vs ${baseRate * k}`);
    for (const arm of Object.keys(base)) assert.ok(mix[arm] > 0.01, `${arm} keeps a share`);
  }
});

test('bandit draws follow the tilted mix and evidence stays bounded', () => {
  const rng = seeded(11);
  const bandit = defaultBandit();
  const truth = { wall: 0.6, scatter: 0.2, snake: 0.05, gate: 0.02 };
  const base = { wall: 0.25, scatter: 0.25, snake: 0.28, gate: 0.22 };
  const counts = { wall: 0, scatter: 0, snake: 0, gate: 0 };
  for (let i = 0; i < 3000; i++) {
    const arm = chooseArm(bandit, base, 0.1, undefined, rng); // well below the base rate
    if (i >= 2000) counts[arm]++;
    updateBandit(bandit, arm, rng() < truth[arm]);
  }
  assert.ok(counts.wall < 0.25 * 1000 && counts.snake > 0.28 * 1000, JSON.stringify(counts));
  for (const p of Object.values(bandit)) assert.ok(p.a + p.b <= MAX_EVIDENCE + 1e-9);
});

test('Beta sampler has the right mean', () => {
  const rng = seeded(3);
  let sum = 0;
  for (let i = 0; i < 20000; i++) sum += sampleBeta(2, 6, rng);
  assert.ok(Math.abs(sum / 20000 - 0.25) < 0.01);
});

test('recorder keeps only the most recent events', () => {
  const rec = createRecorder({ capacity: 5 });
  for (let i = 0; i < 12; i++) rec.push({ type: i % 2 ? 'fruit' : 'boost', i });
  assert.equal(rec.size, 5);
  assert.deepEqual(rec.recent().map((e) => e.i), [7, 8, 9, 10, 11]);
  assert.deepEqual(rec.recent(2, 'fruit').map((e) => e.i), [9, 11]);
  rec.clear();
  assert.equal(rec.size, 0);
});
