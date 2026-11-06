/* Agent Office for Claude Code x0.2: the lobby and the desks (#92).
   A host adapter like board.js and terminal.js: the engine builds the Reception (DS office type lobby) and the open desks
   (room.spare); this file repaints the reception memo and the directory board, makes the open desks and the memo clickable,
   puts a nameplate on each bot's desk, and runs the lobby tour's flights.
   - An open desk takes two clicks (the scene host runs the steps): the first looks at it, the second starts an agent there,
     with the floor's role (o.onDesk). Its hit box is padded past the desk (the DS builds it). Its monitor (a DS desk screen,
     K.screens) is the tour's monitor stop when no agent's monitor is on the floor (o.monitor, terminal.js look).
   - The memo on the reception desk: the archetype memo until the user confirms it, then the Since you left lines. Two clicks:
     look, then open the Reception (o.onReception).
   - The directory board on the Reception's back wall lists every floor, top floor first, with its wing, its agents and the worst
     state of its desks. Two clicks: look, then open the search (o.onReception('directory')).
   - The pipeline board on the Reception's back wall draws the eight stages of the building's changes (#93, o.changes). Two clicks: look,
     then open the pipeline dialog (o.onReception('pipeline')). The DS paper props (ready tray, cabinet, archive box) get their count
     from the same data (propCounts, userData.setCount); the page never builds them.
   - A nameplate stands at each bot's desk: name, model lane (Haiku, Sonnet, Opus, Fable) and cost. It faces the camera and keeps
     the DS body and caption sizes on screen at every zoom (plateBox; #92 review: a plate on the desk was 2 px text at the floor's zoom).
   Pure part (window.OfficeLobby.pure; tested in test/lobby.test.mjs): tourSteps, tourDue, plateLines, plateBox, directoryRows, memoLines,
   FACES and dotOf (the painted colors, test/contrast.test.mjs).
   It reads the stage only through the host (rooms, shown floor, pick targets, frames) and office.inspect().bots, like terminal.js.
   It never moves a bot. Colors come from DS tokens (K.tok). */
