import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyObstaclePass } from '../personalization/obstacles.js';

test('obstacle pass is classified only after the collision radius is behind the ship', () => {
  assert.equal(classifyObstaclePass({ zc: 2.79, rx: 2, d2: 1.5, passed: false }), null);
  assert.equal(classifyObstaclePass({ zc: 2.8, rx: 2, d2: 1.5, passed: false }), 'nearMiss');
  assert.equal(classifyObstaclePass({ zc: 3, rx: 2, d2: 2.25, passed: false }), 'clean');
});

test('an already classified obstacle cannot be labelled a second time', () => {
  assert.equal(classifyObstaclePass({ zc: 5, rx: 2, d2: 0.5, passed: true }), null);
});
