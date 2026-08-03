// merge-video.mjs — combines keyframe PNGs into a single MP4
// Usage: node scripts/merge-video.mjs [fps] [output]
//        node scripts/merge-video.mjs preview   → s02 only, 640x360 (16:9), under 500 KB, saved as preview.mp4
// Requires ffmpeg on PATH (download from https://ffmpeg.org)

import { execSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const KEYFRAMES = join(ROOT, 'cutscene', 'keyframes');
const OUTPUT = join(ROOT, 'cutscene', 'output');
mkdirSync(OUTPUT, { recursive: true });

const PREVIEW = process.argv[2] === 'preview';
const fps = PREVIEW ? 24 : parseInt(process.argv[2]) || 24;  // matches film_animated.js D.FPS
const outName = PREVIEW ? 'preview.mp4' : process.argv[3] || 'blingo_cutscene.mp4';
const outPath = join(OUTPUT, outName);
const MAX_BYTES = 500 * 1024; // preview target: under 500 KB

if (!existsSync(KEYFRAMES)) {
  console.error('❌ No keyframes directory found. Run the film script first.');
  process.exit(1);
}

const files = readdirSync(KEYFRAMES)
  .filter(f => f.endsWith('.png'))
  .filter(f => !PREVIEW || f.startsWith('s02_'))
  .sort();

if (files.length === 0) {
  console.error(`❌ No ${PREVIEW ? 's02 ' : ''}PNG files in keyframes/. Run the film script first.`);
  process.exit(1);
}

console.log(`🎬 Found ${files.length} keyframes${PREVIEW ? ' (s02 preview)' : ''}`);

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

function encode(bitrate) {
  // preview: downscale the 1920x1080 captures to 640x360 (exact 16:9) and rate-cap
  const extra = PREVIEW
    ? ` -vf "scale=640:360" -b:v ${bitrate}k -maxrate ${Math.round(bitrate * 1.2)}k -bufsize ${Math.round(bitrate * 2)}k`
    : '';
  const cmd = `ffmpeg -y -framerate ${fps} -i "${tmpDir}/frame_%0${pad}d.png" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 18${extra} "${outPath}"`;
  execSync(cmd, { stdio: 'inherit' });
}

console.log(`🎥 Encoding at ${fps} fps...`);
try {
  if (!PREVIEW) {
    encode(0);
    console.log(`✅ Video saved: ${outPath}`);
  } else {
    let bitrate = 340;
    for (;;) {
      encode(bitrate);
      const kb = (statSync(outPath).size / 1024).toFixed(0);
      if (statSync(outPath).size <= MAX_BYTES || bitrate <= 40) {
        console.log(`✅ Preview saved: ${outPath} (${kb} KB, 640x360 16:9 @ ${fps} fps)`);
        break;
      }
      console.log(`  ⚠️ ${kb} KB — over 500 KB, re-encoding at ${bitrate / 2}k...`);
      bitrate = Math.max(40, Math.round(bitrate / 2));
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.error('❌ ffmpeg failed. Is it installed? Try: choco install ffmpeg');
  console.error('   Or download from https://ffmpeg.org');
  process.exit(1);
}
