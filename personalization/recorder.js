/* =========================================================
   Event recorder — a capped in-memory ring buffer of gameplay
   events for this session only. Raw logs never leave memory;
   only per-run summaries may be persisted (IndexedDB, optional).
   ========================================================= */

export const EVENT_TYPES = [
  'run_start', 'run_end', 'wave_spawn', 'obstacle_pass', 'fruit', 'gate',
  'shakti_used', 'boost', 'ship_sample',
];

export function createRecorder({ capacity = 2000, persistSummaries = false } = {}) {
  const buffer = new Array(capacity);
  let head = 0;
  let size = 0;
  const summaryStore = persistSummaries ? openSummaryStore() : null;

  return {
    push(event) {
      buffer[head] = event;
      head = (head + 1) % capacity;
      if (size < capacity) size++;
    },
    // Most recent `n` events, oldest first (optionally filtered by type).
    recent(n = size, type = null) {
      const out = [];
      for (let i = 0; i < size && out.length < n; i++) {
        const e = buffer[(head - 1 - i + capacity) % capacity];
        if (!type || e.type === type) out.push(e);
      }
      return out.reverse();
    },
    get size() { return size; },
    clear() { head = 0; size = 0; buffer.fill(undefined); },
    saveSummary(summary) { summaryStore?.add(summary); },
    clearSummaries() { summaryStore?.clear(); },
  };
}

// Tiny optional IndexedDB store of run summaries (capped). Silently does nothing
// when IndexedDB is missing or blocked (Node, private mode, file://).
function openSummaryStore(cap = 200) {
  let dbPromise = null;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const request = globalThis.indexedDB.open('mission-sanjeevni', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('runs', { autoIncrement: true });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  };
  const withStore = (fn) => open().then((db) => {
    if (!db) return;
    try { fn(db.transaction('runs', 'readwrite').objectStore('runs')); } catch { /* ignore */ }
  });
  return {
    add(summary) {
      withStore((store) => {
        store.add(summary);
        const countReq = store.count();
        countReq.onsuccess = () => {
          let extra = countReq.result - cap;
          if (extra <= 0) return;
          store.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor && extra-- > 0) { cursor.delete(); cursor.continue(); }
          };
        };
      });
    },
    clear() { withStore((store) => store.clear()); },
  };
}
