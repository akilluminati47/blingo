import * as THREE from './libs/three.module.js';

/* =========================================================
   BLINGO - infinite-map zombie shooter
   - chunked procedural world w/ rolling terrain + graded town
   - loot crates (glow -> shrink -> respawn elsewhere)
   - gang-beasts style wobbly blob characters
   - Blingo + 5 immune cousins: pick one, recruit the rest
   - inputs: free-aim mouse+kb, touch (Roblox style), gamepad w/ rumble
   ========================================================= */

// ---------- renderer / scene ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const SKY = 0x2b3350;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 28, 105);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 300);

const hemi = new THREE.HemisphereLight(0x8fa3d0, 0x2e2a22, 0.9);
scene.add(hemi);
const moon = new THREE.DirectionalLight(0xaebfff, 0.8);
moon.position.set(-30, 50, -20);
scene.add(moon);
const warm = new THREE.AmbientLight(0x64513a, 0.35);
scene.add(warm);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- utils ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const WORLD_SEED = 1337;
function chunkRng(cx, cz) {
  let h = WORLD_SEED ^ Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return mulberry32(h ^ h >>> 16);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const TAU = Math.PI * 2;
function angLerp(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// ---------- terrain height ----------
function vhash(ix, iz) {
  let h = Math.imul(ix, 127413) ^ Math.imul(iz, 311989) ^ WORLD_SEED;
  h = Math.imul(h ^ h >>> 13, 0x5bd1e995);
  return ((h ^ h >>> 15) >>> 0) / 4294967295;
}
function vnoise(x, z, s) {
  const fx = x / s, fz = z / s;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const sx = smooth(fx - ix), sz = smooth(fz - iz);
  return lerp(
    lerp(vhash(ix, iz), vhash(ix + 1, iz), sx),
    lerp(vhash(ix, iz + 1), vhash(ix + 1, iz + 1), sx), sz);
}
// distance from a coordinate to nearest road centerline (roads repeat every 120 at offset -17)
function roadAxisDist(v) {
  let m = ((v + 17) % 120 + 120) % 120;
  return Math.min(m, 120 - m);
}
// town footprint rectangles [x0,z0,x1,z1] - flattened terrain + no random spawns inside
const TOWN_RECTS = [
  [-16, -60, 110, 6],  // main street, shops, bank + fountain pavilion, town hall, courthouse
  [8, 12, 78, 64],     // shopping plaza + parking
  [36, -16, 46, 18],   // plaza driveway
];
function rectDist(x, z, r) {
  const dx = Math.max(r[0] - x, 0, x - r[2]);
  const dz = Math.max(r[1] - z, 0, z - r[3]);
  return Math.hypot(dx, dz);
}
function inTown(x, z, margin = 0) {
  for (const r of TOWN_RECTS) if (rectDist(x, z, r) <= margin) return true;
  return false;
}
function groundHeight(x, z) {
  const base = (vnoise(x, z, 57) - 0.5) * 3.4 + (vnoise(x, z, 23) - 0.5) * 1.1 + (vnoise(x, z, 131) - 0.5) * 2.2;
  const dr = Math.min(roadAxisDist(x), roadAxisDist(z));
  let f = smooth(clamp((dr - 6.7) / 10, 0, 1)); // graded flat near roads
  let td = Infinity;
  for (const r of TOWN_RECTS) td = Math.min(td, rectDist(x, z, r));
  f = Math.min(f, smooth(clamp((td - 1) / 12, 0, 1))); // graded flat in town
  return base * (0.12 + 0.88 * f);
}
// roads are two-way now: a lane each direction, 12.8 wide in total
function onRoad(x, z, margin = 0) {
  return roadAxisDist(x) < 6.4 + margin || roadAxisDist(z) < 6.4 + margin;
}

// shared materials/geometries
const MAT = {};
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!MAT[key]) MAT[key] = new THREE.MeshLambertMaterial({ color, ...opts });
  return MAT[key];
}
const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(1, 14, 12);
function box(w, h, d, color, opts) { const m = new THREE.Mesh(BOX, mat(color, opts)); m.scale.set(w, h, d); return m; }
function ball(r, color, opts) { const m = new THREE.Mesh(SPHERE, mat(color, opts)); m.scale.setScalar(r); return m; }
function cyl(r1, r2, h, color, sides = 8) { return new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, sides), mat(color)); }

// canvas texture helpers
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const shingleTex = canvasTex(128, 128, ctx => {
  ctx.fillStyle = '#6e392c'; ctx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 12) {
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, y + 10, 128, 2);
    const off = (y / 12) % 2 ? 8 : 0;
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    for (let x = off; x < 128; x += 16) ctx.fillRect(x, y, 2, 10);
  }
});
shingleTex.wrapS = shingleTex.wrapT = THREE.RepeatWrapping;
const roofMats = [
  new THREE.MeshLambertMaterial({ map: shingleTex }),
  new THREE.MeshLambertMaterial({ map: shingleTex, color: 0x9a9aa8 }),
  new THREE.MeshLambertMaterial({ map: shingleTex, color: 0x7a8a6a }),
];
const darkGlassMat = new THREE.MeshLambertMaterial({ color: 0x11131a, side: THREE.DoubleSide });
const glowTex = canvasTex(64, 64, ctx => {
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,220,120,1)');
  g.addColorStop(1, 'rgba(255,220,120,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
});
function textPlate(txt, w, h, bg = '#3a3128', fg = '#ffe9c0') {
  const t = canvasTex(256, 64, ctx => {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = fg; ctx.lineWidth = 3; ctx.strokeRect(4, 4, 248, 56);
    ctx.fillStyle = fg; ctx.font = 'bold 30px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, 128, 34);
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: t }));
}

// ---------- sky, time-of-day & weather ----------
// four times of day, cycled morning -> noon -> sunset -> night as blocks are cleared
// (the heroes never stop rescuing); weather rerolls each cycle: 40% sunny / 40% cloudy / 20% rain
const PHASES = [
  { name: 'MORNING', top: '#6f9fd8', mid: '#f2c58e', hor: '#ffd9a8', sun: '#fff0c4', sunV: 0.40, sunR: 34,
    hemiSky: 0xbfd4ee, hemiGnd: 0x4a4436, hemiI: 0.95, dirC: 0xffe2ae, dirI: 0.9, dirPos: [40, 26, 55], ambC: 0x8a7458, ambI: 0.42, fog: '#c7ad91' },
  { name: 'NOON', top: '#2e6fc9', mid: '#7ab5ea', hor: '#cde6f8', sun: '#ffffff', sunV: 0.12, sunR: 30,
    hemiSky: 0xd8e8ff, hemiGnd: 0x5a5442, hemiI: 1.1, dirC: 0xfff6e0, dirI: 1.0, dirPos: [12, 70, 18], ambC: 0x9a8a70, ambI: 0.42, fog: '#a9c3dd' },
  { name: 'SUNSET', top: '#413a6e', mid: '#d96a4c', hor: '#ffb35c', sun: '#ffcf9a', sunV: 0.44, sunR: 40,
    hemiSky: 0xd8a080, hemiGnd: 0x3a3040, hemiI: 0.85, dirC: 0xff9a5c, dirI: 0.8, dirPos: [-55, 16, 22], ambC: 0x7a5a48, ambI: 0.38, fog: '#8a5f52' },
  { name: 'NIGHT', top: '#0a0e22', mid: '#1c2440', hor: '#2b3350', sun: '#dfe8ff', sunV: 0.30, sunR: 22, stars: true,
    hemiSky: 0x8fa3d0, hemiGnd: 0x2e2a22, hemiI: 0.75, dirC: 0xaebfff, dirI: 0.7, dirPos: [-30, 50, -20], ambC: 0x64513a, ambI: 0.32, fog: '#232a45' },
];
function rollWeather() { const r = Math.random(); return r < 0.4 ? 'sunny' : r < 0.8 ? 'cloudy' : 'rain'; }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
const skyCanvas = document.createElement('canvas');
skyCanvas.width = 1024; skyCanvas.height = 512;
const skyTex = new THREE.CanvasTexture(skyCanvas);
skyTex.colorSpace = THREE.SRGBColorSpace;
skyTex.flipY = false; // canvas top = zenith, middle row = horizon
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(240, 24, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
);
skyDome.renderOrder = -10;
scene.add(skyDome);
const moonOff = new THREE.Vector3(-30, 50, -20); // key-light offset, follows the player
function drawSky(p, weather) {
  const ctx = skyCanvas.getContext('2d');
  const W = skyCanvas.width, H = skyCanvas.height;
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.56);
  g.addColorStop(0, p.top); g.addColorStop(0.72, p.mid); g.addColorStop(1, p.hor);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.56);
  ctx.fillStyle = p.hor; ctx.fillRect(0, H * 0.55, W, H * 0.45);
  ctx.fillStyle = 'rgba(28,28,34,.5)'; ctx.fillRect(0, H * 0.58, W, H * 0.42); // haze below the horizon
  if (p.stars && weather === 'sunny') {
    const srng = mulberry32(42);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 170; i++) {
      ctx.globalAlpha = 0.25 + srng() * 0.75;
      ctx.fillRect(srng() * W, srng() * H * 0.5, srng() < 0.12 ? 2 : 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  if (weather !== 'rain') {
    // sun (moon at night) with a soft halo
    const sx = W * 0.72, sy = H * p.sunV, r = p.sunR;
    const halo = ctx.createRadialGradient(sx, sy, 1, sx, sy, r * 3.2);
    halo.addColorStop(0, hexA(p.sun, 0.9)); halo.addColorStop(0.3, hexA(p.sun, 0.35)); halo.addColorStop(1, hexA(p.sun, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(sx - r * 3.2, sy - r * 3.2, r * 6.4, r * 6.4);
    ctx.fillStyle = p.sun;
    ctx.beginPath(); ctx.arc(sx, sy, r * (weather === 'cloudy' ? 0.75 : 1), 0, TAU); ctx.fill();
  }
  // clouds: a few white puffs when sunny, a grey blanket when cloudy, dark rollers in rain
  const crng = mulberry32(7 + game.cycle * 31 + game.phase);
  const night = !!p.stars;
  const nC = weather === 'sunny' ? 5 : weather === 'cloudy' ? 24 : 32;
  for (let i = 0; i < nC; i++) {
    const cx2 = crng() * W, cy2 = (0.14 + crng() * 0.34) * H;
    const cw2 = 50 + crng() * 130, chh = 10 + crng() * 16;
    ctx.fillStyle = night
      ? (weather === 'sunny' ? 'rgba(52,60,86,.7)' : 'rgba(30,34,52,.85)')
      : weather === 'sunny' ? 'rgba(255,255,255,.55)'
      : weather === 'cloudy' ? 'rgba(208,212,220,.8)'
      : 'rgba(88,94,106,.85)';
    for (let k2 = 0; k2 < 4; k2++) {
      ctx.beginPath();
      ctx.ellipse(cx2 + (crng() - 0.5) * cw2, cy2 + (crng() - 0.5) * chh, cw2 * (0.3 + crng() * 0.3), chh * (0.6 + crng() * 0.6), 0, 0, TAU);
      ctx.fill();
    }
  }
  if (weather === 'cloudy') { ctx.fillStyle = 'rgba(148,153,163,.25)'; ctx.fillRect(0, 0, W, H); }
  if (weather === 'rain') { ctx.fillStyle = 'rgba(66,72,84,.45)'; ctx.fillRect(0, 0, W, H); }
  skyTex.needsUpdate = true;
}
// live wind: direction & strength drift over time, gusting harder in worse weather.
// rain streaks lean and drift with it, and the wind bed swells/pans to match.
let windYaw = Math.random() * TAU, windTgtYaw = windYaw, windStr = 0.4, windTgtStr = 0.4, windShiftT = 0;
function updateWind(dt) {
  windShiftT -= dt;
  if (windShiftT <= 0) {
    windShiftT = 5 + Math.random() * 7;
    windTgtYaw = Math.random() * TAU;
    windTgtStr = game.weather === 'rain' ? 0.45 + Math.random() * 0.55
      : game.weather === 'cloudy' ? 0.3 + Math.random() * 0.45
      : 0.15 + Math.random() * 0.3;
  }
  windYaw = angLerp(windYaw, windTgtYaw, 1 - Math.exp(-0.5 * dt));
  windStr = lerp(windStr, windTgtStr, 1 - Math.exp(-0.7 * dt));
  if (windGainNode) {
    const base = game.weather === 'rain' ? 0.75 : game.weather === 'cloudy' ? 0.55 : 0.3;
    windGainNode.gain.value = base * (0.5 + windStr * 0.9);
    if (windPanNode) windPanNode.pan.value = clamp(Math.sin(windYaw - player.camYaw), -1, 1) * 0.7;
  }
}

// rain: recycled line streaks falling around the player
const RAIN_N = 260;
let rainMesh = null;
function rainOn(on) {
  if (on && !rainMesh) {
    const pos = new Float32Array(RAIN_N * 6);
    for (let i = 0; i < RAIN_N; i++) {
      const x = (Math.random() - 0.5) * 56, y = Math.random() * 26, z = (Math.random() - 0.5) * 56;
      pos.set([x, y, z, x + 0.12, y - 0.9, z], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rainMesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9db4cc, transparent: true, opacity: 0.4 }));
    rainMesh.frustumCulled = false;
    scene.add(rainMesh);
  } else if (!on && rainMesh) {
    scene.remove(rainMesh);
    rainMesh.geometry.dispose();
    rainMesh = null;
  }
}
function updateRain(dt) {
  if (!rainMesh) return;
  const a = rainMesh.geometry.attributes.position;
  const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
  // drops drift with the wind and the streaks lean along their true velocity
  const wx = Math.sin(windYaw) * windStr * 11, wz = Math.cos(windYaw) * windStr * 11;
  for (let i = 0; i < RAIN_N; i++) {
    let y = a.getY(i * 2) - 34 * dt;
    let x = a.getX(i * 2) + wx * dt, z = a.getZ(i * 2) + wz * dt;
    if (y < py - 3) {
      y = py + 20 + Math.random() * 6;
      x = px + (Math.random() - 0.5) * 56;
      z = pz + (Math.random() - 0.5) * 56;
    }
    a.setXYZ(i * 2, x, y, z);
    a.setXYZ(i * 2 + 1, x + wx * 0.035, y - 0.92, z + wz * 0.035);
  }
  a.needsUpdate = true;
}
function applyEnvironment() {
  const p = PHASES[game.phase] || PHASES[0];
  const w = game.weather || 'sunny';
  drawSky(p, w);
  const dimD = w === 'sunny' ? 1 : w === 'cloudy' ? 0.55 : 0.35;
  const dimH = w === 'sunny' ? 1 : w === 'cloudy' ? 0.85 : 0.7;
  hemi.color.set(p.hemiSky); hemi.groundColor.set(p.hemiGnd); hemi.intensity = p.hemiI * dimH;
  moon.color.set(p.dirC); moon.intensity = p.dirI * dimD;
  moonOff.set(p.dirPos[0], p.dirPos[1], p.dirPos[2]);
  warm.color.set(p.ambC); warm.intensity = p.ambI;
  const fogC = new THREE.Color(p.fog);
  if (w === 'cloudy') fogC.lerp(new THREE.Color(0x9aa0aa), 0.4);
  if (w === 'rain') fogC.lerp(new THREE.Color(0x5c636e), 0.6);
  scene.fog.color.copy(fogC);
  scene.fog.near = w === 'rain' ? 16 : w === 'cloudy' ? 24 : 28;
  scene.fog.far = w === 'rain' ? 70 : w === 'cloudy' ? 92 : 105;
  scene.background = fogC.clone();
  rainOn(w === 'rain');
  syncWeatherAmbience();
}

// fake blob shadow
const shadowGeo = new THREE.CircleGeometry(1, 20);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
function makeShadow(r) {
  const s = new THREE.Mesh(shadowGeo, shadowMat);
  s.rotation.x = -Math.PI / 2; s.scale.setScalar(r); s.position.y = 0.02; s.renderOrder = 1;
  return s;
}

// ---------- settings (5-notch bars in the pause menu, persisted) ----------
// notches: integer 0..5 per setting. `settings` holds the derived engine values.
const NOTCH_KEYS = ['master', 'sfx', 'music', 'ambience', 'mouseSens', 'padSens', 'zombieSpawn', 'lootSpawn', 'gore', 'extraGore'];
const notches = { master: 3, sfx: 5, music: 3, ambience: 2, mouseSens: 3, padSens: 3, zombieSpawn: 2, lootSpawn: 2, gore: 3, extraGore: 0 };
try {
  const saved = JSON.parse(localStorage.getItem('blingo-notches') || '{}');
  for (const k of NOTCH_KEYS) if (Number.isInteger(saved[k]) && saved[k] >= 0 && saved[k] <= 5) notches[k] = saved[k];
} catch (e) {}
const SENS_MULT = [0.5, 0.5, 0.75, 1, 1.4, 1.9];
const SPAWN_MULT = [0, 0.5, 1, 1.6, 2.2, 3];
const settings = {};
function syncDerived() {
  settings.master = notches.master / 5;
  settings.sfx = notches.sfx / 5;
  settings.music = notches.music / 5;
  settings.ambience = notches.ambience / 5;
  settings.mouseSens = SENS_MULT[notches.mouseSens];
  settings.padSens = SENS_MULT[notches.padSens];
  settings.zombieSpawn = SPAWN_MULT[notches.zombieSpawn];
  settings.lootSpawn = SPAWN_MULT[notches.lootSpawn];
  settings.gore = notches.gore / 5;
  settings.extraGore = notches.extraGore / 5;
}
syncDerived();

// ---------- audio (procedural, 3D) ----------
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, masterGain = null, sfxGain = null, musicGain = null, ambGain = null;
let sfxDest = null;
function initAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  actx = new AC();
  masterGain = actx.createGain(); masterGain.gain.value = settings.master; masterGain.connect(actx.destination);
  sfxGain = actx.createGain(); sfxGain.gain.value = settings.sfx; sfxGain.connect(masterGain);
  musicGain = actx.createGain(); musicGain.gain.value = settings.music; musicGain.connect(masterGain);
  ambGain = actx.createGain(); ambGain.gain.value = settings.ambience; ambGain.connect(masterGain);
  startAmbience();
}
function applyAudioSettings() {
  if (!actx) return;
  masterGain.gain.value = settings.master;
  sfxGain.gain.value = settings.sfx;
  musicGain.gain.value = settings.music;
  ambGain.gain.value = settings.ambience;
}
function noiseBurst(dur, freq, vol, type = 'lowpass') {
  if (!actx) return;
  const n = actx.sampleRate * dur, buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = actx.createBufferSource(); src.buffer = buf;
  const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = actx.createGain(); g.gain.setValueAtTime(vol, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
  src.connect(f); f.connect(g); g.connect(sfxDest || sfxGain); src.start();
}
function tone(freq, dur, vol, type = 'sine', slideTo, dest) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, actx.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, actx.currentTime + dur);
  g.gain.setValueAtTime(vol, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
  o.connect(g); g.connect(dest || sfxDest || sfxGain); o.start(); o.stop(actx.currentTime + dur);
}
// route the next SFX call through a stereo-panned, distance-attenuated bus (3D sound)
function busFor(x, z) {
  const g = actx.createGain();
  const rx = x - camera.position.x, rz = z - camera.position.z;
  const dist = Math.hypot(rx, rz);
  g.gain.value = clamp(1 - dist / 55, 0.05, 1);
  if (actx.createStereoPanner) {
    const pan = actx.createStereoPanner();
    const cy = player.camYaw;
    const rightX = Math.cos(cy), rightZ = -Math.sin(cy);
    const p = (rx * rightX + rz * rightZ) / Math.max(dist, 0.001);
    pan.pan.value = clamp(p * clamp(dist / 6, 0, 1), -1, 1);
    g.connect(pan); pan.connect(sfxGain);
  } else g.connect(sfxGain);
  return g;
}
function play3d(x, z, fn) { if (!actx) return; sfxDest = busFor(x, z); fn(); sfxDest = null; }
const SFX = {
  shoot(w) {
    if (w.id === 'shotgun') { noiseBurst(0.28, 900, 0.9); tone(90, 0.15, 0.4, 'square', 40); }
    else if (w.id === 'sniper') { noiseBurst(0.4, 1400, 0.9); tone(140, 0.3, 0.35, 'sawtooth', 50); }
    else if (w.id === 'magnum') { noiseBurst(0.22, 1100, 0.8); tone(120, 0.16, 0.4, 'square', 45); }
    else if (w.melee) {
      if (w.id === 'fists') { noiseBurst(0.08, 500, 0.3); }               // soft whiff
      else { noiseBurst(0.09, 340, 0.42); tone(160, 0.08, 0.18, 'square', 80); } // swing whoosh + thud
    }
    else { noiseBurst(0.12, 1800, 0.55); tone(180, 0.07, 0.25, 'square', 70); }
  },
  hit() { noiseBurst(0.08, 700, 0.4); tone(220, 0.06, 0.2, 'square', 120); },
  hurt() { tone(160, 0.25, 0.4, 'sawtooth', 60); },
  groan() { tone(70 + Math.random() * 50, 0.5, 0.12, 'sawtooth', 45); },
  reload() { tone(700, 0.05, 0.2, 'square'); setTimeout(() => tone(900, 0.05, 0.2, 'square'), 130); },
  // distinct mechanical "chk-chk" per gun when you cycle to it
  swap(w) {
    const id = w && w.id;
    if (id === 'shotgun') { noiseBurst(0.05, 260, 0.4); tone(150, 0.07, 0.3, 'square', 90); setTimeout(() => { noiseBurst(0.05, 220, 0.45); tone(110, 0.08, 0.32, 'square', 70); }, 120); }
    else if (id === 'sniper') { tone(320, 0.05, 0.28, 'square', 180); setTimeout(() => tone(240, 0.09, 0.3, 'sawtooth', 120), 150); }
    else if (id === 'magnum') { tone(520, 0.04, 0.28, 'triangle', 700); setTimeout(() => { noiseBurst(0.04, 500, 0.3); tone(180, 0.06, 0.3, 'square', 110); }, 110); }
    else if (id === 'rifle') { noiseBurst(0.04, 900, 0.3); tone(400, 0.05, 0.28, 'square', 260); setTimeout(() => tone(300, 0.06, 0.3, 'square', 200), 90); }
    else if (id === 'smg') { tone(680, 0.03, 0.26, 'square', 520); setTimeout(() => tone(560, 0.03, 0.26, 'square', 440), 60); setTimeout(() => tone(760, 0.03, 0.24, 'square', 600), 120); }
    else if (id === 'pistol') { tone(760, 0.04, 0.28, 'square', 560); setTimeout(() => tone(600, 0.05, 0.3, 'square', 440), 80); }
    else { noiseBurst(0.05, 320, 0.25); } // fists: soft whoosh
  },
  crate() { tone(300, 0.1, 0.3, 'triangle', 500); setTimeout(() => tone(600, 0.15, 0.3, 'triangle', 900), 100); },
  pickup() { tone(500, 0.08, 0.25, 'sine', 800); },
  jump() { tone(250, 0.12, 0.15, 'sine', 420); },
  dry() { tone(1000, 0.04, 0.15, 'square'); },
  splat() { noiseBurst(0.15, 300, 0.5); },
  recruit() { tone(400, 0.12, 0.3, 'triangle', 600); setTimeout(() => tone(600, 0.18, 0.3, 'triangle', 900), 120); },
  step(hard) { noiseBurst(0.05, hard ? 230 : 150, hard ? 0.16 : 0.09); },
  headpop() { noiseBurst(0.16, 420, 0.75); tone(140, 0.22, 0.4, 'sawtooth', 50); },
  limb() { noiseBurst(0.2, 360, 0.6); tone(110, 0.16, 0.3, 'square', 60); },
  land() { noiseBurst(0.09, 200, 0.25); },
  slide() { noiseBurst(0.3, 480, 0.32); tone(220, 0.22, 0.12, 'sawtooth', 90); },
};

// ---------- ambience + persona themes ----------
let ambStarted = false;
let windGainNode = null, windPanNode = null, rainGainNode = null;
function startAmbience() {
  if (ambStarted || !actx) return;
  ambStarted = true;
  const mkNoise = () => {
    const n = actx.sampleRate * 3, buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
    return src;
  };
  // wind bed: filtered noise; the live wind sim drives its swell and stereo direction
  const wsrc = mkNoise();
  const wf = actx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 300;
  windGainNode = actx.createGain(); windGainNode.gain.value = 0.35;
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.07;
  const lfoG = actx.createGain(); lfoG.gain.value = 0.1;
  lfo.connect(lfoG); lfoG.connect(windGainNode.gain); lfo.start();
  wsrc.connect(wf); wf.connect(windGainNode);
  if (actx.createStereoPanner) {
    windPanNode = actx.createStereoPanner();
    windGainNode.connect(windPanNode); windPanNode.connect(ambGain);
  } else windGainNode.connect(ambGain);
  wsrc.start();
  // rain bed: bright hiss, silent until a rainy weather roll fades it up
  const rsrc = mkNoise();
  const rf = actx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 900;
  rainGainNode = actx.createGain(); rainGainNode.gain.value = 0;
  rsrc.connect(rf); rf.connect(rainGainNode); rainGainNode.connect(ambGain);
  rsrc.start();
  // each weather roll has its own life on top of the wind bed: sunny = songbirds by
  // day / crickets at night, cloudy = crows + low moaning gusts, rain = distant thunder
  (function weatherLife() {
    setTimeout(() => {
      if (actx) {
        if (game.weather === 'sunny') {
          if (game.phase === 3) {
            for (let i = 0; i < 6; i++) setTimeout(() => tone(3400 + Math.random() * 300, 0.035, 0.05, 'sine', undefined, ambGain), i * 85);
          } else {
            const base = 1800 + Math.random() * 900;
            for (let i = 0; i < 2 + ((Math.random() * 3) | 0); i++) setTimeout(() => tone(base + Math.random() * 500, 0.09, 0.055, 'sine', base - 400, ambGain), i * 170);
          }
        } else if (game.weather === 'cloudy') {
          if (Math.random() < 0.45) {
            for (let i = 0; i < 2 + ((Math.random() * 2) | 0); i++) setTimeout(() => tone(640 + Math.random() * 90, 0.15, 0.06, 'square', 390, ambGain), i * 290); // far-off crows
          } else {
            tone(230 + Math.random() * 90, 2.3, 0.045, 'sine', 115, ambGain); // hollow gust moan
          }
        } else if (Math.random() < 0.45) {
          // rolling thunder somewhere past the fog line
          const f = 52 + Math.random() * 24;
          tone(f, 2.6, 0.16, 'sawtooth', 30, ambGain);
          setTimeout(() => tone(f * 0.7, 1.9, 0.1, 'sawtooth', 26, ambGain), 350 + Math.random() * 450);
        }
      }
      weatherLife();
    }, 3500 + Math.random() * 6500);
  })();
  syncWeatherAmbience();
}
// fade the rain bed with the current weather (wind is driven live by updateWind)
function syncWeatherAmbience() {
  if (!actx || !ambStarted) return;
  rainGainNode.gain.setTargetAtTime(game.weather === 'rain' ? 0.55 : 0, actx.currentTime, 1.2);
}
const NF = s => 220 * Math.pow(2, s / 12);
// each cousin has a persona motif (chiptune-ish MIDI feel)
const THEMES = {
  blingo:  { wave: 'square',   tempo: 0.34, seq: [0, 7, 12, 7, 3, 7, 10, 7], bass: [0, -5] },
  blazo:   { wave: 'sawtooth', tempo: 0.26, seq: [0, 3, 7, 3, 5, 8, 7, 3], bass: [0, 0, -2, -2] },
  blizzy:  { wave: 'sine',     tempo: 0.40, seq: [12, 7, 9, 4, 7, 2, 4, 0], bass: [-12, -7] },
  blomba:  { wave: 'triangle', tempo: 0.46, seq: [0, 4, 7, 4, -1, 4, 5, 4], bass: [-12, -12, -5, -5] },
  bloopy:  { wave: 'square',   tempo: 0.22, seq: [0, 12, 7, 12, 3, 12, 10, 12], bass: [-5, -5] },
  blondie: { wave: 'triangle', tempo: 0.30, seq: [7, 9, 11, 12, 11, 9, 7, 4], bass: [-5, -8] },
};
let themeTimer = null, themeStep = 0;
function startTheme(id) {
  stopTheme();
  if (!actx) return;
  const t = THEMES[id] || THEMES.blingo;
  themeStep = 0;
  const tick = () => {
    // hero music lives in the pause menu / screens; it only plays during
    // gameplay when the music bar is maxed at 5/5 notches
    const audible = actx && (game.state !== 'playing' || notches.music >= 5);
    if (audible) {
      const note = t.seq[themeStep % t.seq.length];
      tone(NF(note), t.tempo * 0.9, 0.13, t.wave, undefined, musicGain);
      if (themeStep % 2 === 0) {
        const b = t.bass[Math.floor(themeStep / 2) % t.bass.length];
        tone(NF(b - 12), t.tempo * 1.6, 0.17, 'triangle', undefined, musicGain);
      }
      themeStep++;
      themeTimer = setTimeout(tick, t.tempo * 1000);
    } else {
      themeTimer = setTimeout(tick, 220); // idle, keep the beat ready
    }
  };
  tick();
}
function stopTheme() { if (themeTimer) { clearTimeout(themeTimer); themeTimer = null; } }
function previewTheme(id) {
  if (!actx) return;
  const t = THEMES[id] || THEMES.blingo;
  for (let i = 0; i < 4; i++) setTimeout(() => tone(NF(t.seq[i]), 0.16, 0.16, t.wave, undefined, musicGain), i * 120);
}

// ---------- rumble ----------
let gpIndex = null;
function rumble(ms, strong = 0.6, weak = 0.4) {
  if (gpIndex === null) return;
  const gp = navigator.getGamepads()[gpIndex];
  const act = gp && gp.vibrationActuator;
  if (!act) return;
  try {
    act.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {});
  } catch (e) {}
}
let shakeAmp = 0;

