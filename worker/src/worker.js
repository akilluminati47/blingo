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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'blingo-discord-token' });
    }

    if (url.pathname === '/api/token' && request.method === 'POST') {
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
