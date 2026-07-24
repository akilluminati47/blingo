# BLINGO

An infinite-map, squad zombie shooter built with plain JavaScript and Three.js. Play as one of six immune blob cousins of blob-kind, clear the wasteland, loot glowing crates for guns and ammo, and recruit the other cousins to fight alongside you.

---

## Play

- **https://blingo.pages.dev** — Public or Private (code-based) Multiplayer in browser
- Solo or squad up with friends
- No downloads, no sign-ups — just pick a cousin and drop in

The website is the home of BLINGO — the fastest way to play and always the freshest build.

---

## Standalone Apps (Windows + Android)

Prefer a standalone? Grab the latest builds from [**GitHub Releases**](https://github.com/akilluminati47/blingo/releases/latest):

- **Setup .exe** — Windows guided installer: license page, install-location choice, desktop shortcut offered (recommended)
- **Portable .exe** — Windows single file, no install
- **Android .apk** — sideload on your phone/tablet (allow "install unknown apps" when prompted)

The Windows app is the same game, wrapped in Electron with the Chromium/ANGLE GPU stack tuned for desktop play: GPU blocklist ignored, GPU rasterization + zero-copy forced on, vsync/frame-rate cap lifted, and no browser tab throttling — your frame never freezes mid-run. The Android app wraps the same build in a Capacitor WebView. Steam integration (overlay/achievements via steamworks.js) is wired in and activates when a Steam App ID ships with the build.

Every push to `main` increments the version (0.0.9 → 0.1.0, 0.9.9 → 1.0.0), rebuilds the app in GitHub Actions, and replaces the latest release — so the download is always current with the website.

---

## The World

<details>
<summary><strong>Infinite Procedural Wasteland</strong></summary>

- Chunked, procedurally generated terrain stretching forever in every direction
- A persistent central town with shops, a fountain pavilion, town hall, courthouse, and the bank
- Rolling roads, houses, cars, rocks, trees, and foliage scattered across the map
- Landmarks: church + graveyard, jelly park, Red's Chili stand, Blob Lounge, and grandma's Jelly House far out east
- Prestige system: every cleared block remixes the map — landmarks scatter farther, harder, and the trek grows longer each run

</details>

<details>
<summary><strong>Sky, Weather & Day/Night</strong></summary>

- Full day/night cycle: morning → noon → sunset → night, cycling as blocks are cleared
- Weather system: sunny, cloudy, rain — crossfading over ~20 seconds
- Dynamic cloud shell wrapping a spherical sky over the globe curve — no flat-plane smear at the horizon
- Air motes that anchor to the map (not the camera) and react to weather density
- Fog that scales with draw distance, weather, and time of day
- Street lamps that light up as night falls
- Storm system: lightning flashes brighten the cloud shell, thunder claps and rolls with distance-delayed sound, wind gusts harder, and rain thickens during strikes

</details>

<details>
<summary><strong>Curved Horizon & Globe Rendering</strong></summary>

- The world sits on a fake globe curve — distant terrain sinks below the horizon like a real planet
- Clipmap LOD ground rings: dense near the camera, coarser out past the fog line
- Seamless streaming: nothing pops in as you move — chunks load ahead of the camera
- Sky-high cousin beacons visible over the curve from far away
- Horizon-clamped landmark chevrons: the bank and jelly house markers ride the skyline where ground meets sky, never sinking below the curve

</details>

---

## Characters

<details>
<summary><strong>Six Immune Cousins</strong></summary>

| Cousin | Color | Perk | Melee |
|--------|-------|------|-------|
| Blingo | Orange | Balanced hero | Slugger Bat |
| Blazo | Red | +15% damage | Fire Axe |
| Blizzy | Blue | Fast scout | Katana |
| Blomba | Purple | Melee tank | Sledgehammer |
| Bloopy | Green | Agile | Lead Pipe |
| Blondie | Pink | Lefty | Machete |

Every cousin has their own persona theme (chiptune motif), hand skin tone, and melee weapon with unique reach, speed, and damage. Blomba hits half again as hard and her kills come apart.

</details>

<details>
<summary><strong>AI Companions</strong></summary>

- Recruit the other five cousins to fight alongside you
- They follow, shoot, and revive you when you're downed
- Squad orders: Trade, Wait, and Fight via emotes
- A downed cousin gets a red rescue beacon — haul them back up or lose them
- Each carries their signature melee until you trade them something better

</details>

<details>
<summary><strong>Four Bosses</strong></summary>

| Boss | Location | Behavior |
|------|----------|----------|
| Two Horned One | Bank plaza | Wakes when all cousins are recruited, shields himself with horned guards |
| Crimson One | Church door | Rises after the block is scoured, harder hits, boils waves from the church |
| Infected One | Town | Spreads plague — NPC cousins take triple damage from him |
| Rotten One | Jelly House | The final trek — his minions rot, his heart beats in an open chest (weak spot) |

Each boss spawns with a colored beam pillar marking their location. Beating them unlocks the next phase of the run.

</details>

---

## Combat & Arsenal

<details>
<summary><strong>Weapons</strong></summary>

**Firearms:**
- Pistol, SMG, Rifle, Shotgun, Magnum, Sniper — each with distinct damage, range, fire rate, and stopping power
- Sniper rounds punch through everything they kill
- Shotgun pellets tear through close-range kills
- Magnum rounds pop skulls and keep going
- Crows (1hp) never stop a heavy round — one blast can pick apart a whole murder

**Melee:**
- Every cousin's signature weapon with infinite swings
- Close-range damage bonus
- Blomba's sledge hits 58 in her hands (vs 39 standard)

**Consumables:**
- **Good Jelly** — grandma's jar: self-revive when you bleed out, 3 seconds of bleeding purple, then back on your feet
- **Red's Chili** — eat it and become the boss for 90 seconds: giant stomps, crate-bursting slams, and a massive health pool

</details>

<details>
<summary><strong>Zombie Variants</strong></summary>

- **Standard walkers** — droopy eyes, exposed brains (weak spots), blind zombies that hunt the last gunshot
- **Colored variants** — purple (faster), red (harder hits), green (gore-horde minions)
- **Rotten** — hanging eye, exposed ribs with beating heart, pink belly — rolled by the Rotten One's sickness
- **Corpse zombies** — laying dead for crows to pick over (they get the rot roll when crows find them)
- **Boss guards** — horned, shielded, glowing in their boss's color

</details>

<details>
<summary><strong>Dismemberment & Gore</strong></summary>

- Headshots pop skulls — sometimes an eye pops loose
- Limb severance: arms and legs come off with the right hits
- Blood pools, splatter stains, and body-part gibs
- Extra Gore setting: max the slider to unlock the gore horde — denser spawns, greener brutes, and more carnage

</details>

---

## Multiplayer

<details>
<summary><strong>Lobby System</strong></summary>

- Public lobbies — drop in with anyone
- Private code-based lobbies — share a code with friends
- Host runs the world simulation; clients see synchronized ghosts of every player and zombie
- Player tags float over every human's head with their number and color
- Boss health bars, chevron markers, and world state sync across all screens

</details>

<details>
<summary><strong>Bare-Skin Trades</strong></summary>

- Hold a trade with empty fists and two players swap cousins, kits, and map spots
- Same player numbers, same lobby — just new bodies and new weapons
- A one-shot swapped-cousins theme plays for the trade
- Chili giants can't trade — nobody deals with a giant

</details>

---

## The Trek to Grandma's

<details>
<summary><strong>The Finale</strong></summary>

- Beat all four bosses and the trek to the Jelly House opens
- Grandma's beacon glows orange over the horizon
- Her ghost appears beside the long table with six capped jars of Good Jelly
- Wake her and the celebration begins — the whole family gathers, spawns cut, and the run ends with a tally of your streak
- Grandma's jelly stops the rot — the world is safe, for now

</details>

<details>
<summary><strong>Prestige & New Game Plus</strong></summary>

- After the finale, a new run begins with the map remixed — landmarks scatter farther
- Bluga the Bad Blob appears in new-game-plus — a cameo and a last stand
- Each consecutive prestige pushes landmarks farther from the fountain
- Best streak badge carries your record forward

</details>

---

## Controls (PC / Xbox / Touch)

| Action | PC | Xbox | Touch |
|--------|-----|------|-------|
| Move | WASD | Left stick | Left joystick |
| Aim | Mouse | Right stick | Right drag |
| Melee / Shoot | Left mouse | RT | On-screen button |
| Reload | R | B | On-screen button |
| Interact | E | X | On-screen button |
| Slide | C / Ctrl | R3 | On-screen button |
| Jump | Space | A | On-screen button |
| Sprint | Shift | L3 | On-screen button |
| Pause | Esc / P | Start | On-screen pause |
| View | V | Select | On-screen button |

*PlayStation and Nintendo controllers also supported.*

---

## Ownership

**BLINGO** — name, characters, story, artwork, music, and all code — is an original work created and owned by **[akilluminati47](https://github.com/akilluminati47) (AK & Co.)**.

Copyright (c) 2026 akilluminati47 (AK & Co.). **All rights reserved.** The source is publicly visible for transparency, but it is not open source — see [LICENSE](LICENSE). Play free at [blingo.pages.dev](https://blingo.pages.dev) or via the official [GitHub Releases](https://github.com/akilluminati47/blingo/releases/latest).
