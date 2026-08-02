// film_storyboard.js — run in browser console with game loaded
// Directs and captures the BLINGO advertisement cutscene in-engine.
// Each shot auto-captures; press Space to advance to next shot.
// Captures always at 1920×1080 regardless of viewport size.

(function() {

// ── Director state ──
const D = {
  shot: 0,
  captures: [],
  fps: 30,
  recording: false,
  recordFrames: [],
  recordTimer: 0,
  CAP_W: 1920,  // capture resolution
  CAP_H: 1080,
};

// ── Grab game internals from the dev toolbox ──
const $ = window.__dbg;
if (!$) { console.error('window.__dbg not found — is the game loaded?'); throw new Error('Missing __dbg'); }
const {
  renderer, camera, scene, game, player, settings,
  wxSet, applyEnvironment, COUSINS, buildBlob, spawnZombie,
  skyDome, cloudDome, hemi, sunLight, addRotGore,
  groundHeight, bossState, zombies,
} = $;
// verify critical refs loaded
const _missing = [];
if (!COUSINS) _missing.push('COUSINS');
if (!buildBlob) _missing.push('buildBlob');
if (!spawnZombie) _missing.push('spawnZombie');
if (!wxSet) _missing.push('wxSet');
if (!skyDome) _missing.push('skyDome');
if (_missing.length) {
  console.error('❌ Missing __dbg props:', _missing.join(', '));
  console.log('Available keys:', Object.keys($).sort().join(', '));
  throw new Error('Missing game refs — run git pull and hard-refresh (Ctrl+Shift+R)');
}
console.log('✅ Director ready —', Object.keys($).length, 'refs loaded');

const C = document.getElementById('c');
let _origW, _origH;

// force the renderer to HD for capture, then save to disk (or download as fallback)
const SAVE_URL = 'http://localhost:3000/save';
let _saveQueue = Promise.resolve();

function snapHD(name) {
  _origW = C.width; _origH = C.height;
  noFrustumCull();
  renderer.setSize(D.CAP_W, D.CAP_H);
  camera.aspect = D.CAP_W / D.CAP_H;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const dataUrl = C.toDataURL('image/png');
  restoreCulling();
  // restore viewport size
  renderer.setSize(_origW, _origH);
  camera.aspect = _origW / _origH;
  camera.updateProjectionMatrix();
  // try saving to local dev server first, fall back to download
  D.captures.push(name);
  _saveQueue = _saveQueue.then(() =>
    fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data: dataUrl }),
    }).then(r => r.json()).then(j => {
      console.log('💾', name + '.png', j.file ? '→ keyframes/' : '⚠');
    }).catch(() => {
      // server not running — fall back to browser download
      const a = document.createElement('a');
      a.download = name + '.png';
      a.href = dataUrl;
      a.click();
      console.log('⬇', name + '.png (download)');
    })
  );
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

// capture-safe view: no part on screen may be frustum-chopped when the camera
// pulls high or tilts up (a director camera out-lives the game's own framing).
let _cullingOriginal = null;
function noFrustumCull() {
  if (!_cullingOriginal) {
    _cullingOriginal = [];
    scene.traverse(o => { if (o.isMesh) { _cullingOriginal.push([o, o.frustumCulled]); o.frustumCulled = false; } });
  }
}
function restoreCulling() {
  if (!_cullingOriginal) return;
  for (const [mesh, v] of _cullingOriginal) mesh.frustumCulled = v;
  _cullingOriginal = null;
}

function cam(x, y, z, lx, ly, lz) {
  camera.position.set(x, y, z);
  camera.lookAt(lx || 0, ly || 1, lz || 0);
  skyDome.position.copy(camera.position);
  cloudDome.position.copy(camera.position);
}

function setClock(h) { game.clock = h; applyEnvironment(true); }
function setWeather(k) { wxSet(k); applyEnvironment(true); }
function setFog(near, far) { settings.fogFar = far; applyEnvironment(true); }

let cleanup = [];

