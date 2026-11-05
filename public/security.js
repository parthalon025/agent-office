/* Agent Office for Claude Code x0.1: the Security room's wall screens (#70).
   The user picks the permission rules on six wall screens (Files, Commands, Network, Secrets, Agents, Spend) in the scene.
   The DS builds the room (type security) and its six screen planes; this file repaints them and handles clicks on them.
   A host adapter like board.js and terminal.js: it registers one pick target and a frame with the scene host, and it
   never raycasts, sets the cursor or moves the camera itself. A distinct job from board.js (the lab rooms' boards): in-scene
   controls with a painted Confirm, a paged view and typing on the wall.

   The screens take the host's two steps. The first click looks at a screen; in focus, every click is the second step, and
   the host gives the point of the click on the screen (hit.uv). A click on a cell cycles Ask, Allow, Deny (Secrets: Ask,
   Deny). A looser rule (to Allow, or an agent toggle to On) turns the cell amber and paints "Confirm: <change>" with Confirm
   and Cancel hotspots: no dialog. Ask and Deny apply at once. Below 700 px of width that the screen in focus can take (the free width, or the free height times its aspect) it shows one agent kind
   at a time, with Previous and Next. No keyboard or screen reader path (ADR 0003); the Spend value takes digits while it is
   being typed, after a click on it. Minus stops at $1, and No limit (a typed 0 or an empty value) is the loosest spend
   setting: it waits for the same painted Confirm.
   A cell the office cannot enforce says "Not enforced"; an Ask cell that the agent decides by itself (Claude Code asks only
   when its own rules and mode say so) says "Partly enforced". So does a default Ask that forces nothing (review B1: Claude
   Code decides until the user sets the cell); a click on it sets Ask, and Use default under an office-wide rule the user set
   takes it back to the default. Each with its reason (security.mjs enforcement).
   The rules and words come from the snapshot (snap.security) and the shared vocabulary (vocab.js OfficeVocab.security); the
   server checks every change again (security.mjs), so this file keeps no rule of its own beyond what to paint.

   Pure part (window.OfficeSecurity.pure, no DOM, no THREE; tested in test/security-screens.test.mjs):
     plan(view, data)    -> { items, hots }: what a screen paints (in canvas px, tone names, no colors) and where its hotspots are
     hotAt(p, uv, w, h)  -> the hotspot under a screen point (uv: { x, y } from the bottom left, as the host gives it), or null
     step(view, hot, data) -> { view, send? }: a click on a hotspot. send: { route, body } for the server
     key(view, e, data)  -> { view, send?, taken } for a key while the Spend value is being typed
     PAGED_BELOW         -> 700: below this width (px) that the screen in focus can take, it shows one agent kind
     pagedFor(free, aspect) -> that check: the free width, or the free height times the screen aspect (review M6)
   view: { screen, w, h, focused, paged, page, scope, pending, edit, hover, busy, note, face, section, hqPage }
   data: { sec (snap.security), building (key), buildingName, hq (snap.hq) }
   The Agents screen has two parts (section): the agent kinds (the grid) and Paperclip (#76): each agent of the watched
   company with its supervision and Supervise in office, which waits for the same painted Confirm and then sends
   POST /api/paperclip/supervise { agent, confirmed: true } (one PATCH of that agent in Paperclip). */
