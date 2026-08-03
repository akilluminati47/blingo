/* BLINGO — Discord Activities bootstrap.
   Non-blocking: if this page isn't running inside Discord's activity iframe,
   nothing happens and the game plays exactly as a normal website.
   Exposes window.BLINGO_DISCORD = { state, sdk, user, diag, openExternal } when connected. */
(function () {
  'use strict';

  function timeout(ms) {
    return new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, ms);
    });
  }

  function state(status) {
    window.BLINGO_DISCORD = window.BLINGO_DISCORD || {};
    window.BLINGO_DISCORD.state = status;
  }

  (function boot() {
    if (typeof window === 'undefined') return;
    var params = new URLSearchParams(window.location.search);
    // Discord injects client_id/frame_id/etc. as query params on discordsays.com —
    // be generous here so the diagnostics panel always comes up inside the sandbox
    var inDiscord = !!params.get('client_id') || !!params.get('frame_id') ||
      !!params.get('instance_id') || /discordsays\.com$/i.test(window.location.hostname);
    if (!inDiscord) return;

    window.BLINGO_DISCORD = {};
    state('connecting');

    // tiny diagnostics panel — created first, before anything that can throw
    window.BLINGO_DISCORD.diag = function (msg) {
      try {
        var el = window.BLINGO_DISCORD._el;
        if (!el) {
          el = document.createElement('div');
          el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:560px;max-height:200px;overflow:auto;background:rgba(0,0,0,.8);color:#7fe0ff;font:10px/1.5 monospace;padding:6px 8px;border:1px solid rgba(127,224,255,.35);border-radius:6px;pointer-events:none;white-space:pre-wrap;text-align:left;';
          (document.body || document.documentElement).appendChild(el);
          window.BLINGO_DISCORD._el = el;
        }
        var line = document.createElement('div');
        line.textContent = msg;
        el.appendChild(line);
        while (el.childNodes.length > 40) el.removeChild(el.firstChild);
      } catch (_) {}
    };
    window.BLINGO_DISCORD.diag('host ' + window.location.hostname + window.location.search.slice(0, 160));

    var SDK = window.DiscordSDK && window.DiscordSDK.DiscordSDK;
    if (!SDK) {
      window.BLINGO_DISCORD.diag('SDK bundle missing');
      return;
    }

    // the current Discord iframe URL carries the client id as the SUBDOMAIN
    // (1533697932149264495.discordsays.com) — not always as a query param.
    // Passing null to the SDK makes Discord reject the handshake and ready()
    // hangs until timeout, so resolve it properly.
    var clientId = params.get('client_id') || String(window.location.hostname).split('.')[0];
    window.BLINGO_DISCORD.diag('clientId ' + clientId);

    var sdk;
    try {
      sdk = new SDK(clientId);
    } catch (err) {
      // whatever the iframe URL lacks, the mappings below can still work —
      // and the panel says exactly which query param (or other cause) broke it
      window.BLINGO_DISCORD.diag('SDK ctor failed: ' + (err && err.message ? err.message : err));
      try {
        if (window.DiscordSDK.patchUrlMappings) {
          window.DiscordSDK.patchUrlMappings([{ prefix: '/peer', target: '0.peerjs.com' }]);
          window.BLINGO_DISCORD.diag('url mappings patched (fallback)');
        }
      } catch (_) {}
      return;
    }
    window.BLINGO_DISCORD.sdk = sdk;

    // external links can't navigate inside Discord's sandboxed iframe — open them
    // in the user's browser instead (used by the policies page download links etc.)
    window.BLINGO_DISCORD.openExternal = function (url) {
      url = String(url);
      var p;
      try {
        p = sdk.commands.openExternalLink({ url: url });
      } catch (err) {
        p = Promise.resolve({ opened: false });
      }
      return p.then(
        function (r) {
          if (!r || !r.opened) {
            try { window.open(url, '_blank', 'noopener'); } catch (_) {}
            return { opened: false };
          }
          return r;
        },
        function () {
          return { opened: false };
        }
      );
    };

    // Discord's sandbox only allows requests to the activity origin, so anything
    // the game needs from the outside goes through the activity proxy. The portal
    // URL mappings below are REQUIRED for these to resolve:
    //   PREFIX /peer  TARGET 0.peerjs.com     (multiplayer lobby broker)
    // (the policies download section talks to the OAuth worker instead, via /api/release)
    try {
      if (window.DiscordSDK.patchUrlMappings) {
        window.DiscordSDK.patchUrlMappings([
          { prefix: '/peer', target: '0.peerjs.com' }
        ]);
        window.BLINGO_DISCORD.diag('url mappings patched');
      }
    } catch (err) {
      window.BLINGO_DISCORD.diag('patchUrlMappings failed: ' + err);
    }

    // probe the release path through the proxy (what the policies page uses).
    // NOTE: use the direct mapping prefix — /.proxy/api/... does not match the
    // /api mapping and falls through to the / mapping (404 on pages.dev)
    fetch('/api/release').then(
      function (r) { window.BLINGO_DISCORD.diag('release probe HTTP ' + r.status); },
      function (e) { window.BLINGO_DISCORD.diag('release probe failed: ' + e.message); }
    );

    // probe the PeerJS broker WebSocket through the proxy (patched, so this is
    // exactly the URL PeerJS will connect to) — answers "does hosting work".
    // the broker closes sockets without a real id/token/version, so mimic PeerJS
    try {
      var wsp = new WebSocket('wss://0.peerjs.com/peerjs?key=peerjs&id=diagprobe&token=diag-token&version=1.5.4');
      wsp.onopen = function () {
        window.BLINGO_DISCORD.diag('peer broker WS OPEN');
        try { wsp.close(); } catch (_) {}
      };
      wsp.onerror = function () { window.BLINGO_DISCORD.diag('peer broker WS onerror'); };
      wsp.onclose = function (e) {
        if (e && e.code && e.code !== 1000) {
          window.BLINGO_DISCORD.diag('peer broker WS close ' + e.code + ' ' + (e.reason || ''));
        }
      };
    } catch (err) {
      window.BLINGO_DISCORD.diag('peer WS throw: ' + err.message);
    }

    Promise.race([sdk.ready(), timeout(20000)])
      .then(function () {
        state('ready');
        window.BLINGO_DISCORD.diag('sdk ready');
        return sdk.commands.authorize({
          client_id: clientId,
          response_type: 'code',
          state: '',
          prompt: 'none',
          scope: ['identify']
        });
      })
      .then(function (res) {
        if (!res || !res.code) throw new Error('no code');
        return fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: res.code })
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('token ' + r.status);
        return r.json();
      })
      .then(function (t) {
        if (!t.access_token) throw new Error('no access_token');
        return sdk.commands.authenticate({ access_token: t.access_token });
      })
      .then(function (auth) {
        window.BLINGO_DISCORD.user = auth && auth.user ? auth.user : null;
        state('authed');
        window.BLINGO_DISCORD.diag('authenticated');
      })
      .catch(function (err) {
        window.BLINGO_DISCORD.error = err && err.message ? err.message : String(err);
        state('ready'); // game still runs; identity just isn't linked
        window.BLINGO_DISCORD.diag('auth failed: ' + window.BLINGO_DISCORD.error);
      });
  })();
})();
