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
    // Night — start high behind the church, looking south toward the sleeping town
    setClock(23.5); setWeather('sunny'); applyEnvironment(true);
    await pause(300);
    await panShot('s01a_night', 4, v3(28, 30, 100), v3(20, 22, 70), v3(20, 5, 50));
    // Dawn — fly over the graveyard toward the plaza
    setClock(6); applyEnvironment(true);
    await panShot('s01b_dawn', 4, v3(20, 24, 70), v3(15, 18, 40), v3(10, 5, 30));
    // Noon — descend across the plaza toward the bank
    setClock(13); applyEnvironment(true);
    await panShot('s01c_noon', 4, v3(15, 20, 40), v3(8, 14, 10), v3(5, 4, 0));
    // Sunset — slow pan down to the bank steps, sun low behind camera
    setClock(18.5); applyEnvironment(true);
    await panShot('s01d_sunset', 6, v3(8, 16, 10), v3(2, 8, -20), v3(0, 3, -30));
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

  // SHOT 3 — Melee combat closeups (12s)
  async function() {
    console.log('🎬 S3: Melee Montage');
    setClock(19); setWeather('cloudy'); setFog(28, 95);
    const cuts = [
      { id: 'blingo',  x: 4, z: -30 },
      { id: 'blazo',   x: 8, z: -28 },
      { id: 'blizzy',  x: 2, z: -26 },
      { id: 'blomba',  x: -2, z: -32 },
      { id: 'bloopy',  x: 10, z: -32 },
      { id: 'blondie', x: -5, z: -34 },
    ];
    for (const cut of cuts) {
      clearAll();
      spawnCousin(cut.id, cut.x, cut.z, 0);
      spawnZ(cut.x + 2, cut.z + 3, {});
      spawnZ(cut.x - 1.5, cut.z + 2.5, { droopy: true });
      player.pos.set(cut.x, groundHeight(cut.x, cut.z), cut.z);
      const cx = cut.x + (cut.x > 0 ? 5 : -5);
      const cz = cut.z + 4;
      const look = v3(cut.x, 1, cut.z + 1);
      await panShot('s03_' + cut.id, 2, v3(cx, 2.5, cz), v3(cx, 2.3, cz), look);
    }
  },

  // SHOT 4 — Gunfight on main street (10s)
  async function() {
    console.log('🎬 S4: Gunfight');
    setClock(20); setWeather('cloudy'); setFog(25, 85);
    clearAll();
    for (let i = 0; i < 6; i++) spawnCousin(COUSINS[i].id, i * 2.5 - 6, -44, Math.PI / 2);
    for (let i = 0; i < 15; i++) spawnZ(-4 + i * 1.3, -30 + Math.random() * 4, {});
    player.pos.set(0, groundHeight(0, -44), -44);
    await panShot('s04_wide', 5, v3(-7, 3.5, -26), v3(7, 4, -26), v3(0, 1.5, -42));
    const cx = 6, cz = -28;
    await panShot('s04_blazo', 2.5, v3(cx, 2.5, cz), v3(cx, 2.5, cz), v3(5, 1.2, -40));
    const cx2 = -7, cz2 = -36;
    await panShot('s04_blondie', 2.5, v3(cx2, 4, cz2), v3(cx2, 4, cz2), v3(-5, 1.2, -42));
  },

  // SHOT 5 — Rotten One closeup (10s, storm + lightning)
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
    // wide orbit
    await panShot('s05_orbit', 5, v3(138, 5, -28), v3(127, 4, -40), v3(bx, 3, bz));
    // close on exposed chest + dangling eye
    await panShot('s05_close', 4, v3(bx + 1.5, 4, bz - 2), v3(bx - 1, 3.5, bz - 1.5), v3(bx, 3, bz));
  },

  // SHOT 6 — Family charges the Rotten One (10s)
  async function() {
    console.log('🎬 S6: Family Charge');
    setClock(23.2); setWeather('rain'); setFog(18, 65);
    clearAll();
    const bx = 132, bz = -36, gy = groundHeight(bx, bz);
    const boss = buildBlob({ color: 0x77a12c, zombie: true, scale: 3.1, hands: 0x3f5a14 });
    if (addRotGore) addRotGore(boss, { hangEye: true, chestHole: true });
    boss.root.position.set(bx, gy, bz);
    scene.add(boss.root); cleanup.push(boss.root);
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, d = 4 + Math.random() * 3;
      spawnZ(bx + Math.sin(a) * d, bz + Math.cos(a) * d, { green: true, rot: true });
    }
    // cousins charge from the park edge
    for (let i = 0; i < 6; i++) spawnCousin(COUSINS[i].id, 126 + i * 1.5, -30, -0.4);
    player.pos.set(bx, gy, bz);
    await panShot('s06_charge', 10, v3(130, 7, -22), v3(124, 6, -32), v3(bx, 2.5, bz));
  },

  // SHOT 7 — Bluga at Jelly House (8s, cold night)
  async function() {
    console.log('🎬 S7: Bluga');
    setClock(23.5); setWeather('rain'); setFog(20, 70);
    clearAll();
    const jx = 124, jz = 182, jy = groundHeight(jx, jz);
    player.pos.set(jx, jy, jz);
    const bluga = buildBlob({ color: 0x141519, scale: 1, hands: 0x141519 });
    bluga.root.position.set(jx, jy + 0.3, jz);
    bluga.root.rotation.y = Math.PI;
    scene.add(bluga.root); cleanup.push(bluga.root);
    // guards in a semi-circle in front
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI/2 + (i * Math.PI / 5);
      const d = 6;
      const gx = jx + Math.cos(a) * d, gz = jz + Math.sin(a) * d;
      const g = buildBlob({ color: 0x141519, scale: 0.8 });
      g.root.position.set(gx, groundHeight(gx, gz), gz);
      scene.add(g.root); cleanup.push(g.root);
    }
    await pause(400);
    await panShot('s07_reveal', 8, v3(jx + 8, 2.5, jz + 6), v3(jx - 4, 2, jz + 4), v3(jx, 1.5, jz));
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
  document.getElementById('dirStat').textContent = `Shot ${D.shot+1}/${SHOTS.length} ...`;
  await SHOTS[D.shot]();
  D.shot++;
  document.getElementById('dirStat').textContent = D.shot < SHOTS.length
    ? `Waiting (Space) | ${D.frames} frames` : `✅ All ${SHOTS.length} done | ${D.frames} frames`;
};

window.dirRunAll = async function() {
  for (let i = 0; i < SHOTS.length; i++) {
    D.shot = i;
    document.getElementById('dirStat').textContent = `🎬 Shot ${i+1}/${SHOTS.length} ...`;
    await SHOTS[i]();
    await pause(300);
  }
  D.shot = SHOTS.length;
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
