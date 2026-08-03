// film_animated.js — run in browser console with game loaded via npm run dev
// Captures in-engine cutscene footage frame-by-frame for smooth video.
// Press Space to advance shots, or run dirRunAll() for the full sequence.

(function() {

const C = document.getElementById('c');
const $ = window.__dbg;
if (!$) { console.error('window.__dbg not found — is the game loaded?'); return; }
const {
  renderer, camera, scene, game, player, settings,
  wxSet, applyEnvironment, buildBlob, cousinHands, spawnZombie,
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
// the camera's locked lens for the shot in progress — see setCam() below for why this has
// to be re-asserted every single frame, not just set once
let _lockedFov = 70;
const _tmpCamPos = new THREE.Vector3();

// ── Director mode: override pause menu so capture never gets interrupted ──
function directorMode() {
  const dbg = window.__dbg;
  if (!dbg) return;
  if (dbg.game && dbg.game.state !== 'playing') {
    try { dbg.startRun(); } catch(_) {}
  }
  if (dbg.bossState) {
    dbg.bossState._wasSpawned = dbg.bossState.spawned;
    dbg.bossState.spawned = true;
  }
  // Kill all existing zombies and stop spawner — no attackers during filming
  if (dbg.zombies) {
    for (let i = dbg.zombies.length - 1; i >= 0; i--) {
      try { dbg.killZombie(dbg.zombies[i], 0, 0, false); } catch(_) {}
    }
  }
  if (dbg.settings) {
    dbg._prevSpawn = dbg.settings.zombieSpawn;
    dbg.settings.zombieSpawn = 0;
  }
  _origEscape = window.onkeydown;
  const oldPause = dbg.pauseGame;
  dbg._oldPause = oldPause;
  dbg.pauseGame = function() {};
  const pauseBtn = document.getElementById('btnPause');
  if (pauseBtn) pauseBtn.style.display = 'none';
  if (dbg.game) dbg.game.state = 'playing';
  // Remove player entirely — no body, no chase target
  if (dbg.player) {
    dbg.player.dead = true;
    dbg.player.pos.set(9999, -50, 9999);
    if (dbg.playerBlob) {
      dbg._prevBlobVisible = dbg.playerBlob.root.visible;
      dbg.playerBlob.root.visible = false;
    }
  }
  hideCousins(true);
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
  if (dbg.player) {
    dbg.player.dead = false;
    if (dbg.playerBlob) dbg.playerBlob.root.visible = true;
  }
  hideCousins(false);
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
  // the baseline lens for this shot — NOT whatever camera.fov currently holds. window.__step()
  // runs the real game frame under the hood between captures (see setCam below), and that
  // includes updateCamera(), which is the live player's camera rig: it has no idea a director
  // is driving and no reason to stay out of the way. settings.fov is the one value that's
  // always the game's own clean, unzoomed default, so every shot starts from the same lens
  // no matter what the last shot (or a stray keypress) left sitting on the camera.
  _lockedFov = (settings && settings.fov) || 70;
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

// Point the camera for the frame about to be captured — and, just as importantly, undo
// whatever the last window.__step() did to it. updateCamera() (the real per-frame player
// rig) runs unconditionally every step; it has no concept of director mode. With the player
// parked at (9999,-50,9999) and marked dead, that rig reads the camera as buried a mile
// underground and fires the "ground-cam flare" meant for a live player's lens getting shoved
// into the dirt — FOV blown out by up to 24°, PLUS the projection matrix hand-stretched on
// top of that. The director's own position/lookAt reset already undid the position half of
// that corruption every loop; this locks the fov/matrix half the same way. And since the
// scene keeps breathing while a shot rolls (new crows fly in, old ones leave — see
// noFrustumCull below), this also re-sweeps the world for anything that showed up since the
// last frame, so nothing spawned mid-shot is ever left relying on real-world frustum culling
// against a camera that's off doing 100-unit director moves.
function setCam(pos, lookAt) {
  camera.position.copy(pos);
  camera.lookAt(lookAt);
  skyDome.position.copy(camera.position);
  cloudDome.position.copy(camera.position);
  camera.fov = _lockedFov;
  camera.updateProjectionMatrix(); // rebuilt from scratch every time — this is what actually
                                    // discards the flare's manually-poked matrix elements
  noFrustumCull();
}
// same idea for a shot that never moves the camera at all: pin position + orientation by
// QUATERNION (not lookAt — nothing to aim at once the camera's just holding still) so a held
// shot is exactly as immune to the live rig's per-frame meddling as a moving one.
function pinCam() {
  const pos = camera.position.clone(), quat = camera.quaternion.clone();
  return () => {
    camera.position.copy(pos);
    camera.quaternion.copy(quat);
    skyDome.position.copy(pos);
    cloudDome.position.copy(pos);
    camera.fov = _lockedFov;
    camera.updateProjectionMatrix();
    noFrustumCull();
  };
}

async function panShot(name, dur, camA, camB, lookAt) {
  beginCapture();
  const n = Math.max(1, Math.round(dur * D.FPS));
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(n - 1, 1);
    setCam(_tmpCamPos.lerpVectors(camA, camB, t), lookAt);
    snap(name + '_' + String(i).padStart(4, '0'));
    if (window.__step) window.__step(1, 1 / D.FPS);
    await new Promise(r => requestAnimationFrame(r));
  }
  endCapture();
  restoreCulling();
}

async function holdShot(name, dur) {
  beginCapture();
  const pin = pinCam();
  const n = Math.round(dur * D.FPS);
  for (let i = 0; i < n; i++) {
    pin();
    snap(name + '_' + String(i).padStart(4, '0'));
    if (window.__step) window.__step(1, 1 / D.FPS);
    await new Promise(r => requestAnimationFrame(r));
  }
  endCapture();
  restoreCulling();
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
function setClock(h) { game.clock = h; applyEnvironment(true); }
function setWeather(k) { wxSet(k); applyEnvironment(true); }
function setFog(near, far) { settings.fogFar = far; applyEnvironment(true); }
function v3(x,y,z) { return new THREE.Vector3(x,y,z); }

// capture-safe view: no part on screen may be frustum-chopped when the camera pulls high or
// tilts up (a director camera out-lives the game's own framing). This used to be a ONE-TIME
// snapshot taken when a shot began, which missed anything the world spawned mid-shot — most
// visibly the crow trickle-spawner, which flies fresh birds in and old ones out every few
// seconds all on its own. A crow born after the snapshot kept three.js's normal frustumCulled
// default and was left to the ordinary (camera-relative) cull test — accurate for the live
// player's camera, but a director shot routinely parks the camera 100 units out on a crane
// move, where a bird sitting near the top of frame reads as behind the frustum's near-vertical
// plane and blinks out mid-shot, then pops back once the spawner's next bird lands somewhere
// safer. setCam/pinCam now call this every captured frame instead of once, so anything new
// gets swept in before it can ever be judged by a cull test built for a different camera.
let _cullingOriginal = null, _cullingSeen = null;
function noFrustumCull() {
  if (!_cullingOriginal) { _cullingOriginal = []; _cullingSeen = new WeakSet(); }
  scene.traverse(o => {
    if (!o.isMesh || _cullingSeen.has(o)) return;
    _cullingSeen.add(o);
    _cullingOriginal.push([o, o.frustumCulled]);
    o.frustumCulled = false;
  });
}
function restoreCulling() {
  if (!_cullingOriginal) return;
  for (const [mesh, v] of _cullingOriginal) mesh.frustumCulled = v;
  _cullingOriginal = null; _cullingSeen = null;
}

function spawnCousin(id, x, z, rot) {
  const c = COUSINS.find(c => c.id === id);
  // the actual in-game cousin model: per-cousin hand skin tone + Blondie's lefty gun hand
  const blob = buildBlob({ color: c.color, gunHand: c.id === 'blondie' ? 'left' : 'right', hands: cousinHands(c.id) });
  const y = groundHeight(x, z);
  blob.root.position.set(x, y, z);
  blob.root.rotation.y = rot || 0;
  scene.add(blob.root); cleanup.push(blob.root);
  return blob;
}
// drive one cousin's in-game idle: breathing squash-and-stretch, body sway, head bob
// and arm/leg swing — the same motion the player's blob does when standing still.
// phase0 is random per cousin (so the six never bounce in sync) and t is the SHOT
// PROGRESS (0..1): every motion runs whole cycles over the shot (breathe 2x, the rest
// 1x of a 4π base swing), so the last frame lands EXACTLY on the first frame's pose
// and the idle loops seamless. The gaze stays locked forward — no body-yaw sway, so
// nobody's eyes drift off the fountain as the camera pans.
function idleCousin(blob, phase0, t) {
  const p = phase0 + t * Math.PI * 4;
  const b = blob;
  const wobble = Math.sin(p * 2.0) * 0.03;
  b.wob.scale.set(1 + wobble, 1 - wobble, 1 + wobble);
  b.wob.rotation.z = Math.sin(p) * 0.025;
  b.head.rotation.x = Math.sin(p) * 0.05;
  const swing = Math.sin(p) * 0.06;
  b.legs[0].rotation.x = swing;
  b.legs[1].rotation.x = -swing;
  b.arms[0].rotation.x = -swing * 0.8; b.arms[0].rotation.z = 0;
  b.arms[1].rotation.x = swing * 0.8; b.arms[1].rotation.z = 0;
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

const SHOTS = [

  // SHOT 1 — Low flyover with time progression: night → dawn → noon → sunset (18s)
  async function() {
    console.log('🎬 S1: The Block flyover');
    clearAll();
    maxSettings();
    // park the dead player off-world: updateHousePeek fades any building on the
    // camera→player sightline, and with the player at the look-at point (20,50) the
    // flyover's opening buildings peek-transparent. blob is hidden anyway.
    player.pos.set(9999, -50, 9999);
    setWeather('sunny');
    // single 18s continuous pan — clock changes midway, no gaps
    const dur = 18, n = Math.round(dur * D.FPS);
    const waypoints = [
      { t: 0.00, pos: v3(28, 30, 100), look: v3(20, 5, 50), clock: 23.5 },  // night
      { t: 0.22, pos: v3(20, 22, 70),  look: v3(20, 5, 50), clock: 6    },  // dawn
      { t: 0.50, pos: v3(15, 18, 40),  look: v3(15, 5, 30), clock: 13   },  // noon
      { t: 0.72, pos: v3(8, 14, 10),   look: v3(8, 4, 0),   clock: 18.5 },  // sunset
      { t: 1.00, pos: v3(2, 8, -20),   look: v3(0, 3, -30), clock: 18.5 },
    ];
    beginCapture();
    let lastClock = -1;
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(n - 1, 1);
      // find the two surrounding waypoints
      let lo = 0, hi = waypoints.length - 1;
      for (let w = 1; w < waypoints.length; w++) {
        if (t <= waypoints[w].t) { lo = w - 1; hi = w; break; }
      }
      const wt = (t - waypoints[lo].t) / (waypoints[hi].t - waypoints[lo].t || 1);
      const cp = waypoints[lo].pos.clone().lerp(waypoints[hi].pos, wt);
      const cl = waypoints[lo].look.clone().lerp(waypoints[hi].look, wt);
      setCam(cp, cl);
      // change clock at waypoint crossings
      const ck = waypoints[lo].clock;
      if (ck !== lastClock) { game.clock = ck; applyEnvironment(true); lastClock = ck; }
      snap('s01_flyover_' + String(i).padStart(4, '0'));
      if (window.__step) window.__step(1, 1 / D.FPS);
      await new Promise(r => requestAnimationFrame(r));
    }
    endCapture();
    restoreCulling();
    restoreSettings();
    console.log('  ✅ s01 flyover', n, 'frames');
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
    // each cousin idles on their own clock — a random start phase so their
    // bounces never line up; the shot spans whole cycles of every motion, so
    // the last frame lands back on the first (seamless loop, no gaze snap)
    const blobs = [], idle = [];
    for (let i = 0; i < 6; i++) {
      blobs.push(spawnCousin(ids[i], positions[i][0], positions[i][1], 0));
      idle.push(Math.random() * Math.PI * 2);
    }
    await pause(600);
    beginCapture();
    const dur = 10, n = Math.round(dur * D.FPS), dt = 1 / D.FPS;
    const camA = v3(-5, 3, -30), camB = v3(6, 2.5, -30), lookAt2 = v3(0, 1.5, -35);
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(n - 1, 1);
      setCam(_tmpCamPos.lerpVectors(camA, camB, t), lookAt2);
      for (let k = 0; k < blobs.length; k++) idleCousin(blobs[k], idle[k], t);
      snap('s02_' + String(i).padStart(4, '0'));
      if (window.__step) window.__step(1, dt);
      await new Promise(r => requestAnimationFrame(r));
    }
    endCapture();
    restoreCulling();
  },

  // SHOT 5 — Rotten One closeup (9s, storm + lightning)
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
      // blind guards: no target to home on, so they shuffle from bearing to
      // bearing like the street walkers — the shot gets a slow patrol, not a
      // mob converging on the parked player
      spawnZ(bx + Math.sin(a) * d, bz + Math.cos(a) * d, { green: true, rot: true, shield: true, blind: true });
    }
    await pause(300);
    await panShot('s05', 6, v3(bx + 10, 5, bz + 8), v3(bx, 4, bz + 6), v3(bx, 3, bz)); // orbit to head-on
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