// ---------- weapons ----------
// cqc = extra close-range damage (fades to 0 by cqcRange metres)
// weak = weapon too puny to reliably pop a healthy head (far/weak headshots expose brain instead)
// dismember = base chance to sever a limb on a hit; gib = head bursts on any headshot (insta-kill)
// mags are arcade-sized (generous). semi-auto guns fire as fast as you can pull the trigger.
// melee: swung, infinite ammo. execute: any hit (limb, chest, head) detonates the target
// in an instant kill. slot: which inventory group the weapon sorts into (melee first, then guns).
const WEAPONS = {
  fists:   { id: 'fists',   name: 'Fists',        melee: true, slot: 'melee', dmg: 42, range: 2.4, rpm: 150, mag: Infinity, kick: 0.02, rmb: [130, 0.9, 0.55], cqc: 0, weak: true, dismember: 0.12 },
  pipe:    { id: 'pipe',    name: 'Lead Pipe',    melee: true, slot: 'melee', dmg: 80, range: 3.1, rpm: 150, mag: Infinity, kick: 0.03, rmb: [80, 0.5, 0.3], cqc: 0, dismember: 0.28, color: 0x8b9099 },
  bat:     { id: 'bat',     name: 'Slugger Bat',  melee: true, slot: 'melee', dmg: 92, range: 3.4, rpm: 130, mag: Infinity, kick: 0.04, rmb: [90, 0.55, 0.35], cqc: 0, dismember: 0.34, color: 0x8a5a2a },
  machete: { id: 'machete', name: 'Machete',      melee: true, slot: 'melee', dmg: 112, range: 3.2, rpm: 155, mag: Infinity, kick: 0.03, rmb: [90, 0.5, 0.4], cqc: 0, dismember: 0.82, color: 0xb7bcc4 },
  katana:  { id: 'katana',  name: 'Katana',       melee: true, slot: 'melee', dmg: 130, range: 3.7, rpm: 175, mag: Infinity, kick: 0.03, rmb: [90, 0.5, 0.4], cqc: 0, dismember: 0.95, gib: true, color: 0xd8dde5 },
  sledge:  { id: 'sledge',  name: 'Sledgehammer', melee: true, slot: 'melee', dmg: 190, range: 3.1, rpm: 72, mag: Infinity, kick: 0.09, rmb: [150, 0.95, 0.5], cqc: 0, dismember: 0.6, gib: true, color: 0x5c6068 },
  axe:     { id: 'axe',     name: 'Fire Axe',     melee: true, slot: 'melee', dmg: 152, range: 3.2, rpm: 96, mag: Infinity, kick: 0.06, rmb: [120, 0.7, 0.45], cqc: 0, dismember: 0.9, gib: true, color: 0xc23a2a },
  pistol:  { id: 'pistol',  name: 'Pistol',       slot: 'gun', dmg: 34, mag: 18, rpm: 320, auto: false, spread: 0.012, ammo: 90,  color: 0x555a66, kick: 0.025, rmb: [60, 0.3, 0.5],  cqc: 0.45, weak: true,  dismember: 0.14 },
  smg:     { id: 'smg',     name: 'SMG',          slot: 'gun', dmg: 15, mag: 50, rpm: 800, auto: true,  spread: 0.038, ammo: 200, color: 0x3a3f4a, kick: 0.015, rmb: [40, 0.2, 0.4],  cqc: 0.5,  weak: true,  dismember: 0.1 },
  rifle:   { id: 'rifle',   name: 'Assault Rifle',slot: 'gun', dmg: 32, mag: 40, rpm: 560, auto: true,  spread: 0.022, ammo: 160, color: 0x51442e, kick: 0.02, rmb: [50, 0.35, 0.5],  cqc: 0.5,  dismember: 0.32 },
  shotgun: { id: 'shotgun', name: 'Shotgun',      slot: 'gun', dmg: 12, mag: 10, rpm: 300, auto: false, spread: 0.11,  ammo: 60, pellets: 12, color: 0x6e3d1f, kick: 0.09, rmb: [150, 1, 0.7], cqc: 2.0, dismember: 0.75, gib: true },
  magnum:  { id: 'magnum',  name: 'Magnum',       slot: 'gun', dmg: 62, mag: 10, rpm: 160, auto: false, spread: 0.008, ammo: 60,  color: 0x8a8f9a, kick: 0.05, rmb: [90, 0.6, 0.5],  cqc: 0.6,  dismember: 0.6, gib: true },
  sniper:  { id: 'sniper',  name: 'Sniper Rifle', slot: 'gun', dmg: 145,mag: 8,  rpm: 45,  auto: false, spread: 0.002, ammo: 40,  color: 0x2f4a35, kick: 0.11, rmb: [180, 1, 0.8],  cqc: 0.2,  dismember: 1, gib: true, execute: true },
};
// inventory slot order: melee group first (fists then found melee by weight), then guns by tier
const SLOT_ORDER = ['fists', 'pipe', 'bat', 'machete', 'katana', 'sledge', 'axe', 'pistol', 'smg', 'rifle', 'shotgun', 'magnum', 'sniper'];
function slotRank(id) { const i = SLOT_ORDER.indexOf(id); return i < 0 ? 99 : i; }
// point-blank damage multiplier for a hit at distance d
function closeBonus(w, d) { return 1 + (w.cqc || 0) * clamp(1 - d / 8, 0, 1); }
const LOOT_TABLE = [
  ['pistol', 20], ['smg', 16], ['shotgun', 15], ['rifle', 13], ['magnum', 9], ['sniper', 5], ['ammo', 14], ['medkit', 8],
];
function rollLoot(rng) {
  let total = 0; for (const [, w] of LOOT_TABLE) total += w;
  let r = rng() * total;
  for (const [id, w] of LOOT_TABLE) { r -= w; if (r <= 0) return id; }
  return 'pistol';
}

function buildGunMesh(id) {
  const g = new THREE.Group();
  const w = WEAPONS[id];
  const c = w.color || 0x444444;
  if (id === 'pistol' || id === 'magnum') {
    const body = box(0.09, 0.13, 0.34, c); body.position.set(0, 0.05, -0.12); g.add(body);
    const grip = box(0.08, 0.18, 0.1, 0x2a2d33); grip.position.set(0, -0.08, 0.06); grip.rotation.x = 0.25; g.add(grip);
  } else if (id === 'smg') {
    const body = box(0.1, 0.14, 0.5, c); body.position.set(0, 0.04, -0.15); g.add(body);
    const magz = box(0.07, 0.22, 0.09, 0x22252b); magz.position.set(0, -0.12, -0.08); g.add(magz);
    const grip = box(0.08, 0.15, 0.09, 0x22252b); grip.position.set(0, -0.09, 0.1); g.add(grip);
  } else if (id === 'shotgun') {
    const body = box(0.1, 0.12, 0.75, 0x3b3e45); body.position.set(0, 0.05, -0.22); g.add(body);
    const pump = box(0.12, 0.1, 0.2, c); pump.position.set(0, -0.02, -0.32); g.add(pump);
    const stock = box(0.09, 0.13, 0.22, c); stock.position.set(0, 0.0, 0.18); g.add(stock);
  } else if (id === 'rifle') {
    const body = box(0.09, 0.13, 0.72, 0x3b3e45); body.position.set(0, 0.05, -0.2); g.add(body);
    const magz = box(0.07, 0.2, 0.11, c); magz.position.set(0, -0.1, -0.1); magz.rotation.x = 0.3; g.add(magz);
    const stock = box(0.08, 0.12, 0.2, c); stock.position.set(0, 0.02, 0.2); g.add(stock);
  } else if (id === 'sniper') {
    // long-barrelled marksman rifle with a proper scope + lens
    const body = box(0.08, 0.12, 1.15, c); body.position.set(0, 0.05, -0.42); g.add(body);
    const barrel = cyl(0.035, 0.035, 0.5, 0x1c1e22); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.06, -0.86); g.add(barrel);
    const brake = cyl(0.06, 0.06, 0.1, 0x2a2c30); brake.rotation.x = Math.PI / 2; brake.position.set(0, 0.06, -1.08); g.add(brake);
    for (const sz of [-0.16, 0.02]) { const mount = box(0.05, 0.09, 0.05, 0x101216); mount.position.set(0, 0.15, sz); g.add(mount); }
    const scope = cyl(0.055, 0.055, 0.42, 0x121317); scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.2, -0.08); g.add(scope);
    const lens = cyl(0.056, 0.056, 0.03, 0x5aa0ff, 10); lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.2, -0.29);
    lens.material = new THREE.MeshBasicMaterial({ color: 0x7fb8ff }); g.add(lens);
    const stock = box(0.08, 0.15, 0.3, 0x2a2318); stock.position.set(0, 0.0, 0.28); g.add(stock);
    const grip = box(0.07, 0.16, 0.09, 0x22252b); grip.position.set(0, -0.09, 0.12); grip.rotation.x = 0.25; g.add(grip);
  } else if (w.melee && id !== 'fists') {
    buildMeleeMesh(g, id, c);
  }
  // beefier reads better on the blocky blobs: guns +20%, melee +35%
  g.scale.setScalar(w.melee ? 1.35 : 1.2);
  return g;
}
// melee weapons sit in the same fist socket as guns, blade/head pointing forward (-z)
function shaftZ(len, r1, r2, color, near = 0.06) {
  const m = cyl(r1, r2, len, color, 8);
  m.rotation.x = Math.PI / 2;                 // lie the length along Z
  m.position.set(0, 0, near - len / 2);       // extend forward from just past the fist
  return m;
}
function buildMeleeMesh(g, id, c) {
  if (id === 'pipe') {
    g.add(shaftZ(0.86, 0.05, 0.055, c));
    const joint = cyl(0.075, 0.075, 0.09, 0x6a6f78); joint.rotation.x = Math.PI / 2; joint.position.set(0, 0, -0.72); g.add(joint);
    const cap = cyl(0.065, 0.065, 0.06, 0x555a63); cap.rotation.x = Math.PI / 2; cap.position.set(0, 0, -0.82); g.add(cap);
    for (const zz of [-0.32, -0.52]) { // rust rings
      const rust = cyl(0.054, 0.054, 0.05, 0x7a4a2a); rust.rotation.x = Math.PI / 2; rust.position.set(0, 0, zz); g.add(rust);
    }
    g.add(shaftZ(0.18, 0.058, 0.058, 0x2b2b2b, 0.08));
  } else if (id === 'bat') {
    g.add(shaftZ(0.95, 0.04, 0.1, c));                        // thin grip -> fat barrel
    const cap = cyl(0.095, 0.078, 0.07, 0x744a20); cap.rotation.x = Math.PI / 2; cap.position.set(0, 0, -0.9); g.add(cap);
    for (const zz of [-0.56, -0.64]) { // tape stripes on the barrel
      const tape = cyl(0.083, 0.083, 0.035, 0x2a2a2e); tape.rotation.x = Math.PI / 2; tape.position.set(0, 0, zz); g.add(tape);
    }
    const knob = cyl(0.06, 0.06, 0.04, 0x2a2a2a); knob.rotation.x = Math.PI / 2; knob.position.set(0, 0, 0.07); g.add(knob);
    g.add(shaftZ(0.22, 0.046, 0.046, 0x2a2a2a, 0.06));
  } else if (id === 'machete') {
    const blade = box(0.03, 0.16, 0.74, c); blade.position.set(0, 0.02, -0.47); g.add(blade);
    const spine = box(0.034, 0.03, 0.72, 0x8a9097); spine.position.set(0, 0.1, -0.46); g.add(spine);
    const edge = box(0.012, 0.025, 0.72, 0xe8edf2); edge.position.set(0, -0.06, -0.46); g.add(edge);
    const tip = box(0.03, 0.02, 0.2, c); tip.position.set(0, 0.09, -0.86); tip.rotation.x = 0.5; g.add(tip);
    const guard = box(0.16, 0.06, 0.06, 0x2a2c30); guard.position.set(0, 0, -0.06); g.add(guard);
    for (const gy2 of [0.03, -0.03]) { // grip rivets
      const rivet = ball(0.018, 0xc8a44a); rivet.position.set(0.05, gy2, 0.02); g.add(rivet);
    }
    g.add(shaftZ(0.2, 0.048, 0.052, 0x3a2a1a, 0.12));
  } else if (id === 'katana') {
    const blade = box(0.022, 0.12, 1.0, c); blade.position.set(0, 0.02, -0.56); g.add(blade);
    const edge = box(0.01, 0.03, 0.98, 0xf2f6fa); edge.position.set(0, -0.045, -0.55); g.add(edge);
    const tip = box(0.022, 0.1, 0.14, c); tip.position.set(0, 0.04, -1.12); tip.rotation.x = 0.35; g.add(tip);
    const guard = cyl(0.12, 0.12, 0.035, 0x1c1c22); guard.rotation.x = Math.PI / 2; guard.position.set(0, 0, -0.04); g.add(guard);
    for (const zz of [0.05, 0.12, 0.19]) { // silk wrap bands
      const wrap = cyl(0.052, 0.052, 0.035, 0x0c1c2c); wrap.rotation.x = Math.PI / 2; wrap.position.set(0, 0, zz); g.add(wrap);
    }
    const pommel = cyl(0.056, 0.056, 0.04, 0xc8a44a); pommel.rotation.x = Math.PI / 2; pommel.position.set(0, 0, 0.26); g.add(pommel);
    g.add(shaftZ(0.28, 0.05, 0.05, 0x14304a, 0.12));
  } else if (id === 'sledge') {
    g.add(shaftZ(0.8, 0.042, 0.052, 0x6b5330));
    const head = box(0.24, 0.24, 0.34, c); head.position.set(0, 0, -0.76); g.add(head);
    for (const zz of [-0.63, -0.89]) { // forged bands
      const band = box(0.25, 0.25, 0.05, 0x3a3d43); band.position.set(0, 0, zz); g.add(band);
    }
    for (const s of [-1, 1]) { // striking faces
      const face = cyl(0.1, 0.1, 0.05, 0x8a8f98); face.rotation.z = Math.PI / 2; face.position.set(s * 0.15, 0, -0.76); g.add(face);
    }
    const collar = cyl(0.06, 0.06, 0.08, 0x3a3d43); collar.rotation.x = Math.PI / 2; collar.position.set(0, 0, -0.56); g.add(collar);
    g.add(shaftZ(0.2, 0.047, 0.047, 0x2a2a2a, 0.08));
  } else if (id === 'axe') {
    g.add(shaftZ(0.82, 0.042, 0.048, 0x6b5330));
    const collar = box(0.07, 0.1, 0.1, 0x3a3d43); collar.position.set(0, 0.02, -0.72); g.add(collar);
    const head = box(0.07, 0.3, 0.24, c); head.position.set(0, 0.05, -0.76); g.add(head);
    const blade = box(0.034, 0.36, 0.1, 0xd8dde5); blade.position.set(0, 0.05, -0.88); g.add(blade);
    const spike = box(0.05, 0.09, 0.14, 0x5c6068); spike.position.set(0, 0.05, -0.62); g.add(spike);
    const stripe = box(0.072, 0.05, 0.24, 0xf2e28a); stripe.position.set(0, -0.06, -0.76); g.add(stripe);
    g.add(shaftZ(0.2, 0.047, 0.047, 0x2a2a2a, 0.08));
  }
}

// ---------- blob character builder ----------
function buildBlob({ color = 0xff8c42, zombie = false, scale = 1, gunHand = 'right', droopy = false, brain = false, blind = false, wounded = false }) {
  const root = new THREE.Group();
  const wob = new THREE.Group();
  root.add(wob);

  const body = ball(0.55, color);
  body.scale.set(0.55, 0.62, 0.5);
  body.position.y = 0.62;
  wob.add(body);

  // pre-wounded gore: blood stains painted flat onto the torso (not floating blobs)
  const stainCount = { n: 0 };
  if (wounded) {
    for (let i = 0; i < 4; i++) stainBody(wob, stainCount, (Math.random() - 0.5) * 2.6, -0.2 + Math.random() * 0.9, 1.1);
  }

  const head = new THREE.Group();
  head.position.y = 1.28;
  wob.add(head);
  // intact skull (full head)
  const skull = ball(0.42, color);
  skull.scale.set(0.42, 0.4, 0.4);
  head.add(skull);

  // exposed-brain variant: skull cap sliced off (craniotomy) with pink brain welling up.
  // built on every character so a runtime headshot can crack it open; hidden until then.
  const brainMesh = new THREE.Group();
  // open skull "bowl": the head minus its top cap, so you look down into the opening
  const bowl = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12, 0, TAU, 0.92, Math.PI - 0.92),
    mat(color, { side: THREE.DoubleSide })
  );
  bowl.scale.set(0.42, 0.4, 0.4);
  brainMesh.add(bowl);
  // pink brain filling the opening, with lobed bumps poking out of the sliced cap
  const brainDome = ball(0.31, 0xd77a8e);
  brainDome.scale.set(0.31, 0.24, 0.31);
  brainDome.position.y = 0.15;
  brainMesh.add(brainDome);
  for (let i = 0; i < 5; i++) {
    const lobe = ball(0.07 + Math.random() * 0.045, 0xc76b80);
    const a = Math.random() * TAU, rr = 0.05 + Math.random() * 0.11;
    lobe.position.set(Math.cos(a) * rr, 0.19 + Math.random() * 0.05, Math.sin(a) * rr);
    brainMesh.add(lobe);
  }
  head.add(brainMesh);
  brainMesh.visible = brain;
  skull.visible = !brain; // showing the brain means the intact skull cap is gone

  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = ball(0.13, blind ? 0xe2e6e2 : 0xffffff);
    eye.position.set(0.16 * s, droopy ? -0.02 : 0.05, 0.32);
    head.add(eye);
    const pupil = ball(0.055, blind ? 0xbfc3c6 : (zombie ? 0x7a1010 : 0x1a1a1a));
    pupil.position.set(0.16 * s, droopy ? -0.06 : 0.05, 0.415); // recessed flush with the cornea
    head.add(pupil);
    eyes.push(eye);
    if (droopy) {
      const lid = box(0.28, 0.13, 0.1, color);
      lid.position.set(0.16 * s, 0.09, 0.37); lid.rotation.x = 0.32;
      head.add(lid);
    } else if (zombie) {
      const brow = box(0.14, 0.04, 0.04, 0x2f4020);
      brow.position.set(0.16 * s, 0.17, 0.36); brow.rotation.z = 0.5 * s;
      head.add(brow);
    }
  }
  const mouth = box(zombie ? 0.2 : 0.16, zombie ? 0.1 : 0.05, 0.05, zombie ? 0x4a1414 : 0x7a3020);
  mouth.position.set(0, -0.16, 0.36);
  head.add(mouth);

  const arms = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.5 * s, 0.95, 0);
    wob.add(shoulder);
    const arm = box(0.2, 0.4, 0.2, color);
    arm.position.y = -0.26;
    shoulder.add(arm);
    // boxy mitt fist + knuckle block
    const hand = box(0.28, 0.26, 0.28, zombie ? 0x8aa85a : 0xffd7a8);
    hand.position.y = -0.56;
    shoulder.add(hand);
    const knuck = box(0.3, 0.09, 0.14, zombie ? 0x789748 : 0xf0c898);
    knuck.position.set(0, -0.52, 0.13);
    shoulder.add(knuck);
    arms.push(shoulder);
  }
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(0.2 * s, 0.42, 0);
    wob.add(hip);
    const leg = box(0.2, 0.34, 0.2, zombie ? 0x39432a : 0x3a4a6b);
    leg.position.y = -0.2;
    hip.add(leg);
    const foot = box(0.22, 0.13, 0.34, zombie ? 0x2c331f : 0x2c2c34);
    foot.position.set(0, -0.42, 0.06);
    hip.add(foot);
    legs.push(hip);
  }

  // weapon socket: right hand by default (Blondie is the clan lefty). rotated so the
  // barrel points straight out of the fist when the arm is raised, not down at the dirt.
  const gunArm = gunHand === 'left' ? 1 : 0; // arms[0] is the character's right hand
  const gunSocket = new THREE.Group();
  gunSocket.position.set(0, -0.56, 0.02);
  gunSocket.rotation.x = -Math.PI / 2;
  // roll the socket so the weapon's top (sights, scope, axe head) faces UP when the
  // arm is raised — without this the guns hang upside down under the fist
  gunSocket.rotation.z = Math.PI;
  arms[gunArm].add(gunSocket);

  root.scale.setScalar(scale);
  // shadow lives in world space (not parented to the body) so it stays flat on the
  // ground when the character jumps and stays under their center when they topple over.
  const shadow = makeShadow(0.55 * scale);
  scene.add(shadow);

  // collect skin meshes for red damage flash
  const skinList = [];
  root.traverse(o => { if (o.isMesh && o.material !== shadowMat) skinList.push({ mesh: o, mat: o.material }); });
  return { root, wob, head, arms, legs, gunSocket, gunArm, offArm: 1 - gunArm, body, skull, brainMesh, eyes, shadow, stainCount, skinList, flashT: 0,
           armGone: [false, false], legGone: [false, false], headGone: false };
}
// keep a blob's shadow pinned flat under its centre, projected onto whatever surface
// is below (terrain, car roofs, crates...) — it follows you up and slices onto lower tops
function placeShadow(blob, x, z, y) {
  if (!blob.shadow) return;
  const sy = supportTop(x, z, y === undefined ? groundHeight(x, z) : y, 0.1);
  // lifted enough to sit on road (+0.04) and parking (+0.05) surfaces too, not just grass
  blob.shadow.position.set(x, sy + 0.08, z);
}
const FLASH_RED = new THREE.MeshBasicMaterial({ color: 0xff2525 });
const FLASH_GREEN = new THREE.MeshBasicMaterial({ color: 0x3ae06a }); // shielded boss: no damage taken
function flashBlob(blob, fm = FLASH_RED) {
  for (const s of blob.skinList) s.mesh.material = fm;
  blob.flashT = 0.12;
}
function updateFlash(blob, dt) {
  if (blob.flashT > 0) {
    blob.flashT -= dt;
    if (blob.flashT <= 0) for (const s of blob.skinList) s.mesh.material = s.mat;
  }
}

// ---------- world generation ----------
const CHUNK = 40;
const VIEW_R = 2;
const chunks = new Map();
const allCrates = [];
const townColliders = [];

// tight collision/hit box. y0..y1 hug the mesh so bullets pass over/around without
// invisible walls. optional rot = yaw for oriented boxes (cars). tops are standable.
function aabb(x, z, hw, hd, h, y0, rot = 0) {
  if (y0 === undefined) y0 = groundHeight(x, z) - 0.05;
  return { x, z, hw, hd, y0, y1: y0 + h, rot };
}
// highest standable surface under (x,z) for feet at feetY: terrain, or any collider
// top within maxStep above the feet
function supportTop(x, z, feetY, maxStep = 0.45) {
  let top = groundHeight(x, z);
  for (const c of nearbyColliders(x, z)) {
    if (c.y1 > feetY + maxStep || c.y1 <= top) continue;
    let lx = x - c.x, lz = z - c.z;
    if (c.rot) {
      const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      const tx = lx * cs - lz * sn; lz = lx * sn + lz * cs; lx = tx;
    }
    if (Math.abs(lx) <= c.hw + 0.1 && Math.abs(lz) <= c.hd + 0.1) top = c.y1;
  }
  return top;
}

