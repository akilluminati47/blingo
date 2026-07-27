// cutscene.mjs — one-command cutscene pipeline for BLINGO
// Usage: npm run cutscene
// Steps: clear old frames → start server → user captures → auto-merge → release

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import http from 'node:http';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const KEYFRAMES = join(ROOT, 'cutscene', 'keyframes');
const PORT = 3000;

function clearKeyframes() {
  if (!existsSync(KEYFRAMES)) return 0;
  const files = readdirSync(KEYFRAMES).filter(f => f.endsWith('.png'));
  for (const f of files) unlinkSync(join(KEYFRAMES, f));
  return files.length;
}

async function waitForCapture() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\n⏳ Press ENTER when capture is done (or type "merge" to skip waiting)...\n', ans => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function checkKeyframeCount() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${PORT}/status`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).count); } catch { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => { req.destroy(); resolve(0); });
  });
}

async function runMerge() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['scripts/merge-video.mjs'], {
      cwd: ROOT, stdio: 'inherit', shell: true,
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('merge failed')));
  });
}

// ─── Main ───
console.log('🎬 BLINGO Cutscene Pipeline\n');

// 1. Clear old frames
const cleared = clearKeyframes();
if (cleared > 0) console.log(`🧹 Cleared ${cleared} old keyframes`);

// 2. Start dev server
console.log(`\n🚀 Starting dev server on http://localhost:${PORT}`);
console.log('   1. Open browser to that URL');
console.log('   2. Paste film_animated.js into console');
console.log('   3. Run: dirRunAll()');
console.log('   4. Come back here and press ENTER\n');

const server = spawn('node', ['scripts/dev-server.mjs'], {
  cwd: ROOT, stdio: 'pipe', shell: true,
});

server.stdout.on('data', d => process.stdout.write(d));
server.stderr.on('data', d => process.stderr.write(d));

// Wait a moment for server to start
await new Promise(r => setTimeout(r, 1500));

// 3. Wait for user
await waitForCapture();

// 4. Check what we got
const count = await checkKeyframeCount();
console.log(`\n📸 ${count} keyframes captured`);

if (count === 0) {
  console.log('⚠️  No keyframes found. Did you run dirRunAll()?');
  server.kill();
  process.exit(1);
}

// 5. Merge
console.log('\n🔧 Running merge...\n');
try {
  await runMerge();
} catch (e) {
  console.error('❌ Merge failed');
  server.kill();
  process.exit(1);
}

// 6. Cleanup
console.log('\n🛑 Stopping server...');
server.kill();
console.log('✅ Pipeline complete. The cutscene is ready for release.');
