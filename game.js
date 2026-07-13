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
  [4, -44, 110, 6],    // main street, shops, town hall, courthouse
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
  let f = smooth(clamp((dr - 3.5) / 10, 0, 1)); // graded flat near roads
  let td = Infinity;
  for (const r of TOWN_RECTS) td = Math.min(td, rectDist(x, z, r));
  f = Math.min(f, smooth(clamp((td - 1) / 12, 0, 1))); // graded flat in town
  return base * (0.12 + 0.88 * f);
}
function onRoad(x, z, margin = 0) {
  return roadAxisDist(x) < 3.2 + margin || roadAxisDist(z) < 3.2 + margin;
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
// a few distinct cracked-glass patterns: jagged spokes from a random impact point + rings
function makeGlassTex(variant) {
  const bases = ['#141824', '#1a1e2a', '#101420', '#171b25'];
  return canvasTex(64, 64, ctx => {
    ctx.fillStyle = bases[variant % bases.length]; ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = 'rgba(255,255,255,.65)';
    ctx.lineWidth = 1 + Math.random();
    const ix = 12 + Math.random() * 40, iy = 12 + Math.random() * 40;
    const spokes = 5 + ((Math.random() * 5) | 0);
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * TAU + Math.random() * 0.7;
      const len = 22 + Math.random() * 40, segs = 2 + ((Math.random() * 2) | 0);
      let x = ix, y = iy;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < segs; s++) {
        x += Math.cos(a) * len / segs + (Math.random() - 0.5) * 10;
        y += Math.sin(a) * len / segs + (Math.random() - 0.5) * 10;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let r = 5; r < 22; r += 5 + Math.random() * 4) { ctx.beginPath(); ctx.arc(ix, iy, r, 0, TAU); ctx.stroke(); }
  });
}
const brokenGlassMats = [];
for (let i = 0; i < 4; i++) brokenGlassMats.push(new THREE.MeshLambertMaterial({ map: makeGlassTex(i), side: THREE.DoubleSide }));
function randomGlassMat() { return brokenGlassMats[(Math.random() * brokenGlassMats.length) | 0]; }
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

// fake blob shadow
const shadowGeo = new THREE.CircleGeometry(1, 20);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
function makeShadow(r) {
  const s = new THREE.Mesh(shadowGeo, shadowMat);
  s.rotation.x = -Math.PI / 2; s.scale.setScalar(r); s.position.y = 0.02; s.renderOrder = 1;
  return s;
}

// ---------- settings (tunable from pause menu) ----------
const settings = {
  master: 0.6, sfx: 1, music: 0.6, ambience: 0.5,
  zombieSpawn: 1, lootSpawn: 1,
  gore: 0.6, extraGore: 0,
};

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
    else if (w.id === 'fists') { noiseBurst(0.08, 500, 0.3); }
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
};

// ---------- ambience + persona themes ----------
let ambStarted = false;
function startAmbience() {
  if (ambStarted || !actx) return;
  ambStarted = true;
  // low wind: looping filtered noise with a slow swell
  const n = actx.sampleRate * 3, buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const g = actx.createGain(); g.gain.value = 0.5;
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.07;
  const lfoG = actx.createGain(); lfoG.gain.value = 0.22;
  lfo.connect(lfoG); lfoG.connect(g.gain); lfo.start();
  src.connect(f); f.connect(g); g.connect(ambGain); src.start();
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
    if (game.state === 'playing') {
      const note = t.seq[themeStep % t.seq.length];
      tone(NF(note), t.tempo * 0.9, 0.13, t.wave, undefined, musicGain);
      if (themeStep % 2 === 0) {
        const b = t.bass[Math.floor(themeStep / 2) % t.bass.length];
        tone(NF(b - 12), t.tempo * 1.6, 0.17, 'triangle', undefined, musicGain);
      }
      themeStep++;
      themeTimer = setTimeout(tick, t.tempo * 1000);
    } else {
      themeTimer = setTimeout(tick, 220); // idle while paused/menu, keep the beat ready
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
const WEAPONS = {
  fists:   { id: 'fists',   name: 'Fists',        melee: true, dmg: 42, range: 2.4, rpm: 150, mag: Infinity, kick: 0.02, rmb: [60, 0.4, 0.2], cqc: 0, weak: true, dismember: 0.12 },
  pistol:  { id: 'pistol',  name: 'Pistol',       dmg: 34, mag: 18, rpm: 320, auto: false, spread: 0.012, ammo: 90,  color: 0x555a66, kick: 0.025, rmb: [60, 0.3, 0.5],  cqc: 0.45, weak: true,  dismember: 0.14 },
  smg:     { id: 'smg',     name: 'SMG',          dmg: 15, mag: 50, rpm: 800, auto: true,  spread: 0.038, ammo: 200, color: 0x3a3f4a, kick: 0.015, rmb: [40, 0.2, 0.4],  cqc: 0.5,  weak: true,  dismember: 0.1 },
  shotgun: { id: 'shotgun', name: 'Shotgun',      dmg: 12, mag: 10, rpm: 300, auto: false, spread: 0.11,  ammo: 60, pellets: 12, color: 0x6e3d1f, kick: 0.09, rmb: [150, 1, 0.7], cqc: 2.0, dismember: 0.75, gib: true },
  rifle:   { id: 'rifle',   name: 'Assault Rifle',dmg: 28, mag: 40, rpm: 560, auto: true,  spread: 0.022, ammo: 160, color: 0x51442e, kick: 0.02, rmb: [50, 0.35, 0.5],  cqc: 0.5,  dismember: 0.32 },
  magnum:  { id: 'magnum',  name: 'Magnum',       dmg: 62, mag: 10, rpm: 160, auto: false, spread: 0.008, ammo: 60,  color: 0x8a8f9a, kick: 0.05, rmb: [90, 0.6, 0.5],  cqc: 0.6,  dismember: 0.6, gib: true },
  sniper:  { id: 'sniper',  name: 'Sniper Rifle', dmg: 145,mag: 8,  rpm: 45,  auto: false, spread: 0.002, ammo: 40,  color: 0x2f4a35, kick: 0.09, rmb: [160, 1, 0.7],  cqc: 0.2,  dismember: 0.9, gib: true },
};
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
    const body = box(0.08, 0.11, 0.95, c); body.position.set(0, 0.05, -0.28); g.add(body);
    const scope = cyl(0.045, 0.045, 0.2, 0x181a1f); scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.14, -0.1); g.add(scope);
    const stock = box(0.08, 0.14, 0.24, 0x33291c); stock.position.set(0, 0, 0.22); g.add(stock);
  }
  return g;
}

