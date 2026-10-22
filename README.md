# Mission Sanjeevni

A Three.js flying game set beneath a sunset, with a stylized flying Hanuman crossing a river through changing forest regions and natural mountain ranges. Every 40–60 seconds (adapting to your typical run length as the game learns how you play), the river, stones, trees, and mountain colors shift together to suggest a new region, the storm-cloud obstacle model changes randomly for newly spawned storms (existing storms keep their model), and the Devanagari place names from `places.json` appear in file order over distant mountains. Collect glowing fruit to build your multiplier, fly through gates to recharge your shield and Shakti power, and dodge storm clouds.

No build step and no dependencies to install: it's a static site with local Hanuman and storm-cloud models, and Three.js loads from a CDN through an import map.

## Controls

| Action | Input |
| --- | --- |
| Steer | Mouse / touch, or WASD / arrow keys |
| Boost flight speed | Hold the left mouse button on the game |
| Destroy storm clouds | X, double-click the game, or press the शक्ति button (3 charges) |
| Refill Shakti charges | Fly through माँ सीता शक्ति rings (maximum 3 charges) |
| Start / restart | Click Play, or press Enter / Space |
| Pause | P or Esc |
| Mute | M or the ♪ button |

## Run locally

ES modules don't load from `file://`, so serve the folder:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open http://localhost:8000 (or the URL `serve` prints).

## Deploy for free

### GitHub Pages

1. Create a new repository on GitHub and push these files to the `main` branch (at the repo root).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then **Save**.
4. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`.

### Vercel

1. Push the files to a GitHub repo (as above).
2. On [vercel.com](https://vercel.com), click **Add New → Project** and import the repo.
3. Leave **Framework Preset** as **Other**, with no build command and the output directory left as the root.
4. Click **Deploy**. You'll get a `https://<project>.vercel.app` URL, and every push redeploys automatically.

Or from the terminal: `npx vercel` inside this folder.

## Project structure

```
index.html   page, HUD and menus, import map for Three.js
style.css    UI styling
main.js      the game: scene, shaders, GLB loading, spawning, collisions, audio
places.json  Devanagari place names shown over the distant mountains
hanuman_flying.glb   Hanuman player model
obstacle_storm_cloud.glb   initial storm-cloud obstacle model
storm_*.glb   storm-cloud variants selected when regions change
personalization/   on-device learning (pure JS, no Three.js)
  director.js        the only module the game asks for decisions; tension controller
  profile.js         exponentially-weighted play statistics
  recorder.js        in-memory event ring buffer (+ optional run summaries)
  storage.js         versioned localStorage load/save, migration, reset
  models/            risk (logistic regression), bandit (wave types), reach (ship prediction)
  debug-overlay.js   the ?debug=1 panel
tests/        Node unit tests and the bot simulation
package.json  no dependencies; only marks the JS files as ES modules for Node
```

## Personalisation & privacy

The game quietly adapts to how *you* fly. A small "director" watches your play and tunes pacing so runs stay tense but fair: easing off when you are struggling and pushing harder when you are cruising.

**What is learned**

- A play profile: reaction time, which lanes you tend to fly in (a coarse 5×3 heatmap), which side you dodge worse, how much you over-correct your steering, how far you comfortably move in a second, your recent hit rate, typical run length, boost and Shakti habits, and how you fare against each storm theme. Each statistic slowly forgets old data, so the profile follows you as you improve.
- A risk model (a tiny logistic regression) that estimates how likely a storm cloud placed at a given spot is to hit you.
- Wave preferences: how often each wave type (wall, scatter, snake, gate) hits you.
- A tension target and a ramp speed, nudged by how your runs end. For example, quitting right after a tense run lowers the target. Tension comes from near misses, not hits: with only three hits per run, a hit instead acts as a brake that eases difficulty for a while. Even when fully personalised, about 10% of placements stay classic so the models keep seeing unbiased play.

These drive the speed multiplier, the spacing between waves, how quickly difficulty ramps up, where storms, gates and fruit trails are placed, wall gap size, steering smoothness, and how long each region lasts. With no saved data, the game plays exactly like the original hand-tuned version. Personalisation fades in over your first few runs.

**Where it is stored**

Only in your browser: one `localStorage` entry, `mission-sanjeevni-player-v1` (about 1 KB of numbers). Optionally, short per-run summaries (duration, score, hits) go in an IndexedDB database called `mission-sanjeevni`, capped at 200 runs. Raw event logs stay in memory for the current session only. Nothing is ever sent anywhere: the game makes no analytics, telemetry or network requests beyond loading its own files, Three.js and Google Fonts.

**How to reset it**

Clear this site's data in your browser settings. This also clears your best score.

**How often it is used**

Storm and orb placement is personalised in every game. Everything else (speed, spacing, ramp, wave types, rings) is personalised in only one game in every 30; in the other 29 it plays like the original hand-tuned game (the game still learns from them). In a personalised game, those settings switch back to the original once your score gets near your best (a point drawn within ±10,312 of it). The game shows one best score across all games.

**Debug overlay**

Add `?debug=1` to the URL or press the backtick key (`` ` ``). The overlay shows tension, the targets, the multipliers, the wave-type statistics, the last 10 placement decisions and the risk-model weights.

## Tests

The learning code in `personalization/` is plain JavaScript with no Three.js, so it runs in Node 20+ with no dependencies:

```bash
node --test "tests/*.test.mjs"   # unit tests
node tests/sim.mjs               # bot simulation (skills 0.2 / 0.5 / 0.9, 50 runs each)
```

## Tweaking

Handy knobs in `main.js`:

- `BOUNDS`: how far the ship can move
- `targetSpeed` in `frame()`: start speed and top speed (scaled by `director.speedMultiplier()`)
- `difficulty()`: how quickly the game ramps up (150 seconds to full difficulty, scaled by the learned skill)
- `UnrealBloomPass(..., strength, radius, threshold)`: glow intensity
- `FOG_COLOR` and the sky/sun shaders: the color palette

Personalisation knobs live at the top of `personalization/director.js`: `CLASSIC` (the original constants), `LIMITS` (clamps), `CONTROL` (controller gains and rate limits), `TENSION` (near-miss tension weights), `BRAKE` (how hard a hit eases off), `CLASSIC_SHARE` (exploration) and `FADE_OBSERVATIONS` (how quickly personalisation fades in).

## License

MIT
