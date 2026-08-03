/* BLINGO — title-card typewriter (external file so the page survives
   Discord Activities' strict CSP, which forbids inline scripts). */
(function() {
  var GOLD = [
    "When the horde came, every blob turned . . except six cousins.",
    "The bites never took.",
    "Now the immune cousins are clearing the wasteland block by block, so the rest of blob-kind can finally move back home .\u141F"
  ];
  var WHITE = [
    "Pick your cousin.",
    "The other five are out there somewhere, find them, recruit them, fight together.",
    "Loot the glowing crates for guns & ammo."
  ];
  var LUCK = "Good Luck .\u141F";

  var gEl = document.querySelector('#typelore .gold');
  var wEl = document.querySelector('#typelore .white');
  if (!gEl || !wEl) return;

  var TYPE = 32, WIPE = 4, HOLD = 4200, BLANK = 900;
  var gText = GOLD.join('\n'), wText = WHITE.join('\n');
  var wFull = wText + '\n' + LUCK;

  function render(el, text, pos, color) {
    var h = '';
    for (var i = 0; i < text.length; i++) {
      var c = text[i] === '\n' ? '<br>' : text[i];
      h += '<span style="color:' + (i < pos ? color : '#5a5a64') + '">' + c + '</span>';
    }
    el.innerHTML = h;
  }

  var _tid = null, _paused = false;
  function clearTypewriter() { if (_tid) { clearTimeout(_tid); _tid = null; } }
  function schedule(ms, fn) { if (_paused) return; clearTypewriter(); _tid = setTimeout(function() { _tid = null; fn(); }, ms); }

  function fill(el, text, fullText, color, i, cb) {
    i = i || 0;
    if (i > text.length) { cb(); return; }
    render(el, fullText, i, color);
    schedule(TYPE, function() { fill(el, text, fullText, color, i + 1, cb); });
  }

  function wipe(el, text, pos, color, cb) {
    if (pos < 0) { el.innerHTML = text.replace(/\n/g, '<br>'); cb(); return; }
    render(el, text, pos, color);
    schedule(WIPE, function() { wipe(el, text, pos - 1, color, cb); });
  }

  function pause(ms, cb) { schedule(ms, cb); }

  function cycle() {
    gEl.innerHTML = gText.replace(/\n/g, '<br>');
    wEl.innerHTML = wFull.replace(/\n/g, '<br>');
    gEl.style.color = '#5a5a64';
    wEl.style.color = '#5a5a64';

    fill(gEl, gText, gText, '#ffd9a8', 0, function() {
      pause(200, function() {
        fill(wEl, wText, wFull, '#eef1f5', 0, function() {
          // Flash the luck line gold — it's the last line in the white span
          wEl.innerHTML = wFull.replace(/\n/g, '<br>');
          var html = '';
          for (var i = 0; i < wFull.length; i++) {
            var ch = wFull[i] === '\n' ? '<br>' : wFull[i];
            html += '<span style="color:' + (i >= wText.length + 1 ? '#ffd9a8' : '#eef1f5') + '">' + ch + '</span>';
          }
          wEl.innerHTML = html;
          pause(HOLD, function() {
            wipe(wEl, wFull, wFull.length - 1, '#eef1f5', function() {
              wipe(gEl, gText, gText.length - 1, '#ffd9a8', function() {
                pause(BLANK, cycle);
              });
            });
          });
        });
      });
    });
  }

  window._resetTypewriter = function() { clearTypewriter(); _paused = false; cycle(); };
  window._pauseTypewriter = function() { _paused = true; clearTypewriter(); };
  window._resumeTypewriter = function() { _paused = false; cycle(); };

  // Wait until the splash is dismissed before starting the cycle
  var _started = false;
  function waitForPicker() {
    var splash = document.getElementById('splash');
    var gone = !splash || splash.classList.contains('hide') || splash.style.display === 'none';
    if (gone) {
      if (!_started) { _started = true; cycle(); }
    } else {
      requestAnimationFrame(waitForPicker);
    }
  }
  waitForPicker();
})();
