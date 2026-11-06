/* Agent Office for Claude Code x0.2: the desk terminals.
   Each bot's desk monitor shows that bot's Claude Code session as a terminal: the last prompt, the
   tool calls with their outcome, and the reply as it streams, with a blinking cursor. A desk with two
   monitors (the coder desk) shows the terminal on the left and the session's stats on the right
   (agent kind, model, context, spend, time, to-do list). A desk with one monitor shows a stats line at the bottom.
   In a dark theme (Night, Fluent Dark: stage.K.dark) a soft pool of screen light falls on the desk; it turns amber when the bot needs you and
   red after an error. A monitor is a pinned screen (#89): a click flies the camera to it, and once it lands the page lays
   the chat and the terminal of that session over the monitor (scene-host.js layer). open(uid) is the keyboard path.
   The engine builds the desks and walks the bots. This file only repaints the screens and adds the
   cursor and the light pool (decor, noNav). Colors and fonts come from the DS tokens (stage.K).
   Helpers (subagents) have no session of their own; their monitors show what the engine traced.

   window.OfficeTerminal
     attach(office, { session(botName) -> session or null, onOpen(uid, name), host? }) -> { refresh(), open(uid), dispose(), screens() }
       host: the scene host (scene-host.js). Without it, attach makes its own.
       open(uid): fly to the desk monitor of that session on the shown floor (the pinned screen); false when it is not there.
       onOpen: a click on the monitor in focus outside its layer, or host.open().
     lines(session, cols, rows?) -> [{ text, tone, mark?, ask? }]
       tone: 'prompt' | 'out' | 'tool' | 'ok' | 'err' | 'muted'. Without rows: the full transcript
       (for the page panel). With rows: what fits on a screen of that many rows, newest last.
       mark: on tool call lines, the outcome word that ends the text ('ok 2.1s', 'failed', '...').
       ask: on a permission question or an office_ask question (tone 'prompt').
     status(session) -> { key, word, live }   key is a DS status ('working', 'waiting', ...)
     toolName(name) -> the short tool name the terminal shows
     stats(session, kind) -> { rows: [[label, value, 'bar'?, pct?]], todos, done, note }: the stats monitor.
       kind: the agent kind as a word. With a to-do list the Agent row holds kind, model and mode. */