// displaced ground-following plane
function terrainPlane(w, d, segW, segD, cx, cz, material, lift = 0) {
  const geo = new THREE.PlaneGeometry(w, d, segW, segD);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, groundHeight(cx + pos.getX(i), cz + pos.getZ(i)) + lift);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.position.set(cx, 0, cz);
  // vertices already in world-offset space relative to center
  m.geometry.translate(0, 0, 0);
  m.position.set(cx, 0, cz);
  // undo double-offset: we sampled with cx+localX, so mesh must sit at cx, but geometry x is local. correct.
  return m;
}

// ---------- crates ----------
function makeCrate(rng, x, y, z, group, colliders, crateList, onShelf) {
  const g = new THREE.Group();
  const base = box(0.7, 0.5, 0.7, 0x8a5a2b);
  base.position.y = 0.25;
  g.add(base);
  const trim = box(0.74, 0.1, 0.74, 0xc8a44a, { emissive: 0x886600, emissiveIntensity: 0.6 });
  trim.position.y = 0.5;
  g.add(trim);
  const lid = box(0.72, 0.1, 0.72, 0x6e451f);
  lid.position.y = 0.57;
  g.add(lid);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.7, depthWrite: false }));
  glow.scale.setScalar(1.6);
  glow.position.y = 0.9;
  g.add(glow);
  g.position.set(x, y, z);
  g.rotation.y = rng() * TAU;
  group.add(g);
  const crate = { mesh: g, lid, trim, glow, opened: false, shrink: 0, pos: new THREE.Vector3(x, y, z), t: rng() * 10, list: crateList };
  crateList.push(crate);
  allCrates.push(crate);
  if (!onShelf) {
    crate.col = aabb(x, z, 0.38, 0.38, 0.72, y - 0.02);
    crate.colList = colliders;
    colliders.push(crate.col);
  }
  return crate;
}
// respawn a crate somewhere random in a loaded chunk
function respawnCrateElsewhere() {
  const keys = [...chunks.keys()];
  for (let tries = 0; tries < 14; tries++) {
    const ch = chunks.get(keys[(Math.random() * keys.length) | 0]);
    if (!ch) continue;
    const x = ch.cx * CHUNK + (Math.random() - 0.5) * (CHUNK - 8);
    const z = ch.cz * CHUNK + (Math.random() - 0.5) * (CHUNK - 8);
    if (onRoad(x, z, 1) || inTown(x, z, 1)) continue;
    let blocked = false;
    for (const c of ch.colliders) {
      if (Math.abs(x - c.x) < c.hw + 1 && Math.abs(z - c.z) < c.hd + 1) { blocked = true; break; }
    }
    if (blocked) continue;
    makeCrate(Math.random, x, groundHeight(x, z) + 0.02, z, ch.group, ch.colliders, ch.crates, false);
    return;
  }
}

function makeShelf(rng, x, z, rotY, group, colliders, crateList) {
  const y0 = groundHeight(x, z);
  const s = new THREE.Group();
  const frame = 0x4a4f58;
  for (const sx of [-0.9, 0.9]) for (const sz of [-0.25, 0.25]) {
    const leg = box(0.08, 1.9, 0.08, frame);
    leg.position.set(sx, 0.85, sz);
    s.add(leg);
  }
  for (const y of [0.55, 1.25]) {
    const plank = box(1.9, 0.07, 0.66, 0x7a6a4a);
    plank.position.y = y;
    s.add(plank);
  }
  s.position.set(x, y0 - 0.1, z);
  s.rotation.y = rotY;
  group.add(s);
  colliders.push(aabb(x, z, 1.0, 0.45, 1.85, y0 - 0.1));
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  for (const y of [0.485, 1.185]) {
    if (rng() < 0.62) {
      const off = (rng() - 0.5) * 1.2;
      const wx = x + cos * off, wz = z - sin * off;
      if (rng() < 0.55) makeCrate(rng, wx, y0 + y, wz, group, colliders, crateList, true);
      else {
        const junk = box(0.3 + rng() * 0.2, 0.25 + rng() * 0.2, 0.3, [0x666f7a, 0x7a5a40, 0x505a44][(rng() * 3) | 0]);
        junk.position.set(wx, y0 + y + 0.15, wz);
        group.add(junk);
      }
    }
  }
}

// window pane helper (plain dark glass)
function windowPane(rng, w, h) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), darkGlassMat);
}

// pitched shingle roof + gables
function addRoof(group, bx, by, bz, w, d, rng) {
  const rh = d * 0.32;
  const roofMat = roofMats[(rng() * roofMats.length) | 0];
  const slopeLen = Math.hypot(d / 2 + 0.5, rh);
  const ang = Math.atan2(rh, d / 2 + 0.5);
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(BOX, roofMat);
    slab.scale.set(w + 0.9, 0.12, slopeLen);
    slab.position.set(bx, by + rh / 2, bz + s * (d / 4 + 0.12));
    slab.rotation.x = s * ang;
    group.add(slab);
  }
  // gable ends
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0); shape.lineTo(d / 2, 0); shape.lineTo(0, rh); shape.closePath();
  const ggeo = new THREE.ShapeGeometry(shape);
  const gmat = new THREE.MeshLambertMaterial({ color: 0x5d5044, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const gable = new THREE.Mesh(ggeo, gmat);
    gable.rotation.y = Math.PI / 2;
    gable.position.set(bx + s * w / 2, by, bz);
    group.add(gable);
  }
}

function makeBuilding(rng, bx, bz, group, colliders, crateList) {
  const w = 7 + ((rng() * 5) | 0), d = 6 + ((rng() * 4) | 0), h = 2.6 + rng() * 1.2;
  const y0 = groundHeight(bx, bz);
  const wallC = [0x6b6154, 0x5d6068, 0x745f4d, 0x606a5d][(rng() * 4) | 0];
  const t = 0.35;
  const doorSide = (rng() * 4) | 0;
  const walls = [
    { x: bx, z: bz - d / 2, hw: w / 2, hd: t / 2, side: 0 },
    { x: bx, z: bz + d / 2, hw: w / 2, hd: t / 2, side: 1 },
    { x: bx - w / 2, z: bz, hw: t / 2, hd: d / 2, side: 2 },
    { x: bx + w / 2, z: bz, hw: t / 2, hd: d / 2, side: 3 },
  ];
  for (const wall of walls) {
    if (wall.side === doorSide) {
      const horiz = wall.hw > wall.hd;
      const len = horiz ? wall.hw * 2 : wall.hd * 2;
      const gap = 1.6, segLen = (len - gap) / 2;
      for (const s of [-1, 1]) {
        const off = s * (gap / 2 + segLen / 2);
        const sx = horiz ? wall.x + off : wall.x;
        const sz = horiz ? wall.z : wall.z + off;
        const m = box(horiz ? segLen : t, h + 0.6, horiz ? t : segLen, wallC);
        m.position.set(sx, y0 + h / 2 - 0.3, sz);
        group.add(m);
        colliders.push(aabb(sx, sz, horiz ? segLen / 2 : t / 2, horiz ? t / 2 : segLen / 2, h + 0.6, y0 - 0.6));
      }
    } else {
      const m = box(wall.hw * 2, h + 0.6, wall.hd * 2, wallC);
      m.position.set(wall.x, y0 + h / 2 - 0.3, wall.z);
      group.add(m);
      colliders.push(aabb(wall.x, wall.z, wall.hw, wall.hd, h + 0.6, y0 - 0.6));
      if (rng() < 0.75) {
        const horiz = wall.hw > wall.hd;
        const win = windowPane(rng, 1.2, 0.9);
        if (horiz) {
          win.position.set(wall.x + (rng() - 0.5) * wall.hw, y0 + h * 0.55, wall.z + (wall.hd + 0.03) * (wall.z > bz ? 1 : -1));
          win.rotation.y = wall.z > bz ? 0 : Math.PI;
        } else {
          win.position.set(wall.x + (wall.hw + 0.03) * (wall.x > bx ? 1 : -1), y0 + h * 0.55, wall.z + (rng() - 0.5) * wall.hd);
          win.rotation.y = (wall.x > bx ? 1 : -1) * Math.PI / 2;
        }
        group.add(win);
      }
    }
  }
  const floor = box(w, 0.6, d, 0x4a453e);
  floor.position.set(bx, y0 - 0.24, bz);
  group.add(floor);
  addRoof(group, bx, y0 + h - 0.05, bz, w, d, rng); // roof sits down onto the walls
  if (rng() < 0.85) makeShelf(rng, bx + (rng() - 0.5) * (w - 3), bz + (rng() - 0.5) * (d - 3), (rng() * 4 | 0) * Math.PI / 2, group, colliders, crateList);
  if (rng() < 0.7) makeCrate(rng, bx + (rng() - 0.5) * (w - 2.5), y0 + 0.08, bz + (rng() - 0.5) * (d - 2.5), group, colliders, crateList, false);
  // parked car near the building
  if (rng() < 0.45) {
    const side = rng() < 0.5 ? -1 : 1;
    const cxr = bx + side * (w / 2 + 2.6), czr = bz + (rng() - 0.5) * d;
    if (!onRoad(cxr, czr, 1)) makeCar(rng, cxr, czr, group, colliders, { broken: rng() < 0.6 });
  }
  // barrels leaning against the outside walls
  const nBar = (rng() * 3) | 0;
  for (let i = 0; i < nBar; i++) {
    const side = (rng() * 4) | 0;
    const along = (rng() - 0.5) * (side < 2 ? w - 2 : d - 2);
    const bx2 = side === 2 ? bx - w / 2 - 0.55 : side === 3 ? bx + w / 2 + 0.55 : bx + along;
    const bz2 = side === 0 ? bz - d / 2 - 0.55 : side === 1 ? bz + d / 2 + 0.55 : bz + along;
    if (onRoad(bx2, bz2, 0.5)) continue;
    const by = groundHeight(bx2, bz2);
    const barrel = cyl(0.34, 0.34, 0.9, [0x7a2e2e, 0x2e5a7a, 0x5a7a2e][(rng() * 3) | 0]);
    barrel.position.set(bx2, by + 0.45, bz2);
    group.add(barrel);
    colliders.push(aabb(bx2, bz2, 0.36, 0.36, 0.9, by));
  }
  // footprint: zombies never spawn inside a building on their own, and the door gap is
  // the only route they will path in or out through
  const doorX = doorSide === 2 ? bx - w / 2 : doorSide === 3 ? bx + w / 2 : bx;
  const doorZ = doorSide === 0 ? bz - d / 2 : doorSide === 1 ? bz + d / 2 : bz;
  const outX = doorSide === 2 ? -1 : doorSide === 3 ? 1 : 0;
  const outZ = doorSide === 0 ? -1 : doorSide === 1 ? 1 : 0;
  return { x: bx, z: bz, hw: w / 2 + 0.5, hd: d / 2 + 0.5,
    doorX, doorZ, doorOutX: doorX + outX * 2.2, doorOutZ: doorZ + outZ * 2.2 };
}

function makeTree(rng, x, z, group, colliders) {
  const y0 = groundHeight(x, z);
  const trunk = cyl(0.14, 0.2, 1.6, 0x4a3623);
  trunk.position.set(x, y0 + 0.8, z);
  group.add(trunk);
  const leaves = ball(0.9 + rng() * 0.5, [0x3d5a34, 0x49663a, 0x35502e][(rng() * 3) | 0]);
  leaves.scale.y *= 1.15;
  leaves.position.set(x, y0 + 2.1 + rng() * 0.5, z);
  group.add(leaves);
  colliders.push(aabb(x, z, 0.25, 0.25, 2, y0));
}
function makeBush(rng, x, z, group, big = false) {
  const y0 = groundHeight(x, z);
  const g = new THREE.Group();
  const n = 2 + ((rng() * 2) | 0);
  for (let i = 0; i < n; i++) {
    const b = ball(0.32 + rng() * 0.25, [0x2f4a28, 0x3a5a30, 0x44663a][(rng() * 3) | 0]);
    b.scale.y *= 0.75;
    b.position.set((rng() - 0.5) * 0.7, 0.2 + rng() * 0.1, (rng() - 0.5) * 0.7);
    g.add(b);
  }
  if (big) g.scale.setScalar(2); // jumbo hedge variant
  g.position.set(x, y0, z);
  group.add(g);
}
// evergreen: stacked dark conifer cones
function makeEvergreen(rng, x, z, group, colliders) {
  const y0 = groundHeight(x, z);
  const trunk = cyl(0.12, 0.17, 1.1, 0x3e3020);
  trunk.position.set(x, y0 + 0.55, z);
  group.add(trunk);
  const green = [0x2a4a2e, 0x2e5233, 0x27452b][(rng() * 3) | 0];
  const s = 0.85 + rng() * 0.5;
  let ty = y0 + 0.9;
  for (const [r, h] of [[1.25, 1.5], [0.95, 1.3], [0.6, 1.1]]) {
    const cone = cyl(0.02, r * s, h * s, green, 9);
    cone.position.set(x, ty + h * s / 2, z);
    group.add(cone);
    ty += h * s * 0.62;
  }
  colliders.push(aabb(x, z, 0.28, 0.28, 1.6, y0));
}
function makeRock(rng, x, z, group, colliders, big) {
  const y0 = groundHeight(x, z);
  const r = big ? 0.55 + rng() * 0.6 : 0.25 + rng() * 0.3;
  const rock = ball(r, [0x5c5f66, 0x6a6d74, 0x54585e][(rng() * 3) | 0]);
  rock.scale.y *= 0.55;
  rock.scale.x *= 0.8 + rng() * 0.4;
  rock.rotation.y = rng() * TAU;
  rock.position.set(x, y0 + r * 0.2, z);
  group.add(rock);
  if (big) colliders.push(aabb(x, z, r * 0.8, r * 0.8, r * 0.75, y0));
}

function makeCar(rng, x, z, group, colliders, opts = {}) {
  const y0 = groundHeight(x, z);
  const g = new THREE.Group();
  const c = [0x7a3030, 0x30507a, 0x6a6a30, 0x555555, 0x8a6a2a, 0x3a6a5a][(rng() * 6) | 0];
  const body = box(1.8, 0.55, 4, c);
  body.position.y = 0.55;
  g.add(body);
  // cabin is body-coloured metal; only the window strips are glass (and only some cracked)
  const cab = box(1.5, 0.5, 1.7, c);
  cab.position.set(0, 1.05, -0.2);
  g.add(cab);
  const winGlass = () => darkGlassMat;
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.34), winGlass());
  windshield.position.set(0, 1.08, 0.66); g.add(windshield);
  const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.34), winGlass());
  rearWin.position.set(0, 1.08, -1.06); rearWin.rotation.y = Math.PI; g.add(rearWin);
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.3), winGlass());
    side.position.set(sx * 0.76, 1.08, -0.2); side.rotation.y = sx * Math.PI / 2; g.add(side);
  }
  for (const [wx, wz] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]) {
    const wheel = cyl(0.3, 0.3, 0.22, 0x14161a);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.3, wz);
    g.add(wheel);
  }
  g.position.set(x, y0, z);
  const yaw = opts.rotY !== undefined ? opts.rotY : rng() * TAU;
  g.rotation.y = yaw;
  if (opts.flipped) {
    g.rotation.z = Math.PI + (rng() - 0.5) * 0.3;
    g.position.y = y0 + 1.35;
  }
  group.add(g);
  // tight oriented boxes: low body + narrower cabin. bullets skim past the hood
  // instead of hitting an invisible wall, and you can hop trunk -> roof.
  if (opts.flipped) {
    colliders.push(aabb(x, z, 1.02, 2.02, 1.45, y0, yaw));
  } else {
    colliders.push(aabb(x, z, 0.95, 2.02, 0.85, y0, yaw));
    colliders.push(aabb(x - 0.2 * Math.sin(yaw), z - 0.2 * Math.cos(yaw), 0.78, 0.88, 1.32, y0, yaw));
  }
}
// traffic pileup: cluster of wrecked cars, all broken windows, some flipped
function makePileup(rng, x, z, along, group, colliders) {
  const n = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const off = (i - n / 2) * 4.6 + (rng() - 0.5) * 1.6;
    const jitter = (rng() - 0.5) * 5.6; // scattered across both lanes now that roads are two-way
    const px = along === 'z' ? x + jitter : x + off;
    const pz = along === 'z' ? z + off : z + jitter;
    makeCar(rng, px, pz, group, colliders, {
      broken: true,
      flipped: rng() < 0.3,
      rotY: (along === 'z' ? 0 : Math.PI / 2) + (rng() - 0.5) * (rng() < 0.25 ? 2.5 : 0.5),
    });
  }
}

const grassMats = {};
function grassMat(hue) {
  const key = hue.toFixed(2);
  if (!grassMats[key]) grassMats[key] = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.26 + hue * 0.05, 0.3, 0.25 + hue * 0.05) });
  return grassMats[key];
}
const roadMat = new THREE.MeshLambertMaterial({ color: 0x2c2e33 });
const lotMat = new THREE.MeshLambertMaterial({ color: 0x35373d });

function buildChunk(cx, cz) {
  const rng = chunkRng(cx, cz);
  const group = new THREE.Group();
  const colliders = [];
  const crateList = [];
  const ox = cx * CHUNK, oz = cz * CHUNK;

  group.add(terrainPlane(CHUNK, CHUNK, 10, 10, ox, oz, grassMat(rng())));

  // roads on grid lines every 3 chunks (center at ox-17 / oz-17)
  const hasVRoad = ((cx % 3) + 3) % 3 === 0;
  const hasHRoad = ((cz % 3) + 3) % 3 === 0;
  if (hasVRoad) group.add(terrainPlane(12.8, CHUNK, 3, 10, ox - 17, oz, roadMat, 0.04));
  if (hasHRoad) group.add(terrainPlane(CHUNK, 12.8, 10, 3, ox, oz - 17, roadMat, 0.04));
  // dotted yellow centre line between the two lanes, broken well clear of intersections
  for (const vert of [true, false]) {
    if (vert ? !hasVRoad : !hasHRoad) continue;
    for (let off = -CHUNK / 2 + 1.6; off < CHUNK / 2; off += 4.2) {
      const dxp = vert ? ox - 17 : ox + off;
      const dzp = vert ? oz + off : oz - 17;
      if (roadAxisDist(vert ? dzp : dxp) < 8.4) continue;
      const dash = box(vert ? 0.16 : 1.7, 0.02, vert ? 1.7 : 0.16, 0xd8b62a);
      dash.position.set(dxp, groundHeight(dxp, dzp) + 0.075, dzp);
      group.add(dash);
    }
  }

  const spots = [];
  function freeSpot(minDist, roadMargin = 2) {
    for (let tries = 0; tries < 12; tries++) {
      const x = ox + (rng() - 0.5) * (CHUNK - 8);
      const z = oz + (rng() - 0.5) * (CHUNK - 8);
      if (cx === 0 && cz === 0 && Math.hypot(x, z) < 8) continue;
      if (onRoad(x, z, roadMargin)) continue;
      if (inTown(x, z, 4)) continue;
      let ok = true;
      for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < minDist + s.r) { ok = false; break; }
      if (ok) { spots.push({ x, z, r: minDist }); return { x, z }; }
    }
    return null;
  }

  const buildings = [];
  const nB = rng() < 0.55 ? 1 + (rng() < 0.3 ? 1 : 0) : 0;
  for (let i = 0; i < nB; i++) {
    const p = freeSpot(10, 4);
    if (p) buildings.push(makeBuilding(rng, p.x, p.z, group, colliders, crateList));
  }
  if (cx === 0 && cz === 0) makeCrate(rng, 4.5, groundHeight(4.5, 5) + 0.02, 5, group, colliders, crateList, false);
  const nC = Math.round((1 + ((rng() * 2) | 0)) * clamp(settings.lootSpawn, 0, 3));
  for (let i = 0; i < nC; i++) {
    const p = freeSpot(2);
    if (p) makeCrate(rng, p.x, groundHeight(p.x, p.z) + 0.02, p.z, group, colliders, crateList, false);
  }
  // foliage: leafy + evergreen trees, bushes (some jumbo), rocks — never on roads
  const nT = 2 + ((rng() * 4) | 0);
  for (let i = 0; i < nT; i++) {
    const p = freeSpot(2.5);
    if (!p) continue;
    if (rng() < 0.4) makeEvergreen(rng, p.x, p.z, group, colliders);
    else makeTree(rng, p.x, p.z, group, colliders);
  }
  const nBu = 3 + ((rng() * 4) | 0);
  for (let i = 0; i < nBu; i++) {
    const p = freeSpot(1.4);
    if (p) makeBush(rng, p.x, p.z, group, rng() < 0.25);
  }
  const nR = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < nR; i++) {
    const p = freeSpot(1.4);
    if (p) makeRock(rng, p.x, p.z, group, colliders, rng() < 0.4);
  }
  // traffic pileups on roads
  if (hasVRoad && rng() < 0.3 && !(cx === 0 && cz === 0)) {
    makePileup(rng, ox - 17, oz + (rng() - 0.5) * 16, 'z', group, colliders);
  }
  if (hasHRoad && rng() < 0.3 && !inTown(ox, oz - 17, 8)) {
    makePileup(rng, ox + (rng() - 0.5) * 16, oz - 17, 'x', group, colliders);
  }

  scene.add(group);
  return { group, colliders, crates: crateList, buildings, cx, cz };
}
// the hollow chunk house whose footprint contains (x,z), or null — keeps spawns
// outdoors and lets zombies respect doorways instead of pressing through walls
function buildingAt(x, z) {
  const ccx = Math.round(x / CHUNK), ccz = Math.round(z / CHUNK);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const ch = chunks.get(chunkKey(ccx + dx, ccz + dz));
    if (!ch || !ch.buildings) continue;
    for (const bld of ch.buildings) {
      if (Math.abs(x - bld.x) <= bld.hw && Math.abs(z - bld.z) <= bld.hd) return bld;
    }
  }
  return null;
}
function insideBuilding(x, z) { return !!buildingAt(x, z); }