(function (root) {
  'use strict';
  var V = root.OfficeVocab, F = root.OfficeFormat, Kit = root.OfficeScreenKit;

  // ---------- pure ----------
  // The lobby tour: four stops, once per browser, replayed from the Reception. key: what the camera looks at.
  var TOUR = [
    { key: 'desk', title: 'An open desk', text: 'Click a desk once to look at it, and again to start an agent there. The floor sets its role.' },
    { key: 'monitor', title: 'The desk monitor', text: 'Each agent works at a desk. Its monitor shows the terminal. Click the monitor to read it.' },
    { key: 'paper', title: 'The memo', text: 'The memo on the reception desk names the kind of building. Confirm it once, or change the floors at the Reception.' },
    { key: 'elevator', title: 'The elevator', text: 'Each floor is a function. A lit button has work or needs you. Empty floors are dimmed and skipped.' }
  ];
  function tourSteps() { return TOUR.map(function (s) { return { key: s.key, title: s.title, text: s.text }; }); }
  // The tour shows by itself once: when the user has not seen it and the office shows a building.
  function tourDue(seen, inOffice) { return !seen && !!inOffice; }
  // A desk's nameplate: the bot name, then its model lane and cost (unknown cost says so; no cost yet says nothing).
  function plateLines(name, s) {
    var lane = s ? V.laneOf(s.model) : '', cost = !s ? '' : s.costUnknown ? 'cost unknown' : typeof s.cost === 'number' ? (F ? F.cost(s.cost) : '$' + s.cost.toFixed(2)) : '';
    return { name: String(name || ''), detail: [lane, cost].filter(Boolean).join(' · ') };
  }
  // The box of a nameplate in CSS pixels, from the widths of its two lines measured at the DS sizes (body: the name, caption: the
  // lane and cost) and those sizes. pad: the side padding. The plate is as wide as its longer line, at most max; the lines are cut
  // to fit (with an ellipsis) beyond that. Returns { w, h, nameY, detailY } (the line middles, from the top).
  function plateBox(nameW, detailW, body, caption, pad, max) {
    var w = Math.min(max, Math.ceil(Math.max(nameW, detailW || 0)) + 2 * pad), h = Math.round(body * 1.45 + (detailW ? caption * 1.4 : 0) + pad);
    var top = pad / 2;
    return { w: Math.max(w, 2 * pad + body), h: h, nameY: top + body * 0.72, detailY: top + body * 1.45 + caption * 0.7 };
  }
  // Which nameplates show, from their boxes on screen ({ left, top, right, bottom } in CSS pixels, in a stable order): a box that
  // overlaps (gap pixels around it included) one shown before it waits, so two neighbouring desks at a narrow width never show
  // two plates on top of each other. Zooming in parts them, and both show. null (not on screen) shows nothing.
  function declutter(boxes, gap) {
    var shown = [], g = gap || 0;
    return (boxes || []).map(function (b) {
      if (!b) return false;
      var hit = shown.some(function (s) { return b.left < s.right + g && b.right + g > s.left && b.top < s.bottom + g && b.bottom + g > s.top; });
      if (!hit) shown.push(b);
      return !hit;
    });
  }
  // The directory board: one row per floor, top floor first. floors: [{ id, name, wingName }], agents: { floorId: [names] },
  // states: { floorId: state }. A row: { id, wing, name, agents, state, line }.
  function directoryRows(floors, agents, states) {
    return (floors || []).slice().reverse().map(function (f) {
      var a = (agents && agents[f.id]) || [], st = states && states[f.id];
      var who = a.length ? (a.length <= 2 ? a.join(', ') : a.slice(0, 2).join(', ') + ' and ' + (a.length - 2) + ' more') : 'No agents';
      return { id: f.id, wing: f.wingName || '', name: f.name, agents: a.length, state: st || null, line: who + (st ? ' · ' + V.stateWord(st) : '') };
    });
  }
  // The reception memo. layout: the building's layout (snapshot.layouts); since: lines from Since you left, or [].
  function memoLines(layout, since) {
    if (!layout) return { title: 'Reception', lines: ['Open desks for agents with no role.', 'Click the memo for the floors.'] };
    if (!layout.confirmed) return { title: 'Confirm the building', lines: ['Proposed: ' + layout.proposedName + '.', layout.why || '', 'Click the memo to confirm or change it.'].filter(Boolean) };
    return { title: layout.archetypeName, lines: (since && since.length ? since.slice(0, 3) : ['Nothing new since you left.']).concat(['Click the memo for the floors and the tour.']) };
  }
  // The pipeline board (#93): the eight stages of the building's changes, one row each. c: the building's changes (building.js changes) or
  // null. A stage with no data says "No data", also when the read failed. rows: { id, name, count, text }; foot: the line under them.
  var STAGE_NAMES = [['intake', 'Intake'], ['build', 'Build'], ['check', 'Check'], ['review', 'Review'], ['gate', 'Gate'], ['merge', 'Merge'], ['release', 'Release'], ['record', 'Record']];
  function pipelineLines(c) {
    var by = {}; ((c && c.pipeline) || []).forEach(function (s) { by[s.id] = s; });
    var rows = STAGE_NAMES.map(function (n) {
      var s = by[n[0]], none = !s || s.unknown || (c && c.unknown), count = none ? 0 : s.count | 0;
      return { id: n[0], name: n[1], count: count, text: none ? 'No data' : String(count) };
    });
    var foot = !c ? '' : c.unknown ? (c.line || '') : (c.mergedToday | 0) + ' merged today';
    return { rows: rows, foot: foot };
  }
  // What each paper prop holds (the DS parts of the Reception): the ready tray, the inbox and outbox trays, the cabinet and the archive
  // box, by the place of each folder (building.js folderAt). A building whose changes are unknown shows empty props.
  function propCounts(c) {
    var n = { ready: 0, inbox: 0, outbox: 0, cabinet: 0, archive: 0 };
    if (!c || c.unknown) return n;
    n.ready = (c.tray || []).length;
    (c.folders || []).forEach(function (f) { if (f.place === 'inbox' || f.place === 'outbox' || f.place === 'cabinet' || f.place === 'archive') n[f.place]++; });
    return n;
  }
  // The painted faces, as DS token names. The memo and the directory board are paper in every theme (bubble, scene-dark ink, like
  // the notes card); the nameplate is the reverse. A lighter line keeps `alpha` of its ink over its face. A state dot on paper is the
  // on-bubble tone of its state (dot: the token suffix), since a raw status color is a fill and reads under 3:1 on paper at night; a
  // state with no such token (review, #93) is ink. test/contrast.test.mjs checks every pair in every theme.
  var FACES = {
    memo: { face: 'bubble', ink: 'scene-dark', band: 'status-waiting-on-bubble' },
    directory: { face: 'bubble', ink: 'scene-dark', wingAlpha: 0.7, dot: '-on-bubble' },
    plate: { face: 'scene-dark', ink: 'bubble', detailAlpha: 0.85 },
    pipeline: { face: 'bubble', ink: 'scene-dark', mutedAlpha: 0.7, barAlpha: 0.85 }
  };
  function dotOf(tok, state) { var t = state && tok['status-' + state + FACES.directory.dot]; return t || tok[FACES.directory.ink]; }
  var pure = { tourSteps: tourSteps, tourDue: tourDue, plateLines: plateLines, plateBox: plateBox, declutter: declutter, directoryRows: directoryRows, memoLines: memoLines, pipelineLines: pipelineLines, propCounts: propCounts, FACES: FACES, dotOf: dotOf };

  // ---------- browser ----------
  function cssNum(name, fallback) { try { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; } catch (x) { return fallback; } }
  function attach(office, o) {
    o = o || {};
    var T = root.THREE, host = o.host, ins0 = null;
    try { ins0 = office && office.inspect && office.inspect(); } catch (x) { ins0 = null; }
    var st = ins0 && ins0.stage;
    var none = { refresh: function () {}, tour: function () { return false; }, dispose: function () {}, items: function () { return []; }, idle: function () { return false; }, desk: function () { return false; } };
    if (!T || !st || !host) return none;
    var K = st.K, dead = false, lastTok = K.tok;
    var desks = [], boards = [], plates = [], props = [];   // { mesh, ... } of the shown floor; a desk also has its monitor (screen) when it has one
    var paintedSig = {};


    // ----- paint -----
    // The faces and inks are FACES (pure, checked for contrast): paper for the memo and the directory, the reverse for a nameplate.
    function paintMemo(c, w, h, m) {
      var tok = K.tok, F0 = FACES.memo;
      c.fillStyle = tok[F0.face]; c.fillRect(0, 0, w, h);
      c.fillStyle = tok[F0.band]; c.fillRect(0, 0, w, 14);
      c.strokeStyle = tok[F0.ink]; c.lineWidth = 6; c.strokeRect(3, 3, w - 6, h - 6);
      c.fillStyle = tok[F0.ink]; c.textBaseline = 'top';
      c.font = Kit.font(K, 46, 600); c.fillText(Kit.clip(c, m.title, w - 64), 32, 40);
      c.font = Kit.font(K, 30, 500);
      var y = 112;
      m.lines.forEach(function (l) { Kit.wrap(c, l, w - 64, { clip: '…' }).forEach(function (t) { if (y < h - 40) c.fillText(t, 32, y); y += 40; }); y += 6; });
    }
    function paintDirectory(c, w, h, rows) {
      var tok = K.tok, F0 = FACES.directory, ink = tok[F0.ink];
      c.fillStyle = tok[F0.face]; c.fillRect(0, 0, w, h);
      c.strokeStyle = ink; c.lineWidth = 14; c.strokeRect(7, 7, w - 14, h - 14);   // a frame, so the light board reads on a light wall
      c.fillStyle = ink; c.textBaseline = 'top';
      c.font = Kit.font(K, 44, 600); c.fillText('Directory', 32, 26);
      var y = 92, wing = null, lh = Math.max(26, Math.min(40, Math.floor((h - 110) / Math.max(1, rows.length * 1.35))));
      rows.forEach(function (r) {
        if (y > h - lh) return;
        if (r.wing && r.wing !== wing) { wing = r.wing; c.globalAlpha = F0.wingAlpha; c.font = Kit.font(K, Math.round(lh * 0.62), 600); c.fillText(r.wing.toUpperCase(), 32, y); c.globalAlpha = 1; y += Math.round(lh * 0.8); }
        if (r.state) { c.fillStyle = dotOf(tok, r.state); c.beginPath(); c.arc(44, y + lh * 0.42, lh * 0.22, 0, 7); c.fill(); }
        c.fillStyle = ink; c.font = Kit.font(K, Math.round(lh * 0.75), 600); c.fillText(Kit.clip(c, r.id + '  ' + r.name, w * 0.42), 70, y);
        c.font = Kit.font(K, Math.round(lh * 0.66), 400); c.fillText(Kit.clip(c, r.line, w * 0.5), w * 0.47, y + 2);
        y += lh;
      });
    }
    // A nameplate is drawn at PLATE_K canvas pixels per CSS pixel, so it is sharp on a dense screen too. Its box (plateBox) comes
    // from the DS body and caption sizes; the frame scales the sprite to that many CSS pixels at every zoom.
    var PLATE_K = 3, PLATE_PAD = 8, PLATE_MAX = 200;
    // The pipeline board: a bar per stage, as long as its count (a shape, not a color); "No data" is dimmer text with no bar.
    function paintPipeline(c, w, h, p) {
      var tok = K.tok, F0 = FACES.pipeline, ink = tok[F0.ink];
      c.fillStyle = tok[F0.face]; c.fillRect(0, 0, w, h);
      c.strokeStyle = ink; c.lineWidth = 14; c.strokeRect(7, 7, w - 14, h - 14);
      c.fillStyle = ink; c.textBaseline = 'top';
      c.font = Kit.font(K, 44, 600); c.fillText('Pipeline', 32, 26);
      var top = 92, foot = p.foot ? 44 : 0, lh = Math.max(24, Math.floor((h - top - foot - 24) / p.rows.length)), max = Math.max(1, p.rows.reduce(function (m, r) { return Math.max(m, r.count); }, 1));
      p.rows.forEach(function (r, i) {
        var y = top + i * lh, none = r.text === 'No data';
        c.globalAlpha = none ? F0.mutedAlpha : 1; c.font = Kit.font(K, Math.round(lh * 0.6), 600); c.fillText(r.name, 32, y);
        if (none) { c.font = Kit.font(K, Math.round(lh * 0.5), 500, true); c.fillText(r.text, 280, y + 2); }
        else {
          c.globalAlpha = F0.barAlpha; var bw = Math.round((w - 400) * r.count / max);
          if (bw > 0) c.fillRect(280, y + lh * 0.12, bw, lh * 0.5);
          c.globalAlpha = 1; c.font = Kit.font(K, Math.round(lh * 0.55), 600, true); c.fillText(r.text, 290 + bw, y);
        }
        c.globalAlpha = 1;
      });
      if (p.foot) { c.globalAlpha = F0.mutedAlpha; c.font = Kit.font(K, 26, 500); c.fillText(Kit.clip(c, p.foot, w - 64), 32, h - 56); c.globalAlpha = 1; }
    }
    function paintPlate(c, w, h, p, box, sz) {
      var tok = K.tok, F0 = FACES.plate, k = PLATE_K, pad = PLATE_PAD * k;
      c.fillStyle = tok[F0.face]; c.fillRect(0, 0, w, h);
      c.fillStyle = tok[F0.ink]; c.textBaseline = 'middle';
      c.font = Kit.font(K, sz.body * k, 600); c.fillText(Kit.clip(c, p.name, w - 2 * pad), pad, box.nameY * k);
      if (p.detail) { c.globalAlpha = F0.detailAlpha; c.font = Kit.font(K, sz.caption * k, 500, true); c.fillText(Kit.clip(c, p.detail, w - 2 * pad), pad, box.detailY * k); c.globalAlpha = 1; }
    }
    function repaint(b, sig, draw) {
      if (paintedSig[b.id] === sig && b.tex.image === b.canvas) return;
      paintedSig[b.id] = sig;
      draw(b.canvas.getContext('2d'), b.canvas.width, b.canvas.height);
      b.tex.needsUpdate = true;
    }

    // ----- scan the shown floor: open desks, the memo and the directory, the bots' desks -----
    function adopt(mesh, w, h, kind, roomId) {
      var t = Kit.newTex(w, h), mt = mesh.material;
      if (mt.map && mt.map !== t.tex) mt.map.dispose();
      mt.map = t.tex; if (mt.emissiveMap !== undefined) { mt.emissiveMap = t.tex; mt.emissive = new T.Color(0xffffff); mt.emissiveIntensity = 0.25; }
      mt.needsUpdate = true;
      var b = { kind: kind, mesh: mesh, roomId: roomId, tex: t.tex, canvas: t.canvas, id: kind + ':' + mesh.uuid };
      mesh.userData.lobbyItem = b;
      return b;
    }
    // A plate is a sprite: its texture and material are its own, its geometry is the one every three.js sprite shares (never freed here).
    function dropPlate(p) { if (p.mesh.parent) p.mesh.parent.remove(p.mesh); p.tex.dispose(); p.mesh.material.dispose(); }
    function scan() {
      var fg = host.shownFloor();
      desks = desks.filter(function (d) { return host.inScene(d.mesh); });
      props = props.filter(function (m) { return host.inScene(m); });
      boards = boards.filter(function (b) { if (host.inScene(b.mesh)) return true; b.tex.dispose(); return false; });
      host.rooms().forEach(function (x) {
        x.rg.traverse(function (m) {
          if (m.userData.spareHit && !desks.some(function (d) { return d.mesh === m; })) desks.push({ kind: 'desk', mesh: m, roomId: m.userData.spareDesk.room, i: m.userData.spareDesk.i, screen: screenOf(m.parent) });
          if (m.userData.setCount && m.userData.prop && props.indexOf(m) < 0) props.push(m);
          if (m.userData.lobby && !m.userData.lobbyItem) boards.push(adopt(m, 768, m.userData.lobby === 'memo' ? 520 : m.userData.lobby === 'pipeline' ? 528 : 470, m.userData.lobby, x.room.id));
        });
      });
      // nameplates: one per seated bot of the shown floor, on its desk
      var ins = null;
      try { ins = office.inspect(); } catch (x) { ins = null; }
      var bots = ((ins && ins.bots) || []).filter(function (b) { return b && b.g && b.seat && !b.ephemeral && b.floor === ins.floor; });
      plates = plates.filter(function (p) {
        var keep = host.inScene(p.mesh) && bots.some(function (b) { return b.name === p.bot && host.floorOf(b.g) === p.mesh.parent; });
        if (!keep) dropPlate(p);
        return keep;
      });
      bots.forEach(function (b) {
        var g = host.floorOf(b.g);
        if (!g || g !== fg || plates.some(function (p) { return p.bot === b.name; })) return;
        var t = Kit.newTex(8, 8);
        var m = new T.Sprite(new T.SpriteMaterial({ map: t.tex, transparent: true, depthTest: false, depthWrite: false }));
        m.material.fog = false; m.material.toneMapped = false; m.renderOrder = 900; m.layers.set(1);   // like the hint: no bloom, no light on it
        m.userData.noNav = 1; m.name = 'nameplate'; m.center.set(0, 0);   // its lower left corner at the desk's right edge
        m.position.set(b.seat.x + 0.9, 1.05, b.seat.z - 0.5);
        g.add(m);
        plates.push({ bot: b.name, mesh: m, tex: t.tex, canvas: t.canvas, box: null, id: 'plate:' + b.name + ':' + m.uuid });
      });
    }
    // The monitor of an open desk: the first DS desk screen (K.screens, Parts.screen) inside the desk's group.
    function screenOf(dg) {
      var list = K.screens || [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i] && list[i][0];
        for (var p = m; p; p = p.parent) if (p === dg) return m;
      }
      return null;
    }
    // An open desk's monitor as a look item of this target (the tour's monitor stop): the second step starts an agent there.
    function monitorOf(d) { return d && d.screen ? { kind: 'monitor', mesh: d.screen, roomId: d.roomId, i: d.i } : null; }
    function refresh() {
      if (dead) return;
      if (K.tok !== lastTok) { lastTok = K.tok; paintedSig = {}; }
      scan();
      boards.forEach(function (b) {
        if (b.kind === 'memo') { var m = memoLines(o.layout ? o.layout() : null, o.since ? o.since() : []); repaint(b, JSON.stringify(m), function (c, w, h) { paintMemo(c, w, h, m); }); }
        if (b.kind === 'pipeline') { var pl0 = pipelineLines(o.changes ? o.changes() : null); repaint(b, JSON.stringify(pl0), function (c, w, h) { paintPipeline(c, w, h, pl0); }); }
        if (b.kind === 'directory') {
          var rows = directoryRows(o.floors ? o.floors() : [], o.agents ? o.agents() : {}, o.states ? o.states() : {});
          repaint(b, JSON.stringify(rows), function (c, w, h) { paintDirectory(c, w, h, rows); });
        }
      });
      var pc = propCounts(o.changes ? o.changes() : null);
      props.forEach(function (m) { var k = m.userData.prop === 'tray' ? m.userData.kind : m.userData.prop; if (pc[k] != null) m.userData.setCount(pc[k]); });
      var sz = { body: cssNum('type-body-size', 13), caption: cssNum('type-caption-size', 11) };
      plates.forEach(function (p) {
        var pl = plateLines(p.bot, o.session ? o.session(p.bot) : null), sig = JSON.stringify(pl) + sz.body + '/' + sz.caption;
        if (paintedSig[p.id] === sig && p.tex.image === p.canvas) return;
        var c0 = p.canvas.getContext('2d');
        c0.font = Kit.font(K, sz.body, 600); var nw = c0.measureText(pl.name).width;
        c0.font = Kit.font(K, sz.caption, 500, true); var dw = pl.detail ? c0.measureText(pl.detail).width : 0;
        var box = plateBox(nw, dw, sz.body, sz.caption, PLATE_PAD, PLATE_MAX), W = Math.round(box.w * PLATE_K), H = Math.round(box.h * PLATE_K);
        if (p.canvas.width !== W || p.canvas.height !== H) {   // a new size needs a new texture: the old one was sent at its old size
          var nt = Kit.newTex(W, H); p.tex.dispose(); p.tex = nt.tex; p.canvas = nt.canvas; p.mesh.material.map = nt.tex; p.mesh.material.needsUpdate = true;
        }
        p.box = box;
        paintedSig[p.id] = sig;
        paintPlate(p.canvas.getContext('2d'), W, H, pl, box, sz);
        p.tex.needsUpdate = true;
      });
    }

    // ----- hover: the badge says what the next click does -----
    var hint = null, hintText = '', hintOn = 0, hintPoint = null;
    function setHint(text, point) {
      if (!root.OfficeBoard || !root.OfficeBoard.hintTex) return;
      if (!hint) {
        hint = new T.Sprite(new T.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
        hint.renderOrder = 1000; hint.userData.noNav = 1; hint.visible = false; hint.layers.set(1); hint.material.fog = false; hint.material.toneMapped = false;
        st.scene.add(hint);
      }
      if (!text) { hintOn = 0; return; }
      if (text !== hintText) { if (hint.material.map) hint.material.map.dispose(); hint.material.map = root.OfficeBoard.hintTex(text, K.tok, K.f || {}); hint.material.needsUpdate = true; hintText = text; }
      hintPoint = point.clone(); hintOn = 1;
    }
    function placeHint() {
      if (!hint || !hintPoint) return;
      var cv = st.r.domElement, wpp = (st.cam.top - st.cam.bottom) / (st.cam.zoom || 1) / (cv.clientHeight || 1), hpx = cssNum('type-title-size', 14) * 140 / 50, tw = (hint.material.map && hint.material.map.userData.w) || 560;
      hint.scale.set(hpx * tw / 140 * wpp, hpx * wpp, 1);
      var up = new T.Vector3(0, 1, 0).applyQuaternion(st.cam.quaternion);
      hint.position.copy(hintPoint).addScaledVector(up, (hpx / 2 + cssNum('space-2', 8)) * wpp);
    }
    var VERB = { desk: 'Start an agent here', memo: 'Open the Reception', directory: 'Search the office', pipeline: 'Open the pipeline', monitor: 'Start an agent here' };
    function keyOf(it) { return it.kind + ':' + it.roomId + (it.kind === 'desk' || it.kind === 'monitor' ? ':' + it.i : ''); }
    function hintOf(it) { var f = host.focused(); return f && f.key === keyOf(it) ? VERB[it.kind] : it.kind === 'desk' ? 'Look at the open desk' : 'Look closer'; }
    var target = {
      name: 'lobby',
      active: function () { return !dead; },
      meshes: function () { return desks.map(function (d) { return d.mesh; }).concat(boards.map(function (b) { return b.mesh; })); },
      itemOf: function (mesh) { return mesh.userData.lobbyItem || desks.filter(function (d) { return d.mesh === mesh; })[0] || null; },
      hover: function (it, hit) { setHint(it ? hintOf(it) : '', hit && hit.point); },
      // a desk is framed from its padded box; fill keeps the desk and its chair in view, with room for the hint
      // a monitor (the tour's stop) fills the free view like a terminal (the host's fill), cut clear of the chair in front
      look: function (it) {
        if (it.kind === 'monitor') return { key: keyOf(it), mesh: it.mesh, verb: VERB.monitor, kind: 'desk', clear: 0.5 };
        return { key: keyOf(it), mesh: it.mesh, verb: VERB[it.kind], kind: it.kind === 'desk' ? 'desk' : 'lobby', fill: it.kind === 'desk' ? 0.42 : 0.8, clear: it.kind === 'desk' ? 0 : 1.2 };
      },
      open: function (it) {
        if (it.kind === 'desk' || it.kind === 'monitor') { if (o.onDesk) o.onDesk(it.roomId, it.i); }
        else if (o.onReception) o.onReception(it.kind);
      },
      find: function (key) {
        var it = desks.concat(boards, desks.map(monitorOf).filter(Boolean)).filter(function (x) { return keyOf(x) === key && host.inScene(x.mesh); })[0];
        return it ? { item: it, mesh: it.mesh } : null;
      },
      anchors: function () { return []; }
    };
    var offTarget = host.register(target);
    var offRebuild = host.onRebuild(function () { try { refresh(); } catch (x) { /* the timer tries again */ } });
    var pv = null;
    function placePlates() {
      if (!plates.length) return;
      var cv = st.r.domElement, wpp = (st.cam.top - st.cam.bottom) / (st.cam.zoom || 1) / (cv.clientHeight || 1);
      var W = cv.clientWidth || 1, H = cv.clientHeight || 1;
      if (!pv) pv = new T.Vector3();
      // the screen box of each plate: its lower left corner (center 0, 0) projected, then its CSS size up and to the right
      var boxes = plates.map(function (p) {
        if (!p.box) return null;
        p.mesh.scale.set(p.box.w * wpp, p.box.h * wpp, 1);
        if (!host.shown(p.mesh.parent || p.mesh)) return null;
        p.mesh.getWorldPosition(pv); pv.project(st.cam);
        var x = (pv.x + 1) / 2 * W, y = (1 - pv.y) / 2 * H;
        return { left: x, top: y - p.box.h, right: x + p.box.w, bottom: y };
      });
      var show = declutter(boxes, 4);
      plates.forEach(function (p, i) { p.mesh.visible = !!show[i] || !boxes[i]; });
    }
    var offFrame = host.frame(function (dt) {
      placePlates();
      if (!hint) return;
      var op = hint.material.opacity;
      if (op !== hintOn) { op += (hintOn - op) * (st.rm ? 1 : Math.min(1, dt * 9)); if (Math.abs(hintOn - op) < 0.02) op = hintOn; hint.material.opacity = op; }
      hint.visible = op > 0 && !!hint.material.map;
      if (hint.visible) placeHint();
    });
    var timer = setInterval(function () { if (st.dead) { dispose(); return; } try { refresh(); } catch (x) { /* next time */ } }, 1500);
    try { refresh(); } catch (x) { /* the first frame tries again */ }

    // The tour's flights: look at the first open desk, at a monitor, or at the memo of the shown floor; the elevator is in the
    // HUD (back to the room). The monitor: an agent's on this floor (o.monitor, the terminal adapter flies), else the monitor of
    // the first open desk that has one (the Reception's desks always do). True when the camera flies.
    function tour(key) {
      if (dead) return false;
      try { scan(); } catch (x) { /* the lists are still good */ }
      var fg = host.shownFloor(), on = function (x) { return host.onShownFloor(x.mesh, fg); };
      if (key === 'desk') { var d = desks.filter(on)[0]; return !!d && host.show(target, d, false); }
      if (key === 'monitor') {
        var agent = false;
        try { agent = !!(o.monitor && o.monitor()); } catch (x) { agent = false; }
        if (agent) return true;
        var mo = desks.filter(on).map(monitorOf).filter(function (x) { return x && on(x); })[0];
        if (mo && host.show(target, mo, false)) return true;
      }
      if (key === 'paper') { var m = boards.filter(function (b) { return b.kind === 'memo' && on(b); })[0]; return !!m && host.show(target, m, false); }
      host.blur();
      return false;
    }
    function dispose() {
      if (dead) return;
      dead = true; clearInterval(timer); offTarget(); offRebuild(); offFrame(); host.leave();
      plates.forEach(dropPlate);
      boards.forEach(function (b) { delete b.mesh.userData.lobbyItem; });
      if (hint) { if (hint.parent) hint.parent.remove(hint); if (hint.material.map) hint.material.map.dispose(); hint.material.dispose(); hint = null; }
      desks = []; boards = []; plates = [];
    }
    return {
      refresh: refresh, tour: tour, dispose: dispose,
      // false while the engine's intro flight owns the camera: the tour waits for it
      idle: function () { return !dead && !st.intro; },
      // the lobby items of the shown floor, for tests and the console
      items: function () { return desks.map(function (d) { return { kind: 'desk', roomId: d.roomId, i: d.i, shown: host.shown(d.mesh) }; })
        .concat(boards.map(function (b) { return { kind: b.kind, roomId: b.roomId, shown: host.shown(b.mesh) }; }), plates.map(function (p) { return { kind: 'plate', bot: p.bot, shown: host.shown(p.mesh) }; })); },
      // the keyboard path (Ctrl+K): look at an open desk of a room, and with andOpen start the agent at once
      desk: function (roomId, andOpen) {
        try { scan(); } catch (x) { /* ok */ }
        var fg = host.shownFloor(), d = desks.filter(function (x) { return x.roomId === roomId && host.onShownFloor(x.mesh, fg); })[0];
        return !!d && host.show(target, d, !!andOpen);
      }
    };
  }

  root.OfficeLobby = { attach: attach, pure: pure };
})(typeof globalThis !== 'undefined' ? globalThis : window);
