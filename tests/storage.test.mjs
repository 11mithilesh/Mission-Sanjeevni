import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, migrate, STORAGE_KEY, MAX_BYTES } from '../personalization/storage.js';
import { defaultModel } from '../personalization/director.js';
import { memoryBackend, throwingBackend } from './helpers.mjs';

test('round-trip: saved model loads back identically', () => {
  const backend = memoryBackend();
  const storage = createStorage({ defaults: defaultModel, backend });
  const { model, fresh } = storage.load();
  assert.equal(fresh, true);
  model.director.targetTension = 0.42;
  model.profile.heat[3] = 0.5;
  model.profile.themes['storm_void.glb'] = 0.1;
  model.risk.w[1] = -3.3;
  assert.equal(storage.save(model), true);
  assert.ok(backend.data.has(STORAGE_KEY));
  const again = storage.load();
  assert.equal(again.fresh, false);
  assert.deepEqual(again.model, model);
});

test('saved model stays well under the size budget', () => {
  const backend = memoryBackend();
  const storage = createStorage({ defaults: defaultModel, backend });
  storage.save(defaultModel());
  assert.ok(backend.data.get(STORAGE_KEY).length < MAX_BYTES / 4);
});

test('missing or corrupted fields are filled from defaults', () => {
  const backend = memoryBackend();
  backend.setItem(STORAGE_KEY, JSON.stringify({ version: 1, director: { targetTension: 'oops' }, risk: { w: [1, 2] } }));
  const { model, fresh } = createStorage({ defaults: defaultModel, backend }).load();
  assert.equal(fresh, false);
  assert.equal(model.director.targetTension, 0.35);
  assert.deepEqual(model.risk.w, defaultModel().risk.w);
  assert.equal(model.profile.heat.length, 15);
});

test('migration hook upgrades older versions, unknown versions start fresh', () => {
  const defaults = () => ({ version: 2, a: 1, b: 'new' });
  const migrations = { 1: (m) => ({ ...m, version: 2, b: `from-${m.old}` }) };
  const upgraded = migrate({ version: 1, a: 5, old: 'x' }, defaults(), { version: 2, migrations });
  assert.deepEqual(upgraded, { version: 2, a: 5, b: 'from-x' });
  assert.equal(migrate({ version: 0, a: 5 }, defaults(), { version: 2, migrations }), null);
  assert.equal(migrate({ version: 3, a: 5 }, defaults(), { version: 2, migrations }), null);
  assert.equal(migrate('garbage', defaults(), { version: 2, migrations }), null);
});

test('corrupt JSON and throwing storage never break loading or saving', () => {
  const backend = memoryBackend();
  backend.setItem(STORAGE_KEY, '{not json');
  assert.equal(createStorage({ defaults: defaultModel, backend }).load().fresh, true);
  const blocked = createStorage({ defaults: defaultModel, backend: throwingBackend });
  assert.equal(blocked.load().fresh, true);
  assert.equal(blocked.save(defaultModel()), false);
  assert.doesNotThrow(() => blocked.reset());
  const none = createStorage({ defaults: defaultModel, backend: null });
  assert.equal(none.load().fresh, true);
});

test('reset wipes the stored model', () => {
  const backend = memoryBackend();
  const storage = createStorage({ defaults: defaultModel, backend });
  storage.save(defaultModel());
  storage.reset();
  assert.equal(backend.data.size, 0);
  assert.equal(storage.load().fresh, true);
});