(function (root) {
  'use strict';
  var V = root.OfficeVocab;
  var PAGED_BELOW = 700;
  var CANVAS_W = 1280;

  // ---------- pure ----------
  function S() { return V.security; }
  function screenOf(id) { return S().screens.filter(function (x) { return x.id === id; })[0]; }
  function colLabel(col) { var c = S().columns.filter(function (x) { return x.id === col; })[0]; return c ? c.label : col; }
  function permScreen(id) { return id !== 'agents' && id !== 'spend'; }
  function rulesOf(data) { return (data && data.sec && data.sec.rules) || { office: {}, buildings: {} }; }
  // The value a cell shows in a scope: the office-wide rule, or this building's (its override or the office rule).
  function shown(data, scope, row, col) {
    return S().valueOf(rulesOf(data), scope === 'building' ? data.building : null, row, col);
  }
  // Where that value comes from: 'building', 'office' or 'default' (a cell the user never set).
  function sourceIn(data, scope, row, col) {
    return S().sourceOf(rulesOf(data), scope === 'building' ? data.building : null, row, col);
  }
  // The office-wide rule of a cell was set by the user (Use default takes it back).
  function officeSet(data, row, col) { return S().own(rulesOf(data).office, S().key(row, col)) && !S().rows[row].office; }
  // A default Ask the agent decides by itself (enforce unset): a click sets Ask, so the office makes the agent ask (B1).
  function unsetAsk(data, scope, row, col) {
    var e = data && data.sec && data.sec.enforce && data.sec.enforce[col];
    return !!(e && e.unset && S().own(e.unset, row) && !notEnforced(data, row, col) && shown(data, scope, row, col) === 'ask' && sourceIn(data, scope, row, col) === 'default');
  }
  function overridden(data, row, col) {
    var b = rulesOf(data).buildings[data.building];
    return !!(b && b[S().key(row, col)] && !S().rows[row].office);
  }
  // Why a cell is not enforced for its agent kind ('' = it is): the column reason, else a row reason.
  function notEnforced(data, row, col) {
    var e = data && data.sec && data.sec.enforce && data.sec.enforce[col];
    if (!e) return '';
    return e.reason || (e.rows && S().own(e.rows, row) && e.rows[row]) || '';
  }
  // Why a cell is only partly enforced ('' = fully): only some calls reach the office (partly), or an Ask the agent decides by itself.
  function partly(data, scope, row, col) {
    var e = data && data.sec && data.sec.enforce && data.sec.enforce[col];
    if (!e || notEnforced(data, row, col)) return '';
    if (e.partly && S().own(e.partly, row)) return e.partly[row];   // only some calls reach the office, whatever the value
    if (unsetAsk(data, scope, row, col)) return e.unset[row];        // a default Ask: the agent decides until the user sets it
    if (!e.asks || !S().own(e.asks, row)) return '';
    return shown(data, scope, row, col) === 'ask' ? e.asks[row] : '';
  }
  // The note under a cell: { word, why } or null.
  function noteOf(data, scope, row, col) {
    var n = notEnforced(data, row, col);
    if (n) return { word: 'Not enforced', why: n };
    var q = partly(data, scope, row, col);
    return q ? { word: 'Partly enforced', why: q } : null;
  }
  function tone(v) { return v === 'allow' || v === 'on' ? 'allow' : v === 'deny' ? 'deny' : 'ask'; }
  // The painted Confirm: the change, then what it is for.
  function isSpend(p) { return !!p && p.spend !== undefined; }
  // Allow on the Shell commands row approves every command, high risk ones too: the check before a hold ignores the risk rating
  // (security.mjs decide), so the painted Confirm says it (review).
  function allowsAnyCommand(p) { return !!p && !isSpend(p) && p.row === 'shell' && (p.to === 'allow' || (p.to === null && p.office === 'allow')); }
  // Supervise in office (#76): the one change on the wall that writes to another system, so the Confirm says what it writes.
  function isHq(p) { return !!p && p.hq !== undefined; }
  function confirmText(p) {
    if (isHq(p)) return 'Confirm: Supervise ' + p.name + ' in office?';
    if (allowsAnyCommand(p)) return 'Confirm: Allow every command for ' + colLabel(p.col) + ', high risk too (rm -rf, git push --force)?';
    return 'Confirm: ' + (isSpend(p) ? 'No limit' : p.to === null ? (p.def ? 'the default (' : 'the office rule (') + S().word(p.office) + ')' : S().word(p.to));
  }
  function confirmWhat(p) {
    if (isHq(p)) return 'The office writes to its config in Paperclip: engine cli, skip permissions off, permission mode default and the office hooks file. Its next run asks here.';
    return isSpend(p) ? 'Spend limit, new sessions' : S().rows[p.row].label + ', ' + colLabel(p.col);
  }
  function money(n) { var F = root.OfficeFormat; return F && F.money ? F.money(n) : '$' + (+n || 0).toFixed(2); }
  function monthName(m) {
    var a = String(m || '').split('-'), names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return a.length === 2 && names[+a[1] - 1] ? names[+a[1] - 1] + ' ' + a[0] : 'this month';
  }

  // Draw items. t: fill | stroke | text | mark. Positions in canvas px; colors are tone names (paint maps them to tokens).
  function P() { return { items: [], hots: [] }; }
  function fill(p, x, y, w, h, c, r) { p.items.push({ t: 'fill', x: x, y: y, w: w, h: h, c: c, r: r || 0 }); }
  function stroke(p, x, y, w, h, c, lw, r) { p.items.push({ t: 'stroke', x: x, y: y, w: w, h: h, c: c, lw: lw || 3, r: r || 0 }); }
  function text(p, x, y, s, c, str, o) { o = o || {}; p.items.push({ t: 'text', x: x, y: y, s: s, c: c, text: String(str), wt: o.wt || 400, align: o.align || 'left', maxW: o.maxW || 0, mono: !!o.mono }); }
  function hot(p, h) { p.hots.push(h); return h; }
  // Wrapping. Node has no canvas to measure text, so the plan wraps by a safe estimate of the width of a character: a share of
  // the font size (IBM Plex Sans, checked against the browser's measureText in the screenshots: the average English text is
  // about 0.48 em at 400 and 0.52 at 600). The share is higher than that on purpose, so a line the plan makes fits in the
  // browser and the paint's ellipsis (clipW) never cuts a reason. One rule for the plan and for the test.
  function charW(size, wt) { return size * (wt >= 600 ? 0.6 : 0.56); }
  // The size a one-line word in a column takes: s, or smaller so that it fits maxW by the same estimate (six agent kinds make
  // the columns narrower, #24), with 5 % more room than charW, so the paint's ellipsis never cuts it. Never under 14 px.
  function fit(str, s, maxW, wt) { var n = String(str).length; return n ? Math.max(14, Math.min(s, Math.floor(maxW / (n * charW(1, wt) * 1.08)))) : s; }
  function wrap(str, size, maxW, wt) {
    var cap = Math.max(1, Math.floor(maxW / charW(size, wt))), lines = [], cur = '';
    String(str).split(/\s+/).filter(Boolean).forEach(function (w) {
      while (w.length > cap) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, cap)); w = w.slice(cap); }
      if (!cur) cur = w; else if (cur.length + 1 + w.length <= cap) cur += ' ' + w; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines;
  }
  // Paint wrapped lines, the first baseline at y, lh apart. Returns the baseline after the last line.
  function para(p, x, y, s, lh, c, list, o) {
    list.forEach(function (l, i) { text(p, x, y + i * lh, s, c, l, Object.assign({}, o)); });
    return y + list.length * lh;
  }
  // A value chip: words always, a status tone for Allow and Deny (DS: pair every status color with a word).
  function chip(p, x, y, w, h, v, s, hovered, pending) {
    if (pending) { var cs = fit('Confirm?', s, w - 16, 600); fill(p, x, y, w, h, 'pending', h / 2); text(p, x + w / 2, y + h / 2 + cs * 0.36, cs, 'onPending', 'Confirm?', { wt: 600, align: 'center', maxW: w - 16 }); return; }
    var tn = tone(v);
    if (tn === 'ask') stroke(p, x + 1.5, y + 1.5, w - 3, h - 3, 'line', 3, h / 2);
    else fill(p, x, y, w, h, tn + 'Fill', h / 2);
    if (hovered) stroke(p, x - 5, y - 5, w + 10, h + 10, 'focus', 4, h / 2 + 5);
    var ws = fit(S().word(v), s, w - 16, 600);
    text(p, x + w / 2, y + h / 2 + ws * 0.36, ws, 'ink', S().word(v), { wt: 600, align: 'center', maxW: w - 16 });
  }
  // A button with a label, or with a DS icon (label { icon: name }: the icon set, never a text glyph).
  function button(p, x, y, w, h, label, s, h0, hovered, kind) {
    fill(p, x, y, w, h, kind === 'primary' ? 'primary' : 'buttonFill', 12);
    if (hovered) stroke(p, x - 4, y - 4, w + 8, h + 8, 'focus', 4, 14);
    if (label && label.icon) p.items.push({ t: 'icon', name: label.icon, x: x + w / 2 - s / 2, y: y + h / 2 - s / 2, s: s, c: 'ink' });
    else text(p, x + w / 2, y + h / 2 + s * 0.36, s, kind === 'primary' ? 'onPrimary' : 'ink', label, { wt: 600, align: 'center', maxW: w - 12 });
    h0.x = x; h0.y = y; h0.w = w; h0.h = h;
    return h0;
  }
  function isHover(view, id) { return view.hover === id; }

  // The header: the title and, on a rules screen, the scope (all buildings or this building).
  function header(p, view, data, big) {
    var sc = screenOf(view.screen), W = view.w, ts = big ? 64 : 56;
    text(p, 48, big ? 80 : 76, ts, 'ink', sc.title, { wt: 600 });
    if (permScreen(view.screen)) {
      // Both choices, the chosen one marked. The paged view draws them bigger; one button that named only the current scope
      // hid "This building" there (review minor).
      pair(p, view, big, [['office', 'All buildings'], ['building', 'This building']], view.scope === 'building' ? 'building' : 'office', 'scope');
    } else if (view.screen === 'agents') {
      // the Agents screen has two parts: the agent kinds (the grid) and the Paperclip agents, one by one (#76)
      pair(p, view, big, [['kinds', 'Agent kinds'], ['hq', 'Paperclip']], sectionOf(view), 'section');
    } else text(p, W - 48, big ? 80 : 74, big ? 40 : 28, 'muted', 'Office-wide', { align: 'right' });
  }
  // Two choices at the right of the header, the chosen one marked: the scope of a rules screen, or the part of the Agents screen.
  function pair(p, view, big, opts, cur, kind) {
    var W = view.w, bw = big ? 344 : 250, bh = big ? 80 : 58, by = big ? 22 : 30, fs = big ? 40 : 28;
    opts.forEach(function (o, i) {
      var id = kind + '-' + o[0], x = W - 48 - (2 - i) * (bw + 12) + 12, on = cur === o[0];
      // the chosen one is the primary pair (accent and on-accent): ink on the room's accent was 2.76:1 at Night
      if (on) fill(p, x, by, bw, bh, 'primary', bh / 2); else stroke(p, x + 1.5, by + 1.5, bw - 3, bh - 3, 'line', 3, bh / 2);
      if (isHover(view, id)) stroke(p, x - 5, by - 5, bw + 10, bh + 10, 'focus', 4, bh / 2 + 5);
      text(p, x + bw / 2, by + bh / 2 + fs * 0.36, fs, on ? 'onPrimary' : 'ink', o[1], { wt: 600, align: 'center', maxW: bw - 16 });
      var h0 = { kind: kind, id: id, x: x, y: by, w: bw, h: bh };
      h0[kind] = o[0];
      hot(p, h0);
    });
  }
  function sectionOf(view) { return view.screen === 'agents' && view.section === 'hq' ? 'hq' : 'kinds'; }

  // ---------- the Paperclip part of the Agents screen (#76) ----------
  // Each Paperclip agent of the watched company: its role, whether its runs hold their calls in the office (paperclip.mjs
  // supervisionOf), why not, and Supervise in office when the office can set it up. A click paints the Confirm; Confirm sends
  // POST /api/paperclip/supervise, one PATCH of that agent in Paperclip. data.hq: the snapshot's hq (null: not connected).
  function hqAgents(data) { var q = data && data.hq; return q && q.company && q.agents ? q.agents : null; }
  function hqHead(data) {
    var q = data && data.hq;
    if (!q) return 'Paperclip is not connected. Connect it in Attach sessions, then supervise its agents here.';
    if (!q.company) return V.hq.state(q) + '.';
    return V.hq.state(q) + '. Supervise in office sends the Claude Code runs of an agent through the office hooks.';
  }
  function hqTone(a) { var s = a.supervision && a.supervision.state; return s === 'supervised' ? 'allow' : s === 'partly' ? 'ask' : 'deny'; }
  function hqWord(a) { var s = a.supervision && a.supervision.state; return s === 'supervised' ? 'Supervised' : s === 'partly' ? 'Partly' : 'Unsupervised'; }
  function stateChip(p, x, y, w, h, a, s) {
    var tn = hqTone(a), word = hqWord(a), ws = fit(word, s, w - 16, 600);
    if (tn === 'ask') stroke(p, x + 1.5, y + 1.5, w - 3, h - 3, 'line', 3, h / 2); else fill(p, x, y, w, h, tn + 'Fill', h / 2);
    text(p, x + w / 2, y + h / 2 + ws * 0.36, ws, 'ink', word, { wt: 600, align: 'center', maxW: w - 16 });
  }
  // Lines of a reason that fit in n lines: the last one ends with an ellipsis when the reason is longer (the HQ dialog has it whole).
  function upTo(lines, n) { if (lines.length <= n) return lines; var out = lines.slice(0, n); out[n - 1] = out[n - 1].replace(/\s*\S*$/, '') + '…'; return out; }
  function hqScreen(p, view, data, big) {
    var W = view.w, H = view.h, list = hqAgents(data), hs = big ? 32 : 24;
    // the narrow view keeps the head to the connection: what Supervise in office does is on its Confirm
    var head = big && list ? V.hq.state(data.hq) + '.' : hqHead(data);
    var y = para(p, 48, big ? 150 : 134, hs, hs + 6, 'muted', wrap(head, hs, W - 96, 400), { maxW: W - 96 }) + (big ? 6 : 2);
    var hint = view.note || (!view.focused ? 'Click to look closer.' : list && list.some(function (a) { return a.supervision && a.supervision.can; }) ? (big ? 'The office asks before it writes to Paperclip.' : 'Click Supervise in office for an agent. The office asks before it writes to Paperclip.') : 'No agent here needs Supervise in office.');
    var ns = big ? 32 : 24, hl = wrap(hint, ns, W - 96, 400);
    function foot() { if (view.pending) { confirmBand(p, view, big); return; } para(p, 48, H - 30 - (hl.length - 1) * (ns + 6), ns, ns + 6, view.note ? 'error' : 'ink', hl, { maxW: W - 96 }); }
    if (!list || !list.length) {
      if (list) text(p, 48, y + (big ? 60 : 44), big ? 40 : 28, 'ink', 'This company has no agents yet.', { maxW: W - 96 });
      foot(); return;
    }
    var n = list.length, bottom = (view.pending ? H - 170 : H - 40 - hl.length * (ns + 6)) - (big ? 0 : 4);
    if (big) {
      // one agent at a time, with Previous and Next (the narrow view)
      var pg = ((view.hqPage || 0) % n + n) % n, a = list[pg];
      if (n > 1) {
        hot(p, button(p, 48, y, 230, 80, 'Previous', 44, { kind: 'hq-prev', id: 'hq-prev' }, isHover(view, 'hq-prev')));
        hot(p, button(p, W - 48 - 230, y, 230, 80, 'Next', 44, { kind: 'hq-next', id: 'hq-next' }, isHover(view, 'hq-next')));
        text(p, W / 2, y + 54, 36, 'muted', (pg + 1) + ' of ' + n, { align: 'center', maxW: W - 600 });
        y += 100;
      }
      text(p, 48, y + 46, 48, 'ink', a.name, { wt: 600, maxW: W - 96 - 330 });
      text(p, 48, y + 86, 30, 'muted', a.title || a.role, { maxW: W - 96 - 330 });
      stateChip(p, W - 48 - 300, y + 4, 300, 80, a, 40);
      var can = a.supervision.can && !view.pending, room = (can ? bottom - 100 : bottom) - (y + 130);
      var wl = upTo(wrap(a.supervision.why || 'Its runs hold every call Claude Code asks about in the office.', 30, W - 96, 400), Math.max(1, Math.floor(room / 36) + 1));
      para(p, 48, y + 130, 30, 36, 'muted', wl, { maxW: W - 96 });
      var byy = Math.min(bottom - 92, y + 130 + wl.length * 36 - 10);
      if (can) {
        if (a.busy) text(p, 48, byy + 60, 40, 'muted', 'Setting up in Paperclip', { maxW: W - 96 });
        else hot(p, button(p, 48, byy, 520, 92, 'Supervise in office', 44, { kind: 'supervise', id: 'hq:' + a.id, agent: a.id, name: a.name }, isHover(view, 'hq:' + a.id), 'primary'));
      }
      foot(); return;
    }
    // the full view: a row per agent, as many as fit, with Previous and Next when there are more
    // a row: name and role, the state in a chip, the reason in up to three lines, Supervise in office when it is offered
    var rowH = 92, fitN = Math.max(1, Math.floor((bottom - y - 8) / rowH)), more = n > fitN;
    if (more) fitN = Math.max(1, Math.floor((bottom - y - 76) / rowH));
    var pages = Math.ceil(n / fitN), page = ((view.hqPage || 0) % pages + pages) % pages, from = page * fitN;
    var nameW = 250, chipX = 48 + nameW + 12, chipW = 190, bw = 290, whyX = chipX + chipW + 20;
    list.slice(from, from + fitN).forEach(function (a) {
      fill(p, 48, y, W - 96, 2, 'line');
      text(p, 48, y + 38, fit(a.name, 28, nameW, 600), 'ink', a.name, { wt: 600, maxW: nameW });
      text(p, 48, y + 70, 21, 'muted', a.title || a.role, { maxW: nameW });
      stateChip(p, chipX, y + 20, chipW, 52, a, 24);
      var can = a.supervision && a.supervision.can, whyW = W - 48 - whyX - (can ? bw + 16 : 0);
      para(p, whyX, y + 28, 20, 24, 'muted', upTo(wrap(a.supervision.why || 'Its runs hold every call Claude Code asks about in the office.', 20, whyW, 400), 3), { maxW: whyW });
      if (can) {
        var pend = isHq(view.pending) && view.pending.hq === a.id, id = 'hq:' + a.id, bx = W - 48 - bw;
        if (pend) { fill(p, bx, y + 18, bw, 56, 'pending', 28); text(p, bx + bw / 2, y + 46 + 9, 24, 'onPending', 'Confirm?', { wt: 600, align: 'center', maxW: bw - 16 }); }
        else if (a.busy) text(p, bx + bw / 2, y + 54, 22, 'muted', 'Setting up', { align: 'center', maxW: bw });
        else hot(p, button(p, bx, y + 18, bw, 56, 'Supervise in office', 24, { kind: 'supervise', id: id, agent: a.id, name: a.name }, isHover(view, id), 'primary'));
      }
      y += rowH;
    });
    if (more) {
      fill(p, 48, y, W - 96, 2, 'line');
      hot(p, button(p, 48, y + 14, 200, 52, 'Previous', 24, { kind: 'hq-prev', id: 'hq-prev' }, isHover(view, 'hq-prev')));
      hot(p, button(p, 260, y + 14, 200, 52, 'Next', 24, { kind: 'hq-next', id: 'hq-next' }, isHover(view, 'hq-next')));
      text(p, 480, y + 48, 22, 'muted', 'Agents ' + (from + 1) + ' to ' + Math.min(n, from + fitN) + ' of ' + n, { maxW: W - 528 });
    }
    foot();
  }

  // Three layouts of a rules screen (levels). The first is the roomy one. A screen with many reasons (Files, with six agent
  // kinds) takes the second: smaller type (18 px is the smallest on the wall), a tighter grid and the subtitle under the
  // title, so that every reason fits in full, wrapped, between the grid and the hint. The third keeps that type and makes the
  // grid and the gap above the hint tighter still: Files when an agent's own config also has gaps (OpenClaw). fs/lh: reason type and line height;
  // y0: the top of the grid; sub/subS: the subtitle baseline and size; rowH: a row of a screen with 3 rows (2 rows or fewer
  // take 120); cy/ch: chip top in the row and chip height; ng: the note under the chip; bk: the Use default line under it;
  // hint/hintY: the hint size and its baseline from the bottom; gap: hint baseline to the last reason baseline.
  var LEVELS = [
    { fs: 21, lh: 29, y0: 168, sub: 132, subS: 24, rowH: 104, cy: 16, ch: 52, ng: 26, bk: 22, hint: 24, hintY: 34, gap: 36 },
    { fs: 18, lh: 23, y0: 128, sub: 110, subS: 22, rowH: 96, cy: 8, ch: 44, ng: 20, bk: 19, hint: 22, hintY: 30, gap: 30 },
    { fs: 18, lh: 23, y0: 128, sub: 110, subS: 22, rowH: 86, cy: 6, ch: 42, ng: 19, bk: 18, hint: 22, hintY: 30, gap: 24 }
  ];
  function rowHOf(L, rows) { return rows > 2 ? L.rowH : 120; }

  // The subtitle under the header of a full screen.
  function subtitle(p, view, data, L) {
    var t;
    if (view.screen === 'spend') t = 'The spend limit of new sessions, and what each agent kind cost this month.';
    else if (view.screen === 'agents') t = 'Office-wide: which agents may run. The office asks before a looser change.';
    else if (view.scope === 'building') t = 'Rules for ' + (data.buildingName || 'this building') + ' only. A corner mark: this building has its own rule.';
    else t = 'Rules for every building. A corner mark: this building has its own rule there.';
    para(p, 48, L.sub, L.subS, L.subS + 6, 'muted', wrap(t, L.subS, view.w - 96, 400), { maxW: view.w - 96 });
  }

  // The heads of the agent kind columns, centred over each column. Six kinds (#23) make a column narrow: when a head does
  // not fit on one line at size s, every head takes size s - 2 and wraps to at most two lines, and the heads end on one
  // baseline (yTwo); else they sit on yOne. So no head reaches the paint's ellipsis.
  function heads(p, cols, gx, colW, s, yOne, yTwo) {
    var max = colW - 8;
    var two = cols.some(function (c) { return c.label.length * charW(s, 600) > max; }), size = two ? s - 2 : s;
    // seven kinds (#22, #23): the longest word of a head must fit too, so the type goes down to 18 px, never cut
    if (two) cols.forEach(function (c) { c.label.split(' ').forEach(function (w) { while (size > 18 && w.length * charW(size, 600) > max) size--; }); });
    cols.forEach(function (c, i) {
      var lines = two ? wrap(c.label, size, max, 600).slice(0, 2) : [c.label];
      lines.forEach(function (l, k) {
        text(p, gx + i * colW + colW / 2, (two ? yTwo : yOne) - (lines.length - 1 - k) * (size + 2), size, 'muted', l, { wt: 600, align: 'center', maxW: max });
      });
    });
  }

  // The rows of a rules or Agents screen as a grid: one column per agent kind.
  function grid(p, view, data, L) {
    // eight kinds (#22, #24): the label column is 300 px and the grid runs to 24 px from the edge, so a column is 113 px and
    // "Framework" and "Not enforced" fit it; a row label that does not fit at 28 px takes a smaller size (fit).
    var sc = screenOf(view.screen), W = view.w, x0 = 48, labelW = 300, gx = x0 + labelW, cols = S().columns;
    var colW = Math.floor((W - 24 - gx) / cols.length), y0 = L.y0, rowH = rowHOf(L, sc.rows.length);
    heads(p, cols, gx, colW, 24, y0 + 30, y0 + 42);
    var y = y0 + 52;
    sc.rows.forEach(function (row) {
      var r = S().rows[row];
      fill(p, x0, y, W - 96, 2, 'line');
      text(p, x0, y + rowH / 2 + 10, fit(r.label, 28, labelW - 16, 400), 'ink', r.label, { maxW: labelW - 16 });
      cols.forEach(function (c, i) {
        var cx = gx + i * colW, cw = colW - 16, ch = L.ch, cy = y + L.cy;
        if (!S().applies(row, c.id)) { text(p, cx + colW / 2, cy + ch / 2 + 9, fit(S().na(row, c.id), 22, colW - 8, 400), 'muted', S().na(row, c.id), { align: 'center', maxW: colW - 8 }); return; }
        var id = 'cell:' + row + '|' + c.id, pend = view.pending && view.pending.row === row && view.pending.col === c.id;
        chip(p, cx + 8, cy, cw, ch, shown(data, view.scope, row, c.id), 24, isHover(view, id), pend);
        if (overridden(data, row, c.id) && !pend) p.items.push({ t: 'mark', x: cx + 8 + cw - 4, y: cy + 4, s: 18, c: 'accent' });
        hot(p, { kind: 'cell', id: id, row: row, col: c.id, x: cx + 4, y: cy - 4, w: cw + 8, h: ch + 8 });
        var nt = noteOf(data, view.scope, row, c.id);
        if (nt) text(p, cx + colW / 2, cy + ch + L.ng, fit(nt.word, 18, colW - 8, 400), 'muted', nt.word, { align: 'center', maxW: colW - 8 });
        // Back to the office rule (a building override), or to the default (an office-wide rule the user set).
        var back = view.scope === 'building' ? overridden(data, row, c.id) && 'Use office rule' : officeSet(data, row, c.id) && 'Use default';
        if (back && !pend && view.focused) {
          var cid = 'clear:' + row + '|' + c.id;
          text(p, cx + colW / 2, cy + ch + L.ng + (nt ? L.bk : 0), fit(back, 18, colW - 8, 400), isHover(view, cid) ? 'ink' : 'muted', back, { align: 'center', maxW: colW - 8 });
          hot(p, { kind: 'clear', id: cid, row: row, col: c.id, x: cx + 4, y: cy + ch + 8, w: cw + 8, h: 26 });
        }
      });
      y += rowH;
    });
    return y;
  }

  // The reasons of the cells that are not or partly enforced, one per reason: "Not enforced for Hermes, dsh. ...". onlyCol: only
  // that agent kind (the paged view), then "Not enforced. ..." without the kind.
  function reasons(view, data, onlyCol) {
    var sc = screenOf(view.screen), by = {}, order = [];
    S().columns.forEach(function (c) {
      if (onlyCol && c.id !== onlyCol) return;
      sc.rows.forEach(function (row) {
        if (!S().applies(row, c.id)) return;
        var nt = noteOf(data, view.scope, row, c.id);
        if (!nt) return;
        var k = nt.word + '\u0000' + nt.why;
        if (!by[k]) { by[k] = { word: nt.word, why: nt.why, cols: [] }; order.push(k); }
        if (by[k].cols.indexOf(c.label) < 0) by[k].cols.push(c.label);
      });
    });
    return order.map(function (k) { var x = by[k]; return x.word + (onlyCol ? '' : ' for ' + x.cols.join(', ')) + '. ' + x.why; });
  }
  function wrapAll(list, size, maxW, wt) { var out = []; list.forEach(function (t) { out = out.concat(wrap(t, size, maxW, wt)); }); return out; }

  // The painted Confirm at the bottom of a screen: the change, what it is for, Confirm and Cancel. big: the paged view. The
  // texts wrap in the room the buttons leave, and the band grows with them (a long Confirm, like Allow on Shell commands).
  function confirmBand(p, view, big) {
    var W = view.w, H = view.h, bw = big ? 260 : 220, bt = big ? 92 : 64, tw = W - 96 - 2 * bw - 80;
    var hs = big ? 42 : 30, ws = big ? 30 : 22, hl = hs + 6, wl = ws + 6, gap = big ? 46 : 34;
    var head = wrap(confirmText(view.pending), hs, tw, 600), what = wrap(confirmWhat(view.pending), ws, tw, 400);
    var hb = Math.round(hs * 1.4), bh = Math.max(big ? 132 : 96, hb + (head.length - 1) * hl + gap + (what.length - 1) * wl + 20), by = H - bh - 28;
    fill(p, 48, by, W - 96, bh, 'pendingBand', 16);
    para(p, 76, by + hb, hs, hl, 'onPending', head, { wt: 600, maxW: tw });
    para(p, 76, by + hb + (head.length - 1) * hl + gap, ws, wl, 'onPending', what, { maxW: tw });
    hot(p, button(p, W - 48 - 2 * bw - 30, by + (bh - bt) / 2, bw, bt, 'Confirm', big ? 42 : 30, { kind: 'confirm', id: 'confirm' }, isHover(view, 'confirm'), 'primary'));
    hot(p, button(p, W - 48 - bw - 16, by + (bh - bt) / 2, bw, bt, 'Cancel', big ? 42 : 30, { kind: 'cancel', id: 'cancel' }, isHover(view, 'cancel')));
  }

  function hintOf(view) {
    return view.note || (!view.focused ? 'Click to look closer.' : view.screen === 'secrets' ? 'Click a cell to change it: Ask or Deny.' : view.screen === 'agents' ? 'Click a cell to change it.' : 'Click a cell to change it: Ask, Allow, Deny.');
  }
  // The layout of a rules screen: the first level in which the grid, every reason (wrapped) and the hint fit. The last level
  // is the answer when none does. The reasons sit between the grid and the hint, the last reason a gap above the hint.
  function levelFor(view, data) {
    var rows = screenOf(view.screen).rows.length, W = view.w, H = view.h, rs = reasons(view, data), out;
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i], ls = wrapAll(rs, L.fs, W - 96, 400), hl = wrap(hintOf(view), L.hint, W - 96, 400);
      var hintTop = H - L.hintY - (hl.length - 1) * (L.hint + 4), last = hintTop - L.gap, first = last - Math.max(0, ls.length - 1) * L.lh;
      var end = L.y0 + 52 + rows * rowHOf(L, rows);
      out = { L: L, lines: ls, hint: hl, first: first, hintTop: hintTop, end: end };
      if (!ls.length || first - L.fs * 0.8 >= end + 16) break;
    }
    return out;
  }

  // The bottom of a full screen: the painted Confirm, else the reasons and a hint (or the last error).
  function footer(p, view, lay) {
    var W = view.w, L = lay.L;
    if (view.pending) { confirmBand(p, view, false); return; }
    para(p, 48, lay.first, L.fs, L.lh, 'muted', lay.lines, { maxW: W - 96 });
    para(p, 48, lay.hintTop, L.hint, L.hint + 4, view.note ? 'error' : 'ink', lay.hint, { maxW: W - 96 });
  }

  // One agent kind at a time (below 700 px of free view): Previous and Next, big text. The reasons of the agent kind sit under
  // the rows, wrapped in full; the rows share what is left (84 to 140 px each), and a Confirm that needs more lines takes them.
  function pagedRows(p, view, data) {
    var sc = screenOf(view.screen), W = view.w, H = view.h, cols = S().columns, n = cols.length;
    var page = ((view.page || 0) % n + n) % n, col = cols[page];
    hot(p, button(p, 48, 108, 230, 80, 'Previous', 44, { kind: 'prev', id: 'prev' }, isHover(view, 'prev')));
    hot(p, button(p, W - 48 - 230, 108, 230, 80, 'Next', 44, { kind: 'next', id: 'next' }, isHover(view, 'next')));
    text(p, W / 2, 162, 48, 'ink', col.label + ' (' + (page + 1) + ' of ' + n + ')', { wt: 600, align: 'center', maxW: W - 600 });
    var rows = sc.rows, cw = 300, top = 210, tw = W - 96 - 500;
    // the bottom text: the last error, else the reasons of this agent kind, else the hint
    var rl = reasons(view, data, col.id), bs = view.note || !rl.length ? 32 : 30, blh = bs + 6;
    var bl = wrapAll(view.note ? [view.note] : rl.length ? rl : ['Click a value to change it.'], bs, W - 96, 400);
    var pend = view.pending && !isSpend(view.pending) && view.pending.col === col.id ? view.pending : null;
    var pl = pend ? wrap(confirmText(pend), 36, tw, 600) : [], pendNeed = pend ? pl.length * 42 + 28 : 0;
    var bottom = view.pending ? H - 20 : H - 30 - (bl.length - 1) * blh - bs * 0.8 - 12;
    var rowH = Math.max(84, Math.min(140, Math.floor((bottom - top) / Math.max(1, rows.length)))), small = rowH < 104, y = top;
    rows.forEach(function (row) {
      var r = S().rows[row], isP = pend && pend.row === row, rh = isP ? Math.max(rowH, pendNeed) : rowH, chH = Math.min(96, rowH - 28);
      fill(p, 48, y, W - 96, 2, 'line');
      if (isP) {
        var ph = rh - 12, bh2 = Math.min(chH, 92);
        fill(p, 48, y + 6, W - 96, ph, 'pendingBand', 16);
        para(p, 72, y + 6 + (ph - pl.length * 42) / 2 + 32, 36, 42, 'onPending', pl, { wt: 600, maxW: tw });
        hot(p, button(p, W - 48 - 460, y + (rh - bh2) / 2, 220, bh2, 'Confirm', 42, { kind: 'confirm', id: 'confirm' }, isHover(view, 'confirm'), 'primary'));
        hot(p, button(p, W - 48 - 228, y + (rh - bh2) / 2, 220, bh2, 'Cancel', 42, { kind: 'cancel', id: 'cancel' }, isHover(view, 'cancel')));
        y += rh; return;
      }
      var nt = S().applies(row, col.id) ? noteOf(data, view.scope, row, col.id) : null;
      var lb = y + rowH / 2 + (nt ? (small ? -2 : 0) : (small ? 16 : 18));
      text(p, 48, lb, small ? 44 : 52, 'ink', r.label, { maxW: W - 96 - cw - 24 });
      if (nt) text(p, 48, lb + (small ? 34 : 46), small ? 30 : 34, 'muted', nt.word + ' for this agent', { maxW: W - 96 - cw - 24 });   // 34: about 9 px on a 400 px screen
      if (!S().applies(row, col.id)) { text(p, W - 48 - cw / 2, y + rowH / 2 + 18, 44, 'muted', S().na(row, col.id), { align: 'center', maxW: cw }); y += rh; return; }
      var id = 'cell:' + row + '|' + col.id, cy = y + (rowH - chH) / 2;
      chip(p, W - 48 - cw, cy, cw, chH, shown(data, view.scope, row, col.id), 52, isHover(view, id), false);
      if (overridden(data, row, col.id)) p.items.push({ t: 'mark', x: W - 48 - 6, y: cy + 6, s: 26, c: 'accent' });
      hot(p, { kind: 'cell', id: id, row: row, col: col.id, x: W - 48 - cw - 6, y: cy - 6, w: cw + 12, h: chH + 12 });
      y += rh;
    });
    if (!view.pending) para(p, 48, H - 30 - (bl.length - 1) * blh, bs, blh, view.note ? 'error' : 'muted', bl, { maxW: W - 96 });
  }

  // The Spend screen: the default spend limit (minus, plus, click the value to type), cost this month, the extensions scope.
  function spend(p, view, data) {
    var W = view.w, H = view.h, sp = (data.sec && data.sec.spend) || {}, limit = +sp.limit || 0, big = view.paged;
    var s = big ? 46 : 28, y = big ? 120 : 168;
    text(p, 48, y + (big ? 60 : 44), s, 'ink', 'Spend limit, new sessions', { maxW: big ? W - 96 : 420 });
    var bx = big ? 48 : 480, by = big ? y + 84 : y, bh = big ? 96 : 64, bw = big ? 120 : 80, vw = big ? 340 : 240;
    hot(p, button(p, bx, by, bw, bh, { icon: 'remove' }, big ? 56 : 36, { kind: 'spend-minus', id: 'spend-minus' }, isHover(view, 'spend-minus')));
    var vx = bx + bw + 16, editing = !!view.edit, asking = isSpend(view.pending);
    if (asking) { fill(p, vx, by, vw, bh, 'pending', 12); text(p, vx + vw / 2, by + bh / 2 + s * 0.36, s, 'onPending', 'No limit?', { wt: 600, align: 'center', maxW: vw - 16 }); }
    else if (editing) { fill(p, vx, by, vw, bh, 'editFill', 12); stroke(p, vx, by, vw, bh, 'focus', 4, 12); }
    else { stroke(p, vx + 1.5, by + 1.5, vw - 3, bh - 3, isHover(view, 'spend-edit') ? 'focus' : 'line', 3, 12); }
    if (!asking) text(p, vx + vw / 2, by + bh / 2 + s * 0.36, s, 'ink', editing ? '$' + view.edit.text + '|' : limit > 0 ? money(limit) : 'No limit', { wt: 600, align: 'center', maxW: vw - 16, mono: editing });
    hot(p, { kind: 'spend-edit', id: 'spend-edit', x: vx, y: by, w: vw, h: bh });
    hot(p, button(p, vx + vw + 16, by, bw, bh, { icon: 'add' }, big ? 56 : 36, { kind: 'spend-plus', id: 'spend-plus' }, isHover(view, 'spend-plus')));
    y = by + bh + (big ? 40 : 34);
    fill(p, 48, y, W - 96, 2, 'line');
    text(p, 48, y + (big ? 56 : 46), s, 'ink', 'Cost, ' + monthName(sp.month), { maxW: W - 96 });
    var cols = S().columns, by2 = (sp.byColumn || {});
    function costWord(c) {
      if (c.free) return 'Free';   // a model on this machine: the local model and Agent Framework teams (vocab.js columns)
      if (c.id === 'claude-code') return money(+by2[c.id] || 0);
      var e = data.sec && data.sec.enforce && data.sec.enforce[c.id];
      // reports: every agent of the column reports cost (a cloud kind with its prices set, #24), so no spend is $0.00.
      return e && e.reason ? 'Not set up' : (by2[c.id] ? money(by2[c.id]) : e && e.reports ? money(0) : 'Not reported');
    }
    if (big) {
      var n = cols.length, page = ((view.page || 0) % n + n) % n, col = cols[page];
      var ny = y + 80;
      hot(p, button(p, 48, ny, 200, 80, 'Previous', 40, { kind: 'prev', id: 'prev' }, isHover(view, 'prev')));
      hot(p, button(p, W - 48 - 200, ny, 200, 80, 'Next', 40, { kind: 'next', id: 'next' }, isHover(view, 'next')));
      text(p, W / 2, ny + 54, 44, 'ink', col.label + ': ' + costWord(col), { wt: 600, align: 'center', maxW: W - 520 });
      y = ny + 110;
    } else {
      // the columns take the full width under the "Cost, month" line: right of the 480 px label column they were 142 px
      // each, and "Not reported" did not fit (review minor). With six kinds (#23) a cost word that does not fit at 28 px
      // takes 24 px.
      var gx = 48, colW = Math.floor((W - 48 - gx) / cols.length), gy = y + 66;
      heads(p, cols, gx, colW, 22, gy + 30, gy + 30);
      // One size for the row, up to 28 px, so that the longest word fits its column by the plan's estimate (seven kinds: 161 px).
      var longest = Math.max.apply(null, cols.map(function (c) { return costWord(c).length; }));
      var cs = Math.max(18, Math.min(28, Math.floor((colW - 8) / (longest * 0.62))));
      cols.forEach(function (c, i) {
        var w = costWord(c);
        text(p, gx + i * colW + colW / 2, gy + 68, cs, 'ink', w, { wt: 600, align: 'center', maxW: colW - 8, mono: c.id === 'claude-code' });
      });
      y = gy + 92;
    }
    fill(p, 48, y, W - 96, 2, 'line');
    if (asking) { confirmBand(p, view, big); return; }   // the band takes the bottom of the screen until Confirm or Cancel
    var es = big ? 40 : 26;
    para(p, 48, y + (big ? 56 : 44), es, es + 8, 'ink', wrap('Extensions: local or project scope only. User scope stays out of reach.', es, W - 96, 400), { maxW: W - 96 });
    var hint = view.note || (editing ? 'Type a number of dollars. Enter saves, Esc cancels. 0 means no limit.' : !view.focused ? 'Click to look closer.' : 'Minus and plus change the limit by $1. Click the value to type it.');
    var hs = big ? 32 : 24, hw = wrap(hint, hs, W - 96, 400);
    para(p, 48, H - 34 - (hw.length - 1) * (hs + 6), hs, hs + 6, view.note ? 'error' : big ? 'muted' : 'ink', hw, { maxW: W - 96 });
  }

  function plan(view, data) {
    var p = P(), W = view.w, H = view.h;
    fill(p, 0, 0, W, H, 'face');
    stroke(p, 5, 5, W - 10, H - 10, 'accent', 10);
    if (view.face === 'back') {   // the plate on the outside of the glass: the title, and the first step
      text(p, 48, 120, 72, 'ink', screenOf(view.screen).title, { wt: 600 });
      text(p, 48, 200, 34, 'muted', 'Security room screen. Click to look at it.', { maxW: W - 96 });
      return p;
    }
    var big = !!view.paged && view.focused;
    var v = big === view.paged ? view : Object.assign({}, view, { paged: big });
    header(p, v, data, big);
    if (view.screen === 'spend') { spend(p, v, data); return p; }
    if (sectionOf(v) === 'hq') { hqScreen(p, v, data, big); return p; }
    if (big) { pagedRows(p, v, data); return p; }
    var lay = levelFor(v, data);
    subtitle(p, v, data, lay.L);
    grid(p, v, data, lay.L);
    footer(p, v, lay);
    return p;
  }

  // The hotspot under a screen point. uv: { x, y }, x from the left edge and y from the bottom edge (0 to 1).
  function hotAt(p, uv, w, h) {
    if (!p || !uv) return null;
    var x = uv.x * w, y = (1 - uv.y) * h;
    for (var i = p.hots.length - 1; i >= 0; i--) { var z = p.hots[i]; if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return z; }
    return null;
  }

  function setBody(view, data, row, col, value, confirmed) {
    var b = { scope: view.scope === 'building' ? 'building' : 'office', row: row, col: col, value: value };
    if (b.scope === 'building') b.building = data.building;
    if (confirmed) b.confirmed = true;
    return { route: '/api/security/set', body: b };
  }
  function with_(view, o) { return Object.assign({}, view, { note: null }, o); }
  // A click on a hotspot: the next view, and maybe one change for the server.
  function step(view, h, data) {
    if (!h || view.busy) return { view: view };
    var sc = view.scope === 'building' ? 'building' : 'office', n = S().columns.length;
    switch (h.kind) {
      case 'scope': return { view: with_(view, { scope: h.scope, pending: null }) };
      case 'section': return { view: with_(view, { section: h.section, pending: null }) };
      // the Paperclip part (#76): Supervise in office waits for the painted Confirm, then sends one change for one agent
      case 'supervise': return { view: with_(view, { pending: { hq: h.agent, name: h.name } }) };
      case 'hq-prev': return { view: with_(view, { hqPage: (view.hqPage || 0) - 1, pending: null }) };
      case 'hq-next': return { view: with_(view, { hqPage: (view.hqPage || 0) + 1, pending: null }) };
      case 'prev': return { view: with_(view, { page: ((view.page || 0) - 1 + n) % n, pending: null }) };
      case 'next': return { view: with_(view, { page: ((view.page || 0) + 1) % n, pending: null }) };
      case 'cancel': return { view: with_(view, { pending: null }) };
      case 'confirm': {
        var pd = view.pending;
        if (!pd) return { view: view };
        if (isSpend(pd)) return { view: with_(view, { pending: null }), send: { route: '/api/settings/spend', body: { limit: pd.spend, confirmed: true } } };
        if (isHq(pd)) return { view: with_(view, { pending: null }), send: { route: '/api/paperclip/supervise', body: { agent: pd.hq, confirmed: true } } };
        return { view: with_(view, { pending: null }), send: setBody(view, data, pd.row, pd.col, pd.to, true) };
      }
      case 'cell': {
        var pend = view.pending && view.pending.row === h.row && view.pending.col === h.col ? view.pending : null;
        var cur = shown(data, sc, h.row, h.col);
        // a default Ask the agent decides by itself: the click sets Ask (a tightening, at once), and the office makes it ask
        if (!pend && unsetAsk(data, sc, h.row, h.col)) return { view: with_(view, { pending: null }), send: setBody(view, data, h.row, h.col, 'ask', false) };
        // a click on a cell that waits for its Confirm moves on to the next value (so Deny can be reached from Ask)
        var next = S().next(h.row, pend && pend.to !== null ? pend.to : cur);
        if (S().loosens(h.row, cur, next)) return { view: with_(view, { pending: { row: h.row, col: h.col, to: next, office: null } }) };
        return { view: with_(view, { pending: null }), send: setBody(view, data, h.row, h.col, next, false) };
      }
      case 'clear': {   // back to the office rule in this building, or office-wide back to the default
        var def = sc === 'office', now = shown(data, sc, h.row, h.col), office = def ? S().defaultOf(h.row, h.col) : S().valueOf(rulesOf(data), null, h.row, h.col);
        if (S().loosens(h.row, now, office)) return { view: with_(view, { pending: Object.assign({ row: h.row, col: h.col, to: null, office: office }, def ? { def: true } : {}) }) };
        return { view: with_(view, { pending: null }), send: setBody(Object.assign({}, view, { scope: sc }), data, h.row, h.col, null, false) };
      }
      case 'spend-minus': case 'spend-plus': {
        // Minus stops at $1: No limit (0) is never one click away (it needs the Confirm, after typing 0).
        var lim = +((data.sec && data.sec.spend && data.sec.spend.limit) || 0), up = h.kind === 'spend-plus';
        if (!up && lim <= 1) return { view: with_(view, { edit: null, pending: null, note: lim > 0 ? 'The lowest step is $1. Click the value to type a lower limit.' : null }) };
        var to = up ? Math.min(1000, Math.round(lim) + 1) : Math.max(1, Math.round(lim) - 1);
        return { view: with_(view, { edit: null, pending: null }), send: { route: '/api/settings/spend', body: { limit: to } } };
      }
      case 'spend-edit': {
        var l0 = +((data.sec && data.sec.spend && data.sec.spend.limit) || 0);
        return { view: with_(view, { edit: { text: l0 > 0 ? String(l0) : '' }, pending: null }) };
      }
      default: return { view: view };
    }
  }

  // A key while the Spend value is being typed: digits and one point, Backspace, Enter saves, Esc cancels.
  // A typed 0 (or nothing) is No limit: the loosest spend setting, so it waits for the painted Confirm like Allow does.
  function key(view, e, data) {
    if (!view.edit) return { view: view, taken: false };
    var k = e && e.key, t = view.edit.text;
    if (k === 'Escape') return { view: with_(view, { edit: null }), taken: true };
    if (k === 'Enter') {
      var n = t === '' ? 0 : Number(t);
      if (!isFinite(n) || n < 0 || n > 1000) return { view: Object.assign({}, view, { note: 'The spend limit is a number from 0 to 1000. 0 means no limit.' }), taken: true };
      if (n === 0) {
        var cur = +((data && data.sec && data.sec.spend && data.sec.spend.limit) || 0);
        return { view: with_(view, { edit: null, pending: data && cur === 0 ? null : { spend: 0 } }), taken: true };
      }
      return { view: with_(view, { edit: null }), send: { route: '/api/settings/spend', body: { limit: n } }, taken: true };
    }
    if (k === 'Backspace') return { view: with_(view, { edit: { text: t.slice(0, -1) } }), taken: true };
    if (/^[0-9]$/.test(k) && t.length < 7) return { view: with_(view, { edit: { text: t + k } }), taken: true };
    if (k === '.' && t.indexOf('.') < 0 && t.length < 6) return { view: with_(view, { edit: { text: t + k } }), taken: true };
    return { view: view, taken: k && k.length === 1 };   // other printable keys do nothing while typing
  }

  // Tone names to token colors: the only colors the screens paint. The face is scene-dark: text is the bubble color, status
  // tones mix into the face. t: the first token that is set; or: a tone when none is; mix: [a, b, k], k of b in a (like
  // THREE.Color.lerp; three r147 mixes in sRGB). test/contrast.test.mjs checks every text on the fill under it at 4.5:1.
  // The Confirm cell and band are status-waiting-on-bubble with ink (bubble) text: the DS pair for amber words on a bubble,
  // so it reads at 4.5:1 both ways; ink on raw status-waiting did not in Day and Sublevel (review minor).
  var TONES = {
    face: { t: ['scene-dark'] }, ink: { t: ['bubble'] }, muted: { mix: ['ink', 'face', 0.42] }, line: { mix: ['ink', 'face', 0.7] },
    accent: { t: ['type-security', 'accent'] }, focus: { t: ['accent'] },
    allowFill: { mix: [{ t: ['status-working'] }, 'face', 0.45] }, denyFill: { mix: [{ t: ['status-error'] }, 'face', 0.4] }, askFill: 'face',
    pending: { t: ['status-waiting-on-bubble'] }, pendingBand: 'pending', onPending: 'ink',
    primary: { t: ['accent'] }, onPrimary: { t: ['on-accent'], or: 'ink' },
    buttonFill: { mix: ['ink', 'face', 0.82] }, editFill: { mix: ['ink', 'face', 0.88] }, error: { mix: [{ t: ['status-error'] }, 'ink', 0.5] }
  };
  // tok(name) -> a color or nothing; mix(a, b, k) -> a color. Returns tone name -> color.
  function toneColors(tok, mixFn) {
    var out = {};
    function get(x) {
      if (typeof x === 'string') { if (!Object.prototype.hasOwnProperty.call(out, x)) out[x] = get(TONES[x]); return out[x]; }
      if (x.t) { for (var i = 0; i < x.t.length; i++) { var c = tok(x.t[i]); if (c) return c; } return x.or ? get(x.or) : null; }
      return mixFn(get(x.mix[0]), get(x.mix[1]), x.mix[2]);
    }
    Object.keys(TONES).forEach(get);
    return out;
  }

  // One agent kind at a time when the screen in focus cannot be wide: the width it can take is the free width, or the free
  // height times its aspect (a wide but short free view frames it small too; review M6). free: the host's free rect, or null.
  function pagedFor(free, aspect) {
    if (!free) return false;
    return Math.min(free.right - free.left, (free.bottom - free.top) * (aspect || 1)) < PAGED_BELOW;
  }

  var pure = { plan: plan, hotAt: hotAt, step: step, key: key, pagedFor: pagedFor, wrap: wrap, charW: charW, noteOf: noteOf, levelFor: levelFor, PAGED_BELOW: PAGED_BELOW, CANVAS_W: CANVAS_W, TONES: TONES, toneColors: toneColors };

  // ---------- browser ----------
  // opts: { host, data() -> data, post(route, body) -> Promise, onError(text) }
  function attach(office, opts) {
    opts = opts || {};
    var T = root.THREE, host = opts.host, st = null;
    try { st = office.inspect().stage; } catch (x) { st = null; }
    if (!T || !host || !st) return { open: function () { return false; }, refresh: function () {}, dispose: function () {} };
    var K = st.K, dead = false, room = null, items = [], views = {}, scope = 'office', edit = null, lastTok = K.tok, busy = false;
    function tk(k) { return K.tok[k]; }
    function mix(a, b, t) { try { return '#' + new T.Color(a).lerp(new T.Color(b), t).getHexString(); } catch (e) { return a; } }
    // Tone names to token colors. The face is scene-dark: text is the bubble color, status tones mix into the face.
    function colors() { return toneColors(tk, mix); }
    function viewOf(it) {
      var v = views[it.screen] || (views[it.screen] = { page: 0, pending: null, hover: null, note: null });
      var f = host.focused(), focused = !!f && f.key === keyOf(it);
      var paged = pagedFor(focused ? host.free() : null, it.w / it.h);
      return { screen: it.screen, w: it.w, h: it.h, focused: focused, paged: paged, page: v.page, scope: scope, pending: v.pending, edit: it.screen === 'spend' ? edit : null,
        hover: focused ? v.hover : null, busy: busy, note: v.note, section: v.section || 'kinds', hqPage: v.hqPage || 0 };
    }
    function keyOf(it) { return 'security:' + it.screen; }
    function newTex(w, h) {
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var tex = new T.CanvasTexture(cv); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
      return { canvas: cv, tex: tex };
    }
    function take(mesh, w, h) {   // our picture on the engine's screen plane (its own picture is freed)
      var t = newTex(w, h), mt = mesh.material;
      if (mt.map && mt.map !== t.tex) mt.map.dispose();
      mt.map = t.tex; mt.emissive = new T.Color(0xffffff); mt.emissiveMap = t.tex; mt.emissiveIntensity = 0.5; mt.needsUpdate = true;
      return t;
    }
    function rr(c, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    function clipW(c, s, maxW) {
      s = String(s || '');
      if (!maxW || c.measureText(s).width <= maxW) return s;
      while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      return s + '…';
    }
    function paint(c, p) {
      var col = colors(), f = K.f || {}, sl = K.look === 'sublevel';
      p.items.forEach(function (d) {
        var cc = col[d.c] || col.ink;
        if (d.t === 'fill') { c.fillStyle = cc; if (d.r) { rr(c, d.x, d.y, d.w, d.h, d.r); c.fill(); } else c.fillRect(d.x, d.y, d.w, d.h); }
        else if (d.t === 'stroke') { c.strokeStyle = cc; c.lineWidth = d.lw; if (d.r) { rr(c, d.x, d.y, d.w, d.h, d.r); c.stroke(); } else c.strokeRect(d.x, d.y, d.w, d.h); }
        else if (d.t === 'mark') { c.fillStyle = cc; c.beginPath(); c.moveTo(d.x - d.s, d.y); c.lineTo(d.x, d.y); c.lineTo(d.x, d.y + d.s); c.closePath(); c.fill(); }
        else if (d.t === 'icon') {   // a DS icon (24 x 24 path data, stroked like the DS Icon component)
          var svg = (root.AgentOffice && root.AgentOffice.ICONS && root.AgentOffice.ICONS[d.name]) || '', re = /\sd="([^"]+)"/g, m;
          c.save(); c.translate(d.x, d.y); c.scale(d.s / 24, d.s / 24);
          c.strokeStyle = cc; c.lineWidth = 2.25; c.lineCap = 'round'; c.lineJoin = 'round';
          while ((m = re.exec(svg))) c.stroke(new Path2D(m[1]));
          c.restore();
        }
        else if (d.t === 'text') {
          c.fillStyle = cc; c.textAlign = d.align; c.textBaseline = 'alphabetic';
          c.font = d.wt + ' ' + d.s + 'px ' + (d.mono ? f.mono || 'monospace' : f.sans || 'sans-serif');
          c.fillText(clipW(c, sl && d.s >= 56 ? d.text.toUpperCase() : d.text, d.maxW), d.x, d.y);
        }
      });
      c.textAlign = 'left';
    }

    // ----- scan: the Security room of the shown floor, its six screens (DS slots 0 to 5 are the vocabulary's screens in order) -----
    function scan() {
      var x = host.rooms().filter(function (r) { return r.room.type === 'security'; })[0];
      if (!x) { if (room && !host.inScene(room.rg)) drop(); return; }
      if (room && room.rg === x.rg) return;
      drop();
      var screens = S().screens, by = {};
      x.rg.children.forEach(function (m) { var u = m.userData; if (u && u.secSlot != null && m.geometry && m.geometry.parameters) (by[u.secSlot] = by[u.secSlot] || {})[u.secFace] = m; });
      var raised = root.OfficeBoard && root.OfficeBoard.raiseRoom ? root.OfficeBoard.raiseRoom(x.rg) : [];
      room = { rg: x.rg, id: x.room.id, raised: raised };
      items = Object.keys(by).map(function (k) {
        var slot = +k, s = by[k], front = s.front;
        if (!front || !screens[slot]) return null;
        var g = front.geometry.parameters, w = CANVAS_W, h = Math.round(CANVAS_W * g.height / g.width);
        var it = { screen: screens[slot].id, slot: slot, front: front, back: s.back || null, w: w, h: h, sig: '', bsig: '', g: 0, tgt: 0 };
        it.tex = take(front, w, h); front.userData.secItem = it;
        if (it.back) { it.btex = take(it.back, w, h); it.back.userData.secItem = it; }
        return it;
      }).filter(Boolean);
      refresh();
    }
    function drop() {
      if (!room) return;
      items.forEach(function (it) { it.tex.tex.dispose(); if (it.btex) it.btex.tex.dispose(); delete it.front.userData.secItem; if (it.back) delete it.back.userData.secItem; });
      if (root.OfficeBoard && root.OfficeBoard.lowerRoom && host.inScene(room.rg)) root.OfficeBoard.lowerRoom(room.raised);
      room = null; items = [];
    }
    var plans = {};
    function refresh() {
      if (dead) return;
      if (K.tok !== lastTok) { lastTok = K.tok; items.forEach(function (it) { it.sig = ''; it.bsig = ''; }); }
      var data = opts.data ? opts.data() : null;
      if (!data) return;
      var dsig = JSON.stringify(data) + K.look;
      items.forEach(function (it) {
        var v = viewOf(it), sig = dsig + JSON.stringify(v);
        if (sig !== it.sig) {
          it.sig = sig;
          var p = plans[it.screen] = plan(v, data);
          paint(it.tex.canvas.getContext('2d'), p); it.tex.tex.needsUpdate = true;
        }
        if (it.back) {
          var bs = K.look + v.screen + lastTok;
          if (bs !== it.bsig) { it.bsig = bs; paint(it.btex.canvas.getContext('2d'), plan(Object.assign({}, v, { face: 'back' }), data)); it.btex.tex.needsUpdate = true; }
        }
      });
    }

    function send(s, it) {
      if (!s) return;
      busy = true; refresh();
      Promise.resolve(opts.post ? opts.post(s.route, s.body) : null).then(function () {
        busy = false; refresh();
      }, function (e) {
        busy = false;
        var v = views[it.screen]; if (v) v.note = e && e.message ? e.message : 'The office did not take the change.';
        if (opts.onError) opts.onError(v && v.note);
        refresh();
      });
    }
    function apply(it, r) {
      var v = views[it.screen] || (views[it.screen] = { page: 0, pending: null, hover: null, note: null });
      v.page = r.view.page; v.pending = r.view.pending; v.note = r.view.note || null; v.section = r.view.section || 'kinds'; v.hqPage = r.view.hqPage || 0;
      if (r.view.scope !== scope) { scope = r.view.scope; Object.keys(views).forEach(function (k) { views[k].pending = null; }); }
      if (it.screen === 'spend') {
        // typing starts: no text field keeps the focus, so the digits go to the wall and nowhere else
        if (r.view.edit && !edit && document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
        edit = r.view.edit || null;
      }
      refresh();
      send(r.send, it);
    }

    // ----- the pick target: look first (the host flies), then every click in focus is a hotspot click -----
    var target = {
      name: 'security',
      active: function () { return !dead && !!room; },
      meshes: function () { var m = []; items.forEach(function (it) { m.push(it.front); if (it.back) m.push(it.back); }); return m; },
      itemOf: function (mesh) { return mesh.userData.secItem || null; },
      hover: function (it, hit) {
        items.forEach(function (x) { x.tgt = x === it ? 1 : 0; });
        if (!it) { items.forEach(function (x) { var v = views[x.screen]; if (v && v.hover) { v.hover = null; } }); refresh(); return; }
        var v = views[it.screen] || (views[it.screen] = { page: 0, pending: null, hover: null, note: null });
        var h = hit && hit.object === it.front ? hotAt(plans[it.screen], hit.uv, it.w, it.h) : null;
        var id = h ? h.id : null;
        if (id !== v.hover) { v.hover = id; refresh(); }
      },
      // the plane to face is always the front: a click on the outside plate of a right-wall screen flies into the room
      look: function (it) { return { key: keyOf(it), mesh: it.front, verb: '', kind: 'security', clear: 1.2 }; },
      open: function (it, hit) {
        if (!it || !hit || hit.object !== it.front) return;
        refresh();   // the plan of the view the user sees now (paged or not)
        var h = hotAt(plans[it.screen], hit.uv, it.w, it.h);
        if (!h) return;
        apply(it, step(viewOf(it), h, opts.data()));
      },
      find: function (key) { var it = items.filter(function (x) { return keyOf(x) === key && host.inScene(x.front); })[0]; return it ? { item: it, mesh: it.front } : null; },
      anchors: function () { return room ? [room.rg] : []; }
    };
    var offTarget = host.register(target);
    var offRebuild = host.onRebuild(function () { try { scan(); refresh(); } catch (x) { /* the timer tries again */ } });
    var offFocus = host.onFocus(function (f) {
      if (!f || f.kind !== 'security') { if (edit) { edit = null; } Object.keys(views).forEach(function (k) { views[k].pending = null; views[k].hover = null; }); }
      refresh();
    });
    // glow: a screen under the pointer lights up a little (instant with reduced motion)
    var offFrame = host.frame(function (dt) {
      if (dead) return;
      var k = st.rm ? 1 : Math.min(1, dt * 10);
      items.forEach(function (it) {
        if (it.g === it.tgt) return;
        it.g += (it.tgt - it.g) * k; if (Math.abs(it.tgt - it.g) < 0.01) it.g = it.tgt;
        [it.front, it.back].forEach(function (m) { if (m) m.material.emissiveIntensity = 0.5 + 0.3 * it.g; });
      });
    });
    // typing the Spend value: keys go to the wall only while it is being typed (Esc then cancels the typing, not the look)
    function onKey(e) {
      if (!edit || dead) return;
      var it = items.filter(function (x) { return x.screen === 'spend'; })[0];
      if (!it) return;
      var r = key(viewOf(it), e, opts.data());
      if (!r.taken) return;
      e.preventDefault(); e.stopPropagation();
      apply(it, r);
    }
    window.addEventListener('keydown', onKey, true);
    var timer = setInterval(function () { if (st.dead) { dispose(); return; } try { scan(); refresh(); } catch (x) { /* next time */ } }, 1500);
    try { scan(); } catch (x) { /* the first rebuild tries again */ }

    // The keyboard path to the room (Ctrl+K Permissions): show its floor, then look at a screen (Files by default).
    var want = null;
    function open(screenId) {
      if (dead) return false;
      var o = office, bl = o.getBuilding && o.getBuilding(), fl = null, rid = opts.roomId ? opts.roomId() : null;
      ((bl && bl.floors) || []).forEach(function (f) { (f.rooms || []).forEach(function (r) { if (r.type === 'security' && (!rid || r.id === rid)) fl = f; }); });
      if (!fl) return false;
      // From the building view the floor comes with the engine's framing (and its intro the first time): about 3 s.
      want = { screen: screenId || 'files', until: Date.now() + 10000 };
      var ins = o.inspect ? o.inspect() : null;
      if (!ins || ins.floor !== fl.id || host.inBuilding()) { if (o.setFloor) o.setFloor(fl.id); }
      tryOpen();
      return true;
    }
    function tryOpen() {
      if (!want) return;
      if (Date.now() > want.until) { want = null; return; }
      try { scan(); } catch (x) { /* next frame */ }
      var it = items.filter(function (x) { return x.screen === want.screen; })[0];
      // the flight starts once the engine's own camera moves (a floor goal, the intro) are over
      if (it && host.onShownFloor(it.front, host.shownFloor()) && !st.goal && !st.intro && host.show(target, it, false)) want = null;
    }
    var offWant = host.frame(function () { if (want) tryOpen(); });

    function dispose() {
      if (dead) return;
      dead = true; clearInterval(timer);
      window.removeEventListener('keydown', onKey, true);
      offTarget(); offRebuild(); offFocus(); offFrame(); offWant();
      drop();
    }
    return { open: open, refresh: refresh, dispose: dispose, roomShown: function () { return !!room; } };
  }

  root.OfficeSecurity = { attach: attach, pure: pure };
})(typeof globalThis !== 'undefined' ? globalThis : window);
