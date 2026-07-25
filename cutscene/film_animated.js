// film_animated.js — run in browser console with game loaded via npm run dev
// Captures in-engine cutscene footage frame-by-frame for smooth video.
// Press Space to advance shots, or run dirRunAll() for the full sequence.

(function() {

const C = document.getElementById('c');
const $ = window.__dbg;
if (!$) { console.error('window.__dbg not found — is the game loaded?'); return; }
const {
  renderer, camera, scene, game, player, settings,
  wxSet, applyEnvironment, buildBlob, spawnZombie,
  skyDome, cloudDome, hemi, sunLight, addRotGore,
  groundHeight, bossState, zombies, THREE,
} = $;

const COUSINS = [
  { id: 'blingo',  color: 0xff8c42 },
  { id: 'blazo',   color: 0xff4f42 },
  { id: 'blizzy',  color: 0x6fd8ff },
  { id: 'blomba',  color: 0xb06fff },
  { id: 'bloopy',  color: 0x3fd8b0 },
  { id: 'blondie', color: 0xffd84a },
];

const D = { shot: 0, frames: 0, CAP_W: 1920, CAP_H: 1080, FPS: 24 };
const SAVE = 'http://localhost:3000/save';
let _saveQ = Promise.resolve(), cleanup = [];
let _prevDrawDist = 2;
let _origEscape = null;

// ── Director mode: override pause menu so capture never gets interrupted ──
function directorMode() {
  const dbg = window.__dbg;
  if (!dbg) return;
  // Prevent boss spawns during filming — we want the cousins at the fountain shot clean
  if (dbg.bossState) {
    dbg.bossState._wasSpawned = dbg.bossState.spawned;
    dbg.bossState.spawned = true; // mark as spawned so nothing tries to spawn
  }
  // Override the pause toggle so neither Escape nor pause button interrupts capture
  _origEscape = window.onkeydown;
  const oldPause = dbg.pauseGame;
  dbg._oldPause = oldPause;
  dbg.pauseGame = function() {}; // no-op the pause function
  // Suppress the pause button visually
  const pauseBtn = document.getElementById('btnPause');
  if (pauseBtn) pauseBtn.style.display = 'none';
}
function endDirectorMode() {
  const dbg = window.__dbg;
  if (!dbg) return;
  if (dbg.bossState && dbg.bossState._wasSpawned !== undefined) {
    dbg.bossState.spawned = dbg.bossState._wasSpawned;
  }
  if (dbg._oldPause) dbg.pauseGame = dbg._oldPause;
  const pauseBtn = document.getElementById('btnPause');
  if (pauseBtn) pauseBtn.style.display = '';
}

// ── Max out draw distance for shadows during capture ──
function maxSettings() {
  if (window.__dbg && window.__dbg.notches) {
    _prevDrawDist = window.__dbg.notches.drawDist;
    window.__dbg.setNotch('drawDist', 5, true);
  }
}
function restoreSettings() {
  if (window.__dbg && window.__dbg.notches) {
    window.__dbg.setNotch('drawDist', _prevDrawDist, true);
  }
}

function beginCapture() {
  const w = C.width || window.innerWidth, h = C.height || window.innerHeight;
  renderer.setSize(D.CAP_W, D.CAP_H);
  camera.aspect = D.CAP_W / D.CAP_H;
  camera.updateProjectionMatrix();
}
function endCapture() {
  renderer.setSize(C.width || innerWidth, C.height || innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
function snap(name) {
  renderer.render(scene, camera);
  const dataUrl = C.toDataURL('image/png');
  D.frames++;
  _saveQ = _saveQ.then(() =>
    fetch(SAVE, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, data: dataUrl }) })
    .then(r => r.json()).catch(() => {})
  );
}

async function panShot(name, dur, camA, camB, lookAt) {
  beginCapture();
  const n = Math.max(1, Math.round(dur * D.FPS));
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(n - 1, 1);
    camera.position.lerpVectors(camA, camB, t);
    camera.lookAt(lookAt);
    skyDome.position.copy(camera.position);
    cloudDome.position.copy(camera.position);
    snap(name + '_' + String(i).padStart(4, '0'));
    if (window.__step) window.__step(1, 1 / D.FPS);
    await new Promise(r => requestAnimationFrame(r));
  }
  endCapture();
}

