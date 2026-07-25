// film_animated.js — run in browser console with game loaded via npm run dev
// Captures in-engine cutscene footage frame-by-frame for smooth video.
// Each shot animates characters/camera, saves every frame to cutscene/keyframes/
// Press Space to advance shots, or run dirRunAll() for the full sequence.

(function() {

const C = document.getElementById('c');
const $ = window.__dbg;
if (!$) { console.error('window.__dbg not found — is the game loaded?'); return; }
const {
  renderer, camera, scene, game, player, settings,
  wxSet, applyEnvironment, buildBlob, spawnZombie,
  skyDome, cloudDome, hemi, moon, addRotGore,
  groundHeight, bossState, zombies, THREE,
} = $;

// Hardcoded fallback — the script NEVER depends on __dbg for data
const COUSINS = [
  { id: 'blingo',  color: 0xff8c42, weapon: 'bat'     },
  { id: 'blazo',   color: 0xff4f42, weapon: 'shotgun'  },
  { id: 'blizzy',  color: 0x6fd8ff, weapon: 'katana'   },
  { id: 'blomba',  color: 0xb06fff, weapon: 'sledge'   },
  { id: 'bloopy',  color: 0x3fd8b0, weapon: 'pistol'   },
  { id: 'blondie', color: 0xffd84a, weapon: 'sniper'   },
];

const D = { shot: 0, frames: 0, CAP_W: 1920, CAP_H: 1080, FPS: 30 };
const SAVE = 'http://localhost:3000/save';
let _saveQ = Promise.resolve(), _origW, _origH, cleanup = [];

// ── capture one HD frame and POST to local server ──
function snap(name) {
  _origW = C.width; _origH = C.height;
  renderer.setSize(D.CAP_W, D.CAP_H);
  camera.aspect = D.CAP_W / D.CAP_H;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const dataUrl = C.toDataURL('image/png');
  renderer.setSize(_origW, _origH);
  camera.aspect = _origW / _origH;
  camera.updateProjectionMatrix();
  D.frames++;
  _saveQ = _saveQ.then(() =>
    fetch(SAVE, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, data: dataUrl }) })
    .then(r => r.json()).catch(() => {})
  );
}

// ── capture N frames over duration seconds, moving camera from A to B ──
async function panShot(name, dur, camA, camB, lookAt) {
  const n = Math.round(dur * D.FPS);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1 || 1);
    camera.position.lerpVectors(camA, camB, t);
    camera.lookAt(lookAt);
    skyDome.position.copy(camera.position);
    cloudDome.position.copy(camera.position);
    const sn = name + '_' + String(i).padStart(4, '0');
    snap(sn);
    if (window.__step) window.__step(1, 1 / D.FPS);
    await new Promise(r => requestAnimationFrame(r));
  }
}

