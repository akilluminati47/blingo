/* BLINGO — Copyright (c) 2026 akilluminati47 (AK & Co.). All rights reserved.
 * Original work; see LICENSE. https://blingo.pages.dev */
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
// placeholder until applyEnvironment takes over: it drives fog off the draw-distance
// setting every frame (far end always inside the chunk stream radius — see syncDerived)
scene.fog = new THREE.Fog(SKY, 29, 108);

// the far plane runs way past the fog so the fog-exempt landmarks — the town skyline
// silhouettes and the clipmap ground they stand on — never get frustum-chopped
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 6000);

// ---------- globe horizon ----------
// A gentle planet curvature patched into EVERY built-in material through the shared
// project_vertex chunk: geometry sinks by distance² from the camera, so far rooflines
// slide down over the curve and streaming pop-in happens below the horizon, inside
// the fog (the Animal Crossing trick, dialled way back). Purely visual — physics,
// aiming and collision all stay in flat world space. Camera-riding backdrops (the sky
// dome, the fog-exempt town skyline) opt out with defines.NO_CURVE.
const CURVE_DROP = 7.2e-4; // y drop per unit²: ~1u at 40u out, ~10u at the default fog line
THREE.ShaderChunk.project_vertex = THREE.ShaderChunk.project_vertex.replace(
  'mvPosition = modelViewMatrix * mvPosition;',
  `#ifdef NO_CURVE
  mvPosition = modelViewMatrix * mvPosition;
#else
  vec4 curveW = modelMatrix * mvPosition;
  vec2 curveD = curveW.xz - cameraPosition.xz;
  curveW.y -= dot(curveD, curveD) * ${CURVE_DROP};
  mvPosition = viewMatrix * curveW;
#endif`
);
// sprites skip project_vertex entirely (they bill-board off their own anchor math), so
// world-anchored sprites — the loot glow orbs — hung at flat height while the ground
// sank away under them. Sink the anchor the same way; the camera-riding sky sprites
// (sun, moon, overhead cloud) opt out with the same NO_CURVE define.
THREE.ShaderLib.sprite.vertexShader = THREE.ShaderLib.sprite.vertexShader.replace(
  'vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );',
  `vec4 curveW = modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
#ifndef NO_CURVE
  vec2 curveD = curveW.xz - cameraPosition.xz;
  curveW.y -= dot(curveD, curveD) * ${CURVE_DROP};
#endif
  vec4 mvPosition = viewMatrix * curveW;`
);
// the same sink for anything CPU-side that pins UI to a world point (damage numbers,
// talk bubbles, player tags): drop a world y by this before projecting, so the label
// lands on the drawn, curved actor instead of floating over its flat position
function curveDrop(x, z) {
  const dx = x - camera.position.x, dz = z - camera.position.z;
  return (dx * dx + dz * dz) * CURVE_DROP;
}

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
// signed shortest angular distance a->b — the "am I actually facing it yet" test
function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
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
// distance from a coordinate to the nearest road centreline (roads repeat every 120).
// Horizontal roads (the z axis, incl. the main street at z=-17) keep the -17 offset;
// vertical roads (the x axis) sit 3 further west at -20, which slides the town's western
// cross street clear of the bank so it no longer sits on the tarmac.
function roadAxisDist(v) {          // z axis — horizontal roads
  let m = ((v + 17) % 120 + 120) % 120;
  return Math.min(m, 120 - m);
}
function roadAxisDistX(v) {         // x axis — vertical roads, shifted 3 west
  let m = ((v + 20) % 120 + 120) % 120;
  return Math.min(m, 120 - m);
}
// town footprint rectangles [x0,z0,x1,z1] - flattened terrain + no random spawns inside
const TOWN_RECTS = [
  [-16, -60, 110, 6],  // main street, shops, bank + fountain pavilion, town hall, courthouse
  [8, 12, 78, 64],     // shopping plaza + parking
  [69, 32, 96, 40],     // east lot connector, out to the x=100 road
  [-15, 18, 10, 26],    // west lot connector, out to the x=-20 road
  [16, 68, 62, 94],    // old church + spiked graveyard, just north of the plaza
  [112, -56, 146, -28], // the jelly park, down the block from the civic pair's side road
  [108, 48, 128, 66],   // Red's Chili corner plot, two blocks up the side road from the statue
  [103, -140, 141, -104], // the Blob Lounge grounds, far down the side road the other way
  [105, 160, 143, 196], // grandma's Jelly House grounds — far past the church, the farthest landmark out, clear east of the x=100 road
];
// ---------- the prestige map remix ----------
// First campaigns play the hardcoded town above. Run 2+ (new game plus) re-deals the five
// OUTER landmark blocks — church+graveyard, jelly park, Red's Chili, Blob Lounge, Jelly
// House — onto fresh anchors every run: a mystery layout with the same flow, spaced a
// little wider than the classic map. The heart of town (main street, shops, bank +
// fountain, hall, courthouse, plaza) never moves. Landmarks never land on a road or a
// core block (layoutRectFits), and the Jelly House stays the farthest light out.
const LAYOUT = { chili: { x: 117, z: 56 }, lounge: { x: 122, z: -121 } }; // live anchors the builders read
const TOWN_BOUND = { x0: -50, x1: 160, z0: -145, z1: 205 }; // collider net, recomputed per layout
const LM_EXT = { church: [23, 13], park: [17, 14], chili: [10, 9], lounge: [19, 18], jelly: [19, 18] };
// where each block's TRUE rectangle centre sits relative to its anchor (applyLayout builds
// the rects off-centre — the church's graveyard runs 14 east of the anchor, for one). The
// dealer must test the fit at the real centre, or a graveyard edge can lap onto a road.
const LM_OFF = { church: [14, 0], park: [0, 0], chili: [1, 1], lounge: [0, -1], jelly: [0, 0] };
function defaultLayout() { return { church: [25, 81], park: [129, -42], chili: [117, 56], lounge: [122, -121], jelly: [124, 178] }; }
let currentLayout = ''; // JSON of what's built, so an unchanged layout never rebuilds
function layoutRectFits(x, z, hw, hd) {
  // roads thread BETWEEN landmarks, never under one: both lattices must clear the block
  const nv = Math.round((x + 20) / 120) * 120 - 20;   // nearest vertical road line
  const dv = nv < x - hw ? (x - hw) - nv : nv > x + hw ? nv - (x + hw) : 0;
  if (dv < 8.9) return false;
  const nh = Math.round((z + 17) / 120) * 120 - 17;   // nearest horizontal road line
  const dh = nh < z - hd ? (z - hd) - nh : nh > z + hd ? nh - (z + hd) : 0;
  if (dh < 8.9) return false;
  // and clear of the town's fixed heart (the first four rects) with breathing room
  for (let i = 0; i < 4; i++) {
    const r = TOWN_RECTS[i];
    if (x + hw > r[0] - 6 && x - hw < r[2] + 6 && z + hd > r[1] - 6 && z - hd < r[3] + 6) return false;
  }
  return true;
}
// each consecutive prestige deal in a session pushes EVERY landmark farther from the
// fountain than the run before (any direction) — so every trek only ever grows longer.
// Session-scoped on purpose: quit-to-menu / a fresh page restarts at the classic map.
let lastLmD = null;
function randomLayout() {
  const C = { x: 45, z: -17 }; // the fixed heart the blocks deal out around
  for (let attempt = 0; attempt < 60; attempt++) {
    const L = {}, placed = [];
    let ok = true;
    // the four mid landmarks ring the heart a touch wider than the classic map;
    // the Jelly House deals onto its own far ring so the trek stays the epilogue
    for (const [key, r0, r1] of [['church', 80, 150], ['park', 80, 150], ['chili', 80, 150], ['lounge', 90, 165], ['jelly', 190, 235]]) {
      const [hw, hd] = LM_EXT[key];
      const [ox, oz] = LM_OFF[key];
      // beat last run's fountain distance for this landmark (capped so the deal can
      // always still land somewhere), and widen the sampling ring to reach that far
      const need = Math.min(lastLmD && lastLmD[key] ? lastLmD[key] + 4 : 0, 420);
      const rr0 = Math.max(r0, need - 46), rr1 = Math.max(r1, need + 46);
      let hit = null;
      for (let t = 0; t < 240 && !hit; t++) {
        const a = Math.random() * TAU, d = rr0 + Math.random() * (rr1 - rr0);
        const x = Math.round(C.x + Math.sin(a) * d), z = Math.round(C.z + Math.cos(a) * d);
        if (!layoutRectFits(x + ox, z + oz, hw, hd)) continue;   // tested at the TRUE rect centre
        if (need > 0 && Math.hypot(x - FOUNTAIN.x, z - FOUNTAIN.z) <= need) continue;
        if (placed.some(p => Math.hypot(p[0] - x, p[1] - z) < 95)) continue; // wider spacing than run one
        hit = [x, z];
      }
      if (!hit) { ok = false; break; }
      L[key] = hit; placed.push(hit);
    }
    if (ok) {
      lastLmD = {};
      for (const k in L) lastLmD[k] = Math.hypot(L[k][0] - FOUNTAIN.x, L[k][1] - FOUNTAIN.z);
      return L;
    }
  }
  return defaultLayout(); // the dice never landed: the map keeps its classic bones
}
function setRect(r, x0, z0, x1, z1) { r[0] = x0; r[1] = z0; r[2] = x1; r[3] = z1; }
// point every anchor in the game at the dealt layout: build positions, boss arenas,
// cousin doorsteps, spawn-suppression rects and the collider net all move together
function applyLayout(L) {
  currentLayout = JSON.stringify(L);
  const [chx, chz] = L.church;
  CHURCH.x = chx; CHURCH.z = chz;
  GRAVEYARD.x0 = chx + 15; GRAVEYARD.z0 = chz - 11; GRAVEYARD.x1 = chx + 33; GRAVEYARD.z1 = chz + 11;
  CHURCHYARD.x = chx + 10; CHURCHYARD.z = chz;
  setRect(TOWN_RECTS[4], chx - 9, chz - 13, chx + 37, chz + 13);
  const [px, pz] = L.park;
  PARK.x0 = px - 17; PARK.z0 = pz - 14; PARK.x1 = px + 17; PARK.z1 = pz + 14;
  setRect(TOWN_RECTS[5], px - 17, pz - 14, px + 17, pz + 14);
  const [cx, cz] = L.chili;
  LAYOUT.chili.x = cx; LAYOUT.chili.z = cz;
  setRect(TOWN_RECTS[6], cx - 9, cz - 8, cx + 11, cz + 10);
  const [lx, lz] = L.lounge;
  LAYOUT.lounge.x = lx; LAYOUT.lounge.z = lz;
  setRect(TOWN_RECTS[7], lx - 19, lz - 19, lx + 19, lz + 17);
  const [jx, jz] = L.jelly;
  JELLY.x = jx; JELLY.z = jz; JELLY_G.x = jx; JELLY_G.z = jz + 4.2;
  setRect(TOWN_RECTS[8], jx - 19, jz - 18, jx + 19, jz + 18);
  // the cousins wait where their story says — wherever that story moved to this run
  COUSIN_HOMES.blingo = [px, pz + 4.5];
  COUSIN_HOMES.blazo = [cx + 2.5, cz + 5];
  COUSIN_HOMES.blomba = [lx, lz + 10.5];
  // stretch the town-collider net over whatever the deal spans
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of TOWN_RECTS) { x0 = Math.min(x0, r[0]); z0 = Math.min(z0, r[1]); x1 = Math.max(x1, r[2]); z1 = Math.max(z1, r[3]); }
  TOWN_BOUND.x0 = x0 - 20; TOWN_BOUND.z0 = z0 - 20; TOWN_BOUND.x1 = x1 + 20; TOWN_BOUND.z1 = z1 + 20;
}
// The park keeps its perimeter sacred: no zombie ever spawns on it (they may still
// wander in chasing you, which is exactly the picnic-crashing the plaque deserves).
const PARK = { x0: 112, z0: -56, x1: 146, z1: -28 };
function inPark(x, z, m = 0) {
  return x > PARK.x0 - m && x < PARK.x1 + m && z > PARK.z0 - m && z < PARK.z1 + m;
}
function rectDist(x, z, r) {
  const dx = Math.max(r[0] - x, 0, x - r[2]);
  const dz = Math.max(r[1] - z, 0, z - r[3]);
  return Math.hypot(dx, dz);
}
function inTown(x, z, margin = 0) {
  for (const r of TOWN_RECTS) if (rectDist(x, z, r) <= margin) return true;
  return false;
}
// dead-flat "poured pads" under the enterable houses. makeBuilding registers one before
// its chunk's terrain mesh samples heights (terrain builds LAST in buildChunk now), so
// inside the pad the ground IS the pad level — no outside grade leaking through the
// floorboards — and a short apron blends back out to the natural grade so the yard
// doesn't cliff at the wall line.
const flatPads = [];
function groundHeight(x, z) {
  const base = (vnoise(x, z, 57) - 0.5) * 3.4 + (vnoise(x, z, 23) - 0.5) * 1.1 + (vnoise(x, z, 131) - 0.5) * 2.2;
  const dr = Math.min(roadAxisDistX(x), roadAxisDist(z));
  let f = smooth(clamp((dr - 6.7) / 10, 0, 1)); // graded flat near roads
  let td = Infinity;
  for (const r of TOWN_RECTS) td = Math.min(td, rectDist(x, z, r));
  f = Math.min(f, smooth(clamp((td - 1) / 12, 0, 1))); // graded flat in town
  let g = base * (0.12 + 0.88 * f);
  // roads trump pads: a house that spawned close enough for its pad (or apron) to lap
  // onto the road corridor lets go of the ground there — fading back to full strength
  // past the shoulder — so the tarmac never grows a grass hump over itself. (The road
  // mesh and the grass sample this same function at different grids; any pad influence
  // on the corridor shows up as green poking through the asphalt.)
  const padHold = smooth(clamp((dr - 6.7) / 3, 0, 1));
  if (padHold > 0) for (const p of flatPads) {
    const dOut = Math.max(Math.abs(x - p.x) - p.hw, Math.abs(z - p.z) - p.hd);
    if (dOut >= p.apron) continue;
    const k = dOut <= 0 ? 0 : smooth(dOut / p.apron);
    g = lerp(p.y, g, Math.max(k, 1 - padHold));
  }
  return g;
}
// roads are two-way now: a lane each direction, 12.8 wide in total
function onRoad(x, z, margin = 0) {
  return roadAxisDistX(x) < 6.4 + margin || roadAxisDist(z) < 6.4 + margin;
}

// shared materials/geometries
const MAT = {};
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!MAT[key]) MAT[key] = new THREE.MeshLambertMaterial({ color, ...opts });
  return MAT[key];
}
// knock a colour down a shade — the knuckle block always sits just under its mitt
// (green 8aa85a/789748, skin ffd7a8/f0c898), so an overridden hand needs the same pairing
function darken(hex, f = 0.86) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return (((r * f) | 0) << 16) | (((g * f) | 0) << 8) | ((b * f) | 0);
}
// A private copy of a cached material, so one mesh can fade without dragging every other
// user of mat()'s cache with it. Flagged so its chunk disposes it on unload.
function ownMat(mesh) {
  mesh.material = mesh.material.clone();
  mesh.material.userData.owned = true;
  return mesh.material;
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
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
});
// ---------- the loot glow kit ----------
// One dressed-up glow, reused everywhere something wants to be found: a soft tinted pool
// laid on the ground (the drop shadow), a sharp ring breathing over it, and a brighter orb
// of light riding above the top centre of whatever it marks. Crates wear it gold, the jelly
// table purple, the chili pot red — and boss-wave guards wear it in their own body colour
// so the shield-breakers read at a glance (the shielded boss glows his too, till they fall).
function makeLootGlow(color, { r = 1, y = 0.9, s = 1.6, dark = false } = {}) {
  // dark = the black-ops read: a REAL shadow on the ground (normal-blended black) instead of
  // an additive glow (which can never darken), with a smoky charcoal ring + orb over it
  const g = new THREE.Group();
  const blend = dark ? THREE.NormalBlending : THREE.AdditiveBlending;
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(r * 2.7, r * 2.7),
    new THREE.MeshBasicMaterial({ map: glowTex, color: dark ? 0x000000 : color, transparent: true, opacity: 0.45,
      blending: blend, depthWrite: false }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = 0.045; pool.renderOrder = 2;
  g.add(pool);
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.8, r, 28),
    new THREE.MeshBasicMaterial({ color: dark ? 0x0a0a0e : color, transparent: true, opacity: 0.5,
      blending: blend, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.07; ring.renderOrder = 2;
  g.add(ring);
  const orb = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: dark ? 0x2a2a34 : color, transparent: true,
    opacity: 0.8, blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false }));
  orb.scale.setScalar(s);
  orb.position.y = y;
  g.add(orb);
  g.userData.glow = { pool, ring, orb, s, orbY: y, mul: 1 };
  return g;
}
// one shared heartbeat for every glow: the ring breathes out while the pool swells under
// it and the orb bobs and brightens on the same beat. mul lets a glow fade off (a boss
// losing his shield) without tearing the group down.
function animateLootGlow(g, t) {
  const u = g.userData.glow;
  if (!u) return;
  g.visible = u.mul > 0.02;
  if (!g.visible) return;
  const beat = Math.sin(t * 2.6), soft = Math.sin(t * 2.6 + 1.1);
  u.ring.scale.setScalar(1 + beat * 0.14);
  u.ring.material.opacity = (0.36 + beat * 0.2) * u.mul;
  u.pool.scale.setScalar(1 + soft * 0.1);
  u.pool.material.opacity = (0.38 + soft * 0.14) * u.mul;
  u.orb.material.opacity = (0.6 + beat * 0.28) * u.mul;
  u.orb.scale.setScalar(u.s * (1 + beat * 0.09));
  u.orb.position.y = u.orbY + beat * 0.07;
}
// Extra Gore at full is the "gore horde": locally it's the slider maxed; a client also
// inherits it from the host, since the host's world is the one doing the spawning. It lights
// the settings notches (see updateGoreHordeUI) and swells the spawner — the in-world zombies
// themselves stay unlit, the glow is a menu-only tell.
function goreHordeLocal() { return notches.extraGore >= 5; }
// ---------- shop + civic signage ----------
// The town's signs are the blob font in caps, same face the blobs' own menus wear, on a
// clean plate: one hairline rule inset off the edge instead of the old heavy frame, and the
// name fitted to the width so a long one shrinks to sit inside the rule rather than running
// out through it. Rendered at 512x128 — the plates are all ~4:1, and the old 256x64 was
// soft enough to read as a smudge from across the street.
const SIGN_FONT = "'OpenDyslexic','Open-Dyslexic','Comic Sans MS','Comic Sans',cursive";
const SIGN_W = 512, SIGN_H = 128;
const textPlates = [];
function drawPlate(ctx, txt, bg, fg) {
  ctx.clearRect(0, 0, SIGN_W, SIGN_H);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, SIGN_W, SIGN_H);
  ctx.strokeStyle = fg; ctx.lineWidth = 3; ctx.globalAlpha = 0.6;
  ctx.strokeRect(11, 11, SIGN_W - 22, SIGN_H - 22);
  ctx.globalAlpha = 1;
  const caps = txt.toUpperCase();
  if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';   // ignored where unsupported
  // shrink until it clears the rule with room either side
  let size = 66;
  const fit = SIGN_W - 60;
  ctx.font = `bold ${size}px ${SIGN_FONT}`;
  while (ctx.measureText(caps).width > fit && size > 14) { size -= 2; ctx.font = `bold ${size}px ${SIGN_FONT}`; }
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(caps, SIGN_W / 2, SIGN_H / 2 + 2);
}
function textPlate(txt, w, h, bg = '#241f1a', fg = '#ffe9c0') {
  const t = canvasTex(SIGN_W, SIGN_H, ctx => drawPlate(ctx, txt, bg, fg));
  textPlates.push({ txt, bg, fg, tex: t });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: t }));
}
// Canvas text bakes in whatever font is loaded the instant you draw it, and the whole town
// is built long before a webfont crosses the wire — so every sign would silently bake the
// fallback. Ask for the face, then re-render the signage once it actually lands.
if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load(`bold 66px ${SIGN_FONT}`), document.fonts.ready])
    .then(() => {
      for (const p of textPlates) { drawPlate(p.tex.image.getContext('2d'), p.txt, p.bg, p.fg); p.tex.needsUpdate = true; }
    })
    .catch(() => {});   // no webfont: the fallback face already baked in is fine
}

// ---------- sky, time-of-day & weather ----------
// four times of day, cycled morning -> noon -> sunset -> night as blocks are cleared
// (the heroes never stop rescuing); weather rerolls each cycle: 40% sunny / 40% cloudy / 20% rain
const PHASES = [
  { name: 'MORNING', top: '#6f9fd8', mid: '#f2c58e', hor: '#ffd9a8', sun: '#fff0c4', sunV: 0.40, sunR: 34, cloudC: '#fff2dd', cloudB: '#eccfa8',
    hemiSky: 0xbfd4ee, hemiGnd: 0x4a4436, hemiI: 0.95, dirC: 0xffe2ae, dirI: 0.9, dirPos: [40, 26, 55], ambC: 0x8a7458, ambI: 0.42, fog: '#c7ad91' },
  { name: 'NOON', top: '#2e6fc9', mid: '#7ab5ea', hor: '#cde6f8', sun: '#ffffff', sunV: 0.12, sunR: 30, cloudC: '#ffffff', cloudB: '#d7e5f2',
    hemiSky: 0xd8e8ff, hemiGnd: 0x5a5442, hemiI: 1.1, dirC: 0xfff6e0, dirI: 1.0, dirPos: [12, 70, 18], ambC: 0x9a8a70, ambI: 0.42, fog: '#a9c3dd' },
  { name: 'SUNSET', top: '#413a6e', mid: '#d96a4c', hor: '#ffb35c', sun: '#ffcf9a', sunV: 0.44, sunR: 40, cloudC: '#ffd7b0', cloudB: '#e2926c',
    hemiSky: 0xd8a080, hemiGnd: 0x3a3040, hemiI: 0.85, dirC: 0xff9a5c, dirI: 0.8, dirPos: [-55, 16, 22], ambC: 0x7a5a48, ambI: 0.38, fog: '#8a5f52' },
  { name: 'NIGHT', top: '#0a0e22', mid: '#1c2440', hor: '#2b3350', sun: '#dfe8ff', sunV: 0.30, sunR: 22, stars: true, cloudC: '#2b3352', cloudB: '#20263f',
    hemiSky: 0x8fa3d0, hemiGnd: 0x2e2a22, hemiI: 0.75, dirC: 0xaebfff, dirI: 0.7, dirPos: [-30, 50, -20], ambC: 0x64513a, ambI: 0.32, fog: '#232a45' },
];
// weather rolls live in the wx machine (50/50 sunny/cloudy, rain can intercept a cloudy
// spell at its halfway mark) — see updateDayNight below
const skyCanvas = document.createElement('canvas');
skyCanvas.width = 1024; skyCanvas.height = 512;
const skyTex = new THREE.CanvasTexture(skyCanvas);
skyTex.colorSpace = THREE.SRGBColorSpace;
// canvas top = zenith, middle row = horizon. On this sphere the zenith vertex is uv.v=1, and
// only flipY=true lands v=1 on the canvas TOP row — flipY=false put the canvas BOTTOM (the dark
// below-horizon floor tone) at the zenith, stamping a grey lid over the whole overhead sky.
skyTex.flipY = true;
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(240, 24, 16),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
);
skyDome.renderOrder = -10;
skyDome.material.defines = { NO_CURVE: 1 }; // rides the camera — bending it would dent the sky
scene.add(skyDome);
const moonOff = new THREE.Vector3(-30, 50, -20); // key-light offset, follows the player
const _skyMoodC = new THREE.Color('#9aa2b0'), _skyMoodR = new THREE.Color('#59606e');
// p is a blended phase palette (see phaseMixAt) and W the live weather weights
// { sunny, cloudy, rain } summing to 1 — mid-transition skies mix both moods.
function drawSky(p, W) {
  const ctx = skyCanvas.getContext('2d');
  const CW = skyCanvas.width, H = skyCanvas.height;
  // weather tints the palette itself (scaled by its blend weight) instead of
  // flat-washing the finished sky, so the gradient keeps its depth in any mood
  const tint = hex => '#' + new THREE.Color(hex)
    .lerp(_skyMoodC, 0.42 * W.cloudy).lerp(_skyMoodR, 0.62 * W.rain).getHexString();
  // one clean sweep from zenith to horizon. The top stop is held flat for the first
  // stretch so the sphere's pole pinch lands inside a single tone — no more grey
  // circle stamped overhead — and no haze band muddying the horizon line.
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.54);
  g.addColorStop(0, tint(p.top)); g.addColorStop(0.14, tint(p.top));
  g.addColorStop(0.6, tint(p.mid)); g.addColorStop(1, tint(p.hor));
  ctx.fillStyle = g; ctx.fillRect(0, 0, CW, H * 0.54);
  // below the horizon a single quiet floor tone — terrain and fog own that half anyway
  ctx.fillStyle = '#' + new THREE.Color(tint(p.hor)).multiplyScalar(0.34).getHexString();
  ctx.fillRect(0, H * 0.53, CW, H * 0.47);
  const starA = (p.starA || 0) * W.sunny; // stars need clear night: fade with dawn AND cover
  if (starA > 0.05) {
    const srng = mulberry32(42);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 170; i++) {
      ctx.globalAlpha = (0.25 + srng() * 0.75) * starA;
      ctx.fillRect(srng() * CW, H * (0.04 + srng() * 0.44), srng() < 0.12 ? 2 : 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  // no more moon stamp here — the moon is a 3D sprite pair now (disc + halo, see
  // updateCelestial), arcing the sky in real time just like the sun
  skyTex.needsUpdate = true;
}
// ---------- cloud dome ----------
// The cartoon puff-stamps are gone: this is the frutiger-gallery FBM cloud shader
// (domain-warped value noise billowing across the dome) rehomed onto the game's
// transparent cloud shell — and made LIVE. Where the gallery baked its coverage at
// build time, here cover, colour, silver-lining and drift speed are uniforms fed
// every frame off the blended phase palette, the weather weights and the wind, so
// fronts genuinely roll in: sunny keeps a few wandering puffs, cloudy sheets over,
// rain shuts the lid — and at night the same field runs dark with a moonlit lining.
const cloudUni = {
  uTime: { value: 0 },
  uCover: { value: 0.3 },
  uCirrus: { value: 0.5 },
  uFill: { value: new THREE.Color('#ffffff') },
  uBelly: { value: new THREE.Color('#d7e5f2') },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunCol: { value: new THREE.Color(0x000000) },
  uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uMoonCol: { value: new THREE.Color(0x000000) },
};
// the cloud SHELL: rays hit a layer wrapped over the same globe the world bends on
// (planet radius straight from CURVE_DROP), so the field foreshortens into the horizon
// like a real sky instead of capping a flat plane overhead
const CLOUD_RP = 1 / (2 * CURVE_DROP);   // ≈ the planet the curve implies
const CLOUD_CH = 90;                     // shell height overhead
const CLOUD_THOR = Math.sqrt(2 * CLOUD_RP * CLOUD_CH + CLOUD_CH * CLOUD_CH); // ray length at the horizon
const cloudDome = new THREE.Mesh(
  new THREE.SphereGeometry(232, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
    uniforms: cloudUni,
    vertexShader: /* glsl */`
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      varying vec3 vP;
      uniform float uTime, uCover, uCirrus;
      uniform vec3 uFill, uBelly, uSunCol, uMoonCol, uSunDir, uMoonDir;
      // Dave Hoskins hash -> value noise -> fbm, straight from the gallery sky
      float hash(vec2 p){
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        float a = hash(i), b = hash(i + vec2(1., 0.)), c = hash(i + vec2(0., 1.)), d = hash(i + vec2(1., 1.));
        vec2 u = f * f * (3. - 2. * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1. - u.x) + (d - b) * u.x * u.y;
      }
      float fbm(vec2 p){
        float v = 0.0, a = 0.5;
        mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
        for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = m * p; a *= 0.5; }
        return v;
      }
      void main(){
        vec3 dir = normalize(vP);
        if (dir.y < -0.04) discard;               // the shell dips just past the horizon line
        // spherical shell projection — the ray meets a cloud layer wrapped over the
        // globe (t = distance to the shell), so the texture foreshortens smoothly INTO
        // the horizon: no flat-plane singularity, no smears down the tube sides
        float t = -${CLOUD_RP.toFixed(1)} * dir.y
                + sqrt(${(CLOUD_RP * CLOUD_RP).toFixed(1)} * dir.y * dir.y + ${(2 * CLOUD_RP * CLOUD_CH + CLOUD_CH * CLOUD_CH).toFixed(1)});
        vec2 uv = dir.xz * t * ${(0.5 / CLOUD_CH).toFixed(6)};
        // melt the far shell into the horizon haze over its last stretch, and cut
        // hard just below the line so the fog owns everything under it
        float far = smoothstep(0.42, 1.0, t * ${(1 / CLOUD_THOR).toFixed(6)});
        float above = (1.0 - 0.85 * far) * smoothstep(-0.03, 0.05, dir.y);
        // fbm fed through fbm so the puffs billow and curl instead of sliding as a rigid sheet
        vec2 q = vec2(fbm(uv + uTime * 0.006), fbm(uv + vec2(5.2, 1.3) - uTime * 0.005));
        vec2 cuv = uv + q * 0.6 + vec2(uTime * 0.010, uTime * 0.004);
        float dens = fbm(cuv) * 0.68 + fbm(cuv * 2.3 + 7.0) * 0.32;
        float cov = smoothstep(0.80 - 0.42 * uCover, 0.80, dens) * above;
        // belly shading, then a silver lining toward whichever light is up
        float sd = max(dot(dir, uSunDir), 0.0), md = max(dot(dir, uMoonDir), 0.0);
        vec3 col = mix(uBelly, uFill, smoothstep(0.28, 0.94, dens));
        col += uSunCol * (pow(sd, 90.0) * 0.5 + pow(sd, 3.0) * 0.22);
        col += uMoonCol * (pow(md, 60.0) * 0.6 + pow(md, 6.0) * 0.2);
        float aP = cov * 0.92;
        // thin high cirrus streaks in the gaps the puffs leave
        float ciBand = smoothstep(0.05, 0.32, dir.y) * (1.0 - far); // streaks ride the shell too, thinning into the distance
        float ci = fbm(dir.xz * t * ${(1 / CLOUD_CH).toFixed(6)} * vec2(0.55, 2.8) + vec2(uTime * 0.006, 0.0));
        ci = smoothstep(0.82 - 0.22 * uCirrus, 0.88, ci) * ciBand * (1.0 - cov);
        float aC = ci * 0.34 * (1.0 - aP);
        float a = aP + aC;
        vec3 outCol = (col * aP + uFill * 1.10 * aC) / max(a, 1e-4);
        gl_FragColor = vec4(outCol, a);
      }`
  })
);
cloudDome.renderOrder = -9;
scene.add(cloudDome);
// scratch colours for the per-frame cloud dressing (see updateCelestial)
const _cFillW = new THREE.Color(), _cFillR = new THREE.Color();
// ---------- 3D sun, its lens glare, the dark overhead cloud it ducks behind, and air motes ----------
// The old sun was a flat stamp baked into the sky canvas. Now it's a sprite that ARCS across
// the sky in real time off game.clock: it lifts off the horizon at dawn, slides up behind a
// dark cloud parked overhead through the middle of the day (overcast — the disc vanishes, only
// a bruised glow bleeds round the cloud's rim), then drops out the far side and flares low over
// the dusk horizon. The warm lens glare is lifted from the .webpages frutiger-gallery sun.
// Everything reads the live (blended) phase palette, so sunrise/sunset burn gold and noon runs
// white, and it all recolours frame by frame with the day.
const ss = (a, b, t) => { t = clamp((t - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function radialTex(size, stops) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// warm core glare + a tight bright disc — the frutiger sun's palette (cream → gold → gone)
const sunGlareTex = radialTex(256, [[0, 'rgba(255,247,224,1)'], [0.22, 'rgba(255,236,188,0.72)'],
  [0.45, 'rgba(255,222,150,0.34)'], [0.66, 'rgba(255,214,150,0.12)'], [0.8, 'rgba(255,214,150,0)']]);
const sunDiscTex = radialTex(128, [[0, 'rgba(255,255,246,1)'], [0.5, 'rgba(255,246,220,0.98)'],
  [0.72, 'rgba(255,240,205,0.5)'], [0.9, 'rgba(255,240,205,0)']]);
// the MOON gets the same treatment as the sun: a real disc (with soft maria splotches,
// off-centre lit) plus a wide silver halo, so it can glow gently at night and all but
// dissolve into the blue by day
const moonDiscTex = (() => {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), R = mulberry32(51);
  const g = x.createRadialGradient(S * 0.45, S * 0.43, S * 0.06, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(249,252,255,1)'); g.addColorStop(0.6, 'rgba(228,237,253,0.98)');
  g.addColorStop(0.84, 'rgba(206,220,245,0.55)'); g.addColorStop(1, 'rgba(206,220,245,0)');
  x.fillStyle = g; x.beginPath(); x.arc(S / 2, S / 2, S / 2, 0, TAU); x.fill();
  x.fillStyle = 'rgba(148,166,205,0.3)'; // the seas — a few soft grey blotches
  for (let i = 0; i < 7; i++) {
    const a = R() * TAU, d = R() * S * 0.26, r = (0.05 + R() * 0.11) * S;
    x.beginPath();
    x.ellipse(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, r, r * (0.7 + R() * 0.3), R() * TAU, 0, TAU);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const moonHaloTex = radialTex(256, [[0, 'rgba(210,226,255,0.85)'], [0.25, 'rgba(186,208,250,0.4)'],
  [0.5, 'rgba(170,196,246,0.16)'], [0.78, 'rgba(160,190,240,0.05)'], [1, 'rgba(160,190,240,0)']]);
// a lumpy dark cloud on its own canvas: overlapping puff lobes inside a soft circular alpha
// falloff, so it reads as a cloud (crisp middle, dissolving rim the sun can peek around)
const overheadCloudTex = (() => {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), R = mulberry32(913);
  x.fillStyle = '#ffffff';
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * TAU + R() * 0.6, dist = (0.05 + R() * 0.24) * S, rad = (0.09 + R() * 0.2) * S;
    x.beginPath(); x.ellipse(S / 2 + Math.cos(a) * dist, S / 2 + Math.sin(a) * dist * 0.7, rad, rad * 0.82, 0, 0, TAU); x.fill();
  }
  x.beginPath(); x.arc(S / 2, S / 2, 0.33 * S, 0, TAU); x.fill();
  const img = x.getImageData(0, 0, S, S), d = img.data;
  for (let py = 0; py < S; py++) for (let pxl = 0; pxl < S; pxl++) {
    const idx = (py * S + pxl) * 4, r = Math.hypot((pxl - S / 2) / (S / 2), (py - S / 2) / (S / 2));
    d[idx + 3] *= 1 - ss(0.58, 1.0, r);
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
function skySprite(tex, blend, ro, name) {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, blending: blend });
  m.defines = { NO_CURVE: 1 }; // celestial sprites ride the camera at sky radius — never globe-bent
  const s = new THREE.Sprite(m); s.renderOrder = ro; s.frustumCulled = false; s.name = name; scene.add(s); return s;
}
const sunGlare = skySprite(sunGlareTex, THREE.AdditiveBlending, -8, 'sunGlare');
const sunDisc = skySprite(sunDiscTex, THREE.AdditiveBlending, -7, 'sunDisc');
const moonHalo = skySprite(moonHaloTex, THREE.AdditiveBlending, -8, 'moonHalo');
const moonSprite = skySprite(moonDiscTex, THREE.NormalBlending, -7, 'moonDisc');
const overheadCloud = skySprite(overheadCloudTex, THREE.NormalBlending, -6, 'overheadCloud');

// sun-lit air motes: one THREE.Points draw call. Every mote owns a fixed, OPEN spot on
// the MAP (seated by updateMotes — never in a wall, wreck or building footprint) and
// holds it while you trek past; only the bob/sway/twinkle lives in the vertex shader.
// Additive soft bokeh = out-of-focus glints. uTint recolours the lot off the sky.
const MOTE_SPAN = 26;
// the pool holds more motes than a clear day shows: uFrac gates how many are live, so
// the air genuinely thickens with the weather — sunny keeps the old baseline count,
// cloudy wakes a few more, and rain packs the air with drifting spray-glints
const MOTE_N = 430, MOTE_BASE = 200 / MOTE_N;
const airMotes = (() => {
  const N = MOTE_N, geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // parked far out of the box: the first updateMotes sweep seats every mote at a
    // real open spot on the map once the world actually exists
    pos[i * 3] = 1e6; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 1e6;
    seed[i] = Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: { value: 0 }, uPR: { value: Math.min(devicePixelRatio, 2) },
                uTint: { value: new THREE.Color(0xffe8c0) }, uAmt: { value: 1 },
                uFrac: { value: MOTE_BASE } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime, uPR, uFrac;
      varying float vA;
      void main(){
        vec3 p = position; float s = aSeed;   // p is an ABSOLUTE map spot (see updateMotes)
        // weather gate: motes past the live fraction collapse (decorrelated from the
        // seed's motion role so waking more doesn't favour the slow risers)
        float gate = step(fract(s * 97.13), uFrac);
        p.y += sin(uTime*(0.18 + 0.22*s) + s*61.0) * 0.9;                // a gentle bob ON its spot
        p.x += sin(uTime*(0.25 + s) + s*31.0) * 0.5;                     // lazy sway
        p.z += cos(uTime*(0.20 + s*0.5) + s*57.0) * 0.5;
        vec4 wp = modelMatrix * vec4(p, 1.0);          // globe-bend like everything else
        vec2 cd = wp.xz - cameraPosition.xz;
        wp.y -= dot(cd, cd) * ${CURVE_DROP};
        vec4 mv = viewMatrix * wp;
        float tw = 0.5 + 0.5*sin(uTime*(0.6 + s*1.6) + s*43.0);
        vA = (0.14 + 0.86*tw*tw) * clamp(1.0 - (-mv.z)/38.0, 0.0, 1.0) * gate;  // twinkle, fade with depth
        gl_PointSize = min((1.4 + 3.2*s) * uPR * (6.0 / max(1.0, -mv.z)), 16.0*uPR) * gate;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTint; uniform float uAmt;
      varying float vA;
      void main(){
        float m = smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5));
        float a = m * vA * uAmt;
        gl_FragColor = vec4(uTint * a, a);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; pts.renderOrder = 3; pts.name = 'airMotes'; scene.add(pts);
  return pts;
})();
// world-anchored mote keeping: a mote holds its map spot while you trek past — no more
// cloud gliding along with the camera — and only ever seats in the OPEN: never inside
// a building footprint, a wall, a wreck or any other collider. Ones that fall out of
// the box around the hero re-seat at a fresh open spot on the way in.
function moteSpot(pos, i, px, pz) {
  for (let k = 0; k < 8; k++) {
    const x = px + (Math.random() * 2 - 1) * MOTE_SPAN;
    const z = pz + (Math.random() * 2 - 1) * MOTE_SPAN;
    let blocked = !!buildingAt(x, z);       // indoors is not "the open"
    if (!blocked) for (const c of nearbyColliders(x, z)) {
      let lx = x - c.x, lz = z - c.z;
      if (c.rot) { const cs = Math.cos(c.rot), sn = Math.sin(c.rot), tx = lx * cs - lz * sn; lz = lx * sn + lz * cs; lx = tx; }
      if (Math.abs(lx) < c.hw + 0.8 && Math.abs(lz) < c.hd + 0.8) { blocked = true; break; }
    }
    if (blocked) continue;
    pos.setXYZ(i, x, groundHeight(x, z) + 0.4 + Math.random() * 8.5, z);
    return;
  }
  // a packed block with no daylight this frame: tuck it under the dirt inside the box —
  // invisible, and it re-rolls naturally the next time the box moves off it
  pos.setXYZ(i, px, groundHeight(px, pz) - 20, pz);
}
function updateMotes() {
  const pos = airMotes.geometry.attributes.position;
  const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
  let dirty = false;
  for (let i = 0; i < MOTE_N; i++) {
    if (Math.abs(pos.getX(i) - px) > MOTE_SPAN || Math.abs(pos.getZ(i) - pz) > MOTE_SPAN
      || Math.abs(pos.getY(i) - py) > 26) {
      moteSpot(pos, i, px, pz);
      dirty = true;
    }
  }
  if (dirty) pos.needsUpdate = true;
}

const _sunDir = new THREE.Vector3(), _moonDir = new THREE.Vector3();
const _ohDir = new THREE.Vector3(0.06, 1.0, -0.16).normalize();   // fixed spot the dark cloud parks at
const _cSun = new THREE.Color(), _cCloud = new THREE.Color(), _cMote = new THREE.Color(), _cMoon = new THREE.Color();
const _warmSun = new THREE.Color(0xff9a4e);
const MOON_RISE = 17.5, MOON_SET = 6.8; // the moon's arc laps over dusk & dawn, so a pale day moon lingers
// arc the sun off the clock, dress its glare, park + backlight the overhead cloud, drift the
// motes. Called every frame from the render loop (it needs the live camera + player).
function updateCelestial(dt) {
  const clk = game.clock ?? 13, p = phaseMixAt(clk), W = wxWeights();
  const dawn = 5.5, dusk = 19.0, day = clk >= dawn && clk <= dusk;
  const u = clamp((clk - dawn) / (dusk - dawn), 0, 1);   // 0 dawn(E) .. 1 dusk(W)
  const el = day ? Math.sin(u * Math.PI) : -0.3;         // 0→1→0 over the day, below the horizon at night
  const hx = Math.cos(u * Math.PI);                      // +1 east .. -1 west
  const elAng = el * 1.28, hLen = Math.cos(elAng);       // peak ~73°, a touch shy of the zenith
  _sunDir.set(hx * hLen, Math.sin(elAng), -0.32 * hLen).normalize();
  const aboveH = ss(-0.04, 0.14, _sunDir.y);             // fades through twilight
  const overcast = 1 - ss(0.34, 0.62, _sunDir.angleTo(_ohDir)); // 1 = dead behind the cloud, 0 = clear
  const wxClear = Math.max(0, 1 - 0.55 * W.cloudy - 0.85 * W.rain);
  const warmU = clamp(1 - el, 0, 1);                     // low sun burns warmer/oranger
  const vis = aboveH * wxClear;
  _cSun.set(p.sun).lerp(_warmSun, 0.35 * warmU);
  const camP = camera.position, R = 208;
  sunDisc.position.copy(camP).addScaledVector(_sunDir, R);
  sunGlare.position.copy(camP).addScaledVector(_sunDir, R);
  sunDisc.material.color.copy(_cSun);
  sunDisc.material.opacity = vis * (1 - overcast);
  sunDisc.scale.setScalar(24 + 8 * el);
  sunGlare.material.color.copy(_cSun);
  sunGlare.material.opacity = Math.min(1, vis * (1 - 0.82 * overcast) * (0.45 + 0.75 * warmU)); // glare swells low
  sunGlare.scale.setScalar(118 + 66 * warmU);
  overheadCloud.position.copy(camP).addScaledVector(_ohDir, 194);
  _cCloud.set(p.cloudB).multiplyScalar(0.5).lerp(_cSun, 0.3 * overcast);  // warm rim when the sun's behind
  overheadCloud.material.color.copy(_cCloud);
  overheadCloud.material.opacity = clamp(0.6 + 0.28 * W.cloudy + 0.18 * (p.nightW || 0), 0, 0.95);
  overheadCloud.scale.setScalar(150);
  // the moon runs its own arc, offset from the sun's plane: it rises ahead of dusk and
  // sets after dawn, so a pale ghost of it hangs in the day sky — almost fully lost in
  // the blue (a tenth of its night presence) — then brightens as the sun hands over,
  // its halo swelling into a soft night glow that fades back out toward morning
  const mu = ((clk - MOON_RISE + 24) % 24) / ((MOON_SET - MOON_RISE + 24) % 24);
  const mel = mu <= 1 ? Math.sin(mu * Math.PI) : -0.3;   // below the horizon once it sets
  const mhx = Math.cos(clamp(mu, 0, 1) * Math.PI);
  const melAng = mel * 1.18, mhLen = Math.cos(Math.abs(melAng));
  _moonDir.set(mhx * mhLen, Math.sin(melAng), 0.36 * mhLen).normalize();
  const mAbove = ss(-0.04, 0.14, _moonDir.y);
  const mWx = Math.max(0, 1 - 0.5 * W.cloudy - 0.85 * W.rain);
  const mVis = mAbove * mWx * (0.1 + 0.9 * (1 - aboveH));
  _cMoon.set(0xdfe9ff).lerp(_warmSun, 0.22 * clamp(1 - mel, 0, 1)); // a touch warm near the horizon
  moonSprite.position.copy(camP).addScaledVector(_moonDir, R);
  moonHalo.position.copy(camP).addScaledVector(_moonDir, R);
  moonSprite.material.color.copy(_cMoon);
  moonSprite.material.opacity = mVis;
  moonSprite.scale.setScalar(15 + 3 * mel);
  moonHalo.material.color.copy(_cMoon);
  moonHalo.material.opacity = mVis * (0.3 + 0.45 * (p.nightW || 0));
  moonHalo.scale.setScalar(64 + 30 * (p.nightW || 0));
  // feed the FBM cloud dome: cover tracks the weather, colours track the (blended)
  // phase palette greyed down by the front rolling in — same dressing rules the old
  // canvas puffs followed — and the drift speed leans on the live wind
  const night = (p.nightW || 0) > 0.4;
  const gf = night ? '#272e46' : '#c6ccd8', gb = night ? '#1d2338' : '#a9b0bf';
  const rf = night ? '#1a1f30' : '#6d7484', rb = night ? '#141827' : '#565e6c';
  cloudUni.uTime.value += dt * (0.5 + windStr * 1.4);
  cloudUni.uCover.value = 0.3 * W.sunny + 0.88 * W.cloudy + 1.0 * W.rain;
  cloudUni.uCirrus.value = 0.55 * W.sunny + 0.3 * W.cloudy;
  cloudUni.uFill.value.set(p.cloudC).lerp(_cFillW.set(gf), W.cloudy).lerp(_cFillR.set(rf), W.rain);
  cloudUni.uBelly.value.set(p.cloudB).lerp(_cFillW.set(gb), W.cloudy).lerp(_cFillR.set(rb), W.rain);
  cloudUni.uSunDir.value.copy(_sunDir);
  cloudUni.uSunCol.value.copy(_cSun).multiplyScalar(vis);
  cloudUni.uMoonDir.value.copy(_moonDir);
  cloudUni.uMoonCol.value.copy(_cMoon).multiplyScalar(mVis * (p.nightW || 0));
  updateMotes(); // re-seat any motes the trek left behind — the cloud itself never moves
  airMotes.material.uniforms.uTime.value += dt;
  _cMote.set(p.hor).lerp(_cSun, 0.5);
  airMotes.material.uniforms.uTint.value.copy(_cMote).multiplyScalar(0.55 + 0.45 * (1 - (p.nightW || 0)));
  // the old clear-day amount is the FLOOR now: cloud wakes a few more motes, rain
  // wakes the whole pool and runs them brightest
  airMotes.material.uniforms.uAmt.value = 0.95 * W.sunny + 0.8 * W.cloudy + 1.0 * W.rain;
  airMotes.material.uniforms.uFrac.value = MOTE_BASE + (1 - MOTE_BASE) * (0.25 * W.cloudy + W.rain);
}
// live wind: direction & strength drift over time, gusting harder in worse weather.
// rain streaks lean and drift with it, and the wind bed swells/pans to match.
let windYaw = Math.random() * TAU, windTgtYaw = windYaw, windStr = 0.4, windTgtStr = 0.4, windShiftT = 0;
function updateWind(dt) {
  windShiftT -= dt;
  if (windShiftT <= 0) {
    const storming = stormActive();
    windShiftT = storming ? 2 + Math.random() * 3 : 5 + Math.random() * 7; // storms gust faster
    windTgtYaw = Math.random() * TAU;
    windTgtStr = storming ? 0.65 + Math.random() * 0.35
      : game.weather === 'rain' ? 0.45 + Math.random() * 0.55
      : game.weather === 'cloudy' ? 0.3 + Math.random() * 0.45
      : 0.15 + Math.random() * 0.3;
  }
  windYaw = angLerp(windYaw, windTgtYaw, 1 - Math.exp(-0.5 * dt));
  windStr = lerp(windStr, windTgtStr, 1 - Math.exp(-0.7 * dt));
  if (windGainNode) {
    const storming = stormActive();
    const base = storming ? 0.95 : game.weather === 'rain' ? 0.75 : game.weather === 'cloudy' ? 0.55 : 0.3;
    windGainNode.gain.value = base * (0.5 + windStr * 0.9);
    if (windPanNode) windPanNode.pan.value = clamp(Math.sin(windYaw - player.camYaw), -1, 1) * (storming ? 1.0 : 0.7);
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
// ---------- the living clock ----------
// 1s of play = 1min of world time: a whole day wheels past in 24 minutes, and the sky
// blends smoothly through the phase palettes instead of jumping. Night holds solid
// 22:00-05:00, dawn breaks 05:00-07:00, then morning -> noon -> sunset -> dusk.
const PHASE_ANCHORS = [[1, 3], [5, 3], [7, 0], [13, 1], [18.5, 2], [22, 3], [25, 3]]; // [hour, PHASES idx]
function lerpHex(a, b, u) { return '#' + new THREE.Color(a).lerp(new THREE.Color(b), u).getHexString(); }
const _pmix = {};
function phaseMixAt(t) {
  if (t < PHASE_ANCHORS[0][0]) t += 24;
  let i = 0;
  while (i < PHASE_ANCHORS.length - 2 && t >= PHASE_ANCHORS[i + 1][0]) i++;
  let u = (t - PHASE_ANCHORS[i][0]) / (PHASE_ANCHORS[i + 1][0] - PHASE_ANCHORS[i][0]);
  u = u * u * (3 - 2 * u); // dwell at each anchor, glide between
  const A = PHASES[PHASE_ANCHORS[i][1]], B = PHASES[PHASE_ANCHORS[i + 1][1]];
  for (const k of ['top', 'mid', 'hor', 'sun', 'cloudC', 'cloudB', 'fog', 'hemiSky', 'hemiGnd', 'dirC', 'ambC']) _pmix[k] = lerpHex(A[k], B[k], u);
  for (const k of ['sunV', 'sunR', 'hemiI', 'dirI', 'ambI']) _pmix[k] = lerp(A[k], B[k], u);
  _pmix.dirPos = [lerp(A.dirPos[0], B.dirPos[0], u), lerp(A.dirPos[1], B.dirPos[1], u), lerp(A.dirPos[2], B.dirPos[2], u)];
  _pmix.nightW = (A.stars ? 1 - u : 0) + (B.stars ? u : 0);
  _pmix.starA = _pmix.nightW;
  return _pmix;
}
// the coarse phase 0-3 that gameplay systems key off (crickets, seeds, net compat)
function coarsePhase(t) { return t < 5 ? 3 : t < 10 ? 0 : t < 16 ? 1 : t < 20 ? 2 : 3; }
// ---------- the weather machine ----------
// rerolls every 5 minutes of play, 50% sunny / 50% cloudy — and when a cloudy spell
// reaches its halfway mark, rain has a 50% chance to muscle in for the back half.
// States crossfade over ~20s instead of snapping.
const wx = { from: 'sunny', to: 'sunny', u: 1, T: 300, half: false };
// storm system: lightning flashes + thunder claps/rolls ride on top of rainy weather
// and drag the wind and rain with them
let stormT = 0, lightningT = 0, stormNextT = 3 + Math.random() * 6;
function stormActive() { return stormT > 0; }
function wxWeights() {
  const w = { sunny: 0, cloudy: 0, rain: 0 };
  w[wx.from] += 1 - wx.u; w[wx.to] += wx.u;
  return w;
}
function wxSet(kind) { wx.from = wx.to = kind; wx.u = 1; game.weather = kind; }
function wxReset() { wxSet(Math.random() < 0.5 ? 'sunny' : 'cloudy'); wx.T = 300; wx.half = false; }
let skyRedrawT = 0;
function updateDayNight(dt) {
  game.clock = ((game.clock ?? 13) + dt / 60) % 24;
  game.phase = coarsePhase(game.clock);
  if (net.role !== 'client') { // the host owns the weather dice; clients follow snapshots
    wx.T -= dt;
    if (!wx.half && wx.T <= 150) {
      wx.half = true;
      if (wx.to === 'cloudy' && wx.u >= 1 && Math.random() < 0.5) { wx.from = 'cloudy'; wx.to = 'rain'; wx.u = 0; }
    }
    if (wx.T <= 0) {
      wx.T = 300; wx.half = false;
      const next = Math.random() < 0.5 ? 'sunny' : 'cloudy';
      if (next !== wx.to) { wx.from = wx.to; wx.to = next; wx.u = 0; }
    }
  }
  if (wx.u < 1) wx.u = Math.min(1, wx.u + dt / 20);
  game.weather = wx.u < 0.5 ? wx.from : wx.to;
  skyRedrawT -= dt;
  applyEnvironment(skyRedrawT <= 0);
  updateStorm(dt);
}
// the storm: lightning flashes ride the rainy weather — a bright bolt in the cloud
// shell, then thunder claps and rolls chasing it. The wind gusts and rain thickens
// with the storm's own rhythm. Runs every frame alongside updateDayNight.
function updateStorm(dt) {
  const inRain = game.weather === 'rain' || (wx.to === 'rain' && wx.u > 0.5);
  if (!inRain) { stormT = 0; return; }
  stormNextT -= dt;
  if (stormNextT <= 0) {
    // roll a lightning strike: 60% chance on each tick, more likely the longer it's been
    if (Math.random() < 0.6) {
      stormT = 0.4 + Math.random() * 0.5; // flash lasts 0.4-0.9s
      lightningT = stormT;
      // the flash: brighten the cloud fill/belly to a pale electric blue-white
      cloudUni.uFill.value.set(0xd8e4f0).lerp(new THREE.Color(0xffffff), 0.7);
      cloudUni.uBelly.value.set(0xc8d8e8).lerp(new THREE.Color(0xffffff), 0.6);
      // schedule the thunder — closer storms clap sooner, distant rolls drag
      const dist = 0.3 + Math.random() * 1.2; // 0.3-1.5s delay (roughly 100-500m)
      const loud = clamp(1.2 - dist * 0.7, 0.3, 1); // louder = closer
      setTimeout(() => {
        if (!actx) return;
        const baseF = 35 + Math.random() * 20;
        // sharp clap: a high burst that crackles and falls
        tone(baseF * 3.5 + Math.random() * 40, 0.08 + Math.random() * 0.06, 0.28 * loud, 'square', 80, ambGain);
        // the crack decays into a rolling rumble
        tone(baseF, 1.8 + Math.random() * 1.2, 0.2 * loud, 'sawtooth', 28, ambGain);
        setTimeout(() => tone(baseF * 0.65, 1.5 + Math.random() * 0.8, 0.12 * loud, 'sawtooth', 24, ambGain),
          200 + Math.random() * 300);
      }, dist * 1000);
    }
    stormNextT = 2 + Math.random() * 7; // next strike in 2-9s
  }
  // flash decay: stormT counts down, the cloud colors ease back to their rain palette
  if (stormT > 0) {
    stormT -= dt;
    if (stormT <= 0) {
      stormT = 0; lightningT = 0;
      applyEnvironment(true); // redraw the sky with normal rain colors
    }
  }
}
// lights and fog blend every frame (cheap); the sky/cloud canvases repaint at 1Hz,
// which is plenty for a day that moves a minute per second
function applyEnvironment(redraw = true) {
  const p = phaseMixAt(game.clock ?? 13);
  const W = wxWeights();
  if (redraw) { drawSky(p, W); skyRedrawT = 1; syncWeatherAmbience(); } // clouds are all-shader now — no repaint
  const dimD = W.sunny + W.cloudy * 0.55 + W.rain * 0.35;
  const dimH = W.sunny + W.cloudy * 0.85 + W.rain * 0.7;
  hemi.color.set(p.hemiSky); hemi.groundColor.set(p.hemiGnd); hemi.intensity = p.hemiI * dimH;
  moon.color.set(p.dirC); moon.intensity = p.dirI * dimD;
  moonOff.set(p.dirPos[0], p.dirPos[1], p.dirPos[2]);
  warm.color.set(p.ambC); warm.intensity = p.ambI;
  const fogC = new THREE.Color(p.fog);
  fogC.lerp(new THREE.Color(0x9aa0aa), 0.4 * W.cloudy);
  fogC.lerp(new THREE.Color(0x5c636e), 0.6 * W.rain);
  scene.fog.color.copy(fogC);
  // the draw-distance notch owns the fog reach (settings.fogFar); weather keeps its old
  // character as fractions of it (the same 105:92:70 and 28:24:16 ratios as before).
  // Because fogFar never exceeds the guaranteed streamed-ground radius, chunks and
  // everything standing on them are always born fully fogged — nothing pops in.
  const F = settings.fogFar;
  scene.fog.near = F * (0.267 * W.sunny + 0.229 * W.cloudy + 0.152 * W.rain);
  scene.fog.far = F * (W.sunny + 0.876 * W.cloudy + 0.667 * W.rain);
  scene.background.copy(fogC);
  rainOn(W.rain > 0.45);
  if (rainMesh) {
    const stormBoost = stormActive() ? 0.25 : 0; // rain thickens with the storm
    rainMesh.material.opacity = (0.4 + stormBoost) * Math.min(1, W.rain * 1.6);
  }
  // the storm's flash also lifts the scene's ambient and directional light briefly
  if (stormActive()) {
    const f = stormT / 0.9; // 1 → 0 as the flash decays
    hemi.intensity *= 1 + f * 0.6;
    moon.intensity *= 1 + f * 0.4;
  }
  setLampGlow(lampLitFor(game.clock ?? 13, W)); // the street lamps take over as the sky goes down
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
// coarse-pointer touch device? decided once, up here, because the default draw distance
// leans on it (phones start at the lightest notch) — the input code reuses it as isTouch
const IS_TOUCH = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
// notches: integer 0..5 per setting. `settings` holds the derived engine values.
const NOTCH_KEYS = ['master', 'sfx', 'music', 'mouseSens', 'padSens', 'drawDist', 'zombieSpawn', 'lootSpawn', 'gore', 'extraGore'];
const notches = { master: 3, sfx: 5, music: 3, mouseSens: 3, padSens: 3, drawDist: IS_TOUCH ? 0 : 2, zombieSpawn: 2, lootSpawn: 2, gore: 3, extraGore: 0 };
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
  // ambience rides the SFX notch now (its old default mix was 0.4 against sfx's 1.0, so the
  // scale keeps the balance) — the freed settings row went to draw distance
  settings.ambience = settings.sfx * 0.4;
  settings.mouseSens = SENS_MULT[notches.mouseSens];
  settings.padSens = SENS_MULT[notches.padSens];
  settings.zombieSpawn = SPAWN_MULT[notches.zombieSpawn];
  settings.lootSpawn = SPAWN_MULT[notches.lootSpawn];
  settings.gore = notches.gore / 5;
  settings.extraGore = notches.extraGore / 5;
  // draw distance: how many chunk rings stay live, and how far the fog lets you see.
  // fogFar (the sunny-weather cap) never exceeds the guaranteed streamed-ground radius
  // (viewR chunks = viewR*40 units in the worst standing spot), so the world is always
  // born behind the fog line, never in front of it. Phones default to the lightest
  // notch — same live-chunk cost as ever, minus the pop-in.
  settings.viewR = [2, 3, 3, 3, 4, 4][notches.drawDist];
  settings.fogFar = [76, 96, 108, 116, 136, 156][notches.drawDist];
}
syncDerived();

// ---------- audio (procedural, 3D) ----------
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, masterGain = null, sfxGain = null, musicGain = null, ambGain = null;
let sfxDest = null;
// set while the window is in the background: everything rides silent until they're back
let blurMuted = false;
function initAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  actx = new AC();
  masterGain = actx.createGain(); masterGain.gain.value = settings.master; masterGain.connect(actx.destination);
  sfxGain = actx.createGain(); sfxGain.gain.value = settings.sfx; sfxGain.connect(masterGain);
  musicGain = actx.createGain(); musicGain.gain.value = settings.music; musicGain.connect(masterGain);
  // the world starts silent: the picker is a quiet, black stage. Ambience only rises once a
  // run begins (rampWorldAudio, from startRun) and falls back to nothing on the way to the menu.
  ambGain = actx.createGain(); ambGain.gain.value = game.state === 'menu' ? 0 : settings.ambience; ambGain.connect(masterGain);
  startAmbience();
}
// fade the world's ambience up (run start) or down (back to the menu), so the world audio
// arrives and leaves with its black-veil visual instead of snapping on
function rampWorldAudio(target, secs) {
  if (!actx || !ambGain) return;
  const t = actx.currentTime;
  ambGain.gain.cancelScheduledValues(t);
  ambGain.gain.setValueAtTime(Math.max(0.0001, ambGain.gain.value), t);
  ambGain.gain.linearRampToValueAtTime(Math.max(0.0001, target), t + secs);
}
// iOS / iPadOS keeps a fresh AudioContext 'suspended' until it's resumed INSIDE a real user
// gesture AND a buffer has actually played through it — a bare resume() isn't enough, and a
// context first touched off-gesture never wakes (that's the "iPad has no sound" bug). So on
// the very first touch/click/key we init, resume, and push a one-sample silent buffer to
// unlock output; after that we just keep nudging resume() in case iOS re-suspends it.
let audioUnlocked = false;
function unlockAudio() {
  initAudio();
  if (!actx) return;
  if (actx.state === 'suspended') actx.resume();
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const src = actx.createBufferSource();
    src.buffer = actx.createBuffer(1, 1, actx.sampleRate);
    src.connect(actx.destination);
    src.start(0);
  } catch (e) {}
}
for (const ev of ['touchend', 'pointerdown', 'mousedown', 'keydown']) addEventListener(ev, unlockAudio, { passive: true });
// iOS drops the context back to 'suspended' when the tab backgrounds — wake it on return
document.addEventListener('visibilitychange', () => { if (!document.hidden && actx && actx.state === 'suspended') actx.resume(); });
function applyAudioSettings() {
  if (!actx) return;
  masterGain.gain.value = blurMuted ? 0 : settings.master;
  sfxGain.gain.value = settings.sfx;
  musicGain.gain.value = settings.music;
  ambGain.gain.value = game.state === 'menu' ? 0 : settings.ambience; // the menu stays a silent stage
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
  // the answer to reload()'s call: a higher chk-CHK that closes the wait when the mag seats
  reloadDone() { tone(900, 0.05, 0.22, 'square'); setTimeout(() => tone(1250, 0.08, 0.24, 'square'), 110); },
  // hold-to-trade completion: a bright two-note ping
  tradePing() { tone(920, 0.08, 0.3, 'sine', 1100); setTimeout(() => tone(1380, 0.16, 0.3, 'sine', 1600), 100); },
  // trade ACCEPTED: the soundoff chord from the very end of the opening medley — the family
  // all landing on one note together (see playOpeningTheme's closing sting)
  tradeAccept() { for (const n of [0, 4, 7, 12]) tone(NF(n), 1.4, 0.11, 'square'); },
  // launching a drop kick: a sharp cloth-snap whoosh. hard = off a slide hop, which
  // drops the pitch and leans on it for a heavier, meatier launch
  dropKick(hard) {
    noiseBurst(hard ? 0.16 : 0.12, hard ? 380 : 520, hard ? 0.5 : 0.36);
    tone(hard ? 150 : 210, hard ? 0.16 : 0.12, hard ? 0.34 : 0.24, 'square', hard ? 55 : 85);
  },
  // the boot landing: a low thud with a crack on top, harder off a slide hop
  dropKickHit(hard) {
    noiseBurst(hard ? 0.14 : 0.1, hard ? 260 : 380, hard ? 0.7 : 0.5);
    tone(hard ? 80 : 110, hard ? 0.2 : 0.14, hard ? 0.5 : 0.34, 'square', hard ? 32 : 48);
    if (hard) tone(240, 0.1, 0.28, 'sawtooth', 70);
  },
  // distinct mechanical "chk-chk" per gun when you cycle to it
  swap(w) {
    const id = w && w.id;
    if (id === 'shotgun') { noiseBurst(0.05, 260, 0.4); tone(150, 0.07, 0.3, 'square', 90); setTimeout(() => { noiseBurst(0.05, 220, 0.45); tone(110, 0.08, 0.32, 'square', 70); }, 120); }
    else if (id === 'sniper') { tone(320, 0.05, 0.28, 'square', 180); setTimeout(() => tone(240, 0.09, 0.3, 'sawtooth', 120), 150); }
    else if (id === 'magnum') { tone(520, 0.04, 0.28, 'triangle', 700); setTimeout(() => { noiseBurst(0.04, 500, 0.3); tone(180, 0.06, 0.3, 'square', 110); }, 110); }
    else if (id === 'rifle') { noiseBurst(0.04, 900, 0.3); tone(400, 0.05, 0.28, 'square', 260); setTimeout(() => tone(300, 0.06, 0.3, 'square', 200), 90); }
    else if (id === 'smg') { tone(680, 0.03, 0.26, 'square', 520); setTimeout(() => tone(560, 0.03, 0.26, 'square', 440), 60); setTimeout(() => tone(760, 0.03, 0.24, 'square', 600), 120); }
    else if (id === 'pistol') { tone(760, 0.04, 0.28, 'square', 560); setTimeout(() => tone(600, 0.05, 0.3, 'square', 440), 80); }
    // fists and armed melee each get their own switch cue, so swapping between the two is
    // audibly different: bare hands crack the knuckles; a melee weapon rings + hefts in the grip
    else if (id === 'fists') { noiseBurst(0.03, 420, 0.22); tone(220, 0.045, 0.2, 'square', 150); setTimeout(() => tone(170, 0.05, 0.2, 'square', 110), 75); }
    else if (w && w.melee) { noiseBurst(0.045, 760, 0.28); tone(540, 0.06, 0.24, 'triangle', 360); setTimeout(() => { noiseBurst(0.04, 300, 0.3); tone(340, 0.07, 0.26, 'sawtooth', 220); }, 95); }
    else { noiseBurst(0.05, 320, 0.25); } // anything else (e.g. the FPV toggle): soft whoosh
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
  // each weather roll has its own life on top of the wind bed: sunny = crickets at
  // night (daytime songbirds retired — the crows own the daylight air now, with their
  // own 3D caws), cloudy = far-off crows + low moaning gusts, rain = distant thunder
  (function weatherLife() {
    setTimeout(() => {
      if (actx) {
        if (game.weather === 'sunny') {
          if (game.phase === 3) {
            for (let i = 0; i < 6; i++) setTimeout(() => tone(3400 + Math.random() * 300, 0.035, 0.05, 'sine', undefined, ambGain), i * 85);
          }
        } else if (game.weather === 'cloudy') {
          if (Math.random() < 0.45) {
            for (let i = 0; i < 2 + ((Math.random() * 2) | 0); i++) setTimeout(() => tone(640 + Math.random() * 90, 0.15, 0.06, 'square', 390, ambGain), i * 290); // far-off crows
          } else {
            tone(230 + Math.random() * 90, 2.3, 0.045, 'sine', 115, ambGain); // hollow gust moan
          }
        } else if (Math.random() < 0.45) {
          // storm groans: the bosses answering the rain, rolling past the fog line
          const f = 52 + Math.random() * 24;
          tone(f * 0.9, 2.8, 0.18, 'sawtooth', 28, ambGain);
          setTimeout(() => tone(f * 0.65, 2.1, 0.12, 'sawtooth', 24, ambGain), 320 + Math.random() * 400);
          setTimeout(() => { if (Math.random() < 0.6) tone(f * 1.15, 0.4, 0.22, 'sawtooth', 40, ambGain); }, 180 + Math.random() * 200);
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
  // halved again: the rain is weather you notice, not weather you have to talk over
  rainGainNode.gain.setTargetAtTime(game.weather === 'rain' ? 0.045 : 0, actx.currentTime, 1.2);
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
let openingThemeUntil = 0; // while the opening medley holds the floor, solo snippets wait
function startTheme(id) {
  stopTheme();
  if (!actx) return;
  const t = THEMES[id] || THEMES.blingo;
  themeStep = 0;
  const tick = () => {
    // the persona beat is MENU music now — the picker, screens and the pause menu. During an
    // actual run the full looping cousin track (startGameMusic) owns the music bed instead,
    // so this stays quiet in gameplay to keep the two from stacking.
    const audible = actx && game.state !== 'playing';
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
  // the opening medley has the floor until it resolves: picking cousins stays silent
  // (the pickup click still answers), and the snippets come back the moment it lands
  if (!actx || performance.now() < openingThemeUntil) return;
  const t = THEMES[id] || THEMES.blingo;
  for (let i = 0; i < 4; i++) setTimeout(() => tone(NF(t.seq[i]), 0.16, 0.16, t.wave, undefined, musicGain), i * 120);
}
// the swapped-cousins theme: two chip voices walk each other's scale lines and finish on
// the other one's note — played through exactly once when two players trade skins, at
// whatever the settings music dial says (it rides musicGain like every other theme)
const SWAP_THEME = { tempo: 0.22, a: [12, 11, 9, 7, 5, 4, 2, 0], b: [0, 2, 4, 5, 7, 9, 11, 12], bass: [0, -5, -7, 0] };
function playSwapTheme() {
  if (!actx || !notches.music) return;
  const t = SWAP_THEME, n = t.a.length, step = t.tempo * 1000;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    setTimeout(() => {
      tone(NF(t.a[i]), t.tempo * (last ? 2.4 : 0.9), 0.11, 'square', undefined, musicGain);
      tone(NF(t.b[i]), t.tempo * (last ? 2.4 : 0.9), 0.11, 'triangle', undefined, musicGain);
      if (i % 2 === 0) tone(NF(t.bass[(i / 2) % t.bass.length] - 12), t.tempo * 1.6, 0.15, 'triangle', undefined, musicGain);
    }, i * step);
  }
  // the persona theme steps aside for the sting, then picks itself back up
  stopTheme();
  setTimeout(() => { if (!themeTimer) startTheme(selectedCousin); }, n * step + 600);
}
// the opening medley: all six persona motifs stitched into one march — four notes of
// each cousin in picker order, at a shared tempo but each still in their own chip
// voice — closing on the family chord. Plays exactly once, off the splash screen's
// wake-up gesture, and it rides musicGain at whatever the remembered music notch
// says: dial saved at zero means a silent opening, same as every other theme.
function playOpeningTheme() {
  if (!actx || !notches.music) return;
  const tempo = 0.21, per = 4;
  // claim the floor until the closing chord has rung out — previewTheme defers to this
  openingThemeUntil = performance.now() + COUSINS.length * per * tempo * 1000 + 120 + 1400;
  COUSINS.forEach((c, ci) => {
    const t = THEMES[c.id] || THEMES.blingo;
    for (let i = 0; i < per; i++) {
      const step = ci * per + i;
      setTimeout(() => {
        tone(NF(t.seq[i % t.seq.length]), tempo * 0.9, 0.12, t.wave, undefined, musicGain);
        if (step % 2 === 0) tone(NF(t.bass[(step / 2) % t.bass.length] - 12), tempo * 1.6, 0.15, 'triangle', undefined, musicGain);
      }, step * tempo * 1000);
    }
  });
  // the sting: everyone lands together
  setTimeout(() => { for (const n of [0, 4, 7, 12]) tone(NF(n), 1.4, 0.09, 'square', undefined, musicGain); },
    COUSINS.length * per * tempo * 1000 + 120);
}

// ---------- in-game music: the full cousin track, looped ----------
// The same six arrangements the /policies page previews (baked into themes.js, no .mid files),
// but run as a proper gameplay bed: the track's BODY (everything before its closing sting)
// plays through, then plays AGAIN a touch fuller — an octave lead laid over the lead line —
// and from there loops that second half forever. Twice as long as the preview, and it rolls
// into the loop instead of landing on the sting. It rides musicGain, so the pause-menu Music
// notch is its volume; at 0 it's silent (and the scheduler idles without emitting).
let ThemeAPI = null;             // themes.js, dynamically imported on first run that needs it
let themeApiPending = null;
let gameMusicGain = null;        // a fixed bed level under musicGain, so the arrangement sits
                                 // below the SFX rather than drowning them
const gmusic = { on: false, id: null, timer: null, body: null, bodyEnd: 0, program: null,
  idx: 0, pass: 0, passBase: 0 };
function ensureThemeAPI() {
  if (ThemeAPI) return Promise.resolve(ThemeAPI);
  if (!themeApiPending) themeApiPending = import('./themes.js').then(m => (ThemeAPI = m)).catch(() => (ThemeAPI = false));
  return themeApiPending;
}
async function startGameMusic(id) {
  if (!actx) return;
  await ensureThemeAPI();
  if (!ThemeAPI) return;
  stopGameMusic();
  const song = ThemeAPI.getSong(id);
  if (!song) return;
  if (!gameMusicGain) { gameMusicGain = actx.createGain(); gameMusicGain.gain.value = 0.6; gameMusicGain.connect(musicGain); }
  const be = ThemeAPI.songBodyEnd(song);
  gmusic.body = song.notes.filter(n => n.t < be - 0.001);   // drop the closing sting; loop the body
  gmusic.bodyEnd = be; gmusic.program = song.program;
  gmusic.id = id; gmusic.idx = 0; gmusic.pass = 0; gmusic.on = true;
  gmusic.passBase = actx.currentTime + 0.12;
  gmusic.timer = setInterval(gameMusicTick, 40);
}
function stopGameMusic() {
  gmusic.on = false;
  if (gmusic.timer) { clearInterval(gmusic.timer); gmusic.timer = null; }
}
// look-ahead scheduler: walk the body notes in order, wrapping at the end and bumping the
// loop base by one body-length each pass. Emits only what's inside the next 0.2s. When the
// music notch is 0, the tab is backgrounded, or we've slipped out of gameplay it keeps the
// clock rolling but stays silent, so raising the notch resumes right where it should.
function gameMusicTick() {
  if (!gmusic.on || !actx || !ThemeAPI) return;
  const emit = settings.music > 0 && game.state === 'playing' && !blurMuted;
  const now = actx.currentTime, look = now + 0.2;
  let guard = 0;
  while (guard++ < 600) {
    if (gmusic.idx >= gmusic.body.length) { gmusic.idx = 0; gmusic.passBase += gmusic.bodyEnd; gmusic.pass++; }
    const n = gmusic.body[gmusic.idx];
    const when = gmusic.passBase + n.t;
    if (when > look) break;
    if (emit && when > now - 0.05) {
      if (n.ch === 9) ThemeAPI.themeDrum(actx, gameMusicGain, n.note, when, n.vel);
      else {
        ThemeAPI.themeVoice(actx, gameMusicGain, n, gmusic.program, when);
        // from the second pass on, thicken the lead an octave up — the "new second half"
        // the track rolls into before it settles into its loop
        if (gmusic.pass >= 1 && n.ch === 0)
          ThemeAPI.themeVoice(actx, gameMusicGain, { ch: 0, note: n.note + 12, vel: n.vel, d: n.d }, gmusic.program, when, 0.45);
      }
    }
    gmusic.idx++;
  }
}

// ---------- rumble ----------
// The motors only answer to the pad: the moment a key or the mouse moves, input.device
// flips to 'kbm' and rumble goes silent — touch the stick again and it comes straight back.
let gpIndex = null;
let rumbleEnd = 0, rumblePeak = 0;
function rumble(ms, strong = 0.6, weak = 0.4) {
  if (gpIndex === null || input.device !== input.gamepadKind) return;
  const gp = navigator.getGamepads()[gpIndex];
  const act = gp && gp.vibrationActuator;
  if (!act) return;
  // playEffect replaces whatever is running, so a punchier effect outranks a weaker one
  // while it's still live — footstep ticks never stomp on a magnum going off.
  const now = performance.now();
  const peak = Math.max(strong, weak);
  if (now < rumbleEnd && peak < rumblePeak) return;
  rumbleEnd = now + ms; rumblePeak = peak;
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
  fists:   { id: 'fists',   name: 'Fists',        melee: true, slot: 'melee', dmg: 6, range: 2.4, rpm: 150, mag: Infinity, kick: 0.02, rmb: [130, 0.9, 0.55], cqc: 0, weak: true, dismember: 0.12 },
  // the consumables: family recipes with lore, not arms. Both swing exactly like fists
  // (same numbers, never break) — their real power fires elsewhere: the jelly is a
  // self-revive when you bleed out, the chili is 90 seconds of being the boss.
  jelly:   { id: 'jelly',   name: 'Good Jelly',   melee: true, slot: 'consumable', consumable: true, dmg: 6, range: 2.4, rpm: 150, mag: Infinity, kick: 0.02, rmb: [130, 0.9, 0.55], cqc: 0, weak: true, dismember: 0.12 },
  chili:   { id: 'chili',   name: "Red's Chili",  melee: true, slot: 'consumable', consumable: true, dmg: 6, range: 2.4, rpm: 150, mag: Infinity, kick: 0.02, rmb: [130, 0.9, 0.55], cqc: 0, weak: true, dismember: 0.12 },
  pipe:    { id: 'pipe',    name: 'Lead Pipe',    melee: true, slot: 'melee', dmg: 16, range: 3.1, rpm: 150, mag: Infinity, kick: 0.03, rmb: [80, 0.5, 0.3], cqc: 0, dismember: 0.28, color: 0x8b9099 },
  bat:     { id: 'bat',     name: 'Slugger Bat',  melee: true, slot: 'melee', dmg: 19, range: 3.4, rpm: 130, mag: Infinity, kick: 0.04, rmb: [90, 0.55, 0.35], cqc: 0, dismember: 0.34, color: 0x8a5a2a },
  machete: { id: 'machete', name: 'Machete',      melee: true, slot: 'melee', dmg: 23, range: 3.2, rpm: 155, mag: Infinity, kick: 0.03, rmb: [90, 0.5, 0.4], cqc: 0, dismember: 0.82, color: 0xb7bcc4 },
  katana:  { id: 'katana',  name: 'Katana',       melee: true, slot: 'melee', dmg: 27, range: 3.7, rpm: 175, mag: Infinity, kick: 0.03, rmb: [90, 0.5, 0.4], cqc: 0, dismember: 0.95, gib: true, color: 0xd8dde5 },
  sledge:  { id: 'sledge',  name: 'Sledgehammer', melee: true, slot: 'melee', dmg: 39, range: 3.1, rpm: 72, mag: Infinity, kick: 0.09, rmb: [150, 0.95, 0.5], cqc: 0, dismember: 0.6, gib: true, color: 0x5c6068 },
  axe:     { id: 'axe',     name: 'Fire Axe',     melee: true, slot: 'melee', dmg: 31, range: 3.2, rpm: 96, mag: Infinity, kick: 0.06, rmb: [120, 0.7, 0.45], cqc: 0, dismember: 0.9, gib: true, color: 0xc23a2a },
  pistol:  { id: 'pistol',  name: 'Pistol',       slot: 'gun', dmg: 5, mag: 18, rpm: 320, auto: false, spread: 0.012, ammo: 90,  color: 0x555a66, kick: 0.025, rmb: [60, 0.3, 0.5],  cqc: 0.45, weak: true,  dismember: 0.14, fRange: 14, oneHand: true },
  smg:     { id: 'smg',     name: 'SMG',          slot: 'gun', dmg: 2, mag: 50, rpm: 800, auto: true,  spread: 0.038, ammo: 200, color: 0x3a3f4a, kick: 0.015, rmb: [40, 0.2, 0.4],  cqc: 0.5,  weak: true,  dismember: 0.1, fRange: 9, oneHand: true },
  rifle:   { id: 'rifle',   name: 'Assault Rifle',slot: 'gun', dmg: 5, mag: 40, rpm: 560, auto: true,  spread: 0.022, ammo: 160, color: 0x51442e, kick: 0.02, rmb: [50, 0.35, 0.5],  cqc: 0.5,  dismember: 0.32, armSever: true, skullcrack: true, fRange: 30 },
  shotgun: { id: 'shotgun', name: 'Shotgun',      slot: 'gun', dmg: 2, mag: 10, rpm: 300, auto: false, spread: 0.11,  ammo: 60, pellets: 12, color: 0x6e3d1f, kick: 0.09, rmb: [150, 1, 0.7], cqc: 2.0, dismember: 0.75, gib: true, fRange: 7 },
  magnum:  { id: 'magnum',  name: 'Magnum',       slot: 'gun', dmg: 10, mag: 10, rpm: 160, auto: false, spread: 0.008, ammo: 60,  color: 0x8a8f9a, kick: 0.05, rmb: [140, 1, 0.75],  cqc: 0.6,  dismember: 0.6, gib: true, fRange: 18, oneHand: true },
  sniper:  { id: 'sniper',  name: 'Sniper Rifle', slot: 'gun', dmg: 22,mag: 8,  rpm: 45,  auto: false, spread: 0.002, ammo: 40,  color: 0x2f4a35, kick: 0.11, rmb: [260, 1, 1],  cqc: 0.2,  dismember: 1, gib: true, execute: true },
};
// inventory slot order: fists, then the consumables (grandma's jelly, Red's chili), then
// found melee by weight, then guns by tier
const SLOT_ORDER = ['fists', 'jelly', 'chili', 'pipe', 'bat', 'machete', 'katana', 'sledge', 'axe', 'pistol', 'smg', 'rifle', 'shotgun', 'magnum', 'sniper'];
function slotRank(id) { const i = SLOT_ORDER.indexOf(id); return i < 0 ? 99 : i; }
// point-blank damage multiplier for a hit at distance d
function closeBonus(w, d) { return 1 + (w.cqc || 0) * clamp(1 - d / 8, 0, 1); }
// bullets lose steam past a gun's comfy range (fRange, metres); snipers never drop off
function rangeFactor(w, d) {
  if (!w || w.melee || !w.fRange || d <= w.fRange) return 1;
  return Math.max(0.4, 1 - (d - w.fRange) * 0.035);
}
const LOOT_TABLE = [
  ['pistol', 20], ['smg', 16], ['shotgun', 15], ['rifle', 13], ['magnum', 9], ['sniper', 5], ['ammo', 14], ['medkit', 8],
];
const LOOT_GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'magnum', 'sniper'];
// guns nobody's handed you yet
function unownedGuns() { return LOOT_GUNS.filter(id => !player.owned.includes(id)); }
function rollLoot(rng) {
  let total = 0; for (const [, w] of LOOT_TABLE) total += w;
  let r = rng() * total;
  for (const [id, w] of LOOT_TABLE) { r -= w; if (r <= 0) return id; }
  return 'pistol';
}
// A box someone bothered to carry indoors and stash is worth going indoors for: most of the
// time it's a gun you're still missing, picked from what you're missing rather than rolled
// against the flat table and hoping. Once you're holding the whole armoury there's nothing
// left to hand you, so it pays out the ammo you'll always be shortest of instead.
const INDOOR_NEW_GUN_CHANCE = 0.7;
function rollCrateLoot(rng, crate) {
  if (!crate || !crate.indoor) return rollLoot(rng);
  const missing = unownedGuns();
  // fully kitted out: half the boxes feed the iron actually in your hands, half still
  // pay the scarcest rounds in the game — not every consolation is a sniper box now
  if (!missing.length) return rng() < 0.5 ? 'ammo' : 'sniperammo';
  if (rng() < INDOOR_NEW_GUN_CHANCE) return missing[(rng() * missing.length) | 0];
  return rollLoot(rng);
}

const MAGNUM_BIG = 1.3;   // how much heavier the magnum reads than the pistol it shares a frame with
function buildGunMesh(id) {
  const g = new THREE.Group();
  const w = WEAPONS[id];
  const c = w.color || 0x444444;
  if (id === 'pistol' || id === 'magnum') {
    // same frame both ways, but the magnum is a hand cannon — it should read heavier than
    // the sidearm in the fist, not like the same gun with a different name
    const s = id === 'magnum' ? MAGNUM_BIG : 1;
    const body = box(0.09 * s, 0.13 * s, 0.34 * s, c); body.position.set(0, 0.05 * s, -0.12 * s); g.add(body);
    const grip = box(0.08 * s, 0.18 * s, 0.1 * s, 0x2a2d33); grip.position.set(0, -0.08 * s, 0.06 * s); grip.rotation.x = 0.25; g.add(grip);
  } else if (id === 'smg') {
    const body = box(0.1, 0.14, 0.5, c); body.position.set(0, 0.04, -0.15); g.add(body);
    const magz = box(0.07, 0.22, 0.09, 0x22252b); magz.position.set(0, -0.12, -0.08); g.add(magz);
    const grip = box(0.08, 0.15, 0.09, 0x22252b); grip.position.set(0, -0.09, 0.1); g.add(grip);
  } else if (id === 'shotgun') {
    // AA-12: a squared full-auto receiver with a drum slung under its belly and a flat top
    // rail — no pump under the barrel to work, because there's nothing to work
    const body = box(0.13, 0.17, 0.6, 0x3b3e45); body.position.set(0, 0.05, -0.16); g.add(body);
    const rail = box(0.05, 0.03, 0.42, 0x22252b); rail.position.set(0, 0.15, -0.18); g.add(rail);
    const barrel = cyl(0.045, 0.05, 0.28, 0x2a2c30); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.06, -0.58); g.add(barrel);
    const shroud = box(0.09, 0.09, 0.14, 0x2a2c30); shroud.position.set(0, 0.06, -0.5); g.add(shroud);
    // the drum turned to face forward like a proper AA-12's, and dressed in black
    const drum = cyl(0.15, 0.15, 0.1, 0x14161a, 14); drum.rotation.x = Math.PI / 2; drum.position.set(0, -0.11, -0.13); g.add(drum);
    const grip = box(0.08, 0.16, 0.1, 0x22252b); grip.position.set(0, -0.08, 0.09); grip.rotation.x = 0.22; g.add(grip);
    const stock = box(0.09, 0.14, 0.2, c); stock.position.set(0, 0.04, 0.22); g.add(stock);
  } else if (id === 'rifle') {
    const body = box(0.09, 0.13, 0.72, 0x3b3e45); body.position.set(0, 0.05, -0.2); g.add(body);
    const magz = box(0.07, 0.2, 0.11, c); magz.position.set(0, -0.1, -0.1); magz.rotation.x = 0.3; g.add(magz);
    const stock = box(0.08, 0.12, 0.28, c); stock.position.set(0, 0.02, 0.24); g.add(stock); // stock lengthened a touch
    // longer barrel tube off the front end — the round leaves ITS tip now (muzzle anchor below)
    const barrel = cyl(0.03, 0.033, 0.4, 0x2a2c30); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.06, -0.76); g.add(barrel);
    // the front sight: a SLIM tab rising off the tube — its sides run exactly as wide as
    // the tube itself (no overhang past the barrel at all), the bottom is the flush arch
    // hugging the tube's upper half with zero gap, and the little V is notched from the
    // top-centre to aim through. The whole piece reads as welded straight onto the metal.
    const BR = 0.0305;              // the tube's radius where the plate sits = the tab's half-width
    const sShape = new THREE.Shape();
    sShape.moveTo(-BR, 0);          // left side meets the tube at its equator
    sShape.lineTo(-BR, 0.05);       // straight up the left side, tube-wide exactly
    sShape.lineTo(-0.008, 0.05);    // across the top to the divot
    sShape.lineTo(0, 0.036);        // down into the little V
    sShape.lineTo(0.008, 0.05);     // back up out of it
    sShape.lineTo(BR, 0.05);        // across to the right edge
    sShape.lineTo(BR, 0);           // straight down to the tube's equator
    sShape.absarc(0, 0, BR, 0, Math.PI, false); // the flush arch back over the tube — closes the outline
    sShape.closePath();
    const sGeo = new THREE.ExtrudeGeometry(sShape, { depth: 0.02, bevelEnabled: false });
    sGeo.translate(0, 0, -0.01);
    const sight = new THREE.Mesh(sGeo, mat(0x101216));
    sight.position.set(0, 0.06, -0.86);  // centred ON the barrel axis: the arch hugs the tube all round
    g.add(sight);
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
  } else if (id === 'jelly') {
    // grandma's jar in hand: purple glass under a waxed cap, the family cure-all
    const glass = cyl(0.11, 0.1, 0.24, 0xffffff, 10);
    glass.material = new THREE.MeshLambertMaterial({ color: 0x8a4dd0, emissive: 0x2a0d4a, emissiveIntensity: 0.55 });
    glass.position.y = -0.02; g.add(glass);
    const lid = cyl(0.12, 0.12, 0.04, 0xe8dcc0, 10); lid.position.y = 0.12; g.add(lid);
    const band = cyl(0.115, 0.115, 0.025, 0xb4642a, 10); band.position.y = 0.095; g.add(band);
    g.userData.reach = 0.5; // the melee carry needs a length, even for a jar
  } else if (id === 'chili') {
    // Red's own serving: a bowl with the chili still in it and a spoon standing proud
    const bowl = cyl(0.16, 0.11, 0.1, 0xd8cdb8, 10); bowl.position.y = -0.02; g.add(bowl);
    const chi = cyl(0.14, 0.14, 0.035, 0xffffff, 10);
    chi.material = new THREE.MeshLambertMaterial({ color: 0x8a2f1a, emissive: 0x1e0602, emissiveIntensity: 0.4 });
    chi.position.y = 0.035; g.add(chi);
    const spoon = box(0.025, 0.2, 0.015, 0xb9bdc4); spoon.position.set(0.05, 0.12, 0); spoon.rotation.z = -0.3; g.add(spoon);
    g.userData.reach = 0.5; // same: the carry pose reads it
  } else if (w.melee && id !== 'fists') {
    buildMeleeMesh(g, id, c);
  }
  // everything rides forward out of the fist rather than clipping back into it. Guns go
  // further than melee, whose handles are meant to sit near the knuckles anyway.
  if (id !== 'fists') g.position.z = w.melee ? -0.1 : -0.22;
  if (!w.melee) {
    // muzzle anchors track the geometry above: the magnum's rides out with its bigger frame,
    // the AA-12's sits at the tip of its short barrel rather than a pump's long one
    const tip = { pistol: [0.05, -0.3], magnum: [0.05 * MAGNUM_BIG, -0.3 * MAGNUM_BIG], smg: [0.04, -0.42],
      shotgun: [0.06, -0.72], rifle: [0.06, -0.96], sniper: [0.06, -1.14] }[id]; // rifle muzzle rides at the new barrel tip
    if (tip) {
      const muz = new THREE.Group();
      muz.position.set(0, tip[0], tip[1]);
      g.add(muz);
      g.userData.muzzle = muz;
    }
  }
  // beefier reads better on the blocky blobs: guns +20%, melee +35%
  g.scale.setScalar(w.melee ? 1.35 : 1.2);
  if (w.melee && id !== 'fists') {
    // measure the built blade once: how far it reaches past the fist. The carry frame
    // uses this to keep the tip riding just above the ground.
    const bb = new THREE.Box3().setFromObject(g);
    g.userData.reach = -bb.min.z;
  }
  return g;
}
// the low frame for held melee: the arm may hang at `base`, but it lifts exactly enough
// that the weapon tip rides just above the ground. This used to be the walking carry;
// with the rest pose now HIGH it serves as the swing's floor — where a down strike ends,
// blade kissing the dirt however high we're standing.
function meleeCarryLift(base, shoulderY, groundY, reach) {
  const L = 0.56 + (reach || 0.8);                 // shoulder -> fist -> weapon tip
  const room = clamp((shoulderY - groundY - 0.12) / L, 0, 1);
  return -Math.max(Math.abs(base), Math.acos(room));
}
// A swing that actually travels: cock AWAY from where the strike lands, whip through to
// `through`, then ease home. p is 0..1 across the swing. The whip is the fast quarter —
// smoothed on either side so the arm doesn't tick between poses. Fists still cock back
// and punch forward; a raised weapon cocks higher and comes DOWN.
function meleeSwing(p, ready, through) {
  const cock = ready + Math.sign(ready - through) * 0.6;
  if (p < 0.2) return lerp(ready, cock, smooth(p / 0.2));                         // wind up
  if (p < 0.45) return lerp(cock, through, smooth((p - 0.2) / 0.25));             // whip through
  return lerp(through, ready, smooth((p - 0.45) / 0.55));                         // recover to rest
}
// same arc, but it leaves from `home` and settles BACK to `home` instead of the style's
// ready pose — so a swing flows out of the weapon's idle hold and melts back into it
// with no snap on the last frame
function meleeSwingHome(p, home, ready, through) {
  const cock = ready + Math.sign(ready - through) * 0.6;
  if (p < 0.2) return lerp(home, cock, smooth(p / 0.2));
  if (p < 0.45) return lerp(cock, through, smooth((p - 0.2) / 0.25));
  return lerp(through, home, smooth((p - 0.45) / 0.55));
}
// the raised follow-through pose: a swing parks the weapon up here for a 1s hold, then
// the arm relaxes slowly back down to the low tip-skimming carry
const MELEE_REST = -2.45;
// every arm swings its own way. The x-drive (raise/plunge) is meleeSwing's; the style
// just re-voices the poses: jab = short thrust straight out (pipe, the consumables),
// side = horizontal roundhouse carried on rotation.z (bat, katana), diag = a high-out
// cross-body slash (machete), over = the big overhead chop (sledge, axe — heaviest arc).
const SWING_STYLE = {
  pipe: 'chop', jelly: 'jab', chili: 'jab',
  bat: 'side', katana: 'side',
  machete: 'diag',
  sledge: 'over', axe: 'over',
};
// each arm's own idle carry, not the shared tip-in-the-dirt drag: x = arm pitch,
// z = out-to-side tilt (mirrored for the lefty). rest = where it parks after a swing.
// The sledge stays off the list — too heavy for anything but the ground-drag carry.
// each arm's own idle carry: the bat, katana and axe ride STRAIGHT OUT in front —
// everything else (pipe, machete, sledge, the consumables) drags low off the ground
// carry. The NPCs read this same table, so they haul every weapon the way the hero
// does. z = out-to-side tilt, mirrored for the lefty.
const MELEE_HOLD = {
  bat:    { x: -1.55, z: 0, rest: -1.95 },  // straight out in front, slugger on deck
  katana: { x: -1.55, z: 0, rest: -1.95 },  // straight out in front, blade level
  axe:    { x: -1.55, z: 0, rest: -1.95 },  // straight out in front, head held high
};
// how long a fists chain stays live. Comfortably wider than the 0.4s fists rpm gap, so
// held-down punching always chains, but a real pause drops you back to a 6 opener.
const COMBO_WINDOW = 0.75;
// melee weapons sit in the same fist socket as guns, blade/head pointing forward (-z)
function shaftZ(len, r1, r2, color, near = 0.06) {
  const m = cyl(r1, r2, len, color, 8);
  m.rotation.x = Math.PI / 2;                 // lie the length along Z
  m.position.set(0, 0, near - len / 2);       // extend forward from just past the fist
  return m;
}
// the fire-axe head as one forged piece, traced off the reference's side silhouette:
// the pick spike rising off the top leaning into the blade, the long top, the blade
// face sweeping down, and the beard's belly curling back up to the eye — extruded thin
function axeBladeGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.58, -0.02);   // poll bottom, where the haft meets the head
  s.lineTo(-0.58, 0.09);    // poll top
  s.lineTo(-0.62, 0.11);
  s.lineTo(-0.66, 0.3);     // the pick's tip, up and leaning into the blade
  s.lineTo(-0.7, 0.1);
  s.lineTo(-0.78, 0.09);    // the long top out to the blade face
  s.lineTo(-0.83, -0.1);    // the blade face sweeping down
  s.lineTo(-0.84, -0.26);   // to the edge
  s.lineTo(-0.68, -0.22);   // the beard's belly curling back up
  s.lineTo(-0.6, -0.1);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.075, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 1 });
  g.rotateY(-Math.PI / 2);    // shape plane onto the weapon's z axis, thickness onto x
  g.translate(0.0375, 0, 0);
  return g;
}
// the dark cutting edge: the blade's bottom sweep as its own proud piece
function axeEdgeGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.83, -0.2);
  s.lineTo(-0.84, -0.26);
  s.lineTo(-0.82, -0.3);    // the very edge point
  s.lineTo(-0.68, -0.24);   // along the beard's bottom
  s.lineTo(-0.68, -0.22);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.077, bevelEnabled: false });
  g.rotateY(-Math.PI / 2);
  g.translate(0.0385, 0, 0);
  return g;
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
    // (the old angled "tip" box read as a tang sticking off the point — the blade ends clean now)
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
    // Blazo's fire axe: plain brown haft with the end knob, then the head as ONE forged
    // piece — the extruded silhouette with its pick spike and sweeping beard — plus the
    // dark cutting edge along the sweep and the eye slot inset on both faces
    g.add(shaftZ(0.88, 0.034, 0.046, 0x8a6b42));
    const knob = cyl(0.05, 0.056, 0.06, 0x7a5a36); knob.rotation.x = Math.PI / 2; knob.position.set(0, 0, 0.3); g.add(knob);
    g.add(new THREE.Mesh(axeBladeGeo(), mat(c)));
    g.add(new THREE.Mesh(axeEdgeGeo(), mat(0x23262b)));
    for (const sx of [-1, 1]) {
      const eye = box(0.012, 0.05, 0.15, 0x1c1e22);
      eye.position.set(sx * 0.039, 0.03, -0.64);
      g.add(eye);
    }
  }
}

// ---------- blob character builder ----------
// hands: override the mitt colour. The Crimson One wears his own dark red rather than
// the standard rot-green, so his swing reads as his.
function buildBlob({ color = 0xff8c42, zombie = false, scale = 1, gunHand = 'right', droopy = false, brain = false, blind = false, wounded = false, hands = 0 }) {
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

  const eyes = [], pupils = [];
  for (const s of [-1, 1]) {
    const eye = ball(0.13, blind ? 0xe2e6e2 : 0xffffff);
    eye.position.set(0.16 * s, droopy ? -0.02 : 0.05, 0.32);
    head.add(eye);
    const pupil = ball(0.055, blind ? 0xbfc3c6 : (zombie ? 0x7a1010 : 0x1a1a1a));
    pupil.position.set(0.16 * s, droopy ? -0.06 : 0.05, 0.415); // recessed flush with the cornea
    head.add(pupil);
    eyes.push(eye); pupils.push(pupil);
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
    const hand = box(0.28, 0.26, 0.28, hands || (zombie ? 0x8aa85a : 0xffd7a8));
    hand.position.y = -0.56;
    shoulder.add(hand);
    const knuck = box(0.3, 0.09, 0.14, hands ? darken(hands) : (zombie ? 0x789748 : 0xf0c898));
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

  // weapon socket: right hand by default (Blondie is the family lefty). rotated so the
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
  return { root, wob, head, arms, legs, gunSocket, gunArm, offArm: 1 - gunArm, body, skull, brainMesh, eyes, pupils, mouth, shadow, stainCount, skinList, flashT: 0,
           armGone: [false, false], legGone: [false, false], headGone: false };
}
// ---------- rot gore (the Rotten One and his sickness) ----------
// Anatomy dressings for the fourth boss and the walkers that rot while he stands. All
// positions are unscaled blob-local, so the same builder dresses a boss and a street walker.
// The chest is always the heart side (+x local). The hanging EYE, though, rolls a side per
// character (eyeSide): street rot and his minions hang left OR right, the Rotten One always
// left. Every piece is tracked into the blob's skinList so it flashes red when he's hit.
// palette: hearts wear the bloodstains' own deep red (BLOOD, 0x7a0f0f — declared later,
// so the hex is repeated here); ribs are BONE white; every opened interior (socket, chest,
// belly) shows brain-pink flesh, never the body's green
const ROT_PINK = 0xe89aa8, ROT_HEART = 0x7a0f0f, ROT_RIB = 0xd8cfc0, ROT_SOCKET = 0x1c0e10, ROT_CAV = 0xc76b80, ROT_FLESH = 0xd77a8e;
function addRotGore(blob, { hangEye = false, ribs = false, ribsR = false, belly = false, chestHole = false, eyeSide = 1 } = {}) {
  // pieces added AFTER buildBlob missed the skinList sweep, so gather them here and fold them
  // in — that's what makes the eye + open chest flash red under fire like the rest of the body.
  // Every wound piece renders at order -2 so the depth punches (below) can carve the green
  // skin away over them without also z-rejecting the wound details themselves.
  const rotFlash = [], track = m => { rotFlash.push(m); m.renderOrder = -2; return m; };
  // the actual CUT: an invisible copy of each cavity (front faces, depth-only) drawn at
  // order -1 — after the wound interior, before the body. Its front boundary sits proud of
  // the skin, so every green skin fragment inside the wound's footprint fails the depth test
  // and the hole truly opens: you see the pink interior, not skin stretched over it.
  const punchMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const punch = (parent, cav) => {
    const p = new THREE.Mesh(SPHERE, punchMat);
    p.scale.copy(cav.scale); p.position.copy(cav.position);
    p.renderOrder = -1;
    parent.add(p);
  };
  if (hangEye) {
    // that eye has let go. Take its eyeball + pupil out of the face entirely, and leave a
    // concave black socket where it sat — a dark sphere turned INSIDE-OUT (BackSide) and sunk
    // into the brow so you read the cup of an empty hole, not a ball stuck on. A tiny pit at
    // its back sells the depth. The eyeball itself now dangles below on a red optic stalk, off
    // one group so the whole thing swings with every head twitch (its sway is in updateZombies).
    const es = eyeSide < 0 ? -1 : 1, ei = es > 0 ? 1 : 0; // which original eye to pull out
    if (blob.eyes && blob.eyes[ei]) blob.eyes[ei].visible = false;
    if (blob.pupils && blob.pupils[ei]) blob.pupils[ei].visible = false;
    // the empty socket is backfilled with brain pink — you look into flesh, not into a
    // dark void (and never the body's green): pink cup, slightly deeper pink at the bottom
    const socket = new THREE.Mesh(SPHERE, mat(ROT_FLESH, { side: THREE.BackSide }));
    socket.scale.set(0.15, 0.17, 0.15);
    socket.position.set(0.16 * es, 0.05, 0.27);   // sunk in: the opening sits flush with the face
    blob.head.add(track(socket));
    punch(blob.head, socket);                     // carve the face skin away over the socket
    const pit = ball(0.06, 0xa84a5e); pit.position.set(0.16 * es, 0.05, 0.2); // the soft back of the hole
    blob.head.add(track(pit));
    const hang = new THREE.Group(); hang.position.set(0.16 * es, 0.0, 0.36);
    const stalk = cyl(0.02, 0.02, 0.26, 0x8a2430, 5);
    stalk.position.set(0, -0.12, 0.01); stalk.rotation.x = 0.22;
    hang.add(track(stalk));
    const eyeball = ball(0.11, 0xe8e4da); eyeball.position.set(0, -0.26, 0.05); hang.add(track(eyeball));
    const pupil = ball(0.05, 0x7a1010); pupil.position.set(0, -0.27, 0.14); hang.add(track(pupil));
    blob.head.add(hang);
    blob.hangEye = hang;
  }
  if (ribs || chestHole) {
    // the left chest laid open, on the heart side. Everything here rides on the TORSO SURFACE
    // (~0.45 out in z at chest height) — earlier it sat at z~0.2, buried inside the body, which
    // is why the chest read closed. A walker gets a slight tear; the boss gets the full gaping
    // hole with the heart plainly beating proud of the lip (his weak spot — see the isBoss4
    // sphere in the hitscan). The cut-out itself is the rot wound: PINK flesh inside (never
    // the body's green), BONE-white ribs arcing over it, and the heart in the mouth of the
    // hole wearing the bloodstains' own deep red.
    const deep = chestHole;
    const cx = deep ? 0.17 : 0.16, cy = deep ? 0.82 : 0.74, surf = deep ? 0.45 : 0.46;
    const cav = new THREE.Mesh(SPHERE, mat(ROT_CAV, { side: THREE.BackSide }));
    cav.scale.set(deep ? 0.26 : 0.18, deep ? 0.3 : 0.21, deep ? 0.24 : 0.17);
    cav.position.set(cx, cy, surf - (deep ? 0.12 : 0.09));
    blob.wob.add(track(cav));
    punch(blob.wob, cav);                  // cut the green chest skin away over the opening
    // the heart sits DOWN IN the cavity, tucked underneath the rib bars — recessed behind
    // the skin line so the ribs arc over it instead of the heart poking past the middle rib
    const heart = ball(deep ? 0.14 : 0.085, ROT_HEART);
    heart.position.set(cx, cy - 0.02, surf - (deep ? 0.06 : 0.04));
    blob.wob.add(track(heart));
    blob.rotHeart = heart; blob.rotHeartR = deep ? 0.14 : 0.085; // pulse base radius
    for (let i = 0; i < 3; i++) {          // bone-white rib bars arcing over the opening, proud of the skin
      const rib = box(deep ? 0.32 : 0.21, 0.035, 0.06, ROT_RIB);
      rib.position.set(cx, cy + (deep ? 0.14 : 0.1) - i * (deep ? 0.13 : 0.095), surf + (deep ? 0.07 : 0.05));
      rib.rotation.z = -0.22;
      blob.wob.add(track(rib));
    }
  }
  if (ribsR) {
    // the OTHER chest side, mirrored off the heart's: same opened cut and bone-white rib
    // bars arcing over it, but no heart in the mouth of the hole — nothing beats on this
    // side. Mutually exclusive with the heart-side roll at spawn; only a kill shot (the
    // shotgun's blast) opens this one onto a body already carrying the other
    const cx = -0.16, cy = 0.74, surf = 0.46;
    const cav = new THREE.Mesh(SPHERE, mat(ROT_CAV, { side: THREE.BackSide }));
    cav.scale.set(0.18, 0.21, 0.17);
    cav.position.set(cx, cy, surf - 0.09);
    blob.wob.add(track(cav));
    punch(blob.wob, cav);
    for (let i = 0; i < 3; i++) {
      const rib = box(0.21, 0.035, 0.06, ROT_RIB);
      rib.position.set(cx, cy + 0.1 - i * 0.095, surf + 0.05);
      rib.rotation.z = 0.22;                       // arc the mirrored way
      blob.wob.add(track(rib));
    }
  }
  if (belly) {
    // the stomach cut AWAY, not bulging out: a concave pocket opened low on the front —
    // an inside-out sphere whose rim sits at the skin line, so you look INTO the pink
    // under the model — with a couple of soft gut folds sitting recessed in the opening.
    // Nothing pokes proud of the body any more.
    const surf = 0.49;
    const cav = new THREE.Mesh(SPHERE, mat(ROT_PINK, { side: THREE.BackSide }));
    cav.scale.set(0.2, 0.16, 0.16);
    cav.position.set(-0.02, 0.5, surf - 0.11);   // rim proud of the surface; the cup opens inward
    blob.wob.add(track(cav));
    punch(blob.wob, cav);                        // cut the green belly skin away over the pocket
    for (let i = 0; i < 3; i++) {           // gut folds down IN the hole, behind the skin line
      const lobe = ball(0.05 + Math.random() * 0.025, ROT_FLESH);
      lobe.position.set(-0.02 + (Math.random() - 0.5) * 0.12, 0.5 + (Math.random() - 0.5) * 0.1, surf - 0.06);
      blob.wob.add(track(lobe));
    }
  }
  for (const m of rotFlash) blob.skinList.push({ mesh: m, mat: m.material });
}
// keep a blob's shadow pinned flat under its centre, projected onto whatever surface
// is below (terrain, car roofs, crates...) — it follows you up and slices onto lower tops
function placeShadow(blob, x, z, y) {
  if (!blob.shadow) return;
  const sy = supportTop(x, z, y === undefined ? groundHeight(x, z) : y, 0.1);
  // lifted enough to sit on road (+0.04) and parking (+0.05) surfaces too, not just grass
  blob.shadow.position.set(x, sy + 0.08, z);
}
// fold a mesh added AFTER buildBlob's skinList sweep (horns, blood stains, boss dressing)
// into the flash list, so every feature flashes with the body when the blob is shot
function foldSkin(blob, m) { blob.skinList.push({ mesh: m, mat: m.material }); return m; }
const FLASH_RED = new THREE.MeshBasicMaterial({ color: 0xff2525 });
const FLASH_GREEN = new THREE.MeshBasicMaterial({ color: 0x3ae06a }); // shielded boss: no damage taken — one green for EVERY boss
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
// how many chunk rings stay live comes off the Draw Distance notch now (settings.viewR)
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
// the tarmac is laid proud of the terrain it was poured over (roads +0.04, the big lot
// +0.05 — see the roadMat/lotMat terrainPlanes), so feet have to land on the asphalt's
// own surface instead of the dirt line buried underneath it
function groundLift(x, z) {
  if (Math.abs(x - LOT.x) <= LOT.hw && Math.abs(z - LOT.z) <= LOT.hd) return 0.05;
  return onRoad(x, z) ? 0.04 : 0;
}
function supportTop(x, z, feetY, maxStep = 0.45) {
  let top = groundHeight(x, z) + groundLift(x, z);
  for (const c of nearbyColliders(x, z)) {
    const ct = colTop(c, x, z); // roofs support at the shingle surface, wrecks at the tilted steel
    if (ct > feetY + maxStep || ct <= top) continue;
    let lx = x - c.x, lz = z - c.z;
    if (c.rot) {
      const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      const tx = lx * cs - lz * sn; lz = lx * sn + lz * cs; lx = tx;
    }
    if (Math.abs(lx) <= c.hw + 0.1 && Math.abs(lz) <= c.hd + 0.1) top = ct;
  }
  return top;
}
// how high a step a walker will mount without a jump. Building floor thresholds on
// graded lots sit above the approaching dirt, so this is generous enough to let the
// hero, cousins AND zombies climb in through a doorway instead of stalling at it — but
// still short of a loot crate (0.70 tall), car or roof, so nobody rides those by walking
// into one; those still want a jump.
const STEP_UP = 0.6;

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
// same ground-following approach as terrainPlane, but a fan disc instead of a grid — for round
// ground decals (floodlight pools) that need to ride the terrain's own tilt instead of sinking
// into it as a rigid flat circle would. The curve sink runs per-vertex in the shader, so a disc
// with only one rim ring can't bend with distance: `rings` subdivides the fan into concentric
// bands (roughly one per 2.5m of radius) and the pool flexes with the globe like the ground does
function terrainDisc(r, segs, cx, cz, material, lift = 0, rings = 0) {
  if (!rings) rings = Math.max(2, Math.round(r / 2.5));
  const geo = new THREE.RingGeometry(0.001, r, segs, rings);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, groundHeight(cx + pos.getX(i), cz + pos.getZ(i)) + lift);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, material);
  m.position.set(cx, 0, cz);
  return m;
}

// ---------- crates ----------
// indoor: a box someone stashed under a roof rather than one left lying in a field. Worth
// more when you open it — see rollLoot.
function makeCrate(rng, x, y, z, group, colliders, crateList, onShelf, indoor) {
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
  // the dressed-up find-me glow: gold pool + ring at the crate's feet, orb over the lid
  const glow = makeLootGlow(0xffdc78, { r: 0.78, y: 1.05, s: 1.7 });
  g.add(glow);
  g.position.set(x, y, z);
  g.rotation.y = rng() * TAU;
  group.add(g);
  // a shelf only ever stands inside a building, so anything on one is indoors by definition
  const crate = { mesh: g, lid, trim, glow, opened: false, shrink: 0, pos: new THREE.Vector3(x, y, z), t: rng() * 10, list: crateList, indoor: !!indoor || !!onShelf };
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

function makeShelf(rng, x, z, rotY, group, colliders, crateList, baseY) {
  // indoors the shelf stands ON the floorboards (baseY = the floor's top); outdoors it
  // keeps planting its feet a knuckle into the dirt like it always has
  const yb = baseY !== undefined ? baseY : groundHeight(x, z) - 0.1;
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
  s.position.set(x, yb, z);
  s.rotation.y = rotY;
  group.add(s);
  colliders.push(aabb(x, z, 1.0, 0.45, 1.85, yb));
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  for (const y of [0.485, 1.185]) {
    if (rng() < 0.62) {
      const off = (rng() - 0.5) * 1.2;
      const wx = x + cos * off, wz = z - sin * off;
      if (rng() < 0.55) makeCrate(rng, wx, yb + 0.1 + y, wz, group, colliders, crateList, true);
      else {
        const junk = box(0.3 + rng() * 0.2, 0.25 + rng() * 0.2, 0.3, [0x666f7a, 0x7a5a40, 0x505a44][(rng() * 3) | 0]);
        junk.position.set(wx, yb + 0.1 + y + 0.15, wz);
        group.add(junk);
      }
    }
  }
}

// window pane helper (plain dark glass)
function windowPane(rng, w, h) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), darkGlassMat);
}
// A REAL window: the wall is built as four slabs around a true hole — sill below,
// header above, a jamb either side — so a round fired through the opening flies clean
// through. Nobody walks through one (the sill is hip height and every slab keeps its own
// collider), but lead and eyes pass freely. variant 0 leaves the cutout bare; 1..3 nail
// wooden boards over the gap in three different half-hearted patterns. The boards are
// bare decoration with no collider: shots thread the gaps, which is the whole tactic.
//
// The whole thing — slabs AND boards — registers as ONE see-through peek entry against a
// single full-wall box, so when the camera fades the wall for the interior peek it
// dissolves the boarded window with it, exactly as if it were one solid panel. (Without
// this the boards, being their own meshes, stayed opaque and hung in the air.)
const WIN_W = 1.2, WIN_H = 0.9, WIN_SILL = 1.05;
// ONE welded wall slab with the porthole cut clean through it — a single extruded mesh
// built from a rectangle-with-a-hole, so when the peek fades it there's a single translucent
// surface and no seams (the old four-box build showed every join the instant it went
// see-through). Absolute world-Y is baked into the shape; the mesh only carries x/z.
function holedWallMesh(len, h, y0, t, wallC, horiz) {
  const bottom = y0 - 0.6, top = y0 + h;
  const sillY = y0 + WIN_SILL, headY = y0 + WIN_SILL + WIN_H;
  const shape = new THREE.Shape();
  shape.moveTo(-len / 2, bottom); shape.lineTo(len / 2, bottom);
  shape.lineTo(len / 2, top);     shape.lineTo(-len / 2, top);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-WIN_W / 2, sillY); hole.lineTo(WIN_W / 2, sillY);
  hole.lineTo(WIN_W / 2, headY);  hole.lineTo(-WIN_W / 2, headY);
  hole.closePath();
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
  geo.translate(0, 0, -t / 2);         // centre the thickness on the wall plane
  const m = new THREE.Mesh(geo, mat(wallC));
  ownMat(m);                           // private clone so the fade never touches other walls
  if (!horiz) m.rotation.y = Math.PI / 2; // swing the along-axis onto z for a wall that runs in z
  return m;
}
function wallWithWindow(group, colliders, x, z, horiz, len, t, h, y0, wallC, variant, shell, outDir = 1) {
  const topY = y0 + h;                 // walls span y0-0.6 .. y0+h, like every house wall
  const headY = y0 + WIN_SILL + WIN_H; // top of the opening
  const jambLen = (len - WIN_W) / 2;
  const peekMats = [];                 // every piece of this wall, faded as one
  // physics only — four invisible slab colliders ring the hole (sill, header, two jambs),
  // sized to overlap so nothing slips a corner. Being colliders, not meshes, they add no
  // seam; the single welded slab above is the whole visible wall.
  const slabCols = [
    [len, WIN_SILL + 0.6, y0 + (WIN_SILL - 0.6) / 2, 0],                       // sill run (full width)
    [len, topY - headY, (topY + headY) / 2, 0],                                // header run (full width)
    [jambLen, h + 0.6, y0 + h / 2 - 0.3, -(WIN_W + jambLen) / 2],              // jambs (FULL height)
    [jambLen, h + 0.6, y0 + h / 2 - 0.3, (WIN_W + jambLen) / 2],
  ];
  for (const [sl, sh, sy, off] of slabCols) {
    if (sl <= 0.01 || sh <= 0.01) continue;
    const sx = horiz ? x + off : x, sz = horiz ? z : z + off;
    colliders.push(aabb(sx, sz, horiz ? sl / 2 : t / 2, horiz ? t / 2 : sl / 2, sh, sy - sh / 2));
  }
  const wall = holedWallMesh(len, h, y0, t, wallC, horiz);
  wall.position.set(x, 0, z);
  group.add(wall);
  peekMats.push(wall.material);
  if (variant > 0) { // boarded over: planks nailed across the opening, past its edges
    const wood = [0x6a4a2c, 0x7a5836, 0x5c3f24];
    const midY = y0 + WIN_SILL + WIN_H / 2;
    // three layouts: lazy pair, threefold, the X-and-bar special. The 4th number is a depth
    // bias (metres, further proud of the wall): in the X-and-bar the two diagonals cross and
    // the top bar laps over both, so they'd co-plane and z-fight. Staggering their depth makes
    // the bar trump the two diagonals, and one diagonal trump the other where the X meets —
    // every overlap now has one clear winner. The other two layouts never overlap (their dy
    // gaps beat a board's own 0.16 height), so they stay flush at bias 0.
    const layouts = [
      [[0, -0.18, 0.1], [0, 0.2, -0.14]],
      [[0, -0.26, 0.06], [0, 0.02, -0.08], [0, 0.3, 0.12]],
      [[0, 0, 0.55, 0], [0, 0, -0.55, 0.02], [0, 0.34, 0.03, 0.045]],
    ];
    // boarded from BOTH sides, and never the same pattern twice: whoever held this
    // room reinforced the outside, then braced the inside with a different lattice —
    // it reads as work done on purpose, not one lucky nail-up. The inner variant
    // cycles deterministically off the outer so a restreamed chunk rebuilds identical.
    const innerVariant = (variant % 3) + 1;
    for (const [v, side] of [[variant, outDir], [innerVariant, -outDir]]) {
      for (const [off, dy, tilt, dep = 0] of layouts[v - 1]) {
        const proud = side * (t / 2 + 0.05 + dep); // dep lifts a board proud of its neighbours
        const b = box(WIN_W + 0.5, 0.16, 0.06, wood[(Math.abs(dy * 100) | 0) % 3]);
        b.position.set(horiz ? x + off : x + proud, midY + dy, horiz ? z + proud : z + off);
        b.rotation.z = horiz ? tilt : 0;
        b.rotation.x = horiz ? 0 : tilt;
        if (!horiz) b.rotation.y = Math.PI / 2;
        group.add(b);
        peekMats.push(ownMat(b)); // boards fade with the wall, never float when it clears
      }
    }
  }
  // one peek entry, one full-wall box (peek-only — the slab colliders above already do
  // the physics). segBox reads this exactly like a solid wall's collider would.
  if (shell) shell.push({ mats: peekMats,
    box: aabb(x, z, horiz ? len / 2 : t / 2, horiz ? t / 2 : len / 2, h + 0.6, y0 - 0.6),
    op: 1, want: 1 });
}

// sloped standable roof collider: one entry whose walkable top follows the pitch, so
// feet ride the shingle surface and walking up/down is smooth (no stair-hopping).
// ridge runs along x when axis='x' (slopes fall away in ±z), along z when axis='z'.
function roofSlope(colliders, bx, by, bz, axis, ridgeHalf, slopeHalf, rh) {
  const c = axis === 'x' ? aabb(bx, bz, ridgeHalf, slopeHalf, rh, by)
                         : aabb(bx, bz, slopeHalf, ridgeHalf, rh, by);
  c.roof = { axis, rh, slopeHalf };
  colliders.push(c);
}
// shingle-surface height of a sloped roof collider under (x,z)
function roofTopAt(c, x, z) {
  const d = c.roof.axis === 'x' ? Math.abs(z - c.z) : Math.abs(x - c.x);
  return c.y0 + c.roof.rh * clamp(1 - d / c.roof.slopeHalf, 0, 1);
}
// standable top of any collider under (x,z): a roof rides its pitched shingles, a flipped
// wreck rides its tilted undercarriage (a plane sloped in world x/z), everything else is the
// flat box top. One place so feet AND the side-shove gate agree on where the surface is.
function colTop(c, x, z) {
  if (c.roof) return roofTopAt(c, x, z);
  if (c.slope) return c.y1 + c.slope.gx * (x - c.x) + c.slope.gz * (z - c.z);
  return c.y1;
}
// pitched shingle roof + gables. Returns the peek entry (materials + the blocker box) so
// the house can fade its own roof out from over the hero — see updateHousePeek.
function addRoof(group, bx, by, bz, w, d, rng, colliders, gableC) {
  const rh = d * 0.32;
  // cloned: roofMats is shared by every house on the map, so fading the cached one
  // would ghost roofs chunks away
  const roofMat = roofMats[(rng() * roofMats.length) | 0].clone();
  roofMat.userData.owned = true;
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
  // the gable triangles wear the house's own wall colour — they ARE wall, not trim,
  // and the old mystery brown read as a third material the building never had
  const gmat = new THREE.MeshLambertMaterial({ color: gableC !== undefined ? gableC : 0x5d5044, side: THREE.DoubleSide });
  gmat.userData.owned = true; // already per-house, just needs disposing with the chunk
  for (const s of [-1, 1]) {
    const gable = new THREE.Mesh(ggeo, gmat);
    gable.rotation.y = Math.PI / 2;
    gable.position.set(bx + s * w / 2, by, bz);
    group.add(gable);
  }
  if (!colliders) return null;
  roofSlope(colliders, bx, by, bz, 'x', w / 2 + 0.45, d / 2 + 0.5, rh);
  // the slabs are pitched, but their collider's bounding box is a fine blocker to test
  // against — it errs a touch large, which only means the roof clears a shade early
  return { mats: [roofMat, gmat], box: colliders[colliders.length - 1], op: 1, want: 1 };
}

function makeBuilding(rng, bx, bz, group, colliders, crateList, pads) {
  const w = 7 + ((rng() * 5) | 0), d = 6 + ((rng() * 4) | 0), h = 2.6 + rng() * 1.2;
  const y0 = groundHeight(bx, bz);
  // pour the pad FIRST (its level sampled from the still-natural grade): from here on,
  // every groundHeight call inside the footprint — the shelf, the crates, the barrels'
  // apron, the terrain mesh built after us — answers with this one flat height
  if (pads) {
    // the pad stops AT the wall corners — only the interior is held dead flat, with a
    // short apron blending straight back to the natural grade. The old +0.9 skirt (plus
    // a 2m apron) reached far enough to re-grade a neighbouring landmark's ground.
    const pad = { x: bx, z: bz, hw: w / 2, hd: d / 2, apron: 1.2, y: y0 };
    flatPads.push(pad); pads.push(pad);
  }
  const wallC = [0x6b6154, 0x5d6068, 0x745f4d, 0x606a5d][(rng() * 4) | 0];
  const t = 0.35;
  const doorSide = (rng() * 4) | 0;
  const walls = [
    { x: bx, z: bz - d / 2, hw: w / 2, hd: t / 2, side: 0 },
    { x: bx, z: bz + d / 2, hw: w / 2, hd: t / 2, side: 1 },
    { x: bx - w / 2, z: bz, hw: t / 2, hd: d / 2, side: 2 },
    { x: bx + w / 2, z: bz, hw: t / 2, hd: d / 2, side: 3 },
  ];
  // The house shell fades slab by slab for the see-through peek, so each slab owns a
  // clone of the cached wall material and pairs with the collider just pushed for it.
  const shell = [];
  const peekSlab = (m) => shell.push({ mats: [ownMat(m)], box: colliders[colliders.length - 1], op: 1, want: 1 });
  // interior keep-out boxes in front of every opening: a shelf parked in a doorway walls you
  // out, one across a window plugs the firing port. Each opening is centred on its wall, so
  // its box spans the opening (± a shelf half-width) and reaches OPEN_IN into the room.
  const openings = [];
  const OPEN_IN = 2.2, OPEN_SIDE = 1.0;
  const keepOut = (wall, half) => {
    const horiz = wall.hw > wall.hd;
    if (horiz) {                                   // wall runs along x at z=wall.z; room is toward bz
      const z2 = wall.z + (Math.sign(bz - wall.z) || 1) * OPEN_IN;
      openings.push({ xlo: wall.x - half - OPEN_SIDE, xhi: wall.x + half + OPEN_SIDE,
                      zlo: Math.min(wall.z, z2), zhi: Math.max(wall.z, z2) });
    } else {                                       // wall runs along z at x=wall.x; room is toward bx
      const x2 = wall.x + (Math.sign(bx - wall.x) || 1) * OPEN_IN;
      openings.push({ zlo: wall.z - half - OPEN_SIDE, zhi: wall.z + half + OPEN_SIDE,
                      xlo: Math.min(wall.x, x2), xhi: Math.max(wall.x, x2) });
    }
  };
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
        peekSlab(m);
      }
      keepOut(wall, gap / 2);
    } else if (rng() < 0.75) {
      // a windowed wall is a REAL opening now, not painted glass: half the houses keep
      // the cutout bare (a firing port you can shoot in and out through), the other half
      // nailed boards over theirs in one of three patterns. Nobody fits through either
      // way — the sill slab is hip height — but bullets thread what the boards leave.
      const horiz = wall.hw > wall.hd;
      const variant = rng() < 0.5 ? 0 : 1 + ((rng() * 3) | 0);
      const outDir = horiz ? (wall.z > bz ? 1 : -1) : (wall.x > bx ? 1 : -1);
      wallWithWindow(group, colliders, wall.x, wall.z, horiz,
        horiz ? wall.hw * 2 : wall.hd * 2, t, h, y0, wallC, variant, shell, outDir);
      keepOut(wall, WIN_W / 2);
    } else {
      const m = box(wall.hw * 2, h + 0.6, wall.hd * 2, wallC);
      m.position.set(wall.x, y0 + h / 2 - 0.3, wall.z);
      group.add(m);
      colliders.push(aabb(wall.x, wall.z, wall.hw, wall.hd, h + 0.6, y0 - 0.6));
      peekSlab(m);
    }
  }
  const floor = box(w, 0.6, d, 0x4a453e);
  floor.position.set(bx, y0 - 0.24, bz);
  group.add(floor);
  // the boards are a real surface now: a walkable collider whose top matches the mesh,
  // so feet stand ON the floor (a 6cm sill over the pad — walked over, never noticed)
  colliders.push(aabb(bx, bz, w / 2 - t, d / 2 - t, 0.56, y0 - 0.5));
  const roofPeek = addRoof(group, bx, y0 + h - 0.05, bz, w, d, rng, colliders, wallC); // roof sits down onto the walls, standable
  if (roofPeek) shell.push(roofPeek); // the roof clears too, or looking down at the hero shows only shingles
  if (rng() < 0.85) {
    // hunt for interior floor the shelf can stand on without capping a door or a window; a
    // handful of tries almost always finds it, and if a small all-openings house has none the
    // shelf just sits this one out rather than walling something off
    for (let t2 = 0; t2 < 14; t2++) {
      const sx = bx + (rng() - 0.5) * (w - 3), sz = bz + (rng() - 0.5) * (d - 3);
      if (openings.some(o => sx > o.xlo && sx < o.xhi && sz > o.zlo && sz < o.zhi)) continue;
      makeShelf(rng, sx, sz, (rng() * 4 | 0) * Math.PI / 2, group, colliders, crateList, y0 + 0.06);
      break;
    }
  }
  // the floor crate lands somewhere the shelf that just went in isn't standing
  if (rng() < 0.7) {
    for (let t = 0; t < 10; t++) {
      const cx3 = bx + (rng() - 0.5) * (w - 2.5), cz3 = bz + (rng() - 0.5) * (d - 2.5);
      if (!spotClearOf(cx3, cz3, 0.7, colliders)) continue;
      makeCrate(rng, cx3, y0 + 0.08, cz3, group, colliders, crateList, false, true);
      break;
    }
  }
  // parked vehicle pulled up beside the house — 40% a pickup, rarely a work van
  if (rng() < 0.45) {
    const side = rng() < 0.5 ? -1 : 1;
    const truck = rng() < 0.4, van = !truck && rng() < 0.12;
    const cxr = bx + side * (w / 2 + (truck ? 3.2 : van ? 3.0 : 2.6)), czr = bz + (rng() - 0.5) * d;
    // parked ~parallel to the wall it pulled up beside (a fixed yaw, not dice) so the clearance
    // test below knows its footprint — and it reads as parked, not abandoned mid-spin
    const carYaw = (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.1;
    const chw = (truck ? 2.0 : van ? 1.9 : 1.8) / 2 + 0.15, chl = (truck ? 5.4 : van ? 4.8 : 4) / 2 + 0.15;
    // never on a road, never lapping a town landmark (the truck-in-the-Jelly-House bug), and
    // never into another vehicle already parked or piled up nearby — checked against every
    // car the world knows about, not just this chunk's
    if (!onRoad(cxr, czr, 1) && !inTown(cxr, czr, 2) && carSpotClearAll(cxr, czr, carYaw, chw, chl, colliders))
      makeCar(rng, cxr, czr, group, colliders, { broken: rng() < 0.6, truck, van, rotY: carYaw });
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
  return { x: bx, z: bz, hw: w / 2 + 0.5, hd: d / 2 + 0.5, shell,
    doorX, doorZ, doorOutX: doorX + outX * 2.2, doorOutZ: doorZ + outZ * 2.2,
    // roof ridge line (runs along x) — a crow perch
    roofY: y0 + h - 0.05 + d * 0.32, ridgeHW: Math.max(1, w / 2 - 0.6) };
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

// front of the car faces +z: windshield, headlights and front axle all sit that way.
// opts.truck: a bigger pickup — longer body with an open cargo bed, cab pushed forward,
// and wheels half again as large.
function makeCar(rng, x, z, group, colliders, opts = {}) {
  const y0 = groundHeight(x, z);
  const g = new THREE.Group();
  const truck = !!opts.truck;
  const van = !!opts.van && !truck; // a van is its own silhouette; truck wins a double-booking
  // the palette roll always spends its rng so world gen stays deterministic either way;
  // a roof-down van overrides it to matte black — the wrecked look the flip earns
  const roll = [0x7a3030, 0x30507a, 0x6a6a30, 0x555555, 0x8a6a2a, 0x3a6a5a][(rng() * 6) | 0];
  const c = opts.flipped && van ? 0x16171b : roll;
  // ride height up 25% across the fleet (body, cab, glass and tires all scaled together)
  const bodyW = truck ? 2.0 : van ? 1.9 : 1.8, bodyLen = truck ? 5.4 : van ? 4.8 : 4, bodyH = truck ? 0.78 : van ? 0.72 : 0.69;
  const bodyTop = bodyH + bodyH / 2;
  const body = box(bodyW, bodyH, bodyLen, c);
  body.position.y = bodyTop - bodyH / 2;
  g.add(body);
  // cab sits back on a car, forward over the front axle on a truck (leaving the bed
  // behind). On a van the "cab" IS the cargo shell: one tall box running from a stubby
  // hood at the front all the way back to the rear doors, nearly the body's full width.
  const cabZ = truck ? 0.95 : van ? -0.52 : -0.2, cabLen = truck ? 1.55 : van ? 3.72 : 1.7, cabH = truck ? 0.78 : van ? 1.18 : 0.63;
  const cabW = van ? bodyW - 0.12 : bodyW - 0.3;
  const cabY = bodyTop + cabH / 2;
  const cab = box(cabW, cabH, cabLen, c);
  cab.position.set(0, cabY, cabZ);
  g.add(cab);
  if (van) {
    // barn-door seam down the back panel, under the rear glass — reads as doors, costs a box
    const seam = box(0.05, cabH * 0.5, 0.04, 0x1c1e24);
    seam.position.set(0, bodyTop + cabH * 0.27, cabZ - cabLen / 2 - 0.01);
    g.add(seam);
  }
  if (truck) {
    // open cargo bed behind the cab: floor is the body top, the tailgate across the back,
    // and side walls that run the FULL bed — tucked a hand into the cab's rear wall and
    // over the tailgate's ends, so the tub reads as one welded piece instead of three
    // floating planks with daylight at both joins
    const cabRear = cabZ - cabLen / 2;
    const gateZ = -bodyLen / 2 + 0.1;
    const sideLen = (cabRear + 0.1) - (gateZ - 0.07);
    const sideZ = ((cabRear + 0.1) + (gateZ - 0.07)) / 2;
    for (const [px, sw, sd, pz] of [[0, bodyW, 0.14, gateZ],
                                    [-(bodyW / 2 - 0.07), 0.14, sideLen, sideZ],
                                    [bodyW / 2 - 0.07, 0.14, sideLen, sideZ]]) {
      const wall = box(sw, 0.53, sd, c);
      wall.position.set(px, bodyTop + 0.265, pz);
      g.add(wall);
    }
  }
  // glass strips (some cracked): flat to the body on all four sides now — no rake on the
  // windshield or rear glass, and the sides sit flush on the cab's own wall (bodyW-0.3)
  // rather than out at the wider body's edge, where they used to float past the cab in open air
  const winGlass = () => darkGlassMat;
  const EPS = 0.01;
  const cabHalfW = cabW / 2;
  // van glass rides the upper half of the tall shell; the windshield gets van height too
  const glassY = van ? cabY + 0.14 : cabY;
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(bodyW - 0.48, truck ? 0.53 : van ? 0.6 : 0.43), winGlass());
  windshield.position.set(0, glassY, cabZ + cabLen / 2 + EPS);
  g.add(windshield);
  const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(bodyW - 0.48, 0.4), winGlass());
  rearWin.position.set(0, glassY, cabZ - cabLen / 2 - EPS); rearWin.rotation.y = Math.PI; g.add(rearWin);
  // side glass: full cab length on cars and trucks; on a van just the driver's window up
  // front — the cargo panels behind it stay solid steel
  const swLen = van ? 0.85 : cabLen - 0.2, swZ = van ? cabZ + cabLen / 2 - 0.7 : cabZ;
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(swLen, 0.38), winGlass());
    side.position.set(sx * (cabHalfW + EPS), glassY, swZ); side.rotation.y = sx * Math.PI / 2; g.add(side);
  }
  // lamp details: warm headlights up front, red tails behind — mounted PROUD of the
  // body faces. They used to be centred a hair inside the box, outer face 5mm behind
  // the panel, so every lamp on every car in the game was invisible. Wrecks roll a
  // dead bulb per corner: dull plastic, no glow, like something already gave out.
  const frontZ = bodyLen / 2 + 0.01, rearZ = -bodyLen / 2 - 0.01, lampY = bodyTop - 0.12;
  for (const sx of [-1, 1]) {
    const hlDead = opts.broken && rng() < 0.35;
    const hl = box(0.3, 0.17, 0.06, hlDead ? 0x8f8a76 : 0xfff6d8, hlDead ? {} : { emissive: 0xffefb0, emissiveIntensity: 0.9 });
    hl.position.set(sx * (bodyW / 2 - 0.32), lampY, frontZ); g.add(hl);
    const tlDead = opts.broken && rng() < 0.35;
    const tl = box(0.26, 0.15, 0.06, tlDead ? 0x5f2626 : 0xff6a6a, tlDead ? {} : { emissive: 0xff2626, emissiveIntensity: 0.85 });
    tl.position.set(sx * (bodyW / 2 - 0.32), lampY, rearZ); g.add(tl);
  }
  const wr = truck ? 0.56 : 0.38, wA = truck ? 1.75 : van ? 1.6 : 1.3, wX = truck ? 0.92 : van ? 0.88 : 0.85;
  for (const [wx, wz] of [[-wX, wA], [wX, wA], [-wX, -wA], [wX, -wA]]) {
    const wheel = cyl(wr, wr, truck ? 0.35 : 0.28, 0x14161a);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, wr, wz);
    g.add(wheel);
  }
  g.position.set(x, y0, z);
  const yaw = opts.rotY !== undefined ? opts.rotY : rng() * TAU;
  g.rotation.y = yaw;
  let flipRoll = 0;
  if (opts.flipped) {
    // rolled a little as it came to rest — lies askew, not primly square. The collider below
    // carries this same roll as a slope so feet ride the tilted steel instead of a flat lid.
    flipRoll = (rng() - 0.5) * 0.3;
    g.rotation.z = Math.PI + flipRoll;
    g.position.y = y0 + (truck ? 2.0 : van ? 2.3 : 1.7); // roof-rest height rode the +25% up too
  }
  group.add(g);
  // tight oriented boxes: low body + narrower cabin. bullets skim past the hood
  // instead of hitting an invisible wall, and you can hop trunk -> roof.
  const hw = bodyW / 2 - 0.05, hl = bodyLen / 2 + 0.02;
  // full silhouette + a hand of daylight, tagged onto the body box so carSpotClear can run a
  // real oriented test against this wreck when the next car looks for a place to spawn
  const carFoot = { hw: bodyW / 2 + 0.15, hl: bodyLen / 2 + 0.15 };
  if (opts.flipped) {
    // roof-down, you stand on the UNDERCARRIAGE: the body's underside now faces the sky at
    // rest height minus half the body's thickness. The old tops (1.8/2.4/2.1) were set at
    // the upturned wheels, leaving feet floating half a metre over the visible steel.
    const restY = truck ? 2.0 : van ? 2.3 : 1.7;   // same roof-rest heights the flip sets above
    const flipCol = aabb(x, z, hw + 0.07, hl, restY - bodyH / 2, y0, yaw);
    flipCol.car = carFoot;
    // feet ride the tilted undercarriage, not a flat lid: the roll tips the steel about the
    // car's length axis, so the standable top is a plane sloped by that roll (walked like a
    // pitched roof's shingles). gx/gz are that plane's world-space height gradients — derived
    // from the flip's roll + yaw, so colTop rises toward the raised edge and falls to the low one.
    const tr = Math.tan(flipRoll);
    flipCol.slope = { gx: tr * Math.cos(yaw), gz: -tr * Math.sin(yaw) };
    colliders.push(flipCol);
  } else {
    const bodyCol = aabb(x, z, hw, hl, bodyTop, y0, yaw);
    bodyCol.car = carFoot;
    // a rider standing on an upright truck's body top is standing down IN the tub —
    // the bite gate below (inTruckBed) reads this flag and calls them unbiteable
    if (truck) bodyCol.bed = true;
    colliders.push(bodyCol);
    // cabin box hugs whatever the cab actually is (a van's shell runs wider and longer)
    colliders.push(aabb(x + cabZ * Math.sin(yaw), z + cabZ * Math.cos(yaw), cabW / 2 - 0.02, cabLen / 2 + 0.06, cabY + cabH / 2, y0, yaw));
    if (truck) {
      // the bed liner holds: tailgate + both side walls get their own thin boxes, so the
      // tub keeps whoever's riding in it from strolling out over the sides. Their tops are
      // standable like every collider top — 14cm of steel a careful jump can perch on —
      // and at 0.53 over the bed floor they're past the 0.45 step, so leaving takes a hop.
      const sn = Math.sin(yaw), cn = Math.cos(yaw);
      const cabRear = cabZ - cabLen / 2, gateZ = -bodyLen / 2 + 0.1;
      const sideLen = (cabRear + 0.1) - (gateZ - 0.07), sideZ = ((cabRear + 0.1) + (gateZ - 0.07)) / 2;
      const wallTop = bodyTop + 0.53;
      colliders.push(aabb(x + gateZ * sn, z + gateZ * cn, bodyW / 2, 0.07, wallTop, y0, yaw));
      for (const sx of [-1, 1]) {
        const lx = sx * (bodyW / 2 - 0.07);
        colliders.push(aabb(x + lx * cn + sideZ * sn, z - lx * sn + sideZ * cn, 0.07, sideLen / 2, wallTop, y0, yaw));
      }
    }
  }
}
// traffic pileup: cluster of wrecked cars, all broken windows, some flipped
// nothing solid already standing within r of (x,z). Everything scattered by dice — wrecks,
// crates — asks this first, because dice will happily roll a car through a shopfront or a
// loot box into a door panel, and the list is whatever's been built so far.
function spotClearOf(x, z, r, colliders) {
  for (const c of colliders) {
    if (Math.abs(x - c.x) < c.hw + r && Math.abs(z - c.z) < c.hd + r) return false;
  }
  return true;
}
// do two oriented rectangles overlap? SAT over both boxes' face normals (4 axes) — exact for
// rectangles, unlike spotClearOf's axis-aligned test which under-reads a spun car's diagonal
// and lets two wrecks pass while their panels still lie into each other.
function carsOverlap(ax, az, ayaw, ahw, ahl, bx, bz, byaw, bhw, bhl) {
  const dx = bx - ax, dz = bz - az;
  const rects = [[ayaw, ahw, ahl, byaw, bhw, bhl], [byaw, bhw, bhl, ayaw, ahw, ahl]];
  for (const [ry, rhw, rhl, oy, ohw, ohl] of rects) {
    const c = Math.cos(ry), s = Math.sin(ry), oc = Math.cos(oy), os = Math.sin(oy);
    for (const [nx, nz, half] of [[c, -s, rhw], [s, c, rhl]]) {           // r's two face normals
      const reach = Math.abs(oc * nx - os * nz) * ohw + Math.abs(os * nx + oc * nz) * ohl;
      if (Math.abs(dx * nx + dz * nz) > half + reach) return false;       // a separating axis
    }
  }
  return true;
}
// is this footprint clear of every car already placed in `colliders`? Every wreck tags its body
// box with `.car`, so this catches cross-pileup pileups and parked cars that spotClearOf's AABB
// pass would miss — nothing spawns lying into another vehicle.
function carSpotClear(x, z, yaw, hw, hl, colliders) {
  for (const c of colliders) {
    if (c.car && carsOverlap(x, z, yaw, hw, hl, c.x, c.z, c.rot, c.car.hw, c.car.hl)) return false;
  }
  return true;
}
// the spawn-time clearance a wreck actually needs: every car the WORLD already knows about,
// not just the chunk currently being built. carSpotClear used to read the chunk-local array
// only, so a pileup (or a parked house car) never saw wrecks in an already-built neighbour
// chunk or the town's fixed cars — that's how cars came out fused across the boundary. This
// checks the live 3×3 chunk set plus the town colliders instead; pass the building chunk's
// own array as `extra` too, since it isn't registered in `chunks` until it finishes building.
function carSpotClearAll(x, z, yaw, hw, hl, extra) {
  const all = nearbyColliders(x, z);
  return carSpotClear(x, z, yaw, hw, hl, extra ? extra.concat(all) : all);
}
function makePileup(rng, x, z, along, group, colliders) {
  const n = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const off = (i - n / 2) * 4.6 + (rng() - 0.5) * 1.6;
    const jitter = (rng() - 0.5) * 5.6; // scattered across both lanes now that roads are two-way
    const px = along === 'z' ? x + jitter : x + off;
    const pz = along === 'z' ? z + off : z + jitter;
    // trucks crashed among the cars now; vans are the rare sighting of the fleet
    const truck = rng() < 0.18, van = !truck && rng() < 0.08;
    const rotY = (along === 'z' ? 0 : Math.PI / 2) + (rng() - 0.5) * (rng() < 0.25 ? 2.5 : 0.5);
    // half footprint by silhouette (car 1.8x4, van 1.9x4.8, truck 2.0x5.4) plus a hand of daylight
    const hw = (truck ? 2.0 : van ? 1.9 : 1.8) / 2 + 0.15, hl = (truck ? 5.4 : van ? 4.8 : 4) / 2 + 0.15;
    // a wreck half-buried in a shop wall (or another wreck) reads as a bug, not a crash —
    // skip that one and let the pileup be a car lighter. The clearance grows with the
    // silhouette: a car is ~4.4 long (2.4 covers it however it spun), a van 4.8 (2.7),
    // a truck 5.4 (3.0) — so the longer bodies can never lie into a neighbour. The check
    // reads this chunk's colliders PLUS the world's (3×3 loaded chunks + town): buildChunk
    // hasn't registered itself in `chunks` yet while it runs, so neither list alone is enough.
    const worldCols = colliders.concat(nearbyColliders(px, pz));
    if (!spotClearOf(px, pz, truck ? 3.0 : van ? 2.7 : 2.4, worldCols)) continue;
    // oriented pass on top of the coarse spotClearOf: no wreck lies into another, whether it's
    // one already dropped in this pileup, the cross-street pileup, a truck parked by a house,
    // or one of the town's fixed cars
    if (!carSpotClear(px, pz, rotY, hw, hl, worldCols)) continue;
    makeCar(rng, px, pz, group, colliders, { broken: true, flipped: rng() < 0.3, truck, van, rotY });
  }
}

const grassMats = {};
function grassMat(hue) {
  const key = hue.toFixed(2);
  if (!grassMats[key]) grassMats[key] = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.26 + hue * 0.05, 0.3, 0.25 + hue * 0.05) });
  return grassMats[key];
}
const ROAD_GREY = 0x2c2e33;
const roadMat = new THREE.MeshLambertMaterial({ color: ROAD_GREY });
// the same pour as the road — same grey, off the same constant so they can never drift apart —
// but biased to win the depth test wherever it laps over the tarmac. That lets a slab bury its
// edge under the road rather than butt a hairline against it, with nothing visible to give the
// join away. (Reusing roadMat itself would put the offset on every road in the world.)
const roadJoinMat = new THREE.MeshLambertMaterial({ color: ROAD_GREY,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
const lotMat = new THREE.MeshLambertMaterial({ color: 0x35373d });

function buildChunk(cx, cz) {
  const rng = chunkRng(cx, cz);
  const group = new THREE.Group();
  const colliders = [];
  const crateList = [];
  const ox = cx * CHUNK, oz = cz * CHUNK;

  // roads on grid lines every 3 chunks (vertical centre ox-20, horizontal oz-17).
  // NOTE: only the FLAGS live up here — the terrain and road meshes themselves are built
  // at the BOTTOM of this function, after the buildings have registered their flat
  // interior pads, so the ground mesh samples the padded heights.
  const hasVRoad = ((cx % 3) + 3) % 3 === 0;
  const hasHRoad = ((cz % 3) + 3) % 3 === 0;

  const spots = [];
  function freeSpot(minDist, roadMargin = 2, townMargin = 4) {
    for (let tries = 0; tries < 12; tries++) {
      const x = ox + (rng() - 0.5) * (CHUNK - 8);
      const z = oz + (rng() - 0.5) * (CHUNK - 8);
      if (cx === 0 && cz === 0 && Math.hypot(x, z) < 8) continue;
      if (onRoad(x, z, roadMargin)) continue;
      if (inTown(x, z, townMargin)) continue;
      // spots only ever checked each other, so a crate could land inside a car or a rock
      // some earlier roll had already put there. Solid things get a say now too.
      if (!spotClearOf(x, z, 1.1, colliders)) continue;
      let ok = true;
      for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < minDist + s.r) { ok = false; break; }
      if (ok) { spots.push({ x, z, r: minDist }); return { x, z }; }
    }
    return null;
  }

  const buildings = [];
  const pads = [];
  const nB = rng() < 0.55 ? 1 + (rng() < 0.3 ? 1 : 0) : 0;
  for (let i = 0; i < nB; i++) {
    // houses keep a wide berth (14m) off every town/landmark rect: a house pad that laps
    // onto a landmark re-grades ground the landmark already built on (floating benches,
    // half-buried statue pads), and its parked truck needs the room too
    const p = freeSpot(10, 6, 14);
    if (p) buildings.push(makeBuilding(rng, p.x, p.z, group, colliders, crateList, pads));
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
  if (hasVRoad && rng() < 0.3 && !(cx === 0 && cz === 0) && !inTown(ox - 20, oz, 8)) {
    makePileup(rng, ox - 20, oz + (rng() - 0.5) * 16, 'z', group, colliders);
  }
  if (hasHRoad && rng() < 0.3 && !inTown(ox, oz - 17, 8)) {
    makePileup(rng, ox + (rng() - 0.5) * 16, oz - 17, 'x', group, colliders);
  }

  // terrain LAST: every building above has registered its flat pad by now, so the
  // ground mesh (and the road skins riding it) bake those pads into their vertices
  group.add(terrainPlane(CHUNK, CHUNK, 10, 10, ox, oz, grassMat(rng())));
  if (hasVRoad) group.add(terrainPlane(12.8, CHUNK, 5, 10, ox - 20, oz, roadMat, 0.04));
  if (hasHRoad) group.add(terrainPlane(CHUNK, 12.8, 10, 5, ox, oz - 17, roadMat, 0.04));
  // dotted yellow centre line between the two lanes, broken well clear of intersections
  for (const vert of [true, false]) {
    if (vert ? !hasVRoad : !hasHRoad) continue;
    for (let off = -CHUNK / 2 + 1.6; off < CHUNK / 2; off += 4.2) {
      const dxp = vert ? ox - 20 : ox + off;
      const dzp = vert ? oz + off : oz - 17;
      // skip dashes near a crossing: on a vertical road that's a horizontal road (z), on a
      // horizontal road that's a vertical road (x) — each axis has its own offset now
      if ((vert ? roadAxisDist(dzp) : roadAxisDistX(dxp)) < 8.4) continue;
      const dash = box(vert ? 0.16 : 1.7, 0.02, vert ? 1.7 : 0.16, 0xd8b62a);
      dash.position.set(dxp, groundHeight(dxp, dzp) + 0.075, dzp);
      group.add(dash);
    }
  }

  scene.add(group);
  return { group, colliders, crates: crateList, buildings, pads, cx, cz };
}
// the hollow chunk house whose footprint contains (x,z), or null — keeps spawns
// outdoors and lets zombies respect doorways instead of pressing through walls
function buildingAt(x, z) {
  // the permanent enterable town buildings (the Blob Lounge) answer first
  for (const bld of townBuildings) {
    if (Math.abs(x - bld.x) <= bld.hw && Math.abs(z - bld.z) <= bld.hd) return bld;
  }
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
// which doorway of a building serves (x,z) best — chunk houses have the one, the
// Blob Lounge keeps four, so walkers file through whichever is closest
function nearestDoor(bld, x, z) {
  if (!bld.doors) return { x: bld.doorX, z: bld.doorZ, outX: bld.doorOutX, outZ: bld.doorOutZ };
  let best = bld.doors[0], bd = Infinity;
  for (const dr of bld.doors) {
    const d = Math.hypot(dr.x - x, dr.z - z);
    if (d < bd) { bd = d; best = dr; }
  }
  return best;
}
// where a zombie presses when the prey is up on the roof: everyone converges on the nearest
// point of the building's WALL FACE, so the horde rings the building tight instead of pouring
// in the door. The aim sits on the wall itself (not beyond it, so nobody seeks the doorway);
// the surround branch below drops the walker's move-stop so it closes right up to the wall.
function surroundPoint(bld, x, z) {
  const hw = Math.max(bld.hw - 0.5, 0.4), hd = Math.max(bld.hd - 0.5, 0.4); // footprint minus its margin ≈ the wall faces
  const lx = clamp(x - bld.x, -hw, hw), lz = clamp(z - bld.z, -hd, hd);
  if (hw - Math.abs(lx) < hd - Math.abs(lz)) return [bld.x + Math.sign(lx || 1) * hw, bld.z + lz];
  return [bld.x + lx, bld.z + Math.sign(lz || 1) * hd];
}
// prey is up on this building's roof rather than down on its floor: horizontally inside
// the footprint but lifted well above the pad it stands on
function onRoofOf(bld, ty) { return ty - groundHeight(bld.x, bld.z) > 1.4; }

function chunkKey(cx, cz) { return cx + ',' + cz; }

// ---------- geometry clipmap ground ----------
// The world only STREAMS near the player (live chunks carry the buildings, loot and
// colliders), but the ground itself now runs to the horizon on a stable geometry
// clipmap: a dense core under the live chunks, then concentric LOD rings that double
// their cell size with every step out, so vertex density lives near the camera and
// the far field costs almost nothing. Each level snaps to its own fixed world lattice
// (twice its cell), so a vertex only ever samples groundHeight at points it has
// sampled before — heights never swim as the player moves, they just extend. Live
// chunks draw their detailed terrain over the top; past the stream radius the clipmap
// IS the ground, and the fog line owns the far end of it. This replaces the old
// visited-chunk corridor silhouettes — every direction keeps a floor now, not just
// the ground already walked.
const CLIP_LEVELS = [
  { cell: 5, half: 80 },    // solid core: live-chunk territory, hidden under real terrain
  { cell: 10, half: 160 },  // rings: each level doubles the reach of the one inside it
  { cell: 20, half: 320 },
  { cell: 40, half: 640 },
  { cell: 80, half: 1280 },
];
// one quiet wasteland tone, the average of the live grass mats — by the time the
// clipmap is the visible ground it's mostly fog anyway, so the seam never reads
const clipMat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.285, 0.3, 0.26) });
const clipLevels = []; // {panels, group, cell, sink, ox, oz}
{
  CLIP_LEVELS.forEach((L, i) => {
    // every level rides a little lower than the one inside it, and ring holes are cut
    // one cell smaller than the level they frame — that tuck-under overlap is what
    // seals the seams (no T-junction stitching, nothing to flicker through)
    const sink = 0.22 + 0.2 * i;
    const group = new THREE.Group();
    const panels = [];
    const rects = []; // plan rects [x0,z0,x1,z1] local to the level origin
    if (i === 0) rects.push([-L.half, -L.half, L.half, L.half]);
    else {
      const hx = CLIP_LEVELS[i - 1].half - L.cell;
      rects.push([-L.half, -L.half, L.half, -hx], [-L.half, hx, L.half, L.half],
                 [-L.half, -hx, -hx, hx], [hx, -hx, L.half, hx]);
    }
    for (const [x0, z0, x1, z1] of rects) {
      const w = x1 - x0, d = z1 - z0;
      const geo = new THREE.PlaneGeometry(w, d, w / L.cell, d / L.cell);
      geo.rotateX(-Math.PI / 2);
      geo.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
      const mesh = new THREE.Mesh(geo, clipMat);
      group.add(mesh);
      panels.push(mesh);
    }
    scene.add(group);
    clipLevels.push({ group, panels, cell: L.cell, sink, ox: null, oz: null });
  });
}
function clipDisplace(lv) {
  for (const mesh of lv.panels) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, groundHeight(lv.ox + pos.getX(i), lv.oz + pos.getZ(i)) - lv.sink);
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
  }
}
function updateClipmap(px, pz) {
  for (const lv of clipLevels) {
    // snap to twice the cell so vertices keep landing on the same world lattice
    const s = lv.cell * 2;
    const ox = Math.round(px / s) * s, oz = Math.round(pz / s) * s;
    if (ox === lv.ox && oz === lv.oz) continue;
    lv.ox = ox; lv.oz = oz;
    lv.group.position.set(ox, 0, oz);
    clipDisplace(lv); // only the level that actually snapped re-samples its heights
  }
}

function updateChunks(px, pz) {
  const R = settings.viewR; // live-chunk rings off the Draw Distance notch
  const ccx = Math.round(px / CHUNK), ccz = Math.round(pz / CHUNK);
  // mid-run, chunk building is BUDGETED: crossing a chunk line used to raise every missing
  // chunk in the ring in one frame — a visible hitch, worst on phones. Now at most two go
  // up per frame, nearest first; the fog + the ground clipmap cover the beat a far chunk's
  // dressing takes to arrive. Menus and run-starts still build the whole ring at once
  // (nobody is watching the frame clock there, and spawning wants solid ground NOW).
  const missing = [];
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    const key = chunkKey(ccx + dx, ccz + dz);
    if (!chunks.has(key)) missing.push([key, ccx + dx, ccz + dz, dx * dx + dz * dz]);
  }
  if (missing.length) {
    missing.sort((a, b) => a[3] - b[3]);
    const budget = game.state === 'playing' ? 2 : missing.length;
    for (let i = 0; i < Math.min(budget, missing.length); i++)
      chunks.set(missing[i][0], buildChunk(missing[i][1], missing[i][2]));
  }
  for (const [key, ch] of chunks) {
    if (Math.abs(ch.cx - ccx) > R + 1 || Math.abs(ch.cz - ccz) > R + 1) unloadChunk(key, ch);
  }
  updateClipmap(px, pz);
}
// tear one streamed chunk all the way down — shared by the distance cull above and the
// prestige rebuild (which flushes EVERY chunk so the terrain re-irons to the new rects)
function unloadChunk(key, ch) {
  scene.remove(ch.group);
  ch.group.traverse(o => {
    if (o.geometry && o.geometry !== BOX && o.geometry !== SPHERE && o.geometry !== shadowGeo) o.geometry.dispose();
    if (o.material && o.material.userData.owned) o.material.dispose(); // per-house shell clones
  });
  // drop any half-faded slab of this chunk before its materials go
  if (ch.buildings) for (const bld of ch.buildings) for (const s of bld.shell) peeking.delete(s);
  for (const cr of ch.crates) {
    const i = allCrates.indexOf(cr);
    if (i >= 0) allCrates.splice(i, 1);
  }
  // the flat pads leave with their houses, or the terrain here would stay ironed
  // forever for a building that no longer exists
  if (ch.pads) for (const p of ch.pads) {
    const i = flatPads.indexOf(p);
    if (i >= 0) flatPads.splice(i, 1);
  }
  chunks.delete(key);
}
function nearbyColliders(x, z) {
  const out = [];
  const ccx = Math.round(x / CHUNK), ccz = Math.round(z / CHUNK);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const ch = chunks.get(chunkKey(ccx + dx, ccz + dz));
    if (ch) out.push(...ch.colliders);
  }
  // box covers the whole permanent build — recomputed per layout, since a prestige remix
  // can deal the landmark blocks anywhere around the heart of town
  if (x > TOWN_BOUND.x0 && x < TOWN_BOUND.x1 && z > TOWN_BOUND.z0 && z < TOWN_BOUND.z1) out.push(...townColliders);
  return out;
}
function resolveCollision(x, z, r, y) {
  for (const c of nearbyColliders(x, z)) {
    if (y !== undefined) {
      // standing on top of it (roofs: on the local shingle surface, so the box never
      // shoves us sideways while we're walking the pitch)
      if (y >= colTop(c, x, z) - 0.25) continue;
      if (c.y0 > y + 1.5) continue;     // walking underneath (awnings etc.)
      // pitched roofs (the chili cabana, house roofs) are standable tops only, never a
      // side wall: the collider is one flat-height box across the WHOLE footprint even
      // though the shingles taper down toward the eaves, so jumping up near a low roof
      // can land your centre "inside" that big flat footprint while still well under the
      // real sloped surface. That used to fall into the tunnelling rescue below, which
      // ejects through the nearest face of the box — for a roof this size, an instant
      // snap clear across the footprint (read as a teleport). Skip roofs outright here;
      // the on-top check above already keeps their surface standable and solid.
      if (c.roof) continue;
    }
    if (c.rot) {
      // oriented box: work in the collider's local frame
      const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      const wx = x - c.x, wz = z - c.z;
      let lx = wx * cs - wz * sn, lz = wx * sn + wz * cs;
      if (Math.abs(lx) < c.hw && Math.abs(lz) < c.hd) {
        // centre INSIDE the box: a hard knock tunneled it past the surface in one frame
        // (the clamp math below sees zero depth there and would shrug). Eject through the
        // nearest side face — for a thin wall that's the way it came in.
        if (c.hw - Math.abs(lx) < c.hd - Math.abs(lz)) lx = Math.sign(lx || 1) * (c.hw + r);
        else lz = Math.sign(lz || 1) * (c.hd + r);
        x = c.x + lx * cs + lz * sn;
        z = c.z - lx * sn + lz * cs;
        continue;
      }
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
      if (Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd) {
        // same tunneling rescue as the oriented branch, in world axes
        if (c.hw - Math.abs(x - c.x) < c.hd - Math.abs(z - c.z)) x = c.x + Math.sign(x - c.x || 1) * (c.hw + r);
        else z = c.z + Math.sign(z - c.z || 1) * (c.hd + r);
        continue;
      }
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
// ray vs a pitched roof's ACTUAL shingle surface (its two slope planes), not the crude
// bounding box the collider carries. A round that clears the roofline passes over instead
// of being swallowed by the box — that's what lets a crow perched on the ridge get shot.
// Returns the nearest t where the ray crosses a shingle within the roof's footprint, else Infinity.
function rayRoof(ox, oy, oz, dx, dy, dz, c) {
  const rh = c.roof.rh, sh = c.roof.slopeHalf, k = rh / sh, ridgeTop = c.y0 + rh;
  const alongX = c.roof.axis === 'x';          // ridge runs along x -> slopes fall off in z
  let best = Infinity;
  for (const s of [1, -1]) {                   // the two facing slopes
    const along = alongX ? (oz - c.z) : (ox - c.x);       // offset from ridge, on the slope axis
    const alongD = alongX ? dz : dx;
    const den = dy + s * k * alongD;
    if (Math.abs(den) < 1e-8) continue;
    const t = (ridgeTop - oy - s * k * along) / den;
    if (t <= 0 || t >= best) continue;
    const hx = ox + dx * t, hz = oz + dz * t;
    // within the ridge's length, and on this slope's side within one slope's run
    if (alongX) { if (Math.abs(hx - c.x) > c.hw || (hz - c.z) * s < 0 || (hz - c.z) * s > sh + 1e-4) continue; }
    else        { if (Math.abs(hz - c.z) > c.hd || (hx - c.x) * s < 0 || (hx - c.x) * s > sh + 1e-4) continue; }
    best = t;
  }
  return best;
}
function raySphere(ox, oy, oz, dx, dy, dz, sx, sy, sz, r) {
  const lx = sx - ox, ly = sy - oy, lz = sz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  return tca - Math.sqrt(r * r - d2);
}
// does the segment a->b pierce this collider? slab test, axis-aligned only (house wall
// slabs never carry a rot). pad widens the box so a graze counts as a block.
function segBox(ax, ay, az, bx, by, bz, c, pad = 0) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let t0 = 0, t1 = 1;
  const slab = (o, d, lo, hi) => {
    if (Math.abs(d) < 1e-6) return o >= lo && o <= hi;
    let ta = (lo - o) / d, tb = (hi - o) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    return t0 <= t1;
  };
  return slab(ax, dx, c.x - c.hw - pad, c.x + c.hw + pad) &&
         slab(az, dz, c.z - c.hd - pad, c.z + c.hd + pad) &&
         slab(ay, dy, c.y0 - pad, c.y1 + pad);
}
// coarse ray-vs-terrain — tested against the DRAWN ground: every sample lifts the ray
// by that spot's globe sink, so a shot skimming the horizon flies exactly as far as it
// looks like it should instead of biting into flat dirt the curve already lowered
function rayGround(ox, oy, oz, dx, dy, dz, maxT) {
  let prev = oy + curveDrop(ox, oz) - groundHeight(ox, oz);
  for (let t = 2; t <= maxT; t += 2) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const dh = y + curveDrop(x, z) - groundHeight(x, z);
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
const townPads = []; // the poured east-side pads, so a prestige rebuild can lift them back out
// ---------- the prestige rebuild ----------
// Tear the standing town down to bare ground and raise it again on the freshly dealt
// anchors (applyLayout must run FIRST), then flush every streamed chunk so the terrain
// re-irons itself to the new rects. The heart of town rebuilds identically (same seed);
// only the five outer landmark blocks land somewhere new.
function rebuildTownWorld() {
  townGroup.traverse(o => { if (o.geometry && o.geometry !== BOX && o.geometry !== SPHERE && o.geometry !== shadowGeo) o.geometry.dispose(); });
  townGroup.clear();
  for (const cr of townCrates) { const i = allCrates.indexOf(cr); if (i >= 0) allCrates.splice(i, 1); }
  townCrates.length = 0;
  townColliders.length = 0;
  townBuildings.length = 0;
  graveSpots.length = 0;
  shopDoors.length = 0;
  parkFlowers.length = 0;
  butterflies.length = 0;         // their groups died with townGroup; buildButterflies re-mints them
  peeking.clear();                // no half-faded shell may outlive the walls it belonged to
  for (const p of townPads) { const i = flatPads.indexOf(p); if (i >= 0) flatPads.splice(i, 1); }
  townPads.length = 0;
  jellyBar.jars.length = 0; jellyBar.glow = null;             // the consumable stations rebuild with their halls
  chiliBar.bowls.length = 0; chiliBar.glow = null; chiliBar.surf = null;
  fountainFx = null;
  buildTown();
  for (const [key, ch] of [...chunks]) unloadChunk(key, ch);
  updateChunks(0, 0);             // runs start at the origin: iron the ground under the spawn now
}
const townBuildings = []; // permanent enterable buildings (the Blob Lounge) — buildingAt checks these too
let fountainFx = null; // animated water on the plaza fountain — filled in buildTown, run by updateFountain

// (the old fog-free "town skyline" silhouette LODs — church, bank, town hall,
// courthouse — are gone: the globe curve keeps real geometry honest at distance
// now, sliding it below the horizon instead of popping it, so the stand-ins had
// nothing left to stand in for)
scene.add(townGroup);

// civic building: colonnaded facade on the faceDir side (+1 = faces +z, -1 = faces -z)
function grandBuilding(x, z, w, d, h, wallColor, label, rng, faceDir = -1) {
  const y0 = groundHeight(x, z);
  const peekKit = []; // every visible piece joins the camera-peek fade unit at the end
  const body = box(w, h, d, wallColor);
  body.position.set(x, y0 + h / 2, z);
  townGroup.add(body); peekKit.push(body);
  townColliders.push(aabb(x, z, w / 2, d / 2, h, y0));
  const fz = z + faceDir * d / 2; // facade plane, turned toward the road
  // full-height columns whose capitals meet the portico slab above
  for (let i = 0; i < 4; i++) {
    const col = cyl(0.28, 0.32, h, 0xd8d2c4, 10);
    col.position.set(x - w / 4 + i * (w / 6), y0 + h / 2, fz + faceDir * 1);
    townGroup.add(col); peekKit.push(col);
  }
  // portico roof: underside rests on the column tops; standable, feet on the slab top
  const roofSlab = box(w + 1, 0.3, d + 2.6, 0x8b8577);
  roofSlab.position.set(x, y0 + h + 0.15, z + faceDir * 0.8);
  townGroup.add(roofSlab); peekKit.push(roofSlab);
  townColliders.push(aabb(x, z + faceDir * 0.8, (w + 1) / 2, (d + 2.6) / 2, 0.3, y0 + h));
  const pedShape = new THREE.Shape();
  pedShape.moveTo(-w * 0.4, 0); pedShape.lineTo(w * 0.4, 0); pedShape.lineTo(0, 2.2); pedShape.closePath();
  const ped = new THREE.Mesh(new THREE.ShapeGeometry(pedShape), new THREE.MeshLambertMaterial({ color: 0xcfc9ba, side: THREE.DoubleSide }));
  ped.position.set(x, y0 + h + 0.28, fz + faceDir * 1.1);
  townGroup.add(ped); peekKit.push(ped);
  // Steps climb TOWARD the building: you meet the low wide one out front off the road, then
  // the taller one tucked behind it against the columns. They used to run backwards — the
  // tall one sat outermost, so you stepped up onto it and then back down to reach the door.
  // [depth, centre y, distance out from the facade]
  for (const [depth, yc, zd] of [[1.1, 0.11, 1.85], [0.55, 0.33, 1.575]]) {
    const step = box(w * 0.55, 0.22, depth, 0xbab4a6);
    step.position.set(x, y0 + yc, fz + faceDir * zd);
    townGroup.add(step);
  }
  // name plate mounted flat on the wall face, behind the columns
  const plate = textPlate(label, Math.min(w * 0.45, 9), Math.min(w * 0.11, 2.2));
  plate.position.set(x, y0 + h - Math.min(w * 0.07, 1.4), fz + faceDir * 0.06);
  plate.rotation.y = faceDir > 0 ? 0 : Math.PI;
  townGroup.add(plate); peekKit.push(plate);
  // facade: a big grand entrance where the centre window used to be — same dark slab as the
  // chapel door, scaled up for a civic front — flanked by the two side windows
  const rrng = rng || Math.random;
  const dW = Math.min(w * 0.22, 3.4), dH = Math.min(h * 0.6, 4.6);   // bigger than the chapel's
  // a pale stone surround, then the dark door face proud of it, so it reads as a doorway cut
  // into the wall rather than a flat panel
  const surround = box(dW + 0.5, dH + 0.4, 0.08, 0xbdb7a8);
  surround.position.set(x, y0 + (dH + 0.4) / 2 - 0.2, fz + faceDir * 0.02);
  townGroup.add(surround); peekKit.push(surround);
  const door = box(dW, dH, 0.16, 0x241a12);
  door.position.set(x, y0 + dH / 2, fz + faceDir * 0.06);
  townGroup.add(door); peekKit.push(door);
  for (const i of [-1, 1]) {
    const win = windowPane(rrng, 1.4, 1.6);
    win.position.set(x + i * (w / 3.2), y0 + h * 0.42, fz + faceDir * 0.03);
    win.rotation.y = faceDir > 0 ? 0 : Math.PI;
    townGroup.add(win); peekKit.push(win);
  }
  // the whole civic front — walls, columns, portico, door, windows, name plate — fades
  // as one unit for the camera peek
  registerTownPeek(aabb(x, z + faceDir * 0.8, (w + 1) / 2, (d + 2.6) / 2, h + 0.45, y0), peekKit);
}

// the big lot north of the plaza: floodlit at its corners, and the ground the Infected One
// rises on. One definition so the lights, the boss and his arena can't drift apart.
const LOT = { x: 42, z: 36, hw: 29, hd: 13 };
const LOT_MASTS = [[LOT.x - LOT.hw + 1.6, LOT.z - LOT.hd + 1.6], [LOT.x + LOT.hw - 1.6, LOT.z - LOT.hd + 1.6],
                   [LOT.x - LOT.hw + 1.6, LOT.z + LOT.hd - 1.6], [LOT.x + LOT.hw - 1.6, LOT.z + LOT.hd - 1.6]];
// The lot is floodlit from its own four corners now. A little lamp standing inside it — or
// crowding the foot of a mast three times its height — is just clutter competing with a
// light it can't compete with. The frontage lamps out along the middle still earn their keep.
function lotIsFloodlit(x, z) {
  if (Math.abs(x - LOT.x) < LOT.hw + 0.5 && Math.abs(z - LOT.z) < LOT.hd + 0.5) return true;
  return LOT_MASTS.some(([mx, mz]) => Math.hypot(mx - x, mz - z) < 6);
}
const shopDoors = [];   // every shopfront's doorstep, filled in as the town is built
// ---------- camera wall-peek for the town's solid buildings ----------
// Every shop / civic front registers its whole face kit here — walls plus the features ON
// those walls (doors, windows, signs, awnings) — as one fade unit. updateHousePeek clears
// any unit standing between the third-person camera and the hero, so a camera clipped into
// an alley nook never buries the view behind a shopfront.
const townPeek = [];
function registerTownPeek(bx, meshes) {
  const mats = [];
  for (const m of meshes) m.traverse(o => { if (o.isMesh) mats.push(ownMat(o)); });
  townPeek.push({ mats, box: bx, op: 1, want: 1 });
}
function shopBuilding(x, z, w, d, h, faceDir, label, rng) {
  const y0 = groundHeight(x, z);
  const wallC = [0x7a6a55, 0x6a707a, 0x7d6a62, 0x6d7a68][(rng() * 4) | 0];
  const body = box(w, h, d, wallC);
  body.position.set(x, y0 + h / 2, z);
  townGroup.add(body);
  // flat roof is standable: collider tops out on the parapet slab, the surface you see
  townColliders.push(aabb(x, z, w / 2 + 0.1, d / 2 + 0.1, h + 0.4, y0));
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
  // remember the step outside every shop door: the Infected One empties the whole parade
  // through them, and a wave has to come out of a doorway rather than through a wall
  shopDoors.push({ x: x + w * 0.32, z: fz + faceDir * 0.9 });
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
  // the shop and everything mounted on it fade as one for the camera peek
  registerTownPeek(aabb(x, z, w / 2 + 0.3, d / 2 + 0.8, h + 0.4, y0),
    [body, parapet, win, door, awn, plate]);
}

// gateN: leave the first gateN stall lines of the FIRST row unpainted (and keep cars out
// of the slots they'd frame). The big lot's SW corner is where the angled driveway throat
// comes in — lines painted straight across it read as stalls blocking the entrance, so
// that corner stays bare tarmac a driver could actually pull through.
function parkingLot(x, z, w, d, rows, rng, gateN = 0) {
  townGroup.add(terrainPlane(w, d, 16, 10, x, z, lotMat, 0.05)); // dense enough to bend with the curve, no faceted seams
  const lineMat = mat(0xd8d8d0);
  for (let r = 0; r < rows; r++) {
    const rz = z - d / 2 + (r + 0.5) * (d / rows);
    const nLines = Math.floor(w / 3.2) - 1;
    const skip = r === 0 ? gateN : 0; // row 0 is the south row, the one the throat opens onto
    for (let i = skip; i < nLines; i++) {
      const lx = x - w / 2 + 2.4 + i * 3.2;
      const line = new THREE.Mesh(BOX, lineMat);
      line.scale.set(0.14, 0.02, 2.6);
      line.position.set(lx, groundHeight(lx, rz) + 0.09, rz);
      townGroup.add(line);
    }
    // abandoned cars sit properly inside the painted stalls, nose-in or backed-in — and in
    // a big lot (deep enough rows) some are pickup trucks nosed straight into the space
    for (let i = skip; i < nLines - 1; i++) {
      if (rng() < 0.3) {
        const sx = x - w / 2 + 2.4 + i * 3.2 + 1.6;
        makeCar(rng, sx, rz, townGroup, townColliders, {
          broken: rng() < 0.7,
          truck: w > 30 && d / rows > 7.5 && rng() < 0.3,
          rotY: (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.08,
        });
      }
    }
  }
}

// ---------- old church + spiked graveyard (north of the plaza) ----------
// dirt-mound positions the dead claw out of — the ambient spawner and the Crimson
// One's grave waves both draw from this list
const graveSpots = [];
const CHURCH = { x: 25, z: 81 };                       // nave runs N-S; main door faces the road (south), graveyard on the east flank
const GRAVEYARD = { x0: 40, z0: 70, x1: 58, z1: 92 };  // spike-fenced plot east of the church
// the strip between the church side door and the graveyard gate: where the Crimson One lies
// once the block is scoured, and the patch of ground this whole town's infection leaks from
const CHURCHYARD = { x: 35, z: 81 };
function buildChurchyard(rng) {
  const ironMat = mat(0x23262c);
  // nave runs north-south: w is the (narrow) east-west width, d the long axis toward the road
  const cx = CHURCH.x, cz = CHURCH.z, w = 11, d = 16, h = 5.2;
  const y0 = groundHeight(cx, cz);
  // front is the NORTH wall — that's the side that actually faces a real road (the z=103
  // horizontal road runs just past it). The door used to be on the south wall, which faced
  // nothing but open field back toward the plaza's parking lot, away from any road.
  const northZ = cz + d / 2, eastX = cx + w / 2, westX = cx - w / 2; // front + both flanks
  // weathered stone body
  const body = box(w, h, d, 0x6b6a62);
  body.position.set(cx, y0 + h / 2, cz);
  townGroup.add(body);
  townColliders.push(aabb(cx, cz, w / 2, d / 2, h, y0));
  // pitched shingle roof, ridge running down the nave (N-S); gable ends face the road & the rear
  const rh = w * 0.34;
  const roofMat = roofMats[(rng() * roofMats.length) | 0];
  const slopeLen = Math.hypot(w / 2 + 0.5, rh);
  const rang = Math.atan2(rh, w / 2 + 0.5);
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(BOX, roofMat);
    slab.scale.set(slopeLen, 0.12, d + 0.9);
    slab.position.set(cx + s * (w / 4 + 0.12), y0 + h - 0.05 + rh / 2, cz);
    slab.rotation.z = -s * rang;
    townGroup.add(slab);
  }
  const gshape = new THREE.Shape();
  gshape.moveTo(-w / 2, 0); gshape.lineTo(w / 2, 0); gshape.lineTo(0, rh); gshape.closePath();
  const ggeo = new THREE.ShapeGeometry(gshape);
  const gmat = new THREE.MeshLambertMaterial({ color: 0x4a4038, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const gable = new THREE.Mesh(ggeo, gmat);
    gable.position.set(cx, y0 + h - 0.05, cz + s * d / 2);
    townGroup.add(gable);
  }
  roofSlope(townColliders, cx, y0 + h - 0.05, cz, 'z', d / 2 + 0.45, w / 2 + 0.5, rh); // scalable nave roof
  // bell tower + spire + leaning cross over the front (road-side) entrance
  const ridgeY = y0 + h - 0.05 + rh;
  const steepleZ = northZ - 2.4;
  const tower = box(2.6, 3.4, 2.6, 0x615f58);
  tower.position.set(cx, ridgeY + 0.9, steepleZ);
  townGroup.add(tower);
  for (const s of [-1, 1]) { // dark bell slats on the tower's road-facing (front/back) sides
    const slat = box(1.1, 1.1, 0.06, 0x14121a);
    slat.position.set(cx, ridgeY + 1.5, steepleZ + s * 1.31);
    townGroup.add(slat);
  }
  const spire = cyl(0.02, 1.85, 2.8, 0x1f1d24, 4);
  spire.position.set(cx, ridgeY + 4, steepleZ);
  spire.rotation.y = Math.PI / 4; // 4-sided cone's corners default to the box's face centers; twist to cap the tower's faces instead
  townGroup.add(spire);
  const crossV = box(0.08, 0.95, 0.08, 0x14121a);
  crossV.position.set(cx, ridgeY + 5.75, steepleZ); crossV.rotation.z = 0.09; // slightly askew
  townGroup.add(crossV);
  const crossH = box(0.5, 0.08, 0.08, 0x14121a);
  crossH.position.set(cx - 0.02, ridgeY + 5.92, steepleZ); crossH.rotation.z = 0.09;
  townGroup.add(crossH);
  // tall dark windows down both flanks — the east-flank (graveyard-side) centre is left open
  // for the side door
  for (const wz of [-5, 0, 5]) for (const s of [-1, 1]) {
    if (s > 0 && wz === 0) continue;
    const win = windowPane(rng, 1.0, 2.4);
    win.position.set(cx + s * (w / 2 + 0.03), y0 + h * 0.5, cz + wz);
    win.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    townGroup.add(win);
  }
  // black rose window over the main door, facing the road
  const rose = new THREE.Mesh(new THREE.CircleGeometry(0.85, 18), darkGlassMat);
  rose.position.set(cx, y0 + h + 0.9, northZ + 0.06);
  townGroup.add(rose);
  // heavy main door facing the road, with a couple of worn steps
  const door = box(2.2, 2.6, 0.12, 0x241a12);
  door.position.set(cx, y0 + 1.3, northZ + 0.06);
  townGroup.add(door);
  // two SOLID stone steps up to the threshold — each a block sitting flat on the ground, no
  // floating slab with a gap beneath it. The tall (thick) riser sits hard against the door,
  // the short (thin) one out front, so you climb up toward the threshold like proper steps.
  for (const [sh, so] of [[0.42, 0.5], [0.2, 1.15]]) {   // [riser height, distance out from door]
    const step = box(3, sh, 0.72, 0x55524a);
    step.position.set(cx, y0 + sh / 2, northZ + so);
    townGroup.add(step);
  }
  const plate = textPlate('CHAPEL', 3.6, 0.9, '#2a2422', '#9a8f7a'); // faded sign over the door
  plate.position.set(cx, y0 + h - 0.7, northZ + 0.06);
  townGroup.add(plate);
  // side door, now on the EAST flank facing the graveyard — the way out to where the Crimson
  // One lies, between this door and the graveyard gate. Its own step: thick tread against the
  // door, thin one further out, climbing up toward the threshold.
  const sideDoor = box(0.12, 2.4, 1.8, 0x241a12);
  sideDoor.position.set(eastX + 0.06, y0 + 1.2, cz);
  townGroup.add(sideDoor);
  for (const [sh, so] of [[0.42, 0.5], [0.2, 1.15]]) {   // solid: thick riser to the door, thin one out
    const step = box(0.72, sh, 2.4, 0x55524a);
    step.position.set(eastX + so, y0 + sh / 2, cz);
    townGroup.add(step);
  }

  // --- the graveyard: dirt floor, spiked iron fence, slabs + fresh mounds ---
  const g = GRAVEYARD;
  const gw = g.x1 - g.x0, gd = g.z1 - g.z0, gcx = (g.x0 + g.x1) / 2, gcz = (g.z0 + g.z1) / 2;
  townGroup.add(terrainPlane(gw, gd, 5, 6, gcx, gcz, mat(0x2e2a25), 0.035)); // bare packed earth
  // fence: verticals with spike tips + rails, gate gap on the church side and two
  // rusted-out breaches so the dead (and you) can squeeze through elsewhere
  const gaps = {
    w: [[gcz - 1.5, gcz + 1.5]],   // gate on the church-facing side
    s: [[g.x0 + 6, g.x0 + 8.5]],   // broken sections (fence-relative: the plot moves on prestige remixes)
    n: [[g.x0 + 10, g.x0 + 12.5]],
    e: [],
  };
  const inGap = (side, v) => gaps[side].some(([a, b]) => v > a && v < b);
  const spikeBar = (x, z) => {
    const yb = groundHeight(x, z);
    const bar = box(0.07, 1.25, 0.07, 0x23262c);
    bar.position.set(x, yb + 0.66, z);
    townGroup.add(bar);
    const tip = cyl(0.004, 0.05, 0.22, 0x2c3038, 4);
    tip.position.set(x, yb + 1.39, z);
    townGroup.add(tip);
  };
  for (let x = g.x0; x <= g.x1 + 0.01; x += 1.5) {
    if (!inGap('s', x)) spikeBar(x, g.z0);
    if (!inGap('n', x)) spikeBar(x, g.z1);
  }
  for (let z = g.z0 + 1.5; z < g.z1; z += 1.5) {
    if (!inGap('w', z)) spikeBar(g.x0, z);
    if (!inGap('e', z)) spikeBar(g.x1, z);
  }
  // rails + movement/bullet colliders per unbroken run (low, so shots clear the spikes)
  const railRun = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const yb = groundHeight(mx, mz);
    for (const ry of [0.42, 1.12]) {
      const rail = box(x1 > x0 ? len : 0.06, 0.07, z1 > z0 ? len : 0.06, 0x23262c);
      rail.position.set(mx, yb + ry, mz);
      townGroup.add(rail);
    }
    townColliders.push(aabb(mx, mz, x1 > x0 ? len / 2 : 0.1, z1 > z0 ? len / 2 : 0.1, 1.3, yb));
  };
  const runsAlong = (side, fixed, v0, v1, horiz) => {
    let at = v0;
    for (const [a, b] of [...gaps[side], [v1, v1]]) {
      if (a - at > 0.5) horiz ? railRun(at, fixed, a, fixed) : railRun(fixed, at, fixed, a);
      at = b;
    }
  };
  runsAlong('s', g.z0, g.x0, g.x1, true);
  runsAlong('n', g.z1, g.x0, g.x1, true);
  runsAlong('w', g.x0, g.z0, g.z1, false);
  runsAlong('e', g.x1, g.z0, g.z1, false);
  // corner + gate posts with iron finials
  const posts = [[g.x0, g.z0], [g.x1, g.z0], [g.x0, g.z1], [g.x1, g.z1], [g.x0, gcz - 1.5], [g.x0, gcz + 1.5]];
  for (const [px, pz] of posts) {
    const yb = groundHeight(px, pz);
    const post = box(0.2, 1.7, 0.2, 0x1d2026);
    post.position.set(px, yb + 0.85, pz);
    townGroup.add(post);
    const fin = ball(0.11, 0x2c3038);
    fin.position.set(px, yb + 1.78, pz);
    townGroup.add(fin);
  }
  // a fallen bar rusting by each breach
  for (const [bx, bz, rot] of [[g.x0 + 7.2, g.z0 + 0.7, 0.4], [g.x0 + 11.4, g.z1 - 0.8, -0.7]]) {
    const fallen = box(1.3, 0.07, 0.07, 0x2a2620);
    fallen.position.set(bx, groundHeight(bx, bz) + 0.08, bz);
    fallen.rotation.y = rot; fallen.rotation.z = 0.05;
    townGroup.add(fallen);
  }
  // rows of slabs, crosses and the odd obelisk, each with a too-fresh dirt mound
  const stones = [0x8a8578, 0x77746a, 0x99958a];
  for (let col = 0; col < 6; col++) for (let row = 0; row < 6; row++) {
    if (rng() < 0.12) continue; // the odd empty plot
    const gx = g.x0 + 2.6 + col * 2.66 + (rng() - 0.5) * 0.5;
    const gz = g.z0 + 2.4 + row * 3.5 + (rng() - 0.5) * 0.5;
    const yb = groundHeight(gx, gz);
    const stone = stones[(rng() * 3) | 0];
    const kind = rng();
    if (kind < 0.62) {                       // headstone slab
      const slab = box(0.66, 0.85, 0.11, stone);
      slab.position.set(gx, yb + 0.4, gz);
      slab.rotation.z = (rng() - 0.5) * 0.22; slab.rotation.x = (rng() - 0.5) * 0.12;
      townGroup.add(slab);
    } else if (kind < 0.85) {                // cross
      const v = box(0.14, 1.05, 0.12, stone);
      v.position.set(gx, yb + 0.5, gz); v.rotation.z = (rng() - 0.5) * 0.3;
      townGroup.add(v);
      const hbar = box(0.56, 0.13, 0.12, stone);
      hbar.position.set(gx, yb + 0.68, gz); hbar.rotation.z = v.rotation.z;
      townGroup.add(hbar);
    } else {                                 // obelisk
      const ob = box(0.3, 1.5, 0.3, stone);
      ob.position.set(gx, yb + 0.72, gz);
      ob.rotation.z = (rng() - 0.5) * 0.16;
      townGroup.add(ob);
    }
    const mz = gz + 1.05;                    // the grave itself, mounded like it was filled last night
    const mound = ball(1, [0x40342a, 0x4a3c2e, 0x383026][(rng() * 3) | 0]);
    mound.scale.set(0.5, 0.17, 0.92);
    mound.position.set(gx, groundHeight(gx, mz) + 0.06, mz);
    townGroup.add(mound);
    graveSpots.push({ x: gx, z: mz });
  }
}

// ---------- street lamps ----------
// every lamp shares three materials so the whole town's lighting is one cheap dial: the
// bulb's glow, a soft halo around it, and a pool of light thrown on the ground. All three
// are dark by day and swell in at dusk, through the night, and under heavy weather.
const lampBulbMat = mat(0xffe9a8, { emissive: 0xffdd77, emissiveIntensity: 1 });
const lampHaloMat = new THREE.MeshBasicMaterial({ color: 0xffe6a6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const lampPoolMat = new THREE.MeshBasicMaterial({ color: 0xffdca0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const lampHaloGeo = new THREE.SphereGeometry(0.55, 10, 8);
function makeStreetLamp(x, z, group, h = 4.2) {
  const y0 = groundHeight(x, z);
  const pole = cyl(0.07, 0.09, h, 0x3a3d42);
  pole.position.set(x, y0 + h / 2, z); group.add(pole);
  const head = box(0.34, 0.14, 0.34, 0x2f3236);   // a little lantern housing at the top
  head.position.set(x, y0 + h + 0.02, z); group.add(head);
  const bulb = new THREE.Mesh(SPHERE, lampBulbMat); bulb.scale.setScalar(0.16);
  bulb.position.set(x, y0 + h - 0.08, z); group.add(bulb);
  const halo = new THREE.Mesh(lampHaloGeo, lampHaloMat); halo.position.copy(bulb.position); group.add(halo);
  // the light pool rides the terrain and bends with the curve like every other ground decal
  const pool = terrainDisc(2.7, 20, x, z, lampPoolMat, 0.07);
  pool.renderOrder = 1; group.add(pool);
  return bulb;
}
// The big lot's floods are their own dial: same three materials, same lit ramp, but a
// separate set so the Infected One can make them stutter over his parking lot without
// every lamp in town blinking along with him.
const floodBulbMat = mat(0xfff4d2, { emissive: 0xffe9a0, emissiveIntensity: 1 });
const floodHaloMat = new THREE.MeshBasicMaterial({ color: 0xfff0c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const floodPoolMat = new THREE.MeshBasicMaterial({ color: 0xffe9b4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const floodHaloGeo = new THREE.SphereGeometry(1.15, 10, 8);
const FLOOD_H = 12.6;   // three street lamps tall: these throw light across a lot, not a path
// corner floods: a mast, a boxed head cocked in toward the lot, and a wide pool under it
function makeFloodLamp(x, z, aimX, aimZ, group) {
  const y0 = groundHeight(x, z);
  const pole = cyl(0.16, 0.24, FLOOD_H, 0x3a3d42);
  pole.position.set(x, y0 + FLOOD_H / 2, z); group.add(pole);
  const yaw = Math.atan2(aimX - x, aimZ - z);
  const head = box(1.5, 0.4, 0.6, 0x2f3236);
  head.position.set(x, y0 + FLOOD_H + 0.18, z); head.rotation.y = yaw; group.add(head);
  for (const sx of [-0.45, 0.45]) {   // twin lamps in the housing, tipped down at the tarmac
    const bulb = new THREE.Mesh(SPHERE, floodBulbMat); bulb.scale.setScalar(0.22);
    bulb.position.set(x + Math.cos(yaw) * sx, y0 + FLOOD_H + 0.02, z - Math.sin(yaw) * sx);
    group.add(bulb);
    const halo = new THREE.Mesh(floodHaloGeo, floodHaloMat); halo.position.copy(bulb.position); group.add(halo);
  }
  // thrown in toward the lot — and sampled at its own (poolX,poolZ), not the mast's, since a
  // flat radius-13 disc riding the mast's ground height would float or sink the moment the
  // ground under the pool itself sits at a different height than the ground under the pole
  const poolX = lerp(x, aimX, 0.28), poolZ = lerp(z, aimZ, 0.28);
  const pool = terrainDisc(13, 24, poolX, poolZ, floodPoolMat, 0.08);
  pool.renderOrder = 1; group.add(pool);
}
// lit: 0 (broad daylight) .. 1 (deep night / heavy rain). Drives all lamps at once.
let lampLit = 0;   // last computed — the floods re-read it every frame to flicker against
function setLampGlow(lit) {
  lampLit = lit;
  lampBulbMat.emissiveIntensity = 0.55 + lit * 1.7;
  lampHaloMat.opacity = lit * 0.5;
  lampPoolMat.opacity = lit * 0.34;
  setFloodGlow(lit);
}
function setFloodGlow(lit) {
  floodBulbMat.emissiveIntensity = 0.5 + lit * 2.1;
  floodHaloMat.opacity = lit * 0.42;
  floodPoolMat.opacity = lit * 0.3;
}
// The Infected One is in the wiring: while he's standing, his lot's floods stutter — long
// steady stretches broken by a short brownout, so it reads as ballasts giving out rather
// than a strobe. Only bites when they're actually lit; at noon there's nothing to flicker.
let floodFlickT = 0, floodFlick = 1;
function updateFloodlights(dt) {
  if (infectedAlive() && lampLit > 0.02) {
    floodFlickT -= dt;
    if (floodFlickT <= 0) {
      const stumbling = floodFlick < 1;
      floodFlick = stumbling ? 1 : 0.1 + Math.random() * 0.35;
      floodFlickT = stumbling ? 0.5 + Math.random() * 2.6 : 0.04 + Math.random() * 0.14;
    }
  } else if (floodFlick !== 1) { floodFlick = 1; floodFlickT = 0; }
  setFloodGlow(lampLit * floodFlick);
}
// how lit the lamps should be for a given hour + weather: full through the night, ramping
// on across dusk and off across dawn, and forced up under rain (or, softly, heavy cloud)
function lampLitFor(h, W) {
  let d = (h >= 19 || h < 5.5) ? 1
    : h >= 17 ? (h - 17) / 2
    : h < 7 ? (7 - h) / 1.5 : 0;
  return clamp(Math.max(d, W.rain * 0.7 + W.cloudy * 0.2), 0, 1);
}

function buildTown() {
  const rng = mulberry32(9001);
  townPeek.length = 0; // a prestige rebuild registers a fresh set of camera-peek shells
  // the east side's poured pads go in before ANY terrain samples heights: the Blob
  // Lounge needs a dead-flat floor and the chili stand a level counter, so both
  // register like makeBuilding does — pad first, every mesh after answers to it.
  // Captured in townPads so a prestige rebuild can pull them back out of flatPads.
  const loungePad = { x: LAYOUT.lounge.x, z: LAYOUT.lounge.z, hw: 17, hd: 9.5, apron: 2.4, y: groundHeight(LAYOUT.lounge.x, LAYOUT.lounge.z) };
  const chiliPad = { x: LAYOUT.chili.x, z: LAYOUT.chili.z + 1, hw: 8, hd: 6, apron: 2.0, y: groundHeight(LAYOUT.chili.x, LAYOUT.chili.z + 1) };
  flatPads.push(loungePad, chiliPad);
  townPads.push(loungePad, chiliPad);
  // persistent low-res ground apron under the whole town footprint. Chunks only
  // stream in near the player, so without this the always-visible town buildings
  // sit on transparent void when seen from far away. Sunk slightly below the
  // streamed chunk terrain so the detailed ground draws over it with no z-fighting.
  townGroup.add(terrainPlane(208, 208, 52, 52, 47, 2, grassMat(0.5), -0.15));
  townGroup.add(terrainPlane(12.8, 208, 5, 52, -20, 2, roadMat, -0.06)); // far copy of the x=-20 road
  townGroup.add(terrainPlane(12.8, 208, 5, 52, 100, 2, roadMat, -0.06)); // far copy of the x=100 road
  townGroup.add(terrainPlane(208, 12.8, 52, 5, 47, -17, roadMat, -0.06)); // far copy of the z=-17 road
  // main street shops: road z in [-20,-14], shops face it from both sides
  const northNames = ['DINER', 'BAKERY', 'BOOKS', 'TOOLS', 'PIZZA'];
  const southNames = ['MART', 'LIQUOR', 'BARBER', 'TAILOR', 'RADIO'];
  for (let i = 0; i < 5; i++) {
    shopBuilding(12 + i * 13, -5.9, 9.5, 7, 3.4 + rng() * 0.8, -1, northNames[i], rng); // north side faces south (-z)
    shopBuilding(12 + i * 13, -28.1, 9.5, 7, 3.4 + rng() * 0.8, 1, southNames[i], rng); // south side faces north (+z)
  }
  // town hall & courthouse face each other across the east end of main street,
  // pulled west to sit clear of the x=100 cross road (which slid 3 west with its grid)
  grandBuilding(85, -2, 19.5, 13, 7, 0x8a7f6a, 'TOWN HALL', rng, -1);       // grown a touch over the courthouse
  grandBuilding(85, -34, 18, 12, 6.5, 0x9a9aa2, 'COURTHOUSE', rng, 1);      // now the old town-hall footprint
  // the bank anchors the west end of the shop road, a third grander than town hall.
  // The western cross road was slid 3 west (off its left flank), so the bank sits on
  // the lawn now, not the tarmac. Set well back to leave room for the fountain
  // pavilion and the boss arena between them.
  grandBuilding(0, -50.2, 24, 16, 8.6, 0x7d8a96, 'BANK', rng, 1);

  // fountain pavilion — the apron is a U opening onto the street: two straight arms run up
  // either side of the basin and out over the main-street tarmac, closed off behind by a
  // semicircle round the basin's back. It is poured as road, not as a lot: the road's own grey,
  // and the road's own terrain-following height, sampled from the same groundHeight it rides
  // and lifted the same 0.04. Butting it against the kerb still left a hairline no matter how
  // close the numbers got — two surfaces tessellated differently never quite agree along a
  // shared edge — so the arms run a little PAST the kerb and let the join sit buried under the
  // road, where identical grey at an identical height leaves nothing to catch the eye. Open
  // lawn still runs from the back of the U to the bank steps — the Two Horned One wakes on it.
  const fz = -28.2;
  {
    const fy = groundHeight(0, fz);
    const R = 4.8, KERB_Z = -23.4, LAP = 0.6;  // apron radius; main street's south edge; overlap
    // the mesh is built flat in XY and then tipped over, so shape y maps to world z as fz - y
    const armY = fz - (KERB_Z + LAP);     // where the arms end: out on the tarmac, past the kerb
    const shape = new THREE.Shape();
    shape.moveTo(R, armY);                // right arm, run out over the road
    shape.lineTo(R, 0);                   // back down it to the basin's centre line
    shape.absarc(0, 0, R, 0, Math.PI, false);  // round the back of the basin (arms sit tangent
    shape.lineTo(-R, armY);               // to the arc, so the U has no corner to catch the eye)
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape, 20);
    geo.rotateX(-Math.PI / 2);            // tip it flat, then ride the ground exactly as the road does
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundHeight(pos.getX(i), fz + pos.getZ(i)) + 0.04);
    geo.computeVertexNormals();
    const pave = new THREE.Mesh(geo, roadJoinMat);
    pave.position.set(0, 0, fz);          // height already baked into the vertices, as terrainPlane does
    townGroup.add(pave);
    // The basin is a SOLID plinth, not a bowl you can pour into — so its top face IS the
    // landing, and anything below that face is buried in stone rather than sitting in water.
    // Every wet part of this fountain (pool, ripples, puddle, drain, the foot of the fall)
    // was pitched 0.07 under it and therefore invisible. They all hang off waterY now, and
    // waterY sits just proud of the landing, which is the only place water can actually show.
    // The pool is an opaque disc lying on an opaque plinth, so clearance alone was never
    // going to settle it — at any distance the two are close enough for depth precision to
    // start picking between them. It stands a clear 6cm proud AND takes a polygon offset, so
    // it wins the test outright rather than by a margin the far plane can eat into.
    const BASIN_H = 0.85;
    const waterY = fy + BASIN_H + 0.06;
    const basin = cyl(2.8, 3.0, BASIN_H, 0x9a948a, 18);
    basin.position.set(0, fy + BASIN_H / 2, fz);
    townGroup.add(basin);
    const water = new THREE.Mesh(new THREE.CircleGeometry(2.45, 18),
      new THREE.MeshLambertMaterial({ color: 0x3f7fae, emissive: 0x14405e, emissiveIntensity: 0.55,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, waterY, fz);
    townGroup.add(water);
    const ped = cyl(0.42, 0.62, 1.5, 0x8b8577, 10);
    ped.position.set(0, fy + 1.5, fz);
    townGroup.add(ped);
    // dish: wide lip up top narrowing to the stem, so water thrown up by the spout runs
    // out over the rim and off the outside of it
    const BOWL_Y = fy + 2.4, BOWL_H = 0.45, BOWL_RIM_R = 1.05;
    const bowl = cyl(BOWL_RIM_R, 0.22, BOWL_H, 0x9a948a, 12);
    bowl.position.set(0, BOWL_Y, fz);
    townGroup.add(bowl);
    const spout = ball(0.26, 0x7fb8d8, { emissive: 0x2a5a78, emissiveIntensity: 0.6 });
    spout.position.set(0, fy + 2.72, fz);
    townGroup.add(spout);
    townColliders.push(aabb(0, fz, 2.9, 2.9, 0.95, fy));
    // ---- the working water feature ----
    // The ball is the pressure welling up at the top, and what it throws runs over the bowl's
    // LIP — so that lip is where the curtain has to start. It used to hang off the bowl's
    // underside, a third of a metre lower, which left the top of the run dry and made the
    // spill appear to begin halfway down out of nothing. Off the rim it reads as one piece:
    // top surface, curtain, pool.
    const bowlRim = BOWL_Y + BOWL_H / 2;
    // a translucent skirt hanging off the bowl lip down to the pool — the whole top-to-bottom
    // flow in one curtain. Its top radius sits just inside the rim so it sheets over the lip,
    // and it hangs outside the dish as that narrows away beneath it.
    const fallH = bowlRim - waterY;
    const fall = cyl(1.02, 0.86, fallH, 0x6fb2d6, 14);
    fall.material = new THREE.MeshLambertMaterial({ color: 0x6fb2d6, emissive: 0x1e5678, emissiveIntensity: 0.4, transparent: true, opacity: 0.42, depthWrite: false });
    fall.position.set(0, waterY + fallH / 2, fz);
    townGroup.add(fall);
    // droplets that fall from the bowl rim and loop back up when they reach the pool
    const fdrops = [];
    for (let i = 0; i < 11; i++) {
      const d = ball(0.05 + Math.random() * 0.03, 0x9fd4ec, { emissive: 0x2a6a88, emissiveIntensity: 0.7 });
      const a = Math.random() * TAU, r = 0.82 + Math.random() * 0.18;
      d.position.set(Math.cos(a) * r, waterY + Math.random() * fallH, fz + Math.sin(a) * r);
      townGroup.add(d);
      fdrops.push({ m: d, a, r, y: d.position.y, sp: 2.6 + Math.random() * 1.8 });
    }
    // ripples widening across the pool, forever
    const fripples = [];
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.5, 22),
        new THREE.MeshBasicMaterial({ color: 0x9fd4ec, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(0, waterY + 0.015, fz);
      townGroup.add(ring); fripples.push({ m: ring, t: i / 3 });
    }
    // a puddle-glint pooled round the pedestal base. A closed ring: it used to be a 252°
    // arc, and spinning that just dragged a bite out of the water round and round.
    const puddle = new THREE.Mesh(new THREE.RingGeometry(0.64, 1.6, 30),
      new THREE.MeshBasicMaterial({ color: 0x7fbcda, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false }));
    puddle.rotation.x = -Math.PI / 2; puddle.position.set(0, waterY + 0.01, fz);
    townGroup.add(puddle);
    // one drain sunk into the basin behind the pedestal — a contracting ring shows the water
    // sliding inward into it. It's the only opaque thing lying ON the pool, so it's the only
    // one that can fight it for depth: the rings above are all depthWrite:false and can't.
    // A polygon offset keeps it in front for good rather than trusting 6mm of clearance.
    const drainZ = fz - 1.95;
    const drain = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16),
      new THREE.MeshLambertMaterial({ color: 0x24282d, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    drain.rotation.x = -Math.PI / 2; drain.position.set(0, waterY + 0.012, drainZ); townGroup.add(drain);
    const drainRing = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 18),
      new THREE.MeshBasicMaterial({ color: 0x8fc6e0, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    drainRing.rotation.x = -Math.PI / 2; drainRing.position.set(0, waterY + 0.022, drainZ); townGroup.add(drainRing);
    // centerpiece collider: hop the basin rim, then up onto the pedestal and bowl. Feet
    // land ON the bowl's lip (BOWL_Y + BOWL_H/2 = 2.625 over the base, plus a hair) —
    // the old 2.55 top left you shin-deep in the dish water.
    townColliders.push(aabb(0, fz, 0.7, 0.7, 2.64, fy));
    // drops respawn at the rim too, so they fall the full run rather than the bottom of it
    fountainFx = { fdrops, fripples, puddle, drainRing, waterY, top: bowlRim };
    // lamp ring around the pavilion
    for (const a of [0.79, 2.36, 3.93, 5.5]) makeStreetLamp(Math.cos(a) * 4.3, fz + Math.sin(a) * 4.3, townGroup, 3.4);
  }

  // shopping plaza: long building north edge of plaza rect, parking in front
  const plazaShops = [['SUPER MART', 20], ['PHARMACY', 12], ['GYM', 10], ['CAFE', 10]];
  let px = 18;
  for (const [name, w] of plazaShops) {
    shopBuilding(px + w / 2, 58, w, 9, 4.6, -1, name, rng);
    px += w + 1.5;
  }
  parkingLot(42, 36, 58, 26, 3, rng, 3); // large parking; 3 SW stalls yield to the driveway throat
  // floodlight masts on the big lot's four corners, each cocked in at the middle of it, so
  // after dusk (and under rain) the whole lot is lit rather than the odd pool of lamplight
  for (const [fx, fzz] of [[LOT.x - LOT.hw + 1.6, LOT.z - LOT.hd + 1.6], [LOT.x + LOT.hw - 1.6, LOT.z - LOT.hd + 1.6],
                           [LOT.x - LOT.hw + 1.6, LOT.z + LOT.hd - 1.6], [LOT.x + LOT.hw - 1.6, LOT.z + LOT.hd - 1.6]]) {
    makeFloodLamp(fx, fzz, LOT.x, LOT.z, townGroup);
    townColliders.push(aabb(fx, fzz, 0.3, 0.3, FLOOD_H, groundHeight(fx, fzz)));
  }
  // the small lot's footprint overlaps the big lot's SW corner (x13-23, z23-27) — a pocket
  // that used to carry its own stall lines duplicating ground the big lot already painted.
  // Paved plain, no lines or parked cars, it reads as the throat of a driveway instead —
  // which is exactly what it needs to be once the west connector below runs through it.
  townGroup.add(terrainPlane(14, 10, 7, 5, 16, 22, lotMat, 0.05));
  // east connector: starts flush at the lot's own east edge (x=71, zero overlap into the
  // lot's tarmac so its colour goes right up to the border cleanly) and runs to the x=100
  // road, noseing 0.6m past its kerb — roadJoinMat is what actually buries that far seam;
  // two separately-tessellated planes at the same grey and lift still don't agree along a
  // shared edge otherwise. The TOWN_RECTS entry above grades the ground flat under the
  // whole span so the road doesn't have to ride raw terrain noise and clip against it.
  townGroup.add(terrainPlane(23.2, 6.4, 12, 4, 82.6, LOT.z, roadJoinMat, 0.04));
  // west connector: same deal in reverse — flush at the pocket's west edge (x=9, no overlap
  // into its tarmac either) out to the x=-20 road with the same kerb-lap on that end
  townGroup.add(terrainPlane(23.2, 6.4, 12, 4, -2.6, 22, roadJoinMat, 0.04));
  // a painted stripe across each flush seam — same white and same stroke width as the
  // parking-stall lines. Tessellated along its span now instead of one rigid box: the
  // old straight box couldn't bend with the curve, so with the camera off the seam's
  // axis one end sank under the tarmac while the other floated off it. A polygon offset
  // past the strips' own keeps it winning the depth along the join it hides.
  const seamStripeMat = new THREE.MeshLambertMaterial({ color: 0xd8d8d0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [mx, mz] of [[71, LOT.z], [9, 22]]) {
    townGroup.add(terrainPlane(0.14, 6.4, 1, 8, mx, mz, seamStripeMat, 0.05));
  }

  // the old church and its spiked graveyard brood just north of the plaza
  buildChurchyard(rng);

  // main-street pileups (all broken windows, some flipped)
  makePileup(rng, 30, -17, 'x', townGroup, townColliders);
  makePileup(rng, 62, -17, 'x', townGroup, townColliders);
  makePileup(rng, -20, 26, 'z', townGroup, townColliders);
  // parked cars near town buildings
  makeCar(rng, 84, -14, townGroup, townColliders, { broken: true, rotY: 0.3 });
  makeCar(rng, 20, -32.5, townGroup, townColliders, { broken: rng() < 0.5, rotY: Math.PI / 2 });
  makeCar(rng, 47, 8, townGroup, townColliders, { broken: true, flipped: true, van: true }); // the plaza's roof-down van

  // loot crates scattered through town
  const spots = [[10, -9.8], [36, -9.8], [58, -24.4], [88, -9.4], [94, -26], [30, 30], [55, 42], [18, 20], [70, 55], [41, 10]];
  for (const [cx2, cz2] of spots) {
    if (rng() >= 0.8) continue;
    // These spots are hand-placed, and a few of them sit inside a shopfront or hard against
    // a parked car. Cast wider with each miss so a box lands near where it was meant to when
    // it can and relocates when it can't — and if the whole neighbourhood is solid, drop it
    // rather than bury it. A crate you can't reach is worse than no crate at all.
    for (let t = 0; t < 16; t++) {
      const spread = 1.5 + t * 0.35;
      const jx = cx2 + (rng() - 0.5) * spread * 2, jz = cz2 + (rng() - 0.5) * spread * 2;
      if (!spotClearOf(jx, jz, 0.75, townColliders)) continue;
      makeCrate(rng, jx, groundHeight(jx, jz) + 0.05, jz, townGroup, townColliders, townCrates, false);
      break;
    }
  }
  // street lamps line the shopfronts, then run on down both kerbs of the main street and up
  // toward the plaza — the whole small district lit for the dusk / night / rain shift
  for (const lx of [5.5, 18.5, 31.5, 44.5, 57.5, 70.5, 76]) {
    for (const lz of [-10.1, -23.9]) if (!onRoad(lx, lz, 0.5)) makeStreetLamp(lx, lz, townGroup);
  }
  // along the plaza frontage — skipping any that would stand inside the floodlit lot. (The
  // old books-driveway kerb lamps are gone: the lot's own floods light that approach now, and
  // the four that survived the lot cull just stood stranded at its south edge.)
  for (const lx of [16, 30, 58, 70]) if (!lotIsFloodlit(lx, 50)) makeStreetLamp(lx, 50, townGroup);

  // the east side: jelly park, Red's Chili and the Blob Lounge, strung down the
  // side road the town hall and courthouse share — and grandma's Jelly House way
  // off the other end of that road, far past the church
  buildPark(rng);
  buildChiliStand(rng);
  buildBlobLounge(rng);
  buildJellyHouse(rng);
}

// ---------- the jelly park ----------
// Down the block from the courthouse and town hall, across their side road: a manicured
// square of grass where nothing spawns and the butterflies never left. Trees planted in
// rows (a gardener clearly survived long enough to care), rock arrangements, picnic
// tables, flower beds — and the town's granite thank-you to its First Immune.
const parkFlowers = []; // world spots the butterflies drift between
function makeFlowerBed(rng, cx, cz, r, n) {
  const petal = [0xff6fa8, 0xffd84a, 0xffffff, 0xb06fff, 0xff8c42];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.7, d = r * (0.35 + rng() * 0.65);
    const x = cx + Math.sin(a) * d, z = cz + Math.cos(a) * d;
    const y0 = groundHeight(x, z);
    const stem = cyl(0.016, 0.024, 0.34, 0x3f6a33, 5);
    stem.position.set(x, y0 + 0.17, z);
    townGroup.add(stem);
    const head = ball(0.085, petal[(rng() * petal.length) | 0]);
    head.scale.y *= 0.7;
    head.position.set(x, y0 + 0.36, z);
    townGroup.add(head);
    const eye = ball(0.04, 0xffe9a0);
    eye.position.set(x, y0 + 0.41, z);
    townGroup.add(eye);
    parkFlowers.push({ x, y: y0 + 0.44, z });
  }
}
function makePicnicTable(x, z, rotY) {
  const y0 = groundHeight(x, z);
  const g = new THREE.Group();
  const wood = 0x8a6a42, woodDk = 0x745634;
  const top = box(2.2, 0.09, 1.0, wood); top.position.y = 0.76; g.add(top);
  for (const s of [-1, 1]) {
    const bench = box(2.2, 0.07, 0.34, woodDk); bench.position.set(0, 0.45, s * 0.82); g.add(bench);
    for (const e of [-0.85, 0.85]) {
      const leg = box(0.09, 0.76, 0.09, woodDk); leg.position.set(e, 0.38, s * 0.5); leg.rotation.x = s * 0.5; g.add(leg);
      const bleg = box(0.08, 0.45, 0.08, woodDk); bleg.position.set(e, 0.22, s * 0.82); g.add(bleg);
    }
  }
  g.position.set(x, y0, z);
  g.rotation.y = rotY;
  townGroup.add(g);
  townColliders.push(aabb(x, z, 1.15, 1.0, 0.8, y0, rotY));
}
// the massive granite Blingo — the actual in-game Blingo body, built by buildBlob like
// every living blob, then petrified: every material remapped onto a granite ramp that
// keeps its relative tone (pale eyes, near-black pupils, mid-grey jelly). No bat, fists
// down at his sides — the exact splash-screen stance, five metres of stone.
function petrify(root) {
  root.traverse(o => {
    if (!o.isMesh || !o.material || !o.material.color) return;
    // read the hex back in sRGB (the .r/.g/.b floats are linear — grading off those
    // and re-feeding a hex would gamma-darken the stone into coal)
    const hx = o.material.color.getHex();
    const lum = 0.35 * ((hx >> 16) & 255) / 255 + 0.5 * ((hx >> 8) & 255) / 255 + 0.15 * (hx & 255) / 255;
    const g = Math.round(84 + lum * 116); // luminance onto the granite ramp
    o.material = mat((g << 16) | (g << 8) | g);
  });
}
function buildBlingoStatue(x, z) {
  const y0 = groundHeight(x, z);
  const granite = 0x8f939b, graniteDk = 0x6d7178;
  // paved apron + two-step plinth
  const pave = terrainDisc(6.4, 22, x, z, mat(0x9a948a), 0.05);
  townGroup.add(pave);
  const step = box(6.2, 0.4, 6.2, 0xaaa49a); step.position.set(x, y0 + 0.2, z); townGroup.add(step);
  const plinth = box(4.6, 1.3, 4.6, graniteDk); plinth.position.set(x, y0 + 1.05, z); townGroup.add(plinth);
  const lip = box(5.0, 0.22, 5.0, granite); lip.position.set(x, y0 + 1.75, z); townGroup.add(lip);
  const py = y0 + 1.86; // top of the pedestal — the blob stands here
  const statue = buildBlob({ color: granite });
  scene.remove(statue.shadow); // stone casts its presence, not a gameplay shadow blob
  petrify(statue.root);
  statue.root.scale.setScalar(3.3); // the family silhouette at monument scale
  statue.root.position.set(x, py, z);
  statue.root.rotation.y = -Math.PI / 2; // faces the side road, eyes on the town he took back
  townGroup.add(statue.root);
  // the plaque sits ON the plinth itself, west face, BEST JELLY in the goopy face
  const plaque = textPlate('BEST JELLY', 1.9, 0.5, '#3c3428', '#e8d9a8');
  plaque.position.set(x - 2.32, y0 + 1.05, z);
  plaque.rotation.y = -Math.PI / 2;
  townGroup.add(plaque);
  townColliders.push(aabb(x, z, 2.55, 2.55, 2.1, y0));
}
function buildPark(rng) {
  const cx = (PARK.x0 + PARK.x1) / 2, cz = (PARK.z0 + PARK.z1) / 2; // (129, -42)
  // manicured rows: leafy trees pace the two street edges at even intervals, an
  // evergreen squaring off each corner — planted, not sprouted
  for (let z = PARK.z0 + 3; z <= PARK.z1 - 3; z += 6) makeTree(rng, PARK.x0 + 2.5, z, townGroup, townColliders);
  for (let x = PARK.x0 + 8; x <= PARK.x1 - 3; x += 6) makeTree(rng, x, PARK.z1 - 2.5, townGroup, townColliders);
  for (const [ex, ez] of [[PARK.x0 + 2.5, PARK.z0 + 2.5], [PARK.x1 - 2.5, PARK.z0 + 2.5], [PARK.x1 - 2.5, PARK.z1 - 2.5]])
    makeEvergreen(rng, ex, ez, townGroup, townColliders);
  // hedge line down the two quiet edges
  for (let x = PARK.x0 + 4; x <= PARK.x1 - 2; x += 4.5) makeBush(rng, x, PARK.z0 + 1.6, townGroup, rng() < 0.3);
  for (let z = PARK.z0 + 6; z <= PARK.z1 - 4; z += 4.5) makeBush(rng, PARK.x1 - 1.6, z, townGroup, rng() < 0.3);
  // rock arrangements: three deliberate clusters, big stones ringed by small ones
  // (everything below rides the park CENTRE, so a prestige remix carries the whole lawn)
  for (const [rx, rz] of [[cx - 11, cz - 10], [cx + 11.5, cz - 9], [cx + 12.5, cz + 10.5]]) {
    makeRock(rng, rx, rz, townGroup, townColliders, true);
    makeRock(rng, rx + 1.1, rz + 0.4, townGroup, townColliders, true);
    for (let i = 0; i < 3; i++) makeRock(rng, rx + (rng() - 0.5) * 2.8, rz + (rng() - 0.5) * 2.8, townGroup, townColliders, false);
  }
  // picnic tables, angled like people actually dragged them
  makePicnicTable(cx - 8.5, cz + 5, 0.4);
  makePicnicTable(cx + 8.5, cz - 5.5, -0.7);
  makePicnicTable(cx + 10, cz + 4.5, 1.2);
  // flower beds — the butterflies' whole world
  makeFlowerBed(rng, cx - 9.5, cz - 4.5, 1.9, 11);
  makeFlowerBed(rng, cx + 6.5, cz, 1.7, 10);
  makeFlowerBed(rng, cx - 4.5, cz + 10.2, 1.8, 10);
  makeFlowerBed(rng, cx + 2, cz - 9.5, 1.6, 9);
  // the man himself, centre of the lawn
  buildBlingoStatue(cx, cz);
  // two park lamps so the statue reads at dusk — set diagonal off the apron corners,
  // never straight in front of the big fella's face
  makeStreetLamp(cx - 6.5, cz - 6.5, townGroup, 3.6);
  makeStreetLamp(cx + 6.5, cz + 6.5, townGroup, 3.6);
  buildButterflies();
}

// ---------- butterflies ----------
// small ones, park property: each picks a flower, flutters over, sits with slow wings,
// then moves along. Two triangle wings on a crumb of a body — cheap enough to always tick.
const butterflies = [];
const BFLY_COLORS = [0xfff3f3, 0xffd84a, 0xff9a3d, 0xa8d8ff, 0xffb0d8];
function buildButterflies() {
  if (!parkFlowers.length) return;
  const wingGeo = new THREE.PlaneGeometry(0.16, 0.11);
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    const bmat = new THREE.MeshBasicMaterial({ color: BFLY_COLORS[i % BFLY_COLORS.length], side: THREE.DoubleSide });
    const wings = [];
    for (const s of [-1, 1]) {
      const hinge = new THREE.Group();
      const w = new THREE.Mesh(wingGeo, bmat);
      w.position.x = s * 0.09;
      hinge.add(w);
      hinge.rotation.x = -Math.PI / 2; // wings lie flat, flap around the body line
      g.add(hinge);
      wings.push(hinge);
    }
    const body = box(0.025, 0.02, 0.1, 0x2e2a24);
    g.add(body);
    const f = parkFlowers[(Math.random() * parkFlowers.length) | 0];
    g.position.set(f.x, f.y + 0.05, f.z);
    townGroup.add(g);
    butterflies.push({ g, wings, tgt: f, phase: Math.random() * TAU,
      sitT: Math.random() * 3, speed: 1.1 + Math.random() * 0.9, yaw: 0 });
  }
}
function updateButterflies(dt) {
  for (const b of butterflies) {
    b.phase += dt * (b.sitT > 0 ? 5 : 22); // lazy fan on the flower, a blur in the air
    const flap = Math.sin(b.phase) * (b.sitT > 0 ? 0.5 : 1.05);
    b.wings[0].rotation.z = flap;
    b.wings[1].rotation.z = -flap;
    if (b.sitT > 0) { b.sitT -= dt; continue; }
    const dx = b.tgt.x - b.g.position.x, dz = b.tgt.z - b.g.position.z;
    const ty = b.tgt.y + 0.05 + Math.sin(b.phase * 0.13) * 0.3; // drifting bob on the way
    const dy = ty - b.g.position.y;
    const d = Math.hypot(dx, dz);
    if (d < 0.12) { // landed: settle onto the bloom and fan
      b.g.position.set(b.tgt.x, b.tgt.y + 0.05, b.tgt.z);
      b.sitT = 1.8 + Math.random() * 3.2;
      const next = parkFlowers[(Math.random() * parkFlowers.length) | 0];
      b.tgt = next;
      continue;
    }
    b.yaw = Math.atan2(dx, dz);
    b.g.rotation.y = b.yaw;
    const step = Math.min(d, b.speed * dt);
    b.g.position.x += (dx / d) * step;
    b.g.position.z += (dz / d) * step;
    b.g.position.y += clamp(dy, -1.4 * dt, 1.4 * dt);
  }
}

// ---------- Red's Chili ----------
// The corner plot up the side road from the park sign: Blazo's championship chili stand,
// rebuilt in loving detail down to the disaster on the ground. A cabana roof with spoons
// swinging from the fringe, the big pot up on the counter, bowls stacked and waiting —
// and the horde's review spilled across the tarmac: one pot nearly licked clean on the
// ground, one knocked flat, chili everywhere. RED'S CHILI overhead in the goopy face,
// civic-plate sized, because the town hall never made anything this good.
const chiliMat = mat(0x7a2412);
// RED'S CHILI, the lootable consumable: the counter pot + its bowl stack. taken counts
// servings gone (6 empties it for the run); surf is the pot's chili surface, ladled
// lower per loot. lootedBy holds who already ate this run (multiplayer: one per cousin).
const chiliBar = { x: 0, z: 0, y: 0, surf: null, potH: 0.75, bowls: [], taken: 0, glow: null, lootedBy: new Set() };
function makeChiliPot(x, z, r, h, opts = {}) {
  const y0 = groundHeight(x, z) + (opts.lift || 0);
  const iron = mat(0x2e3238, { side: THREE.DoubleSide });
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.82, h, 12, 1, true), iron);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(r * 0.82, 12), iron);
  bottom.rotation.x = Math.PI / 2;
  bottom.position.y = -h / 2 + 0.01;
  pot.add(bottom);
  for (const s of [-1, 1]) { // stub handles
    const hd = box(0.3, 0.05, 0.05, 0x1e2226);
    hd.position.set(s * r, h * 0.32, 0);
    pot.add(hd);
  }
  if (opts.fill !== undefined) { // chili surface, at whatever height is left in it
    // the pot tapers toward its base, so the surface disc shrinks with the fill level —
    // a nearly-empty pot's chili sits well inside the rim, never poking through the wall
    const cr = r * (0.76 + 0.14 * opts.fill);
    const chili = new THREE.Mesh(new THREE.CircleGeometry(cr, 12),
      new THREE.MeshLambertMaterial({ color: 0x8a2f1a, emissive: 0x1e0602, emissiveIntensity: 0.4 }));
    chili.rotation.x = -Math.PI / 2;
    chili.position.y = -h / 2 + Math.max(0.03, h * opts.fill);
    pot.add(chili);
    pot.userData.chiliSurf = chili; pot.userData.chiliH = h; // the counter pot ladles down per loot
  }
  if (opts.tipped) {
    pot.rotation.z = Math.PI / 2 - 0.06;
    pot.rotation.y = opts.yaw || 0;
    pot.position.set(x, y0 + r * 0.86, z);
  } else {
    pot.position.set(x, y0 + h / 2, z);
  }
  townGroup.add(pot);
  townColliders.push(aabb(x, z, r * (opts.tipped ? 1.2 : 0.95), r * 0.95, opts.tipped ? r * 1.7 : h, y0));
  return pot;
}
function buildChiliStand(rng) {
  const sx = LAYOUT.chili.x, sz = LAYOUT.chili.z; // classic: two blocks up the side road; prestige: wherever the deal put it
  const y0 = groundHeight(sx, sz);
  const wood = 0x7a5230, woodDk = 0x64431f;
  // four posts and the cabana roof: two tan slabs pitched into a ridge, straw-fringed
  for (const [px, pz] of [[-3.1, -2.3], [3.1, -2.3], [-3.1, 2.3], [3.1, 2.3]]) {
    const post = cyl(0.09, 0.12, 2.9, woodDk, 7);
    post.position.set(sx + px, y0 + 1.45, sz + pz);
    townGroup.add(post);
    townColliders.push(aabb(sx + px, sz + pz, 0.14, 0.14, 2.9, y0));
  }
  const straw = mat(0xc9a55a), strawDk = mat(0xb08d44);
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(BOX, straw);
    slab.scale.set(7.6, 0.1, 3.1);
    slab.position.set(sx, y0 + 3.25, sz + s * 1.45);
    slab.rotation.x = s * 0.38;
    townGroup.add(slab);
  }
  const ridge = new THREE.Mesh(BOX, strawDk);
  ridge.scale.set(7.7, 0.12, 0.5);
  ridge.position.set(sx, y0 + 3.82, sz);
  townGroup.add(ridge);
  // straw fringe strips swinging under the eaves, alternating shades
  for (let i = 0; i < 12; i++) {
    const fx = sx - 3.5 + i * 0.64;
    for (const s of [-1, 1]) {
      const strip = new THREE.Mesh(BOX, i % 2 ? straw : strawDk);
      strip.scale.set(0.5, 0.34, 0.06);
      strip.position.set(fx, y0 + 2.72, sz + s * 2.95);
      townGroup.add(strip);
    }
  }
  // the counter runs the front (road side), a shorter return up the west flank
  const counter = box(5.6, 0.95, 0.7, wood);
  counter.position.set(sx, y0 + 0.475, sz - 1.7);
  townGroup.add(counter);
  townColliders.push(aabb(sx, sz - 1.7, 2.8, 0.35, 0.95, y0));
  const ret = box(0.7, 0.95, 2.6, wood);
  ret.position.set(sx - 2.45, y0 + 0.475, sz - 0.1);
  townGroup.add(ret);
  townColliders.push(aabb(sx - 2.45, sz - 0.1, 0.35, 1.3, 0.95, y0));
  // the big cooking pot up on the counter, full and steaming-adjacent; ladle leaned in.
  // This one is RED'S CHILI, the lootable: its level ladles DOWN a notch per serving
  // taken, and the bowl stack beside it goes with it, one bowl a cousin, six deep.
  const mainPot = makeChiliPot(sx + 1.3, sz - 1.7, 0.55, 0.75, { fill: 0.85, lift: 0.95 });
  // the pot gets a collider: it's the first step of the climb to the sign (counter ->
  // pot lid -> straw -> ridge -> pegs), and rounds stop on real cookware now too
  townColliders.push(aabb(sx + 1.3, sz - 1.7, 0.5, 0.5, 0.78, y0 + 0.95));
  chiliBar.x = sx + 1.3; chiliBar.z = sz - 1.7; chiliBar.y = y0;
  chiliBar.surf = mainPot.userData.chiliSurf; chiliBar.potH = mainPot.userData.chiliH;
  chiliBar.taken = 0; chiliBar.lootedBy.clear(); chiliBar.bowls.length = 0;
  // the ladle stands IN the pot: a real cupped scoop planted near the bottom (so it still
  // reads when all six servings are gone and the pot's drained empty) and a long handle
  // leaning up and out over the front rim
  const ladle = new THREE.Group();
  const steel = 0xb9bdc4;
  const scoop = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 8, 0, TAU, Math.PI / 2, Math.PI / 2),
    mat(steel, { side: THREE.DoubleSide }));                       // bottom hemisphere = a cup opening up
  ladle.add(scoop);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.016, 6, 16), mat(steel));
  rim.rotation.x = Math.PI / 2; ladle.add(rim);                    // lip round the cup's mouth
  const handle = cyl(0.024, 0.024, 1.35, steel, 6);
  handle.position.set(0, 0.66, 0.06); ladle.add(handle);          // long shaft up out of the pot
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 6, 12), mat(steel));
  hook.position.set(0, 1.33, 0.06); hook.rotation.y = Math.PI / 2; ladle.add(hook); // hanging hook at the top
  // wet with chili up to the full-pot line: the pot starts at fill 0.85 (0/6 looted, chili
  // surface ~y0+1.59 world), so everything below that line wears the sauce — the cup coated
  // outside, its mouth brimming, and a chili sleeve up the shaft to exactly that height.
  // It stays painted on as the pot ladles down, reading as the wet ladle that did the work.
  const sauce = new THREE.MeshLambertMaterial({ color: 0x8a2f1a, emissive: 0x1e0602, emissiveIntensity: 0.4 });
  const coat = new THREE.Mesh(new THREE.SphereGeometry(0.185, 14, 8, 0, TAU, Math.PI / 2, Math.PI / 2), sauce);
  ladle.add(coat);                                                 // chili skinned over the cup's outside
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.165, 12), sauce);
  mouth.rotation.x = -Math.PI / 2; mouth.position.y = 0.02; ladle.add(mouth); // the cup sits brim-full
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.5, 6), sauce);
  sleeve.position.set(0, 0.25, 0.06); ladle.add(sleeve);           // sauce up the shaft to the 0/6 line
  const driplet = ball(0.045, 0x8a2f1a); driplet.position.set(0.02, 0.5, 0.07);
  ladle.add(driplet);                                              // the last gob clinging at the line
  ladle.position.set(sx + 1.28, y0 + 1.12, sz - 1.58);            // scoop just off the pot floor
  ladle.rotation.x = 0.32;                                        // lean the handle out over the front rim
  townGroup.add(ladle);
  // the stack of bowls beside it: six high now, one per cousin at the table
  for (let i = 0; i < 6; i++) {
    const bowl = cyl(0.22, 0.15, 0.1, i % 2 ? 0xd8cdb8 : 0xcabfa8, 10);
    bowl.position.set(sx - 0.9, y0 + 1.0 + i * 0.085, sz - 1.68);
    townGroup.add(bowl);
    chiliBar.bowls.push(bowl);
  }
  // the big red glow: pool + ring on the counter top, orb riding over the pot
  chiliBar.glow = makeLootGlow(0xff4030, { r: 1.5, y: 1.35, s: 2.5 });
  chiliBar.glow.position.set(sx + 1.3, y0 + 0.96, sz - 1.7);
  townGroup.add(chiliBar.glow);
  // spoons live in a caddy cup on the counter now, handles up, grab-and-go
  const caddy = cyl(0.14, 0.11, 0.22, 0x64431f, 8);
  caddy.position.set(sx - 1.6, y0 + 1.06, sz - 1.68);
  townGroup.add(caddy);
  for (let i = 0; i < 4; i++) {
    const handle = box(0.03, 0.3, 0.018, 0xb9bdc4);
    handle.position.set(sx - 1.66 + (i % 2) * 0.12, y0 + 1.3, sz - 1.73 + ((i / 2) | 0) * 0.1);
    handle.rotation.z = (i - 1.5) * 0.12;
    townGroup.add(handle);
  }
  // the disaster: chili slicked over the ground out front, a nearly-empty pot on the
  // tarmac side, and one knocked flat with its mouth to the street
  townGroup.add(terrainDisc(1.5, 16, sx - 0.6, sz - 4.1, chiliMat, 0.055));
  townGroup.add(terrainDisc(0.9, 12, sx + 1.7, sz - 4.8, chiliMat, 0.055));
  townGroup.add(terrainDisc(0.6, 10, sx - 2.6, sz - 4.6, chiliMat, 0.055));
  for (let i = 0; i < 8; i++) { // chunks in the sauce (beans, hopefully)
    const bit = ball(0.05 + rng() * 0.04, 0x8a2f1a);
    const bx2 = sx - 0.8 + (rng() - 0.5) * 3.4, bz2 = sz - 4.2 + (rng() - 0.5) * 1.6;
    bit.position.set(bx2, groundHeight(bx2, bz2) + 0.08, bz2);
    townGroup.add(bit);
  }
  makeChiliPot(sx + 2.9, sz - 4.3, 0.6, 0.85, { fill: 0.18 });          // a little left at the bottom
  makeChiliPot(sx - 3.4, sz - 4.0, 0.55, 0.8, { tipped: true, yaw: 0.9 }); // kicked over, empty
  const dribble = terrainDisc(0.5, 9, sx - 4.15, sz - 4.35, chiliMat, 0.055); // what rolled out of it
  townGroup.add(dribble);
  // the signage: civic-plate sized RED'S CHILI over the ridge — and a little platforming
  // prize with it: counter -> pot lid -> straw slope -> ridge -> up onto the pegs. The
  // pegs stand right on the ridge's own centerline (the roof's peak, not partway down
  // the front slope), based on the ridge cap's actual top so they sit clean on the wood
  // instead of dipping into the straw, and pegs, straw and plate are all real standable
  // colliders (the plate top is the crown for slide-hoppers).
  roofSlope(townColliders, sx, y0 + 2.68, sz, 'x', 3.8, 2.9, 1.14); // the straw is walkable
  const ridgeTop = y0 + 3.88; // top face of the ridge cap mesh (y0+3.82 centre + half its 0.12 height)
  for (const s of [-1, 1]) {
    const peg = cyl(0.09, 0.11, 0.6, woodDk, 7);
    peg.position.set(sx + s * 2.6, ridgeTop + 0.3, sz);
    townGroup.add(peg);
    townColliders.push(aabb(sx + s * 2.6, sz, 0.15, 0.15, 0.6, ridgeTop)); // jump-on pegs
  }
  const pegTop = ridgeTop + 0.6; // where the sign's underside should land
  const sign = textPlate("RED'S CHILI", 6.8, 1.7, '#421511', '#ffe2b0');
  sign.position.set(sx, pegTop + 0.85, sz);
  sign.rotation.y = Math.PI; // face the main-street crossing the park sign points from
  townGroup.add(sign);
  const signBack = textPlate("RED'S CHILI", 6.8, 1.7, '#421511', '#ffe2b0');
  signBack.position.set(sx, pegTop + 0.85, sz + 0.02);
  townGroup.add(signBack); // readable coming down the road from the north too
  // the plate itself is solid: a narrow catwalk top to crown, set a hair behind the pegs
  // (now that pegs sit on the centerline too) so a blob standing on them never gets
  // shoved off by the plate's box
  townColliders.push(aabb(sx, sz + 0.3, 3.4, 0.1, 1.7, pegTop));
}

// ---------- the Blob Lounge ----------
// Blomba's old workplace, far down the side road the other way from all of it: a hall
// you can properly fight inside — tall flat frontage with her name up on the wall above
// the doors, roof pitched behind it, four doorways (two a side) so the room never
// bottles you in, and every wall lined with stocked shelves. The loot run of the map.
function buildBlobLounge(rng) {
  buildLoungeHall(rng, { bx: LAYOUT.lounge.x, bz: LAYOUT.lounge.z,
    wallC: 0x584a66,  // lounge purple, like the bouncer who kept its door
    floorC: 0x453a4e, signText: 'BLOB LOUNGE', signBg: '#241a2e', signFg: '#d8a8ff',
    jars: 'good' }); // the mess-hall centrepiece: grandma's GOOD JELLY, still potent
}
// grandma Blingo's Jelly House: the same fighting-hall bones as the Blob Lounge, dressed
// in her jelly orange, way off past the church up the east road — the farthest landmark
// on the map, which is the point: the trek IS the epilogue (see spawnJellyMarks).
// East of the x=100 road (which runs x 93.6..106.4): the house sits on its own grass,
// never on the tarmac.
const JELLY = { x: 124, z: 178 };
// where grandma's ghost actually stands: beside the long table, not inside it
const JELLY_G = { x: JELLY.x, z: JELLY.z + 4.2 };
function buildJellyHouse(rng) {
  // grandma's porch faces HOME: sign + lamps on whichever long side looks back toward
  // the town's centre — and since a prestige re-deal can drop the house anywhere on its
  // far ring, the facing is computed off the live layout bounds, not hardcoded
  const face = JELLY.z >= (TOWN_BOUND.z0 + TOWN_BOUND.z1) / 2 ? -1 : 1;
  buildLoungeHall(rng, { bx: JELLY.x, bz: JELLY.z, face,
    wallC: 0xb4642a,  // jelly orange, sun-faded like the label on her jars
    floorC: 0x6b4a30, signText: 'JELLY HOUSE', signBg: '#3a2210', signFg: '#ffb347',
    jars: 'empty' }); // her table too — but the jars here were eaten long ago: no loot, no mess
}
function buildLoungeHall(rng, { bx, bz, wallC, floorC, signText, signBg, signFg, jars, face = 1 }) {
  const w = 30, d = 16, h = 6.0;
  const y0 = groundHeight(bx, bz);
  // it sits past the town's far ground apron, so it brings its own: the building must
  // never read as floating on void from across the map
  townGroup.add(terrainPlane(52, 48, 13, 12, bx, bz, grassMat(0.5), -0.15));
  const t = 0.35;
  const DOOR_W = 2.8, DOOR_H = 3.4, DOOR_X = 8; // two doorways per long side, at ±DOOR_X
  const shell = [];
  const peekSlab = m => shell.push({ mats: [ownMat(m)], box: townColliders[townColliders.length - 1], op: 1, want: 1 });
  // long sides (front faces the park, +z): three wall segments around the two door
  // gaps, plus a lintel band riding over each gap — the doors are doorways, not slots
  // cut to the roofline, so the face above them stays one flat wall for the signage
  const segs = [
    [-(w / 2 + (DOOR_X + DOOR_W / 2)) / 2, (w / 2) - (DOOR_X + DOOR_W / 2)],   // outer left
    [0, 2 * (DOOR_X - DOOR_W / 2)],                                            // middle run
    [(w / 2 + (DOOR_X + DOOR_W / 2)) / 2, (w / 2) - (DOOR_X + DOOR_W / 2)],    // outer right
  ];
  for (const s of [-1, 1]) {
    const wz = bz + s * d / 2;
    for (const [cx, len] of segs) {
      const m = box(len, h + 0.6, t, wallC);
      m.position.set(bx + cx, y0 + h / 2 - 0.3, wz);
      townGroup.add(m);
      townColliders.push(aabb(bx + cx, wz, len / 2, t / 2, h + 0.6, y0 - 0.6));
      peekSlab(m);
    }
    for (const dx of [-DOOR_X, DOOR_X]) { // lintels: wall continues above each doorway
      const lm = box(DOOR_W, h - DOOR_H, t, wallC);
      lm.position.set(bx + dx, y0 + (DOOR_H + h) / 2, wz);
      townGroup.add(lm);
      townColliders.push(aabb(bx + dx, wz, DOOR_W / 2, t / 2, h - DOOR_H, y0 + DOOR_H));
      peekSlab(lm);
    }
  }
  // short flanks: one honest window each — both open cutouts, never boarded. The Blob
  // Lounge is a fighting hall you shoot in and out of; a boarded flank would wall off a
  // whole firing line the room is meant to keep open
  for (const s of [-1, 1]) {
    wallWithWindow(townGroup, townColliders, bx + s * w / 2, bz, false, d, t, h, y0,
      wallC, 0, shell, s);
  }
  const floor = box(w, 0.6, d, floorC);
  floor.position.set(bx, y0 - 0.24, bz);
  townGroup.add(floor);
  townColliders.push(aabb(bx, bz, w / 2 - t, d / 2 - t, 0.56, y0 - 0.5));
  const roofPeek = addRoof(townGroup, bx, y0 + h - 0.05, bz, w, d, rng, townColliders, wallC);
  if (roofPeek) shell.push(roofPeek);
  // the loot: shelving lined along every wall, the way she left the stockroom.
  // Each rolls its crates through makeShelf like any chunk house shelf would.
  for (const sx of [-12, -7.2, -2.4, 2.4, 7.2, 12]) for (const s of [-1, 1]) {
    if (Math.abs(Math.abs(sx) - DOOR_X) < 2.2) continue; // keep every doorway clear
    makeShelf(rng, bx + sx, bz + s * (d / 2 - 0.85), s > 0 ? Math.PI : 0, townGroup, townColliders, townCrates, y0 + 0.06);
  }
  for (const sz of [-4.6, 4.6]) { // the middle of each flank stays open: that's window light
    makeShelf(rng, bx - w / 2 + 0.85, bz + sz, Math.PI / 2, townGroup, townColliders, townCrates, y0 + 0.06);
    makeShelf(rng, bx + w / 2 - 0.85, bz + sz, Math.PI / 2, townGroup, townColliders, townCrates, y0 + 0.06);
  }
  // loose floor crates pushed off the centreline — the mess tables own the middle now
  makeCrate(rng, bx - 4.5, y0 + 0.08, bz - 4.9, townGroup, townColliders, townCrates, false, true);
  makeCrate(rng, bx + 4.5, y0 + 0.08, bz + 4.9, townGroup, townColliders, townCrates, false, true);
  buildMessTables(bx, bz, y0, jars);
  // the name big on the flat frontage, above the doors, below the eaves — on the FACE
  // side (face flips sign + porch lamps to whichever long side the hall fronts)
  const sign = textPlate(signText, 8, 1.8, signBg, signFg);
  sign.position.set(bx, y0 + (DOOR_H + h) / 2 + 0.15, bz + face * (d / 2 + t / 2 + 0.04));
  if (face < 0) sign.rotation.y = Math.PI; // the plate reads +z by default
  townGroup.add(sign);
  makeStreetLamp(bx - 5.5, bz + face * (d / 2 + 2.4), townGroup, 3.6);
  makeStreetLamp(bx + 5.5, bz + face * (d / 2 + 2.4), townGroup, 3.6);
  // register it enterable, four doors: pathing picks whichever is nearest
  const doors = [];
  for (const s of [-1, 1]) for (const dx of [-DOOR_X, DOOR_X])
    doors.push({ x: bx + dx, z: bz + s * d / 2, outX: bx + dx, outZ: bz + s * (d / 2 + 2.2) });
  townBuildings.push({ x: bx, z: bz, hw: w / 2 + 0.5, hd: d / 2 + 0.5, shell, doors,
    doorX: doors[2].x, doorZ: doors[2].z, doorOutX: doors[2].outX, doorOutZ: doors[2].outZ,
    roofY: y0 + h - 0.05 + d * 0.32, ridgeHW: Math.max(1, w / 2 - 0.6) });
}
// ---------- the mess tables + grandma's GOOD JELLY ----------
// The Valhalla line: three picnic tables end to end down the hall's spine, benches both
// sides, like a viking mess hall waiting on a feast. In the BLOB LOUNGE the centre table
// carries the centrepiece — six capped jars of grandma's GOOD JELLY under a big purple
// glow, with the purple spill of a hurried exit over the table and the floor by the door.
// One whole cluster acts as one big loot spot (the jar nearest your crosshair is the one
// you take). In the JELLY HOUSE the same table stands with the jars long since emptied:
// clear glass, no lids, nothing to take — she gave it all away.
const jellyBar = { x: 0, z: 0, y: 0, jars: [], mask: 0, glow: null, lootedBy: new Set() };
function makeJellyJar(full) {
  const g = new THREE.Group();
  const glass = cyl(0.16, 0.14, 0.34, 0xffffff, 10);
  glass.material = full
    ? new THREE.MeshLambertMaterial({ color: 0x8a4dd0, emissive: 0x2a0d4a, emissiveIntensity: 0.55 })
    : new THREE.MeshLambertMaterial({ color: 0xdde4ec, transparent: true, opacity: 0.35 });
  glass.position.y = 0.17;
  g.add(glass);
  if (full) { // capped: wax-paper lid + her orange band
    const lid = cyl(0.17, 0.17, 0.05, 0xe8dcc0, 10); lid.position.y = 0.365; g.add(lid);
    const band = cyl(0.165, 0.165, 0.03, 0xb4642a, 10); band.position.y = 0.33; g.add(band);
  }
  return g;
}
function buildMessTables(bx, bz, y0, jars) {
  const wood = 0x6e4a26, woodDk = 0x59391c;
  for (const tx of [-8, 0, 8]) {
    const top = box(7.2, 0.14, 2.2, wood);
    top.position.set(bx + tx, y0 + 0.95, bz);
    townGroup.add(top);
    for (const ex of [-3.1, 3.1]) for (const s of [-1, 1]) {
      const leg = box(0.16, 0.95, 0.16, woodDk);
      leg.position.set(bx + tx + ex, y0 + 0.475, bz + s * 0.7);
      townGroup.add(leg);
    }
    townColliders.push(aabb(bx + tx, bz, 3.6, 1.1, 1.02, y0));
    for (const s of [-1, 1]) { // benches both sides, low enough to hop up on
      const bench = box(7.2, 0.1, 0.55, wood);
      bench.position.set(bx + tx, y0 + 0.55, bz + s * 1.6);
      townGroup.add(bench);
      for (const ex of [-3, 3]) {
        const bl = box(0.14, 0.55, 0.14, woodDk);
        bl.position.set(bx + tx + ex, y0 + 0.275, bz + s * 1.6);
        townGroup.add(bl);
      }
      townColliders.push(aabb(bx + tx, bz + s * 1.6, 3.6, 0.32, 0.62, y0));
    }
  }
  // the jar cluster on the centre table: 2 rows of 3
  const full = jars === 'good';
  for (let i = 0; i < 6; i++) {
    const jar = makeJellyJar(full);
    jar.position.set(bx + ((i % 3) - 1) * 0.6, y0 + 1.02, bz + (i < 3 ? -0.42 : 0.42));
    townGroup.add(jar);
    if (full) jellyBar.jars.push(jar);
  }
  if (!full) return;
  jellyBar.x = bx; jellyBar.z = bz; jellyBar.y = y0;
  jellyBar.mask = 0; jellyBar.lootedBy.clear();
  // the big purple glow: pool + ring spilling out from under the table, orb over the jars
  jellyBar.glow = makeLootGlow(0xb06fff, { r: 1.8, y: 2.3, s: 2.8 });
  jellyBar.glow.position.set(bx, y0, bz);
  townGroup.add(jellyBar.glow);
  // the spill: rounded jelly splats, small and separated — a few dropped on the tabletop by
  // the jars, and a scatter across the floor on the way out the door (never one big slab)
  const jmat = new THREE.MeshLambertMaterial({ color: 0x7a3fd0, emissive: 0x1e0a3a, emissiveIntensity: 0.4 });
  const splatGeo = new THREE.CircleGeometry(1, 14);
  const splat = (cx, yy, cz, r) => {
    // an irregular blob: one main puddle ringed by a couple of smaller offset lobes
    const lobes = 3 + (Math.random() * 2 | 0);
    for (let i = 0; i < lobes; i++) {
      const m = new THREE.Mesh(splatGeo, jmat);
      m.rotation.x = -Math.PI / 2;
      const a = i === 0 ? 0 : Math.random() * TAU, dd = i === 0 ? 0 : r * (0.5 + Math.random() * 0.7);
      m.scale.set(r * (i === 0 ? 1 : 0.3 + Math.random() * 0.4), 1, r * (i === 0 ? 0.82 : 0.3 + Math.random() * 0.4));
      m.rotation.z = Math.random() * TAU;   // (about the disc's own up-axis after the tip)
      m.position.set(cx + Math.sin(a) * dd, yy, cz + Math.cos(a) * dd);
      townGroup.add(m);
    }
  };
  splat(bx - 1.1, y0 + 1.03, bz + 0.35, 0.22);   // dropped on the tabletop by the cluster
  splat(bx + 1.4, y0 + 1.03, bz - 0.3, 0.16);
  splat(bx + 6.6, y0 + 0.08, bz + 3.6, 0.5);     // the trail out toward the door
  splat(bx + 7.7, y0 + 0.08, bz + 5.1, 0.42);
  splat(bx + 8.6, y0 + 0.08, bz + 6.2, 0.3);
  for (let i = 0; i < 6; i++) { // stray gobs flung off the trail
    const gob = ball(0.05 + Math.random() * 0.05, 0x7a3fd0);
    gob.position.set(bx + 6 + Math.random() * 3.4, y0 + 0.1, bz + 3 + Math.random() * 3.8);
    townGroup.add(gob);
  }
  // a few empty jars left behind: two upright on the table's end, a couple knocked over
  // on the floor by the spill trail
  const je1 = makeJellyJar(false); je1.position.set(bx + 2.9, y0 + 1.02, bz - 0.4); townGroup.add(je1);
  const je2 = makeJellyJar(false); je2.position.set(bx + 3.3, y0 + 1.02, bz + 0.3); townGroup.add(je2);
  for (const [ex, ez, ry] of [[bx + 7, bz + 4, 1.1], [bx + 8.2, bz + 5.6, -0.5]]) {
    const je = makeJellyJar(false);
    je.rotation.z = Math.PI / 2; je.rotation.y = ry;   // tipped on its side
    je.position.set(ex, y0 + 0.24, ez); townGroup.add(je);
  }
}
// ---------- consumable loot state ----------
// State appliers run on EVERY screen (locally on loot for the host/solo, off the host's
// snapshot for clients): jars vanish by mask bit so all screens hide the SAME jar, the
// pot surface ladles down per serving, and the bowls leave the stack top-first. When a
// stock runs dry its glow fades off with it.
function jellyLeft() { let n = 0; for (let i = 0; i < 6; i++) if (!(jellyBar.mask & (1 << i))) n++; return n; }
function applyJellyMask(mask) {
  jellyBar.mask = mask;
  jellyBar.jars.forEach((j, i) => j.visible = !(mask & (1 << i)));
  if (jellyBar.glow) jellyBar.glow.userData.glow.mul = jellyLeft() > 0 ? 1 : 0;
}
function applyChiliTaken(taken) {
  chiliBar.taken = taken;
  chiliBar.bowls.forEach((b, i) => b.visible = i < 6 - taken);
  if (chiliBar.surf) {
    const fill = 0.85 * (6 - taken) / 6;
    chiliBar.surf.visible = taken < 6;
    chiliBar.surf.position.y = -chiliBar.potH / 2 + Math.max(0.03, chiliBar.potH * fill);
  }
  if (chiliBar.glow) chiliBar.glow.userData.glow.mul = taken < 6 ? 1 : 0;
}
function updateConsumables(dt) {
  if (jellyBar.glow) animateLootGlow(jellyBar.glow, game.time);
  if (chiliBar.glow) animateLootGlow(chiliBar.glow, game.time * 1.13 + 2); // its own beat
}
// who this screen's player is in the once-per-run ledgers
function myLootKey() { return net.role ? 'p' + (net.playerNum || 1) : 'solo'; }
// solo runs can come back for more after using one (the once-per-run law is a lobby rule);
// nobody loots a second helping while still carrying the first, and giants don't shop
function canLootJelly() {
  return jellyLeft() > 0 && !player.owned.includes('jelly') && !player.downed
    && !(net.role && jellyBar.lootedBy.has(myLootKey())) && !playerGiantAny();
}
function canLootChili() {
  return chiliBar.taken < 6 && !player.owned.includes('chili') && !player.downed
    && !(net.role && chiliBar.lootedBy.has(myLootKey())) && !playerGiantAny();
}
function findNearJelly() {
  if (!canLootJelly()) return null;
  return Math.hypot(player.pos.x - jellyBar.x, player.pos.z - jellyBar.z) < 3.8 ? jellyBar : null;
}
function findNearChili() {
  if (!canLootChili()) return null;
  return Math.hypot(player.pos.x - chiliBar.x, player.pos.z - chiliBar.z) < 3.6 ? chiliBar : null;
}
// the whole cluster is one big loot spot, but the jar that leaves the table is the one
// nearest your crosshair
const _jarV = new THREE.Vector3();
function nearestJarToCrosshair() {
  let best = -1, bd = Infinity;
  jellyBar.jars.forEach((j, i) => {
    if (jellyBar.mask & (1 << i)) return;
    _jarV.setFromMatrixPosition(j.matrixWorld);
    _jarV.y -= curveDrop(_jarV.x, _jarV.z); // compare against where the jar is DRAWN
    _jarV.project(camera);
    const d = Math.hypot(_jarV.x, _jarV.y);
    if (_jarV.z < 1 && d < bd) { bd = d; best = i; }
  });
  if (best >= 0) return best;
  for (let i = 0; i < 6; i++) if (!(jellyBar.mask & (1 << i))) return i;
  return -1;
}
function nearestFreeJar() { for (let i = 0; i < 6; i++) if (!(jellyBar.mask & (1 << i))) return i; return -1; }
function lootJelly() {
  if (net.role === 'client') { try { net.conns[0].send({ t: 'jellyReq', jar: nearestJarToCrosshair() }); } catch (e) {} return; }
  const jar = nearestJarToCrosshair();
  if (jar < 0) return;
  applyJellyMask(jellyBar.mask | (1 << jar));
  jellyBar.lootedBy.add(myLootKey());
  grantJelly();
  npcNiceRound();
}
function lootChili() {
  if (net.role === 'client') { try { net.conns[0].send({ t: 'chiliReq' }); } catch (e) {} return; }
  applyChiliTaken(chiliBar.taken + 1);
  chiliBar.lootedBy.add(myLootKey());
  grantChili();
}
function grantJelly() {
  jellyBar.lootedBy.add(myLootKey()); // clients keep their own copy of the once-per-run law
  // the jar goes in the pocket, not the hand: it slots into the loadout next to fists /
  // chili / the melees, and whatever you were holding stays out
  if (!player.owned.includes('jelly')) {
    player.owned.push('jelly');
    player.owned.sort((a, b) => slotRank(a) - slotRank(b));
    updateWeaponBtn();
  }
  SFX.pickup(); rumble(120, 0.4, 0.5);
  toast('GOOD JELLY ACQUIRED .ᐟ SAVE IT FOR LATER . .', true);
  spawnParticles(player.pos.x, player.pos.y + 1.4, player.pos.z, 0xb06fff, 14, 4, 0.8);
  updateAmmoHUD();
}
function grantChili() {
  chiliBar.lootedBy.add(myLootKey()); // same law, client-side mirror
  equipWeapon('chili');
  SFX.pickup(); rumble(120, 0.4, 0.5);
  toast("RED'S CHILI ACQUIRED .ᐟ RELOAD TO EAT IT .ᐟ", true);
  spawnParticles(player.pos.x, player.pos.y + 1.4, player.pos.z, 0xff4030, 14, 4, 0.8);
  updateAmmoHUD();
}
// the whole squad's review of grandma's jelly leaving the shelf: every AI cousin fires
// the Nice emote, each a heartbeat apart
function npcNiceRound() {
  if (net.role === 'client') return; // the host owns the squad's voices
  companions.forEach(c => { if (c.recruited && !c.downed && !c.netP) c.niceT = 0.4 + Math.random() * 0.9; });
}

// ---------- RED'S CHILI giant mode ----------
// Eat the bowl (the reload key — RED'S on the touch button) and the chili does what the
// lore promises: you come up boss-sized for 90 seconds (Blazo, raised on the stuff, holds
// it 120). Melee only while grown — the swings insta-gib street walkers, a landed jump
// slams an AOE stomp, a slide bulldozes the crowd — but a boss only ever takes a punch's
// worth from a giant, and street teeth only find 1hp of giant to chew. The chili clears
// waves; it never cheeses a boss. That's the balance the table talk is about.
const GIANT_SCALE = 2.7;
function playerGiantOn() { return (player.giantScale || 1) > 1.5; }
function playerGiantAny() { return !!player.giantPhase; } // any phase: eating, grown, shrinking
function eatChili() {
  if (player.giantPhase || player.downed || player.dead) return;
  if (!player.owned.includes('chili')) return;
  if (player.weapon.id !== 'chili') equipWeapon('chili'); // the bowl comes out for the meal
  player.giantPhase = 'eat'; player.giantPhT = 0;
  player.giantDur = selectedCousin === 'blazo' ? 120 : 90;
  player.giantT = player.giantDur;
  initAudio(); SFX.crate(); rumble(200, 0.6, 0.6);
}
// the grow/shrink melt: the splash screen's blur, borrowed for a body changing size
function playerFadeBegin() { if (!player._fade) { player._fade = { blob: playerBlob }; beginBlobFade(player._fade); } }
function playerFadeEnd() { if (player._fade) { endBlobFade(player._fade); player._fade = null; } }
// the giant's constitution: a temporary +50 to the pool while you're huge, healed in on
// the way up and clamped back out when you shrink (or go down). Idempotent both ways.
const GIANT_HP_BOOST = 50;
function giantHpOn() {
  if (player.giantHpBoost) return;
  player.giantHpBoost = GIANT_HP_BOOST;
  player.maxHp += GIANT_HP_BOOST;
  player.hp = Math.min(player.maxHp, player.hp + GIANT_HP_BOOST);
}
function giantHpOff() {
  if (!player.giantHpBoost) return;
  player.maxHp -= player.giantHpBoost;
  player.giantHpBoost = 0;
  player.hp = Math.min(player.hp, player.maxHp);
}
function updateGiant(dt) {
  if (player.giantPhase) {
    player.giantPhT += dt;
    const ph = player.giantPhase, t = player.giantPhT;
    if (ph === 'eat') {
      // still, bowl to the mouth; at the gulp the bowl leaves the hand and the growing starts
      if (t >= 0.85) {
        const i = player.owned.indexOf('chili');
        if (i >= 0) player.owned.splice(i, 1);
        equipWeapon('fists');
        player.giantPhase = 'grow'; player.giantPhT = 0;
        playerFadeBegin();
      }
    } else if (ph === 'grow') {
      const k = Math.min(t / 0.8, 1);
      player.giantScale = 1 + (GIANT_SCALE - 1) * k;
      if (player._fade) setBlobFade(player._fade, 0.3 + 0.7 * Math.abs(Math.cos(k * Math.PI)));
      if (k >= 1) {
        playerFadeEnd(); player.giantPhase = 'rise'; player.giantPhT = 0;
        giantHpOn(); // the +50 lands as the growing finishes
        rumble(400, 1, 0.9); shakeAmp = Math.max(shakeAmp, 0.2);
        toast('BOSS-SIZED .ᐟ +50 HP .ᐟ', true);
      }
    } else if (ph === 'rise') {
      // the look-around: still, arms down as fists, head sweeping left and right (animated
      // in updatePlayerVisual off this phase)
      if (t >= 0.9) { player.giantPhase = 'on'; player.giantPhT = 0; }
    } else if (ph === 'on') {
      player.giantT -= dt;
      if (player.giantT <= 0) { player.giantPhase = 'shrink'; player.giantPhT = 0; playerFadeBegin(); }
    } else if (ph === 'shrink') {
      const k = Math.min(t / 0.8, 1);
      player.giantScale = GIANT_SCALE + (1 - GIANT_SCALE) * k;
      if (player._fade) setBlobFade(player._fade, 0.3 + 0.7 * Math.abs(Math.cos(k * Math.PI)));
      if (k >= 1) {
        playerFadeEnd(); giantHpOff();
        player.giantPhase = null; player.giantScale = 1; player.giantT = 0;
        toast('THE CHILI WEARS OFF . .');
      }
    }
    playerBlob.root.scale.setScalar(player.giantScale || 1);
  }
  // giant stomp: landing off a jump slams an AOE ring into everything around the boots
  const landed = player.grounded && !player._gPrevGrounded && (player._gPrevVy || 0) < -5.5;
  if (landed && playerGiantOn()) giantStomp();
  player._gPrevGrounded = player.grounded; player._gPrevVy = player.vy;
  // giant charge: a slide bulldozes through the crowd, batting walkers off their feet
  if (playerGiantOn() && player.slideT > 0) giantCharge();
  updateGiantHud();
}
function giantStomp() {
  spawnParticles(player.pos.x, player.pos.y + 0.4, player.pos.z, 0xffb056, 30, 7, 1);
  rumble(320, 1, 0.9); shakeAmp = Math.max(shakeAmp, 0.24);
  play3d(player.pos.x, player.pos.z, () => SFX.crate());
  for (const z of [...zombies]) {
    if (z.state === 'dying') continue;
    const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 6.5) continue;
    damageZombie(z, z.isBoss ? 6 : 400, dx / (d || 1), dz / (d || 1), 9, { isHead: false });
  }
  // the boot comes down on the loot too: any crate under the stomp bursts open (health only)
  for (const cr of [...allCrates]) {
    if (cr.opened) continue;
    if (Math.hypot(cr.pos.x - player.pos.x, cr.pos.z - player.pos.z) < 4.5) openCrate(cr);
  }
}
function giantCharge() {
  for (const z of [...zombies]) {
    if (z.state === 'dying') continue;
    const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 3.4) continue;
    if (game.time - (z._chgT || -9) < 0.8) continue; // one shove per pass, not per frame
    z._chgT = game.time;
    damageZombie(z, z.isBoss ? 6 : 300, dx / (d || 1), dz / (d || 1), 14, { isHead: false });
  }
}
// the countdown chip, styled like the kill quota and living just under its spot
const giantHudEl = document.getElementById('gianttimer');
const giantHudNum = giantHudEl ? giantHudEl.querySelector('b') : null;
function updateGiantHud() {
  const on = playerGiantAny() && player.giantPhase !== 'eat';
  if (giantHudEl) {
    giantHudEl.classList.toggle('show', on);
    giantHudEl.classList.toggle('lower', game.cleanup && game.clearTarget > 0); // quota showing: sit under it
    if (on && giantHudNum) giantHudNum.textContent = fmtTime(Math.max(player.giantT, 0));
  }
}

// ---------- input ----------
const input = {
  moveX: 0, moveY: 0, lookDX: 0, lookDY: 0,
  jump: false, sprint: false, shoot: false, shootPressed: false,
  interact: false, interactHeld: false, interactHeldPad: false,
  reload: false, aim: false, aimPad: false, aimTouch: false, slide: false,
  device: 'kbm', gamepadKind: 'xbox',
  sprintGamepad: false, shootGamepad: false,
};
const keys = {};
let aimX = innerWidth / 2, aimY = innerHeight / 2;
let rmbDrag = false, lastMX = 0, lastMY = 0;

addEventListener('keydown', e => {
  // hidden fullscreen toggle — Alt+Enter or Ctrl/Cmd+F (kept off the controls bar).
  // Esc is the browser's own way back out, and it already lands on the pause path.
  if ((e.code === 'Enter' && e.altKey) || (e.code === 'KeyF' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.()?.catch(() => {});
    return; // never falls through to the KeyF weapon cycle
  }
  keys[e.code] = true;
  input.device = 'kbm';
  if (e.code === 'KeyE') { input.interact = true; input.interactHeld = true; }
  if (e.code === 'KeyR') input.reload = true;
  if ((e.code === 'KeyQ' || e.code === 'KeyF') && !e.repeat) cycleWeapon(1);
  if (e.code === 'KeyV' && !e.repeat) toggleFPV();
  if ((e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') && !e.repeat) input.slide = true;
  if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
  if (e.code === 'Tab') { e.preventDefault(); if (!e.repeat) ewOpen('kbm'); }
  refreshControlsBar();
});
addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'KeyE') input.interactHeld = false;
  if (e.code === 'Tab') ewRelease();
});

addEventListener('mousemove', e => {
  const sens = settings.mouseSens || 1;
  // an open emote wheel captures the mouse to steer the highlight instead of the camera
  if (ewheel.open && ewheel.src === 'kbm') {
    ewSteer(e.movementX, e.movementY, false);
    lastMX = e.clientX; lastMY = e.clientY;
    return;
  }
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
// ---- zoom: one gesture, two jobs ----
// scroll / two-finger pinch / d-pad all feed the same zoom. In third person it slides the
// camera distance smoothly; down a sniper scope it snaps through fixed magnification notches
// with a click, so the scope zoom is dynamic but always lands on a clean setting.
const SNIPER_FOVS = [30, 22, 15, 10]; // wider .. tighter; index 1 (22°) is the old fixed zoom
let sniperNotch = 1, zoomAcc = 0;
function scopedSniper() { return player.weapon && player.weapon.id === 'sniper' && player.aiming; }
function scopeClick() { if (actx) tone(1500, 0.03, 0.13, 'square'); }
function zoomStep(dir) {   // dir: -1 = in / more mag, +1 = out / less
  if (scopedSniper()) {
    const p = sniperNotch;
    sniperNotch = clamp(sniperNotch - dir, 0, SNIPER_FOVS.length - 1); // in -> tighter FOV -> higher index
    if (sniperNotch !== p) scopeClick();
  } else camDist = clamp(camDist + dir * 0.55, 2.6, 9.5);
}
function zoomAnalog(d) {    // d > 0 = out, d < 0 = in (continuous, from wheel/pinch)
  if (scopedSniper()) {
    zoomAcc += d;
    while (zoomAcc >= 0.35) { zoomAcc -= 0.35; zoomStep(1); }
    while (zoomAcc <= -0.35) { zoomAcc += 0.35; zoomStep(-1); }
  } else { zoomAcc = 0; camDist = clamp(camDist + d, 2.6, 9.5); }
}
// how fast a held d-pad glides the zoom (camDist units / second) — a ~1.6s sweep across the range
const ZOOM_PAD_RATE = 4.2;
addEventListener('wheel', e => {
  if (game.state === 'playing') zoomAnalog(e.deltaY * 0.004);
}, { passive: true });
addEventListener('contextmenu', e => e.preventDefault());

// --- touch (Roblox mobile style) ---
const isTouch = IS_TOUCH; // decided up in the settings block (draw distance defaults lean on it)
const touchLayer = document.getElementById('touchlayer');
const joyBase = document.getElementById('joyBase');
const joyKnob = document.getElementById('joyKnob');
let joyTouchId = null, camTouchId = null;
// second finger in the aim area pinches to zoom — track it + both fingers' last positions
let pinchTouchId = null, pinchDist = 0;
const aimPos = {}; // identifier -> {x, y} for the (up to two) aim-area fingers
// the weapon+ammo squircle lives in the HUD (z-index 10) beneath this touch layer (z-index 13),
// so its own taps never land — we hit-test its box in the touchstart handler and hold the finger
// here so it can't also swing the camera
let weaponTouchId = null;
const weaponPanel = document.getElementById('bottomright');
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
bindBtn('btnSlide', () => { input.slide = true; });
bindBtn('btnPause', () => { togglePause(); }); // touch has no corner pause: it's this circle
// aim is a toggle: tap on, tap off (the lit state survives bindBtn's touchend un-press)
bindBtn('btnAim', () => { input.aimTouch = !input.aimTouch; },
  () => { document.getElementById('btnAim').classList.toggle('pressed', input.aimTouch); });
bindBtn('btnView', () => { toggleFPV(); });
bindBtn('btnReload', () => { input.reload = true; });
// the weapon + ammo squircle at bottom-right IS the swap button on touch. It sits in the HUD,
// under the full-screen touch layer, so a tap on it never reaches the panel — the touchstart
// handler below hit-tests this box and cycles the weapon (holding the finger so it won't aim).
function inWeaponPanel(t) {
  const r = weaponPanel.getBoundingClientRect();
  return r.width > 0 && t.clientX >= r.left && t.clientX <= r.right && t.clientY >= r.top && t.clientY <= r.bottom;
}
bindBtn('btnInteract', () => { input.interact = true; input.interactHeld = true; }, () => { input.interactHeld = false; });
// emote: hold the button and keep swiping to steer the wheel (ewTouchStart takes it from
// here), or just tap it and the wheel stays up to thumb through
{
  const el = document.getElementById('btnEmote');
  el.addEventListener('touchstart', e => {
    e.preventDefault(); e.stopPropagation();
    el.classList.add('pressed'); initAudio();
    ewOpen('touch');
    ewTouchStart(e.changedTouches[0], 'btn');
  }, { passive: false });
  const up = () => el.classList.remove('pressed');
  el.addEventListener('touchend', up, { passive: true });
  el.addEventListener('touchcancel', up, { passive: true });
}
bindBtn('btnSprint', () => {
  sprintToggle = !sprintToggle;
  document.getElementById('btnSprint').style.background = sprintToggle ? 'rgba(120,255,140,.35)' : 'rgba(255,255,255,.14)';
});

// the stick's translucent home zone: it waits here faded, and glides back when let go
function joyHomePos() { return { x: 128, y: innerHeight - (innerHeight <= 430 ? 118 : 158) }; }
function joyGoHome() {
  const h = joyHomePos();
  joyBase.classList.remove('live');
  joyBase.classList.add('home');
  joyBase.style.left = h.x + 'px';
  joyBase.style.top = h.y + 'px';
  joyKnob.style.left = '50%'; joyKnob.style.top = '50%';
}
if (isTouch) joyGoHome();
addEventListener('resize', () => { if (isTouch && joyTouchId === null) joyGoHome(); });

let camLast = { x: 0, y: 0 };
touchLayer.addEventListener('touchstart', e => {
  initAudio();
  input.device = 'touch'; refreshControlsBar();
  for (const t of e.changedTouches) {
    if (t.target.closest('.tbtn')) continue;
    // tap on the weapon/ammo squircle (which lives beneath this layer): cycle the weapon, and
    // keep the finger owned here so it can't double as a camera swing
    if (weaponTouchId === null && inWeaponPanel(t)) {
      weaponTouchId = t.identifier;
      weaponPanel.classList.add('pressed');
      cycleWeapon(1);
      continue;
    }
    // the stick only claims the bottom-left quadrant — the upper-left corner aims the camera
    if (t.clientX < innerWidth * 0.45 && t.clientY > innerHeight * 0.5 && joyTouchId === null) {
      joyTouchId = t.identifier;
      joyOrigin = { x: t.clientX, y: t.clientY };
      joyBase.classList.remove('home');
      joyBase.classList.add('live');
      joyBase.style.left = t.clientX + 'px';
      joyBase.style.top = t.clientY + 'px';
      joyKnob.style.left = '50%'; joyKnob.style.top = '50%';
    } else if (camTouchId === null) {
      camTouchId = t.identifier;
      camLast = { x: t.clientX, y: t.clientY };
      aimPos[t.identifier] = { x: t.clientX, y: t.clientY };
    } else if (pinchTouchId === null) {
      // a second finger in the aim area: it's a pinch-to-zoom, not a look
      pinchTouchId = t.identifier;
      aimPos[t.identifier] = { x: t.clientX, y: t.clientY };
      const a = aimPos[camTouchId], b = aimPos[pinchTouchId];
      pinchDist = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    }
  }
}, { passive: false });
touchLayer.addEventListener('touchmove', e => {
  e.preventDefault();
  const pinching = pinchTouchId !== null;
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
      if (aimPos[camTouchId]) { aimPos[camTouchId].x = t.clientX; aimPos[camTouchId].y = t.clientY; }
      // while two fingers are down the aim finger only pinches — it doesn't swing the camera
      if (!pinching) {
        const sens = settings.mouseSens || 1;
        input.lookDX += (t.clientX - camLast.x) * 0.006 * sens;
        input.lookDY += (t.clientY - camLast.y) * 0.006 * sens;
      }
      camLast = { x: t.clientX, y: t.clientY };
    } else if (t.identifier === pinchTouchId) {
      if (aimPos[pinchTouchId]) { aimPos[pinchTouchId].x = t.clientX; aimPos[pinchTouchId].y = t.clientY; }
    }
  }
  // recompute the finger spread and feed the change to zoom (fingers together = zoom out)
  if (pinching && aimPos[camTouchId] && aimPos[pinchTouchId]) {
    const a = aimPos[camTouchId], b = aimPos[pinchTouchId];
    const nd = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAnalog((pinchDist - nd) * 0.01);
    pinchDist = nd;
  }
}, { passive: false });
function touchEnd(e) {
  for (const t of e.changedTouches) {
    delete aimPos[t.identifier];
    if (t.identifier === weaponTouchId) {
      weaponTouchId = null;
      weaponPanel.classList.remove('pressed');
    } else if (t.identifier === joyTouchId) {
      joyTouchId = null;
      joyGoHome();   // drift back to the faded home zone
      input.moveX = 0; input.moveY = 0;
    } else if (t.identifier === pinchTouchId) {
      pinchTouchId = null;
    } else if (t.identifier === camTouchId) {
      // if the aim finger lifts but the pinch finger is still down, promote it to the aim finger
      camTouchId = pinchTouchId; pinchTouchId = null;
      if (camTouchId !== null && aimPos[camTouchId]) camLast = { x: aimPos[camTouchId].x, y: aimPos[camTouchId].y };
    }
  }
}
touchLayer.addEventListener('touchend', touchEnd);
touchLayer.addEventListener('touchcancel', touchEnd);

// --- gamepad ---
addEventListener('gamepadconnected', e => {
  gpIndex = e.gamepad.index;
  const id = e.gamepad.id;
  // Nintendo's vendor id is 057e (Switch Pro pad + Joy-Cons); fall back to name matches
  input.gamepadKind =
    /057e|switch|joy-?con|nintendo/i.test(id) ? 'switch' :
    /dual|playstation|054c|ps4|ps5/i.test(id) ? 'ps' : 'xbox';
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
  // front-end screens (start / lobby / death / on-screen keyboard): the pad drives the UI
  if (game.state !== 'playing') {
    padMenuScreen(gp, dt, justPressed, mx, my);
    input.shootGamepad = false; gpPrev.rt = false;
    return;
  }
  const padSens = settings.padSens || 1;
  // D-pad down holds the emote wheel open; the right stick steers it (camera pauses)
  const dpadDown = gp.buttons[13] && gp.buttons[13].pressed;
  if (dpadDown && !ewheel.open) ewOpen('pad');
  else if (!dpadDown && ewheel.open && ewheel.src === 'pad') ewRelease();
  if (ewheel.open && ewheel.src === 'pad') {
    ewSteer(lx, ly, true);
  } else {
    input.lookDX += lx * 2.6 * dt * padSens;
    input.lookDY += ly * 2.0 * dt * padSens;
  }
  // d-pad left/right glide the zoom smoothly while held (same continuous feed as the pinch),
  // so you can slide all the way to min/max in one hold instead of tapping repeatedly
  if (pressed(15)) zoomAnalog(-ZOOM_PAD_RATE * dt); // d-pad right: zoom in
  if (pressed(14)) zoomAnalog(ZOOM_PAD_RATE * dt);  // d-pad left: zoom out
  if (justPressed(0)) input.jump = true;
  if (justPressed(1)) input.reload = true;
  if (justPressed(2)) input.interact = true;
  input.interactHeldPad = pressed(2);   // held X/Square feeds the hold-to-trade ring
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
if (isTouch) controlsEl.classList.add('collapsed'); // phones: start as a chip, tap to expand
controlsEl.addEventListener('click', () => { controlsEl.classList.remove('faded'); toggleControlsBar(); });
controlsEl.addEventListener('touchstart', e => { e.stopPropagation(); }, { passive: true });
function toggleControlsBar() { controlsEl.classList.toggle('collapsed'); }

// PC/controller only: the bar fades off 15s after the pause menu is first closed, then
// after that just flashes back for 5s each time pause is opened and shut again
let controlsFadedOnce = false;
let controlsFadeTimer = null;
function scheduleControlsFade() {
  if (isTouch) return; // touchmode hides the bar outright; nothing to fade here
  clearTimeout(controlsFadeTimer);
  controlsEl.classList.remove('faded');
  const delay = controlsFadedOnce ? 5000 : 15000;
  controlsFadedOnce = true;
  controlsFadeTimer = setTimeout(() => controlsEl.classList.add('faded'), delay);
}

const ICON = {
  kbm: p => `icons/kbm/${p}.png`,
  xbox: p => `icons/xbox/${p}.png`,
  ps: p => `icons/ps/${p}.png`,
  switch: p => `icons/switch/${p}.png`,
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
      [['kbm', 'keyboard_v'], 'First / Third view'],
      [['kbm', 'mouse_scroll_vertical'], 'Camera Zoom (Third)'],
      [['kbm', 'keyboard_escape'], 'Pause'],
      [['kbm', 'keyboard_e'], 'Interact'],
      [['kbm', 'keyboard_r'], 'Reload'],
      [['kbm', 'keyboard_space'], 'Jump'],
      [['kbm', 'keyboard_shift'], 'Sprint'],
      [['kbm', 'keyboard_ctrl'], 'Slide'],
      [['kbm', 'keyboard_tab'], 'Emote wheel (hold)'],
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
      [['xbox', 'xbox_button_view'], 'First / Third view'],
      [['xbox', 'xbox_dpad_horizontal'], 'Camera Zoom (Third)'],
      [['xbox', 'xbox_button_menu'], 'Pause'],
      [['xbox', 'xbox_button_color_x'], 'Interact'],
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
      [['ps', 'playstation_button_share'], 'First / Third view'],
      [['ps', 'playstation_dpad_horizontal'], 'Camera Zoom (Third)'],
      [['ps', 'playstation_button_options'], 'Pause'],
      [['ps', 'playstation_button_square'], 'Interact'],
      [['ps', 'playstation_button_circle'], 'Reload'],
      [['ps', 'playstation_button_cross'], 'Jump'],
      [['ps', 'playstation_stick_side_l'], 'Sprint (L3)'],
      [['ps', 'playstation_stick_side_r'], 'Slide (R3)'],
    ],
    prompt: ['ps', 'playstation_button_square'],
  },
  switch: {
    name: 'Nintendo Switch Controller',
    // Same positional button indices as the others, but Nintendo swaps the A/B and X/Y
    // LABELS versus Xbox: bottom is B, right is A, left is Y, top is X. So each glyph shows
    // the label that's physically under your thumb, while the action stays the same.
    rows: [
      [['switch', 'switch_stick_l'], 'Move'],
      [['switch', 'switch_stick_r'], 'Look'],
      [['switch', 'switch_button_zr'], 'Shoot'],
      [['switch', 'switch_button_zl'], 'Zoom / ADS'],
      [['switch', 'switch_button_x'], 'Swap weapon'],
      [['switch', 'switch_button_minus'], 'First / Third view'],
      [['switch', 'switch_dpad_horizontal'], 'Camera Zoom (Third)'],
      [['switch', 'switch_button_plus'], 'Pause'],
      [['switch', 'switch_button_y'], 'Interact'],
      [['switch', 'switch_button_a'], 'Reload'],
      [['switch', 'switch_button_b'], 'Jump'],
      [['switch', 'switch_stick_side_l'], 'Sprint (L3)'],
      [['switch', 'switch_stick_side_r'], 'Slide (R3)'],
    ],
    prompt: ['switch', 'switch_button_y'],
  },
  touch: {
    name: 'Touch',
    rows: [
      [['touch', 'touch_swipe_move'], 'Bottom left: joystick'],
      [['touch', 'touch_swipe_horizontal'], 'Elsewhere: look'],
      [['touch', 'touch_tap'], 'Tap ammo panel: swap weapon'],
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
  { id: 'blizzy',  name: 'Blizzy',  color: 0x6fd8ff, perk: '+12% sprint speed', melee: 'katana', lore: 'The coolest head of the six. Scouted the frozen north alone for two winters. Zombies can’t catch what they can’t chill.' },
  { id: 'blomba',  name: 'Blomba',  color: 0xb06fff, perk: '+25 max HP',    melee: 'sledge',  lore: 'Big-hearted bouncer of the old Blob Lounge. Soft on the inside, softer on the outside, absolutely will not fall over.' },
  { id: 'bloopy',  name: 'Bloopy',  color: 0x3fd8b0, perk: '35% faster reload', melee: 'pipe', lore: 'Fidgety tinkerer who rebuilt the family radio from soup cans. Hands so twitchy the reloads finish themselves.' },
  { id: 'blondie', name: 'Blondie', color: 0xffd84a, perk: '+50% ammo from loot', melee: 'machete', lore: 'The family hoarder. Her pockets don’t make sense geometrically. If there’s a bullet in a crate, she’ll find three.' },
];
// per-cousin hand skin tone — blob-kind comes in every colour of the blobby-rainbow, so the
// family doesn't all share one mitt: Blondie runs pale, Bloopy a touch browner, Blomba a warm
// tan. The rest keep the family default (0xffd7a8, baked into buildBlob). Knuckles auto-darken.
const COUSIN_HANDS = { blondie: 0xffe7cf, bloopy: 0xc79a6a, blomba: 0xe4b98c };
function cousinHands(id) { return COUSIN_HANDS[id] || 0; }
let selectedCousin = 'blingo';
// the living-tab controller (set up far below): { lockTo(idx), unlock() }. Declared here so
// the run-start / skin-swap / quit hooks can reach it before its definition runs.
let tabTitle = null;
// the multiplayer session (its lobby wiring lives far below). Declared up here because the
// settings UI is built at load and reads net.role for the gore-horde notch glow, well before
// the lobby code runs — a later const would still be in its temporal dead zone at that point.
const net = { role: null, peer: null, conns: [], playerNum: 0, lobbyCode: '',
  ghosts: new Map(), actors: new Map(), recruits: new Map(), txT: 0, zid: 0, pkid: 0, scan: null, leaving: false, barSig: '',
  hostPaused: false, hostGoreHorde: false };

// ---------- prestige (persisted across runs; shown as badges on the menu) ----------
const prestige = { blocks: {}, bestTime: 0, bestHero: '', campaign: 0, bestStreak: 0 };
// The block is not the block it was: the Infected One now stands between the Crimson One and
// the street party, so every clear banked before him was banked on a shorter game and every
// record time was set on one. Those runs don't compare, so the old save is dropped rather
// than shown next to new ones — new key, and the old one deleted so it can't linger.
const PRESTIGE_KEY = 'blingo-prestige-v2';
try { localStorage.removeItem('blingo-prestige'); } catch (e) {}
try {
  const saved = JSON.parse(localStorage.getItem(PRESTIGE_KEY) || '{}');
  if (saved && typeof saved === 'object') {
    if (saved.blocks && typeof saved.blocks === 'object')
      for (const k in saved.blocks) if (Number.isInteger(saved.blocks[k]) && saved.blocks[k] > 0) prestige.blocks[k] = saved.blocks[k];
    if (typeof saved.bestTime === 'number' && saved.bestTime > 0) prestige.bestTime = saved.bestTime;
    if (typeof saved.bestHero === 'string') prestige.bestHero = saved.bestHero;
    if (Number.isInteger(saved.campaign) && saved.campaign > 0) prestige.campaign = saved.campaign;
    if (Number.isInteger(saved.bestStreak) && saved.bestStreak > 0) prestige.bestStreak = saved.bestStreak;
  }
} catch (e) {}
// a run is "new game plus" once the family has been made whole THIS SESSION: the first
// playthrough after a page load or a quit-to-menu is always the hardcoded, Bluga-less
// classic town — consistency first, the FBI earned as prestige. Clearing the campaign
// within the session (sessionCampaign++) is what puts you on his radar; the persisted
// prestige.campaign still drives the menu badges.
let sessionCampaign = 0;
function isPrestigeRun() { return sessionCampaign > 0; }
function recordPrestige() {
  prestige.blocks[selectedCousin] = (prestige.blocks[selectedCousin] | 0) + 1;
  if (!prestige.bestTime || game.time < prestige.bestTime) { prestige.bestTime = game.time; prestige.bestHero = selectedCousin; }
  try { localStorage.setItem(PRESTIGE_KEY, JSON.stringify(prestige)); } catch (e) {}
  renderPrestige();
}
function fmtTime(t) { return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'); }
// badge strip: the best block streak (most reunions chained back-to-back), plus the record
// time in the colour of the hero who set it (single + multiplayer runs both feed these)
function renderPrestige() {
  const el = document.getElementById('prestige');
  el.innerHTML = '';
  const mkBadge = (txt, hex) => {
    const b = document.createElement('div');
    b.className = 'badge';
    if (hex) b.style.setProperty('--bc', hex);
    b.textContent = txt;
    el.appendChild(b);
    return b;
  };
  // BLOCKS SECURED is the best STREAK — the most reunions strung together consecutively, not
  // the lifetime tally. One win is one block; each Bluga run that follows without a quit-to-menu
  // adds another, so a big number means a long unbroken chain, the prestige worth showing.
  // white base glow, so at rest it never reads as Blondie's — the rainbow only rides the
  // entry animation (the .grandma class), then it settles back to white (grandma's spirit)
  if (prestige.bestStreak > 0) mkBadge(`BLOCKS SECURED x${prestige.bestStreak}`, '#ffffff').classList.add('grandma');
  if (prestige.bestTime > 0) {
    const hero = COUSINS.find(c => c.id === prestige.bestHero);
    mkBadge(`FASTEST ${fmtTime(prestige.bestTime)}`, '#' + (hero ? hero.color : 0xffd24a).toString(16).padStart(6, '0'));
  }
  el.style.display = el.children.length ? 'flex' : 'none';
}
const companions = []; // {data, blob, beacon, pos, recruited, shootCd, walkPhase, yaw}

// one shared beacon shaft for cousins, rescues and the player's own down-marker:
// wide enough to stand clear of a blob's belly instead of slicing through it, and
// tall enough to run into the sky — with the deep draw distance it reads from
// anywhere the fog allows, dissolving upward where the beam outruns the fog line
const BEACON_GEO = new THREE.CylinderGeometry(0.85, 0.85, 120, 10, 1, true);
const BEACON_Y = 60; // centre height: base on the dirt, crown in the clouds
function makeBeacon(color, opacity) {
  return new THREE.Mesh(BEACON_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
}

// true when nothing solid overlaps a character-sized circle at (x,z): keeps spawns out
// of cars, rocks, shelf-filled corners and the sealed town facades (which sit in town)
function spotOpenFor(x, z) {
  const gy = groundHeight(x, z);
  for (const c of nearbyColliders(x, z)) {
    if (Math.abs(x - c.x) < c.hw + 0.55 && Math.abs(z - c.z) < c.hd + 0.55 && gy < c.y1 - 0.2) return false;
  }
  return true;
}
function spawnSpotClear(x, z) {
  if (inTown(x, z, 2)) return false;
  return spotOpenFor(x, z);
}
// Everyone waits where their story says they would. Blingo at the foot of his own
// granite likeness, Blazo back at the family chili stand, Blomba outside her lounge,
// Bloopy by the radio shop he rebuilt. Blizzy is the scout: always the farthest out of
// all six — and her bearing rides on Blondie's roll. Blondie wanders somewhere far on a
// fresh random bearing every run, and Blizzy scouts the OPPOSITE side of the map from
// wherever the hoarder ended up: different sides always, and twice the run-to-run
// volatility for the one cousin who'd hate to be predictable.
const COUSIN_HOMES = {
  blingo: [129, -37.5],  // the statue lawn — his beacon rises over his own monument
  blazo:  [119.5, 61],   // Red's Chili, two blocks up the side road
  blomba: [122, -110.5], // the Blob Lounge doorstep, far side of it all
  bloopy: [69.5, -31],   // beside the RADIO shop
};
function scatterCousins() {
  for (const c of companions) {
    scene.remove(c.blob.root);
    if (c.blob.shadow) scene.remove(c.blob.shadow);
    if (c.beacon) scene.remove(c.beacon);
  }
  companions.length = 0;
  recruitCounter = 0;
  // Blondie's roll happens first so Blizzy can take the opposite bearing. On a prestige
  // run the compass is fixed: Blondie draws SOUTH, which pins the scout to the true
  // north — Blizzy stays the farthest out of everyone, holding the direction Bluga's
  // smoke trick always escapes toward.
  const blondieAng = game.prestigeRun ? (Math.random() - 0.5) * 0.6 : Math.random() * TAU;
  const blondieDist = 85 + Math.random() * 45;
  let i = 0;
  for (const data of COUSINS) {
    if (data.id === selectedCousin) continue;
    // cousins wait on open land, roads or inside the enterable hollow houses — never
    // wedged into cars, rocks, shelves or the sealed town buildings
    let x = 0, z = 0;
    const home = COUSIN_HOMES[data.id];
    if (home) {
      // homebodies: land on the doorstep, drifting only as far as blocked ground demands.
      // These spots sit inside town rects, so only the collider check gates them.
      for (let tries = 0; tries < 24; tries++) {
        const jit = 1 + tries * 0.45;
        x = home[0] + (Math.random() - 0.5) * jit;
        z = home[1] + (Math.random() - 0.5) * jit;
        [x, z] = resolveCollision(x, z, 0.6);
        if (spotOpenFor(x, z)) break;
      }
    } else {
      const far = data.id === 'blizzy';
      for (let tries = 0; tries < 24; tries++) {
        // Blondie: her own fresh bearing. Blizzy: 180 degrees off it, half again as deep.
        const ang = (far ? blondieAng + Math.PI : blondieAng) + (Math.random() - 0.5) * 0.5;
        const dist = far ? blondieDist * 1.5 + 25 + Math.random() * 20 : blondieDist + Math.random() * 12;
        x = Math.sin(ang) * dist; z = Math.cos(ang) * dist;
        [x, z] = resolveCollision(x, z, 0.6);
        if (spawnSpotClear(x, z)) break;
      }
    }
    const blob = buildBlob({ color: data.color, gunHand: data.id === 'blondie' ? 'left' : 'right', hands: cousinHands(data.id) });
    blob.root.position.set(x, groundHeight(x, z), z);
    scene.add(blob.root);
    const beacon = makeBeacon(data.color, 0.28);
    beacon.position.set(x, groundHeight(x, z) + BEACON_Y, z);
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
  // AI cousins stack on top in the order they were found; live players group at the
  // BOTTOM of the stack, right against your own bar, lowest player number nearest it.
  // Sorting by number (not join order) means a lapsed P2 leaves P3 sitting beside you,
  // and whoever fills the P2 seat later slides in between — the column self-heals into
  // numeric order from your bar upward, on every screen from that screen's own view.
  const squad = companions.filter(c => c.recruited).sort((a, b) => {
    if (!!a.netP !== !!b.netP) return a.netP ? 1 : -1;
    if (a.netP && b.netP) return b.netP - a.netP;
    return (a.order || 0) - (b.order || 0);
  });
  for (const c of squad) {
    const hex = '#' + c.data.color.toString(16).padStart(6, '0');
    const row = document.createElement('div');
    // cousins driven by a real player get a hero-sized bar with their player tag
    row.className = 'sqrow' + (c.netP ? ' pc' : '');
    const label = (c.netP ? 'P' + c.netP + ' ' : '') + c.data.name;
    row.innerHTML = `<div class="sqwrap"><div class="sqbar" style="background:${hex}"></div></div>` +
                    `<span class="sqname" style="color:${hex}">${label}</span>`;
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
  // player-controlled cousins take their damage on their own screen
  if (c.netP) { if (c.netConn) { try { c.netConn.send({ t: 'hurt', d: dmg }); } catch (e) {} } return; }
  if (c.downed || !c.recruited) return;
  // The Infected One's plague goes through an AI cousin like paper — they fold three times
  // as fast while he stands. This sits below the netP hand-off on purpose: a real person
  // driving a cousin takes normal damage, so a squad of bots won't carry this fight and a
  // lobby of people will. That gap is the whole point of him. The Rotten One inherited the
  // sickness whole — same playstyle, same plague.
  if (infectedFightOn() || rottenFightOn()) dmg *= INFECTED_NPC_DMG;
  c.hp -= dmg;
  c.lastHurtT = game.time;
  flashBlob(c.blob);
  spawnDamageNumber(c.pos.x, (c.y || 0) + 1.8, c.pos.z, dmg, '#' + c.data.color.toString(16).padStart(6, '0'));
  if (c.hp <= 0) {
    // downed, not dead — but they stay down until you walk over and pick them up
    c.hp = 0; c.downed = true;
    play3d(c.pos.x, c.pos.z, () => SFX.hurt());
    // red rescue beacon marks where they fell
    c.beacon = makeBeacon(0xff3b3b, 0.3);
    c.beacon.position.set(c.pos.x, groundHeight(c.pos.x, c.pos.z) + BEACON_Y, c.pos.z);
    scene.add(c.beacon);
    toast(`${c.data.name.toUpperCase()} IS DOWN .ᐟ`);
  }
}
// haul a downed cousin back onto their feet — a rescue is a TRANSFUSION now: half the
// rescuer's current health goes with the pull, and the revived stand up with exactly
// what it cost (the rescuer never drops below 1). `free` skips the cost for revives
// that aren't anyone's arms doing the hauling (a joining player taking over a body).
function reviveCousin(c, free) {
  let pay = 0;
  if (!free) {
    pay = Math.max(1, Math.round(player.hp / 2));
    player.hp = Math.max(1, player.hp - pay);
  }
  // a player-controlled cousin lives on someone else's screen: they own the state, so
  // ask them to stand up rather than pretending we did it here — the transfusion rides along
  if (c.netP) {
    if (c.netConn) { try { c.netConn.send({ t: 'revive', hp: pay }); } catch (e) {} }
    c.downed = false;
    c.hp = pay ? Math.min(pay, c.maxHp) : c.hp; // mirror it host-side until their next pose lands
    netSyncCousinBeacon(c);
    SFX.recruit();
    rumble(140, 0.5, 0.6);
    toast(`PLAYER ${c.netP} IS BACK UP`);
    return;
  }
  c.downed = false;
  c.hp = free ? c.maxHp * 0.5 : Math.min(pay, c.maxHp);
  c.blob.wob.rotation.x = 0;
  c.blob.wob.scale.set(1, 1, 1);
  if (c.beacon) { scene.remove(c.beacon); c.beacon = null; }
  SFX.recruit();
  rumble(140, 0.5, 0.6);
  toast(`${c.data.name.toUpperCase()} IS BACK UP`);
}
// host-side: a downed player's rescue beacon, driven off their streamed state
function netSyncCousinBeacon(c) {
  if (c.downed && !c.beacon) {
    c.beacon = makeBeacon(0xff3b3b, 0.3);
    scene.add(c.beacon);
  } else if (!c.downed && c.beacon) { scene.remove(c.beacon); c.beacon = null; }
  if (c.beacon) c.beacon.position.set(c.pos.x, groundHeight(c.pos.x, c.pos.z) + BEACON_Y, c.pos.z);
}

// ---------- player ----------
let playerBlob = buildBlob({ color: 0xff8c42 });
scene.add(playerBlob.root);
let gunMesh = null;
// Give the player blob its OWN copies of every material so we can fade the whole avatar out
// under the sniper scope without touching the shared material cache the rest of the world
// draws from. The gun sits under gunSocket and is skipped (its models are re-equipped from
// shared mats constantly) — it's dropped by a plain visibility toggle instead. Rebuilt after
// applyCousin, which swaps in a fresh blob.
let playerBodyMats = [];
function ownPlayerBodyMats() {
  playerBodyMats = [];
  (function walk(node) {
    if (node === playerBlob.gunSocket) return; // never descend the gun
    if (node.material && node.material !== shadowMat) {
      if (!node.userData._ownMat) { node.material = node.material.clone(); node.userData._ownMat = true; }
      playerBodyMats.push(node.material);
    }
    for (const c of node.children) walk(c);
  })(playerBlob.root);
}
ownPlayerBodyMats();

const player = {
  pos: new THREE.Vector3(0, 0, 0),
  vy: 0, grounded: true,
  hp: 100, maxHp: 100,
  camYaw: 0, camPitch: -0.24, groundCamT: 0,
  weapon: WEAPONS.fists,
  clip: Infinity,
  reloading: 0, shootCd: 0, lastShotT: -9, lastHurtT: -9,
  walkPhase: 0, squash: 0, dead: false, idlePhase: 0, bobT: 0,
  stumbleT: 0, stumbleX: 0, stumbleZ: 0, meleeArm: 0,
  // fists combo: comboN is the swing's place in the current chain (0 = opener). It rolls
  // 6,7,6,7 while the chain holds and resets to a 6 opener once COMBO_WINDOW lapses.
  comboN: 0, lastPunchT: -9,
  swingT: 0, swingDur: 0.999,           // drives the melee swing arc
  meleeChopT: 0, meleeChopHop: false,   // the follow-through down swing lands mid-arc
  dropKick: false, dropKickHard: false, // committed air move: rides out until you land
  dropKickHits: null, dkX: 0, dkZ: 0,   // the locked-in line of the dive
  // downed: with another human in the run you drop to a crawl instead of dying, and
  // bleed back up on your own so nobody gets dumped out of the session
  downed: false, downT: 0, beacon: null, dripT: 0,
  slideT: 0, slideDX: 0, slideDZ: 0, hopT: 0,
  dmgMult: 1, sprintMult: 1, reloadMult: 1, ammoMult: 1, jumpMult: 1, meleeMult: 1,
  owned: ['fists'], aiming: false, aimT: 0,   // aimT: eased 0=hip .. 1=aiming down / zoomed
  fpv: false, fpvT: 0,                         // fpv toggle (V / Select); fpvT eased 0=third-person .. 1=first-person
};
const reserves = {};

// take damage: stumble away from the hit, still able to fight; heavy gore paints the screen
// ---------- going down ----------
// Another human in the run means a bite puts you on your belly instead of out of the
// game: they can haul you up, and even if nobody comes, you bleed back up on your own.
// Alone — or with only AI cousins, who can't revive you — death still means death.
const DOWN_BLEED = 15;
const INFECTED_NPC_DMG = 3;   // what the Infected One does to a cousin nobody's driving
function hasHumanAlly() {
  if (net.role === 'client') return true;                  // the host is a person
  if (net.role === 'host') return companions.some(c => c.netP);
  return false;
}
function goDown() {
  if (player.downed || player.dead) return;
  player.downed = true;
  player.downT = DOWN_BLEED;
  player.hp = 0;
  // carrying grandma's jelly: the jar breaks itself open — 3 seconds of bleeding purple,
  // then it stands you back up whole (jellyRevive, run from the downed block)
  player.jellyT = player.owned.includes('jelly') ? 3 : 0;
  // giant chili wears off the instant you hit the floor: nobody bleeds out boss-sized
  if (player.giantPhase || player.giantHpBoost) { playerFadeEnd(); giantHpOff(); player.giantPhase = null; player.giantScale = 1; player.giantT = 0; playerBlob.root.scale.setScalar(1); updateGiantHud(); }
  // everything committed gets dropped — you are not drop-kicking from the floor
  player.slideT = 0; player.hopT = 0; player.swingT = 0;
  player.dropKick = false; player.dropKickHits = null;
  if (!player.beacon) {
    player.beacon = makeBeacon(0xff3b3b, 0.3);
    scene.add(player.beacon);
  }
  SFX.hurt();
  rumble(400, 1, 0.8);
  shakeAmp = Math.max(shakeAmp, 0.14);
  // going down only happens with human allies around, so the callout is lobby-speak:
  // short, name-tagged, the same line everyone else sees on their screen
  const me = COUSINS.find(c => c.id === selectedCousin);
  toast(`P${net.playerNum || 1} ${(me ? me.name : '').toUpperCase()} DOWN .ᐟ`, true);
}
// hp: what the rescuer's transfusion delivered — a rescued player stands up with exactly
// the health it cost to haul them, not a flat half; the self-recovery keeps its 35%
function playerGetUp(byRescue, hp) {
  if (!player.downed) return;
  player.downed = false; player.downT = 0;
  player.hp = byRescue
    ? clamp(Math.round(hp || player.maxHp * 0.5), 1, player.maxHp)
    : Math.max(1, Math.round(player.maxHp * 0.35));
  if (player.beacon) { scene.remove(player.beacon); player.beacon = null; }
  playerBlob.wob.rotation.x = 0;
  SFX.recruit();
  rumble(140, 0.5, 0.6);
  toast(byRescue ? 'BACK ON YOUR FEET .ᐟ' : 'YOU DRAGGED YOURSELF BACK UP .ᐟ');
}
// the jar does its work: consumed from the inventory, a FULL-health self revive, the
// family toast, and your own Nice fired without asking — grandma knew what she had
function jellyRevive() {
  const i = player.owned.indexOf('jelly');
  if (i >= 0) player.owned.splice(i, 1);
  if (player.weapon.id === 'jelly') equipWeapon('fists');
  player.downed = false; player.downT = 0; player.jellyT = 0;
  player.hp = player.maxHp;
  if (player.beacon) { scene.remove(player.beacon); player.beacon = null; }
  playerBlob.wob.rotation.x = 0;
  SFX.recruit();
  rumble(320, 0.9, 0.8);
  toast('GOOD JELLY .ᐟ', true);
  fireEmote(2); // 'Nice .ᐟ'
  spawnParticles(player.pos.x, player.pos.y + 1.2, player.pos.z, 0xb06fff, 26, 5, 1);
  updateAmmoHUD();
}

function hurtPlayer(dmg, awayX, awayZ) {
  // already on the floor: being chewed on can't finish you, that's the whole promise of
  // the bleed-out timer
  if (player.dead || player.downed) return;
  player.hp -= dmg;
  player.lastHurtT = game.time;
  spawnDamageNumber(player.pos.x, player.pos.y + 1.8, player.pos.z, dmg, player.colorHex);
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
  // the GOOD JELLY is a reason to go down instead of die even alone: it stops the rot
  if (player.hp <= 0 && !player.dead) { if (hasHumanAlly() || player.owned.includes('jelly')) goDown(); else die(); }
}

function applyCousin(id) {
  selectedCousin = id;
  const data = COUSINS.find(c => c.id === id);
  scene.remove(playerBlob.root);
  if (playerBlob.shadow) scene.remove(playerBlob.shadow);
  playerBlob = buildBlob({ color: data.color, gunHand: id === 'blondie' ? 'left' : 'right', hands: cousinHands(id) });
  scene.add(playerBlob.root);
  player.colorHex = '#' + data.color.toString(16).padStart(6, '0');
  document.documentElement.style.setProperty('--hero', player.colorHex);
  startTheme(id);
  player.dmgMult = id === 'blazo' ? 1.15 : 1;
  player.sprintMult = id === 'blizzy' ? 1.12 : 1;
  player.maxHp = id === 'blomba' ? 125 : 100;
  player.reloadMult = id === 'bloopy' ? 0.65 : 1;
  player.ammoMult = id === 'blondie' ? 1.5 : 1;
  player.jumpMult = id === 'blingo' ? 1.1 : 1; // unlisted perk: the "balanced hero" quietly jumps higher
  // unlisted perk: the bouncer. Any melee Blomba swings lands half again as hard, her
  // kills come apart instead of just falling, and every one feeds her (see blombaVamp)
  player.meleeMult = id === 'blomba' ? 1.5 : 1;
  if (gunMesh) { gunMesh.removeFromParent(); gunMesh = null; }
  equipWeapon(player.weapon.id === 'fists' ? 'fists' : player.weapon.id);
  ownPlayerBodyMats(); // the fresh blob needs its own fade-able materials again
  // mid-run, a skin swap re-locks the tab title to the traded hero (spell it once, then hold);
  // at the menu the title keeps cycling — startRun does the first lock
  if (game.state === 'playing' || game.state === 'paused')
    tabTitle && tabTitle.lockTo(COUSINS.findIndex(c => c.id === id));
}

function equipWeapon(id) {
  player.weapon = WEAPONS[id];
  if (!player.owned.includes(id)) player.owned.push(id);
  // keep the loadout organised into slots: melee group first, then guns by tier
  player.owned.sort((a, b) => slotRank(a) - slotRank(b));
  // any equip (crate pickup, skin swap, respawn) cuts a reload short — clear its banner too,
  // or the "RELOADING . ." text is stranded on screen until the next reload finishes it
  if (gunMesh) { player.reloading = 0; if (hud && hud.reloadmsg) hud.reloadmsg.style.opacity = 0; gunMesh.removeFromParent(); gunMesh = null; }
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
  // don't let a swap interrupt a reload mid-way (that's what stranded the "RELOADING . ."
  // banner): the gun we're loading stays out, and we re-sound the reload cue so the input
  // reads as "not yet — finishing the mag"
  if (player.reloading > 0) { SFX.reload(); return; }
  let idx = player.owned.indexOf(player.weapon.id);
  if (idx < 0) idx = 0;
  let id = player.weapon.id;
  // a giant's hands are melee-only until the shrink lands: the cycle walks the loadout but
  // skips every gun (and the consumables, which a giant can't use anyway)
  for (let n = 0; n < player.owned.length; n++) {
    idx = (idx + dir + player.owned.length) % player.owned.length;
    const cand = player.owned[idx];
    if (!playerGiantAny() || (WEAPONS[cand].melee && !WEAPONS[cand].consumable)) { id = cand; break; }
  }
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
// opts.goreHorn: the gore-horde extra — an Infected-style green horned brute, but a FREE walker.
//   It looks exactly like the Infected One's minions yet never shields a boss (no hornWave),
//   so it can join the ordinary street horde without breaking the boss-shield rule.
function spawnZombie(x, z, powerScale = 1, opts = {}) {
  const purple = !!opts.purple;              // boss-swarm variant: purple & 33% faster
  const red = !!opts.red;                    // Crimson One's church swarm: red & quick
  const goreHorn = !!opts.goreHorn;          // gore-horde extra: green horned brute, but no boss shield
  const green = !!opts.green || goreHorn;     // Infected One's lot swarm: the red brute, 10% bigger
  const horns = !!opts.horns || goreHorn;
  const mode = opts.mode || 'pop';
  const scale = (0.85 + Math.random() * 0.5) * (green ? 1.1 : 1);
  // random rot-variants; brain-showing spawns are the rare weak-spot walkers. A laying
  // corpse is far gone — skull cracked open, eye gone, chest and stomach split: it rolls
  // every rot at nearly even odds and they STACK, so no two carcasses rot alike
  const corpse = mode === 'corpse';
  const droopy = !corpse && !purple && !red && !green && Math.random() < 0.3;
  const brain = corpse ? Math.random() < 0.4 : Math.random() < 0.12;
  const blind = !corpse && !purple && !red && !green && Math.random() < 0.16;
  // extra-gore mode makes fresh zombies spawn already mangled and bloody; a corpse always
  // spawns wounded — it's already dead, a carcass for the crows to pick over
  const wounded = mode === 'corpse' || (extraGoreOn() && Math.random() < 0.35 + settings.extraGore * 0.5);
  const color = green ? 0x39b83a : red ? 0xd43a3a : purple ? 0x9b4dff : ZOMBIE_COLORS[(Math.random() * ZOMBIE_COLORS.length) | 0];
  // the coloured variants get matching mitts: dark purple on the purple guards, dark red
  // on the crimson ones — no more default-green hands on a purple body
  const blob = buildBlob({ color, zombie: true, scale, droopy, brain, blind, wounded,
    hands: purple ? 0x4a1a7a : red ? CRIMSON_HANDS : 0 });
  // the Rotten One's sickness: his own minions (opts.rot) always roll for it, and once he
  // has risen EVERY street spawn can come up rotting too — the hanging eye, the slight left
  // ribs with a small beating heart tucked under, the stomach showing pink. It rides through
  // the fight AND the whole trek/late-game after (rotOnBlock), not just while he's standing
  const rotty = !!opts.rot || rotOnBlock() || corpse;
  const rotE = rotty && Math.random() < (corpse ? 0.5 : 0.28);
  // the chest opens on ONE side only at spawn: heart side or the mirrored no-heart side,
  // never both — a second side only ever comes from a kill shot after the fact
  const rotChest = rotty && Math.random() < (corpse ? 0.5 : 0.26);
  const rotRR = rotChest && Math.random() < 0.5;   // the side without the heart
  const rotR = rotChest && !rotRR;                  // the heart side
  const rotB = rotty && Math.random() < (corpse ? 0.55 : 0.3);
  const rotEyeSide = Math.random() < 0.5 ? 1 : -1;   // street rot + minions hang either side
  if (rotE || rotR || rotRR || rotB) addRotGore(blob, { hangEye: rotE, ribs: rotR, ribsR: rotRR, belly: rotB, eyeSide: rotEyeSide });
  blob.root.position.set(x, groundHeight(x, z), z);
  if (horns) {
    for (const s of [-1, 1]) {
      const horn = cyl(0.015, 0.12, 0.42, 0x2a1a3a, 6);
      horn.position.set(0.2 * s, 0.28, 0.02); horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
      blob.head.add(foldSkin(blob, horn));  // horns flash with the body under fire
    }
  }
  // a boss's shield guard wears the loot glow in its OWN body colour — purple guard glows
  // purple, red red, green green — so the shield-breakers read at a glance across the block.
  // goreHorn brutes never glow: they look the part but shield nobody.
  if ((opts.horns || opts.shield) && !goreHorn) {
    const gl = makeLootGlow(purple ? 0x9b4dff : red ? 0xd43a3a : 0x39b83a, { r: 0.85, y: 2.1, s: 1.5 });
    gl.userData.glow.orb.visible = false; // ground circle only — no floating spot over their head
    blob.root.add(gl);
    blob.guardGlow = gl;
  }
  // 1-in-10 shuffles in already missing an arm, a dried blood glob capping the shoulder.
  // A laying corpse is far more likely to have lost one somewhere along the way
  if (Math.random() < (corpse ? 0.35 : 0.1)) {
    const idx = Math.random() < 0.5 ? 0 : 1;
    blob.arms[idx].visible = false;
    blob.armGone[idx] = true;
    const glob = ball(0.16, BLOOD);
    glob.position.copy(blob.arms[idx].position);
    glob.position.y -= 0.15;
    blob.wob.add(foldSkin(blob, glob));   // the shoulder cap flashes with the body too
  }
  if (mode === 'sleeper' || mode === 'corpse') blob.root.rotation.x = -1.45; // sprawled on its back — a sleeper, or a carcass that never gets up
  scene.add(blob.root);
  zombies.push({
    blob, pos: new THREE.Vector3(x, 0, z),
    hp: mode === 'corpse' ? (3 + Math.random() * 3) * scale : (9 + Math.random() * 6) * scale * powerScale * (purple || red || green ? 1.2 : 1),
    speed: (1.5 + Math.random() * 1.4) * (0.9 + powerScale * 0.1) * (purple ? 1.33 : (red || green) ? 1.25 : 1) * (mode === 'runner' ? 1.5 : 1),
    yaw: Math.random() * TAU,
    state: mode === 'grave' ? 'emerge' : mode === 'sleeper' ? 'sleep' : mode === 'corpse' ? 'corpse' : 'chase',
    attackT: 0, deadT: 0, walkPhase: Math.random() * 10,
    groanT: Math.random() * 6, scale,
    brainExposed: brain, blind, droopy, stepT: Math.random(),
    // head-animation pool: twitches, double-takes and (straight-brow ones) a mouth gape —
    // fired off headT, jumped by a blind repath (repathed). See runHeadAnim.
    headT: Math.random() * 2.5, headAnim: null, repathed: false,
    bleeding: wounded, dripT: 0, purple, red, green, goreHorn, biteMult: (red || green) ? 1.35 : 1,
    rotE, rotR, rotRR, rotB, // streamed so a joiner's ghosts rot the same way
    // hornWave = a boss's shield guard while alive. opts.horns wears the horns and shields;
    // opts.shield shields WITHOUT horns (the Rotten One's hornless minions are his shield).
    // goreHorn deliberately sets neither — a free walker that never shields a boss.
    // hornVis carries what the head actually WEARS, so clients never sprout horns on a
    // shield-only guard (the ho stream reads this, not hornWave).
    mode, emergeT: 0, hornWave: !!opts.horns || !!opts.shield, hornVis: horns,
    farBorn: mode === 'runner', // runners live on a longer leash — they were born out past the fog
    // vertical: feet track a standable top with a step-up + gravity, so a walker climbs
    // in over a graded doorway threshold instead of stalling at the door (see updateZombies)
    feetY: groundHeight(x, z), vy: 0, grounded: true, reachT: 0, clawPhase: Math.random() * TAU,
    punchT: 0, blocked: false,
    wanderT: 0, wanderYaw: Math.random() * TAU, shotIgnoreT: -99,
  });
  // hand the fresh walker back: Bluga's cameo tracks its prey by it (without this his
  // demonstration thought the mob was dead on arrival and cut straight to the goodbye)
  return zombies[zombies.length - 1];
}

// ---------- pickups ----------
const pickups = [];
function spawnPickup(kind, x, z, fromY) {
  const g = new THREE.Group();
  if (kind === 'ammo') {
    const b = box(0.3, 0.2, 0.22, 0x3f6d3a, { emissive: 0x1a3a14, emissiveIntensity: 0.8 });
    b.position.y = 0.1; g.add(b);
  } else if (kind === 'bestjelly') {
    // a jar of the good stuff, dropped off a fallen perimeter guard — purple glass, waxed cap
    const glass = cyl(0.13, 0.11, 0.26, 0xffffff, 10);
    glass.material = new THREE.MeshLambertMaterial({ color: 0x8a4dd0, emissive: 0x2a0d4a, emissiveIntensity: 0.7 });
    glass.position.y = 0.15; g.add(glass);
    const lid = cyl(0.14, 0.14, 0.05, 0xe8dcc0, 10); lid.position.y = 0.3; g.add(lid);
    const band = cyl(0.135, 0.135, 0.03, 0xb4642a, 10); band.position.y = 0.27; g.add(band);
  } else {
    const b = box(0.32, 0.22, 0.32, 0xd8dde5);
    b.position.y = 0.11; g.add(b);
    const c1 = box(0.22, 0.06, 0.07, 0xd23b3b); c1.position.y = 0.23; g.add(c1);
    const c2 = box(0.07, 0.06, 0.22, 0xd23b3b); c2.position.y = 0.23; g.add(c2);
  }
  // fromY: spawn airborne (crow kills) and fall until we land on a roof/car/terrain
  const restY = supportTop(x, z, fromY != null ? fromY : groundHeight(x, z) + 0.1, 0.5);
  g.position.set(x, fromY != null ? fromY : restY, z);
  scene.add(g);
  const p = { mesh: g, kind, pos: new THREE.Vector3(x, 0, z), t: 0,
    y: g.position.y, vy: 0, falling: fromY != null, restY,
    nid: ++net.pkid };   // network id: the host streams its drops so every screen can loot them
  pickups.push(p);
  return p;
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
// the two bosses' liveries, shared by the local spawn and the client-side ghost so a
// joiner sees the same monster the host does
const BOSS_PURPLE = 0x8a2be2, BOSS_CRIMSON = 0xc22626, CRIMSON_HANDS = 0x6e1414;
// how much blood to throw: base gore slider, boosted by the unlocked extra-gore slider
function goreAmt() { return settings.gore + settings.extraGore * 1.4; }
function extraGoreOn() { return settings.gore >= 0.999 && settings.extraGore > 0; }
// stretches + points a gore mesh along its launch direction — a hit thrown hard enough
// reads as a streak, not a puff. Only worth bothering with above ~1.05x; the one caller
// that ever hands in more is the giant's slide-hop kick, scaled off its own knockback.
const _streakUp = new THREE.Vector3(0, 1, 0), _streakDir = new THREE.Vector3(), _streakScale = new THREE.Vector3();
function streakMesh(m, kx, kz, stretch) {
  if (stretch <= 1.05) return;
  const s = clamp(stretch, 1, 3);
  _streakDir.set(kx || 0, 0.4, kz || 0).normalize();
  m.quaternion.setFromUnitVectors(_streakUp, _streakDir);
  m.scale.multiply(_streakScale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s)));
}
function spawnBlood(x, y, z, kx, kz, mult = 1, stretch = 1) {
  const g = goreAmt();
  if (g <= 0.02) return;
  const n = Math.round((3 + Math.random() * 4) * g * mult);
  const s = clamp(stretch, 1, 3);
  for (let i = 0; i < n; i++) {
    if (particles.length > 240) break;
    const m = new THREE.Mesh(partGeo, mat(BLOOD));
    m.position.set(x, y, z);
    streakMesh(m, kx, kz, s);
    scene.add(m);
    particles.push({
      // a streak also flies faster and a beat longer, so the smear actually covers ground
      // before it lands instead of just looking stretched in place
      mesh: m, life: 0.5 * (0.6 + Math.random() * 0.8) * (s > 1.05 ? 1.4 : 1), blood: true,
      vx: (kx || 0) * 2 * s + (Math.random() - 0.5) * 3, vy: Math.random() * 3 * Math.sqrt(s), vz: (kz || 0) * 2 * s + (Math.random() - 0.5) * 3,
    });
  }
  if (extraGoreOn() && Math.random() < 0.5 + settings.extraGore * 0.5) groundSplat(x, z, 0.4 + Math.random() * 0.6 * mult * s);
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
function spawnGib(x, y, z, color, kx, kz, stretch = 1) {
  if (gibs.length > 60) return;
  const s = clamp(stretch, 1, 3); // gibs tumble immediately (spin below), so the streak orientation
  const m = new THREE.Mesh(gibGeo, mat(color));           // wouldn't read — the power shows in the throw instead
  m.position.set(x, y, z);
  m.scale.setScalar(0.6 + Math.random() * 0.8);
  scene.add(m);
  gibs.push({ mesh: m, life: 3 + Math.random() * 2, bled: false,
    vx: (kx || 0) * 3 * s + (Math.random() - 0.5) * 4, vy: (3 + Math.random() * 4) * Math.sqrt(s), vz: (kz || 0) * 3 * s + (Math.random() - 0.5) * 4,
    spin: (Math.random() - 0.5) * 14 * s });
}
// reveal the brain (weak spot) on a zombie's head: crack the skull cap open
function exposeBrain(z) {
  if (z.brainExposed) return;
  z.brainExposed = true;
  const b = z.blob;
  if (b.brainMesh) b.brainMesh.visible = true;
  if (b.skull) b.skull.visible = false;
}

// ---------- floating damage numbers ----------
// one number per bullet/punch/bite, never stacked: it pops, drifts straight up and
// fades. White for damage dealt; damage taken shows in the victim's hero colour.
const dmgNums = [];
const dmgLayer = document.getElementById('dmgnums');
const _dnv = new THREE.Vector3();
function spawnDamageNumber(x, y, z, val, color) {
  if (dmgNums.length > 40) { const old = dmgNums.shift(); old.el.remove(); }
  const el = document.createElement('div');
  el.className = 'dmgnum';
  el.textContent = Math.max(1, Math.round(val));
  el.style.fontSize = Math.round(13 + Math.min(11, val * 0.35)) + 'px'; // heavier hits pop bigger
  if (color) el.style.color = color;
  dmgLayer.appendChild(el);
  dmgNums.push({ el, x: x + (Math.random() - 0.5) * 0.4, y, z: z + (Math.random() - 0.5) * 0.4, t: 0, life: 0.85 });
}
function updateDamageNumbers(dt) {
  for (let i = dmgNums.length - 1; i >= 0; i--) {
    const n = dmgNums[i];
    n.t += dt;
    if (n.t >= n.life) { n.el.remove(); dmgNums.splice(i, 1); continue; }
    _dnv.set(n.x, n.y + n.t * 1.9 - curveDrop(n.x, n.z), n.z); // rises straight up in world space, sunk to the curve
    _dnv.project(camera);
    if (_dnv.z > 1) { n.el.style.display = 'none'; continue; }
    n.el.style.display = '';
    const pop = 1 + 0.6 * Math.max(0, 1 - n.t / 0.14); // lands big, settles fast
    n.el.style.left = ((_dnv.x * 0.5 + 0.5) * innerWidth) + 'px';
    n.el.style.top = ((-_dnv.y * 0.5 + 0.5) * innerHeight) + 'px';
    n.el.style.transform = `translate(-50%,-50%) scale(${pop.toFixed(3)})`;
    n.el.style.opacity = (1 - Math.pow(n.t / n.life, 1.6)).toFixed(3);
  }
}
function clearDamageNumbers() {
  for (const n of dmgNums) n.el.remove();
  dmgNums.length = 0;
}

// ---------- emote wheel + talk bubbles ----------
// hold Tab / D-pad down (or toggle the touch button), steer with mouse / right stick;
// the highlighted wedge grows, and releasing fires it as a bubble above your head
const EMOTES = ['Hello .ᐟ', 'Good Luck .ᐟ', 'Nice .ᐟ', 'Trade .ᐟ', 'Wait .ᐟ', 'Fight .ᐟ'];
const ewheelEl = document.getElementById('ewheel');
const ewringEl = document.getElementById('ewring');
const ewSegs = [];
for (let i = 0; i < EMOTES.length; i++) {
  const s = document.createElement('div');
  s.className = 'ewseg';
  s.textContent = EMOTES[i];
  s.addEventListener('click', () => { if (ewheel.open) { fireEmote(i); ewClose(); } }); // touch taps a wedge directly
  ewringEl.appendChild(s);
  ewSegs.push(s);
}
const ewheel = { open: false, src: null, sel: -1, vx: 0, vy: 0 };
function ewOpen(src) {
  if (game.state !== 'playing' || ewheel.open) return;
  ewheel.open = true; ewheel.src = src; ewheel.sel = -1; ewheel.vx = 0; ewheel.vy = 0;
  ewheelEl.classList.add('show');
  // these only live as long as the wheel does: a non-passive touchmove parked on the window
  // costs the whole document its scrolling fast path, and the menus scroll
  addEventListener('touchmove', ewTouchMove, { passive: false });
  addEventListener('touchend', ewTouchEnd);
  addEventListener('touchcancel', ewTouchEnd);
  ewRender();
}
function ewClose() {
  ewheel.open = false; ewTouch = null;
  ewheelEl.classList.remove('show');
  removeEventListener('touchmove', ewTouchMove);
  removeEventListener('touchend', ewTouchEnd);
  removeEventListener('touchcancel', ewTouchEnd);
}
function ewRelease() {
  if (!ewheel.open) return;
  if (ewheel.sel >= 0) fireEmote(ewheel.sel);
  ewClose();
}
// steer the highlight; wedge centres are fixed so the pick never wobbles as slices grow
function ewSteer(dx, dy, absolute) {
  if (absolute) { ewheel.vx = dx; ewheel.vy = dy; }
  else { ewheel.vx = clamp(ewheel.vx + dx, -90, 90); ewheel.vy = clamp(ewheel.vy + dy, -90, 90); }
  const m = Math.hypot(ewheel.vx, ewheel.vy);
  const was = ewheel.sel;
  if (m < (absolute ? 0.35 : 18)) ewheel.sel = -1;
  else {
    const ang = (Math.atan2(ewheel.vx, -ewheel.vy) * 180 / Math.PI + 360) % 360;
    ewheel.sel = Math.round(ang / (360 / EMOTES.length)) % EMOTES.length;
  }
  if (ewheel.sel !== was) {
    ewRender();
    if (ewheel.sel >= 0) tone(500 + ewheel.sel * 60, 0.04, 0.15, 'square');
  }
}
// touch steering: hold and swipe and the wedge under your thumb swells exactly like the
// mouse hover, then lifting fires it. Two ways in, so both read the same:
//   'ring' — thumb down on the wheel itself, so the wedge it points at from the centre is
//            the pick (angle only: parking outside the ring still aims at a wedge)
//   'btn'  — dragged straight off the emote button, which sits nowhere near the centre, so
//            the swipe is measured from where the thumb started instead
let ewTouch = null;
const EW_CANCEL_R = 1.9; // ring taps this far out are a dismiss, not a pick
function ewTouchStart(t, mode) {
  if (!ewheel.open || ewTouch) return;
  ewTouch = { id: t.identifier, mode, sx: t.clientX, sy: t.clientY };
  if (mode === 'ring') ewTouchSteer(t);
}
function ewTouchSteer(t) {
  const r = ewringEl.getBoundingClientRect();
  const rad = r.width / 2 || 145;
  let dx, dy;
  if (ewTouch.mode === 'ring') {
    dx = (t.clientX - (r.left + rad)) / rad;
    dy = (t.clientY - (r.top + rad)) / rad;
    if (Math.hypot(dx, dy) > EW_CANCEL_R) { dx = 0; dy = 0; }
  } else {
    dx = (t.clientX - ewTouch.sx) / rad;
    dy = (t.clientY - ewTouch.sy) / rad;
  }
  ewSteer(dx, dy, true);
}
// the overlay only takes touches once it's up (pointer-events rides the .show class)
ewheelEl.addEventListener('touchstart', e => {
  if (!ewheel.open) return;
  e.preventDefault();
  ewTouchStart(e.changedTouches[0], 'ring');
}, { passive: false });
function ewTouchMove(e) {
  if (!ewTouch) return;
  for (const t of e.changedTouches) {
    if (t.identifier === ewTouch.id) { e.preventDefault(); ewTouchSteer(t); }
  }
}
function ewTouchEnd(e) {
  if (!ewTouch) return;
  for (const t of e.changedTouches) {
    if (t.identifier !== ewTouch.id) continue;
    const tapped = ewTouch.mode === 'btn' && ewheel.sel < 0;
    ewTouch = null;
    // a bare tap on the emote button leaves the wheel up to browse; everything else is a
    // real pick — including a thumb that came to rest in the dead centre, which closes it
    if (!tapped) ewRelease();
  }
}
// the hero accent (the settings-menu trim colour) as an rgba() string for inline tints
function heroTint(a) {
  const h = getComputedStyle(document.documentElement).getPropertyValue('--hero').trim();
  const n = parseInt(h.replace('#', ''), 16) || 0xff8c42;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// redraw the ring: the highlighted wedge takes a bigger slice of the pie
function ewRender() {
  const n = EMOTES.length, sel = ewheel.sel;
  const evenW = 360 / n, hotW = 100, restW = (360 - hotW) / (n - 1);
  const w = i => sel < 0 ? evenW : (i === sel ? hotW : restW);
  const anchor = sel < 0 ? 0 : sel;
  let start = anchor * evenW - w(anchor) / 2;
  for (let i = anchor - 1; i >= 0; i--) start -= w(i);
  const stops = [];
  let a = 0;
  const c = ewringEl.clientWidth / 2 || 145; // ring centre — the CSS shrinks the wheel on phones
  for (let i = 0; i < n; i++) {
    // settings-menu palette: dark panel rows, the picked wedge glows in the hero colour
    const col = i === sel ? heroTint(0.32) : (i % 2 ? 'rgba(10,12,18,.92)' : 'rgba(22,26,36,.92)');
    stops.push(`${col} ${a}deg ${a + w(i)}deg`);
    const mid = (start + a + w(i) / 2) * Math.PI / 180;
    const r = i === sel ? c - 40 : c - 50;
    ewSegs[i].style.left = (c + Math.sin(mid) * r) + 'px';
    ewSegs[i].style.top = (c - Math.cos(mid) * r) + 'px';
    ewSegs[i].classList.toggle('hot', i === sel);
    // a chili giant keeps the greetings but loses the orders: Trade, Wait and Fight grey
    // out until the shrink lands (fireEmote refuses them too — the wedge is honest)
    ewSegs[i].classList.toggle('off', playerGiantAny() && i >= 3);
    a += w(i);
  }
  ewringEl.style.background = `conic-gradient(from ${start}deg, ${stops.join(',')})`;
}
const ebubsEl = document.getElementById('ebubs');
const bubbles = [];
const _bv = new THREE.Vector3();
function spawnBubble(getPos, text, owner) {
  // a fresh emote from the same speaker vanishes their previous bubble so they never stack
  if (owner != null) {
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (bubbles[i].owner === owner) { bubbles[i].el.remove(); bubbles.splice(i, 1); }
    }
  }
  const el = document.createElement('div');
  el.className = 'ebub';
  el.textContent = text;
  ebubsEl.appendChild(el);
  bubbles.push({ el, getPos, owner, t: 0, life: 2.6 });
}
function fireEmote(i) {
  if (playerGiantAny() && i >= 3) return; // no Trade / Wait / Fight orders from a giant
  spawnBubble(() => ({ x: player.pos.x, y: player.pos.y + (playerGiantOn() ? 5.2 : 2.2), z: player.pos.z }), EMOTES[i], player);
  SFX.pickup();
  // some emotes double as squad orders for the AI cousins
  const name = EMOTES[i] || '';
  if (name.startsWith('Trade')) issueSquadCmd('lineup');
  else if (name.startsWith('Wait')) issueSquadCmd('wait');
  else if (name.startsWith('Fight')) issueSquadCmd('guard');
  if (typeof netSendEmote === 'function') netSendEmote(i);
}
// ---------- emote squad orders ----------
// Trade: the AI cousins line up shoulder-to-shoulder in front of you and hold for 10s
// (or until you fire) so you can walk the line swapping weapons. Wait: they cluster on
// their spot back-to-back for 45s. Fight: they ring your sides and back for 45s and
// move with you — calling it during a Wait ends the wait early.
const squadCmd = { mode: null, t: 0, ax: 0, az: 0, ayaw: 0, n: 0, p: 1 };
// issuer: null for the host, or a client-run cousin — a client's Trade/Wait/Fight emote
// commands the AI squad too (relayed via the host's emote handler). Only cousins within
// earshot of the CALLER (30m) obey; they also adopt the caller as their follow leader,
// so once the order runs out they re-path to that player instead of drifting home.
function issueSquadCmd(mode, issuer = null) {
  if (net.role === 'client') return; // the host owns the squad AI
  const ax0 = issuer ? issuer.pos.x : player.pos.x;
  const az0 = issuer ? issuer.pos.z : player.pos.z;
  const squad = companions.filter(c => c.recruited && !c.downed && !c.netP
      && Math.hypot(c.pos.x - ax0, c.pos.z - az0) < 30)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!squad.length) return;
  squadCmd.mode = mode;
  squadCmd.p = issuer ? issuer.netP : 1;
  squadCmd.t = mode === 'lineup' ? 10 : 45;
  squadCmd.ax = ax0; squadCmd.az = az0;
  squadCmd.ayaw = issuer ? (issuer.yaw || 0) : player.camYaw;
  if (mode === 'wait') {
    // "that spot": the squad's own centroid, not the player's feet
    let cx = 0, cz = 0;
    for (const c of squad) { cx += c.pos.x; cz += c.pos.z; }
    squadCmd.ax = cx / squad.length; squadCmd.az = cz / squad.length;
  }
  for (const c of companions) c.inCmd = false;
  squad.forEach((c, i) => { c.cmdSlot = i; c.inCmd = true; c.followP = squadCmd.p; });
  squadCmd.n = squad.length;
}
function updateEmoteFx(dt) {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const bu = bubbles[i];
    bu.t += dt;
    if (bu.t >= bu.life) { bu.el.remove(); bubbles.splice(i, 1); continue; }
    const p = bu.getPos();
    _bv.set(p.x, p.y - curveDrop(p.x, p.z), p.z).project(camera);
    if (_bv.z > 1) { bu.el.style.display = 'none'; continue; }
    bu.el.style.display = '';
    bu.el.style.left = ((_bv.x * 0.5 + 0.5) * innerWidth) + 'px';
    bu.el.style.top = ((-_bv.y * 0.5 + 0.5) * innerHeight) + 'px';
    bu.el.style.opacity = Math.min(1, (bu.life - bu.t) / 0.45).toFixed(3);
  }
}
function clearBubbles() {
  for (const bu of bubbles) bu.el.remove();
  bubbles.length = 0;
  ewClose();
}

// ---------- player + boss tags ----------
// Every other human wears a chevron with their player number, floating over their head.
// Bosses now wear the same chevron instead of a separate top-bar pill — just with the
// arrow underneath tinted to their boss color (purple / crimson) so it stays readable
// without a busy label.
const ptagsEl = document.getElementById('ptags');
const ptags = new Map();

// ---------- horizon-clamped landmark ----------
// One fixed reference chevron, always tracked the same way as a player or boss tag, so
// getting turned around out past every beacon still leaves a "this way home" pointer.
// Anchored on the bank (per the latest word on it) — swap x/z to [85, -2] to anchor it
// on the town hall instead; same grand-building footprint either way.
const LANDMARK = { x: 0, z: -50.2, label: 'BANK', color: 0xffffff };

// Who deserves a marker. The host owns other players as netP companions; a client only
// knows them as actor ghosts. Bosses come out of the zombie list either way, so they
// show up in single player too.
function trackedActors() {
  const out = [];
  if (net.role === 'host') {
    for (const c of companions) if (c.netP) {
      out.push({ key: 'p' + c.netP, label: 'P' + c.netP, color: c.data.color,
        x: c.pos.x, y: c.y || 0, z: c.pos.z, downed: !!c.downed, boss: false });
    }
  } else if (net.role === 'client') {
    for (const [, g] of net.actors) if (g.p) {
      const p = g.blob.root.position;
      out.push({ key: 'p' + g.p, label: 'P' + g.p, color: g.data.color,
        x: p.x, y: p.y, z: p.z, downed: !!g.dn, boss: false });
    }
  }
  // the last ten of a clear-the-block hunt wear a small green chevron each, so nobody
  // spends the endgame combing empty streets for one straggler asleep behind a hedge
  const huntFinal = game.cleanup && game.clearTarget > 0 && (game.clearTarget - game.kills) <= 10;
  for (const z of zombies) {
    if (z.state === 'dying') continue;
    if (z.isBoss) {
      out.push({ key: z.isBoss4 ? 'b4' : z.isBoss3 ? 'b3' : z.isBoss2 ? 'b2' : 'b1',
        label: z.isBoss4 ? 'ROTTEN' : z.isBoss3 ? 'INFECTED' : z.isBoss2 ? 'CRIMSON' : 'TWO HORNED',
        color: z.isBoss4 ? BOSS_ROTTEN : z.isBoss3 ? BOSS_INFECTED : z.isBoss2 ? BOSS_CRIMSON : BOSS_PURPLE,
        x: z.pos.x, y: z.blob.root.position.y, z: z.pos.z, downed: false, boss: true, scale: z.scale });
    } else if (huntFinal && !z.fbi) {
      if (!z.nid) z.nid = ++net.zid;
      out.push({ key: 'z' + z.nid, label: '', color: 0x3ae06a,
        x: z.pos.x, y: z.blob.root.position.y, z: z.pos.z, downed: false, boss: false, mini: true, scale: z.scale });
    }
  }
  // Bank landmark: hidden until the last unrecruited cousin beacon sinks below the
  // curved horizon — then fades in so it's never spammy. Once the Two Horned One aggros
  // his own pillar and chevron take over, so the bank marker is no longer needed.
  const bossAggro = bossState.spawned && bossState.beamFade;
  if (!bossAggro && companions.length > 0) {
    let anyBeaconUp = false;
    const unrecruited = companions.filter(c => !c.recruited);
    if (unrecruited.length > 0) {
      for (const c of unrecruited) {
        const by = groundHeight(c.pos.x, c.pos.z) + BEACON_Y;
        _edgeReal.set(c.pos.x, by - curveDrop(c.pos.x, c.pos.z), c.pos.z).project(camera);
        if (_edgeReal.z <= 1 && _edgeReal.y >= 0) { anyBeaconUp = true; break; }
      }
    }
    if (!anyBeaconUp) {
      out.push({ key: 'landmark', label: LANDMARK.label, color: LANDMARK.color,
        x: LANDMARK.x, y: groundHeight(LANDMARK.x, LANDMARK.z) + 11, z: LANDMARK.z,
        downed: false, boss: false, landmark: true });
    }
  }
  // HOME marker: only fades in once the jelly-house beacon has sunk below the curve —
  // same visibility rule as the cousin beacons for the bank landmark.
  if (jelly.beacon) {
    const jby = jelly.gy + 60;
    _edgeReal.set(JELLY.x, jby - curveDrop(JELLY.x, JELLY.z), JELLY.z).project(camera);
    if (_edgeReal.z > 1 || _edgeReal.y < 0) {
      out.push({ key: 'jellyhouse', label: 'HOME', color: 0xffa040,
        x: JELLY.x, y: jelly.gy + 60, z: JELLY.z, downed: false, boss: false, landmark: true });
    }
  }
  return out;
}
// is the line from the eye to this point blocked by terrain or a solid? Rebuilding the
// collider list is chunky, so this runs on a timer and the result eases in.
function tagOccluded(x, y, z) {
  const o = camera.position;
  const dx = x - o.x, dy = y - o.y, dz = z - o.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.01) return false;
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  if (rayGround(o.x, o.y, o.z, nx, ny, nz, dist) < dist) return true;
  for (const c of nearbyColliders(x, z)) if (rayAABB(o.x, o.y, o.z, nx, ny, nz, c) < dist) return true;
  return false;
}
// A marker's honest position — real head height, sunk by the same fake-globe curve the
// world itself draws with — used to just keep sinking as range grew. This tries that
// honest projection first, and only once it's genuinely out of frame (sunk past the
// bottom, risen past the top, or off a side) swaps to a flattened point instead: same
// true bearing, but at the camera's own eye height with no curve sink, so it can't sink —
// it rides the horizon line and still slides left/right exactly like the real position
// would. No snapping to screen corners and no rotating to "point" anywhere — it's a
// signpost standing at the right bearing, not a compass needle. Genuinely behind the
// camera, it's just not visible, same as any real sign you haven't turned to face yet.
// Same function for players, bosses, the landmark and everyone else, so none of them
// behave differently from one another.
const EDGE_REF = 45;   // world units for the flattened bearing point — distance-agnostic on purpose
const _edgeReal = new THREE.Vector3();
const _edgeFlat = new THREE.Vector3();
function edgeClampedProject(x, y, z) {
  const o = camera.position;
  _edgeReal.set(x, y - curveDrop(x, z), z).project(camera);
  if (_edgeReal.z <= 1 && Math.abs(_edgeReal.x) <= 1 && _edgeReal.y >= -1 && _edgeReal.y <= 1) {
    return { x: _edgeReal.x, y: _edgeReal.y, visible: true, edge: false };
  }
  const dx = x - o.x, dz = z - o.z;
  const fd = Math.hypot(dx, dz) || 1;
  const nx = dx / fd, nz = dz / fd;
  _edgeFlat.set(o.x + nx * EDGE_REF, o.y, o.z + nz * EDGE_REF).project(camera);
  if (_edgeFlat.z > 1 || !isFinite(_edgeFlat.x) || !isFinite(_edgeFlat.y)) {
    return { visible: false, edge: true };   // behind you — nothing to show until you turn
  }
  return { x: _edgeFlat.x, y: _edgeFlat.y, visible: true, edge: true };
}
// the TRUE horizon line in NDC y for the camera's current pitch: a level point out
// along the view direction, forced to eye height, projects exactly onto the skyline.
// y=0 in NDC is only the horizon when the camera is level — pitched up it sinks below
// screen centre, pitched down it rises above it, and a marker pinned to 0 floats off
// the ground-meets-sky line it's supposed to ride.
const _hz = new THREE.Vector3();
function horizonY() {
  camera.getWorldDirection(_hz);
  _hz.multiplyScalar(EDGE_REF).add(camera.position);
  _hz.y = camera.position.y;
  _hz.project(camera);
  return _hz.y;
}
function tagEl(key) {
  let t = ptags.get(key);
  if (!t) {
    const el = document.createElement('div');
    el.className = 'ptag';
    el.innerHTML = '<b></b><i>▼</i>';
    ptagsEl.appendChild(el);
    t = { el, b: el.querySelector('b'), i: el.querySelector('i'), op: 0 };
    ptags.set(key, t);
  }
  return t;
}
function clearTags() {
  for (const [, t] of ptags) t.el.remove();
  ptags.clear();
}
function updatePlayerTags(dt) {
  if (game.state !== 'playing') { if (ptags.size) clearTags(); return; }
  const live = trackedActors();
  const k = 1 - Math.exp(-10 * dt);
  const seen = new Set();
  for (const a of live) {
    seen.add(a.key);
    const t = tagEl(a.key);
    const hy = a.y + 2.35 * (a.scale || 1);   // floats just over the blob's head (taller for bosses)
    const o = camera.position;
    const dist = Math.hypot(a.x - o.x, hy - o.y, a.z - o.z);
    const pr = edgeClampedProject(a.x, hy, a.z);
    if (!pr.visible) { t.el.style.display = 'none'; continue; }
    t.el.style.display = '';
    if (t.label !== a.label) { t.label = a.label; t.b.textContent = a.label; }
    const hex = '#' + a.color.toString(16).padStart(6, '0');
    if (t.hex !== hex) {
      t.hex = hex;
      t.i.style.color = hex;                       // arrow always tinted
      t.b.style.color = (a.boss || a.landmark) ? '' : hex;   // bosses & the landmark keep a plain name, just a colored arrow
    }
    t.el.classList.toggle('boss', !!a.boss);
    t.el.classList.toggle('mini', !!a.mini);
    t.el.classList.toggle('down', a.downed);
    t.el.classList.toggle('landmark', !!a.landmark);
    t.el.classList.toggle('edge', pr.edge);
    if (a.landmark) { const hz = horizonY(); if (pr.y < hz) pr.y = hz; }   // landmarks never sink below the true skyline — whatever the pitch, they ride the ground-meets-sky line
    t.el.style.left = ((pr.x * 0.5 + 0.5) * innerWidth) + 'px';
    t.el.style.top = ((-pr.y * 0.5 + 0.5) * innerHeight) + 'px';
    // chevron stays upright — no rotation, no compass-needle pointing, just a signpost at the bearing
    // the tag is the wayfinding layer now: never lost to distance (a kiting player or
    // a boss arena has to read from right across the map) and never blocked by world
    // geometry — it punches through everything. Up close it only steps halfway back,
    // so it stops shouting over the blob it names without ever letting go of it. Once it's
    // fallen back to the horizon-clamped edge, distance stops being a meaningful read (the
    // number could be 60 or 600) so it just holds a steady, legible full strength instead.
    // Landmarks fade on approach — the chevron stays fully visible from the
    // horizon line at any range, and only dims once you're close enough to
    // make out the actual landmark (fade band 60–120 units).
    const lmFade = clamp((dist - 60) / 60, 0, 1);
    const near = a.landmark ? (pr.edge ? 1 : lmFade) : (pr.edge ? 1 : clamp((dist - 3) / 4, 0, 1));
    t.op = lerp(t.op, a.landmark ? near : 0.35 + 0.65 * near, k);
    t.el.style.opacity = t.op.toFixed(3);
    const scale = pr.edge ? 1.2 : clamp(26 / Math.max(dist, 1), a.landmark ? 0.8 : 0.55, 1.5);   // perspective, roughly — landmarks keep a readable floor, edge markers stay big on the horizon
    t.el.style.transform = `translate(-50%,-100%) scale(${scale.toFixed(3)})`;
  }
  for (const [key, t] of ptags) if (!seen.has(key)) { t.el.remove(); ptags.delete(key); }
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
// sniper centre mass: the chest blob bursts like a head pop, and with no core left the
// rest of the body — head, arms, legs — just drops off as tumbling pieces
function popChest(z, kx, kz, stretch = 1) {
  const b = z.blob;
  if (b.bodyGone) return;
  b.bodyGone = true;
  const wp = new THREE.Vector3();
  b.body.getWorldPosition(wp);
  const skin = b.skinList.find(s => s.mesh === b.body);
  const bodyCol = skin ? skin.mat.color.getHex() : 0x8aa85a;
  for (let i = 0; i < 4; i++) spawnGib(wp.x, wp.y, wp.z, i % 2 ? BLOOD : bodyCol, kx, kz, stretch);
  spawnBlood(wp.x, wp.y, wp.z, kx, kz, 2.6, stretch);
  // still-attached parts fall from where they hung, barely kicked — they drop, not fly
  for (const [kind, grps, gone] of [['arm', b.arms, b.armGone], ['leg', b.legs, b.legGone]]) {
    for (let i = 0; i < 2; i++) {
      if (gone[i]) continue;
      gone[i] = true;
      grps[i].getWorldPosition(wp);
      grps[i].visible = false;
      spawnGib(wp.x, wp.y, wp.z, kind === 'arm' ? 0x8aa85a : 0x39432a, kx * 0.25, kz * 0.25, stretch);
      spawnGib(wp.x, wp.y, wp.z, BLOOD, kx * 0.25, kz * 0.25, stretch);
    }
  }
  if (!b.headGone) {
    b.headGone = true;
    b.head.getWorldPosition(wp);
    b.head.visible = false;
    spawnGib(wp.x, wp.y, wp.z, 0xdb8b9b, kx * 0.25, kz * 0.25, stretch);
    spawnGib(wp.x, wp.y, wp.z, bodyCol, kx * 0.25, kz * 0.25, stretch);
  }
  b.wob.visible = false;                        // nothing left standing — stumps, stains and all go
  if (b.shadow) b.shadow.visible = false;       // no body, no shadow
  play3d(z.pos.x, z.pos.z, () => SFX.headpop());
}

const tracers = [];
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 });
// tracers render CURVE-EXEMPT: a round should read as a straight line of light, not a
// dramatic arc. The globe cheat stays in the hit math; the drawn line just goes straight
// to the drawn impact point (fireWeapon hands us that point directly).
tracerMat.defines = { NO_CURVE: 1 };
function spawnTracer(from, to) {
  const len = from.distanceTo(to);
  if (len < 0.2) return;
  const g = new THREE.BoxGeometry(0.025, 0.025, len);
  const m = new THREE.Mesh(g, tracerMat.clone());
  m.material.defines = { NO_CURVE: 1 }; // clones don't reliably carry defines across
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
  if (player.weapon.consumable) { hud.clip.textContent = '1'; hud.res.textContent = ''; }
  else if (player.weapon.melee) { hud.clip.textContent = '∞'; hud.res.textContent = ''; }
  else {
    hud.clip.textContent = player.clip;
    hud.res.textContent = ' / ' + (reserves[player.weapon.id] | 0);
  }
  // holding Red's bowl, the reload button becomes RED'S: pressing it is the meal
  const rb = document.getElementById('btnReload');
  if (rb) rb.textContent = player.weapon.id === 'chili' ? "RED'S" : 'RELOAD';
}
// label on the touch weapon-cycle button
function updateWeaponBtn() {
  const el = document.getElementById('btnCycle');
  if (el) el.textContent = player.weapon.id === 'jelly' ? 'JELLY'
    : player.weapon.id === 'chili' ? 'CHILI'
    : player.weapon.melee ? 'FIST' : player.weapon.id.slice(0, 4).toUpperCase();
}
let toastT = 0;
function toast(txt, long) {
  // break the line after each .ᐟ so whatever follows drops onto its own centred row,
  // sitting under the statement it belongs to. Escape first — these strings carry weapon
  // and cousin names — then insert the only markup we add ourselves.
  const safe = String(txt).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  hud.toast.innerHTML = safe.replace(/\.ᐟ[ ]+/g, '.ᐟ<br>').replace(/<br>\s*$/, '');
  hud.toast.style.opacity = 1;
  hud.toast.style.top = '32%';
  toastT = long ? 4.2 : 1.6;
}
let hitmarkT = 0;
// set from the crosshair test each frame in updateFx — an enemy is under the sights
let aimHot = false;

// ---------- game state ----------
const game = { state: 'menu', time: 0, kills: 0, cratesOpened: 0, spawnT: 2, lastShot: new THREE.Vector3(), lastShotT: -99,
  phase: 0, weather: 'sunny', cycle: 0, cleanup: false, clearTarget: 0, celebrateT: 0 };

function resetGame() {
  applyCousin(selectedCousin);
  player.pos.set(0, groundHeight(0, 0), 0);
  player.vy = 0; player.hp = player.maxHp; player.dead = false;
  player.camYaw = 0; player.camPitch = -0.24; player.groundCamT = 0;
  player.reloading = 0;
  player.lastHurtT = -9; player.lastShotT = -9;
  player.stumbleT = 0; player.idlePhase = 0; player.lastStepPh = -1; player.meleeArm = 0;
  player.comboN = 0; player.lastPunchT = -9; player.swingT = 0; player.meleeChopT = 0; player.meleeCombo = 0; player.lastMeleeT = -9;
  player.dropKick = false; player.dropKickHard = false; player.dropKickHits = null;
  player.downed = false; player.downT = 0; player.dripT = 0;
  if (player.beacon) { scene.remove(player.beacon); player.beacon = null; }
  player.slideT = 0; player.hopT = 0;
  // consumables come back with the world: full jars, full pot, six bowls, nobody fed yet
  player.jellyT = 0;
  playerFadeEnd();
  player.giantPhase = null; player.giantScale = 1; player.giantT = 0; player.giantHpBoost = 0;
  player.finaleTp = null; // no half-finished finale warp follows anyone into a fresh run
  if (net.camG) { scene.remove(net.camG.blob.root); if (net.camG.blob.shadow) scene.remove(net.camG.blob.shadow); net.camG = null; } // nor a stale cameo ghost
  playerBlob.root.scale.setScalar(1);
  jellyBar.lootedBy.clear(); applyJellyMask(0);
  chiliBar.lootedBy.clear(); applyChiliTaken(0);
  updateGiantHud();
  // the hero starts with bare fists plus their own signature melee; recruits keep theirs
  player.owned = ['fists', COUSINS.find(c => c.id === selectedCousin).melee];
  player.owned.sort((a, b) => slotRank(a) - slotRank(b));
  player.aiming = false; player.aimT = 0;
  player.fpv = false; player.fpvT = 0;
  input.aim = false; input.aimPad = false; input.aimTouch = false;
  const vb = document.getElementById('btnView'); if (vb) vb.classList.remove('pressed');
  const ab = document.getElementById('btnAim'); if (ab) ab.classList.remove('pressed'); // aim toggle resets off
  game.time = 0; game.kills = 0; game.cratesOpened = 0; game.shots = 0; game.spawnT = 2; game.lastShotT = -99;
  // the clock starts at 8am, 11am or 1pm — one roll per lobby/campaign — and the weather
  // starts random; from there the day wheels on its own (1s of play = 1min of world)
  game.clock = [8, 11, 13][(Math.random() * 3) | 0];
  game.phase = coarsePhase(game.clock);
  wxReset();
  game.cycle = 0; game.cleanup = false; game.clearTarget = 0; game.quotaN = 0;
  game.celebrateT = 0;
  // new game plus: the host/solo decides if Bluga is in play this run (a client follows the
  // host's world, so its own flag never spawns anything). Reset his whole state machine.
  game.prestigeRun = net.role === 'client' ? false : isPrestigeRun();
  resetBluga();
  // the prestige remix: run 2+ deals the outer landmark blocks onto fresh anchors — a
  // mystery layout every run. First campaigns (and any unchanged deal) keep the standing
  // town. Clients never roll their own: the host's layout arrives in the welcome handshake.
  if (net.role !== 'client') {
    const want = game.prestigeRun ? randomLayout() : defaultLayout();
    if (JSON.stringify(want) !== currentLayout) { applyLayout(want); rebuildTownWorld(); }
  }
  updateQuotaHud();
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
  bossState.beamFade = false;
  bossState.boss = null; bossState.spawned = false; bossState.defeated = false;
  bossState.spawned2 = false; bossState.defeated2 = false;
  bossState.spawned3 = false; bossState.defeated3 = false; // the Infected One resets with his brothers
  bossState.spawned4 = false; bossState.defeated4 = false; // and the Rotten One with all three
  // grandma's light + ghost + tally leave with the run they closed
  if (jelly.beacon) { scene.remove(jelly.beacon); jelly.beacon = null; }
  if (jelly.ghost) { scene.remove(jelly.ghost.root); if (jelly.ghost.shadow) scene.remove(jelly.ghost.shadow); jelly.ghost = null; }
  jelly.skins = []; jelly.ghostMats = []; jelly.sat = 0; jelly.awake = false; jelly.wakeT = 0; jelly.statT = -1; jelly.statRows = [];
  hideFinalStats();
  bossBarEl.classList.remove('show');
  resetCrows();
  for (const p of pickups) scene.remove(p.mesh);
  pickups.length = 0;
  clearDamageNumbers();
  clearBubbles();
  squadCmd.mode = null; // no emote orders carry across runs
  tradeRing(0); tradePactReset();
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

// hide every menu screen and drop into a fresh run
function startRun() {
  initAudio();
  for (const id of ['startscreen', 'deathscreen', 'lobbyscreen', 'hostclosed'])
    document.getElementById(id).classList.add('hidden');
  deathFx.on = false; deathFadeEl.style.opacity = 0; // the fade never follows you into a fresh run
  document.getElementById('waitmsg').classList.add('hidden');
  document.body.classList.add('playing');
  resetGame();
  game.state = 'playing';
  // the black stage lifts and the world's own audio rises with it (the veil fade is CSS,
  // keyed off body.playing) — single or multi, the block comes up out of the dark
  rampWorldAudio(settings.ambience, 1.1);
  // now that we're in as a cousin, lock the tab title to them: spell it once more, then hold
  tabTitle && tabTitle.lockTo(COUSINS.findIndex(c => c.id === selectedCousin));
  stopTheme();                       // the menu persona beat steps aside for the full track
  startGameMusic(selectedCousin);    // the looping in-game bed, at the Music notch's volume
  if (input.device === 'kbm') grabPointer();
}
document.getElementById('playbtn').addEventListener('click', () => { netLeave(); startRun(); });
// shared by the solo RESPAWN button and the lobby game-over's HOST RETRY: in a lobby,
// respawning is Player 1's call alone. A client's click just lights the waiting line
// under the button; the host's click restarts the run for everyone, with the lobby
// held open (no netLeave — the connections ARE the lobby).
function respawnRun() {
  if (net.role === 'client') { document.getElementById('waitmsg').classList.remove('hidden'); return; }
  if (net.role === 'host' && net.conns.length) {
    // remember who was riding each connection (their number and cousin), restart the run,
    // then hand everyone the same cousin back in the fresh world and re-welcome them —
    // 'restart' resets their end, 'welcome' re-binds it (in order, on a reliable pipe)
    const held = net.conns.map(conn => {
      const c = companions.find(k => k.netConn === conn);
      return { conn, num: (c && c.netP) || 0, cousin: c && c.data.id, tok: c && c.netTok };
    });
    startRun();
    for (const h of held) {
      if (!h.num) continue;
      const c = companions.find(k => k.data.id === h.cousin && !k.netP) || companions.find(k => !k.netP);
      if (!c) continue;
      c.netP = h.num; c.netConn = h.conn; c.netPose = null; c.netTok = h.tok || null; c.netHold = 0;
      if (!c.recruited) recruitCousin(c);
      try {
        h.conn.send({ t: 'restart' });
        h.conn.send({ t: 'welcome', n: h.num, cousin: c.data.id, x: c.pos.x, z: c.pos.z,
          w: game.weather, ph: game.phase, ck: game.clock, tm: game.time, k: game.kills,
          lay: currentLayout }); // the fresh run's landmark deal rides the re-welcome
      } catch (e) {}
    }
    rebuildSquadBars();
    return;
  }
  netLeave(); startRun();
}
document.getElementById('retrybtn').addEventListener('click', respawnRun); // clients never fire this: their copy is pointer-events:none
document.getElementById('dquitbtn').addEventListener('click', () => {
  document.getElementById('deathscreen').classList.add('hidden');
  quitToMenu();
});
document.getElementById('mpbtn').addEventListener('click', () => { initAudio(); showLobbies(); });
document.getElementById('hostbtn').addEventListener('click', () => hostLobby(codeEl.value));
document.getElementById('joincodebtn').addEventListener('click', () => joinLobby(codeEl.value));
document.getElementById('lobbycode').addEventListener('input', () => updateCodeHint());
// enter in the code box joins — hosting is the deliberate button press
document.getElementById('lobbycode').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); joinLobby(codeEl.value); }
  e.stopPropagation();   // typing must never leak into the game's key bindings
});
document.getElementById('lobbybackbtn').addEventListener('click', () => {
  netScanStop();
  document.getElementById('lobbyscreen').classList.add('hidden');
  document.getElementById('startscreen').classList.remove('hidden');
});
document.getElementById('hcmenu').addEventListener('click', () => {
  document.getElementById('hostclosed').classList.add('hidden');
  document.getElementById('startscreen').classList.remove('hidden');
  renderPrestige();
});

// ---------- the death transition ----------
// the last bite doesn't cut to a menu: the world drops into slow motion — the horde still
// chewing — while everything, HUD included, sinks to black. The fade completes while the
// simulation is still (barely) moving, so the slow motion is never seen reaching its stop;
// the death screen arrives on the black the fade laid down. gameOver = the multiplayer
// everyone-is-down version: every player in the lobby rides the same transition.
const deathFx = { on: false, t: 0, dur: 1.7, gameOver: false };
const deathFadeEl = document.getElementById('deathfade');
function die(gameOver) {
  if (player.dead || deathFx.on) return;
  player.dead = true;
  stopGameMusic();   // the run's music ends with the run; the menu medley plays on the way back
  rumble(500, 1, 1);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  // a dead host stalls the sim for the whole lobby, so a host death IS the lobby's game over
  if (net.role === 'host' && net.conns.length) gameOver = true;
  deathFx.on = true; deathFx.t = 0; deathFx.gameOver = !!gameOver;
  if (net.role === 'host' && gameOver) netBroadcast({ t: 'gameover' });
}
// tiny stroke-drawn icons, inked in the hero's colour via currentColor
const DEATH_ICONS = {
  kills: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3a7 7 0 0 0-7 7c0 2.6 1.2 4.4 3 5.6V19h8v-3.4c1.8-1.2 3-3 3-5.6a7 7 0 0 0-7-7z"/><circle cx="9.2" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.8" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><path d="M10 19v2.2M14 19v2.2"/></svg>',
  survived: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.8 2M9.5 3h5"/></svg>',
  crates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="1.2"/><path d="M4 11h16M12 7v13M4 7l2.5-3h11L20 7"/></svg>',
  bullets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10c0-3 1.2-5.4 3-7 1.8 1.6 3 4 3 7v6H9v-6z"/><path d="M8.4 16h7.2v3H8.4z"/></svg>',
};
function finishDeath() {
  game.state = 'dead';
  document.body.classList.remove('playing');
  const mins = Math.floor(game.time / 60), secs = Math.floor(game.time % 60);
  const chips = [
    ['kills', game.kills, 'kills'],
    ['survived', `${mins}:${String(secs).padStart(2, '0')}`, 'survived'],
    ['crates', game.cratesOpened, 'crates'],
    ['bullets', game.shots | 0, 'bullets'],
  ];
  document.getElementById('deathstats').innerHTML = chips.map(([ic, val, lab]) =>
    `<div class="dchip">${DEATH_ICONS[ic]}<div><b>${val}</b><span>${lab}</span></div></div>`).join('');
  document.getElementById('deathtitle').textContent = deathFx.gameOver && net.role ? 'GAME OVER' : 'YOU GOT EATEN';
  // one fused pair on every death now, dressed in the fallen hero's colour: solo deaths
  // read RETRY .ᐟ, a lobby game over reads HOST RETRY . . (live for the host, greyed-
  // waiting for a client — the same read as the pause screen's waithost RESUME)
  const lobbyOver = deathFx.gameOver && !!net.role && (net.role === 'client' || net.conns.length > 0);
  const rb = document.getElementById('retrybtn');
  rb.textContent = lobbyOver ? 'HOST RETRY . .' : 'RETRY .ᐟ';
  rb.classList.toggle('waithost', lobbyOver && net.role === 'client');
  document.getElementById('waitmsg').classList.add('hidden');
  document.getElementById('deathscreen').classList.remove('hidden');
}

// ---------- blood splatter overlay (extra gore) ----------
const bloodEl = document.getElementById('bloodsplat');
let bloodSplatT = 0;
function bloodSplat() { bloodEl.style.opacity = clamp(0.5 + settings.extraGore * 0.5, 0, 1); bloodSplatT = 1.1; }

// ---------- pause menu + settings ----------
const pauseScreen = document.getElementById('pausescreen');
// multiplayer readout on the pause badge: the lobby code + how many slots are filled.
// Split out of pauseGame so joins and leaves refresh it LIVE while the menu is open —
// the host counts player-ridden cousins, a client counts the player ghosts it renders.
function updatePauseLobby() {
  const pl = document.getElementById('pauselobby');
  if (net.role && net.lobbyCode) {
    const n = net.role === 'client'
      ? 1 + [...net.actors.values()].filter(g => g.p).length
      : 1 + companions.filter(c => c.netP).length;
    const html = `LOBBY ${net.lobbyCode.toUpperCase()} <span class="plslots">${n}/${NET_SLOTS}</span>`;
    if (pl.innerHTML !== html) pl.innerHTML = html;
    pl.classList.remove('hidden');
  } else pl.classList.add('hidden');
}
function pauseGame() {
  if (game.state !== 'playing') return;
  game.state = 'paused';
  syncSettingsUI();
  updatePauseLobby();
  pauseScreen.classList.remove('hidden');
  document.body.classList.remove('playing');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  stopGameMusic();                             // the in-game bed stops for the pause menu...
  if (!themeTimer) startTheme(selectedCousin); // ...and the persona beat plays over it instead
  if (input.device === 'xbox' || input.device === 'ps' || input.device === 'switch') setPadFocus(0);
  else clearPadFocus();
  updateHostPauseLock();
  // the host's pause stops the world, so it stops the lobby: everyone sees the settings
  // screen together and waits on the host's resume
  if (net.role === 'host') netBroadcast({ t: 'hpause', on: 1 });
}
function resumeGame() {
  if (game.state !== 'paused') return;
  if (net.role === 'client' && net.hostPaused) return; // the host holds the pause, not us
  pauseScreen.classList.add('hidden');
  document.body.classList.add('playing');
  game.state = 'playing';
  stopTheme();                       // drop the pause-menu persona beat...
  startGameMusic(selectedCousin);    // ...and pick the looping track back up
  if (input.device === 'kbm') grabPointer();
  scheduleControlsFade();
  if (net.role === 'host') netBroadcast({ t: 'hpause', on: 0 }); // the lobby resumes with us
}
// keepChain: true only when the family was just made whole (the finale sends us here). A WIN
// banks the campaign so the very next solo run is new-game-plus — Bluga stalking, the landmark
// ladder pushed farther out — exactly as in a held-open lobby. Every OTHER way back to the menu
// (dying, the pause-menu quit, a dropped connection) is a give-up that starts the session over:
// the hardcoded Bluga-less classic town again, the distance ladder reset.
function quitToMenu(keepChain) {
  game.state = 'menu';
  pauseScreen.classList.add('hidden');
  document.getElementById('startscreen').classList.remove('hidden');
  document.body.classList.remove('playing');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  hideFinalStats(); // grandma's tally never follows you onto the menu
  if (!keepChain) { sessionCampaign = 0; lastLmD = null; }
  rampWorldAudio(0, 0.6); // the world sinks back to a silent black stage behind the picker
  stopGameMusic();
  stopTheme();
  netLeave();
  tabTitle && tabTitle.unlock(); // back at the menu: the tab title cycles the family again
  renderPrestige();
}
function togglePause() {
  if (game.state === 'playing') pauseGame();
  else if (game.state === 'paused') resumeGame();
}
document.getElementById('resumebtn').addEventListener('click', resumeGame);
// wrapped, not passed straight: a click hands the listener a (truthy) MouseEvent, which
// quitToMenu would read as keepChain — the pause-menu quit is a give-up and must reset
document.getElementById('quitbtn').addEventListener('click', () => quitToMenu());
addEventListener('keydown', e => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    // pointer-lock release already paused us on this same Esc press
    if (e.code === 'Escape' && performance.now() - lockLossT < 500) return;
    e.preventDefault();
    togglePause();
  }
});

// ---------- looking away ----------
// Tab out of a solo run and the world stops dead with you — nobody comes back to a corpse
// they never saw. A multiplayer world can't stop for one person, so that run only goes
// quiet. Either way the sound waits at zero until you're actually back looking at it.
function setBlurMute(on) {
  blurMuted = on;
  if (actx) masterGain.gain.setTargetAtTime(on ? 0 : settings.master, actx.currentTime, 0.06);
}
function onWindowBlur() {
  if (game.state === 'menu') return;
  if (game.state === 'playing' && net.role === null) pauseGame();
  setBlurMute(true);
}
addEventListener('blur', onWindowBlur);
addEventListener('focus', () => setBlurMute(false));
// phones background the tab without ever firing blur
document.addEventListener('visibilitychange', () => document.hidden ? onWindowBlur() : setBlurMute(false));

// ---------- settings UI: snappy 5-notch bars, two columns, gamepad navigable ----------
const SETTING_DEFS = [
  // ambience folded into SFX (it rides that notch at its old 0.4 mix) — the row it used to
  // hold belongs to draw distance now, keeping the grid at ten rows / two clean columns
  ['master', 'Master'], ['sfx', 'SFX'], ['music', 'Music'],
  // one look-sensitivity notch serves mouse and thumb both; a phone has no mouse to tune,
  // so it takes the name of the thing they actually have in their hands
  ['mouseSens', isTouch ? 'Swipe Sens' : 'Mouse Sens'], ['padSens', 'Pad Sens'],
  ['drawDist', 'Draw Dist'], ['zombieSpawn', 'Zombies'], ['lootSpawn', 'Loot'],
  ['gore', 'Gore'], ['extraGore', 'Extra Gore'],
];
const settingsGrid = document.getElementById('settingsGrid');
const rowEls = {};
function saveNotches() {
  // a client's spawn rows are wearing the HOST's values — never let those persist as
  // their own prefs (ownSpawnNotches holds theirs until netLeave restores them)
  const out = { ...notches };
  if (ownSpawnNotches) Object.assign(out, ownSpawnNotches);
  try { localStorage.setItem('blingo-notches', JSON.stringify(out)); } catch (e) {}
}
function notchClickSfx(level) { initAudio(); tone(280 + level * 90, 0.05, 0.22, 'square'); }
function setNotch(key, n, silent) {
  // in a joined lobby the spawn dials belong to the HOST — a client's copies are read-only
  if (net.role === 'client' && HOST_NOTCH_KEYS.includes(key)) return;
  n = clamp(Math.round(n), 0, 5);
  // "extra" means more than full: dialing up Extra Gore quietly fills the Gore bar first
  if (key === 'extraGore' && n > 0 && notches.gore < 5) setNotch('gore', 5, true);
  if (key === 'gore' && n < 5 && notches.extraGore > 0) { notches.extraGore = 0; refreshRow('extraGore'); }
  // Extra Gore maxed forces the Zombies dial to full too — the horde IS the gore now. (A
  // client can't set the host-owned Zombies dial; the host's forced 5 rides down to them.)
  if (key === 'extraGore' && n >= 5 && notches.zombieSpawn < 5 && net.role !== 'client') setNotch('zombieSpawn', 5, true);
  if (n === notches[key]) return;
  notches[key] = n;
  syncDerived();
  applyAudioSettings();
  saveNotches();
  refreshRow(key);
  if (key === 'gore') refreshRow('extraGore');
  if (key === 'extraGore' || key === 'zombieSpawn') updateGoreHordeUI();
  if (!silent) notchClickSfx(n);
  // the host turning a spawn dial updates every client's greyed copy live — even from
  // the pause menu, where the periodic snapshot isn't flowing
  if (net.role === 'host' && HOST_NOTCH_KEYS.includes(key))
    netBroadcast({ t: 'notch', zs: notches.zombieSpawn, ls: notches.lootSpawn, hg: goreHordeLocal() ? 1 : 0 });
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
  // Extra Gore has a live state its pips can't show: it does nothing at all unless Gore is
  // maxed under it, so it lights its name only while it's actually running, read off the same
  // test the game itself uses rather than a second opinion here that could drift out of step.
  // (Music no longer has a hidden threshold — the full cousin track now plays in-game at any
  // level above zero, so the pips already tell the whole story.)
  if (key === 'extraGore') row.classList.toggle('live', extraGoreOn());
}
function syncSettingsUI() { for (const [key] of SETTING_DEFS) refreshRow(key); updateGoreHordeUI(); }
// light the Extra Gore + Zombies pips while the gore horde is on. The owner (single player,
// or whoever maxed their own slider) gets the hero-coloured throb; a client only mirroring
// the host's forced horde gets it grey — they see the horde, but it isn't their setting.
function updateGoreHordeUI() {
  const localMax = goreHordeLocal();
  const clientForced = net.role === 'client' && net.hostGoreHorde;
  const grey = clientForced && !localMax;
  for (const key of ['extraGore', 'zombieSpawn']) {
    const row = rowEls[key];
    if (!row) continue;
    // the Extra Gore row only glows for its OWN maxed slider; the Zombies row glows whenever
    // the horde is on (host-forced included, in grey)
    const rowOn = key === 'extraGore' ? localMax : (localMax || clientForced);
    row.classList.toggle('gorehorde', rowOn);
    row.classList.toggle('greygore', rowOn && grey);
  }
}
syncSettingsUI();

// ---------- host-owned spawn settings + host pause (multiplayer) ----------
// Zombies + Loot drive the SPAWNER, and in a lobby the host's world does all the
// spawning — so those two dials are the host's alone. A client's copies grey out,
// go read-only, and mirror the host's values live: they arrive with the welcome,
// with every snapshot, and on a dedicated message the moment the host turns one.
const HOST_NOTCH_KEYS = ['zombieSpawn', 'lootSpawn'];
let ownSpawnNotches = null; // the client's own saved values, restored when they leave
function lockSpawnRows(on) {
  for (const k of HOST_NOTCH_KEYS) rowEls[k].classList.toggle('locked', on);
}
function applyHostNotches(zs, ls, hg) {
  if (net.role !== 'client') return;
  if (!ownSpawnNotches) ownSpawnNotches = { zombieSpawn: notches.zombieSpawn, lootSpawn: notches.lootSpawn };
  let changed = false;
  for (const [k, v] of [['zombieSpawn', zs], ['lootSpawn', ls]]) {
    if (!Number.isInteger(v)) continue;
    const n = clamp(v, 0, 5);
    if (n !== notches[k]) { notches[k] = n; refreshRow(k); changed = true; }
  }
  if (changed) syncDerived();  // no saveNotches: the host's dials are borrowed, not ours
  lockSpawnRows(true);
  if (hg !== undefined) { net.hostGoreHorde = !!hg; updateGoreHordeUI(); } // the host's gore-horde flag drives our grey glow
}
function restoreOwnNotches() {
  lockSpawnRows(false);
  net.hostGoreHorde = false;
  updateGoreHordeUI();
  if (!ownSpawnNotches) return;
  notches.zombieSpawn = ownSpawnNotches.zombieSpawn;
  notches.lootSpawn = ownSpawnNotches.lootSpawn;
  ownSpawnNotches = null;
  syncDerived();
  refreshRow('zombieSpawn'); refreshRow('lootSpawn');
}
// while the host holds the lobby paused, a client's RESUME button waits on them
function updateHostPauseLock() {
  const btn = document.getElementById('resumebtn');
  const locked = net.role === 'client' && net.hostPaused;
  btn.classList.toggle('waithost', locked);
  btn.textContent = locked ? 'HOST PAUSED . .' : 'RESUME';
}

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
  // LB/RB hop to the other column and wrap: the ten settings sit in two stacked columns of
  // five (indices 0-4 | 5-9), with Resume/Quit their own two-wide row (10 | 11). Left/right
  // are spent tuning the focused row's value, so the bumpers are what move focus sideways.
  if (justPressed(4) || justPressed(5))
    setPadFocus(padFocus < 10 ? (padFocus + 5) % 10 : (padFocus === 10 ? 11 : 10));
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

// ---------- gamepad menus + on-screen keyboard ----------
// the pad drives every front-end screen the way it drives the pause menu: a focus ring you
// move with the d-pad/stick, A to pick, B to back out.
let menuFocus = 0, menuNavT = 0;
function currentScreen() {
  if (!document.getElementById('vkeyboard').classList.contains('hidden')) return document.getElementById('vkeyboard');
  for (const id of ['startscreen', 'lobbyscreen', 'hostclosed', 'deathscreen']) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) return el;
  }
  return null;
}
function menuFocusables() {
  const s = currentScreen();
  if (!s) return [];
  return [...s.querySelectorAll('button, .card, #lobbycode, .lobbyrow, .vkkey')].filter(el => el.offsetParent !== null);
}
function setMenuFocus(i) {
  const els = menuFocusables();
  if (!els.length) return;
  menuFocus = (i + els.length) % els.length;
  els.forEach((el, j) => el.classList.toggle('focus', j === menuFocus));
  const el = els[menuFocus];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}
function menuActivate(el) {
  if (!el) return;
  if (el === codeEl) openVKeyboard();   // the code field pops the on-screen keyboard
  else el.click();
  // picking a cousin card drops the focus straight onto the mode selector below, so the
  // flow reads the way it plays: pick your cousin, then A again starts the game
  if (el.classList.contains('card')) {
    const i = menuFocusables().indexOf(document.getElementById('playbtn'));
    if (i >= 0) setMenuFocus(i);
  }
}
// 2D menu nav: from the focused element's centre, step to the nearest focusable in the
// pressed direction by SCREEN geometry, not DOM order — so the cousin-card grid, the mode
// buttons and the on-screen keyboard all move exactly the way the d-pad/stick points.
// Nothing that way? Wrap to the farthest element on the opposite side, so a held
// direction cycles instead of hitting a wall.
function spatialNext(els, from, dx, dy) {
  const cen = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const f = cen(els[from]);
  let best = -1, bestScore = Infinity, wrap = -1, wrapScore = Infinity;
  els.forEach((el, i) => {
    if (i === from) return;
    const p = cen(el);
    const fwd = (p.x - f.x) * dx + (p.y - f.y) * dy;                          // progress the way we pressed
    const side = Math.abs((p.x - f.x) * dy) + Math.abs((p.y - f.y) * dx);     // drift off that axis
    if (fwd > 0.5) {
      const score = fwd + side * 2;
      if (score < bestScore) { bestScore = score; best = i; }
    } else {
      const score = fwd + side * 2;   // most negative fwd with least drift = farthest behind
      if (score < wrapScore) { wrapScore = score; wrap = i; }
    }
  });
  return best >= 0 ? best : wrap;
}
function padMenuScreen(gp, dt, justPressed, ax, ay) {
  menuNavT -= dt;
  const sx = Math.abs(ax) > 0.5 ? Math.sign(ax) : 0;
  const sy = Math.abs(ay) > 0.5 ? Math.sign(ay) : 0;
  const ready = menuNavT <= 0 && (sx || sy);
  const els = menuFocusables();
  if (!els.length) return;
  if (menuFocus >= els.length) menuFocus = 0;
  if (!els[menuFocus] || !els[menuFocus].classList.contains('focus')) setMenuFocus(menuFocus);
  const vk = !document.getElementById('vkeyboard').classList.contains('hidden');
  let dx = 0, dy = 0;
  // LB/RB drive the horizontal step too, so the bumpers jump between cousin columns and
  // between Single/Multiplayer just as the d-pad does — spatialNext already wraps at the ends.
  if (justPressed(14) || justPressed(4) || (ready && sx < 0)) dx = -1;
  else if (justPressed(15) || justPressed(5) || (ready && sx > 0)) dx = 1;
  else if (justPressed(12) || (ready && sy < 0)) dy = -1;
  else if (justPressed(13) || (ready && sy > 0)) dy = 1;
  if (dx || dy) {
    const to = spatialNext(els, menuFocus, dx, dy);
    if (to >= 0) setMenuFocus(to);
    menuNavT = 0.16;
  }
  if (justPressed(0)) menuActivate(menuFocusables()[menuFocus]);
  if (justPressed(1)) {   // B: close the keyboard, or hit the screen's back/menu button
    if (vk) closeVKeyboard();
    else { const back = els.find(e => /BACK|MENU/i.test(e.textContent)); if (back) back.click(); }
  }
}
// on-screen keyboard for the lobby code. Enter hosts (sends them in); Close keeps the
// edited name and drops back to the lobby, so they can still host from the HOST A LOBBY tab.
const vkLayout = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function buildVKeyboard() {
  const keys = document.getElementById('vkkeys');
  keys.innerHTML = '';
  for (const rowChars of vkLayout) {
    const r = document.createElement('div'); r.className = 'vkrow';
    for (const ch of rowChars) {
      const b = document.createElement('button'); b.className = 'vkkey'; b.textContent = ch.toUpperCase();
      b.addEventListener('click', () => vkPress(ch));
      r.appendChild(b);
    }
    keys.appendChild(r);
  }
  const r = document.createElement('div'); r.className = 'vkrow';
  for (const [label, act] of [['DEL', 'del'], ['CLOSE', 'close'], ['ENTER', 'enter']]) {
    const b = document.createElement('button'); b.className = 'vkkey vkact'; b.textContent = label;
    b.addEventListener('click', () => vkAction(act));
    r.appendChild(b);
  }
  keys.appendChild(r);
}
function vkSync() {
  const c = normCode(codeEl.value);
  document.getElementById('vkdisplay').textContent = codeEl.value.toUpperCase() || '_';
  document.getElementById('vkhint').textContent = !c ? 'type a code'
    : isPublicCode(c) ? `PUBLIC · anyone can find ${c.toUpperCase()}`
    : `PRIVATE · only players you hand ${c.toUpperCase()} can join`;
  updateCodeHint();
}
function vkPress(ch) { if (normCode(codeEl.value + ch).length <= 12) codeEl.value += ch; vkSync(); }
function vkAction(act) {
  if (act === 'close') { closeVKeyboard(); return; }
  if (act === 'enter') { closeVKeyboard(); hostLobby(codeEl.value); return; }
  if (act === 'del') codeEl.value = codeEl.value.slice(0, -1);
  vkSync();
}
function openVKeyboard() {
  document.getElementById('lobbyscreen').classList.add('hidden');
  document.getElementById('vkeyboard').classList.remove('hidden');
  document.body.classList.add('vkopen');
  hud.crosshair.style.left = '50%'; hud.crosshair.style.top = '50%';
  vkSync();
  setMenuFocus(0);
}
function closeVKeyboard() {
  document.getElementById('vkeyboard').classList.add('hidden');
  document.body.classList.remove('vkopen');
  document.getElementById('lobbyscreen').classList.remove('hidden'); // keep the edit; the tab still hosts
  updateCodeHint();
  setMenuFocus(0);
}
buildVKeyboard();

// ---------- aiming ----------
const _aimDir = new THREE.Vector3();
function getAimDir(out) {
  // aim is camera-relative now (centred crosshair, third-person or first) — no free-aim cursor
  camera.getWorldDirection(out);
  return out;
}
// how far along an aim ray the hero himself stands. Rays are cast from the camera, which
// in third person floats behind the blob — so a zombie between the camera and the hero's
// back can intercept the centre line without being anywhere the gun points. Hits closer
// than this are behind the muzzle: never hot, never shot. The 0.6 slack keeps a zombie
// pressed right up against the hero (its sphere laps the gun plane) a legal target, and
// in first person the whole thing collapses to ~0 so point-blank still lands.
function selfT(ox, oy, oz, dx, dy, dz) {
  return Math.max(0,
    (player.pos.x - ox) * dx + (player.pos.y + 1 - oy) * dy + (player.pos.z - oz) * dz) - 0.6;
}

// ---------- drop kick ----------
// Throwing bare fists in mid-air commits you: the boots come out, you ride the dive to
// the ground, and nothing else fires until you land. That commitment is the whole point —
// an armed melee jump swing can be mashed at its rpm, this one costs you a jump each time.
const DROPKICK_DMG = 13, DROPKICK_RANGE = 2.1, DROPKICK_KNOCK = 27.5;
// a giant's boot lands harder than its fists — both jump-kick insta-gibs clear the punch's
// 400, and the slide-hop version clears the plain jump kick too. Bosses never see these
// numbers (see updateDropKick): same rule as the giant punch, they only feel the boot.
const GIANT_KICK_GIB = 500, GIANT_KICK_GIB_HARD = 750;
function startDropKick() {
  player.dropKick = true;
  player.dropKickHard = player.hopT > 0;   // launched out of a slide hop: the hard version
  player.dropKickHits = new Set();         // one boot per zombie, not one per frame
  player.comboN = 0;                       // the kick is not a punch — it breaks the chain
  player.swingT = 0; player.meleeChopT = 0;
  player.lastShotT = game.time;
  // lock the line of the dive and kill any remaining climb, so it reads as a committed
  // fall rather than a float. First person dives down the sights; third person dives
  // where the BODY is pointing — the blob you watch is the thing that kicks, not the
  // crosshair floating over its shoulder.
  if (player.fpv) {
    getAimDir(_aimDir);
    const l = Math.hypot(_aimDir.x, _aimDir.z) || 1;
    player.dkX = _aimDir.x / l; player.dkZ = _aimDir.z / l;
  } else {
    const yw = playerBlob.root.rotation.y;
    player.dkX = Math.sin(yw); player.dkZ = Math.cos(yw);
  }
  if (player.vy > 0) player.vy *= 0.35;
  SFX.dropKick(player.dropKickHard);
  // the commit, not the impact: a short snap weighted to the high-frequency motor.
  // long + even across both motors reads as a wobble, which the boots are not.
  rumble(player.dropKickHard ? 55 : 40, player.dropKickHard ? 0.5 : 0.3, player.dropKickHard ? 1 : 0.75);
}
function updateDropKick(dt) {
  if (!player.dropKick) return;
  const hard = player.dropKickHard;
  const giantOn = playerGiantOn();
  for (const z of zombies) {
    if (z.state === 'dying' || player.dropKickHits.has(z)) continue;
    const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > DROPKICK_RANGE || Math.abs(z.blob.root.position.y - player.pos.y) > 2.2) continue;
    player.dropKickHits.add(z);
    const nx = d > 0.001 ? dx / d : player.dkX, nz = d > 0.001 ? dz / d : player.dkZ;
    // a slide-hop kick hits twice as hard, same as any slide-hop melee. A giant's boot
    // insta-gibs a street walker like the giant punch does — but bigger, and a boss only
    // ever feels the ordinary kick (same exception the punch gets)
    const dmg = giantOn && !z.isBoss ? (hard ? GIANT_KICK_GIB_HARD : GIANT_KICK_GIB) : DROPKICK_DMG * (hard ? 2 : 1);
    const knock = DROPKICK_KNOCK * (hard ? 1.6 : 1) * (giantOn ? 1.8 : 1);
    const wasDying = z.state === 'dying';
    damageZombie(z, dmg, nx, nz, knock, { weapon: player.weapon, dist: d, isHead: false });
    // the harder the boot threw them, the more the burst reads as a streak instead of a
    // splat — DROPKICK_KNOCK is the 1x reference, so only a giant kick clears it and the
    // slide-hop giant kick (the biggest knockback in the game) streaks hardest of all
    if (giantOn && !z.isBoss && !z.netGhost && z.state === 'dying' && !wasDying && !z.blob.bodyGone) {
      popChest(z, nx, nz, knock / DROPKICK_KNOCK);
    }
    meleeMoveGib(player.weapon, z, nx, nz, hard); // a slide-hop boot that kills bursts the body too
    play3d(z.pos.x, z.pos.z, () => SFX.dropKickHit(hard));
    // boot connecting: the sharpest thing in the game. peaks above the launch snap so it
    // always cuts through it, and a slide-hop kick cracks harder like it hits harder.
    rumble(hard ? 70 : 50, hard ? 1 : 0.65, hard ? 1 : 0.9);
    shakeAmp = Math.max(shakeAmp, hard ? 0.09 : 0.05);
  }
  if (player.grounded) { player.dropKick = false; player.dropKickHits = null; } // landed: free again
}

// ---------- shooting ----------
const _from = new THREE.Vector3(), _to = new THREE.Vector3(), _gp = new THREE.Vector3(), _gp2 = new THREE.Vector3();
// the zombie a swing would land on right now, or null. Reach plus a wide forward cone —
// not the nearest one, but the first inside both, which is exactly what the swing itself
// takes. Auto-attack asks this before committing, so the probe and the swing can never
// disagree and leave the hero punching air.
const _mDir = new THREE.Vector3();
// EVERY zombie a swing would land on right now: a melee arc is a sweep, not a poke, so
// one swing connects with the whole crowd inside reach and cone at once
function meleeTargets(w) {
  // grounded (and first-person) swings sweep along the crosshair; an airborne swing in
  // third person sweeps where the BODY faces — a jump attack goes where the blob goes,
  // matching the drop kick's body-committed dive
  let yaw;
  if (!player.grounded && !player.fpv) yaw = playerBlob.root.rotation.y;
  else { getAimDir(_mDir); yaw = Math.atan2(_mDir.x, _mDir.z); }
  const out = [];
  const reach = w.range * (playerGiantOn() ? 2.3 : 1); // giant arms sweep a giant arc
  for (const z of zombies) {
    if (z.state === 'dying' || z.vanished) continue;
    const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
    if (Math.hypot(dx, dz) >= reach) continue;
    const diff = Math.abs(((Math.atan2(dx, dz) - yaw) % TAU + TAU + Math.PI) % TAU - Math.PI);
    if (diff < 1.15) out.push(z);
  }
  return out;
}
function meleeTarget(w) { return meleeTargets(w)[0] || null; }
// a swing that connects with the WORLD instead of a body: wall, car, crate, house —
// anything solid inside the arc's reach. Drives the controller thunk so a bat bounced
// off a truck reads as contact, not air.
function meleeWorldHit(w) {
  getAimDir(_mDir);
  const ox = player.pos.x, oy = player.pos.y + 1.2, oz = player.pos.z;
  const reach = w.range * (playerGiantOn() ? 2.3 : 1);
  for (const c of nearbyColliders(ox, oz)) {
    if (rayAABB(ox, oy, oz, _mDir.x, _mDir.y, _mDir.z, c) < reach) return true;
  }
  return false;
}
// the gore payoff on a move-kill: a melee kill earned mid-move bursts the body — the
// execute's centre-mass treatment. Heavy hitters (the gib-class katana/sledge/axe) take
// it from any airborne swing kill; the lighter arms (fists, pipe, bat, machete) have to
// earn it out of a slide-hop. Runs AFTER the damage lands, on whatever actually died.
function meleeMoveGib(w, z, kx, kz, hop, okFBI) {
  if (!(hop || (w.gib && !player.grounded))) return;
  // FBI armour holds against ordinary move-kills: only the callers that vouch for a heavy
  // hitter (chili giant, Blazo's leaping axe, Blomba's melee) burst a black-ops blob
  if (z.fbi && !okFBI) return;
  if (z.state !== 'dying' || z.isBoss || z.netGhost || z.blob.bodyGone) return;
  popChest(z, kx, kz);
}
// Blomba's hidden trait, the easter egg the lounge regulars swear by: her melee kills
// never just read a number and fall — they come apart (head, limbs or chest, dealer's
// choice) — and every one feeds her. +2hp a swing kill, +6 off bare fists: the softer
// the touch, the sweeter the jelly. Vampirism, but make it a bouncer.
// (Host/solo only: a client can't see host-side hp, so its kills settle upstream.)
function blombaVamp(w, z, kx, kz, wasDying) {
  if (player.meleeMult <= 1 || wasDying || z.state !== 'dying') return;
  if (!z.isBoss && !z.netGhost && !z.blob.bodyGone) {
    const roll = Math.random();
    if (roll < 0.34) popHead(z, kx, kz);
    else if (roll < 0.67) { blowLimb(z, kx, kz); blowLimb(z, kx, kz); }
    else popChest(z, kx, kz);
  }
  player.hp = Math.min(player.maxHp, player.hp + (w.id === 'fists' ? 6 : 2));
}
// a sprawled zombie (asleep, or an already-dead carcass) lies flat, head and torso low and
// off along the sprawl axis rather than stacked upright. Two fat low spheres down the body
// catch a shot aimed at what you actually see. Returns nearest t (Infinity on a miss); sets
// out.isHead when the head sphere won so a corpse can still take a headshot.
function lyingHitT(ox, oy, oz, dx, dy, dz, z, out) {
  const s = z.scale, gy = z.blob.root.position.y;
  const ry = z.blob.root.rotation.y, ax = -Math.sin(ry), az = -Math.cos(ry), yb = gy + 0.3 * s;
  const bt = raySphere(ox, oy, oz, dx, dy, dz, z.pos.x + ax * 0.55 * s, yb, z.pos.z + az * 0.55 * s, 0.66 * s);
  const ht = raySphere(ox, oy, oz, dx, dy, dz, z.pos.x + ax * 1.3 * s, yb, z.pos.z + az * 1.3 * s, 0.46 * s);
  if (out) out.isHead = ht < bt;
  return Math.min(bt, ht);
}
// the down swing: an armed melee follows its opening swing through with a second strike that
// lands as the weapon comes down, so a single attack press connects twice
function meleeChopHit() {
  if (player.dead || player.downed) return;
  const w = player.weapon;
  if (!w.melee || w.id === 'fists') return;
  const hits = meleeTargets(w);
  if (!hits.length) {
    if (meleeWorldHit(w)) rumble(45, 0.45, 0.32);   // the down swing met a wall instead of a crowd
    return;
  }
  const hop = player.meleeChopHop;
  const knock = 3.5 * (hop ? 2.2 : 1) * (player.grounded ? 1 : 1.5);
  for (const hit of hits) {   // the down swing sweeps the whole crowd too
    const dx = hit.pos.x - player.pos.x, dz = hit.pos.z - player.pos.z, d = Math.hypot(dx, dz) || 1;
    const wasDying = hit.state === 'dying';
    damageZombie(hit, w.dmg * player.meleeMult * closeBonus(w, d) * (hop ? 2 : 1), dx / d, dz / d, knock, { weapon: w, dist: d, isHead: false });
    meleeMoveGib(w, hit, dx / d, dz / d, hop);
    blombaVamp(w, hit, dx / d, dz / d, wasDying);
  }
  SFX.shoot(w); rumble(...w.rmb);
}
function fireWeapon() {
  if (squadCmd.mode === 'lineup' && squadCmd.p === 1) squadCmd.mode = null; // gunfire breaks up the trade line (the caller's own line)
  const w = player.weapon;
  // mid-meal you swing nothing; and a giant's trigger fingers are too big for guns anyway
  if (player.giantPhase === 'eat' || player.giantPhase === 'grow' || player.giantPhase === 'rise') return;
  if (playerGiantOn() && !w.melee) return;
  getAimDir(_aimDir);
  if (w.melee) {
    // bare fists in the air are a drop kick, not a punch: a committed move you ride down
    // (updateDropKick), so unlike an armed jump swing it can't be mashed. The !dropKick
    // guard is the lock itself — re-entering would re-arm the hit set and let one jump
    // land the boot over and over.
    if (w.id === 'fists' && !player.grounded) { if (!player.dropKick) startDropKick(); return; }
    SFX.shoot(w);
    player.lastShotT = game.time;
    player.swingDur = 60 / w.rpm * 0.9;   // the arc fills the weapon's own rpm gap
    player.swingT = player.swingDur;
    if (w.id === 'fists') {
      // consecutive swings still trade hands — the opener leads with the dominant one
      // (right for everyone, left for Blondie, gunArm carries the family handedness) and a
      // lapsed chain re-opens on it — but that's animation now: damage no longer rides
      // the chain, each ZOMBIE keeps its own 6,7,6,7 count (see the swing below).
      player.comboN = game.time - player.lastPunchT > COMBO_WINDOW ? 0 : player.comboN + 1;
      player.lastPunchT = game.time;
      player.meleeArm = player.comboN % 2 === 0 ? playerBlob.gunArm : playerBlob.offArm;
    } else {
      player.meleeArm = playerBlob.gunArm;  // an armed melee always swings the weapon hand
      // the armed combo: every press inside the window swings BACK the other way —
      // forehand leads, backhand answers, a lapsed chain re-opens on the forehand.
      // The bat's chain runs a beat longer: forehand, backhand, then the overhead finisher
      const comboLen = w.id === 'bat' ? 3 : 2;
      player.meleeCombo = (game.time - (player.lastMeleeT || -9) < COMBO_WINDOW) ? ((player.meleeCombo || 0) + 1) % comboLen : 0;
      player.lastMeleeT = game.time;
      // the bat's finisher takes its time: the full overhead smash reads as the big
      // hit it is instead of rushing through the same beat as the sweeps
      if (w.id === 'bat' && player.meleeCombo % 3 === 2) player.swingDur = player.swingT = player.swingDur * 1.35;
    }
    const hop = player.hopT > 0;            // swung out of a slide hop: twice the damage
    const hits = meleeTargets(w);           // the arc sweeps EVERYONE inside reach + cone
    for (const hit of hits) {
      const dx = hit.pos.x - player.pos.x, dz = hit.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      // fists land on the ZOMBIE, not the hand or the clock: each one takes 6 on its first
      // punch, 7 on its next, 6 again — its own running count, so two zombies in one arc
      // can be on different beats. Melee ignores the gun damage perks so the numbers stay
      // true for everyone — Blomba's meleeMult is the one sanctioned exception: the
      // bouncer's swings are her whole perk.
      let base = w.id === 'fists' ? ((hit.punchN = (hit.punchN | 0) + 1) % 2 ? 6 : 7) : w.dmg;
      // a giant's swing insta-gibs a street walker — but a boss only ever feels the punch,
      // so a grown cousin clears the wave while the small ones keep the real boss DPS
      if (playerGiantOn() && !hit.isBoss) base = 400;
      const knock = (w.id === 'fists' ? 5.5 : 3.5) * (hop ? 2.2 : 1) * (player.grounded ? 1 : 1.5) * (playerGiantOn() ? 1.8 : 1);
      const wasDying = hit.state === 'dying';
      damageZombie(hit, base * player.meleeMult * closeBonus(w, d) * (hop ? 2 : 1), dx / d, dz / d, knock,
        { weapon: w, dist: d, isHead: false });
      if (playerGiantOn() && !hit.isBoss && !hit.netGhost && hit.state === 'dying' && !wasDying && !hit.blob.bodyGone) popChest(hit, dx / d, dz / d);
      meleeMoveGib(w, hit, dx / d, dz / d, hop,
        playerGiantOn() || player.meleeMult > 1 || (selectedCousin === 'blazo' && w.id === 'axe'));
      blombaVamp(w, hit, dx / d, dz / d, wasDying);
    }
    if (hits.length) rumble(...w.rmb);
    else if (meleeWorldHit(w)) rumble(55, 0.55, 0.4);   // wood/steel on wall or steel — the swing met something solid
    // armed weapons chop through: schedule the down swing to land mid-arc (fists keep their
    // own alternating 6,7 chain, one hit per press)
    if (w.id !== 'fists') { player.meleeChopT = player.swingDur * 0.4; player.meleeChopHop = hop; }
    return;
  }
  if (player.reloading > 0) return;
  // empty AND nothing left to load: just the dry click. The reload is kicked off by the
  // last round leaving the mag (below), not by a wasted trigger pull on zero.
  if (player.clip <= 0) { SFX.dry(); return; }
  player.clip--;
  // the last round out of the mag starts the reload on its own
  if (player.clip === 0) tryReload();
  game.shots = (game.shots | 0) + 1; // the death screen counts every round you spent
  // AR discipline perk: the first pull after a beat off the trigger flies dead straight —
  // pace your taps and every one is a marksman round; hold it down and the spray returns
  const steady = w.id === 'rifle' && game.time - player.lastShotT > 0.25;
  player.lastShotT = game.time;
  // gunshots are loud: blind zombies home in on this spot
  game.lastShot.set(player.pos.x, 0, player.pos.z); game.lastShotT = game.time;
  updateAmmoHUD();
  SFX.shoot(w);
  rumble(...w.rmb);
  shakeAmp = Math.max(shakeAmp, w.kick);

  if (gunMesh) {
    const muz = gunMesh.userData.muzzle;
    (muz || gunMesh).getWorldPosition(flash.position);
    if (!muz) flash.position.y += 0.05;
    flash.visible = true;
    flashT = 0.05;
  }

  const pellets = w.pellets || 1;
  _from.copy(camera.position);
  // the long guns reach the whole VISIBLE world: out to wherever the fog actually ends
  // today (weather + draw-distance notch), never less than the old 80
  const REACH = (w.id === 'sniper' || w.id === 'rifle') ? Math.max(80, scene.fog.far) : 80;
  let anyHit = false;
  for (let p = 0; p < pellets; p++) {
    const sp = steady ? 0.002 : w.spread;
    const dx = _aimDir.x + (Math.random() - 0.5) * sp * 2;
    const dy = _aimDir.y + (Math.random() - 0.5) * sp * 2;
    const dzz = _aimDir.z + (Math.random() - 0.5) * sp * 2;
    const dl = Math.hypot(dx, dy, dzz);
    const rdx = dx / dl, rdy = dy / dl, rdz = dzz / dl;

    // nothing behind the muzzle takes a round: the stretch of ray between the camera and
    // the hero's back is dead air (same line the crosshair flare draws — see selfT).
    // WALLS live by this too — backed against a building, the camera sits inside faded
    // wall geometry, and without the gate that wall caught the round at the camera, so
    // fire the hero was plainly clear of died "inside" a building at his back. The round
    // now truly leaves from the gun: geometry behind it is as dead as bodies behind it.
    const tSelf = selfT(_from.x, _from.y, _from.z, rdx, rdy, rdz);
    let tWall = rayGround(_from.x, _from.y, _from.z, rdx, rdy, rdz, REACH);
    for (const c of nearbyColliders(player.pos.x, player.pos.z)) {
      // roofs stop a round on their real pitch, not the box that errs large, so a bird on the
      // ridge (poking above the roofline) is hittable instead of the box eating the shot.
      // Lifted per-collider like the bodies: the round stops where the wall is DRAWN
      const fyC = _from.y + curveDrop(c.x, c.z);
      const t = c.roof ? rayRoof(_from.x, fyC, _from.z, rdx, rdy, rdz, c)
                       : rayAABB(_from.x, fyC, _from.z, rdx, rdy, rdz, c);
      if (t > tSelf && t < tWall) tWall = t;
    }
    const tMax = Math.min(tWall, REACH);
    // gather EVERY body along the line, nearest first — not just the closest — so a
    // killing hit can hand the round on to whoever stood behind (stopping power, below)
    const line = [];
    for (const z of zombies) {
      if (z.state === 'dying' || z.vanished) continue; // Bluga in his smoke takes no rounds
      const gy = z.blob.root.position.y, s = z.scale;
      // aim in DRAWN space: the globe bend sinks this body on screen, so lift the ray
      // by the same amount for its hit test — what the crosshair covers is what dies
      // (matters most for the sniper glassing marks right at the fog line)
      const fy = _from.y + curveDrop(z.pos.x, z.pos.z);
      let zt = tMax, zh = null;
      // sleepers and carcasses lie flat — hit them where they actually are, not standing up
      if (z.state === 'sleep' || z.state === 'corpse') {
        const o = {};
        const lt = lyingHitT(_from.x, fy, _from.z, rdx, rdy, rdz, z, o);
        if (lt < zt) { zt = lt; zh = { isHead: o.isHead, limb: null }; }
      } else {
        const ht = raySphere(_from.x, fy, _from.z, rdx, rdy, rdz, z.pos.x, gy + 1.3 * s, z.pos.z, 0.42 * s);
        if (ht < zt) { zt = ht; zh = { isHead: true, limb: null }; }
        const bt = raySphere(_from.x, fy, _from.z, rdx, rdy, rdz, z.pos.x, gy + 0.7 * s, z.pos.z, 0.55 * s);
        if (bt < zt) { zt = bt; zh = { isHead: false, limb: null }; }
        // the Rotten One's open chest: a sphere over the beating heart proud of his left upper
        // chest (it turns with him). It covers the exposed heart + the mouth of the wound, so a
        // ray landing there upgrades the body hit to weak-spot damage (isHead's 2x) rather than
        // competing with it on distance. Kept aligned with the visual heart in addRotGore.
        if (z.isBoss4 && zh && !zh.isHead) {
          const cy4 = Math.cos(z.yaw || 0), sy4 = Math.sin(z.yaw || 0);
          const hx = z.pos.x + (0.17 * cy4 + 0.48 * sy4) * s;
          const hz = z.pos.z + (-0.17 * sy4 + 0.48 * cy4) * s;
          const wt = raySphere(_from.x, fy, _from.z, rdx, rdy, rdz, hx, gy + 0.82 * s, hz, 0.28 * s);
          if (wt < tMax) zh = { isHead: true, limb: null, weakspot: true };
        }
        // arms + legs live in the zombie's facing frame; a hit here marks that exact limb
        if (!z.isBoss) {
          const cy = Math.cos(z.yaw || 0), sy = Math.sin(z.yaw || 0);
          for (const L of LIMB_SPEC) {
            if (L[0] === 'arm' ? z.blob.armGone[L[1]] : z.blob.legGone[L[1]]) continue;
            const wx = z.pos.x + (L[2] * cy + L[4] * sy) * s;
            const wz = z.pos.z + (-L[2] * sy + L[4] * cy) * s;
            const lt = raySphere(_from.x, fy, _from.z, rdx, rdy, rdz, wx, gy + L[3] * s, wz, L[5] * s);
            if (lt < zt) { zt = lt; zh = { isHead: false, limb: { kind: L[0], idx: L[1] } }; }
          }
        }
      }
      if (zh && zt > tSelf) line.push({ t: zt, z, isHead: zh.isHead, limb: zh.limb, weakspot: zh.weakspot });
    }
    // crows are fair game too — a clean hit lands like a headshot. One shared hit-sphere
    // (crowRayT) that the crosshair flare reads from as well, so a bird that's under the
    // aim always gibs from first contact: no invincibility frames while perched, landed,
    // mid-hop or taking off, and no "dropped feathers and flew off alive" whiffs.
    for (const cw of crows) {
      // birds sink with the curve too — same drawn-space lift as the zombie spheres
      const ct = crowRayT(_from.x, _from.y + curveDrop(cw.g.position.x, cw.g.position.z), _from.z, rdx, rdy, rdz, cw);
      if (ct > tSelf && ct < tMax) line.push({ t: ct, crow: cw });
    }
    line.sort((q, r) => q.t - r.t);
    // stopping power: the round marches down the line and stops in the first body it
    // can't pass through. A kill shot doesn't stop these — the sniper round goes through
    // anything it drops, shotgun pellets through kills inside party range, magnum rounds
    // through the skulls they pop. And no crow ever stopped a heavy round: 1hp of
    // feathers pops and the shot flies on, so one blast can pick a whole murder apart.
    let stopT = tMax, stopped = false;
    for (const hit of line) {
      anyHit = true;
      const dHit = hit.t;
      let died;
      if (hit.crow) {
        if (net.role === 'client') {
          // the host owns the bird: show the hit now (feathers + the number), ask for the
          // kill, and the ghost falls out of the next snapshot with the full pop + drop
          const cb = hit.crow;
          if (!cb.shotPending) {
            cb.shotPending = true;
            spawnDamageNumber(cb.g.position.x, cb.g.position.y + 0.6, cb.g.position.z, Math.round(w.dmg * player.dmgMult * 2));
            spawnParticles(cb.g.position.x, cb.g.position.y + 0.35, cb.g.position.z, CROW_FEATHER, 4, 2, 0.5);
            try { net.conns[0].send({ t: 'crowShot', i: cb.nid }); } catch (e) {}
          }
        } else killCrow(hit.crow, rdx, rdz, w.dmg * player.dmgMult * 2 * closeBonus(w, dHit) * rangeFactor(w, dHit));
        died = true; // crows carry 1hp: first contact pops them
      } else {
        const dmg = w.dmg * player.dmgMult * (hit.isHead ? 2 : 1) * closeBonus(w, dHit) * rangeFactor(w, dHit);
        damageZombie(hit.z, dmg, rdx, rdz, w.id === 'shotgun' ? 1.2 : 2, { weapon: w, dist: dHit, isHead: hit.isHead, limb: hit.limb, weakspot: hit.weakspot });
        // a client can't read host-side hp, so over the wire only the sniper's execute
        // (a guaranteed kill on anything that isn't a boss) counts as a confirmed drop
        died = hit.z.netGhost ? !!(w.execute && !hit.z.isBoss) : hit.z.state === 'dying';
      }
      const pierce = died && (w.id === 'sniper'
        || (w.id === 'shotgun' && (hit.crow || dHit < 9))
        || (w.id === 'magnum' && (hit.crow || hit.isHead)));
      if (!pierce) { stopT = dHit; stopped = true; break; }
    }
    _to.set(_from.x + rdx * stopT, _from.y + rdy * stopT, _from.z + rdz * stopT);
    if (gunMesh) {
      // the curve-exempt tracer goes STRAIGHT to this flat endpoint — which is exactly
      // where the eye sees the hit, since the drawn world sank by the same amount the
      // hit test was lifted. No arc, same landing spot.
      (gunMesh.userData.muzzle || gunMesh).getWorldPosition(_gp);
      spawnTracer(_gp.clone(), _to.clone());
    }
    // the impact dust and the wire DO render through the curve, so their endpoint takes
    // the world-space raise that lands their drawn position on the drawn target
    _to.y += curveDrop(_to.x, _to.z);
    if (!stopped && stopT < REACH) {
      spawnParticles(_to.x, _to.y, _to.z, 0x9a9a8a, 3, 2, 0.3);
    }
  }
  // the bang flushes crows near the muzzle, and near where the shot landed
  scareCrows(player.pos.x, player.pos.z, 16);
  scareCrows(_to.x, _to.z, 9);
  if (anyHit) { hitmarkT = 0.18; SFX.hit(); }
  // every round is visible lobby-wide: the endpoint rides a tiny message and the far side
  // draws the same tracer from this player's muzzle (netRemotePew). Host shots broadcast
  // as Player 1; a client's go up to the host, who draws them and relays to the rest.
  if (net.role) {
    const pm = { t: 'pew', x: Math.round(_to.x * 10) / 10, y: Math.round(_to.y * 10) / 10, z: Math.round(_to.z * 10) / 10 };
    if (net.role === 'host') netBroadcast({ ...pm, p: 1 });
    else try { net.conns[0].send(pm); } catch (e) {}
  }
}
// draw another player's round: a tracer from their muzzle to where it ended, the bang
// audible in 3d — the far half of fireWeapon's own tracer + shot sound
function netRemotePew(blob, gunMeshR, weapon, ex, ey, ez) {
  if (!blob) return;
  const from = new THREE.Vector3();
  if (gunMeshR && gunMeshR.userData.muzzle) gunMeshR.userData.muzzle.getWorldPosition(from);
  else { blob.root.getWorldPosition(from); from.y += 1.1; }
  spawnTracer(from, new THREE.Vector3(ex, ey, ez));
  if (weapon && !weapon.melee && Math.hypot(from.x - player.pos.x, from.z - player.pos.z) < 30)
    play3d(from.x, from.z, () => SFX.shoot(weapon));
}
// death bookkeeping: kills counter, gore burst, optional head-pop, loot drop
function killZombie(z, kx, kz, headPop) {
  if (z.state === 'dying') return;
  z.state = 'dying'; z.deadT = 0; z.hp = 0;
  z.diedPop = !!headPop;   // streamed so a joiner bursts the head on gib kills too, not just ours
  if (z.isBoss) onBossDefeated(z);
  game.kills++;
  hud.kills.textContent = game.kills;
  if (game.cleanup) updateQuotaHud();
  if (game.cleanup && game.kills >= game.clearTarget) completeCleanup();
  play3d(z.pos.x, z.pos.z, () => SFX.splat());
  rumble(70, 0.4, 0.3);
  spawnBlood(z.pos.x, z.blob.root.position.y + 0.8 * z.scale, z.pos.z, kx, kz, 2.2);
  if (headPop) popHead(z, kx, kz);
  // black-ops blobs drop their own loot (ammo, and BEST JELLY off a perimeter guard); ordinary
  // dead roll the usual ammo/medkit
  if (z.fbi) fbiOnDeath(z);
  else if (Math.random() < 0.22 * settings.lootSpawn) spawnPickup(Math.random() < 0.7 ? 'ammo' : 'medkit', z.pos.x, z.pos.z);
}
// sniper-class execute: the target detonates wherever it was struck — instant kill
function executeZombie(z, kx, kz, limb, isHead) {
  if (z.state === 'dying') return;
  const b = z.blob;
  if (limb) { blowLimb(z, kx, kz, limb); blowLimb(z, kx, kz); } // the struck limb comes off first, then it comes apart
  else if (isHead) blowLimb(z, kx, kz);                         // head hit: killZombie's head pop leads
  else popChest(z, kx, kz);              // centre mass: the chest blob pops, the rest drops off
  spawnBlood(z.pos.x, b.root.position.y + 0.9 * z.scale, z.pos.z, kx, kz, 3);
  for (let i = 0; i < 4; i++) spawnGib(z.pos.x, b.root.position.y + (0.4 + Math.random()) * z.scale, z.pos.z, i % 2 ? BLOOD : 0x8aa85a, kx, kz);
  killZombie(z, kx, kz, true);           // pops the head too
}
// the shotgun's kill blast opens the body up on its way through: a 50/50 the stomach
// splits, a 50/50 a chest side blows — whichever side isn't already open. Spawn rot
// only ever opens ONE side, so a rotted walker the shotgun drops can still come away
// wearing the other side, or the stomach, or both. Wounds never re-open.
function shotgunWoundRoll(z, w) {
  if (!w || w.id !== 'shotgun' || z.isBoss) return;
  const b = z.blob;
  if (!z.rotB && Math.random() < 0.5) { addRotGore(b, { belly: true }); z.rotB = 1; }
  if (Math.random() < 0.5 && !(z.rotR && z.rotRR)) {
    const right = z.rotR ? true : z.rotRR ? false : Math.random() < 0.5;
    if (right) { addRotGore(b, { ribsR: true }); z.rotRR = 1; }
    else { addRotGore(b, { ribs: true }); z.rotR = 1; }
  }
}
// gore a body shot opens on the way through — kill or no kill. The magnum blows a chest
// side open first and the stomach after, in that order: a hand cannon, not a scattergun.
// The shotgun's blast rolls the whole nine on ANY body hit — an eye knocked loose, a
// chest side, the stomach — each only into a slot still closed, likelier up close but
// rolling from a bit farther out too.
function bodyShotGore(z, w, dist) {
  if (!w || z.isBoss) return false;
  const b = z.blob;
  if (w.id === 'magnum') {
    // every body blow rolls for the eye too — the hand cannon's concussion can knock
    // one loose clean through the body
    let hit = false;
    if (!z.rotE && Math.random() < 0.5) {
      addRotGore(b, { hangEye: true, eyeSide: Math.random() < 0.5 ? 1 : -1 }); z.rotE = 1; hit = true;
    }
    if (!z.rotR && !z.rotRR) {
      const right = Math.random() < 0.5;
      if (right) { addRotGore(b, { ribsR: true }); z.rotRR = 1; } else { addRotGore(b, { ribs: true }); z.rotR = 1; }
      hit = true;
    } else if (!z.rotB) { addRotGore(b, { belly: true }); z.rotB = 1; hit = true; }
    return hit;
  } else if (w.id === 'shotgun') {
    const near = dist <= (w.fRange || 7);
    let hit = false;
    if (!z.rotE && Math.random() < (near ? 0.3 : 0.12)) {
      addRotGore(b, { hangEye: true, eyeSide: Math.random() < 0.5 ? 1 : -1 }); z.rotE = 1; hit = true;
    }
    if (!(z.rotR && z.rotRR) && Math.random() < (near ? 0.4 : 0.18)) {
      const right = z.rotR ? true : z.rotRR ? false : Math.random() < 0.5;
      if (right) { addRotGore(b, { ribsR: true }); z.rotRR = 1; } else { addRotGore(b, { ribs: true }); z.rotR = 1; }
      hit = true;
    }
    if (!z.rotB && Math.random() < (near ? 0.4 : 0.18)) { addRotGore(b, { belly: true }); z.rotB = 1; hit = true; }
    return hit;
  }
  return false;
}
// the shotgun's body blast bursts the whole torso when it's delivered close enough to
// feel the muzzle — guaranteed inside its comfort range — or onto a walker already
// wearing BOTH chests open: at that point nothing's holding the middle together
function shotgunBodyGib(z, w, kx, kz, dist, isHead) {
  if (!w || w.id !== 'shotgun' || isHead || z.isBoss || z.netGhost || !z.blob || z.blob.bodyGone) return;
  if (dist <= (w.fRange || 7) || (z.rotR && z.rotRR)) popChest(z, kx, kz);
}
function damageZombie(z, dmg, kx, kz, knock, opts = {}) {if (z.vanished) return; // Bluga in his smoke is untouchable — cull the guards to unmask him
  // in a joined game the host owns every zombie: show feedback, send the hit upstream
  if (net.role === 'client') { if (z.state !== 'dying') netClientShot(z, dmg, kx, kz, opts); return; }
  if (z.state === 'dying') return;
  if (z.fbi) fbiAlert(z); // a perimeter bad blob that takes its first round calls the contact
  // horn-guard: while boss-wave zombies still stand, the Two Horned One shrugs everything
  // off — he flashes green instead of red because nothing got through
  if (z.isBoss && bossShielded()) {
    // the shrug is the same bright invuln green on every boss — one signal, learned once
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
  if (w && w.execute && !z.isBoss) {
    spawnDamageNumber(z.pos.x, b.root.position.y + 1.1 * z.scale, z.pos.z, dmg);
    executeZombie(z, kx, kz, limb, isHead);
    return;
  }

  // heavy weapons, or any hit on an already-exposed brain, burst the head: instant kill, head
  // vanishes. Black-ops armour shrugs the ordinary gib class — only a magnum round earns it here.
  if (isHead && !b.headGone && !z.isBoss && ((w && w.gib) || z.brainExposed) && !fbiArmored(z, w)) {
    spawnDamageNumber(z.pos.x, b.root.position.y + 1.45 * z.scale, z.pos.z, dmg);
    shotgunWoundRoll(z, w);
    killZombie(z, kx, kz, true);
    return;
  }

  z.hp -= dmg;
  flashBlob(b);
  // a round through the Rotten One's open chest: the heart itself sprays — the "you found
  // the spot" read, distinct from the ordinary body-shot blood below
  if (opts.weakspot && b.rotHeart) {
    _gp2.setFromMatrixPosition(b.rotHeart.matrixWorld);
    spawnBlood(_gp2.x, _gp2.y, _gp2.z, kx, kz, 1.6);
    spawnParticles(_gp2.x, _gp2.y, _gp2.z, ROT_HEART, 6, 3, 0.4);
  }
  spawnDamageNumber(z.pos.x, b.root.position.y + (isHead ? 1.45 : 0.95) * z.scale, z.pos.z, dmg);
  // a boss is a mountain: a hit staggers a walker across the street but barely rocks him,
  // so weapons can't kite a boss backwards the way they herd the horde
  const kb = z.isBoss ? 0.05 : 1;
  z.pos.x += kx * knock * 0.12 * kb;
  z.pos.z += kz * knock * 0.12 * kb;
  // the blow carries: an impulse the body keeps riding (integrated in updateZombies).
  // Set before the kill check on purpose — a corpse should be thrown by the hit that
  // killed it, not drop straight down on the spot.
  z.kvx = (z.kvx || 0) + kx * knock * 0.5 * kb;
  z.kvz = (z.kvz || 0) + kz * knock * 0.5 * kb;
  spawnBlood(z.pos.x, b.root.position.y + (isHead ? 1.25 : 0.75) * z.scale, z.pos.z, kx, kz, isHead ? 1.3 : 1);
  // wounds bleed: leave a stain on the body itself and start dripping a ground trail
  z.bleeding = true;
  if (!isHead && Math.random() < 0.75) {
    const localAng = Math.atan2(-kx, -kz) - (z.yaw || 0);
    const st = stainBody(b.wob, b.stainCount, localAng + (Math.random() - 0.5) * 0.6, -0.1 + Math.random() * 0.55, 1);
    if (st) foldSkin(b, st);   // fresh blood spots join the flash too
  }

  // the assault rifle takes an arm clean off in a single hit: a round that catches an arm
  // severs it outright, no roll (armSever). Legs and body shots still go through the chance.
  // FBI armour holds both off — only magnum/sniper rounds delimb a black-ops blob.
  let severed = false;
  if (w && w.armSever && !isHead && !z.isBoss && limb && limb.kind === 'arm' && !b.armGone[limb.idx] && !fbiArmored(z, w)) {
    blowLimb(z, kx, kz, limb); severed = true;
  } else if (!isHead && !z.isBoss && w && w.dismember && !fbiArmored(z, w)) {
    // limb dismemberment — a direct hit on an arm/leg severs that exact limb; else a body-shot chance
    const base = limb ? 0.9 : 0.55;
    if (Math.random() < w.dismember * closeBonus(w, dist) * (z.hp <= 0 ? 1 : base)) { blowLimb(z, kx, kz, limb); severed = true; }
  }
  // the magnum and the shotgun open the body up on body hits, not just kills
  let gored = false;
  if (!isHead && !fbiArmored(z, w)) gored = bodyShotGore(z, w, dist);
  // black-ops armour shrugs the small stuff — but a gore wound that DOES land (a chest
  // blown open, the stomach split, an arm off) drops the blob where it stands
  if (z.fbi && (severed || gored)) { killZombie(z, kx, kz, false); return; }

  if (z.hp > 0) {
    // weak, far or skullcrack (marksman rifle) headshot that doesn't kill cracks the
    // skull open, revealing the weak spot: one tap opens it, the next tap pops it.
    // A black-ops mask never cracks — there's no brain window through a shiesty.
    if (isHead && !z.brainExposed && !z.isBoss && !z.fbi && w && (w.weak || w.skullcrack || dist > 26)) {
      if (w.id === 'pistol') {
        // pistol skull discipline: an eye already dangling — street rot, or a round that
        // knocked one loose — is a window straight in, one tap opens the brain. A sealed
        // face takes two taps, and the FIRST has a 25% shot at popping an eye out onto
        // its stalk (the rot dressing, either side), buying the next tap that window.
        if (b.hangEye) exposeBrain(z);
        else if ((z.skullHits = (z.skullHits | 0) + 1) >= 2) exposeBrain(z);
        else if (Math.random() < 0.25) {
          addRotGore(b, { hangEye: true, eyeSide: Math.random() < 0.5 ? 1 : -1 });
          z.rotE = 1; // rides the wire (zs.he) so client ghosts hang the same eye
        }
      } else exposeBrain(z);
    }
    return;
  }
  shotgunWoundRoll(z, w);
  killZombie(z, kx, kz, isHead && !fbiArmored(z, w) && (!w || w.gib || z.brainExposed));
  shotgunBodyGib(z, w, kx, kz, dist, isHead);
}
// FBI armour: black-ops blobs don't come apart under ordinary fire. The heavy dismember
// class still gets through — magnum and sniper rounds here; a chili giant's blows, Blazo's
// leaping axe and Blomba's melee are cleared at their own call sites (meleeMoveGib, blombaVamp).
function fbiArmored(z, w) {
  return !!z.fbi && !(w && (w.id === 'magnum' || w.id === 'sniper'));
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
// a melee you can hand over in a player-to-player trade (fists stay attached to you)
function meleeTradable(id) { const w = WEAPONS[id]; return !!(w && w.melee && id !== 'fists'); }
// an AI cousin you're close to AND looking at — so the squad trailing behind doesn't spam the
// trade prompt while you walk. Player-run cousins are EXCLUDED here: taking a weapon off another
// human is never a one-tap grab any more — it goes through the two-sided hold pact instead.
function findNearTrade() {
  let best = null, bestD = 2.4;
  const fx = -Math.sin(player.camYaw), fz = -Math.cos(player.camYaw);
  for (const c of companions) {
    if (!c.recruited || c.downed || c.netP) continue;
    const dx = c.pos.x - player.pos.x, dz = c.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD && (dx * fx + dz * fz) / Math.max(d, 0.001) > 0.5) { bestD = d; best = c; }
  }
  return best;
}
// host-side: the nearest player-run cousin you're close to AND facing, any weapon — the target
// of a hold-to-trade. A tap here just fires the trade emote; the swap is the two-sided hold.
function findNearNetPlayer() {
  let best = null, bestD = TRADE_RANGE;
  const fx = -Math.sin(player.camYaw), fz = -Math.cos(player.camYaw);
  for (const c of companions) {
    if (!c.netP || !c.netConn || c.downed) continue;
    if ((c.netGs || 1) > 1.02) continue; // no dealing with (or at) a chili giant
    const dx = c.pos.x - player.pos.x, dz = c.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD && (dx * fx + dz * fz) / Math.max(d, 0.001) > 0.5) { bestD = d; best = { p: c.netP, name: c.data.name }; }
  }
  return best;
}
// swap held weapons with a recruited cousin — hand their personal favourite back, or borrow it
function tradeWeapons(c) {
  const myId = player.weapon.id;
  const theirId = (c.weapon || WEAPONS.pistol).id;
  if (myId === 'fists') { toast('NOTHING TO TRADE BUT SKIN . .'); return; } // AI cousins don't deal in skin
  if (myId === theirId) { toast('YOU BOTH HOLD THE SAME WEAPON'); return; }
  // a true swap: the weapon you hand over leaves your kit entirely — and the ammo you were
  // carrying for it (reserve + the loaded clip) goes with it — so nothing duplicates and you
  // can't cycle back to a gun you gave away
  const oi = player.owned.indexOf(myId);
  if (oi >= 0) player.owned.splice(oi, 1);
  delete reserves[myId];
  setCompanionWeapon(c, myId, false); // no banking: the player just took that gun with them
  equipWeapon(theirId);
  // a player-run cousin is a real person elsewhere: tell their client to settle its side
  if (c.netP && c.netConn) { try { c.netConn.send({ t: 'tradeW', w: myId, took: theirId }); } catch (e) {} }
  SFX.swap(WEAPONS[theirId]);
  rumble(60, 0.3, 0.4);
  toast(`TRADED: YOUR ${WEAPONS[myId].name.toUpperCase()} FOR ${(c.netP ? 'P' + c.netP + ' ' : '') + c.data.name.toUpperCase()}'S ${WEAPONS[theirId].name.toUpperCase()}`);
  bloopyTradeNice();
}
// ---------- hold-to-trade consent (multiplayer, any weapons) ----------
// A fair, two-sided handshake: each player's character-picker face fills with their own colour
// as they hold interact near the other. Neither can take a weapon one-sided — the swap only
// settles once BOTH faces are full. Host-authoritative: the host tracks both sides' hold and
// streams each client its own + its partner's progress so every screen shows the same pact.
const TRADE_DUR = 1.2, TRADE_RANGE = 3.2;
const tradeHold = { key: null, cd: 0, txT: 0, t: {}, emoted: {}, aE: null, bE: null };
const tradeRingEl = document.getElementById('tradering');
function tradeRing(v) {   // legacy single ring, kept only for the exports table; the pact replaces it
  if (v > 0.02) {
    tradeRingEl.style.display = 'block';
    tradeRingEl.style.setProperty('--fill', (v * 360) + 'deg');
  } else tradeRingEl.style.display = 'none';
}
function myCousinData() { return COUSINS.find(k => k.id === selectedCousin) || COUSINS[0]; }

// --- the two-face consent widget (drawn on whichever screen is one of the two traders) ---
const tradePactEl = document.getElementById('tradepact');
const tpMe = { color: -1 }, tpThem = { color: -1 };
tpMe.face = tradePactEl.querySelector('.tpme'); tpThem.face = tradePactEl.querySelector('.tpthem');
tpMe.base = tpMe.face.querySelector('.tpbase'); tpMe.fill = tpMe.face.querySelector('.tpfill');
tpThem.base = tpThem.face.querySelector('.tpbase'); tpThem.fill = tpThem.face.querySelector('.tpfill');
const tpLabelEl = tradePactEl.querySelector('.tplabel');
let tpAcceptT = 0;   // >0 while the ACCEPTED sting holds before the faces fade out under the chord
function tpSetFace(slot, color, lookLeft) {
  if (slot.color === color) return;              // faceIcon mints a fresh data URL each call — cache by colour
  slot.color = color;
  const url = faceIcon(color, lookLeft);
  slot.base.src = url; slot.fill.src = url;
}
// the label the viewer sees for what's being put on the table for THEM: the partner's weapon
// (what you'd receive), or a bare fist on either side = the whole dignified skin-and-kit swap
function offerLabel(myW, themW) {
  if (myW === 'fists' || themW === 'fists') return 'SKIN OFFER .ᐟ';
  return `${WEAPONS[themW] ? WEAPONS[themW].name.toUpperCase() : 'WEAPON'} OFFER .ᐟ`;
}
function tradePact(meColor, themColor, meFill, themFill, themLookLeft, offerText) {
  if (tpAcceptT > 0) return;                      // the accept animation owns the widget until it fades
  tradePactEl.classList.remove('hidden', 'fade', 'accepted');
  tpSetFace(tpMe, meColor, selectedCousin === 'blondie');
  tpSetFace(tpThem, themColor, !!themLookLeft);
  tpMe.face.style.setProperty('--fill', meFill.toFixed(3));
  tpThem.face.style.setProperty('--fill', themFill.toFixed(3));
  tpLabelEl.textContent = offerText || 'TRADE OFFER .ᐟ';   // the offer stands here until it's accepted
}
function tradePactHide() {
  if (tpAcceptT > 0) return;
  tradePactEl.classList.add('hidden');
}
function tradePactAccept() {
  if (tpAcceptT > 0) return;
  tradePactEl.classList.remove('hidden', 'fade');
  tradePactEl.classList.add('accepted');
  tpMe.face.style.setProperty('--fill', '1'); tpThem.face.style.setProperty('--fill', '1');
  tpLabelEl.textContent = 'ACCEPTED .ᐟ';           // flips in place — same slot the offer stood in
  tpAcceptT = 1.2;
  SFX.tradeAccept();                              // the soundoff chord from the end of the splash medley
}
// runs every playing frame on both roles: bleeds the ACCEPTED sting out with the chord's tail
function updateTradePact(dt) {
  if (tpAcceptT <= 0) return;
  tpAcceptT -= dt;
  if (tpAcceptT <= 0.55) tradePactEl.classList.add('fade');
  if (tpAcceptT <= 0) tradePactEl.classList.add('hidden');
}
// hard reset (a new run cleared the field): drop the pact even mid-accept
function tradePactReset() { tpAcceptT = 0; tradePactEl.classList.add('hidden'); tradePactEl.classList.remove('accepted', 'fade'); }

// --- host: track both sides' independent hold and settle the swap ---
function updateHoldTrades(dt) {
  tradeHold.cd -= dt;
  tradeHold.txT -= dt;
  updateSkinOfferTimers(dt);
  // everyone who could be trading right now: me (the host) + every player-run cousin, up & alive
  const parts = [];
  const meP = net.playerNum || 1;
  if (!player.dead && !player.downed && !playerGiantAny())  // a giant host signs no pacts
    parts.push({ p: meP, self: true, x: player.pos.x, z: player.pos.z,
      held: !!(input.interactHeld || input.interactHeldPad), data: myCousinData() });
  for (const c of companions)
    if (c.netP && c.netConn && !c.downed && (c.netGs || 1) <= 1.02) // nor does a giant client
      parts.push({ p: c.netP, c, x: c.pos.x, z: c.pos.z, held: !!(c.netPose && c.netPose.th), data: c.data });
  // the engagement = the closest in-reach pair with at least one side holding, so the pact can
  // show with the partner greyed the instant you reach out — before they've held back
  let a = null, b = null, bd = TRADE_RANGE;
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    if (!parts[i].held && !parts[j].held) continue;
    const d = Math.hypot(parts[i].x - parts[j].x, parts[i].z - parts[j].z);
    if (d < bd) { bd = d; a = parts[i]; b = parts[j]; }
  }
  updateSkinNudge(dt, !a && tradeHold.cd <= 0 && skinOfferOpen(parts.filter(p => p.held)));

  const key = a ? a.p + '-' + b.p : null;
  if (key !== tradeHold.key) {
    tradeClearStream();                 // tell the previous partners to drop their pact
    tradeHold.t = {}; tradeHold.emoted = {};
    tradeHold.key = key;
    // a standing 2s+ bare-fist offer still converts fast: seed that side half-full
    if (a) for (const e of [a, b]) {
      const off = e.self ? Math.max(0, skinNudge.t) : (e.c ? e.c.skinOfferT || 0 : 0);
      if (off >= 2) tradeHold.t[e.p] = TRADE_DUR * 0.5;
    }
  }
  if (!a || tradeHold.cd > 0) {
    if (tradeHold.aE || tradeHold.bE) tradeClearStream();
    tradeHold.aE = tradeHold.bE = null;
    tradePactHide();
    return;
  }
  updateSkinNudge(dt, false);
  tradeHold.aE = a; tradeHold.bE = b;

  // each face fills only while THAT side holds; letting go bleeds it back down fast
  for (const e of [a, b]) {
    let v = tradeHold.t[e.p] || 0;
    if (e.held) {
      if (v <= 0 && !tradeHold.emoted[e.p]) {          // first reach-out this engagement → auto trade emote
        tradeHold.emoted[e.p] = 1;
        if (e.self && TRADE_EMOTE >= 0) fireEmote(TRADE_EMOTE);
      }
      v = Math.min(TRADE_DUR, v + dt);
    } else { v = Math.max(0, v - dt * 2.5); tradeHold.emoted[e.p] = 0; }
    tradeHold.t[e.p] = v;
  }
  const progA = (tradeHold.t[a.p] || 0) / TRADE_DUR, progB = (tradeHold.t[b.p] || 0) / TRADE_DUR;

  // paint my own pact if I'm one of the two; if I'm just the host relaying two clients, hide mine
  const meSide = a.self ? a : b.self ? b : null;
  if (meSide) {
    const them = meSide === a ? b : a;
    tradePact(myCousinData().color, them.data.color,
      meSide === a ? progA : progB, them === a ? progA : progB, them.data.id === 'blondie',
      offerLabel(player.weapon.id, sideWeapon(them)));
  } else tradePactHide();

  if (tradeHold.txT <= 0) {
    tradeHold.txT = 0.06;
    tradeStreamSide(a, b, progA, progB);
    tradeStreamSide(b, a, progB, progA);
  }
  if (progA >= 1 && progB >= 1) {
    const swapped = executeHoldTrade(a, b);
    if (swapped) {   // only a real hand-off rings ACCEPTED on every screen; a no-op just resets
      if (a.self || b.self) tradePactAccept();
      for (const s of [a, b]) if (s.c && s.c.netConn) { try { s.c.netConn.send({ t: 'tradeAcc' }); } catch (e) {} }
    }
    tradeHold.t = {}; tradeHold.emoted = {}; tradeHold.cd = 1.5; tradeHold.key = null;
    if (a.c) a.c.skinOfferT = 0;
    if (b.c) b.c.skinOfferT = 0; // a settled trade spends the standing offer
  }
}
const sideWeapon = e => e.self ? player.weapon.id : (e.c.weapon || WEAPONS.pistol).id;
// stream one net side its own fill + its partner's, who the partner is (colour + grey the faces),
// and the offer label THIS side reads. The host paints its own pact directly and isn't streamed.
function tradeStreamSide(side, partner, meProg, themProg) {
  if (!side.c || !side.c.netConn) return;
  try { side.c.netConn.send({ t: 'tradeP', me: meProg, them: themProg, tp: partner.p, tc: partner.data.id,
    ol: offerLabel(sideWeapon(side), sideWeapon(partner)) }); } catch (e) {}
}
// tell the last-engaged net partners to clear their pact (the engagement dropped)
function tradeClearStream() {
  for (const s of [tradeHold.aE, tradeHold.bE])
    if (s && s.c && s.c.netConn) { try { s.c.netConn.send({ t: 'tradeP', me: 0, them: 0 }); } catch (e) {} }
}
// settles a filled pact. Returns true when something actually changed hands, so the caller only
// rings the ACCEPTED chord on a real swap (not on the both-hold-the-same-gun no-op).
function executeHoldTrade(a, b) {
  const idOf = e => e.self ? player.weapon.id : (e.c.weapon || WEAPONS.pistol).id;
  const idA = idOf(a), idB = idOf(b);
  if (idA === 'fists' || idB === 'fists') { executeSkinTrade(a, b); return true; } // a bare fist on the table trades the skin it's attached to
  if (idA === idB) { toast('YOU BOTH HOLD THE SAME WEAPON'); return false; }
  for (const [e, give, take] of [[a, idA, idB], [b, idB, idA]]) {
    if (e.self) {
      const i = player.owned.indexOf(give); if (i >= 0) player.owned.splice(i, 1);
      delete reserves[give];   // the ammo you were carrying leaves with the weapon
      equipWeapon(take);
      toast(`TRADED: YOUR ${WEAPONS[give].name.toUpperCase()} FOR ${anA(WEAPONS[take].name)} ${WEAPONS[take].name.toUpperCase()}`);
    } else {
      setCompanionWeapon(e.c, take);
      try { e.c.netConn.send({ t: 'tradeW', w: take, took: give }); } catch (err) {}
    }
  }
  if (!a.self && !b.self) toast(`P${a.p} AND P${b.p} TRADED WEAPONS`);
  bloopyTradeNice();
  return true;
}
// (the old one-sided netHandleTradeReq is gone — a HUMAN's weapon can only change hands through
//  the two-sided hold pact in updateHoldTrades, so there's no request path left to grab one.)
// AI cousins, though, deal freely with anyone: a client taps to trade with an NPC and the host
// settles it one-sided, exactly like the host's own findNearTrade/tradeWeapons. No consent — an
// NPC isn't a real person. The requesting player gives their held weapon, takes the NPC's.
function netHandleNpcTrade(conn, cid) {
  const req = cousinByConn(conn);              // the requesting player's body on the host
  if (!req || req.downed) return;
  const reqW = (req.weapon || WEAPONS.pistol).id;
  if (reqW === 'fists') return;                // a bare fist has nothing to trade an NPC but skin
  const npc = companions.find(k => k.recruited && !k.netP && !k.downed && k.data.id === cid);
  if (!npc || !npc.weapon || npc.weapon.id === 'fists' || npc.weapon.id === reqW) return;
  if (Math.hypot(npc.pos.x - req.pos.x, npc.pos.z - req.pos.z) > 3.4) return;
  const npcW = npc.weapon.id;
  setCompanionWeapon(npc, reqW, false);        // the NPC takes the player's weapon (no banking — the client walked off with theirs)
  try { conn.send({ t: 'tradeW', w: npcW, took: reqW }); } catch (e) {} // the client equips the NPC's
  toast(`P${req.netP} TRADED WITH ${npc.data.name.toUpperCase()}`);
  bloopyTradeNice();
}
// ---------- the bare-skin trade (multiplayer cousin swap) ----------
// When a settled hold-trade has a bare fist on either side, the two players trade
// EVERYTHING — cousins, kits, wounds, spots. Player numbers and the lobby never move;
// only the skins change hands. Runs on the host (hold-trades are host-settled).
function executeSkinTrade(a, b) {
  if ((a.self || b.self) && player.downed) return; // no dealing skin from the dirt
  if (a.self || b.self) {
    // host <-> client: my kit rides down with the swap order; theirs returns on the reply
    const c = (a.self ? b : a).c;
    const myData = COUSINS.find(k => k.id === selectedCousin) || COUSINS[0];
    const theirData = c.data;
    const kit = { owned: player.owned.slice(), rs: { ...reserves }, w: player.weapon.id,
      clip: Number.isFinite(player.clip) ? player.clip : 0, hp: Math.max(1, Math.round(player.hp)) };
    const mx = player.pos.x, mz = player.pos.z;
    const cx = c.pos.x, cz = c.pos.z, cHp = c.hp;
    c.swapTo = 'host';
    try { c.netConn.send({ t: 'cswap', c: myData.id, x: mx, z: mz, kit }); } catch (e) {}
    applyCousin(theirData.id);
    player.pos.set(cx, groundHeight(cx, cz), cz);
    player.vy = 0;
    player.hp = clamp(cHp || player.maxHp, 1, player.maxHp);
    swapCompanionIdentity(c, myData, mx, mz);
    setCompanionWeapon(c, kit.w);
    if (c.netPose) c.netPose.wp = kit.w;
    c.hp = Math.min(kit.hp, c.maxHp);
    toast(`P1 ~ ${theirData.name.toUpperCase()} .ᐟ`, true);
    playSwapTheme();
  } else {
    // client <-> client: the host re-dresses both bodies and relays each kit across
    const c1 = a.c, c2 = b.c;
    const d1 = c1.data, d2 = c2.data;
    const s1 = { x: c1.pos.x, z: c1.pos.z, hp: c1.hp, w: (c1.weapon || WEAPONS.pistol).id };
    const s2 = { x: c2.pos.x, z: c2.pos.z, hp: c2.hp, w: (c2.weapon || WEAPONS.pistol).id };
    c1.swapTo = c2.netConn; c2.swapTo = c1.netConn;
    try { c1.netConn.send({ t: 'cswap', c: d2.id, x: s2.x, z: s2.z }); } catch (e) {}
    try { c2.netConn.send({ t: 'cswap', c: d1.id, x: s1.x, z: s1.z }); } catch (e) {}
    swapCompanionIdentity(c1, d2, s2.x, s2.z);
    swapCompanionIdentity(c2, d1, s1.x, s1.z);
    setCompanionWeapon(c1, s2.w); setCompanionWeapon(c2, s1.w);
    if (c1.netPose) c1.netPose.wp = s2.w;
    if (c2.netPose) c2.netPose.wp = s1.w;
    c1.hp = Math.min(s2.hp, c1.maxHp); c2.hp = Math.min(s1.hp, c2.maxHp);
    toast(`P${a.p} ~ ${d2.name.toUpperCase()} .ᐟ P${b.p} ~ ${d1.name.toUpperCase()} .ᐟ`, true);
  }
  rumble(120, 0.5, 0.5);   // the ACCEPTED soundoff chord (pact) + swap theme carry the audio now
  bloopyTradeNice(); // even a whole-skin deal gets the one-word review
}
// re-dress a player-driven companion as a different cousin on a different spot — the
// host-side half of a bare-skin trade (the player behind it keeps their number + conn)
function swapCompanionIdentity(c, data, x, z) {
  scene.remove(c.blob.root);
  if (c.blob.shadow) scene.remove(c.blob.shadow);
  c.data = data;
  c.blob = buildBlob({ color: data.color, gunHand: data.id === 'blondie' ? 'left' : 'right', hands: cousinHands(data.id) });
  scene.add(c.blob.root);
  c.pos.x = x; c.pos.z = z;
  c.y = groundHeight(x, z);
  c.blob.root.position.set(x, c.y, z);
  c.blob.root.rotation.y = c.yaw || 0;
  // stale pose targets would lerp the body straight back to the old spot
  if (c.netPose) { c.netPose.x = x; c.netPose.z = z; c.netPose.y = c.y; }
  c.gunMesh = null; // went down with the old blob; setCompanionWeapon rebuilds it
  c.maxHp = data.id === 'blomba' ? 125 : 100;
  c.hp = Math.min(c.hp, c.maxHp);
  rebuildSquadBars();
}
// wholesale kit replacement: the other side of a bare-skin trade delivered their entire
// loadout — weapon list, every reserve, the loaded clip, and the body's wounds
function applySwapKit(kit) {
  if (!kit || !Array.isArray(kit.owned)) return;
  player.owned = kit.owned.filter(id => WEAPONS[id]);
  if (!player.owned.includes('fists')) player.owned.unshift('fists');
  for (const k in reserves) delete reserves[k];
  for (const k in (kit.rs || {})) if (WEAPONS[k]) reserves[k] = kit.rs[k] | 0;
  equipWeapon(WEAPONS[kit.w] ? kit.w : 'fists');
  if (!player.weapon.melee && Number.isFinite(kit.clip)) player.clip = clamp(kit.clip | 0, 0, player.weapon.mag);
  if (Number.isFinite(kit.hp)) player.hp = clamp(kit.hp, 1, player.maxHp);
  updateAmmoHUD();
}
// ---------- the bare-skin offer ----------
// Fists held out at an armed player who hasn't answered the hold: there's nothing to
// trade but skin. Name the offer, and while it stands keep pitching it — every 2s the
// Trade .ᐟ emote fires itself so the other side knows exactly what's on the table.
const TRADE_EMOTE = EMOTES.findIndex(e => e.startsWith('Trade'));
const skinNudge = { t: -1 };
function updateSkinNudge(dt, on) {
  if (!on) { skinNudge.t = -1; return; }
  if (skinNudge.t < 0) { skinNudge.t = 0; toast('NOTHING TO TRADE BUT SKIN . .'); return; }
  const before = skinNudge.t;
  skinNudge.t += dt;
  if (Math.floor(skinNudge.t / 2) > Math.floor(before / 2)) {
    toast('NOTHING TO TRADE BUT SKIN . .');
    if (TRADE_EMOTE >= 0) fireEmote(TRADE_EMOTE);
  }
}
// host-side: is MY bare fist held out at an armed player who isn't holding back?
function skinOfferOpen(holders) {
  if (player.weapon.id !== 'fists' || player.downed || !holders.some(h => h.self)) return false;
  for (const c of companions) {
    if (!c.netP || c.downed || !c.weapon || c.weapon.id === 'fists') continue;
    if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 3.2) return true;
  }
  return false;
}
// host-side: each client's standing fists offer, timed off the th flag they stream —
// an offer that's been up 2s+ converts fast the moment it's answered
function updateSkinOfferTimers(dt) {
  for (const c of companions)
    c.skinOfferT = (c.netP && !c.downed && c.netPose && c.netPose.th && c.weapon && c.weapon.id === 'fists')
      ? (c.skinOfferT || 0) + dt : 0;
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
  const loot = rollCrateLoot(rng, cr);
  // a chili giant can't hold a gun, so a crate a giant bursts hands over its HEALTH only —
  // a medkit still heals, but weapons and ammo are left in the dirt (giantSpill marks them)
  if (playerGiantOn()) {
    if (loot === 'medkit') { player.hp = Math.min(player.maxHp, player.hp + 40); toast('+40 HP'); SFX.pickup(); }
    else { toast('TOO BIG FOR THE GUNS . .'); giantSpill(cr.pos.x, cr.pos.z); }
    return;
  }
  if (loot === 'sniperammo') {
    // the armoury's full: the consolation is a box of the scarcest rounds in the game
    const add = Math.ceil(WEAPONS.sniper.mag * (1.5 + rng()) * player.ammoMult);
    reserves.sniper = (reserves.sniper | 0) + add;
    toast(`+${add} SNIPER AMMO`);
    SFX.pickup();
    updateAmmoHUD();
  } else if (loot === 'ammo') {
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
// the giant leaves what it can't use: a little grey puff over the crate it just crushed
function giantSpill(x, z) {
  spawnParticles(x, groundHeight(x, z) + 0.6, z, 0x8a8f98, 8, 3, 0.7);
}
function giveWeapon(id) {
  const w = WEAPONS[id];
  const gain = Math.round(w.ammo * player.ammoMult);
  reserves[id] = (reserves[id] | 0) + gain;
  if (player.weapon.id === id) {
    toast(`+${gain} ${w.name.toUpperCase()} AMMO`);
  } else {
    equipWeapon(id);
    toast(`${w.name.toUpperCase()} ACQUIRED .ᐟ`);
  }
  updateAmmoHUD();
}
let recruitCounter = 0;
function recruitCousin(c, byP = 1) {
  c.recruited = true;
  c.followP = byP;  // in a lobby the cousin walks with WHOEVER recruited them (1 = host)
  c.inCmd = false;
  c.order = ++recruitCounter; // formation order = order found
  c.hp = c.maxHp; c.downed = false;
  scene.remove(c.beacon);
  c.beacon = null;
  SFX.recruit();
  rumble(160, 0.5, 0.7);
  toast(`${c.data.name.toUpperCase()} JOINED .ᐟ`);
  // the whole lobby hears the signing: clients toast the JOINED and tick their own N/6
  if (net.role === 'host' && typeof netBroadcast === 'function')
    netBroadcast({ t: 'cjoin', c: c.data.id, n: companions.filter(k => k.recruited).length, tot: companions.length });
  settleGunTrades();
  updateCousinHUD();
  rebuildSquadBars();
  maybeSpawnBoss();
  // half of them say hello, half just fall in — so the greeting stays a moment rather
  // than a formality. Beat late: the JOINED toast lands first, then they speak.
  // Bloopy is the exception: he has NEVER once skipped the hello. No coin for him.
  if (Math.random() < 0.5 || persona(c).alwaysHello) c.helloT = 0.45;
  // family lore: Bloopy has watched Blondie's pocket-geometry looting for years. Every
  // time she signs back on, he wishes the world good luck. Always — no coin on this one.
  if (c.data.id === 'blondie') {
    const bp = companions.find(o => o.data.id === 'bloopy' && o.recruited && !o.downed && !o.netP);
    if (bp) bp.luckT = 1.2; // lands after her own possible hello, so the bubbles don't stack
  }
}
// ---------- cousin battle personas ----------
// Each cousin fights like themselves, not like a squad slot. These are the tells you'd
// recognise from across the street: Blizzy's slide-hops closing the gap, Blingo bouncing
// through a firefight, Blazo's leaping chop, Blomba picking birds out of the sky, Bloopy's
// one word for a fallen boss, Blondie sweeping the ground clean and hopping back to formation.
// Every quirk is cosmetic-plus: it changes how they move and when they act, never their
// damage — the perks on the picker still own the numbers.
const PERSONA = {
  blizzy:  { slideCatchup: true },   // never merely walks back to you: slides, hops out of it
  blingo:  { fightHops: true },      // can't stand still in a fight
  blazo:   { leapChop: true },       // melee in hand? the swing comes down out of the air
  blomba:  { crowShot: true, meleeBrawler: true }, // guns: no crow is safe. Melee: he takes the fight TO them
  bloopy:  { bossNice: true, alwaysHello: true, tradeNice: true }, // says the quiet part when a boss drops; never skips a hello; rates every trade
  blondie: { sweeper: true },        // wider loot reach, and hops home once she has it
};
function persona(c) { return (c.data && PERSONA[c.data.id]) || {}; }
// a cousin's own voice: the emote bubble + ping everyone else's cousins get, fired at
// their own head rather than the player's. Mirrored to the lobby so a client sees it too.
function cousinEmote(c, i) {
  if (i < 0) return;
  spawnBubble(() => ({ x: c.pos.x, y: (c.y || 0) + 2.2, z: c.pos.z }), EMOTES[i] || '', c);
  if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 26) play3d(c.pos.x, c.pos.z, () => SFX.pickup());
  if (net.role === 'host' && typeof netBroadcast === 'function') netBroadcast({ t: 'cemote', c: c.data.id, e: i });
}
const HELLO_EMOTE = EMOTES.findIndex(e => e.startsWith('Hello'));
const NICE_EMOTE = EMOTES.findIndex(e => e.startsWith('Nice'));
const LUCK_EMOTE = EMOTES.findIndex(e => e.startsWith('Good'));
// Bloopy appreciates commerce: once he's on the squad, EVERY settled trade — weapons,
// melees, whole skins — gets his one-word review, a beat after the swap lands
function bloopyTradeNice() {
  const bp = companions.find(o => persona(o).tradeNice && o.recruited && !o.downed && !o.netP);
  if (bp) bp.niceT = 0.9;
}
// "a" or "an", by how the weapon's name is actually said out loud — an SMG, an Assault
// Rifle, a Pistol. Used by every found/traded-weapon toast.
function anA(name) { return (/^[AEIOU]/i.test(name) || /^SMG/i.test(name)) ? 'AN' : 'A'; }
// weapon-only loot roll (companions only ever grab guns from crates)
function rollLootWeapon(rng) {
  for (let i = 0; i < 8; i++) { const id = rollLoot(rng); if (id !== 'ammo' && id !== 'medkit') return id; }
  return 'pistol';
}
// swap a companion's held weapon + its visible gun model. AI cousins keep a BAG now:
// swapping away a gun that still has rounds banks it (with its count) for later, and
// they run the whole armoury down favourite-first to pistol-last before ever falling
// back to steel (see cousinNextGun). bank=false for straight trades, where the iron
// changes hands instead of going to the bag. Player-run cousins own their own count.
function setCompanionWeapon(c, id, bank = true) {
  const bag = (!c.netP && bank) ? (c.bag || (c.bag = {})) : null;
  if (bag && c.weapon && !c.weapon.melee && c.weapon.id !== id && (c.gunAmmo | 0) > 0)
    bag[c.weapon.id] = (bag[c.weapon.id] | 0) + c.gunAmmo;
  c.weapon = WEAPONS[id];
  if (c.gunMesh) c.gunMesh.removeFromParent();
  c.gunMesh = id === 'fists' ? null : buildGunMesh(id); // melee models show in their fist too
  if (c.gunMesh) c.blob.gunSocket.add(c.gunMesh);
  // ammo, tracked like the player's inventory: a banked gun comes back up with the rounds
  // it went to sleep with, a fresh one ships with a full load (mag + reserve); melee and
  // bare fists never run dry. When this hits zero the cousin draws the next gun in the bag.
  const banked = c.netP ? 0 : ((c.bag || {})[id] | 0);
  c.gunAmmo = WEAPONS[id].melee ? Infinity : (banked > 0 ? banked : WEAPONS[id].mag + WEAPONS[id].ammo);
  if (banked > 0) delete c.bag[id];
}
// the draw order when a gun runs dry: the cousin's dream iron first, then the heavy
// glass downward, the humble pistol dead last — melee only once the whole bag is dry
function cousinNextGun(c) {
  if (!c.bag) return null;
  const order = [PREF_GUN[c.data.id], 'sniper', 'magnum', 'shotgun', 'rifle', 'smg', 'pistol'];
  for (const id of order) if ((c.bag[id] | 0) > 0) return id;
  return null;
}
// a cousin's gun runs dry mid-fight: they drop the empty iron and draw their own signature
// melee (bare hands only if they somehow have none), and the squad's own loot + trade rules
// re-arm them from the next crate. (Player-run cousins keep their own count on their own
// screen — this only fires for AI ones.)
function cousinDropEmptyGun(c) {
  if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 26) play3d(c.pos.x, c.pos.z, () => SFX.dry());
  const was = c.weapon.name;
  // the bag first: every banked gun gets used up, favourites down to the pistol,
  // before the melee draw ever happens
  const next = cousinNextGun(c);
  if (next) {
    setCompanionWeapon(c, next);
    toast(`${c.data.name.toUpperCase()} EMPTIED THE ${was.toUpperCase()} .ᐟ ${WEAPONS[next].name.toUpperCase()} OUT .ᐟ`);
    return;
  }
  const mid = c.data.melee && WEAPONS[c.data.melee] ? c.data.melee : 'fists';
  setCompanionWeapon(c, mid);
  toast(mid === 'fists'
    ? `${c.data.name.toUpperCase()} EMPTIED THE ${was.toUpperCase()} .ᐟ BARE-KNUCKLE NOW .ᐟ`
    : `${c.data.name.toUpperCase()} EMPTIED THE ${was.toUpperCase()} .ᐟ ${WEAPONS[mid].name.toUpperCase()} OUT .ᐟ`);
}
// a companion opens a crate it walked up to and equips whatever gun it finds
// every cousin dreams of one specific gun; spare finds flow to whoever still swings melee
const PREF_GUN = { blingo: 'rifle', blazo: 'shotgun', blizzy: 'smg', blomba: 'magnum', bloopy: 'pistol', blondie: 'sniper' };
function armedWithGun(c) { return c.weapon && !c.weapon.melee; }
// route a freshly looted gun: the looter keeps it only while still on melee, otherwise
// it arms a melee-only squadmate (preference first), then upgrades whoever dreams of it
function distributeGun(looter, id) {
  let take = looter;
  if (armedWithGun(looter)) {
    const unarmed = companions.filter(c => c.recruited && !c.downed && !c.netP && !armedWithGun(c));
    take = unarmed.find(c => PREF_GUN[c.data.id] === id) || unarmed[0]
      || companions.find(c => c.recruited && !c.netP && PREF_GUN[c.data.id] === id && c.weapon.id !== id)
      || null;
  }
  if (take) setCompanionWeapon(take, id);
  else if (!looter.netP) {
    // every hand full and nobody dreams of it: the looter banks it — nothing found
    // ever goes to waste, it just waits its turn in the draw order
    const bag = looter.bag || (looter.bag = {});
    bag[id] = (bag[id] | 0) + WEAPONS[id].mag + WEAPONS[id].ammo;
    take = looter;
  }
  return take;
}
// armed cousins pass guns between themselves until everyone holds their preferred iron
function settleGunTrades() {
  for (const a of companions) {
    if (!a.recruited || a.netP || !armedWithGun(a) || a.weapon.id === PREF_GUN[a.data.id]) continue;
    for (const b of companions) {
      if (b === a || !b.recruited || b.netP || !armedWithGun(b)) continue;
      if (a.weapon.id === PREF_GUN[b.data.id] && b.weapon.id !== PREF_GUN[b.data.id]) {
        const aw = a.weapon.id, bw = b.weapon.id;
        setCompanionWeapon(a, bw, false); setCompanionWeapon(b, aw, false); // hands swap, bags don't
        toast(`${a.data.name.toUpperCase()} AND ${b.data.name.toUpperCase()} TRADED GUNS`);
        return; // one trade per pass keeps the toasts calm
      }
    }
  }
}
function companionLoot(c, cr) {
  cr.opened = true;
  game.cratesOpened++;
  hud.crates.textContent = game.cratesOpened;
  cr.glow.visible = false;
  cr.trim.visible = false;
  play3d(cr.pos.x, cr.pos.z, () => SFX.crate());
  const id = rollLootWeapon(Math.random);
  const who = distributeGun(c, id);
  if (who === c) toast(`${c.data.name.toUpperCase()} FOUND ${anA(WEAPONS[id].name)} ${WEAPONS[id].name.toUpperCase()}`);
  else if (who) toast(`${c.data.name.toUpperCase()} ARMED ${who.data.name.toUpperCase()} WITH ${anA(WEAPONS[id].name)} ${WEAPONS[id].name.toUpperCase()}`);
  if (who) play3d(cr.pos.x, cr.pos.z, () => SFX.swap(WEAPONS[id]));
  settleGunTrades();
}

// ---------- main loop ----------
const clock = new THREE.Clock();
let camDist = 4.9;
// lens state for the ground-cam flare (see updateCamera). lookFov is the FOV *before*
// the flare widens it, so craning at the sky never speeds the look up.
let lensStretched = false, lookFov = 70;
let nearCrate = null, nearRecruit = null;

function animate() {
  requestAnimationFrame(animate);
  stepFrame(Math.min(clock.getDelta(), 0.05));
}
// one simulated+rendered frame. Split out of animate so a frozen tab (hidden panes
// stop rAF dead) can still be driven by hand: window.__step(n) pumps n fixed-dt
// frames — the same hook the solo-multiplayer __dbg workflow leans on.
window.__step = (n = 1, fdt = 1 / 60) => { for (let i = 0; i < n; i++) stepFrame(fdt); };
function stepFrame(dt) {
  // the opening splash owns the frame until it's gone: it renders its own stage and
  // swallows the gamepad, so "any button" wakes the audio instead of clicking the
  // menu waiting underneath
  if (splash.active) splashTick(dt);
  else pollGamepad(dt);
  // the death transition: fade runs on real time, the simulation runs on an ever-smaller
  // slice of it. The floor (5%) keeps the horde chewing right up until the black lands —
  // by the time the world would visibly stop, there's nothing left to see it stop.
  if (deathFx.on) {
    deathFx.t += dt;
    const p = Math.min(deathFx.t / deathFx.dur, 1);
    deathFadeEl.style.opacity = p;
    dt *= Math.max(1 - smooth(p) * 1.2, 0.05);
    if (p >= 1) { deathFx.on = false; finishDeath(); }
  }

  // clients: the rest of the lobby (other players, zombies) keeps moving live every frame,
  // paused or not — see netClientWorldTick for why this can never grant invincibility
  if (net.role === 'client') netClientWorldTick(dt);

  if (game.state === 'playing') {
    game.time += dt;
    updateDayNight(dt);
    updatePlayer(dt);
    updateTradePact(dt);   // both roles: animate the ACCEPTED sting / fade regardless of who settled it
    if (net.role === 'client') {
      // the host owns the squad, zombies and spawner; we animate their ghosts
      netClientTick(dt);
    } else {
      updateCompanions(dt);
      updateZombies(dt);
      updateSpawner(dt);
      if (net.role === 'host') { netHostTick(dt); updateHoldTrades(dt); }
      // the lobby's last legs: host crawling, every player down, every cousin down — nobody
      // left standing to haul anyone up. That's the game over, for every screen at once.
      if (net.role === 'host' && net.conns.length && !deathFx.on && !player.dead
          && player.downed
          && companions.every(c => !c.recruited || c.downed)) die(true);
    }
    updateCrates(dt);
    updatePickups(dt);
    updateConsumables(dt); // the jelly + chili glows breathe on every screen
    updateGiant(dt);       // the chili ritual: eat, grow, reign, shrink
    updateBossFx(dt);
    updateFloodlights(dt);
    updateCrows(dt);
    updateButterflies(dt);
    updateFountain(dt);
    updateBluga(dt);       // Bluga's cameo, then his last stand — the new-game-plus overlay
    updateJelly(dt);       // grandma's beacon, ghost dance and the finale tally — every role
    updateCelebration(dt);
    const mins = Math.floor(game.time / 60), secs = Math.floor(game.time % 60);
    hud.timer.textContent = mins + ':' + String(secs).padStart(2, '0');
  }
  updateCamera(dt);
  updateHousePeek(dt); // after the camera: the sightline test needs its settled position
  updatePlayerTags(dt);
  updateFx(dt);
  updateDamageNumbers(dt);
  updateEmoteFx(dt);
  updateRain(dt);
  renderer.render(scene, camera);
}

function updatePlayer(dt) {
  if (player.dead) return;
  // look speed scales with the current FOV so zoomed aim (especially the sniper
  // scope, 22° vs 70°) turns proportionally slower and stays steady on target
  const lookDamp = lookFov / 70;
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

  // bleeding out: nobody came, so you haul yourself back up rather than drop out
  if (player.downed) {
    player.downT -= dt;
    // the GOOD JELLY working: three seconds bleeding purple, then up whole
    if (player.jellyT > 0) {
      player.jellyT -= dt;
      if (Math.random() < dt * 9) spawnParticles(player.pos.x, player.pos.y + 0.7, player.pos.z, 0x9b4dff, 3, 2.2, 0.5);
      if (player.jellyT <= 0) jellyRevive();
    }
    if (player.downed && player.downT <= 0) playerGetUp(false);
  }
  // mid-meal (eating, growing, the look-around): rooted to the spot, that's the ritual
  if (player.giantPhase === 'eat' || player.giantPhase === 'grow' || player.giantPhase === 'rise') { mx = 0; my = 0; }
  const sprinting = (keys['ShiftLeft'] || keys['ShiftRight'] || sprintToggle || input.sprintGamepad) && ml > 0.1 && !player.downed;
  // bare fists keep you light on your feet: 5% quicker stride, 10% springier jumps
  const fists = player.weapon.id === 'fists';
  // downed you can still move, but only at a drag; a chili giant covers ground like a boss
  const speed = (sprinting ? 7.26 * player.sprintMult : 4.73) * (fists ? 1.05 : 1) * (player.downed ? 0.24 : 1) * (playerGiantOn() ? 1.45 : 1);

  // camera-relative: forward = away from camera
  const sin = Math.sin(player.camYaw), cos = Math.cos(player.camYaw);
  const vx = (mx * cos + my * sin) * speed;
  const vz = (my * cos - mx * sin) * speed;

  // slide: quick low dash along current motion; jump out of it for a slide-hop boost
  if (input.slide && player.grounded && player.slideT <= 0 && ml > 0.1 && !player.downed) {
    player.slideT = 0.55;
    const l = Math.hypot(vx, vz) || 1;
    player.slideDX = vx / l; player.slideDZ = vz / l;
    SFX.slide();
    // a sprint slide is a body hitting the deck, a walking slide is a scuff
    rumble(sprinting ? 150 : 70, sprinting ? 0.85 : 0.3, sprinting ? 0.7 : 0.5);
  }
  input.slide = false;

  let mvx = vx, mvz = vz;
  // a chili giant throws its weight around: a bit more push on the slide and the slide-hop
  const gSlide = playerGiantOn() ? 1.35 : 1;
  if (player.slideT > 0) {
    player.slideT -= dt;
    const s = Math.max(player.slideT, 0) / 0.55;
    mvx += player.slideDX * 7.5 * s * gSlide;
    mvz += player.slideDZ * 7.5 * s * gSlide;
  }
  if (player.hopT > 0) { // slide-hop momentum carried through the air
    player.hopT -= dt;
    mvx += player.slideDX * 6.5 * gSlide;
    mvz += player.slideDZ * 6.5 * gSlide;
  }
  if (player.stumbleT > 0) {
    player.stumbleT -= dt;
    const s = Math.max(player.stumbleT, 0) / 0.42;
    mvx += player.stumbleX * 7 * s;
    mvz += player.stumbleZ * 7 * s;
  }
  // riding a drop kick: the dive owns your movement outright — no air steering, no
  // slide momentum on top, you go where you committed
  if (player.dropKick) {
    const sp = player.dropKickHard ? 11 : 8.5;
    mvx = player.dkX * sp; mvz = player.dkZ * sp;
  }
  let nx = player.pos.x + mvx * dt;
  let nz = player.pos.z + mvz * dt;
  [nx, nz] = resolveCollision(nx, nz, 0.45, player.pos.y);
  player.pos.x = nx; player.pos.z = nz;

  // ground = terrain or any standable top under us (crates, cars, rocks, awnings, roofs).
  // the wider STEP_UP lets us mount a graded doorway threshold or a low floor on foot,
  // the same climb the cousins and the horde get, instead of jamming on the sill
  const groundY = supportTop(player.pos.x, player.pos.z, player.pos.y, STEP_UP);
  if (input.jump && player.grounded && !player.downed) {
    const hop = player.slideT > 0;   // slide-hop: bigger jump, momentum kept
    // a chili giant leaves the ground harder — the extra height sets up bigger stomps
    player.vy = (hop ? 8.6 : 7.4) * (fists ? 1.1 : 1) * player.jumpMult * (playerGiantOn() ? 1.25 : 1);
    if (hop) { player.hopT = 0.5; player.slideT = 0; }
    player.grounded = false;
    player.squash = -0.25;
    // an armed-melee jump reads like a swing: the weapon snaps up into the same 1s
    // over-the-shoulder hold a swing leaves behind, then drifts back down after landing
    if (player.weapon.melee && player.weapon.id !== 'fists') player.meleeHoldT = 1.0;
    SFX.jump();
    rumble(sprinting ? 70 : 40, sprinting ? 0.35 : 0.15, sprinting ? 0.5 : 0.3);
  }
  input.jump = false;
  if (player.grounded) {
    // 0.15 tolerance: big enough to stick to a roof pitch sprinting downhill (no
    // micro-hops), small enough that real ledges (crates, cars) still read as edges
    if (groundY < player.pos.y - 0.15) { player.grounded = false; player.vy = 0; } // walked off an edge
    else {
      // stepping UP onto a raised surface: a short controller bump the moment the boot
      // catches the lip, scaled to how tall the step was — the going-up rumble intercept
      const rise = groundY - player.pos.y;
      if (rise > 0.18) rumble(60, 0.2 + rise * 0.5, 0.35 + rise * 0.4);
      player.pos.y = groundY;
    }
  }
  if (!player.grounded) {
    player.vy -= 20 * dt;
    player.pos.y += player.vy * dt;
    if (player.vy <= 0 && player.pos.y <= groundY) {
      if (player.vy < -4) {
        player.squash = 0.3; SFX.land();
        // scaled to how fast you came down: stepping off a kerb taps, a sprint-hop
        // or a roof drop lands with the motors buried
        const hit = clamp((-player.vy - 4) / 6, 0, 1);
        rumble(70 + hit * 110, 0.3 + hit * 0.7, 0.4 + hit * 0.5);
      }
      player.pos.y = groundY; player.vy = 0; player.grounded = true; player.hopT = 0;
    }
  }

  // the rescue beacon drags along with you, and you leave a smear behind
  if (player.downed) {
    if (player.beacon) player.beacon.position.set(player.pos.x, groundHeight(player.pos.x, player.pos.z) + BEACON_Y, player.pos.z);
    if (goreAmt() > 0.02 && ml > 0.1) {
      player.dripT -= dt;
      if (player.dripT <= 0) {
        player.dripT = 0.1 + Math.random() * 0.1;
        groundSplat(player.pos.x + (Math.random() - 0.5) * 0.3, player.pos.z + (Math.random() - 0.5) * 0.3, 0.16 + Math.random() * 0.18);
      }
    }
  }
  player.shootCd -= dt;
  player.swingT = Math.max(0, player.swingT - dt);
  if (player.meleeChopT > 0 && (player.meleeChopT -= dt) <= 0) meleeChopHit(); // the follow-through down swing
  updateDropKick(dt);   // resolves the boots, and frees you the moment you land
  const w = player.weapon;
  // touch gave up its trigger circles to auto-fire: the crosshair flaring on a target IS
  // the shot, so a thumb only ever has to steer. (aimHot is last frame's crosshair test —
  // updateFx runs after us — which at 60fps is under the reaction time it replaces.)
  // A gun with nothing left to load stays quiet rather than auto-fire: there's no thumb
  // deciding to stop, so it would dry-click at full rpm for as long as a target's in view.
  const spent = !w.melee && player.clip <= 0 && !(reserves[w.id] | 0);
  // Bullets go wherever the crosshair points, so guns open up on the flare itself. A swing
  // doesn't, and the flare is the wrong cue for it twice over: it lights for a zombie clear
  // across the block, and the third-person crosshair rides a ray angled at the ground that
  // only crosses a zombie's height around 3-5m out — past fists' 2.4m reach. Gate a swing on
  // it and the hero stands there being eaten by the one chewing his ankle. So melee takes the
  // signal that actually decides whether it lands: inside its reach and inside its arc, which
  // is all holding the attack button ever swung at. He chops at his own rpm (the arc always
  // finishes first), stops dead when nothing's in front, and picks back up on the next one to
  // close. Whatever slips around the arc to flank him is outside it, which is the trade.
  const autoTouch = input.device === 'touch' && (w.melee ? !!meleeTarget(w) : aimHot && !spent);
  const wantShoot = input.shoot || input.shootGamepad || autoTouch;
  // hold the trigger to keep firing; every weapon — full-auto, semi-auto & melee — cycles at its own rpm.
  // A live drop kick locks everything out until it lands.
  if ((wantShoot || (w.melee && input.shootPressed)) && player.shootCd <= 0 && !player.dropKick && !player.downed) {
    fireWeapon();
    player.shootCd = 60 / w.rpm;
  }
  input.shootPressed = false;

  // holding Red's bowl, the reload button IS the meal (RED'S on the touch label)
  if (input.reload) { if (player.weapon.id === 'chili') eatChili(); else tryReload(); input.reload = false; }
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) {
      const need = w.mag - player.clip;
      const take = Math.min(need, reserves[w.id] | 0);
      player.clip += take;
      reserves[w.id] -= take;
      hud.reloadmsg.style.opacity = 0;
      updateAmmoHUD();
      SFX.reloadDone(); // the response to the reload's opening call — mag's seated
    }
  }

  // interact: downed squadmates outrank crates + recruits. On a client the downed teammate
  // is an actor ghost (netNearDowned), not a companion, but it earns the same top priority —
  // so the touch interact button pops for a rescue exactly like it does over a crate.
  const nearDowned = findNearDowned();
  const nearNetDowned = (!nearDowned && net.role === 'client') ? netFindNearDowned() : null;
  const blockLower = nearDowned || nearNetDowned;
  // a chili giant never opens a crate by hand — the stomp bursts them instead (giantStomp)
  nearCrate = (blockLower || playerGiantAny()) ? null : findNearCrate();
  nearRecruit = blockLower ? null : findNearRecruit();
  // a client can sign up the streamed recruit-beacon cousins too (host owns the squad, so
  // it's a request) — treated exactly like a local recruit for prompt + priority
  let nearNetRecruit = (!blockLower && net.role === 'client') ? netFindNearRecruit() : null;
  const recruitAny = nearRecruit || nearNetRecruit;   // crate vs. whichever recruit is closer
  if (nearCrate && recruitAny) {
    const dc = Math.hypot(nearCrate.pos.x - player.pos.x, nearCrate.pos.z - player.pos.z);
    const dr = Math.hypot(recruitAny.pos.x - player.pos.x, recruitAny.pos.z - player.pos.z);
    if (dc <= dr) { nearRecruit = null; nearNetRecruit = null; } else nearCrate = null;
  }
  // the consumable stations: the jelly cluster and the chili pot, both one big loot spot
  const nearJelly = blockLower ? null : findNearJelly();
  const nearChili = blockLower ? null : findNearChili();
  // AI cousins trade freely on one tap (findNearTrade for the host, netFindNearNpcTrade for a
  // client). A player-run cousin instead lights the "hold to trade" prompt — that swap is gated
  // behind the two-sided consent pact, so no human's kit moves without their held agreement.
  // A chili giant trades with NOBODY: no skin swaps, no weapon deals, until small again.
  let nearTrade = null, nearNpcTrade = null, nearNetPlayer = null;
  if (!blockLower && !nearCrate && !nearRecruit && !nearNetRecruit && !playerGiantAny()) {
    nearTrade = findNearTrade();
    if (!nearTrade && net.role === 'client') nearNpcTrade = netFindNearNpcTrade();
    if (!nearTrade && !nearNpcTrade) nearNetPlayer = net.role === 'client' ? netFindNearPlayerAny()
                                                   : net.role === 'host'   ? findNearNetPlayer() : null;
  }
  // grandma's ghost outranks everything: at the end of the trek there is nothing else to do
  const nearGrandma = findNearGrandma();
  const showPrompt = !!(nearGrandma || nearDowned || nearNetDowned || nearCrate || nearJelly || nearChili || nearRecruit || nearNetRecruit || nearTrade || nearNpcTrade || nearNetPlayer);
  const bareHand = player.weapon.id === 'fists'; // fists out: the trade on offer is your skin
  hud.prompttxt.textContent = nearGrandma ? 'Remember Grandma Blingo'
    : nearDowned ? 'Pick up ' + nearDowned.data.name
    : nearNetDowned ? `Revive P${nearNetDowned.p} ${nearNetDowned.data.name}`
    : nearCrate ? 'Open Crate'
    : nearJelly ? 'Take the GOOD JELLY'
    : nearChili ? "Take RED'S CHILI"
    : nearRecruit ? 'Recruit ' + nearRecruit.data.name
    : nearNetRecruit ? 'Recruit ' + nearNetRecruit.data.name
    : nearTrade ? (bareHand ? `Offer skin to ${nearTrade.data.name}`
                            : `Trade for ${nearTrade.data.name}'s ${(nearTrade.weapon || WEAPONS.pistol).name}`)
    : nearNpcTrade ? `Trade for ${nearNpcTrade.name}'s ${WEAPONS[nearNpcTrade.wp] ? WEAPONS[nearNpcTrade.wp].name : 'weapon'}`
    : nearNetPlayer ? `Hold to trade with P${nearNetPlayer.p} ${nearNetPlayer.name}` : '';
  hud.prompt.classList.toggle('hidden', !showPrompt || input.device === 'touch');
  if (isTouch) hud.btnInteract.style.display = showPrompt ? 'flex' : 'none';
  if (input.interact) {
    if (nearGrandma) {
      // remembering her is host business (the squad + the gather are his); a client asks
      if (net.role === 'client') { try { net.conns[0].send({ t: 'grandmaReq' }); } catch (e) {} }
      else grandmaWake();
    }
    else if (nearDowned) reviveCousin(nearDowned);
    else if (nearNetDowned) { try { net.conns[0].send({ t: 'reviveReq', p: nearNetDowned.p }); } catch (e) {} }
    else if (nearCrate) openCrate(nearCrate);
    else if (nearJelly) lootJelly();
    else if (nearChili) lootChili();
    else if (nearRecruit) recruitCousin(nearRecruit);
    else if (nearNetRecruit) { try { net.conns[0].send({ t: 'recruitReq', c: nearNetRecruit.data.id }); } catch (e) {} }
    else if (nearTrade) tradeWeapons(nearTrade);
    else if (nearNpcTrade) { try { net.conns[0].send({ t: 'npcTradeReq', c: nearNpcTrade.c }); } catch (e) {} } // NPCs deal freely
    else if (nearNetPlayer) {
      // no one-sided grab off another human: a tap just names it — HOLDING interact is what
      // reaches out (the hold auto-fires your trade emote and fills the consent pact)
      toast('HOLD TO TRADE .ᐟ BOTH PLAYERS HOLD .ᐟ');
    }
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
  hud.healthTxt.innerHTML = Math.ceil(player.hp) + ` HP <span class="pnum">| Player ${net.playerNum || 1}</span>`;
  updateSquadBars();
  hud.vignette.style.opacity = player.hp < 40 ? (1 - player.hp / 40) * 0.9 :
    (game.time - player.lastHurtT < 0.4 && game.time > player.lastHurtT ? 0.7 : 0);

  // --- blob animation ---
  const moving = ml > 0.1;
  player.stillT = moving ? 0 : (player.stillT || 0) + dt;
  const stumbling = player.stumbleT > 0;
  player.walkPhase += dt * (moving ? (sprinting ? 13 : 9) : 2);
  player.idlePhase += dt;
  // how hard the first-person head bob is running (updateCamera rides this). Eased so it
  // never snaps on mid-stride, and dead in the air — a jump should read as a jump.
  player.bobT = lerp(player.bobT, moving && player.grounded ? (sprinting ? 1 : 0.68) : 0, 1 - Math.exp(-7 * dt));
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
  // in first person, drop the parts of our own avatar that would fill the view: the head,
  // the belly (torso ball) and the feet (both legs). The arms stay — the gun rides the gun
  // arm as the viewmodel, so it has to keep drawing. Same cheap visibility toggle the head
  // uses (the playerBodyMats opacity fade only feeds the sniper scope's b.root cutoff).
  const fpBody = player.fpvT < 0.55;
  b.head.visible = fpBody;
  b.body.visible = fpBody;
  for (const hip of b.legs) hip.visible = fpBody;
  // down the sniper scope the whole avatar melts away so it never crosses the eyepiece —
  // it fades OUT as the scope comes up (matched to the scope overlay's aimT>0.55 onset) and
  // snaps back the instant we come off the scope. The gun rides the same fade as a hard
  // visibility flip (its models are shared-material, so it can't take the opacity fade).
  {
    const hide = player.weapon.id === 'sniper' && player.aimT > 0.55 && !player.dead;
    const prev = player.scopeFadeT || 0;
    const sf = hide ? Math.min(1, prev + dt * 6) : 0;   // ~0.17s to vanish, instant to return
    player.scopeFadeT = sf;
    const fadingNow = sf > 0.001;
    if (fadingNow || player._scopeFading) {
      for (const m of playerBodyMats) {
        if (m.transparent !== fadingNow) { m.transparent = fadingNow; m.needsUpdate = true; }
        m.opacity = 1 - sf;
      }
      if (gunMesh) gunMesh.visible = sf < 0.5;
      if (b.shadow) b.shadow.visible = sf < 0.5;
      b.root.visible = sf < 0.999;   // fully gone: skip drawing the body entirely
      player._scopeFading = fadingNow;
      if (!fadingNow) { b.root.visible = true; if (gunMesh) gunMesh.visible = true; if (b.shadow) b.shadow.visible = true; }
    }
  }

  // footsteps on each half of the walk cycle — the pad ticks in time with the stride,
  // so a sprint drums twice as fast and twice as hard as a walk
  if (moving && player.grounded) {
    const ph = Math.floor(player.walkPhase / Math.PI);
    if (ph !== player.lastStepPh) {
      player.lastStepPh = ph;
      SFX.step(sprinting);
      rumble(sprinting ? 55 : 32, sprinting ? 0.34 : 0.1, sprinting ? 0.5 : 0.18);
    }
  }

  const recentShot = game.time - player.lastShotT < 2.2 && !w.melee;
  let targetYaw;
  // an airborne third-person melee press never yanks the body toward the camera: the
  // jump attack committed along the body's own facing (see meleeTargets / startDropKick),
  // so the blob holds its line instead of twisting mid-air to face the crosshair
  const bodyCommitted = w.melee && !player.grounded && !player.fpv;
  if ((recentShot || wantShoot || player.aiming) && !bodyCommitted) {
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
    // swingT drives a real arc rather than snapping the arm to a pose: -1 when idle
    const sw = player.swingT > 0 ? 1 - player.swingT / player.swingDur : -1;
    if (w.id === 'fists') {
      // fists: the chain alternates which arm throws, so the swing plays on meleeArm
      b.arms[0].rotation.x = -swing * 0.8;
      b.arms[1].rotation.x = swing * 0.8;
      if (sw >= 0) b.arms[player.meleeArm].rotation.x = meleeSwing(sw, b.arms[player.meleeArm].rotation.x, -2.5);
      else if (stumbling) { b.arms[0].rotation.x -= stumbleLean * 1.0; b.arms[1].rotation.x -= stumbleLean * 1.0; }
    } else {
      // armed melee: the WALK pose is the low carry again (tip skimming the dirt), but a
      // swing leaves its mark — the follow-through parks the weapon raised over the
      // shoulder for a beat (1s), then the arm relaxes slowly back down to the carry.
      // Rapid swinging never lets it drop: each arc re-arms the hold, so a flurry rides
      // high the whole way. The strike still whips DOWN, ending at the tip-skimming angle.
      if (player.swingT > 0) player.meleeHoldT = 1.0;                       // the post-swing hold, re-armed by every arc
      else player.meleeHoldT = Math.max(0, (player.meleeHoldT || 0) - dt);
      const raiseTo = player.swingT > 0 || player.meleeHoldT > 0 ? 1 : 0;
      const rk = raiseTo > (player.meleeRaise || 0) ? 6 : 1.6;              // snaps up with the swing, drifts down slow
      player.meleeRaise = lerp(player.meleeRaise || 0, raiseTo, 1 - Math.exp(-rk * dt));
      const bob = Math.sin(player.walkPhase) * (moving ? 0.14 : 0.04);
      const reach = gunMesh ? gunMesh.userData.reach : 0.8;
      const shoulderY = player.pos.y + (player.slideT > 0 ? 0.6 : 0.95);
      // each arm carries its own way: the hold IS the idle walk pose, and every swing
      // leaves from it and melts back into it — no shared tip-in-the-dirt carry, no
      // snap home on the last frame
      const hold = MELEE_HOLD[w.id];
      const hand = b.gunArm === 0 ? 1 : -1;
      let hx, hz;
      if (hold) { hx = hold.x + bob * 0.4 - aimAmt * 0.3; hz = hold.z * hand; }
      else {
        hx = meleeCarryLift(-0.55 - aimAmt * 1.0 + bob, shoulderY, groundHeight(player.pos.x, player.pos.z), reach);
        hz = 0;
      }
      const ready = lerp(hx, (hold ? hold.rest : MELEE_REST) + bob * 0.5, player.meleeRaise);
      const strike = meleeCarryLift(-0.35, shoulderY, groundHeight(player.pos.x, player.pos.z), reach);
      if (sw >= 0) {
        // the swing's own voice: jabs thrust straight, the pipe chops down light,
        // roundhouses sweep the arm across on rotation.z STARTING FROM THE OUTSIDE
        // (the backswing answers from the inside), diagonals slash high-to-low the
        // same way, overhead chops cock right up over the shoulder first. The bat's
        // chain runs three deep: forehand, backhand, then a full overhead finisher.
        const style = SWING_STYLE[w.id] || 'over';
        const combo = player.meleeCombo || 0;
        const beat = w.id === 'bat' ? combo % 3 : combo % 2;
        const cdir = hand * (beat === 0 ? 1 : -1);
        let sR = ready, sS = strike, sZ = hz;
        if (style === 'jab') { sR = -1.1; sS = -1.9; }
        else if (style === 'chop') {
          // the pipe strikes twice: the vertical chop leads, the second press comes
          // across on the diagonal — a vert-and-diag striker combo
          if (beat === 1) sZ = meleeSwingHome(sw, hz, -0.65 * cdir, 0.5 * cdir);
          else sR = lerp(ready, -2.2, 0.5);
        }
        else if (style === 'side') {
          if (beat === 2) { sR = lerp(ready, -2.95, 0.55); }           // the bat's finisher
          else {
            sR = lerp(ready, -1.75, 0.55); sS = -1.2;
            sZ = meleeSwingHome(sw, hz, -1.05 * cdir, 0.85 * cdir);
          }
        }
        else if (style === 'diag') { sZ = meleeSwingHome(sw, hz, -0.65 * cdir, 0.5 * cdir); }
        else sR = lerp(ready, -2.95, 0.55);
        b.arms[b.gunArm].rotation.x = meleeSwingHome(sw, ready, sR, sS);
        b.arms[b.gunArm].rotation.z = sZ;
      } else {
        b.arms[b.gunArm].rotation.x = ready;
        b.arms[b.gunArm].rotation.z = hz;
      }
      b.arms[b.offArm].rotation.x = -swing * 0.6 - aimAmt * 0.35;
      if (stumbling) { b.arms[b.gunArm].rotation.x -= stumbleLean * 0.6; b.arms[b.offArm].rotation.x -= stumbleLean * 1.0; }
    }
  } else {
    const aimPitch = Math.asin(clamp((recentShot || player.aiming) ? getAimDir(_aimDir).y : 0, -0.9, 0.9));
    b.arms[b.gunArm].rotation.x = -Math.PI / 2 - aimPitch * 0.8;
    // one-handers (pistol, magnum, smg) keep the off arm DOWN at the walk swing even
    // mid-aim — the casual sidearm carry. The long guns pull the second hand up into
    // the classic two-arm brace whenever the gun comes to bear
    b.arms[b.offArm].rotation.x = (!w.oneHand && (wantShoot || recentShot || aimAmt > 0.2)) ? b.arms[b.gunArm].rotation.x : -swing * 0.8;
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
    // airborne tuck — but never stomp on a live swing, or a jump attack reads as nothing
    // but its sound effect. Whichever arm is mid-swing keeps its arc; the rest tuck.
    const swingArm = player.swingT > 0 ? (w.id === 'fists' ? player.meleeArm : b.gunArm) : -1;
    if (swingArm !== b.offArm) b.arms[b.offArm].rotation.x = -2.4;
    // the post-swing (and now post-jump) hold outranks the tuck: a raised weapon stays
    // raised through the air instead of snapping into the generic airborne pose
    if (w.melee && swingArm !== b.gunArm && !(player.meleeHoldT > 0)) b.arms[b.gunArm].rotation.x = -2.4;
    b.legs[0].rotation.x = 0.5; b.legs[1].rotation.x = -0.3;
  }
  if (player.dropKick) {
    // drop kick: both boots thrust out front, torso cocked back behind them
    b.wob.rotation.x = -0.75;
    b.legs[0].rotation.x = -1.5; b.legs[1].rotation.x = -1.2;
    b.arms[0].rotation.x = -2.7; b.arms[1].rotation.x = -2.7;
  }
  if (player.downed) {
    // face-down crawl: chest on the dirt, hauling yourself forward one arm at a time
    // (last word on the pose, so nothing above can stand you back up)
    b.wob.rotation.x = 1.2;
    b.wob.rotation.z = 0;
    const claw = Math.sin(player.walkPhase * 1.5);
    b.arms[0].rotation.x = -2.25 + claw * 0.55;
    b.arms[1].rotation.x = -2.25 - claw * 0.55;
    b.legs[0].rotation.x = 0.3 + claw * 0.18;
    b.legs[1].rotation.x = 0.3 - claw * 0.18;
    b.head.rotation.x = -0.55;   // chin up, still looking where you're dragging to
  }
  // the chili ritual outranks everything above: eating lifts the bowl to the mouth; the
  // grow + look-around stands dead still, arms down as fists, head sweeping left and right
  if (player.giantPhase === 'eat') {
    const k = Math.min(player.giantPhT / 0.5, 1);
    b.arms[b.gunArm].rotation.x = -0.3 - k * 2.1;   // the bowl rides up to the face
    b.arms[b.offArm].rotation.x = -0.3 - k * 1.9;   // both hands on the meal
    b.head.rotation.x = -0.25 * k;                  // tipped back for the gulp
    b.legs[0].rotation.x = 0; b.legs[1].rotation.x = 0;
  } else if (player.giantPhase === 'grow' || player.giantPhase === 'rise') {
    b.arms[0].rotation.x = -0.08; b.arms[1].rotation.x = -0.08; // arms down, fists closed
    b.legs[0].rotation.x = 0; b.legs[1].rotation.x = 0;
    const lt = player.giantPhase === 'rise' ? player.giantPhT : 0;
    b.head.rotation.y = Math.sin(lt * 7) * 0.55;    // the left-and-right survey of the block
    b.head.rotation.x = 0;
  } else if (b.head.rotation.y !== 0 && !player.downed) {
    b.head.rotation.y = 0; // hand the head back to the normal animator once the ritual ends
  }

  updateChunks(player.pos.x, player.pos.z);
}

// ---------- companions ----------
const _cv = new THREE.Vector3();
// ---------- the splash melt, in-world ----------
// The opening splash blurs one cousin into the next; a teleport out here borrows that
// feel with what a mesh can actually do — every material fades to nothing where they
// stood, and fades back up at the new spot. Clones exist only for the fade; the shared
// originals come back (and the clones are disposed) the moment it lands.
function beginBlobFade(c) {
  c.tpMats = [];
  c.blob.root.traverse(o => {
    if (!o.isMesh || o.material === shadowMat) return;
    const m = o.material.clone(); m.transparent = true;
    c.tpMats.push({ mesh: o, orig: o.material, clone: m });
    o.material = m;
  });
}
function setBlobFade(c, a) {
  if (c.tpMats) for (const e of c.tpMats) if (e.mesh.material === e.clone) e.clone.opacity = a;
}
function endBlobFade(c) {
  if (!c.tpMats) return;
  for (const e of c.tpMats) { e.mesh.material = e.orig; e.clone.dispose(); }
  c.tpMats = null;
}
function updateCompanions(dt) {
  // emote squad orders run on a timer (lineup also breaks when the player fires)
  if (squadCmd.mode) {
    squadCmd.t -= dt;
    if (squadCmd.t <= 0) { squadCmd.mode = null; for (const cc of companions) cc.inCmd = false; }
  }
  // follow leaders: every AI cousin walks with whoever recruited (or last commanded) them —
  // the host by default, or any client-run cousin in the lobby. Each leader gets their own
  // little formation, slots dealt in recruit order per group; a leader who drops falls
  // everyone back to the host.
  const fYaw = playerBlob.root.rotation.y;
  const leaders = new Map();
  leaders.set(1, { x: player.pos.x, z: player.pos.z, yaw: fYaw, still: (player.stillT || 0) > 0.5 });
  for (const cc of companions) {
    if (!cc.netP || !cc.recruited) continue;
    // a client leader's "standing still" read comes off their streamed motion
    const mv = Math.hypot(cc.pos.x - (cc.leadPX ?? cc.pos.x), cc.pos.z - (cc.leadPZ ?? cc.pos.z));
    cc.leadStill = mv < dt * 0.8 + 0.005 ? (cc.leadStill || 0) + dt : 0;
    cc.leadPX = cc.pos.x; cc.leadPZ = cc.pos.z;
    leaders.set(cc.netP, { x: cc.pos.x, z: cc.pos.z, yaw: cc.yaw || 0, still: cc.leadStill > 0.5 });
  }
  // formation slots in recruit order (per leader): single-file line behind them while
  // moving, spread shoulder-to-shoulder like a firing squad once they stop
  const squad = companions.filter(c => c.recruited && !c.netP).sort((a, b) => (a.order || 0) - (b.order || 0));
  const slotCnt = new Map();
  for (const c of squad) {
    c.leadP = (c.followP && leaders.has(c.followP)) ? c.followP : 1;
    c.slotIdx = slotCnt.get(c.leadP) || 0;
    slotCnt.set(c.leadP, c.slotIdx + 1);
  }
  for (const c of squad) c.slotN = slotCnt.get(c.leadP);
  for (const c of companions) {
    const b = c.blob;
    const gy = groundHeight(c.pos.x, c.pos.z);
    // this cousin's own leader: position, facing and stillness drive their formation
    const lead = leaders.get(c.leadP || 1) || leaders.get(1);
    const bkX = -Math.sin(lead.yaw), bkZ = -Math.cos(lead.yaw); // behind the leader
    const rtX = -Math.cos(lead.yaw), rtZ = Math.sin(lead.yaw);  // the leader's right
    const still = lead.still;
    updateFlash(b, dt);
    placeShadow(b, c.pos.x, c.pos.z, c.y);
    if (!c.recruited) {
      c.y = gy;
      // if the world generated something solid on top of this waiting cousin, step clear
      c.clearT = (c.clearT || 0) - dt;
      if (c.clearT <= 0) {
        c.clearT = 1.2;
        const [nx, nz] = resolveCollision(c.pos.x, c.pos.z, 0.6, c.y);
        if (nx !== c.pos.x || nz !== c.pos.z) {
          c.pos.x = nx; c.pos.z = nz;
          if (c.beacon) c.beacon.position.set(nx, groundHeight(nx, nz) + BEACON_Y, nz);
        }
      }
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
    // a cousin claimed by another player moves by their streamed pose, not squad AI
    if (c.netP) { netPoseCompanion(c, dt); continue; }
    // downed: kneel where they fell, flashing red under a rescue beacon, until
    // someone comes and picks them up by hand
    if (c.downed) {
      if (c.tp) { endBlobFade(c); c.tp = null; } // going down mid-melt: reappear and kneel here
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
    // mid-teleport: the splash melt. Fade out where they stand, cross over, fade back in
    // at the formation slot — no walking, no fighting, just the dissolve. A tp carrying its
    // own tx/tz (the finale gather) crosses to THAT spot instead; a negative starting t is
    // a stagger delay, so the family melts out one after another instead of as one flash.
    if (c.tp) {
      c.tp.t += dt;
      const k = Math.min(Math.max(c.tp.t, 0) / 0.32, 1);
      if (c.tp.phase === 0) {
        setBlobFade(c, 1 - k);
        if (k >= 1) {
          let tx, tz;
          if (c.tp.tx !== undefined) { tx = c.tp.tx; tz = c.tp.tz; }
          else {
            const ii = c.slotIdx || 0;
            tx = lead.x + bkX * (2 + ii * 1.5); tz = lead.z + bkZ * (2 + ii * 1.5);
          }
          [tx, tz] = resolveCollision(tx, tz, 0.42);
          c.pos.x = tx; c.pos.z = tz;
          c.y = groundHeight(tx, tz); c.vy = 0; c.grounded = true;
          if (c.tp.burst) spawnParticles(tx, c.y + 1.2, tz, c.data.color, 10, 4, 0.8); // arrival sparkle
          c.tp.phase = 1; c.tp.t = 0;
        }
      } else {
        setBlobFade(c, k);
        if (k >= 1) { endBlobFade(c); c.tp = null; }
      }
      b.root.position.set(c.pos.x, c.y, c.pos.z);
      placeShadow(b, c.pos.x, c.pos.z, c.y);
      continue;
    }
    // steady regen once they've been out of a bite for a few seconds
    if (game.time - (c.lastHurtT || -9) > 5 && c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + 5 * dt);
    // seek my formation slot. A chili giant gets room: the squad hangs back about twice as
    // far (nobody walks under those boots), and they get there on their own legs — the
    // 60m teleport cheat stays off while the giant stands (see below)
    const gRoom = (c.leadP === 1 || !c.leadP) && playerGiantOn() ? 2.1 : 1;
    const i = c.slotIdx || 0, n = c.slotN || 1;
    let tx2, tz2;
    if (still) {
      const lateral = (i - (n - 1) / 2) * 1.7;
      tx2 = lead.x + bkX * 2.3 * gRoom + rtX * lateral;
      tz2 = lead.z + bkZ * 2.3 * gRoom + rtZ * lateral;
    } else {
      tx2 = lead.x + bkX * (1.8 * gRoom + i * 1.5);
      tz2 = lead.z + bkZ * (1.8 + i * 1.5);
    }
    // an emote squad order overrides the slot — but only for the cousins who were in
    // earshot when it was called (inCmd): trade line, huddle, or guard ring, anchored
    // on whoever called it (host or client)
    const cmd = c.inCmd ? squadCmd.mode : null;
    const cmdLead = leaders.get(squadCmd.p || 1) || leaders.get(1);
    if (cmd) {
      const ci = c.cmdSlot || 0, cn = squadCmd.n || 1;
      if (cmd === 'lineup') {
        // shoulder-to-shoulder row a couple metres in front of where you called it
        const fx = -Math.sin(squadCmd.ayaw), fz = -Math.cos(squadCmd.ayaw);
        const k = ci - (cn - 1) / 2;
        tx2 = squadCmd.ax + fx * 2.6 + (-fz) * k * 1.7;
        tz2 = squadCmd.az + fz * 2.6 + fx * k * 1.7;
      } else if (cmd === 'wait') {
        // tight ring on the huddle spot, everyone covering someone's back
        const a = ci * TAU / cn;
        const r = cn > 1 ? 0.95 : 0;
        tx2 = squadCmd.ax + Math.sin(a) * r;
        tz2 = squadCmd.az + Math.cos(a) * r;
      } else {
        // guard: spread across the caller's sides and back (90..270 deg off their facing)
        // and move with them
        const th = cn > 1 ? Math.PI / 2 + (ci * Math.PI) / (cn - 1) : Math.PI;
        const gYaw = squadCmd.p === 1 ? player.camYaw : cmdLead.yaw;
        const fx = -Math.sin(gYaw), fz = -Math.cos(gYaw);
        tx2 = cmdLead.x + (fx * Math.cos(th) + (-fz) * Math.sin(th)) * 2.3;
        tz2 = cmdLead.z + (fz * Math.cos(th) + fx * Math.sin(th)) * 2.3;
      }
    }
    // Blomba's brawl: with a real melee weapon he doesn't hold his slot — any walker
    // inside 14m pulls him in AT A SPRINT, the swing itself stays the ordinary one at
    // ordinary reach, and with nothing left to hit he sprints back to formation the same
    // way he left. Only while he's still in earshot of the squad (26m), and never over a
    // squad order — Wait means wait, even for the bouncer.
    let hunt = null, brawlSprint = false;
    {
      const cwM = c.weapon;
      if (persona(c).meleeBrawler && cwM && cwM.melee && cwM.id !== 'fists' && !cmd
          && Math.hypot(lead.x - c.pos.x, lead.z - c.pos.z) < 26) {
        brawlSprint = true; // the trip home is a sprint too
        let hd2 = 14;
        for (const z of zombies) {
          if (z.state !== 'chase' && z.state !== 'wake') continue;
          const dz3 = Math.hypot(z.pos.x - c.pos.x, z.pos.z - c.pos.z);
          if (dz3 < hd2) { hd2 = dz3; hunt = z; }
        }
        if (hunt) { tx2 = hunt.pos.x; tz2 = hunt.pos.z; }
      }
    }
    // buildings admit cousins through doorways, same as everyone else: inside heading
    // out (or outside heading in) they file via the nearest door gap instead of
    // grinding face-first into a wall they will never win against
    {
      const myBld = buildingAt(c.pos.x, c.pos.z);
      const tgtBld = buildingAt(tx2, tz2);
      if (myBld && myBld !== tgtBld) {
        const dr = nearestDoor(myBld, c.pos.x, c.pos.z);
        tx2 = dr.outX; tz2 = dr.outZ;
      } else if (!myBld && tgtBld) {
        const dr = nearestDoor(tgtBld, c.pos.x, c.pos.z);
        if (Math.hypot(dr.x - c.pos.x, dr.z - c.pos.z) > 1.3) { tx2 = dr.x; tz2 = dr.z; }
      }
    }
    const dx = tx2 - c.pos.x, dz = tz2 - c.pos.z;
    const dist = Math.hypot(dx, dz);
    const pd = Math.hypot(lead.x - c.pos.x, lead.z - c.pos.z);
    let moving = false;
    // teleport catch-up only when left FAR behind — 60m now, not 30, so a slide-hopping
    // cousin gets to show she can close a real gap on her own legs before the world
    // cheats for her. Never during a Wait: they were told to stay put, and stay they do.
    if (pd > 60 && cmd !== 'wait' && !playerGiantOn() && !jelly.awake) {
      // (never during the finale party: the family was gathered onto grandma's ring on
      // purpose — the catch-up must not yank anyone back out of the reunion)
      c.tp = { t: 0, phase: 0 };   // the splash-screen melt, worldside (handled above)
      beginBlobFade(c);
      continue;
    } else if (dist > (hunt ? Math.max(0.4, c.weapon.range - 0.6) : 0.4)) {   // a brawler pulls up at swinging distance, not on top of the mark
      // Blizzy (and Blondie heading home) don't jog a long gap — they drop into a slide and
      // hop out of it, the same trick the hero uses to cover ground. The slide holds while
      // there's ground to make up, then spends itself on a hop that lands near the slot.
      const pq = persona(c);
      if ((pq.slideCatchup || pq.sweeper) && c.grounded && !(c.slideT > 0) && !(c.slideCd > 0)
          && dist > (pq.slideCatchup ? 5 : 7) && !c.downed) {
        c.slideT = pq.slideCatchup ? 0.75 : 0.55;
        c.slideCd = pq.slideCatchup ? 1.5 : 3.2;
        if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 22) play3d(c.pos.x, c.pos.z, () => SFX.slide && SFX.slide());
      }
      const sliding = c.slideT > 0;
      // the brawler covers ground at a sprint both ways: closing on a mark, and hustling
      // back to his slot once the floor's been cleaned
      const sp = Math.min(sliding ? 10.5 : (hunt || (brawlSprint && dist > 6)) ? 8.2 : dist > 8 ? 7.3 : dist > 2 ? 5.4 : 2.8, dist / dt);
      const step = sp * dt;
      let nx = c.pos.x + dx / dist * step;
      let nz = c.pos.z + dz / dist * step;
      [nx, nz] = resolveCollision(nx, nz, 0.42, c.y);
      // hop over whatever is blocking the way back to the formation slot
      const movedD = Math.hypot(nx - c.pos.x, nz - c.pos.z);
      if (c.grounded && dist > 1.1 && movedD < step * 0.4) { c.vy = 7.4; c.grounded = false; }
      c.pos.x = nx; c.pos.z = nz;
      if (dist > 1) {
        c.walkPhase += dt * (sliding ? 3 : 10);
        c.yaw = Math.atan2(dx, dz);
        moving = true;
      }
    }
    // the slide's own clock: it ends in a hop, which is the whole point of sliding
    if (c.slideT > 0) {
      c.slideT -= dt;
      if (c.slideT <= 0 && c.grounded) { c.vy = 7.2; c.grounded = false; c.hopT = 0.5; }
    }
    if (c.slideCd > 0) c.slideCd -= dt;
    if (c.hopT > 0) c.hopT -= dt;
    // gravity: cousins stand on (and jump onto) the same tops we can, and mount the same
    // low steps (STEP_UP) — so a cousin files in over a doorway threshold too
    const supY = supportTop(c.pos.x, c.pos.z, c.y, STEP_UP);
    if (c.grounded) {
      if (supY < c.y - 0.05) { c.grounded = false; c.vy = 0; }
      else c.y = supY;
    }
    if (!c.grounded) {
      c.vy -= 20 * dt;
      c.y += c.vy * dt;
      if (c.vy <= 0 && c.y <= supY) { c.y = supY; c.vy = 0; c.grounded = true; }
    }
    // auto-loot: grab a gun from any crate we're standing next to. Blondie is the family
    // hoarder — her reach is wider than anyone's, and a crate that lands her a gun sends
    // her hopping back to the slot with it rather than strolling.
    const lootR = persona(c).sweeper ? 4.2 : 2.1;
    for (const cr of allCrates) {
      if (cr.opened) continue;
      if (Math.hypot(cr.pos.x - c.pos.x, cr.pos.z - c.pos.z) < lootR && Math.abs(cr.pos.y - c.y) < 2.4) {
        companionLoot(c, cr);
        if (persona(c).sweeper && c.grounded) { c.vy = 7.2; c.grounded = false; c.hopT = 0.5; }
        break;
      }
    }
    // Blondie also works the trade line herself: any squadmate inside arm's reach who is
    // still swinging melee gets handed a spare, without waiting on the player to call it
    if (persona(c).sweeper && (c.sweepCd || 0) <= 0 && armedWithGun(c)) {
      c.sweepCd = 1.4;
      for (const o of companions) {
        if (o === c || !o.recruited || o.downed || o.netP || armedWithGun(o)) continue;
        if (Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z) > 3.4) continue;
        settleGunTrades();
        break;
      }
    }
    if (c.sweepCd > 0) c.sweepCd -= dt;
    // fight: swing or shoot at the nearest zombie with whatever we're carrying.
    // a trade lineup is at-ease — no targeting, eyes on the player until it breaks
    const cw = c.weapon || WEAPONS.pistol;
    c.shootCd -= dt;
    if (c.meleeT > 0) c.meleeT -= dt;
    let tgt = null, tD = 15;
    if (cmd !== 'lineup') for (const z of zombies) {
      if (z.state !== 'chase' && z.state !== 'wake') continue; // ignore sleepers, emergers & the dormant boss
      const d = Math.hypot(z.pos.x - c.pos.x, z.pos.z - c.pos.z);
      // no locking onto a walker there's a wall in front of: eyes (and rounds) need the
      // same clear line — through a doorway or an open window is fine, through brick is
      // not. Stops the old wall-staring and point-blank drywall executions both.
      if (d < tD && companionSees(c, z, d)) { tD = d; tgt = z; }
    }
    // the greeting from recruitCousin, a beat after the toast — and Bloopy's verdict on a
    // fallen boss, on the same beat-late timer
    if (c.helloT > 0) { c.helloT -= dt; if (c.helloT <= 0) cousinEmote(c, HELLO_EMOTE); }
    if (c.niceT > 0) { c.niceT -= dt; if (c.niceT <= 0) cousinEmote(c, NICE_EMOTE); }
    if (c.luckT > 0) { c.luckT -= dt; if (c.luckT <= 0) cousinEmote(c, LUCK_EMOTE); } // Bloopy, on Blondie signing on
    // Blingo fights on his toes: with something to shoot at, he won't keep both feet down
    if (persona(c).fightHops && tgt && c.grounded && !cmd) {
      c.hopCd = (c.hopCd || 0) - dt;
      if (c.hopCd <= 0) { c.vy = 6.6; c.grounded = false; c.hopCd = 0.9 + Math.random() * 0.7; }
    }
    // an armed Blomba cannot let a crow be: no zombie needed, he'll take the shot on sight
    if (persona(c).crowShot && armedWithGun(c) && c.shootCd <= 0 && !cmd) {
      let bird = null, bD = 22;
      for (const cw2 of crows) {
        const d = Math.hypot(cw2.g.position.x - c.pos.x, cw2.g.position.z - c.pos.z);
        if (d < bD) { bD = d; bird = cw2; }
      }
      // a zombie in his face always outranks a bird — the quirk is a habit, not a death wish
      if (bird && (!tgt || tD > 6)) {
        const wantYaw = Math.atan2(bird.g.position.x - c.pos.x, bird.g.position.z - c.pos.z);
        c.yaw = wantYaw;
        const sy2 = c.y + 1.0;
        // track the bird's height with the gun arm while swinging round; hold the shot
        // until he's actually facing it — same barrel-first discipline as the squad's
        c.aimPitch = lerp(c.aimPitch || 0, Math.atan2(bird.g.position.y - sy2, bD), 1 - Math.exp(-14 * dt));
        if (Math.abs(angDiff(b.root.rotation.y, wantYaw)) < 0.12) {
          const gun = c.weapon;
          c.shootCd = 0.75 + Math.random() * 0.3;
          c.lastShotT = game.time; // recoil kick on the crow shot too
          if (c.gunMesh && c.gunMesh.userData.muzzle) c.gunMesh.userData.muzzle.getWorldPosition(_cv);
          else _cv.set(c.pos.x, sy2, c.pos.z);
          spawnTracer(_cv.clone(), bird.g.position.clone());
          relayTracerFx(gun.id, _cv, bird.g.position); // Blomba's bird-shot draws on every screen
          killCrow(bird, (bird.g.position.x - c.pos.x) / bD, (bird.g.position.z - c.pos.z) / bD, (gun.dmg || 5) * 2);
          game.lastShot.set(c.pos.x, 0, c.pos.z); game.lastShotT = game.time;
          c.gunAmmo = (c.gunAmmo ?? Infinity) - 1; // a crow round comes off the same count
          if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 24) play3d(c.pos.x, c.pos.z, () => SFX.shoot(gun));
          if ((c.gunAmmo ?? Infinity) <= 0) cousinDropEmptyGun(c);
        }
      }
    }
    // lead a moving mark a hair so the barrel tracks ACROSS it instead of trailing behind —
    // capped tight so the round still lands on the body, never out past its shoulder. Only a
    // gun leads (melee closes the gap itself); the hit still lands on the mark, this only
    // aims the swing and the tracer, so a lead never turns into a phantom miss.
    const gunAim = !!tgt && !(c.weapon || WEAPONS.pistol).melee;
    let aimX = tgt ? tgt.pos.x : 0, aimZ = tgt ? tgt.pos.z : 0;
    if (gunAim) {
      let ox = (tgt.vX || 0) * 0.14, oz = (tgt.vZ || 0) * 0.14;
      const ol = Math.hypot(ox, oz);
      if (ol > 0.6) { ox = ox / ol * 0.6; oz = oz / ol * 0.6; }
      aimX += ox; aimZ += oz;
    }
    if (tgt) c.yaw = Math.atan2(aimX - c.pos.x, aimZ - c.pos.z);
    else if (cmd === 'lineup' && !moving) c.yaw = Math.atan2(cmdLead.x - c.pos.x, cmdLead.z - c.pos.z);
    else if (cmd === 'wait' && !moving) c.yaw = Math.atan2(c.pos.x - squadCmd.ax, c.pos.z - squadCmd.az); // backs together, eyes out
    else if (cmd === 'guard' && !moving) c.yaw = Math.atan2(c.pos.x - cmdLead.x, c.pos.z - cmdLead.z); // watch the caller's flanks
    else if (still && !moving) c.yaw = lead.yaw; // stand at attention facing where the leader faces
    // real aiming: track the vertical angle to the mark (shoulder to torso) so the gun
    // arm actually points at what's being shot, and never loose a round until the body
    // has swung round to face it — the shot leaves along the barrel, not out of a hip
    // mid-turn like the old instant-fire did
    if (gunAim) {
      const aimHD = Math.hypot(aimX - c.pos.x, aimZ - c.pos.z);
      const wantP = Math.atan2((tgt.blob.root.position.y + 0.7 * tgt.scale) - (c.y + 1.0), aimHD);
      c.aimPitch = lerp(c.aimPitch || 0, wantP, 1 - Math.exp(-14 * dt));
    } else c.aimPitch = lerp(c.aimPitch || 0, 0, 1 - Math.exp(-6 * dt));
    const facingTgt = !!tgt && Math.abs(angDiff(b.root.rotation.y, c.yaw)) < 0.12;
    if (tgt && c.shootCd <= 0) {
      const kx = (tgt.pos.x - c.pos.x) / tD, kz = (tgt.pos.z - c.pos.z) / tD;
      if (cw.melee) {
        // melee cousins swing once the target shambles into reach
        if (tD < cw.range + 0.5) {
          // Blazo doesn't chop from the floor: with a real weapon in hand he leaps and brings
          // it down, and the landing hit is worth the wind-up. Fists don't earn the leap —
          // the family's hot head needs something with a head of its own to swing.
          const leap = persona(c).leapChop && cw.id !== 'fists';
          if (leap && c.grounded) { c.vy = 6.9; c.grounded = false; }
          c.shootCd = 60 / cw.rpm + 0.2;
          c.meleeT = 0.16;
          const air = leap && !c.grounded;
          // AI Blomba swings with the same hidden bouncer trait the played one has
          const brawn = c.data.id === 'blomba' ? 1.5 : 1;
          damageZombie(tgt, cw.dmg * (air ? 1.7 : 1.1) * brawn, kx, kz, air ? 4.4 : 2.2, { weapon: cw, dist: tD, isHead: false });
          if (air) meleeMoveGib(cw, tgt, kx, kz, true, c.data.id === 'blazo' || c.data.id === 'blomba'); // a leaping kill bursts the body, same as ours
          // and her kills come apart + feed her, the same vampirism the played Blomba gets
          if (brawn > 1 && tgt.state === 'dying' && !tgt.isBoss && !tgt.netGhost) {
            if (!tgt.blob.bodyGone) {
              const roll = Math.random();
              if (roll < 0.34) popHead(tgt, kx, kz);
              else if (roll < 0.67) { blowLimb(tgt, kx, kz); blowLimb(tgt, kx, kz); }
              else popChest(tgt, kx, kz);
            }
            c.hp = Math.min(c.maxHp, c.hp + (cw.id === 'fists' ? 6 : 2));
          }
          if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 24) play3d(c.pos.x, c.pos.z, () => SFX.shoot(cw));
        }
      } else if (facingTgt) {
        // ranged holds fire until the swing-round completes (facingTgt) — the round
        // leaves the instant the barrel actually crosses the mark
        c.shootCd = (cw.auto ? 0.32 : cw.id === 'shotgun' ? 0.6 : 0.7) + Math.random() * 0.15;
        c.lastShotT = game.time; // drives the recoil kick on the gun arm, below
        c.gunAmmo = (c.gunAmmo ?? Infinity) - 1; // spend a round; empties handled after the shot
        // even a cousin misses: mostly a range thing (a close mark is a sure thing, a far one
        // isn't), with a touch more spray from a full-auto gun. Capped so they still earn their keep.
        const miss = Math.random() < Math.min(0.32, 0.03 + tD * 0.011 + (cw.auto ? 0.04 : 0));
        // cousin gunfire rings out just as loud as ours: blind zombies home in on it too
        game.lastShot.set(c.pos.x, 0, c.pos.z); game.lastShotT = game.time;
        const sy = c.y + 1.0;
        const zy = tgt.blob.root.position.y + 0.7 * tgt.scale;
        // cousin bullets obey the same walls, cars and crates ours do — fired at the LED
        // aim point so the tracer tracks across a moving mark (damage still lands on it)
        let ddx = aimX - c.pos.x, ddy = zy - sy, ddz = aimZ - c.pos.z;
        const dl = Math.hypot(ddx, ddy, ddz);
        ddx /= dl; ddy /= dl; ddz /= dl;
        let tWall = rayGround(c.pos.x, sy, c.pos.z, ddx, ddy, ddz, dl + 4);
        for (const col of nearbyColliders(c.pos.x, c.pos.z)) {
          const t = rayAABB(c.pos.x, sy, c.pos.z, ddx, ddy, ddz, col);
          if (t < tWall) tWall = t;
        }
        // cousin tracers also leave the barrel tip when a gun model is in hand
        if (c.gunMesh && c.gunMesh.userData.muzzle) c.gunMesh.userData.muzzle.getWorldPosition(_cv);
        else _cv.set(c.pos.x, sy, c.pos.z);
        if (tWall < dl - 0.35) {
          // blocked: the shot smacks the obstacle instead of magically reaching the zombie
          const hx = c.pos.x + ddx * tWall, hy = sy + ddy * tWall, hz = c.pos.z + ddz * tWall;
          spawnTracer(_cv.clone(), new THREE.Vector3(hx, hy, hz));
          spawnParticles(hx, hy, hz, 0x9a9a8a, 3, 2, 0.3);
        } else if (miss) {
          // a clean miss: the rounds sail wide of the mark and hit nothing
          const shots = cw.id === 'shotgun' ? 3 : 1;
          const ma = Math.random() * TAU, mo = 0.8 + Math.random() * 1.1;
          for (let s = 0; s < shots; s++) spawnTracer(_cv.clone(), new THREE.Vector3(aimX + Math.cos(ma) * mo + (Math.random() - 0.5) * s, zy + (Math.random() - 0.5) * 0.5, aimZ + Math.sin(ma) * mo + (Math.random() - 0.5) * s));
        } else {
          const shots = cw.id === 'shotgun' ? 3 : 1;
          for (let s = 0; s < shots; s++) spawnTracer(_cv.clone(), new THREE.Vector3(aimX + (Math.random() - 0.5) * s, zy, aimZ + (Math.random() - 0.5) * s));
          damageZombie(tgt, (cw.dmg || 5) * 1.25 * shots * rangeFactor(cw, tD), kx, kz, 1, { weapon: cw, dist: tD, isHead: false });
        }
        if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 24) play3d(c.pos.x, c.pos.z, () => SFX.shoot(cw));
        if ((c.gunAmmo ?? Infinity) <= 0) cousinDropEmptyGun(c); // out of ammo: drop the empty gun
      }
    }
    b.root.position.set(c.pos.x, c.y, c.pos.z);
    b.root.rotation.y = angLerp(b.root.rotation.y, c.yaw, 1 - Math.exp(-10 * dt));
    const swing = Math.sin(c.walkPhase) * (moving ? 0.8 : 0.05);
    b.legs[0].rotation.x = swing;
    b.legs[1].rotation.x = -swing;
    b.arms[b.offArm].rotation.x = -swing * 0.7;
    // guns point where the shots go: level in the carry, pitched up/down the aim angle
    // while a mark is tracked (same 0.8 arm-lag the hero's own aim uses), plus the same
    // 0.35 recoil snap the hero gets for ~0.09s after a shot; melee walks in the low
    // carry, buries the blade at the dirt on a swing, rides high for a beat after it,
    // then relaxes back down — same as the hero
    if (!cw.melee) {
      b.arms[b.gunArm].rotation.x = -Math.PI / 2 - (c.aimPitch || 0) * 0.8;
      if (game.time - (c.lastShotT || -9) < 0.09) b.arms[b.gunArm].rotation.x += 0.35;
    }
    else {
      if (c.meleeT > 0) c.meleeHoldT = 1;
      else c.meleeHoldT = Math.max(0, (c.meleeHoldT || 0) - dt);
      const reach = c.gunMesh ? c.gunMesh.userData.reach : 0.8;
      // the straight-out carries (MELEE_HOLD) ride exactly like the hero's — same idle
      // pitch, same raised park after a swing; the rest drag low
      const npcHold = MELEE_HOLD[cw.id];
      const target = c.meleeT > 0
        ? meleeCarryLift(-0.35, (c.y || 0) + 0.95, groundHeight(c.pos.x, c.pos.z), reach)
        : c.meleeHoldT > 0 ? (npcHold ? npcHold.rest : MELEE_REST)
        : npcHold ? npcHold.x + Math.sin(c.walkPhase) * (moving ? 0.1 : 0.03)
        : meleeCarryLift(-0.55 + Math.sin(c.walkPhase) * (moving ? 0.14 : 0.04), (c.y || 0) + 0.95, groundHeight(c.pos.x, c.pos.z), reach);
      const k = 1 - Math.exp(-(c.meleeT > 0 ? 14 : c.meleeHoldT > 0 ? 8 : 1.6) * dt);
      b.arms[b.gunArm].rotation.x = lerp(b.arms[b.gunArm].rotation.x, target, k);
    }
    if (!c.grounded) { b.legs[0].rotation.x = 0.5; b.legs[1].rotation.x = -0.3; b.arms[b.offArm].rotation.x = -2.4; }
    // a slide has to LOOK like one from across the street: down on one hip, legs tucked
    // ahead, trailing arm out for balance — otherwise it just reads as gliding fast
    if (c.slideT > 0 && c.grounded) {
      b.wob.rotation.x = 0.85;
      b.legs[0].rotation.x = -1.15; b.legs[1].rotation.x = -0.75;
      b.arms[b.offArm].rotation.x = -1.9;
    } else b.wob.rotation.x = 0;
    const wob = moving ? Math.sin(c.walkPhase * 2) * 0.04 : Math.sin(performance.now() * 0.002) * 0.015;
    b.wob.scale.set(1 + wob, 1 - wob, 1 + wob);
  }
}

// ---------- zombies ----------
// teeth obey walls: the mouth-to-target line must be clear of solid geometry — a wall
// segment, a car body, a crate is enough to keep a bite on its own side. Roofs test on
// their true pitch (like bullets do) so a lunge under an awning isn't eaten by the
// bounding box that errs large.
function biteBlocked(z, tx, ty, tz) {
  const oy = z.blob.root.position.y + 1.0 * z.scale;
  let dx = tx - z.pos.x, dy = ty - oy, dz2 = tz - z.pos.z;
  const dl = Math.hypot(dx, dy, dz2) || 1;
  dx /= dl; dy /= dl; dz2 /= dl;
  for (const c of nearbyColliders(z.pos.x, z.pos.z)) {
    const t = c.roof ? rayRoof(z.pos.x, oy, z.pos.z, dx, dy, dz2, c)
                     : rayAABB(z.pos.x, oy, z.pos.z, dx, dy, dz2, c);
    if (t < dl - 0.15) return true;
  }
  return false;
}
// a cousin's line of sight to a walker: same ray the bite uses, eye height to torso.
// Point blank skips the test — at arm's length the wall question has answered itself.
function companionSees(c, z, d) {
  if (d < 2.2) return true;
  const sy = c.y + 1.0;
  const zy = z.blob.root.position.y + 0.7 * z.scale;
  let dx = z.pos.x - c.pos.x, dy = zy - sy, dz2 = z.pos.z - c.pos.z;
  const dl = Math.hypot(dx, dy, dz2) || 1;
  dx /= dl; dy /= dl; dz2 /= dl;
  for (const col of nearbyColliders(c.pos.x, c.pos.z)) {
    const t = col.roof ? rayRoof(c.pos.x, sy, c.pos.z, dx, dy, dz2, col)
                       : rayAABB(c.pos.x, sy, c.pos.z, dx, dy, dz2, col);
    if (t < dl - 0.35) return false;
  }
  return true;
}
// standing down in a truck bed, the tub is armour: nothing on the ground gets its teeth
// over those walls. Matches the collider flagged `bed` in makeCar (upright trucks only).
function inTruckBed(px, pz, py) {
  for (const c of nearbyColliders(px, pz)) {
    if (!c.bed || Math.abs(py - c.y1) > 0.35) continue;
    let lx = px - c.x, lz = pz - c.z;
    if (c.rot) { const cs = Math.cos(c.rot), sn = Math.sin(c.rot); const t = lx * cs - lz * sn; lz = lx * sn + lz * cs; lx = t; }
    if (Math.abs(lx) < c.hw && Math.abs(lz) < c.hd) return true;
  }
  return false;
}
// ---------- zombie head-animation pool ----------
// zombie mouths are built box(0.2, 0.1, 0.05) at head-local y -0.16; the gape grows that
// box downward (top edge stays put) and trembles, so it reads as a jaw dropping open
const ZMOUTH_BASE_Y = -0.16, ZMOUTH_BASE_SY = 0.1;
function pickHeadAnim(z, engaging) {
  const r = Math.random();
  // the Rotten One's head never sits still: he leans hard into the gapes and twitches —
  // the jaw working constantly, the neck jerking — which also swings the hanging eye
  if (z.isBoss4 && r < 0.45) return { type: 'gape', t: 0, dur: 0.8 + Math.random() * 0.9 };
  // straight-brow walkers gape now and then — the jaw sagging open, trembling, then shut
  if (!z.droopy && r < (engaging ? 0.3 : 0.16)) return { type: 'gape', t: 0, dur: 1.1 + Math.random() * 1.4 };
  if (r < 0.5) return { type: 'twitch', t: 0, dur: 0.22 + Math.random() * 0.12 }; // a single sharp neck jerk
  if (r < 0.82) return { type: 'shake', t: 0, dur: 0.4 };                          // a fast flurry of them
  return { type: 'double', t: 0, dur: 0.6 };                                       // a look-away double-take
}
// the rot's living dressings, host walkers and client ghosts alike: the tucked heart
// pumps (harder and larger on the boss's open chest), and the hanging eye swings on its
// stalk with the body's own motion
function animateRotGore(z, b) {
  if (b.rotHeart) {
    const beat = 1 + Math.max(0, Math.sin(performance.now() * 0.009 + (z.walkPhase || 0))) * 0.3;
    b.rotHeart.scale.setScalar(b.rotHeartR * beat);
  }
  if (b.hangEye) {
    const wp = z.walkPhase || 0;
    b.hangEye.rotation.z = Math.sin(wp * 1.7) * 0.3;
    b.hangEye.rotation.x = Math.sin(wp * 1.3 + 1) * 0.2;
  }
}
// drive one zombie's head/mouth for the frame: run the current pool animation (or, when idle,
// roll for the next). Damaged and actively-lunging walkers pull from it constantly so they
// never hold a dead stare; blind ones snap a double-take the instant they repath.
function runHeadAnim(z, b, dt, engaging) {
  const head = b.head, mouth = b.mouth;
  if (z.blind && z.repathed) { z.repathed = false; z.headAnim = { type: 'double', t: 0, dur: 0.6 }; z.headT = 1.4 + Math.random() * 2; }
  let rx = 0, ry = 0, rz = 0, grow = 0;
  const a = z.headAnim;
  if (a) {
    a.t += dt;
    const p = a.t / a.dur, e = 1 - p;
    if (a.type === 'twitch') { ry = Math.sin(a.t * 46) * 0.14 * e; rx = Math.sin(a.t * 40) * 0.07 * e; }
    else if (a.type === 'shake') { ry = Math.sin(a.t * 30) * 0.22 * e; rz = Math.cos(a.t * 30) * 0.06 * e; }
    else if (a.type === 'double') { ry = Math.sin(p * Math.PI) * (p < 0.5 ? 0.5 : -0.28); rx = Math.sin(p * Math.PI) * 0.08; }
    else if (a.type === 'gape') {
      const openAmt = Math.min(a.t / 0.35, (a.dur - a.t) / 0.3, 1); // ease open, hold, ease shut
      grow = Math.max(openAmt, 0) * (1.6 + Math.sin(a.t * 22) * 0.28); // gape + a size tremble
      ry = Math.sin(a.t * 17) * 0.05 * Math.max(openAmt, 0);          // a neck twitch riding it
    }
    if (a.t >= a.dur) z.headAnim = null;
  } else if (!z.isBoss || z.isBoss4) {
    // bosses hold a dead stare — except the Rotten One, whose head and jaw never stop:
    // he rolls from the pool constantly, on the shortest cooldowns in the game
    z.headT -= dt;
    if (z.headT <= 0) {
      if (z.isBoss4) { z.headAnim = pickHeadAnim(z, engaging); z.headT = 0.2 + Math.random() * 0.45; }
      else {
        const wants = z.bleeding || engaging || (!z.droopy && Math.random() < 0.7);
        if (wants) { z.headAnim = pickHeadAnim(z, engaging); z.headT = (engaging ? 0.45 : z.bleeding ? 1.0 : 2.0) + Math.random() * (engaging ? 0.6 : 2); }
        else z.headT = 1.5 + Math.random() * 2.5;
      }
    }
  }
  head.rotation.x = rx;
  head.rotation.y = ry;
  head.rotation.z = Math.sin(z.walkPhase * 0.5) * 0.18 + rz; // keep the base walk head-sway
  if (mouth) {
    const sy = ZMOUTH_BASE_SY * (1 + grow);
    mouth.scale.y = sy;
    mouth.position.y = ZMOUTH_BASE_Y - (sy - ZMOUTH_BASE_SY) / 2; // grow the LOWER edge; top stays put
  }
}
function updateZombies(dt) {
  // the endgame of a clear-the-block hunt: <=10 to go marks every straggler (chevron via
  // trackedActors, ground ring here)
  const huntFinal = game.cleanup && game.clearTarget > 0 && (game.clearTarget - game.kills) <= 10;
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    const b = z.blob;
    // where it was before this frame moved it — the squad's gunners lead its motion off
    // the smoothed velocity we derive from this (vX/vZ), computed at the bottom of the loop
    const _vpx = z.pos.x, _vpz = z.pos.z;
    updateFlash(b, dt);
    // the hunt's last ten also earn the guard ring underfoot (ground circle only), the
    // same read the shield guards wear — makes the stragglers pop at street level
    if (huntFinal && !z.isBoss && !z.fbi && !b.guardGlow && z.state !== 'dying') {
      const gl = makeLootGlow(0x3ae06a, { r: 0.85, y: 2.1, s: 1.5 });
      gl.userData.glow.orb.visible = false;
      b.root.add(gl); b.guardGlow = gl;
    }
    // a shield guard's glow breathes while it stands and dies with it
    if (b.guardGlow) {
      if (z.state === 'dying') b.guardGlow.visible = false;
      else animateLootGlow(b.guardGlow, game.time + (z.walkPhase || 0));
    }
    // knockback rides on after the hit, corpses included — walls still stop a body
    if (z.kvx || z.kvz) {
      const [kx2, kz2] = resolveCollision(z.pos.x + z.kvx * dt, z.pos.z + z.kvz * dt, 0.4 * z.scale, b.root.position.y);
      z.pos.x = kx2; z.pos.z = kz2;
      const decay = Math.exp(-6 * dt);
      z.kvx *= decay; z.kvz *= decay;
      if (Math.hypot(z.kvx, z.kvz) < 0.08) { z.kvx = 0; z.kvz = 0; }
    }
    if (z.state === 'dying') {
      z.deadT += dt;
      // the corpse follows its knockback out; the alive branch owns this the rest of the time
      b.root.position.x = z.pos.x; b.root.position.z = z.pos.z;
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
    // the leash scales with the live fog line, so a zombie only ever winks out well
    // inside the haze — never in front of you on a clear long-draw day. In a lobby it's the
    // NEAREST player that holds the leash, not just the host, so a client roaming off on
    // their own keeps their horde instead of watching it despawn around them.
    if (nearestPlayerDist(z.pos.x, z.pos.z) > scene.fog.far + (z.farBorn ? 46 : 26) && !z.isBoss && !z.fbi) { scene.remove(b.root); if (b.shadow) scene.remove(b.shadow); zombies.splice(i, 1); continue; }

    // black-ops blobs run their own AI (aim + shoot), not the bite loop below
    if (z.fbi) { updateFbi(z, dt); continue; }

    // boss: sleeps by the bank until approached, then sends waves at damage thresholds
    if (z.isBoss) {
      updateBossState(z);
      if (z.state === 'dormant') {
        b.root.position.set(z.pos.x, groundHeight(z.pos.x, z.pos.z), z.pos.z);
        b.root.rotation.y = z.yaw;
        b.wob.scale.y = 1 + Math.sin(performance.now() * 0.001) * 0.03;
        placeShadow(b, z.pos.x, z.pos.z);
        continue;
      }
      // no auto invuln blink any more: the boss only flashes green when a shot actually
      // lands on him while shielded (damageZombie / netClientShot)
      // the shielded boss glows in his own colours; the glow drains off as the last
      // guard drops, so "he's open" reads from clear across the fight
      if (b.bossGlow) {
        const u = b.bossGlow.userData.glow;
        u.mul = lerp(u.mul, bossShielded() ? 1 : 0, 1 - Math.exp(-4 * dt));
        animateLootGlow(b.bossGlow, game.time);
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
      if (nearestPlayerDist(z.pos.x, z.pos.z) < 24) { z.state = 'wake'; z.emergeT = 0; } // any player walking up wakes it, not only the host
      continue;
    }
    // an already-dead carcass: lies where it fell and never gets up. Crows feed on it and
    // shots dismember it (and still count as kills). Being static, a pecker can finish its
    // full turn on one — which is the whole point of them. Until the Rotten One rises:
    // his sickness stirs every laying body on the block, and a carcass you stroll past
    // peels itself up off the pavement and joins the horde (crows flush the moment it stirs)
    if (z.state === 'corpse') {
      const gy = groundHeight(z.pos.x, z.pos.z);
      b.root.position.set(z.pos.x, gy + 0.05, z.pos.z);
      b.root.rotation.x = -1.45;
      placeShadow(b, z.pos.x, z.pos.z);
      if (rotOnBlock() && nearestPlayerDist(z.pos.x, z.pos.z) < 24) {
        z.state = 'wake'; z.emergeT = 0;
        // rotten and half-eaten, it rises on what's left — less than a fresh walker
        z.hp = Math.max(z.hp, (7 + Math.random() * 5) * z.scale);
      }
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
    let tx, tz, ty = 0, hasTarget = true, tgtC = null, wander = false;
    if (z.blind) {
      const heard = game.time - game.lastShotT < 14 && game.lastShotT > z.shotIgnoreT;
      if (heard) {
        tx = game.lastShot.x; tz = game.lastShot.z;
        // reached where the bang came from and found nothing: shrug, wander off again
        if (Math.hypot(tx - z.pos.x, tz - z.pos.z) < 2.2) { z.shotIgnoreT = game.lastShotT; wander = true; }
      } else wander = true;
      if (wander) {
        z.wanderT -= dt;
        // fresh bearing = a repath: the blind one snaps its head around in a double-take,
        // reading a room it can't see (runHeadAnim jumps the queue on this flag)
        if (z.wanderT <= 0) { z.wanderT = 2.5 + Math.random() * 4; z.wanderYaw = Math.random() * TAU; z.repathed = true; }
        tx = z.pos.x + Math.sin(z.wanderYaw) * 6;
        tz = z.pos.z + Math.cos(z.wanderYaw) * 6;
      }
    } else {
      tx = player.pos.x; tz = player.pos.z; ty = player.pos.y;
      // a downed hero (host or cousin) drops off the menu: nothing left to bite there while
      // they bleed, so the horde peels off to the NEXT closest one still standing rather than
      // piling uselessly on a body
      let tDist = (player.dead || player.downed) ? Infinity : pDist;
      for (const c of companions) {
        if (c.downed) continue;
        // with the hero off the menu the unrecruited cousins go ON it: the horde drifts to
        // whichever blob is still standing and menaces them instead of freezing where they
        // lost you. Teeth never find purchase on an immune cousin anyway — hurtCompanion
        // refuses to land on anyone not yet recruited, so the gathering is all theatre
        if (!c.recruited && !(player.dead || player.downed)) continue;
        const d = Math.hypot(c.pos.x - z.pos.x, c.pos.z - z.pos.z);
        if (d < tDist) { tDist = d; tx = c.pos.x; tz = c.pos.z; ty = c.y || 0; tgtC = c; }
      }
      if (tDist === Infinity) hasTarget = false;
    }
    // how far the actual prey is, kept clear of the door/surround detour below — a zombie
    // pressed against a wall it can't get past is "close" for the sake of the idle claw-wave
    const preyDist = hasTarget ? Math.hypot(tx - z.pos.x, tz - z.pos.z) : Infinity;
    // houses only admit zombies through the door: prey holed up inside pulls them to the
    // doorway first and they now climb the threshold and file all the way in (the step-up
    // below). A zombie left inside an empty house files back out the door to repath. But
    // prey up ON the roof — out of reach through any door — draws the horde to ring the
    // building's walls instead of pouring uselessly inside.
    let surrounding = false;
    if (!z.isBoss && hasTarget) {
      const myBld = buildingAt(z.pos.x, z.pos.z);
      const tgtBld = buildingAt(tx, tz);
      if (myBld && myBld !== tgtBld) {
        const dr = nearestDoor(myBld, z.pos.x, z.pos.z);
        tx = dr.outX; tz = dr.outZ;
      } else if (!myBld && tgtBld) {
        if (onRoofOf(tgtBld, ty)) {
          [tx, tz] = surroundPoint(tgtBld, z.pos.x, z.pos.z); // ring the walls, don't flood in
          surrounding = true;
        } else {
          const dr = nearestDoor(tgtBld, z.pos.x, z.pos.z); // enter by the door on YOUR side
          const dd = Math.hypot(dr.x - z.pos.x, dr.z - z.pos.z);
          // line up on the gap from range, then AIM A STEP INSIDE it so the walker commits
          // across the threshold — targeting the threshold itself stalled them ~1.5m short,
          // since movement halts at dist<1.5 and they never actually reached the door
          if (dd > 2.2) { tx = dr.x; tz = dr.z; }
          else {
            const toCx = tgtBld.x - dr.x, toCz = tgtBld.z - dr.z, cl = Math.hypot(toCx, toCz) || 1;
            tx = dr.x + toCx / cl * 1.8; tz = dr.z + toCz / cl * 1.8;
          }
        }
      }
    }
    const dx = tx - z.pos.x, dz = tz - z.pos.z;
    const dist = hasTarget ? Math.hypot(dx, dz) : Infinity;

    z.groanT -= dt;
    if (z.groanT < 0) { z.groanT = 4 + Math.random() * 7; if (pDist < 26) play3d(z.pos.x, z.pos.z, () => SFX.groan()); }

    if (z.isBoss && z.dashT > 0) z.dashT -= dt;
    z.blocked = false;
    // ringing a rooftop, close right up to the wall face; otherwise pull up at bite range
    const stopDist = surrounding ? 0.6 : 1.5;
    if (dist > stopDist && dist < Infinity) {
      const sp = z.speed * (dist < 3 ? 1.25 : 1) * (wander ? 0.45 : 1) * (z.isBoss && z.dashT > 0 ? 5 : 1);
      const ox = z.pos.x, oz = z.pos.z;
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
      // wanted to move but a wall/press ate most of it: it's jammed as close as it can get
      z.blocked = Math.hypot(nx - ox, nz - oz) < sp * dt * 0.34;
      z.walkPhase += dt * z.speed * 3.2;
      // shuffling footsteps (3D, throttled by distance)
      z.stepT -= dt * z.speed;
      if (z.stepT <= 0) { z.stepT = 0.55; if (pDist < 22) play3d(z.pos.x, z.pos.z, () => SFX.step(false)); }
    }
    // engaging: right on top of the prey, between lunges — it leans in clawing (and its head
    // works, below) instead of walking up and freezing dead until the bite timer comes round
    const engaging = !z.isBoss && preyDist < 2.2 && z.attackT < 0.55;
    // idle claw-wave: near the prey (a wall between them, pressed as tight as the horde will
    // let it, ringing a rooftop, or leaning in for a bite) but not closing — reach and paw
    // instead of standing frozen. reachT ramps the pose in/out so it never snaps on
    const reaching = !z.isBoss && z.attackT < 0.5 &&
      (surrounding || engaging || ((z.blocked || (dist <= 1.6 && preyDist > 1.9)) && preyDist < 7));
    z.reachT = clamp((z.reachT || 0) + (reaching ? 1 : -1) * dt * 4, 0, 1);
    if (z.reachT > 0.01) z.clawPhase = (z.clawPhase || 0) + dt * 6;
    z.attackT -= dt;
    // bite whoever is actually within reach — player first, else the cousin it's chasing.
    // vertical reach matters too: perched on a roof/awning above them means no bites from below
    if (z.attackT <= 0) {
      const reach = z.isBoss ? 3.4 : 1.7;
      const vReach = z.isBoss ? 2.4 : 1.25;
      // no biting through house walls: both parties must be in the same room (or both
      // outside) — AND the actual mouth-to-target line must be clear. The room test alone
      // let teeth reach through outdoor walls, fences and car bodies; now any solid
      // between the two stops the bite exactly like it stops a bullet. A rider standing
      // down in a truck bed is off the menu entirely.
      const sameRoom = z.isBoss || buildingAt(z.pos.x, z.pos.z) === buildingAt(player.pos.x, player.pos.z);
      if (!player.dead && sameRoom && pDist < reach && player.pos.y - b.root.position.y < vReach
          && !inTruckBed(player.pos.x, player.pos.z, player.pos.y)
          && !biteBlocked(z, player.pos.x, player.pos.y + 1, player.pos.z)) {
        z.attackT = z.isBoss ? 1.1 : 0.9;
        // very rarely a walker with both arms still on throws a haymaker instead of a bite:
        // a telegraphed arm-thrust (punchT drives it in the animator) and a harder shove
        // a street walker gnawing on a chili giant finds 1hp of purchase; a boss still
        // gets a real bite in on a giant, just half as hard as he'd bite the small you
        const giantSoak = playerGiantOn() && !z.isBoss;
        const giantBossHalf = z.isBoss && playerGiantOn() ? 0.5 : 1;
        if (!z.isBoss && !b.armGone[0] && !b.armGone[1] && Math.random() < 0.05) {
          z.punchT = 0.34;
          hurtPlayer(giantSoak ? 1 : (8 + Math.random() * 5) * (z.biteMult || 1), player.pos.x - z.pos.x, player.pos.z - z.pos.z);
          player.stumbleT = 0.6; // knocked back a step harder than a bite
        } else {
          hurtPlayer(giantSoak ? 1 : (z.isBoss ? 26 + Math.random() * 12 : 9 + Math.random() * 6) * giantBossHalf * (z.biteMult || 1), player.pos.x - z.pos.x, player.pos.z - z.pos.z);
        }
      } else if (tgtC && !tgtC.downed && (tgtC.y || 0) - b.root.position.y < vReach) {
        const cd = Math.hypot(tgtC.pos.x - z.pos.x, tgtC.pos.z - z.pos.z);
        if (cd < (z.isBoss ? 3.2 : 1.6) && !biteBlocked(z, tgtC.pos.x, (tgtC.y || 0) + 1, tgtC.pos.z)) {
          // a client riding the chili: street teeth find the same 1hp on their giant too,
          // and a boss halves against their giant the same way it halves against ours
          const cIsGiant = (tgtC.netGs || 1) > 1.02;
          const cGiant = cIsGiant && !z.isBoss;
          const cBossHalf = cIsGiant && z.isBoss ? 0.5 : 1;
          z.attackT = z.isBoss ? 1.1 : 0.9; hurtCompanion(tgtC, cGiant ? 1 : (z.isBoss ? 22 : 7 + Math.random() * 5) * cBossHalf * (z.biteMult || 1));
        }
      }
    }

    if (dist < Infinity) z.yaw = angLerp(z.yaw, Math.atan2(dx, dz), 1 - Math.exp(-6 * dt));
    // vertical: normal walkers ride a standable top with a step-up + gravity, so a graded
    // doorway threshold or a low floor lifts them IN instead of walling them out at the door
    // — and they drop off an edge rather than moon-walk in the air. Bosses keep to the dirt:
    // they never path indoors and their bulk has no business riding crates.
    let feetY = groundHeight(z.pos.x, z.pos.z);
    if (!z.isBoss) {
      const supY = supportTop(z.pos.x, z.pos.z, z.feetY, STEP_UP);
      if (z.grounded) {
        if (supY < z.feetY - 0.1) { z.grounded = false; z.vy = 0; } // walked off a ledge
        else z.feetY = supY;                                        // ride terrain / step up
      }
      if (!z.grounded) {
        z.vy -= 20 * dt;
        z.feetY += z.vy * dt;
        if (z.vy <= 0 && z.feetY <= supY) { z.feetY = supY; z.vy = 0; z.grounded = true; }
      }
      feetY = z.feetY;
    }
    if (z.punchT > 0) z.punchT -= dt;
    b.root.position.set(z.pos.x, feetY, z.pos.z);
    b.root.rotation.y = z.yaw;
    placeShadow(b, z.pos.x, z.pos.z, feetY);

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
    // arms: the usual shamble, cross-faded into a raised clawing wave when it's stuck
    // reaching for prey it can't quite touch, so it never just stands there frozen
    const rr = z.reachT || 0;
    let a0 = -1.4 + sw * 0.25, a1 = -1.4 - sw * 0.25;
    if (rr > 0.01) {
      const cp = z.clawPhase || 0;
      const claw0 = -2.5 + Math.sin(cp) * 0.55;             // arms up, alternately grasping
      const claw1 = -2.5 + Math.sin(cp + Math.PI) * 0.55;
      a0 = a0 * (1 - rr) + claw0 * rr;
      a1 = a1 * (1 - rr) + claw1 * rr;
    }
    // a punch drives the near arm out in a hard thrust that eases back over its window
    if (z.punchT > 0) a0 = -Math.PI / 2 - (1 - z.punchT / 0.34) * 0.6;
    b.arms[0].rotation.x = a0;
    b.arms[1].rotation.x = a1;
    const lunge = z.attackT > 0.62 ? (z.attackT - 0.62) * 3 : 0;
    b.wob.rotation.x = 0.15 + lunge * 0.9;
    const wobble = sw * 0.05;
    b.wob.scale.set(1 + wobble, 1 - wobble, 1 + wobble);
    // head + jaw: twitches, double-takes and gapes off the pool (keeps the base walk-sway)
    runHeadAnim(z, b, dt, engaging);
    animateRotGore(z, b);
    // smoothed ground velocity (only chase walkers reach here) — what the gunners lead
    const inv = 1 / Math.max(dt, 0.001);
    z.vX = lerp(z.vX || 0, (z.pos.x - _vpx) * inv, 0.25);
    z.vZ = lerp(z.vZ || 0, (z.pos.z - _vpz) * inv, 0.25);
  }
}

// how far the closest person actually playing is: the local hero, or a cousin somebody else
// is driving. AI cousins never count — they only ever trail the hero, so they'd report his
// position back and let him wake things he's nowhere near.
function nearestPlayerDist(x, z) {
  let best = Math.hypot(player.pos.x - x, player.pos.z - z);
  for (const c of companions) if (c.netP) best = Math.min(best, Math.hypot(c.pos.x - x, c.pos.z - z));
  return best;
}
// where a fresh street spawn rings in — any human in the run is fair game, not just the host,
// so a client wandering off on their own still draws a horde of their own rather than an empty
// map. AI cousins ride the host's formation, so anchoring on the humans already covers them.
function spawnAnchor() {
  const anchors = [player.pos];
  for (const c of companions) if (c.netP && !c.downed) anchors.push(c.pos);
  return anchors[(Math.random() * anchors.length) | 0];
}
// step inside this of the churchyard and its ground starts giving up its dead (he wakes at 18)
const CHURCHYARD_NEAR = 42;
// The Crimson One asleep at the church, block already scoured: his ground is the only thing
// left in town still turning. Nothing spawns anywhere while nobody's near it.
function churchyardVigil() {
  const b = bossState.boss;
  return bossState.spawned2 && !bossState.defeated2 && !!b && b.isBoss2 && b.state === 'dormant';
}
function updateSpawner(dt) {
  // jelly.awake: grandma's tally is running — spawns stay cut for the rest of this
  // run/seed, so the celebration at the old jelly house is a safe one
  if (game.time < 15 || settings.zombieSpawn <= 0 || game.celebrateT > 0 || jelly.awake) return;
  game.spawnT -= dt;
  // cleanup phase after the boss falls: never spawn past the clear target, so the last
  // stragglers can be hunted down to exactly the next hundred
  if (game.cleanup) {
    const alive = zombies.reduce((n, zz) => n + (zz.state !== 'dying' ? 1 : 0), 0);
    if (game.kills + alive >= game.clearTarget) return;
  }
  // Scoured block, Crimson One still sleeping: the streets stay empty. Walk up on his
  // churchyard and it starts handing them back — out of the mounds, never out of the town,
  // so it reads as the one wound the infection was always leaking from. Walk away and the
  // block is clean again. Wake him and the whole map floods as before, until he falls.
  const vigil = churchyardVigil();
  if (vigil && nearestPlayerDist(CHURCHYARD.x, CHURCHYARD.z) > CHURCHYARD_NEAR) return;
  // Extra Gore maxed swells the whole horde by a fifth — a denser cap and a faster clock —
  // and salts the street spawns with green horned brutes (the Infected One's minions, but
  // free walkers). They ride the SAME spawner, so every boss-phase / vigil / cleanup rule
  // above already governs them.
  const horde = goreHordeLocal();
  const maxZ = Math.round(Math.min(26, 4 + Math.floor(game.time / 22) + Math.floor(game.kills / 7)) * settings.zombieSpawn * (horde ? 1.2 : 1));
  const interval = Math.max(0.35, (3.6 - game.time / 80) / settings.zombieSpawn / (horde ? 1.2 : 1));
  if (game.spawnT <= 0 && zombies.length < maxZ) {
    game.spawnT = interval;
    // the graveyard breathes: near the churchyard, some spawns claw up out of the mounds.
    // During the vigil it's the only door left open — every one of them comes up out of it.
    if (graveSpots.length && (vigil || Math.random() < 0.3)) {
      const gs = graveSpots[(Math.random() * graveSpots.length) | 0];
      const d = nearestPlayerDist(gs.x, gs.z);
      if (d > 14 && d < 60) {
        spawnZombie(gs.x, gs.z, 1 + game.time / 240, { mode: 'grave' });
        return;
      }
    }
    // the mound we drew came up under their feet, or too far off to matter. Normally the
    // street takes over from here — during the vigil there is no street left to take over.
    if (vigil) return;
    const runner = Math.random() < 0.22; // far spawns already running our way
    const anchor = spawnAnchor();         // ring in around SOME player, not always the host
    let x = 0, z = 0, ok = false;
    for (let tries = 0; tries < 8 && !ok; tries++) {
      const ang = Math.random() * TAU;
      // runners are born just past the CURRENT fog line, whatever the draw-distance
      // notch and weather have set it to — so they always arrive out of the haze,
      // never pop into a clear sky
      const d = runner ? scene.fog.far + 6 + Math.random() * 28 : 32 + Math.random() * 22;
      x = anchor.x + Math.sin(ang) * d;
      z = anchor.z + Math.cos(ang) * d;
      [x, z] = resolveCollision(x, z, 0.5);
      // zombies never appear inside buildings on their own — and never on the park,
      // perimeter included: the jelly picnic ground stays spawn-free
      ok = !insideBuilding(x, z) && !inPark(x, z, 3);
    }
    if (!ok) return;
    const power = 1 + game.time / 240;
    // near spawns claw out of the dirt or wake from the pavement — no popping into view.
    // during cleanup everything actively hunts, so the last stragglers come find you
    // a fifth of the horde's street spawns come up as green horned brutes while Extra Gore
    // is maxed — never laid out (they rise from the dirt, they don't sleep), never blind,
    // now and then already cracked open at the skull like the rest of the dead
    if (horde && !runner && Math.random() < 0.2) { spawnZombie(x, z, power, { goreHorn: true, mode: 'grave' }); return; }
    const mode = runner ? 'runner'
      : game.cleanup ? 'grave'
      : (!bossPhase() && (onRoad(x, z, 0.5) || Math.random() < 0.35)) ? 'sleeper' : 'grave';
    spawnZombie(x, z, power, { mode });
    // laying zombies come doubled now: beside each sleeper, one already dead — a carcass the
    // crows can pick that never gets up. Capped so they don't crowd the block, and the boss
    // fight ends the practice entirely (sleepers stop spawning too, so this never fires then).
    if (mode === 'sleeper' && zombies.reduce((n, zz) => n + (zz.state === 'corpse'), 0) < 6) {
      // set the carcass a body-length off the sleeper on a random bearing, and only if the
      // spot is clear of every other body — so nothing spawns stacked and a woken sleeper
      // never peels straight up out of a corpse it was sitting inside
      const ca = Math.random() * TAU, cd = 1.5 + Math.random() * 1.4;
      const [cxx, czz] = resolveCollision(x + Math.sin(ca) * cd, z + Math.cos(ca) * cd, 0.5);
      const clear = !zombies.some(zz => zz.state !== 'dying' && Math.hypot(zz.pos.x - cxx, zz.pos.z - czz) < 1.1);
      if (clear && !insideBuilding(cxx, czz) && !inPark(cxx, czz, 3)) spawnZombie(cxx, czz, power, { mode: 'corpse' });
    }
  }
}

// ---------- boss: the Two Horned One ----------
const bossState = { boss: null, beam: null, spawned: false, defeated: false, spawned2: false, defeated2: false,
  spawned3: false, defeated3: false, spawned4: false, defeated4: false };
// the Infected One is up and awake: his lot lights stutter, and his plague makes short work
// of anyone who isn't a real person behind a screen
function infectedFightOn() {
  const b = bossState.boss;
  return bossState.spawned3 && !bossState.defeated3 && !!b && b.isBoss3 && b.state !== 'dormant' && b.state !== 'dying';
}
function infectedAlive() { return bossState.spawned3 && !bossState.defeated3; }
// the Rotten One is up and awake: every street spawn comes up rotting (spawnZombie rolls
// the eye/rib/belly variants) and NPC cousins take his plague damage like the Infected One's
function rottenFightOn() {
  const b = bossState.boss;
  return bossState.spawned4 && !bossState.defeated4 && !!b && b.isBoss4 && b.state !== 'dormant' && b.state !== 'dying';
}
// the rot outlives him. Once the Rotten One has risen the whole block stays sick: every
// street spawn keeps rolling the hanging eye / open-chest-with-beating-heart / pink-belly
// variants for the entire trek to the Jelly House and all the late game after, so the world
// only ever looks MORE rotten the longer you're out here — until grandma's jelly finally
// stops it (she wakes). BEST JELLY STOPS THE ROT.
function rotOnBlock() {
  return bossState.spawned4 && !jelly.awake;
}
// once a boss is in play the streets change character: no more laying zombies (sleepers or
// carcasses) get spawned — the block has bigger problems than crows picking at the dead
function bossPhase() { return bossState.spawned || bossState.spawned2 || bossState.spawned3 || bossState.spawned4; }
const bossBarEl = document.getElementById('bossbar');
const bossHpEl = document.getElementById('bosshp');
const bossLabelEl = document.getElementById('bosslabel');
// cleanup-quota tracker (top right): how many of the hunt's zombies still stand before
// the block is scoured. Appears when the Two Horned One drops his quota, ticks down with
// every kill, and fades once the last one falls and the next beacon takes over the pointing.
const quotaEl = document.getElementById('quota');
const quotaNumEl = quotaEl.querySelector('b');
function updateQuotaHud() {
  const on = game.cleanup && game.clearTarget > 0;
  if (on) quotaNumEl.textContent = Math.max(game.clearTarget - game.kills, 0) + '/' + (game.quotaN || game.clearTarget);
  quotaEl.classList.toggle('show', on);
}
// The Crimson One is always a clear step up from the Two Horned One — taken off his number
// rather than parked beside it, so tuning one can never quietly leave the second boss the
// softer of the two. Each cleared block then wakes tougher versions of both.
const BOSS_HP = 650, BOSS2_HP = Math.round(BOSS_HP * 1.25);
// the Infected One matches the Crimson One's health exactly, and spends his advantage on
// size and speed instead — a bigger, faster thing to fight for the same number of bullets
const BOSS3_HP = BOSS2_HP, BOSS3_BIG = 1.15;
// each boss flies his own colours: the purple bar belongs to the Two Horned One alone
function dressBossBar(z) {
  const kind = !z ? 0 : z.isBoss4 ? 4 : z.isBoss3 ? 3 : z.isBoss2 ? 2 : 1;
  bossLabelEl.textContent = kind === 4 ? 'The Rotten One' : kind === 3 ? 'The Infected One' : kind === 2 ? 'The Crimson One' : 'The Two Horned One';
  bossBarEl.classList.toggle('crimson', kind === 2);
  bossBarEl.classList.toggle('infected', kind === 3);
  bossBarEl.classList.toggle('rotten', kind === 4);
}
// unlocked once every cousin has been recruited
function maybeSpawnBoss() {
  if (bossState.spawned || bossState.defeated || game.state !== 'playing') return;
  if (companions.length === 0 || companions.some(c => !c.recruited)) return;
  spawnBoss();
}
function spawnBoss() {
  bossState.spawned = true;
  const bx = 0, bz = -37.7;                   // the open ground between the fountain and the bank steps
  const blob = buildBlob({ color: BOSS_PURPLE, zombie: true, scale: 2.7, hands: 0x4a1a7a });
  attachBossGlow(blob, BOSS_PURPLE);
  for (const s of [-1, 1]) {                  // horns — folded in so they flash when he's shot
    const horn = cyl(0.02, 0.15, 0.55, 0x2a1a3a, 6);
    horn.position.set(0.22 * s, 0.3, 0.02); horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
    blob.head.add(foldSkin(blob, horn));
  }
  blob.root.position.set(bx, groundHeight(bx, bz), bz);
  scene.add(blob.root);
  const hp = Math.round(BOSS_HP * (1 + 0.4 * game.cycle)); // each cleared block wakes a tougher one
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
  bossState.beam = beam; bossState.beamFade = false; // fresh pillar, full strength
  bossBarEl.classList.remove('show');         // the bar appears once it aggros
  toast('ALL COUSINS FOUND . . SOMETHING STIRS BY THE BANK .ᐟ', true);
  initAudio(); play3d(bx, bz, () => SFX.groan());
}
// the Crimson One: wakes at the church door once the block is scoured. Bites harder
// than the Two Horned One but shuffles at the same pace, and his waves boil out of
// the church doors (red horned guards + purple fodder) and up out of the graves.
function spawnBoss2() {
  bossState.spawned2 = true;
  const bx = CHURCHYARD.x, bz = CHURCHYARD.z; // the strip between the church side door and the graveyard gate
  const blob = buildBlob({ color: BOSS_CRIMSON, zombie: true, scale: 2.7, hands: CRIMSON_HANDS });
  attachBossGlow(blob, BOSS_CRIMSON);
  for (const s of [-1, 1]) {                  // the same crown of horns, rust-dark
    const horn = cyl(0.02, 0.15, 0.55, 0x3a1414, 6);
    horn.position.set(0.22 * s, 0.3, 0.02); horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
    blob.head.add(foldSkin(blob, horn));
  }
  blob.root.position.set(bx, groundHeight(bx, bz), bz);
  scene.add(blob.root);
  const hp = Math.round(BOSS2_HP * (1 + 0.4 * game.cycle));
  const z = {
    blob, pos: new THREE.Vector3(bx, 0, bz), hp, maxHp: hp, speed: 1.15, yaw: -Math.PI / 2, state: 'dormant',
    attackT: 0, deadT: 0, walkPhase: 0, groanT: 2, scale: 2.7,
    brainExposed: false, blind: false, stepT: 0, bleeding: false, dripT: 0, isBoss: true, isBoss2: true,
    biteMult: 1.35, red: true, wavesFired: 0, dashT: 0, dashCdT: -9,
  };
  zombies.push(z);
  bossState.boss = z;
  // blood-red beam over the churchyard pointing the way
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 130, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.set(bx, groundHeight(bx, bz) + 64, bz);
  scene.add(beam);
  bossState.beam = beam; bossState.beamFade = false; // fresh pillar, full strength
  bossBarEl.classList.remove('show');
  toast('BLOCK SCOURED . . BUT THE GRAVES SHIFT BY THE OLD CHURCH .ᐟ', true);
  initAudio(); play3d(bx, bz, () => SFX.groan());
}
// the Infected One: rises out on the floodlit parking lot once the Crimson One is down, and
// his sickness is in the wiring — the lot's floods stutter the whole time he stands. Matches
// the Crimson One's health exactly and spends the difference on reach: 15% bigger and 15%
// faster. His waves come out of the shops, the whole parade at once.
const BOSS_INFECTED = 0x2f9e34, INFECTED_HANDS = 0x145414;
function spawnBoss3() {
  bossState.spawned3 = true;
  const bx = LOT.x, bz = LOT.z;
  const scale = 2.7 * BOSS3_BIG;
  const blob = buildBlob({ color: BOSS_INFECTED, zombie: true, scale, hands: INFECTED_HANDS });
  attachBossGlow(blob, BOSS_INFECTED);
  for (const s of [-1, 1]) {                  // the same crown of horns, sickly dark
    const horn = cyl(0.02, 0.15, 0.55, 0x123a12, 6);
    horn.position.set(0.22 * s, 0.3, 0.02); horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
    blob.head.add(foldSkin(blob, horn));
  }
  blob.root.position.set(bx, groundHeight(bx, bz), bz);
  scene.add(blob.root);
  const hp = Math.round(BOSS3_HP * (1 + 0.4 * game.cycle));
  const z = {
    blob, pos: new THREE.Vector3(bx, 0, bz), hp, maxHp: hp, speed: 1.15 * BOSS3_BIG, yaw: Math.PI, state: 'dormant',
    attackT: 0, deadT: 0, walkPhase: 0, groanT: 2, scale,
    brainExposed: false, blind: false, stepT: 0, bleeding: false, dripT: 0, isBoss: true, isBoss3: true,
    biteMult: 1.35, green: true, wavesFired: 0, dashT: 0, dashCdT: -9,
  };
  zombies.push(z);
  bossState.boss = z;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 130, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x3ae04a, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.set(bx, groundHeight(bx, bz) + 64, bz);
  scene.add(beam);
  bossState.beam = beam; bossState.beamFade = false; // fresh pillar, full strength
  bossBarEl.classList.remove('show');
  toast('THE CHURCH IS QUIET . . SOMETHING STIRS UNDER THE LOT LIGHTS .ᐟ', true);
  initAudio(); play3d(bx, bz, () => SFX.groan());
}
// the Rotten One: the last of them, festering on the jelly park's picnic ground once the
// Infected One is down. The Infected One's playstyle — big, fast, waves at damage
// thresholds — but he wears NO horns and neither do his minions, so nothing ever shields
// him. His weakness is anatomical instead: the rot has laid his left chest open, and the
// heart beating in the hole takes weak-spot damage like a head (see the isBoss4 sphere in
// the hitscan). While he stands, the whole street's spawns come up rotting like him.
const BOSS_ROTTEN = 0x77a12c, ROTTEN_HANDS = 0x3f5a14;
const BOSS4_HP = Math.round(BOSS2_HP * 1.2);
function spawnBoss4() {
  bossState.spawned4 = true;
  const bx = (PARK.x0 + PARK.x1) / 2, bz = (PARK.z0 + PARK.z1) / 2 + 6; // the picnic ground, between the statue and the park gate — wherever the park landed this run
  const scale = 2.7 * BOSS3_BIG;
  const blob = buildBlob({ color: BOSS_ROTTEN, zombie: true, scale, hands: ROTTEN_HANDS });
  attachBossGlow(blob, BOSS_ROTTEN);
  addRotGore(blob, { hangEye: true, chestHole: true }); // no horns — the rot is his crown
  blob.root.position.set(bx, groundHeight(bx, bz), bz);
  scene.add(blob.root);
  const hp = Math.round(BOSS4_HP * (1 + 0.4 * game.cycle));
  const z = {
    blob, pos: new THREE.Vector3(bx, 0, bz), hp, maxHp: hp, speed: 1.15 * BOSS3_BIG, yaw: 0, state: 'dormant',
    attackT: 0, deadT: 0, walkPhase: 0, groanT: 2, scale,
    headT: 0.5, headAnim: null, // his restless head rolls the anim pool like a walker does
    brainExposed: false, blind: false, stepT: 0, bleeding: false, dripT: 0, isBoss: true, isBoss4: true,
    biteMult: 1.35, wavesFired: 0, dashT: 0, dashCdT: -9,
  };
  zombies.push(z);
  bossState.boss = z;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 130, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xb8e03a, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.set(bx, groundHeight(bx, bz) + 64, bz);
  scene.add(beam);
  bossState.beam = beam; bossState.beamFade = false; // fresh pillar, full strength
  bossBarEl.classList.remove('show');
  initAudio(); play3d(bx, bz, () => SFX.groan());
}
function wakeBoss(z) {
  if (z.state !== 'dormant') return;
  z.state = 'chase';
  // the beacon's pointing is done the moment he aggros — his chevron tracks him from
  // here, so the pillar drains away instead of hanging over the fight
  bossState.beamFade = true;
  dressBossBar(z);
  bossBarEl.classList.add('show');
  toast(z.isBoss4 ? 'THE ROTTEN ONE CRASHES THE PICNIC .ᐟ' : z.isBoss3 ? 'THE INFECTED ONE DISTURBS THE LOT .ᐟ' : z.isBoss2 ? 'THE CRIMSON ONE RISES AT THE CHURCH DOOR .ᐟ' : 'THE TWO HORNED ONE AWAKENS .ᐟ', true);
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
function updateBossState(z) {
  if (z.state === 'dormant') {
    // sleeps until someone draws near, then aggros — and anyone playing will do. The vigil
    // outside answers whoever walks up on the churchyard, so he has to answer them too, or
    // they'd stand on his doorstep prising the graves open forever and never wake him.
    if (!player.dead && nearestPlayerDist(z.pos.x, z.pos.z) < 18) wakeBoss(z);
    return;
  }
  // damage-taken thresholds send bigger swarms boiling out of the bank
  const taken = 1 - z.hp / z.maxHp;
  if (z.wavesFired < 1 && taken >= 0.33) fireBossWave(z, 1);
  else if (z.wavesFired < 2 && taken >= 0.50) fireBossWave(z, 2);
  else if (z.wavesFired < 3 && taken >= 0.75) fireBossWave(z, 3);
}
// the shielded boss wears the loot glow in his own body colour, dark until his first
// wave stands a shield up (mul 0), fading back off as the last guard falls
function attachBossGlow(blob, color) {
  const gl = makeLootGlow(color, { r: 1.05, y: 1.85, s: 1.6 });
  gl.userData.glow.mul = 0;
  gl.visible = false; // dormant bosses never animate: stay dark until the fight wakes
  blob.root.add(gl);
  blob.bossGlow = gl;
}
// while any horned wave zombie stands, the boss takes no damage at all
function bossShielded() {
  return zombies.some(zz => zz.hornWave && zz.state !== 'dying');
}
// (the old auto shield-pulse is gone: a shielded boss now flashes green only when a shot
// actually lands on him — damageZombie on the host, netClientShot on a client)
// a spot on a shop's doorstep, clear of whatever's parked against it
function shopDoorSpot() {
  const d = shopDoors[(Math.random() * shopDoors.length) | 0];
  const [x, z] = resolveCollision(d.x + (Math.random() - 0.5) * 1.2, d.z + (Math.random() - 0.5) * 1.2, 0.5);
  return [x, z];
}
function fireBossWave(z, n) {
  z.wavesFired = n;
  if (z.isBoss4) {
    // The Rotten One's waves are all his own: green, hornless, rotting (opts.rot rolls the
    // hanging eye / open chest / pink belly). He wears no horns — but the ROT is his shield:
    // every wave minion spawns with opts.shield, so while any of them still stands he takes no
    // damage at all (bossShielded). Cull the whole swarm to open him up, then hit the heart.
    // They boil up around the ENTIRE park block at once, at every distance — some clawing
    // straight up out of the grass line, others sprinting in out of the haze from clear across
    // the block — so the picnic ground is swarmed heavily from every side. Park stays sacred.
    const cx = (PARK.x0 + PARK.x1) / 2, cz = (PARK.z0 + PARK.z1) / 2; // park centre (129, -42)
    const count = 12 + n * 5;                  // 17 -> 22 -> 27: a heavy swarm, growing each wave
    for (let k = 0; k < count; k++) {
      let px = cx, pz = cz, ok = false;
      for (let tries = 0; tries < 12 && !ok; tries++) {
        const a = Math.random() * TAU;
        const dist = 22 + Math.random() * 48;  // 22 (just off the fence) out to 70 (across the block)
        px = cx + Math.sin(a) * dist;
        pz = cz + Math.cos(a) * dist;
        [px, pz] = resolveCollision(px, pz, 0.5);
        ok = !inPark(px, pz, 2) && !insideBuilding(px, pz);
      }
      if (!ok) continue;
      const far = Math.hypot(px - cx, pz - cz) > 42; // the far half comes running, the near half rises
      spawnZombie(px, pz, 1 + game.time / 240, { green: true, rot: true, shield: true, mode: far ? 'runner' : 'grave' });
    }
  } else if (z.isBoss3) {
    // The Infected One empties the parade, shop by shop, and the town gets sicker each time:
    // first his own green brutes with the ordinary dead in tow, then the Two Horned One's
    // purple guards still with fodder behind them, and finally nothing but horns — green,
    // purple and red together, every guard on the block at once and no filler left to soak
    // a shot. Every one of them walks out of a doorway.
    const count = 7 + n * 4;                   // 11 -> 15 -> 19
    for (let k = 0; k < count; k++) {
      const [x, zz] = shopDoorSpot();
      const power = 1 + game.time / 240;
      if (n === 1) {
        // half green horned guards, half plain dead out of the same doors
        if (k < Math.ceil(count / 2)) spawnZombie(x, zz, power, { green: true, horns: true });
        else spawnZombie(x, zz, power, {});
      } else if (n === 2) {
        if (k < Math.ceil(count / 2)) spawnZombie(x, zz, power, { purple: true, horns: true });
        else spawnZombie(x, zz, power, {});
      } else {
        const kind = k % 3;
        spawnZombie(x, zz, power, kind === 0 ? { green: true, horns: true }
          : kind === 1 ? { purple: true, horns: true } : { red: true, horns: true });
      }
    }
  } else if (z.isBoss2) {
    // the Crimson One calls bigger waves. From the church side door pour purple horned
    // guards (his shield — exactly the Two Horned One's guards, horns + speed) plus red
    // brutes that are faster AND bite harder; from the graves claw plain standard dead.
    const count = 6 + n * 4;                   // wave size grows 10 -> 14 -> 18
    for (let k = 0; k < count; k++) {
      const kind = k % 3;
      if (kind === 0) {                        // purple horned shield-guard from the church
        const [x, zz] = resolveCollision(CHURCHYARD.x - 4.5 + Math.random() * 3, CHURCHYARD.z - 2 + Math.random() * 4, 0.5);
        spawnZombie(x, zz, 1 + game.time / 240, { purple: true, horns: true });
      } else if (kind === 1) {                 // red speed+damage brute from the church
        const [x, zz] = resolveCollision(CHURCHYARD.x - 4.5 + Math.random() * 3, CHURCHYARD.z - 2 + Math.random() * 4, 0.5);
        spawnZombie(x, zz, 1 + game.time / 240, { red: true });
      } else {                                 // standard dead rising from a grave mound
        const gs = graveSpots[(Math.random() * graveSpots.length) | 0];
        spawnZombie(gs.x, gs.z, 1 + game.time / 240, { mode: 'grave' });
      }
    }
  } else {
    const count = 4 + n * 3;                   // wave size grows 7 -> 10 -> 13
    for (let k = 0; k < count; k++) {
      // the only zombies allowed to walk out of a building: they pour from the bank doors.
      // half the wave are purple horned guards (his shield); the rest are plain green fodder
      const [x, zz] = resolveCollision((Math.random() - 0.5) * 12, -40.8 + Math.random() * 1.8, 0.5);
      const guard = k < Math.ceil(count / 2);
      spawnZombie(x, zz, 1 + game.time / 240, { purple: guard, horns: guard });
    }
  }
  bossDash(z);
  // the Rotten One's shield is the swarm itself, not horned guards — his callout points at
  // culling the rot to lay him open, then the heart
  toast(z.isBoss4 ? `WAVE ${n}: THE ROT SHIELDS HIM .ᐟ CULL THE SWARM, THEN THE HEART .ᐟ`
                  : `WAVE ${n}: KILL THE HORNED GUARDS TO BREAK HIS SHIELD`, true);
  play3d(z.pos.x, z.pos.z, () => SFX.groan());
  shakeAmp = Math.max(shakeAmp, 0.2);
}
// Bloopy has exactly one review for a fallen boss, and it is not a long one. Any boss,
// every time — provided he's actually out here to see it.
function bossNice() {
  const b = companions.find(c => persona(c).bossNice && c.recruited && !c.downed && !c.netP);
  if (b) b.helloT = 0, b.niceT = 0.9;   // let the boss's own toast land first
}
function onBossDefeated(z) {
  bossNice();
  if (z.isBoss4) {
    // the true end of it: the last boss down, the block finally clean — and grandma's
    // porch light comes on way off past the church. The party waits at the Jelly House.
    bossState.defeated4 = true;
    if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
    bossBarEl.classList.remove('show');
    for (const zz of [...zombies]) if (zz !== z && !zz.netGhost && zz.state !== 'dying') killZombie(zz, 0, 0, false);
    toast('THE ROTTEN ONE FALLS .ᐟ', true);
    setTimeout(() => toast('REMEMBER THE JELLY .ᐟ BEST JELLY STOPS THE ROT .ᐟ', true), 2800);
    setTimeout(() => toast('AHA, TO THE OLD JELLY HOUSE .ᐟ', true), 7400);
    for (let k = 0; k < 48; k++) spawnParticles(z.pos.x, z.blob.root.position.y + 2, z.pos.z, [0xffd24a, 0xb8e03a, 0xfff3d0][k % 3], 1, 6, 1.2);
    rumble(600, 1, 1);
    // new game plus: the porch light is BLUGA's now — grandma only comes once he falls.
    // First-ever campaigns skip him and go straight to her.
    if (game.prestigeRun) {
      setTimeout(() => toast('BUT THE JELLY HOUSE IS SURROUNDED .ᐟ', true), 2800);
      spawnBlugaFinal();
    } else {
      spawnJellyMarks();                      // the beacon + grandma's ghost inside
      if (net.role === 'host') netBroadcast({ t: 'jelly' }); // every screen gets the light + the ghost
    }
    return;
  }
  if (z.isBoss3) {
    // the Infected One down — but the rot he carried has settled on the picnic ground.
    // The street party still has one gatecrasher left to bounce.
    bossState.defeated3 = true;
    if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
    bossBarEl.classList.remove('show');
    for (const zz of [...zombies]) if (zz !== z && !zz.netGhost && zz.state !== 'dying') killZombie(zz, 0, 0, false);
    toast('THE INFECTED ONE FALLS . . BUT SOMETHING ROTS ON THE JELLY PARK .ᐟ', true);
    for (let k = 0; k < 48; k++) spawnParticles(z.pos.x, z.blob.root.position.y + 2, z.pos.z, [0xffd24a, 0x3ae04a, 0xfff3d0][k % 3], 1, 6, 1.2);
    rumble(600, 1, 1);
    spawnBoss4();
    return;
  }
  if (z.isBoss2) {
    // the church goes quiet — but the sickness just moves house. Every walker left drops,
    // and the Infected One stands up out on the lot instead of the street party starting.
    bossState.defeated2 = true;
    if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
    bossBarEl.classList.remove('show');
    for (const zz of [...zombies]) if (zz !== z && !zz.netGhost && zz.state !== 'dying') killZombie(zz, 0, 0, false);
    toast('THE CRIMSON ONE FALLS . . BUT THE LOT LIGHTS ARE STUTTERING .ᐟ', true);
    for (let k = 0; k < 48; k++) spawnParticles(z.pos.x, z.blob.root.position.y + 2, z.pos.z, [0xffd24a, 0xff3030, 0xfff3d0][k % 3], 1, 6, 1.2);
    rumble(600, 1, 1);
    spawnBoss3();
    return;
  }
  bossState.defeated = true;
  if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
  bossBarEl.classList.remove('show');
  crowsLeave(); // the whole murder abandons the block once its master falls
  // cleanup phase: kills must reach the NEXT full hundred so it's always 100+ more —
  // at 299 kills the target is 400, never a one-kill cheese to 300
  game.cleanup = true;
  game.clearTarget = Math.ceil((game.kills + 1 + 100) / 100) * 100;
  game.quotaN = game.clearTarget - game.kills; // the size of the hunt, for the X/N readout
  updateQuotaHud();
  toast(`BOSS DOWN .ᐟ REACH ${game.clearTarget} KILLS TO SECURE THE BLOCK .ᐟ`, true);
  if (net.role === 'host') netBroadcast({ t: 'hunt', ct: game.clearTarget }); // clients get the hunt call too
  for (let k = 0; k < 40; k++) spawnParticles(z.pos.x, z.blob.root.position.y + 2, z.pos.z, [0xffd24a, 0xb03cff, 0x6fd8ff][k % 3], 1, 6, 1.2);
  rumble(600, 1, 1);
}
// every straggler hunted down: the hunt is done — but the block isn't clean yet.
// The Crimson One stirs at the church instead of the street party; the celebration
// only plays once HE falls (see onBossDefeated).
function completeCleanup() {
  game.cleanup = false;
  updateQuotaHud(); // the readout fades out: the hunt is done, the next beacon points the way
  if (!bossState.spawned2 && !bossState.defeated2) { spawnBoss2(); return; }
  game.celebrateT = 5.5;
  recordPrestige();
  if (net.role === 'host') netBroadcast({ t: 'secured', tm: game.time }); // everyone banks the clear
  toast('BLOCK SECURED .ᐟ', true);
  rumble(600, 1, 1);
}
const fadeEl = document.getElementById('fade');
// the street party: fireworks + bouncing cousins, then fade out to the prestige menu
function updateCelebration(dt) {
  if (game.celebrateT <= 0) return;
  game.celebrateT -= dt;
  if (Math.random() < dt * 7) {
    const ang = Math.random() * TAU, r = 2.5 + Math.random() * 6;
    const x = player.pos.x + Math.sin(ang) * r, z = player.pos.z + Math.cos(ang) * r;
    const cols = [0xffd24a, 0xff5b5b, 0x6fd8ff, 0x9bff6a, 0xb06fff];
    spawnParticles(x, player.pos.y + 2.5 + Math.random() * 3.5, z, cols[(Math.random() * cols.length) | 0], 12, 5.5, 1.1);
    play3d(x, z, () => tone(500 + Math.random() * 900, 0.25, 0.18, 'square', 180));
  }
  for (const c of companions) {
    if (c.recruited && !c.downed && c.grounded && Math.random() < dt * 2.5) { c.vy = 5.5 + Math.random() * 3; c.grounded = false; }
  }
  if (game.celebrateT <= 1) fadeEl.classList.add('show');
  if (game.celebrateT <= 0) {
    // jelly.awake means this was the grandma finale (a win), not a mid-run block clear: bank
    // the campaign so the next solo run rolls into new-game-plus (Bluga + the farther deal)
    quitToMenu(jelly.awake);
    setTimeout(() => fadeEl.classList.remove('show'), 300);
  }
}
function updateBossFx(dt) {
  if (bossState.beam) {
    if (bossState.beamFade) {
      // aggro'd: ~1.5s drain from the pulse's brightest, then the pillar is gone
      const m = bossState.beam.material;
      m.opacity -= dt * 0.16;
      if (m.opacity <= 0) { scene.remove(bossState.beam); bossState.beam = null; bossState.beamFade = false; }
    } else {
      bossState.beam.material.opacity = 0.16 + Math.sin(performance.now() * 0.004) * 0.08;
    }
  }
  const z = bossState.boss;
  if (z && z.state !== 'dormant') bossHpEl.style.width = clamp(z.hp / z.maxHp, 0, 1) * 100 + '%';
}

// ---------- grandma Blingo and the Jelly House epilogue ----------
// The end-game formula: the Rotten One falls -> a giant fog-proof light stands up over the
// Jelly House (the farthest landmark out, way past the church) -> the trek -> inside, the
// ghost of Grandma Blingo, grey and see-through, celebrating like the splash-screen blobs
// at 4x their pace, her colours rainbowing through the whole family's in a blur. Remember
// her (interact) and she colours in for real: every cousin — human and AI — is gathered
// into the Jelly House for the family reunion, the opening medley plays, and the run's
// tally counts itself up on screen while the party runs long enough to read it.
const jelly = { beacon: null, ghost: null, skins: [], sat: 0, awake: false, wakeT: 0,
  cyc: 0, gy: 0, col: new THREE.Color(0xff8c42), statRows: [], statT: -1 };
const _jelC = new THREE.Color(), _jelHSL = { h: 0, s: 0, l: 0 };
function spawnJellyMarks() {
  if (jelly.beacon) return;                     // one light, one grandma
  jelly.gy = groundHeight(JELLY.x, JELLY.z);
  // the pillar: far wider and taller than a boss beam, and fog-exempt — it must read
  // from the middle of town, all the way across the map, or the trek has no star to steer by
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 2.6, 220, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.3, fog: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.set(JELLY.x, jelly.gy + 100, JELLY.z);
  scene.add(beam);
  jelly.beacon = beam;
  // grandma's ghost, mid-celebration in the middle of her stockroom floor. Blingo's blob,
  // Blingo's hands — the family skin stays skin; only the SUIT rainbows (and starts grey)
  const b = buildBlob({ color: 0xff8c42 });
  b.root.position.set(JELLY_G.x, jelly.gy, JELLY_G.z); // beside the long table, jars at her elbow
  scene.add(b.root);
  jelly.skins = [];
  b.root.traverse(o => {
    if (!o.isMesh || o.material === shadowMat) return;
    const base = o.material.color.getHex();
    o.material = o.material.clone();            // never touch the shared mat() cache
    o.material.transparent = true; o.material.opacity = 0.5;
    if (base === 0xff8c42) jelly.skins.push(o.material); // body + head + arms — the recolour set
  });
  jelly.ghostMats = [];
  b.root.traverse(o => { if (o.isMesh && o.material !== shadowMat) jelly.ghostMats.push(o.material); });
  jelly.ghost = b;
  jelly.sat = 0; jelly.awake = false; jelly.wakeT = 0; jelly.statT = -1;
}
// grandma's ghost close enough to remember (the Jelly House prompt)
function findNearGrandma() {
  if (!jelly.ghost || jelly.awake) return null;
  return Math.hypot(player.pos.x - JELLY_G.x, player.pos.z - JELLY_G.z) < 3.4 ? jelly : null;
}
// the moment of remembrance, on whichever screen owns the squad (host / solo). Colours her
// in, gathers the whole family, starts the long party + the tally.
function grandmaWake() {
  if (jelly.awake) return;
  recordPrestige();
  startFinale();
  // the remembrance clears the streets: every walker on the map bursts on the spot (and
  // updateSpawner stays muted while the tally runs), so the party can't be crashed
  for (const zz of [...zombies]) if (!zz.netGhost && zz.state !== 'dying' && !zz.fbi) killZombie(zz, 0, 0, true);
  // gather every cousin to the reunion — THEATRICALLY. Each AI cousin melts out in turn
  // (the splash blur, staggered a beat apart), crosses the whole map, and blooms back in
  // on the ring around her, healed — the jelly stops the rot. Human-run cousins get the
  // same melt on their OWN screens (the 'finale' message drives player.finaleTp there),
  // and their host-side bodies wear it too when the teleported pose stream lands
  // (netPoseCompanion's long-jump melt). Nobody ever just blinks into the room.
  const ring = companions.filter(c => c.recruited);
  ring.forEach((c, i) => {
    const a = (i / Math.max(ring.length, 1)) * TAU + 0.6;
    const x = JELLY_G.x + Math.sin(a) * 2.5, z = JELLY_G.z + Math.cos(a) * 2.5; // ringed round her, clear of the table
    c.downed = false; c.hp = c.maxHp;
    if (c.beacon) { scene.remove(c.beacon); c.beacon = null; }
    if (c.netP) {
      if (c.netConn) { try { c.netConn.send({ t: 'finale', x, z }); } catch (e) {} }
    } else {
      if (!c.tpMats) beginBlobFade(c);
      c.tp = { t: -0.22 * i, phase: 0, tx: x, tz: z, burst: true }; // one after another, oldest cousin first
    }
  });
  // and the hero who DIDN'T reach her first (a client triggered the wake): the host's own
  // body joins the family through the same melt instead of missing its own party
  if (Math.hypot(player.pos.x - JELLY_G.x, player.pos.z - JELLY_G.z) > 12)
    player.finaleTp = { t: 0, x: JELLY_G.x + Math.sin(-0.9) * 2.5, z: JELLY_G.z + Math.cos(-0.9) * 2.5 };
  rebuildSquadBars();
  toast('GRANDMA BLINGO .ᐟ THE FAMILY IS WHOLE AGAIN .ᐟ', true);
}
// the shared half of the finale — runs on the host when grandma wakes, and on every client
// when the 'finale' message lands: colour her in, strike up the family medley, run the
// party long, and start the tally counting
function startFinale() {
  jelly.awake = true; jelly.wakeT = 0;
  game.celebrateT = 16;                       // the long party: time to read the tally
  game.cleanup = false; updateQuotaHud();
  // the family made whole: this campaign is in the books. From the next run on, Bluga's
  // black-ops blobs are watching (isPrestigeRun). Banked on every screen that sees the party.
  prestige.campaign = (prestige.campaign | 0) + 1;
  sessionCampaign++; // this session has a clear on the books: the next run is Bluga's
  // BLOCKS SECURED is now a streak, not a tally: the most grandma-reunions strung together
  // back-to-back without dropping the chain (win = 1, each consecutive Bluga run = 2+). The
  // session chain (sessionCampaign) IS that streak — quitting to the menu breaks it — so its
  // high-water mark is the prestige worth banking next to the fastest time.
  if (sessionCampaign > (prestige.bestStreak | 0)) prestige.bestStreak = sessionCampaign;
  try { localStorage.setItem(PRESTIGE_KEY, JSON.stringify(prestige)); } catch (e) {}
  initAudio(); stopGameMusic();               // the looping bed hands the floor to the family theme
  playOpeningTheme();                         // all six motifs + the soundoff — the family theme
  rumble(500, 0.8, 0.8);
  // the tally rows, captured now so late kills don't wiggle the numbers mid-count
  jelly.statRows = [
    { label: 'KILLS', icon: 'kills', v: game.kills },
    { label: 'SHOTS FIRED', icon: 'bullets', v: game.shots | 0 },
    { label: 'CRATES OPENED', icon: 'crates', v: game.cratesOpened | 0 },
    { label: 'TIME', icon: 'survived', v: Math.round(game.time), fmt: fmtTime },
  ];
  jelly.statT = 0;
  buildFinalStats();
}
const finalStatsEl = document.getElementById('finalstats');
function buildFinalStats() {
  finalStatsEl.innerHTML = '<div class="fshead">GRANDMA’S TALLY .ᐟ</div>';
  for (const r of jelly.statRows) {
    const row = document.createElement('div');
    row.className = 'fsrow';
    // each category wears its little inked icon — the same set the death screen uses
    row.innerHTML = `<span>${DEATH_ICONS[r.icon] || ''}${r.label}</span><b>${r.fmt ? r.fmt(0) : 0}</b>`;
    finalStatsEl.appendChild(row);
    r.el = row; r.num = row.querySelector('b');
  }
  finalStatsEl.classList.remove('hidden');
}
function hideFinalStats() { finalStatsEl.classList.add('hidden'); finalStatsEl.innerHTML = ''; }
function updateJelly(dt) {
  if (!jelly.beacon) return;
  // the finale warp on your OWN body: the splash melt — fade out where you stood, cross
  // the whole map at the dip, bloom back in on grandma's ring, healed on arrival. Runs on
  // whichever screen owns this hero (the host pulled to a client's wake, or a client
  // answering the 'finale' call), so ending a run reads smooth on every screen at once.
  if (player.finaleTp) {
    const ft = player.finaleTp;
    if (!ft.began) { ft.began = true; if (!player.giantPhase) playerFadeBegin(); }
    ft.t += dt;
    const k = Math.min(ft.t / 0.9, 1);
    if (player._fade) setBlobFade(player._fade, Math.max(k < 0.5 ? 1 - k * 2 : (k - 0.5) * 2, 0.06));
    if (!ft.crossed && k >= 0.5) {
      ft.crossed = true;
      player.pos.set(ft.x, groundHeight(ft.x, ft.z), ft.z);
      player.vy = 0;
      if (player.downed) { // the jelly stops the rot: the party stands you up whole
        player.downed = false; player.downT = 0; player.jellyT = 0; player.hp = player.maxHp;
        if (player.beacon) { scene.remove(player.beacon); player.beacon = null; }
        playerBlob.wob.rotation.x = 0;
      }
      spawnParticles(ft.x, player.pos.y + 1.2, ft.z, myCousinData().color, 10, 4, 0.8);
    }
    if (k >= 1) { if (!player.giantPhase) playerFadeEnd(); player.finaleTp = null; }
  }
  jelly.beacon.material.opacity = 0.24 + Math.sin(performance.now() * 0.0035) * 0.1;
  jelly.beacon.rotation.y += dt * 0.3;
  const b = jelly.ghost;
  if (!b) return;
  // --- the rainbow: the splash screen's cousin-morph at 4x, smeared into a blur ---
  jelly.cyc += dt * 6.75;                      // ~0.15s a cousin — 6x the splash's saunter: one beat per cousin, six cousins in her blur
  _jelC.set(COUSINS[Math.floor(jelly.cyc) % COUSINS.length].color);
  jelly.col.lerp(_jelC, 1 - Math.exp(-9 * dt));
  if (jelly.awake && jelly.sat < 1) jelly.sat = Math.min(1, jelly.sat + dt / 1.2); // colouring in
  jelly.col.getHSL(_jelHSL);
  _jelC.setHSL(_jelHSL.h, _jelHSL.s * jelly.sat, _jelHSL.l);
  for (const m of jelly.skins) m.color.copy(_jelC);
  // ghost translucency solidifies as she colours in
  const op = 0.5 + jelly.sat * 0.5;
  for (const m of jelly.ghostMats) m.opacity = op;
  // --- the dance: hopping, arms up and waving, a slow happy spin ---
  const gt = performance.now() * 0.001;
  b.root.position.y = jelly.gy + Math.abs(Math.sin(gt * 6)) * 0.4;
  b.arms[0].rotation.x = -2.6 + Math.sin(gt * 8) * 0.35;
  b.arms[1].rotation.x = -2.6 + Math.sin(gt * 8 + Math.PI) * 0.35;
  b.root.rotation.y += dt * 1.1;
  b.wob.scale.y = 1 + Math.sin(gt * 12) * 0.04;
  placeShadow(b, JELLY_G.x, JELLY_G.z, jelly.gy);
  // --- the finale timeline: confetti around her + the tally counting itself up ---
  if (!jelly.awake) return;
  jelly.wakeT += dt;
  if (Math.random() < dt * 5) {
    const a = Math.random() * TAU, r = 1 + Math.random() * 2.5;
    spawnParticles(JELLY_G.x + Math.sin(a) * r, jelly.gy + 2 + Math.random() * 2, JELLY_G.z + Math.cos(a) * r,
      COUSINS[(Math.random() * COUSINS.length) | 0].color, 8, 4, 0.9);
  }
  if (jelly.statT < 0) return;
  jelly.statT += dt;
  jelly.statRows.forEach((r, i) => {
    const t0 = 1.6 + i * 1.5;                  // each row takes the stage in turn
    if (jelly.statT < t0) return;
    if (!r.el.classList.contains('in')) r.el.classList.add('in');
    const p = clamp((jelly.statT - t0) / 1.1, 0, 1);
    const eased = 1 - Math.pow(1 - p, 3);      // count fast then settle on the number
    const v = Math.round(r.v * eased);
    const txt = r.fmt ? r.fmt(v) : String(v);
    if (r.num.textContent !== txt) r.num.textContent = txt;
  });
}

// ---------- Bluga the Bad Blob + the Black-ops blobs ----------
// New game plus (isPrestigeRun): clear the family's campaign once and Bluga starts stalking
// the trek. FBI blobs are black head to toe with a shiesty ski-mask opening showing a random
// cousin's colour around the eyes and FBI up the back in goopy yellow; Bluga's own opening is
// Blizzy blue. They carry SMGs and ARs and shoot EVERYTHING — zombies, cousins, you. First he
// cameos at the fountain (shoots a few walkers, wishes you luck, slide-hops off in a puff of
// smoke). Then he's the run's true final boss, dug in around the Jelly House: he smoke-vanishes
// while any guard stands, so you cull the black-glowing squad to drag him back into the open.
const FBI_BLACK = 0x141519, FBI_BLACK_DK = 0x0a0b0e, BLUGA_FACE = 0x6fd8ff; // Bluga's opening is Blizzy blue
const bluga = { phase: 'idle', boss: null, cameo: null, camT: 0, camDone: false, wave: 0, appearT: 0, smokeT: 0 };
function resetBluga() {
  if (bluga.cameo) { scene.remove(bluga.cameo.blob.root); if (bluga.cameo.blob.shadow) scene.remove(bluga.cameo.blob.shadow); }
  bluga.phase = 'idle'; bluga.boss = null; bluga.cameo = null;
  bluga.camT = 0; bluga.camDone = false; bluga.wave = 0; bluga.appearT = 0; bluga.smokeT = 0;
}
let fbiBackTex = null;
function getFbiBackTex() {
  if (!fbiBackTex) fbiBackTex = canvasTex(96, 64, ctx => {
    ctx.clearRect(0, 0, 96, 64);
    ctx.fillStyle = '#f2c21a';
    ctx.font = "bold 44px 'OpenDyslexic','Comic Sans MS','Comic Sans',cursive";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('FBI', 48, 36);
  });
  return fbiBackTex;
}
// the black-ops body: all-black blob + black mitts, a band of a cousin's colour around the
// eyes (the ski-mask opening), and FBI up the back in the goopy yellow font
function buildFbiBlob(faceColor, big) {
  const blob = buildBlob({ color: FBI_BLACK, scale: big ? 1.4 : 1.0, hands: FBI_BLACK_DK });
  // the shiesty opening: a clean SIDEWAYS OVAL of the cousin's colour laid flat on the face
  // front (thin, riding proud of the black skull instead of buried in it), wide enough to
  // frame both eyes — which still poke through in front of it
  const face = ball(1, faceColor); face.scale.set(0.3, 0.15, 0.055); face.position.set(0, 0.05, 0.355);
  blob.head.add(face);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.44),
    new THREE.MeshBasicMaterial({ map: getFbiBackTex(), transparent: true, depthWrite: false }));
  // clear of the torso ellipsoid (z extent ~0.42 at chest height) — at -0.31 the letters
  // sat buried INSIDE the body and never showed
  back.position.set(0, 0.95, -0.46); back.rotation.y = Math.PI; blob.wob.add(back);
  return blob;
}
// stand up one black-ops blob in the zombie list (so the whole hitscan / damage / death /
// client-ghost pipeline already sees it). wave guards never drop the jelly; perimeter ones do.
function spawnFbi(x, z, { weapon, wave, bluga: isBluga } = {}) {
  const faceColor = isBluga ? BLUGA_FACE : COUSINS[(Math.random() * COUSINS.length) | 0].color;
  const wid = weapon || (Math.random() < 0.5 ? 'smg' : 'rifle');
  const blob = buildFbiBlob(faceColor, isBluga);
  const gun = buildGunMesh(wid); blob.gunSocket.add(gun);
  const gy = groundHeight(x, z);
  blob.root.position.set(x, gy, z);
  scene.add(blob.root);
  const gl = makeLootGlow(0, { r: isBluga ? 1.1 : 0.85, y: isBluga ? 2.6 : 2.0, s: isBluga ? 1.7 : 1.35, dark: true });
  blob.root.add(gl); blob.guardGlow = gl;
  // squad stats track the Crimson One's red minions spawned at this same moment: the same
  // health pool and the same quick feet — armoured, but not spongier than the red brutes
  const power = 1 + game.time / 240;
  const minionHp = Math.round((9 + Math.random() * 6) * 1.2 * power);
  const hp = isBluga ? Math.round(BOSS2_HP * 0.9) : minionHp;
  const z2 = {
    blob, pos: new THREE.Vector3(x, 0, z), yaw: Math.random() * TAU, scale: isBluga ? 1.4 : 1,
    hp, maxHp: hp, state: 'chase', deadT: 0, walkPhase: Math.random() * 9,
    speed: (1.5 + Math.random() * 1.4) * 1.25 * (0.9 + power * 0.1), // the red minions' pace
    minionHp, // Bluga's own endgame line: at or under this he stops smoking out (see updateFbi)
    fbi: true, fbiWave: !!wave, fbiFace: faceColor, fbiWeapon: wid, bluga: !!isBluga, gunMesh: gun,
    homeX: x, homeZ: z, y: gy, vy: 0, grounded: true, aimPitch: 0, shootCd: Math.random() * 0.7,
    attackT: 0, kvx: 0, kvz: 0, biteMult: 1, vanished: false, blind: false,
  };
  if (!z2.nid) z2.nid = ++net.zid;
  zombies.push(z2);
  return z2;
}
function fbiGuardsAlive() { return zombies.some(z => z.fbi && !z.bluga && z.state !== 'dying'); }
// a black-ops blob's shot: a tracer from the muzzle to the mark, its own crack, and the
// damage (guns miss sometimes — a far mark more than a near one)
const _fbiFrom = new THREE.Vector3(), _fbiTo = new THREE.Vector3();
// every host-side NPC muzzle line (FBI squads, Bluga's cameo, a cousin's crow shot) is
// relayed so clients draw the same tracer and hear the same crack — the fight LOOKS the
// same on every screen, not just where the simulation lives
function relayTracerFx(wid, from, to) {
  if (net.role !== 'host' || !net.conns.length) return;
  const q = v => Math.round(v * 10) / 10;
  netBroadcast({ t: 'ftr', w: wid, a: [q(from.x), q(from.y), q(from.z), q(to.x), q(to.y), q(to.z)] });
}
// a black-ops eye-line: can this blob actually see (and therefore shoot) the mark, or is
// a wall / car / crate in the way? Same ray discipline the cousins' guns follow.
function fbiSees(z, tx, ty, tz) {
  const oy = groundHeight(z.pos.x, z.pos.z) + 1.1 * z.scale;
  let dx = tx - z.pos.x, dy = (ty + 0.9) - oy, dz2 = tz - z.pos.z;
  const dl = Math.hypot(dx, dy, dz2) || 1;
  if (dl < 2.2) return true;
  dx /= dl; dy /= dl; dz2 /= dl;
  for (const c of nearbyColliders(z.pos.x, z.pos.z)) {
    const t = c.roof ? rayRoof(z.pos.x, oy, z.pos.z, dx, dy, dz2, c)
                     : rayAABB(z.pos.x, oy, z.pos.z, dx, dy, dz2, c);
    if (t < dl - 0.35) return false;
  }
  return true;
}
// the perimeter's bad blobs call the contact — one sharp ".ᐟ" over the mask the first
// time they lay eyes on prey or take a round. Map guards only, never the waves.
function fbiAlert(z) {
  if (z.alerted || z.fbiWave || z.bluga || !z.fbi) return;
  z.alerted = true;
  spawnBubble(() => ({ x: z.pos.x, y: groundHeight(z.pos.x, z.pos.z) + 2.3, z: z.pos.z }), '.ᐟ', z);
  if (Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z) < 30) play3d(z.pos.x, z.pos.z, () => SFX.pickup());
}
function fbiShoot(z, tx, ty, tz, target, td) {
  z.lastShotT = game.time;
  const gm = z.gunMesh;
  if (gm && gm.userData.muzzle) gm.userData.muzzle.getWorldPosition(_fbiFrom);
  else { _fbiFrom.set(z.pos.x, groundHeight(z.pos.x, z.pos.z) + 1.1 * z.scale, z.pos.z); }
  _fbiTo.set(tx, ty + 0.9, tz);
  const w = WEAPONS[z.fbiWeapon] || WEAPONS.rifle;
  // black-ops rounds obey the same walls, cars and crates everyone else's do: a blocked
  // line smacks the obstacle — the round never phases through into whoever's behind it
  {
    let dx = _fbiTo.x - _fbiFrom.x, dy = _fbiTo.y - _fbiFrom.y, dz2 = _fbiTo.z - _fbiFrom.z;
    const dl = Math.hypot(dx, dy, dz2) || 1;
    dx /= dl; dy /= dl; dz2 /= dl;
    let tWall = rayGround(_fbiFrom.x, _fbiFrom.y, _fbiFrom.z, dx, dy, dz2, dl + 4);
    for (const col of nearbyColliders(z.pos.x, z.pos.z)) {
      const t = col.roof ? rayRoof(_fbiFrom.x, _fbiFrom.y, _fbiFrom.z, dx, dy, dz2, col)
                         : rayAABB(_fbiFrom.x, _fbiFrom.y, _fbiFrom.z, dx, dy, dz2, col);
      if (t < tWall) tWall = t;
    }
    if (tWall < dl - 0.35) {
      _fbiTo.set(_fbiFrom.x + dx * tWall, _fbiFrom.y + dy * tWall, _fbiFrom.z + dz2 * tWall);
      spawnTracer(_fbiFrom, _fbiTo);
      relayTracerFx(z.fbiWeapon, _fbiFrom, _fbiTo);
      spawnParticles(_fbiTo.x, _fbiTo.y, _fbiTo.z, 0x9a9a8a, 3, 2, 0.3);
      if (Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z) < 32) play3d(z.pos.x, z.pos.z, () => SFX.shoot(w));
      return;
    }
  }
  spawnTracer(_fbiFrom, _fbiTo);
  relayTracerFx(z.fbiWeapon, _fbiFrom, _fbiTo);
  if (Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z) < 32) play3d(z.pos.x, z.pos.z, () => SFX.shoot(w));
  // hit chance falls off with range; a giant chili player only ever soaks 1
  if (Math.random() > clamp(1 - td / 34, 0.28, 0.9)) return;
  const dmg = z.bluga ? 6 : (z.fbiWeapon === 'rifle' ? 9 : 6);
  if (target.kind === 'player') hurtPlayer(playerGiantOn() ? 1 : dmg, player.pos.x - z.pos.x, player.pos.z - z.pos.z);
  else if (target.kind === 'cousin') hurtCompanion(target.c, dmg);
  else if (target.kind === 'zombie' && target.z.state !== 'dying') {
    const zz = target.z, d2 = Math.hypot(zz.pos.x - z.pos.x, zz.pos.z - z.pos.z) || 1;
    damageZombie(zz, dmg * 2.2, (zz.pos.x - z.pos.x) / d2, (zz.pos.z - z.pos.z) / d2, 1.5, { isHead: false });
  }
}
// one black-ops blob's frame: pick the nearest thing that isn't FBI, face it, hold at range
// (guards keep near their post), and put rounds on it. Bluga himself runs this too when he's
// out of the smoke.
const _fbiT = { kind: null };
function updateFbi(z, dt) {
  const b = z.blob;
  const gy = groundHeight(z.pos.x, z.pos.z);
  // Bluga vanishes in his own smoke while any guard still stands — invisible AND untargetable.
  // But the trick runs out with him: once his health is down to a mere minion's worth, the
  // smoke stays in the pocket and he can be finished like any other black-ops blob.
  if (z.bluga) {
    const hide = fbiGuardsAlive() && z.hp > (z.minionHp || 0);
    if (hide !== z.vanished) {
      z.vanished = hide; b.root.visible = !hide;
      if (b.guardGlow) b.guardGlow.visible = false;
      for (let k = 0; k < 3; k++) spawnParticles(z.pos.x, gy + (1 + k * 0.5) * z.scale, z.pos.z, 0x3a3a42, 22, 6.5, 2.2); // the smoke pop — big, and it hangs
      play3d(z.pos.x, z.pos.z, () => noiseBurst(0.4, 300, 0.7));
    }
    if (hide) { b.root.position.set(z.pos.x, gy, z.pos.z); placeShadow(b, z.pos.x, z.pos.z, gy); return; }
  }
  b.root.position.set(z.pos.x, gy, z.pos.z);
  // nearest non-FBI target: you, a cousin, or an ordinary zombie
  let td = Infinity, tx = 0, ty = 0, tz = 0; _fbiT.kind = null;
  const eye = (x, zz) => Math.hypot(x - z.pos.x, zz - z.pos.z);
  if (!player.dead && !player.downed) { const d = eye(player.pos.x, player.pos.z); if (d < td) { td = d; tx = player.pos.x; ty = player.pos.y; tz = player.pos.z; _fbiT.kind = 'player'; } }
  for (const c of companions) if (c.recruited && !c.downed) { const d = eye(c.pos.x, c.pos.z); if (d < td) { td = d; tx = c.pos.x; ty = c.y || 0; tz = c.pos.z; _fbiT.kind = 'cousin'; _fbiT.c = c; } }
  for (const oz of zombies) if (!oz.fbi && oz.state !== 'dying' && oz.state !== 'corpse') { const d = eye(oz.pos.x, oz.pos.z); if (d < td) { td = d; tx = oz.pos.x; ty = oz.blob.root.position.y; tz = oz.pos.z; _fbiT.kind = 'zombie'; _fbiT.z = oz; } }
  const range = z.bluga ? 24 : 18;
  // mid slide-for-cover: ride it out before anything else — a low fast dive off the
  // firing line, spent on its own clock
  if (z.fbiSlideT > 0) {
    z.fbiSlideT -= dt;
    const sp = 8.5 * dt;
    const [nx, nz] = resolveCollision(z.pos.x + (z.slideVX || 0) * sp, z.pos.z + (z.slideVZ || 0) * sp, 0.42 * z.scale, gy);
    z.pos.x = nx; z.pos.z = nz;
    b.root.position.set(z.pos.x, gy, z.pos.z);
    b.root.rotation.y = z.yaw;
    b.wob.rotation.x = 0.85;
    b.legs[0].rotation.x = -1.15; b.legs[1].rotation.x = -0.75;
    b.arms[b.offArm].rotation.x = -1.9;
    placeShadow(b, z.pos.x, z.pos.z, gy);
    if (b.guardGlow) animateLootGlow(b.guardGlow, game.time + (z.walkPhase || 0));
    return;
  }
  b.wob.rotation.x = 0;
  if (_fbiT.kind) {
    // the map's perimeter blobs call the contact the first time they lay eyes on prey
    if ((_fbiT.kind === 'player' || _fbiT.kind === 'cousin') && td < 26) fbiAlert(z);
    // Bluga works the Jelly House like he owns it: from inside, his mark outside, he reads
    // the room through the openings and pushes for one — the entrance closest to the
    // bullets hitting him, unless somebody is hugging another entrance/window even closer
    let sees = fbiSees(z, tx, ty, tz);
    if (z.bluga) {
      const myBld = buildingAt(z.pos.x, z.pos.z);
      if (myBld && myBld !== buildingAt(tx, tz)) {
        const doors = myBld.doors || [{ x: myBld.doorX, z: myBld.doorZ, outX: myBld.doorOutX, outZ: myBld.doorOutZ }];
        let drShot = null, dShot = Infinity, drTgt = null, dTgt = Infinity;
        for (const d of doors) {
          const ds = Math.hypot(d.x - game.lastShot.x, d.z - game.lastShot.z);
          if (ds < dShot) { dShot = ds; drShot = d; }
          const dtg = Math.hypot(d.x - tx, d.z - tz);
          if (dtg < dTgt) { dTgt = dtg; drTgt = d; }
        }
        const shotFresh = game.time - game.lastShotT < 4;
        const dr = (shotFresh && drShot && dTgt >= dShot) ? drShot : drTgt;
        if (dr && !sees) { tx = dr.outX; tz = dr.outZ; td = eye(tx, tz) || 0.1; sees = false; }
      }
    }
    const want = Math.atan2(tx - z.pos.x, tz - z.pos.z);
    z.yaw = angLerp(z.yaw || 0, want, 1 - Math.exp(-9 * dt));
    // close to a comfortable firing distance — and with no clear line, PATH to one
    // instead of standing there hosing a wall; a guard pulled too far drifts back home
    const homeD = eye(z.homeX, z.homeZ);
    let mx = 0, mz = 0;
    if (!sees || td > range * 0.8) { mx = (tx - z.pos.x) / (td || 1); mz = (tz - z.pos.z) / (td || 1); }
    else if (td < range * 0.45) { mx = -(tx - z.pos.x) / td; mz = -(tz - z.pos.z) / td; } // back off if crowded
    if (!z.fbiWave && !z.bluga && (td > 30 || homeD > 12)) { const hd = homeD || 1; mx = (z.homeX - z.pos.x) / hd; mz = (z.homeZ - z.pos.z) / hd; }
    if (mx || mz) {
      const sp = (z.bluga ? 3.4 : (z.speed || 3)) * dt;
      const [nx, nz] = resolveCollision(z.pos.x + mx * sp, z.pos.z + mz * sp, 0.42 * z.scale, gy);
      const moved = Math.hypot(nx - z.pos.x, nz - z.pos.z);
      z.pos.x = nx; z.pos.z = nz;
      z.walkPhase = (z.walkPhase || 0) + moved * 6;
    }
    z.aimPitch = lerp(z.aimPitch || 0, Math.atan2((ty + 0.9) - (gy + 1.0 * z.scale), Math.max(td, 0.5)), 1 - Math.exp(-12 * dt));
    z.shootCd -= dt;
    const facing = Math.abs(angDiff(z.yaw, want)) < 0.3;
    const w = WEAPONS[z.fbiWeapon] || WEAPONS.rifle;
    // barrel discipline: the shot only leaves with a genuinely clear line (sees) — target
    // acquired, no drywall executions — then the shooter breaks for cover in a slide
    if (facing && sees && td < range * 1.4 && z.shootCd <= 0) {
      z.shootCd = (w.auto ? 0.26 : 0.62) + Math.random() * 0.2;
      fbiShoot(z, tx, ty, tz, _fbiT, td);
      // pick the cover: dive toward the nearest solid within 9m, or break sideways off
      // the firing line if the street is bare. Not every shot — every few.
      if (Math.random() < 0.4 && !z.bluga) {
        let sx = 0, sz2 = 0, bd = 81;
        for (const col of nearbyColliders(z.pos.x, z.pos.z)) {
          if (col.roof) continue;
          const dx2 = col.x - z.pos.x, dz2 = col.z - z.pos.z, d2 = dx2 * dx2 + dz2 * dz2;
          if (d2 > 0.6 && d2 < bd) { bd = d2; sx = dx2; sz2 = dz2; }
        }
        if (!sx && !sz2) { const side = Math.random() < 0.5 ? 1 : -1; sx = Math.cos(want) * side; sz2 = -Math.sin(want) * side; }
        const sl = Math.hypot(sx, sz2) || 1;
        z.slideVX = sx / sl; z.slideVZ = sz2 / sl; z.fbiSlideT = 0.5;
      }
    }
  } else z.aimPitch = lerp(z.aimPitch || 0, 0, 1 - Math.exp(-6 * dt));
  b.root.rotation.y = z.yaw;
  // pose: the gun arm tracks the aim, the off arm swings with the stride, legs walk
  b.arms[b.gunArm].rotation.x = -Math.PI / 2 - (z.aimPitch || 0) * 0.8 + (game.time - (z.lastShotT || -9) < 0.09 ? 0.3 : 0);
  const sw = Math.sin(z.walkPhase) * 0.5;
  b.arms[b.offArm].rotation.x = -sw * 0.7;
  b.legs[0].rotation.x = sw; b.legs[1].rotation.x = -sw;
  b.wob.scale.y = 1 + Math.sin((z.walkPhase || 0) * 2) * 0.03;
  placeShadow(b, z.pos.x, z.pos.z, gy);
  if (b.guardGlow) animateLootGlow(b.guardGlow, game.time + (z.walkPhase || 0));
}
// a fallen black-ops blob leaves ammo, and a perimeter guard has a 1-in-3 of dropping a BEST
// JELLY — the wave guards never do (see the spec: only the ones already on the perimeter)
function fbiOnDeath(z) {
  spawnPickup('ammo', z.pos.x + 0.3, z.pos.z);
  if (!z.fbiWave && !z.bluga && Math.random() < 0.33) spawnPickup('bestjelly', z.pos.x - 0.3, z.pos.z);
  if (z.bluga) onBlugaDefeated(z);
}
// ---------- the arena cameo ----------
// the opening beat of every prestige run, always in view from the spawn: Bluga stands on
// the Two Horned One's own ground (the open arena between the fountain and the bank
// steps) working a whole mob of walkers solo — moving, strafing, never missing — and he
// holds that ground until the mob is down. Then he turns to face you, wishes you Good
// Luck, and slide-HOPS north (the Blizzy direction, -z) faster than anyone could chase,
// gone into a smoke grenade. One time only; camDone locks it.
const FOUNTAIN = { x: 0, z: -28.2 };
const CAMEO_SPOT = { x: 0, z: -37.7 };   // the Two Horned One's waking ground
function maybeStartCameo() {
  if (bluga.phase !== 'idle' || bluga.camDone || !game.prestigeRun || net.role === 'client') return;
  if (game.time < 1.5 || bluga.boss) return; // no distance gate: the arena IS the view from spawn
  startCameo();
}
function startCameo() {
  bluga.phase = 'cameo'; bluga.camT = 0;
  const cx = CAMEO_SPOT.x, cz = CAMEO_SPOT.z;
  const blob = buildFbiBlob(BLUGA_FACE, true);
  const gun = buildGunMesh('smg'); blob.gunSocket.add(gun);
  blob.root.position.set(cx, groundHeight(cx, cz), cz);
  scene.add(blob.root);
  bluga.cameo = { blob, gunMesh: gun, pos: new THREE.Vector3(cx, 0, cz), yaw: 0, shootCd: 0, prey: [],
    wanderT: 0, wx: cx, wz: cz };
  // a proper mob, ringed all around him — the demonstration is the point
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.random() * 0.5, d = 6 + Math.random() * 4;
    bluga.cameo.prey.push(spawnZombie(cx + Math.sin(a) * d, cz + Math.cos(a) * d, 1, { mode: 'grave' }));
  }
  toast('WHO IS THAT BY THE FOUNTAIN .ᐟ', true);
  if (net.role === 'host') netBroadcast({ t: 'cam' }); // every screen gets the callout; the show itself streams (cm)
}
function updateCameo(dt) {
  const c = bluga.cameo; if (!c) return;
  bluga.camT += dt;
  const b = c.blob, gy = groundHeight(c.pos.x, c.pos.z);
  const t = bluga.camT;
  const alive = c.prey.filter(p => p && p.state !== 'dying');
  if (t < 7 && !(alive.length === 0 && t > 1.2)) {
    // the show: face the nearest live walker and put it down — while WORKING the ground,
    // strafing to a fresh spot every second or so, but never leaving the arena
    c.wanderT -= dt;
    if (c.wanderT <= 0) {
      c.wanderT = 0.9 + Math.random() * 0.8;
      const a = Math.random() * TAU, d = 1.5 + Math.random() * 4;
      c.wx = CAMEO_SPOT.x + Math.sin(a) * d; c.wz = CAMEO_SPOT.z + Math.cos(a) * d; // stays roughly on the Two Horned One's ground
    }
    const wd = Math.hypot(c.wx - c.pos.x, c.wz - c.pos.z);
    if (wd > 0.3) {
      const sp = 4.2 * dt;
      const [nx, nz] = resolveCollision(c.pos.x + (c.wx - c.pos.x) / wd * sp, c.pos.z + (c.wz - c.pos.z) / wd * sp, 0.5);
      c.walk = (c.walk || 0) + Math.hypot(nx - c.pos.x, nz - c.pos.z) * 6;
      c.pos.x = nx; c.pos.z = nz;
    }
    const sw = Math.sin(c.walk || 0) * 0.5;
    b.legs[0].rotation.x = sw; b.legs[1].rotation.x = -sw;
    let tgt = null, td = Infinity;
    for (const p of alive) { const d = Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z); if (d < td) { td = d; tgt = p; } }
    if (tgt) {
      const want = Math.atan2(tgt.pos.x - c.pos.x, tgt.pos.z - c.pos.z);
      c.yaw = angLerp(c.yaw, want, 1 - Math.exp(-10 * dt));
      c.shootCd -= dt;
      if (c.shootCd <= 0 && Math.abs(angDiff(c.yaw, want)) < 0.3) {
        c.shootCd = 0.22;
        _fbiFrom.set(c.pos.x, gy + 1.4, c.pos.z);
        if (c.gunMesh.userData.muzzle) c.gunMesh.userData.muzzle.getWorldPosition(_fbiFrom);
        _fbiTo.set(tgt.pos.x, tgt.blob.root.position.y + 0.8, tgt.pos.z);
        spawnTracer(_fbiFrom, _fbiTo);
        relayTracerFx('smg', _fbiFrom, _fbiTo); // the demonstration plays on every screen
        play3d(c.pos.x, c.pos.z, () => SFX.shoot(WEAPONS.smg));
        const d2 = td || 1;
        damageZombie(tgt, 40, (tgt.pos.x - c.pos.x) / d2, (tgt.pos.z - c.pos.z) / d2, 2, { isHead: false });
        b.arms[b.gunArm].rotation.x = -Math.PI / 2 + 0.25;
      }
    }
    c.showDone = t; // remember when the demonstration actually ended
  } else if (!c.greetT) {
    c.greetT = t;   // mob down (or the clock ran): the turn-and-greet starts NOW
  }
  if (c.greetT && t < c.greetT + 2.2) {
    // turn to you and wish you luck, gun lowered
    c.yaw = angLerp(c.yaw, Math.atan2(player.pos.x - c.pos.x, player.pos.z - c.pos.z), 1 - Math.exp(-8 * dt));
    b.arms[b.gunArm].rotation.x = lerp(b.arms[b.gunArm].rotation.x, -0.15, 1 - Math.exp(-8 * dt));
    b.legs[0].rotation.x = 0; b.legs[1].rotation.x = 0;
    if (!c.greeted && t > c.greetT + 0.7) { c.greeted = true; spawnBubble(() => ({ x: c.pos.x, y: groundHeight(c.pos.x, c.pos.z) + 3.4, z: c.pos.z }), 'Good Luck .ᐟ', c); SFX.pickup(); }
  } else if (c.greetT) {
    // the exit, the same every time: he walks up to the front of the bank, drops into a
    // slide dead straight through the bank's front door, and is gone INSIDE — no vanishing
    // on open street. He has access to this town's buildings; that's the whole point.
    const frontX = 0, frontZ = -39.4;   // the bank steps
    const doorX = 0, doorZ = -42.0;     // the bank's front door plane
    if (!c.exitPhase) c.exitPhase = 1;
    if (c.exitPhase === 1) {
      const dx = frontX - c.pos.x, dz = frontZ - c.pos.z, d = Math.hypot(dx, dz);
      c.yaw = angLerp(c.yaw, Math.atan2(dx, dz), 1 - Math.exp(-8 * dt));
      if (d > 0.4) {
        const step = Math.min(4.6 * dt, d);
        c.pos.x += dx / d * step; c.pos.z += dz / d * step;
        c.walk = (c.walk || 0) + step * 6;
        const sw2 = Math.sin(c.walk) * 0.5;
        b.legs[0].rotation.x = sw2; b.legs[1].rotation.x = -sw2;
        b.arms[b.gunArm].rotation.x = lerp(b.arms[b.gunArm].rotation.x, -0.15, 1 - Math.exp(-8 * dt)); // gun stays lowered
      } else c.exitPhase = 2;
    } else {
      // the slide: low on one hip, straight into the doorway
      const dx = doorX - c.pos.x, dz = doorZ - c.pos.z, d = Math.hypot(dx, dz) || 0.01;
      c.yaw = Math.atan2(dx, dz);
      c.pos.x += dx / d * 14 * dt; c.pos.z += dz / d * 14 * dt;
      b.wob.rotation.x = -0.7; b.legs[0].rotation.x = -1.2; b.legs[1].rotation.x = -1.3;
      if (d < 0.5) {
        // through the door and gone within the bank — just a wisp where he crossed the sill
        spawnParticles(c.pos.x, groundHeight(c.pos.x, c.pos.z) + 1.1, c.pos.z, 0x3a3a42, 10, 3, 1.2);
        play3d(c.pos.x, c.pos.z, () => noiseBurst(0.3, 300, 0.5));
        scene.remove(b.root); if (b.shadow) scene.remove(b.shadow);
        bluga.cameo = null; bluga.phase = 'idle'; bluga.camDone = true;
        return;
      }
    }
  }
  b.root.position.set(c.pos.x, groundHeight(c.pos.x, c.pos.z), c.pos.z); // feet on the ground through every phase (walk and slide both)
  b.root.rotation.y = c.yaw;
  placeShadow(b, c.pos.x, c.pos.z, groundHeight(c.pos.x, c.pos.z));
}
// ---------- Bluga's last stand at the Jelly House ----------
// on a prestige run the Rotten One's fall doesn't light grandma's porch — it lights BLUGA's.
// He's dug in around the Jelly House with a perimeter of black-ops guards, smoke-vanished
// until you cull them. Damage drags three waves of three spec-ops out of the surrounding
// dark; only when he finally drops does grandma's spirit come (spawnJellyMarks).
function spawnBlugaFinal() {
  if (bluga.boss) return;
  bluga.phase = 'final'; bluga.wave = 0;
  // his beam over the Jelly House — his own cold blue, so the trek still has a star to steer by
  const gy = groundHeight(JELLY.x, JELLY.z);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 220, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x2b3550, transparent: true, opacity: 0.32, fog: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
  beam.position.set(JELLY.x, gy + 100, JELLY.z);
  scene.add(beam); bluga.beam = beam;
  // Bluga himself, dead centre of her floor
  bluga.boss = spawnFbi(JELLY_G.x, JELLY_G.z - 2, { weapon: 'rifle', bluga: true });
  bluga.boss.vanished = true; bluga.boss.blob.root.visible = false;
  // the perimeter: black-ops guards ringing the house (these are the ones that drop BEST JELLY)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.4;
    const gx = JELLY.x + Math.sin(a) * 13, gz = JELLY.z + Math.cos(a) * 13;
    const [px, pz] = resolveCollision(gx, gz, 0.5);
    spawnFbi(px, pz, {});
  }
  dressBlugaBar();
  bossBarEl.classList.add('show');
  toast("BLUGA THE BAD BLOB .ᐟ CULL THE SQUAD TO UNMASK HIM .ᐟ", true);
  if (net.role === 'host') netBroadcast({ t: 'bluga' });
}
function dressBlugaBar() {
  bossLabelEl.textContent = 'Bluga the Bad Blob';
  bossBarEl.classList.remove('crimson', 'infected', 'rotten');
  bossBarEl.classList.add('bluga');
}
function blugaFireWave() {
  const n = ++bluga.wave;
  // three spec-ops out of the surrounding dark, all around the house
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * TAU, dist = 16 + Math.random() * 8;
    const gx = JELLY.x + Math.sin(a) * dist, gz = JELLY.z + Math.cos(a) * dist;
    const [px, pz] = resolveCollision(gx, gz, 0.5);
    spawnFbi(px, pz, { wave: true, mode: 'grave' });
  }
  toast(`WAVE ${n} .ᐟ SPEC OPS CLOSING IN .ᐟ`, true);
  play3d(JELLY.x, JELLY.z, () => noiseBurst(0.4, 260, 0.7));
}
function onBlugaDefeated(z) {
  bluga.boss = null; bluga.phase = 'done';
  if (bluga.beam) { scene.remove(bluga.beam); bluga.beam = null; }
  bossBarEl.classList.remove('show', 'bluga');
  for (const zz of [...zombies]) if (zz.fbi && zz.state !== 'dying') killZombie(zz, 0, 0, false);
  toast('BLUGA FALLS .ᐟ THE BLOCK IS FINALLY QUIET .ᐟ', true);
  for (let k = 0; k < 40; k++) spawnParticles(z.pos.x, z.blob.root.position.y + 2, z.pos.z, [0x6fd8ff, 0xf2c21a, 0xffffff][k % 3], 1, 6, 1.2);
  rumble(600, 1, 1);
  spawnJellyMarks();                          // NOW grandma's spirit comes
  if (net.role === 'host') netBroadcast({ t: 'jelly' });
}
// master tick: cameo script, then the final fight's waves + smoke-vanish + boss bar
function updateBluga(dt) {
  maybeStartCameo();
  if (bluga.phase === 'cameo') updateCameo(dt);
  const z = bluga.boss;
  if (!z || z.state === 'dying') return;
  // damage thresholds pull the waves (only once he's been unmasked and is taking hits)
  if (!z.vanished) {
    const taken = 1 - z.hp / z.maxHp;
    if (bluga.wave < 1 && taken >= 0.30) blugaFireWave();
    else if (bluga.wave < 2 && taken >= 0.55) blugaFireWave();
    else if (bluga.wave < 3 && taken >= 0.80) blugaFireWave();
  }
  // his bar tracks his health for the whole lobby; the beam fades once he first unmasks
  if (bossBarEl.classList.contains('show')) bossHpEl.style.width = clamp(z.hp / z.maxHp, 0, 1) * 100 + '%';
  if (bluga.beam) { bluga.beam.material.opacity = z.vanished ? 0.24 + Math.sin(performance.now() * 0.004) * 0.08 : Math.max(0, bluga.beam.material.opacity - dt * 0.2); }
}

// ---------- crows ----------
// scavengers that dress the block (ported from the alien-farm crows): they peck at
// sleeping zombies and flush the moment the meal stands up, circle in to perch on
// house roof ridges, and roost on the civic rooftops — a chattering row along the
// bank's portico edge, solos or pairs on the town hall and courthouse. Gunfire close
// flushes them wide; on foot you can steal in until you cross a bird's personal ring
// (red-beaks hold their nerve in the tightest ring, so you can get closest). A direct
// hit pops them like a headshot. The odd bird glares purple from spawn (no loot, purple
// blood); half of those — plus half the peckers — wear a pecker's bloodied beak and drip
// a stain wherever they set down. A red-beak that feeds 45s straight turns purple and
// lifts off sated. Once the Two Horned One falls every crow leaves the block for good.
const crows = [];
const CROW_FEATHER = 0x1b1b20;
const CROW_PURPLE_BLOOD = 0x9a2be0;
const CROW_EYE_NORMAL = 0xffd24a, CROW_EYE_PURPLE = 0xb04aff;
const CROW_GREY = 0x44444d;  // beak + legs: dark grey, a shade up from the feathers so they read
const CROW_GAP = 0.55;       // closest two crows ever stand: a row, never one inside another
let crowSpawnT = 2;
let crowsGone = false; // boss defeated: the flock departs, none return this run
let crowTargets = { bank: 4, hall: 2, court: 1 };

function buildCrow(x, y, z, roost) {
  const g = new THREE.Group();
  const blk = 0x15151a;
  const body = ball(1, blk); body.scale.set(0.21, 0.18, 0.33); body.position.y = 0.32; g.add(body);
  // charcoal breast puff: swells when the bird settles, tucks flat in flight
  const breast = ball(0.13, 0x2b2b33); breast.scale.set(0.13, 0.11, 0.1);
  breast.position.set(0, 0.3, 0.22); g.add(breast);
  const head = ball(0.16, blk); head.position.set(0, 0.52, 0.28); g.add(head);
  const beak = cyl(0.01, 0.06, 0.22, CROW_GREY, 5);
  beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.5, 0.48); g.add(beak);
  // long tail feathers: the root stays tucked under the body's back end, so the extra
  // length all runs out behind — the folded wingtips come to rest partway along it
  const tail = box(0.18, 0.04, 0.5, blk); tail.position.set(0, 0.32, -0.5); g.add(tail);
  // skinny legs filling the gap the floating body leaves: a shaft down to a foot of three
  // toes fanned forward and one hind toe back — along the bird, not across it. The whole
  // leg swings back under the tail once the wings open (see crowPose).
  const mkLeg = sgn => {
    const leg = new THREE.Group(); leg.position.set(0.075 * sgn, 0.15, 0.02);
    const shin = cyl(0.012, 0.015, 0.15, CROW_GREY, 4); shin.position.y = -0.075; leg.add(shin);
    const foot = new THREE.Group(); foot.position.y = -0.15; leg.add(foot);
    for (const t of [-0.36, 0, 0.36]) {          // three toes fanned forward
      const toe = box(0.018, 0.014, 0.11, CROW_GREY);
      toe.position.set(Math.sin(t) * 0.055, 0, 0.05);
      toe.rotation.y = t;
      foot.add(toe);
    }
    const hind = box(0.018, 0.014, 0.07, CROW_GREY); // and the one that grips backwards
    hind.position.set(0, 0, -0.035); foot.add(hind);
    g.add(leg);
    return leg;
  };
  const legL = mkLeg(1), legR = mkLeg(-1);
  // two-segment wings: a shoulder pivot that sweeps them back along the body, a roll group
  // inside it that turns the whole plane up onto its edge the way a real wing rotates as it
  // shuts, then shoulder panel + tip panel with splayed primary feathers
  const mkWing = sgn => {
    const piv = new THREE.Group(); piv.position.set(0.1 * sgn, 0.4, 0.02);
    const roll = new THREE.Group(); piv.add(roll);
    const inner = box(0.3, 0.045, 0.36, blk); inner.position.x = 0.15 * sgn;
    roll.add(inner);
    const tip = new THREE.Group(); tip.position.set(0.3 * sgn, 0, 0);
    const outer = box(0.28, 0.035, 0.3, blk); outer.position.set(0.13 * sgn, 0, -0.02);
    tip.add(outer);
    for (let f = 0; f < 3; f++) { // primary feather fingers on the trailing edge
      const fe = box(0.06, 0.028, 0.14, blk);
      fe.position.set((0.06 + f * 0.075) * sgn, 0, -0.2 + f * 0.025);
      tip.add(fe);
    }
    roll.add(tip); g.add(piv);
    return { piv, roll, tip };
  };
  const wl = mkWing(1), wr = mkWing(-1);
  const wingL = wl.piv, wingR = wr.piv;
  // most birds are born normal-eyed; the odd purple one (a veteran of the carcasses)
  // glares from spawn — and half of those still wear the pecker's bloodied beak
  const purple = Math.random() < 0.12;
  const eyeC = purple ? CROW_EYE_PURPLE : CROW_EYE_NORMAL;
  const eyes = [];
  for (const sx of [-0.07, 0.07]) {
    const e = ball(0.03, eyeC, { emissive: eyeC, emissiveIntensity: 0.6 });
    e.position.set(sx, 0.56, 0.4); g.add(e); eyes.push(e);
  }
  g.scale.setScalar(1 + Math.random() * 0.35);
  g.position.set(x, y, z);
  g.rotation.y = Math.random() * TAU;
  scene.add(g);
  const c = { g, wingL, wingR, rollL: wl.roll, rollR: wr.roll, tipL: wl.tip, tipR: wr.tip,
    legL, legR, breast, beak, eyes, purple, peckT: 0,
    fold: 1, redBeak: false, dropsBlood: false, roost: roost || null, target: null,
    state: 'perch', t: Math.random() * 5, headBob: Math.random() * TAU, flap: Math.random() * TAU,
    hopT: 0.6 + Math.random() * 2, hopFrom: null, hopTo: null, hopP: 1, flutterT: 0,
    ang: Math.random() * TAU, angSpd: 0.6, cx: x, cz: z, ra: 12, rb: 10,
    cruiseY: y + 12, flyT: 0, lx: x, ly: y, lz: z, leaveDir: 0 };
  if (purple && Math.random() < 0.5) crowRedBeak(c); // half the purples kept a pecker's beak
  c.nid = ++net.zid; // the flock streams to clients now: every bird wears a wire id
  crows.push(c);
  return c;
}
// one call poses the whole bird. `a` is the flap beat; `fold` 0..1 shuts it up for standing.
// Closing runs in two turns, which is what makes it read as a wing rather than a hinge: the
// plane first rolls up onto its edge (rollL/rollR, applied inside the shoulder), then the
// shoulder sweeps that edge back along the flank, so a standing crow wears its wings flat
// against its sides with the tips over the tail, instead of holding them out like a shelf.
// Legs swing back under the tail as it opens up, and the breast puffs out at rest.
function crowPose(c, a, fold) {
  // Mirroring a pose across the body negates the turns about Y and Z but NOT the one about
  // X — X is the axis being mirrored through. So the roll runs the same sign on both wings
  // (exactly as the legs below do) while only the sweep and the flap flip. Negating the roll
  // too turns that wing inside out: it stands up over the bird's back instead of tucking
  // down its flank.
  c.rollL.rotation.x = c.rollR.rotation.x = -fold * 1.45;
  c.wingL.rotation.set(0, fold * 1.5, a - fold * 0.12);
  c.wingR.rotation.set(0, -fold * 1.5, -a + fold * 0.12);
  c.tipL.rotation.z = a * 0.55; c.tipR.rotation.z = -a * 0.55;
  c.tipL.rotation.y = fold * 0.45; c.tipR.rotation.y = -fold * 0.45;
  c.legL.rotation.x = (1 - fold) * 1.2; c.legR.rotation.x = (1 - fold) * 1.2;
  const puff = 1 + fold * 0.45 + Math.sin(c.t * 2.2) * fold * 0.06; // slow breathing at rest
  c.breast.scale.set(0.13 * puff, 0.11 * puff, 0.1 * (0.7 + fold * 0.55));
}
// where a crow is standing, or the spot it has already committed to. A bird gliding down
// owns its slot before it gets there, so two can't pick the same gap in the same breath.
function crowClaim(c) {
  if (c.state === 'descend') return { x: c.lx, y: c.ly, z: c.lz };
  if (c.hopP < 1 && c.hopTo) return { x: c.hopTo.x, y: c.hopTo.y != null ? c.hopTo.y : c.ly, z: c.hopTo.z };
  return { x: c.g.position.x, y: c.ly, z: c.g.position.z };
}
function crowNearestD(x, y, z, ignore) {
  let best = Infinity;
  for (const o of crows) {
    if (o === ignore || o.state === 'fly' || o.state === 'leave') continue;
    const q = crowClaim(o);
    if (Math.abs(q.y - y) > 0.6) continue;   // different roof entirely — no argument
    best = Math.min(best, Math.hypot(q.x - x, q.z - z));
  }
  return best;
}
// roll for a spot nobody else has. `orBest` takes the roomiest roll when they're all
// crowded — a bird already committed to landing has to go somewhere; one merely thinking
// about a sidestep gets null instead and just stays where it is. `from` is a hop's take-off
// point: the midpoint gets checked too, so it can't hop clean through the neighbour it's
// trying to get around to reach open rail on the far side.
function crowSpot(gen, ignore, orBest, from) {
  let best = null, bestD = -1;
  for (let i = 0; i < 10; i++) {
    const s = gen();
    let d = crowNearestD(s.x, s.y, s.z, ignore);
    if (from) d = Math.min(d, crowNearestD((from.x + s.x) / 2, s.y, (from.z + s.z) / 2, ignore));
    if (d >= CROW_GAP) return s;
    if (d > bestD) { bestD = d; best = s; }
  }
  return orBest ? best : null;
}
function removeCrow(c) {
  const i = crows.indexOf(c);
  if (i < 0) return;
  scene.remove(c.g);
  c.g.traverse(o => { if (o.geometry && o.geometry !== BOX && o.geometry !== SPHERE) o.geometry.dispose(); });
  crows.splice(i, 1);
}
// the three civic roosts: portico slab front edges (crows face out over the street)
function townRoosts() {
  if (!townRoosts.list) townRoosts.list = [
    { tag: 'bank',  x: 0,  y: groundHeight(0, -50.2) + 8.6 + 0.3, z: -40.1, hw: 9, face: 0 },
    { tag: 'hall',  x: 85, y: groundHeight(85, -2) + 7 + 0.3, z: -10.6, hw: 7, face: Math.PI },
    { tag: 'court', x: 85, y: groundHeight(85, -34) + 6.5 + 0.3,  z: -25.9, hw: 7, face: 0 },
  ];
  return townRoosts.list;
}
function roostSlot(r) { return { x: r.x + (Math.random() * 2 - 1) * r.hw, y: r.y, z: r.z }; }
// a loaded chunk-house roof ridge in the mid distance to glide onto
function pickHouseRoost() {
  const ccx = Math.round(player.pos.x / CHUNK), ccz = Math.round(player.pos.z / CHUNK);
  const cands = [];
  const R = settings.viewR;
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    const key = chunkKey(ccx + dx, ccz + dz);
    const ch = chunks.get(key);
    if (!ch || !ch.buildings) continue;
    for (const b of ch.buildings) {
      if (b.roofY == null) continue;
      const d = Math.hypot(b.x - player.pos.x, b.z - player.pos.z);
      if (d > 16 && d < 75) cands.push({ tag: 'house', x: b.x, y: b.roofY, z: b.z, hw: b.ridgeHW, face: null, key });
    }
  }
  return cands.length ? cands[(Math.random() * cands.length) | 0] : null;
}
// spawn already airborne, circle the roost briefly, then glide down onto it
function crowFliesIn(roost) {
  const s = crowSpot(() => roostSlot(roost), null, true);
  const ang = Math.random() * TAU;
  const c = buildCrow(s.x + Math.sin(ang) * 30, s.y + 9 + Math.random() * 8, s.z + Math.cos(ang) * 30, roost);
  c.state = 'fly';
  c.cx = s.x; c.cz = s.z;
  c.cruiseY = s.y + 8 + Math.random() * 6;
  c.ra = 13 + Math.random() * 8; c.rb = 10 + Math.random() * 7;
  c.angSpd = (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.3);
  c.ang = Math.atan2(c.g.position.z - c.cz, c.g.position.x - c.cx);
  c.flyT = 2 + Math.random() * 4;
  c.lx = s.x; c.ly = s.y; c.lz = s.z;
  if (Math.random() < 0.6) crowCaw(c.g.position.x, c.g.position.z, 'idle'); // announces itself inbound
  return c;
}
// what a pecker will drop onto: a sleeper or an already-dead carcass, still on the block.
// The carcass is the prize — it never wakes, so the bird can feed all the way to its turn.
function peckable(z) { return !!z && (z.state === 'sleep' || z.state === 'corpse') && zombies.includes(z); }
// drop 1-2 crows straight onto the ground beside a laying zombie to pick at it
function spawnPeckers() {
  const cands = [];
  for (const z of zombies) {
    if (z.state !== 'sleep' && z.state !== 'corpse') continue;
    const d = Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
    if (d < 26 || d > 72) continue; // close enough to see, far enough not to wake it
    if (crows.filter(c => c.target === z).length >= 2) continue;
    cands.push(z);
  }
  if (!cands.length) return;
  const zz = cands[(Math.random() * cands.length) | 0];
  // crows are drawn to rot — a zombie they pick over gets the rot roll if it isn't
  // already carrying the Rotten One's marks from spawn
  if (!zz.rotE && !zz.rotR && !zz.rotB) {
    const re = Math.random() < 0.28, rr = Math.random() < 0.26, rb = Math.random() < 0.3;
    if (re || rr || rb) {
      addRotGore(zz.blob, { hangEye: re, ribs: rr, belly: rb, eyeSide: Math.random() < 0.5 ? 1 : -1 });
      zz.rotE = re; zz.rotR = rr; zz.rotB = rb;
    }
  }
  const n = 1 + (Math.random() < 0.45 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    // the pair drop either side of the meal, never both onto the same patch of it
    const s = crowSpot(() => {
      const ang = Math.random() * TAU, d = 0.8 + Math.random() * 0.9;
      const x = zz.pos.x + Math.sin(ang) * d, z = zz.pos.z + Math.cos(ang) * d;
      return { x, y: groundHeight(x, z), z };
    }, null, true);
    const x = s.x, z2 = s.z;
    const c = buildCrow(x, groundHeight(x, z2), z2, null);
    c.state = 'peck'; c.target = zz; c.ly = c.g.position.y;
    c.g.rotation.y = Math.atan2(zz.pos.x - x, zz.pos.z - z2); // face the meal
    if (Math.random() < 0.5) { // half the peckers have been at it a while: bloodied beak
      crowRedBeak(c);
      c.dropsBlood = Math.random() < 0.5; // and half of those carry a drip off with them
    }
  }
}
// crow voice, all in 3D: every caw is 1-3 short square rasps that pitch-fall like the
// real bird, with pitch/length/syllable jitter so no two land the same. Kinds cue what
// the bird is doing: 'idle' perch/peck chatter, 'alarm' the sharp fast flush cry,
// 'land' a low double as it settles, 'die' one strangled squawk cut off at the top.
function crowCaw(x, z, kind = 'idle') {
  const K = {
    idle:  { n: 1 + ((Math.random() * 3) | 0), f: 640, j: 170, len: 0.11, gap: 155, g: 0.05 },
    alarm: { n: 2 + ((Math.random() * 2) | 0), f: 780, j: 170, len: 0.075, gap: 90, g: 0.06 },
    land:  { n: 2, f: 540, j: 90, len: 0.13, gap: 175, g: 0.045 },
    die:   { n: 1, f: 900, j: 140, len: 0.16, gap: 0, g: 0.07 },
  }[kind] || { n: 2, f: 700, j: 140, len: 0.1, gap: 100, g: 0.05 };
  const base = K.f + Math.random() * K.j;
  for (let i = 0; i < K.n; i++) {
    const fall = base * (1 - i * 0.07) + Math.random() * 40; // each rasp a shade lower
    setTimeout(() => play3d(x, z, () => tone(fall, K.len * (1 - i * 0.1), K.g, 'square', fall * 0.55)),
      i * (K.gap + Math.random() * 45));
  }
}
function crowTakeoff(c) {
  if (c.state === 'fly' || c.state === 'leave') return;
  const p = c.g.position;
  // a bloodied pecker sheds a droplet as it lifts off its meal
  if (c.state === 'peck' && c.dropsBlood && goreAmt() > 0.02)
    spawnParticles(p.x, p.y + 0.45, p.z, BLOOD, 1, 1.2, 0.55);
  // every red-beak carries off a scrap and drops it as it goes
  if (c.redBeak) crowDropGib(p.x, p.z, c.purple);
  c.state = 'fly'; c.target = null; c.hopP = 1;
  c.cx = p.x + (Math.random() - 0.5) * 12; c.cz = p.z + (Math.random() - 0.5) * 12;
  c.ra = 13 + Math.random() * 8; c.rb = 10 + Math.random() * 7;
  c.cruiseY = Math.max(p.y + 7, groundHeight(p.x, p.z) + 11) + Math.random() * 5;
  c.angSpd = (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.3);
  c.ang = Math.atan2(p.z - c.cz, p.x - c.cx);
  c.flyT = 6 + Math.random() * 7;
  spawnParticles(p.x, p.y + 0.35, p.z, CROW_FEATHER, 4, 2, 0.45); // feather puff
  crowCaw(p.x, p.z, 'alarm'); // the flush cry is the cue — every takeoff sounds off
}
// gunfire / impacts near perched or pecking crows flush them
function scareCrows(x, z, r) {
  if (net.role === 'client') return; // ghost birds take their cues from the stream (the host flushes for everyone — see the pew hook)
  if (!crows.length) return;
  const r2 = r * r;
  for (const c of crows) {
    if (c.state === 'fly' || c.state === 'leave') continue;
    const dx = c.g.position.x - x, dz = c.g.position.z - z;
    if (dx * dx + dz * dz < r2) crowTakeoff(c);
  }
}
// shared crow hit-sphere: the bullet and the crosshair flare read from the exact same
// volume, so if the X lights up on a bird the shot connects. Generous and consistent in
// every state (perched, landed, mid-hop, taking off, in flight) — crows have no
// invincibility frames and gib from first contact the instant they're under the aim.
function crowRayT(ox, oy, oz, dx, dy, dz, cw) {
  if (cw.shotPending) return Infinity; // a ghost already claimed by our shot: no double taps
  const cs = cw.g.scale.x;
  const airborne = cw.state === 'fly' || cw.state === 'leave' || cw.state === 'descend';
  const r = (airborne ? 0.85 : 0.7) * cs; // wings-out flight silhouette is a touch wider
  return raySphere(ox, oy, oz, dx, dy, dz, cw.g.position.x, cw.g.position.y + 0.4 * cs, cw.g.position.z, r);
}
// the bloodied beak of a bird that's been at a carcass — worn by half the peckers and
// half the purples (they were peckers once)
function crowRedBeak(c) { c.redBeak = true; c.beak.material = mat(0x9c1414); }
// a red-beak drips where it sets down: a small ground stain and a fleck or two, so it
// reads as having just stepped off a kill. Honours the gore setting (nothing on a clean run).
function crowLandBleed(x, y, z) {
  if (goreAmt() <= 0.02) return;
  groundSplat(x, z, 0.22 + Math.random() * 0.16);
  spawnParticles(x, y + 0.2, z, BLOOD, 2, 1.4, 0.5);
}
// a red-beak tears off a scrap of the carcass and lets it fall as it leaves — usually a
// near-instant drop right by the meal, but if it holds on climbing it can let go from up
// around roof height. A wet gib that sprays blood the whole way down (purple birds spill purple).
function crowDropGib(x, z, purple) {
  if (goreAmt() <= 0.02 || gibs.length > 60) return;
  const h = 0.35 + Math.pow(Math.random(), 3) * 5.2; // weighted low, a small tail up to the roof
  const y = groundHeight(x, z) + h;
  const col = purple ? CROW_PURPLE_BLOOD : BLOOD;
  const m = new THREE.Mesh(gibGeo, mat(col));
  m.position.set(x, y, z); m.scale.setScalar(0.55 + Math.random() * 0.6);
  scene.add(m);
  gibs.push({ mesh: m, life: 3 + Math.random() * 2, bled: false,
    vx: (Math.random() - 0.5) * 1.6, vy: -1 - Math.random() * 1.5, vz: (Math.random() - 0.5) * 1.6,
    spin: (Math.random() - 0.5) * 12 });
  spawnParticles(x, y, z, col, 3, 2, 0.5); // the spray as it lets go
}
// a red-beak that's fed long enough turns: eyes glow purple and from this moment its
// blood and gib spill purple crow (killCrow keys off c.purple), and it gives up no loot.
// The caller lifts it off right after — sated, it abandons the meal.
function crowGoPurple(c) {
  if (c.purple) return;
  c.purple = true;
  for (const e of c.eyes) e.material = mat(CROW_EYE_PURPLE, { emissive: CROW_EYE_PURPLE, emissiveIntensity: 0.6 });
}
// a clean hit pops a crow like a headshot: burst, feathers, one tumbling scrap
function killCrow(c, kx, kz, dmg) {
  const p = c.g.position;
  spawnDamageNumber(p.x, p.y + 0.6, p.z, dmg);
  const bloodC = c.purple ? CROW_PURPLE_BLOOD : BLOOD;
  const n = Math.round(6 * goreAmt());
  if (n > 0) spawnParticles(p.x, p.y + 0.35, p.z, bloodC, n, 3, 0.5);
  spawnParticles(p.x, p.y + 0.35, p.z, CROW_FEATHER, 6, 2.5, 0.6);
  spawnGib(p.x, p.y + 0.3, p.z, c.purple ? CROW_PURPLE_BLOOD : CROW_FEATHER, kx, kz);
  crowCaw(p.x, p.z, 'die'); // one strangled squawk, cut off at the top
  // shot crows shake loose a little reward that drops from where they were hit —
  // except the purple ones, which give up nothing and stay a mystery
  if (!c.purple) spawnPickup(Math.random() < 0.7 ? 'ammo' : 'medkit', p.x, p.z, p.y + 0.3);
  removeCrow(c);
}
// boss down: the whole murder lifts off and leaves the block, and no more spawn
function crowsLeave() {
  crowsGone = true;
  for (const c of crows) {
    if (c.state === 'leave') continue;
    const p = c.g.position;
    if (c.state !== 'fly') spawnParticles(p.x, p.y + 0.35, p.z, CROW_FEATHER, 3, 2, 0.4);
    c.state = 'leave';
    c.leaveDir = Math.atan2(p.x - 47, p.z - 2) + (Math.random() - 0.5) * 0.7; // scatter away from town
    if (Math.random() < 0.5) crowCaw(p.x, p.z, 'alarm');
  }
}
function resetCrows() {
  while (crows.length) removeCrow(crows[crows.length - 1]);
  crowsGone = false;
  crowSpawnT = 2;
  townRoosts.list = null; // terrain-height cache is cheap to rebuild
  crowTargets = {
    bank: 3 + ((Math.random() * 3) | 0),          // an animated group on the bank edge
    hall: 1 + (Math.random() < 0.5 ? 1 : 0),      // solo or pair
    court: 1 + (Math.random() < 0.5 ? 1 : 0),
  };
}
function updateCrows(dt) {
  // a client's flock is the HOST's flock: no local spawning or brains — just fly the
  // streamed ghosts smoothly between the 10Hz marks (airborne birds flap on the flight
  // beat, grounded ones fold up and breathe), so every screen watches the same murder
  if (net.role === 'client') {
    const k = 1 - Math.exp(-8 * dt);
    for (const c of crows) {
      c.t += dt;
      if (c.tx != null) {
        c.g.position.x = lerp(c.g.position.x, c.tx, k);
        c.g.position.y = lerp(c.g.position.y, c.ty, k);
        c.g.position.z = lerp(c.g.position.z, c.tz, k);
        c.g.rotation.y = angLerp(c.g.rotation.y, c.tyw || 0, k);
      }
      c.foldT = lerp(c.foldT != null ? c.foldT : 1, c.air ? 0 : 1, 1 - Math.exp(-6 * dt));
      c.flap += dt * (c.air ? 16 : 2.2);
      crowPose(c, Math.sin(c.flap) * (c.air ? 0.9 : 0.05), c.foldT);
    }
    return;
  }
  // trickle spawner: top up the civic roosts, a few house-ridge sitters, and peckers
  if (!crowsGone) {
    crowSpawnT -= dt;
    if (crowSpawnT <= 0) {
      crowSpawnT = 4 + Math.random() * 5;
      let spawned = false;
      for (const r of townRoosts()) {
        const have = crows.filter(c => c.roost && c.roost.tag === r.tag).length;
        const want = crowTargets[r.tag];
        // an empty roost refills as a little flock so groups read as groups
        for (let i = have; i < want && i < have + 3; i++) { crowFliesIn(r); spawned = true; }
        if (spawned) break;
      }
      if (!spawned && crows.filter(c => c.roost && c.roost.tag === 'house').length < 3 && Math.random() < 0.6) {
        const r = pickHouseRoost();
        if (r) { crowFliesIn(r); spawned = true; }
      }
      if (!spawned && crows.filter(c => c.target).length < 4 && Math.random() < 0.75) spawnPeckers();
      if (spawned) crowSpawnT = 2 + Math.random() * 2; // keep filling while under target
    }
  }
  for (let i = crows.length - 1; i >= 0; i--) {
    const c = crows[i], g = c.g;
    c.t += dt;
    // house roost's chunk streamed out: the roof is gone and so is the player — vanish quietly
    if (c.roost && c.roost.key && !chunks.has(c.roost.key)) { removeCrow(c); continue; }
    // an on-foot approach spooks a settled bird once the player crosses its personal
    // space — red-beaks hold their nerve in a tighter ring, so you can steal right up on
    // one before it bolts (gunfire still flushes everything wide through scareCrows)
    if ((c.state === 'perch' || c.state === 'peck') && !player.dead) {
      const fr = c.redBeak ? 3.5 : 7.5;
      const dx = g.position.x - player.pos.x, dy = g.position.y - player.pos.y, dz = g.position.z - player.pos.z;
      if (dx * dx + dy * dy + dz * dz < fr * fr) { crowTakeoff(c); continue; }
    }
    if (c.state === 'fly') {
      c.flyT -= dt; c.ang += c.angSpd * dt;
      const tx = c.cx + Math.cos(c.ang) * c.ra, tz = c.cz + Math.sin(c.ang) * c.rb;
      const px = g.position.x, pz = g.position.z, k = 1 - Math.pow(0.02, dt);
      g.position.x = lerp(px, tx, k); g.position.z = lerp(pz, tz, k);
      g.position.y = lerp(g.position.y, c.cruiseY + Math.sin(game.time * 1.3 + c.flap) * 0.6, 1 - Math.pow(0.05, dt));
      const vx = g.position.x - px, vz = g.position.z - pz;
      if (Math.hypot(vx, vz) > 1e-3) g.rotation.y = Math.atan2(vx, vz);
      g.rotation.z = clamp(-c.angSpd * 0.5, -0.5, 0.5); g.rotation.x = -0.12; // bank into the turn
      c.fold = Math.max(0, c.fold - dt * 4);
      crowPose(c, Math.sin(c.t * 16) * 0.9, c.fold);
      if (c.flyT <= 0) {
        if (c.roost) {
          // claim a gap on the rail nobody's already standing in or gliding down to
          const s = crowSpot(() => roostSlot(c.roost), c, true);
          c.lx = s.x; c.ly = s.y; c.lz = s.z; c.state = 'descend';
        } else if (peckable(c.target)) {
          const s = crowSpot(() => {
            const ang = Math.random() * TAU, d = 0.8 + Math.random() * 0.9;
            const x = c.target.pos.x + Math.sin(ang) * d, z = c.target.pos.z + Math.cos(ang) * d;
            return { x, y: groundHeight(x, z), z };
          }, c, true);
          c.lx = s.x; c.ly = s.y; c.lz = s.z; c.state = 'descend';
        } else {
          // nowhere to go back to — drift off the block
          c.state = 'leave';
          c.leaveDir = Math.atan2(g.position.x - player.pos.x, g.position.z - player.pos.z) + (Math.random() - 0.5) * 0.6;
        }
      }
    } else if (c.state === 'descend') {
      const k = 1 - Math.pow(0.04, dt);
      g.position.x = lerp(g.position.x, c.lx, k); g.position.z = lerp(g.position.z, c.lz, k);
      g.position.y = lerp(g.position.y, c.ly + 0.02, 1 - Math.pow(0.06, dt));
      const dx = c.lx - g.position.x, dz = c.lz - g.position.z;
      if (Math.hypot(dx, dz) > 1e-3) g.rotation.y = Math.atan2(dx, dz);
      g.rotation.z = lerp(g.rotation.z, 0, k); g.rotation.x = lerp(g.rotation.x, 0.2, k); // flare
      c.fold = Math.max(0, c.fold - dt * 4);
      crowPose(c, Math.sin(c.t * 10) * 0.7, c.fold);
      if (Math.hypot(dx, dz) < 0.35 && Math.abs(g.position.y - c.ly) < 0.14) {
        c.state = c.roost ? 'perch' : 'peck';
        if (c.redBeak) crowLandBleed(c.lx, c.ly, c.lz); // a bloodied bird drips as it sets down
        if (Math.random() < 0.5) crowCaw(c.lx, c.lz, 'land'); // low double as it settles
        c.hopT = 1 + Math.random() * 3; c.hopP = 1;
        g.rotation.set(0, c.roost && c.roost.face != null ? c.roost.face + (Math.random() - 0.5) * 0.5 : g.rotation.y, 0);
        g.position.set(c.lx, c.ly, c.lz);
      }
    } else if (c.state === 'leave') {
      g.position.x += Math.sin(c.leaveDir) * 13 * dt;
      g.position.z += Math.cos(c.leaveDir) * 13 * dt;
      g.position.y += 5.5 * dt;
      g.rotation.y = c.leaveDir; g.rotation.x = -0.25; g.rotation.z = 0;
      c.fold = Math.max(0, c.fold - dt * 4);
      crowPose(c, Math.sin(c.t * 15) * 0.9, c.fold);
      if (Math.hypot(g.position.x - player.pos.x, g.position.z - player.pos.z) > 150) removeCrow(c);
    } else if (c.state === 'peck') {
      // meal woke / got dragged into the fight / despawned → flush (a carcass never wakes)
      if (!peckable(c.target)) { crowTakeoff(c); continue; }
      // a pecker that feeds uninterrupted turns purple and lifts off sated — a red-beak
      // holds out 45s, a plain bird only 20s. The static carcasses let them finish.
      if (!c.purple) {
        c.peckT += dt;
        if (c.peckT >= (c.redBeak ? 45 : 20)) { crowGoPurple(c); crowTakeoff(c); continue; }
      }
      c.fold = Math.min(1, c.fold + dt * 2.5);
      crowPose(c, 0, c.fold);
      if (c.hopP < 1) {
        c.hopP = Math.min(1, c.hopP + dt * 3);
        g.position.x = lerp(c.hopFrom.x, c.hopTo.x, c.hopP);
        g.position.z = lerp(c.hopFrom.z, c.hopTo.z, c.hopP);
        g.position.y = lerp(c.hopFrom.y, c.hopTo.y, c.hopP) + Math.sin(c.hopP * Math.PI) * 0.3;
        const dx = c.hopTo.x - c.hopFrom.x, dz = c.hopTo.z - c.hopFrom.z;
        if (Math.hypot(dx, dz) > 1e-3) g.rotation.y = Math.atan2(dx, dz);
      } else {
        c.headBob += dt * 6;
        g.position.y = c.ly;
        g.rotation.x = Math.sin(c.headBob) * 0.18 + 0.05; // pecking at the sprawl
        c.hopT -= dt;
        if (c.hopT <= 0) {
          c.hopT = 0.7 + Math.random() * 1.6;
          if (Math.random() < 0.25) crowCaw(g.position.x, g.position.z, 'idle'); // a rasp between mouthfuls
          // hop around the body, staying within pecking reach — and never onto the bird
          // already eating there. Boxed in on every roll, it just keeps its mouthful.
          const s = crowSpot(() => {
            const ang = Math.atan2(c.target.pos.x - g.position.x, c.target.pos.z - g.position.z) + (Math.random() - 0.5) * 2.4;
            const step = 0.4 + Math.random() * 0.7;
            let nx = g.position.x + Math.sin(ang) * step, nz = g.position.z + Math.cos(ang) * step;
            if (Math.hypot(nx - c.target.pos.x, nz - c.target.pos.z) > 2) {
              nx = c.target.pos.x + (nx - c.target.pos.x) * 0.5;
              nz = c.target.pos.z + (nz - c.target.pos.z) * 0.5;
            }
            return { x: nx, y: groundHeight(nx, nz), z: nz };
          }, c, false, g.position);
          if (s) {
            c.hopFrom = { x: g.position.x, y: c.ly, z: g.position.z };
            c.hopTo = { x: s.x, y: s.y, z: s.z };
            c.hopP = 0; c.ly = c.hopTo.y;
          }
        }
      }
    } else { // perch: folded wings, idle nods, edge shuffles, the odd wing flutter
      if (c.flutterT > 0) {
        c.flutterT -= dt;
        c.fold = Math.max(0.2, c.fold - dt * 5); // wings half-unfurl for the flutter
        crowPose(c, Math.sin(c.t * 18) * 0.7, c.fold);
      } else {
        c.fold = Math.min(1, c.fold + dt * 2.5);
        crowPose(c, 0, c.fold);
        if (Math.random() < dt * 0.12) {
          c.flutterT = 0.4 + Math.random() * 0.4;
          // half the flutters come with chatter — the roost row talks over the block
          if (Math.random() < 0.5) crowCaw(g.position.x, g.position.z, 'idle');
        }
      }
      c.headBob += dt * (1.6 + Math.sin(c.flap) * 0.4);
      g.rotation.x = Math.max(0, Math.sin(c.headBob)) * 0.22; // peckish nods
      if (c.hopP < 1) {
        c.hopP = Math.min(1, c.hopP + dt * 3.2);
        g.position.x = lerp(c.hopFrom.x, c.hopTo.x, c.hopP);
        g.position.z = lerp(c.hopFrom.z, c.hopTo.z, c.hopP);
        g.position.y = c.ly + Math.sin(c.hopP * Math.PI) * 0.22;
      } else {
        g.position.y = c.ly;
        c.hopT -= dt;
        if (c.hopT <= 0) {
          c.hopT = 2.5 + Math.random() * 5;
          if (c.roost && Math.random() < 0.7) {
            // sidestep along the edge/ridge, staying on it — and never into the neighbour.
            // A bird hemmed in on both sides holds its place instead of shoving through.
            const s = crowSpot(() => {
              const nx = clamp(g.position.x + (Math.random() - 0.5) * 1.6, c.roost.x - c.roost.hw, c.roost.x + c.roost.hw);
              return { x: nx, y: c.ly, z: c.roost.z != null && c.roost.tag !== 'house' ? c.roost.z : g.position.z };
            }, c, false, g.position);
            if (s) {
              c.hopFrom = { x: g.position.x, z: g.position.z };
              c.hopTo = { x: s.x, z: s.z };
              c.hopP = 0;
              if (c.roost.face == null) g.rotation.y = Math.atan2(s.x - g.position.x, 0) + (Math.random() - 0.5) * 0.8;
            }
          }
        }
      }
    }
  }
}

// the plaza fountain runs: droplets spill off the bowl and loop, ripples widen across the
// pool, a glint circles the pedestal base, and a ring keeps contracting into the back drain
function updateFountain(dt) {
  const F = fountainFx;
  if (!F) return;
  for (const d of F.fdrops) {
    d.y -= d.sp * dt;
    if (d.y <= F.waterY + 0.04) d.y = F.top - Math.random() * 0.12;
    d.m.position.y = d.y;
  }
  for (const r of F.fripples) {
    r.t = (r.t + dt * 0.5) % 1;
    r.m.scale.setScalar(0.5 + r.t * 2.1);
    r.m.material.opacity = 0.42 * (1 - r.t);
  }
  // the puddle is a closed ring now, so spinning it would be work nobody can see — it just
  // breathes instead
  F.puddle.material.opacity = 0.2 + Math.sin(performance.now() * 0.0015) * 0.08;
  // the drain ring shrinks inward, then snaps back out — water sliding in
  F.drainRing.__t = ((F.drainRing.__t || 0) + dt * 0.8) % 1;
  const dt2 = F.drainRing.__t;
  F.drainRing.scale.setScalar(1.9 - dt2 * 1.5);
  F.drainRing.material.opacity = 0.4 * dt2;
}
function updateCrates(dt) {
  for (let i = allCrates.length - 1; i >= 0; i--) {
    const cr = allCrates[i];
    cr.t += dt;
    if (!cr.opened) {
      cr.trim.material.emissiveIntensity = 0.4 + Math.sin(cr.t * 3) * 0.3;
      animateLootGlow(cr.glow, cr.t);
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
    if (p.falling) { // crow drops tumble down from the kill and settle on whatever is below
      p.vy -= 22 * dt;
      p.y += p.vy * dt;
      if (p.y <= p.restY) { p.y = p.restY; p.falling = false; }
      p.mesh.position.y = p.y;
    } else {
      p.mesh.position.y = p.restY + 0.1 + Math.sin(p.t * 3) * 0.08;
    }
    p.mesh.rotation.y += dt * 2;
    const d = Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z);
    if (d < 1.1 && Math.abs(p.mesh.position.y - player.pos.y) < 2.2 && !player.dead) {
      // a host drop seen through the stream: ASK the host for it (its world owns the loot);
      // the grant comes back as pkGive and the ghost leaves with the next snapshot. Pre-check
      // what we can actually take, so a full hand never wastes the jar on the host's side.
      if (p.netGhost) {
        p.reqT = (p.reqT || 0) - dt;
        if (p.reqT <= 0) {
          if (p.kind === 'bestjelly' && (player.owned.includes('jelly') || player.owned.includes('chili') || playerGiantAny())) continue;
          if (p.kind === 'ammo' && player.weapon.melee) continue;
          p.reqT = 0.6;
          try { net.conns[0].send({ t: 'pkTake', i: p.nid }); } catch (e) {}
        }
        continue;
      }
      if (p.kind === 'bestjelly') {
        // the good stuff off a black-ops guard: the jelly consumable, but only if a hand is free
        if (player.owned.includes('jelly') || player.owned.includes('chili')) continue; // one consumable at a time
        if (playerGiantAny()) continue;
        equipWeapon('jelly');
        toast('BEST JELLY .ᐟ BEST JELLY STOPS THE ROT .ᐟ', true);
        spawnParticles(player.pos.x, player.pos.y + 1.4, player.pos.z, 0xb06fff, 14, 4, 0.8);
      } else if (p.kind === 'ammo' && !player.weapon.melee) {
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
  // a chili giant carries the whole rig up and back with the body, so boss-sized still frames
  const gs = player.giantScale || 1;
  const rightX = Math.cos(cy), rightZ = -Math.sin(cy);
  const shoulder = 0.7 * (1 - aimT * 0.35) * gs;
  const pivotX = player.pos.x + rightX * shoulder;
  const pivotY = player.pos.y + 1.5 * gs;
  const pivotZ = player.pos.z + rightZ * shoulder;
  // ground-cam flare, settled last frame: as the rig gets shoved into the dirt it also
  // pulls in tight, so the widening lens below reads as a dolly zoom rather than a plain
  // FOV bump (see the flare block after the ground clamp). Pulling in shortens the rig,
  // which eases the very shove that drives the flare — keep this gentle or that loop
  // gains enough to breathe.
  const gcPrev = player.groundCamT;
  const tpDist = camDist * (1 - aimT * 0.5) * (1 - gcPrev * 0.42) * (1 + (gs - 1) * 0.75); // pull in harder as the rig meets the dirt; ease back for a giant
  const tpX = pivotX + Math.sin(cy) * Math.cos(cp) * tpDist;
  const tpY = pivotY - Math.sin(cp) * tpDist;
  const tpZ = pivotZ + Math.cos(cy) * Math.cos(cp) * tpDist;
  // ---- first-person eye + forward look ----
  // the slightest head bob: a dip on each footfall (walkPhase turns over twice a stride) and
  // a slow sway across the whole stride. Kept under a centimetre and a half — enough that
  // walking has a pulse, not so much that the sights swim. Third person never gets it: that
  // rig is already alive out there, and doubling it up would just read as a wobbly camera.
  const bob = player.bobT;
  const bobY = Math.sin(player.walkPhase * 2) * 0.014 * bob;
  const bobX = Math.sin(player.walkPhase) * 0.011 * bob;
  const fwdX = -Math.sin(cy) * Math.cos(cp), fwdY = Math.sin(cp), fwdZ = -Math.cos(cy) * Math.cos(cp);
  const eyeX = player.pos.x + fwdX * 0.16 * gs + rightX * bobX;
  const eyeY = player.pos.y + 1.52 * gs + fwdY * 0.16 * gs + bobY;
  const eyeZ = player.pos.z + fwdZ * 0.16 * gs + rightZ * bobX;
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
  // how far below the dirt the rig *wanted* to sit — that shove, and only while we're
  // actually craning up at the sky, is what drives the flare. Aiming and first-person
  // both cancel it: a scope that fisheyes is a scope you can't shoot with.
  const bury = clamp((minY - tY) / 1.2, 0, 1) * clamp(cp / 0.3, 0, 1) * (1 - fpv) * (1 - aimT);
  player.groundCamT = lerp(player.groundCamT, bury, 1 - Math.exp(-8 * dt));
  const gc = player.groundCamT;
  // look target eases from the blob itself (TP) to far ahead along the aim (FP)
  const lx = lerp(pivotX, eyeX + fwdX * 8, fpv);
  const ly = lerp(pivotY + 0.15, eyeY + fwdY * 8, fpv);
  const lz = lerp(pivotZ, eyeZ + fwdZ * 8, fpv);
  camera.lookAt(lx, ly, lz);
  // zoom focus: snipers punch in hard through the scope, guns focus modestly, melee barely
  let zoomedFov;
  if (wz.id === 'sniper') zoomedFov = SNIPER_FOVS[sniperNotch]; // dynamic, notched scope zoom
  else if (wz.melee) zoomedFov = 62;
  else zoomedFov = fpv > 0.5 ? 45 : 52;
  const baseFov = lerp(70, zoomedFov, aimT);
  lookFov = baseFov;
  const fov = baseFov + gc * 24;
  // The flare goes wide *and* warps the frame — both axes stretch out (y harder than x) so
  // a hero shot from the dirt magnifies and rears up against the sky instead of the old
  // anamorphic pinch that left everything skinny. The matrix is rebuilt from scratch every
  // frame the flare is live — scaling it in place would compound the warp — and the inverse
  // is re-derived because updateProjectionMatrix's copy is stale after we poke the elements
  // (raycasts and unproject read it).
  if (gc > 0.002 || lensStretched || Math.abs(fov - camera.fov) > 0.04) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    if (gc > 0.002) {
      camera.projectionMatrix.elements[0] *= 1 + gc * 0.11; // stretch x too, so nothing goes skinny
      camera.projectionMatrix.elements[5] *= 1 + gc * 0.26; // stretch y harder for the vertical rear-up
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    lensStretched = gc > 0.002;
  }
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
  cloudDome.position.copy(camera.position); // drift lives in the shader's uTime, wind-paced
  updateCelestial(dt); // arc the sun + moon, dress the clouds' uniforms, drift the motes
  moon.position.set(player.pos.x + moonOff.x, moonOff.y, player.pos.z + moonOff.z);
  moon.target.position.copy(player.pos);
  moon.target.updateMatrixWorld();
}

// ---- see-through house ----
// Standing in a house, any part of its shell that comes between the camera and the hero
// clears away — walls and roof both, since pitching down puts the camera over the ridge
// looking in. Only the house you're actually standing in ever fades.
const PEEK_OP = 0.18;
const peeking = new Set(); // mid-fade shell slabs, kept so they ease back after you leave
function updateHousePeek(dt) {
  // default every mid-fade slab back toward solid; the scans below re-flag whatever is
  // still actually in the way this frame
  for (const s of peeking) s.want = 1;
  if (game.state === 'playing') {
    const p = player.pos, c = camera.position, py = p.y + 1.15;
    // pad a little so a slab that merely grazes the sightline still clears
    const flag = (s) => { if (segBox(c.x, c.y, c.z, p.x, py, p.z, s.box, 0.12)) { s.want = PEEK_OP; peeking.add(s); } };
    // the enterable building you're standing in (chunk house or a permanent town one)
    const bld = buildingAt(p.x, p.z);
    if (bld && bld.shell) for (const s of bld.shell) flag(s);
    // every chunk house AROUND the hero too: a third-person camera clipped into an alley
    // clears the neighbour's wall it's buried in — windows, boards and roof fade with it
    const ccx = Math.round(p.x / CHUNK), ccz = Math.round(p.z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const ch = chunks.get(chunkKey(ccx + dx, ccz + dz));
      if (!ch || !ch.buildings) continue;
      for (const b2 of ch.buildings) if (b2 !== bld && b2.shell) for (const s of b2.shell) flag(s);
    }
    // and the town's solid fronts (shops, civic buildings): the whole kit — walls plus the
    // doors / windows / signs / awnings mounted on them — fades as one
    for (const s of townPeek) {
      if (Math.abs(s.box.x - p.x) > 60 || Math.abs(s.box.z - p.z) > 60) continue;
      flag(s);
    }
  }
  const k = 1 - Math.exp(-11 * dt);
  for (const s of peeking) {
    s.op = lerp(s.op, s.want, k);
    // the ease only approaches 1, so snap it once it's close enough to read as solid —
    // otherwise the slab is left parked at ~0.997 and never truly opaque again
    const solid = s.want === 1 && s.op > 0.995;
    if (solid) s.op = 1;
    const clear = s.op < 1;
    for (const m of s.mats) {
      // transparent flips the material's shader program, so only poke it on the change
      if (m.transparent !== clear) { m.transparent = clear; m.depthWrite = !clear; m.needsUpdate = true; }
      m.opacity = s.op;
    }
    if (solid) peeking.delete(s); // settled solid, stop tracking it
  }
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
  // the X flares open when an enemy is under the crosshair — but only one the shot could
  // actually reach. We measure how far the aim ray travels before a wall, car/truck, roof or
  // the ground stops the round (exactly as fireHitscan does), and a target sitting past that
  // stays cold: no flare, and on touch no auto-fire, until the path to it is clear.
  let hot = false;
  if (game.state === 'playing' && !player.dead) {
    getAimDir(_aimDir);
    const ox = camera.position.x, oy = camera.position.y, oz = camera.position.z;
    const dx = _aimDir.x, dy = _aimDir.y, dz = _aimDir.z;
    // the ray starts at the CAMERA, which rides behind the hero in third person — anything
    // it crosses before it reaches the gun is at the hero's back, not under the sights.
    // Nothing behind that line may flare (or, on touch, open fire): see selfT in fireWeapon.
    const tSelf = selfT(ox, oy, oz, dx, dy, dz);
    // the flare mirrors fireWeapon EXACTLY — same reach (the long guns read out to the
    // fog line) and the same globe-bend lifts on every test — or the scope would lie
    // about what the round will actually do
    const wFl = player.weapon;
    const reach = (wFl.id === 'sniper' || wFl.id === 'rifle') ? Math.max(80, scene.fog.far) : 80;
    let tWall = rayGround(ox, oy, oz, dx, dy, dz, reach);
    for (const c of nearbyColliders(player.pos.x, player.pos.z)) {
      // walls at the hero's back are dead air, exactly as fireWeapon treats them — the
      // flare must read the same line the round will fly, or touch auto-fire goes blind
      // the moment the camera backs into a building
      const fyC = oy + curveDrop(c.x, c.z);
      const t = c.roof ? rayRoof(ox, fyC, oz, dx, dy, dz, c) : rayAABB(ox, fyC, oz, dx, dy, dz, c);
      if (t > tSelf && t < tWall) tWall = t;
    }
    for (const z of zombies) {
      if (z.state === 'dying' || z.vanished) continue;
      const gy2 = z.blob.root.position.y;
      const fy = oy + curveDrop(z.pos.x, z.pos.z); // aim in drawn space, same as the round
      let t;
      if (z.state === 'sleep' || z.state === 'corpse') {
        t = lyingHitT(ox, fy, oz, dx, dy, dz, z, null);
      } else {
        t = Math.min(
          raySphere(ox, fy, oz, dx, dy, dz, z.pos.x, gy2 + 1.3 * z.scale, z.pos.z, 0.45 * z.scale),
          raySphere(ox, fy, oz, dx, dy, dz, z.pos.x, gy2 + 0.7 * z.scale, z.pos.z, 0.58 * z.scale));
      }
      if (t > tSelf && t < tWall) { hot = true; break; }   // in front of the gun, and of whatever stops the round
    }
    // crows light the crosshair up like any other spawn — same sphere, same occlusion test
    if (!hot) for (const cw of crows) {
      const t = crowRayT(ox, oy + curveDrop(cw.g.position.x, cw.g.position.z), oz, dx, dy, dz, cw);
      if (t > tSelf && t < tWall) { hot = true; break; }
    }
  }
  hud.crosshair.classList.toggle('enemy', hot);
  aimHot = hot; // touch has no trigger: the flare itself is what opens fire (see updatePlayer)
  if (hitmarkT > 0) {
    hitmarkT -= dt;
    hud.hitmarker.style.opacity = 1;
    hud.hitmarker.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${1 + hitmarkT * 3.5})`; // snappy pop
  } else hud.hitmarker.style.opacity = 0;
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) { hud.toast.style.opacity = 0; hud.toast.style.top = '30%'; } }
  if (bloodSplatT > 0) { bloodSplatT -= dt; if (bloodSplatT <= 0) bloodEl.style.opacity = 0; }
}

// ---------- blob face icon (64px canvas): one drawing of a cousin's head, wherever a
// cousin needs a face — the tab favicon, the lobby roster portraits, the picker cards ----------
const faceCv = document.createElement('canvas'); faceCv.width = 64; faceCv.height = 64;
const faceFx = faceCv.getContext('2d');
function faceRounded(x, y, w, h, r) {
  const fx = faceFx, [tl, tr, br, bl] = r;
  fx.beginPath();
  fx.moveTo(x + tl, y);
  fx.lineTo(x + w - tr, y); fx.arcTo(x + w, y, x + w, y + tr, tr);
  fx.lineTo(x + w, y + h - br); fx.arcTo(x + w, y + h, x + w - br, y + h, br);
  fx.lineTo(x + bl, y + h); fx.arcTo(x, y + h, x, y + h - bl, bl);
  fx.lineTo(x, y + tl); fx.arcTo(x, y, x + tl, y, tl);
  fx.closePath();
}
function faceIcon(color, lookLeft) {
  const fx = faceFx;
  fx.clearRect(0, 0, 64, 64);
  fx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  faceRounded(8, 6, 48, 52, [24, 24, 20, 20]); fx.fill();        // rounded blob head
  fx.fillStyle = 'rgba(0,0,0,.14)';
  faceRounded(8, 42, 48, 16, [0, 0, 20, 20]); fx.fill();          // soft chin shading
  const gaze = lookLeft ? -1.5 : 1.5;                             // Blondie glances left; the rest look right
  for (const ex of [24, 40]) {                                    // two googly eyes
    fx.fillStyle = '#fff';
    fx.beginPath(); fx.ellipse(ex, 27, 7, 8, 0, 0, TAU); fx.fill();
    fx.fillStyle = '#222';
    fx.beginPath(); fx.arc(ex + gaze, 29, 3.2, 0, TAU); fx.fill();
  }
  return faceCv.toDataURL('image/png');
}

// ---------- character select ----------
(function buildCousinCards() {
  const row = document.getElementById('cousincards');
  for (const c of COUSINS) {
    const card = document.createElement('div');
    card.className = 'card' + (c.id === selectedCousin ? ' sel' : '');
    const hex = '#' + c.color.toString(16).padStart(6, '0');
    card.innerHTML = `
      <img class="blobface" src="${faceIcon(c.color, c.id === 'blondie')}" alt="">
      <b>${c.name}</b>
      <i>${c.perk}</i>
      <p>${c.lore}</p>`;
    card.addEventListener('click', () => {
      selectedCousin = c.id;
      row.querySelectorAll('.card').forEach(el => el.classList.remove('sel'));
      card.classList.add('sel');
      // the single/multiplayer badge takes the picked cousin's colour immediately,
      // instead of only flipping once you spawn in
      document.documentElement.style.setProperty('--hero', hex);
      initAudio(); SFX.pickup(); previewTheme(c.id);
    });
    row.appendChild(card);
  }
  // seed the badge colour from the default pick so it matches before any click
  const sel0 = COUSINS.find(c => c.id === selectedCousin);
  if (sel0) document.documentElement.style.setProperty('--hero', '#' + sel0.color.toString(16).padStart(6, '0'));
})();

// ---------- multiplayer: PeerJS lobbies + host-authoritative co-op ----------
// A lobby is just a code on the public PeerJS broker. The host runs the world; joiners
// assume a cousin in it. Terrain is deterministic, so clients generate their own map and
// only zombies, actors and events travel the wire.
//
// Your cousin's name is the code you get for free, which makes the six names the entire
// public directory: leave the code alone and the browser can find you, type your own and
// only people you hand it to can knock. (This replaced four fixed ids that everyone on
// the internet shared — strangers collided in them and dead peers squatted them.)
const NET_SLOTS = 6;
// how long the host holds a dropped player's seat (number + cousin) before it falls back to
// squad AI. Long enough to cover a phone sleeping / a tunnel, short enough that a real quit
// doesn't strand the slot (a deliberate quit sends 'leave' and frees it immediately anyway).
const RECON_GRACE_MS = 60000;
// net is declared far earlier (near selectedCousin) so the settings UI, which builds at load
// and reads net.role for the gore-horde glow, can reach it before this block runs.
const lobbyHintEl = document.getElementById('lobbyhint');
const lobbyListEl = document.getElementById('lobbylist');
const codeEl = document.getElementById('lobbycode');
const codeHintEl = document.getElementById('codehint');
// broker ids must be predictable, so codes normalise hard: letters and digits only
function normCode(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12); }
function lobbyId(code) { return 'blingo-lobby-' + normCode(code); }
const PUBLIC_CODES = COUSINS.map(c => normCode(c.name));
function isPublicCode(code) { return PUBLIC_CODES.includes(normCode(code)); }
function defaultCode() { return (COUSINS.find(c => c.id === selectedCousin) || COUSINS[0]).name; }
// says out loud what the code they're typing will actually do
function updateCodeHint() {
  const c = normCode(codeEl.value);
  codeHintEl.textContent = !c ? 'Give it a code . .'
    : isPublicCode(c) ? `Public . . anyone scanning will find ${c.toUpperCase()}`
    : `Private . . only players you hand ${c.toUpperCase()} to can join`;
}
function netAvailable() { return typeof Peer !== 'undefined'; }
function netBroadcast(m) { for (const c of net.conns) { try { c.send(m); } catch (e) {} } }
function cousinByConn(conn) { return companions.find(c => c.netConn === conn); }

// --- lobby browser ---
function showLobbies() {
  document.getElementById('startscreen').classList.add('hidden');
  document.getElementById('lobbyscreen').classList.remove('hidden');
  lobbyListEl.innerHTML = '';
  codeEl.value = defaultCode();   // your own name, ready to host as public
  updateCodeHint();
  if (!netAvailable()) { lobbyHintEl.textContent = 'Multiplayer needs an internet connection . .'; return; }
  lobbyHintEl.textContent = 'Scanning for lobbies . .';
  netScanStop();
  const scan = net.scan = new Peer(undefined, { debug: 0 });
  let found = 0;
  scan.on('open', () => {
    // the public directory is exactly the six cousin names
    for (const code of PUBLIC_CODES) {
      const conn = scan.connect(lobbyId(code), { reliable: true });
      conn.on('open', () => conn.send({ t: 'query' }));
      conn.on('data', m => {
        if (m.t !== 'info') return;
        found++;
        lobbyHintEl.textContent = 'Pick a lobby, or host your own . .';
        renderLobbyRow(m);
        conn.close();
      });
    }
  });
  // Probing four fixed ids means every EMPTY slot answers 'peer-unavailable' — that is
  // simply what an empty lobby list looks like, not a broker outage. Shouting about it
  // was scaring people off a working list: the errors land after the rows do, so a real
  // lobby could be sitting right there while the hint claimed the service was down.
  scan.on('error', e => {
    if (e.type === 'peer-unavailable') return;
    if (!found) lobbyHintEl.textContent = 'Lobby service unreachable . . host one instead';
  });
  setTimeout(() => { if (net.scan === scan && !found) lobbyHintEl.textContent = 'No open lobbies . . host one .ᐟ'; }, 3500);
}
function netScanStop() { if (net.scan) { try { net.scan.destroy(); } catch (e) {} net.scan = null; } }
// one row per live lobby: badge in the host's hero colour, slots taken, and the
// cousin faces of everyone inside in the order they joined
function renderLobbyRow(m) {
  const code = normCode(m.code);
  const old = lobbyListEl.querySelector(`[data-code="${code}"]`);
  if (old) old.remove();
  const host = m.players.find(p => p.n === 1);
  const hostData = COUSINS.find(c => c.id === (host && host.c)) || COUSINS[0];
  const row = document.createElement('div');
  row.className = 'lobbyrow';
  row.dataset.code = code;
  row.style.setProperty('--bc', '#' + hostData.color.toString(16).padStart(6, '0'));
  row.innerHTML = `<span>${code.toUpperCase()}</span><span class="slots">${m.players.length}/${NET_SLOTS}</span>`;
  for (const p of [...m.players].sort((a, b) => a.n - b.n)) {
    const cd = COUSINS.find(c => c.id === p.c);
    if (!cd) continue;
    const img = document.createElement('img');
    img.src = faceIcon(cd.color);
    img.title = 'Player ' + p.n;
    row.appendChild(img);
  }
  row.addEventListener('click', () => joinLobby(code));
  lobbyListEl.appendChild(row);
}

// --- hosting ---
function hostLobby(rawCode) {
  if (!netAvailable()) { lobbyHintEl.textContent = 'Multiplayer needs an internet connection . .'; return; }
  const code = normCode(rawCode);
  if (!code) { lobbyHintEl.textContent = 'Give the lobby a code first . .'; return; }
  netScanStop();
  lobbyHintEl.textContent = 'Opening a lobby . .';
  const peer = new Peer(lobbyId(code), { debug: 0 });
  peer.on('open', () => {
    net.peer = peer; net.role = 'host'; net.playerNum = 1; net.lobbyCode = code; net.leaving = false;
    peer.on('connection', conn => wireHostConn(conn));
    startRun();
    toast(`HOSTING ${code.toUpperCase()} .ᐟ ${isPublicCode(code) ? 'PUBLIC' : 'PRIVATE'} .ᐟ YOU ARE PLAYER 1`, true);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') {
      try { peer.destroy(); } catch (er) {}
      // the code IS the lobby's name now, so no silent hop to some other slot — say it's
      // taken and let them choose, or they'd never know where they actually landed
      lobbyHintEl.textContent = `${code.toUpperCase()} is already hosting . . pick another code`;
    } else if (!net.role) lobbyHintEl.textContent = 'Lobby service unreachable . .';
  });
}
function lobbyPlayers() {
  const out = [{ n: 1, c: selectedCousin }];
  for (const c of companions) if (c.netP) out.push({ n: c.netP, c: c.data.id });
  return out.sort((a, b) => a.n - b.n);
}
function wireHostConn(conn) {
  conn.on('data', m => {
    if (m.t === 'query') {
      try { conn.send({ t: 'info', code: net.lobbyCode, players: lobbyPlayers() }); } catch (e) {}
      setTimeout(() => { try { conn.close(); } catch (e) {} }, 600);
    } else if (m.t === 'hi') {
      // a reconnecting player reclaims their EXACT seat by token — even if the host hasn't
      // seen the old link drop yet (still stale-open) or is already holding it on grace.
      // This is what stops a slept phone from walking back in as a brand-new, higher number.
      if (m.tok) {
        const mine = companions.find(k => k.netP && k.netTok && k.netTok === m.tok);
        if (mine) {
          if (mine.netConn && mine.netConn !== conn) { try { mine.netConn.close(); } catch (e) {} net.conns = net.conns.filter(x => x !== mine.netConn); }
          mine.netConn = conn; mine.netHold = 0; mine.netPose = null;
          if (!net.conns.includes(conn)) net.conns.push(conn);
          conn.send({ t: 'welcome', n: mine.netP, cousin: mine.data.id, x: mine.pos.x, z: mine.pos.z,
            w: game.weather, ph: game.phase, ck: game.clock, tm: game.time, k: game.kills,
            zs: notches.zombieSpawn, ls: notches.lootSpawn, hg: goreHordeLocal() ? 1 : 0,
            lay: currentLayout, // the host's landmark deal — a reconnecting screen must match it
            hp: game.state === 'paused' ? 1 : 0, resumed: 1 });
          toast(`PLAYER ${mine.netP} RECONNECTED .ᐟ`);
          rebuildSquadBars();
          updatePauseLobby();
          return;
        }
      }
      if (lobbyPlayers().length >= NET_SLOTS || game.state === 'menu') { try { conn.send({ t: 'full' }); } catch (e) {} return; }
      // their preferred cousin is their pick: take it if it's still free (recruit it if
      // it was only a beacon). If it's already taken, fall back — but favour a cousin the
      // squad has ALREADY recruited (picked at random) over waking a fresh beacon spawn.
      let c = companions.find(k => k.data.id === m.cousin && !k.netP);
      if (!c) {
        const free = companions.filter(k => !k.netP);
        const recruited = free.filter(k => k.recruited);
        const pool = recruited.length ? recruited : free;
        c = pool.length ? pool[(Math.random() * pool.length) | 0] : null;
      }
      if (!c) { try { conn.send({ t: 'full' }); } catch (e) {} return; }
      // a joiner takes the LOWEST free seat, not count+1: with P2 gone and P3 still
      // in, the next player IS the new P2 (count+1 would have minted a second P3),
      // and the health-bar column snaps back into numeric order around them
      const taken = new Set(lobbyPlayers().map(p => p.n));
      let num = 2;
      while (taken.has(num)) num++;
      c.netP = num; c.netConn = conn; c.netPose = null; c.netTok = m.tok || null; c.netHold = 0;
      if (c.downed) reviveCousin(c, true);   // a join-takeover is free: nobody's arms did the hauling
      if (!c.recruited) recruitCousin(c);   // the JOINED .ᐟ toast, beacon off — found like any cousin
      else toast(`PLAYER ${num} TOOK OVER ${c.data.name.toUpperCase()} .ᐟ`);
      net.conns.push(conn);
      conn.send({ t: 'welcome', n: num, cousin: c.data.id, x: c.pos.x, z: c.pos.z,
        w: game.weather, ph: game.phase, ck: game.clock, tm: game.time, k: game.kills,
        zs: notches.zombieSpawn, ls: notches.lootSpawn, hg: goreHordeLocal() ? 1 : 0, // the host's spawn dials + gore-horde flag
        lay: currentLayout, // the host's landmark deal: prestige remixes rebuild on our screen too
        hp: game.state === 'paused' ? 1 : 0 });               // joined a held lobby: wait with it
      rebuildSquadBars();
      updatePauseLobby();   // a paused host sees the count tick up the moment they join
    } else if (m.t === 'p') {
      const c = cousinByConn(conn);
      if (c) {
        c.netPose = m; c.hp = m.hp;
        c.netGs = m.gs || 1; // their chili-giant scale rides the pose stream
        // a player-controlled cousin owns its own downed state (hurtCompanion bails out
        // for them), so mirror it here and run their rescue beacon from it
        const dn = !!m.dn;
        if (dn !== !!c.downed) {
          c.downed = dn; netSyncCousinBeacon(c); rebuildSquadBars();
          if (dn) toast(`P${c.netP} ${c.data.name.toUpperCase()} DOWN .ᐟ`, true);
        }
      }
    } else if (m.t === 'shot') {
      const z = zombies.find(zz => zz.nid === m.id);
      if (z) damageZombie(z, m.d, m.kx, m.kz, 2, { weapon: WEAPONS[m.wid], dist: m.ds, isHead: m.hd });
    } else if (m.t === 'pew') {
      // a client fired: draw their round here, let it ring in the host's world (blind
      // zombies home on it like any gunshot), and relay it to everyone else's screen
      const c = cousinByConn(conn);
      if (c) {
        netRemotePew(c.blob, c.gunMesh, c.weapon, m.x, m.y, m.z);
        if (squadCmd.mode === 'lineup' && squadCmd.p === c.netP) squadCmd.mode = null; // their gunfire breaks their own trade line
        game.lastShot.set(c.pos.x, 0, c.pos.z); game.lastShotT = game.time;
        scareCrows(m.x, m.z, 12); // a client's gunfire flushes the flock for EVERY screen
        for (const o of net.conns) if (o !== conn) { try { o.send({ t: 'pew', p: c.netP, x: m.x, y: m.y, z: m.z }); } catch (e) {} }
      }
    } else if (m.t === 'emote') {
      const c = cousinByConn(conn);
      if (c) {
        spawnBubble(() => ({ x: c.pos.x, y: (c.y || 0) + 2.2, z: c.pos.z }), EMOTES[m.e] || '', c);
        // a client's Trade / Wait / Fight commands the AI cousins too — anchored on the
        // caller, so the squad lines up / huddles / rings around THEM, not the host
        const nm = EMOTES[m.e] || '';
        if (nm.startsWith('Trade')) issueSquadCmd('lineup', c);
        else if (nm.startsWith('Wait')) issueSquadCmd('wait', c);
        else if (nm.startsWith('Fight')) issueSquadCmd('guard', c);
        for (const o of net.conns) if (o !== conn) { try { o.send({ t: 'emote', e: m.e, p: c.netP }); } catch (e) {} }
      }
    } else if (m.t === 'tradeReq') {
      // legacy one-sided melee grab — no longer honoured. Taking a weapon off another human now
      // requires the two-sided hold pact (updateHoldTrades), so a lone request settles nothing.
    } else if (m.t === 'npcTradeReq') {
      netHandleNpcTrade(conn, m.c);   // AI cousins deal freely, no consent needed
    } else if (m.t === 'grandmaReq') {
      // a client reached grandma first: the finale is anyone's to start — the host just
      // checks they're really standing in her stockroom before the family gathers
      const gc = cousinByConn(conn);
      if (gc && jelly.ghost && !jelly.awake && Math.hypot(gc.pos.x - JELLY_G.x, gc.pos.z - JELLY_G.z) < 4.5) grandmaWake();
    } else if (m.t === 'jellyReq') {
      // a client at the jelly table: one jar a cousin for the whole run — the host holds
      // the ledger, hides the jar their crosshair chose, and the snapshot carries it out
      const jc = cousinByConn(conn);
      const key = jc ? 'p' + jc.netP : '';
      if (jc && jellyLeft() > 0 && !jellyBar.lootedBy.has(key)
          && Math.hypot(jc.pos.x - jellyBar.x, jc.pos.z - jellyBar.z) < 5.2) {
        const jar = (m.jar >= 0 && m.jar < 6 && !(jellyBar.mask & (1 << m.jar))) ? m.jar : nearestFreeJar();
        applyJellyMask(jellyBar.mask | (1 << jar));
        jellyBar.lootedBy.add(key);
        try { conn.send({ t: 'jellyGive' }); } catch (e) {}
        npcNiceRound();
      }
    } else if (m.t === 'chiliReq') {
      const cc = cousinByConn(conn);
      const key = cc ? 'p' + cc.netP : '';
      if (cc && chiliBar.taken < 6 && !chiliBar.lootedBy.has(key)
          && Math.hypot(cc.pos.x - chiliBar.x, cc.pos.z - chiliBar.z) < 5) {
        applyChiliTaken(chiliBar.taken + 1);
        chiliBar.lootedBy.add(key);
        try { conn.send({ t: 'chiliGive' }); } catch (e) {}
      }
    } else if (m.t === 'pkTake') {
      // a client walked up on one of our streamed ground drops: hand it over if it still
      // exists and they're really standing on it — first ask wins, the snapshot clears the
      // ghost from every other screen on the next tick
      const pc = cousinByConn(conn);
      const pi = pickups.findIndex(p => !p.netGhost && p.nid === m.i);
      if (pc && pi >= 0) {
        const p = pickups[pi];
        if (Math.hypot(pc.pos.x - p.pos.x, pc.pos.z - p.pos.z) < 3.4) {
          scene.remove(p.mesh);
          pickups.splice(pi, 1);
          try { conn.send({ t: 'pkGive', k: p.kind === 'ammo' ? 0 : p.kind === 'medkit' ? 1 : 2 }); } catch (e) {}
        }
      }
    } else if (m.t === 'crowShot') {
      // a client's round found a bird: the host lands the kill — the gore plays here, the
      // drop spawns here (and streams back), and the ghost leaves every screen's flock
      const cb2 = crows.find(cc => cc.nid === m.i);
      if (cb2) killCrow(cb2, 0, 0, 10);
    } else if (m.t === 'cswapKit') {
      // the reply half of a bare-skin trade: this player's old kit, bound for their partner
      const c = cousinByConn(conn);
      if (c && c.swapTo) {
        const to = c.swapTo; c.swapTo = null;
        if (to === 'host') applySwapKit(m.kit);
        else { try { to.send({ t: 'cswapKit', kit: m.kit }); } catch (e) {} }
      }
    } else if (m.t === 'reviveReq') {
      netHandleReviveReq(conn, m.p | 0);
    } else if (m.t === 'recruitReq') {
      // a client walked up to a waiting cousin: recruit it into the shared squad if they're
      // actually next to it. It lands on every screen through the next snapshot (drops out of
      // rc, joins ac) and the recruit beacon clears everywhere.
      const rq = cousinByConn(conn);
      const c = companions.find(k => k.data.id === m.c && !k.recruited && !k.netP);
      if (c && rq && Math.hypot(c.pos.x - rq.pos.x, c.pos.z - rq.pos.z) < 4) recruitCousin(c, rq.netP);
    } else if (m.t === 'dead') {
      netFreeCousin(conn, false);
    } else if (m.t === 'leave') {
      // a deliberate quit / tab-close: free the seat NOW so the number + cousin can be
      // inherited straight away, and mark the conn so the close that follows is a no-op
      conn._left = true;
      netFreeCousin(conn, true);
    }
  });
  conn.on('close', () => netHostConnGone(conn));
  conn.on('error', () => netHostConnGone(conn));
}
// a client's connection dropped. If they said 'leave' it's already handled. Otherwise it
// might just be a phone that slept or a tunnel that blinked — hold their seat (number +
// cousin, counted as taken) for a grace window so they can reconnect straight back into it.
// netHostTick sweeps holds that never come back.
function netHostConnGone(conn) {
  if (conn._left) return;                       // already freed by an explicit leave
  const c = cousinByConn(conn);
  net.conns = net.conns.filter(k => k !== conn);
  if (!c) return;
  c.netConn = null; c.netPose = null;
  c.netHold = performance.now() + RECON_GRACE_MS; // reserved, not freed — see netSweepHolds
  toast(`PLAYER ${c.netP} DROPPED, HOLDING THEIR SEAT .ᐟ`);
  rebuildSquadBars();
  updatePauseLobby();
}
// free any reserved seat whose grace ran out with no reconnect — only now does the cousin
// fall back to squad AI and the number open up for a fresh joiner
function netSweepHolds() {
  const now = performance.now();
  for (const c of companions) {
    if (c.netP && !c.netConn && c.netHold && now > c.netHold) {
      const num = c.netP;
      c.netP = null; c.netHold = 0; c.netTok = null; c.netPose = null;
      c.hp = Math.max(c.hp, c.maxHp * 0.5);
      for (const o of companions) if (o.followP === num) o.followP = 1; // their followers fall back to the host
      toast(`PLAYER ${num} LEFT, ${c.data.name.toUpperCase()} REJOINS THE SQUAD`);
      rebuildSquadBars();
      updatePauseLobby();
    }
  }
}
// the transfusion revive, requested by a client hauling up a downed teammate. The cost comes
// out of the RESCUING client (not the host), and whoever they lift — another player, or the
// host's own body — stands with exactly what it cost.
function netHandleReviveReq(conn, p) {
  const rescuer = cousinByConn(conn);
  if (!rescuer || rescuer.downed) return;
  const pay = Math.max(1, Math.round((rescuer.hp || 1) / 2));
  const charge = () => {
    rescuer.hp = Math.max(1, (rescuer.hp || 1) - pay);
    if (rescuer.netConn) { try { rescuer.netConn.send({ t: 'reviveCost', hp: pay }); } catch (e) {} }
  };
  if (p === 1) {
    if (!player.downed || Math.hypot(player.pos.x - rescuer.pos.x, player.pos.z - rescuer.pos.z) > 3.2) return;
    charge();
    playerGetUp(true, pay);
    toast(`P${rescuer.netP} REVIVED THE HOST`);
  } else {
    const target = companions.find(k => k.netP === p && k.downed);
    if (!target || Math.hypot(target.pos.x - rescuer.pos.x, target.pos.z - rescuer.pos.z) > 3.2) return;
    charge();
    target.downed = false;
    target.hp = Math.min(pay, target.maxHp);
    if (target.netConn) { try { target.netConn.send({ t: 'revive', hp: pay }); } catch (e) {} }
    netSyncCousinBeacon(target);
    rebuildSquadBars();
    toast(`P${rescuer.netP} REVIVED P${p}`);
  }
}
// a player left or died: their cousin snaps back to squad AI
function netFreeCousin(conn, gone) {
  const c = cousinByConn(conn);
  net.conns = net.conns.filter(k => k !== conn);
  if (!c) return;
  const num = c.netP;
  c.netP = null; c.netConn = null; c.netPose = null; c.netHold = 0; c.netTok = null;
  c.hp = Math.max(c.hp, c.maxHp * 0.5);
  for (const o of companions) if (o.followP === num) o.followP = 1; // their followers fall back to the host
  if (gone) toast(`PLAYER ${num} LEFT, ${c.data.name.toUpperCase()} REJOINS THE SQUAD`);
  rebuildSquadBars();
  updatePauseLobby();   // and tick back down the moment they leave, pause menu open or not
}
// 10Hz world snapshot to every client
function netHostTick(dt) {
  netSweepHolds();   // let go of any reserved seat whose reconnect window has lapsed
  net.txT -= dt;
  if (net.txT > 0 || !net.conns.length) return;
  net.txT = 0.1;
  const R = v => Math.round(v * 20) / 20;
  // every actor ships its gun-arm angle too: the host's own aim, an AI cousin's tracked
  // pitch, or a remote player's streamed one (already applied to their blob) — so every
  // client renders the same full x/y aim the owning screen sees
  const ac = [netActorOf(1, selectedCousin, player.pos.x, player.pos.z, player.pos.y,
    playerBlob.root.rotation.y, player.weapon.id, player.hp, !!player.downed,
    playerBlob.arms[playerBlob.gunArm].rotation.x, player.giantScale || 1)];
  // the remaining cousins still waiting to be found: streamed so every client sees the same
  // recruit beacons the host does and can walk one up themselves (netFindNearRecruit)
  const rc = [];
  for (const c of companions) {
    if (c.recruited) continue;
    rc.push({ c: c.data.id, x: R(c.pos.x), z: R(c.pos.z) });
  }
  for (const c of companions) {
    if (!c.recruited) continue;
    ac.push(netActorOf(c.netP || 0, c.data.id, c.pos.x, c.pos.z, c.y || 0, c.yaw, (c.weapon || WEAPONS.pistol).id, c.hp, !!c.downed,
      c.blob.arms[c.blob.gunArm].rotation.x, c.netGs || 1));
  }
  const zb = [];
  const shielded = bossShielded();   // its wave guards are up: the boss is invuln right now
  for (const z of zombies) {
    if (!z.nid) z.nid = ++net.zid;
    zb.push({ i: z.nid, x: R(z.pos.x), z: R(z.pos.z), yw: R(z.yaw || 0),
      st: z.state === 'dying' ? 1 : (z.state === 'sleep' || z.state === 'emerge' || z.state === 'corpse' ? 2 : 0),
      sc: R(z.scale), pu: z.purple ? 1 : 0, re: z.red ? 1 : 0, gr: z.green ? 1 : 0, gh: z.goreHorn ? 1 : 0,
      ho: (z.hornVis || z.goreHorn) ? 1 : 0, bo: z.isBoss ? 1 : 0, b2: z.isBoss2 ? 1 : 0, b3: z.isBoss3 ? 1 : 0,
      b4: z.isBoss4 ? 1 : 0,              // the Rotten One → clients dress him rotten too
      he: z.rotE ? 1 : 0, rb: z.rotR ? 1 : 0, rr: z.rotRR ? 1 : 0, pb: z.rotB ? 1 : 0, // the rot variants ride the wire
      sh: (z.isBoss && shielded) ? 1 : 0, // boss invuln flag → clients blink it the same
      gd: (z.hornWave && !z.goreHorn) ? 1 : 0, // shield guard → clients dress the tell-tale glow
      fb: z.fbi ? 1 : 0, bg: z.bluga ? 1 : 0, gv: z.vanished ? 1 : 0, // black-ops: FBI look, Bluga, his smoke-vanish
      ff: z.fbi ? z.fbiFace : undefined,  // the cousin colour in the ski-mask opening
      ar: z.fbi ? Math.round((z.aimPitch || 0) * 100) / 100 : undefined, // FBI gun-arm pitch
      dp: z.diedPop ? 1 : 0 });           // this death popped the head (gib/headshot) → clients burst it too
  }
  const boss = bossState.boss;
  const base = { t: 's', tm: R(game.time), k: game.kills, w: game.weather, ph: game.phase, ck: R(game.clock * 100) / 100, ac, rc,
    bb: boss && boss.state !== 'dormant' && boss.state !== 'dying' ? clamp(boss.hp / boss.maxHp, 0, 1) : -1,
    b2: !!(boss && boss.isBoss2), b3: !!(boss && boss.isBoss3), b4: !!(boss && boss.isBoss4), // which one is up: clients dress the bar in his colours
    ct: game.cleanup ? game.clearTarget : 0, cq: game.quotaN || 0, // cleanup quota, so every screen runs the REMAIN readout
    rn: companions.filter(c => c.recruited).length, rt: companions.length, // the N/6 recruit tally, mirrored
    cjm: jellyBar.mask, cct: chiliBar.taken, // the consumable shelves, so every screen shows the same jars + bowls left
    blg: bluga.boss ? clamp(bluga.boss.hp / bluga.boss.maxHp, 0, 1) : -1, // Bluga's bar, streamed to every screen
    zs: notches.zombieSpawn, ls: notches.lootSpawn, hg: goreHordeLocal() ? 1 : 0 }; // host's spawn dials + gore-horde, mirrored on every client
  // --- per-connection delivery, tuned for laggy coop ---
  // 1) INTEREST FILTER: each client only receives the zombies near ITS OWN hero (plus every
  //    boss and black-ops blob, whose bars/beams must sync at any range). A gore-horde of 30
  //    walkers used to ride every snapshot to every phone, 10 times a second — most of them
  //    two blocks away in the fog. The ghost machinery already grows/culls from the stream,
  //    so entries appearing and vanishing at the interest ring costs nothing extra.
  // 2) BACKPRESSURE: a connection whose send buffer is backing up (weak wifi mid-retransmit)
  //    SKIPS this snapshot instead of queueing seconds of stale world behind it — a struggling
  //    client degrades to a lower snapshot rate and recovers, rather than falling ever further
  //    behind on a reliable ordered channel that never forgets.
  // the host's ground drops ride along too (ammo boxes, medkits, BEST JELLY off the black
  // ops): kind coded small, so every screen can SEE and walk up on the same loot
  const pk = pickups.filter(p => !p.netGhost).map(p => ({ i: p.nid,
    k: p.kind === 'ammo' ? 0 : p.kind === 'medkit' ? 1 : 2, x: R(p.pos.x), z: R(p.pos.z) }));
  // the murder streams whole (it's small): same birds on the same ledges on every screen,
  // so when Blomba picks one out of the sky, everyone watches the SAME crow drop
  base.cw = crows.map(c => ({ i: c.nid, x: R(c.g.position.x), y: R(c.g.position.y), z: R(c.g.position.z),
    yw: R(c.g.rotation.y), st: (c.state === 'fly' || c.state === 'leave' || c.state === 'descend') ? 1 : 0,
    pu: c.purple ? 1 : 0, rk: c.redBeak ? 1 : 0, sc: R(c.g.scale.x) }));
  base.cg = crowsGone ? 1 : 0;
  // and Bluga's arena cameo, while it plays: position + phase, so every screen watches the
  // same show (his prey zombies already ride the zombie stream like any walker)
  if (bluga.cameo) {
    const cc = bluga.cameo;
    base.cm = { x: R(cc.pos.x), z: R(cc.pos.z), yw: R(cc.yaw),
      ph: cc.greetT ? (bluga.camT < cc.greetT + 2.2 ? 1 : 2) : 0 };
  }
  const INTEREST = Math.max(150, (scene.fog && scene.fog.far || 0) + 50);
  for (const conn of net.conns) {
    try {
      const dc = conn.dataChannel;
      if (dc && dc.bufferedAmount > 65536) continue; // let the pipe drain; the next tick retries
      const seat = cousinByConn(conn);
      const sx = seat ? seat.pos.x : player.pos.x, sz = seat ? seat.pos.z : player.pos.z;
      base.zb = zb.filter(e => e.bo || e.fb || Math.hypot(e.x - sx, e.z - sz) < INTEREST);
      base.pk = pk.filter(e => Math.hypot(e.x - sx, e.z - sz) < INTEREST);
      conn.send(base);
    } catch (e) {}
  }
  base.zb = null; base.pk = null; // never let the last client's filtered lists linger on the shared object
}
function netActorOf(p, cid, x, z, y, yw, wp, hp, dn, ar, gs) {
  const R = v => Math.round(v * 20) / 20;
  const key = p ? 'p' + p : 'ai' + cid;
  const mv = Math.hypot(x - (net['_lx' + key] || x), z - (net['_lz' + key] || z)) > 0.03 ? 1 : 0;
  net['_lx' + key] = x; net['_lz' + key] = z;
  return { p, c: cid, x: R(x), z: R(z), y: R(y), yw: R(yw), wp, hp: Math.round(hp), dn: dn ? 1 : 0, mv,
    ar: ar == null ? undefined : Math.round(ar * 100) / 100, // gun-arm angle, finer grain than position
    gs: gs && gs > 1.02 ? Math.round(gs * 20) / 20 : undefined }; // chili-giant scale: absent = small
}

// --- reconnect: a client that drops (phone sleeps, tunnel blinks) soft-pauses and dials
// back into its HELD seat instead of being kicked to the menu. The host reserves that seat
// for RECON_GRACE_MS (netHostConnGone); the client keeps trying for the same window. ---
const reconnEl = document.getElementById('reconnecting');
// a stable per-browser id the host recognises us by, so our exact player number + cousin
// come back on reconnect rather than the host minting a fresh (higher) slot
function clientToken() {
  let t = null;
  try { t = localStorage.getItem('blingo_tok'); } catch (e) {}
  if (!t) {
    t = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('blingo_tok', t); } catch (e) {}
  }
  return t;
}
function clientConnLost() {
  if (net.role !== 'client' || net.leaving || net.reconnecting) return;
  beginReconnect();
}
function beginReconnect() {
  net.reconnecting = true;
  net.reconStart = performance.now();
  net.reconUnavail = 0;
  // soft-pause: freeze the world behind the banner instead of tearing down to the menu
  if (game.state === 'playing') {
    game.state = 'paused';
    document.body.classList.remove('playing');
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  setBlurMute(true);
  reconnEl.classList.remove('hidden');
  if (net.peer) { try { net.peer.destroy(); } catch (e) {} net.peer = null; }
  net.conns = [];
  reconnectAttempt();
}
function endReconnect() {
  net.reconnecting = false;
  clearTimeout(net.reconTimer); net.reconTimer = null;
  reconnEl.classList.add('hidden');
}
function giveUpReconnect() { endReconnect(); showHostClosed(); }
function scheduleReconnect() {
  if (!net.reconnecting) return;
  clearTimeout(net.reconTimer);
  net.reconTimer = setTimeout(reconnectAttempt, 2500);
}
function reconnectAttempt() {
  if (!net.reconnecting) return;
  if (performance.now() - net.reconStart > RECON_GRACE_MS) { giveUpReconnect(); return; }
  const code = net.lobbyCode;
  let peer;
  try { peer = new Peer(undefined, { debug: 0 }); } catch (e) { scheduleReconnect(); return; }
  const retry = () => {
    if (!net.reconnecting) return;   // already back in: never touch the live peer
    try { peer.destroy(); } catch (e) {}
    scheduleReconnect();
  };
  const giveT = setTimeout(retry, 4500);   // no welcome in time → next attempt
  peer.on('open', () => {
    const conn = peer.connect(lobbyId(code), { reliable: true });
    conn.on('open', () => { try { conn.send({ t: 'hi', cousin: selectedCousin, tok: clientToken() }); } catch (e) {} });
    conn.on('data', m => {
      if (net.reconnecting) {
        if (m.t === 'full') { clearTimeout(giveT); retry(); return; }   // seat not back yet — try again
        if (m.t === 'welcome') { clearTimeout(giveT); endReconnect(); }  // reclaimed: welcome re-syncs us
      }
      netClientData(m, conn, peer, code);
    });
    conn.on('close', () => { if (net.reconnecting) retry(); else clientConnLost(); });
    conn.on('error', () => { if (net.reconnecting) retry(); else clientConnLost(); });
  });
  peer.on('error', e => {
    clearTimeout(giveT);
    // the lobby id simply not existing means the host is truly gone: bail fast rather than
    // spinning out the whole grace window
    if (e && e.type === 'peer-unavailable' && ++net.reconUnavail >= 2) { giveUpReconnect(); return; }
    retry();
  });
}
document.getElementById('reconquit').addEventListener('click', () => { endReconnect(); quitToMenu(); });

// --- joining ---
function joinLobby(rawCode) {
  const code = normCode(rawCode);
  if (!code) { lobbyHintEl.textContent = 'Type a code to join . .'; return; }
  lobbyHintEl.textContent = `Joining ${code.toUpperCase()} . .`;
  netScanStop();
  const peer = new Peer(undefined, { debug: 0 });
  peer.on('open', () => {
    const conn = peer.connect(lobbyId(code), { reliable: true });
    conn.on('open', () => conn.send({ t: 'hi', cousin: selectedCousin, tok: clientToken() }));
    conn.on('data', m => netClientData(m, conn, peer, code));
    // a live session that drops soft-pauses and reconnects (clientConnLost) rather than
    // dumping to the menu; a failure BEFORE welcome (role still null) just no-ops here and
    // the peer.on('error') hint below explains a bad code
    conn.on('close', () => clientConnLost());
    conn.on('error', () => clientConnLost());
  });
  peer.on('error', e => {
    if (net.role === 'client') { clientConnLost(); return; }
    // a typo'd code is the common case here, so name it rather than blaming the service
    lobbyHintEl.textContent = e.type === 'peer-unavailable'
      ? `Nobody is hosting ${code.toUpperCase()} . .`
      : 'Could not reach that lobby . .';
  });
}
function netClientData(m, conn, peer, code) {
  if (m.t === 'full') { lobbyHintEl.textContent = 'That lobby is full . .'; try { peer.destroy(); } catch (e) {} return; }
  if (m.t === 'welcome') {
    net.peer = peer; net.role = 'client'; net.conns = [conn];
    net.playerNum = m.n; net.lobbyCode = code; net.leaving = false;
    // the host's landmark deal comes first: if their town differs from ours (a prestige
    // remix), rebuild OUR world on their anchors before anything walks through a wall
    if (m.lay && m.lay !== currentLayout) { applyLayout(JSON.parse(m.lay)); rebuildTownWorld(); }
    applyCousin(m.cousin);
    startRun();
    // this world belongs to the host: no local squad, no local spawner
    for (const c of companions) {
      scene.remove(c.blob.root);
      if (c.blob.shadow) scene.remove(c.blob.shadow);
      if (c.beacon) scene.remove(c.beacon);
    }
    companions.length = 0;
    for (const z of zombies) { scene.remove(z.blob.root); if (z.blob.shadow) scene.remove(z.blob.shadow); }
    zombies.length = 0;
    if (m.ck != null) game.clock = m.ck;
    game.phase = m.ph; wxSet(m.w); applyEnvironment();
    game.time = m.tm; game.kills = m.k; hud.kills.textContent = m.k;
    player.pos.set(m.x, groundHeight(m.x, m.z), m.z);
    applyHostNotches(m.zs, m.ls, m.hg);   // the host's spawn dials + gore-horde land on our greyed rows
    if (m.hp) { net.hostPaused = true; pauseGame(); } // lobby is held: wait with it
    toast(m.resumed ? `RECONNECTED .ᐟ YOU ARE PLAYER ${m.n}` : `JOINED ${code.toUpperCase()} .ᐟ YOU ARE PLAYER ${m.n}`, true);
  } else if (m.t === 's') {
    netApplySnapshot(m);
  } else if (m.t === 'notch') {
    applyHostNotches(m.zs, m.ls, m.hg);   // the host turned a spawn dial (or maxed gore): our pips follow live
  } else if (m.t === 'hpause') {
    // the host's pause is the lobby's pause: the settings screen drops over everyone
    // together, and only the host's resume lifts it
    net.hostPaused = !!m.on;
    updateHostPauseLock();
    if (m.on && game.state === 'playing') pauseGame();
    else if (!m.on && game.state === 'paused') resumeGame();
  } else if (m.t === 'hurt') {
    hurtPlayer(m.d, Math.random() - 0.5, Math.random() - 0.5);
  } else if (m.t === 'revive') {
    playerGetUp(true, m.hp); // someone hauled us up — we inherit what the pull cost them
  } else if (m.t === 'reviveCost') {
    // we hauled a downed teammate up: the transfusion comes out of us (never below 1)
    player.hp = Math.max(1, player.hp - (m.hp | 0));
    SFX.recruit();
    rumble(120, 0.4, 0.5);
    toast('YOU REVIVED A TEAMMATE .ᐟ');
  } else if (m.t === 'gameover') {
    // the whole lobby is down: ride the same slow-motion fade the host is riding
    if (!player.dead && !deathFx.on) {
      player.dead = true;
      deathFx.on = true; deathFx.t = 0; deathFx.gameOver = true;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      rumble(500, 1, 1);
    }
  } else if (m.t === 'restart') {
    // Player 1 respawned the lobby: drop the death screen and step back into the fresh run
    deathFx.on = false; deathFadeEl.style.opacity = 0;
    startRun();
  } else if (m.t === 'pew') {
    // another player's round (the host's own, or a relayed client's): trace it from
    // their ghost's muzzle so the whole lobby sees who is shooting at what
    const g = net.actors.get('p' + m.p);
    if (g) netRemotePew(g.blob, g.gunMesh, WEAPONS[g.wp], m.x, m.y, m.z);
  } else if (m.t === 'emote') {
    const a = net.actors.get(m.p ? 'p' + m.p : null);
    if (a) spawnBubble(() => ({ x: a.blob.root.position.x, y: a.blob.root.position.y + 2.2 * 1, z: a.blob.root.position.z }), EMOTES[m.e] || '', a);
  } else if (m.t === 'cemote') {
    // an AI cousin spoke on the host's side (hello on recruit, Bloopy on a boss): the
    // squad AI doesn't run here, so the bubble only exists if the host tells us about it
    const c = companions.find(x => x.data.id === m.c);
    if (c) spawnBubble(() => ({ x: c.pos.x, y: (c.y || 0) + 2.2, z: c.pos.z }), EMOTES[m.e] || '', c);
  } else if (m.t === 'tradeW') {
    // the host settled a trade: what we gave leaves the kit, theirs takes its slot —
    // never overwritten back to this cousin's signature gear
    if (WEAPONS[m.w]) {
      if (m.took && m.took !== 'fists' && player.weapon.id === m.took) {
        const i = player.owned.indexOf(m.took);
        if (i >= 0) player.owned.splice(i, 1);
      }
      equipWeapon(m.w);
      SFX.tradePing();
      rumble(60, 0.3, 0.4);
      toast(`TRADED: YOUR ${WEAPONS[m.took] ? WEAPONS[m.took].name.toUpperCase() : 'WEAPON'} FOR ${anA(WEAPONS[m.w].name)} ${WEAPONS[m.w].name.toUpperCase()}`);
    }
  } else if (m.t === 'tradeP') {
    // the host's read of the consent pact from MY seat: my own fill, my partner's fill, and who
    // they are (player num + cousin id) so I can colour and grey the two faces. Rendered in
    // netClientTick; also kept as net.tradeP/PT so the skin-nudge still knows a ring is answering.
    net.tp = { me: m.me || 0, them: m.them || 0, tp: m.tp || 0, tc: m.tc, ol: m.ol, t: performance.now() };
    net.tradeP = Math.max(m.me || 0, m.them || 0); net.tradePT = performance.now();
  } else if (m.t === 'tradeAcc') {
    tradePactAccept();   // both faces filled — the ACCEPTED sting + soundoff chord on our screen too
  } else if (m.t === 'cswap') {
    netClientSkinSwap(m);
  } else if (m.t === 'cswapKit') {
    applySwapKit(m.kit); // the other half's kit, relayed through the host
  } else if (m.t === 'bluga') {
    // the host's Rotten One fell on a prestige run: Bluga's cold-blue light stands over the
    // Jelly House instead of grandma's. Bluga + his squad arrive via the zombie snapshot.
    const gy = groundHeight(JELLY.x, JELLY.z);
    if (!bluga.beam) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 220, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x2b3550, transparent: true, opacity: 0.32, fog: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      beam.position.set(JELLY.x, gy + 100, JELLY.z); scene.add(beam); bluga.beam = beam;
    }
    toast('THE ROTTEN ONE FALLS .ᐟ', true);
    setTimeout(() => toast('BUT THE JELLY HOUSE IS SURROUNDED .ᐟ BLUGA THE BAD BLOB .ᐟ', true), 2800);
  } else if (m.t === 'jelly') {
    // the Rotten One fell on the host's watch: the same light + ghost + toasts, our screen.
    // (On a prestige run this arrives only once Bluga is down — his beam clears with it.)
    if (bluga.beam) { scene.remove(bluga.beam); bluga.beam = null; }
    spawnJellyMarks();
    toast('THE ROTTEN ONE FALLS .ᐟ', true);
    setTimeout(() => toast('REMEMBER THE JELLY .ᐟ BEST JELLY STOPS THE ROT .ᐟ', true), 2800);
    setTimeout(() => toast('AHA, TO THE OLD JELLY HOUSE .ᐟ', true), 7400);
  } else if (m.t === 'jellyGive') {
    grantJelly();   // the host honoured our jar: it lands in the hand
  } else if (m.t === 'chiliGive') {
    grantChili();   // the host ladled our serving: bowl in hand, RED'S on the button
  } else if (m.t === 'cam') {
    toast('WHO IS THAT BY THE FOUNTAIN .ᐟ', true); // Bluga's show opens on our screen too
  } else if (m.t === 'ftr') {
    // a black-ops round (or a cousin's crow shot) fired on the host: the same tracer line
    // and the same crack land here, so the fight LOOKS identical on every screen
    _fbiFrom.set(m.a[0], m.a[1], m.a[2]); _fbiTo.set(m.a[3], m.a[4], m.a[5]);
    spawnTracer(_fbiFrom, _fbiTo);
    if (Math.hypot(m.a[0] - player.pos.x, m.a[2] - player.pos.z) < 32)
      play3d(m.a[0], m.a[2], () => SFX.shoot(WEAPONS[m.w] || WEAPONS.rifle));
  } else if (m.t === 'pkGive') {
    // the host handed over the ground drop we asked for: grant it here, same numbers as local
    if (m.k === 2) {
      if (!player.owned.includes('jelly') && !player.owned.includes('chili') && !playerGiantAny()) {
        equipWeapon('jelly');
        toast('BEST JELLY .ᐟ BEST JELLY STOPS THE ROT .ᐟ', true);
        spawnParticles(player.pos.x, player.pos.y + 1.4, player.pos.z, 0xb06fff, 14, 4, 0.8);
      }
    } else if (m.k === 0) {
      const wid = player.weapon.melee ? 'pistol' : player.weapon.id; // a melee hand banks it for the pistol
      const add = Math.ceil((WEAPONS[wid].mag || 18) * 0.8 * player.ammoMult);
      reserves[wid] = (reserves[wid] | 0) + add;
      toast(`+${add} AMMO`);
    } else {
      player.hp = Math.min(player.maxHp, player.hp + 25);
      toast('+25 HP');
    }
    SFX.pickup();
    rumble(50, 0.2, 0.4);
    updateAmmoHUD();
  } else if (m.t === 'finale') {
    // grandma remembered: melt out of wherever we are (the splash blur), cross the map,
    // and bloom back in on the ring spot the host set for us (player.finaleTp, updateJelly)
    player.finaleTp = { t: 0, x: m.x, z: m.z };
    recordPrestige();                 // the family clear counts toward your badges too
    startFinale();
    toast('GRANDMA BLINGO .ᐟ THE FAMILY IS WHOLE AGAIN .ᐟ', true);
  } else if (m.t === 'hunt') {
    // the host's boss fell: same hunt call on our screen (the quota readout itself
    // rides the snapshot stream)
    toast(`BOSS DOWN .ᐟ REACH ${m.ct} KILLS TO SECURE THE BLOCK .ᐟ`, true);
    rumble(600, 1, 1);
  } else if (m.t === 'cjoin') {
    // a cousin signed on somewhere in the lobby: same JOINED toast, same N/6 tick
    const cd = COUSINS.find(k => k.id === m.c);
    toast(`${(cd ? cd.name : 'COUSIN').toUpperCase()} JOINED .ᐟ`);
    SFX.recruit();
    if (m.n != null) document.querySelector('#cousins b').textContent = m.n + '/' + (m.tot || 6);
  } else if (m.t === 'secured') {
    game.time = m.tm; game.cleanup = false; game.celebrateT = 5.5;
    updateQuotaHud();
    recordPrestige();                 // multiplayer clears count toward your badges too
    toast('BLOCK SECURED .ᐟ', true);
  }
}
function netSendEmote(i) {
  if (net.role === 'client') { try { net.conns[0].send({ t: 'emote', e: i }); } catch (e) {} }
  else if (net.role === 'host') netBroadcast({ t: 'emote', e: i, p: 1 });
}
// the host settled a bare-skin trade on us: ship the whole kit back up the wire, then
// walk on as the other cousin — same player number, same lobby, new body, new spot.
// The partner's kit lands in m.kit (a host swap) or on a relayed cswapKit (client swap).
function netClientSkinSwap(m) {
  const data = COUSINS.find(c => c.id === m.c);
  if (!data) return;
  const kit = { owned: player.owned.slice(), rs: { ...reserves }, w: player.weapon.id,
    clip: Number.isFinite(player.clip) ? player.clip : 0, hp: Math.max(1, Math.round(player.hp)) };
  try { net.conns[0].send({ t: 'cswapKit', kit }); } catch (e) {}
  applyCousin(data.id);
  player.pos.set(m.x, groundHeight(m.x, m.z), m.z);
  player.vy = 0;
  player.hp = Math.min(player.hp, player.maxHp);
  if (m.kit) applySwapKit(m.kit);
  SFX.tradePing();
  rumble(120, 0.5, 0.5);
  toast(`P${net.playerNum} ~ ${data.name.toUpperCase()} .ᐟ`, true);
  playSwapTheme();
}
// apply a host snapshot: lerp targets for actors + zombie ghosts, HUD sync
function netApplySnapshot(m) {
  if (Math.abs(m.tm - game.time) > 1) game.time = m.tm;
  if (m.k !== game.kills) { game.kills = m.k; hud.kills.textContent = m.k; }
  // the host owns the clock and the weather dice; we tick locally and correct on drift,
  // and glide into the host's weather through the same 20s crossfade it used
  if (m.ck != null && Math.abs(m.ck - (game.clock ?? 0)) > 0.15) game.clock = m.ck;
  if (m.w && m.w !== wx.to) { wx.from = game.weather; wx.to = m.w; wx.u = 0; }
  // Bluga's bar outranks the usual boss bar when he's the one up (blg >= 0)
  const blg = m.blg == null ? -1 : m.blg;
  bossBarEl.classList.toggle('show', m.bb >= 0 || blg >= 0);
  if (blg >= 0) { dressBlugaBar(); bossHpEl.style.width = blg * 100 + '%'; }
  else if (m.bb >= 0) { dressBossBar({ isBoss2: !!m.b2, isBoss3: !!m.b3, isBoss4: !!m.b4 }); bossHpEl.style.width = m.bb * 100 + '%'; }
  // mirror the host's cleanup quota so the REMAIN readout ticks on every screen
  game.cleanup = (m.ct || 0) > 0; game.clearTarget = m.ct || 0; game.quotaN = m.cq || 0;
  // and the recruit tally (N/6) — a late joiner starts on the right count too
  if (m.rn != null) document.querySelector('#cousins b').textContent = m.rn + '/' + (m.rt || 6);
  // and the consumable shelves: same jars gone, same bowls left, on every screen
  if (m.cjm !== undefined && m.cjm !== net._cjm) { net._cjm = m.cjm; applyJellyMask(m.cjm); }
  // the host's ground drops, mirrored as loot ghosts: walk up on one and updatePickups asks
  // the host for it (pkTake) instead of granting locally — the host's world owns the loot.
  // Entries slide out of our interest ring (or get taken) → their ghosts leave with them.
  if (m.pk) {
    const seenP = new Set();
    for (const e of m.pk) {
      seenP.add(e.i);
      if (!pickups.some(p => p.netGhost && p.nid === e.i)) {
        const g = spawnPickup(e.k === 0 ? 'ammo' : e.k === 1 ? 'medkit' : 'bestjelly', e.x, e.z);
        g.netGhost = true; g.nid = e.i; g.reqT = 0;
      }
    }
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      if (p.netGhost && !seenP.has(p.nid)) { scene.remove(p.mesh); pickups.splice(i, 1); }
    }
  }
  // the murder, mirrored: same birds, same ledges, same purple glares on every screen.
  // A bird gone from the stream was SHOT (pop its feathers here too) — unless the whole
  // flock is leaving town (cg), which goes quietly.
  if (m.cw) {
    const seenC = new Set();
    for (const e of m.cw) {
      seenC.add(e.i);
      let c = crows.find(cc => cc.nid === e.i);
      if (!c) {
        c = buildCrow(e.x, e.y, e.z);
        c.nid = e.i; c.netGhost = true; c.foldT = e.st ? 0 : 1;
        if (e.sc) c.g.scale.setScalar(e.sc);
        if (!!e.pu !== c.purple) { // the stream's roll outranks our local one
          c.purple = !!e.pu;
          const ec = c.purple ? CROW_EYE_PURPLE : CROW_EYE_NORMAL;
          for (const ey of c.eyes) ey.material = mat(ec, { emissive: ec, emissiveIntensity: 0.6 });
        }
        if (e.rk && !c.redBeak) crowRedBeak(c);
        else if (!e.rk && c.redBeak) { c.redBeak = false; c.beak.material = mat(CROW_GREY); }
      }
      c.tx = e.x; c.ty = e.y; c.tz = e.z; c.tyw = e.yw; c.air = !!e.st;
    }
    for (let i = crows.length - 1; i >= 0; i--) {
      const c = crows[i];
      if (!seenC.has(c.nid)) {
        if (!m.cg) {
          const p = c.g.position;
          spawnParticles(p.x, p.y + 0.35, p.z, CROW_FEATHER, 6, 2.5, 0.6);
          crowCaw(p.x, p.z, 'die');
        }
        removeCrow(c);
      }
    }
  }
  // Bluga's arena cameo, mirrored: the ghost stands up when the show starts and keeps its
  // phase (working the mob / the Good Luck turn / the slide-hop getaway) in step. When the
  // entry stops streaming he's gone into the smoke here too.
  if (m.cm) {
    if (!net.camG) {
      const blob = buildFbiBlob(BLUGA_FACE, true);
      const gun = buildGunMesh('smg'); blob.gunSocket.add(gun);
      blob.root.position.set(m.cm.x, groundHeight(m.cm.x, m.cm.z), m.cm.z);
      scene.add(blob.root);
      net.camG = { blob, x: m.cm.x, z: m.cm.z, yaw: m.cm.yw || 0, ph: 0, t: 0, greeted: false };
    }
    net.camG.tx = m.cm.x; net.camG.tz = m.cm.z; net.camG.tyw = m.cm.yw; net.camG.ph = m.cm.ph;
  } else if (net.camG) {
    const g = net.camG;
    if (g.ph >= 1) { // he finished the show: the same smoke-grenade exit
      for (let k2 = 0; k2 < 5; k2++) spawnParticles(g.x, groundHeight(g.x, g.z) + 1 + k2 * 0.5, g.z, 0x3a3a42, 26, 7, 2.4);
      play3d(g.x, g.z, () => noiseBurst(0.5, 260, 0.8));
    }
    scene.remove(g.blob.root); if (g.blob.shadow) scene.remove(g.blob.shadow);
    net.camG = null;
  }
  if (m.cct !== undefined && m.cct !== net._cct) { net._cct = m.cct; applyChiliTaken(m.cct); }
  updateQuotaHud();
  applyHostNotches(m.zs, m.ls, m.hg); // and the host's spawn dials + gore-horde, in case a change slipped past
  const seenA = new Set();
  for (const a of m.ac) {
    if (a.p === net.playerNum) continue;          // that's me
    const key = a.p ? 'p' + a.p : 'ai' + a.c;
    seenA.add(key);
    let g = net.actors.get(key);
    if (g && g.data.id !== a.c) {
      // a bare-skin trade re-dressed this player mid-run: rebuild the ghost in the new
      // cousin's colours, standing right where the old one stood
      scene.remove(g.blob.root);
      if (g.blob.shadow) scene.remove(g.blob.shadow);
      const cd = COUSINS.find(c => c.id === a.c) || COUSINS[0];
      const nb = buildBlob({ color: cd.color, gunHand: a.c === 'blondie' ? 'left' : 'right', hands: cousinHands(a.c) });
      nb.root.position.copy(g.blob.root.position);
      nb.root.rotation.y = g.blob.root.rotation.y;
      scene.add(nb.root);
      g = { blob: nb, wp: '', data: cd, p: a.p, walk: g.walk };
      net.actors.set(key, g);
    }
    if (!g) {
      const cd = COUSINS.find(c => c.id === a.c) || COUSINS[0];
      g = { blob: buildBlob({ color: cd.color, gunHand: a.c === 'blondie' ? 'left' : 'right', hands: cousinHands(a.c) }), wp: '', data: cd, p: a.p, walk: 0 };
      scene.add(g.blob.root);
      net.actors.set(key, g);
    }
    if (a.wp !== g.wp) {
      g.wp = a.wp;
      if (g.gunMesh) g.gunMesh.removeFromParent();
      g.gunMesh = a.wp === 'fists' ? null : buildGunMesh(a.wp);
      if (g.gunMesh) g.blob.gunSocket.add(g.gunMesh);
    }
    // another player just hit the floor: the lobby callout (0-check skips fresh ghosts,
    // so joining mid-rescue doesn't announce an old fall)
    if (a.p && a.dn && g.dn === 0) toast(`P${a.p} ${g.data.name.toUpperCase()} DOWN .ᐟ`, true);
    g.tx = a.x; g.tz = a.z; g.ty = a.y; g.tyw = a.yw; g.mv = a.mv; g.hp = a.hp; g.dn = a.dn; g.tar = a.ar;
    g.tgs = a.gs || 1; // chili-giant scale target: the ghost grows/shrinks toward it with the melt blur
  }
  for (const [key, g] of net.actors) if (!seenA.has(key)) { scene.remove(g.blob.root); if (g.blob.shadow) scene.remove(g.blob.shadow); net.actors.delete(key); }
  updatePauseLobby();   // the slots readout follows the actor list live, even mid-pause
  // the remaining cousins still waiting out there: mirror the host's recruit beacons so a
  // client sees (and can walk up) every cousin left to find. A standing cousin blob under a
  // coloured shaft; recruiting one drops it from the next snapshot (netClientWorldTick
  // animates them; netFindNearRecruit lets a client claim one).
  const seenR = new Set();
  for (const r of (m.rc || [])) {
    seenR.add(r.c);
    let g = net.recruits.get(r.c);
    if (!g) {
      const cd = COUSINS.find(c => c.id === r.c) || COUSINS[0];
      const blob = buildBlob({ color: cd.color, gunHand: r.c === 'blondie' ? 'left' : 'right', hands: cousinHands(r.c) });
      scene.add(blob.root);
      const beacon = makeBeacon(cd.color, 0.28);
      scene.add(beacon);
      g = { blob, beacon, data: cd, pos: new THREE.Vector3(r.x, 0, r.z), walkPhase: Math.random() * 9 };
      net.recruits.set(r.c, g);
    }
    g.pos.x = r.x; g.pos.z = r.z;
  }
  for (const [id, g] of net.recruits) if (!seenR.has(id)) {
    scene.remove(g.blob.root); if (g.blob.shadow) scene.remove(g.blob.shadow); scene.remove(g.beacon);
    net.recruits.delete(id);
  }
  const seenZ = new Set();
  for (const zs of m.zb) {
    seenZ.add(zs.i);
    let g = net.ghosts.get(zs.i);
    if (!g) {
      // bosses wear their own livery: without this they fell through to a random
      // zombie colour, so a joiner met a differently-coloured monster than the host
      let blob;
      if (zs.fb) {
        // a black-ops blob: the FBI look, a gun in hand, and the dark shadow-glow tell
        blob = buildFbiBlob(zs.ff != null ? zs.ff : 0xffffff, !!zs.bg);
        const gun = buildGunMesh(zs.bg ? 'rifle' : 'smg'); blob.gunSocket.add(gun); blob.gunMesh = gun;
        const gl = makeLootGlow(0, { r: zs.bg ? 1.1 : 0.85, y: zs.bg ? 2.6 : 2.0, s: zs.bg ? 1.7 : 1.35, dark: true });
        blob.root.add(gl); blob.guardGlow = gl;
      } else {
        const color = zs.bo ? (zs.b4 ? BOSS_ROTTEN : zs.b3 ? BOSS_INFECTED : zs.b2 ? BOSS_CRIMSON : BOSS_PURPLE)
          : zs.re ? 0xd43a3a : zs.gr ? 0x39b83a : zs.pu ? 0x9b4dff : ZOMBIE_COLORS[zs.i % ZOMBIE_COLORS.length];
        blob = buildBlob({ color, zombie: true, scale: zs.sc,
          hands: zs.b4 ? ROTTEN_HANDS : zs.b3 ? INFECTED_HANDS : zs.b2 ? CRIMSON_HANDS
            : zs.bo ? 0x4a1a7a : zs.pu ? 0x4a1a7a : zs.re ? CRIMSON_HANDS : 0 }); // ghost guards + Two Horned One wear the dark mitts too
        // the Rotten One and his rotting walkers wear no horns — the rot is the whole crown
        if ((zs.ho || zs.bo) && !zs.b4) for (const s of [-1, 1]) {
          const horn = cyl(zs.bo ? 0.02 : 0.015, zs.bo ? 0.15 : 0.12, zs.bo ? 0.55 : 0.42, 0x2a1a3a, 6);
          horn.position.set((zs.bo ? 0.22 : 0.2) * s, zs.bo ? 0.3 : 0.28, 0.02);
          horn.rotation.z = -0.55 * s; horn.rotation.x = -0.25;
          blob.head.add(foldSkin(blob, horn));  // ghost horns flash with the body too
        }
        if (zs.b4) addRotGore(blob, { hangEye: true, chestHole: true }); // boss always hangs left
        else if (zs.he || zs.rb || zs.rr || zs.pb) addRotGore(blob, { hangEye: !!zs.he, ribs: !!zs.rb, ribsR: !!zs.rr, belly: !!zs.pb, eyeSide: Math.random() < 0.5 ? 1 : -1 });
        // the tell-tale glows travel: a boss ghost carries his shield glow, a guard ghost
        // its own body-colour glow — the same reads the host sees, on every client screen
        if (zs.bo) attachBossGlow(blob, color);
        else if (zs.gd) { const gl = makeLootGlow(color, { r: 0.85, y: 2.1, s: 1.5 }); gl.userData.glow.orb.visible = false; blob.root.add(gl); blob.guardGlow = gl; }
      }
      scene.add(blob.root);
      g = { blob, pos: new THREE.Vector3(zs.x, 0, zs.z), yaw: zs.yw, scale: zs.sc, isBoss: !!zs.bo, isBoss2: !!zs.b2, isBoss3: !!zs.b3, isBoss4: !!zs.b4,
        state: 'chase', nid: zs.i, netGhost: true, hp: 1, deadT: 0, walkPhase: Math.random() * 9, blind: false,
        purple: !!zs.pu, green: !!zs.gr, goreHorn: !!zs.gh, fbi: !!zs.fb, bluga: !!zs.bg,
        rotHe: !!zs.he, rotRb: !!zs.rb, rotRr: !!zs.rr, rotPb: !!zs.pb };
      net.ghosts.set(zs.i, g);
      zombies.push(g);              // lives in the same list so shots + crosshair see it
    }
    g.tx = zs.x; g.tz = zs.z; g.tyw = zs.yw; g.netSt = zs.st; g.sh = !!zs.sh;
    // late rot: a pistol round can hang an eye mid-fight on the host, and a shotgun kill
    // can split a stomach or blow a chest side open on the way down — dress the ghost the
    // moment each flag arrives, not just at creation
    if (!zs.b4 && g.blob) {
      if (zs.he && !g.rotHe) { addRotGore(g.blob, { hangEye: true, eyeSide: Math.random() < 0.5 ? 1 : -1 }); g.rotHe = 1; }
      if (zs.rb && !g.rotRb) { addRotGore(g.blob, { ribs: true }); g.rotRb = 1; }
      if (zs.rr && !g.rotRr) { addRotGore(g.blob, { ribsR: true }); g.rotRr = 1; }
      if (zs.pb && !g.rotPb) { addRotGore(g.blob, { belly: true }); g.rotPb = 1; }
    }
    if (g.fbi) { g.gv = !!zs.gv; g.tar = zs.ar; }  // Bluga's smoke-vanish + FBI gun-arm pitch
    if (zs.st === 1 && g.state !== 'dying') {
      g.state = 'dying'; g.deadT = 0;
      // gore for a kill we didn't make: a blood burst + splat, and pop the head on a gib /
      // headshot, so a teammate's sledgehammer reads as a kill here instead of a zombie that
      // silently blinks out (we already show blood on our OWN kills via netClientShot)
      const gy = groundHeight(g.pos.x, g.pos.z);
      play3d(g.pos.x, g.pos.z, () => SFX.splat());
      spawnBlood(g.pos.x, gy + 0.8 * g.scale, g.pos.z, 0, 0, 2.2);
      if (zs.dp && !g.blob.headGone) popHead(g, 0, 0);
    }
  }
  for (const [nid, g] of net.ghosts) {
    if (!seenZ.has(nid) && g.state !== 'dying') netRemoveGhost(nid);
  }
}
function netRemoveGhost(nid) {
  const g = net.ghosts.get(nid);
  if (!g) return;
  scene.remove(g.blob.root);
  if (g.blob.shadow) scene.remove(g.blob.shadow);
  net.ghosts.delete(nid);
  const i = zombies.indexOf(g);
  if (i >= 0) zombies.splice(i, 1);
}
// client frame: animate ghosts toward their targets and stream our own pose at 15Hz
// the world/other-players half: runs every frame regardless of local pause state, so a
// paused client sees the lobby actually moving behind the dimmed menu instead of a frozen
// snapshot that then has to catch up on resume. Damage is fully host-authoritative and
// applied via the 'hurt' message handler (never gated on game.state), so pausing here never
// makes you — or anyone else — untouchable; a zombie that reaches your last position still
// lands the hit, you just can't see or react to it until you resume.
function netClientWorldTick(dt) {
  const k = 1 - Math.exp(-10 * dt);
  for (const [, g] of net.actors) {
    const b = g.blob;
    // a streamed TELEPORT (the finale gather): this actor just crossed the whole map —
    // snap them over with the splash melt instead of letting the lerp slide them there
    if (g.tx != null && Math.hypot(g.tx - b.root.position.x, g.tz - b.root.position.z) > 25) {
      if (!g.tpMats) beginBlobFade(g);
      g.meltT = 0.5;
      b.root.position.x = g.tx; b.root.position.z = g.tz;
    }
    if (g.meltT > 0) {
      g.meltT -= dt;
      setBlobFade(g, clamp(1 - Math.max(g.meltT, 0) / 0.5, 0.05, 1));
      if (g.meltT <= 0) endBlobFade(g);
    }
    b.root.position.x = lerp(b.root.position.x, g.tx ?? b.root.position.x, k);
    b.root.position.z = lerp(b.root.position.z, g.tz ?? b.root.position.z, k);
    b.root.position.y = g.ty ?? b.root.position.y;
    b.root.rotation.y = angLerp(b.root.rotation.y, g.tyw || 0, k);
    g.walk += dt * (g.mv ? 10 : 0);
    const swing = Math.sin(g.walk) * (g.mv ? 0.8 : 0.05);
    b.legs[0].rotation.x = swing; b.legs[1].rotation.x = -swing;
    b.arms[b.offArm].rotation.x = -swing * 0.7;
    // ranged arms ride the streamed gun-arm angle (eased over the 10Hz snapshots), so a
    // hero aiming at the sky here aims at the sky on every screen — not a levelled prop
    g.arS = lerp(g.arS ?? -Math.PI / 2, g.tar ?? -Math.PI / 2, 1 - Math.exp(-14 * dt));
    b.arms[b.gunArm].rotation.x = g.wp === 'fists' ? -swing * 0.8
      : (WEAPONS[g.wp] && WEAPONS[g.wp].melee
        ? (MELEE_HOLD[g.wp] ? MELEE_HOLD[g.wp].x   // the straight-out carries match the hero's on every screen
          : meleeCarryLift(-0.55, b.root.position.y + 0.95, groundHeight(b.root.position.x, b.root.position.z), g.gunMesh ? g.gunMesh.userData.reach : 0.8))
        : g.arS);
    if (g.dn) {
      // downed players crawl on their belly, same read as the host's own view of them
      b.wob.rotation.x = 1.2;
      const claw = Math.sin(g.walk * 1.5);
      b.arms[0].rotation.x = -2.25 + claw * 0.55;
      b.arms[1].rotation.x = -2.25 - claw * 0.55;
      b.legs[0].rotation.x = 0.3 + claw * 0.18;
      b.legs[1].rotation.x = 0.3 - claw * 0.18;
    } else b.wob.rotation.x = 0;
    // chili giants on other screens: ease the ghost toward the streamed scale, wearing the
    // splash-melt blur while the size is actually changing (grow AND the shrink back)
    const gsNow = b.root.scale.x, gsTgt = g.tgs || 1;
    if (Math.abs(gsNow - gsTgt) > 0.03) {
      if (!g.tpMats) beginBlobFade(g);
      const ns = lerp(gsNow, gsTgt, 1 - Math.exp(-6 * dt));
      b.root.scale.setScalar(ns);
      setBlobFade(g, 0.35 + 0.65 * Math.abs(ns - (gsNow < gsTgt ? 1 : GIANT_SCALE)) / (GIANT_SCALE - 1));
    } else if (g.tpMats && !g.dn && !(g.meltT > 0)) { endBlobFade(g); b.root.scale.setScalar(gsTgt); }
    placeShadow(b, b.root.position.x, b.root.position.z, b.root.position.y);
    updateFlash(b, dt);
  }
  // mirror the host's final-ten hunt rings on our ghosts (quota fields ride the snapshot)
  const huntFinal = game.cleanup && game.clearTarget > 0 && (game.clearTarget - game.kills) <= 10;
  for (const [nid, g] of net.ghosts) {
    const b = g.blob;
    if (huntFinal && !g.isBoss && !g.fbi && !b.guardGlow && g.state !== 'dying') {
      const gl = makeLootGlow(0x3ae06a, { r: 0.85, y: 2.1, s: 1.5 });
      gl.userData.glow.orb.visible = false;
      b.root.add(gl); b.guardGlow = gl;
    }
    if (g.state === 'dying') {
      if (b.guardGlow) b.guardGlow.visible = false;   // a dead guard's glow dies with it
      if (b.bossGlow) b.bossGlow.visible = false;
      g.deadT += dt;
      b.root.rotation.x = Math.min(g.deadT * 4, Math.PI / 2);
      if (g.deadT > 1.2) b.root.position.y -= dt * 0.8;
      placeShadow(b, g.pos.x, g.pos.z);
      if (g.deadT > 2.4) netRemoveGhost(nid);
      continue;
    }
    // the shield tells, client-side: guards breathe their body-colour glow; the boss's own
    // fades in with his shield (streamed sh flag) and drains off when the last guard drops
    if (b.guardGlow) animateLootGlow(b.guardGlow, game.time + (g.walkPhase || 0));
    if (b.bossGlow) {
      const u = b.bossGlow.userData.glow;
      u.mul = lerp(u.mul, g.sh ? 1 : 0, 1 - Math.exp(-4 * dt));
      animateLootGlow(b.bossGlow, game.time);
    }
    g.pos.x = lerp(g.pos.x, g.tx ?? g.pos.x, k);
    g.pos.z = lerp(g.pos.z, g.tz ?? g.pos.z, k);
    g.yaw = angLerp(g.yaw, g.tyw || 0, k);
    const gy = groundHeight(g.pos.x, g.pos.z);
    b.root.position.set(g.pos.x, gy, g.pos.z);
    b.root.rotation.y = g.yaw;
    // black-ops ghosts: mirror Bluga's smoke-vanish, and hold the gun on the streamed pitch
    if (g.fbi) {
      b.root.visible = !g.gv;
      if (b.guardGlow) b.guardGlow.visible = !g.gv;
      if (!g.gv) {
        b.root.rotation.x = 0;
        g.walkPhase += dt * 2.4;
        const sw = Math.sin(g.walkPhase);
        b.legs[0].rotation.x = sw * 0.45; b.legs[1].rotation.x = -sw * 0.45;
        g.arS = lerp(g.arS ?? -Math.PI / 2, -Math.PI / 2 - (g.tar || 0) * 0.8, 1 - Math.exp(-12 * dt));
        b.arms[b.gunArm].rotation.x = g.arS;
        b.arms[b.offArm].rotation.x = -sw * 0.5;
        if (b.guardGlow) animateLootGlow(b.guardGlow, game.time + (g.walkPhase || 0));
      }
      placeShadow(b, g.pos.x, g.pos.z);
      updateFlash(b, dt);
      continue;
    }
    if (g.netSt === 2) b.root.rotation.x = -1.45;   // still sprawled / clawing out
    else {
      b.root.rotation.x = 0;
      g.walkPhase += dt * 3;
      const sw = Math.sin(g.walkPhase);
      b.legs[0].rotation.x = sw * 0.7; b.legs[1].rotation.x = -sw * 0.7;
      b.arms[0].rotation.x = -1.4 + sw * 0.25; b.arms[1].rotation.x = -1.4 - sw * 0.25;
    }
    animateRotGore(g, b);                              // rot hearts beat + eyes swing here too
    placeShadow(b, g.pos.x, g.pos.z);
    updateFlash(b, dt);
  }
  // Bluga's cameo ghost: glide to the streamed marks and wear the phase's pose — working
  // the mob gun-up, the lowered-gun Good Luck turn (bubble fired once), or the bouncing
  // slide-hop getaway north
  if (net.camG) {
    const g = net.camG, b = g.blob;
    g.t = (g.t || 0) + dt;
    const kk = 1 - Math.exp(-8 * dt);
    g.x = lerp(g.x, g.tx ?? g.x, kk); g.z = lerp(g.z, g.tz ?? g.z, kk);
    g.yaw = angLerp(g.yaw, g.tyw || 0, kk);
    const gy = groundHeight(g.x, g.z);
    b.root.position.set(g.x, gy, g.z);
    b.root.rotation.y = g.yaw;
    const sw = Math.sin(g.t * 7) * 0.4;
    if (g.ph === 2) {
      b.root.position.y = gy + Math.abs(Math.sin(g.t * 9)) * 0.55; // hop to hop, low slide
      b.wob.rotation.x = -0.7; b.legs[0].rotation.x = -1.2; b.legs[1].rotation.x = -1.3;
      b.arms[b.gunArm].rotation.x = -0.3;
    } else {
      b.wob.rotation.x = 0;
      b.legs[0].rotation.x = sw; b.legs[1].rotation.x = -sw;
      b.arms[b.gunArm].rotation.x = g.ph === 1 ? -0.15 : -Math.PI / 2 + 0.1;
      if (g.ph === 1 && !g.greeted) {
        g.greeted = true;
        spawnBubble(() => ({ x: g.x, y: groundHeight(g.x, g.z) + 3.4, z: g.z }), 'Good Luck .ᐟ', g);
        SFX.pickup();
      }
    }
    placeShadow(b, g.x, g.z, gy);
  }
  // the waiting cousins: idle sway under a slow-turning, breathing beacon — the same read
  // the host gives them (see the unrecruited branch of updateCompanions)
  for (const [, g] of net.recruits) {
    const b = g.blob;
    const gy = groundHeight(g.pos.x, g.pos.z);
    b.root.position.set(g.pos.x, gy, g.pos.z);
    b.wob.scale.y = 1 + Math.sin(performance.now() * 0.002 + g.walkPhase) * 0.03;
    b.root.rotation.y = Math.sin(performance.now() * 0.0006 + g.walkPhase) * 0.6;
    b.arms[b.gunArm].rotation.x = -Math.PI / 2;
    b.arms[b.offArm].rotation.x = -0.1;
    placeShadow(b, g.pos.x, g.pos.z, gy);
    g.beacon.position.set(g.pos.x, gy + BEACON_Y, g.pos.z);
    g.beacon.material.opacity = 0.2 + Math.sin(performance.now() * 0.003) * 0.1;
    g.beacon.rotation.y += dt * 0.5;
  }
  netRefreshClientBars();
  // fires the moment hp hits zero, paused or not — the host should never be kept waiting
  // on a death notice just because the victim's own screen happened to be paused
  if (player.dead && !net.sentDead) { net.sentDead = true; try { net.conns[0].send({ t: 'dead' }); } catch (e) {} }
  // the host streams our own fill + our partner's; we paint the two-face pact from it and let
  // it hide the moment the updates stop or both faces empty out (the trade broke off)
  const tp = net.tp;
  if (tp && performance.now() - tp.t < 400 && (tp.me > 0.02 || tp.them > 0.02)) {
    const them = COUSINS.find(k => k.id === tp.tc) || COUSINS[0];
    tradePact(myCousinData().color, them.color, tp.me, tp.them, them.id === 'blondie', tp.ol);
  } else tradePactHide();
}
// the local-input half: only meaningful while you're actually playing, so it's gated behind
// game.state === 'playing'. Freezing this (and not the world tick above) is what makes pause
// a pure spectate-your-own-frozen-body state rather than a way to stop the clock on anyone.
function netClientTick(dt) {
  // a bare fist held out at an armed player's ghost is the skin offer; the ring only
  // fills once they answer (the host streams that back as tradeP), so until it does
  // this names the offer and lets it pitch itself
  let skinOffer = false;
  if ((input.interactHeld || input.interactHeldPad) && !player.dead && !player.downed && player.weapon.id === 'fists' && !playerGiantAny()) {
    for (const [, g] of net.actors) {
      if (!g.p || g.dn || !g.wp || g.wp === 'fists') continue;
      if (Math.hypot(g.blob.root.position.x - player.pos.x, g.blob.root.position.z - player.pos.z) < 3.2) { skinOffer = true; break; }
    }
  }
  updateSkinNudge(dt, skinOffer && !(net.tradePT && performance.now() - net.tradePT < 500 && (net.tradeP || 0) > 0.02));
  net.txT -= dt;
  if (net.txT <= 0 && net.conns[0]) {
    net.txT = 1 / 15;
    const mv = Math.hypot(player.pos.x - (net._px || 0), player.pos.z - (net._pz || 0)) > 0.02 ? 1 : 0;
    net._px = player.pos.x; net._pz = player.pos.z;
    // holding interact near another player streams the trade-hold handshake flag
    let th = 0;
    if ((input.interactHeld || input.interactHeldPad) && !player.dead && !playerGiantAny()) {
      for (const [, g] of net.actors) {
        if (!g.p || g.dn) continue;
        if (Math.hypot(g.blob.root.position.x - player.pos.x, g.blob.root.position.z - player.pos.z) < TRADE_RANGE) { th = 1; break; }
      }
    }
    // first frame we reach out toward a player → auto-fire our trade emote (approaching + trying
    // to trade). The host settles the pact; our own hold just needs to greet + signal consent.
    if (th && !net.thPrev && TRADE_EMOTE >= 0) fireEmote(TRADE_EMOTE);
    net.thPrev = th;
    try {
      net.conns[0].send({ t: 'p', x: player.pos.x, z: player.pos.z, y: player.pos.y,
        yw: playerBlob.root.rotation.y, mv, wp: player.weapon.id, hp: Math.round(player.hp), th,
        // the gun arm's actual angle — full vertical aim, kick included — so every other
        // screen sees this hero pointing exactly where they point
        ar: Math.round(playerBlob.arms[playerBlob.gunArm].rotation.x * 100) / 100,
        gs: (player.giantScale || 1) > 1.02 ? Math.round(player.giantScale * 20) / 20 : undefined,
        dn: player.downed ? 1 : 0 });
    } catch (e) {}
  }
}
// client-side squad bars: every other player big + tagged, AI cousins small
function netRefreshClientBars() {
  const rows = [];
  for (const [key, g] of net.actors) rows.push({ key, g });
  rows.sort((a, b) => (a.g.p || 99) - (b.g.p || 99));
  const sig = rows.map(r => r.key + r.g.data.id + (r.g.wp || '')).join('|'); // cousin id too: skin trades relabel the rows
  if (sig !== net.barSig) {
    net.barSig = sig;
    squadBarsEl.innerHTML = '';
    squadBarEls.length = 0;
    for (const { g } of rows) {
      const hex = '#' + g.data.color.toString(16).padStart(6, '0');
      const row = document.createElement('div');
      row.className = 'sqrow' + (g.p ? ' pc' : '');
      const label = (g.p ? 'P' + g.p + ' ' : '') + g.data.name;
      row.innerHTML = `<div class="sqwrap"><div class="sqbar" style="background:${hex}"></div></div>` +
                      `<span class="sqname" style="color:${hex}">${label}</span>`;
      squadBarsEl.appendChild(row);
      squadBarEls.push({ row, bar: row.querySelector('.sqbar'), c: { get hp() { return g.hp || 0; }, maxHp: g.data.id === 'blomba' ? 125 : 100, get downed() { return !!g.dn; } } });
    }
  }
}
// on a client, another player's ghost we're close to and facing while BOTH melees are
// client-side: the nearest other player's ghost we're close to AND facing, any weapon — the
// target of a hold-to-trade. A tap fires the trade emote; the swap itself is the two-sided hold.
function netFindNearPlayerAny() {
  let best = null, bestD = TRADE_RANGE;
  const fx = -Math.sin(player.camYaw), fz = -Math.cos(player.camYaw);
  for (const [, g] of net.actors) {
    if (!g.p || g.dn) continue;
    if ((g.tgs || 1) > 1.02) continue; // no dealing with (or at) a chili giant
    const dx = g.blob.root.position.x - player.pos.x, dz = g.blob.root.position.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD && (dx * fx + dz * fz) / Math.max(d, 0.001) > 0.5) { bestD = d; best = { p: g.p, name: g.data.name }; }
  }
  return best;
}
// client-side: the nearest AI cousin (no player number) we're close to AND facing, holding a
// different weapon than us. NPCs deal freely — no consent pact — so this is a plain one-tap
// swap request the host settles, same as the host's own findNearTrade/tradeWeapons.
function netFindNearNpcTrade() {
  const myW = player.weapon.id;
  if (myW === 'fists' || !WEAPONS[myW]) return null;   // a bare fist has nothing to trade an NPC but skin
  let best = null, bestD = 2.4;
  const fx = -Math.sin(player.camYaw), fz = -Math.cos(player.camYaw);
  for (const [, g] of net.actors) {
    if (g.p || g.dn || !g.wp || g.wp === 'fists' || g.wp === myW) continue;
    const dx = g.blob.root.position.x - player.pos.x, dz = g.blob.root.position.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestD && (dx * fx + dz * fz) / Math.max(d, 0.001) > 0.5) { bestD = d; best = { c: g.data.id, name: g.data.name, wp: g.wp }; }
  }
  return best;
}
// a downed teammate (another player's ghost, or the host's) close enough for a CLIENT to
// haul up. The client only knows players as actor ghosts, so findNearDowned (which walks
// companions) never sees them — this is the client's own reach check. The host owns the
// actual revive; a tap just asks for it.
function netFindNearDowned() {
  let best = null, bestD = 2.8;
  for (const [, g] of net.actors) {
    if (!g.p || !g.dn) continue;
    const d = Math.hypot(g.blob.root.position.x - player.pos.x, g.blob.root.position.z - player.pos.z);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}
// an unrecruited cousin (streamed recruit beacon) close enough for a CLIENT to sign up. The
// host owns the squad, so a tap just asks; the recruit lands on every screen at once.
function netFindNearRecruit() {
  let best = null, bestD = 3.2;   // matches the host's findNearRecruit reach
  for (const [, g] of net.recruits) {
    const d = Math.hypot(g.pos.x - player.pos.x, g.pos.z - player.pos.z);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}
// a client's own shots don't damage ghosts directly: local feedback + wire to the host
function netClientShot(z, dmg, kx, kz, opts) {
  if (!z.nid) return;
  if (z.isBoss && z.sh) {
    // hit a boss while its wave guards still stand: it shrugs — show the invuln colour, not
    // blood, so a client reads "no damage" the same way the host does
    flashBlob(z.blob, FLASH_GREEN);
    spawnParticles(z.pos.x, z.blob.root.position.y + 1.6 * z.scale, z.pos.z, 0x3ae06a, 3, 2.5, 0.3);
  } else {
    spawnDamageNumber(z.pos.x, z.blob.root.position.y + (opts.isHead ? 1.45 : 0.95) * z.scale, z.pos.z, dmg);
    spawnBlood(z.pos.x, z.blob.root.position.y + (opts.isHead ? 1.25 : 0.75) * z.scale, z.pos.z, kx, kz, 1);
    flashBlob(z.blob);
  }
  try {
    net.conns[0].send({ t: 'shot', id: z.nid, d: dmg, hd: !!opts.isHead, kx, kz,
      ds: opts.dist || 0, wid: (opts.weapon || {}).id });
  } catch (e) {}
}
// tear down whatever multiplayer state exists (safe to call any time)
function netLeave() {
  net.leaving = true;
  if (net.reconnecting) endReconnect();   // stop any in-flight reconnect attempts + banner
  netScanStop();
  // a deliberate leave tells the host to free our seat NOW so the number + cousin can be
  // inherited immediately — that's what separates a real quit from a phone that just slept.
  // Send first, then destroy the peer a beat later so the message actually flushes.
  const dyingPeer = net.peer;
  if (net.role === 'client' && net.conns[0]) { try { net.conns[0].send({ t: 'leave', tok: clientToken() }); } catch (e) {} }
  net.peer = null; net.role = null; net.conns = []; net.playerNum = 0; net.lobbyCode = '';
  net.sentDead = false; net.barSig = ''; net.hostPaused = false;
  net.reconnecting = false;
  if (dyingPeer) setTimeout(() => { try { dyingPeer.destroy(); } catch (e) {} }, 150);
  restoreOwnNotches();     // the spawn rows go back to being theirs, ungreyed
  updateHostPauseLock();
  for (const [nid] of [...net.ghosts]) netRemoveGhost(nid);
  for (const [key, g] of [...net.actors]) { scene.remove(g.blob.root); if (g.blob.shadow) scene.remove(g.blob.shadow); net.actors.delete(key); }
  for (const [id, g] of [...net.recruits]) { scene.remove(g.blob.root); if (g.blob.shadow) scene.remove(g.blob.shadow); scene.remove(g.beacon); net.recruits.delete(id); }
  for (const c of companions) { c.netP = null; c.netConn = null; c.netPose = null; c.netHold = 0; c.netTok = null; }
  net.leaving = false;
}
// the host vanished mid-run: everyone gets walked back out gracefully
function showHostClosed() {
  netLeave();
  game.state = 'menu';
  document.body.classList.remove('playing');
  for (const id of ['startscreen', 'deathscreen', 'lobbyscreen', 'pausescreen']) document.getElementById(id).classList.add('hidden');
  document.getElementById('hostclosed').classList.remove('hidden');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  stopTheme();
}
// remote-controlled cousins follow their player's streamed pose instead of squad AI
function netPoseCompanion(c, dt) {
  const p = c.netPose;
  const b = c.blob;
  if (p) {
    // a streamed TELEPORT (the finale gather warping this player across the map): snap
    // over with the splash melt — blooming in from nothing — never a cross-map slide
    if (Math.hypot(p.x - c.pos.x, p.z - c.pos.z) > 25) {
      if (!c.tpMats) beginBlobFade(c);
      c.meltT = 0.5;
      c.pos.x = p.x; c.pos.z = p.z;
    }
    if (c.meltT > 0) {
      c.meltT -= dt;
      setBlobFade(c, clamp(1 - Math.max(c.meltT, 0) / 0.5, 0.05, 1));
      if (c.meltT <= 0 && !c.tp) { endBlobFade(c); }
    }
    const k = 1 - Math.exp(-12 * dt);
    c.pos.x = lerp(c.pos.x, p.x, k);
    c.pos.z = lerp(c.pos.z, p.z, k);
    c.y = p.y; c.yaw = p.yw;
    if (p.wp && WEAPONS[p.wp] && (c.weapon || {}).id !== p.wp) setCompanionWeapon(c, p.wp);
    c.walkPhase += dt * (p.mv ? 10 : 0);
  }
  const swing = Math.sin(c.walkPhase) * (p && p.mv ? 0.8 : 0.05);
  b.root.position.set(c.pos.x, c.y || groundHeight(c.pos.x, c.pos.z), c.pos.z);
  b.root.rotation.y = angLerp(b.root.rotation.y, c.yaw, 1 - Math.exp(-10 * dt));
  b.legs[0].rotation.x = swing; b.legs[1].rotation.x = -swing;
  b.arms[b.offArm].rotation.x = -swing * 0.7;
  // their streamed gun-arm angle, eased over the 15Hz stream: real x/y aim, not a levelled prop
  c.arS = lerp(c.arS ?? -Math.PI / 2, p && p.ar != null ? p.ar : -Math.PI / 2, 1 - Math.exp(-14 * dt));
  b.arms[b.gunArm].rotation.x = c.weapon && c.weapon.melee
    ? (MELEE_HOLD[c.weapon.id]
      ? MELEE_HOLD[c.weapon.id].x   // the straight-out carries ride the same on every screen
      : meleeCarryLift(-0.55, (c.y || 0) + 0.95, groundHeight(c.pos.x, c.pos.z), c.gunMesh ? c.gunMesh.userData.reach : 0.8))
    : c.arS;
  // downed: mirror their crawl, and drag their beacon along as they haul themselves off
  if (c.downed) {
    b.wob.rotation.x = 1.2;
    const claw = Math.sin(c.walkPhase * 1.5);
    b.arms[0].rotation.x = -2.25 + claw * 0.55;
    b.arms[1].rotation.x = -2.25 - claw * 0.55;
    b.legs[0].rotation.x = 0.3 + claw * 0.18;
    b.legs[1].rotation.x = 0.3 - claw * 0.18;
    if (c.beacon) c.beacon.position.set(c.pos.x, groundHeight(c.pos.x, c.pos.z) + BEACON_Y, c.pos.z);
  } else if (b.wob.rotation.x) b.wob.rotation.x = 0;
  // a client that ate the chili: the host's view of them grows/shrinks through the same
  // melt blur, driven off the gs field riding their pose stream
  const cgNow = b.root.scale.x, cgTgt = c.netGs || 1;
  if (Math.abs(cgNow - cgTgt) > 0.03) {
    if (!c.tpMats) beginBlobFade(c);
    const ns = lerp(cgNow, cgTgt, 1 - Math.exp(-6 * dt));
    b.root.scale.setScalar(ns);
    setBlobFade(c, 0.35 + 0.65 * Math.abs(ns - (cgNow < cgTgt ? 1 : GIANT_SCALE)) / (GIANT_SCALE - 1));
  } else if (c.tpMats && !c.tp && !c.downed && !(c.meltT > 0)) { endBlobFade(c); b.root.scale.setScalar(cgTgt); }
  placeShadow(b, c.pos.x, c.pos.z, c.y);
  updateFlash(b, dt);
}
// a genuine tab close / navigate-away frees the seat right away (best-effort — mobile screen
// sleep fires visibilitychange/pagehide, NOT beforeunload, so it stays a reconnect, not a leave)
addEventListener('beforeunload', () => {
  if (net.role === 'client' && net.conns[0]) { try { net.conns[0].send({ t: 'leave', tok: clientToken() }); } catch (e) {} }
  if (net.peer) { try { net.peer.destroy(); } catch (e) {} }
});

// ---------- boot ----------
refreshControlsBar();
renderPrestige();
equipWeapon('fists');
applyLayout(defaultLayout()); // the classic deal: currentLayout + the collider net start coherent
buildTown();
game.clock = 9; wxReset(); applyEnvironment(); // a gentle mid-morning behind the menus
applyEnvironment(); // morning sky behind the menus too
updateChunks(0, 0);
player.pos.y = groundHeight(0, 0);
playerBlob.root.position.copy(player.pos);
window.__tagDbg = { updatePlayerTags, trackedActors, tagOccluded, spawnBoss2, darken, CRIMSON_HANDS };
window.__dbg = {
  player, game, zombies, crows, buildCrow, camera, input, companions, settings, notches, setNotch, WEAPONS, supportTop, net,
  groundHeight, chunks, buildingAt, flatPads, rollCrateLoot,
  openNearest: () => { const c = findNearCrate(); if (c) openCrate(c); },
  recruitNearest: () => { const c = findNearRecruit(); if (c) recruitCousin(c); },
  give: id => giveWeapon(id),
  spawn: (dx = 3, dz = 0) => spawnZombie(player.pos.x + dx, player.pos.z + dz),
  hurtZombie: (z, dmg, opts) => damageZombie(z, dmg, 0, 1, 2, opts),
  blowLimb: z => blowLimb(z, 0, 1),
  popHead: z => popHead(z, 0, 1),
  squadCmd, issueSquadCmd, executeHoldTrade, executeSkinTrade, applySwapKit, playSwapTheme, updateSkinNudge, tradeRing, updateHoldTrades, fireWeapon, updateCompanions,
  startGameMusic, stopGameMusic, get gmusic() { return gmusic; }, gameMusicTick,
  exposeBrain, killZombie, pauseGame, resumeGame, scene, allCrates, cycleWeapon,
  get playerBlob() { return playerBlob; },
  fire: () => fireWeapon(),
  hurt: (dmg, ax, az) => hurtPlayer(dmg, ax, az),
  toggleFPV, bossState, spawnBoss, spawnBoss2, spawnBoss3, spawnBoss4, maybeSpawnBoss, applyEnvironment, completeCleanup, tradeWeapons, findNearTrade,
  jellyBar, chiliBar, lootJelly, lootChili, grantJelly, grantChili, eatChili, jellyRevive, goDown, hurtPlayer, JELLY, JELLY_G, jelly,
  updateGiant, giantStomp, openCrate, allCrates,
  bluga, prestige, spawnBlugaFinal, startCameo, spawnFbi, updateBluga, FOUNTAIN, CAMEO_SPOT,
  spawnJellyMarks, grandmaWake, findNearGrandma,
  randomLayout, defaultLayout, applyLayout, rebuildTownWorld, PARK, CHURCHYARD, CHURCH, GRAVEYARD, COUSIN_HOMES, TOWN_RECTS, TOWN_BOUND, LAYOUT, scatterCousins,
  // jump straight to the endgame: mark the first three bosses cleared, kit the player + squad
  // out, drop everyone at the picnic ground and stand the Rotten One up for the fight + trek
  rotten: (recruit = true) => {
    // tear down any prior Rotten One + his beam first, so a re-run always stands up a FRESH,
    // visible boss instead of leaving a spent/invisible one behind with a live boss bar
    if (bossState.boss) {
      scene.remove(bossState.boss.blob.root);
      if (bossState.boss.blob.shadow) scene.remove(bossState.boss.blob.shadow);
      const bi = zombies.indexOf(bossState.boss); if (bi >= 0) zombies.splice(bi, 1);
    }
    if (bossState.beam) { scene.remove(bossState.beam); bossState.beam = null; }
    bossState.boss = null; bossState.spawned4 = false; bossState.defeated4 = false;
    bossBarEl.classList.remove('show');
    // clear any leftover endgame from a prior defeat: the Jelly House light + grandma's ghost,
    // the tally, and the party/cleanup flags — plus un-mute spawns if a booth turned them off
    if (jelly.beacon) { scene.remove(jelly.beacon); jelly.beacon = null; }
    if (jelly.ghost) { scene.remove(jelly.ghost.root); jelly.ghost = null; }
    jelly.awake = false; jelly.statT = -1;
    if (typeof hideFinalStats === 'function') hideFinalStats();
    game.celebrateT = 0; game.cleanup = false;
    if (settings.zombieSpawn <= 0) settings.zombieSpawn = 1;
    bossState.spawned = bossState.spawned2 = bossState.spawned3 = true;
    bossState.defeated = bossState.defeated2 = bossState.defeated3 = true;
    if (recruit) companions.forEach(c => { if (!c.recruited) recruitCousin(c); });
    window.__dbg.kit();
    player.pos.set(129, groundHeight(129, -58), -58);
    spawnBoss4();
  },
  // max ammo, every gun in hand, and every recruited cousin handed an assault rifle
  kit: () => {
    for (const id of Object.keys(WEAPONS)) {
      if (id === 'fists') continue;
      if (!player.owned.includes(id)) player.owned.push(id);
      if (!WEAPONS[id].melee) reserves[id] = 9999;
    }
    player.owned.sort((a, b) => slotRank(a) - slotRank(b));
    equipWeapon('rifle');
    updateAmmoHUD();
    companions.forEach(c => { if (c.recruited) setCompanionWeapon(c, 'rifle'); });
  },
  setSky: (phase, weather) => { game.clock = [8, 13, 18.7, 23][phase] ?? 13; if (weather) wxSet(weather); applyEnvironment(); },
  setClock: (h) => { game.clock = h % 24; applyEnvironment(); },
  recruitAll: () => companions.forEach(c => { if (!c.recruited) recruitCousin(c); }),
  step: (dt = 0.05) => { updatePlayer(dt); updateCompanions(dt); updateZombies(dt); updateCrates(dt); updatePickups(dt); updateSpawner(dt); updateJelly(dt); updateCelebration(dt); updateFx(dt); },
};

// ---------- living tab: rotating cousin-face favicon + typewriter title (cycles forever) ----------
let tabCousin = 0; // which cousin the tab is currently spelling — the splash stage mirrors it
// The living tab cycles every cousin's name in the menu. Start a run (or host/join a lobby)
// as a cousin and it spells THAT hero one last time, then holds the name static with its
// sideways-! flourish; a mid-run skin swap re-spells the traded hero once and holds the new
// one; quitting to the menu lets go and resumes the full cycle. lock === null is "cycling".
tabTitle = (function livingTab() {
  const link = document.createElement('link');
  link.rel = 'icon'; link.type = 'image/png';
  document.head.appendChild(link);
  let ci = 0, li = 0, lock = null, timer = null;
  function tick() {
    const c = COUSINS[ci];
    if (li === 0) { link.href = faceIcon(c.color, c.id === 'blondie'); tabCousin = ci; } // this cousin's turn begins
    li++;
    if (li >= c.name.length) {
      document.title = c.name + ' .ᐟ';              // finished: name + flourish
      if (lock !== null && ci === lock) return;     // locked hero fully spelled: hold it, stop ticking
      ci = lock !== null ? lock : (ci + 1) % COUSINS.length; // a lock that arrived mid-pass is spelled next
      li = 0;
      timer = setTimeout(tick, 900);
    } else {
      document.title = c.name.slice(0, li);         // one more letter (every .5s)
      timer = setTimeout(tick, 500);
    }
  }
  tick();
  return {
    lockTo(idx) {                                    // spell this hero once from the top, then hold
      if (idx == null || idx < 0) return;
      lock = idx; clearTimeout(timer); ci = idx; li = 0; tick();
    },
    unlock() {                                       // let go and resume the full cycle from the next cousin
      if (lock === null) return;
      const from = lock; lock = null;
      clearTimeout(timer); ci = (from + 1) % COUSINS.length; li = 0; tick();
    },
  };
})();

// ---------- opening splash ----------
// First thing anyone sees: deep space tinted the showing hero's colour, stars rushing
// past, and the cousins taking turns rotating in the light — the real in-game blob
// model, fists out, wearing their name over an XXL boss chevron in their own colour.
// The rotation order rides the living-tab typewriter (tabCousin), so the blob on
// stage is always the cousin the tab title is spelling. Any click / key / pad button
// / touch is the audio unlock the browser was waiting for: it fires the confirm ping,
// starts the opening medley (at the remembered music volume) and fades this screen
// into the cousin picker, ambience rising underneath.
const splash = { active: true, ready: false, done: false, shown: 0, morph: 0, morphT: 0, yaw: 0, t: 0 };
const splashEl = document.getElementById('splash');
const splashTagEl = document.getElementById('splashTag');
const _splTagV = new THREE.Vector3();
const splashBg = new THREE.Color(0x07080d);
const splashHeroC = new THREE.Color();
let splashRenderer = null, splashScene = null, splashCam = null, splashBlobs = null, splashStars = null;
{
  const starsCv = document.getElementById('splashStars');
  const starsCx = starsCv.getContext('2d');
  // the little stage: its own renderer on an alpha canvas so the stars show through
  splashRenderer = new THREE.WebGLRenderer({ canvas: document.getElementById('splashBlob'), alpha: true, antialias: true });
  splashRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  splashScene = new THREE.Scene();
  splashScene.add(new THREE.HemisphereLight(0x8fa3d0, 0x2e2a22, 1.2));
  const key = new THREE.DirectionalLight(0xfff2dd, 0.95);
  key.position.set(2.5, 4, 3);
  splashScene.add(key);
  splashCam = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
  // all six cousins built up front (they're a few dozen boxes each), fists out
  splashBlobs = COUSINS.map(c => {
    const b = buildBlob({ color: c.color, hands: cousinHands(c.id) });
    b.arms[0].rotation.x = b.arms[1].rotation.x = -1.5;  // both fists punched forward
    b.arms[0].rotation.z = 0.14; b.arms[1].rotation.z = -0.14;
    b.root.visible = false;
    splashScene.add(b.root);
    return b;
  });
  splashBlobs[0].root.visible = true;
  // rushing starfield: angle + unit distance from centre; speed swells as they near the rim
  splashStars = Array.from({ length: 240 }, () => ({
    a: Math.random() * TAU, d: Math.random(), sp: 0.25 + Math.random() * 0.6 }));
  function splashSize() {
    if (!splash.active) return;
    starsCv.width = innerWidth; starsCv.height = innerHeight;
    splashRenderer.setSize(innerWidth, innerHeight);
    splashCam.aspect = innerWidth / innerHeight;
    splashCam.updateProjectionMatrix();
  }
  splashSize();
  addEventListener('resize', splashSize);
  splash.starsCx = starsCx;
  splash.starsCv = starsCv;
  splash.sizeFn = splashSize; // splashTick re-checks each frame: a pane that reported
  // zero width at boot (hidden tab, prerender) heals itself the moment it has a size
}
// LOADING . . holds the door until the game is actually warm, not just until the icon
// images landed. The warmup builds one of everything a run will need (guns, a black-ops
// blob, a rotting walker, the loot glow) into a hidden pocket to prime the material +
// geometry caches, then renderer.compile() bakes every shader the standing town uses —
// so the first firefight never stutters on a mid-frame shader compile. Spread across
// idle frames; the click/tap prompt only appears once it's all done.
let splashWarmed = false;
function splashWarmup() {
  if (splashWarmed) return;
  splashWarmed = true;
  const pocket = new THREE.Group();
  pocket.position.set(0, -60, 0);          // under the world: present for compile, never seen
  try {
    for (const id of Object.keys(WEAPONS)) if (id !== 'fists') pocket.add(buildGunMesh(id));
    const fbi = buildFbiBlob(0x6fd8ff, false); pocket.add(fbi.root); if (fbi.shadow) scene.remove(fbi.shadow);
    const rot = buildBlob({ color: 0x6fae4e, zombie: true });
    addRotGore(rot, { hangEye: true, ribs: true, belly: true });
    pocket.add(rot.root); if (rot.shadow) scene.remove(rot.shadow);
    pocket.add(makeLootGlow(0xffdc78, {}));
    pocket.add(makeLootGlow(0, { dark: true }));
    scene.add(pocket);
    renderer.compile(scene, camera);       // every material in town + the pocket, baked now
  } catch (e) {}
  setTimeout(() => {                       // one beat later: the pocket leaves, caches stay warm
    scene.remove(pocket);
    pocket.traverse(o => { if (o.geometry && o.geometry !== BOX && o.geometry !== SPHERE && o.geometry !== shadowGeo) o.geometry.dispose(); });
    splash.ready = true;
    document.getElementById('splashHint').textContent = IS_TOUCH ? 'TAP ANYWHERE .ᐟ' : 'CLICK .ᐟ ANY KEY .ᐟ ANY BUTTON .ᐟ';
  }, 120);
}
function splashReady() {
  if (splash.ready || splashWarmed) return;
  // give the splash a frame to paint LOADING . . before the warmup blocks the thread
  requestAnimationFrame(() => requestAnimationFrame(splashWarmup));
}
if (document.readyState === 'complete') splashReady();
else addEventListener('load', splashReady);
function splashDismiss() {
  if (!splash.ready || splash.done) return;
  splash.done = true;
  // the same click/keypress that opens the game is a real user gesture, so ride it
  // straight into fullscreen — Esc (or Alt+Enter / Ctrl+F) hands it back
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()?.catch(() => {});
  initAudio();          // the user gesture audio was waiting on — ambience rises with it
  SFX.tradePing();      // the confirm ping for the input itself
  playOpeningTheme();   // six motifs in one march, at the volume the settings remember
  splashEl.classList.add('hide');
  setTimeout(() => {
    splash.active = false;
    splashEl.remove();
    splashRenderer.dispose(); // frees the stage's GL context; the game's own is untouched
  }, 1050);
}
splashEl.addEventListener('pointerdown', e => { e.preventDefault(); splashDismiss(); });
addEventListener('keydown', () => { if (splash.active) splashDismiss(); });
function splashTick(dt) {
  splash.t += dt;
  // --- stars over hero-tinted space (translucent fill leaves motion trails) ---
  if (splash.starsCv.width !== innerWidth || splash.starsCv.height !== innerHeight) splash.sizeFn();
  const cx = splash.starsCx, W = innerWidth, H = innerHeight;
  const hero = COUSINS[splash.shown];
  splashHeroC.set(hero.color).multiplyScalar(0.13);
  splashBg.lerp(splashHeroC, 1 - Math.exp(-2.2 * dt));
  cx.fillStyle = 'rgba(' + ((splashBg.r * 255) | 0) + ',' + ((splashBg.g * 255) | 0) + ',' + ((splashBg.b * 255) | 0) + ',0.5)';
  cx.fillRect(0, 0, W, H);
  const R = Math.hypot(W, H) * 0.52;
  cx.lineCap = 'round';
  for (const s of splashStars) {
    const d0 = s.d;
    s.d += s.sp * dt * (0.22 + s.d * 1.6);
    if (s.d >= 1) { s.a = Math.random() * TAU; s.d = 0.03 + Math.random() * 0.05; s.sp = 0.25 + Math.random() * 0.6; continue; }
    const e0 = d0 * d0 * R, e1 = s.d * s.d * R; // ease outward: crawl at centre, whip past the rim
    cx.strokeStyle = 'rgba(255,255,255,' + (0.16 + s.d * 0.6).toFixed(3) + ')';
    cx.lineWidth = 0.6 + s.d * 1.8;
    cx.beginPath();
    cx.moveTo(W / 2 + Math.cos(s.a) * e0, H / 2 + Math.sin(s.a) * e0);
    cx.lineTo(W / 2 + Math.cos(s.a) * e1, H / 2 + Math.sin(s.a) * e1);
    cx.stroke();
  }
  // --- the stage: slow turn, blur-morph to whoever the tab is spelling ---
  if (splash.morph === 0 && tabCousin !== splash.shown) {
    splash.morph = 1; splash.morphT = 0;
    splashEl.classList.add('morph'); // blur climbs (CSS transition)
  } else if (splash.morph === 1) {
    splash.morphT += dt;
    if (splash.morphT >= 0.42) {     // deep in the blur: swap the cousin + the marquee
      splashBlobs[splash.shown].root.visible = false;
      splash.shown = tabCousin;
      splashBlobs[splash.shown].root.visible = true;
      const c = COUSINS[splash.shown];
      const hex = '#' + c.color.toString(16).padStart(6, '0');
      const tag = document.getElementById('splashTag');
      tag.querySelector('b').textContent = c.name.toUpperCase();
      tag.querySelector('b').style.color = hex;
      tag.querySelector('i').style.color = hex;
      splashEl.classList.remove('morph'); // and the blur falls away
      splash.morph = 2; splash.morphT = 0;
    }
  } else if (splash.morph === 2) {
    splash.morphT += dt;
    if (splash.morphT >= 0.42) splash.morph = 0;
  }
  splash.yaw += dt * 0.45;
  const b = splashBlobs[splash.shown];
  b.root.rotation.y = splash.yaw;
  splashCam.position.set(0, 1.18 + Math.sin(splash.t * 0.7) * 0.05, 3.9);
  splashCam.lookAt(0, 0.92, 0);
  splashRenderer.render(splashScene, splashCam);
  // pin the marquee to the blob's actual crown, not the window: read the head's live world
  // position (render just ran, so the matrices are current), lift a hair past the scalp for
  // a neat gap, and hang the chevron tip there (CSS translates the tag up by its own height).
  // Projecting the real head — not a guessed constant — keeps the chevron on the scalp at
  // every viewport, and rides the camera's idle bob for free.
  b.head.getWorldPosition(_splTagV);
  _splTagV.y += 0.5;   // crown (~+0.4 above the head origin) plus a small gap
  _splTagV.project(splashCam);
  splashTagEl.style.top = ((-_splTagV.y * 0.5 + 0.5) * H) + 'px';
  // any pad button is "any input" too (the pad polling below is menu-nav, so it's
  // held off until the splash lets go of the frame)
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) {
    if (gp && gp.buttons.some(bt => bt && bt.pressed)) {
      // a pad seen here is connected, whatever events did or didn't fire — adopt it so
      // the menu polling actually runs once the splash lets go
      if (gpIndex === null) gpIndex = gp.index;
      // remember the held buttons: the press that wakes the splash must not ALSO count
      // as a fresh A on the character select underneath
      gp.buttons.forEach((bt, i) => { gpPrev[i] = !!(bt && bt.pressed); });
      splashDismiss(); break;
    }
  }
}
// paint the marquee's opening colours (Blingo) before the first frame
{
  const hex = '#' + COUSINS[0].color.toString(16).padStart(6, '0');
  const tag = document.getElementById('splashTag');
  tag.querySelector('b').style.color = hex;
  tag.querySelector('i').style.color = hex;
}

animate();
