// copy-web.mjs — Copyright (c) 2026 akilluminati47 (AK & Co.). All rights reserved.
// Stages the same web build that ships to blingo.pages.dev into www/ for Capacitor,
// so the Android APK runs pixel-identically to the site and the desktop app.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const FILES = [
  'index.html', 'game.js', 'themes.js', 'policies.js',
  'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png',
  'icon-192.png', 'icon-512.png', 'banner-2.png', 'blingo.png',
  'site.webmanifest',
];
const DIRS = ['libs', 'icons', 'policies'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
for (const f of FILES) cpSync(f, `www/${f}`);
for (const d of DIRS) cpSync(d, `www/${d}`, { recursive: true });
console.log('www/ staged');
