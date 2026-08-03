/* BLINGO — Discord Activities bootstrap.
   Non-blocking: if this page isn't running inside Discord's activity iframe,
   nothing happens and the game plays exactly as a normal website.
   Exposes window.BLINGO_DISCORD = { state, sdk, user, openExternal } when connected. */
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
    // be generous so the bootstrap also runs in odd sandbox URL shapes
    var inDiscord = !!params.get('client_id') || !!params.get('frame_id') ||
      !!params.get('instance_id') || /discordsays\.com$/i.test(window.location.hostname);
    if (!inDiscord) return;

    window.BLINGO_DISCORD = {};
    state('connecting');

    var SDK = window.DiscordSDK && window.DiscordSDK.DiscordSDK;
    if (!SDK) return;

    // the current Discord iframe URL carries the client id as the SUBDOMAIN
    // (1533697932149264495.discordsays.com) — not always as a query param.
    // Passing null to the SDK makes Discord reject the handshake and ready()
    // hangs until timeout, so resolve it properly.
    var clientId = params.get('client_id') || String(window.location.hostname).split('.')[0];

    var sdk;
    try {
      sdk = new SDK(clientId);
    } catch (err) {
      // whatever the iframe URL lacks, the mapping below can still work
      try {
        if (window.DiscordSDK.patchUrlMappings) {
          window.DiscordSDK.patchUrlMappings([{ prefix: '/peer', target: '0.peerjs.com' }]);
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
    // URL mapping below is REQUIRED for these to resolve:
    //   PREFIX /peer  TARGET 0.peerjs.com     (multiplayer lobby broker)
    // (the policies download section talks to the OAuth worker instead, via /api/release)
    try {
      if (window.DiscordSDK.patchUrlMappings) {
        window.DiscordSDK.patchUrlMappings([
          { prefix: '/peer', target: '0.peerjs.com' }
        ]);
      }
    } catch (_) {}

    Promise.race([sdk.ready(), timeout(20000)])
      .then(function () {
        state('ready');
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
      })
      .catch(function (err) {
        window.BLINGO_DISCORD.error = err && err.message ? err.message : String(err);
        state('ready'); // game still runs; identity just isn't linked
      });
  })();
})();
