/* ==========================================================================
   lib/link.js  |  Connection between the big screen and the phone controller
   --------------------------------------------------------------------------
   Messages travel over public MQTT brokers (secure WebSockets). Both brokers
   are used together for redundancy, so every message can arrive twice and is
   de-duplicated here. BroadcastChannel is used as well, so the game and the
   controller can be desk-tested in two tabs of the same browser.

   Needs lib/mqtt.min.js loaded first (global: mqtt).

   Usage (big screen):
     var link = PBLink.connect({ role: 'screen', room: 'K7QX', onMessage: fn, onStatus: fn });
   Usage (phone):
     var link = PBLink.connect({ role: 'controller', room: 'K7QX', onMessage: fn, onStatus: fn });
   Then: link.send({ t: 'move', x: 0.5 })

   Status object passed to onStatus:
     { net:  'connecting' | 'ok' | 'offline',   // can this device reach a broker?
       peer: 'none' | 'up' | 'lost' | 'notfound' } // is the other screen alive?
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------- SETTINGS ---------------------------------- */
  var SETTINGS = {
    TOPIC_ROOT: 'pricebailey',
    GAME_SLUG: 'pb-man',      // topic prefix: pricebailey/scaling-breakout/ROOM
    BROKERS: [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt'
    ],
    HEARTBEAT_MS: 2000,                 // each side says "still here" this often
    PEER_TIMEOUT_MS: 6000,              // the other side is gone after this much silence
    NOT_FOUND_MS: 7000,                 // controller: no screen answered after this long
    BROKER_GIVE_UP_MS: 9000,            // no broker connected after this long = no internet
    ROOM_LENGTH: 4,
    // No look-alike characters (no O, 0, I, 1)
    ROOM_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  };

  /* ---------------------------- Helpers ----------------------------------- */
  function qs(name) {
    try { return new URLSearchParams(global.location.search).get(name); } catch (e) { return null; }
  }
  function rand(n) {
    var s = '', a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < n; i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  }

  function newRoomCode() {
    var out = '', a = SETTINGS.ROOM_ALPHABET;
    var buf = null;
    try { buf = global.crypto.getRandomValues(new Uint8Array(SETTINGS.ROOM_LENGTH)); } catch (e) {}
    for (var i = 0; i < SETTINGS.ROOM_LENGTH; i++) {
      var r = buf ? buf[i] : Math.floor(Math.random() * 256);
      out += a.charAt(r % a.length);
    }
    return out;
  }

  // Tidy what a person might type or what arrives in the address
  function cleanRoom(s) {
    s = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.length === SETTINGS.ROOM_LENGTH ? s : '';
  }

  // ?broker=ws://localhost:9001 (comma separated for several) overrides the public brokers
  function brokerList() {
    var o = qs('broker');
    if (o) return o.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return SETTINGS.BROKERS.slice();
  }

  // Address the QR code points to. Carries ?broker= across so the phone tests the same broker.
  function controllerUrl(room) {
    var base = new URL('controller/', global.location.href);
    base.search = '';
    base.hash = '';
    base.searchParams.set('room', room);
    var b = qs('broker');
    if (b) base.searchParams.set('broker', b);
    return base.toString();
  }

  /* ---------------------------- Connection -------------------------------- */
  function connect(opts) {
    var role = opts.role;                       // 'screen' or 'controller'
    var other = role === 'screen' ? 'controller' : 'screen';
    var room = opts.room;
    var onMessage = opts.onMessage || function () {};
    var onStatus = opts.onStatus || function () {};
    var heartbeatExtra = opts.heartbeatExtra || function () { return {}; };

    var prefix = SETTINGS.TOPIC_ROOT + '/' + SETTINGS.GAME_SLUG + '/' + room;
    var topicOut = prefix + '/' + role;         // what this side publishes
    var topicIn = prefix + '/' + other;         // what this side listens to

    var startedAt = Date.now();
    var closed = false;
    var clients = [];                           // { url, client, up }
    var seen = {};                              // de-duplication
    var seenOrder = [];
    var counter = 0;
    var senderId = rand(6);
    var lastPeerAt = 0;
    var everSawPeer = false;
    var lastStatusKey = '';
    var bc = null;

    /* ---- inbound: de-duplicate then hand over ---- */
    function receive(raw, via) {
      var msg;
      try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
      if (!msg || typeof msg !== 'object' || !msg.i || msg.r !== other) return;
      if (seen[msg.i]) return;                  // arrived twice, ignore
      seen[msg.i] = 1;
      seenOrder.push(msg.i);
      if (seenOrder.length > 400) delete seen[seenOrder.shift()];

      lastPeerAt = Date.now();
      everSawPeer = true;
      evaluate();
      // Heartbeats are passed on too: they carry data such as the controller id.
      onMessage(msg, via);
    }

    /* ---- outbound: every route at once ---- */
    function send(obj) {
      if (closed) return;
      counter++;
      var msg = {};
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) msg[k] = obj[k];
      msg.i = senderId + '.' + counter;         // unique id, lets the other side drop duplicates
      msg.r = role;
      var text = JSON.stringify(msg);
      for (var n = 0; n < clients.length; n++) {
        var c = clients[n];
        if (c.up) { try { c.client.publish(topicOut, text, { qos: 0 }); } catch (e) {} }
      }
      if (bc) { try { bc.postMessage(msg); } catch (e) {} }
    }

    /* ---- brokers ---- */
    function startBrokers() {
      if (typeof global.mqtt === 'undefined') { evaluate(); return; }
      brokerList().forEach(function (url) {
        var entry = { url: url, client: null, up: false };
        clients.push(entry);
        try {
          entry.client = global.mqtt.connect(url, {
            clientId: 'pbgame_' + role + '_' + rand(10),
            clean: true,
            keepalive: 30,
            connectTimeout: 8000,
            reconnectPeriod: 2000,
            queueQoSZero: false                 // never replay stale messages after a reconnect
          });
        } catch (e) { return; }
        entry.client.on('connect', function () {
          entry.up = true;
          entry.client.subscribe(topicIn, { qos: 0 });
          evaluate();
        });
        entry.client.on('close', function () { entry.up = false; evaluate(); });
        entry.client.on('offline', function () { entry.up = false; evaluate(); });
        entry.client.on('error', function () { /* reconnect is automatic */ });
        entry.client.on('message', function (t, payload) {
          if (t === topicIn) receive(payload.toString(), 'mqtt');
        });
      });
    }

    /* ---- desk testing: two tabs of one browser ---- */
    function startBroadcast() {
      if (typeof global.BroadcastChannel === 'undefined') return;
      try {
        bc = new global.BroadcastChannel(SETTINGS.TOPIC_ROOT + '-' + SETTINGS.GAME_SLUG + '-' + room);
        bc.onmessage = function (e) { receive(e.data, 'bc'); };
      } catch (e) { bc = null; }
    }

    /* ---- status ---- */
    function currentStatus() {
      var now = Date.now();
      var brokersUp = clients.some(function (c) { return c.up; });
      var net;
      if (global.navigator && global.navigator.onLine === false && !brokersUp) net = 'offline';
      else if (brokersUp) net = 'ok';
      else if (now - startedAt > SETTINGS.BROKER_GIVE_UP_MS) net = 'offline';
      else net = 'connecting';

      var peer;
      if (everSawPeer) peer = (now - lastPeerAt > SETTINGS.PEER_TIMEOUT_MS) ? 'lost' : 'up';
      else if (role === 'controller' && net === 'ok' && now - startedAt > SETTINGS.NOT_FOUND_MS) peer = 'notfound';
      else peer = 'none';
      return { net: net, peer: peer };
    }
    function evaluate() {
      var s = currentStatus();
      var key = s.net + '|' + s.peer;
      if (key !== lastStatusKey) { lastStatusKey = key; onStatus(s); }
    }

    /* ---- heartbeat ---- */
    var hbTimer = setInterval(function () {
      var extra = heartbeatExtra() || {};
      extra.t = 'hb';
      send(extra);
      evaluate();
    }, SETTINGS.HEARTBEAT_MS);
    var watchTimer = setInterval(evaluate, 500);

    startBroadcast();
    startBrokers();
    global.addEventListener('online', function () { evaluate(); });
    global.addEventListener('offline', function () { evaluate(); });
    setTimeout(function () { send({ t: 'hb' }); evaluate(); }, 300);
    evaluate();

    return {
      send: send,
      status: currentStatus,
      room: room,
      close: function () {
        closed = true;
        clearInterval(hbTimer);
        clearInterval(watchTimer);
        clients.forEach(function (c) { try { c.client.end(true); } catch (e) {} });
        if (bc) { try { bc.close(); } catch (e) {} }
      }
    };
  }

  global.PBLink = {
    SETTINGS: SETTINGS,
    connect: connect,
    newRoomCode: newRoomCode,
    cleanRoom: cleanRoom,
    controllerUrl: controllerUrl,
    query: qs
  };
})(window);