function chunkKey(cx, cz) { return cx + ',' + cz; }
function updateChunks(px, pz) {
  const ccx = Math.round(px / CHUNK), ccz = Math.round(pz / CHUNK);
  for (let dx = -VIEW_R; dx <= VIEW_R; dx++) for (let dz = -VIEW_R; dz <= VIEW_R; dz++) {
    const key = chunkKey(ccx + dx, ccz + dz);
    if (!chunks.has(key)) chunks.set(key, buildChunk(ccx + dx, ccz + dz));
  }
  for (const [key, ch] of chunks) {
    if (Math.abs(ch.cx - ccx) > VIEW_R + 1 || Math.abs(ch.cz - ccz) > VIEW_R + 1) {
      scene.remove(ch.group);
      ch.group.traverse(o => { if (o.geometry && o.geometry !== BOX && o.geometry !== SPHERE && o.geometry !== shadowGeo) o.geometry.dispose(); });
      for (const cr of ch.crates) {
        const i = allCrates.indexOf(cr);
        if (i >= 0) allCrates.splice(i, 1);
      }
      chunks.delete(key);
    }
  }
}
function nearbyColliders(x, z) {
  const out = [];
  const ccx = Math.round(x / CHUNK), ccz = Math.round(z / CHUNK);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const ch = chunks.get(chunkKey(ccx + dx, ccz + dz));
    if (ch) out.push(...ch.colliders);
  }
  if (x > -50 && x < 140 && z > -70 && z < 90) out.push(...townColliders);
  return out;
}
function resolveCollision(x, z, r, y) {
  for (const c of nearbyColliders(x, z)) {
    if (y !== undefined) {
      if (y >= c.y1 - 0.25) continue;   // standing on top of it
      if (c.y0 > y + 1.5) continue;     // walking underneath (awnings etc.)
    }
    if (c.rot) {
      // oriented box: work in the collider's local frame
      const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      const wx = x - c.x, wz = z - c.z;
      const lx = wx * cs - wz * sn, lz = wx * sn + wz * cs;
      const nx = clamp(lx, -c.hw, c.hw), nz = clamp(lz, -c.hd, c.hd);
      const ddx = lx - nx, ddz = lz - nz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 0.0001;
        const push = (r - d) / d;
        const plx = lx + ddx * push, plz = lz + ddz * push;
        x = c.x + plx * cs + plz * sn;
        z = c.z - plx * sn + plz * cs;
      }
    } else {
      const nx = clamp(x, c.x - c.hw, c.x + c.hw);
      const nz = clamp(z, c.z - c.hd, c.z + c.hd);
      const dx = x - nx, dz = z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 0.0001;
        const push = (r - d) / d;
        x += dx * push; z += dz * push;
      }
    }
  }
  return [x, z];
}
function rayAABB(ox, oy, oz, dx, dy, dz, c) {
  let px = ox - c.x, pz = oz - c.z, rdx = dx, rdz = dz;
  if (c.rot) {
    const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    const tx = px * cs - pz * sn; pz = px * sn + pz * cs; px = tx;
    const tdx = dx * cs - dz * sn; rdz = dx * sn + dz * cs; rdx = tdx;
  }
  const mn = [-c.hw, c.y0, -c.hd], mx = [c.hw, c.y1, c.hd];
  const p = [px, oy, pz], d = [rdx, dy, rdz];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (p[i] < mn[i] || p[i] > mx[i]) return Infinity; }
    else {
      let t1 = (mn[i] - p[i]) / d[i], t2 = (mx[i] - p[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}
function raySphere(ox, oy, oz, dx, dy, dz, sx, sy, sz, r) {
  const lx = sx - ox, ly = sy - oy, lz = sz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  return tca - Math.sqrt(r * r - d2);
}
// coarse ray-vs-terrain
function rayGround(ox, oy, oz, dx, dy, dz, maxT) {
  let prev = oy - groundHeight(ox, oz);
  for (let t = 2; t <= maxT; t += 2) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const dh = y - groundHeight(x, z);
    if (dh <= 0) {
      // refine between t-2 and t
      return t - 2 + 2 * (prev / (prev - dh));
    }
    prev = dh;
  }
  return Infinity;
}

// ---------- town (built once, persistent) ----------
const townGroup = new THREE.Group();
const townCrates = [];
scene.add(townGroup);

// civic building: colonnaded facade on the faceDir side (+1 = faces +z, -1 = faces -z)
function grandBuilding(x, z, w, d, h, wallColor, label, rng, faceDir = -1) {
  const y0 = groundHeight(x, z);
  const body = box(w, h, d, wallColor);
  body.position.set(x, y0 + h / 2, z);
  townGroup.add(body);
  townColliders.push(aabb(x, z, w / 2, d / 2, h, y0));
  const fz = z + faceDir * d / 2; // facade plane, turned toward the road
  // full-height columns whose capitals meet the portico slab above
  for (let i = 0; i < 4; i++) {
    const col = cyl(0.28, 0.32, h, 0xd8d2c4, 10);
    col.position.set(x - w / 4 + i * (w / 6), y0 + h / 2, fz + faceDir * 1);
    townGroup.add(col);
  }
  // portico roof: underside rests on the column tops
  const roofSlab = box(w + 1, 0.3, d + 2.6, 0x8b8577);
  roofSlab.position.set(x, y0 + h + 0.15, z + faceDir * 0.8);
  townGroup.add(roofSlab);
  const pedShape = new THREE.Shape();
  pedShape.moveTo(-w * 0.4, 0); pedShape.lineTo(w * 0.4, 0); pedShape.lineTo(0, 2.2); pedShape.closePath();
  const ped = new THREE.Mesh(new THREE.ShapeGeometry(pedShape), new THREE.MeshLambertMaterial({ color: 0xcfc9ba, side: THREE.DoubleSide }));
  ped.position.set(x, y0 + h + 0.28, fz + faceDir * 1.1);
  townGroup.add(ped);
  for (const s of [1.1, 0.55]) {
    const step = box(w * 0.55, 0.22, s, 0xbab4a6);
    step.position.set(x, y0 + (s === 1.1 ? 0.11 : 0.33), fz + faceDir * (2.4 - s * 0.5));
    townGroup.add(step);
  }
  // name plate mounted flat on the wall face, behind the columns
  const plate = textPlate(label, Math.min(w * 0.45, 9), Math.min(w * 0.11, 2.2));
  plate.position.set(x, y0 + h - Math.min(w * 0.07, 1.4), fz + faceDir * 0.06);
  plate.rotation.y = faceDir > 0 ? 0 : Math.PI;
  townGroup.add(plate);
  // facade windows
  const rrng = rng || Math.random;
  for (let i = -1; i <= 1; i++) {
    const win = windowPane(rrng, 1.4, 1.6);
    win.position.set(x + i * (w / 3.2), y0 + h * 0.42, fz + faceDir * 0.03);
    win.rotation.y = faceDir > 0 ? 0 : Math.PI;
    townGroup.add(win);
  }
}

function shopBuilding(x, z, w, d, h, faceDir, label, rng) {
  const y0 = groundHeight(x, z);
  const wallC = [0x7a6a55, 0x6a707a, 0x7d6a62, 0x6d7a68][(rng() * 4) | 0];
  const body = box(w, h, d, wallC);
  body.position.set(x, y0 + h / 2, z);
  townGroup.add(body);
  townColliders.push(aabb(x, z, w / 2, d / 2, h, y0)); // flat roof is standable
  const parapet = box(w + 0.2, 0.4, d + 0.2, 0x55493c);
  parapet.position.set(x, y0 + h + 0.2, z);
  townGroup.add(parapet);
  const fz = z + faceDir * (d / 2 + 0.03);
  // storefront window
  const win = windowPane(rng, w * 0.55, h * 0.42);
  win.position.set(x - w * 0.12, y0 + h * 0.38, fz);
  win.rotation.y = faceDir > 0 ? 0 : Math.PI;
  townGroup.add(win);
  // door
  const door = box(0.9, 1.8, 0.08, 0x33261a);
  door.position.set(x + w * 0.32, y0 + 0.9, fz);
  townGroup.add(door);
  // awning
  const awn = box(w * 0.9, 0.08, 1.3, [0x8a2f2f, 0x2f5a8a, 0x8a6a2f][(rng() * 3) | 0]);
  awn.position.set(x, y0 + h * 0.62, z + faceDir * (d / 2 + 0.6));
  awn.rotation.x = faceDir * 0.25;
  townGroup.add(awn);
  // thin standable ledge: jump car -> awning -> shop roof
  townColliders.push(aabb(x, z + faceDir * (d / 2 + 0.6), w * 0.45, 0.72, 0.1, y0 + h * 0.62 - 0.05));
  const plate = textPlate(label, Math.min(w * 0.8, 4.5), 1.1);
  plate.position.set(x, y0 + h * 0.82, z + faceDir * (d / 2 + 0.05));
  plate.rotation.y = faceDir > 0 ? 0 : Math.PI;
  townGroup.add(plate);
}

function parkingLot(x, z, w, d, rows, rng) {
  townGroup.add(terrainPlane(w, d, 8, 8, x, z, lotMat, 0.05));
  const lineMat = mat(0xd8d8d0);
  for (let r = 0; r < rows; r++) {
    const rz = z - d / 2 + (r + 0.5) * (d / rows);
    const nLines = Math.floor(w / 3.2) - 1;
    for (let i = 0; i < nLines; i++) {
      const lx = x - w / 2 + 2.4 + i * 3.2;
      const line = new THREE.Mesh(BOX, lineMat);
      line.scale.set(0.14, 0.02, 2.6);
      line.position.set(lx, groundHeight(lx, rz) + 0.09, rz);
      townGroup.add(line);
    }
    // abandoned cars sit properly inside the painted stalls, nose-in or backed-in
    for (let i = 0; i < nLines - 1; i++) {
      if (rng() < 0.3) {
        const sx = x - w / 2 + 2.4 + i * 3.2 + 1.6;
        makeCar(rng, sx, rz, townGroup, townColliders, {
          broken: rng() < 0.7,
          rotY: (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.08,
        });
      }
    }
  }
}

function buildTown() {
  const rng = mulberry32(9001);
  // main street shops: road z in [-20,-14], shops face it from both sides
  const northNames = ['DINER', 'BAKERY', 'BOOKS', 'TOOLS', 'PIZZA'];
  const southNames = ['MART', 'LIQUOR', 'BARBER', 'TAILOR', 'RADIO'];
  for (let i = 0; i < 5; i++) {
    shopBuilding(12 + i * 13, -5.9, 9.5, 7, 3.4 + rng() * 0.8, -1, northNames[i], rng); // north side faces south (-z)
    shopBuilding(12 + i * 13, -28.1, 9.5, 7, 3.4 + rng() * 0.8, 1, southNames[i], rng); // south side faces north (+z)
  }
  // town hall & courthouse face each other across the east end of main street,
  // pulled west of the x=103 cross road so nothing overlaps it
  grandBuilding(88, -2, 18, 12, 6.5, 0x8a7f6a, 'TOWN HALL', rng, -1);
  grandBuilding(88, -34, 18, 12, 6, 0x9a9aa2, 'COURTHOUSE', rng, 1);
  // the bank anchors the west end of the shop road, a third grander than town hall,
  // set back to leave room for the fountain pavilion (and the boss arena between them)
  grandBuilding(0, -46, 24, 16, 8.6, 0x7d8a96, 'BANK', rng, 1);

  // fountain pavilion in front of the bank — the Two Horned One wakes between the two
  {
    const fy = groundHeight(0, -28.5);
    const pave = new THREE.Mesh(new THREE.CircleGeometry(4.8, 26), lotMat);
    pave.rotation.x = -Math.PI / 2;
    pave.position.set(0, fy + 0.06, -28.5);
    townGroup.add(pave);
    const basin = cyl(2.8, 3.0, 0.85, 0x9a948a, 18);
    basin.position.set(0, fy + 0.42, -28.5);
    townGroup.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(2.45, 18),
      new THREE.MeshLambertMaterial({ color: 0x3f7fae, emissive: 0x14405e, emissiveIntensity: 0.55 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, fy + 0.78, -28.5);
    townGroup.add(water);
    const ped = cyl(0.42, 0.62, 1.5, 0x8b8577, 10);
    ped.position.set(0, fy + 1.5, -28.5);
    townGroup.add(ped);
    const bowl = cyl(1.05, 0.22, 0.45, 0x9a948a, 12);
    bowl.position.set(0, fy + 2.4, -28.5);
    townGroup.add(bowl);
    const spout = ball(0.26, 0x7fb8d8, { emissive: 0x2a5a78, emissiveIntensity: 0.6 });
    spout.position.set(0, fy + 2.72, -28.5);
    townGroup.add(spout);
    townColliders.push(aabb(0, -28.5, 2.9, 2.9, 0.95, fy));
    // lamp ring around the pavilion
    for (const a of [0.79, 2.36, 3.93, 5.5]) {
      const lx = Math.cos(a) * 4.3, lz = -28.5 + Math.sin(a) * 4.3;
      const ly = groundHeight(lx, lz);
      const pole = cyl(0.06, 0.08, 3.4, 0x3a3d42);
      pole.position.set(lx, ly + 1.7, lz);
      townGroup.add(pole);
      const bulb = ball(0.14, 0xffe9a8, { emissive: 0xffdd77, emissiveIntensity: 1 });
      bulb.position.set(lx, ly + 3.4, lz);
      townGroup.add(bulb);
    }
  }

  // shopping plaza: long building north edge of plaza rect, parking in front
  const plazaShops = [['SUPER MART', 20], ['PHARMACY', 12], ['GYM', 10], ['CAFE', 10]];
  let px = 18;
  for (const [name, w] of plazaShops) {
    shopBuilding(px + w / 2, 58, w, 9, 4.6, -1, name, rng);
    px += w + 1.5;
  }
  parkingLot(42, 36, 58, 26, 3, rng);   // large parking
  parkingLot(16, 22, 14, 10, 1, rng);   // smaller side parking
  // plaza driveway connects main road to parking
  townGroup.add(terrainPlane(6.4, 32, 2, 8, 41, 2, roadMat, 0.04));

  // main-street pileups (all broken windows, some flipped)
  makePileup(rng, 30, -17, 'x', townGroup, townColliders);
  makePileup(rng, 62, -17, 'x', townGroup, townColliders);
  makePileup(rng, -17, 26, 'z', townGroup, townColliders);
  // parked cars near town buildings
  makeCar(rng, 84, -14, townGroup, townColliders, { broken: true, rotY: 0.3 });
  makeCar(rng, 20, -32.5, townGroup, townColliders, { broken: rng() < 0.5, rotY: Math.PI / 2 });
  makeCar(rng, 47, -3, townGroup, townColliders, { broken: true, flipped: true });

  // loot crates scattered through town
  const spots = [[10, -9.8], [36, -9.8], [58, -24.4], [88, -9.4], [94, -26], [30, 30], [55, 42], [18, 20], [70, 55], [41, 10]];
  for (const [cx2, cz2] of spots) {
    if (rng() < 0.8) makeCrate(rng, cx2 + (rng() - 0.5) * 3, groundHeight(cx2, cz2) + 0.05, cz2 + (rng() - 0.5) * 3, townGroup, townColliders, townCrates, false);
  }
  // street lamps tucked in the gaps between shopfronts, clear of the awnings
  for (const lx of [5.5, 18.5, 31.5, 44.5, 57.5, 70.5]) {
    for (const lz of [-10.1, -23.9]) {
      const y0 = groundHeight(lx, lz);
      const pole = cyl(0.07, 0.09, 4.2, 0x3a3d42);
      pole.position.set(lx, y0 + 2.1, lz);
      townGroup.add(pole);
      const bulb = ball(0.16, 0xffe9a8, { emissive: 0xffdd77, emissiveIntensity: 1 });
      bulb.position.set(lx, y0 + 4.2, lz);
      townGroup.add(bulb);
    }
  }
}

// ---------- input ----------
const input = {
  moveX: 0, moveY: 0, lookDX: 0, lookDY: 0,
  jump: false, sprint: false, shoot: false, shootPressed: false,
  interact: false, reload: false, aim: false, aimPad: false, aimTouch: false, slide: false,
  device: 'kbm', gamepadKind: 'xbox',
  sprintGamepad: false, shootGamepad: false,
};
const keys = {};
let aimX = innerWidth / 2, aimY = innerHeight / 2;
let rmbDrag = false, lastMX = 0, lastMY = 0;

addEventListener('keydown', e => {
  keys[e.code] = true;
  input.device = 'kbm';
  if (e.code === 'KeyE') input.interact = true;
  if (e.code === 'KeyR') input.reload = true;
  if ((e.code === 'KeyQ' || e.code === 'KeyF') && !e.repeat) cycleWeapon(1);
  if (e.code === 'KeyV' && !e.repeat) toggleFPV();
  if ((e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') && !e.repeat) input.slide = true;
  if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
  if (e.code === 'Tab') { e.preventDefault(); toggleControlsBar(); }
  refreshControlsBar();
});
addEventListener('keyup', e => { keys[e.code] = false; });

addEventListener('mousemove', e => {
  const sens = settings.mouseSens || 1;
  if (document.pointerLockElement === canvas) {
    // locked: the mouse aims the camera directly (proper third-person look), crosshair centred
    input.lookDX += e.movementX * 0.0052 * sens;
    input.lookDY += e.movementY * 0.0052 * sens;
  } else {
    aimX = e.clientX; aimY = e.clientY;
    // unlocked (no pointer lock yet): drag with the button held to look around
    if (rmbDrag || input.shoot) {
      input.lookDX += (e.clientX - lastMX) * 0.0052 * sens;
      input.lookDY += (e.clientY - lastMY) * 0.0052 * sens;
    }
    lastMX = e.clientX; lastMY = e.clientY;
  }
  if (!isTouch && input.device !== 'kbm') { input.device = 'kbm'; refreshControlsBar(); }
});
function grabPointer() {
  if (isTouch || document.pointerLockElement === canvas) return;
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch (err) {}
}
canvas.addEventListener('mousedown', e => {
  initAudio();
  if (game.state === 'playing') grabPointer();
  lastMX = e.clientX; lastMY = e.clientY;
  if (e.button === 0 && game.state === 'playing') { input.shoot = true; input.shootPressed = true; }
  // right mouse: aim / zoom. third-person = tighter over-the-shoulder; first-person = focus down the sights.
  if (e.button === 2) { rmbDrag = true; input.aim = true; }
});
// Esc naturally releases the pointer lock -> treat that as opening the pause menu
let lockLossT = -9999;
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas && game.state === 'playing' && input.device === 'kbm') {
    lockLossT = performance.now();
    pauseGame();
  }
});
addEventListener('mouseup', e => {
  if (e.button === 0) input.shoot = false;
  if (e.button === 2) { rmbDrag = false; input.aim = false; }
});
addEventListener('wheel', e => {
  if (game.state === 'playing') camDist = clamp(camDist + e.deltaY * 0.004, 2.6, 9.5);
}, { passive: true });
addEventListener('contextmenu', e => e.preventDefault());

// --- touch (Roblox mobile style) ---
const isTouch = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
const touchLayer = document.getElementById('touchlayer');
const joyBase = document.getElementById('joyBase');
const joyKnob = document.getElementById('joyKnob');
let joyTouchId = null, camTouchId = null;
let joyOrigin = { x: 0, y: 0 };
const JOY_R = 48;
let sprintToggle = false;

if (isTouch) {
  document.body.classList.add('touchmode');
  input.device = 'touch';
}

function bindBtn(id, down, up) {
  const el = document.getElementById(id);
  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('pressed'); initAudio(); down(); }, { passive: false });
  el.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('pressed'); if (up) up(); }, { passive: false });
  el.addEventListener('touchcancel', e => { el.classList.remove('pressed'); if (up) up(); }, { passive: false });
}
bindBtn('btnJump', () => { input.jump = true; });
bindBtn('btnShoot', () => { input.shoot = true; input.shootPressed = true; }, () => { input.shoot = false; });
bindBtn('btnAim', () => { input.aimTouch = true; }, () => { input.aimTouch = false; });
bindBtn('btnView', () => { toggleFPV(); });
bindBtn('btnCycle', () => { cycleWeapon(1); });
bindBtn('btnReload', () => { input.reload = true; });
bindBtn('btnInteract', () => { input.interact = true; });
bindBtn('btnSprint', () => {
  sprintToggle = !sprintToggle;
  document.getElementById('btnSprint').style.background = sprintToggle ? 'rgba(120,255,140,.35)' : 'rgba(255,255,255,.14)';
});

let camLast = { x: 0, y: 0 };
touchLayer.addEventListener('touchstart', e => {
  initAudio();
  input.device = 'touch'; refreshControlsBar();
  for (const t of e.changedTouches) {
    if (t.target.closest('.tbtn')) continue;
    if (t.clientX < innerWidth * 0.45 && joyTouchId === null) {
      joyTouchId = t.identifier;
      joyOrigin = { x: t.clientX, y: t.clientY };
      joyBase.style.display = 'block';
      joyBase.style.left = t.clientX + 'px';
      joyBase.style.top = t.clientY + 'px';
      joyKnob.style.left = '50%'; joyKnob.style.top = '50%';
    } else if (camTouchId === null) {
      camTouchId = t.identifier;
      camLast = { x: t.clientX, y: t.clientY };
    }
  }
}, { passive: false });
touchLayer.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joyTouchId) {
      let dx = t.clientX - joyOrigin.x, dy = t.clientY - joyOrigin.y;
      const d = Math.hypot(dx, dy);
      if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; }
      joyKnob.style.left = 'calc(50% + ' + dx + 'px)';
      joyKnob.style.top = 'calc(50% + ' + dy + 'px)';
      input.moveX = dx / JOY_R;
      input.moveY = dy / JOY_R;
    } else if (t.identifier === camTouchId) {
      input.lookDX += (t.clientX - camLast.x) * 0.006;
      input.lookDY += (t.clientY - camLast.y) * 0.006;
      camLast = { x: t.clientX, y: t.clientY };
    }
  }
}, { passive: false });
function touchEnd(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === joyTouchId) {
      joyTouchId = null;
      joyBase.style.display = 'none';
      input.moveX = 0; input.moveY = 0;
    } else if (t.identifier === camTouchId) camTouchId = null;
  }
}
touchLayer.addEventListener('touchend', touchEnd);
touchLayer.addEventListener('touchcancel', touchEnd);

// --- gamepad ---
addEventListener('gamepadconnected', e => {
  gpIndex = e.gamepad.index;
  input.gamepadKind = /dual|playstation|054c|ps4|ps5/i.test(e.gamepad.id) ? 'ps' : 'xbox';
});
addEventListener('gamepaddisconnected', e => { if (gpIndex === e.gamepad.index) gpIndex = null; });
const gpPrev = {};
function pollGamepad(dt) {
  if (gpIndex === null) return;
  const gp = navigator.getGamepads()[gpIndex];
  if (!gp) return;
  const dz = v => Math.abs(v) < 0.16 ? 0 : v;
  const mx = dz(gp.axes[0]), my = dz(gp.axes[1]); // stick up = my<0 = forward
  const lx = dz(gp.axes[2]), ly = dz(gp.axes[3]);
  const pressed = i => gp.buttons[i] && gp.buttons[i].pressed;
  const justPressed = i => { const p = pressed(i), was = gpPrev[i]; gpPrev[i] = p; return p && !was; };

  const anyActivity = mx || my || lx || ly || gp.buttons.some(b => b.pressed);
  if (anyActivity && input.device !== input.gamepadKind) {
    input.device = input.gamepadKind;
    refreshControlsBar();
  }
  if (mx || my) { input.moveX = mx; input.moveY = my; }
  else if (input.device === input.gamepadKind && joyTouchId === null) { input.moveX = 0; input.moveY = 0; }
  // paused: the pad drives the menu instead of the blob
  if (game.state === 'paused') {
    padMenuNav(gp, dt, justPressed, mx, my);
    if (justPressed(9)) resumeGame();
    input.shootGamepad = false; gpPrev.rt = false;
    return;
  }
  const padSens = settings.padSens || 1;
  input.lookDX += lx * 2.6 * dt * padSens;
  input.lookDY += ly * 2.0 * dt * padSens;
  if (justPressed(0)) input.jump = true;
  if (justPressed(1)) input.reload = true;
  if (justPressed(2)) input.interact = true;
  if (justPressed(3)) cycleWeapon(1);              // Y / Triangle: cycle weapon
  if (justPressed(10)) input.sprintGamepad = !input.sprintGamepad;
  if (justPressed(11)) input.slide = true;         // R3: slide
  const rt = gp.buttons[7] && (gp.buttons[7].pressed || gp.buttons[7].value > 0.4);
  if (rt && !gpPrev.rt) input.shootPressed = true;
  gpPrev.rt = rt;
  input.shootGamepad = rt;
  // left trigger: aim down sights (ease to first person)
  input.aimPad = !!(gp.buttons[6] && (gp.buttons[6].pressed || gp.buttons[6].value > 0.35));
  if (justPressed(9)) togglePause();     // Start: pause menu
  if (justPressed(8)) toggleFPV();       // Back/Select: first/third person toggle
}

// ---------- controls bar / prompts ----------
const controlsEl = document.getElementById('controls');
const devnameEl = document.getElementById('devname');
controlsEl.addEventListener('click', toggleControlsBar);
controlsEl.addEventListener('touchstart', e => { e.stopPropagation(); }, { passive: true });
function toggleControlsBar() { controlsEl.classList.toggle('collapsed'); }

const ICON = {
  kbm: p => `icons/kbm/${p}.png`,
  xbox: p => `icons/xbox/${p}.png`,
  ps: p => `icons/ps/${p}.png`,
  touch: p => `icons/touch/${p}.png`,
};
const CONTROL_SCHEMES = {
  kbm: {
    name: 'Keyboard & Mouse',
    rows: [
      [['kbm', 'keyboard_w'], ['kbm', 'keyboard_a'], ['kbm', 'keyboard_s'], ['kbm', 'keyboard_d'], 'Move'],
      [['kbm', 'mouse_move'], 'Aim / Look'],
      [['kbm', 'mouse_left'], 'Shoot'],
      [['kbm', 'mouse_right'], 'Zoom / ADS'],
      [['kbm', 'keyboard_f'], 'Swap weapon'],
      ['V', 'First / Third view'],
      [['kbm', 'mouse_scroll'], 'Cam distance'],
      [['kbm', 'keyboard_e'], 'Loot / Recruit'],
      [['kbm', 'keyboard_r'], 'Reload'],
      [['kbm', 'keyboard_space'], 'Jump'],
      [['kbm', 'keyboard_shift'], 'Sprint'],
      [['kbm', 'keyboard_ctrl'], 'Slide'],
      ['Tab', 'Hide this help'],
    ],
    prompt: ['kbm', 'keyboard_e'],
  },
  xbox: {
    name: 'Xbox Controller',
    rows: [
      [['xbox', 'xbox_stick_l'], 'Move'],
      [['xbox', 'xbox_stick_r'], 'Look'],
      [['xbox', 'xbox_rt'], 'Shoot'],
      [['xbox', 'xbox_lt'], 'Zoom / ADS'],
      [['xbox', 'xbox_button_color_y'], 'Swap weapon'],
      ['Select', 'First / Third view'],
      [['xbox', 'xbox_button_color_x'], 'Loot / Recruit'],
      [['xbox', 'xbox_button_color_b'], 'Reload'],
      [['xbox', 'xbox_button_color_a'], 'Jump'],
      [['xbox', 'xbox_stick_side_l'], 'Sprint (L3)'],
      [['xbox', 'xbox_stick_side_r'], 'Slide (R3)'],
    ],
    prompt: ['xbox', 'xbox_button_color_x'],
  },
  ps: {
    name: 'PlayStation Controller',
    rows: [
      [['ps', 'playstation_stick_l'], 'Move'],
      [['ps', 'playstation_stick_r'], 'Look'],
      [['ps', 'playstation_trigger_r2'], 'Shoot'],
      [['ps', 'playstation_trigger_l2'], 'Zoom / ADS'],
      [['ps', 'playstation_button_triangle'], 'Swap weapon'],
      ['Share', 'First / Third view'],
      [['ps', 'playstation_button_square'], 'Loot / Recruit'],
      [['ps', 'playstation_button_circle'], 'Reload'],
      [['ps', 'playstation_button_cross'], 'Jump'],
      [['ps', 'playstation_stick_side_l'], 'Sprint (L3)'],
      [['ps', 'playstation_stick_side_r'], 'Slide (R3)'],
    ],
    prompt: ['ps', 'playstation_button_square'],
  },
  touch: {
    name: 'Touch',
    rows: [
      [['touch', 'touch_swipe_move'], 'Left side: joystick'],
      [['touch', 'touch_swipe_horizontal'], 'Right side: look'],
      [['touch', 'touch_tap'], 'Shoot / Aim / GUN / VIEW'],
    ],
    prompt: ['touch', 'touch_tap'],
  },
};
let shownDevice = null;
function refreshControlsBar() {
  if (shownDevice === input.device) return;
  shownDevice = input.device;
  const scheme = CONTROL_SCHEMES[input.device];
  devnameEl.textContent = scheme.name;
  controlsEl.querySelectorAll('.row').forEach(r => r.remove());
  for (const row of scheme.rows) {
    const div = document.createElement('div');
    div.className = 'row';
    for (const item of row) {
      if (Array.isArray(item)) {
        const img = document.createElement('img');
        img.src = ICON[item[0]](item[1]);
        img.alt = item[1];
        div.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.textContent = item;
        div.appendChild(span);
      }
    }
    controlsEl.appendChild(div);
  }
  const p = scheme.prompt;
  document.getElementById('promptimg').src = ICON[p[0]](p[1]);
}

