/* =========================================================
   Player-model storage — versioned localStorage load/save.
   Pure JS (no Three.js); the backend is injectable for tests.
   Every access is wrapped in try/catch so private mode or a
   full/blocked storage never breaks the game.
   ========================================================= */

export const STORAGE_KEY = 'mission-sanjeevni-player-v1';
export const SCHEMA_VERSION = 1;
export const MAX_BYTES = 20000;

// Migrations keyed by the version they upgrade FROM. Each returns the next version's shape.
// Add `1: (m) => ({ ...m, version: 2, newField: ... })` here when the schema changes.
export const MIGRATIONS = {};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Fill any field missing from `saved` with the default, recursively, and drop
// values whose type no longer matches (e.g. a corrupted number stored as a string).
export function mergeDefaults(defaults, saved) {
  if (!isPlainObject(defaults)) {
    if (Array.isArray(defaults)) {
      return Array.isArray(saved) && saved.length === defaults.length
        && saved.every((v, i) => typeof v === typeof defaults[i]) ? saved : defaults;
    }
    return typeof saved === typeof defaults && !(typeof saved === 'number' && !Number.isFinite(saved))
      ? saved : defaults;
  }
  const out = {};
  for (const key of Object.keys(defaults)) {
    out[key] = key in (isPlainObject(saved) ? saved : {}) ? mergeDefaults(defaults[key], saved[key]) : defaults[key];
  }
  // Open-ended maps (defaults are `{}`) keep whatever keys were saved.
  if (Object.keys(defaults).length === 0 && isPlainObject(saved)) Object.assign(out, saved);
  return out;
}

export function migrate(raw, defaults, { version = SCHEMA_VERSION, migrations = MIGRATIONS } = {}) {
  if (!isPlainObject(raw) || !Number.isInteger(raw.version)) return null;
  let model = raw;
  while (model.version < version) {
    const step = migrations[model.version];
    if (!step) return null; // no path forward: start fresh rather than guess
    model = step(model);
  }
  if (model.version !== version) return null; // saved by a newer build
  return mergeDefaults(defaults, model);
}

const defaultBackend = () => {
  try { return globalThis.localStorage || null; } catch { return null; }
};

export function createStorage({
  key = STORAGE_KEY, version = SCHEMA_VERSION, migrations = MIGRATIONS,
  defaults, backend = defaultBackend(), maxBytes = MAX_BYTES, trim = null,
} = {}) {
  return {
    // Returns { model, fresh } — fresh is true when nothing usable was stored (cold start).
    load() {
      try {
        const text = backend?.getItem(key);
        if (text) {
          const model = migrate(JSON.parse(text), defaults(), { version, migrations });
          if (model) return { model, fresh: false };
        }
      } catch { /* corrupt or unavailable: fall through to defaults */ }
      return { model: defaults(), fresh: true };
    },
    save(model) {
      try {
        let text = JSON.stringify({ ...model, version });
        // Keep the footprint small: let the caller drop optional detail if we are over budget.
        if (text.length > maxBytes && trim) text = JSON.stringify({ ...trim(model), version });
        if (text.length > maxBytes) return false;
        backend?.setItem(key, text);
        return true;
      } catch { return false; }
    },
    reset() {
      try { backend?.removeItem(key); } catch { /* storage unavailable */ }
    },
  };
}