// the run's live cousins each carry a 120-unit beacon shaft; the director's own
// spawns don't. Hide the WHOLE live cousins (blob + shadow + beacon) plus the
// player's own blob and down-marker so only the director's dummies are in frame —
// a real cousin standing at his home (blingo's is the Rotten One arena!) would
// otherwise get swarmed by the director's zombies mid-shot.
function hideCousins(off = true) {
  for (const c of $.companions || []) {
    if (c.blob) {
      if (c.blob.root) c.blob.root.visible = !off;
      if (c.blob.shadow) c.blob.shadow.visible = !off;
    }
    if (c.beacon) c.beacon.visible = !off;
  }
  const pb = $.playerBlob;
  if (pb) {
    if (pb.root) pb.root.visible = !off;
    if (pb.shadow) pb.shadow.visible = !off;
  }
  if ($.player && $.player.beacon) $.player.beacon.visible = !off;
  if ($.jelly && $.jelly.beacon) $.jelly.beacon.visible = !off;
  if ($.bossState) {
    for (const k of ['guardBeacons', 'beacons']) {
      const arr = $.bossState[k];
      if (Array.isArray(arr)) for (const m of arr) if (m) m.visible = !off;
    }
  }
}

function spawnCousin(id, x, z, rot = 0) {
  const c = COUSINS.find(c => c.id === id);
  const blob = buildBlob({ color: c.color, scale: 1 });
  blob.root.position.set(x, groundHeight(x, z), z);
  blob.root.rotation.y = rot;
  scene.add(blob.root);
  cleanup.push(blob.root);
  return blob;
}

function spawnZ(x, z, opts = {}) {
  const idx = spawnZombie(x, z, 1, opts);
  if (idx != null) cleanup.push(idx);
  return idx;
}

function spawnBoss4() {
  bossState.spawned4 = true;
  const bx = 132, bz = -36;
  const scale = 3.1;
  const blob = buildBlob({ color: 0x77a12c, zombie: true, scale, hands: 0x3f5a14 });
  addRotGore(blob, { hangEye: true, chestHole: true });
  blob.root.position.set(bx, groundHeight(bx, bz), bz);
  scene.add(blob.root);
  cleanup.push(blob.root);
  return blob.root;
}

function clearAll() {
  for (const o of cleanup) {
    if (o.parent) o.parent.remove(o);
    if (o.isZombie && zombies.includes(o)) {
      const i = zombies.indexOf(o);
      if (i >= 0) zombies.splice(i, 1);
    }
  }
  cleanup = [];
}