// ---------- cousins ----------
const COUSINS = [
  { id: 'blingo',  name: 'Blingo',  color: 0xff8c42, perk: 'Balanced hero', melee: 'bat',     lore: 'The First Immune. Bitten at the Blob Falls picnic on day one, never turned. He swore on his grandma’s jelly recipe to take the town back.' },
  { id: 'blazo',   name: 'Blazo',   color: 0xff4f42, perk: '+15% damage',   melee: 'axe',     lore: 'Blingo’s hot-headed cousin. The horde ate his championship chili stand. Now every trigger pull is seasoned with revenge.' },
  { id: 'blizzy',  name: 'Blizzy',  color: 0x6fd8ff, perk: '+12% sprint speed', melee: 'katana', lore: 'The coolest head in Clan Blob. Scouted the frozen north alone for two winters. Zombies can’t catch what they can’t chill.' },
  { id: 'blomba',  name: 'Blomba',  color: 0xb06fff, perk: '+25 max HP',    melee: 'sledge',  lore: 'Big-hearted bouncer of the old Blob Lounge. Soft on the inside, softer on the outside, absolutely will not fall over.' },
  { id: 'bloopy',  name: 'Bloopy',  color: 0x3fd8b0, perk: '35% faster reload', melee: 'pipe', lore: 'Fidgety tinkerer who rebuilt the clan radio from soup cans. Hands so twitchy the reloads finish themselves.' },
  { id: 'blondie', name: 'Blondie', color: 0xffd84a, perk: '+50% ammo from loot', melee: 'machete', lore: 'The clan hoarder. Her pockets don’t make sense geometrically. If there’s a bullet in a crate, she’ll find three.' },
];
const CLAN_LORE = 'The immune cousins of Clan Blob are clearing the wasteland so the rest of blob-kind can move back home.';
let selectedCousin = 'blingo';
const companions = []; // {data, blob, beacon, pos, recruited, shootCd, walkPhase, yaw}

function scatterCousins() {
  for (const c of companions) {
    scene.remove(c.blob.root);
    if (c.blob.shadow) scene.remove(c.blob.shadow);
    if (c.beacon) scene.remove(c.beacon);
  }
  companions.length = 0;
  recruitCounter = 0;
  let i = 0;
  for (const data of COUSINS) {
    if (data.id === selectedCousin) continue;
    const ang = i * (TAU / 5) + Math.random() * 0.8;
    const dist = 65 + i * 18 + Math.random() * 25;
    let x = Math.sin(ang) * dist, z = Math.cos(ang) * dist;
    [x, z] = resolveCollision(x, z, 0.6);
    const blob = buildBlob({ color: data.color, gunHand: data.id === 'blondie' ? 'left' : 'right' });
    blob.root.position.set(x, groundHeight(x, z), z);
    scene.add(blob.root);
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 34, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: data.color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
    );
    beacon.position.set(x, groundHeight(x, z) + 17, z);
    scene.add(beacon);
    // every cousin carries their signature melee weapon until you trade them something else
    const gun = buildGunMesh(data.melee);
    blob.gunSocket.add(gun);
    const maxHp = data.id === 'blomba' ? 125 : 100;
    companions.push({ data, blob, beacon, pos: new THREE.Vector3(x, 0, z), recruited: false, shootCd: 0, walkPhase: Math.random() * 9, yaw: Math.random() * TAU,
      weapon: WEAPONS[data.melee], gunMesh: gun, hp: maxHp, maxHp, downed: false,
      y: groundHeight(x, z), vy: 0, grounded: true, meleeT: 0 });
    i++;
  }
  updateCousinHUD();
  rebuildSquadBars();
}
function updateCousinHUD() {
  const n = companions.filter(c => c.recruited).length;
  document.querySelector('#cousins b').textContent = n + '/' + companions.length;
}

// ---------- squad + player health bars (bottom-left) ----------
const squadBarsEl = document.getElementById('squadbars');
const squadBarEls = []; // {row, bar, c}
function rebuildSquadBars() {
  squadBarsEl.innerHTML = '';
  squadBarEls.length = 0;
  // recruited cousins, in the order they were found, each colour-coded to their character
  const squad = companions.filter(c => c.recruited).sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const c of squad) {
    const hex = '#' + c.data.color.toString(16).padStart(6, '0');
    const row = document.createElement('div');
    row.className = 'sqrow';
    row.innerHTML = `<div class="sqwrap"><div class="sqbar" style="background:${hex}"></div></div>` +
                    `<span class="sqname" style="color:${hex}">${c.data.name}</span>`;
    squadBarsEl.appendChild(row);
    squadBarEls.push({ row, bar: row.querySelector('.sqbar'), c });
  }
}
function updateSquadBars() {
  for (const e of squadBarEls) {
    e.bar.style.width = clamp(e.c.hp / e.c.maxHp, 0, 1) * 100 + '%';
    e.row.classList.toggle('down', !!e.c.downed);
  }
}
function hurtCompanion(c, dmg) {
  if (c.downed || !c.recruited) return;
  c.hp -= dmg;
  c.lastHurtT = game.time;
  flashBlob(c.blob);
  if (c.hp <= 0) {
    // downed, not dead — but they stay down until you walk over and pick them up
    c.hp = 0; c.downed = true;
    play3d(c.pos.x, c.pos.z, () => SFX.hurt());
    // red rescue beacon marks where they fell
    c.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 34, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
    );
    c.beacon.position.set(c.pos.x, groundHeight(c.pos.x, c.pos.z) + 17, c.pos.z);
    scene.add(c.beacon);
    toast(`${c.data.name.toUpperCase()} IS DOWN — PICK THEM UP!`);
  }
}
// haul a downed cousin back onto their feet at half health
function reviveCousin(c) {
  c.downed = false;
  c.hp = c.maxHp * 0.5;
  c.blob.wob.rotation.x = 0;
  c.blob.wob.scale.set(1, 1, 1);
  if (c.beacon) { scene.remove(c.beacon); c.beacon = null; }
  SFX.recruit();
  rumble(140, 0.5, 0.6);
  toast(`${c.data.name.toUpperCase()} IS BACK UP`);
}

// ---------- player ----------
let playerBlob = buildBlob({ color: 0xff8c42 });
scene.add(playerBlob.root);
let gunMesh = null;

const player = {
  pos: new THREE.Vector3(0, 0, 0),
  vy: 0, grounded: true,
  hp: 100, maxHp: 100,
  camYaw: 0, camPitch: -0.24,
  weapon: WEAPONS.fists,
  clip: Infinity,
  reloading: 0, shootCd: 0, lastShotT: -9, lastHurtT: -9, lastAimYaw: 0,
  walkPhase: 0, squash: 0, dead: false, idlePhase: 0,
  stumbleT: 0, stumbleX: 0, stumbleZ: 0, meleeArm: 0,
  slideT: 0, slideDX: 0, slideDZ: 0, hopT: 0,
  dmgMult: 1, sprintMult: 1, reloadMult: 1, ammoMult: 1,
  owned: ['fists'], aiming: false, aimT: 0,   // aimT: eased 0=hip .. 1=aiming down / zoomed
  fpv: false, fpvT: 0,                         // fpv toggle (V / Select); fpvT eased 0=third-person .. 1=first-person
};
const reserves = {};

// take damage: stumble away from the hit, still able to fight; heavy gore paints the screen
function hurtPlayer(dmg, awayX, awayZ) {
  if (player.dead) return;
  player.hp -= dmg;
  player.lastHurtT = game.time;
  const d = Math.hypot(awayX, awayZ) || 1;
  player.stumbleX = awayX / d; player.stumbleZ = awayZ / d;
  player.stumbleT = 0.42;
  SFX.hurt();
  flashBlob(playerBlob);
  rumble(220, 0.9, 0.6);
  shakeAmp = Math.max(shakeAmp, 0.1);
  spawnParticles(player.pos.x, player.pos.y + 1, player.pos.z, 0xff5b5b, 5, 2.5, 0.4);
  if (extraGoreOn()) {
    spawnBlood(player.pos.x, player.pos.y + 1, player.pos.z, player.stumbleX, player.stumbleZ, 1.4);
    bloodSplat();
  }
  if (player.hp <= 0 && !player.dead) die();
}

function applyCousin(id) {
  selectedCousin = id;
  const data = COUSINS.find(c => c.id === id);
  scene.remove(playerBlob.root);
  if (playerBlob.shadow) scene.remove(playerBlob.shadow);
  playerBlob = buildBlob({ color: data.color, gunHand: id === 'blondie' ? 'left' : 'right' });
  scene.add(playerBlob.root);
  player.colorHex = '#' + data.color.toString(16).padStart(6, '0');
  document.documentElement.style.setProperty('--hero', player.colorHex);
  startTheme(id);
  player.dmgMult = id === 'blazo' ? 1.15 : 1;
  player.sprintMult = id === 'blizzy' ? 1.12 : 1;
  player.maxHp = id === 'blomba' ? 125 : 100;
  player.reloadMult = id === 'bloopy' ? 0.65 : 1;
  player.ammoMult = id === 'blondie' ? 1.5 : 1;
  if (gunMesh) { gunMesh.removeFromParent(); gunMesh = null; }
  equipWeapon(player.weapon.id === 'fists' ? 'fists' : player.weapon.id);
}

function equipWeapon(id) {
  player.weapon = WEAPONS[id];
  if (!player.owned.includes(id)) player.owned.push(id);
  // keep the loadout organised into slots: melee group first, then guns by tier
  player.owned.sort((a, b) => slotRank(a) - slotRank(b));
  if (gunMesh) { player.reloading = 0; gunMesh.removeFromParent(); gunMesh = null; }
  if (!player.weapon.melee) {
    gunMesh = buildGunMesh(id);
    playerBlob.gunSocket.add(gunMesh);
    player.clip = player.weapon.mag;
    if (reserves[id] === undefined) reserves[id] = Math.round(player.weapon.ammo * player.ammoMult);
  } else {
    // melee weapons get a visible model in the fist too (fists stay bare)
    if (id !== 'fists') {
      gunMesh = buildGunMesh(id);
      playerBlob.gunSocket.add(gunMesh);
    }
    player.clip = Infinity;
  }
  updateAmmoHUD();
  updateWeaponBtn();
  document.getElementById('weaponname').textContent = player.weapon.name;
}
// cycle to the next weapon the player owns, with that gun's own switch sound
function cycleWeapon(dir = 1) {
  if (player.dead || player.owned.length < 2) return;
  let idx = player.owned.indexOf(player.weapon.id);
  if (idx < 0) idx = 0;
  idx = (idx + dir + player.owned.length) % player.owned.length;
  const id = player.owned[idx];
  if (id === player.weapon.id) return;
  equipWeapon(id);
  SFX.swap(WEAPONS[id]);
  toast(WEAPONS[id].name.toUpperCase());
  rumble(40, 0.2, 0.3);
}
// V / Select flips between the over-the-shoulder third-person rig and first person
function toggleFPV() {
  if (player.dead) return;
  player.fpv = !player.fpv;
  toast(player.fpv ? 'FIRST PERSON' : 'THIRD PERSON');
  initAudio(); SFX.swap({ id: 'view' });
  rumble(40, 0.2, 0.3);
  const vb = document.getElementById('btnView');
  if (vb) vb.classList.toggle('pressed', player.fpv);
}

// ---------- zombies ----------
const zombies = [];
const ZOMBIE_COLORS = [0x6fae4e, 0x7fb85a, 0x5f9a44, 0x8fbc6a];
// opts.mode: 'grave' claws up out of the dirt, 'sleeper' lies on the ground until you're
// close, 'runner' spawns far out and sprints in, default 'pop' just appears (boss waves).
// opts.horns: purple boss-wave guard — wears the Two Horned One's horns and shields him while alive.
function spawnZombie(x, z, powerScale = 1, opts = {}) {
  const purple = !!opts.purple;              // boss-swarm variant: purple & 33% faster
  const mode = opts.mode || 'pop';
  const scale = 0.85 + Math.random() * 0.5;
  // random rot-variants; brain-showing spawns are the rare weak-spot walkers
  const droopy = !purple && Math.random() < 0.3;
  const brain = Math.random() < 0.12;
  const blind = !purple && Math.random() < 0.16;
  // extra-gore mode makes fresh zombies spawn already mangled and bloody
  const wounded = extraGoreOn() && Math.random() < 0.35 + settings.extraGore * 0.5;
  const color = purple ? 0x9b4dff : ZOMBIE_COLORS[(Math.random() * ZOMBIE_COLORS.length) | 0];
  const blob = buildBlob({ color, zombie: true, scale, droopy, brain, blind, wounded });
  blob.root.position.set(x, groundHeight(x, z), z);
  if (opts.horns) {
    for (const s of [-1, 1]) {
      const horn = cyl(0.015, 0.12, 0.42, 0x2a1a3a, 6);
      horn.position.set(0.2 * s, 0.28, 0.02); horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
      blob.head.add(horn);
    }
  }
  // 1-in-10 shuffles in already missing an arm, a dried blood glob capping the shoulder
  if (Math.random() < 0.1) {
    const idx = Math.random() < 0.5 ? 0 : 1;
    blob.arms[idx].visible = false;
    blob.armGone[idx] = true;
    const glob = ball(0.16, BLOOD);
    glob.position.copy(blob.arms[idx].position);
    glob.position.y -= 0.15;
    blob.wob.add(glob);
  }
  if (mode === 'sleeper') blob.root.rotation.x = -1.45; // sprawled on its back
  scene.add(blob.root);
  zombies.push({
    blob, pos: new THREE.Vector3(x, 0, z),
    hp: (55 + Math.random() * 40) * scale * powerScale * (purple ? 1.2 : 1),
    speed: (1.5 + Math.random() * 1.4) * (0.9 + powerScale * 0.1) * (purple ? 1.33 : 1) * (mode === 'runner' ? 1.5 : 1),
    yaw: Math.random() * TAU,
    state: mode === 'grave' ? 'emerge' : mode === 'sleeper' ? 'sleep' : 'chase',
    attackT: 0, deadT: 0, walkPhase: Math.random() * 10,
    groanT: Math.random() * 6, scale,
    brainExposed: brain, blind, stepT: Math.random(),
    bleeding: wounded, dripT: 0, purple,
    mode, emergeT: 0, hornWave: !!opts.horns,
    despawnR: mode === 'runner' ? 140 : 85,
    wanderT: 0, wanderYaw: Math.random() * TAU, shotIgnoreT: -99,
  });
}

// ---------- pickups ----------
const pickups = [];
function spawnPickup(kind, x, z) {
  const g = new THREE.Group();
  if (kind === 'ammo') {
    const b = box(0.3, 0.2, 0.22, 0x3f6d3a, { emissive: 0x1a3a14, emissiveIntensity: 0.8 });
    b.position.y = 0.1; g.add(b);
  } else {
    const b = box(0.32, 0.22, 0.32, 0xd8dde5);
    b.position.y = 0.11; g.add(b);
    const c1 = box(0.22, 0.06, 0.07, 0xd23b3b); c1.position.y = 0.23; g.add(c1);
    const c2 = box(0.07, 0.06, 0.22, 0xd23b3b); c2.position.y = 0.23; g.add(c2);
  }
  g.position.set(x, groundHeight(x, z), z);
  scene.add(g);
  pickups.push({ mesh: g, kind, pos: new THREE.Vector3(x, 0, z), t: 0 });
}

// ---------- particles / tracers ----------
const particles = [];
const partGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
function spawnParticles(x, y, z, color, n, speed = 3, life = 0.5) {
  for (let i = 0; i < n; i++) {
    if (particles.length > 220) break;
    const m = new THREE.Mesh(partGeo, mat(color));
    m.position.set(x, y, z);
    scene.add(m);
    particles.push({
      mesh: m, life: life * (0.6 + Math.random() * 0.7),
      vx: (Math.random() - 0.5) * speed, vy: Math.random() * speed * 0.8, vz: (Math.random() - 0.5) * speed,
    });
  }
}

// ---------- gore: blood, gibs, ground splatter, dismemberment ----------
const gibs = [];
const gibGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
const decals = [];
const MAX_DECALS = 200; // higher cap so bleeding trails stay visible for a while
const decalGeo = new THREE.CircleGeometry(1, 12);
const BLOOD = 0x7a0f0f;
// how much blood to throw: base gore slider, boosted by the unlocked extra-gore slider
function goreAmt() { return settings.gore + settings.extraGore * 1.4; }
function extraGoreOn() { return settings.gore >= 0.999 && settings.extraGore > 0; }
function spawnBlood(x, y, z, kx, kz, mult = 1) {
  const g = goreAmt();
  if (g <= 0.02) return;
  const n = Math.round((3 + Math.random() * 4) * g * mult);
  for (let i = 0; i < n; i++) {
    if (particles.length > 240) break;
    const m = new THREE.Mesh(partGeo, mat(BLOOD));
    m.position.set(x, y, z);
    scene.add(m);
    particles.push({
      mesh: m, life: 0.5 * (0.6 + Math.random() * 0.8), blood: true,
      vx: (kx || 0) * 2 + (Math.random() - 0.5) * 3, vy: Math.random() * 3, vz: (kz || 0) * 2 + (Math.random() - 0.5) * 3,
    });
  }
  if (extraGoreOn() && Math.random() < 0.5 + settings.extraGore * 0.5) groundSplat(x, z, 0.4 + Math.random() * 0.6 * mult);
}
function groundSplat(x, z, r) {
  const m = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({ color: BLOOD, transparent: true, opacity: 0.6, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.rotation.z = Math.random() * TAU;
  // lifted enough to sit on road/parking surfaces (+0.04/+0.05) too, not just grass
  m.scale.setScalar(r); m.position.set(x, groundHeight(x, z) + 0.07, z); m.renderOrder = 1;
  scene.add(m);
  decals.push(m);
  if (decals.length > MAX_DECALS) { const old = decals.shift(); scene.remove(old); old.material.dispose(); }
}
// paint a flattened blood stain onto a blob's body ellipsoid, so blood reads as being ON
// the body rather than a separate blob floating in front. `count` ({n}) caps accumulation.
function stainBody(wob, count, angY, heightT, mult = 1) {
  if (goreAmt() <= 0.02 || (count && count.n >= 7)) return null;
  if (count) count.n++;
  const ny = clamp(heightT, -0.8, 0.85);
  const rXZ = Math.sqrt(Math.max(0, 1 - ny * ny));
  const nx = Math.sin(angY) * rXZ, nz = Math.cos(angY) * rXZ;
  const s = (0.11 + Math.random() * 0.07) * mult;
  const stain = ball(s, BLOOD);
  stain.scale.set(s, s * 0.55, s);          // thin splat that hugs the body surface
  stain.position.set(0.55 * nx * 0.92, 0.62 + 0.6 * ny, 0.5 * nz * 0.92);
  wob.add(stain);
  return stain;
}
function spawnGib(x, y, z, color, kx, kz) {
  if (gibs.length > 60) return;
  const m = new THREE.Mesh(gibGeo, mat(color));
  m.position.set(x, y, z);
  m.scale.setScalar(0.6 + Math.random() * 0.8);
  scene.add(m);
  gibs.push({ mesh: m, life: 3 + Math.random() * 2, bled: false,
    vx: (kx || 0) * 3 + (Math.random() - 0.5) * 4, vy: 3 + Math.random() * 4, vz: (kz || 0) * 3 + (Math.random() - 0.5) * 4,
    spin: (Math.random() - 0.5) * 14 });
}
// reveal the brain (weak spot) on a zombie's head: crack the skull cap open
function exposeBrain(z) {
  if (z.brainExposed) return;
  z.brainExposed = true;
  const b = z.blob;
  if (b.brainMesh) b.brainMesh.visible = true;
  if (b.skull) b.skull.visible = false;
}
// limb hitboxes in the zombie's facing frame: [kind, idx, localX, localY, localZ, radius].
// a bullet that strikes one of these severs that exact limb (dismemberment local to the shot).
const LIMB_SPEC = [
  ['arm', 0, -0.5, 0.80, 0.18, 0.30],
  ['arm', 1,  0.5, 0.80, 0.18, 0.30],
  ['leg', 0, -0.2, 0.28, 0.02, 0.24],
  ['leg', 1,  0.2, 0.28, 0.02, 0.24],
];
// sever an arm or leg; returns true if one came off. arms are weighted higher so you can
// reliably shoot arms off.
function blowLimb(z, kx, kz, spec) {
  const b = z.blob;
  let kind, idx;
  // dismemberment is local to the limb that was actually shot, when we know which one
  if (spec && spec.kind && b[spec.kind + 'Gone'] && !b[spec.kind + 'Gone'][spec.idx]) {
    kind = spec.kind; idx = spec.idx;
  } else {
    const opts = [];
    if (!b.armGone[0]) { opts.push(['arm', 0]); opts.push(['arm', 0]); }
    if (!b.armGone[1]) { opts.push(['arm', 1]); opts.push(['arm', 1]); }
    if (!b.legGone[0]) opts.push(['leg', 0]);
    if (!b.legGone[1]) opts.push(['leg', 1]);
    if (!opts.length) return false;
    [kind, idx] = opts[(Math.random() * opts.length) | 0];
  }
  const grp = kind === 'arm' ? b.arms[idx] : b.legs[idx];
  const wp = new THREE.Vector3(); grp.getWorldPosition(wp);
  grp.visible = false;
  if (kind === 'arm') b.armGone[idx] = true; else b.legGone[idx] = true;
  // stump
  const stump = ball(0.14, BLOOD);
  stump.position.copy(grp.position); stump.position.y += kind === 'arm' ? -0.2 : -0.1;
  b.wob.add(stump);
  const limbCol = kind === 'arm' ? 0x8aa85a : 0x39432a;
  spawnGib(wp.x, wp.y, wp.z, limbCol, kx, kz);
  spawnGib(wp.x, wp.y, wp.z, BLOOD, kx, kz);
  spawnBlood(wp.x, wp.y, wp.z, kx, kz, 1.6);
  play3d(z.pos.x, z.pos.z, () => SFX.limb());
  return true;
}
// pop the head off: it disappears, they fall
function popHead(z, kx, kz) {
  const b = z.blob;
  if (b.headGone) return;
  b.headGone = true;
  const wp = new THREE.Vector3(); b.head.getWorldPosition(wp);
  b.head.visible = false;
  const stump = ball(0.16, BLOOD);
  stump.position.set(0, 1.0, 0);
  b.wob.add(stump);
  for (let i = 0; i < 3; i++) spawnGib(wp.x, wp.y, wp.z, i ? BLOOD : 0xdb8b9b, kx, kz);
  spawnBlood(wp.x, wp.y, wp.z, kx, kz, 2.4);
  play3d(z.pos.x, z.pos.z, () => SFX.headpop());
}

const tracers = [];
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 });
function spawnTracer(from, to) {
  const len = from.distanceTo(to);
  if (len < 0.2) return;
  const g = new THREE.BoxGeometry(0.025, 0.025, len);
  const m = new THREE.Mesh(g, tracerMat.clone());
  m.position.copy(from).lerp(to, 0.5);
  m.lookAt(to);
  scene.add(m);
  tracers.push({ mesh: m, life: 0.07 });
}
const flashMat = new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.95 });
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), flashMat);
flash.visible = false;
scene.add(flash);
let flashT = 0;

// ---------- HUD ----------
const hud = {
  health: document.getElementById('healthbar'),
  healthTxt: document.getElementById('healthtxt'),
  clip: document.getElementById('ammoclip'),
  res: document.getElementById('ammores'),
  kills: document.querySelector('#kills b'),
  timer: document.querySelector('#timer b'),
  crates: document.querySelector('#crates b'),
  vignette: document.getElementById('vignette'),
  hitmarker: document.getElementById('hitmarker'),
  crosshair: document.getElementById('crosshair'),
  prompt: document.getElementById('prompt'),
  prompttxt: document.getElementById('prompttxt'),
  toast: document.getElementById('toast'),
  reloadmsg: document.getElementById('reloadmsg'),
  btnInteract: document.getElementById('btnInteract'),
};
const scopeEl = document.getElementById('scope');
function updateAmmoHUD() {
  if (player.weapon.melee) { hud.clip.textContent = '∞'; hud.res.textContent = ''; }
  else {
    hud.clip.textContent = player.clip;
    hud.res.textContent = ' / ' + (reserves[player.weapon.id] | 0);
  }
}
// label on the touch weapon-cycle button
function updateWeaponBtn() {
  const el = document.getElementById('btnCycle');
  if (el) el.textContent = player.weapon.melee ? 'FIST' : player.weapon.id.slice(0, 4).toUpperCase();
}
let toastT = 0;
function toast(txt, long) {
  hud.toast.textContent = txt;
  hud.toast.style.opacity = 1;
  hud.toast.style.top = '32%';
  toastT = long ? 4.2 : 1.6;
}
let hitmarkT = 0;

// ---------- game state ----------
const game = { state: 'menu', time: 0, kills: 0, cratesOpened: 0, spawnT: 2, lastShot: new THREE.Vector3(), lastShotT: -99,
  phase: 0, weather: 'sunny', cycle: 0, cleanup: false, clearTarget: 0 };

function resetGame() {
  applyCousin(selectedCousin);
  player.pos.set(0, groundHeight(0, 0), 0);
  player.vy = 0; player.hp = player.maxHp; player.dead = false;
  player.camYaw = 0; player.camPitch = -0.24;
  player.reloading = 0;
  player.lastHurtT = -9; player.lastShotT = -9;
  player.stumbleT = 0; player.idlePhase = 0; player.lastStepPh = -1; player.meleeArm = 0;
  player.slideT = 0; player.hopT = 0;
  player.owned = ['fists']; player.aiming = false; player.aimT = 0;
  player.fpv = false; player.fpvT = 0;
  input.aim = false; input.aimPad = false; input.aimTouch = false;
  const vb = document.getElementById('btnView'); if (vb) vb.classList.remove('pressed');
  game.time = 0; game.kills = 0; game.cratesOpened = 0; game.spawnT = 2; game.lastShotT = -99;
  // every run starts on a fresh morning; the sky rolls forward as blocks are cleared
  game.phase = 0; game.cycle = 0; game.weather = rollWeather(); game.cleanup = false; game.clearTarget = 0;
  applyEnvironment();
  // clear ground gore from the last run
  for (const d of decals) { scene.remove(d); d.material.dispose(); }
  decals.length = 0;
  for (const gb of gibs) scene.remove(gb.mesh);
  gibs.length = 0;
  for (const z of zombies) { scene.remove(z.blob.root); if (z.blob.shadow) scene.remove(z.blob.shadow); }
  zombies.length = 0;
  // reset the boss + its beam
  if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
  bossState.boss = null; bossState.spawned = false; bossState.defeated = false;
  bossBarEl.classList.remove('show');
  for (const p of pickups) scene.remove(p.mesh);
  pickups.length = 0;
  for (const k in reserves) delete reserves[k];
  equipWeapon('fists');
  scatterCousins();
  hud.kills.textContent = 0;
  hud.crates.textContent = 0;
  playerBlob.root.visible = true;
  // starter zombies far out
  for (let i = 0; i < 3; i++) {
    const ang = Math.random() * TAU;
    spawnZombie(Math.sin(ang) * 48, Math.cos(ang) * 48, 1, { mode: Math.random() < 0.5 ? 'grave' : 'sleeper' });
  }
}

