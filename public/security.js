/* Agent Office for Claude Code x0.1: the Security room's wall screens (#70).
   The user picks the permission rules on six wall screens (Files, Commands, Network, Secrets, Agents, Spend) in the scene.
   The DS builds the room (type security) and its six screen planes; this file repaints them and handles clicks on them.
   A host adapter like board.js and terminal.js: it registers one pick target and a frame with the scene host, and it
   never raycasts, sets the cursor or moves the camera itself. A distinct job from board.js (the lab rooms' boards): in-scene
   controls with a painted Confirm, a paged view and typing on the wall.

   The screens take the host's two steps. The first click looks at a screen; in focus, every click is the second step, and
   the host gives the point of the click on the screen (hit.uv). A click on a cell cycles Ask, Allow, Deny (Secrets: Ask,
   Deny). A looser rule (to Allow, or an agent toggle to On) turns the cell amber and paints "Confirm: <change>" with Confirm
   and Cancel hotspots: no dialog. Ask and Deny apply at once. Below 700 px of free view a screen in focus shows one agent kind
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
     PAGED_BELOW         -> 700: below this free width (px) a screen in focus shows one agent kind
   view: { screen, w, h, focused, paged, page, scope, pending, edit, hover, busy, note, face }
   data: { sec (snap.security), building (key), buildingName } */
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
  function confirmText(p) { return 'Confirm: ' + (isSpend(p) ? 'No limit' : p.to === null ? (p.def ? 'the default (' : 'the office rule (') + S().word(p.office) + ')' : S().word(p.to)); }
  function confirmWhat(p) { return isSpend(p) ? 'Spend limit, new sessions' : S().rows[p.row].label + ', ' + colLabel(p.col); }
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
  // A value chip: words always, a status tone for Allow and Deny (DS: pair every status color with a word).
  function chip(p, x, y, w, h, v, s, hovered, pending) {
    if (pending) { fill(p, x, y, w, h, 'pending', h / 2); text(p, x + w / 2, y + h / 2 + s * 0.36, s, 'onPending', 'Confirm?', { wt: 600, align: 'center', maxW: w - 16 }); return; }
    var tn = tone(v);
    if (tn === 'ask') stroke(p, x + 1.5, y + 1.5, w - 3, h - 3, 'line', 3, h / 2);
    else fill(p, x, y, w, h, tn + 'Fill', h / 2);
    if (hovered) stroke(p, x - 5, y - 5, w + 10, h + 10, 'focus', 4, h / 2 + 5);
    text(p, x + w / 2, y + h / 2 + s * 0.36, s, 'ink', S().word(v), { wt: 600, align: 'center', maxW: w - 16 });
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
      var scope = view.scope === 'building' ? 'building' : 'office';
      if (big) {
        var id = 'scope', lbl = scope === 'building' ? 'This building' : 'All buildings', bw = 440;
        hot(p, button(p, W - 48 - bw, 22, bw, 80, lbl, 46, { kind: 'scope', id: id, scope: scope === 'building' ? 'office' : 'building' }, isHover(view, id)));
      } else {
        ['office', 'building'].forEach(function (s, i) {
          var id = 'scope-' + s, bw = 250, x = W - 48 - (2 - i) * (bw + 12) + 12, on = scope === s;
          if (on) fill(p, x, 30, bw, 58, 'accent', 29); else stroke(p, x + 1.5, 31.5, bw - 3, 55, 'line', 3, 29);
          if (isHover(view, id)) stroke(p, x - 5, 25, bw + 10, 68, 'focus', 4, 34);
          text(p, x + bw / 2, 30 + 29 + 10, 28, on ? 'onAccent' : 'ink', s === 'office' ? 'All buildings' : 'This building', { wt: 600, align: 'center', maxW: bw - 16 });
          hot(p, { kind: 'scope', id: id, scope: s, x: x, y: 30, w: bw, h: 58 });
        });
      }
    } else text(p, W - 48, big ? 80 : 74, big ? 40 : 28, 'muted', 'Office-wide', { align: 'right' });
  }

  // The subtitle under the header of a full screen.
  function subtitle(p, view, data) {
    var t;
    if (view.screen === 'spend') t = 'The spend limit of new sessions, and what each agent kind cost this month.';
    else if (view.screen === 'agents') t = 'Which agents may run. The office asks before a looser change.';
    else if (view.scope === 'building') t = 'Rules for ' + (data.buildingName || 'this building') + ' only. A corner mark: this building has its own rule.';
    else t = 'Rules for every building. A corner mark: this building has its own rule there.';
    text(p, 48, 132, 24, 'muted', t, { maxW: view.w - 96 });
  }

  // The rows of a rules or Agents screen as a grid: one column per agent kind.
  function grid(p, view, data) {
    var sc = screenOf(view.screen), W = view.w, x0 = 48, labelW = 380, gx = x0 + labelW, cols = S().columns;
    var colW = Math.floor((W - 48 - gx) / cols.length), y0 = 168, rowH = sc.rows.length > 2 ? 104 : 120;
    cols.forEach(function (c, i) { text(p, gx + i * colW + colW / 2, y0 + 30, 24, 'muted', c.label, { wt: 600, align: 'center', maxW: colW - 8 }); });
    var y = y0 + 52;
    sc.rows.forEach(function (row) {
      var r = S().rows[row];
      fill(p, x0, y, W - 96, 2, 'line');
      text(p, x0, y + rowH / 2 + 10, 28, 'ink', r.label, { maxW: labelW - 16 });
      cols.forEach(function (c, i) {
        var cx = gx + i * colW, cw = colW - 16, ch = 52, cy = y + 16;
        if (!S().applies(row, c.id)) { text(p, cx + colW / 2, cy + ch / 2 + 9, 22, 'muted', S().na(row, c.id), { align: 'center', maxW: colW - 8 }); return; }
        var id = 'cell:' + row + '|' + c.id, pend = view.pending && view.pending.row === row && view.pending.col === c.id;
        chip(p, cx + 8, cy, cw, ch, shown(data, view.scope, row, c.id), 24, isHover(view, id), pend);
        if (overridden(data, row, c.id) && !pend) p.items.push({ t: 'mark', x: cx + 8 + cw - 4, y: cy + 4, s: 18, c: 'accent' });
        hot(p, { kind: 'cell', id: id, row: row, col: c.id, x: cx + 4, y: cy - 4, w: cw + 8, h: ch + 8 });
        var nt = noteOf(data, view.scope, row, c.id);
        if (nt) text(p, cx + colW / 2, cy + ch + 26, 18, 'muted', nt.word, { align: 'center', maxW: colW - 8 });
        // Back to the office rule (a building override), or to the default (an office-wide rule the user set).
        var back = view.scope === 'building' ? overridden(data, row, c.id) && 'Use office rule' : officeSet(data, row, c.id) && 'Use default';
        if (back && !pend && view.focused) {
          var cid = 'clear:' + row + '|' + c.id;
          text(p, cx + colW / 2, cy + ch + 26 + (nt ? 22 : 0), 18, isHover(view, cid) ? 'ink' : 'muted', back, { align: 'center', maxW: colW - 8 });
          hot(p, { kind: 'clear', id: cid, row: row, col: c.id, x: cx + 4, y: cy + ch + 8, w: cw + 8, h: 26 });
        }
      });
      y += rowH;
    });
    return y;
  }

  // The reasons of the cells that are not or partly enforced, one line per reason: "Not enforced for Hermes, dsh. ...".
  function reasons(view, data) {
    var sc = screenOf(view.screen), by = {}, order = [];
    S().columns.forEach(function (c) {
      sc.rows.forEach(function (row) {
        if (!S().applies(row, c.id)) return;
        var nt = noteOf(data, view.scope, row, c.id);
        if (!nt) return;
        var k = nt.word + '\u0000' + nt.why;
        if (!by[k]) { by[k] = { word: nt.word, why: nt.why, cols: [] }; order.push(k); }
        if (by[k].cols.indexOf(c.label) < 0) by[k].cols.push(c.label);
      });
    });
    return order.map(function (k) { var x = by[k]; return x.word + ' for ' + x.cols.join(', ') + '. ' + x.why; });
  }

  // The painted Confirm at the bottom of a screen: the change, what it is for, Confirm and Cancel. big: the paged view.
  function confirmBand(p, view, big) {
    var W = view.w, H = view.h, bh = big ? 132 : 96, by = H - bh - 28, bw = big ? 260 : 220, bt = big ? 92 : 64;
    fill(p, 48, by, W - 96, bh, 'pendingBand', 16);
    text(p, 76, by + (big ? 58 : 42), big ? 42 : 30, 'onPending', confirmText(view.pending), { wt: 600, maxW: W - 96 - 2 * bw - 80 });
    text(p, 76, by + (big ? 104 : 76), big ? 30 : 22, 'onPending', confirmWhat(view.pending), { maxW: W - 96 - 2 * bw - 80 });
    hot(p, button(p, W - 48 - 2 * bw - 30, by + (bh - bt) / 2, bw, bt, 'Confirm', big ? 42 : 30, { kind: 'confirm', id: 'confirm' }, isHover(view, 'confirm'), 'primary'));
    hot(p, button(p, W - 48 - bw - 16, by + (bh - bt) / 2, bw, bt, 'Cancel', big ? 42 : 30, { kind: 'cancel', id: 'cancel' }, isHover(view, 'cancel')));
  }

  // The bottom of a full screen: the painted Confirm, else the reasons and a hint (or the last error).
  function footer(p, view, data, yTop) {
    var W = view.w, H = view.h;
    if (view.pending) { confirmBand(p, view, false); return; }
    var lines = reasons(view, data), y = Math.max(yTop + 34, H - 40 - 30 * (Math.min(lines.length, 3) + 1));
    lines.slice(0, 3).forEach(function (l) { text(p, 48, y, 21, 'muted', l, { maxW: W - 96 }); y += 30; });
    var hint = view.note || (!view.focused ? 'Click to look closer.' : view.screen === 'secrets' ? 'Click a cell to change it: Ask or Deny.' : view.screen === 'agents' ? 'Click a cell to change it.' : 'Click a cell to change it: Ask, Allow, Deny.');
    text(p, 48, H - 34, 24, view.note ? 'error' : 'ink', hint, { maxW: W - 96 });
  }

  // One agent kind at a time (below 700 px of free view): Previous and Next, big text.
  function pagedRows(p, view, data) {
    var sc = screenOf(view.screen), W = view.w, H = view.h, cols = S().columns, n = cols.length;
    var page = ((view.page || 0) % n + n) % n, col = cols[page];
    hot(p, button(p, 48, 108, 230, 80, 'Previous', 44, { kind: 'prev', id: 'prev' }, isHover(view, 'prev')));
    hot(p, button(p, W - 48 - 230, 108, 230, 80, 'Next', 44, { kind: 'next', id: 'next' }, isHover(view, 'next')));
    text(p, W / 2, 162, 48, 'ink', col.label + ' (' + (page + 1) + ' of ' + n + ')', { wt: 600, align: 'center', maxW: W - 600 });
    var rows = sc.rows, rowH = Math.min(140, Math.floor((H - 210 - 70) / Math.max(1, rows.length))), y = 210, cw = 300, chH = Math.min(96, rowH - 28);
    rows.forEach(function (row) {
      var r = S().rows[row], pend = view.pending && view.pending.row === row && view.pending.col === col.id;
      fill(p, 48, y, W - 96, 2, 'line');
      if (pend) {
        fill(p, 48, y + 6, W - 96, rowH - 12, 'pendingBand', 16);
        text(p, 72, y + rowH / 2 + 15, 40, 'onPending', confirmText(view.pending), { wt: 600, maxW: W - 96 - 500 });
        hot(p, button(p, W - 48 - 460, y + (rowH - chH) / 2, 220, chH, 'Confirm', 42, { kind: 'confirm', id: 'confirm' }, isHover(view, 'confirm'), 'primary'));
        hot(p, button(p, W - 48 - 228, y + (rowH - chH) / 2, 220, chH, 'Cancel', 42, { kind: 'cancel', id: 'cancel' }, isHover(view, 'cancel')));
        y += rowH; return;
      }
      var nt = S().applies(row, col.id) ? noteOf(data, view.scope, row, col.id) : null;
      text(p, 48, y + rowH / 2 + (nt ? 0 : 18), 52, 'ink', r.label, { maxW: W - 96 - cw - 24 });
      if (nt) text(p, 48, y + rowH / 2 + 44, 28, 'muted', nt.word + ' for this agent', { maxW: W - 96 - cw - 24 });
      if (!S().applies(row, col.id)) { text(p, W - 48 - cw / 2, y + rowH / 2 + 18, 44, 'muted', S().na(row, col.id), { align: 'center', maxW: cw }); y += rowH; return; }
      var id = 'cell:' + row + '|' + col.id, cy = y + (rowH - chH) / 2;
      chip(p, W - 48 - cw, cy, cw, chH, shown(data, view.scope, row, col.id), 52, isHover(view, id), false);
      if (overridden(data, row, col.id)) p.items.push({ t: 'mark', x: W - 48 - 6, y: cy + 6, s: 26, c: 'accent' });
      hot(p, { kind: 'cell', id: id, row: row, col: col.id, x: W - 48 - cw - 6, y: cy - 6, w: cw + 12, h: chH + 12 });
      y += rowH;
    });
    var why2 = sc.rows.map(function (row) { var n = S().applies(row, col.id) ? noteOf(data, view.scope, row, col.id) : null; return n ? n.why : ''; }).filter(Boolean)[0];
    if (!view.pending) text(p, 48, H - 30, 32, view.note ? 'error' : 'muted', view.note || (why2 ? why2 : 'Click a value to change it.'), { maxW: W - 96 });
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
      if (c.id === 'local') return 'Free';
      if (c.id === 'claude-code') return money(+by2[c.id] || 0);
      var e = data.sec && data.sec.enforce && data.sec.enforce[c.id];
      return e && e.reason ? 'Not set up' : (by2[c.id] ? money(by2[c.id]) : 'Not reported');
    }
    if (big) {
      var n = cols.length, page = ((view.page || 0) % n + n) % n, col = cols[page];
      var ny = y + 80;
      hot(p, button(p, 48, ny, 200, 80, 'Previous', 40, { kind: 'prev', id: 'prev' }, isHover(view, 'prev')));
      hot(p, button(p, W - 48 - 200, ny, 200, 80, 'Next', 40, { kind: 'next', id: 'next' }, isHover(view, 'next')));
      text(p, W / 2, ny + 54, 44, 'ink', col.label + ': ' + costWord(col), { wt: 600, align: 'center', maxW: W - 520 });
      y = ny + 110;
    } else {
      var gx = 480, colW = Math.floor((W - 48 - gx) / cols.length);
      cols.forEach(function (c, i) {
        text(p, gx + i * colW + colW / 2, y + 30, 22, 'muted', c.label, { wt: 600, align: 'center', maxW: colW - 8 });
        text(p, gx + i * colW + colW / 2, y + 68, 28, 'ink', costWord(c), { wt: 600, align: 'center', maxW: colW - 8, mono: c.id === 'claude-code' });
      });
      y += 100;
    }
    fill(p, 48, y, W - 96, 2, 'line');
    if (asking) { confirmBand(p, view, big); return; }   // the band takes the bottom of the screen until Confirm or Cancel
    text(p, 48, y + (big ? 56 : 44), big ? 40 : 26, 'ink', 'Extensions: local or project scope only. User scope stays out of reach.', { maxW: W - 96 });
    var hint = view.note || (editing ? 'Type a number of dollars. Enter saves, Esc cancels. 0 means no limit.' : !view.focused ? 'Click to look closer.' : 'Minus and plus change the limit by $1. Click the value to type it.');
    text(p, 48, H - 34, big ? 32 : 24, view.note ? 'error' : big ? 'muted' : 'ink', hint, { maxW: W - 96 });
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
    if (big) { pagedRows(p, v, data); return p; }
    subtitle(p, v, data);
    var y = grid(p, v, data);
    footer(p, v, data, y);
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
      case 'prev': return { view: with_(view, { page: ((view.page || 0) - 1 + n) % n, pending: null }) };
      case 'next': return { view: with_(view, { page: ((view.page || 0) + 1) % n, pending: null }) };
      case 'cancel': return { view: with_(view, { pending: null }) };
      case 'confirm': {
        var pd = view.pending;
        if (!pd) return { view: view };
        if (isSpend(pd)) return { view: with_(view, { pending: null }), send: { route: '/api/settings/spend', body: { limit: pd.spend, confirmed: true } } };
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

  var pure = { plan: plan, hotAt: hotAt, step: step, key: key, PAGED_BELOW: PAGED_BELOW, CANVAS_W: CANVAS_W };

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
    function colors() {
      var face = tk('scene-dark'), ink = tk('bubble');
      return { face: face, ink: ink, muted: mix(ink, face, 0.42), line: mix(ink, face, 0.7), accent: tk('type-security') || tk('accent'), onAccent: tk('bubble'),
        focus: tk('accent'), allowFill: mix(tk('status-working'), face, 0.45), denyFill: mix(tk('status-error'), face, 0.4), askFill: face,
        pending: tk('status-waiting'), pendingBand: tk('status-waiting'), onPending: face, primary: tk('accent'), onPrimary: tk('on-accent') || ink,
        buttonFill: mix(ink, face, 0.82), editFill: mix(ink, face, 0.88), error: mix(tk('status-error'), ink, 0.35) };
    }
    function viewOf(it) {
      var v = views[it.screen] || (views[it.screen] = { page: 0, pending: null, hover: null, note: null });
      var f = host.focused(), focused = !!f && f.key === keyOf(it);
      var fr = focused ? host.free() : null, paged = !!fr && (fr.right - fr.left) < PAGED_BELOW;
      return { screen: it.screen, w: it.w, h: it.h, focused: focused, paged: paged, page: v.page, scope: scope, pending: v.pending, edit: it.screen === 'spend' ? edit : null,
        hover: focused ? v.hover : null, busy: busy, note: v.note };
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
      v.page = r.view.page; v.pending = r.view.pending; v.note = r.view.note || null;
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
