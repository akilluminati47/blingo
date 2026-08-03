/* BLINGO Discord Activity — OAuth token exchange worker.
   The game never sees the client secret; this worker swaps the one-time
   OAuth code (from the Embedded App SDK authorize command) for an
   access token, then the SDK uses it in authenticate().

   Deploy:
     cd worker
     npm install
     wrangler secret put DISCORD_CLIENT_ID
     wrangler secret put DISCORD_CLIENT_SECRET
     wrangler deploy
*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // the Discord activity maps PREFIX /api -> this worker, and the proxy CONSUMES
    // the prefix, so /api/token arrives here as /token. Strip it so the same routes
    // serve both the mapped path (activity) and the direct workers.dev path.
    const path = url.pathname.replace(/^\/api/, '');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      return json({ ok: true, service: 'blingo-discord-token' });
    }

    // latest GitHub release info for the policies download section (the Discord
    // sandbox can't reach api.github.com directly, so the page asks us instead)
    if (request.method === 'GET' && path === '/release') {
      const cacheKey = new Request('https://blingo-discord-token.akilluminati47.workers.dev/release');
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const gh = await fetch('https://api.github.com/repos/akilluminati47/blingo/releases/latest', {
        headers: { 'User-Agent': 'blingo-discord-token-worker' }
      });
      if (!gh.ok) return json({ error: 'github fetch failed' }, 502);
      const data = await gh.json();
      const res = json(data);
      res.headers.set('Cache-Control', 'public, max-age=300');
      await cache.put(cacheKey, res.clone());
      return res;
    }

    if (path === '/token' && request.method === 'POST') {
      const clientId = env.DISCORD_CLIENT_ID;
      const clientSecret = env.DISCORD_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return json({ error: 'worker not configured' }, 500);
      }

      let code;
      try {
        const body = await request.json();
        code = typeof body.code === 'string' ? body.code : '';
      } catch (err) {
        return json({ error: 'invalid json body' }, 400);
      }
      if (!code) return json({ error: 'missing code' }, 400);

      const exchange = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: env.DISCORD_REDIRECT_URI || 'https://127.0.0.1'
        })
      });

      const data = await exchange.json();
      if (!exchange.ok) {
        return json({ error: 'discord exchange failed', detail: data }, exchange.status);
      }
      return json(data);
    }

    return json({ error: 'not found' }, 404);
  }
};
