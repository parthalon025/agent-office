/* Agent Office for Claude Code x0.1: the room's boards, stats display and door.
   Each lab room gets four things that the user can see and click:
   - The blackboard on the back wall is the agents' overview: plan progress, browser steps, last steps
     and the top of the repository. An agent can pin a note on it. A click flies the camera to it and the
     page shows the same data in full (office.js, BoardPanel). Esc or Back flies out again.
   - The whiteboard left of it holds the user's own notes. A click flies to it and the page lays a text box
     over the board itself, so the user writes on the board.
   - A small wall display on the left wall shows the room's numbers: sessions, tool calls, tokens, cost.
   - A door on the left wall opens the "add or remove agents" dialog. It swings open when an agent comes in
     or leaves (api.doorPulse).
   Colors and fonts come from the DS tokens. The engine draws the room; this file repaints the board
   pictures, adds the decor, and moves the camera on request. The engine builds walls 5.2 high with the
   room sign at 4.45, where the cable tray covers it, so the walls go up to WALL_H and the sign moves up. */
(function () {
  'use strict';
  var T = window.THREE;
  if (!T) return;

  var WALL_H = 7, SIGN_Y = 6.15;
  function isWall(m) { return m.isMesh && m.geometry && m.geometry.type === 'BoxGeometry' && m.geometry.parameters && Math.abs(m.geometry.parameters.height - 5.2) < 0.001; }
  function isSign(m) { return m.isMesh && m.geometry && m.geometry.type === 'PlaneGeometry' && m.geometry.parameters && m.geometry.parameters.width === 4.8 && m.geometry.parameters.height === 1.2; }
  function isBoard(m) { return m.isMesh && m.geometry && m.geometry.type === 'PlaneGeometry' && m.geometry.parameters && m.geometry.parameters.width === 4 && m.geometry.parameters.height === 2.5; }
  function isRack(m) { return m.isMesh && m.geometry && m.geometry.type === 'BoxGeometry' && m.geometry.parameters && m.geometry.parameters.width === 1.3 && m.geometry.parameters.height === 3.2; }
  function cssMs(name, fallback) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // Short names for tools on the board: mcp__plugin_playwright_playwright__browser_click -> click
  function toolWord(name) {
    var n = String(name || '');
    var m = n.match(/__browser_([a-z_]+)$/i);
    if (m) return m[1].replace(/_/g, ' ');
    m = n.match(/^mcp__(.+?)__(.+)$/);
    return m ? m[2].replace(/_/g, ' ') : n;
  }
  function isBrowser(c) { return /playwright|__browser_/i.test(c.name); }

  // What a room board shows, from the sessions in the room. pin: { text, by } or null.
  function boardData(info, tree, pin) {
    var ss = info.sessions || [], calls = [];
    ss.forEach(function (s) { (s.calls || []).forEach(function (c) { calls.push(Object.assign({ who: s.name }, c)); }); });
    calls.sort(function (a, b) { return a.t - b.t; });
    var todosOf = ss.filter(function (s) { return (s.todos || []).length; })[0];
    var touched = {};
    calls.forEach(function (c) { if (c.file) { var top = c.file.split('/')[0]; touched[top] = (touched[top] || 0) + 1; } });
    return {
      room: info.place ? info.place.roomName : 'Room',
      branch: info.place ? info.place.branch : '',
      sessions: ss.map(function (s) { return { name: s.name, status: s.status === 'working' || s.status === 'waiting' ? s.status : s.turns ? 'finished' : 'resting', task: s.prompt || '' }; }),
      todos: todosOf ? todosOf.todos : [],
      goal: todosOf ? todosOf.prompt : '',
      browser: calls.filter(isBrowser).slice(-8),
      recent: calls.filter(function (c) { return !isBrowser(c); }).slice(-6),
      tree: tree || null,
      touched: touched,
      pin: pin && pin.text ? { text: String(pin.text), by: String(pin.by || 'an agent') } : null
    };
  }

  // The room's numbers. Used when the page gives no stats(roomId).
  function statsFrom(info) {
    var ss = info.sessions || [], n = { sessions: ss.length, working: 0, waiting: 0, toolCalls: 0, tokens: 0, cost: 0, todosDone: 0, todosTotal: 0, lastEvent: 0 };
    ss.forEach(function (s) {
      if (s.status === 'working') n.working++;
      if (s.status === 'waiting') n.waiting++;
      n.toolCalls += (s.calls || []).length;
      n.tokens += (s.usage && s.usage.tokens) || 0;
      n.cost += s.cost || 0;
      (s.todos || []).forEach(function (t) { n.todosTotal++; if (t.status === 'completed') n.todosDone++; });
      if ((s.lastEvent || 0) > n.lastEvent) n.lastEvent = s.lastEvent;
    });
    return n;
  }
  function fmtTokens(n) { n = +n || 0; return n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1e6).toFixed(1) + 'M'; }
  function fmtCost(c) { c = +c || 0; return '$' + (c < 10 ? c.toFixed(2) : c.toFixed(1)); }
  function fmtAgo(t, now) {
    if (!t) return 'none yet';
    var s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return Math.round(s / 10) * 10 + ' s ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }

  // ---------- drawing helpers (canvas; colors come from tokens) ----------
  function mix(a, b, t) { try { return '#' + new T.Color(a).lerp(new T.Color(b), t).getHexString(); } catch (e) { return a; } }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function clipW(c, text, maxW) {
    text = String(text || '');
    if (c.measureText(text).width <= maxW) return text;
    while (text.length > 1 && c.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }
  function wrap(c, text, maxW) {
    var out = [];
    String(text).split(/\n/).forEach(function (para) {
      var line = '';
      para.split(/\s+/).forEach(function (w) {
        var t = line ? line + ' ' + w : w;
        if (c.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
      });
      out.push(line);
    });
    return out;
  }
  function seeded(seed) { var s = seed; return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

  // ---------- the blackboard: slate, wood frame, chalk ----------
  function paint(c, w, h, d, tok, f) {
    var sans = f.sans || 'sans-serif', mono = f.mono || 'monospace';
    var col = function (k, fb) { return tok[k] || fb || '#888'; };
    var slate = mix(col('scene-dark'), col('status-working'), 0.12);
    var chalk = mix(col('bubble'), col('scene-dark'), 0.06), dim = mix(col('bubble'), slate, 0.55);
    var wood = mix(col('scene-wood'), col('scene-dark'), 0.22), woodHi = mix(col('scene-wood'), col('bubble'), 0.25);
    var tone = function (k) { return mix(col('status-' + k, col('muted')), col('bubble'), 0.22); };
    var F = 28;
    // wood frame with a lighter top edge and a soft inner shadow
    c.fillStyle = wood; c.fillRect(0, 0, w, h);
    c.strokeStyle = woodHi; c.lineWidth = 3; rr(c, 4, 4, w - 8, h - 8, 22); c.stroke();
    c.fillStyle = slate; rr(c, F, F, w - 2 * F, h - 2 * F, 8); c.fill();
    var g = c.createLinearGradient(0, F, 0, h - F);
    g.addColorStop(0, mix(slate, col('bubble'), 0.07)); g.addColorStop(1, mix(slate, col('scene-dark'), 0.3));
    c.fillStyle = g; rr(c, F, F, w - 2 * F, h - 2 * F, 8); c.fill();
    c.strokeStyle = mix(slate, col('scene-dark'), 0.7); c.lineWidth = 6; rr(c, F + 3, F + 3, w - 2 * F - 6, h - 2 * F - 6, 6); c.stroke();
    // old chalk dust
    var rnd = seeded(7);
    for (var i = 0; i < 12; i++) {
      var dx = F + rnd() * (w - 2 * F), dy = F + rnd() * (h - 2 * F), dr = 50 + rnd() * 90;
      var rg = c.createRadialGradient(dx, dy, 0, dx, dy, dr);
      rg.addColorStop(0, mix(slate, chalk, 0.16)); rg.addColorStop(1, slate);
      c.globalAlpha = 0.16; c.fillStyle = rg; c.fillRect(dx - dr, dy - dr, 2 * dr, 2 * dr);
    }
    c.globalAlpha = 1;
    // chalk text: a soft double stroke, still readable
    var say = function (t, x, y, color) { c.fillStyle = color || chalk; c.globalAlpha = 0.93; c.fillText(t, x, y); c.globalAlpha = 0.26; c.fillText(t, x + 0.9, y + 0.8); c.globalAlpha = 1; };
    var line = function (x1, y, x2, color, wd) {
      c.strokeStyle = color || dim; c.lineWidth = wd || 3; c.lineCap = 'round'; c.globalAlpha = 0.7; c.beginPath(); c.moveTo(x1, y);
      for (var x = x1; x < x2; x += 24) c.lineTo(Math.min(x + 24, x2), y + Math.sin(x * 0.07) * 1.6);
      c.stroke(); c.globalAlpha = 1;
    };
    var dot = function (x, y, status) { c.fillStyle = tone(status); c.globalAlpha = 0.95; c.beginPath(); c.arc(x, y, 7, 0, 7); c.fill(); c.globalAlpha = 1; };
    var X0 = F + 30, X1 = w - F - 30, W2 = X1 - X0, y = F + 24;
    c.textBaseline = 'top'; c.textAlign = 'left';
    // pinned note from an agent
    if (d.pin) {
      c.font = '500 24px ' + sans;
      var msg = wrap(c, 'Note from ' + d.pin.by + ': ' + d.pin.text, W2 - 88).slice(0, 2), ch = 26 + msg.length * 30;
      c.fillStyle = col('bubble'); c.globalAlpha = 0.96; rr(c, X0, y, W2, ch, 12); c.fill(); c.globalAlpha = 1;
      c.fillStyle = col('status-error'); c.beginPath(); c.arc(X0 + 30, y + 30, 9, 0, 7); c.fill();
      c.fillStyle = mix(col('status-error'), col('bubble'), 0.55); c.beginPath(); c.arc(X0 + 27, y + 27, 3, 0, 7); c.fill();
      c.fillStyle = col('ink'); c.font = '500 24px ' + sans;
      msg.forEach(function (l, i) { c.fillText(l, X0 + 62, y + 13 + i * 30); });
      y += ch + 14;
    }
    // headline
    var hs = d.pin ? 38 : 46;
    c.font = '600 ' + hs + 'px ' + sans; say('What the agents do', X0, y);
    c.font = '500 22px ' + mono; c.textAlign = 'right';
    c.fillStyle = dim; c.fillText(clipW(c, d.room + (d.branch ? ' · ' + d.branch : ''), W2 * 0.4), X1, y + 10); c.textAlign = 'left';
    y += hs + 10; line(X0, y, X1); y += 16;
    // plan progress
    if (d.todos.length) {
      var done = d.todos.filter(function (t) { return t.status === 'completed'; }).length, n = d.todos.length;
      c.font = '600 20px ' + sans; say('PLAN', X0, y + 3, dim);
      c.font = '500 26px ' + sans; say(done + ' of ' + n + ' steps done', X0 + 78, y);
      y += 38;
      c.fillStyle = mix(slate, chalk, 0.14); rr(c, X0, y, W2, 18, 9); c.fill();
      if (done) { c.fillStyle = tone('working'); c.globalAlpha = 0.9; rr(c, X0, y, Math.max(18, W2 * done / n), 18, 9); c.fill(); c.globalAlpha = 1; }
      y += 30;
      var cur = d.todos.filter(function (t) { return t.status === 'in_progress'; })[0], next = d.todos.filter(function (t) { return t.status !== 'completed'; })[0];
      c.font = '500 25px ' + sans;
      var stepTxt = cur ? 'Now: ' + cur.text : next ? 'Next: ' + next.text : 'All steps are done.';
      say(clipW(c, stepTxt, W2), X0, y);
      y += 38;
    } else {
      var work = d.sessions.filter(function (s) { return s.status === 'working'; }).length, wait = d.sessions.filter(function (s) { return s.status === 'waiting'; }).length;
      c.font = '500 27px ' + sans;
      if (!d.sessions.length) { say('No agent is here.', X0, y); c.font = '400 23px ' + sans; say('Open the door to add one.', X0, y + 38, dim); }
      else {
        var first = d.sessions.filter(function (s) { return s.task; })[0];
        say(d.sessions.length + (d.sessions.length === 1 ? ' agent' : ' agents') + (work ? ' · ' + work + ' working' : '') + (wait ? ' · ' + wait + ' waiting' : ''), X0, y);
        c.font = '400 23px ' + sans; say(first ? clipW(c, 'Task: ' + first.task, W2) : 'No plan yet.', X0, y + 38, dim);
      }
      y += 82;
    }
    // three columns
    var cw = (W2 - 2 * 26) / 3, top = y + 6, rows = Math.max(1, Math.floor((h - F - 22 - (top + 32)) / 31));
    var cols = [X0, X0 + cw + 26, X0 + 2 * (cw + 26)];
    var head = function (t, x) { c.font = '600 17px ' + sans; say(t.toUpperCase(), x, top, dim); };
    head('Browser steps', cols[0]); head('Last steps', cols[1]); head('Repository' + (d.tree ? ' · ' + d.tree.total + ' files' : ''), cols[2]);
    var empty = function (t, x) { c.font = '400 21px ' + sans; say(t, x, top + 32, dim); };
    var step = function (x, i, status, word, detail) {
      var yy = top + 32 + i * 31;
      dot(x + 8, yy + 13, status);
      c.font = '500 20px ' + mono; var ww = Math.min(110, c.measureText(word).width);
      say(clipW(c, word, 110), x + 26, yy);
      c.font = '400 18px ' + mono; say(clipW(c, detail, cw - 26 - ww - 12), x + 26 + ww + 10, yy + 2, dim);
    };
    var st = function (c2) { return c2.ok === null ? 'working' : c2.ok ? 'finished' : 'error'; };
    if (!d.browser.length) empty('No browser steps yet', cols[0]);
    d.browser.slice(-rows).forEach(function (b, i) { step(cols[0], i, st(b), toolWord(b.name), b.detail || ''); });
    if (!d.recent.length) empty('No steps yet', cols[1]);
    d.recent.slice(-rows).forEach(function (b, i) { step(cols[1], i, st(b), toolWord(b.name), b.file || b.detail || ''); });
    var ents = d.tree ? d.tree.entries.filter(function (e) { return e.dir; }).slice(0, rows) : [];
    if (!ents.length) empty(d.tree ? 'Only files at the top' : 'Loading', cols[2]);
    ents.forEach(function (e, i) {
      var yy = top + 32 + i * 31, hot = d.touched[e.name];
      c.font = (hot ? '600 ' : '400 ') + '20px ' + mono;
      var nm = clipW(c, e.name + '/', cw * 0.55);
      say(nm, cols[2], yy, hot ? tone('working') : chalk);
      c.font = '400 18px ' + mono; c.textAlign = 'right';
      say(e.files + (hot ? ' · ' + hot + ' touched' : ''), cols[2] + cw, yy + 2, dim); c.textAlign = 'left';
    });
  }

  // ---------- the whiteboard: bright surface, thin metal frame, marker ----------
  function paintNotes(c, w, h, text, tok, f) {
    var col = function (k, fb) { return tok[k] || fb || '#888'; }, sans = f.sans || 'sans-serif';
    var metal = col('scene-metal'), face = col('bubble'), ink = mix(col('ink'), col('status-finished'), 0.3);
    c.fillStyle = mix(metal, col('scene-dark'), 0.25); rr(c, 0, 0, w, h, 14); c.fill();
    c.fillStyle = mix(metal, col('bubble'), 0.4); rr(c, 3, 3, w - 6, h - 6, 12); c.fill();
    var g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, face); g.addColorStop(0.55, mix(face, col('scene-wall'), 0.35)); g.addColorStop(1, face);
    c.fillStyle = g; rr(c, 14, 14, w - 28, h - 28, 6); c.fill();
    // ghosts of old marker
    var rnd = seeded(11);
    c.strokeStyle = col('ink'); c.lineCap = 'round'; c.lineWidth = 7;
    for (var i = 0; i < 4; i++) { var gx = 60 + rnd() * (w - 200), gy = 150 + rnd() * (h - 240); c.globalAlpha = 0.035; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + 40 + rnd() * 90, gy + rnd() * 16 - 8); c.stroke(); }
    c.globalAlpha = 1;
    c.textBaseline = 'top'; c.textAlign = 'left';
    c.fillStyle = ink; c.font = '700 40px ' + sans; c.fillText('Notes', 52, 42);
    c.strokeStyle = ink; c.lineWidth = 4; c.globalAlpha = 0.75; c.beginPath(); c.moveTo(52, 92);
    for (var x = 52; x < 230; x += 18) c.lineTo(x + 18, 92 + Math.sin(x * 0.09) * 2);
    c.stroke(); c.globalAlpha = 1;
    if (!String(text || '').trim()) { c.fillStyle = col('muted'); c.font = '500 30px ' + sans; c.fillText('Click to write a reminder.', 52, 128); return; }
    c.fillStyle = ink; c.font = '500 32px ' + sans;
    wrap(c, text, w - 120).slice(0, 10).forEach(function (l, i) { c.globalAlpha = 0.95; c.fillText(l, 52, 124 + i * 40); c.globalAlpha = 0.25; c.fillText(l, 52.7, 124.6 + i * 40); c.globalAlpha = 1; });
  }

  // ---------- the stats display ----------
  function paintStats(c, w, h, s, ago, tok, f) {
    var col = function (k, fb) { return tok[k] || fb || '#888'; }, sans = f.sans || 'sans-serif', mono = f.mono || 'monospace';
    var bezel = mix(col('scene-dark'), col('scene-metal'), 0.25), screen = mix(col('scene-dark'), col('status-finished'), 0.07);
    var dim = mix(col('bubble'), screen, 0.5), txt = col('bubble');
    c.fillStyle = bezel; rr(c, 0, 0, w, h, 30); c.fill();
    c.strokeStyle = col('scene-metal'); c.lineWidth = 6; rr(c, 5, 5, w - 10, h - 10, 27); c.stroke();
    c.fillStyle = screen; rr(c, 24, 24, w - 48, h - 48, 14); c.fill();
    c.textBaseline = 'top'; c.textAlign = 'left';
    c.fillStyle = txt; c.font = '600 34px ' + sans; c.fillText('Room stats', 50, 46);
    c.strokeStyle = dim; c.globalAlpha = 0.5; c.lineWidth = 2; c.beginPath(); c.moveTo(50, 94); c.lineTo(w - 50, 94); c.stroke(); c.globalAlpha = 1;
    var rows = [
      ['Open sessions', String(s.sessions), null],
      ['Working now', String(s.working), s.working ? 'status-working' : null],
      ['Waiting', String(s.waiting), s.waiting ? 'status-waiting' : null],
      ['Tool calls', String(s.toolCalls), null],
      ['Tokens', fmtTokens(s.tokens), null],
      ['Cost', fmtCost(s.cost), null],
      ['To-dos done', s.todosTotal ? s.todosDone + ' / ' + s.todosTotal : 'none', null],
      ['Last event', ago, null]
    ];
    var y0 = 112, rh = (h - 24 - 24 - y0) / rows.length;
    rows.forEach(function (r, i) {
      var y = y0 + i * rh;
      c.fillStyle = dim; c.font = '500 21px ' + sans; c.textAlign = 'left'; c.fillText(r[0], 50, y + rh * 0.5 - 12);
      c.fillStyle = r[2] ? col(r[2]) : txt; c.font = '600 30px ' + mono; c.textAlign = 'right'; c.fillText(r[1], w - 50, y + rh * 0.5 - 17);
    });
    c.textAlign = 'left';
  }

  // ---------- the door sign ----------
  function paintSign(c, w, h, count, tok, f) {
    var col = function (k, fb) { return tok[k] || fb || '#888'; }, sans = f.sans || 'sans-serif', mono = f.mono || 'monospace';
    c.fillStyle = col('scene-dark'); rr(c, 0, 0, w, h, 26); c.fill();
    c.strokeStyle = mix(col('status-waiting'), col('scene-dark'), 0.35); c.lineWidth = 6; rr(c, 6, 6, w - 12, h - 12, 22); c.stroke();
    c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillStyle = col('bubble'); c.font = '600 62px ' + sans; c.fillText('Agents', 36, h / 2 + 3);
    c.fillStyle = col('status-working'); rr(c, w - 150, 28, 114, h - 56, (h - 56) / 2); c.fill();
    c.fillStyle = col('on-status', col('bubble')); c.font = '700 56px ' + mono; c.textAlign = 'center'; c.fillText(String(count), w - 93, h / 2 + 3);
    c.textAlign = 'left';
  }

  // ---------- hint pill (a sprite that fades in on hover) ----------
  function hintTex(text, tok, f) {
    var cv = document.createElement('canvas'); cv.width = 640; cv.height = 140;
    var c = cv.getContext('2d'), sans = f.sans || 'sans-serif';
    c.fillStyle = tok.bubble || '#fff'; rr(c, 6, 10, 628, 116, 58); c.fill();
    c.strokeStyle = tok.accent || tok.emphasis || '#2f6fe4'; c.lineWidth = 6; rr(c, 6, 10, 628, 116, 58); c.stroke();
    c.fillStyle = tok.ink || '#222'; c.font = '600 50px ' + sans; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 320, 70);
    var t = new T.CanvasTexture(cv); t.encoding = T.sRGBEncoding; return t;
  }

  // Attach boards to a mounted office.
  // o: { room(roomId) -> info, tree(root) -> Promise, note(roomId) -> text, stats(roomId) -> numbers, pin(roomId) -> { text, by },
  //      onFocus(roomId, kind), onBlur(), onDoor(roomId) }
  function attach(office, o) {
    var ins = office.inspect && office.inspect(), st = ins && ins.stage;
    if (!st) return { refresh: function () {}, blur: function () {}, dispose: function () {}, doorPulse: function () {}, rooms: function () { return []; } };
    var boards = [];      // blackboards: { kind:'board', mesh, roomId, tex, canvas }
    var notes = [];       // whiteboards: { kind:'notes', ... }
    var statsList = [];   // wall displays: { kind:'stats', ... }
    var doors = [];       // doors: { kind:'door', ... }
    var decorRooms = [];  // room groups that have decor
    var trees = {};       // root -> tree
    var focused = null, focusedKind = null, focusedMesh = null, saved = null, dead = false;
    var lastTok = st.K.tok, skinVersion = 0;
    var K = st.K;

    function tk(k) { return K.tok[k]; }
    function themed(key, opt) { return K.t(key, opt); }
    function noNav(obj) { obj.traverse(function (m) { m.userData.noNav = 1; }); return obj; }
    function newTex(w, h) {
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var tex = new T.CanvasTexture(cv); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
      return { canvas: cv, tex: tex };
    }
    function plane(w, h, tex, emissive, name) {
      var m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshStandardMaterial({ map: tex, roughness: 1, alphaTest: 0.5, emissive: new T.Color(0xffffff), emissiveMap: tex, emissiveIntensity: emissive }));
      m.userData.noNav = 1; m.castShadow = false; m.name = name || '';
      return m;
    }
    function box(w, h, d, mat, x, y, z, parent) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.userData.noNav = 1; m.castShadow = true; m.receiveShadow = true;
      if (parent) parent.add(m); return m;
    }
    function cyl(r, len, mat, x, y, z, parent) {
      var m = new T.Mesh(new T.CylinderGeometry(r, r, len, 14), mat); m.position.set(x, y, z); m.userData.noNav = 1; m.castShadow = true;
      if (parent) parent.add(m); return m;
    }
    function plantAt(rg, x, z, s) {
      var P = window.AgentOffice && window.AgentOffice.office && window.AgentOffice.office.Parts;
      if (!P || !P.plant) return;
      var g = new T.Group(); g.position.set(x, 0, z); P.plant(K, g, 0, 0, s); noNav(g); rg.add(g);
    }

    // ----- scan: find the engine's boards and add the decor, once per room -----
    function scan() {
      var floor = office.inspect().floor;
      var b = office.getBuilding && office.getBuilding();
      var fl = b && b.floors.filter(function (f) { return f.id === floor; })[0];
      if (!fl) return;
      // boards of the shown floor, left to right, match its rooms in order
      var found = [];
      st.scene.traverse(function (m) {
        if (!isBoard(m)) return;
        var p = m.parent, vis = true;
        while (p) { if (!p.visible) { vis = false; break; } p = p.parent; }
        if (vis) found.push(m);
      });
      found.sort(function (a, b2) { return a.getWorldPosition(new T.Vector3()).x - b2.getWorldPosition(new T.Vector3()).x; });
      var rooms = fl.rooms.filter(function (r) { return r.type === 'lab'; });
      if (found.length !== rooms.length) return;   // building view or a rebuild in progress
      // taller walls, and the room sign above the cable tray
      found.forEach(function (m) {
        var rg = m.parent;
        rg.children.forEach(function (c) {
          if (isWall(c) && !c.userData.tall) { c.userData.tall = 1; c.scale.y = WALL_H / 5.2; c.position.y = WALL_H / 2; c.updateMatrix(); c.updateMatrixWorld(true); }
          if (isSign(c) && !c.userData.moved) { c.userData.moved = 1; c.position.y = SIGN_Y; c.updateMatrix(); c.updateMatrixWorld(true); }
        });
      });
      found.forEach(function (m, i) {
        var id = rooms[i].id, have = boards.filter(function (x) { return x.mesh === m; })[0];
        if (have) { have.roomId = id; return; }
        var t = newTex(1024, 640);
        m.material.map = t.tex; m.material.emissive = new T.Color(0xffffff); m.material.emissiveMap = t.tex; m.material.emissiveIntensity = 0.55; m.material.needsUpdate = true;
        m.userData.officeBoard = id;
        var bd = { kind: 'board', mesh: m, roomId: id, tex: t.tex, canvas: t.canvas, sig: '', mat: m.material, base: 0.55, hov: 0.85, g: 0, tgt: 0, hit: [m], hint: 'Open the overview' };
        m.userData.item = bd; boards.push(bd);
        // a chalk ledge under the blackboard, with two pieces of chalk
        var ledge = new T.Group(); ledge.position.set(m.position.x, m.position.y - 1.25 - 0.04, m.position.z + 0.1); m.parent.add(ledge);
        box(3.9, 0.07, 0.2, themed('scene-wood'), 0, 0, 0, ledge);
        box(0.22, 0.04, 0.05, themed('bubble'), -0.7, 0.055, 0.02, ledge);
        box(0.14, 0.04, 0.05, themed('bubble'), -0.35, 0.055, 0.0, ledge).rotation.y = 0.5;
        noNav(ledge);
      });
      // a whiteboard left of each blackboard, on the same wall
      found.forEach(function (m, i) {
        var id = rooms[i].id, have = notes.filter(function (n) { return n.mesh.parent === m.parent; })[0];
        if (have) { have.roomId = id; return; }
        var t = newTex(900, 560);
        var nm = plane(3.6, 2.24, t.tex, 0.22, 'notes');
        nm.position.set(m.position.x - 4.1, m.position.y, m.position.z + 0.005);
        nm.userData.officeNotes = id;
        m.parent.add(nm);
        var nd = { kind: 'notes', mesh: nm, roomId: id, tex: t.tex, canvas: t.canvas, sig: null, mat: nm.material, base: 0.22, hov: 0.5, g: 0, tgt: 0, hit: [nm], hint: 'Write notes' };
        nm.userData.item = nd; notes.push(nd);
        // marker tray with two markers
        var tray = new T.Group(); tray.position.set(nm.position.x, nm.position.y - 1.12 - 0.045, nm.position.z + 0.1); m.parent.add(tray);
        box(2.9, 0.07, 0.2, themed('scene-metal'), 0, 0, 0, tray);
        box(2.9, 0.1, 0.03, themed('scene-metal'), 0, 0.045, 0.085, tray);
        var m1 = cyl(0.045, 0.4, themed('status-finished'), -0.5, 0.1, 0.0, tray); m1.rotation.z = Math.PI / 2; m1.rotation.y = 0.12;
        var m2 = cyl(0.045, 0.4, themed('status-error'), -0.05, 0.1, 0.02, tray); m2.rotation.z = Math.PI / 2; m2.rotation.y = -0.08;
        [[-0.7, m1], [-0.25, m2]].forEach(function (p) { cyl(0.05, 0.1, themed('ink'), p[0], 0.1, p[1].position.z, tray).rotation.z = Math.PI / 2; });
        noNav(tray);
      });
      // wall display, door, lamp and plants, once per room
      found.forEach(function (m, i) {
        var rg = m.parent, id = rooms[i].id, dec = decorRooms.filter(function (d) { return d.rg === rg; })[0];
        if (dec) { dec.stats.roomId = id; dec.door.roomId = id; return; }
        var bx = m.position.x, bz = m.position.z, leftX = bx - 8;   // the left wall's inner face (the blackboard stands 8 from it)
        var lw = new T.Group(); lw.position.set(leftX + 0.02, 0, 0); lw.rotation.y = Math.PI / 2; rg.add(lw);   // local x runs along the wall, toward the back
        // stats display
        var sw = 1.5, sh = 1.95, s = newTex(520, Math.round(520 * sh / sw));
        var sm = plane(sw, sh, s.tex, 0.6, 'stats'); sm.position.set(-4.9, 2.15, 0.03); lw.add(sm);
        var sd = { kind: 'stats', mesh: sm, roomId: id, tex: s.tex, canvas: s.canvas, sig: null, mat: sm.material, base: 0.6, hov: 0.95, g: 0, tgt: 0, hit: [sm], hint: 'Room stats' };
        sm.userData.item = sd; statsList.push(sd);
        // door: frame, leaf, handle, doorway, lit sign
        var dgx = -2.9, DW = 1.3, DH = 2.1, y0 = 0.06;
        var dg = new T.Group(); dg.position.set(dgx, 0, 0.03); lw.add(dg);
        var frameMat = themed('scene-rug'), hit = [];
        hit.push(box(0.1, DH + 0.2, 0.12, frameMat, -DW / 2 - 0.05, y0 + (DH + 0.1) / 2, 0, dg));
        hit.push(box(0.1, DH + 0.2, 0.12, frameMat, DW / 2 + 0.05, y0 + (DH + 0.1) / 2, 0, dg));
        hit.push(box(DW + 0.3, 0.12, 0.12, frameMat, 0, y0 + DH + 0.06, 0, dg));
        var inner = new T.Mesh(new T.PlaneGeometry(DW, DH), new T.MeshStandardMaterial({ color: new T.Color(tk('scene-dark')).multiplyScalar(0.45), roughness: 1, emissive: new T.Color(tk('status-waiting')), emissiveIntensity: 0 }));
        inner.position.set(0, y0 + DH / 2, 0.01); inner.userData.noNav = 1; dg.add(inner); hit.push(inner);
        var pivot = new T.Group(); pivot.position.set(-DW / 2 + 0.02, y0, 0.05); dg.add(pivot);
        var leafMat = themed('scene-wood', { emissive: new T.Color(tk('status-waiting')), emissiveIntensity: 0 });
        var leaf = box(DW - 0.04, DH - 0.02, 0.07, leafMat, (DW - 0.04) / 2, (DH - 0.02) / 2, 0, pivot); hit.push(leaf);
        box(DW - 0.4, 0.8, 0.02, leafMat, (DW - 0.04) / 2, 0.6, 0.045, pivot).castShadow = false;
        box(DW - 0.4, 0.7, 0.02, leafMat, (DW - 0.04) / 2, 1.5, 0.045, pivot).castShadow = false;
        var knob = new T.Mesh(new T.SphereGeometry(0.065, 12, 10), themed('scene-metal')); knob.position.set(DW - 0.2, 1.0, 0.1); knob.userData.noNav = 1; pivot.add(knob);
        var sg = newTex(600, 180), sgm = plane(1.1, 0.33, sg.tex, 0.85, 'doorsign'); sgm.position.set(0, y0 + DH + 0.38, 0.02); dg.add(sgm); hit.push(sgm);
        // lamp: warm light between the door and the boards; it also glows when an agent comes or goes
        var lamp = st.lamp(rg, leftX + 2.4, 3.2, 1.2, 0xffc47a, 10);
        var dr = { kind: 'door', mesh: leaf, roomId: id, tex: sg.tex, canvas: sg.canvas, sig: null, mat: leafMat, base: 0, hov: 0.3, g: 0, tgt: 0, hit: hit, hint: 'Add or remove agents',
          pivot: pivot, inner: inner, sign: sgm, lamp: lamp, lampBase: null, pulse: null, open: 0 };
        hit.forEach(function (x) { x.userData.item = dr; });
        doors.push(dr);
        lw.updateMatrixWorld(true);
        // plants: the back-left corner, and right of the blackboard
        plantAt(rg, leftX + 0.55, bz + 0.6, 0.9);
        plantAt(rg, bx + 2.45, bz + 0.55, 0.75);
        decorRooms.push({ rg: rg, stats: sd, door: dr });
      });
      function alive(n) { var p = n.mesh; while (p.parent) p = p.parent; return p === st.scene; }
      notes = notes.filter(alive); boards = boards.filter(alive); statsList = statsList.filter(alive); doors = doors.filter(alive);
      decorRooms = decorRooms.filter(function (d) { var p = d.rg; while (p.parent) p = p.parent; return p === st.scene; });
    }
    function allItems() { return boards.concat(notes, statsList, doors); }

    function statsOf(roomId) {
      var s = o.stats ? o.stats(roomId) : null;
      return Object.assign(statsFrom(o.room(roomId) || {}), s || {});
    }
    function skin() {   // colors that read tokens and are not themed by the engine
      doors.forEach(function (d) {
        d.mat.emissive.set(tk('status-waiting'));
        d.inner.material.color.set(tk('scene-dark')).multiplyScalar(0.45);
      });
    }
    function refresh() {
      if (dead) return;
      var themeChanged = lastTok !== K.tok;
      if (themeChanged) { lastTok = K.tok; skinVersion++; hints = {}; }
      scan();
      if (themeChanged) skin();
      var now = Date.now();
      boards.forEach(function (bd) {
        var info = o.room(bd.roomId);
        var root = info.place && info.place.root;
        if (root && !(root in trees) && o.tree) { trees[root] = null; o.tree(root).then(function (t) { trees[root] = t; refresh(); }, function () { trees[root] = { total: 0, entries: [] }; }); }
        var d = boardData(info, root ? trees[root] : null, o.pin ? o.pin(bd.roomId) : null);
        var sig = skinVersion + K.look + JSON.stringify(d);
        if (sig === bd.sig) return;
        bd.sig = sig; bd.data = d;
        paint(bd.canvas.getContext('2d'), bd.canvas.width, bd.canvas.height, d, K.tok, K.f || {});
        bd.tex.needsUpdate = true;
      });
      notes.forEach(function (n) {
        var text = o.note ? o.note(n.roomId) : '';
        var sig = skinVersion + K.look + text;
        if (sig === n.sig) return;
        n.sig = sig;
        paintNotes(n.canvas.getContext('2d'), n.canvas.width, n.canvas.height, text, K.tok, K.f || {});
        n.tex.needsUpdate = true;
      });
      statsList.forEach(function (s) {
        var v = statsOf(s.roomId), ago = fmtAgo(v.lastEvent, now);
        var sig = skinVersion + K.look + [v.sessions, v.working, v.waiting, v.toolCalls, v.tokens, v.cost, v.todosDone, v.todosTotal, ago].join('|');
        if (sig === s.sig) return;
        s.sig = sig; s.data = v;
        paintStats(s.canvas.getContext('2d'), s.canvas.width, s.canvas.height, v, ago, K.tok, K.f || {});
        s.tex.needsUpdate = true;
      });
      doors.forEach(function (d) {
        var n = statsOf(d.roomId).sessions, sig = skinVersion + K.look + n;
        if (sig === d.sig) return;
        d.sig = sig;
        paintSign(d.canvas.getContext('2d'), d.canvas.width, d.canvas.height, n, K.tok, K.f || {});
        d.tex.needsUpdate = true;
      });
    }

    // ----- the door: swing open and shut for an agent who comes in or leaves -----
    var OPEN_ANGLE = 1.25;
    function doorPulse(roomId, dir) {
      var d = doors.filter(function (x) { return x.roomId === roomId; })[0];
      if (!d) return;
      var D = cssMs('duration-camera', 600);
      if (d.pulse) { d.pulse.t = Math.min(d.pulse.t, D); d.pulse.dir = dir; }   // already moving: hold it open a little longer
      else { d.pulse = { t: 0, dir: dir, D: D, H: D * 1.6 }; d.lampBase = d.lamp.intensity; }
      var c = new T.Color(tk(dir === 'out' ? 'status-waiting' : 'status-working'));
      d.inner.material.emissive.copy(c); d.lamp.color.copy(c);
    }
    function stepDoors(dt) {
      doors.forEach(function (d) {
        var p = d.pulse, a = 0;
        if (p) {
          p.t += dt * 1000;
          var D = p.D, H = p.H;
          if (p.t < D) a = easeInOut(p.t / D);
          else if (p.t < D + H) a = 1;
          else if (p.t < 2 * D + H) a = 1 - easeInOut((p.t - D - H) / D);
          else { d.pulse = null; a = 0; d.lamp.intensity = d.lampBase; d.lamp.color.set(0xffc47a); }
        }
        if (p || d.open !== 0) {
          d.open = a;
          d.pivot.rotation.y = st.rm ? 0 : -OPEN_ANGLE * a;
          d.inner.material.emissiveIntensity = 0.9 * a;
          d.sign.material.emissiveIntensity = 0.85 + 0.5 * a;
          if (d.pulse) d.lamp.intensity = d.lampBase + 2.2 * a;
        }
      });
    }

    // ----- hover: glow, pointer cursor and a hint pill -----
    var cv = st.r.domElement, ray = new T.Raycaster(), ndc = new T.Vector2(), down = null;
    var hints = {}, hintSprite = null, hintTarget = 0, hovered = null, hoverDirty = false, px = 0, py = 0;
    function hintFor(text) {
      if (!hints[text]) hints[text] = hintTex(text, K.tok, K.f || {});
      return hints[text];
    }
    function setHint(item, point) {
      if (!hintSprite) {
        hintSprite = new T.Sprite(new T.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
        hintSprite.renderOrder = 1000; hintSprite.userData.noNav = 1; st.scene.add(hintSprite);
      }
      if (!item) { hintTarget = 0; return; }
      var tex = hintFor(item.hint);
      if (hintSprite.material.map !== tex) { hintSprite.material.map = tex; hintSprite.material.needsUpdate = true; }
      var k = 1 / clamp(st.cam.zoom, 0.4, 4);
      hintSprite.scale.set(3.4 * k, 3.4 * 140 / 640 * k, 1);
      hintSprite.position.copy(point).add(new T.Vector3(0, 0.55 * k, 0));
      hintTarget = 1;
    }
    function pointer(e) {
      var r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, st.cam);
      var meshes = []; allItems().forEach(function (it) { meshes = meshes.concat(it.hit); });
      var hit = ray.intersectObjects(meshes, false)[0];
      return hit ? { item: hit.object.userData.item, point: hit.point } : null;
    }
    function onMove(e) { px = e.clientX; py = e.clientY; hoverDirty = true; }
    function onLeave() { hoverDirty = false; hovered = null; allItems().forEach(function (it) { it.tgt = 0; }); setHint(null); cv.style.cursor = ''; }
    function hoverStep() {
      hoverDirty = false;
      if (focused || fly) { if (hovered) onLeave(); return; }
      var h = pointer({ clientX: px, clientY: py });
      hovered = h && h.item;
      cv.style.cursor = h ? 'pointer' : '';
      allItems().forEach(function (it) { it.tgt = it === hovered ? 1 : 0; });
      setHint(hovered, h ? h.point : null);
    }
    function glowStep(dt) {
      var k = st.rm ? 1 : Math.min(1, dt * 10);
      allItems().forEach(function (it) {
        if (it.g !== it.tgt) {
          it.g += (it.tgt - it.g) * k; if (Math.abs(it.tgt - it.g) < 0.01) it.g = it.tgt;
          it.mat.emissiveIntensity = it.base + (it.hov - it.base) * it.g;
        }
      });
      if (hintSprite) {
        var op = hintSprite.material.opacity;
        if (op !== hintTarget) { op += (hintTarget - op) * (st.rm ? 1 : Math.min(1, dt * 9)); if (Math.abs(hintTarget - op) < 0.02) op = hintTarget; hintSprite.material.opacity = op; }
        hintSprite.visible = hintSprite.material.opacity > 0;
      }
    }

    // ----- camera: fly to face the board, and back -----
    var fly = null;
    st.anim.push(function (dt) {
      if (dead) return;
      if (K.tok !== lastTok) refresh();   // the theme changed: repaint at once
      if (focused && st.goal) st.goal = null;   // the engine must not reframe while a board is open
      if (hoverDirty) hoverStep();
      glowStep(dt);
      stepDoors(dt);
      if (!fly) return;
      fly.t = Math.min(1, fly.t + dt * 1000 / fly.ms);
      var e = easeInOut(fly.t), tg = st.ctl ? st.ctl.target : st.target;
      st.cam.position.lerpVectors(fly.p0, fly.p1, e);
      tg.lerpVectors(fly.t0, fly.t1, e);
      st.cam.zoom = fly.z0 + (fly.z1 - fly.z0) * e; st.cam.updateProjectionMatrix();
      if (fly.t >= 1) { var done = fly.done; fly = null; if (done) done(); }
    });
    function flyTo(p1, t1, z1, done) {
      var tg = st.ctl ? st.ctl.target : st.target;
      var ms = st.rm ? 1 : cssMs('duration-camera', 600) * 1.4;
      fly = { t: 0, ms: ms, p0: st.cam.position.clone(), p1: p1, t0: tg.clone(), t1: t1, z0: st.cam.zoom, z1: z1, done: done };
    }
    function focus(bd, kind) {
      if (focused) return;
      onLeave();
      var tg = st.ctl ? st.ctl.target : st.target;
      saved = { p: st.cam.position.clone(), t: tg.clone(), z: st.cam.zoom };
      var c = bd.mesh.getWorldPosition(new T.Vector3());
      var n = new T.Vector3(0, 0, 1).applyQuaternion(bd.mesh.getWorldQuaternion(new T.Quaternion()));
      var dist = saved.p.distanceTo(saved.t);
      // face the board, a little from above, close enough to read it
      var p1 = c.clone().addScaledVector(n, dist).add(new T.Vector3(0, dist * 0.12, 0));
      var span = (st.cam.top - st.cam.bottom) || 1;
      var vis = kind === 'stats' ? bd.mesh.geometry.parameters.height * 1.8 : 4.4;
      var z1 = Math.min(st.ctl ? st.ctl.maxZoom * 1.6 : 6, span / vis);   // the item fills most of the view, with room around it
      focused = bd.roomId; focusedKind = kind || 'board'; focusedMesh = bd.mesh;
      if (st.ctl) st.ctl.enabled = false;
      // after the flight the camera is the user's again: turn, zoom and move as usual
      flyTo(p1, c, z1, function () { if (st.ctl) st.ctl.enabled = true; });
      if (o.onFocus) o.onFocus(bd.roomId, focusedKind);
    }
    function blur() {
      if (!focused || !saved) return;
      focused = null; focusedKind = null; focusedMesh = null;
      if (st.ctl) st.ctl.enabled = false;
      flyTo(saved.p, saved.t, saved.z, function () { if (st.ctl) st.ctl.enabled = true; });
      if (o.onBlur) o.onBlur();
    }

    // clicks (not drags)
    function onDown(e) { down = [e.clientX, e.clientY]; }
    function onUp(e) {
      if (!down) return;
      var moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
      if (moved > 6) return;
      if (focused) { if (focusedKind === 'stats' && !fly) blur(); return; }   // the stats view has no page panel: a click on the scene closes it
      var h = pointer(e);
      if (!h) return;
      if (h.item.kind === 'door') { if (o.onDoor) o.onDoor(h.item.roomId); return; }
      focus(h.item, h.item.kind);
    }
    function onKey(e) { if (e.key === 'Escape' && focused) blur(); }
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey);
    var timer = setInterval(refresh, 1500);
    refresh();
    return {
      refresh: refresh, blur: blur, focused: function () { return focused; }, kind: function () { return focusedKind; },
      flying: function () { return !!fly; },
      doorPulse: doorPulse,
      rooms: function () { return boards.map(function (b) { return b.roomId; }); },
      // the open board's corners on screen, so the page can lay a text box exactly over it
      rect: function () {
        if (!focusedMesh) return null;
        var g = focusedMesh.geometry.parameters, r = cv.getBoundingClientRect(), xs = [], ys = [];
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
          var v = new T.Vector3(q[0] * g.width / 2, q[1] * g.height / 2, 0);
          focusedMesh.localToWorld(v); v.project(st.cam);
          xs.push(r.left + (v.x + 1) / 2 * r.width); ys.push(r.top + (1 - v.y) / 2 * r.height);
        });
        return { left: Math.min.apply(null, xs), top: Math.min.apply(null, ys), width: Math.max.apply(null, xs) - Math.min.apply(null, xs), height: Math.max.apply(null, ys) - Math.min.apply(null, ys) };
      },
      dataOf: function (roomId) { var b = boards.filter(function (x) { return x.roomId === roomId; })[0]; return b && b.data; },
      dispose: function () {
        dead = true; clearInterval(timer);
        cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerleave', onLeave);
        window.removeEventListener('keydown', onKey);
        if (hintSprite && hintSprite.parent) hintSprite.parent.remove(hintSprite);
        cv.style.cursor = '';
      }
    };
  }

  window.OfficeBoard = { attach: attach, data: boardData, toolWord: toolWord };
})();