// ── hold a still frame for dur seconds ──
async function holdShot(name, dur) {
  const n = Math.round(dur * D.FPS);
  for (let i = 0; i < n; i++) {
    const sn = name + '_' + String(i).padStart(4, '0');
    snap(sn);
    if (window.__step) window.__step(1, 1 / D.FPS);
    await new Promise(r => requestAnimationFrame(r));
  }
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
function setClock(h) { game.clock = h; applyEnvironment(true); }
function setWeather(k) { wxSet(k); applyEnvironment(true); }
function setFog(near, far) { settings.fogFar = far; applyEnvironment(true); }

function vec3(x, y, z) { return new THREE.Vector3(x, y, z); }

function spawnCousin(id, x, z, rot) {
  const c = COUSINS.find(c => c.id === id);
  const blob = buildBlob({ color: c.color, scale: 1 });
  blob.root.position.set(x, groundHeight(x, z), z);
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

// ═══════════════════════════════════════════════════════════════
// SHOT SEQUENCES — each returns a promise that captures frames
// ═══════════════════════════════════════════════════════════════

const SHOTS = [

  // SHOT 1 — Aerial block pull-back (6s)
  async function() {
    console.log('🎬 SHOT 1: The Block');
    setClock(18.5); setWeather('sunny'); setFog(30, 110);
    clearAll();
    player.pos.set(20, groundHeight(20, 50), 50);
    const camA = vec3(20, 35, 90), camB = vec3(20, 75, 140);
    const look = vec3(20, 5, 50);
    await panShot('s01', 6, camA, camB, look);
  },

  // SHOT 2 — Cousins on bank steps (8s: slow pan across lineup)
  async function() {
    console.log('🎬 SHOT 2: Cousins Assemble');
    setClock(18); setWeather('sunny'); setFog(30, 105);
    clearAll();
    player.pos.set(0, groundHeight(0, -37), -37);
    const ids = COUSINS.map(c => c.id);
    const positions = [[-3,-35],[-1.2,-35],[0.6,-35],[2.4,-35],[-2.1,-33],[1.5,-33]];
    for (let i = 0; i < 6; i++) spawnCousin(ids[i], positions[i][0], positions[i][1], 1.6 + i * 0.03);
    await pause(500);
    // slow pan across the lineup
    const camA = vec3(-5, 2.5, -30), camB = vec3(5, 2.2, -30);
    const look = vec3(0, 1.5, -35);
    await panShot('s02', 8, camA, camB, look);
  },

  // SHOT 3 — Melee combat (10s: rapid cuts with zombies)
  async function() {
    console.log('🎬 SHOT 3: Melee Montage');
    setClock(19); setWeather('cloudy'); setFog(28, 95);
    const cuts = [
      { id: 'blingo',  x: 2, z: -32, cx: 7, cz: -28, look: vec3(2, 1, -30) },
      { id: 'blazo',   x: 5, z: -30, cx: 10, cz: -26, look: vec3(5, 1, -28) },
      { id: 'blizzy',  x: 0, z: -28, cx: -4, cz: -24, look: vec3(0, 1, -28) },
      { id: 'blomba',  x: -3, z: -34, cx: -8, cz: -30, look: vec3(-3, 1, -32) },
      { id: 'bloopy',  x: 7, z: -35, cx: 12, cz: -30, look: vec3(7, 1, -33) },
      { id: 'blondie', x: -6, z: -36, cx: -11, cz: -32, look: vec3(-6, 1, -34) },
    ];
    for (const cut of cuts) {
      clearAll();
      spawnCousin(cut.id, cut.x, cut.z, 0);
      spawnZ(cut.x + 1.5, cut.z + 2.5, {});
      spawnZ(cut.x - 1.2, cut.z + 2, { droopy: true });
      player.pos.set(cut.x, groundHeight(cut.x, cut.z), cut.z);
      const camA = vec3(cut.cx, 2.5, cut.cz);
      const dur = 1.4 + Math.random() * 0.4;
      await panShot('s03_' + cut.id, dur, camA, camA, cut.look);
    }
  },

  // SHOT 4 — Gunfight (10s)
  async function() {
    console.log('🎬 SHOT 4: Gunfight');
    setClock(20); setWeather('cloudy'); setFog(25, 85);
    clearAll();
    for (let i = 0; i < 6; i++) spawnCousin(COUSINS[i].id, i * 2 - 5, -42, 1.57);
    for (let i = 0; i < 12; i++) spawnZ(-2 + i * 1.2, -28 + Math.random() * 3, {});
    player.pos.set(0, groundHeight(0, -42), -42);

    // wide pan
    const camA1 = vec3(-6, 3, -26), camB1 = vec3(6, 4, -26);
    await panShot('s04_wide', 5, camA1, camB1, vec3(0, 1.5, -40));

    // tight on Blazo shotgun
    const camA2 = vec3(6, 2.5, -28);
    await panShot('s04_blazo', 2.5, camA2, camA2, vec3(5, 1.2, -40));

    // tight on Blondie scope
    const camA3 = vec3(12, 4, -38);
    await panShot('s04_blondie', 2.5, camA3, camA3, vec3(10, 1.2, -42));
  },

  // SHOT 5 — Rotten One spawns (8s, rain + lightning)
  async function() {
    console.log('🎬 SHOT 5: Rotten One');
    setClock(23); setWeather('rain'); setFog(18, 65);
    clearAll();
    const bx = 132, bz = -36;
    player.pos.set(bx, groundHeight(bx, bz), bz);
    bossState.spawned4 = true;
    const boss = buildBlob({ color: 0x77a12c, zombie: true, scale: 3.1, hands: 0x3f5a14 });
    if (addRotGore) addRotGore(boss, { hangEye: true, chestHole: true });
    boss.root.position.set(bx, groundHeight(bx, bz), bz);
    scene.add(boss.root); cleanup.push(boss.root);
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2, d = 4 + Math.random() * 4;
      spawnZ(bx + Math.sin(a) * d, bz + Math.cos(a) * d, { green: true, rot: true, shield: true });
    }
    await pause(300);

    // slow orbit around the boss
    const camA = vec3(138, 5, -28), camB = vec3(127, 4, -40);
    await panShot('s05_orbit', 5, camA, camB, vec3(bx, 2.5, bz));

    // close on heart, then pull back
    const camC = vec3(131, 3, -37);
    await panShot('s05_heart', 3, camC, camC, vec3(bx, 2.5, bz));
  },

  // SHOT 6 — Family fights Rotten One (8s)
  async function() {
    console.log('🎬 SHOT 6: Family Charge');
    setClock(23.2); setWeather('rain'); setFog(18, 65);
    clearAll();
    const bx = 132, bz = -36;
    const boss = buildBlob({ color: 0x77a12c, zombie: true, scale: 3.1, hands: 0x3f5a14 });
    if (addRotGore) addRotGore(boss, { hangEye: true, chestHole: true });
    boss.root.position.set(bx, groundHeight(bx, bz), bz);
    scene.add(boss.root); cleanup.push(boss.root);
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, d = 3 + Math.random() * 3;
      spawnZ(bx + Math.sin(a) * d, bz + Math.cos(a) * d, { green: true, rot: true });
    }
    for (let i = 0; i < 6; i++) spawnCousin(COUSINS[i].id, 127 + i * 1.5 - 3.5, -30, -0.5);
    player.pos.set(bx, groundHeight(bx, bz), bz);

    const camA = vec3(130, 6, -24), camB = vec3(125, 6, -30);
    await panShot('s06_charge', 8, camA, camB, vec3(bx, 2, bz));
  },

  // SHOT 7 — Bluga at Jelly House (6s)
  async function() {
    console.log('🎬 SHOT 7: Bluga');
    setClock(23.5); setWeather('rain'); setFog(20, 70);
    clearAll();
    player.pos.set(124, groundHeight(124, 182), 182);
    const bluga = buildBlob({ color: 0x141519, scale: 1, hands: 0x141519 });
    bluga.head.material.color.set(0x141519);
    bluga.root.position.set(124, groundHeight(124, 182) + 0.3, 182);
    bluga.root.rotation.y = Math.PI;
    scene.add(bluga.root); cleanup.push(bluga.root);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2, d = 5;
      const g = buildBlob({ color: 0x141519, scale: 0.8 });
      g.root.position.set(124 + Math.sin(a) * d, groundHeight(124 + Math.sin(a) * d, 182 + Math.cos(a) * d), 182 + Math.cos(a) * d);
      scene.add(g.root); cleanup.push(g.root);
    }
    await pause(300);

    const camA = vec3(128, 3, 188), camB = vec3(122, 2, 184);
    await panShot('s07_reveal', 6, camA, camB, vec3(124, 1.5, 182));
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
console.log(`  Frames save to: ${SAVE}`);
console.log('  npm run merge — compile into MP4');

})();
