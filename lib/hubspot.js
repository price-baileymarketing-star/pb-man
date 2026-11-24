/* ==========================================================================
   lib/hubspot.js  |  HubSpot settings and form submission (big screen + phone)
   --------------------------------------------------------------------------
   Uses HubSpot's public form submission service only. The portal ID and form
   ID are public by design. There are no API keys or tokens in this file, and
   there must never be any.

   Personal details are never stored here: they are passed in, sent, and
   forgotten. The caller holds them in memory only and clears them for the
   next player.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------- SETTINGS ---------------------------------- */
  var SETTINGS = {
    PORTAL_ID: '145711233',
    REGION: 'eu1',
    FORM_ID: '4efe8f63-87e7-4b4c-8ee1-351b8840e6a4',   // one form for every game

    GAME_NAME: 'PB Man',   // sent as game_name
    EVENT_NAME: '',                  // sent as event_name. SET THIS BEFORE EACH EVENT.
    PAGE_NAME: 'PB Man',   // sent in the submission context

    TIMEOUT_MS: 10000,

    // Primary address first, EU address as the fallback
    ENDPOINTS: [
      'https://api.hsforms.com/submissions/v3/integration/submit/',
      'https://api-eu1.hsforms.com/submissions/v3/integration/submit/'
    ],

    // Wording shown next to the form. COMPLIANCE MUST APPROVE ALL THREE before a stand.
    CONSENT_TEXT: 'Price Bailey can contact me about its services and events.',
    PRIVACY_NOTICE: 'We use your details to record your game entry and, only if you tick the box, to contact you.',
    PRIVACY_URL: ''   // Add the approved privacy notice address here. When set, a link appears on both forms.
  };

  var debugHook = null;   // set via PBHubSpot.onDebug = function (text) {}

  function debug(text) { if (typeof debugHook === 'function') { try { debugHook(text); } catch (e) {} } }

  /* ---------------------------- Validation -------------------------------- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }

  // Returns { ok, errors: { field: 'message' }, details: tidy copy }
  function validate(raw) {
    raw = raw || {};
    var d = {
      firstname: clean(raw.firstname, 60),
      lastname: clean(raw.lastname, 60),
      email: clean(raw.email, 120).toLowerCase(),
      company: clean(raw.company, 120),
      mobile: clean(raw.mobile, 25),
      consent: raw.consent === true
    };
    var e = {};
    if (!d.firstname) e.firstname = 'Enter your first name';
    if (!d.lastname) e.lastname = 'Enter your last name';
    if (!d.email) e.email = 'Enter your email address';
    else if (!EMAIL_RE.test(d.email)) e.email = 'Check your email address';
    if (!d.company) e.company = 'Enter your organisation';
    if (d.mobile) {
      var digits = d.mobile.replace(/\D/g, '');
      if (!/^[0-9+()\s-]+$/.test(d.mobile) || digits.length < 7 || digits.length > 15) {
        e.mobile = 'Check your mobile number, or leave it blank';
      }
    }
    return { ok: Object.keys(e).length === 0, errors: e, details: d };
  }

  /* ---------------------------- Payload ----------------------------------- */
  // The big screen's address. On the phone this strips the /controller/ part.
  function bigScreenAddress() {
    var loc = global.location;
    var path = loc.pathname.replace(/controller\/(index\.html)?$/, '').replace(/index\.html$/, '');
    return loc.origin + path;
  }

  // score: pass a number to include it (end of game). Leave it out at the start,
  // so a returning contact's earlier score is not overwritten with nothing.
  function buildPayload(details, score) {
    var f = function (obj, name, value) { return { objectTypeId: obj, name: name, value: String(value) }; };
    var fields = [
      f('0-1', 'firstname', details.firstname),
      f('0-1', 'lastname', details.lastname),
      f('0-1', 'email', details.email),
      f('0-2', 'name', details.company),                 // Organisation Name is the company record
      f('0-1', 'game_name', SETTINGS.GAME_NAME)
    ];
    if (details.mobile) fields.push(f('0-1', 'mobilephone', details.mobile));
    if (SETTINGS.EVENT_NAME) fields.push(f('0-1', 'event_name', SETTINGS.EVENT_NAME));
    if (typeof score === 'number' && isFinite(score)) fields.push(f('0-1', 'high_score', Math.max(0, Math.round(score))));
    if (details.consent === true) fields.push(f('0-1', 'game_form_consent', 'true'));   // left out when unticked

    return {
      submittedAt: Date.now(),
      fields: fields,
      context: { pageUri: bigScreenAddress(), pageName: SETTINGS.PAGE_NAME }
    };
  }

  /* ---------------------------- Sending ----------------------------------- */
  function post(url, body) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, SETTINGS.TIMEOUT_MS) : null;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) { return { status: res.status, ok: res.ok, text: text }; });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  // submit(details, { score: 1234, label: 'start' | 'end' }) -> Promise<{ ok, status, message }>
  function submit(details, opts) {
    opts = opts || {};
    var v = validate(details);
    if (!v.ok) return Promise.resolve({ ok: false, status: 0, message: 'Details not valid' });
    if (!SETTINGS.EVENT_NAME && global.console) console.warn('[PBHubSpot] EVENT_NAME is empty. Set it in lib/hubspot.js before an event.');

    var body = JSON.stringify(buildPayload(v.details, opts.score));
    var label = opts.label || 'submit';
    var tail = SETTINGS.PORTAL_ID + '/' + SETTINGS.FORM_ID;

    function attempt(i) {
      if (i >= SETTINGS.ENDPOINTS.length) return Promise.resolve({ ok: false, status: 0, message: 'Could not reach HubSpot' });
      var url = SETTINGS.ENDPOINTS[i] + tail;
      debug(label + ' -> ' + url.replace(tail, '...'));
      return post(url, body).then(function (r) {
        debug(label + ' reply ' + r.status + ' ' + (r.text || '').slice(0, 300));
        if (r.ok) return { ok: true, status: r.status, message: 'Saved' };
        // Server trouble or rate limit: try the other address. Anything else will not improve.
        if (r.status >= 500 || r.status === 429) return attempt(i + 1);
        return { ok: false, status: r.status, message: 'HubSpot refused the details (' + r.status + ')' };
      }, function (err) {
        debug(label + ' network error: ' + (err && err.message ? err.message : err));
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  global.PBHubSpot = {
    SETTINGS: SETTINGS,
    validate: validate,
    buildPayload: buildPayload,
    submit: submit,
    bigScreenAddress: bigScreenAddress,
    set onDebug(fn) { debugHook = fn; }
  };
})(window);