// ── SHOT DEFINITIONS ──
const SHOTS = [

  // SHOT 1 — The Block (establishing)
  async function shot1() {
    console.log('🎬 SHOT 1: The Block');
    setClock(18.5); setWeather('sunny'); setFog(30, 110);
    clearAll();
    // aerial pull-back
    player.pos.x = 20; player.pos.z = 50;
    cam(20, 35, 90, 20, 5, 50);
    await pause(500); snapHD('shot01_establishing');
    cam(20, 50, 110, 20, 5, 50);
    await pause(300); snapHD('shot01_wide');
    cam(20, 70, 130, 20, 5, 50);
    await pause(300); snapHD('shot01_pullback');
  },

  // SHOT 2 — Cousins Assemble (wideshot then individual portraits)
  async function shot2() {
    console.log('🎬 SHOT 2: Cousins Assemble');
    setClock(18); setWeather('sunny'); setFog(30, 105);
    clearAll();
    player.pos.x = 0; player.pos.z = -37;
    // spawn all 6 on bank steps
    const ids = ['blingo', 'blazo', 'blizzy', 'blomba', 'bloopy', 'blondie'];
    const pos = [
      [-3, -35], [-1.2, -35], [0.6, -35], [2.4, -35], [-2.1, -33], [1.5, -33]
    ];
    for (let i = 0; i < 6; i++) {
      spawnCousin(ids[i], pos[i][0], pos[i][1], Math.PI / 2 + (i - 2.5) * 0.04);
    }
    await pause(300);
    // group shot
    cam(0, 3, -30, 0, 1.5, -35);
    await pause(400); snapHD('shot02_group');
    // individual portraits
    for (let i = 0; i < 6; i++) {
      const p = pos[i];
      cam(p[0], 2 + Math.random() * 0.5, p[1] + 4, p[0], 1, p[1]);
      await pause(200); snapHD('shot02_' + ids[i]);
    }
  },

  // SHOT 3 — Melee Montage
  async function shot3() {
    console.log('🎬 SHOT 3: Melee Montage');
    setClock(19); setWeather('cloudy'); setFog(28, 95);
    clearAll();
    const meleeShots = [
      { id: 'blingo', x: 2, z: -30, swing: 'bat' },
      { id: 'blazo', x: 5, z: -28, swing: 'axe' },
      { id: 'blizzy', x: 8, z: -32, swing: 'katana' },
      { id: 'blomba', x: -2, z: -25, swing: 'sledge' },
      { id: 'bloopy', x: -5, z: -28, swing: 'pipe' },
      { id: 'blondie', x: -8, z: -33, swing: 'machete' },
    ];
    for (const s of meleeShots) {
      clearAll();
      const c = spawnCousin(s.id, s.x, s.z, 0);
      // spawn 2 zombies nearby
      spawnZ(s.x + 1.5, s.z + 2, {});
      spawnZ(s.x - 1, s.z + 2.5, { droopy: true });
      player.pos.x = s.x; player.pos.z = s.z;
      // swing pose: set melee arm
      if (s.id === 'blazo') {
        c.head.rotation.x = -0.3; // leaping chop angle
      }
      // position arm outward for impact
      const arm = c.armR || c.children.find(ch => ch.name === 'armR');
      if (arm) arm.rotation.z = -1.2; // swing position
      await pause(200);
      // capture from different angles
      cam(s.x + 4, 2, s.z + 5, s.x, 1.2, s.z + 1);
      await pause(150); snapHD('shot03_melee_' + s.id);
      cam(s.x - 2, 1.8, s.z + 6, s.x, 1, s.z + 1);
      await pause(150); snapHD('shot03_melee_' + s.id + '_b');
    }
  },

  // SHOT 4 — Gunfight
  async function shot4() {
    console.log('🎬 SHOT 4: Gunfight');
    setClock(20); setWeather('cloudy'); setFog(25, 85);
    clearAll();
    // group gunfight on the main street
    const ids = ['blingo', 'blazo', 'blizzy', 'blomba', 'bloopy', 'blondie'];
    for (let i = 0; i < 6; i++) {
      spawnCousin(ids[i], i * 2 - 5, -42 - (i % 2) * 2, Math.PI / 2);
    }
    // horde of zombies approaching
    for (let i = 0; i < 12; i++) {
      spawnZ(-2 + i * 1.2, -28 + Math.random() * 3, {});
    }
    player.pos.x = 0; player.pos.z = -42;
    // wide shot
    cam(0, 4, -25, 0, 1.5, -40);
    await pause(400); snapHD('shot04_gunfight_wide');
    // close on Blazo shotgun
    cam(6, 2.5, -27, 5, 1.2, -40);
    await pause(200); snapHD('shot04_blazo_shotgun');
    // close on Blondie sniper (from above/behind)
    cam(12, 4, -38, 10, 1.2, -42);
    await pause(200); snapHD('shot04_blondie_sniper');
    // muzzle flash alley scene (dark, close)
    cam(-3, 2, -26, -3, 1, -40);
    await pause(200); snapHD('shot04_alley');
  },

  // SHOT 5 — The Rotten One Spawns (rain, night, lightning)
  async function shot5() {
    console.log('🎬 SHOT 5: Rotten One Spawns');
    setClock(23); setWeather('rain'); setFog(18, 65);
    clearAll();
    player.pos.x = 132; player.pos.z = -36;
    // spawn Rotten One
    const boss = spawnBoss4();
    // spawn rotting minions around him
    for (let i = 0; i < 8; i++) {
      const ang = Math.random() * Math.PI * 2, d = 4 + Math.random() * 4;
      spawnZ(132 + Math.sin(ang) * d, -36 + Math.cos(ang) * d, { green: true, rot: true, shield: true });
    }
    await pause(500);
    // wide establishing: boss + beam
    cam(138, 6, -28, 132, 2, -36);
    await pause(400); snapHD('shot05_rotten_spawn');
    // closeup: chest heart
    cam(131, 3.5, -37, 132, 2.5, -36);
    await pause(300); snapHD('shot05_heart_closeup');
    // low angle hero shot
    cam(129, 1.5, -40, 132, 3.5, -36);
    await pause(300); snapHD('shot05_hero_low');
    // lightning flash: boost hemisphere light briefly
    hemi.intensity *= 2.2; sunLight.intensity *= 1.8;
    await pause(100); snapHD('shot05_lightning');
    hemi.intensity /= 2.2; sunLight.intensity /= 1.8;
  },

  // SHOT 6 — Family Fights Back
  async function shot6() {
    console.log('🎬 SHOT 6: Family Fights Back');
    setClock(23.2); setWeather('rain'); setFog(18, 65);
    clearAll();
    // boss
    const boss = spawnBoss4();
    // minions
    for (let i = 0; i < 6; i++) {
      const ang = Math.random() * Math.PI * 2, d = 3 + Math.random() * 3;
      spawnZ(132 + Math.sin(ang) * d, -36 + Math.cos(ang) * d, { green: true, rot: true });
    }
    // all cousins charging from the park edge
    const ids = ['blingo', 'blazo', 'blizzy', 'blomba', 'bloopy', 'blondie'];
    for (let i = 0; i < 6; i++) {
      spawnCousin(ids[i], 127 + (i - 2.5) * 1.5, -30, -Math.PI / 6);
    }
    player.pos.x = 132; player.pos.z = -36;
    // wide group charge
    cam(130, 5, -24, 132, 2, -36);
    await pause(400); snapHD('shot06_charge');
    // Blomba hammer strike (close on boss)
    cam(131, 3, -35, 132, 2.5, -36);
    await pause(200); snapHD('shot06_blomba_strike');
    // Blizzy slicing minions
    cam(127, 2.5, -33, 128, 1.2, -32);
    await pause(200); snapHD('shot06_blizzy_slice');
    // full group in action, rain pouring
    cam(125, 6, -28, 132, 2, -36);
    await pause(300); snapHD('shot06_wide_rain');
  },

  // SHOT 7 — Bluga at Grandma's
  async function shot7() {
    console.log('🎬 SHOT 7: Bluga at Grandma\'s');
    setClock(23.5); setWeather('rain'); setFog(20, 70);
    clearAll();
    player.pos.x = 124; player.pos.z = 182;
    // spawn Bluga
    const bluga = buildBlob({ color: 0x141519, scale: 1, hands: 0x141519 });
    bluga.head.material.color.set(0x141519);
    bluga.root.position.set(124, groundHeight(124, 182) + 0.3, 182);
    bluga.root.rotation.y = Math.PI;
    scene.add(bluga.root);
    cleanup.push(bluga.root);
    // FBI guards
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2, d = 5;
      const g = buildBlob({ color: 0x141519, scale: 0.8 });
      g.root.position.set(124 + Math.sin(ang) * d, groundHeight(124 + Math.sin(ang) * d, 182 + Math.cos(ang) * d), 182 + Math.cos(ang) * d);
      scene.add(g.root);
      cleanup.push(g.root);
    }
    await pause(400);
    // reveal shot
    cam(124, 3, 188, 124, 1.5, 182);
    await pause(400); snapHD('shot07_bluga_reveal');
    // closeup: jelly jar crush
    cam(123.5, 2.2, 183, 124, 1.5, 182);
    await pause(300); snapHD('shot07_jar_crush');
    // low angle, cold blue beam
    cam(122, 1.5, 185, 124, 2, 182);
    await pause(300); snapHD('shot07_cold_beam');
  },

  // SHOT 8 — Title Card (skip — handled in editing)

  // SHOT 9 — End Card (skip — handled in editing)

];

