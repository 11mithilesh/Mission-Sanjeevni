/* =========================================================
   Reach model — where will the ship be `t` seconds from now,
   and how far can the player comfortably move?
   Short horizons extrapolate current velocity (damped); long
   horizons drift toward the player's preferred lane.
   ========================================================= */

import { BOUNDS, preferredPosition } from '../profile.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const VELOCITY_TAU = 0.45; // s — how long current momentum carries
const SETTLE_TAU = 2.0;    // s — how quickly the player returns to a habitual lane

export function predictShip(profile, ship, t) {
  const carry = VELOCITY_TAU * (1 - Math.exp(-t / VELOCITY_TAU));
  const home = preferredPosition(profile);
  const settle = 1 - Math.exp(-t / SETTLE_TAU);
  const x = ship.x + ship.vx * carry;
  const y = ship.y + ship.vy * carry;
  return {
    x: clamp(x + (home.x - x) * settle, -BOUNDS.x, BOUNDS.x),
    y: clamp(y + (home.y - y) * settle, BOUNDS.yMin, BOUNDS.yMax),
  };
}

// Distance the player can comfortably cover within `t` seconds after reacting.
export function reachableDistance(profile, t) {
  return profile.reach * Math.max(0, t - profile.reaction);
}

// Heuristic P(fail to reach a target `distance` away with `t` seconds warning),
// used to size and position wall gaps.
export function missProbability(profile, distance, t, halfWidth) {
  const slack = reachableDistance(profile, t) - Math.max(0, distance - halfWidth);
  return 1 / (1 + Math.exp(slack / Math.max(0.6, profile.reach * 0.25)));
}
