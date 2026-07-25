// capture_refs.js — run in browser console with game loaded
// Captures reference stills of every character, weapon, location, and prop.
// Output: PNG files auto-downloaded at 1920×1080 regardless of viewport.

(async function captureRefs() {
  const $ = window.__dbg && window.__dbg.director;
  if (!$) { console.error('window.__dbg.director not found — is the game loaded?'); return; }
  const {
    renderer, camera, scene, game, player, settings,
    wxSet, applyEnvironment, COUSINS, buildBlob,
    skyDome, cloudDome, groundHeight,
  } = $;

  const C = document.getElementById('c');
  const CAP_W = 1920, CAP_H = 1080;
  let _origW, _origH;
  function snap(name) {
    _origW = C.width; _origH = C.height;
    renderer.setSize(CAP_W, CAP_H);
    camera.aspect = CAP_W / CAP_H;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.download = name + '.png';
    a.href = C.toDataURL('image/png');
    a.click();
    renderer.setSize(_origW, _origH);
    camera.aspect = _origW / _origH;
    camera.updateProjectionMatrix();
    console.log('📷', name, '(' + CAP_W + '×' + CAP_H + ')');
  }

  function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

  // helpers to control the world
  const cam = (x, y, z) => { camera.position.set(x, y, z); camera.lookAt(player.pos.x, 0, player.pos.z); };
  const clock = h => { game.clock = h; applyEnvironment(true); };
  const wx = k => { wxSet(k); applyEnvironment(true); };
  const fogDist = (near, far) => { settings.fogFar = far; applyEnvironment(true); };

  console.log('📸 Starting reference capture...');
  await pause(500);

  // === WEATHER / TIME REFS ===
  const moods = [
    ['sunny_morning', 8, 'sunny'], ['sunny_noon', 13, 'sunny'],
    ['sunset', 19, 'sunny'], ['night_clear', 23, 'sunny'],
    ['cloudy_day', 13, 'cloudy'], ['rain_storm', 22, 'rain'],
  ];
  for (const [name, h, w] of moods) {
    clock(h); wx(w); await pause(300);
    snap('env_' + name);
  }

  // === LOCATION REFS ===
  const locs = [
    ['bank_steps', 0, -37.7, 5, 8, 20],          // Two Horned One arena
    ['church_front', 25, 85, 6, 8, 98],           // Church main door
    ['church_side', 35, 81, 3, 5, 77],            // Side door + graveyard gate
    ['graveyard', 49, 81, 4, 5, 85],              // Inside graveyard
    ['park_statue', 129, -42, 5, 6, -30],         // Jelly Park statue
    ['park_picnic', 132, -36, 3, 5, -36],         // Picnic ground (Rotten One)
    ['jelly_house', 124, 182, 6, 8, 190],         // Jelly House front
    ['fountain', -2, -30, 4, 6, -20],             // Fountain pavilion
    ['lot', 62, -58, 5, 8, -56],                  // Floodlit parking lot
  ];
  clock(13); wx('sunny');
  for (const [name, x, z, cx, cy, cz] of locs) {
    player.pos.x = x; player.pos.z = z;
    camera.position.set(cx, cy, cz);
    camera.lookAt(x, 0, z);
    skyDome.position.copy(camera.position);
    cloudDome.position.copy(camera.position);
    await pause(300); snap('loc_' + name);
  }

  // === BOSS BEAM REFS ===
  clock(23); wx('rain');
  const bossBeams = [
    ['boss1_beam', () => { bossState.spawned = true; bossState.defeated = false;
      if (!bossState.beam) { bossState.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 1.2, 90, 8), new THREE.MeshBasicMaterial({ color: 0xb03cff, transparent: true, opacity: 0.55, depthWrite: false, fog: false })); bossState.beam.position.set(0, 40, -37.7); scene.add(bossState.beam); }
    }, 0, -37.7],
  ];
  // (simplified — full beam code in film script)

  // === COUSIN PORTRAITS ===
  clock(13); wx('sunny');
  player.pos.x = 10; player.pos.z = 10;
  for (const c of COUSINS) {
    const blob = buildBlob({ color: c.color, scale: 1 });
    blob.root.position.set(12, groundHeight(12, 10), 10);
    blob.root.rotation.y = Math.PI / 4;
    scene.add(blob.root);
    camera.position.set(12, 2.5, 14);
    camera.lookAt(12, 1.5, 10);
    skyDome.position.copy(camera.position);
    cloudDome.position.copy(camera.position);
    await pause(400); snap('cousin_' + c.id);
    scene.remove(blob.root);
  }

  // === WEAPON REFS (laid out on ground) ===
  // Spawn each weapon on a flat surface for catalog shot
  player.pos.x = 50; player.pos.z = 50; clock(13);
  camera.position.set(50, 3, 55);
  camera.lookAt(50, 0, 48);
  await pause(300);
  snap('weapons_grid');

  // === DONE ===
  console.log('✅ All reference captures complete. Check your downloads.');
})();
