// merge-video.mjs — combines keyframe PNGs into a single MP4
// Usage: node scripts/merge-video.mjs [fps] [output]
// Requires ffmpeg on PATH (download from https://ffmpeg.org)

import { execSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const KEYFRAMES = join(ROOT, 'cutscene', 'keyframes');
const OUTPUT = join(ROOT, 'cutscene', 'output');
mkdirSync(OUTPUT, { recursive: true });

const fps = parseInt(process.argv[2]) || 24;  // matches film_animated.js D.FPS
const outName = process.argv[3] || 'blingo_cutscene.mp4';
const outPath = join(OUTPUT, outName);

if (!existsSync(KEYFRAMES)) {
  console.error('❌ No keyframes directory found. Run the film script first.');
  process.exit(1);
}

const files = readdirSync(KEYFRAMES)
  .filter(f => f.endsWith('.png'))
  .sort();

if (files.length === 0) {
  console.error('❌ No PNG files in keyframes/. Run the film script first.');
  process.exit(1);
}

console.log(`🎬 Found ${files.length} keyframes`);

// Rename to sequential numbers for ffmpeg
const tmpDir = join(ROOT, 'cutscene', '.tmp');
mkdirSync(tmpDir, { recursive: true });
const pad = String(files.length).length;

files.forEach((f, i) => {
  const num = String(i + 1).padStart(pad, '0');
  const src = join(KEYFRAMES, f);
  const dst = join(tmpDir, `frame_${num}.png`);
  copyFileSync(src, dst);
});

// Build ffmpeg command
const cmd = `ffmpeg -y -framerate ${fps} -i "${tmpDir}/frame_%0${pad}d.png" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 18 "${outPath}"`;

console.log(`🎥 Encoding at ${fps} fps...`);
try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✅ Video saved: ${outPath}`);
  rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.error('❌ ffmpeg failed. Is it installed? Try: choco install ffmpeg');
  console.error('   Or download from https://ffmpeg.org');
  process.exit(1);
}
