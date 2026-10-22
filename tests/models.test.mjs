import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultRisk, predictRisk, updateRisk, riskFeatures, WEIGHT_LIMIT,
} from '../personalization/models/risk.js';
import { defaultBandit, chooseArm, updateBandit, sampleBeta, MAX_EVIDENCE } from '../personalization/models/bandit.js';
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

test('bandit converges toward the arm whose hit rate is nearest the target', () => {
  const rng = seeded(11);
  const bandit = defaultBandit();
  const truth = { wall: 0.6, scatter: 0.2, snake: 0.05, gate: 0.4 };
  const counts = { wall: 0, scatter: 0, snake: 0, gate: 0 };
  for (let i = 0; i < 1500; i++) {
    const arm = chooseArm(bandit, 0.2, undefined, rng);
    if (i >= 1000) counts[arm]++;
    updateBandit(bandit, arm, rng() < truth[arm]);
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(best, 'scatter');
  assert.ok(counts.scatter / 500 > 0.5, JSON.stringify(counts));
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