document.getElementById('playbtn').addEventListener('click', () => {
  initAudio();
  document.getElementById('startscreen').classList.add('hidden');
  document.body.classList.add('playing');
  resetGame();
  game.state = 'playing';
  if (input.device === 'kbm') grabPointer();
});
document.getElementById('respawnbtn').addEventListener('click', () => {
  initAudio();
  document.getElementById('deathscreen').classList.add('hidden');
  document.body.classList.add('playing');
  resetGame();
  game.state = 'playing';
  if (input.device === 'kbm') grabPointer();
});

function die() {
  player.dead = true;
  game.state = 'dead';
  document.body.classList.remove('playing');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  rumble(500, 1, 1);
  const mins = Math.floor(game.time / 60), secs = Math.floor(game.time % 60);
  const n = companions.filter(c => c.recruited).length;
  document.getElementById('deathstats').innerHTML =
    `☠️ ${game.kills} kills &nbsp;•&nbsp; ⏱️ ${mins}:${String(secs).padStart(2, '0')} survived &nbsp;•&nbsp; 📦 ${game.cratesOpened} crates &nbsp;•&nbsp; 🫂 ${n} cousins found`;
  setTimeout(() => document.getElementById('deathscreen').classList.remove('hidden'), 900);
}

// ---------- blood splatter overlay (extra gore) ----------
const bloodEl = document.getElementById('bloodsplat');
let bloodSplatT = 0;
function bloodSplat() { bloodEl.style.opacity = clamp(0.5 + settings.extraGore * 0.5, 0, 1); bloodSplatT = 1.1; }

// ---------- pause menu + settings ----------
const pauseScreen = document.getElementById('pausescreen');
function pauseGame() {
  if (game.state !== 'playing') return;
  game.state = 'paused';
  syncSettingsUI();
  pauseScreen.classList.remove('hidden');
  document.body.classList.remove('playing');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  if (!themeTimer) startTheme(selectedCousin); // hero music plays over the pause menu
  if (input.device === 'xbox' || input.device === 'ps') setPadFocus(0);
  else clearPadFocus();
}
function resumeGame() {
  if (game.state !== 'paused') return;
  pauseScreen.classList.add('hidden');
  document.body.classList.add('playing');
  game.state = 'playing';
  if (input.device === 'kbm') grabPointer();
}
function quitToMenu() {
  game.state = 'menu';
  pauseScreen.classList.add('hidden');
  document.getElementById('startscreen').classList.remove('hidden');
  document.body.classList.remove('playing');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  stopTheme();
}
function togglePause() {
  if (game.state === 'playing') pauseGame();
  else if (game.state === 'paused') resumeGame();
}
document.getElementById('resumebtn').addEventListener('click', resumeGame);
document.getElementById('quitbtn').addEventListener('click', quitToMenu);
{
  const pb = document.getElementById('btnPauseHud');
  pb.addEventListener('click', e => { e.stopPropagation(); pauseGame(); });
  pb.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); pauseGame(); }, { passive: false });
}
addEventListener('keydown', e => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    // pointer-lock release already paused us on this same Esc press
    if (e.code === 'Escape' && performance.now() - lockLossT < 500) return;
    e.preventDefault();
    togglePause();
  }
});

// ---------- settings UI: snappy 5-notch bars, two columns, gamepad navigable ----------
const SETTING_DEFS = [
  ['master', 'Master'], ['sfx', 'SFX'], ['music', 'Music'], ['ambience', 'Ambience'],
  ['mouseSens', 'Mouse Sens'], ['padSens', 'Pad Sens'],
  ['zombieSpawn', 'Zombies'], ['lootSpawn', 'Loot'],
  ['gore', 'Gore'], ['extraGore', 'Extra Gore'],
];
const settingsGrid = document.getElementById('settingsGrid');
const rowEls = {};
function saveNotches() { try { localStorage.setItem('blingo-notches', JSON.stringify(notches)); } catch (e) {} }
function notchClickSfx(level) { initAudio(); tone(280 + level * 90, 0.05, 0.22, 'square'); }
function setNotch(key, n, silent) {
  n = clamp(Math.round(n), 0, 5);
  // "extra" means more than full: dialing up Extra Gore quietly fills the Gore bar first
  if (key === 'extraGore' && n > 0 && notches.gore < 5) setNotch('gore', 5, true);
  if (key === 'gore' && n < 5 && notches.extraGore > 0) { notches.extraGore = 0; refreshRow('extraGore'); }
  if (n === notches[key]) return;
  notches[key] = n;
  syncDerived();
  applyAudioSettings();
  saveNotches();
  refreshRow(key);
  if (key === 'gore') refreshRow('extraGore');
  if (!silent) notchClickSfx(n);
}
function nudgeNotch(key, dir) { setNotch(key, notches[key] + dir); }
for (const [key, label] of SETTING_DEFS) {
  const row = document.createElement('div');
  row.className = 'srow';
  row.dataset.key = key;
  const lab = document.createElement('span');
  lab.textContent = label;
  row.appendChild(lab);
  const bar = document.createElement('div');
  bar.className = 'notches';
  for (let i = 0; i < 5; i++) {
    const pip = document.createElement('div');
    pip.className = 'pip';
    // click the top lit pip to step down one; any other pip sets that level
    pip.addEventListener('click', () => setNotch(key, (i + 1 === notches[key]) ? i : i + 1));
    bar.appendChild(pip);
  }
  row.appendChild(bar);
  settingsGrid.appendChild(row);
  rowEls[key] = row;
}
function refreshRow(key) {
  const row = rowEls[key];
  const n = notches[key];
  row.querySelectorAll('.pip').forEach((p, i) => {
    const on = i < n;
    if (on && !p.classList.contains('on')) { p.classList.remove('pop'); void p.offsetWidth; p.classList.add('pop'); }
    p.classList.toggle('on', on);
  });
}
function syncSettingsUI() { for (const [key] of SETTING_DEFS) refreshRow(key); }
syncSettingsUI();

// ---------- gamepad menu navigation ----------
let padFocus = 0, padNavT = 0;
function padFocusables() {
  return [...settingsGrid.querySelectorAll('.srow'), document.getElementById('resumebtn'), document.getElementById('quitbtn')];
}
function setPadFocus(i) {
  const els = padFocusables();
  padFocus = (i + els.length) % els.length;
  els.forEach((el, j) => el.classList.toggle('focus', j === padFocus));
}
function clearPadFocus() { padFocusables().forEach(el => el.classList.remove('focus')); }
function padMenuNav(gp, dt, justPressed, ax, ay) {
  padNavT -= dt;
  const sx = Math.abs(ax) > 0.5 ? Math.sign(ax) : 0;
  const sy = Math.abs(ay) > 0.5 ? Math.sign(ay) : 0;
  const stickReady = padNavT <= 0 && (sx || sy);
  const up = justPressed(12) || (stickReady && sy < 0);
  const down = justPressed(13) || (stickReady && sy > 0);
  const left = justPressed(14) || (stickReady && sx < 0);
  const right = justPressed(15) || (stickReady && sx > 0);
  if (stickReady && (up || down || left || right)) padNavT = 0.22;
  if (up) setPadFocus(padFocus - 1);
  if (down) setPadFocus(padFocus + 1);
  const els = padFocusables();
  const el = els[padFocus];
  if (!el) return;
  if (el.classList.contains('srow')) {
    const key = el.dataset.key;
    if (left) nudgeNotch(key, -1);
    if (right) nudgeNotch(key, 1);
    if (justPressed(0)) nudgeNotch(key, 1);
  } else {
    if (left) setPadFocus(padFocus - 1);
    if (right) setPadFocus(padFocus + 1);
    if (justPressed(0)) el.click();
  }
  if (justPressed(1)) resumeGame();
}

// ---------- aiming ----------
const _aimDir = new THREE.Vector3();
function getAimDir(out) {
  // aim is camera-relative now (centred crosshair, third-person or first) — no free-aim cursor
  camera.getWorldDirection(out);
  return out;
}

// ---------- shooting ----------
const _from = new THREE.Vector3(), _to = new THREE.Vector3(), _gp = new THREE.Vector3();
function fireWeapon() {
  const w = player.weapon;
  getAimDir(_aimDir);
  player.lastAimYaw = Math.atan2(_aimDir.x, _aimDir.z);
  if (w.melee) {
    SFX.shoot(w);
    player.lastShotT = game.time;
    // fists alternate hands; an armed melee always swings the weapon hand
    player.meleeArm = w.id === 'fists' ? (player.meleeArm ^ 1) : playerBlob.gunArm;
    for (const z of zombies) {
      if (z.state === 'dying') continue;
      const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < w.range) {
        const ang = Math.atan2(dx, dz);
        let diff = Math.abs(((ang - player.lastAimYaw) % TAU + TAU + Math.PI) % TAU - Math.PI);
        if (diff < 1.15) {
          // fists send them staggering back; armed melee shoves a bit too
          damageZombie(z, w.dmg * player.dmgMult * closeBonus(w, d), dx / d, dz / d, w.id === 'fists' ? 11 : 3.5, { weapon: w, dist: d, isHead: false });
          rumble(...w.rmb);
          break;
        }
      }
    }
    return;
  }
  if (player.reloading > 0) return;
  if (player.clip <= 0) { SFX.dry(); tryReload(); return; }
  player.clip--;
  player.lastShotT = game.time;
  // gunshots are loud: blind zombies home in on this spot
  game.lastShot.set(player.pos.x, 0, player.pos.z); game.lastShotT = game.time;
  updateAmmoHUD();
  SFX.shoot(w);
  rumble(...w.rmb);
  shakeAmp = Math.max(shakeAmp, w.kick);

  if (gunMesh) {
    gunMesh.getWorldPosition(flash.position);
    flash.position.y += 0.05;
    flash.visible = true;
    flashT = 0.05;
  }

  const pellets = w.pellets || 1;
  _from.copy(camera.position);
  let anyHit = false;
  for (let p = 0; p < pellets; p++) {
    const sp = w.spread;
    const dx = _aimDir.x + (Math.random() - 0.5) * sp * 2;
    const dy = _aimDir.y + (Math.random() - 0.5) * sp * 2;
    const dzz = _aimDir.z + (Math.random() - 0.5) * sp * 2;
    const dl = Math.hypot(dx, dy, dzz);
    const rdx = dx / dl, rdy = dy / dl, rdz = dzz / dl;

    let tWall = rayGround(_from.x, _from.y, _from.z, rdx, rdy, rdz, 80);
    for (const c of nearbyColliders(player.pos.x, player.pos.z)) {
      const t = rayAABB(_from.x, _from.y, _from.z, rdx, rdy, rdz, c);
      if (t < tWall) tWall = t;
    }
    let best = null, bestT = Math.min(tWall, 80);
    for (const z of zombies) {
      if (z.state === 'dying') continue;
      const gy = z.blob.root.position.y, s = z.scale;
      const ht = raySphere(_from.x, _from.y, _from.z, rdx, rdy, rdz, z.pos.x, gy + 1.3 * s, z.pos.z, 0.42 * s);
      if (ht < bestT) { bestT = ht; best = { z, isHead: true, limb: null }; }
      const bt = raySphere(_from.x, _from.y, _from.z, rdx, rdy, rdz, z.pos.x, gy + 0.7 * s, z.pos.z, 0.55 * s);
      if (bt < bestT) { bestT = bt; best = { z, isHead: false, limb: null }; }
      // arms + legs live in the zombie's facing frame; a hit here marks that exact limb
      if (!z.isBoss) {
        const cy = Math.cos(z.yaw || 0), sy = Math.sin(z.yaw || 0);
        for (const L of LIMB_SPEC) {
          if (L[0] === 'arm' ? z.blob.armGone[L[1]] : z.blob.legGone[L[1]]) continue;
          const wx = z.pos.x + (L[2] * cy + L[4] * sy) * s;
          const wz = z.pos.z + (-L[2] * sy + L[4] * cy) * s;
          const lt = raySphere(_from.x, _from.y, _from.z, rdx, rdy, rdz, wx, gy + L[3] * s, wz, L[5] * s);
          if (lt < bestT) { bestT = lt; best = { z, isHead: false, limb: { kind: L[0], idx: L[1] } }; }
        }
      }
    }
    _to.set(_from.x + rdx * bestT, _from.y + rdy * bestT, _from.z + rdz * bestT);
    if (gunMesh) {
      gunMesh.getWorldPosition(_gp);
      spawnTracer(_gp.clone(), _to.clone());
    }
    if (best) {
      anyHit = true;
      const dHit = bestT;
      const dmg = w.dmg * player.dmgMult * (best.isHead ? 2 : 1) * closeBonus(w, dHit);
      damageZombie(best.z, dmg, rdx, rdz, w.id === 'shotgun' ? 1.2 : 2, { weapon: w, dist: dHit, isHead: best.isHead, limb: best.limb });
    } else if (bestT < 80) {
      spawnParticles(_to.x, _to.y, _to.z, 0x9a9a8a, 3, 2, 0.3);
    }
  }
  if (anyHit) { hitmarkT = 0.18; SFX.hit(); }
}
// death bookkeeping: kills counter, gore burst, optional head-pop, loot drop
function killZombie(z, kx, kz, headPop) {
  if (z.state === 'dying') return;
  z.state = 'dying'; z.deadT = 0; z.hp = 0;
  if (z.isBoss) onBossDefeated(z);
  game.kills++;
  hud.kills.textContent = game.kills;
  if (game.cleanup && game.kills >= game.clearTarget) completeCleanup();
  play3d(z.pos.x, z.pos.z, () => SFX.splat());
  rumble(70, 0.4, 0.3);
  spawnBlood(z.pos.x, z.blob.root.position.y + 0.8 * z.scale, z.pos.z, kx, kz, 2.2);
  if (headPop) popHead(z, kx, kz);
  if (Math.random() < 0.22 * settings.lootSpawn) spawnPickup(Math.random() < 0.7 ? 'ammo' : 'medkit', z.pos.x, z.pos.z);
}
// sniper-class execute: the target detonates wherever it was struck — instant kill
function executeZombie(z, kx, kz, limb) {
  if (z.state === 'dying') return;
  const b = z.blob;
  if (limb) blowLimb(z, kx, kz, limb);   // the struck limb comes off first
  blowLimb(z, kx, kz);                    // then it comes apart
  spawnBlood(z.pos.x, b.root.position.y + 0.9 * z.scale, z.pos.z, kx, kz, 3);
  for (let i = 0; i < 4; i++) spawnGib(z.pos.x, b.root.position.y + (0.4 + Math.random()) * z.scale, z.pos.z, i % 2 ? BLOOD : 0x8aa85a, kx, kz);
  killZombie(z, kx, kz, true);           // pops the head too
}
function damageZombie(z, dmg, kx, kz, knock, opts = {}) {
  if (z.state === 'dying') return;
  // horn-guard: while boss-wave zombies still stand, the Two Horned One shrugs everything
  // off — he flashes green instead of red because nothing got through
  if (z.isBoss && bossShielded()) {
    flashBlob(z.blob, FLASH_GREEN);
    spawnParticles(z.pos.x, z.blob.root.position.y + 1.6 * z.scale, z.pos.z, 0x3ae06a, 3, 2.5, 0.3);
    return;
  }
  // poking the Two Horned One is a mistake: any hit wakes him and sparks a lunge
  if (z.isBoss) {
    wakeBoss(z);
    if (game.time > z.dashCdT) bossDash(z);
  }
  // a sleeping zombie that takes a hit starts getting up
  if (z.state === 'sleep') { z.state = 'wake'; z.emergeT = 0; }
  const w = opts.weapon, isHead = opts.isHead, dist = opts.dist == null ? 0 : opts.dist;
  const b = z.blob;
  const limb = opts.limb || null;   // {kind, idx} when a specific arm/leg took the hit

  // sniper execute: any hit — limb, chest or head — is an instant, explosive kill (bosses are immune)
  if (w && w.execute && !z.isBoss) { executeZombie(z, kx, kz, limb); return; }

  // heavy weapons, or any hit on an already-exposed brain, burst the head: instant kill, head vanishes
  if (isHead && !b.headGone && !z.isBoss && ((w && w.gib) || z.brainExposed)) {
    killZombie(z, kx, kz, true);
    return;
  }

  z.hp -= dmg;
  flashBlob(b);
  z.pos.x += kx * knock * 0.12;
  z.pos.z += kz * knock * 0.12;
  spawnBlood(z.pos.x, b.root.position.y + (isHead ? 1.25 : 0.75) * z.scale, z.pos.z, kx, kz, isHead ? 1.3 : 1);
  // wounds bleed: leave a stain on the body itself and start dripping a ground trail
  z.bleeding = true;
  if (!isHead && Math.random() < 0.75) {
    const localAng = Math.atan2(-kx, -kz) - (z.yaw || 0);
    stainBody(b.wob, b.stainCount, localAng + (Math.random() - 0.5) * 0.6, -0.1 + Math.random() * 0.55, 1);
  }

  // limb dismemberment — a direct hit on an arm/leg severs that exact limb; otherwise it's a body-shot chance
  if (!isHead && !z.isBoss && w && w.dismember) {
    const base = limb ? 0.9 : 0.55;
    if (Math.random() < w.dismember * closeBonus(w, dist) * (z.hp <= 0 ? 1 : base)) blowLimb(z, kx, kz, limb);
  }

  if (z.hp > 0) {
    // weak or far headshot that doesn't kill cracks the skull open, revealing the weak spot
    if (isHead && !z.brainExposed && !z.isBoss && w && (w.weak || dist > 26)) exposeBrain(z);
    return;
  }
  killZombie(z, kx, kz, isHead && (!w || w.gib || z.brainExposed));
}
function tryReload() {
  const w = player.weapon;
  if (w.melee || player.reloading > 0 || player.clip >= w.mag) return;
  const res = reserves[w.id] | 0;
  if (res <= 0) return;
  player.reloading = 1.4 * player.reloadMult;
  hud.reloadmsg.style.opacity = 1;
  SFX.reload();
}

