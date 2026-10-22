/* =========================================================
   Debug overlay — optional on-screen panel showing what the
   director is doing. Toggle with the backtick key or ?debug=1.
   DOM only; refreshes ~4×/s so it costs nothing per frame.
   ========================================================= */

import { ARMS, banditMean } from './models/bandit.js';
import { FEATURE_NAMES } from './models/risk.js';

const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v));

export function createDebugOverlay(director, { visible = false } = {}) {
  const panel = document.createElement('pre');
  panel.id = 'debug-overlay';
  panel.setAttribute('aria-hidden', 'true');
  panel.hidden = !visible;
  document.body.appendChild(panel);
  let timer = 0;

  function render() {
    const m = director.model;
    const d = m.director;
    const lines = [
      `DIRECTOR ${m.classic ? '(classic mode)' : ''}`,
      `confidence     ${fmt(director.confidence)}   obs ${m.profile.observations}   runs ${m.profile.runs}`,
      `tension        ${fmt(director.tension)} / target ${fmt(d.targetTension)}   felt ${fmt(director.felt)}`,
      `brake          ${fmt(director.brake)}   riskMul ${fmt(d.riskMul)} (× classic storm risk)`,
      `speed× ${fmt(director.speedMultiplier())} (raw ${fmt(d.speedMul)})  gap× ${fmt(director.spawnGapMultiplier())} (raw ${fmt(d.gapMul)})`,
      `skill ${fmt(d.skill)}  follow ${fmt(director.steeringFollow(), 1)}  reach ${fmt(m.profile.reach, 1)}  react ${fmt(m.profile.reaction)}s`,
      `hitRate ${fmt(m.profile.recentHitRate)}  weak L/R ${fmt(m.profile.hitLeft)}/${fmt(m.profile.hitRight)}`,
      '',
      'BANDIT  P(hit)  a / b',
      ...ARMS.map((arm) => {
        const p = m.bandit[arm];
        return `  ${arm.padEnd(8)} ${fmt(banditMean(p))}  ${fmt(p.a, 1)} / ${fmt(p.b, 1)}`;
      }),
      '',
      'LAST PLACEMENTS  kind  x  y  risk→target',
      ...director.decisions.slice().reverse().map((e) =>
        `  ${e.personal ? '*' : ' '}${String(e.kind).padEnd(10)} ${fmt(e.x, 1)} ${fmt(e.y, 1)}  ${fmt(e.risk)}→${fmt(e.target)}`),
      '',
      `RISK WEIGHTS (n=${m.risk.n})`,
      ...FEATURE_NAMES.map((name, i) => `  ${name.padEnd(9)} ${fmt(m.risk.w[i])}`),
    ];
    panel.textContent = lines.join('\n');
  }

  return {
    toggle() { panel.hidden = !panel.hidden; if (!panel.hidden) render(); },
    update(dt) {
      if (panel.hidden) return;
      timer += dt;
      if (timer < 0.25) return;
      timer = 0;
      render();
    },
  };
}