async function holdShot(name, dur) {
  beginCapture();
  const n = Math.round(dur * D.FPS);
  for (let i = 0; i < n; i++) {
    snap(name + '_' + String(i).padStart(4, '0'));
    if (window.__step) window.__step(1, 1 / D.FPS);
    await new Promise(r => requestAnimationFrame(r));
  }
  endCapture();
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
function setClock(h) { game.clock = h; applyEnvironment(true); }
function setWeather(k) { wxSet(k); applyEnvironment(true); }
function setFog(near, far) { settings.fogFar = far; applyEnvironment(true); }
function v3(x,y,z) { return new THREE.Vector3(x,y,z); }

function spawnCousin(id, x, z, rot) {
  const c = COUSINS.find(c => c.id === id);
  const blob = buildBlob({ color: c.color, scale: 1 });
  const y = groundHeight(x, z);
  blob.root.position.set(x, y, z);
  blob.root.rotation.y = rot || 0;
  scene.add(blob.root); cleanup.push(blob.root);
  return blob;
}
function spawnZ(x, z, opts) {
  const zz = spawnZombie(x, z, 1, opts || {});
  if (zz != null) cleanup.push(zz);
  return zz;
}
function clearAll() {
  for (const o of cleanup) {
    if (o.parent) o.parent.remove(o);
    if (o.isZombie && zombies.includes(o)) { const i = zombies.indexOf(o); if (i >= 0) zombies.splice(i, 1); }
  }
  cleanup = [];
}

const SHOTS = [

  // SHOT 1 — Low flyover with time progression: night → dawn → noon → sunset (18s)
  async function() {
    console.log('🎬 S1: The Block flyover');
    clearAll();
    player.pos.set(20, groundHeight(20, 50), 50);
    // seamless flyover: each shot starts where the last one ended — position AND look-at
    // Night — start high behind the church, descending toward the graveyard
    setClock(23.5); setWeather('sunny'); applyEnvironment(true);
    await pause(300);
    await panShot('s01a_night', 4, v3(28, 30, 100), v3(20, 22, 70), v3(20, 5, 50));
    // Dawn — continue from the graveyard across the plaza
    setClock(6); applyEnvironment(true);
    await panShot('s01b_dawn', 4, v3(20, 22, 70), v3(15, 18, 40), v3(20, 5, 50));
    // Noon — descend across the plaza toward the bank
    setClock(13); applyEnvironment(true);
    await panShot('s01c_noon', 4, v3(15, 18, 40), v3(8, 14, 10), v3(15, 5, 30));
    // Sunset — slow pan down to the bank steps
    setClock(18.5); applyEnvironment(true);
    await panShot('s01d_sunset', 6, v3(8, 14, 10), v3(2, 8, -20), v3(8, 4, 0));
  },

  // SHOT 2 — Cousins on bank steps facing the fountain (10s slow pan)
  async function() {
    console.log('🎬 S2: Cousins Assemble');
    setClock(18); setWeather('sunny'); setFog(30, 105);
    clearAll();
    player.pos.set(0, groundHeight(0, -37), -37);
    const ids = COUSINS.map(c => c.id);
    // spread across bank steps, facing south toward the fountain
    const positions = [[-3.5,-35],[-2,-35],[-0.5,-35],[1,-35],[2.5,-35],[4,-35]];
    for (let i = 0; i < 6; i++) spawnCousin(ids[i], positions[i][0], positions[i][1], 0);
    await pause(600);
    await panShot('s02', 10, v3(-5, 3, -30), v3(6, 2.5, -30), v3(0, 1.5, -35));
  },

  // SHOT 5 — Rotten One closeup (14s, storm + lightning)
  async function() {
    console.log('🎬 S5: Rotten One');
    setClock(23); setWeather('rain'); setFog(18, 65);
    clearAll();
    const bx = 132, bz = -36, gy = groundHeight(bx, bz);
    player.pos.set(bx, gy, bz);
    bossState.spawned4 = true;
    const boss = buildBlob({ color: 0x77a12c, zombie: true, scale: 3.1, hands: 0x3f5a14 });
    if (addRotGore) addRotGore(boss, { hangEye: true, chestHole: true });
    boss.root.position.set(bx, gy, bz);
    scene.add(boss.root); cleanup.push(boss.root);
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, d = 5 + Math.random() * 4;
      spawnZ(bx + Math.sin(a) * d, bz + Math.cos(a) * d, { green: true, rot: true, shield: true });
    }
    await pause(300);
    // wide orbit around the boss
    await panShot('s05', 9, v3(138, 5, -28), v3(127, 4, -40), v3(bx, 3, bz));
  },
];

// ── Director UI ──
const ui = document.createElement('div');
ui.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:999;background:rgba(0,0,0,.85);color:#fff;padding:10px 20px;border-radius:10px;font:13px monospace;display:flex;gap:12px;align-items:center;';
ui.innerHTML = '<b>🎬 DIRECTOR</b> <span id="dirStat">Ready</span>';
document.body.appendChild(ui);

window.dirNext = async function() {
  if (D.shot >= SHOTS.length) {
    document.getElementById('dirStat').textContent = `✅ DONE — ${D.frames} frames`;
    return;
  }
  directorMode();
  document.getElementById('dirStat').textContent = `Shot ${D.shot+1}/${SHOTS.length} ...`;
  await SHOTS[D.shot]();
  D.shot++;
  endDirectorMode();
  document.getElementById('dirStat').textContent = D.shot < SHOTS.length
    ? `Waiting (Space) | ${D.frames} frames` : `✅ All ${SHOTS.length} done | ${D.frames} frames`;
};

window.dirRunAll = async function() {
  directorMode();
  for (let i = 0; i < SHOTS.length; i++) {
    D.shot = i;
    document.getElementById('dirStat').textContent = `🎬 Shot ${i+1}/${SHOTS.length} ...`;
    await SHOTS[i]();
    await pause(300);
  }
  D.shot = SHOTS.length;
  endDirectorMode();
  document.getElementById('dirStat').textContent = `✅ ${D.frames} frames in keyframes/ — run: npm run merge`;
  console.log(`✅ ${D.frames} frames captured. Run: npm run merge`);
};

window.addEventListener('keydown', e => {
  if (e.key === ' ' && !e.target.closest('input')) { e.preventDefault(); dirNext(); }
});

console.log('🎬 Animated Director ready.');
console.log('  dirNext()     — advance one shot (Space)');
console.log('  dirRunAll()   — run all shots');
console.log('  npm run merge — compile into MP4');

})();