// ---------- crates / interact / recruit ----------
function findNearCrate() {
  let best = null, bestD = 2.6;
  for (const cr of allCrates) {
    if (cr.opened) continue;
    const d = Math.hypot(cr.pos.x - player.pos.x, cr.pos.z - player.pos.z);
    const dy = Math.abs(cr.pos.y - (player.pos.y + 0.5));
    if (d < bestD && dy < 2.4) { bestD = d; best = cr; }
  }
  return best;
}
function findNearRecruit() {
  let best = null, bestD = 3.2;
  for (const c of companions) {
    if (c.recruited) continue;
    const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
// a downed squadmate close enough to pick back up
function findNearDowned() {
  let best = null, bestD = 2.8;
  for (const c of companions) {
    if (!c.recruited || !c.downed) continue;
    const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
// a recruited cousin you're close to AND looking at — so the squad trailing behind
// doesn't spam the trade prompt while you walk
function findNearTrade() {
  let best = null, bestD = 2.4;
  const fx = -Math.sin(player.camYaw), fz = -Math.cos(player.camYaw);
  for (const c of companions) {
    if (!c.recruited || c.downed) continue;
    const dx = c.pos.x - player.pos.x, dz = c.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD && (dx * fx + dz * fz) / Math.max(d, 0.001) > 0.5) { bestD = d; best = c; }
  }
  return best;
}
// swap held weapons with a recruited cousin — hand their personal favourite back, or borrow it
function tradeWeapons(c) {
  const myId = player.weapon.id;
  const theirId = (c.weapon || WEAPONS.pistol).id;
  if (myId === theirId) { toast('YOU BOTH HOLD THE SAME WEAPON'); return; }
  setCompanionWeapon(c, myId);
  equipWeapon(theirId);
  SFX.swap(WEAPONS[theirId]);
  rumble(60, 0.3, 0.4);
  toast(`TRADED: YOUR ${WEAPONS[myId].name.toUpperCase()} FOR ${c.data.name.toUpperCase()}'S ${WEAPONS[theirId].name.toUpperCase()}`);
}
function openCrate(cr) {
  cr.opened = true;
  game.cratesOpened++;
  hud.crates.textContent = game.cratesOpened;
  SFX.crate();
  rumble(110, 0.3, 0.5);
  cr.glow.visible = false;
  cr.trim.visible = false;
  const rng = Math.random;
  const loot = rollLoot(rng);
  if (loot === 'ammo') {
    if (player.weapon.melee) giveWeapon('pistol');
    else {
      const add = Math.ceil(player.weapon.mag * (1.5 + rng()) * player.ammoMult);
      reserves[player.weapon.id] = (reserves[player.weapon.id] | 0) + add;
      toast(`+${add} ${player.weapon.name.toUpperCase()} AMMO`);
      SFX.pickup();
      updateAmmoHUD();
    }
  } else if (loot === 'medkit') {
    player.hp = Math.min(player.maxHp, player.hp + 40);
    toast('+40 HP');
    SFX.pickup();
  } else {
    giveWeapon(loot);
  }
}
function giveWeapon(id) {
  const w = WEAPONS[id];
  const gain = Math.round(w.ammo * player.ammoMult);
  reserves[id] = (reserves[id] | 0) + gain;
  if (player.weapon.id === id) {
    toast(`+${gain} ${w.name.toUpperCase()} AMMO`);
  } else {
    equipWeapon(id);
    toast(`${w.name.toUpperCase()} ACQUIRED!`);
  }
  updateAmmoHUD();
}
let recruitCounter = 0;
function recruitCousin(c) {
  c.recruited = true;
  c.order = ++recruitCounter; // formation order = order found
  c.hp = c.maxHp; c.downed = false;
  scene.remove(c.beacon);
  c.beacon = null;
  SFX.recruit();
  rumble(160, 0.5, 0.7);
  // every cousin hands you their signature melee weapon (into the melee slot), no forced swap
  const mid = c.data.melee;
  let mtxt = '';
  if (mid && !player.owned.includes(mid)) {
    player.owned.push(mid);
    player.owned.sort((a, b) => slotRank(a) - slotRank(b));
    updateWeaponBtn();
    mtxt = ` +${WEAPONS[mid].name.toUpperCase()}`;
  }
  toast(`${c.data.name.toUpperCase()} JOINED!${mtxt} — ${c.data.lore}`, true);
  updateCousinHUD();
  rebuildSquadBars();
  maybeSpawnBoss();
}
// weapon-only loot roll (companions only ever grab guns from crates)
function rollLootWeapon(rng) {
  for (let i = 0; i < 8; i++) { const id = rollLoot(rng); if (id !== 'ammo' && id !== 'medkit') return id; }
  return 'pistol';
}
// swap a companion's held weapon + its visible gun model
function setCompanionWeapon(c, id) {
  c.weapon = WEAPONS[id];
  if (c.gunMesh) c.gunMesh.removeFromParent();
  c.gunMesh = id === 'fists' ? null : buildGunMesh(id); // melee models show in their fist too
  if (c.gunMesh) c.blob.gunSocket.add(c.gunMesh);
}
// a companion opens a crate it walked up to and equips whatever gun it finds
function companionLoot(c, cr) {
  cr.opened = true;
  game.cratesOpened++;
  hud.crates.textContent = game.cratesOpened;
  cr.glow.visible = false;
  cr.trim.visible = false;
  play3d(cr.pos.x, cr.pos.z, () => SFX.crate());
  const id = rollLootWeapon(Math.random);
  setCompanionWeapon(c, id);
  toast(`${c.data.name.toUpperCase()} FOUND A ${WEAPONS[id].name.toUpperCase()}`);
  play3d(cr.pos.x, cr.pos.z, () => SFX.swap(WEAPONS[id]));
}

// ---------- main loop ----------
const clock = new THREE.Clock();
let camDist = 4.9;
let nearCrate = null, nearRecruit = null;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  pollGamepad(dt);

  if (game.state === 'playing') {
    game.time += dt;
    updatePlayer(dt);
    updateCompanions(dt);
    updateZombies(dt);
    updateCrates(dt);
    updatePickups(dt);
    updateSpawner(dt);
    updateBossFx();
    const mins = Math.floor(game.time / 60), secs = Math.floor(game.time % 60);
    hud.timer.textContent = mins + ':' + String(secs).padStart(2, '0');
  }
  updateCamera(dt);
  updateFx(dt);
  updateRain(dt);
  renderer.render(scene, camera);
}

function updatePlayer(dt) {
  if (player.dead) return;
  // look speed scales with the current FOV so zoomed aim (especially the sniper
  // scope, 22° vs 70°) turns proportionally slower and stays steady on target
  const lookDamp = camera.fov / 70;
  player.camYaw -= input.lookDX * lookDamp;
  player.camPitch = clamp(player.camPitch - input.lookDY * lookDamp, -1.25, 0.6);
  input.lookDX = 0; input.lookDY = 0;

  let mx = input.moveX, my = input.moveY;
  if (input.device === 'kbm') {
    mx = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
    my = (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0);
  }
  const ml = Math.hypot(mx, my);
  if (ml > 1) { mx /= ml; my /= ml; }

  const sprinting = (keys['ShiftLeft'] || keys['ShiftRight'] || sprintToggle || input.sprintGamepad) && ml > 0.1;
  // bare fists keep you light on your feet: 5% quicker stride, 10% springier jumps
  const fists = player.weapon.id === 'fists';
  const speed = (sprinting ? 7.26 * player.sprintMult : 4.73) * (fists ? 1.05 : 1);

  // camera-relative: forward = away from camera
  const sin = Math.sin(player.camYaw), cos = Math.cos(player.camYaw);
  const vx = (mx * cos + my * sin) * speed;
  const vz = (my * cos - mx * sin) * speed;

  // slide: quick low dash along current motion; jump out of it for a slide-hop boost
  if (input.slide && player.grounded && player.slideT <= 0 && ml > 0.1) {
    player.slideT = 0.55;
    const l = Math.hypot(vx, vz) || 1;
    player.slideDX = vx / l; player.slideDZ = vz / l;
    SFX.slide();
    rumble(70, 0.3, 0.5);
  }
  input.slide = false;

  let mvx = vx, mvz = vz;
  if (player.slideT > 0) {
    player.slideT -= dt;
    const s = Math.max(player.slideT, 0) / 0.55;
    mvx += player.slideDX * 7.5 * s;
    mvz += player.slideDZ * 7.5 * s;
  }
  if (player.hopT > 0) { // slide-hop momentum carried through the air
    player.hopT -= dt;
    mvx += player.slideDX * 6.5;
    mvz += player.slideDZ * 6.5;
  }
  if (player.stumbleT > 0) {
    player.stumbleT -= dt;
    const s = Math.max(player.stumbleT, 0) / 0.42;
    mvx += player.stumbleX * 7 * s;
    mvz += player.stumbleZ * 7 * s;
  }
  let nx = player.pos.x + mvx * dt;
  let nz = player.pos.z + mvz * dt;
  [nx, nz] = resolveCollision(nx, nz, 0.45, player.pos.y);
  player.pos.x = nx; player.pos.z = nz;

  // ground = terrain or any standable top under us (crates, cars, rocks, awnings, roofs)
  const groundY = supportTop(player.pos.x, player.pos.z, player.pos.y);
  if (input.jump && player.grounded) {
    const hop = player.slideT > 0;   // slide-hop: bigger jump, momentum kept
    player.vy = (hop ? 8.6 : 7.4) * (fists ? 1.1 : 1);
    if (hop) { player.hopT = 0.5; player.slideT = 0; }
    player.grounded = false;
    player.squash = -0.25;
    SFX.jump();
    rumble(40, 0.15, 0.3);
  }
  input.jump = false;
  if (player.grounded) {
    if (groundY < player.pos.y - 0.05) { player.grounded = false; player.vy = 0; } // walked off an edge
    else player.pos.y = groundY;
  }
  if (!player.grounded) {
    player.vy -= 20 * dt;
    player.pos.y += player.vy * dt;
    if (player.vy <= 0 && player.pos.y <= groundY) {
      if (player.vy < -4) { player.squash = 0.3; SFX.land(); rumble(60, 0.25, 0.4); }
      player.pos.y = groundY; player.vy = 0; player.grounded = true; player.hopT = 0;
    }
  }

  player.shootCd -= dt;
  const wantShoot = input.shoot || input.shootGamepad;
  const w = player.weapon;
  // hold the trigger to keep firing; every weapon — full-auto, semi-auto & melee — cycles at its own rpm
  if ((wantShoot || (w.melee && input.shootPressed)) && player.shootCd <= 0) {
    fireWeapon();
    player.shootCd = 60 / w.rpm;
  }
  input.shootPressed = false;

  if (input.reload) { tryReload(); input.reload = false; }
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) {
      const need = w.mag - player.clip;
      const take = Math.min(need, reserves[w.id] | 0);
      player.clip += take;
      reserves[w.id] -= take;
      hud.reloadmsg.style.opacity = 0;
      updateAmmoHUD();
    }
  }

  // interact: downed squadmates outrank crates + recruits
  const nearDowned = findNearDowned();
  nearCrate = nearDowned ? null : findNearCrate();
  nearRecruit = nearDowned ? null : findNearRecruit();
  if (nearCrate && nearRecruit) {
    const dc = Math.hypot(nearCrate.pos.x - player.pos.x, nearCrate.pos.z - player.pos.z);
    const dr = Math.hypot(nearRecruit.pos.x - player.pos.x, nearRecruit.pos.z - player.pos.z);
    if (dc <= dr) nearRecruit = null; else nearCrate = null;
  }
  let nearTrade = null;
  if (!nearDowned && !nearCrate && !nearRecruit) nearTrade = findNearTrade();
  const showPrompt = !!(nearDowned || nearCrate || nearRecruit || nearTrade);
  hud.prompttxt.textContent = nearDowned ? 'Pick up ' + nearDowned.data.name
    : nearCrate ? 'Open Crate'
    : nearRecruit ? 'Recruit ' + nearRecruit.data.name
    : nearTrade ? `Trade for ${nearTrade.data.name}'s ${(nearTrade.weapon || WEAPONS.pistol).name}` : '';
  hud.prompt.classList.toggle('hidden', !showPrompt || input.device === 'touch');
  if (isTouch) hud.btnInteract.style.display = showPrompt ? 'flex' : 'none';
  if (input.interact) {
    if (nearDowned) reviveCousin(nearDowned);
    else if (nearCrate) openCrate(nearCrate);
    else if (nearRecruit) recruitCousin(nearRecruit);
    else if (nearTrade) tradeWeapons(nearTrade);
    input.interact = false;
  }

  if (game.time - player.lastHurtT > 6 && player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + 4 * dt);
  }
  const hpFrac = player.hp / player.maxHp;
  hud.health.style.width = (hpFrac * 100) + '%';
  // player's bar is colour-coded to the cousin we picked; it pulses red when critical
  hud.health.style.background = player.colorHex || '#2ecc71';
  hud.health.classList.toggle('low', hpFrac <= 0.25);
  hud.healthTxt.innerHTML = Math.ceil(player.hp) + ' HP <span class="pnum">| Player 1</span>';
  updateSquadBars();
  hud.vignette.style.opacity = player.hp < 40 ? (1 - player.hp / 40) * 0.9 :
    (game.time - player.lastHurtT < 0.4 && game.time > player.lastHurtT ? 0.7 : 0);

  // --- blob animation ---
  const moving = ml > 0.1;
  player.stillT = moving ? 0 : (player.stillT || 0) + dt;
  const stumbling = player.stumbleT > 0;
  player.walkPhase += dt * (moving ? (sprinting ? 13 : 9) : 2);
  player.idlePhase += dt;
  const b = playerBlob;
  b.root.position.copy(player.pos);
  updateFlash(b, dt);
  // shadow stays flat, projected onto whatever we're above (ground, car roofs...)
  placeShadow(b, player.pos.x, player.pos.z, player.pos.y);

  // aim/zoom: hold to focus. third-person tightens over the shoulder & raises the weapon;
  // first-person eases over the sights (or raises the melee weapon). fpv is the view toggle.
  player.aiming = (input.aim || input.aimPad || input.aimTouch) && !player.dead;
  player.aimT = lerp(player.aimT, player.aiming ? 1 : 0, 1 - Math.exp(-11 * dt));
  player.fpvT = lerp(player.fpvT, player.fpv ? 1 : 0, 1 - Math.exp(-12 * dt));
  // hide our own head only in first person so it doesn't block the view
  b.head.visible = player.fpvT < 0.55;

  // footsteps on each half of the walk cycle
  if (moving && player.grounded) {
    const ph = Math.floor(player.walkPhase / Math.PI);
    if (ph !== player.lastStepPh) { player.lastStepPh = ph; SFX.step(sprinting); }
  }

  const recentShot = game.time - player.lastShotT < 2.2 && !w.melee;
  let targetYaw;
  if (recentShot || wantShoot || player.aiming) {
    getAimDir(_aimDir);
    targetYaw = Math.atan2(_aimDir.x, _aimDir.z);
  }
  else if (moving) targetYaw = Math.atan2(vx, vz);
  else targetYaw = b.root.rotation.y;
  b.root.rotation.y = angLerp(b.root.rotation.y, targetYaw, 1 - Math.exp(-12 * dt));

  player.squash = lerp(player.squash, 0, 1 - Math.exp(-8 * dt));
  // idle breathing when still, bob when moving
  const breathe = Math.sin(player.idlePhase * 2.0) * 0.03;
  const wobble = moving ? Math.sin(player.walkPhase * 2) * 0.045 : breathe;
  const stumbleLean = stumbling ? Math.max(player.stumbleT, 0) / 0.42 : 0;
  b.wob.scale.set(1 + wobble - player.squash * 0.4, 1 - wobble + player.squash, 1 + wobble - player.squash * 0.4);
  b.wob.rotation.z = (moving ? Math.sin(player.walkPhase) * 0.06 : Math.sin(player.idlePhase * 1.3) * 0.025) + stumbleLean * 0.25;
  b.wob.rotation.x = (moving ? 0.08 : 0) - stumbleLean * 0.5;
  b.head.rotation.x = recentShot ? -player.camPitch * 0.4 : Math.sin(player.idlePhase * 1.7) * 0.05;
  b.head.rotation.z = stumbleLean * 0.4;

  const swing = Math.sin(player.walkPhase) * (moving ? 0.85 : 0.06) + (moving ? 0 : Math.sin(player.idlePhase * 1.1) * 0.05);
  b.legs[0].rotation.x = swing + stumbleLean * 0.3;
  b.legs[1].rotation.x = -swing - stumbleLean * 0.2;
  const aimAmt = player.aimT;
  if (w.melee) {
    const punching = game.time - player.lastShotT < 0.18;
    if (w.id === 'fists') {
      // fists: alternate the punching arm each swing
      b.arms[0].rotation.x = -swing * 0.8;
      b.arms[1].rotation.x = swing * 0.8;
      if (punching) b.arms[player.meleeArm].rotation.x = -1.9;
      else if (stumbling) { b.arms[0].rotation.x -= stumbleLean * 1.0; b.arms[1].rotation.x -= stumbleLean * 1.0; }
    } else {
      // armed melee: the weapon hand swings; hold it raised & ready while focusing
      const ready = -0.55 - aimAmt * 1.0;
      b.arms[b.gunArm].rotation.x = punching ? -2.3 : ready + Math.sin(player.walkPhase) * (moving ? 0.14 : 0.04);
      b.arms[b.offArm].rotation.x = -swing * 0.6 - aimAmt * 0.35;
      if (stumbling) { b.arms[b.gunArm].rotation.x -= stumbleLean * 0.6; b.arms[b.offArm].rotation.x -= stumbleLean * 1.0; }
    }
  } else {
    const aimPitch = Math.asin(clamp((recentShot || player.aiming) ? getAimDir(_aimDir).y : 0, -0.9, 0.9));
    b.arms[b.gunArm].rotation.x = -Math.PI / 2 - aimPitch * 0.8;
    b.arms[b.offArm].rotation.x = (wantShoot || recentShot || aimAmt > 0.2) ? b.arms[b.gunArm].rotation.x : -swing * 0.8;
    const kick = game.time - player.lastShotT < 0.09 ? 0.35 : 0;
    b.arms[b.gunArm].rotation.x += kick;
  }
  if (player.slideT > 0) {
    // slide posture: lean way back, legs out front, free arm thrown up
    b.wob.rotation.x = -0.85;
    b.legs[0].rotation.x = -1.2; b.legs[1].rotation.x = -1.35;
    b.arms[b.offArm].rotation.x = -2.6;
  }
  if (!player.grounded) {
    b.arms[b.offArm].rotation.x = -2.4;
    if (w.melee) b.arms[b.gunArm].rotation.x = -2.4;
    b.legs[0].rotation.x = 0.5; b.legs[1].rotation.x = -0.3;
  }

  updateChunks(player.pos.x, player.pos.z);
}

// ---------- companions ----------
const _cv = new THREE.Vector3();
function updateCompanions(dt) {
  // formation slots in recruit order: single-file line behind you while moving,
  // spread shoulder-to-shoulder like a firing squad once you stop
  const squad = companions.filter(c => c.recruited).sort((a, b) => (a.order || 0) - (b.order || 0));
  squad.forEach((c, i) => { c.slotIdx = i; c.slotN = squad.length; });
  const fYaw = playerBlob.root.rotation.y;
  const bkX = -Math.sin(fYaw), bkZ = -Math.cos(fYaw); // behind the player
  const rtX = -Math.cos(fYaw), rtZ = Math.sin(fYaw);  // player's right
  const still = (player.stillT || 0) > 0.5;
  for (const c of companions) {
    const b = c.blob;
    const gy = groundHeight(c.pos.x, c.pos.z);
    updateFlash(b, dt);
    placeShadow(b, c.pos.x, c.pos.z, c.y);
    if (!c.recruited) {
      c.y = gy;
      // idle at their spot, bob & look around — but keep the gun levelled, not pointing at the dirt
      b.root.position.set(c.pos.x, gy, c.pos.z);
      b.wob.scale.y = 1 + Math.sin(performance.now() * 0.002 + c.walkPhase) * 0.03;
      b.root.rotation.y = c.yaw + Math.sin(performance.now() * 0.0006 + c.walkPhase) * 0.6;
      b.arms[b.gunArm].rotation.x = -Math.PI / 2;
      b.arms[b.offArm].rotation.x = -0.1;
      if (c.beacon) {
        c.beacon.material.opacity = 0.2 + Math.sin(performance.now() * 0.003) * 0.1;
        c.beacon.rotation.y += dt * 0.5;
      }
      continue;
    }
    // downed: kneel where they fell, flashing red under a rescue beacon, until
    // someone comes and picks them up by hand
    if (c.downed) {
      c.y = gy; c.vy = 0; c.grounded = true;
      b.root.position.set(c.pos.x, gy, c.pos.z);
      b.wob.rotation.x = 0.55; b.wob.scale.set(1, 0.7, 1);
      b.legs[0].rotation.x = -1.2; b.legs[1].rotation.x = -1.2;
      b.arms[0].rotation.x = -0.3; b.arms[1].rotation.x = -0.3;
      c.downFlashT = (c.downFlashT || 0) - dt;
      if (c.downFlashT <= 0) { c.downFlashT = 0.55; flashBlob(b); }
      if (c.beacon) {
        c.beacon.material.opacity = 0.22 + Math.sin(performance.now() * 0.004) * 0.12;
        c.beacon.rotation.y += dt * 0.8;
      }
      continue;
    }
    // steady regen once they've been out of a bite for a few seconds
    if (game.time - (c.lastHurtT || -9) > 5 && c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + 5 * dt);
    // seek my formation slot
    const i = c.slotIdx || 0, n = c.slotN || 1;
    let tx2, tz2;
    if (still) {
      const lateral = (i - (n - 1) / 2) * 1.7;
      tx2 = player.pos.x + bkX * 2.3 + rtX * lateral;
      tz2 = player.pos.z + bkZ * 2.3 + rtZ * lateral;
    } else {
      tx2 = player.pos.x + bkX * (1.8 + i * 1.5);
      tz2 = player.pos.z + bkZ * (1.8 + i * 1.5);
    }
    const dx = tx2 - c.pos.x, dz = tz2 - c.pos.z;
    const dist = Math.hypot(dx, dz);
    const pd = Math.hypot(player.pos.x - c.pos.x, player.pos.z - c.pos.z);
    let moving = false;
    if (pd > 30) { // teleport catch-up if left far behind
      c.pos.x = player.pos.x + bkX * (2 + i * 1.5);
      c.pos.z = player.pos.z + bkZ * (2 + i * 1.5);
      c.y = groundHeight(c.pos.x, c.pos.z); c.vy = 0; c.grounded = true;
    } else if (dist > 0.4) {
      const sp = Math.min(dist > 8 ? 7.3 : dist > 2 ? 5.4 : 2.8, dist / dt);
      const step = sp * dt;
      let nx = c.pos.x + dx / dist * step;
      let nz = c.pos.z + dz / dist * step;
      [nx, nz] = resolveCollision(nx, nz, 0.42, c.y);
      // hop over whatever is blocking the way back to the formation slot
      const movedD = Math.hypot(nx - c.pos.x, nz - c.pos.z);
      if (c.grounded && dist > 1.1 && movedD < step * 0.4) { c.vy = 7.4; c.grounded = false; }
      c.pos.x = nx; c.pos.z = nz;
      if (dist > 1) {
        c.walkPhase += dt * 10;
        c.yaw = Math.atan2(dx, dz);
        moving = true;
      }
    }
    // gravity: cousins stand on (and jump onto) the same tops we can
    const supY = supportTop(c.pos.x, c.pos.z, c.y);
    if (c.grounded) {
      if (supY < c.y - 0.05) { c.grounded = false; c.vy = 0; }
      else c.y = supY;
    }
    if (!c.grounded) {
      c.vy -= 20 * dt;
      c.y += c.vy * dt;
      if (c.vy <= 0 && c.y <= supY) { c.y = supY; c.vy = 0; c.grounded = true; }
    }
    // auto-loot: grab a gun from any crate we're standing next to
    for (const cr of allCrates) {
      if (cr.opened) continue;
      if (Math.hypot(cr.pos.x - c.pos.x, cr.pos.z - c.pos.z) < 2.1 && Math.abs(cr.pos.y - c.y) < 2.4) {
        companionLoot(c, cr);
        break;
      }
    }
    // fight: swing or shoot at the nearest zombie with whatever we're carrying
    const cw = c.weapon || WEAPONS.pistol;
    c.shootCd -= dt;
    if (c.meleeT > 0) c.meleeT -= dt;
    let tgt = null, tD = 15;
    for (const z of zombies) {
      if (z.state !== 'chase' && z.state !== 'wake') continue; // ignore sleepers, emergers & the dormant boss
      const d = Math.hypot(z.pos.x - c.pos.x, z.pos.z - c.pos.z);
      if (d < tD) { tD = d; tgt = z; }
    }
    if (tgt) c.yaw = Math.atan2(tgt.pos.x - c.pos.x, tgt.pos.z - c.pos.z);
    else if (still && !moving) c.yaw = fYaw; // stand at attention facing where you face
    if (tgt && c.shootCd <= 0) {
      const kx = (tgt.pos.x - c.pos.x) / tD, kz = (tgt.pos.z - c.pos.z) / tD;
      if (cw.melee) {
        // melee cousins swing once the target shambles into reach
        if (tD < cw.range + 0.5) {
          c.shootCd = 60 / cw.rpm + 0.2;
          c.meleeT = 0.16;
          damageZombie(tgt, cw.dmg * 1.1, kx, kz, 2.2, { weapon: cw, dist: tD, isHead: false });
          if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 24) play3d(c.pos.x, c.pos.z, () => SFX.shoot(cw));
        }
      } else {
        c.shootCd = (cw.auto ? 0.32 : cw.id === 'shotgun' ? 0.6 : 0.7) + Math.random() * 0.15;
        // cousin gunfire rings out just as loud as ours: blind zombies home in on it too
        game.lastShot.set(c.pos.x, 0, c.pos.z); game.lastShotT = game.time;
        const sy = c.y + 1.0;
        const zy = tgt.blob.root.position.y + 0.7 * tgt.scale;
        // cousin bullets obey the same walls, cars and crates ours do
        let ddx = tgt.pos.x - c.pos.x, ddy = zy - sy, ddz = tgt.pos.z - c.pos.z;
        const dl = Math.hypot(ddx, ddy, ddz);
        ddx /= dl; ddy /= dl; ddz /= dl;
        let tWall = rayGround(c.pos.x, sy, c.pos.z, ddx, ddy, ddz, dl + 4);
        for (const col of nearbyColliders(c.pos.x, c.pos.z)) {
          const t = rayAABB(c.pos.x, sy, c.pos.z, ddx, ddy, ddz, col);
          if (t < tWall) tWall = t;
        }
        _cv.set(c.pos.x, sy, c.pos.z);
        if (tWall < dl - 0.35) {
          // blocked: the shot smacks the obstacle instead of magically reaching the zombie
          const hx = c.pos.x + ddx * tWall, hy = sy + ddy * tWall, hz = c.pos.z + ddz * tWall;
          spawnTracer(_cv.clone(), new THREE.Vector3(hx, hy, hz));
          spawnParticles(hx, hy, hz, 0x9a9a8a, 3, 2, 0.3);
        } else {
          const shots = cw.id === 'shotgun' ? 3 : 1;
          for (let s = 0; s < shots; s++) spawnTracer(_cv.clone(), new THREE.Vector3(tgt.pos.x + (Math.random() - 0.5) * s, zy, tgt.pos.z + (Math.random() - 0.5) * s));
          damageZombie(tgt, (cw.dmg || 20) * 1.25 * shots, kx, kz, 1, { weapon: cw, dist: tD, isHead: false });
        }
        if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 24) play3d(c.pos.x, c.pos.z, () => SFX.shoot(cw));
      }
    }
    b.root.position.set(c.pos.x, c.y, c.pos.z);
    b.root.rotation.y = angLerp(b.root.rotation.y, c.yaw, 1 - Math.exp(-10 * dt));
    const swing = Math.sin(c.walkPhase) * (moving ? 0.8 : 0.05);
    b.legs[0].rotation.x = swing;
    b.legs[1].rotation.x = -swing;
    b.arms[b.offArm].rotation.x = -swing * 0.7;
    // guns held levelled; melee carried ready, whipping forward on a swing
    b.arms[b.gunArm].rotation.x = cw.melee ? (c.meleeT > 0 ? -2.3 : -0.75) : -Math.PI / 2;
    if (!c.grounded) { b.legs[0].rotation.x = 0.5; b.legs[1].rotation.x = -0.3; b.arms[b.offArm].rotation.x = -2.4; }
    const wob = moving ? Math.sin(c.walkPhase * 2) * 0.04 : Math.sin(performance.now() * 0.002) * 0.015;
    b.wob.scale.set(1 + wob, 1 - wob, 1 + wob);
  }
}

// ---------- zombies ----------
function updateZombies(dt) {
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    const b = z.blob;
    updateFlash(b, dt);
    if (z.state === 'dying') {
      z.deadT += dt;
      b.root.rotation.x = Math.min(z.deadT * 4, Math.PI / 2);
      if (z.deadT > 1.2) b.root.position.y -= dt * 0.8;
      // shadow stays flat under the corpse's centre while the body topples/sinks
      placeShadow(b, z.pos.x, z.pos.z);
      if (z.deadT > 2.4) {
        scene.remove(b.root); if (b.shadow) scene.remove(b.shadow);
        zombies.splice(i, 1);
      }
      continue;
    }
    const pDist = Math.hypot(player.pos.x - z.pos.x, player.pos.z - z.pos.z);
    if (pDist > (z.despawnR || 85) && !z.isBoss) { scene.remove(b.root); if (b.shadow) scene.remove(b.shadow); zombies.splice(i, 1); continue; }

    // boss: sleeps by the bank until approached, then sends waves at damage thresholds
    if (z.isBoss) {
      updateBossState(z, pDist);
      if (z.state === 'dormant') {
        b.root.position.set(z.pos.x, groundHeight(z.pos.x, z.pos.z), z.pos.z);
        b.root.rotation.y = z.yaw;
        b.wob.scale.y = 1 + Math.sin(performance.now() * 0.001) * 0.03;
        placeShadow(b, z.pos.x, z.pos.z);
        continue;
      }
    }

    // visible entrances instead of popping into view: clawing out of the dirt...
    if (z.state === 'emerge') {
      z.emergeT += dt;
      const t = Math.min(z.emergeT / 1.7, 1);
      const gy = groundHeight(z.pos.x, z.pos.z);
      b.root.position.set(z.pos.x, gy - 1.5 * (1 - t), z.pos.z);
      b.root.rotation.y = z.yaw;
      b.arms[0].rotation.x = -2.7 + t * 1.3;
      b.arms[1].rotation.x = -2.3 + t * 0.9;
      if (Math.random() < 0.25) spawnParticles(z.pos.x + (Math.random() - 0.5) * 0.6, gy + 0.05, z.pos.z + (Math.random() - 0.5) * 0.6, 0x5a4a34, 2, 1.6, 0.4);
      placeShadow(b, z.pos.x, z.pos.z);
      if (t >= 1) z.state = 'chase';
      continue;
    }
    // ...or lying sprawled on the pavement until something comes close
    if (z.state === 'sleep') {
      const gy = groundHeight(z.pos.x, z.pos.z);
      b.root.position.set(z.pos.x, gy + 0.05, z.pos.z);
      b.root.rotation.x = -1.45;
      placeShadow(b, z.pos.x, z.pos.z);
      if (pDist < 24) { z.state = 'wake'; z.emergeT = 0; }
      continue;
    }
    if (z.state === 'wake') {
      z.emergeT += dt;
      const t = Math.min(z.emergeT / 0.9, 1);
      const gy = groundHeight(z.pos.x, z.pos.z);
      b.root.rotation.x = -1.45 * (1 - t);
      b.root.position.set(z.pos.x, gy + 0.05 * (1 - t), z.pos.z);
      placeShadow(b, z.pos.x, z.pos.z);
      if (t >= 1) { z.state = 'chase'; b.root.rotation.x = 0; }
      continue;
    }

    // pick what draws this zombie: blind ones only home in on the last gunshot noise,
    // and otherwise wander the streets
    let tx, tz, hasTarget = true, tgtC = null, wander = false;
    if (z.blind) {
      const heard = game.time - game.lastShotT < 14 && game.lastShotT > z.shotIgnoreT;
      if (heard) {
        tx = game.lastShot.x; tz = game.lastShot.z;
        // reached where the bang came from and found nothing: shrug, wander off again
        if (Math.hypot(tx - z.pos.x, tz - z.pos.z) < 2.2) { z.shotIgnoreT = game.lastShotT; wander = true; }
      } else wander = true;
      if (wander) {
        z.wanderT -= dt;
        if (z.wanderT <= 0) { z.wanderT = 2.5 + Math.random() * 4; z.wanderYaw = Math.random() * TAU; }
        tx = z.pos.x + Math.sin(z.wanderYaw) * 6;
        tz = z.pos.z + Math.cos(z.wanderYaw) * 6;
      }
    } else {
      tx = player.pos.x; tz = player.pos.z;
      let tDist = player.dead ? Infinity : pDist;
      for (const c of companions) {
        if (!c.recruited || c.downed) continue;
        const d = Math.hypot(c.pos.x - z.pos.x, c.pos.z - z.pos.z);
        if (d < tDist) { tDist = d; tx = c.pos.x; tz = c.pos.z; tgtC = c; }
      }
      if (tDist === Infinity) hasTarget = false;
    }
    // houses only admit zombies through the door: prey holed up inside pulls them to
    // the doorway first, and a zombie left inside an empty house (kited, then abandoned)
    // files back out the door to repath instead of grinding arms-first into a wall
    if (!z.isBoss && hasTarget) {
      const myBld = buildingAt(z.pos.x, z.pos.z);
      const tgtBld = buildingAt(tx, tz);
      if (myBld && myBld !== tgtBld) {
        tx = myBld.doorOutX; tz = myBld.doorOutZ;
      } else if (!myBld && tgtBld && Math.hypot(tgtBld.doorX - z.pos.x, tgtBld.doorZ - z.pos.z) > 1.3) {
        tx = tgtBld.doorX; tz = tgtBld.doorZ;
      }
    }
    const dx = tx - z.pos.x, dz = tz - z.pos.z;
    const dist = hasTarget ? Math.hypot(dx, dz) : Infinity;

    z.groanT -= dt;
    if (z.groanT < 0) { z.groanT = 4 + Math.random() * 7; if (pDist < 26) play3d(z.pos.x, z.pos.z, () => SFX.groan()); }

    if (z.isBoss && z.dashT > 0) z.dashT -= dt;
    if (dist > 1.5 && dist < Infinity) {
      const sp = z.speed * (dist < 3 ? 1.25 : 1) * (wander ? 0.45 : 1) * (z.isBoss && z.dashT > 0 ? 5 : 1);
      let nx = z.pos.x + dx / dist * sp * dt;
      let nz = z.pos.z + dz / dist * sp * dt;
      for (const o of zombies) {
        if (o === z || o.state === 'dying') continue;
        const sx = nx - o.pos.x, sz = nz - o.pos.z;
        const sd = Math.hypot(sx, sz);
        if (sd < 0.85 && sd > 0.001) { nx += sx / sd * (0.85 - sd) * 0.5; nz += sz / sd * (0.85 - sd) * 0.5; }
      }
      [nx, nz] = resolveCollision(nx, nz, 0.4 * z.scale, b.root.position.y);
      z.pos.x = nx; z.pos.z = nz;
      z.walkPhase += dt * z.speed * 3.2;
      // shuffling footsteps (3D, throttled by distance)
      z.stepT -= dt * z.speed;
      if (z.stepT <= 0) { z.stepT = 0.55; if (pDist < 22) play3d(z.pos.x, z.pos.z, () => SFX.step(false)); }
    }
    z.attackT -= dt;
    // bite whoever is actually within reach — player first, else the cousin it's chasing.
    // vertical reach matters too: perched on a roof/awning above them means no bites from below
    if (z.attackT <= 0) {
      const reach = z.isBoss ? 3.4 : 1.7;
      const vReach = z.isBoss ? 2.4 : 1.25;
      // no biting through house walls: both parties must be in the same room (or both outside)
      const sameRoom = z.isBoss || buildingAt(z.pos.x, z.pos.z) === buildingAt(player.pos.x, player.pos.z);
      if (!player.dead && sameRoom && pDist < reach && player.pos.y - b.root.position.y < vReach) {
        z.attackT = z.isBoss ? 1.1 : 0.9;
        hurtPlayer(z.isBoss ? 26 + Math.random() * 12 : 9 + Math.random() * 6, player.pos.x - z.pos.x, player.pos.z - z.pos.z);
      } else if (tgtC && !tgtC.downed && (tgtC.y || 0) - b.root.position.y < vReach) {
        const cd = Math.hypot(tgtC.pos.x - z.pos.x, tgtC.pos.z - z.pos.z);
        if (cd < (z.isBoss ? 3.2 : 1.6)) { z.attackT = z.isBoss ? 1.1 : 0.9; hurtCompanion(tgtC, z.isBoss ? 22 : 7 + Math.random() * 5); }
      }
    }

    if (dist < Infinity) z.yaw = angLerp(z.yaw, Math.atan2(dx, dz), 1 - Math.exp(-6 * dt));
    b.root.position.set(z.pos.x, groundHeight(z.pos.x, z.pos.z), z.pos.z);
    b.root.rotation.y = z.yaw;
    placeShadow(b, z.pos.x, z.pos.z);

    // wounded zombies drip a blood trail on the ground as they move
    if (z.bleeding && goreAmt() > 0.02) {
      z.dripT -= dt;
      if (z.dripT <= 0) {
        z.dripT = 0.22 + Math.random() * 0.2;
        groundSplat(z.pos.x + (Math.random() - 0.5) * 0.3, z.pos.z + (Math.random() - 0.5) * 0.3, 0.14 + Math.random() * 0.16);
      }
    }

    const sw = Math.sin(z.walkPhase);
    b.legs[0].rotation.x = sw * 0.7;
    b.legs[1].rotation.x = -sw * 0.7;
    b.arms[0].rotation.x = -1.4 + sw * 0.25;
    b.arms[1].rotation.x = -1.4 - sw * 0.25;
    const lunge = z.attackT > 0.62 ? (z.attackT - 0.62) * 3 : 0;
    b.wob.rotation.x = 0.15 + lunge * 0.9;
    const wobble = sw * 0.05;
    b.wob.scale.set(1 + wobble, 1 - wobble, 1 + wobble);
    b.head.rotation.z = Math.sin(z.walkPhase * 0.5) * 0.18;
  }
}

