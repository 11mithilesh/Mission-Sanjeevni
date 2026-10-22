# Mission Sanjeevni

A Three.js flying game set beneath a sunset, with a stylized flying Hanuman crossing a river through changing forest regions and natural mountain ranges. Every 40–60 seconds, the river, stones, trees, and mountain colors shift together to suggest a new region, the storm-cloud obstacle model changes randomly, and the Devanagari place names from `places.json` appear in file order over distant mountains. Collect glowing fruit to build your multiplier, fly through gates to recharge your shield and Shakti power, and dodge storm clouds.

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
```

## Tweaking

Handy knobs in `main.js`:

- `BOUNDS`: how far the ship can move
- `targetSpeed` in `frame()`: start speed and top speed
- `difficulty()`: how quickly the game ramps up (150 seconds to full difficulty)
- `UnrealBloomPass(..., strength, radius, threshold)`: glow intensity
- `FOG_COLOR` and the sky/sun shaders: the color palette

## License

MIT
