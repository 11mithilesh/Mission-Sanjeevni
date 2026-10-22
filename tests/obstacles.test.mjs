import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyObstaclePass, classifyShaktiClear, SHAKTI_IMMINENT } from '../personalization/obstacles.js';

// Frames of one storm (rx = 2, so the radius is behind the ship once zc >= 2.8).
const approach = { zc: -5, rx: 2 };
const crossing = { zc: 0, rx: 2 };
const behind = (zc) => ({ zc, rx: 2 });

test('a pass is reported once, only after the collision radius is behind the ship', () => {
  const e = {};
  assert.equal(classifyObstaclePass(e, { ...approach, d2: 9, invuln: 0 }), null);
  assert.equal(classifyObstaclePass(e, { ...crossing, d2: 1.5, invuln: 0 }), null);
  assert.equal(classifyObstaclePass(e, { ...behind(2.79), d2: 4, invuln: 0 }), null);
  assert.equal(classifyObstaclePass(e, { ...behind(2.8), d2: 9, invuln: 0 }), 'nearMiss');
  assert.equal(classifyObstaclePass(e, { ...behind(5), d2: 9, invuln: 0 }), null, 'never twice');
});

test('the outcome uses the crossing frame, not the report frame', () => {
  // Close at the crossing, then the ship moves away: still a near miss.
  const near = {};
  classifyObstaclePass(near, { ...crossing, d2: 2.2, invuln: 0 });
  assert.equal(classifyObstaclePass(near, { ...behind(3), d2: 20, invuln: 0 }), 'nearMiss');
  // Clear at the crossing, then the ship drifts toward the storm: still clean. The old rule
  // judged the report frame, whose d2 = lateral² + dzn² made this read as a near miss.
  const clean = {};
  classifyObstaclePass(clean, { ...crossing, d2: 2.25, invuln: 0 });
  assert.equal(classifyObstaclePass(clean, { ...behind(2.8), d2: 1.1, invuln: 0 }), 'clean');
});

test('passing through a storm while invulnerable is ignored, even if invulnerability ends before the report', () => {
  const e = {};
  classifyObstaclePass(e, { ...crossing, d2: 0.3, invuln: 0.4 });
  assert.equal(e.crossInvuln, true);
  assert.equal(classifyObstaclePass(e, { ...behind(3), d2: 1.3, invuln: 0 }), 'ignored');
});

test('invulnerability does not change a near miss or clean pass', () => {
  const e = {};
  classifyObstaclePass(e, { ...crossing, d2: 1.8, invuln: 1 });
  assert.equal(classifyObstaclePass(e, { ...behind(3), d2: 5, invuln: 1 }), 'nearMiss');
});

test('an already classified storm cannot be labelled again', () => {
  assert.equal(classifyObstaclePass({ passed: true, crossD2: 0.5 }, { ...behind(5), d2: 0.5, invuln: 0 }), null);
});

test('Shakti clears: imminent and overlapping is a threat, anything else is far', () => {
  const ship = { x: 0, y: 4 };
  const storm = { x: 0.5, y: 4.2, rx: 1.9, ry: 2 };
  // 60 u/s: 30 units ahead arrives in 0.5 s.
  assert.equal(classifyShaktiClear({ ...storm, z: -30 }, ship, 60), 'cleared_threat');
  assert.equal(classifyShaktiClear({ ...storm, z: -90 }, ship, 60), 'cleared_far', 'arrives in 1.5 s');
  assert.equal(classifyShaktiClear({ ...storm, x: 4, z: -30 }, ship, 60), 'cleared_far', 'off the ship line');
  assert.equal(classifyShaktiClear({ ...storm, z: -60 }, ship, 60), 'cleared_threat', 'exactly SHAKTI_IMMINENT');
  assert.equal(SHAKTI_IMMINENT, 1);
});
