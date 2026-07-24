/*
 * BLINGO — an infinite-map squad zombie shooter
 * Copyright (c) 2026 akilluminati47 (AK & Co.). All rights reserved.
 * https://blingo.pages.dev — https://github.com/akilluminati47/blingo
 *
 * Electron main process: wraps the same web build that ships to
 * blingo.pages.dev, served over a loopback HTTP server so ES modules and
 * absolute paths behave pixel-identically to the deployed site.
 */

const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

/* GPU headroom the browser won't give you by default — must run before app ready. */
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-frame-rate-limit');   // uncap rAF past vsync on high-Hz monitors
app.commandLine.appendSwitch('disable-gpu-vsync');

const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.mid':  'audio/midi',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const file = path.normalize(path.join(ROOT, urlPath));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* Steam overlay/achievements hook — activates the day a steam_appid.txt ships
 * beside the exe (and the Steam client is running). Harmless no-op until then. */
function initSteam() {
  try {
    const appIdFile = path.join(process.resourcesPath || ROOT, 'steam_appid.txt');
    const altFile = path.join(ROOT, 'steam_appid.txt');
    const file = fs.existsSync(appIdFile) ? appIdFile : (fs.existsSync(altFile) ? altFile : null);
    if (!file) return;
    const appId = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (!appId) return;
    const steamworks = require('steamworks.js');
    const client = steamworks.init(appId);
    console.log('[steam] initialized for app', appId, '— player:', client.localplayer.getName());
    global.steam = client;
  } catch (e) {
    console.log('[steam] not active:', e.message);
  }
}

let win = null;

async function createWindow() {
  const server = await serve();
  const port = server.address().port;

  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    fullscreenable: true,
    title: 'BLINGO',
    icon: path.join(ROOT, 'icon-512.png'),
    webPreferences: {
      backgroundThrottling: false,   // rAF never gets backgrounded mid-run
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  /* anything the game opens in a new tab (policies, the website) goes to the real browser */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    else win.loadURL(`http://127.0.0.1:${port}${url}`);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
  win.on('closed', () => { win = null; server.close(); });
}

app.whenReady().then(() => {
  initSteam();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
