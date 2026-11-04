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
   Also a chalk ledge, a marker tray, a warm lamp and two plants. The server's room description (server.mjs roomContents) lists it in words; keep the two in step.
   Colors and fonts come from the DS tokens. The engine draws the room; this file repaints the board
   pictures, adds the decor, and moves the camera on request. The engine builds walls 5.2 high with the
   room sign at 4.45, where the cable tray covers it, so the walls go up to WALL_H and the sign moves up.
   The engine rebuilds a floor when a bot joins or leaves and when the theme changes. The per-frame hook
   sees that and puts the decor back before the frame draws. */
(function () {
  'use strict';
  var T = window.THREE, H = window.OfficeSceneHost;
  if (!T || !H) return;

  var WALL_H = 7, SIGN_Y = 6.15;
  // The DS geometry finders live in the scene host, the one module that reads the DS stage.
  var isWall = H.pure.parts.isWall, isBackWall = H.pure.parts.isBackWall, isSideWall = H.pure.parts.isSideWall, isSign = H.pure.parts.isSign, isBoard = H.pure.parts.isBoard;
  function cssNum(name, fallback) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function noop() {}
  // A dialog or the command palette is on top of the page. Esc belongs to it, not to the board or the terminal below.
  function layerOpen() { return !!document.querySelector('.ao-dialog, .ao-cmdk'); }
  // A DS Dialog closes from its own keydown listener and React removes it before window bubble listeners run.
  // So record the layer state in window capture and decide in the bubble phase with escTaken(e).
  var escLayer = false;
  // The palette opens above a dialog (office.css), so one Esc closes the palette only: the event stops here,
  // before the dialog's own document listener, and the palette closes through its overlay.
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    escLayer = layerOpen();
    var pal = document.querySelector('.ao-cmdk-o');
    if (pal && document.querySelector('.ao-dialog')) {
      e.stopPropagation();
      pal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  }, true);
  function escTaken(e) { return e.defaultPrevented || escLayer || layerOpen(); }
  function none() { return null; }
  function empty() { return []; }

  // Short names for tools on the board come from the shared vocabulary (vocab.js).
  function toolWord(name) { return window.OfficeVocab.toolShort(name); }
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
      sessions: ss.map(function (s) { return { name: s.name, status: window.OfficeVocab.status(s).key, task: s.prompt || '' }; }),
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
  function statsFrom(info) { return window.OfficeVocab.figures(info.sessions || []); }
  function fmtTokens(n) { n = +n || 0; return n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1e6).toFixed(1) + 'M'; }
  function fmtCost(c) { return window.OfficeFormat.money(+c || 0); }
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
  function paint(c, w, h, d, tok, f, look) {
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
    // pinned note from an agent: a paper card, so the text is dark in every theme (ink is light at night)
    if (d.pin) {
      c.font = '500 24px ' + sans;
      var pw = W2 - 88, lines = wrap(c, 'Note from ' + d.pin.by + ': ' + d.pin.text, pw);
      var msg = lines.slice(0, 2).map(function (l, i) { return clipW(c, i === 1 && lines.length > 2 ? l + '…' : l, pw); }), ch = 26 + msg.length * 30;
      // at night the composer blooms a lit white card and the text washes out: a shade darker keeps it sharp
      c.fillStyle = look === 'night' ? mix(col('bubble'), slate, 0.3) : col('bubble'); c.globalAlpha = 0.96; rr(c, X0, y, W2, ch, 12); c.fill(); c.globalAlpha = 1;
      c.fillStyle = col('status-error'); c.beginPath(); c.arc(X0 + 30, y + 30, 9, 0, 7); c.fill();
      c.fillStyle = mix(col('status-error'), col('bubble'), 0.55); c.beginPath(); c.arc(X0 + 27, y + 27, 3, 0, 7); c.fill();
      c.fillStyle = col('scene-dark'); c.font = '500 24px ' + sans;
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
    head('Browser steps', cols[0]); head('Last steps', cols[1]); head('Repository' + (d.tree && !d.tree.note ? ' · ' + d.tree.total + ' files' : ''), cols[2]);
    var empty = function (t, x) { c.font = '400 21px ' + sans; say(t, x, top + 32, dim); };
    var step = function (x, i, status, word, detail) {
      var yy = top + 32 + i * 31, cap = Math.round(cw * 0.55);
      dot(x + 8, yy + 13, status);
      c.font = '500 20px ' + mono; var ww = Math.min(cap, c.measureText(word).width);
      say(clipW(c, word, cap), x + 26, yy);
      c.font = '400 18px ' + mono; say(clipW(c, detail, cw - 26 - ww - 12), x + 26 + ww + 10, yy + 2, dim);
    };
    var st = function (c2) { return c2.ok === null ? 'working' : c2.ok ? 'finished' : 'error'; };
    if (!d.browser.length) empty('No browser steps yet', cols[0]);
    d.browser.slice(-rows).forEach(function (b, i) { step(cols[0], i, st(b), toolWord(b.name), b.detail || ''); });
    if (!d.recent.length) empty('No steps yet', cols[1]);
    d.recent.slice(-rows).forEach(function (b, i) { step(cols[1], i, st(b), toolWord(b.name), b.file || b.detail || ''); });
    var ents = d.tree ? d.tree.entries.filter(function (e) { return e.dir; }).slice(0, rows) : [];
    if (!ents.length) empty(d.tree ? d.tree.note || 'Only files at the top' : 'Loading', cols[2]);
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
  // The face is bubble in every theme, so the marker is scene-dark based: ink is light at night.
  function paintNotes(c, w, h, text, tok, f) {
    var col = function (k, fb) { return tok[k] || fb || '#888'; }, sans = f.sans || 'sans-serif';
    var metal = col('scene-metal'), face = col('bubble'), ink = mix(col('scene-dark'), col('status-finished'), 0.3);
    c.fillStyle = mix(metal, col('scene-dark'), 0.25); rr(c, 0, 0, w, h, 14); c.fill();
    c.fillStyle = mix(metal, col('bubble'), 0.4); rr(c, 3, 3, w - 6, h - 6, 12); c.fill();
    var g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, face); g.addColorStop(0.55, mix(face, col('scene-wall'), 0.35)); g.addColorStop(1, face);
    c.fillStyle = g; rr(c, 14, 14, w - 28, h - 28, 6); c.fill();
    // ghosts of old marker
    var rnd = seeded(11);
    c.strokeStyle = col('scene-dark'); c.lineCap = 'round'; c.lineWidth = 7;
    for (var i = 0; i < 4; i++) { var gx = 60 + rnd() * (w - 200), gy = 150 + rnd() * (h - 240); c.globalAlpha = 0.035; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + 40 + rnd() * 90, gy + rnd() * 16 - 8); c.stroke(); }
    c.globalAlpha = 1;
    c.textBaseline = 'top'; c.textAlign = 'left';
    c.fillStyle = ink; c.font = '700 40px ' + sans; c.fillText('Notes', 52, 42);
    c.strokeStyle = ink; c.lineWidth = 4; c.globalAlpha = 0.75; c.beginPath(); c.moveTo(52, 92);
    for (var x = 52; x < 230; x += 18) c.lineTo(x + 18, 92 + Math.sin(x * 0.09) * 2);
    c.stroke(); c.globalAlpha = 1;
    if (!String(text || '').trim()) { c.fillStyle = mix(col('scene-dark'), face, 0.4); c.font = '500 30px ' + sans; c.fillText('Click to write a reminder.', 52, 128); return; }
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
      ['Needs you', String(s.waiting), s.waiting ? 'status-waiting' : null],
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
  var HINT_W = 640, HINT_H = 140, HINT_FONT = 50;
  function hintTex(text, tok, f) {
    var cv = document.createElement('canvas'); cv.width = HINT_W; cv.height = HINT_H;
    var c = cv.getContext('2d'), sans = f.sans || 'sans-serif';
    c.fillStyle = tok.bubble || '#fff'; rr(c, 6, 10, 628, 116, 58); c.fill();
    c.strokeStyle = tok.accent || tok.emphasis || '#2f6fe4'; c.lineWidth = 6; rr(c, 6, 10, 628, 116, 58); c.stroke();
    c.fillStyle = tok['scene-dark'] || '#2b323b'; c.font = '600 ' + HINT_FONT + 'px ' + sans; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 320, 70);
    var t = new T.CanvasTexture(cv); t.encoding = T.sRGBEncoding; return t;
  }

  // Attach boards to a mounted office.
  // o: { room(roomId) -> info, tree(root) -> Promise, note(roomId) -> text, stats(roomId) -> numbers, pin(roomId) -> { text, by },
  //      onFocus(roomId, kind: 'board' | 'notes' | 'stats'), onBlur(), onDoor(roomId) }
  //   The returned object has open(roomId, kind) for the keyboard path (Ctrl+K), and OfficeBoard.layerOpen() for the Esc rule.
  function attach(office, o) {
    o = o || {};
    var ins0 = null;
    try { ins0 = office && office.inspect && office.inspect(); } catch (x) { ins0 = null; }
    var st = ins0 && ins0.stage;
    var ownHost = !o.host, host = o.host || H.attach(office);
    if (!st || !host) return { open: function () { return false; }, refresh: noop, blur: noop, focused: none, kind: none, flying: function () { return false; }, rect: none, dataOf: none, doorPulse: noop, rooms: empty, dispose: noop };
    var K = st.K;
    var boards = [];      // blackboards: { kind:'board', mesh, roomId, tex, canvas, ... }
    var notes = [];       // whiteboards: { kind:'notes', ... }
    var statsList = [];   // wall displays: { kind:'stats', ... }
    var doors = [];       // doors: { kind:'door', ... }
    var decorRooms = [];  // { rg, roomId, items, added, lamp, board } for each room group that has decor
    var pending = {};     // roomId -> { dir, at, t }: a door pulse that waits for its door (the floor is being rebuilt)
    var trees = {};       // root -> tree
    var focused = null, focusedKind = null, focusedMesh = null, saved = null, dead = false, after = null;
    var lastTok = K.tok, skinVersion = 0, repaint = false;

    function tk(k) { return K.tok[k]; }
    function themed(key, opt) { return K.t(key, opt); }
    // Where things are in the scene (shown floor, in the scene or not) is the scene host's to know.
    function inScene(m) { return host.inScene(m); }
    function shownFloor() { return host.shownFloor(); }
    function onShownFloor(m, fg) { return host.onShownFloor(m, fg); }
    function worldX(m) { return m.getWorldPosition(new T.Vector3()).x; }
    // The lamp light: no token names a lamp color, so take a warm tint from the tokens.
    function warm() { return new T.Color(tk('status-waiting')).lerp(new T.Color(tk('bubble')), 0.55); }
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
    function plantsOk() { var P = window.AgentOffice && window.AgentOffice.office && window.AgentOffice.office.Parts; return !!(P && P.plant); }
    function plantAt(rg, x, z, s) {
      if (!plantsOk()) return null;
      var g = new T.Group(); g.position.set(x, 0, z); window.AgentOffice.office.Parts.plant(K, g, 0, 0, s); noNav(g); rg.add(g);
      return g;
    }

    // ----- prune: drop what went with a floor rebuild, and free its GPU textures -----
    function drop(n) {
      if (n.tex) n.tex.dispose();
      (n.own || []).forEach(function (m) { m.dispose(); });
    }
    function prune() {
      function keep(n) { if (inScene(n.mesh)) return true; drop(n); return false; }
      // a door that swings while its floor is rebuilt: the new door takes the swing over
      doors.forEach(function (d) { if (d.pulse && !inScene(d.mesh)) pending[d.roomId] = { dir: d.pulse.dir, at: Date.now(), t: d.pulse.t }; });
      boards = boards.filter(keep); notes = notes.filter(keep); statsList = statsList.filter(keep); doors = doors.filter(keep);
      decorRooms = decorRooms.filter(function (r) { return inScene(r.rg); });
    }

    // ----- scan: find the shown floor's lab rooms and add the decor, once per room -----
    function scan() {
      prune();
      // the host matches the shown floor's room groups to the DS rooms by order
      host.rooms().forEach(function (x) { if (x.room.type === 'lab') decorate(x.rg, x.room.id); });
      // the item that is open now came back with the rebuild: follow it
      if (focused && focusedMesh && !inScene(focusedMesh)) {
        var it = allItems().filter(function (x) { return x.roomId === focused && x.kind === focusedKind; })[0];
        if (it) focusedMesh = it.mesh;
      }
      // a door pulse that came while its floor was being rebuilt
      Object.keys(pending).forEach(function (id) {
        var p = pending[id];
        if (Date.now() - p.at > 3000) { delete pending[id]; return; }
        var d = liveDoor(id);
        if (d) { delete pending[id]; startPulse(d, p.dir, p.t); }
      });
    }

    function decorate(rg, id) {
      var dec = decorRooms.filter(function (d) { return d.rg === rg; })[0];
      if (dec) {
        if (dec.roomId !== id) { dec.roomId = id; dec.items.forEach(function (x) { x.roomId = id; }); }
        return;
      }
      var m = rg.children.filter(isBoard)[0];
      if (!m) return;
      var added = [], items = [], raised = [];   // raised: [mesh, y, scale y] to put back on dispose
      // taller walls, and the room sign above the cable tray
      rg.children.forEach(function (c) {
        if (isWall(c) && !c.userData.tall) { raised.push([c, c.position.y, c.scale.y]); c.userData.tall = 1; c.scale.y = WALL_H / 5.2; c.position.y = WALL_H / 2; c.updateMatrix(); c.updateMatrixWorld(true); }
        if (isSign(c) && !c.userData.moved) { raised.push([c, c.position.y, c.scale.y]); c.userData.moved = 1; c.position.y = SIGN_Y; c.updateMatrix(); c.updateMatrixWorld(true); }
      });

      // the blackboard: the engine's board gets our picture (its own picture is freed)
      var t = newTex(1024, 640), mt = m.material;
      var orig = { map: mt.map, emissive: mt.emissive ? mt.emissive.clone() : null, emissiveMap: mt.emissiveMap, ei: mt.emissiveIntensity };
      if (orig.map && orig.map !== t.tex) orig.map.dispose();
      mt.map = t.tex; mt.emissive = new T.Color(0xffffff); mt.emissiveMap = t.tex; mt.emissiveIntensity = 0.55; mt.needsUpdate = true;
      var bd = { kind: 'board', mesh: m, roomId: id, tex: t.tex, canvas: t.canvas, sig: '', mat: mt, base: 0.55, hov: 0.85, g: 0, tgt: 0, hit: [m], hint: 'Open the overview', orig: orig };
      m.userData.item = bd; boards.push(bd); items.push(bd);
      // a chalk ledge under the blackboard, with two pieces of chalk
      var ledge = new T.Group(); ledge.position.set(m.position.x, m.position.y - 1.25 - 0.04, m.position.z + 0.1); rg.add(ledge); added.push(ledge);
      box(3.9, 0.07, 0.2, themed('scene-wood'), 0, 0, 0, ledge);
      box(0.22, 0.04, 0.05, themed('bubble'), -0.7, 0.055, 0.02, ledge);
      box(0.14, 0.04, 0.05, themed('bubble'), -0.35, 0.055, 0.0, ledge).rotation.y = 0.5;
      noNav(ledge);

      // the whiteboard left of the blackboard, on the same wall, clear of the engine's clock
      var wt = newTex(800, 560);
      var nm = plane(3.2, 2.24, wt.tex, 0.22, 'notes');
      nm.position.set(m.position.x - 3.9, m.position.y, m.position.z + 0.005);
      rg.add(nm); added.push(nm);
      var nd = { kind: 'notes', mesh: nm, roomId: id, tex: wt.tex, canvas: wt.canvas, sig: null, mat: nm.material, base: 0.22, hov: 0.5, g: 0, tgt: 0, hit: [nm], hint: 'Write notes', own: [nm.material] };
      nm.userData.item = nd; notes.push(nd); items.push(nd);
      // marker tray with two markers
      var tray = new T.Group(); tray.position.set(nm.position.x, nm.position.y - 1.12 - 0.045, nm.position.z + 0.1); rg.add(tray); added.push(tray);
      box(2.6, 0.07, 0.2, themed('scene-metal'), 0, 0, 0, tray);
      box(2.6, 0.1, 0.03, themed('scene-metal'), 0, 0.045, 0.085, tray);
      var m1 = cyl(0.045, 0.4, themed('status-finished'), -0.5, 0.1, 0.0, tray); m1.rotation.z = Math.PI / 2; m1.rotation.y = 0.12;
      var m2 = cyl(0.045, 0.4, themed('status-error'), -0.05, 0.1, 0.02, tray); m2.rotation.z = Math.PI / 2; m2.rotation.y = -0.08;
      [[-0.7, m1], [-0.25, m2]].forEach(function (p) { cyl(0.05, 0.1, themed('ink'), p[0], 0.1, p[1].position.z, tray).rotation.z = Math.PI / 2; });
      noNav(tray);

      // the left wall: stats display, door, lamp
      var bx = m.position.x, bz = m.position.z, leftX = bx - 8;   // the left wall's inner face (the blackboard stands 8 from it)
      var lw = new T.Group(); lw.position.set(leftX + 0.02, 0, 0); lw.rotation.y = Math.PI / 2; rg.add(lw); added.push(lw);   // local x runs along the wall, toward the back
      // stats display: above the front plant on a solid wall; under the rail of a 3-high glass divider
      var solid = rg.children.some(isSideWall);
      var sw = 1.5, sh = 1.95, s = newTex(520, Math.round(520 * sh / sw));
      var sm = plane(sw, sh, s.tex, 0.6, 'stats'); sm.position.set(-4.9, solid ? 2.7 : 1.95, 0.03); lw.add(sm);
      var sd = { kind: 'stats', mesh: sm, roomId: id, tex: s.tex, canvas: s.canvas, sig: null, mat: sm.material, base: 0.6, hov: 0.95, g: 0, tgt: 0, hit: [sm], hint: 'Room stats', own: [sm.material] };
      sm.userData.item = sd; statsList.push(sd); items.push(sd);
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
      // a still ring round the doorway: with reduced motion it says "someone came or left" in place of the swing and the glow
      var ringMat = new T.MeshBasicMaterial({ color: new T.Color(tk('status-working')) }), ring = new T.Group(); ring.visible = false; dg.add(ring);
      [[0, y0 + DH + 0.3, DW + 0.5, 0.08], [0, y0 - 0.02, DW + 0.5, 0.08]].forEach(function (r) { box(r[2], r[3], 0.04, ringMat, r[0], r[1], 0.12, ring).castShadow = false; });
      [-1, 1].forEach(function (sd) { box(0.08, DH + 0.4, 0.04, ringMat, sd * (DW / 2 + 0.21), y0 + DH / 2 + 0.14, 0.12, ring).castShadow = false; });
      // lamp: warm light between the door and the boards; it also glows when an agent comes or goes
      var lamp = st.lamp(rg, leftX + 2.4, 3.2, 1.2, warm().getHex(), 10);
      var dr = { kind: 'door', mesh: leaf, roomId: id, tex: sg.tex, canvas: sg.canvas, sig: null, mat: leafMat, base: 0, hov: 0.3, g: 0, tgt: 0, hit: hit, hint: 'Add or remove agents',
        pivot: pivot, inner: inner, sign: sgm, lamp: lamp, lampBase: null, pulse: null, open: 0, ring: ring, ringMat: ringMat, own: [inner.material, sgm.material, ringMat] };
      hit.forEach(function (x) { x.userData.item = dr; });
      doors.push(dr); items.push(dr);
      lw.updateMatrixWorld(true);
      // plants: the back-left corner, and right of the blackboard
      [plantAt(rg, leftX + 0.55, bz + 0.6, 0.9), plantAt(rg, bx + 2.45, bz + 0.55, 0.75)].forEach(function (g) { if (g) added.push(g); });
      decorRooms.push({ rg: rg, roomId: id, items: items, added: added, lamp: lamp, board: bd, raised: raised });
      repaint = true;
    }
    function allItems() { return boards.concat(notes, statsList, doors); }
    function liveDoor(id) { return doors.filter(function (x) { return x.roomId === id && inScene(x.mesh); })[0]; }

    function statsOf(roomId) {
      var s = o.stats ? o.stats(roomId) : null;
      return Object.assign(statsFrom((o.room && o.room(roomId)) || {}), s || {});
    }
    function skin() {   // colors that read tokens and are not themed by the engine
      doors.forEach(function (d) {
        d.mat.emissive.set(tk('status-waiting'));
        d.inner.material.color.set(tk('scene-dark')).multiplyScalar(0.45);
        // the engine set the lamps for the new theme: a swing in progress glows from the new level
        if (d.pulse) d.lampBase = d.lamp.intensity; else d.lamp.color.copy(warm());
      });
    }
    function dropHints() {
      Object.keys(hints).forEach(function (k) { hints[k].dispose(); });
      hints = {}; hintSize = null;
      if (hintSprite) { hintSprite.material.map = null; hintSprite.material.opacity = 0; hintSprite.visible = false; hintTarget = 0; }
      host.rehover();   // the next frame builds the hint again in the new colors
    }
    function refresh() {
      if (dead) return;
      var themeChanged = lastTok !== K.tok;
      if (themeChanged) { lastTok = K.tok; skinVersion++; dropHints(); }
      scan();
      if (themeChanged) skin();
      var now = Date.now();
      boards.forEach(function (bd) {
        var info = (o.room && o.room(bd.roomId)) || {};
        var root = info.place && info.place.root;
        if (root && !(root in trees) && o.tree) {
          // The server lists only worktrees of a known repository. A room outside git (building key '') has no list to ask for.
          if (!info.place.repo) trees[root] = { total: 0, entries: [], note: 'Not a git folder' };
          else {
            trees[root] = null;
            var pr = o.tree(root);
            if (pr && pr.then) pr.then(function (t) { trees[root] = t; refresh(); }, function () { trees[root] = { total: 0, entries: [], note: 'No file list' }; refresh(); });
          }
        }
        var d = boardData(info, root ? trees[root] : null, o.pin ? o.pin(bd.roomId) : null);
        var sig = skinVersion + K.look + JSON.stringify(d);
        if (sig === bd.sig) return;
        bd.sig = sig; bd.data = d;
        paint(bd.canvas.getContext('2d'), bd.canvas.width, bd.canvas.height, d, K.tok, K.f || {}, K.look);
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
      repaint = false;
    }

    // ----- the door: swing open and shut for an agent who comes in or leaves -----
    var OPEN_ANGLE = 1.25;
    function startPulse(d, dir, t0) {
      var p = d.pulse;
      if (p) {
        if (p.t > p.D + p.H) p.t = p.D * (1 - (p.t - p.D - p.H) / p.D);   // closing: open again from where the leaf is now
        else p.t = Math.min(p.t, p.D);   // opening or open: hold it open a little longer
        p.dir = dir;
      } else {
        var D = cssNum('duration-camera', 600);
        d.pulse = { t: t0 || 0, dir: dir, D: D, H: D * 1.6 }; d.lampBase = d.lamp.intensity;
      }
      var c = new T.Color(tk(dir === 'out' ? 'status-waiting' : 'status-working'));
      d.inner.material.emissive.copy(c); d.lamp.color.copy(c); d.ringMat.color.copy(c);
    }
    // The engine rebuilds the floor when a bot joins or leaves, so scan first and swing the new door.
    // No door yet (the floor is hidden or still being built): the swing waits up to 3 s for it.
    function doorPulse(roomId, dir) {
      if (dead) return;
      dir = dir === 'out' ? 'out' : 'in';
      try { scan(); } catch (x) { /* the door may still be found */ }
      var d = liveDoor(roomId);
      if (d) startPulse(d, dir, 0);
      else pending[roomId] = { dir: dir, at: Date.now(), t: 0 };
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
          else { d.pulse = null; a = 0; d.lamp.intensity = d.lampBase; d.lamp.color.copy(warm()); }
        }
        if (p || d.open !== 0) {
          d.open = a;
          var m = st.rm ? 0 : a;   // reduced motion: the door stays shut and nothing glows or pulses
          d.pivot.rotation.y = -OPEN_ANGLE * m;
          d.inner.material.emissiveIntensity = 0.9 * m;
          d.sign.material.emissiveIntensity = 0.85 + 0.5 * m;
          if (d.pulse) d.lamp.intensity = d.lampBase + 2.2 * m;
        }
        d.ring.visible = !!d.pulse && !!st.rm;
      });
    }

    // ----- hover: glow, pointer cursor and a hint pill -----
    var cv = host.canvas;
    var hints = {}, hintSprite = null, hintTarget = 0, hintPoint = null, hovered = null, hintSize = null;
    function hintFor(text) {
      if (!hints[text]) hints[text] = hintTex(text, K.tok, K.f || {});
      return hints[text];
    }
    // The pill has a fixed size on screen: the DS title size, a small gap above the pointer.
    function placeHint() {
      if (!hintSprite || !hintPoint) return;
      var wpp = (st.cam.top - st.cam.bottom) / (st.cam.zoom || 1) / (cv.clientHeight || 1);   // world units per CSS pixel
      if (!hintSize) hintSize = { px: cssNum('type-title-size', 14) * HINT_H / HINT_FONT, gap: cssNum('space-2', 8) };   // read once per theme, not per frame
      var hpx = hintSize.px, gap = hintSize.gap;
      hintSprite.scale.set(hpx * HINT_W / HINT_H * wpp, hpx * wpp, 1);
      var up = new T.Vector3(0, 1, 0).applyQuaternion(st.cam.quaternion);
      hintSprite.position.copy(hintPoint).addScaledVector(up, (hpx / 2 + gap) * wpp);
    }
    function setHint(item, point) {
      if (!hintSprite) {
        hintSprite = new T.Sprite(new T.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
        hintSprite.renderOrder = 1000; hintSprite.userData.noNav = 1; hintSprite.visible = false;
        // the engine's UI layer, like its own labels: drawn after bloom and fog
        hintSprite.layers.set(1); hintSprite.material.fog = false; hintSprite.material.toneMapped = false;
        st.scene.add(hintSprite);
      }
      if (!item) { hintTarget = 0; return; }
      var tex = hintFor(item.hint);
      if (hintSprite.material.map !== tex) { hintSprite.material.map = tex; hintSprite.material.needsUpdate = true; }
      hintPoint = point.clone();
      placeHint();
      hintTarget = 1;
    }
    // The host picks: one raycast over the boards, the terminals and anything else registered, one winner,
    // and it owns the pointer cursor. This file only paints the glow and the hint.
    function clearHover() { hovered = null; allItems().forEach(function (it) { it.tgt = 0; }); setHint(null); }
    function onHover(item, hit) {
      if (!item) { clearHover(); return; }
      hovered = item;
      allItems().forEach(function (it) { it.tgt = it === hovered ? 1 : 0; });
      setHint(hovered, hit.point);
    }
    function onLeave() { clearHover(); host.leave(); }
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
        hintSprite.visible = hintSprite.material.opacity > 0 && !!hintSprite.material.map;
        if (hintSprite.visible) placeHint();   // the zoom can change under a still pointer
      }
    }

    // ----- camera: fly to face the board, and back -----
    var fly = null;
    function stepFly(dt) {
      if (!fly) return;
      fly.t = Math.min(1, fly.t + dt * 1000 / fly.ms);
      var e = easeInOut(fly.t), tg = st.ctl ? st.ctl.target : st.target;
      st.cam.position.lerpVectors(fly.p0, fly.p1, e);
      tg.lerpVectors(fly.t0, fly.t1, e);
      st.cam.zoom = fly.z0 + (fly.z1 - fly.z0) * e; st.cam.updateProjectionMatrix();
      if (fly.t >= 1) { var done = fly.done; fly = null; if (done) done(); }
    }
    // Per frame, before the engine draws. The host tells us when the scene was rebuilt (a bot joins or leaves,
    // the floor or view changes, a theme change): scan and paint now, so the decor is in this frame.
    var offRebuild = host.onRebuild(function () { try { refresh(); } catch (x) { repaint = false; /* the timer tries again */ } });
    function frame(dt) {
      if (dead) return;
      try { if (repaint || K.tok !== lastTok) refresh(); } catch (x) { repaint = false; }
      try {
        if (focused && st.goal) st.goal = null;   // the engine must not reframe while a board is open
        glowStep(dt);
        stepDoors(dt);
        stepFly(dt);
      } catch (x) { /* one bad frame must not stop the office */ }
    }
    var offFrame = host.frame(frame);
    function flyTo(p1, t1, z1, done) {
      var tg = st.ctl ? st.ctl.target : st.target;
      var ms = st.rm ? 1 : cssNum('duration-camera', 600) * 1.4;
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
      flyTo(p1, c, z1, landed);
      if (o.onFocus) o.onFocus(bd.roomId, focusedKind);
    }
    function blur() {
      if (!focused || !saved) return;
      focused = null; focusedKind = null; focusedMesh = null;
      if (st.ctl) st.ctl.enabled = false;
      flyTo(saved.p, saved.t, saved.z, landed);
      if (o.onBlur) o.onBlur();
    }
    // A flight ended. The camera is the user's again; a request that came during the flight runs now.
    function landed() {
      if (st.ctl) st.ctl.enabled = true;
      if (!after || dead) return;
      var a = after; after = null;
      open(a[0], a[1]);
    }
    // Open one tool of a room without the pointer: kind is 'board', 'notes' or 'stats' (the camera flies there),
    // or 'door' (the agents of the room). It works on the shown floor. While another board is open or a flight is
    // on, it waits for the camera to come back and then flies to the new one. Returns false when the room has no such tool.
    function open(roomId, kind) {
      if (dead) return false;
      try { scan(); } catch (x) { /* the lists are still good */ }
      if (kind === 'door') { if (!liveDoor(roomId)) return false; if (o.onDoor) o.onDoor(roomId); return true; }
      var fg = shownFloor();
      var it = allItems().filter(function (x) { return x.roomId === roomId && x.kind === kind && x.kind !== 'door' && onShownFloor(x.mesh, fg); })[0];
      if (!it) return false;
      if (focused || fly) { after = [roomId, kind]; if (focused && !fly) blur(); return true; }
      focus(it, kind);
      return true;
    }

    // Clicks come from the host (not drags, one winner). The open stats view has no page panel: a click on the scene closes it.
    function onClick(item) {
      if (item.kind === 'door') { if (o.onDoor) o.onDoor(item.roomId); return; }
      focus(item, item.kind);
    }
    function bypass() {
      if (focusedKind !== 'stats') return false;   // an open board or notes panel: the click goes on (a monitor still opens its terminal)
      if (!fly) blur();
      return true;                                 // the click closed the stats view and does nothing else
    }
    // Esc closes the top layer only: a dialog or the palette on top of the board takes it, the board stays.
    function onKey(e) { if (e.key === 'Escape' && focused && !escTaken(e)) { after = null; blur(); } }
    var offTarget = host.register({
      name: 'board',
      active: function () { return !focused && !fly && !dead; },
      meshes: function () { var m = []; allItems().forEach(function (it) { m = m.concat(it.hit); }); return m; },
      itemOf: function (mesh) { return mesh.userData.item || null; },
      hover: onHover, click: onClick, bypass: bypass,
      anchors: function () { return []; }
    });
    window.addEventListener('keydown', onKey);
    var timer = setInterval(function () {
      if (st.dead) { dispose(); return; }
      try { refresh(); } catch (x) { /* next time */ }
    }, 1500);
    try { refresh(); } catch (x) { /* the first frame tries again */ }

    // Remove the decor and give the engine's boards their own pictures back.
    function dispose() {
      if (dead) return;
      dead = true; clearInterval(timer);
      offFrame(); offRebuild(); offTarget();
      window.removeEventListener('keydown', onKey);
      host.leave();
      if (fly || focused) { fly = null; if (st.ctl) st.ctl.enabled = true; }
      if (hintSprite) { if (hintSprite.parent) hintSprite.parent.remove(hintSprite); hintSprite.material.dispose(); hintSprite = null; }
      Object.keys(hints).forEach(function (h) { hints[h].dispose(); }); hints = {};
      decorRooms.forEach(function (r) {
        r.added.forEach(function (x) { if (x.parent) x.parent.remove(x); });
        r.raised.forEach(function (q) { var c = q[0]; c.position.y = q[1]; c.scale.y = q[2]; delete c.userData.tall; delete c.userData.moved; c.updateMatrix(); c.updateMatrixWorld(true); });
        if (r.lamp) { if (r.lamp.parent) r.lamp.parent.remove(r.lamp); if (st.lamps) st.lamps = st.lamps.filter(function (l) { return l !== r.lamp; }); }
        var b = r.board, mt = b.mat, og = b.orig;
        mt.map = og.map; mt.emissiveMap = og.emissiveMap; mt.emissiveIntensity = og.ei; if (og.emissive) mt.emissive = og.emissive; mt.needsUpdate = true;
        delete b.mesh.userData.item;
      });
      allItems().forEach(drop);
      boards = []; notes = []; statsList = []; doors = []; decorRooms = []; pending = {};
      focused = null; focusedKind = null; focusedMesh = null; hovered = null;
      if (ownHost) host.dispose();
    }
    return {
      refresh: refresh, blur: function () { after = null; blur(); }, focused: function () { return focused; }, kind: function () { return focusedKind; },
      flying: function () { return !!fly; },
      open: open,
      doorPulse: doorPulse,
      // the decorated rooms of the shown floor, left to right; none in the building view
      rooms: function () {
        if (dead) return [];
        try { scan(); } catch (x) { /* the lists are still good */ }
        var fg = shownFloor(), list = boards.filter(function (b) { return onShownFloor(b.mesh, fg); });
        list.sort(function (a, b) { return worldX(a.mesh) - worldX(b.mesh); });
        return list.map(function (b) { return b.roomId; });
      },
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
      dataOf: function (roomId) { var b = boards.filter(function (x) { return x.roomId === roomId; })[0]; return b ? b.data : null; },
      dispose: dispose
    };
  }

  window.OfficeBoard = { attach: attach, layerOpen: layerOpen, escTaken: escTaken, data: boardData, toolWord: toolWord };
})();
