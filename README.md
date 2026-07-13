# BLINGO

An infinite-map, third-person zombie shooter built with plain JavaScript and Three.js. Play as one of six immune blob cousins of Clan Blob, clear the wasteland, loot glowing crates for guns and ammo, and recruit the other cousins to fight alongside you.

## Features

- Procedurally generated infinite town + wasteland with a persistent central town
- Gang Beasts style wobbly blob characters with boxy mitts
- Seven weapons with close-range damage bonuses, dismemberment, and head-pop kills
- Zombie variants: droopy eyes, exposed brains (weak spots), and blind zombies that hunt the last gunshot
- 3D positional audio, footsteps, ambience, and a per-cousin persona music theme
- Pause menu with audio, spawn-rate, and gore settings (max the gore slider to unlock extra gore)
- Free-aim mouse and keyboard, Roblox-style touch controls, and gamepad with rumble

## Run locally

The game uses ES modules, so it needs to be served over HTTP:

```bash
python -m http.server 8321
```

Then open http://localhost:8321 in a browser.

## Deploy to Cloudflare Pages

This is a static site with no build step. In Cloudflare Pages:

- Connect this repository
- Build command: (leave empty)
- Build output directory: `/`

## Controls

- Move: WASD / left stick / left-side touch joystick
- Aim: mouse / right stick / right-side touch drag
- Shoot: left mouse / RT / on-screen button
- Reload: R / B / on-screen button
- Loot and recruit: E / X / on-screen button
- Jump: Space / A
- Sprint: Shift / L3
- Pause: Esc or P / Start / on-screen pause button
