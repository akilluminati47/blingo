/* BLINGO — Discord Activities bootstrap.
   Non-blocking: if this page isn't running inside Discord's activity iframe,
   nothing happens and the game plays exactly as a normal website.
   Exposes window.BLINGO_DISCORD = { state, sdk, user } when connected. */
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
    var SDK = window.DiscordSDK && window.DiscordSDK.DiscordSDK;
    if (!SDK) return;
    var params = new URLSearchParams(window.location.search);
    if (!params.get('client_id') || !params.get('frame_id')) return; // not in Discord

    var sdk;
    try {
      sdk = new SDK(params.get('client_id'));
    } catch (err) {
      return;
    }
    window.BLINGO_DISCORD = { state: 'connecting', sdk: sdk };
    state('connecting');

    // external links can't navigate inside Discord's sandboxed iframe — open them
    // in the user's browser instead (used by the policies page download links etc.)
    window.BLINGO_DISCORD.openExternal = function (url) {
      try {
        return sdk.commands.openExternalLink({ url: String(url) });
      } catch (err) {
        return Promise.resolve({ opened: false });
      }
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
      }
    } catch (_) {}

    Promise.race([sdk.ready(), timeout(20000)])
      .then(function () {
        state('ready');
        return sdk.commands.authorize({
          client_id: params.get('client_id'),
          response_type: 'code',
          state: '',
          prompt: 'none',
          scope: ['identify']
        });
      })
      .then(function (res) {
        if (!res || !res.code) throw new Error('no code');
        return fetch('/.proxy/api/token', {
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
      .catch(function () {
        state('ready'); // game still runs; identity just isn't linked
      });
  })();
})();
