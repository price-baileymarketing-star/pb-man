/* ==========================================================================
   lib/screen-kit.js  |  Big screen: QR code, details form, phone link, end screen
   --------------------------------------------------------------------------
   Shared by every Price Bailey two-screen game. It owns four things:
     1. the title overlay with the QR code and the "Play on this screen" button
     2. the details form (shown before every game, on both routes)
     3. the connection to the phone (through lib/link.js)
     4. the end overlay with the score, New game button and 45 second reset
   The game keeps its own gameplay and HUD. Each game passes a small config
   object to PBScreen.init() (see the adapter block at the bottom of its page).

   Needs, loaded first: lib/mqtt.min.js, lib/qrcode.js, lib/link.js, lib/hubspot.js
   Personal details are held in memory only and never shown on this screen.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------- SETTINGS ---------------------------------- */
  var SETTINGS = {
    FORM_IDLE_CLOSE_MS: 90000,       // an abandoned form on this screen closes and clears after this long
    END_AUTO_RESET_MS: 45000,        // end screen goes back to a fresh QR code after this long
    STATE_PUSH_MS: 250,              // game state to the phone, about four times a second
    CONTROLLER_TIMEOUT_MS: 6000,     // phone counts as gone after this much silence
    CONTROLLER_LOST_RESET_MS: 30000, // a phone game paused this long is abandoned
    NEW_GAME_RELOAD_MS: 800,         // time to tell the phone before the page reloads
    HOLD_TIMEOUT_MS: 700             // a held button is released if the phone stops saying it is held
  };

  var cfg = null, link = null, roomCode = '';
  var st = 'lobby';                  // lobby | playing | paused | ended
  var mode = 'screen';               // who is playing: 'screen' or 'phone'
  var linkStatus = { net: 'connecting', peer: 'none' };
  var activeCid = '', activeSeen = 0, hadController = false;
  var bigDetails = null;             // details typed on this screen. Memory only. Gone on new game.
  var formOpen = false, idleTimer = null;
  var endInfo = { sc: 0, ttl: '', msg: '' };
  var lastPushAt = 0, lastPushKey = '', lastQrAt = 0;
  var newGameStarted = false, endTimer = null, countdownTimer = null, pausedAt = 0, saveRetried = false;
  var held = {}, tapSeen = {}, lastInAt = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------------------- Markup and styles ------------------------- */
  function buildCss(t) {
    return '' +
      '#pbk{--k-bg1:' + t.bg1 + ';--k-bg2:' + t.bg2 + ';--k-text:' + t.text + ';--k-dim:' + t.dim + ';--k-accent:' + t.accent + ';--k-accent2:' + t.accent2 + ';--k-warn:' + t.warn + ';--k-err:#ff9db8;--k-btn-text:' + t.btnText + ';--k-font:' + t.font + ';' +
      'font-family:var(--k-font);color:var(--k-text);-webkit-user-select:text;user-select:text}' +
      '#pbk *{box-sizing:border-box}' +
      '#pbk input{-webkit-user-select:text;user-select:text}' +
      '.pbk-ov{position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;align-items:center;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;padding:20px;text-align:center}' +
      '.pbk-ov.active{display:flex}' +
      '.pbk-ov>*{margin-top:auto;margin-bottom:auto}' +
      '.pbk-title{background:' + t.titleBg + '}' +
      '.pbk-formov{background:rgba(0,0,0,.72);backdrop-filter:blur(4px);z-index:2147483100}' +
      '.pbk-end{background:radial-gradient(ellipse at center,var(--k-bg2) 0%,var(--k-bg1) 75%);z-index:2147483200}' +
      '.pbk-grid{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:clamp(24px,5vw,72px);max-width:1120px}' +
      '.pbk-main{display:flex;flex-direction:column;align-items:center;max-width:560px}' +
      '.pbk-logo{width:clamp(56px,9vw,92px);height:auto;border-radius:6px;margin-bottom:14px;display:block}' +
      '#pbk h1{font-size:clamp(30px,5vw,56px);line-height:1.05;margin:0 0 8px;color:var(--k-accent);letter-spacing:.02em;font-weight:800}' +
      '#pbk h2{font-size:clamp(14px,1.8vw,19px);margin:0 0 12px;color:var(--k-accent2);font-weight:600;letter-spacing:.06em}' +
      '#pbk p.pbk-desc{font-size:clamp(14px,1.7vw,18px);line-height:1.55;color:var(--k-text);margin:0 0 20px;max-width:520px}' +
      '.pbk-btn{display:block;min-width:min(320px,100%);padding:16px 30px;font:inherit;font-size:clamp(16px,2vw,21px);font-weight:800;letter-spacing:.06em;color:var(--k-btn-text);background:var(--k-accent);border:0;border-radius:10px;cursor:pointer;box-shadow:0 0 26px color-mix(in srgb,var(--k-accent) 55%,transparent)}' +
      '.pbk-btn:active{transform:translateY(2px)}' +
      '.pbk-btn.secondary{background:transparent;color:var(--k-text);border:2px solid color-mix(in srgb,var(--k-text) 40%,transparent);box-shadow:none;margin-top:12px;font-size:16px;padding:12px 24px}' +
      '.pbk-btn[disabled]{opacity:.55;cursor:not-allowed}' +
      '.pbk-hint{margin-top:14px;font-size:14px;color:var(--k-dim);letter-spacing:.04em}' +
      '.pbk-qr{display:flex;flex-direction:column;align-items:center;width:clamp(190px,24vw,260px);padding:16px;border-radius:14px;background:rgba(255,255,255,.08);border:2px solid var(--k-accent)}' +
      '.pbk-qr-title{font-size:clamp(15px,1.7vw,19px);font-weight:700;margin-bottom:10px;color:var(--k-text)}' +
      '.pbk-qrbox{width:100%;aspect-ratio:1/1;background:#fff;border-radius:8px;padding:8px;display:flex;align-items:center;justify-content:center}' +
      '.pbk-qrbox svg{width:100%;height:100%;display:block}' +
      '.pbk-qrbox .off{color:#111;font-size:14px;padding:12px}' +
      '.pbk-code{margin-top:10px;font-family:"Courier New",monospace;font-size:clamp(26px,3vw,36px);font-weight:700;letter-spacing:.3em;padding-left:.3em;color:var(--k-warn)}' +
      '.pbk-url{margin-top:2px;font-family:"Courier New",monospace;font-size:11px;color:var(--k-dim);word-break:break-all;text-align:center;line-height:1.35}' +
      '.pbk-status{margin-top:12px;display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-size:14px;font-weight:700;color:var(--k-text);background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.3);text-align:center}' +
      '.pbk-status .dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:var(--k-warn)}' +
      '.pbk-status.ok{border-color:var(--k-accent)}.pbk-status.ok .dot{background:var(--k-accent)}' +
      '.pbk-status.bad{border-color:var(--k-err)}.pbk-status.bad .dot{background:var(--k-err);border-radius:2px}' +
      '.pbk-card{width:min(560px,94vw);padding:8px 0;text-align:left;background:transparent}' +
      '#pbk .pbk-card h1{font-size:clamp(24px,3.4vw,36px);text-align:center;margin-bottom:6px}' +
      '.pbk-card .pbk-desc{text-align:center;margin:0 auto 18px;font-size:clamp(14px,1.6vw,17px);color:var(--k-dim)}' +
      '.pbk-frow{display:flex;gap:12px}.pbk-frow .pbk-ff{flex:1 1 0;min-width:0}' +
      '.pbk-ff{margin-bottom:12px}' +
      '.pbk-ff label{display:block;font-size:15px;font-weight:700;margin-bottom:5px;color:var(--k-text)}' +
      '.pbk-ff label .opt{font-weight:400;color:var(--k-dim)}' +
      '.pbk-ff input[type=text],.pbk-ff input[type=email],.pbk-ff input[type=tel]{width:100%;min-height:52px;padding:10px 14px;font:inherit;font-size:18px;color:#fff;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.32);border-radius:8px}' +
      '.pbk-ff input[aria-invalid=true]{border-color:var(--k-err)}' +
      '#pbk input:focus-visible,#pbk button:focus-visible{outline:3px solid var(--k-warn);outline-offset:2px}' +
      '.pbk-err{display:none;margin-top:4px;font-size:14px;color:var(--k-err)}.pbk-err.show{display:block}.pbk-err:before{content:"! ";font-weight:700}' +
      '.pbk-consent{display:flex;gap:12px;align-items:flex-start;margin:4px 0 10px}' +
      '.pbk-consent input{flex:0 0 auto;width:28px;height:28px;margin-top:1px;accent-color:var(--k-accent)}' +
      '.pbk-consent label{font-size:16px;line-height:1.4;color:var(--k-text)}' +
      '.pbk-notice{font-size:13px;color:var(--k-dim);line-height:1.45;margin-bottom:16px}.pbk-notice a{color:var(--k-accent2)}' +
      '.pbk-card .pbk-btn{width:100%}' +
      '.pbk-extra{text-align:left;max-width:560px;margin:0 0 20px;font-size:clamp(13px,1.4vw,16px);line-height:1.5;color:var(--k-text)}' +
      '.pbk-extra p{margin:0 0 8px}.pbk-extra b{color:var(--k-warn)}' +
      '.pbk-extra .rules{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}.pbk-extra .rule{flex:1 1 150px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.2)}' +
      '.pbk-extra .rule small{display:block;color:var(--k-dim);margin-top:3px}' +
      '.pbk-end-inner{display:flex;flex-direction:column;align-items:center;max-width:620px}' +
      '.pbk-label{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--k-dim);margin-bottom:4px}' +
      '.pbk-score{font-size:clamp(54px,9vw,104px);font-weight:900;line-height:1;color:var(--k-warn);margin:6px 0 14px;font-variant-numeric:tabular-nums;text-shadow:0 0 28px color-mix(in srgb,var(--k-warn) 45%,transparent)}' +
      '.pbk-perf{font-size:clamp(16px,2vw,22px);line-height:1.5;color:var(--k-text);margin:0 0 16px;max-width:560px}' +
      '.pbk-save{min-height:24px;margin:0 0 14px;font-size:clamp(14px,1.6vw,17px);color:var(--k-dim)}' +
      '.pbk-save.ok{color:var(--k-accent)}.pbk-save.fail{color:var(--k-err)}' +
      '.pbk-auto{margin-top:12px;font-size:13px;color:var(--k-dim);letter-spacing:.04em}' +
      '#pbkPause{position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:2147483300;display:none;max-width:84%;text-align:center;padding:14px 22px;border-radius:10px;font-size:clamp(16px,2vw,22px);color:#fff;background:rgba(10,17,40,.96);border:2px solid var(--k-warn)}' +
      '#pbkPause.show{display:block}' +
      '@keyframes pbkdrift{0%{background-position:0 0}100%{background-position:120px 120px}}' +
      '.pbk-title.drift{background-image:' + t.titleBg + ',radial-gradient(circle at 20% 30%,color-mix(in srgb,var(--k-accent) 14%,transparent) 0 2px,transparent 3px);background-size:auto,60px 60px;animation:pbkdrift 14s linear infinite}';
  }

  function buildHtml(c) {
    var t = c.title;
    return '' +
      '<div class="pbk-ov pbk-title' + (c.titleDrift ? ' drift' : '') + ' active" id="pbkTitle"><div class="pbk-grid">' +
        '<div class="pbk-main">' +
          (c.logo ? '<img class="pbk-logo" src="' + esc(c.logo) + '" alt="Price Bailey">' : '') +
          '<h1>' + esc(t) + '</h1>' +
          (c.tagline ? '<h2>' + esc(c.tagline) + '</h2>' : '') +
          '<p class="pbk-desc">' + esc(c.blurb || '') + '</p>' +
          (c.titleExtraHtml ? '<div class="pbk-extra">' + c.titleExtraHtml + '</div>' : '') +
          '<button class="pbk-btn" id="pbkPlay" type="button">Play on this screen</button>' +
          '<div class="pbk-hint">' + esc(c.hint || 'Scan the QR code to play on your phone') + '</div>' +
        '</div>' +
        '<div class="pbk-qr" id="pbkQrCard">' +
          '<div class="pbk-qr-title">Play on your phone</div>' +
          '<div class="pbk-qrbox" id="pbkQrBox" role="img" aria-label="QR code to play on your phone"></div>' +
          '<div class="pbk-code" id="pbkRoom" aria-label="Game code">----</div>' +
          '<div class="pbk-url" id="pbkUrl"></div>' +
          '<div class="pbk-status" id="pbkStatus" role="status" aria-live="polite"><span class="dot"></span><span id="pbkStatusText">Connecting</span></div>' +
        '</div>' +
      '</div></div>' +

      '<div class="pbk-ov pbk-formov" id="pbkForm" role="dialog" aria-modal="true" aria-labelledby="pbkFTitle"><div class="pbk-card">' +
        '<h1 id="pbkFTitle">Enter your details to play</h1>' +
        '<p class="pbk-desc">Your score appears on the screen. Your details do not.</p>' +
        '<form id="pbkFormEl" novalidate autocomplete="off">' +
          '<div class="pbk-frow">' +
            '<div class="pbk-ff"><label for="pbk_firstname">First name</label><input type="text" id="pbk_firstname" autocomplete="off" autocapitalize="words" aria-describedby="pbke_firstname"><div class="pbk-err" id="pbke_firstname"></div></div>' +
            '<div class="pbk-ff"><label for="pbk_lastname">Last name</label><input type="text" id="pbk_lastname" autocomplete="off" autocapitalize="words" aria-describedby="pbke_lastname"><div class="pbk-err" id="pbke_lastname"></div></div>' +
          '</div>' +
          '<div class="pbk-ff"><label for="pbk_email">Business email</label><input type="email" id="pbk_email" autocomplete="off" autocapitalize="off" inputmode="email" aria-describedby="pbke_email"><div class="pbk-err" id="pbke_email"></div></div>' +
          '<div class="pbk-ff"><label for="pbk_company">Organisation</label><input type="text" id="pbk_company" autocomplete="off" autocapitalize="words" aria-describedby="pbke_company"><div class="pbk-err" id="pbke_company"></div></div>' +
          '<div class="pbk-ff"><label for="pbk_mobile">Mobile number <span class="opt">(optional)</span></label><input type="tel" id="pbk_mobile" autocomplete="off" inputmode="tel" aria-describedby="pbke_mobile"><div class="pbk-err" id="pbke_mobile"></div></div>' +
          '<div class="pbk-consent"><input type="checkbox" id="pbk_consent"><label for="pbk_consent" id="pbk_consentLabel"></label></div>' +
          '<p class="pbk-notice" id="pbk_notice"></p>' +
          '<button type="submit" class="pbk-btn" id="pbkFStart">Start game</button>' +
          '<button type="button" class="pbk-btn secondary" id="pbkFBack">Back</button>' +
        '</form>' +
      '</div></div>' +

      '<div class="pbk-ov pbk-end" id="pbkEnd" role="dialog" aria-modal="true" aria-labelledby="pbkEndTitle"><div class="pbk-end-inner">' +
        (c.logo ? '<img class="pbk-logo" src="' + esc(c.logo) + '" alt="Price Bailey">' : '') +
        '<h1 id="pbkEndTitle"></h1>' +
        '<div class="pbk-label">' + esc(c.scoreLabel || 'Final score') + '</div>' +
        '<div class="pbk-score" id="pbkEndScore">0</div>' +
        '<p class="pbk-perf" id="pbkEndMsg"></p>' +
        (c.endExtraHtml ? '<div class="pbk-extra">' + c.endExtraHtml + '</div>' : '') +
        '<p class="pbk-save" id="pbkSave" role="status" aria-live="polite"></p>' +
        '<button type="button" class="pbk-btn secondary" id="pbkRetry" style="display:none;margin-top:0;margin-bottom:12px">Try saving again</button>' +
        '<button type="button" class="pbk-btn" id="pbkNew">New game</button>' +
        '<div class="pbk-auto" id="pbkAuto"></div>' +
      '</div></div>' +
      '<div id="pbkPause" role="status" aria-live="polite">Controller lost. Waiting for the phone to reconnect.</div>';
  }

  /* ---------------------------- Helpers ------------------------------------ */
  function fmt(n) { return cfg.fmt ? cfg.fmt(n) : Math.floor(n || 0).toLocaleString('en-GB'); }

  function setQr(text, kind) { $('pbkStatusText').textContent = text; $('pbkStatus').className = 'pbk-status ' + (kind || ''); }
  function refreshQr() {
    if (!link) return;
    var alive = activeCid && (Date.now() - activeSeen < SETTINGS.CONTROLLER_TIMEOUT_MS);
    if (alive) setQr('Controller connected', 'ok');
    else if (hadController && !alive) setQr('Controller lost. Scan the code to reconnect.', 'bad');
    else if (linkStatus.net === 'offline') setQr('No internet. Play on this screen.', 'bad');
    else if (linkStatus.net === 'connecting') setQr('Connecting', '');
    else setQr('Waiting for controller', '');
  }

  /* ---------------------------- State sent to the phone -------------------- */
  function buildState() {
    var s = st === 'ended' ? 'end' : (st === 'lobby' ? 'lobby' : 'playing');
    var h = (s === 'playing' && cfg.hud) ? (cfg.hud() || {}) : {};
    var m = {
      t: 'st', s: s,
      by: s === 'lobby' ? '' : mode,
      ctl: (s === 'lobby' || mode === 'phone') ? activeCid : '',     // empty while someone plays on this screen
      sc: Math.floor(s === 'end' ? endInfo.sc : (h.sc || 0)),
      pad: h.pad || 'play',
      ln: h.ln || ''
    };
    if (s === 'end') { m.ttl = endInfo.ttl; m.msg = endInfo.msg; }
    return m;
  }
  function pushState(force) {
    if (!link) return;
    var m = buildState();
    var key = [m.s, m.by, m.ctl, m.pad, m.ln].join('|');
    var now = Date.now();
    var every = m.s === 'playing' ? SETTINGS.STATE_PUSH_MS : 1000;
    if (force || key !== lastPushKey || now - lastPushAt >= every) { lastPushKey = key; lastPushAt = now; link.send(m); }
  }

  /* ---------------------------- Held buttons from the phone ---------------- */
  function releaseAll() {
    Object.keys(held).forEach(function (k) { if (held[k]) { held[k] = false; if (cfg.release) cfg.release(k); } });
  }
  function applyInput(m) {
    lastInAt = Date.now();
    if (st !== 'playing' || mode !== 'phone') return;
    var now = {}, i;
    (m.h || []).forEach(function (k) { now[k] = true; });
    Object.keys(now).forEach(function (k) { if (!held[k]) { held[k] = true; if (cfg.press) cfg.press(k); } });
    Object.keys(held).forEach(function (k) { if (held[k] && !now[k]) { held[k] = false; if (cfg.release) cfg.release(k); } });
    var tp = m.tp || {};
    Object.keys(tp).forEach(function (k) {
      var n = tp[k] | 0, seen = tapSeen[k] || 0;
      if (n > seen) {                                   // counters make a repeated message harmless
        tapSeen[k] = n;
        if (cfg.press) cfg.press(k);
        setTimeout(function () { if (cfg.release) cfg.release(k); }, 80);
      }
    });
  }
  function resetTapCounters(m) { tapSeen = {}; Object.keys(m.tp || {}).forEach(function (k) { tapSeen[k] = m.tp[k] | 0; }); }

  /* ---------------------------- Ticking ------------------------------------ */
  function tick() {
    if (!link) return;
    var now = Date.now();
    var quiet = activeCid && (now - activeSeen > SETTINGS.CONTROLLER_TIMEOUT_MS);
    var phoneGame = mode === 'phone' && (st === 'playing' || st === 'paused');

    if (quiet && phoneGame) {
      if (st === 'playing') {                            // phone dropped: freeze the game and wait for it
        st = 'paused'; pausedAt = now; releaseAll();
        if (cfg.pause) cfg.pause(true, 0);
        $('pbkPause').classList.add('show');
      } else if (now - pausedAt > SETTINGS.CONTROLLER_LOST_RESET_MS) {
        newGame();                                       // nobody came back: fresh QR code for the next player
      }
    } else if (quiet && st === 'lobby') {
      activeCid = '';                                    // phone walked away from the title screen
    } else if (st === 'paused' && mode === 'phone' && activeCid) {
      var gap = now - pausedAt;
      st = 'playing';
      $('pbkPause').classList.remove('show');
      if (cfg.pause) cfg.pause(false, gap);
    }
    if (st === 'playing' && mode === 'phone' && now - lastInAt > SETTINGS.HOLD_TIMEOUT_MS) releaseAll();

    pushState(false);
    if (now - lastQrAt > 500) { lastQrAt = now; refreshQr(); }
  }

  /* ---------------------------- Messages from the phone -------------------- */
  function onRemote(m) {
    if (!m || !m.c) return;
    var now = Date.now();
    var phoneGame = mode === 'phone' && (st === 'playing' || st === 'paused');

    if (activeCid && activeCid !== m.c) {
      if (now - activeSeen < SETTINGS.CONTROLLER_TIMEOUT_MS || phoneGame) return;   // someone else holds this game
      activeCid = '';
    }
    if (!activeCid) {
      if (st !== 'lobby') return;                        // game running or finished: no new players until reset
      activeCid = m.c; hadController = true;
      pushState(true);
    }
    activeSeen = now;

    if (m.t === 'in') {
      applyInput(m);
    } else if (m.t === 'start') {
      if (st === 'lobby') {                              // safe to receive twice: only the first one starts anything
        closeForm();                                     // a half-filled form on this screen is closed and cleared
        bigDetails = null;
        resetTapCounters(m);
        startNow('phone');
      }
    } else if (m.t === 'newgame') {
      if (st === 'ended') newGame();
    }
  }

  /* ---------------------------- Details form on this screen ---------------- */
  var DFIELDS = ['firstname', 'lastname', 'email', 'company', 'mobile'];
  function readDetails() {
    return { firstname: $('pbk_firstname').value, lastname: $('pbk_lastname').value, email: $('pbk_email').value,
      company: $('pbk_company').value, mobile: $('pbk_mobile').value, consent: $('pbk_consent').checked };
  }
  function showDErrors(errors) {
    DFIELDS.forEach(function (f) {
      var msg = errors[f], el = $('pbke_' + f);
      el.textContent = msg || ''; el.classList.toggle('show', !!msg);
      $('pbk_' + f).setAttribute('aria-invalid', msg ? 'true' : 'false');
    });
  }
  function clearForm() { $('pbkFormEl').reset(); showDErrors({}); }
  function resetIdle() { clearTimeout(idleTimer); if (formOpen) idleTimer = setTimeout(closeForm, SETTINGS.FORM_IDLE_CLOSE_MS); }

  function openForm() {
    if (st !== 'lobby' || formOpen || newGameStarted) return;
    if (cfg.unlockAudio) cfg.unlockAudio();
    formOpen = true; clearForm();
    $('pbkForm').classList.add('active');
    resetIdle();
    setTimeout(function () { var f = $('pbk_firstname'); if (f && formOpen) f.focus(); }, 60);
  }
  function closeForm() {
    if (!formOpen) return;
    formOpen = false; clearTimeout(idleTimer);
    clearForm();                                         // nothing personal is left on this screen
    $('pbkForm').classList.remove('active');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  /* ---------------------------- Starting and ending ------------------------ */
  function startNow(who) {
    if (st !== 'lobby') return;
    mode = who; st = 'playing';
    $('pbkTitle').classList.remove('active');
    $('pbkEnd').classList.remove('active');
    if (cfg.unlockAudio) cfg.unlockAudio();
    cfg.start(who);
    pushState(true);
  }

  function setSave(state, text) {
    var el = $('pbkSave');
    el.textContent = text;
    el.className = 'pbk-save ' + (state === 'ok' ? 'ok' : state === 'fail' ? 'fail' : '');
    $('pbkRetry').style.display = state === 'fail' ? 'block' : 'none';
  }
  function saveBigFinal() {
    if (!bigDetails) return;
    setSave('saving', 'Saving your score...');
    PBHubSpot.submit(bigDetails, { score: endInfo.sc, label: 'end' }).then(function (r) {
      if (r.ok) { setSave('ok', 'Your score and details are saved.'); return; }
      if (!saveRetried) { saveRetried = true; setTimeout(saveBigFinal, 3000); return; }
      setSave('fail', 'We could not save your score. Please tell a member of the team.');
    });
  }

  // The game calls this once when it finishes: PBScreen.ended({ sc: 1200, ttl: 'Game over', msg: 'Well played.' })
  function ended(info) {
    if (st === 'ended' || st === 'lobby') return;
    releaseAll();
    $('pbkPause').classList.remove('show');
    st = 'ended';
    endInfo = { sc: Math.max(0, Math.round(info.sc || 0)), ttl: info.ttl || 'Game over', msg: info.msg || '' };
    $('pbkEndTitle').textContent = endInfo.ttl;
    $('pbkEndScore').textContent = fmt(endInfo.sc);
    $('pbkEndMsg').textContent = endInfo.msg;
    setSave('idle', '');
    $('pbkEnd').classList.add('active');
    $('pbkNew').focus();
    if (mode === 'screen') saveBigFinal();               // phone players are saved by the phone
    var endAt = Date.now() + SETTINGS.END_AUTO_RESET_MS;
    function cd() { $('pbkAuto').textContent = 'New QR code in ' + Math.max(0, Math.ceil((endAt - Date.now()) / 1000)) + ' seconds'; }
    cd(); clearInterval(countdownTimer); countdownTimer = setInterval(cd, 1000);
    clearTimeout(endTimer); endTimer = setTimeout(newGame, SETTINGS.END_AUTO_RESET_MS);
    pushState(true);
  }

  // Tell the phone, then reload so the next player gets a fresh QR code and room code
  function newGame() {
    if (newGameStarted) return;
    newGameStarted = true;
    clearTimeout(endTimer); clearInterval(countdownTimer);
    bigDetails = null; closeForm(); releaseAll();
    var delay = 0;
    if (link) {
      var n = 0;
      (function bye() { link.send({ t: 'bye' }); if (++n < 3) setTimeout(bye, 250); })();
      delay = SETTINGS.NEW_GAME_RELOAD_MS;
    }
    setTimeout(function () { location.reload(); }, delay);
  }

  /* ---------------------------- Start ---------------------------------------- */
  function init(c) {
    cfg = c;
    var T = {
      bg1: '#0a1128', bg2: '#0f1a3a', text: '#e6f2f2', dim: '#9fc3c3', accent: '#27baa4', accent2: '#27baa4', warn: '#fcb53a',
      btnText: '#06151a', font: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', titleBg: 'rgba(8,12,28,.9)'
    };
    for (var k in (c.theme || {})) T[k] = c.theme[k];

    var style = document.createElement('style');
    style.textContent = buildCss(T);
    document.head.appendChild(style);
    var root = document.createElement('div');
    root.id = 'pbk';
    root.innerHTML = buildHtml(c);
    document.body.appendChild(root);

    if (typeof PBHubSpot !== 'undefined') {
      $('pbk_consentLabel').textContent = PBHubSpot.SETTINGS.CONSENT_TEXT;
      var n = $('pbk_notice');
      n.textContent = PBHubSpot.SETTINGS.PRIVACY_NOTICE + ' ';
      if (PBHubSpot.SETTINGS.PRIVACY_URL) {
        var a = document.createElement('a');
        a.href = PBHubSpot.SETTINGS.PRIVACY_URL; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Privacy notice';
        n.appendChild(a);
      }
    }

    /* Browsers only allow sound after a touch or key press on this page */
    ['pointerdown', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { if (cfg.unlockAudio) cfg.unlockAudio(); }, { passive: true }); });

    /* buttons */
    $('pbkPlay').addEventListener('click', openForm);
    $('pbkFBack').addEventListener('click', closeForm);
    $('pbkNew').addEventListener('click', newGame);
    $('pbkRetry').addEventListener('click', function () { saveRetried = true; saveBigFinal(); });
    ['input', 'keydown', 'pointerdown', 'touchstart', 'focusin'].forEach(function (ev) { $('pbkForm').addEventListener(ev, resetIdle, { passive: true }); });
    $('pbkForm').addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') closeForm(); });
    $('pbkFormEl').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = PBHubSpot.validate(readDetails());
      showDErrors(v.errors);
      if (!v.ok) { for (var i = 0; i < DFIELDS.length; i++) { if (v.errors[DFIELDS[i]]) { $('pbk_' + DFIELDS[i]).focus(); break; } } return; }
      bigDetails = v.details;                            // memory only
      PBHubSpot.submit(bigDetails, { label: 'start' });  // the lead is kept even if the game is abandoned
      closeForm();                                       // clears the form as the game starts
      startNow('screen');
    });

    /* QR code and connection */
    if (typeof PBLink === 'undefined' || typeof qrcode === 'undefined') { $('pbkQrCard').style.display = 'none'; }
    else {
      roomCode = PBLink.newRoomCode();
      var url = PBLink.controllerUrl(roomCode);
      try {
        var qr = qrcode(0, 'M'); qr.addData(url); qr.make();
        $('pbkQrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      } catch (err) { $('pbkQrBox').innerHTML = '<div class="off">QR code unavailable. Use the address below.</div>'; }
      $('pbkRoom').textContent = roomCode;
      $('pbkUrl').textContent = url.replace(/^https?:\/\//, '');
      link = PBLink.connect({ role: 'screen', room: roomCode, onMessage: onRemote, onStatus: function (s) { linkStatus = s; refreshQr(); } });
      setInterval(tick, 100);
      refreshQr();
    }
    setTimeout(function () { var p = $('pbkPlay'); if (p && st === 'lobby' && !formOpen) p.focus(); }, 200);
  }

  global.PBScreen = {
    SETTINGS: SETTINGS,
    init: init,
    requestStart: openForm,          // games call this wherever they used to start themselves
    ended: ended,
    newGame: newGame,
    get state() { return st; },
    get mode() { return mode; },
    get room() { return roomCode; },
    get details() { return bigDetails; },
    get formOpen() { return formOpen; },
    get paused() { return st === 'paused'; }
  };
})(window);
