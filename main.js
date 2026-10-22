import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createDirector } from './personalization/director.js';
import { createDebugOverlay } from './personalization/debug-overlay.js';
import { createBestScoreStore } from './personalization/best-score.js';
import { classifyObstaclePass } from './personalization/obstacles.js';

/* =========================================================
   NEON DRIFT — a synthwave flyer in Three.js
   ========================================================= */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const ui = {
  hud: $('hud'), score: $('score'), mult: $('mult'), shield: $('shield'), bestHud: $('best-hud'),
  menu: $('menu'), over: $('over'), pause: $('pause'), start: $('start'), restart: $('restart'),
  resume: $('resume'), finalScore: $('final-score'), finalBest: $('final-best'), newBest: $('new-best'),
  bestMenu: $('best-menu'), flash: $('flash'), toast: $('toast'), mute: $('mute'),
  power: $('power'), powerFill: $('power-fill'),
};

const store = createBestScoreStore();

// ---------- Personalisation ----------
// The director learns locally how this player flies and tunes pacing; see README.
const director = createDirector();
const debugOverlay = createDebugOverlay(director, {
  visible: new URLSearchParams(location.search).get('debug') === '1',
});

// ---------- Config ----------
const BOUNDS = { x: 9, yMin: 0.9, yMax: 7.2 };
const MID_Y = (BOUNDS.yMin + BOUNDS.yMax) / 2;
const HALF_Y = (BOUNDS.yMax - BOUNDS.yMin) / 2;
const SPAWN_Z = -230;
const DESPAWN_Z = 14;
const FOG_COLOR = new THREE.Color('#31454a');
const FOG_DENSITY = 0.008;
const regionStyles = [
  {
    color: '#2c6870', highlight: '#8abdb0', pattern: [0.34, 0.55, 2.2, 0.19], strength: 1,
    mountainLow: '#132d24', mountainHigh: '#695e48', stoneCount: 42, stoneScale: 1, stoneShape: 0,
  },
  {
    color: '#126653', highlight: '#7fe2a6', pattern: [0.25, 0.92, 1.5, 0.48], strength: 0.85,
    mountainLow: '#17372b', mountainHigh: '#526744', stoneCount: 58, stoneScale: 0.78, stoneShape: 1,
  },
  {
    color: '#403265', highlight: '#c2a2ff', pattern: [0.62, 0.38, 3.4, 0.17], strength: 1.35,
    mountainLow: '#24233b', mountainHigh: '#655c80', stoneCount: 34, stoneScale: 1.3, stoneShape: 2,
  },
  {
    color: '#71502b', highlight: '#ffd17a', pattern: [0.38, 0.66, 1.9, 0.58], strength: 1.1,
    mountainLow: '#3a3024', mountainHigh: '#89724f', stoneCount: 68, stoneScale: 1.12, stoneShape: 0,
  },
];
let riverStyleIndex = 0;
let riverStyleTransition = null;
let nextRiverChange = 0;
let treeTypeMap = [0, 1, 2];
let placeNames = [];
let nextPlaceIndex = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;

// ---------- Renderer / Scene ----------
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  ui.start.textContent = 'WebGL unavailable';
  throw err;
}
const pixelRatio = Math.min(window.devicePixelRatio, 1.75);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 700);
camera.position.set(0, 4.5, 9.5);

const composer = new EffectComposer(renderer);
composer.setPixelRatio(pixelRatio);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.34, 0.38, 0.68);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- Lights ----------
scene.add(new THREE.HemisphereLight(0xd5d9cf, 0x354039, 1.35));
const rim = new THREE.DirectionalLight(0xffc18a, 1.5);
rim.position.set(-4, 8, -20);
scene.add(rim);
const key = new THREE.DirectionalLight(0xc5d2c7, 0.8);
key.position.set(5, 6, 10);
scene.add(key);

// ---------- Soft dot texture (for particles & stars) ----------
const dotTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

// ---------- Sky ----------
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(520, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color('#04010d') },
      uMid: { value: FOG_COLOR.clone() },
      uGlow: { value: new THREE.Color('#e98250') },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uMid, uGlow;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = mix(uMid, uTop, smoothstep(0.0, 0.45, h));
        col += uGlow * 0.12 * exp(-abs(h - 0.02) * 18.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
);
sky.renderOrder = -2;
scene.add(sky);

// ---------- Stars ----------
{
  const N = 1400;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(rand(0.08, 1));
    const r = 470;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi);
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    c.setHSL(rand(0.08, 0.16), rand(0.05, 0.2), rand(0.75, 0.98));
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({
    size: 2.2, sizeAttenuation: false, map: dotTexture, vertexColors: true,
    transparent: true, depthWrite: false, fog: false,
  }));
  stars.renderOrder = -1;
  scene.add(stars);
}