function updateSpawner(dt) {
  if (game.time < 15 || settings.zombieSpawn <= 0) return;
  game.spawnT -= dt;
  // cleanup phase after the boss falls: never spawn past the clear target, so the last
  // stragglers can be hunted down to exactly the next hundred
  if (game.cleanup) {
    const alive = zombies.reduce((n, zz) => n + (zz.state !== 'dying' ? 1 : 0), 0);
    if (game.kills + alive >= game.clearTarget) return;
  }
  const maxZ = Math.round(Math.min(26, 4 + Math.floor(game.time / 22) + Math.floor(game.kills / 7)) * settings.zombieSpawn);
  const interval = Math.max(0.35, (3.6 - game.time / 80) / settings.zombieSpawn);
  if (game.spawnT <= 0 && zombies.length < maxZ) {
    game.spawnT = interval;
    const runner = Math.random() < 0.22; // far spawns already running our way
    let x = 0, z = 0, ok = false;
    for (let tries = 0; tries < 8 && !ok; tries++) {
      const ang = Math.random() * TAU;
      const d = runner ? 80 + Math.random() * 34 : 32 + Math.random() * 22;
      x = player.pos.x + Math.sin(ang) * d;
      z = player.pos.z + Math.cos(ang) * d;
      [x, z] = resolveCollision(x, z, 0.5);
      ok = !insideBuilding(x, z); // zombies never appear inside buildings on their own
    }
    if (!ok) return;
    const power = 1 + game.time / 240;
    // near spawns claw out of the dirt or wake from the pavement — no popping into view.
    // during cleanup everything actively hunts, so the last stragglers come find you
    const mode = runner ? 'runner'
      : game.cleanup ? 'grave'
      : (onRoad(x, z, 0.5) || Math.random() < 0.35) ? 'sleeper' : 'grave';
    spawnZombie(x, z, power, { mode });
  }
}

// ---------- boss: the Two Horned One ----------
const bossState = { boss: null, beam: null, spawned: false, defeated: false };
const bossBarEl = document.getElementById('bossbar');
const bossHpEl = document.getElementById('bosshp');
// unlocked once the whole clan has been recruited
function maybeSpawnBoss() {
  if (bossState.spawned || bossState.defeated || game.state !== 'playing') return;
  if (companions.length === 0 || companions.some(c => !c.recruited)) return;
  spawnBoss();
}
function spawnBoss() {
  bossState.spawned = true;
  const bx = 0, bz = -33.5;                   // the open ground between the fountain and the bank steps
  const blob = buildBlob({ color: 0x8a2be2, zombie: true, scale: 2.7 });
  for (const s of [-1, 1]) {                  // horns
    const horn = cyl(0.02, 0.15, 0.55, 0x2a1a3a, 6);
    horn.position.set(0.22 * s, 0.3, 0.02); horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
    blob.head.add(horn);
  }
  blob.root.position.set(bx, groundHeight(bx, bz), bz);
  scene.add(blob.root);
  const hp = Math.round(4200 * (1 + 0.4 * game.cycle)); // each cleared block wakes a tougher one
  const z = {
    blob, pos: new THREE.Vector3(bx, 0, bz), hp, maxHp: hp, speed: 1.15, yaw: 0, state: 'dormant',
    attackT: 0, deadT: 0, walkPhase: 0, groanT: 2, scale: 2.7,
    brainExposed: false, blind: false, stepT: 0, bleeding: false, dripT: 0, isBoss: true, wavesFired: 0,
    dashT: 0, dashCdT: -9,
  };
  zombies.push(z);
  bossState.boss = z;
  // giant beam over the bank pointing the way
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 130, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xb03cff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.set(bx, groundHeight(bx, bz) + 64, bz);
  scene.add(beam);
  bossState.beam = beam;
  bossBarEl.classList.remove('show');         // the bar appears once it aggros
  toast('THE CLAN IS WHOLE — THE TWO HORNED ONE STIRS BY THE BANK', true);
  initAudio(); play3d(bx, bz, () => SFX.groan());
}
function wakeBoss(z) {
  if (z.state !== 'dormant') return;
  z.state = 'chase';
  bossBarEl.classList.add('show');
  toast('THE TWO HORNED ONE AWAKENS!', true);
  shakeAmp = Math.max(shakeAmp, 0.4);
  rumble(400, 1, 1);
  play3d(z.pos.x, z.pos.z, () => { noiseBurst(0.5, 200, 0.9); tone(60, 0.6, 0.5, 'sawtooth', 30); });
}
// a short roaring lunge straight at his prey — triggered by taking a hit or sending a wave
function bossDash(z) {
  if (z.state === 'dying') return;
  z.dashT = 0.85;
  z.dashCdT = game.time + 4;
  shakeAmp = Math.max(shakeAmp, 0.15);
  play3d(z.pos.x, z.pos.z, () => tone(95, 0.45, 0.45, 'sawtooth', 38));
}
function updateBossState(z, pDist) {
  if (z.state === 'dormant') {
    // sleeps until the player draws near, then aggros
    if (!player.dead && pDist < 18) wakeBoss(z);
    return;
  }
  // damage-taken thresholds send bigger swarms boiling out of the bank
  const taken = 1 - z.hp / z.maxHp;
  if (z.wavesFired < 1 && taken >= 0.33) fireBossWave(z, 1);
  else if (z.wavesFired < 2 && taken >= 0.50) fireBossWave(z, 2);
  else if (z.wavesFired < 3 && taken >= 0.75) fireBossWave(z, 3);
}
// while any horned wave zombie stands, the boss takes no damage at all
function bossShielded() {
  return zombies.some(zz => zz.hornWave && zz.state !== 'dying');
}
function fireBossWave(z, n) {
  z.wavesFired = n;
  const count = 4 + n * 3;                     // wave size grows 7 -> 10 -> 13
  for (let k = 0; k < count; k++) {
    // the only zombies allowed to walk out of a building: they pour from the bank doors.
    // half the wave are purple horned guards (his shield); the rest are plain green fodder
    const [x, zz] = resolveCollision((Math.random() - 0.5) * 12, -36.6 + Math.random() * 1.8, 0.5);
    const guard = k < Math.ceil(count / 2);
    spawnZombie(x, zz, 1 + game.time / 240, { purple: guard, horns: guard });
  }
  bossDash(z);
  toast(`WAVE ${n}: HORNED GUARDS POUR FROM THE BANK — THE BOSS IS IMMUNE UNTIL THEY FALL`, true);
  play3d(z.pos.x, z.pos.z, () => SFX.groan());
  shakeAmp = Math.max(shakeAmp, 0.2);
}
function onBossDefeated(z) {
  bossState.defeated = true;
  if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
  bossBarEl.classList.remove('show');
  // cleanup phase: kills must reach the NEXT full hundred so it's always 100+ more —
  // at 299 kills the target is 400, never a one-kill cheese to 300
  game.cleanup = true;
  game.clearTarget = Math.ceil((game.kills + 1 + 100) / 100) * 100;
  toast(`THE TWO HORNED ONE FALLS! CLEAR OUT THE REMAINING ZOMBIES — ${game.clearTarget} KILLS SECURES THE BLOCK`, true);
  for (let k = 0; k < 40; k++) spawnParticles(z.pos.x, z.blob.root.position.y + 2, z.pos.z, [0xffd24a, 0xb03cff, 0x6fd8ff][k % 3], 1, 6, 1.2);
  rumble(600, 1, 1);
}
// every straggler hunted down: roll the sky forward, reroll the weather, wake the next boss
function completeCleanup() {
  game.cleanup = false;
  game.cycle++;
  game.phase = (game.phase + 1) % PHASES.length;
  game.weather = rollWeather();
  applyEnvironment();
  bossState.spawned = false; bossState.defeated = false; bossState.boss = null;
  maybeSpawnBoss();
  toast(`BLOCK SECURED! ${PHASES[game.phase].name} ROLLS IN — ${game.weather.toUpperCase()} SKIES. THE TWO HORNED ONE STIRS AGAIN BY THE BANK…`, true);
  rumble(300, 0.5, 0.5);
}
function updateBossFx() {
  if (bossState.beam) bossState.beam.material.opacity = 0.16 + Math.sin(performance.now() * 0.004) * 0.08;
  const z = bossState.boss;
  if (z && z.state !== 'dormant') bossHpEl.style.width = clamp(z.hp / z.maxHp, 0, 1) * 100 + '%';
}

function updateCrates(dt) {
  for (let i = allCrates.length - 1; i >= 0; i--) {
    const cr = allCrates[i];
    cr.t += dt;
    if (!cr.opened) {
      cr.trim.material.emissiveIntensity = 0.4 + Math.sin(cr.t * 3) * 0.3;
      cr.glow.material.opacity = 0.5 + Math.sin(cr.t * 3) * 0.25;
      continue;
    }
    // open lid, then shrink away, then respawn elsewhere
    if (cr.lid.rotation.x > -1.8) {
      cr.lid.rotation.x -= dt * 6;
    } else if (cr.shrink < 1) {
      cr.shrink = Math.min(1, cr.shrink + dt * 1.8);
      const s = 1 - cr.shrink;
      cr.mesh.scale.setScalar(Math.max(s, 0.001));
      cr.mesh.rotation.y += dt * 6;
      if (cr.shrink >= 1) {
        cr.mesh.removeFromParent();
        const li = cr.list.indexOf(cr);
        if (li >= 0) cr.list.splice(li, 1);
        // take the collider with it — no invisible box where the crate used to be
        if (cr.col && cr.colList) {
          const ci = cr.colList.indexOf(cr.col);
          if (ci >= 0) cr.colList.splice(ci, 1);
        }
        allCrates.splice(i, 1);
        respawnCrateElsewhere();
      }
    }
  }
}

function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt;
    p.mesh.position.y = groundHeight(p.pos.x, p.pos.z) + 0.1 + Math.sin(p.t * 3) * 0.08;
    p.mesh.rotation.y += dt * 2;
    const d = Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z);
    if (d < 1.1 && !player.dead) {
      if (p.kind === 'ammo' && !player.weapon.melee) {
        const add = Math.ceil(player.weapon.mag * 0.8 * player.ammoMult);
        reserves[player.weapon.id] = (reserves[player.weapon.id] | 0) + add;
        toast(`+${add} AMMO`);
      } else if (p.kind === 'medkit') {
        player.hp = Math.min(player.maxHp, player.hp + 25);
        toast('+25 HP');
      } else continue;
      SFX.pickup();
      rumble(50, 0.2, 0.4);
      updateAmmoHUD();
      scene.remove(p.mesh);
      pickups.splice(i, 1);
    } else if (p.t > 30) {
      scene.remove(p.mesh);
      pickups.splice(i, 1);
    }
  }
}

function updateCamera(dt) {
  const cy = player.camYaw, cp = player.camPitch;
  const aimT = player.aimT || 0;
  const fpv = player.fpvT || 0;   // 0 = third-person .. 1 = first-person
  const wz = player.weapon;
  // ---- third-person over-the-shoulder rig: aiming tightens the shoulder & pulls the camera in close ----
  const rightX = Math.cos(cy), rightZ = -Math.sin(cy);
  const shoulder = 0.7 * (1 - aimT * 0.35);
  const pivotX = player.pos.x + rightX * shoulder;
  const pivotY = player.pos.y + 1.5;
  const pivotZ = player.pos.z + rightZ * shoulder;
  const tpDist = camDist * (1 - aimT * 0.5);     // zoom closer over the shoulder while aiming
  const tpX = pivotX + Math.sin(cy) * Math.cos(cp) * tpDist;
  const tpY = pivotY - Math.sin(cp) * tpDist;
  const tpZ = pivotZ + Math.cos(cy) * Math.cos(cp) * tpDist;
  // ---- first-person eye + forward look ----
  const fwdX = -Math.sin(cy) * Math.cos(cp), fwdY = Math.sin(cp), fwdZ = -Math.cos(cy) * Math.cos(cp);
  const eyeX = player.pos.x + fwdX * 0.16;
  const eyeY = player.pos.y + 1.52 + fwdY * 0.16;
  const eyeZ = player.pos.z + fwdZ * 0.16;
  // ---- blend the two rigs by the view toggle ----
  const tX = lerp(tpX, eyeX, fpv), tY = lerp(tpY, eyeY, fpv), tZ = lerp(tpZ, eyeZ, fpv);
  const k = 1 - Math.exp(-14 * dt);
  camera.position.set(
    lerp(camera.position.x, tX, k),
    lerp(camera.position.y, tY, k),
    lerp(camera.position.z, tZ, k),
  );
  const minY = groundHeight(camera.position.x, camera.position.z) + 0.35;
  if (camera.position.y < minY) camera.position.y = minY;
  // look target eases from the blob itself (TP) to far ahead along the aim (FP)
  const lx = lerp(pivotX, eyeX + fwdX * 8, fpv);
  const ly = lerp(pivotY + 0.15, eyeY + fwdY * 8, fpv);
  const lz = lerp(pivotZ, eyeZ + fwdZ * 8, fpv);
  camera.lookAt(lx, ly, lz);
  // zoom focus: snipers punch in hard through the scope, guns focus modestly, melee barely
  let zoomedFov;
  if (wz.id === 'sniper') zoomedFov = 22;
  else if (wz.melee) zoomedFov = 62;
  else zoomedFov = fpv > 0.5 ? 45 : 52;
  const fov = lerp(70, zoomedFov, aimT);
  if (Math.abs(fov - camera.fov) > 0.04) { camera.fov = fov; camera.updateProjectionMatrix(); }
  // sniper scope overlay only when actually aiming a sniper (hide the normal crosshair behind it)
  const scoped = wz.id === 'sniper' && aimT > 0.55;
  if (scopeEl) scopeEl.style.opacity = scoped ? (aimT - 0.55) / 0.45 : 0;
  hud.crosshair.style.opacity = scoped ? '0' : '';
  if (shakeAmp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeAmp;
    camera.position.y += (Math.random() - 0.5) * shakeAmp;
    shakeAmp *= Math.exp(-10 * dt);
  }
  skyDome.position.copy(camera.position); // the sky rides along so it never has edges
  moon.position.set(player.pos.x + moonOff.x, moonOff.y, player.pos.z + moonOff.z);
  moon.target.position.copy(player.pos);
  moon.target.updateMatrixWorld();
}

function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.mesh); particles.splice(i, 1); continue; }
    p.vy -= 9 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    const g = groundHeight(p.mesh.position.x, p.mesh.position.z) + 0.03;
    if (p.mesh.position.y < g) {
      // blood that lands leaves a small pool when extra gore is on
      if (p.blood && !p.landed && extraGoreOn() && Math.random() < 0.25) groundSplat(p.mesh.position.x, p.mesh.position.z, 0.18 + Math.random() * 0.2);
      p.landed = true;
      p.mesh.position.y = g;
    }
  }
  // gibs: chunky flying limb/head pieces that tumble and bleed
  for (let i = gibs.length - 1; i >= 0; i--) {
    const gb = gibs[i];
    gb.life -= dt;
    if (gb.life <= 0) { scene.remove(gb.mesh); gibs.splice(i, 1); continue; }
    gb.vy -= 12 * dt;
    gb.mesh.position.x += gb.vx * dt;
    gb.mesh.position.y += gb.vy * dt;
    gb.mesh.position.z += gb.vz * dt;
    gb.mesh.rotation.x += gb.spin * dt;
    gb.mesh.rotation.z += gb.spin * 0.7 * dt;
    if (goreAmt() > 0.02 && Math.random() < 0.3) spawnBlood(gb.mesh.position.x, gb.mesh.position.y, gb.mesh.position.z, 0, 0, 0.3);
    const g = groundHeight(gb.mesh.position.x, gb.mesh.position.z) + 0.08;
    if (gb.mesh.position.y < g) {
      gb.mesh.position.y = g; gb.vy *= -0.35; gb.vx *= 0.5; gb.vz *= 0.5; gb.spin *= 0.5;
      if (!gb.bled) { gb.bled = true; if (extraGoreOn()) groundSplat(gb.mesh.position.x, gb.mesh.position.z, 0.5); }
    }
  }
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) { scene.remove(t.mesh); t.mesh.geometry.dispose(); tracers.splice(i, 1); }
    else t.mesh.material.opacity = t.life / 0.07 * 0.85;
  }
  if (flashT > 0) { flashT -= dt; if (flashT <= 0) flash.visible = false; }
  // crosshair is always centred now (camera-relative aim in both third and first person)
  const cx = innerWidth / 2;
  const cyp = innerHeight / 2;
  hud.crosshair.style.left = cx + 'px';
  hud.crosshair.style.top = cyp + 'px';
  hud.hitmarker.style.left = cx + 'px';
  hud.hitmarker.style.top = cyp + 'px';
  // the X flares open when an enemy is under the crosshair
  let hot = false;
  if (game.state === 'playing' && !player.dead) {
    getAimDir(_aimDir);
    for (const z of zombies) {
      if (z.state === 'dying') continue;
      const gy2 = z.blob.root.position.y;
      if (raySphere(camera.position.x, camera.position.y, camera.position.z, _aimDir.x, _aimDir.y, _aimDir.z, z.pos.x, gy2 + 1.3 * z.scale, z.pos.z, 0.45 * z.scale) !== Infinity ||
          raySphere(camera.position.x, camera.position.y, camera.position.z, _aimDir.x, _aimDir.y, _aimDir.z, z.pos.x, gy2 + 0.7 * z.scale, z.pos.z, 0.58 * z.scale) !== Infinity) { hot = true; break; }
    }
  }
  hud.crosshair.classList.toggle('enemy', hot);
  if (hitmarkT > 0) {
    hitmarkT -= dt;
    hud.hitmarker.style.opacity = 1;
    hud.hitmarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${1 + hitmarkT * 3.5})`; // snappy pop
  } else hud.hitmarker.style.opacity = 0;
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) { hud.toast.style.opacity = 0; hud.toast.style.top = '30%'; } }
  if (bloodSplatT > 0) { bloodSplatT -= dt; if (bloodSplatT <= 0) bloodEl.style.opacity = 0; }
}

// ---------- character select ----------
(function buildCousinCards() {
  const row = document.getElementById('cousincards');
  for (const c of COUSINS) {
    const card = document.createElement('div');
    card.className = 'card' + (c.id === selectedCousin ? ' sel' : '');
    const hex = '#' + c.color.toString(16).padStart(6, '0');
    card.innerHTML = `
      <div class="blobface" style="background:${hex}"><span class="beye"></span><span class="beye"></span></div>
      <b>${c.name}</b>
      <i>${c.perk}</i>
      <p>${c.lore}</p>`;
    card.addEventListener('click', () => {
      selectedCousin = c.id;
      row.querySelectorAll('.card').forEach(el => el.classList.remove('sel'));
      card.classList.add('sel');
      initAudio(); SFX.pickup(); previewTheme(c.id);
    });
    row.appendChild(card);
  }
})();

// ---------- boot ----------
refreshControlsBar();
equipWeapon('fists');
buildTown();
game.weather = rollWeather();
applyEnvironment(); // morning sky behind the menus too
updateChunks(0, 0);
player.pos.y = groundHeight(0, 0);
playerBlob.root.position.copy(player.pos);
window.__dbg = {
  player, game, zombies, camera, input, companions, settings, notches, setNotch, WEAPONS, supportTop,
  openNearest: () => { const c = findNearCrate(); if (c) openCrate(c); },
  recruitNearest: () => { const c = findNearRecruit(); if (c) recruitCousin(c); },
  give: id => giveWeapon(id),
  spawn: (dx = 3, dz = 0) => spawnZombie(player.pos.x + dx, player.pos.z + dz),
  hurtZombie: (z, dmg, opts) => damageZombie(z, dmg, 0, 1, 2, opts),
  blowLimb: z => blowLimb(z, 0, 1),
  popHead: z => popHead(z, 0, 1),
  exposeBrain, killZombie, pauseGame, resumeGame, scene, allCrates, cycleWeapon,
  get playerBlob() { return playerBlob; },
  fire: () => fireWeapon(),
  hurt: (dmg, ax, az) => hurtPlayer(dmg, ax, az),
  toggleFPV, bossState, spawnBoss, maybeSpawnBoss, applyEnvironment, completeCleanup, tradeWeapons, findNearTrade,
  setSky: (phase, weather) => { game.phase = phase; if (weather) game.weather = weather; applyEnvironment(); },
  recruitAll: () => companions.forEach(c => { if (!c.recruited) recruitCousin(c); }),
  step: (dt = 0.05) => { updatePlayer(dt); updateCompanions(dt); updateZombies(dt); updateCrates(dt); updatePickups(dt); updateSpawner(dt); updateFx(dt); },
};

// ---------- living tab: rotating cousin-face favicon + typewriter title (cycles forever) ----------
(function livingTab() {
  const link = document.createElement('link');
  link.rel = 'icon'; link.type = 'image/png';
  document.head.appendChild(link);
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const fx = cv.getContext('2d');
  function roundRect(x, y, w, h, r) {
    const [tl, tr, br, bl] = r;
    fx.beginPath();
    fx.moveTo(x + tl, y);
    fx.lineTo(x + w - tr, y); fx.arcTo(x + w, y, x + w, y + tr, tr);
    fx.lineTo(x + w, y + h - br); fx.arcTo(x + w, y + h, x + w - br, y + h, br);
    fx.lineTo(x + bl, y + h); fx.arcTo(x, y + h, x, y + h - bl, bl);
    fx.lineTo(x, y + tl); fx.arcTo(x, y, x + tl, y, tl);
    fx.closePath();
  }
  function faceIcon(color) {
    fx.clearRect(0, 0, 64, 64);
    fx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    roundRect(8, 6, 48, 52, [24, 24, 20, 20]); fx.fill();        // rounded blob head
    fx.fillStyle = 'rgba(0,0,0,.14)';
    roundRect(8, 42, 48, 16, [0, 0, 20, 20]); fx.fill();          // soft chin shading
    for (const ex of [24, 40]) {                                  // two googly eyes
      fx.fillStyle = '#fff';
      fx.beginPath(); fx.ellipse(ex, 27, 7, 8, 0, 0, TAU); fx.fill();
      fx.fillStyle = '#222';
      fx.beginPath(); fx.arc(ex + 1.5, 29, 3.2, 0, TAU); fx.fill();
    }
    return cv.toDataURL('image/png');
  }
  let ci = 0, li = 0;
  function tick() {
    const c = COUSINS[ci];
    if (li === 0) link.href = faceIcon(c.color);   // swap to this cousin's pic as their name begins
    li++;
    if (li >= c.name.length) {
      document.title = c.name + ' .ᐟ';              // finished: name + flourish
      ci = (ci + 1) % COUSINS.length; li = 0;       // then move on to the next cousin
      setTimeout(tick, 900);
    } else {
      document.title = c.name.slice(0, li);         // one more letter (every .5s)
      setTimeout(tick, 500);
    }
  }
  tick();
})();

animate();
