// dev-server.mjs — local dev server for cutscene capture
// Serves the game and receives screenshots via POST, saving them to cutscene/keyframes/
// Usage: node scripts/dev-server.mjs
// Then open http://localhost:3000 in your browser, paste film_storyboard.js into console, run dirRunAll()

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'cutscene', 'keyframes');
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/json',
  '.wasm': 'application/wasm',
};

const server = createServer((req, res) => {
  // CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Screenshot save endpoint
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, data } = JSON.parse(body);
        const b64 = data.replace(/^data:image\/png;base64,/, '');
        const file = join(OUT, name.replace(/[^a-zA-Z0-9_\-]/g, '_') + '.png');
        writeFileSync(file, Buffer.from(b64, 'base64'));
        const count = existsSync(OUT) ? readdirSync(OUT).length : 0;
        console.log(`  ✅ ${name}.png  (${count} files in keyframes/)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file }));
      } catch (e) {
        console.error('  ❌ save error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Status endpoint
  if (req.method === 'GET' && req.url === '/status') {
    const files = existsSync(OUT) ? readdirSync(OUT) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: files.length, files }));
    return;
  }

  // Static file serving
  let url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = join(ROOT, url);

  if (!existsSync(filePath) || !filePath.startsWith(ROOT)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🎬 BLINGO Cutscene Server`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log(`   Screenshots saved to: ${OUT}`);
  console.log(`   Paste film_storyboard.js in console, then run dirRunAll()\n`);
});