// ---------- Synthwave sun ----------
const sunMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  fog: false,
  uniforms: {},
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float d = length(p);
      vec3 col = mix(vec3(0.78, 0.19, 0.1), vec3(1.0, 0.72, 0.36), smoothstep(0.1, 0.95, vUv.y));
      float alpha = smoothstep(1.0, 0.97, d);
      gl_FragColor = vec4(col, alpha);
    }`,
});
const sun = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), sunMat);
sun.position.set(0, 26, -440);
scene.add(sun);

// ---------- Infinite terrain ----------
const terrainMat = new THREE.ShaderMaterial({
  uniforms: {
    uOffset: { value: 0 },
    uFog: { value: FOG_COLOR },
    uFogDensity: { value: FOG_DENSITY },
    uRiverColor: { value: new THREE.Color(regionStyles[0].color) },
    uRippleColor: { value: new THREE.Color(regionStyles[0].highlight) },
    uRipplePattern: { value: new THREE.Vector4(...regionStyles[0].pattern) },
    uRippleStrength: { value: regionStyles[0].strength },
    uMountainLow: { value: new THREE.Color(regionStyles[0].mountainLow) },
    uMountainHigh: { value: new THREE.Color(regionStyles[0].mountainHigh) },
  },
  vertexShader: /* glsl */`
    uniform float uOffset;
    varying float vH;
    varying vec2 vGrid;
    varying float vDepth;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    void main() {
      vec3 pos = position;
      vec4 world = modelMatrix * vec4(pos, 1.0);
      vec2 wp = vec2(world.x, world.z - uOffset);
      float riverCenter = sin(wp.y * 0.014) * 1.8 + sin(wp.y * 0.037) * 0.55;
      float riverDistance = abs(wp.x - riverCenter);
      float riverWidth = 5.2 + sin(wp.y * 0.021) * 0.7;
      float mountainSlope = smoothstep(5.0, 32.0, riverDistance);
      float broadRidge = fbm(wp * 0.012);
      float detail = fbm(wp * 0.038);
      float h = mountainSlope * (3.0 + 14.0 * broadRidge
        + 120.0 * pow(max(broadRidge - 0.28, 0.0), 1.25) + 6.0 * detail);
      h = mix(h, -0.32, 1.0 - smoothstep(riverWidth - 0.25, riverWidth + 0.2, riverDistance));
      pos.y += h;
      vH = h;
      vGrid = wp;
      vec4 mv = viewMatrix * modelMatrix * vec4(pos, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uFog;
    uniform float uFogDensity;
    uniform vec3 uRiverColor;
    uniform vec3 uRippleColor;
    uniform vec4 uRipplePattern;
    uniform float uRippleStrength;
    uniform vec3 uMountainLow;
    uniform vec3 uMountainHigh;
    varying float vH;
    varying vec2 vGrid;
    varying float vDepth;
    void main() {
      float riverCenter = sin(vGrid.y * 0.014) * 1.8 + sin(vGrid.y * 0.037) * 0.55;
      float riverDistance = abs(vGrid.x - riverCenter);
      float riverWidth = 5.2 + sin(vGrid.y * 0.021) * 0.7;
      float river = 1.0 - smoothstep(riverWidth - 0.35, riverWidth + 0.45, riverDistance);
      float bank = 1.0 - smoothstep(riverWidth + 0.25, riverWidth + 2.0, riverDistance);
      float height = clamp(vH / 42.0, 0.0, 1.0);
      float texture = sin(vGrid.x * 0.42 + sin(vGrid.y * 0.19) * 2.0) * 0.025;
      vec3 earth = mix(uMountainLow, uMountainHigh, height);
      earth *= 0.86 + 0.24 * sin(vGrid.x * 0.11 + vGrid.y * 0.07);
      earth += texture;
      float snowVariation = sin(vGrid.x * 0.31 + sin(vGrid.y * 0.17) * 2.0)
        * sin(vGrid.y * 0.27 - vGrid.x * 0.13);
      float snow = smoothstep(20.0 + snowVariation * 5.0, 31.0 + snowVariation * 5.0, vH);
      vec3 snowColor = vec3(0.72, 0.79, 0.76) + texture * 0.35;
      earth = mix(earth, snowColor, snow);
      vec3 water = uRiverColor;
      float ripples = sin(vGrid.y * uRipplePattern.x
        + sin(vGrid.x * uRipplePattern.y) * uRipplePattern.z);
      float crossRipples = sin(vGrid.y * uRipplePattern.w - vGrid.x * uRipplePattern.y * 1.4);
      float glints = (smoothstep(0.76, 0.98, ripples) * 0.16
        + smoothstep(0.9, 1.0, crossRipples) * 0.08) * uRippleStrength;
      water += uRippleColor * glints;
      vec3 col = mix(earth, water, river);
      float bankEdge = 1.0 - smoothstep(0.0, 0.65, abs(riverDistance - riverWidth));
      col = mix(col, vec3(0.2, 0.19, 0.13), bank * 0.32);
      col += vec3(0.09, 0.08, 0.055) * bankEdge;
      float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
      col = mix(col, uFog, clamp(fog, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }`,
});

function resetRiverStyle() {
  riverStyleIndex = 0;
  riverStyleTransition = null;
  const style = regionStyles[riverStyleIndex];
  terrainMat.uniforms.uRiverColor.value.set(style.color);
  terrainMat.uniforms.uRippleColor.value.set(style.highlight);
  terrainMat.uniforms.uRipplePattern.value.set(...style.pattern);
  terrainMat.uniforms.uRippleStrength.value = style.strength;
  terrainMat.uniforms.uMountainLow.value.set(style.mountainLow);
  terrainMat.uniforms.uMountainHigh.value.set(style.mountainHigh);
  setRegionScenery(riverStyleIndex, false);
}

function changeRiverStyle() {
  let nextIndex = Math.floor(Math.random() * (regionStyles.length - 1));
  if (nextIndex >= riverStyleIndex) nextIndex++;
  const style = regionStyles[nextIndex];
  riverStyleTransition = {
      elapsed: 0,
      duration: 2.5,
      fromColor: terrainMat.uniforms.uRiverColor.value.clone(),
      toColor: new THREE.Color(style.color),
      fromHighlight: terrainMat.uniforms.uRippleColor.value.clone(),
      toHighlight: new THREE.Color(style.highlight),
      fromPattern: terrainMat.uniforms.uRipplePattern.value.clone(),
      toPattern: new THREE.Vector4(...style.pattern),
      fromStrength: terrainMat.uniforms.uRippleStrength.value,
      toStrength: style.strength,
      fromMountainLow: terrainMat.uniforms.uMountainLow.value.clone(),
      toMountainLow: new THREE.Color(style.mountainLow),
      fromMountainHigh: terrainMat.uniforms.uMountainHigh.value.clone(),
      toMountainHigh: new THREE.Color(style.mountainHigh),
  };
  riverStyleIndex = nextIndex;
  setRegionScenery(nextIndex);
  chooseRegionStormModel();
  showPlaceName();
}

function updateRiverStyle(dt) {
  if (!riverStyleTransition) return;
  const transition = riverStyleTransition;
  transition.elapsed = Math.min(transition.elapsed + dt, transition.duration);
  const progress = THREE.MathUtils.smoothstep(transition.elapsed / transition.duration, 0, 1);
  terrainMat.uniforms.uRiverColor.value.lerpColors(transition.fromColor, transition.toColor, progress);
  terrainMat.uniforms.uRippleColor.value.lerpColors(transition.fromHighlight, transition.toHighlight, progress);
  terrainMat.uniforms.uRipplePattern.value.lerpVectors(transition.fromPattern, transition.toPattern, progress);
  terrainMat.uniforms.uRippleStrength.value = THREE.MathUtils.lerp(
      transition.fromStrength, transition.toStrength, progress,
  );
  terrainMat.uniforms.uMountainLow.value.lerpColors(
    transition.fromMountainLow, transition.toMountainLow, progress,
  );
  terrainMat.uniforms.uMountainHigh.value.lerpColors(
    transition.fromMountainHigh, transition.toMountainHigh, progress,
  );
  if (progress === 1) riverStyleTransition = null;
}

{
    const geo = new THREE.PlaneGeometry(420, 420, 240, 240);
  geo.rotateX(-Math.PI / 2);
  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.position.z = -170;
  terrain.frustumCulled = false;
  scene.add(terrain);
}

// ---------- Valley scenery ----------
function fract(value) {
  return value - Math.floor(value);
}

function terrainHash(x, y) {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(x * 0.1031);
  const dot = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += dot; py += dot; pz += dot;
  return fract((px + py) * pz);
}

function terrainNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = terrainHash(ix, iy), b = terrainHash(ix + 1, iy);
  const c = terrainHash(ix, iy + 1), d = terrainHash(ix + 1, iy + 1);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, ux), THREE.MathUtils.lerp(c, d, ux), uy);
}

function terrainFbm(x, y) {
  let value = 0, amplitude = 0.5;
  for (let octave = 0; octave < 5; octave++) {
    value += amplitude * terrainNoise(x, y);
    x *= 2.03; y *= 2.03; amplitude *= 0.5;
  }
  return value;
}

function valleyAt(z) {
  const center = Math.sin(z * 0.014) * 1.8 + Math.sin(z * 0.037) * 0.55;
  return { center, width: 5.2 + Math.sin(z * 0.021) * 0.7 };
}

function terrainHeight(x, z) {
  const { center, width } = valleyAt(z);
  const distance = Math.abs(x - center);
  const slope = THREE.MathUtils.smoothstep(distance, 5, 32);
  const broad = terrainFbm(x * 0.012, z * 0.012);
  const detail = terrainFbm(x * 0.038, z * 0.038);
  const height = slope * (3 + 14 * broad + 120 * Math.pow(Math.max(broad - 0.28, 0), 1.25) + 6 * detail);
  return THREE.MathUtils.lerp(height, -0.32, 1 - THREE.MathUtils.smoothstep(distance, width - 0.25, width + 0.2));
}

const scenery = [];
const SCENERY_SPAN = 300;
const TREE_ZONE_LENGTH = 420;
const treeZones = [Math.floor(Math.random() * 3)];
const treeTrunk = new THREE.MeshStandardMaterial({ color: 0x653d31, roughness: 0.95 });
const treeFoliage = [
  new THREE.MeshStandardMaterial({ color: 0x1e5144, roughness: 0.88, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x286552, roughness: 0.88, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x34715a, roughness: 0.88, flatShading: true }),
];
const broadleafFoliage = [
  new THREE.MeshStandardMaterial({ color: 0x356b4d, roughness: 0.9, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x487d58, roughness: 0.9, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x59885e, roughness: 0.9, flatShading: true }),
];
const treeTrunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1.3, 6);
const treeCrownGeo = new THREE.ConeGeometry(1, 1.5, 7);
const roundTreeCrownGeo = new THREE.IcosahedronGeometry(1, 1);
const snowPatchGeo = new THREE.IcosahedronGeometry(1, 1);
const treeSnow = new THREE.MeshStandardMaterial({
  color: 0xf4fbff, roughness: 0.92, flatShading: true,
});
let sceneryDistance = 0;

function treeZoneAt(z) {
  const zoneIndex = Math.floor((sceneryDistance + 10 - z) / TREE_ZONE_LENGTH);
  while (treeZones.length <= zoneIndex) {
    const previous = treeZones[treeZones.length - 1];
    const choices = [0, 1, 2].filter((type) => type !== previous);
    treeZones.push(choices[Math.floor(Math.random() * choices.length)]);
  }
  return treeTypeMap[treeZones[zoneIndex]];
}

function chooseMountainPosition(z) {
  const terrainZ = z - terrainMat.uniforms.uOffset.value;
  const { center, width } = valleyAt(terrainZ);
  const side = Math.random() < 0.5 ? -1 : 1;
  const x = center + side * (width + rand(1.5, 11));
  return { x, y: terrainHeight(x, terrainZ) };
}

function addSnowPatch(tree, x, y, z, scale) {
  const patch = new THREE.Mesh(snowPatchGeo, treeSnow);
  patch.scale.set(scale[0], scale[1], scale[2]);
  patch.position.set(x, y, z);
  patch.rotation.set(rand(-0.7, 0.7), rand(0, Math.PI * 2), rand(-0.5, 0.5));
  tree.add(patch);
}

function addPineTree(tree) {
  const trunk = new THREE.Mesh(treeTrunkGeo, treeTrunk);
  trunk.position.y = 0.65;
  tree.add(trunk);
  for (let layer = 0; layer < 3; layer++) {
    const crownWidth = 0.82 - layer * 0.16;
    const crownHeight = 1.15 - layer * 0.12;
    const crownY = 1.15 + layer * 0.72;
    const crown = new THREE.Mesh(treeCrownGeo, treeFoliage[Math.floor(Math.random() * treeFoliage.length)]);
    crown.scale.set(crownWidth, crownHeight, crownWidth);
    crown.position.y = crownY;
    tree.add(crown);
    const patchCount = Math.random() < 0.28 ? 0 : 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < patchCount; i++) {
      const angle = rand(0, Math.PI * 2);
      const crownOffsetY = rand(-0.24, 0.32) * crownHeight;
      const surfaceRadius = crownWidth * Math.max(0.12, 0.5 - crownOffsetY / crownHeight);
      addSnowPatch(tree, Math.cos(angle) * surfaceRadius, crownY + crownOffsetY,
        Math.sin(angle) * surfaceRadius,
        [rand(0.16, 0.36) * crownWidth, rand(0.1, 0.24) * crownHeight, rand(0.08, 0.16) * crownWidth]);
    }
  }
}

function addBroadleafTree(tree) {
  const trunk = new THREE.Mesh(treeTrunkGeo, treeTrunk);
  trunk.scale.set(1.15, 1.4, 1.15);
  trunk.position.y = 0.9;
  tree.add(trunk);
  const crownPositions = [
    [-0.44, 1.75, 0], [0.42, 1.8, 0.12], [0, 2.08, 0.36],
    [-0.12, 2.25, -0.34], [0.28, 2.45, -0.05],
  ];
  for (const [x, y, z] of crownPositions) {
    const radius = rand(0.48, 0.72);
    const crown = new THREE.Mesh(roundTreeCrownGeo, broadleafFoliage[Math.floor(Math.random() * broadleafFoliage.length)]);
    crown.scale.set(radius * rand(0.9, 1.2), radius, radius * rand(0.85, 1.15));
    crown.position.set(x, y, z);
    tree.add(crown);
    if (Math.random() < 0.48) {
      addSnowPatch(tree, x + rand(-0.18, 0.18), y + radius * 0.38, z + rand(-0.18, 0.18),
        [radius * rand(0.28, 0.5), radius * 0.2, radius * rand(0.25, 0.45)]);
    }
  }
}

function addCedarTree(tree) {
  const trunk = new THREE.Mesh(treeTrunkGeo, treeTrunk);
  trunk.scale.set(0.82, 1.5, 0.82);
  trunk.position.y = 0.9;
  tree.add(trunk);
  for (let layer = 0; layer < 5; layer++) {
    const crownWidth = 0.7 - layer * 0.09;
    const crownHeight = 0.95 - layer * 0.06;
    const crownY = 1.1 + layer * 0.55;
    const crown = new THREE.Mesh(treeCrownGeo, treeFoliage[(layer + 1) % treeFoliage.length]);
    crown.scale.set(crownWidth, crownHeight, crownWidth);
    crown.position.y = crownY;
    tree.add(crown);
    if (Math.random() < 0.68) {
      const angle = rand(0, Math.PI * 2);
      const radius = crownWidth * rand(0.25, 0.55);
      addSnowPatch(tree, Math.cos(angle) * radius, crownY + rand(-0.2, 0.25), Math.sin(angle) * radius,
        [rand(0.12, 0.25), rand(0.12, 0.23), rand(0.1, 0.2)]);
    }
  }
}

function setTreeType(tree, type) {
  if (tree.userData.treeType === type) return;
  tree.clear();
  if (type === 0) addPineTree(tree);
  else if (type === 1) addBroadleafTree(tree);
  else addCedarTree(tree);
  if (Math.random() < 0.38) {
    const groundSnow = new THREE.Mesh(snowPatchGeo, treeSnow);
    const patchWidth = rand(0.45, 1.25);
    groundSnow.scale.set(patchWidth, rand(0.025, 0.06), patchWidth * rand(0.55, 1.1));
    groundSnow.position.set(rand(-2.2, 2.2), -0.45, rand(-1.4, 1.4));
    groundSnow.rotation.y = rand(0, Math.PI);
    tree.add(groundSnow);
  }
  tree.userData.treeType = type;
}

function addTree(z) {
  const tree = new THREE.Group();
  tree.scale.setScalar(rand(0.75, 1.55));
  tree.rotation.y = rand(0, Math.PI * 2);
  setTreeType(tree, treeZoneAt(z));
  scene.add(tree);
  const position = chooseMountainPosition(z);
  tree.position.set(position.x, position.y + 0.5, z);
  scenery.push({ object: tree });
}

for (let i = 0; i < 82; i++) addTree(rand(-SCENERY_SPAN, 8));

const stoneGeometries = [
  new THREE.IcosahedronGeometry(1, 1),
  new THREE.DodecahedronGeometry(1, 0),
  new THREE.IcosahedronGeometry(1, 0),
];
const stoneMats = [
  new THREE.MeshStandardMaterial({ color: 0x7d8274, roughness: 0.88, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xa18b69, roughness: 0.84, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x586e70, roughness: 0.82, flatShading: true }),
];
const rippleGeo = new THREE.TorusGeometry(0.62, 0.025, 5, 28);
const rippleMat = new THREE.MeshBasicMaterial({ color: 0x74d6d2, transparent: true, opacity: 0.42, depthWrite: false });
const riverStones = [];
let targetStoneScale = regionStyles[0].stoneScale;

function placeStone(stone, z) {
  const terrainZ = z - terrainMat.uniforms.uOffset.value;
  const { center } = valleyAt(terrainZ);
  const x = center + rand(-3.8, 3.8);
  stone.position.set(x, -0.03, z);
  stone.userData.ripple.position.set(x, -0.29, z);
}

for (let i = 0; i < regionStyles[3].stoneCount; i++) {
  const stone = new THREE.Mesh(
    stoneGeometries[regionStyles[0].stoneShape],
    stoneMats[Math.floor(Math.random() * stoneMats.length)],
  );
  const scale = rand(0.48, 0.92);
  stone.userData.baseScale = new THREE.Vector3(
    scale * rand(0.8, 1.4),
    scale * rand(0.35, 0.6),
    scale * rand(0.8, 1.3),
  );
  stone.userData.targetScale = stone.userData.baseScale.clone().multiplyScalar(targetStoneScale);
  stone.scale.copy(stone.userData.targetScale);
  stone.rotation.set(rand(-0.2, 0.2), rand(0, Math.PI), rand(-0.15, 0.15));
  const ripple = new THREE.Mesh(rippleGeo, rippleMat);
  ripple.rotation.x = -Math.PI / 2;
  ripple.scale.setScalar(rand(0.65, 1.35));
  scene.add(stone, ripple);
  stone.userData.ripple = ripple;
  placeStone(stone, rand(-SCENERY_SPAN, 8));
  riverStones.push(stone);
}

function setRegionScenery(styleIndex, randomizeTrees = true) {
  const style = regionStyles[styleIndex];
  if (randomizeTrees) {
    const currentMap = treeTypeMap.join(',');
    const treeMaps = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2],
      [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ].filter((map) => map.join(',') !== currentMap);
    treeTypeMap = treeMaps[Math.floor(Math.random() * treeMaps.length)];
  } else {
    treeTypeMap = [0, 1, 2];
  }
  for (const entry of scenery) {
    setTreeType(entry.object, treeZoneAt(entry.object.position.z));
  }

  targetStoneScale = style.stoneScale;
  for (let i = 0; i < riverStones.length; i++) {
    const stone = riverStones[i];
    const shouldShow = i < style.stoneCount;
    stone.userData.targetScale.copy(stone.userData.baseScale).multiplyScalar(targetStoneScale);
    stone.visible = shouldShow;
    stone.userData.ripple.visible = shouldShow;
    if (shouldShow && !stone.userData.wasVisible) {
      placeStone(stone, rand(-SCENERY_SPAN, 8));
    }
    stone.userData.wasVisible = shouldShow;
    stone.geometry = stoneGeometries[style.stoneShape];
  }
}

const placeLabelCanvas = document.createElement('canvas');
placeLabelCanvas.width = 1024;
placeLabelCanvas.height = 192;
const placeLabelContext = placeLabelCanvas.getContext('2d');
const placeLabelTexture = new THREE.CanvasTexture(placeLabelCanvas);
placeLabelTexture.colorSpace = THREE.SRGBColorSpace;
const placeLabel = new THREE.Sprite(new THREE.SpriteMaterial({
  map: placeLabelTexture,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  fog: false,
  toneMapped: false,
}));
placeLabel.scale.set(18, 3.4, 1);
placeLabel.renderOrder = 10;
placeLabel.visible = false;
scene.add(placeLabel);
let placeLabelAnchor = null;

function choosePlaceLabelAnchor() {
  camera.updateMatrixWorld(true);
  let farthestVisible = null;
  let nearestFallback = null;
  let fallbackDistance = Infinity;
  const projected = new THREE.Vector3();
  for (const entry of scenery) {
    const tree = entry.object;
    if (tree.position.z > -45 || tree.position.z < -260) continue;
    const labelY = Math.min(tree.position.y + 2.6 * tree.scale.y, 12);
    projected.set(tree.position.x, labelY, tree.position.z).project(camera);
    if (Math.abs(projected.x) < 0.9 && projected.y > -0.8 && projected.y < 0.95
      && projected.z > -1 && projected.z < 1) {
      if (!farthestVisible || tree.position.z < farthestVisible.position.z) farthestVisible = tree;
    }
    const distance = Math.abs(tree.position.z + 150);
    if (distance < fallbackDistance) {
      fallbackDistance = distance;
      nearestFallback = tree;
    }
  }
  return farthestVisible || nearestFallback;
}

function hidePlaceName() {
  placeLabel.visible = false;
  placeLabelAnchor = null;
}

function showPlaceName() {
  if (placeNames.length === 0) return;
  const placeIndex = nextPlaceIndex;
  nextPlaceIndex = (nextPlaceIndex + 1) % placeNames.length;
  const text = placeNames[placeIndex];
  placeLabelContext.clearRect(0, 0, placeLabelCanvas.width, placeLabelCanvas.height);
  placeLabelContext.font = '700 112px "Noto Sans Devanagari", "Nirmala UI", sans-serif';
  placeLabelContext.textAlign = 'center';
  placeLabelContext.textBaseline = 'middle';
  placeLabelContext.lineJoin = 'round';
  placeLabelContext.lineWidth = 14;
  placeLabelContext.strokeStyle = 'rgba(40, 12, 0, 0.95)';
  placeLabelContext.strokeText(text, placeLabelCanvas.width / 2, placeLabelCanvas.height / 2, 960);
  placeLabelContext.shadowColor = '#ff6a00';
  placeLabelContext.shadowBlur = 32;
  placeLabelContext.fillStyle = '#ff9d32';
  placeLabelContext.fillText(text, placeLabelCanvas.width / 2, placeLabelCanvas.height / 2, 960);
  placeLabelTexture.needsUpdate = true;

  placeLabelAnchor = choosePlaceLabelAnchor();
  if (!placeLabelAnchor) {
    hidePlaceName();
    return;
  }
  placeLabel.visible = true;
  placeLabel.material.opacity = 1;
  placeLabel.position.set(
    placeLabelAnchor.position.x,
    Math.min(placeLabelAnchor.position.y + 2.6 * placeLabelAnchor.scale.y, 12),
    placeLabelAnchor.position.z,
  );
}

setRegionScenery(0, false);

function updateScenery(dt, dz) {
  sceneryDistance += dz;
  for (const entry of scenery) {
    const tree = entry.object;
    if (tree === placeLabelAnchor && tree.position.z + dz > 10) hidePlaceName();
    tree.position.z += dz;
    if (tree.position.z > 10) {
      tree.position.z -= SCENERY_SPAN;
      setTreeType(tree, treeZoneAt(tree.position.z));
      const position = chooseMountainPosition(tree.position.z);
      tree.position.set(position.x, position.y + 0.5, tree.position.z);
    }
  }
  if (placeLabelAnchor) {
    placeLabel.position.set(
      placeLabelAnchor.position.x,
      Math.min(placeLabelAnchor.position.y + 2.6 * placeLabelAnchor.scale.y, 12),
      placeLabelAnchor.position.z,
    );
    placeLabel.material.opacity = THREE.MathUtils.clamp((10 - placeLabelAnchor.position.z) / 20, 0, 1);
  }
  for (const stone of riverStones) {
    stone.scale.lerp(stone.userData.targetScale, 1 - Math.exp(-2.5 * dt));
    if (!stone.visible) continue;
    stone.position.z += dz;
    if (stone.position.z > 10) {
      placeStone(stone, stone.position.z - SCENERY_SPAN);
    } else {
      stone.userData.ripple.position.z = stone.position.z;
    }
  }
}

// ---------- Speed streaks ----------
const STREAKS = 260;
const streakPos = new Float32Array(STREAKS * 3);
for (let i = 0; i < STREAKS; i++) {
  streakPos[i * 3] = rand(-30, 30);
  streakPos[i * 3 + 1] = rand(-1, 16);
  streakPos[i * 3 + 2] = rand(-160, 12);
}
const streakGeo = new THREE.BufferGeometry();
streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3).setUsage(THREE.DynamicDrawUsage));
const streaks = new THREE.Points(streakGeo, new THREE.PointsMaterial({
  size: 0.16, map: dotTexture, color: new THREE.Color(0.65, 0.52, 0.38),
  transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.NormalBlending,
}));
streaks.frustumCulled = false;
scene.add(streaks);

// ---------- Particles (trail + bursts) ----------
const MAXP = 900;
const pPos = new Float32Array(MAXP * 3);
const pCol = new Float32Array(MAXP * 3);
const pVel = new Float32Array(MAXP * 3);
const pBase = new Float32Array(MAXP * 3);
const pLife = new Float32Array(MAXP);
const pMax = new Float32Array(MAXP);
let pHead = 0;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
  size: 0.32, map: dotTexture, vertexColors: true, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending,
}));
particles.frustumCulled = false;
scene.add(particles);

function emit(x, y, z, vx, vy, vz, life, r, g, b) {
  const i = pHead;
  pHead = (pHead + 1) % MAXP;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
  pBase[i * 3] = r; pBase[i * 3 + 1] = g; pBase[i * 3 + 2] = b;
  pLife[i] = pMax[i] = life;
}

function burst(pos, count, speed, color, life = 0.9) {
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(speed * rand(0.3, 1));
    emit(pos.x, pos.y, pos.z, v.x, v.y, v.z, life * rand(0.6, 1.2), color[0], color[1], color[2]);
  }
}

function updateParticles(dt, dz) {
  const drag = Math.exp(-2.4 * dt);
  for (let i = 0; i < MAXP; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    const i3 = i * 3;
    if (pLife[i] <= 0) { pCol[i3] = pCol[i3 + 1] = pCol[i3 + 2] = 0; continue; }
    pPos[i3] += pVel[i3] * dt;
    pPos[i3 + 1] += pVel[i3 + 1] * dt;
    pPos[i3 + 2] += pVel[i3 + 2] * dt + dz;
    pVel[i3] *= drag; pVel[i3 + 1] *= drag; pVel[i3 + 2] *= drag;
    const k = pLife[i] / pMax[i];
    pCol[i3] = pBase[i3] * k;
    pCol[i3 + 1] = pBase[i3 + 1] * k;
    pCol[i3 + 2] = pBase[i3 + 2] * k;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

// ---------- Player Hanuman ----------
const ship = new THREE.Group();
ship.position.set(0, 3.6, 0);
ship.visible = false;
scene.add(ship);

const _v = new THREE.Vector3();
const ENGINE_LOCAL = new THREE.Vector3(0, 0, -0.9);
let playerLoaded = false;
let obstacleLoaded = false;
let stormCloudModel = null;
let regionStormModels = [];
let selectedStormCloudModel = null;
let selectedStormTheme = 'obstacle_storm_cloud.glb';
let modelLoadError = '';
let placesLoaded = false;
let placeLoadError = '';
ui.start.disabled = true;
ui.start.textContent = 'Loading…';

function updateStartButton() {
  const ready = playerLoaded && obstacleLoaded && placesLoaded;
  ui.start.disabled = !ready;
  ui.start.textContent = modelLoadError || placeLoadError || (ready ? 'Play' : 'Loading…');
}

fetch(new URL('./places.json', import.meta.url))
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((places) => {
    if (!Array.isArray(places) || places.length === 0
      || places.some((entry) => typeof entry.place !== 'string' || !entry.place.trim())) {
      throw new Error('places.json must contain a non-empty list of place names');
    }
    placeNames = places.map((entry) => entry.place.trim());
    placesLoaded = true;
    updateStartButton();
  })
  .catch((error) => {
    console.error('Failed to load places.json', error);
    placeLoadError = 'Place names failed to load';
    updateStartButton();
  });

new GLTFLoader().load(
  './hanuman_flying.glb',
  (gltf) => {
    const model = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = 2.5 / Math.max(size.x, size.y);
    model.scale.setScalar(scale);
    model.rotation.y = Math.PI;
    model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    model.traverse((object) => {
      if (object.isMesh) object.frustumCulled = false;
    });
    ship.add(model);
    const playerLight = new THREE.PointLight(0xffb642, 0.8, 6, 2);
    playerLight.position.set(0, 0.5, 0.8);
    ship.add(playerLight);
    ship.visible = true;
    playerLoaded = true;
    updateStartButton();
  },
  undefined,
  (error) => {
    console.error('Failed to load hanuman_flying.glb', error);
    modelLoadError = 'Hanuman model failed to load';
    updateStartButton();
  },
);

const obstacleModelFiles = [
  'obstacle_storm_cloud.glb',
  'storm_abyss.glb',
  'storm_crimson.glb',
  'storm_obsidian.glb',
  'storm_venom.glb',
  'storm_void.glb',
];
const loader = new GLTFLoader();

function loadObstacleModel(file) {
  return new Promise((resolve, reject) => {
    loader.load(
      `./${file}`,
      (gltf) => {
        const model = gltf.scene.clone(true);
        model.rotation.x = Math.PI / 2;
        model.rotation.z = Math.PI;
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const scale = 3.8 / size.x;
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
        model.traverse((object) => {
          if (object.isMesh) object.frustumCulled = false;
        });
        resolve({ file, model });
      },
      undefined,
      (error) => reject(new Error(`Failed to load ${file}`, { cause: error })),
    );
  });
}

Promise.all(obstacleModelFiles.map(loadObstacleModel))
  .then((models) => {
    stormCloudModel = models[0].model;
    regionStormModels = models.slice(1);
    selectedStormCloudModel = stormCloudModel;
    obstacleLoaded = true;
    updateStartButton();
  })
  .catch((error) => {
    console.error('Failed to load obstacle models', error);
    modelLoadError = 'Obstacle models failed to load';
    updateStartButton();
  });

function chooseRegionStormModel() {
  const choices = regionStormModels.filter(({ model }) => model !== selectedStormCloudModel);
  const selected = choices[director.pickStormTheme(choices.map(({ file }) => file))];
  selectedStormCloudModel = selected.model;
  selectedStormTheme = selected.file;
}

// ---------- World objects (pooled) ----------
const geos = {
  ring: new THREE.TorusGeometry(2.3, 0.13, 12, 64),
};
function createRingLabel(text, fillColor, shadowColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 144;
  const context = canvas.getContext('2d');
  context.font = '700 76px "Nirmala UI", "Noto Sans Devanagari", sans-serif';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.shadowColor = shadowColor; context.shadowBlur = 10;
  context.lineWidth = 7; context.strokeStyle = 'rgba(14, 20, 26, 0.95)';
  context.strokeText(text, 256, 72, 492);
  context.fillStyle = fillColor;
  context.fillText(text, 256, 72, 492);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false });
}
const ringVisuals = [
  {
    material: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.9, 0.12) }),
    label: createRingLabel('श्री राम कवच', '#fff0a8', '#ff8c24'),
  },
  {
    material: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.035, 0.01) }),
    label: createRingLabel('माँ सीता शक्ति', '#ffe6e6', '#ff1010'),
  },
];
function createFruitTexture(baseColor, highlightColor, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, highlightColor);
  gradient.addColorStop(0.28, baseColor);
  gradient.addColorStop(0.72, baseColor);
  gradient.addColorStop(1, highlightColor);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  let value = seed;
  const random = () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
  for (let i = 0; i < 1800; i++) {
    const radius = random() * 1.6 + 0.35;
    context.fillStyle = random() > 0.5 ? 'rgba(255,235,175,0.18)' : 'rgba(67,37,18,0.12)';
    context.beginPath();
    context.arc(random() * canvas.width, random() * canvas.height, radius, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const appleTexture = createFruitTexture('#bd182e', '#f05a43', 17);
const orangeTexture = createFruitTexture('#e66b12', '#ffad27', 43);
const peelTexture = createFruitTexture('#d78021', '#f3a43b', 89);
const fruitGlowMaterials = {
  apple: new THREE.SpriteMaterial({
    map: dotTexture, color: '#ff3429', opacity: 0.8, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }),
  banana: new THREE.SpriteMaterial({
    map: dotTexture, color: '#ffd12f', opacity: 0.78, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }),
  orange: new THREE.SpriteMaterial({
    map: dotTexture, color: '#ff791e', opacity: 0.8, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }),
};
const fruitMaterials = {
  apple: new THREE.MeshPhysicalMaterial({
    map: appleTexture, color: 0xffffff, emissive: '#ff261b', emissiveIntensity: 0.85,
    roughness: 0.28, clearcoat: 0.32, clearcoatRoughness: 0.3,
  }),
  banana: new THREE.MeshStandardMaterial({
    color: 0xffd21c, emissive: '#ffae12', emissiveIntensity: 0.75, roughness: 0.38,
  }),
  orange: new THREE.MeshStandardMaterial({
    map: orangeTexture, bumpMap: peelTexture, bumpScale: 0.035, color: 0xffffff,
    emissive: '#ff6a12', emissiveIntensity: 0.9, roughness: 0.55,
  }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x27833b, roughness: 0.72, side: THREE.DoubleSide }),
  stem: new THREE.MeshStandardMaterial({ color: 0x68442a, roughness: 0.85 }),
  bananaTip: new THREE.MeshStandardMaterial({ color: 0x60442e, roughness: 0.85 }),
};
const appleGeo = new THREE.SphereGeometry(0.48, 18, 14);
const orangeGeo = new THREE.SphereGeometry(0.46, 24, 18);
{
  const positions = orangeGeo.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const pole = Math.pow(Math.abs(y) / 0.46, 8);
    const dimples = 0.012 * Math.cos(Math.atan2(z, x) * 12) * Math.sin(Math.acos(THREE.MathUtils.clamp(y / 0.46, -1, 1)) * 10);
    const scale = 1 + dimples - pole * 0.035;
    positions.setXYZ(i, x * scale, y * scale, z * scale);
  }
  positions.needsUpdate = true;
  orangeGeo.computeVertexNormals();
}
const leafGeo = new THREE.SphereGeometry(1, 10, 8);
const bananaCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-0.52, -0.08, 0),
  new THREE.Vector3(-0.35, -0.36, 0),
  new THREE.Vector3(0, -0.42, 0),
  new THREE.Vector3(0.38, -0.22, 0),
  new THREE.Vector3(0.5, 0.1, 0),
]);
const bananaGeo = new THREE.TubeGeometry(bananaCurve, 20, 0.12, 10, false);
const entities = [];
const pools = { crystal: [], orb: [], ring: [] };
let gateCount = 0;

function createEntity(type) {
  const mesh = new THREE.Group();
  if (type === 'crystal') setObstacleModel(mesh, selectedStormCloudModel);
  if (type === 'orb') {
    const apple = new THREE.Group();
    const appleGlow = new THREE.Sprite(fruitGlowMaterials.apple);
    appleGlow.position.z = -0.28;
    appleGlow.scale.set(1.8, 1.8, 1);
    apple.add(appleGlow);
    const appleBody = new THREE.Mesh(appleGeo, fruitMaterials.apple);
    appleBody.scale.set(0.9, 0.94, 0.78);
    appleBody.position.y = -0.02;
    apple.add(appleBody);
    const appleStem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.16, 7), fruitMaterials.stem);
    appleStem.position.set(0, 0.43, 0);
    appleStem.rotation.z = -0.18;
    apple.add(appleStem);
    const appleLeaf = new THREE.Mesh(leafGeo, fruitMaterials.leaf);
    appleLeaf.scale.set(0.17, 0.06, 0.085);
    appleLeaf.position.set(0.12, 0.47, 0);
    appleLeaf.rotation.z = 0.42;
    apple.add(appleLeaf);
    mesh.add(apple);

    const banana = new THREE.Group();
    const bananaGlow = new THREE.Sprite(fruitGlowMaterials.banana);
    bananaGlow.position.z = -0.28;
    bananaGlow.scale.set(2.1, 1.7, 1);
    banana.add(bananaGlow);
    const bananaBody = new THREE.Mesh(bananaGeo, fruitMaterials.banana);
    banana.add(bananaBody);
    for (const x of [-0.52, 0.5]) {
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), fruitMaterials.bananaTip);
      tip.position.set(x, x < 0 ? -0.08 : 0.1, 0);
      banana.add(tip);
    }
    banana.rotation.z = 0.18;
    mesh.add(banana);

    const orange = new THREE.Group();
    const orangeGlow = new THREE.Sprite(fruitGlowMaterials.orange);
    orangeGlow.position.z = -0.28;
    orangeGlow.scale.set(1.8, 1.8, 1);
    orange.add(orangeGlow);
    const orangeBody = new THREE.Mesh(orangeGeo, fruitMaterials.orange);
    orangeBody.scale.set(0.92, 0.9, 0.86);
    orange.add(orangeBody);
    const orangeStem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.09, 7), fruitMaterials.stem);
    orangeStem.position.y = 0.42;
    orange.add(orangeStem);
    const orangeLeaf = new THREE.Mesh(leafGeo, fruitMaterials.leaf);
    orangeLeaf.scale.set(0.19, 0.065, 0.09);
    orangeLeaf.position.set(0.12, 0.43, 0);
    orangeLeaf.rotation.z = 0.45;
    orange.add(orangeLeaf);
    mesh.add(orange);
  }
  if (type === 'ring') {
    for (const visual of ringVisuals) {
      const group = new THREE.Group();
      const torus = new THREE.Mesh(geos.ring, visual.material);
      const label = new THREE.Sprite(visual.label);
      label.position.z = 0.16;
      label.scale.set(3.4, 0.96, 1);
      group.add(torus, label);
      mesh.add(group);
    }
  }
  scene.add(mesh);
  return { type, mesh, rx: 1, ry: 1, spin: 0, phase: 0, baseY: 0, passed: false, variant: 'ram' };
}

function setObstacleModel(mesh, modelTemplate) {
  if (mesh.userData.stormModelTemplate === modelTemplate) return;
  if (mesh.userData.stormModel) mesh.remove(mesh.userData.stormModel);
  const model = modelTemplate.clone(true);
  mesh.add(model);
  mesh.userData.stormModel = model;
  mesh.userData.stormModelTemplate = modelTemplate;
}

function spawn(type, x, y, z, variant = 'ram') {
  const e = pools[type].pop() || createEntity(type);
  if (type === 'crystal') setObstacleModel(e.mesh, selectedStormCloudModel);
  e.mesh.visible = true;
  e.mesh.position.set(x, y, z);
  e.mesh.rotation.set(0, type === 'orb' ? 0 : Math.random() * Math.PI * 2, 0);
  e.mesh.scale.set(1, 1, 1);
  if (type === 'ring') {
    e.variant = variant;
    const activeIndex = variant === 'ram' ? 0 : 1;
    e.mesh.children.forEach((group, index) => { group.visible = index === activeIndex; });
  }
  if (type === 'orb') {
    const fruitIndex = Math.floor(Math.random() * 3);
    e.mesh.children.forEach((fruit, index) => { fruit.visible = index === fruitIndex; });
    e.mesh.userData.fruitIndex = fruitIndex;
  }
  e.baseY = y;
  e.phase = Math.random() * Math.PI * 2;
  e.passed = false;
  e.crossD2 = undefined; // pooled entities: clear the previous life's crossing record
  e.crossInvuln = false;
  e.rescue = false;      // rescue कवच gate offered by the director: shield only, no score
  e.waveId = null;    // which wave spawned it, for outcome attribution
  e.features = null;  // risk features at placement time (obstacles only)
  e.side = 0;
  e.stormTheme = type === 'crystal' ? selectedStormTheme : null;
  entities.push(e);
  return e;
}

function crystal(x, y, z, s = 1, sy = 1.8) {
  const e = spawn('crystal', x, y, z);
  e.mesh.scale.set(s, s * sy, s);
  e.rx = 1.9 * s;
  e.ry = 1.1 * s * sy;
  e.spin = rand(0.7, 1.2);
  return e;
}
const orb = (x, y, z) => spawn('orb', x, y, z);
function ring(x, y, z, variant) {
  const e = spawn('ring', x, y, z, variant);
  e.mesh.rotation.set(0, 0, 0);
  const activeIndex = variant === 'ram' ? 0 : 1;
  e.mesh.children[activeIndex].children[0].rotation.set(0, 0, 0);
  return e;
}

function removeAt(i) {
  const e = entities[i];
  entities[i] = entities[entities.length - 1];
  entities.pop();
  e.mesh.visible = false;
  pools[e.type].push(e);
}

function clearEntities() {
  for (let i = entities.length - 1; i >= 0; i--) removeAt(i);
}

function clearObstacles() {
  if (state.mode !== 'playing') return;
  if (state.powerCharges <= 0) {
    toast('NO SHAKTI CHARGES', '#ff263f');
    return;
  }

  let cleared = 0;
  for (const entity of entities) {
    if (entity.type === 'crystal') cleared++;
  }
  if (!cleared) {
    toast('NO OBSTACLES AHEAD', '#b8a6d8');
    return;
  }
  state.powerCharges--;
  const waveIds = [];
  for (let i = entities.length - 1; i >= 0; i--) {
    const obstacle = entities[i];
    if (obstacle.type !== 'crystal') continue;
    if (!obstacle.passed && obstacle.waveId !== null) waveIds.push(obstacle.waveId);
    burst(obstacle.mesh.position, 36, 12, [0.55, 1.5, 2.4], 0.8);
    removeAt(i);
  }
  director.onEvent({ type: 'shakti_used', threats: cleared, waveIds });
  updatePowerBar();
  toast('OBSTACLES CLEARED', '#46f1ff');
}

// ---------- Wave patterns ----------
// The random values below are today's hand-tuned proposals; the director returns them
// unchanged in Classic mode / cold start and personalises them as it learns.
const difficulty = () => director.personalRamp(state.runTime);
const shipVel = { x: 0, y: 0 };
const shipCtx = () => ({ x: ship.position.x, y: ship.position.y, vx: shipVel.x, vy: shipVel.y });

function placeCrystal(wave, x, y, z, s, sy, xRange = null, yRange = null, count = 1) {
  const p = director.placeObstacle({
    waveId: wave.id, x, y, z, s, sy, xRange, yRange, count, fixed: !xRange, ship: shipCtx(), speed: state.speed,
  });
  const e = crystal(p.x, p.y, p.z, p.s, p.sy);
  e.waveId = wave.id;
  e.features = p.features;
  e.side = p.side;
  return e;
}

function waveScatter(d, wave) {
  const n = 2 + Math.floor(d * 4 + Math.random() * 2);
  for (let i = 0; i < n; i++) {
    placeCrystal(wave, rand(-8.5, 8.5), rand(1.3, 6.8), SPAWN_Z - rand(0, 28), rand(0.8, 1.25), rand(1.3, 2.4),
      [-8.5, 8.5], [1.3, 6.8], n);
  }
  if (Math.random() < 0.7) {
    const { x, y } = director.fruitPath({ x: rand(-7, 7), y: rand(2, 6), xRange: [-7, 7], yRange: [2, 6] });
    for (let i = 0; i < 3; i++) orb(x, y, SPAWN_Z + 12 + i * 4);
  }
}

function waveSnake(d, wave) {
  const A = rand(3, 7), B = rand(0.5, 2), ph = rand(0, Math.PI * 2);
  const { x: cx, y: cy } = director.fruitPath({ x: 0, y: rand(2.8, 5.2), xRange: [A - 8.5, 8.5 - A], yRange: [2.8, 5.2] });
  for (let i = 0; i < 9; i++) {
    orb(cx + A * Math.sin(ph + i * 0.55), cy + B * Math.cos(ph + i * 0.8), SPAWN_Z - i * 4.5);
  }
  if (d > 0.25) {
    const n = 1 + Math.floor(d * 2.5);
    for (let i = 0; i < n; i++) {
      placeCrystal(wave, rand(-8, 8), rand(1.5, 6.5), SPAWN_Z - rand(5, 40), rand(0.8, 1.1), rand(1.4, 2),
        [-8, 8], [1.5, 6.5], n);
    }
  }
}

function waveGate(d, wave) {
  const z = SPAWN_Z - 30;
  const alternate = gateCount++ % 2 === 0 ? 'ram' : 'seeta';
  const variant = wave.variant ?? alternate;
  const { x, y } = director.placeRing({
    x: rand(-5.5, 5.5), y: rand(2.4, 5.6), z, xRange: [-5.5, 5.5], yRange: [2.4, 5.6], ship: shipCtx(), speed: state.speed,
  }, variant);
  ring(x, y, z, variant).rescue = wave.rescue;
  const { x: x0, y: y0 } = director.fruitPath({ x: rand(-7, 7), y: rand(1.8, 6.4), xRange: [-7, 7], yRange: [1.8, 6.4] });
  for (let i = 0; i < 4; i++) {
    const k = i / 4;
    orb(THREE.MathUtils.lerp(x0, x, k), THREE.MathUtils.lerp(y0, y, k), z + (4 - i) * 7);
  }
  if (d > 0.4) {
    const side = Math.random() < 0.5 ? -1 : 1;
    placeCrystal(wave, clamp(x + side * 4.6, -9, 9), y, z, 1, 1.6);
  }
}

function waveWall(d, wave) {
  const cols = [-8, -4, 0, 4, 8];
  const gap = Math.floor(rand(0, 5));
  let gaps = new Set([gap]);
  if (d < 0.5) gaps.add(gap === 4 ? 3 : gap + 1);
  gaps = director.wallGaps({ cols, gaps, ship: shipCtx(), speed: state.speed, z: SPAWN_Z });
  cols.forEach((x, i) => { if (!gaps.has(i)) placeCrystal(wave, x, MID_Y, SPAWN_Z, 1, 3.3); });
  const gx = [...gaps].reduce((s, i) => s + cols[i], 0) / gaps.size;
  for (const y of [2.4, 4, 5.6]) orb(gx, y, SPAWN_Z);
}

const WAVES = { wall: waveWall, scatter: waveScatter, snake: waveSnake, gate: waveGate };

function spawnWave() {
  let obstacles = 0;
  for (const e of entities) if (e.type === 'crystal') obstacles++;
  const wave = director.chooseWave({
    runTime: state.runTime, shield: state.shield, powerCharges: state.powerCharges, obstacles,
  });
  WAVES[wave.arm](wave.d, wave);
  director.onEvent({ type: 'wave_spawn', id: wave.id, arm: wave.arm, params: { d: wave.d, variant: wave.variant } });
}

// ---------- Audio (tiny WebAudio synth) ----------
const sfx = {
  ctx: null,
  muted: false,
  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'sine', vol = 0.12, slideTo = 0, delay = 0) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  collect(combo) { this.tone(520 * Math.pow(1.06, Math.min(combo, 24)), 0.14, 'triangle', 0.1); },
  gate() { [660, 880, 1320].forEach((f, i) => this.tone(f, 0.18, 'sine', 0.09, 0, i * 0.06)); },
  hit() { this.tone(180, 0.45, 'sawtooth', 0.14, 45); this.tone(90, 0.5, 'square', 0.06, 30); },
  boom() { this.tone(140, 1.1, 'sawtooth', 0.18, 25); this.tone(70, 1.2, 'triangle', 0.15, 20); },
  start() { [330, 440, 660].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.08, 0, i * 0.08)); },
};

// ---------- Game state ----------
const state = {
  mode: 'menu', // menu | playing | paused | dying | over
  score: 0,
  runMode: 'adaptive', // mode the current/last run was played in; its best score is `best`
  best: 0,
  shield: 100,
  combo: 0,
  powerCharges: 3,
  speed: 26,
  runTime: 0,
  dist: 0,
  nextSpawn: 0,
  invuln: 0,
  shake: 0,
};
// Adaptive and Classic keep separate best scores; the displays follow the selected mode.
const selectedMode = () => (director.model.classic ? 'classic' : 'adaptive');
function showBest(mode = selectedMode()) {
  const best = store.get(mode).toLocaleString();
  const label = mode === 'classic' ? 'Classic' : 'Adaptive';
  ui.bestMenu.textContent = best;
  ui.bestHud.textContent = best;
  ui.finalBest.textContent = best;
  document.querySelectorAll('.best-mode').forEach((el) => { el.textContent = label; });
}
state.runMode = selectedMode();
state.best = store.get(state.runMode);
showBest();

const multiplier = () => Math.min(8, 1 + Math.floor(state.combo / 4));
function updatePowerBar() {
  ui.powerFill.style.width = `${(state.powerCharges / 3) * 100}%`;
  ui.power.dataset.level = String(state.powerCharges);
}

function toast(text, color) {
  ui.toast.textContent = text;
  ui.toast.style.color = color;
  ui.toast.style.textShadow = `0 0 18px ${color}`;
  ui.toast.classList.remove('show');
  void ui.toast.offsetWidth; // restart animation
  ui.toast.classList.add('show');
}

function startGame() {
  if (!playerLoaded || !obstacleLoaded || !placesLoaded) return;
  sfx.init();
  sfx.start();
  clearEntities();
  gateCount = 0;
  director.onEvent({ type: 'run_start' }); // fixes this run's personalisation level first
  resetRiverStyle();
  nextPlaceIndex = 0;
  showPlaceName();
  nextRiverChange = director.regionInterval();
  state.runMode = selectedMode(); // a toggle on the game-over panel can't re-file this run
  state.best = store.get(state.runMode);
  showBest(state.runMode);
  Object.assign(state, { mode: 'playing', score: 0, shield: 100, combo: 0, powerCharges: 3, runTime: 0, dist: 0, nextSpawn: 40, invuln: 1, shake: 0 });
  updatePowerBar();
  ui.power.disabled = false;
  ship.visible = true;
  ship.position.set(0, MID_Y, 0);
  target.set(0, MID_Y);
  input.px = 0; input.py = 0;
  ui.menu.classList.add('hidden');
  ui.over.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  lastMult = 0;
  canvas.focus?.();
}

function gameOver() {
  state.mode = 'dying';
  ui.power.disabled = true;
  burst(ship.position, 160, 16, [2.4, 0.6, 2.2], 1.4);
  burst(ship.position, 80, 9, [0.4, 2.0, 2.6], 1.2);
  ship.visible = false;
  state.shake = 1.2;
  sfx.boom();
  const final = Math.floor(state.score);
  const isBest = final > state.best;
  if (isBest) { state.best = final; store.set(state.runMode, final); }
  director.onEvent({ type: 'run_end', duration: state.runTime, score: final, cause: 'shield' });
  director.save();
  setTimeout(() => {
    state.mode = 'over';
    ui.hud.classList.add('hidden');
    ui.finalScore.textContent = final.toLocaleString();
    showBest(state.runMode);
    ui.newBest.classList.toggle('hidden', !isBest);
    ui.over.classList.remove('hidden');
    ui.restart.focus();
  }, 1100);
}

function setPaused(p) {
  if (p && state.mode === 'playing') {
    state.mode = 'paused';
    ui.power.disabled = true;
    ui.pause.classList.remove('hidden');
  } else if (!p && state.mode === 'paused') {
    state.mode = 'playing';
    ui.power.disabled = false;
    ui.pause.classList.add('hidden');
    clock.getDelta();
  }
}

function toggleMute() {
  sfx.muted = !sfx.muted;
  ui.mute.classList.toggle('muted', sfx.muted);
}

function onHit(e) {
  state.shield -= 34;
  state.combo = 0;
  state.invuln = 1.2;
  state.shake = 0.7;
  burst(e.mesh.position, 70, 12, [2.4, 0.4, 2.0], 0.9);
  sfx.hit();
  ui.flash.classList.add('on');
  setTimeout(() => ui.flash.classList.remove('on'), 60);
  if (state.shield <= 0) { state.shield = 0; gameOver(); }
}

function onCollect(e) {
  director.onEvent({ type: 'fruit', collected: true });
  state.combo++;
  state.score += 25 * multiplier();
  burst(e.mesh.position, 18, 6, [2.4, 1.7, 0.4], 0.5);
  sfx.collect(state.combo);
}

function onGate(e) {
  const shieldBefore = state.shield;
  state.shield = Math.min(100, state.shield + 15);
  const kavachRepaired = state.shield > shieldBefore;
  if (e.rescue) {
    // Rescue gates only repair the shield: no points, no combo.
    burst(e.mesh.position, 90, 10, [0.4, 2.0, 2.6], 0.9);
    sfx.gate();
    if (kavachRepaired) toast('KAVACH REPAIRED', '#ffd166');
    return;
  }
  state.combo += 2;
  const pts = 100 * multiplier();
  state.score += pts;
  burst(e.mesh.position, 90, 10, [0.4, 2.0, 2.6], 0.9);
  sfx.gate();
  if (e.variant === 'seeta' && state.powerCharges < 3) {
    state.powerCharges++;
    updatePowerBar();
    toast('SHAKTI REFILLED', '#ff263f');
  } else if (e.variant === 'ram' && kavachRepaired) {
    toast('KAVACH REPAIRED', '#ffd166');
  } else {
    toast(`GATE +${pts}`, '#46f1ff');
  }
}

// ---------- Input ----------
const input = { px: 0, py: 0, pointer: false, boost: false, keys: new Set() };
const target = new THREE.Vector2(0, MID_Y);

function onPointer(e) {
  input.px = (e.clientX / innerWidth) * 2 - 1;
  input.py = -((e.clientY / innerHeight) * 2 - 1);
  input.pointer = true;
}
window.addEventListener('pointermove', onPointer);
window.addEventListener('pointerdown', onPointer);
canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 0) input.boost = true;
});
window.addEventListener('pointerup', (event) => {
  if (event.button === 0) input.boost = false;
});
window.addEventListener('pointercancel', () => { input.boost = false; });
canvas.addEventListener('dblclick', (event) => {
  event.preventDefault();
  clearObstacles();
});
ui.power.addEventListener('pointerdown', (event) => event.stopPropagation());
ui.power.addEventListener('click', (event) => {
  event.stopPropagation();
  clearObstacles();
});

const MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyX'];
window.addEventListener('keydown', (e) => {
  if (MOVE_KEYS.includes(e.code)) e.preventDefault();
  input.keys.add(e.code);
  if (e.code === 'KeyP' || e.code === 'Escape') setPaused(state.mode === 'playing');
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyX' && !e.repeat) clearObstacles();
  if (e.code === 'Backquote' && !e.repeat) debugOverlay.toggle();
  if ((e.code === 'Enter' || e.code === 'Space') && (state.mode === 'menu' || state.mode === 'over') && !e.repeat) startGame();
});
window.addEventListener('keyup', (e) => input.keys.delete(e.code));
window.addEventListener('blur', () => {
  input.keys.clear();
  input.boost = false;
});
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
// Leaving mid-run counts as quitting; the model is saved locally either way.
window.addEventListener('pagehide', () => {
  if (state.mode === 'playing' || state.mode === 'paused') {
    director.onEvent({ type: 'run_end', duration: state.runTime, score: Math.floor(state.score), cause: 'quit' });
  } else {
    director.onEvent({ type: 'session_end' });
  }
  director.save();
});

// Classic mode (no personalisation) and Reset learning, shown on the menu and game-over panels.
const classicToggles = document.querySelectorAll('.classic-mode');
classicToggles.forEach((box) => {
  box.checked = director.model.classic;
  box.addEventListener('change', () => {
    director.setClassic(box.checked);
    classicToggles.forEach((other) => { other.checked = box.checked; });
    showBest();
  });
});
document.querySelectorAll('.reset-learning').forEach((button) => {
  button.addEventListener('click', () => {
    if (!confirm('Forget everything the game has learned about how you fly?')) return;
    director.reset();
    button.textContent = 'Learning reset ✓';
    setTimeout(() => { button.textContent = 'Reset learning'; }, 2000);
  });
});

ui.start.addEventListener('click', startGame);
ui.restart.addEventListener('click', startGame);
ui.resume.addEventListener('click', () => setPaused(false));
ui.mute.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });

// ---------- Per-frame updates ----------
let prevX = 0, prevY = 0;

function updateShip(dt, t) {
  if (state.mode === 'menu') {
    target.set(Math.sin(t * 0.55) * 5.5, 3.6 + Math.sin(t * 0.9) * 1.6);
  } else if (state.mode === 'playing') {
    const k = input.keys;
    const kx = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    const ky = (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0) - (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
    if (kx || ky) {
      input.pointer = false;
      target.x += kx * 18 * dt;
      target.y += ky * 12 * dt;
    } else if (input.pointer) {
      target.x = input.px * BOUNDS.x * 1.15;
      target.y = MID_Y + input.py * HALF_Y * 1.25;
    }
    target.x = clamp(target.x, -BOUNDS.x, BOUNDS.x);
    target.y = clamp(target.y, BOUNDS.yMin, BOUNDS.yMax);
  } else {
    return;
  }

  const follow = 1 - Math.exp(-(state.mode === 'playing' ? director.steeringFollow() : 8) * dt);
  ship.position.x += (target.x - ship.position.x) * follow;
  ship.position.y += (target.y - ship.position.y) * follow;
  const vx = (ship.position.x - prevX) / Math.max(dt, 1e-4);
  const vy = (ship.position.y - prevY) / Math.max(dt, 1e-4);
  prevX = ship.position.x; prevY = ship.position.y;
  shipVel.x = vx; shipVel.y = vy;

  const bank = 1 - Math.exp(-10 * dt);
  ship.rotation.z += (clamp(-vx * 0.06, -0.9, 0.9) - ship.rotation.z) * bank;
  ship.rotation.x += (clamp(vy * 0.045, -0.5, 0.5) - ship.rotation.x) * bank;
  ship.position.y += Math.sin(t * 2.2) * 0.004;

  if (state.invuln > 0) {
    state.invuln -= dt;
    ship.visible = Math.floor(state.invuln * 14) % 2 === 0 || state.invuln <= 0;
  } else {
    ship.visible = true;
  }

  // Trails
  ship.localToWorld(_v.copy(ENGINE_LOCAL));
  for (let i = 0; i < 2; i++) {
    emit(_v.x + rand(-0.08, 0.08), _v.y + rand(-0.08, 0.08), _v.z, rand(-0.4, 0.4), rand(-0.4, 0.4), rand(3, 6), 0.38, 0.8, 0.4, 0.16);
  }
}

function updateEntities(dt, dz, t) {
  const sp = ship.position;
  const playing = state.mode === 'playing';
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    const m = e.mesh;
    const zOld = m.position.z;
    m.position.z += dz;
    const zNew = m.position.z;
    const zc = clamp(sp.z, zOld, zNew) - sp.z; // swept z distance (no tunneling at high speed)

    if (e.type === 'crystal') {
      m.rotation.y += e.spin * dt;
      if (playing) {
        const dx = (m.position.x - sp.x) / (e.rx + 1.0);
        const dy = (m.position.y - sp.y) / (e.ry + 0.3);
        const dzn = zc / (e.rx + 0.8);
        const d2 = dx * dx + dy * dy + dzn * dzn; // < 1 means inside the collision ellipsoid
        if (state.invuln <= 0 && d2 < 1) { reportObstacle(e, 'hit'); onHit(e); removeAt(i); continue; }
        const outcome = classifyObstaclePass(e, { zc, rx: e.rx, d2, invuln: state.invuln });
        if (outcome !== null) reportObstacle(e, outcome);
      }
    } else if (e.type === 'orb') {
      const fruit = m.children[m.userData.fruitIndex];
      fruit.rotation.x += dt * 1.7;
      fruit.rotation.y += dt * 2.3;
      m.scale.setScalar(1 + 0.15 * Math.sin(t * 6 + e.phase));
      if (playing) {
        const dx = sp.x - m.position.x, dy = sp.y - e.baseY;
        if (Math.abs(m.position.z) < 9 && dx * dx + dy * dy < 20) {
          const pull = 1 - Math.exp(-6 * dt);
          m.position.x += dx * pull;
          e.baseY += dy * pull;
        }
      }
      m.position.y = e.baseY + Math.sin(t * 3 + e.phase) * 0.22;
      if (playing) {
        const dx = sp.x - m.position.x, dy = sp.y - m.position.y;
        if (dx * dx + dy * dy + zc * zc < 1.9) { onCollect(e); removeAt(i); continue; }
      }
    } else if (e.type === 'ring') {
      const activeIndex = e.variant === 'ram' ? 0 : 1;
      m.children[activeIndex].children[0].rotation.z += dt * 0.9;
      m.scale.setScalar(1 + 0.04 * Math.sin(t * 5));
      if (playing && !e.passed && zOld < sp.z && zNew >= sp.z) {
        e.passed = true;
        const dx = sp.x - m.position.x, dy = sp.y - m.position.y;
        const through = dx * dx + dy * dy < 2.1 * 2.1;
        director.onEvent({ type: 'gate', passed: through, variant: e.variant });
        if (through) onGate(e);
      }
    }

    if (zNew > DESPAWN_Z) {
      if (playing && e.type === 'orb') director.onEvent({ type: 'fruit', collected: false });
      removeAt(i);
    }
  }
}

function reportObstacle(e, outcome) {
  director.onEvent({
    type: 'obstacle_pass', features: e.features, side: e.side, outcome, theme: e.stormTheme,
    waveId: e.waveId,
  });
}

function updateStreaks(dz) {
  for (let i = 0; i < STREAKS; i++) {
    const i3 = i * 3;
    streakPos[i3 + 2] += dz * 1.15;
    if (streakPos[i3 + 2] > 12) {
      streakPos[i3 + 2] -= 172;
      streakPos[i3] = rand(-30, 30);
      streakPos[i3 + 1] = rand(-1, 16);
    }
  }
  streakGeo.attributes.position.needsUpdate = true;
}

const camBase = new THREE.Vector2(0, 4.5);
const lookTarget = new THREE.Vector3();
function updateCamera(dt) {
  const k = 1 - Math.exp(-4 * dt);
  camBase.x += (ship.position.x * 0.55 - camBase.x) * k;
  camBase.y += (2.4 + ship.position.y * 0.55 - camBase.y) * k;
  camera.position.set(camBase.x, camBase.y, 9.5);
  if (state.shake > 0) {
    state.shake = Math.max(0, state.shake - dt * 1.6);
    const s = state.shake * state.shake * 0.8;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
  lookTarget.set(ship.position.x * 0.75, ship.position.y * 0.7 + 0.4, -14);
  camera.lookAt(lookTarget);
  camera.rotateZ(ship.rotation.z * 0.15);
  const fov = 66 + (state.speed - 26) * 0.17;
  camera.fov += (fov - camera.fov) * k;
  camera.updateProjectionMatrix();
}

let lastMult = 0;
let lastScoreText = '';
function updateHud() {
  if (state.mode !== 'playing') return;
  const s = Math.floor(state.score).toLocaleString();
  if (s !== lastScoreText) { ui.score.textContent = s; lastScoreText = s; }
  const m = multiplier();
  if (m !== lastMult) {
    ui.mult.textContent = m > 1 ? `×${m}` : '';
    ui.mult.classList.remove('bump');
    void ui.mult.offsetWidth;
    if (m > lastMult && m > 1) {
      ui.mult.classList.add('bump');
      if (m >= 4) toast(`MULTIPLIER ×${m}`, '#ffd166');
    }
    lastMult = m;
  }
  ui.shield.style.width = `${state.shield}%`;
  ui.shield.classList.toggle('low', state.shield <= 34);
  updatePowerBar();
  ui.power.disabled = state.mode !== 'playing';
}

// ---------- Main loop ----------
const clock = new THREE.Clock();
let t = 0;
let lastBoost = false;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.mode === 'paused') { composer.render(); return; }
  t += dt;

  let targetSpeed = 26;
  if (state.mode === 'playing') {
    state.runTime += dt;
    if (state.runTime >= nextRiverChange) {
      changeRiverStyle();
      nextRiverChange = state.runTime + director.regionInterval();
    }
    updateRiverStyle(dt);
    targetSpeed = (38 + difficulty() * 55) * director.speedMultiplier();
    if (input.boost) targetSpeed += 32;
    if (input.boost !== lastBoost) { lastBoost = input.boost; director.onEvent({ type: 'boost', on: lastBoost }); }
  } else if (state.mode === 'dying' || state.mode === 'over') {
    targetSpeed = 12;
  }
  state.speed += (targetSpeed - state.speed) * (1 - Math.exp(-2 * dt));
  const dz = state.speed * dt;

  if (state.mode === 'playing') {
    state.dist += dz;
    state.score += dz * 0.1;
    if (state.dist >= state.nextSpawn) {
      spawnWave();
      state.nextSpawn = state.dist + THREE.MathUtils.lerp(70, 34, difficulty()) * director.spawnGapMultiplier();
    }
  }

  terrainMat.uniforms.uOffset.value += dz;
  updateScenery(dt, dz);
  updateShip(dt, t);
  updateEntities(dt, dz, t);
  director.tick(dt, { playing: state.mode === 'playing', ship: shipCtx(), target, boost: input.boost });
  debugOverlay.update(dt);
  updateParticles(dt, dz);
  updateStreaks(dz);
  updateCamera(dt);
  updateHud();

  composer.render();
}
frame();

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
});