(function () {
  'use strict';
  var T = window.THREE, H = window.OfficeSceneHost;
  var DOT = ' \u00b7 ';

  // ---------- text: a session as terminal lines (no DOM, no canvas) ----------
  function str(v) { return v == null ? '' : String(v); }
  function spaces(n) { return n > 0 ? new Array(n + 1).join(' ') : ''; }
  function base(p) { return str(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  // Terminal text only: no color codes, no emoji, no control characters.
  function clean(t) {
    return str(t)
      .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
      .replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
      .replace(/[\u2705\u2713\u2714]/g, 'ok').replace(/[\u274c\u2716\u2717\u2718]/g, 'x')
      .replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')
      .replace(/[\u2600-\u27bf\ufe0f\u200d\u20e3]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }
  function oneLine(t) { return clean(t).replace(/\s+/g, ' ').trim(); }
  function clipCols(t, n) { t = str(t); if (n <= 0) return ''; return t.length > n ? (n > 3 ? t.slice(0, n - 3) + '...' : t.slice(0, n)) : t; }
  function more(t, n) { t = str(t).replace(/\s+$/, ''); return t.length + 4 <= n ? t + ' ...' : t.slice(0, Math.max(0, n - 3)) + '...'; }
  // Word wrap to a column count. first and rest are the prefixes of the first and the next rows;
  // the leading spaces of the text stay on every row. A word longer than a row breaks.
  function wrapCols(text, cols, first, rest) {
    first = first || ''; rest = rest == null ? first : rest;
    var lead = (str(text).match(/^ */) || [''])[0].slice(0, 12);
    var words = str(text).trim().split(/\s+/), out = [];
    var pre = rest + lead, line = first + lead, empty = true;
    if (pre.length > cols - 4) pre = '';
    if (line.length > cols - 4) line = first.length <= cols - 4 ? first : '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var sep = empty ? '' : ' ';
      if (line.length + sep.length + w.length <= cols) { line += sep + w; empty = false; continue; }
      if (!empty) { out.push(line); line = pre; empty = true; }
      while (line.length + w.length > cols) {
        var room = Math.max(1, cols - line.length);
        out.push(line + w.slice(0, room)); w = w.slice(room); line = pre;
      }
      if (w) { line += w; empty = false; }
    }
    if (!empty || !out.length) out.push(line);
    return out;
  }
  // Agents write Markdown. A terminal shows it as plain text: no marks, code indented.
  function md(text) {
    var out = [], fence = false;
    clean(text).split('\n').forEach(function (l) {
      if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
      if (fence) { out.push('  ' + l); return; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push(''); return; }
      out.push(l.replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^(\s*)>\s?/, '$1| ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*|__/g, '').replace(/`+/g, '')
        .replace(/^(\s*)[*+]\s+/, '$1- '));
    });
    return out;
  }
  // mcp__plugin_playwright_playwright__browser_click -> browser click; mcp__server__tool -> server tool
  function toolName(name) { return window.OfficeVocab.toolShort(str(name)); }
  function secs(ms) { ms = +ms || 0; return ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's' : Math.round(ms / 60000) + 'm'; }

  // The DS status of a session and the word the screen shows with its color.
  function status(s) { return window.OfficeVocab.status(s); }

  // Where the current turn starts. The snapshot has no time for a prompt, so the page remembers the
  // newest call or reply it saw before the turn count went up. A page opened mid-turn does not know it.
  var turnsSeen = {}, turnsKept = 0;
  function newest(s) {
    var m = 0;
    (s.calls || []).forEach(function (c) { if (c && +c.t > m) m = +c.t; });
    (s.replies || []).forEach(function (r) { if (r && +r.t > m) m = +r.t; });
    return m;
  }
  function turnStart(s) {
    if (!s) return null;
    if (s.promptAt) return +s.promptAt;
    if (!s.uid || s.pseudo) return null;
    var k = turnsSeen[s.uid], n = +s.turns || 0, m = newest(s);
    if (!k) {
      if (++turnsKept > 400) { turnsSeen = {}; turnsKept = 1; }
      turnsSeen[s.uid] = { turns: n, maxT: m, start: null };
      return null;
    }
    if (n > k.turns) k.start = k.maxT + 1;
    else if (n < k.turns) k.start = null;
    k.turns = n;
    if (m > k.maxT) k.maxT = m;
    return k.start;
  }

  // One tool call: "$ Bash git status" and its outcome at the end of the row.
  function callLines(c, cols, full) {
    var run = c.ok === null || c.ok === undefined, err = str(c.err);
    var stop = !run && !c.ok && /^stopped$/i.test(err);
    var mark = run ? '...' : c.ok ? (c.ms >= 1000 ? 'ok ' + secs(c.ms) : 'ok') : stop ? 'stopped' : 'failed';
    var tone = run ? 'tool' : c.ok ? 'ok' : stop ? 'muted' : 'err';
    var room = Math.max(4, cols - mark.length - 1);
    var body = clipCols('$ ' + toolName(c.name) + (c.detail ? ' ' + oneLine(c.detail) : ''), room);
    var out = [{ text: body + spaces(room - body.length) + ' ' + mark, tone: tone, mark: mark }];
    if (!run && !c.ok && !stop && err && !/^failed$/i.test(err)) {
      var el = wrapCols(oneLine(err), cols, '  ', '  ');
      (full ? el.slice(0, 4) : el.slice(0, 1)).forEach(function (t) { out.push({ text: t, tone: 'err' }); });
    }
    return out;
  }
  // The timeline of a session (#72): one line per tool call with its clock time, the time since the session began, how long it
  // ran and how it ended. OfficeFormat.timeline owns the rows, so Export carries the same times. Newest last, like the terminal.
  function timeline(s, cols) {
    cols = Math.max(12, Math.floor(+cols) || 80);
    if (!s) return [{ text: 'No session at this desk.', tone: 'muted' }];
    var F = window.OfficeFormat, rows = F.timeline((s.calls || []).filter(function (c) { return c && !c.agent; }), { start: s.startedAt });
    if (!rows.length) return [{ text: 'No tool calls yet.', tone: 'muted' }];
    var out = [{ text: clipCols('Time      After    Took      Call', cols), tone: 'muted' }];
    rows.forEach(function (r) {
      var lead = r.time + '  ' + pad(r.after, 7) + '  ' + pad(r.duration, 8) + '  ';
      var mark = r.state === 'failed' ? ' failed' : r.state === 'open' ? ' ...' : '';
      var room = Math.max(4, cols - lead.length - mark.length);
      var body = clipCols(oneLine(r.text), room);
      out.push({ text: lead + body + spaces(room - body.length) + mark, tone: r.state === 'failed' ? 'err' : r.state === 'open' ? 'tool' : 'ok' });
      if (r.state === 'failed' && r.err && !/^failed$/i.test(r.err)) wrapCols(oneLine(r.err), cols, '  ', '  ').slice(0, 2).forEach(function (t) { out.push({ text: t, tone: 'err' }); });
    });
    return out;
  }
  function pad(t, n) { t = String(t == null ? '' : t); return t + spaces(Math.max(0, n - t.length)); }
  function textLines(text, cols, full) {
    var out = [];
    md(text).forEach(function (p) {
      if (!p.trim()) { if (full && out.length && out[out.length - 1].text) out.push({ text: '', tone: 'out' }); return; }
      var lm = p.match(/^(\s*)([-*+]|\d+[.)])\s+/), hang = lm ? lm[0].length - lm[1].length : 0;
      wrapCols(p.replace(/\s+$/, ''), cols, '', spaces(Math.min(hang, 6))).forEach(function (t) { out.push({ text: t, tone: 'out' }); });
    });
    while (out.length && !out[out.length - 1].text) out.pop();
    return out;
  }
  function say(list, text, cols, tone, max, first, rest) {
    wrapCols(text, cols, first || '', rest == null ? '  ' : rest).slice(0, max || 3).forEach(function (t) { list.push({ text: t, tone: tone }); });
  }

  // The terminal lines of a session. cols: characters per row. rows: rows on the screen, or none for
  // the whole transcript. Calls of subagents show on their helpers, not here.
  function lines(s, cols, rows) {
    cols = Math.max(12, Math.floor(+cols) || 80);
    rows = Math.floor(+rows) || 0;
    var full = rows <= 0;
    if (!s) return [{ text: 'No session at this desk.', tone: 'muted' }];
    var start = turnStart(s), head = [], tail = [], before = [], after = [], blocks = [];
    var pr = oneLine(s.prompt);
    if (pr) {
      var pl = wrapCols(pr, cols, '> ', '  ');
      if (!full && pl.length > 2) pl = [pl[0], more(pl[1], cols)];
      pl.forEach(function (t) { head.push({ text: t, tone: 'prompt' }); });
    } else if (!(s.turns > 0) && s.status !== 'working') head.push({ text: 'No prompt yet.', tone: 'muted' });

    (s.calls || []).filter(function (c) { return c && !c.agent; }).slice(full ? -30 : -10).forEach(function (c, i) {
      blocks.push({ t: +c.t || 0, k: 1, i: i, lines: callLines(c, cols, full) });
    });
    (s.replies || []).slice(full ? -6 : -2).forEach(function (r, i) {
      var ls = textLines(r && r.text, cols, full);
      if (ls.length) blocks.push({ t: +(r && r.t) || 0, k: 0, i: i, lines: full ? ls.slice(-120) : ls, text: true });
    });
    blocks.sort(function (a, b) { return a.t - b.t || a.k - b.k || a.i - b.i; });
    if (s.live) { var lv = textLines(s.live, cols, full); if (lv.length) blocks.push({ t: Infinity, lines: lv, text: true }); }
    blocks.forEach(function (b) { (start != null && b.t < start ? before : after).push(b); });

    (s.pending || []).forEach(function (r) {
      wrapCols(oneLine('Allow ' + str(r.tool) + (r.detail ? ': ' + r.detail : '') + '?'), cols, '? ', '  ').slice(0, full ? 4 : 2)
        .forEach(function (t) { tail.push({ text: t, tone: 'prompt', ask: true }); });
      // The reason the agent gives for the request (#72), under it.
      if (r.reason) wrapCols(oneLine('Reason: ' + r.reason), cols, '  ', '  ').slice(0, full ? 3 : 1).forEach(function (t) { tail.push({ text: t, tone: 'prompt', ask: true }); });
    });
    (s.questions || []).forEach(function (q) {
      wrapCols(oneLine(q && q.text), cols, '? ', '  ').slice(0, full ? 6 : 2).forEach(function (t) { tail.push({ text: t, tone: 'prompt', ask: true }); });
    });
    if (s.error && s.error.text && s.status !== 'working') say(tail, oneLine(s.error.text), cols, 'err', full ? 4 : 2, '! ');
    if (s.status === 'starting') say(tail, 'The session is starting.', cols, 'muted');
    else if (s.status === 'ended') say(tail, 'The session is closed.', cols, 'muted');
    else if (!s.helper && !s.headless && s.status === 'idle') say(tail, 'This session replies in its own terminal.', cols, 'muted', 3, '', '');
    else if (!s.helper && s.headless && s.status === 'idle') tail.push({ text: '> ', tone: 'prompt' });

    var flat = function (bs) { var o = []; bs.forEach(function (b) { o = o.concat(b.lines); }); return o; };
    if (full) {
      var all = flat(before).concat(head, flat(after), tail);
      all = all.length > 400 ? all.slice(-400) : all;
      // An ungated agent (ADR 0001): the label stays at the top of the terminal view of the desk screen.
      var sup = window.OfficeVocab.supervision(s);
      return sup ? [{ text: sup, tone: 'muted' }].concat(all) : all;
    }
    // a screen: the label of an ungated agent (ADR 0001, whole, up to two lines) and the prompt on top, the questions at the
    // bottom, the newest steps between them
    var supLines = [];
    window.OfficeVocab.supervisionLines(window.OfficeVocab.supervision(s)).forEach(function (t) {
      wrapCols(t, cols, '', '  ').forEach(function (u) { supLines.push({ text: u, tone: 'muted' }); });
    });
    supLines = supLines.slice(0, rows > 6 ? 3 : 2);
    rows = Math.max(1, rows - supLines.length);
    tail = tail.slice(-Math.max(1, rows - 1));
    head = head.slice(0, Math.max(0, Math.min(head.length, rows - tail.length)));
    var avail = rows - head.length - tail.length, body = [];
    for (var j = after.length - 1; j >= 0 && avail > 0; j--) {
      var ls = after[j].lines;
      if (ls.length <= avail) { body = ls.concat(body); avail -= ls.length; }
      else { body = (after[j].text ? ls.slice(ls.length - avail) : ls.slice(0, avail)).concat(body); avail = 0; }
    }
    return supLines.concat(head, body, tail);
  }

  // ---------- stats ----------
  var MODES = { 'default': 'Default', plan: 'Plan only', acceptEdits: 'Accept edits', bypassPermissions: 'Bypass', auto: 'Auto' };
  function shortModel(m) {
    m = str(m).toLowerCase();
    if (!m) return '';
    var big = /\[1m\]/.test(m), x;
    m = m.replace(/\[1m\]/g, '').replace(/^(us\.)?anthropic\./, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    if ((x = m.match(/^([a-z]+)-(\d+)-(\d+)$/))) m = x[1] + ' ' + x[2] + '.' + x[3];
    else if ((x = m.match(/^([a-z]+)-(\d+)$/))) m = x[1] + ' ' + x[2];
    else m = m.replace(/-/g, ' ');
    return m + (big ? ' 1M' : '');
  }
  function ctxPct(s) { return s && s.ctxTokens && s.ctxWindow ? Math.min(100, Math.round(100 * s.ctxTokens / s.ctxWindow)) : null; }
  function fmtTok(n) { return window.OfficeFormat.tokens(n); }
  // A session's spend: "unknown" when its agent reports no cost (an ACP agent), never $0.00 (format.js cost).
  function money(c, unknown) { return window.OfficeFormat.cost(c, unknown); }
  function age(ms) { var m = Math.floor(Math.max(0, ms) / 60000); return m < 1 ? 'under 1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  function failedCalls(calls) { return calls.filter(function (c) { return c.ok === false && !/^stopped$/i.test(str(c.err)); }).length; }
  // The stats monitor's rows. kind: the agent kind as a word (vocab.js kindWord), '' when unknown.
  // With a to-do list the kind, model and mode share one Agent row, so the list keeps the lines it had before kinds.
  function statsOf(s, kind) {
    var S = { rows: [], todos: [], done: 0, note: '' };
    if (!s) { S.note = 'No session at this desk.'; return S; }
    var calls = (s.calls || []).filter(function (c) { return c && !c.agent; }), bad = failedCalls(calls);
    var tools = plural(calls.length, 'call', 'calls') + (bad ? DOT + bad + ' failed' : '');
    if (s.helper) {
      S.rows.push(['Kind', 'Subagent'], ['Task', oneLine(s.prompt) || '--'], ['Tools', tools]);
      return S;
    }
    var todos = (s.todos || []).filter(function (t) { return t && t.text; }), pct = ctxPct(s), u = s.usage || {};
    S.todos = todos.map(function (t) { return { text: oneLine(t.text), status: t.status }; });
    S.done = todos.filter(function (t) { return t.status === 'completed'; }).length;
    var model = (shortModel(s.model) || 'default') + (s.mode ? DOT + (MODES[s.mode] || s.mode) : '');
    var pre = kind ? kind + DOT : '';
    if (todos.length) S.rows.push(['Agent', pre + model]);
    else S.rows.push(['Agent', pre + (s.headless ? 'in the office' : 'in a terminal')], ['Model', model]);
    if (window.OfficeVocab.supervision(s)) S.rows.push(['Oversight', window.OfficeVocab.supervision(s)]);
    // A Paperclip run (#76): its role and the budget Paperclip keeps for the agent. The office sets no second limit on it.
    if (s.hq) S.rows.push(['Paperclip', s.hq.role + (s.hq.budget ? DOT + window.OfficeVocab.hq.budget(s.hq.budget) : '')]);
    S.rows.push(['Context', pct == null ? '--' : pct + '%', 'bar', pct]);
    if (!todos.length) S.rows.push(['Tokens', u.tokens ? fmtTok(u.tokens) + (u.input ? DOT + Math.round(100 * (u.cached || 0) / u.input) + '% cached' : '') : '--']);
    S.rows.push(['Spend', money(s.cost, s.costUnknown) + DOT + plural(+s.turns || 0, 'turn', 'turns')]);
    if (!todos.length) S.rows.push(['Time', age(Date.now() - (+s.startedAt || Date.now()))], ['Tools', tools]);
    return S;
  }
  // the agent kind of a session as a word, the one every list shows (vocab.js kindWord through the store)
  function kindOf(s) { var a = window.officeAdapter; return s && a && a.kindWord ? a.kindWord(s) : ''; }
  function footOf(s) {
    if (!s) return null;
    if (s.helper) return { left: 'Subagent', right: plural((s.calls || []).length, 'call', 'calls'), pct: null };
    var pct = ctxPct(s), right = [];
    if (pct != null) right.push('context ' + pct + '%');
    if (s.costUnknown || typeof s.cost === 'number') right.push(window.OfficeFormat.costLabel(s.cost, s.costUnknown));
    return { left: s.git && s.git.branch ? s.git.branch : base(s.cwd), right: right.join(DOT), pct: pct };
  }

  // ---------- painting (canvas 2D, token colors only) ----------
  // A token color with an alpha, for canvas gradients. Null when the token is not a plain color.
  function alpha(col, a) {
    var s = str(col).trim(), m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      var h = m[1].length < 6 ? m[1].split('').map(function (ch) { return ch + ch; }).join('') : m[1];
      return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + a + ')' : null;
  }
  function palette(K) {
    var t = K.tok || {};
    return {
      bg: t['scene-dark'], fg: t.bubble, ok: t['status-working'], wait: t['status-waiting'], err: t['status-error'],
      accent: t.accent, onAccent: t['on-accent'],
      st: function (k) { return t['status-' + k] || t['status-resting']; }
    };
  }
  function rr(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function fit(c, t, w) {
    t = str(t);
    if (w <= 0) return '';
    if (c.measureText(t).width <= w) return t;
    while (t.length > 1 && c.measureText(t + '...').width > w) t = t.slice(0, -1);
    return t + '...';
  }
  function ink(c, P, color, a) { c.fillStyle = color; c.globalAlpha = a; c.shadowColor = color; c.shadowBlur = P.glow; }
  function toneColor(p, tone) { return tone === 'prompt' || tone === 'ok' ? p.ok : tone === 'err' ? p.err : p.fg; }
  function toneAlpha(tone) { return tone === 'out' ? 0.82 : tone === 'muted' ? 0.5 : tone === 'tool' ? 0.95 : 1; }
  function meterColor(p, pct) { return pct >= 90 ? p.err : pct >= 70 ? p.wait : p.ok; }
  function meter(c, x, y, w, h, pct, p) {
    c.shadowBlur = 0;
    c.globalAlpha = 0.14; c.fillStyle = p.fg; rr(c, x, y, w, h, h / 2); c.fill();
    c.globalAlpha = 1; c.fillStyle = meterColor(p, pct); rr(c, x, y, Math.max(h, w * Math.min(100, pct) / 100), h, h / 2); c.fill();
  }

  // The glass: a deep ground from the screen token, darker at the edges, soft scan lines, and a faint
  // glow in the status color, like an old phosphor screen.
  function paintGround(c, W, H, p, key) {
    c.save();
    c.fillStyle = p.bg; c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'multiply';
    c.globalAlpha = 0.6; c.fillRect(0, 0, W, H);
    var v0 = alpha(p.bg, 0), v1 = alpha(p.bg, 1);
    if (v0 && v1) {
      var g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.sqrt(W * W + H * H) * 0.62);
      g.addColorStop(0, v0); g.addColorStop(1, v1);
      c.globalAlpha = 1; c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    c.globalAlpha = 0.22; c.fillStyle = p.bg;
    for (var y = 1; y < H; y += 3) c.fillRect(0, y, W, 1);
    c.globalCompositeOperation = 'source-over';
    var t0 = alpha(p.st(key), 0.12), t1 = alpha(p.st(key), 0);
    if (t0 && t1) {
      var g2 = c.createRadialGradient(W / 2, H * 0.55, 0, W / 2, H * 0.55, Math.max(W, H) * 0.65);
      g2.addColorStop(0, t0); g2.addColorStop(1, t1);
      c.globalAlpha = 1; c.fillStyle = g2; c.fillRect(0, 0, W, H);
    }
    c.restore();
  }
  // The title bar: the bot's name, the model, and the status as a word on its color.
  function paintHead(c, W, v, P, p) {
    var y0 = 10, hh = P.headH - 16, cy = y0 + hh / 2;
    c.save(); c.textBaseline = 'middle';
    c.globalAlpha = 0.08; c.fillStyle = p.fg; rr(c, 10, y0, W - 20, hh, 10); c.fill();
    c.globalAlpha = 1; c.font = P.small;
    var ph = Math.min(hh - 6, 26), pw = c.measureText(v.word).width + 22, px = W - 18 - pw;
    // The pill is the status color mixed 55% into bubble, the word is scene-dark on it (4.5:1 in every theme, #118).
    c.fillStyle = p.fg; rr(c, px, cy - ph / 2, pw, ph, ph / 2); c.fill();
    c.globalAlpha = 0.55; c.fillStyle = p.st(v.key); rr(c, px, cy - ph / 2, pw, ph, ph / 2); c.fill();
    c.globalAlpha = 1; c.fillStyle = p.bg; c.fillText(v.word, px + 11, cy + 1);
    var x = P.padX + 4, room = px - x - 14;
    c.font = P.head; ink(c, P, p.fg, 1);
    var nm = fit(c, v.name, room);
    c.fillText(nm, x, cy + 1);
    var nw = c.measureText(nm).width;
    if (v.sub && room - nw > 48) { c.font = P.small; ink(c, P, p.fg, 0.55); c.fillText(fit(c, v.sub, room - nw - 14), x + nw + 14, cy + 1); }
    c.restore();
  }
  // The rows. Returns where the cursor goes, in canvas pixels.
  function paintLines(c, v, P, p) {
    var L = v.lines || [], n = Math.min(L.length, P.rows), i;
    c.save(); c.font = P.mono; c.textBaseline = 'middle';
    for (i = 0; i < n; i++) {
      var ln = L[i], y = P.top + i * P.rowH + P.rowH / 2, x = P.padX;
      if (ln.mark) {
        var cut = Math.max(0, ln.text.length - ln.mark.length), body = ln.text.slice(0, cut).replace(/\s+$/, ''), dim = ln.tone === 'muted';
        ink(c, P, p.ok, dim ? 0.5 : 1); c.fillText(body.charAt(0), x, y);
        ink(c, P, p.fg, dim ? 0.5 : 0.94); c.fillText(body.slice(1), x + P.cw, y);
        ink(c, P, ln.tone === 'ok' ? p.ok : ln.tone === 'err' ? p.err : p.fg, ln.tone === 'ok' || ln.tone === 'err' ? 1 : 0.55);
        c.fillText(ln.mark, x + cut * P.cw, y);
      } else {
        ink(c, P, ln.ask ? p.wait : toneColor(p, ln.tone), toneAlpha(ln.tone));
        c.fillText(ln.text, x, y);
      }
    }
    c.restore();
    if (!v.live) return null;
    var li = n - 1, col = 0;
    if (li < 0) li = 0;
    else if (L[li].mark) li++;
    else col = L[li].text === '> ' ? 2 : L[li].text.replace(/\s+$/, '').length + 1;
    if (col >= P.cols) { li++; col = 0; }
    if (li >= P.rows) { li = P.rows - 1; col = P.cols - 1; }
    return { x: P.padX + col * P.cw, y: P.top + li * P.rowH + (P.rowH - P.curH) / 2, w: P.cw * 0.9, h: P.curH };
  }
  function paintFoot(c, W, H, v, P, p) {
    var f = v.foot;
    if (!f || !P.footH) return;
    var y = H - P.footH / 2 - 4;
    c.save();
    c.globalAlpha = 0.1; c.fillStyle = p.fg; c.fillRect(P.padX, H - P.footH - 2, W - 2 * P.padX, 1);
    c.font = P.small; c.textBaseline = 'middle'; c.globalAlpha = 0.55;
    var rw = f.right ? c.measureText(f.right).width : 0;
    if (f.right) { c.textAlign = 'right'; c.fillText(f.right, W - P.padX, y); c.textAlign = 'left'; }
    if (f.left) c.fillText(fit(c, f.left, W - 2 * P.padX - rw - 16), P.padX, y);
    if (f.pct != null) meter(c, P.padX, H - 8, W - 2 * P.padX, 3, f.pct, p);
    c.restore();
  }
  function paintStats(c, W, v, P, p) {
    var S = v.stats || { rows: [], todos: [] }, y = P.top, lx = P.padX, vx = P.padX + P.cw * 9, left = P.rows, i;
    var row = function () { var cy = y + P.rowH / 2; y += P.rowH; left--; return cy; };
    c.save(); c.font = P.mono; c.textBaseline = 'middle';
    for (i = 0; i < S.rows.length && left > 0; i++) {
      var r = S.rows[i], cy = row();
      ink(c, P, p.fg, 0.5); c.fillText(r[0], lx, cy);
      if (r[2] === 'bar') {
        var bw = Math.max(40, W - P.padX - vx - P.cw * 5 - 10);
        if (r[3] != null) meter(c, vx, cy - 5, bw, 10, r[3], p);
        else { c.globalAlpha = 0.14; c.fillStyle = p.fg; rr(c, vx, cy - 5, bw, 10, 5); c.fill(); }
        ink(c, P, r[3] != null ? meterColor(p, r[3]) : p.fg, r[3] != null ? 1 : 0.5); c.fillText(r[1], vx + bw + 10, cy);
      } else { ink(c, P, p.fg, 0.92); c.fillText(fit(c, r[1], W - P.padX - vx), vx, cy); }
    }
    var td = S.todos || [];
    if (td.length && left > 1) {
      ink(c, P, p.fg, 0.5); c.fillText('To do  ' + S.done + ' / ' + td.length, lx, row());
      // keep the step that runs now in view
      var at = -1;
      for (i = 0; i < td.length && at < 0; i++) if (td[i].status === 'in_progress') at = i;
      for (i = 0; i < td.length && at < 0; i++) if (td[i].status !== 'completed') at = i;
      var from = at < 0 ? Math.max(0, td.length - left) : Math.max(0, Math.min(at - 1, td.length - left));
      for (i = from; i < td.length && left > 0; i++) {
        var t = td[i], box = t.status === 'completed' ? '[x] ' : t.status === 'in_progress' ? '[>] ' : '[ ] ';
        ink(c, P, t.status === 'in_progress' ? p.ok : p.fg, t.status === 'completed' ? 0.45 : t.status === 'in_progress' ? 1 : 0.85);
        c.fillText(clipCols(box + t.text, P.cols), lx, row());
      }
    } else if (S.note && left > 0) { ink(c, P, p.fg, 0.5); c.fillText(clipCols(S.note, P.cols), lx, row()); }
    c.restore();
  }
  // Hover: a focus ring in the action color and a badge that says what a click does (look closer, or open).
  function paintHover(c, W, H, P, p, label) {
    c.save();
    c.strokeStyle = p.accent; c.lineWidth = 6; rr(c, 5, 5, W - 10, H - 10, 15); c.stroke();
    c.font = P.small; c.textBaseline = 'middle';
    var bh = 30, bw = c.measureText(label).width + 28, bx = W - 16 - bw, by = H - (P.footH || 0) - bh - 12;
    c.fillStyle = p.accent; rr(c, bx, by, bw, bh, bh / 2); c.fill();
    c.fillStyle = p.onAccent; c.fillText(label, bx + 14, by + bh / 2 + 1);
    c.restore();
  }
  function paintScreen(c, W, H, v, P, p) {
    var cur = null;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.shadowBlur = 0;
    c.clearRect(0, 0, W, H);
    c.save();
    rr(c, 2, 2, W - 4, H - 4, 18); c.clip();   // rounded glass; the corners stay dark
    paintGround(c, W, H, p, v.key);
    paintHead(c, W, v, P, p);
    if (v.k === 'term') { cur = paintLines(c, v, P, p); paintFoot(c, W, H, v, P, p); }
    else paintStats(c, W, v, P, p);
    if (v.hover) paintHover(c, W, H, P, p, v.hover);
    c.restore();
    return cur;
  }

  // ---------- the desks ----------
  var NOOP = { refresh: function () {}, dispose: function () {}, screens: function () { return []; } };
  function attach(office, o) {
    o = o || {};
    var st = null;
    try { var ins0 = office && office.inspect && office.inspect(); st = ins0 && ins0.stage; } catch (x) { st = null; }
    if (!T || !H || !st || !st.scene || !st.K || !st.r || !st.cam || !st.anim) return NOOP;
    var ownHost = !o.host, host = o.host || H.attach(office);
    if (!host) return NOOP;
    var K = st.K;
    var sessionOf = typeof o.session === 'function' ? o.session
      : function (n) { var a = window.officeAdapter; return a && a.session ? a.session(n) : null; };
    var self = { dead: false };
    var entries = [];   // one per patched screen: { mesh, bot, name, kind, canvas, ctx, tex, P, sig, uid, cursor, glow, ... }
    var lastTok = K.tok, lastLook = K.look, themeN = 0, acc = 0;
    var hover = null, glowTex = null;
    var realByName = {};   // the last real session of each bot, so a floor rebuild keeps a closed desk right
    var dray = new T.Raycaster(), DOWN = new T.Vector3(0, -1, 0);
    var maxAniso = 4;
    try { maxAniso = Math.min(8, st.r.capabilities.getMaxAnisotropy()) || 4; } catch (x) { maxAniso = 4; }

    function inspect() { try { return office.inspect(); } catch (x) { return null; } }
    // Where things are in the scene is the scene host's to know.
    function inScene(m) { return host.inScene(m); }
    function shown(m) { return host.shown(m); }
    function rootOf(m) { return host.floorOf(m); }
    function owned(m) { var e = m.userData.officeTerm; return !!(e && e.owner && !e.owner.dead); }

    // Each screen of a bot comes from the engine's own list (bot.screens, set when it builds the desk).
    // Without that list: the screens nearest the bot's seat, in front of it.
    function nearScreens(b) {
      var out = [], v = new T.Vector3();
      if (!b.seat) return out;
      (K.screens || []).forEach(function (x) {
        var m = x && x[0];
        if (!m || !m.isMesh || owned(m) || !inScene(m)) return;
        var root = rootOf(m);
        m.getWorldPosition(v);
        if (root) root.worldToLocal(v);
        if (Math.sqrt((v.x - b.seat.x) * (v.x - b.seat.x) + (v.z - b.seat.z) * (v.z - b.seat.z)) < 2.3 && v.z < b.seat.z) out.push({ m: m, x: v.x });
      });
      return out.sort(function (a, c) { return a.x - c.x; }).map(function (a) { return a.m; });
    }

    // What a helper (subagent) or a closed session shows: the engine's trace of the bot.
    function pseudo(b) {
      if (!b) return null;
      var tr = [];
      try { tr = office.traceOf ? office.traceOf(b.name) || [] : []; } catch (x) { tr = []; }
      var calls = [];
      tr.forEach(function (x, i) {
        if (!x || x.type !== 'tool.call' || !x.call) return;
        var c = x.call, a = c.args || {}, k = Object.keys(a)[0];
        calls.push({ id: c.id, name: c.tool, detail: k ? str(a[k]) : '', ok: x.state === 'run' ? null : c.ok !== false, ms: c.ms, err: c.ok === false ? (c.summary || 'Failed') : null, t: i + 1 });
      });
      var es = b.status;
      return { pseudo: true, helper: true, name: b.name, status: es === 'working' ? 'working' : 'idle', pending: [], questions: es === 'waiting' ? [{ id: 'step', text: b.task || 'This step needs you.' }] : [], turns: es === 'finished' ? 1 : 0,
        prompt: b.task || '', calls: calls.slice(-30), replies: [], error: es === 'error' ? { text: b.task || 'The step failed.' } : null };
    }
    function sessionFor(e) {
      var s = null;
      try { s = sessionOf(e.name); } catch (x) { s = null; }
      if (s) { realByName[e.name] = s; return s; }
      var lr = realByName[e.name];
      if (lr) return Object.assign({}, lr, { status: 'ended', live: '', pending: [], questions: [] });
      return pseudo(e.bot);
    }

    function measure(e) {
      var f = K.f || {}, sub = K.look === 'sublevel', fam = sub && f.term ? f.term : (f.mono || 'monospace'), px = sub ? 27 : 20;
      var P = {
        px: px, padX: 18, headH: 50,
        mono: (sub ? '400 ' : '500 ') + px + 'px ' + fam,
        head: sub ? '400 ' + (px + 3) + 'px ' + fam : '600 21px ' + (f.sans || 'sans-serif'),
        small: sub ? '400 21px ' + fam : '600 15px ' + (f.sans || 'sans-serif'),
        rowH: Math.round(px * (sub ? 1.05 : 1.3)),
        glow: K.dark ? 7 : sub ? 5 : 0
      };
      e.ctx.font = P.mono;
      P.cw = e.ctx.measureText('0').width || px * 0.6;
      P.curH = Math.round(px * (sub ? 0.8 : 1.05));
      P.top = P.headH + 4;
      P.footH = e.kind === 'term' && e.footer ? 30 : 0;
      P.rows = Math.max(3, Math.floor((e.H - P.top - P.footH - 6) / P.rowH));
      P.cols = Math.max(12, Math.floor((e.W - 2 * P.padX) / P.cw));
      e.P = P;
    }
    function viewOf(e, s, info) {
      var v = { k: e.kind, name: e.name, word: info.word, key: info.key, live: info.live, hover: e.hover && e.uid ? e.hover : '', look: K.look, th: themeN };
      if (e.kind === 'term') {
        v.sub = s && s.helper ? 'subagent' : [shortModel(s && s.model), window.OfficeVocab.supervisionHead(window.OfficeVocab.supervision(s))].filter(Boolean).join(DOT);
        v.lines = lines(s, e.P.cols, e.P.rows);
        if (e.footer) v.foot = footOf(s);
      } else { v.sub = 'Stats'; v.stats = statsOf(s, kindOf(s)); }
      return v;
    }
    // The blinking cursor: a small plane on the glass, so blinking costs no repaint.
    function addCursor(e) {
      var cm = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ color: new T.Color(K.tok['status-working']), transparent: true, opacity: 0.9, depthWrite: false }));
      cm.visible = false; cm.renderOrder = 3; cm.castShadow = false; cm.receiveShadow = false;
      cm.userData.noNav = 1; cm.userData.officeTermDecor = 1;
      e.mesh.add(cm); e.cursor = cm;
    }
    function placeCursor(e, cur, info) {
      var g = e.mesh.geometry && e.mesh.geometry.parameters;
      if (!e.cursor || !cur || !g || !info.live) { e.curOn = false; return; }
      e.cursor.scale.set(Math.max(1e-3, cur.w / e.W * g.width), Math.max(1e-3, cur.h / e.H * g.height), 1);
      e.cursor.position.set(((cur.x + cur.w / 2) / e.W - 0.5) * g.width, (0.5 - (cur.y + cur.h / 2) / e.H) * g.height, 0.004);
      e.cursor.material.color.set(K.tok[info.key === 'waiting' ? 'status-waiting' : info.key === 'error' ? 'status-error' : 'status-working']);
      e.curOn = true;
    }
    // Screen light on the desk in a dark theme: one soft pool per desk, laid on the desk top under the screens.
    function glowTexture() {
      if (glowTex) return glowTex;
      var c = document.createElement('canvas'); c.width = c.height = 128;
      var x = c.getContext('2d');
      x.fillStyle = K.tok.bubble;
      for (var i = 0; i < 24; i++) { x.globalAlpha = 0.045; x.beginPath(); x.arc(64, 64, 63 * (1 - i / 24), 0, Math.PI * 2); x.fill(); }
      glowTex = new T.CanvasTexture(c); glowTex.encoding = T.sRGBEncoding;
      return glowTex;
    }
    function addGlow(e, screens) {
      try {
        var root = rootOf(e.mesh);
        if (!root) return;
        var c = new T.Vector3(), n = new T.Vector3(), tmp = new T.Vector3(), wsum = 0, count = 0;
        screens.forEach(function (m) {
          m.updateWorldMatrix(true, false);
          c.add(m.getWorldPosition(tmp));
          n.add(new T.Vector3(0, 0, 1).transformDirection(m.matrixWorld));
          wsum += m.geometry.parameters.width; count++;
        });
        if (!count) return;
        c.divideScalar(count); n.y = 0;
        if (n.lengthSq() < 1e-6) return;
        n.normalize();
        var p = c.clone().addScaledVector(n, 0.34), hit = null;
        dray.set(p, DOWN); dray.near = 0; dray.far = 1.8; dray.camera = st.cam;
        var hits = dray.intersectObject(root, true);
        for (var i = 0; i < hits.length && !hit; i++) {
          var ob = hits[i].object;
          if (!ob.isMesh || ob.userData.officeTerm || ob.userData.officeTermDecor || ob.userData.bot || screens.indexOf(ob) >= 0) continue;
          if (ob.material && ob.material.transparent) continue;
          hit = hits[i];
        }
        if (!hit || hit.point.y < 0.5 || c.y - hit.point.y < 0.08) return;
        var gm = new T.Mesh(new T.PlaneGeometry(Math.max(1.1, wsum + 0.3), 0.8),
          new T.MeshBasicMaterial({ map: glowTexture(), color: new T.Color(K.tok.bubble), transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
        gm.rotation.set(-Math.PI / 2, Math.atan2(n.x, n.z), 0, 'YXZ');
        var wp = new T.Vector3(p.x, hit.point.y + 0.012, p.z);
        root.worldToLocal(wp); gm.position.copy(wp);
        gm.userData.noNav = 1; gm.userData.officeTermDecor = 1;
        gm.castShadow = false; gm.receiveShadow = false; gm.renderOrder = 2; gm.visible = false;
        root.add(gm); e.glow = gm;
      } catch (x) { e.glow = null; }
    }

    function patch(m, b, i, ss) {
      var g = m.geometry.parameters;
      if (!(g.width > 0 && g.height > 0)) return;
      var H = 320, W = Math.max(256, Math.min(1024, Math.round(H * g.width / g.height / 4) * 4));
      var canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var tex = new T.CanvasTexture(canvas); tex.encoding = T.sRGBEncoding; tex.anisotropy = maxAniso;
      // hover: '' or the badge text while the pointer is on the screen
      var e = { owner: self, mesh: m, bot: b, name: b.name, kind: ss.length > 1 && i === 1 ? 'stats' : 'term', footer: ss.length < 2,
        canvas: canvas, ctx: ctx, tex: tex, W: W, H: H, P: null, sig: '', uid: null, hover: '', cursor: null, curOn: false,
        glow: null, glowA: 0, em: new T.Color(K.tok.bubble), emI: 0.95, hook: null };
      // The engine tints each screen in the bot's status color every frame. A terminal needs its own
      // colors, so the screen's light is set again right before it draws.
      e.hook = function () {
        var mt = this.material;
        if (self.dead || !mt || !mt.emissive) return;
        mt.emissive.copy(e.em); mt.emissiveIntensity = e.emI * (e.hover ? 1.3 : 1);
      };
      m.userData.officeTerm = e;
      m.material.map = tex; m.material.emissiveMap = tex; m.material.needsUpdate = true;
      m.onBeforeRender = e.hook;
      if (e.kind === 'term') addCursor(e);
      if (i === 0) addGlow(e, ss);
      entries.push(e);
      measure(e);
      paint(e, true);
    }
    function drop(e) {
      if (hover === e) { hover = null; host.rehover(); }
      try {
        if (e.mesh.onBeforeRender === e.hook) delete e.mesh.onBeforeRender;
        if (e.mesh.userData.officeTerm === e) e.mesh.userData.officeTerm = null;
        e.tex.dispose();
        if (e.cursor) { if (e.cursor.parent) e.cursor.parent.remove(e.cursor); e.cursor.geometry.dispose(); e.cursor.material.dispose(); }
        if (e.glow) { if (e.glow.parent) e.glow.parent.remove(e.glow); e.glow.geometry.dispose(); e.glow.material.dispose(); }
      } catch (x) { /* it went with its floor */ }
    }

    // Patch the screens of the bots on the shown floor that are new. The engine rebuilds a floor when a
    // bot joins or leaves, so screens come and go.
    function scan() {
      var ins = inspect();
      if (!ins) return;
      entries = entries.filter(function (e) { if (inScene(e.mesh)) return true; drop(e); return false; });
      var bots = (ins.bots || []).filter(function (b) { return b && b.name && b.floor === ins.floor; });
      var fromEngine = bots.some(function (b) { return Array.isArray(b.screens); });
      bots.forEach(function (b) {
        var ss = (fromEngine ? (b.screens || []) : nearScreens(b)).filter(function (m) {
          return m && m.isMesh && m.material && m.geometry && m.geometry.parameters && inScene(m);
        });
        ss.forEach(function (m, i) {
          var have = m.userData.officeTerm;
          if (owned(m)) { if (have.owner === self) { have.bot = b; have.name = b.name; } return; }
          patch(m, b, i, ss);
        });
      });
    }
    function paint(e, force) {
      if (!e.P) measure(e);
      var s = sessionFor(e), info = status(s), p = palette(K), dark = !!K.dark, sub = K.look === 'sublevel';
      e.uid = s && !s.pseudo && s.uid && s.status !== 'ended' ? s.uid : null;   // a closed session has no terminal to open
      if (e.hover && !e.uid) { e.hover = ''; if (hover === e) { hover = null; host.rehover(); } }
      var closed = info.word === 'Closed', calm = info.key === 'resting' || info.key === 'finished';
      e.emI = (dark ? 1 : 0.95) * (closed ? 0.5 : calm ? 0.8 : 1);
      if (e.glow) {
        e.glowA = (dark ? 0.5 : sub ? 0.16 : 0) * (closed ? 0 : calm ? 0.55 : 1);
        e.glow.visible = e.glowA > 0;
        e.glow.material.color.set(info.key === 'waiting' ? p.wait : info.key === 'error' ? p.err : p.fg);
      }
      var v = viewOf(e, s, info), sig = JSON.stringify(v);
      if (!force && sig === e.sig) return;
      e.sig = sig;
      var cur = paintScreen(e.ctx, e.W, e.H, v, e.P, p);
      e.tex.needsUpdate = true;
      placeCursor(e, cur, info);
    }
    // Every 400 ms: note turn changes of all bots, and repaint the shown screens whose text changed.
    function pass() {
      var ins = inspect();
      if (ins) (ins.bots || []).forEach(function (b) {
        if (!b || !b.name) return;
        var s = null;
        try { s = sessionOf(b.name); } catch (x) { s = null; }
        if (s) turnStart(s);
      });
      for (var i = 0; i < entries.length; i++) if (shown(entries[i].mesh)) paint(entries[i], false);
    }
    function retheme() {
      themeN++;
      entries.forEach(function (e) { e.em.set(K.tok.bubble); measure(e); e.sig = ''; });
      if (K.look === 'sublevel') loadFont(K.f && K.f.term);
      acc = 1;
    }
    function fontsReady() {
      if (self.dead) return;
      themeN++;
      entries.forEach(function (e) { measure(e); e.sig = ''; });
      acc = 1;
    }
    function loadFont(fam) {
      try { if (fam && document.fonts && document.fonts.load) document.fonts.load('20px ' + fam).then(fontsReady, function () {}); } catch (x) { /* the canvas uses the fallback font */ }
    }

    // The host picks: one raycast over all targets, a bot in front wins (then the click is the engine's), and the host owns the cursor.
    // The badge says the next click: it flies to the monitor and opens the chat on it (a pinned screen, #89).
    function keyOf(e) { return 'screen:' + e.name + ':' + e.kind; }
    function labelOf() { return 'Open chat'; }
    function setHover(h) {
      var lb = h ? labelOf(h) : '';
      if (h === hover && (!h || h.hover === lb)) return;
      var old = hover;
      hover = h;
      if (old && old !== h) { old.hover = ''; paint(old, true); }
      if (h) { h.hover = lb; paint(h, true); }
    }

    // The host tells us when a bot joins or leaves, the floor changes, or the engine rebuilds the floors
    // (a theme change does that, with the same bot list): patch the new screens before this frame draws.
    var offRebuild = host.onRebuild(function (why) {
      if (self.dead) return;
      try { scan(); } catch (x) { /* the timer scans again */ }
      if (why.some(function (w) { return w === 'gone' || w === 'floors' || w === 'floor'; })) acc = 1;
    });
    // Per frame: keep the terminal texture on the glass (a theme change puts the DS picture back),
    // blink the cursors, and repaint at most every 400 ms.
    function frame(dt, t) {
      if (self.dead) return;
      if (st.dead) { dispose(); return; }
      try {
        if (K.tok !== lastTok || K.look !== lastLook) { lastTok = K.tok; lastLook = K.look; retheme(); }
        var on = st.rm || Math.floor(t / 0.53) % 2 === 0;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i], mt = e.mesh.material;
          if (mt && mt.map !== e.tex) { mt.map = e.tex; mt.emissiveMap = e.tex; mt.needsUpdate = true; }
          if (e.cursor) e.cursor.visible = e.curOn && on;
          if (e.glow) e.glow.material.opacity = e.glowA * (e.hover ? 1.45 : 1);
        }
        acc += dt || 0;
        if (acc >= 0.4) { acc = 0; pass(); }
      } catch (x) { /* one bad frame must not stop the office */ }
    }

    var fontsHooked = false;
    try { if (document.fonts && document.fonts.addEventListener) { document.fonts.addEventListener('loadingdone', fontsReady); fontsHooked = true; } } catch (x) { fontsHooked = false; }
    loadFont(K.f && K.f.mono);
    if (K.look === 'sublevel') loadFont(K.f && K.f.term);
    var offFrame = host.frame(frame);
    var target = {
      name: 'terminal',
      active: function () { return !self.dead; },
      meshes: function () { return entries.filter(function (e) { return e.uid && shown(e.mesh); }).map(function (e) { return e.mesh; }); },
      itemOf: function (mesh) { return mesh.userData.officeTerm || null; },
      hover: function (e) { try { setHover(e); } catch (x) { hover = null; } },
      // a monitor is a pinned screen: the click flies to it and the page lays the chat and the terminal over it (#89)
      // clear: the bot sits in front of its screen; the cut keeps the desk top and drops the bot and its bubble
      look: function (e) { return { key: keyOf(e), mesh: e.mesh, verb: 'Open chat', kind: 'terminal', clear: 0.5, pin: true }; },
      open: function (e) { if (e.uid && typeof o.onOpen === 'function') o.onOpen(e.uid, e.name); },
      // after a floor rebuild the screen in focus is a new mesh
      find: function (key) { var e = entries.filter(function (x) { return keyOf(x) === key && inScene(x.mesh); })[0]; return e ? { item: e, mesh: e.mesh } : null; },
      anchors: function () { return entries.map(function (e) { return e.mesh; }); }
    };
    var offTarget = host.register(target);
    // The keyboard path (Ctrl+K, the dock, the bezel count): the monitor of a session on the shown floor, the terminal one first.
    function open(uid) {
      if (self.dead || !uid) return false;
      try { scan(); } catch (x) { /* the list is still good */ }
      var fg = host.shownFloor(), mine = entries.filter(function (e) { return e.uid === uid && host.onShownFloor(e.mesh, fg); });
      mine.sort(function (a, b) { return (a.kind === 'term' ? 0 : 1) - (b.kind === 'term' ? 0 : 1); });
      return !!mine[0] && host.show(target, mine[0], false);
    }
    var timer = setInterval(function () { if (st.dead) { dispose(); return; } if (!self.dead) { try { scan(); } catch (x) { /* next time */ } } }, 1500);
    try { scan(); } catch (x) { /* the first frame scans again */ }

    function dispose() {
      if (self.dead) return;
      self.dead = true;
      clearInterval(timer);
      offFrame(); offRebuild(); offTarget();
      if (fontsHooked) { try { document.fonts.removeEventListener('loadingdone', fontsReady); } catch (x) { /* gone */ } }
      hover = null;
      host.leave();
      entries.forEach(function (e) {
        e.hover = '';
        if (e.mesh.onBeforeRender === e.hook) delete e.mesh.onBeforeRender;
        if (e.cursor && e.cursor.parent) e.cursor.parent.remove(e.cursor);
        if (e.glow && e.glow.parent) e.glow.parent.remove(e.glow);
      });
      entries = [];
      hover = null;
      if (ownHost) host.dispose();
    }
    return {
      refresh: function () { if (self.dead) return; scan(); entries.forEach(function (e) { e.sig = ''; }); pass(); },
      open: open,
      dispose: dispose,
      // Look at a session's monitor (step 1, no panel): uid's, or with no uid the first agent monitor on the shown floor (the
      // lobby tour's monitor stop). True when the camera flies there.
      look: function (uid) {
        if (self.dead) return false;
        try { scan(); } catch (x) { /* the list is still good */ }
        var fg = host.shownFloor();
        var e = entries.filter(function (x) { return x.uid && (uid ? x.uid === uid : true) && host.onShownFloor(x.mesh, fg); })[0];
        return !!e && host.show(target, e, false);
      },
      // the patched screens, for tests and the console
      screens: function () { return entries.map(function (e) { return { name: e.name, kind: e.kind, uid: e.uid, shown: shown(e.mesh), hover: e.hover }; }); }
    };
  }

  window.OfficeTerminal = { attach: attach, lines: lines, timeline: timeline, status: status, toolName: toolName, stats: statsOf };
})();
