// Separate best scores for Adaptive (personalised) and Classic play.
export const MODES = ['adaptive', 'classic'];
export const BEST_SCORE_KEYS = {
  adaptive: 'mission-sanjeevni-best-adaptive',
  classic: 'mission-sanjeevni-best-classic',
};
// Older single best scores, newest first. They were not tagged with a mode, so the first one
// found seeds BOTH modes once (nobody loses a record) and is then removed.
export const SHARED_BEST_SCORE_KEY = 'mission-sanjeevni-best';
export const LEGACY_BEST_SCORE_KEY = 'neon-drift-best';

function defaultBackend() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

const parse = (raw) => parseInt(raw || '0', 10) || 0;

export function createBestScoreStore({
  backend = defaultBackend(), keys = BEST_SCORE_KEYS,
  oldKeys = [SHARED_BEST_SCORE_KEY, LEGACY_BEST_SCORE_KEY],
} = {}) {
  let migrated = false;

  function migrate() {
    if (migrated) return;
    migrated = true;
    try {
      const old = oldKeys.map((k) => backend?.getItem(k)).find((v) => v !== null && v !== undefined);
      if (old === undefined) return;
      for (const mode of MODES) {
        const current = backend?.getItem(keys[mode]);
        if (current === null || current === undefined) backend?.setItem(keys[mode], String(parse(old)));
      }
      for (const k of oldKeys) backend?.removeItem(k);
    } catch { /* storage unavailable */ }
  }

  return {
    get(mode) {
      migrate();
      try { return parse(backend?.getItem(keys[mode])); } catch { return 0; }
    },
    set(mode, value) {
      migrate();
      try { backend?.setItem(keys[mode], String(value)); } catch { /* storage unavailable */ }
    },
  };
}