// ── Director UI ──
const ui = document.createElement('div');
ui.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:999;background:rgba(0,0,0,.85);color:#fff;padding:10px 20px;border-radius:10px;font:13px monospace;display:flex;gap:12px;align-items:center;pointer-events:auto;';
ui.innerHTML = '<b>🎬 DIRECTOR</b> <span id="dirShot">Ready</span>';
document.body.appendChild(ui);

window.dirNext = async function() {
  if (D.shot >= SHOTS.length) {
    document.getElementById('dirShot').textContent = '✅ ALL SHOTS DONE';
    console.log('✅ Storyboard complete. ' + D.captures.length + ' captures taken.');
    hideCousins(false);
    return;
  }
  document.getElementById('dirShot').textContent = 'Shot ' + (D.shot + 1) + '/' + SHOTS.length;
  hideCousins(true);
  await SHOTS[D.shot]();
  D.shot++;
  document.getElementById('dirShot').textContent = D.shot >= SHOTS.length ? '✅ Done' : 'Waiting (Space for next)';
};

window.dirRunAll = async function() {
  hideCousins(true);
  for (let i = 0; i < SHOTS.length; i++) {
    D.shot = i;
    document.getElementById('dirShot').textContent = 'Shot ' + (i + 1) + '/' + SHOTS.length;
    await SHOTS[i]();
    await pause(600);
  }
  D.shot = SHOTS.length;
  hideCousins(false);
  document.getElementById('dirShot').textContent = '✅ ALL ' + SHOTS.length + ' SHOTS DONE';
  console.log('✅ Storyboard complete.');
};

// keyboard: Space to advance
window.addEventListener('keydown', e => {
  if (e.key === ' ' && !e.target.closest('input')) {
    e.preventDefault();
    dirNext();
  }
});

console.log('🎬 Director ready.');
console.log('  dirNext()     — advance one shot (or press Space)');
console.log('  dirRunAll()   — run all shots automatically');
console.log('  clearAll()    — clear scene');
console.log('  snapHD("name")  — manual capture');
console.log('');
console.log('Press Space to begin.');

})();