// ---------- blob character builder ----------
function buildBlob({ color = 0xff8c42, zombie = false, scale = 1, belly = true, droopy = false, brain = false, blind = false, wounded = false }) {
  const root = new THREE.Group();
  const wob = new THREE.Group();
  root.add(wob);

  const body = ball(0.55, color);
  body.scale.set(0.55, 0.62, 0.5);
  body.position.y = 0.62;
  wob.add(body);

  // belly patch: NPCs only (hero has none)
  if (belly) {
    const bellyM = ball(0.34, zombie ? 0x9fb86a : 0xffe0b8);
    bellyM.scale.set(0.34, 0.4, 0.25);
    bellyM.position.set(0, 0.58, 0.28);
    wob.add(bellyM);
  }

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
    pupil.position.set(0.16 * s, droopy ? -0.06 : 0.05, 0.43);
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

  const gunSocket = new THREE.Group();
  gunSocket.position.set(0, -0.58, -0.05);
  arms[1].add(gunSocket);

  root.scale.setScalar(scale);
  // shadow lives in world space (not parented to the body) so it stays flat on the
  // ground when the character jumps and stays under their center when they topple over.
  const shadow = makeShadow(0.55 * scale);
  scene.add(shadow);

  // collect skin meshes for red damage flash
  const skinList = [];
  root.traverse(o => { if (o.isMesh && o.material !== shadowMat) skinList.push({ mesh: o, mat: o.material }); });
  return { root, wob, head, arms, legs, gunSocket, body, skull, brainMesh, eyes, shadow, stainCount, skinList, flashT: 0,
           armGone: [false, false], legGone: [false, false], headGone: false };
}
// keep a blob's ground shadow pinned flat under its centre, regardless of jump height / death tilt
function placeShadow(blob, x, z) {
  if (!blob.shadow) return;
  blob.shadow.position.set(x, groundHeight(x, z) + 0.02, z);
}
const FLASH_RED = new THREE.MeshBasicMaterial({ color: 0xff2525 });
function flashBlob(blob) {
  if (blob.flashT <= 0) for (const s of blob.skinList) s.mesh.material = FLASH_RED;
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

function aabb(x, z, hw, hd, h, y0) {
  if (y0 === undefined) y0 = groundHeight(x, z) - 0.5;
  return { x, z, hw, hd, y0, y1: y0 + h + 0.5 };
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
  if (!onShelf) colliders.push(aabb(x, z, 0.4, 0.4, 1, y - 0.2));
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
  colliders.push(aabb(x, z, 1.0, 0.45, 1.9, y0 - 0.2));
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

// window pane helper: some broken
function windowPane(rng, w, h) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), rng() < 0.42 ? randomGlassMat() : darkGlassMat);
  return m;
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
        colliders.push(aabb(sx, sz, horiz ? segLen / 2 : t / 2, horiz ? t / 2 : segLen / 2, h, y0 - 0.5));
      }
    } else {
      const m = box(wall.hw * 2, h + 0.6, wall.hd * 2, wallC);
      m.position.set(wall.x, y0 + h / 2 - 0.3, wall.z);
      group.add(m);
      colliders.push(aabb(wall.x, wall.z, wall.hw, wall.hd, h, y0 - 0.5));
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
  addRoof(group, bx, y0 + h + 0.25, bz, w, d, rng);
  if (rng() < 0.85) makeShelf(rng, bx + (rng() - 0.5) * (w - 3), bz + (rng() - 0.5) * (d - 3), (rng() * 4 | 0) * Math.PI / 2, group, colliders, crateList);
  if (rng() < 0.7) makeCrate(rng, bx + (rng() - 0.5) * (w - 2.5), y0 + 0.08, bz + (rng() - 0.5) * (d - 2.5), group, colliders, crateList, false);
  // parked car near the building
  if (rng() < 0.45) {
    const side = rng() < 0.5 ? -1 : 1;
    const cxr = bx + side * (w / 2 + 2.6), czr = bz + (rng() - 0.5) * d;
    if (!onRoad(cxr, czr, 1)) makeCar(rng, cxr, czr, group, colliders, { broken: rng() < 0.6 });
  }
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
  colliders.push(aabb(x, z, 0.25, 0.25, 2, y0 - 0.5));
}
function makeBush(rng, x, z, group) {
  const y0 = groundHeight(x, z);
  const g = new THREE.Group();
  const n = 2 + ((rng() * 2) | 0);
  for (let i = 0; i < n; i++) {
    const b = ball(0.32 + rng() * 0.25, [0x2f4a28, 0x3a5a30, 0x44663a][(rng() * 3) | 0]);
    b.scale.y *= 0.75;
    b.position.set((rng() - 0.5) * 0.7, 0.2 + rng() * 0.1, (rng() - 0.5) * 0.7);
    g.add(b);
  }
  g.position.set(x, y0, z);
  group.add(g);
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
  if (big) colliders.push(aabb(x, z, r * 0.8, r * 0.8, r, y0 - 0.5));
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
  const winGlass = () => (opts.broken && rng() < 0.6) ? randomGlassMat() : darkGlassMat;
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
  g.rotation.y = opts.rotY !== undefined ? opts.rotY : rng() * TAU;
  if (opts.flipped) {
    g.rotation.z = Math.PI + (rng() - 0.5) * 0.3;
    g.position.y = y0 + 1.35;
  }
  group.add(g);
  colliders.push(aabb(x, z, 2.1, 2.1, 1.6, y0 - 0.5));
}
// traffic pileup: cluster of wrecked cars, all broken windows, some flipped
function makePileup(rng, x, z, along, group, colliders) {
  const n = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const off = (i - n / 2) * 4.6 + (rng() - 0.5) * 1.6;
    const jitter = (rng() - 0.5) * 2.6;
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
  if (hasVRoad) group.add(terrainPlane(6.4, CHUNK, 2, 10, ox - 17, oz, roadMat, 0.04));
  if (hasHRoad) group.add(terrainPlane(CHUNK, 6.4, 10, 2, ox, oz - 17, roadMat, 0.04));

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

  const nB = rng() < 0.55 ? 1 + (rng() < 0.3 ? 1 : 0) : 0;
  for (let i = 0; i < nB; i++) {
    const p = freeSpot(10, 4);
    if (p) makeBuilding(rng, p.x, p.z, group, colliders, crateList);
  }
  const nS = (rng() * 2) | 0;
  for (let i = 0; i < nS; i++) {
    const p = freeSpot(3);
    if (p) makeShelf(rng, p.x, p.z, rng() * TAU, group, colliders, crateList);
  }
  if (cx === 0 && cz === 0) makeCrate(rng, 4.5, groundHeight(4.5, 5) + 0.02, 5, group, colliders, crateList, false);
  const nC = Math.round((1 + ((rng() * 2) | 0)) * clamp(settings.lootSpawn, 0, 3));
  for (let i = 0; i < nC; i++) {
    const p = freeSpot(2);
    if (p) makeCrate(rng, p.x, groundHeight(p.x, p.z) + 0.02, p.z, group, colliders, crateList, false);
  }
  // foliage: trees + bushes + rocks (never on roads)
  const nT = 2 + ((rng() * 4) | 0);
  for (let i = 0; i < nT; i++) {
    const p = freeSpot(2.5);
    if (p) makeTree(rng, p.x, p.z, group, colliders);
  }
  const nBu = 3 + ((rng() * 4) | 0);
  for (let i = 0; i < nBu; i++) {
    const p = freeSpot(1.4);
    if (p) makeBush(rng, p.x, p.z, group);
  }
  const nR = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < nR; i++) {
    const p = freeSpot(1.4);
    if (p) makeRock(rng, p.x, p.z, group, colliders, rng() < 0.4);
  }
  // barrels
  const nJ = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < nJ; i++) {
    const p = freeSpot(1.5);
    if (!p) continue;
    const barrel = cyl(0.34, 0.34, 0.9, [0x7a2e2e, 0x2e5a7a, 0x5a7a2e][(rng() * 3) | 0]);
    barrel.position.set(p.x, groundHeight(p.x, p.z) + 0.45, p.z);
    group.add(barrel);
    colliders.push(aabb(p.x, p.z, 0.36, 0.36, 1));
  }
  // traffic pileups on roads
  if (hasVRoad && rng() < 0.3 && !(cx === 0 && cz === 0)) {
    makePileup(rng, ox - 17, oz + (rng() - 0.5) * 16, 'z', group, colliders);
  }
  if (hasHRoad && rng() < 0.3 && !inTown(ox, oz - 17, 8)) {
    makePileup(rng, ox + (rng() - 0.5) * 16, oz - 17, 'x', group, colliders);
  }

  scene.add(group);
  return { group, colliders, crates: crateList, cx, cz };
}

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
function resolveCollision(x, z, r) {
  for (const c of nearbyColliders(x, z)) {
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
  return [x, z];
}
function rayAABB(ox, oy, oz, dx, dy, dz, c) {
  const mn = [c.x - c.hw, c.y0, c.z - c.hd], mx = [c.x + c.hw, c.y1, c.z + c.hd];
  const p = [ox, oy, oz], d = [dx, dy, dz];
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

function grandBuilding(x, z, w, d, h, wallColor, label, rng) {
  const y0 = groundHeight(x, z);
  const body = box(w, h, d, wallColor);
  body.position.set(x, y0 + h / 2, z);
  townGroup.add(body);
  townColliders.push(aabb(x, z, w / 2, d / 2, h, y0 - 0.5));
  // columns + steps on front (facing -z / toward main road)
  for (let i = 0; i < 4; i++) {
    const col = cyl(0.28, 0.32, h * 0.85, 0xd8d2c4, 10);
    col.position.set(x - w / 4 + i * (w / 6), y0 + h * 0.42, z - d / 2 - 1);
    townGroup.add(col);
  }
  const pedShape = new THREE.Shape();
  pedShape.moveTo(-w * 0.4, 0); pedShape.lineTo(w * 0.4, 0); pedShape.lineTo(0, 2.2); pedShape.closePath();
  const ped = new THREE.Mesh(new THREE.ShapeGeometry(pedShape), new THREE.MeshLambertMaterial({ color: 0xcfc9ba, side: THREE.DoubleSide }));
  ped.position.set(x, y0 + h, z - d / 2 - 1.1);
  townGroup.add(ped);
  const roofSlab = box(w + 1, 0.3, d + 2.6, 0x8b8577);
  roofSlab.position.set(x, y0 + h + 0.15, z - 0.8);
  townGroup.add(roofSlab);
  for (const s of [1.1, 0.55]) {
    const step = box(w * 0.55, 0.22, s, 0xbab4a6);
    step.position.set(x, y0 + (s === 1.1 ? 0.11 : 0.33), z - d / 2 - 2.4 + s * 0.5);
    townGroup.add(step);
  }
  const plate = textPlate(label, 6, 1.5);
  plate.position.set(x, y0 + h - 1, z - d / 2 - 0.02 - 1.05);
  plate.rotation.y = Math.PI;
  townGroup.add(plate);
  // windows
  const rrng = rng || Math.random;
  for (let i = -1; i <= 1; i++) {
    const win = windowPane(rrng, 1.4, 1.6);
    win.position.set(x + i * (w / 3.2), y0 + h * 0.45, z - d / 2 - 0.02);
    win.rotation.y = Math.PI;
    townGroup.add(win);
  }
}

function shopBuilding(x, z, w, d, h, faceDir, label, rng) {
  const y0 = groundHeight(x, z);
  const wallC = [0x7a6a55, 0x6a707a, 0x7d6a62, 0x6d7a68][(rng() * 4) | 0];
  const body = box(w, h, d, wallC);
  body.position.set(x, y0 + h / 2, z);
  townGroup.add(body);
  townColliders.push(aabb(x, z, w / 2, d / 2, h, y0 - 0.5));
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
    for (let i = 0; i < Math.floor(w / 3.2) - 1; i++) {
      const lx = x - w / 2 + 2.4 + i * 3.2;
      const line = new THREE.Mesh(BOX, lineMat);
      line.scale.set(0.14, 0.02, 2.6);
      line.position.set(lx, groundHeight(lx, rz) + 0.09, rz);
      townGroup.add(line);
    }
    // a few abandoned cars in the lot
    for (let i = 0; i < 2 + rows; i++) {
      if (rng() < 0.4) {
        const cx2 = x - w / 2 + 4 + rng() * (w - 8);
        makeCar(rng, cx2, rz + (rng() - 0.5) * 1.5, townGroup, townColliders, { broken: rng() < 0.7, rotY: Math.PI / 2 + (rng() - 0.5) * 0.3 });
      }
    }
  }
}

function buildTown() {
  const rng = mulberry32(9001);
  // main street shops: road z in [-20,-14], shops face it from both sides
  const northNames = ['DINER', 'BAKERY', 'BOOKS', 'TOOLS', 'PIZZA'];
  const southNames = ['MART', 'BANK', 'BARBER', 'TAILOR', 'RADIO'];
  for (let i = 0; i < 5; i++) {
    shopBuilding(12 + i * 13, -8.5, 9.5, 7, 3.4 + rng() * 0.8, -1, northNames[i], rng); // north side faces south (-z)
    shopBuilding(12 + i * 13, -26, 9.5, 7, 3.4 + rng() * 0.8, 1, southNames[i], rng);   // south side faces north (+z)
  }
  // town hall & courthouse at the east end of main street
  grandBuilding(94, -2, 18, 12, 6.5, 0x8a7f6a, 'TOWN HALL', rng);
  grandBuilding(94, -34, 18, 12, 6, 0x9a9aa2, 'COURTHOUSE', rng);
  // courthouse faces north toward road: rotate? simpler - both front-face -z; courthouse sits south so flip via second grand building mirrored:
  // (accepted: courthouse front faces away from road, side visible)

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
  const spots = [[10, -17.5], [36, -12], [58, -22], [88, -10], [94, -26], [30, 30], [55, 42], [18, 20], [70, 55], [41, 10]];
  for (const [cx2, cz2] of spots) {
    if (rng() < 0.8) makeCrate(rng, cx2 + (rng() - 0.5) * 3, groundHeight(cx2, cz2) + 0.05, cz2 + (rng() - 0.5) * 3, townGroup, townColliders, townCrates, false);
  }
  // street lamps along main street
  for (let i = 0; i < 6; i++) {
    const lx = 10 + i * 15;
    for (const s of [-1, 1]) {
      const lz = -17 + s * 4.6;
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
  interact: false, reload: false, aim: false, aimPad: false, aimTouch: false,
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
  if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
  if (e.code === 'Tab') { e.preventDefault(); toggleControlsBar(); }
  refreshControlsBar();
});
addEventListener('keyup', e => { keys[e.code] = false; });

addEventListener('mousemove', e => {
  aimX = e.clientX; aimY = e.clientY;
  if (rmbDrag) {
    input.lookDX += (e.clientX - lastMX) * 0.0052;
    input.lookDY += (e.clientY - lastMY) * 0.0052;
  }
  lastMX = e.clientX; lastMY = e.clientY;
  if (!isTouch && input.device !== 'kbm') { input.device = 'kbm'; refreshControlsBar(); }
});
canvas.addEventListener('mousedown', e => {
  initAudio();
  if (e.button === 0 && game.state === 'playing') { input.shoot = true; input.shootPressed = true; }
  // right mouse: aim down sights (ease to first person). drag still fine-tunes the look.
  if (e.button === 2) { rmbDrag = true; input.aim = true; lastMX = e.clientX; lastMY = e.clientY; }
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
  input.lookDX += lx * 2.6 * dt;
  input.lookDY += ly * 2.0 * dt;
  if (justPressed(0)) input.jump = true;
  if (justPressed(1)) input.reload = true;
  if (justPressed(2)) input.interact = true;
  if (justPressed(3)) cycleWeapon(1);              // Y / Triangle: cycle weapon
  if (justPressed(10)) input.sprintGamepad = !input.sprintGamepad;
  const rt = gp.buttons[7] && (gp.buttons[7].pressed || gp.buttons[7].value > 0.4);
  if (rt && !gpPrev.rt) input.shootPressed = true;
  gpPrev.rt = rt;
  input.shootGamepad = rt;
  // left trigger: aim down sights (ease to first person)
  input.aimPad = !!(gp.buttons[6] && (gp.buttons[6].pressed || gp.buttons[6].value > 0.35));
  if (justPressed(9)) togglePause();     // Start: pause menu
  if (justPressed(8)) toggleControlsBar(); // Back/Select: controls help
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
      [['kbm', 'mouse_move'], 'Free aim'],
      [['kbm', 'mouse_left'], 'Shoot'],
      [['kbm', 'mouse_right'], 'Aim (1st person)'],
      [['kbm', 'keyboard_f'], 'Swap weapon'],
      [['kbm', 'mouse_scroll'], 'Zoom'],
      [['kbm', 'keyboard_e'], 'Loot / Recruit'],
      [['kbm', 'keyboard_r'], 'Reload'],
      [['kbm', 'keyboard_space'], 'Jump'],
      [['kbm', 'keyboard_shift'], 'Sprint'],
    ],
    prompt: ['kbm', 'keyboard_e'],
  },
  xbox: {
    name: 'Xbox Controller',
    rows: [
      [['xbox', 'xbox_stick_l'], 'Move'],
      [['xbox', 'xbox_stick_r'], 'Look'],
      [['xbox', 'xbox_rt'], 'Shoot'],
      [['xbox', 'xbox_lt'], 'Aim (1st person)'],
      [['xbox', 'xbox_button_color_y'], 'Swap weapon'],
      [['xbox', 'xbox_button_color_x'], 'Loot / Recruit'],
      [['xbox', 'xbox_button_color_b'], 'Reload'],
      [['xbox', 'xbox_button_color_a'], 'Jump'],
      [['xbox', 'xbox_stick_side_l'], 'Sprint (L3)'],
    ],
    prompt: ['xbox', 'xbox_button_color_x'],
  },
  ps: {
    name: 'PlayStation Controller',
    rows: [
      [['ps', 'playstation_stick_l'], 'Move'],
      [['ps', 'playstation_stick_r'], 'Look'],
      [['ps', 'playstation_trigger_r2'], 'Shoot'],
      [['ps', 'playstation_trigger_l2'], 'Aim (1st person)'],
      [['ps', 'playstation_button_triangle'], 'Swap weapon'],
      [['ps', 'playstation_button_square'], 'Loot / Recruit'],
      [['ps', 'playstation_button_circle'], 'Reload'],
      [['ps', 'playstation_button_cross'], 'Jump'],
      [['ps', 'playstation_stick_side_l'], 'Sprint (L3)'],
    ],
    prompt: ['ps', 'playstation_button_square'],
  },
  touch: {
    name: 'Touch',
    rows: [
      [['touch', 'touch_swipe_move'], 'Left side: joystick'],
      [['touch', 'touch_swipe_horizontal'], 'Right side: look'],
      [['touch', 'touch_tap'], 'Shoot / Aim / GUN swap'],
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
  { id: 'blingo',  name: 'Blingo',  color: 0xff8c42, perk: 'Balanced hero', lore: 'The First Immune. Bitten at the Blob Falls picnic on day one, never turned. He swore on his grandma’s jelly recipe to take the town back.' },
  { id: 'blazo',   name: 'Blazo',   color: 0xff4f42, perk: '+15% damage',   lore: 'Blingo’s hot-headed cousin. The horde ate his championship chili stand. Now every trigger pull is seasoned with revenge.' },
  { id: 'blizzy',  name: 'Blizzy',  color: 0x6fd8ff, perk: '+12% sprint speed', lore: 'The coolest head in Clan Blob. Scouted the frozen north alone for two winters. Zombies can’t catch what they can’t chill.' },
  { id: 'blomba',  name: 'Blomba',  color: 0xb06fff, perk: '+25 max HP',    lore: 'Big-hearted bouncer of the old Blob Lounge. Soft on the inside, softer on the outside, absolutely will not fall over.' },
  { id: 'bloopy',  name: 'Bloopy',  color: 0x3fd8b0, perk: '35% faster reload', lore: 'Fidgety tinkerer who rebuilt the clan radio from soup cans. Hands so twitchy the reloads finish themselves.' },
  { id: 'blondie', name: 'Blondie', color: 0xffd84a, perk: '+50% ammo from loot', lore: 'The clan hoarder. Her pockets don’t make sense geometrically. If there’s a bullet in a crate, she’ll find three.' },
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
  let i = 0;
  for (const data of COUSINS) {
    if (data.id === selectedCousin) continue;
    const ang = i * (TAU / 5) + Math.random() * 0.8;
    const dist = 65 + i * 18 + Math.random() * 25;
    let x = Math.sin(ang) * dist, z = Math.cos(ang) * dist;
    [x, z] = resolveCollision(x, z, 0.6);
    const blob = buildBlob({ color: data.color });
    blob.root.position.set(x, groundHeight(x, z), z);
    scene.add(blob.root);
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 34, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: data.color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
    );
    beacon.position.set(x, groundHeight(x, z) + 17, z);
    scene.add(beacon);
    const gun = buildGunMesh('pistol');
    blob.gunSocket.add(gun);
    companions.push({ data, blob, beacon, pos: new THREE.Vector3(x, 0, z), recruited: false, shootCd: 0, walkPhase: Math.random() * 9, yaw: Math.random() * TAU,
      weapon: WEAPONS.pistol, gunMesh: gun });
    i++;
  }
  updateCousinHUD();
}
function updateCousinHUD() {
  const n = companions.filter(c => c.recruited).length;
  document.querySelector('#cousins b').textContent = n + '/' + companions.length;
}

// ---------- player ----------
// hero has no belly patch (NPCs do)
let playerBlob = buildBlob({ color: 0xff8c42, belly: false });
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
  dmgMult: 1, sprintMult: 1, reloadMult: 1, ammoMult: 1,
  owned: ['fists'], aiming: false, aimT: 0,   // aimT: eased 0=third-person .. 1=first-person ADS
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
  playerBlob = buildBlob({ color: data.color, belly: false });
  scene.add(playerBlob.root);
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
  if (gunMesh) { player.reloading = 0; gunMesh.removeFromParent(); gunMesh = null; }
  if (!player.weapon.melee) {
    gunMesh = buildGunMesh(id);
    playerBlob.gunSocket.add(gunMesh);
    player.clip = player.weapon.mag;
    if (reserves[id] === undefined) reserves[id] = Math.round(player.weapon.ammo * player.ammoMult);
  } else {
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

// ---------- zombies ----------
const zombies = [];
const ZOMBIE_COLORS = [0x6fae4e, 0x7fb85a, 0x5f9a44, 0x8fbc6a];
function spawnZombie(x, z, powerScale = 1) {
  const scale = 0.85 + Math.random() * 0.5;
  // random rot-variants; brain-showing spawns are the rare weak-spot walkers
  const droopy = Math.random() < 0.3;
  const brain = Math.random() < 0.12;
  const blind = Math.random() < 0.16;
  // extra-gore mode makes fresh zombies spawn already mangled and bloody
  const wounded = extraGoreOn() && Math.random() < 0.35 + settings.extraGore * 0.5;
  const blob = buildBlob({ color: ZOMBIE_COLORS[(Math.random() * ZOMBIE_COLORS.length) | 0], zombie: true, scale, droopy, brain, blind, wounded });
  blob.root.position.set(x, groundHeight(x, z), z);
  scene.add(blob.root);
  zombies.push({
    blob, pos: new THREE.Vector3(x, 0, z),
    hp: (55 + Math.random() * 40) * scale * powerScale,
    speed: (1.5 + Math.random() * 1.4) * (0.9 + powerScale * 0.1),
    yaw: Math.random() * TAU,
    state: 'chase', attackT: 0, deadT: 0, walkPhase: Math.random() * 10,
    groanT: Math.random() * 6, scale,
    brainExposed: brain, blind, stepT: Math.random(),
    bleeding: wounded, dripT: 0,
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
  m.scale.setScalar(r); m.position.set(x, groundHeight(x, z) + 0.03, z); m.renderOrder = 1;
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
// sever an arm or leg; returns true if one came off. arms are weighted higher so you can
// reliably shoot arms off.
function blowLimb(z, kx, kz) {
  const b = z.blob;
  const opts = [];
  if (!b.armGone[0]) { opts.push(['arm', 0]); opts.push(['arm', 0]); }
  if (!b.armGone[1]) { opts.push(['arm', 1]); opts.push(['arm', 1]); }
  if (!b.legGone[0]) opts.push(['leg', 0]);
  if (!b.legGone[1]) opts.push(['leg', 1]);
  if (!opts.length) return false;
  const [kind, idx] = opts[(Math.random() * opts.length) | 0];
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
const game = { state: 'menu', time: 0, kills: 0, cratesOpened: 0, spawnT: 2, lastShot: new THREE.Vector3(), lastShotT: -99 };

function resetGame() {
  applyCousin(selectedCousin);
  player.pos.set(0, groundHeight(0, 0), 0);
  player.vy = 0; player.hp = player.maxHp; player.dead = false;
  player.camYaw = 0; player.camPitch = -0.24;
  player.reloading = 0;
  player.lastHurtT = -9; player.lastShotT = -9;
  player.stumbleT = 0; player.idlePhase = 0; player.lastStepPh = -1; player.meleeArm = 0;
  player.owned = ['fists']; player.aiming = false; player.aimT = 0;
  input.aim = false; input.aimPad = false; input.aimTouch = false;
  game.time = 0; game.kills = 0; game.cratesOpened = 0; game.spawnT = 2; game.lastShotT = -99;
  // clear ground gore from the last run
  for (const d of decals) { scene.remove(d); d.material.dispose(); }
  decals.length = 0;
  for (const gb of gibs) scene.remove(gb.mesh);
  gibs.length = 0;
  for (const z of zombies) { scene.remove(z.blob.root); if (z.blob.shadow) scene.remove(z.blob.shadow); }
  zombies.length = 0;
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
    spawnZombie(Math.sin(ang) * 48, Math.cos(ang) * 48);
  }
}

document.getElementById('playbtn').addEventListener('click', () => {
  initAudio();
  document.getElementById('startscreen').classList.add('hidden');
  document.body.classList.add('playing');
  resetGame();
  game.state = 'playing';
});
document.getElementById('respawnbtn').addEventListener('click', () => {
  initAudio();
  document.getElementById('deathscreen').classList.add('hidden');
  document.body.classList.add('playing');
  resetGame();
  game.state = 'playing';
});

function die() {
  player.dead = true;
  game.state = 'dead';
  document.body.classList.remove('playing');
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
}
function resumeGame() {
  if (game.state !== 'paused') return;
  pauseScreen.classList.add('hidden');
  document.body.classList.add('playing');
  game.state = 'playing';
}
function quitToMenu() {
  game.state = 'menu';
  pauseScreen.classList.add('hidden');
  document.getElementById('startscreen').classList.remove('hidden');
  document.body.classList.remove('playing');
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
addEventListener('keydown', e => { if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); togglePause(); } });

// wire each slider to its setting
const S = id => document.getElementById(id);
const pct = v => Math.round(v * 100) + '%';
const mult = v => v.toFixed(2) + 'x';
function bindSlider(id, valId, key, fmt, onChange) {
  const el = S(id), val = S(valId);
  el.addEventListener('input', () => {
    settings[key] = parseFloat(el.value);
    if (val) val.textContent = fmt(settings[key]);
    if (onChange) onChange();
  });
  return () => { el.value = settings[key]; if (val) val.textContent = fmt(settings[key]); };
}
const settingSyncers = [
  bindSlider('setMaster', 'valMaster', 'master', pct, applyAudioSettings),
  bindSlider('setSfx', 'valSfx', 'sfx', pct, applyAudioSettings),
  bindSlider('setMusic', 'valMusic', 'music', pct, applyAudioSettings),
  bindSlider('setAmb', 'valAmb', 'ambience', pct, applyAudioSettings),
  bindSlider('setZspawn', 'valZspawn', 'zombieSpawn', mult),
  bindSlider('setLspawn', 'valLspawn', 'lootSpawn', mult),
  bindSlider('setGore', 'valGore', 'gore', pct, updateGoreLock),
  bindSlider('setExtraGore', 'valExtra', 'extraGore', pct),
];
// the extra-gore slider only unlocks once base gore is maxed out
function updateGoreLock() {
  const unlocked = settings.gore >= 0.999;
  document.getElementById('extraGoreRow').classList.toggle('locked', !unlocked);
  if (!unlocked && settings.extraGore > 0) { settings.extraGore = 0; S('setExtraGore').value = 0; S('valExtra').textContent = pct(0); }
}
function syncSettingsUI() { for (const s of settingSyncers) s(); updateGoreLock(); }
syncSettingsUI();

// ---------- aiming ----------
const _aimDir = new THREE.Vector3(), _ndc = new THREE.Vector3();
function getAimDir(out) {
  // free-aim cursor on kbm, but once we're aiming down sights the crosshair centers
  if (input.device === 'kbm' && player.aimT < 0.5) {
    _ndc.set((aimX / innerWidth) * 2 - 1, -(aimY / innerHeight) * 2 + 1, 0.5);
    out.copy(_ndc).unproject(camera).sub(camera.position).normalize();
  } else {
    camera.getWorldDirection(out);
  }
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
    player.meleeArm ^= 1; // alternate punching arm each swing
    for (const z of zombies) {
      if (z.state === 'dying') continue;
      const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < w.range) {
        const ang = Math.atan2(dx, dz);
        let diff = Math.abs(((ang - player.lastAimYaw) % TAU + TAU + Math.PI) % TAU - Math.PI);
        if (diff < 1.15) {
          damageZombie(z, w.dmg * player.dmgMult * closeBonus(w, d), dx / d, dz / d, 2.5, { weapon: w, dist: d, isHead: false });
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
      const gy = z.blob.root.position.y;
      const bodyY = gy + 0.7 * z.scale, headY = gy + 1.3 * z.scale;
      let t = raySphere(_from.x, _from.y, _from.z, rdx, rdy, rdz, z.pos.x, headY, z.pos.z, 0.42 * z.scale);
      let isHead = true;
      if (t === Infinity) { t = raySphere(_from.x, _from.y, _from.z, rdx, rdy, rdz, z.pos.x, bodyY, z.pos.z, 0.55 * z.scale); isHead = false; }
      if (t < bestT) { bestT = t; best = { z, isHead }; }
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
      damageZombie(best.z, dmg, rdx, rdz, w.id === 'shotgun' ? 1.2 : 2, { weapon: w, dist: dHit, isHead: best.isHead });
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
  game.kills++;
  hud.kills.textContent = game.kills;
  play3d(z.pos.x, z.pos.z, () => SFX.splat());
  rumble(70, 0.4, 0.3);
  spawnBlood(z.pos.x, z.blob.root.position.y + 0.8 * z.scale, z.pos.z, kx, kz, 2.2);
  if (headPop) popHead(z, kx, kz);
  if (Math.random() < 0.22 * settings.lootSpawn) spawnPickup(Math.random() < 0.7 ? 'ammo' : 'medkit', z.pos.x, z.pos.z);
}
function damageZombie(z, dmg, kx, kz, knock, opts = {}) {
  if (z.state === 'dying') return;
  const w = opts.weapon, isHead = opts.isHead, dist = opts.dist == null ? 0 : opts.dist;
  const b = z.blob;

  // heavy weapons, or any hit on an already-exposed brain, burst the head: instant kill, head vanishes
  if (isHead && !b.headGone && ((w && w.gib) || z.brainExposed)) {
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

  // limb dismemberment on body hits (chance scales with close range + whether it killed)
  if (!isHead && w && w.dismember && Math.random() < w.dismember * closeBonus(w, dist) * (z.hp <= 0 ? 1 : 0.55)) {
    blowLimb(z, kx, kz);
  }

  if (z.hp > 0) {
    // weak or far headshot that doesn't kill cracks the skull open, revealing the weak spot
    if (isHead && !z.brainExposed && w && (w.weak || dist > 26)) exposeBrain(z);
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
function recruitCousin(c) {
  c.recruited = true;
  scene.remove(c.beacon);
  c.beacon = null;
  SFX.recruit();
  rumble(160, 0.5, 0.7);
  toast(`${c.data.name.toUpperCase()} JOINED! - ${c.data.lore}`, true);
  updateCousinHUD();
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
  c.gunMesh = c.weapon.melee ? null : buildGunMesh(id);
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
    const mins = Math.floor(game.time / 60), secs = Math.floor(game.time % 60);
    hud.timer.textContent = mins + ':' + String(secs).padStart(2, '0');
  }
  updateCamera(dt);
  updateFx(dt);
  renderer.render(scene, camera);
}

function updatePlayer(dt) {
  if (player.dead) return;
  player.camYaw -= input.lookDX;
  player.camPitch = clamp(player.camPitch - input.lookDY, -1.25, 0.6);
  input.lookDX = 0; input.lookDY = 0;

  let mx = input.moveX, my = input.moveY;
  if (input.device === 'kbm') {
    mx = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
    my = (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0);
  }
  const ml = Math.hypot(mx, my);
  if (ml > 1) { mx /= ml; my /= ml; }

  const sprinting = (keys['ShiftLeft'] || keys['ShiftRight'] || sprintToggle || input.sprintGamepad) && ml > 0.1;
  const speed = (sprinting ? 6.6 * player.sprintMult : 4.3);

  // camera-relative: forward = away from camera
  const sin = Math.sin(player.camYaw), cos = Math.cos(player.camYaw);
  const vx = (mx * cos + my * sin) * speed;
  const vz = (my * cos - mx * sin) * speed;

  // stumble: knocked-back drift after taking a hit (can still move & attack)
  let mvx = vx, mvz = vz;
  if (player.stumbleT > 0) {
    player.stumbleT -= dt;
    const s = Math.max(player.stumbleT, 0) / 0.42;
    mvx += player.stumbleX * 7 * s;
    mvz += player.stumbleZ * 7 * s;
  }
  let nx = player.pos.x + mvx * dt;
  let nz = player.pos.z + mvz * dt;
  [nx, nz] = resolveCollision(nx, nz, 0.45);
  player.pos.x = nx; player.pos.z = nz;

  const groundY = groundHeight(player.pos.x, player.pos.z);
  if (input.jump && player.grounded) {
    player.vy = 7.4; player.grounded = false;
    player.squash = -0.25;
    SFX.jump();
    rumble(40, 0.15, 0.3);
  }
  input.jump = false;
  if (player.grounded) {
    player.pos.y = groundY;
  } else {
    player.vy -= 20 * dt;
    player.pos.y += player.vy * dt;
    if (player.pos.y <= groundY) {
      if (player.vy < -4) { player.squash = 0.3; rumble(60, 0.25, 0.4); }
      player.pos.y = groundY; player.vy = 0; player.grounded = true;
    }
  }

  player.shootCd -= dt;
  const wantShoot = input.shoot || input.shootGamepad;
  const w = player.weapon;
  if (w.auto || w.melee) {
    // full-auto & melee: hold to fire, capped by the weapon's rate of fire
    if ((wantShoot || (w.melee && input.shootPressed)) && player.shootCd <= 0) {
      fireWeapon();
      player.shootCd = 60 / w.rpm;
    }
  } else if (input.shootPressed && player.shootCd <= 0) {
    // semi-auto & shotgun: one shot per trigger pull, as fast as you can pull it
    fireWeapon();
    player.shootCd = 0.05; // tiny floor so a single click can't double-fire
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

  // interact: crates + recruits
  nearCrate = findNearCrate();
  nearRecruit = findNearRecruit();
  if (nearCrate && nearRecruit) {
    const dc = Math.hypot(nearCrate.pos.x - player.pos.x, nearCrate.pos.z - player.pos.z);
    const dr = Math.hypot(nearRecruit.pos.x - player.pos.x, nearRecruit.pos.z - player.pos.z);
    if (dc <= dr) nearRecruit = null; else nearCrate = null;
  }
  const showPrompt = !!(nearCrate || nearRecruit);
  hud.prompttxt.textContent = nearCrate ? 'Open Crate' : nearRecruit ? 'Recruit ' + nearRecruit.data.name : '';
  hud.prompt.classList.toggle('hidden', !showPrompt || input.device === 'touch');
  if (isTouch) hud.btnInteract.style.display = showPrompt ? 'flex' : 'none';
  if (input.interact) {
    if (nearCrate) openCrate(nearCrate);
    else if (nearRecruit) recruitCousin(nearRecruit);
    input.interact = false;
  }

  if (game.time - player.lastHurtT > 6 && player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + 4 * dt);
  }
  hud.health.style.width = (player.hp / player.maxHp * 100) + '%';
  hud.health.style.background = player.hp > 50 ? 'linear-gradient(90deg,#2ecc71,#27ae60)' :
    player.hp > 25 ? 'linear-gradient(90deg,#f39c12,#e67e22)' : 'linear-gradient(90deg,#e74c3c,#c0392b)';
  hud.healthTxt.textContent = Math.ceil(player.hp) + ' HP';
  hud.vignette.style.opacity = player.hp < 40 ? (1 - player.hp / 40) * 0.9 :
    (game.time - player.lastHurtT < 0.4 && game.time > player.lastHurtT ? 0.7 : 0);

  // --- blob animation ---
  const moving = ml > 0.1;
  const stumbling = player.stumbleT > 0;
  player.walkPhase += dt * (moving ? (sprinting ? 13 : 9) : 2);
  player.idlePhase += dt;
  const b = playerBlob;
  b.root.position.copy(player.pos);
  updateFlash(b, dt);
  // shadow stays flat on the ground even mid-jump (it isn't parented to the body)
  placeShadow(b, player.pos.x, player.pos.z);

  // aim-down-sights: ease the view toward first person while the aim button is held on a gun
  player.aiming = (input.aim || input.aimPad || input.aimTouch) && !w.melee && !player.dead;
  player.aimT = lerp(player.aimT, player.aiming ? 1 : 0, 1 - Math.exp(-11 * dt));
  // hide our own head deep in first person so it doesn't block the view
  b.head.visible = player.aimT < 0.6;

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
  if (w.melee) {
    // alternate the punching arm each swing
    const punching = game.time - player.lastShotT < 0.18;
    b.arms[0].rotation.x = -swing * 0.8;
    b.arms[1].rotation.x = swing * 0.8;
    if (punching) b.arms[player.meleeArm].rotation.x = -1.9;
    else if (stumbling) { b.arms[0].rotation.x -= stumbleLean * 1.0; b.arms[1].rotation.x -= stumbleLean * 1.0; }
  } else {
    const aimPitch = Math.asin(clamp(recentShot ? getAimDir(_aimDir).y : 0, -0.9, 0.9));
    b.arms[1].rotation.x = -Math.PI / 2 - aimPitch * 0.8;
    b.arms[0].rotation.x = wantShoot || recentShot ? b.arms[1].rotation.x : -swing * 0.8;
    const kick = game.time - player.lastShotT < 0.09 ? 0.35 : 0;
    b.arms[1].rotation.x += kick;
  }
  if (!player.grounded) {
    b.arms[0].rotation.x = -2.4;
    if (w.melee) b.arms[1].rotation.x = -2.4;
    b.legs[0].rotation.x = 0.5; b.legs[1].rotation.x = -0.3;
  }

  updateChunks(player.pos.x, player.pos.z);
}

// ---------- companions ----------
const _cv = new THREE.Vector3();
function updateCompanions(dt) {
  for (const c of companions) {
    const b = c.blob;
    const gy = groundHeight(c.pos.x, c.pos.z);
    updateFlash(b, dt);
    placeShadow(b, c.pos.x, c.pos.z);
    if (!c.recruited) {
      // idle at their spot, bob & look around — but keep the gun levelled, not pointing at the dirt
      b.root.position.set(c.pos.x, gy, c.pos.z);
      b.wob.scale.y = 1 + Math.sin(performance.now() * 0.002 + c.walkPhase) * 0.03;
      b.root.rotation.y = c.yaw + Math.sin(performance.now() * 0.0006 + c.walkPhase) * 0.6;
      b.arms[1].rotation.x = -Math.PI / 2;
      b.arms[0].rotation.x = -0.1;
      if (c.beacon) {
        c.beacon.material.opacity = 0.2 + Math.sin(performance.now() * 0.003) * 0.1;
        c.beacon.rotation.y += dt * 0.5;
      }
      continue;
    }
    // follow the player
    const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    let moving = false;
    if (dist > 30) { // teleport catch-up if left far behind
      c.pos.x = player.pos.x - dx / dist * 4;
      c.pos.z = player.pos.z - dz / dist * 4;
    } else if (dist > 3.2) {
      const sp = dist > 10 ? 6.8 : 5.0;
      let nx = c.pos.x + dx / dist * sp * dt;
      let nz = c.pos.z + dz / dist * sp * dt;
      [nx, nz] = resolveCollision(nx, nz, 0.42);
      c.pos.x = nx; c.pos.z = nz;
      c.walkPhase += dt * 10;
      c.yaw = Math.atan2(dx, dz);
      moving = true;
    }
    // auto-loot: grab a gun from any crate we're standing next to
    for (const cr of allCrates) {
      if (cr.opened) continue;
      if (Math.hypot(cr.pos.x - c.pos.x, cr.pos.z - c.pos.z) < 2.1 && Math.abs(cr.pos.y - gy) < 2.4) {
        companionLoot(c, cr);
        break;
      }
    }
    // fight: shoot nearest zombie with whatever weapon we're carrying
    const cw = c.weapon || WEAPONS.pistol;
    c.shootCd -= dt;
    let tgt = null, tD = 15;
    for (const z of zombies) {
      if (z.state === 'dying') continue;
      const d = Math.hypot(z.pos.x - c.pos.x, z.pos.z - c.pos.z);
      if (d < tD) { tD = d; tgt = z; }
    }
    if (tgt) c.yaw = Math.atan2(tgt.pos.x - c.pos.x, tgt.pos.z - c.pos.z);
    if (tgt && c.shootCd <= 0) {
      c.shootCd = (cw.auto ? 0.32 : cw.id === 'shotgun' ? 0.6 : 0.7) + Math.random() * 0.15;
      const zy = tgt.blob.root.position.y + 0.7 * tgt.scale;
      _cv.set(c.pos.x, groundHeight(c.pos.x, c.pos.z) + 1.0, c.pos.z);
      const kx = (tgt.pos.x - c.pos.x) / tD, kz = (tgt.pos.z - c.pos.z) / tD;
      const shots = cw.id === 'shotgun' ? 3 : 1;
      for (let s = 0; s < shots; s++) spawnTracer(_cv.clone(), new THREE.Vector3(tgt.pos.x + (Math.random() - 0.5) * s, zy, tgt.pos.z + (Math.random() - 0.5) * s));
      damageZombie(tgt, (cw.dmg || 20) * 1.25 * shots, kx, kz, 1, { weapon: cw, dist: tD, isHead: false });
      if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 24) play3d(c.pos.x, c.pos.z, () => SFX.shoot(cw));
    }
    b.root.position.set(c.pos.x, gy, c.pos.z);
    b.root.rotation.y = angLerp(b.root.rotation.y, c.yaw, 1 - Math.exp(-10 * dt));
    const swing = Math.sin(c.walkPhase) * (moving ? 0.8 : 0.05);
    b.legs[0].rotation.x = swing;
    b.legs[1].rotation.x = -swing;
    b.arms[0].rotation.x = -swing * 0.7;
    b.arms[1].rotation.x = -Math.PI / 2; // gun always levelled forward
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
    if (pDist > 75) { scene.remove(b.root); if (b.shadow) scene.remove(b.shadow); zombies.splice(i, 1); continue; }

    // pick what draws this zombie: blind ones only home in on the last gunshot noise
    let tx, tz, hasTarget = true;
    if (z.blind) {
      if (game.time - game.lastShotT < 14) { tx = game.lastShot.x; tz = game.lastShot.z; }
      else { hasTarget = false; tx = z.pos.x; tz = z.pos.z; }
    } else {
      tx = player.pos.x; tz = player.pos.z;
      let tDist = player.dead ? Infinity : pDist;
      for (const c of companions) {
        if (!c.recruited) continue;
        const d = Math.hypot(c.pos.x - z.pos.x, c.pos.z - z.pos.z);
        if (d < tDist) { tDist = d; tx = c.pos.x; tz = c.pos.z; }
      }
      if (tDist === Infinity) hasTarget = false;
    }
    const dx = tx - z.pos.x, dz = tz - z.pos.z;
    const dist = hasTarget ? Math.hypot(dx, dz) : Infinity;

    z.groanT -= dt;
    if (z.groanT < 0) { z.groanT = 4 + Math.random() * 7; if (pDist < 26) play3d(z.pos.x, z.pos.z, () => SFX.groan()); }

    if (dist > 1.5 && dist < Infinity) {
      const sp = z.speed * (dist < 3 ? 1.25 : 1);
      let nx = z.pos.x + dx / dist * sp * dt;
      let nz = z.pos.z + dz / dist * sp * dt;
      for (const o of zombies) {
        if (o === z || o.state === 'dying') continue;
        const sx = nx - o.pos.x, sz = nz - o.pos.z;
        const sd = Math.hypot(sx, sz);
        if (sd < 0.85 && sd > 0.001) { nx += sx / sd * (0.85 - sd) * 0.5; nz += sz / sd * (0.85 - sd) * 0.5; }
      }
      [nx, nz] = resolveCollision(nx, nz, 0.4 * z.scale);
      z.pos.x = nx; z.pos.z = nz;
      z.walkPhase += dt * z.speed * 3.2;
      // shuffling footsteps (3D, throttled by distance)
      z.stepT -= dt * z.speed;
      if (z.stepT <= 0) { z.stepT = 0.55; if (pDist < 22) play3d(z.pos.x, z.pos.z, () => SFX.step(false)); }
    }
    z.attackT -= dt;
    // bite whoever is actually within reach (blind zombies still bite point-blank)
    if (z.attackT <= 0 && !player.dead && pDist < 1.7) {
      z.attackT = 0.9;
      hurtPlayer(9 + Math.random() * 6, player.pos.x - z.pos.x, player.pos.z - z.pos.z);
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
  const maxZ = Math.round(Math.min(26, 4 + Math.floor(game.time / 22) + Math.floor(game.kills / 7)) * settings.zombieSpawn);
  const interval = Math.max(0.35, (3.6 - game.time / 80) / settings.zombieSpawn);
  if (game.spawnT <= 0 && zombies.length < maxZ) {
    game.spawnT = interval;
    const ang = Math.random() * TAU;
    const d = 32 + Math.random() * 22;
    let x = player.pos.x + Math.sin(ang) * d;
    let z = player.pos.z + Math.cos(ang) * d;
    [x, z] = resolveCollision(x, z, 0.5);
    const power = 1 + game.time / 240;
    spawnZombie(x, z, power);
  }
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
  // ---- third-person over-the-shoulder rig (shoulder offset fades out as we aim) ----
  const rightX = Math.cos(cy), rightZ = -Math.sin(cy);
  const shoulder = 0.7 * (1 - aimT);
  const pivotX = player.pos.x + rightX * shoulder;
  const pivotY = player.pos.y + 1.5;
  const pivotZ = player.pos.z + rightZ * shoulder;
  const tpX = pivotX + Math.sin(cy) * Math.cos(cp) * camDist;
  const tpY = pivotY - Math.sin(cp) * camDist;
  const tpZ = pivotZ + Math.cos(cy) * Math.cos(cp) * camDist;
  // ---- first-person eye + forward look ----
  const fwdX = -Math.sin(cy) * Math.cos(cp), fwdY = Math.sin(cp), fwdZ = -Math.cos(cy) * Math.cos(cp);
  const eyeX = player.pos.x + fwdX * 0.16;
  const eyeY = player.pos.y + 1.52 + fwdY * 0.16;
  const eyeZ = player.pos.z + fwdZ * 0.16;
  // ---- blend the two rigs by how far we're aiming ----
  const tX = lerp(tpX, eyeX, aimT), tY = lerp(tpY, eyeY, aimT), tZ = lerp(tpZ, eyeZ, aimT);
  const k = 1 - Math.exp(-14 * dt);
  camera.position.set(
    lerp(camera.position.x, tX, k),
    lerp(camera.position.y, tY, k),
    lerp(camera.position.z, tZ, k),
  );
  const minY = groundHeight(camera.position.x, camera.position.z) + 0.35;
  if (camera.position.y < minY) camera.position.y = minY;
  // look target eases from the blob itself (TP) to far ahead along the aim (FP)
  const lx = lerp(pivotX, eyeX + fwdX * 8, aimT);
  const ly = lerp(pivotY + 0.15, eyeY + fwdY * 8, aimT);
  const lz = lerp(pivotZ, eyeZ + fwdZ * 8, aimT);
  camera.lookAt(lx, ly, lz);
  // gentle zoom while aiming down sights
  const fov = lerp(70, 58, aimT);
  if (Math.abs(fov - camera.fov) > 0.04) { camera.fov = fov; camera.updateProjectionMatrix(); }
  if (shakeAmp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeAmp;
    camera.position.y += (Math.random() - 0.5) * shakeAmp;
    shakeAmp *= Math.exp(-10 * dt);
  }
  moon.position.set(player.pos.x - 30, 50, player.pos.z - 20);
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
  // crosshair follows the free-aim cursor on kbm, but centers on gamepad / when aiming down sights
  const centered = input.device !== 'kbm' || player.aimT >= 0.5;
  const cx = centered ? innerWidth / 2 : aimX;
  const cyp = centered ? innerHeight / 2 : aimY;
  hud.crosshair.style.left = cx + 'px';
  hud.crosshair.style.top = cyp + 'px';
  hud.hitmarker.style.left = cx + 'px';
  hud.hitmarker.style.top = cyp + 'px';
  if (hitmarkT > 0) { hitmarkT -= dt; hud.hitmarker.style.opacity = 1; }
  else hud.hitmarker.style.opacity = 0;
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
updateChunks(0, 0);
player.pos.y = groundHeight(0, 0);
playerBlob.root.position.copy(player.pos);
window.__dbg = {
  player, game, zombies, camera, input, companions, settings, WEAPONS,
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
  step: (dt = 0.05) => { updatePlayer(dt); updateCompanions(dt); updateZombies(dt); updateCrates(dt); updatePickups(dt); updateSpawner(dt); updateFx(dt); },
};
animate();
