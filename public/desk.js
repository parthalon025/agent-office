/* Agent Office for Claude Code x0.2: desk actions (#90, spec #88 phase 2).
   A host adapter like lobby.js and terminal.js. The user acts on agents through objects on and at the desk, not through a dialog
   or a bar:
   - Approval paper: a permission request is a paper on the agent's desk with an Approve and a Decline stamp, the time left before
     the office stops holding the request, and Always allow when the request offers it. The first click looks at the paper, a click
     on a stamp acts. A high-risk paper (never Always allow) takes the Approve stamp and then a painted Confirm in another spot.
   - Question note: a question is a note on the desk. Its look is its use: a pinned text field lies over it once the camera lands
     (the page, layer kind 'note'), and the typed answer goes to the agent as the next message.
   - Pause key on the monitor bezel: look at it, then click it to stop the turn (o.onPause).
   - An empty desk starts an agent with two clicks: lobby.js owns that (its open desks), the page starts the agent at once.
     The open desk starts an agent at once in the room's workspace (deskStart in office.js, default kind); Open session in
     Ctrl+K keeps the form. There is no request bar: the requests are on the desk.
   Every control is a box on a plane. Its hit area is padded to at least HIT px (44) around its centre at the size the plane has on
   screen (the host's hitBox, hitAt). Below NARROW px of width a paper shows one large Approve (or Confirm) and a Decline strip.
   Pure part (window.OfficeDesk.pure; tested in test/desk.test.mjs): plan, step, timeLeft, ACTIONS, paletteActions, FACES.
   Browser part: attach(office, { host, targets() -> building.deskTargets, session(botName), onAnswer(paper, { allow, always }),
   onPause(uid) }). It reads the stage only through the host and office.inspect().bots, and never moves a bot or the
   camera: the host flies. Colors come from DS tokens (K.tok) through FACES. Ctrl+K reaches every action (paletteActions). */
(function (root) {
  'use strict';
  var Kit = root.OfficeScreenKit;

  // ---------- pure ----------
  var HIT = 44;       // the least hit area of a control, in px
  var NARROW = 600;   // below this width of the page, a focused paper shows one large action
  var FACES = {
    paper: { face: 'bubble', ink: 'scene-dark', band: 'status-waiting-on-bubble', high: 'status-error-on-bubble' },
    stamp: { face: 'scene-dark', ink: 'bubble' },
    note: { face: 'bubble', ink: 'scene-dark', band: 'status-waiting-on-bubble' },
    key: { face: 'scene-dark', ink: 'bubble' }
  };
  // Every action an object in the scene takes. The Ctrl+K palette has each one (paletteActions; test/desk.test.mjs checks it).
  var ACTIONS = [
    { id: 'desk-start', label: 'Start an agent at an open desk' },
    { id: 'paper-approve', label: 'Approve' },
    { id: 'paper-confirm', label: 'Confirm the approval of a high-risk request' },
    { id: 'paper-decline', label: 'Decline' },
    { id: 'paper-always', label: 'Approve and always allow' },
    { id: 'note-answer', label: 'Answer a question' },
    { id: 'pause', label: 'Pause the turn' }
  ];

  // The controls of a paper in uv units of its plane (0 to 1 from the bottom left). stage: 'ask' or 'confirm' (a high-risk paper
  // after its Approve stamp). The Approve stamp and the Confirm are in two spots a hand cannot cover with one click.
  function plan(paper, stage, narrow) {
    var high = !!(paper && paper.high), out = [];
    if (high && stage === 'confirm') {
      out.push({ id: 'confirm', label: 'Confirm', tone: 'go', rect: narrow ? { x: 0.05, y: 0.54, w: 0.9, h: 0.18 } : { x: 0.52, y: 0.36, w: 0.43, h: 0.22 } });
      out.push({ id: 'cancel', label: 'Cancel', tone: 'quiet', rect: narrow ? { x: 0.05, y: 0.22, w: 0.9, h: 0.26 } : { x: 0.05, y: 0.36, w: 0.43, h: 0.22 } });
    } else if (narrow) {
      out.push({ id: 'approve', label: 'Approve', tone: 'go', rect: { x: 0.05, y: 0.22, w: 0.9, h: 0.26 } });
    } else {
      out.push({ id: 'approve', label: 'Approve', tone: 'go', rect: { x: 0.05, y: 0.06, w: 0.43, h: 0.22 } });
    }
    if (!(high && stage === 'confirm') && paper && paper.always && !high && !narrow) out.push({ id: 'always', label: 'Always allow', tone: 'quiet', rect: { x: 0.05, y: 0.31, w: 0.9, h: 0.1 } });
    out.push({ id: 'decline', label: 'Decline', tone: 'quiet', rect: narrow ? { x: 0.05, y: 0.04, w: 0.9, h: 0.14 } : { x: 0.52, y: 0.06, w: 0.43, h: 0.22 } });
    return out;
  }

  // One click on a control. stages: { paperId: 'confirm' } for the high-risk papers after Approve. Returns { stages, act }, act null
  // or { allow, always }. A high-risk paper answers yes only after Approve and then Confirm, two controls in two spots; Always allow
  // is never taken for it.
  function step(stages, paper, ctl) {
    var st = Object.assign({}, stages || {}), id = paper && paper.id, none = { stages: st, act: null };
    if (!paper || !ctl) return none;
    if (ctl === 'decline') { delete st[id]; return { stages: st, act: { allow: false, always: false } }; }
    if (ctl === 'cancel') { delete st[id]; return { stages: st, act: null }; }
    if (ctl === 'approve') {
      if (st[id] === 'confirm') return none;   // a second click on the same spot only after a Confirm that is not there
      if (paper.high) { st[id] = 'confirm'; return { stages: st, act: null }; }
      return { stages: st, act: { allow: true, always: false } };
    }
    if (ctl === 'confirm') {
      if (!paper.high || st[id] !== 'confirm') return none;
      delete st[id];
      return { stages: st, act: { allow: true, always: false } };
    }
    if (ctl === 'always') return paper.high || !paper.always ? none : { stages: st, act: { allow: true, always: true } };
    return none;
  }

  // The time left before the office stops holding a request, in words. 0 or an unknown deadline says nothing is known.
  function timeLeft(until, now) {
    if (!(until > 0)) return '';
    var ms = until - now;
    if (ms <= 0) return 'Timed out';
    var s = Math.ceil(ms / 1000);
    if (s < 100) return s + ' s left';
    var m = Math.ceil(s / 60);
    return m < 100 ? m + ' min left' : Math.ceil(m / 60) + ' h left';
  }
  // The share of the hold that is gone, 0 to 1, for the bar on the paper.
  function spent(paper, now) {
    if (!paper || !(paper.until > 0) || !(paper.t > 0)) return 0;
    return Math.max(0, Math.min(1, (now - paper.t) / (paper.until - paper.t)));
  }

  // The Ctrl+K entries for the scene's actions, from the building's desk targets (building.deskTargets), the stages of the high-risk
  // papers and the open sessions of the building. Each entry: { action (an ACTIONS id), id, label, ref }. A high-risk paper has
  // Approve; once Approve was taken, Confirm.
  function paletteActions(targets, stages, sessions) {
    var out = [], t = targets || { papers: [], notes: [], empty: [] }, st = stages || {};
    function add(action, id, label, ref) { out.push({ action: action, id: action + ':' + id, label: label, ref: ref }); }
    t.empty.forEach(function (e) { add('desk-start', e.roomId, 'Start an agent on ' + (e.name || e.floorKey), e); });
    t.papers.forEach(function (p) {
      var who = p.bot + ' · ' + p.tool;
      if (p.high && st[p.id] === 'confirm') add('paper-confirm', p.id, 'Confirm high-risk approval: ' + who, p);
      else add('paper-approve', p.id, (p.high ? 'Approve (high risk, asks again): ' : 'Approve: ') + who, p);
      add('paper-decline', p.id, 'Decline: ' + who, p);
      if (p.always && !p.high) add('paper-always', p.id, 'Approve and always allow: ' + who, p);
    });
    t.notes.forEach(function (n) { add('note-answer', n.id, 'Answer ' + n.bot, n); });
    (sessions || []).forEach(function (s) {
      if (s && s.headless && (s.status === 'working' || s.status === 'waiting')) add('pause', s.uid, 'Pause the turn of ' + s.name, s);
    });
    return out;
  }
  // The lines painted on a paper: the head, the request and the reason, cut to the lines it holds by the caller.
  function paperText(p) {
    return { head: p.bot + (p.high ? ' · high risk' : ''), body: p.text, reason: p.reason ? 'Reason: ' + p.reason : '' };
  }

  var pure = { plan: plan, step: step, timeLeft: timeLeft, spent: spent, paletteActions: paletteActions, paperText: paperText, ACTIONS: ACTIONS, FACES: FACES, HIT: HIT, NARROW: NARROW };

  // ---------- browser ----------
  var T0 = root.THREE;
  function cssNum(name, fallback) { try { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; } catch (x) { return fallback; } }
  var NOOP = { refresh: function () {}, dispose: function () {}, act: function () { return false; }, items: function () { return []; }, stages: function () { return {}; }, show: function () { return false; } };
  function attach(office, o) {
    o = o || {};
    var T = root.THREE, host = o.host, st = null;
    try { var i0 = office && office.inspect && office.inspect(); st = i0 && i0.stage; } catch (x) { st = null; }
    if (!T || !host || !st || !st.scene || !st.K || !st.r || !st.cam) return NOOP;
    var K = st.K, dead = false, items = [], stages = {}, lastTok = K.tok, hover = null, hoverCtl = null;
    var SH = root.OfficeSceneHost.pure, V3 = new T.Vector3(), BX = new T.Box3();
    var W = 640, H = 480;   // the paper's canvas (4:3)

    function stamp(c, ctl, w, h, hot) {
      var r = ctl.rect, x = r.x * w, y = (1 - r.y - r.h) * h, bw = r.w * w, bh = r.h * h, F = FACES.stamp, tok = K.tok;
      c.fillStyle = ctl.tone === 'go' ? tok[F.face] : tok[FACES.paper.face];
      c.strokeStyle = ctl.tone === 'go' ? tok[F.face] : tok[FACES.paper.ink];
      c.lineWidth = hot ? 10 : 6;
      c.beginPath(); c.rect(x, y, bw, bh); c.fill(); c.stroke();
      c.fillStyle = ctl.tone === 'go' ? tok[F.ink] : tok[FACES.paper.ink];
      c.font = Kit.font(K, Math.round(bh * 0.46), 700); c.textBaseline = 'middle'; c.textAlign = 'center';
      c.fillText(ctl.label, x + bw / 2, y + bh / 2 + 2); c.textAlign = 'left';
    }
    function paintPaper(it) {
      var c = it.canvas.getContext('2d'), tok = K.tok, F = FACES.paper, p = it.data, narrow = it.narrow, now = Date.now();
      c.clearRect(0, 0, W, H);
      c.fillStyle = tok[F.face]; c.fillRect(0, 0, W, H);
      c.fillStyle = tok[p.high ? F.high : F.band]; c.fillRect(0, 0, W, 16);
      c.strokeStyle = tok[F.ink]; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
      c.fillStyle = tok[F.ink]; c.textBaseline = 'top';
      var tx = paperText(p), left = timeLeft(p.until, now), stage = stages[p.id] === 'confirm';
      var lw = 0;
      if (left) { c.font = Kit.font(K, 28, 600, true); lw = c.measureText(left).width + 20; c.textAlign = 'right'; c.fillText(left, W - 28, 36); c.textAlign = 'left'; }
      c.font = Kit.font(K, 34, 700); c.fillText(Kit.wrap(c, tx.head, W - 56 - lw, { lines: 1, clip: '' })[0] || '', 28, 34);
      var sp = spent(p, now);
      if (left) { c.fillRect(28, 78, (W - 56) * (1 - sp), 6); }
      c.font = Kit.font(K, 30, 500);
      var y = 100, lines = stage ? ['This request is high risk. Confirm to approve it.'] : Kit.wrap(c, tx.body, W - 56, { lines: narrow ? 2 : 3, clip: '' });
      lines.forEach(function (l) { c.fillText(l, 28, y); y += 38; });
      if (!stage && tx.reason && !narrow) { c.font = Kit.font(K, 24, 500); Kit.wrap(c, tx.reason, W - 56, { lines: 1, clip: '' }).forEach(function (l) { c.fillText(l, 28, y + 2); }); }
      plan(p, stage ? 'confirm' : 'ask', narrow).forEach(function (ctl) { stamp(c, ctl, W, H, hover === it && hoverCtl === ctl.id); });
      it.tex.needsUpdate = true;
    }
    function paintNote(it) {
      var c = it.canvas.getContext('2d'), tok = K.tok, F = FACES.note, n = it.data;
      c.fillStyle = tok[F.face]; c.fillRect(0, 0, W, H);
      c.fillStyle = tok[F.band]; c.fillRect(0, 0, W, 16);
      c.strokeStyle = tok[F.ink]; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
      c.fillStyle = tok[F.ink]; c.textBaseline = 'top';
      c.font = Kit.font(K, 34, 700); c.fillText(n.bot + ' asks', 28, 34);
      c.font = Kit.font(K, 32, 500); var y = 100;
      Kit.wrap(c, n.text, W - 56, { lines: 5, clip: '' }).forEach(function (l) { c.fillText(l, 28, y); y += 42; });
      c.font = Kit.font(K, 26, 600); c.fillText(hover === it ? 'Click again to answer' : 'Click to read and answer', 28, H - 56);
      it.tex.needsUpdate = true;
    }
    function paintKey(it) {
      var c = it.canvas.getContext('2d'), tok = K.tok, F = FACES.key, w = it.canvas.width, h = it.canvas.height;
      c.fillStyle = tok[F.face]; c.fillRect(0, 0, w, h);
      c.strokeStyle = tok[F.ink]; c.lineWidth = hover === it ? 8 : 4; c.strokeRect(2, 2, w - 4, h - 4);
      c.fillStyle = tok[F.ink]; c.font = Kit.font(K, Math.round(h * 0.5), 700); c.textBaseline = 'middle'; c.textAlign = 'center';
      c.fillText('Pause', w / 2, h / 2 + 2); c.textAlign = 'left';
      it.tex.needsUpdate = true;
    }
    function paint(it) { if (it.kind === 'paper') paintPaper(it); else if (it.kind === 'note') paintNote(it); else paintKey(it); }

    // ----- scene objects -----
    function makeMesh(kind, size, cw, ch) {
      var t = Kit.newTex(cw, ch), mt = new T.MeshBasicMaterial({ map: t.tex, transparent: true, side: T.DoubleSide, toneMapped: false });
      mt.fog = false;
      var m = new T.Mesh(new T.PlaneGeometry(size[0], size[1]), mt);
      m.renderOrder = 800; m.layers.set(1); m.userData.noNav = 1; m.userData.deskObj = true; m.name = 'desk-' + kind;
      return { mesh: m, tex: t.tex, canvas: t.canvas };
    }
    function drop(it) { if (it.mesh.parent) it.mesh.parent.remove(it.mesh); it.tex.dispose(); it.mesh.material.dispose(); it.mesh.geometry.dispose(); }
    function botsOf() {
      var ins = null; try { ins = office.inspect(); } catch (x) { ins = null; }
      return ((ins && ins.bots) || []).filter(function (b) { return b && b.g && b.seat && !b.ephemeral && b.floor === ins.floor; });
    }
    // Put each object where it belongs on its bot's desk: the paper in front of the monitor, the note beside it, the key under the
    // monitor's right corner. They face the camera (a paper on a desk seen from a fixed angle would be a sliver).
    function scan() {
      var t = o.targets ? o.targets() : { papers: [], notes: [], empty: [] }, bots = botsOf(), fg = host.shownFloor(), want = {};
      var byName = {}; bots.forEach(function (b) { byName[b.name] = b; });
      function need(kind, id, bot, data, size, cw, ch, place) {
        var b = byName[bot];
        var g = b && host.floorOf(b.g);
        if (!g || g !== fg) return;
        var key = kind + ':' + id; want[key] = true;
        var it = items.filter(function (x) { return x.key === key; })[0];
        if (it && it.mesh.parent !== g) { if (hover === it) { hover = null; hoverCtl = null; } drop(it); items = items.filter(function (x) { return x !== it; }); it = null; }
        if (!it) {
          var m = makeMesh(kind, size, cw, ch);
          it = { key: key, kind: kind, id: id, bot: bot, uid: data.uid, mesh: m.mesh, tex: m.tex, canvas: m.canvas, sig: '', narrow: false };
          g.add(it.mesh); items.push(it);
        }
        it.data = data; it.place = place; it.b = b;
        place(it, b, g);
      }
      t.papers.forEach(function (p, i) { need('paper', p.id, p.bot, p, [1.1, 0.825], W, H, function (it, b) { it.mesh.position.set(b.seat.x - 0.15 - 0.12 * i, 1.32 + 0.05 * i, b.seat.z + 0.45); }); });
      t.notes.forEach(function (n, i) { need('note', n.id, n.bot, n, [0.6, 0.45], W, H, function (it, b) { it.mesh.position.set(b.seat.x + 0.62 + 0.1 * i, 1.28 + 0.05 * i, b.seat.z + 0.4); }); });
      var sess = (o.sessions ? o.sessions() : []);
      sess.forEach(function (s) {
        if (!(s && s.headless && (s.status === 'working' || s.status === 'waiting'))) return;
        var b = byName[s.botName];
        if (!b || !b.screens || !b.screens[0]) return;
        need('key', s.uid, s.botName, { uid: s.uid, name: s.name }, [0.34, 0.14], 256, 104, function (it, bb, g) {
          BX.setFromObject(b.screens[0]); BX.getCenter(V3);
          V3.x = BX.max.x - 0.28; V3.y = BX.min.y - 0.12;
          it.mesh.position.copy(g.worldToLocal(V3.clone()));
        });
      });
      items = items.filter(function (it) {
        if (want[it.key] && host.inScene(it.mesh)) return true;
        if (hover === it) { hover = null; hoverCtl = null; }
        drop(it); return false;
      });
      // a high-risk paper whose hold ended (timeout, answered in the chat, session gone) keeps no stage
      var ids = {}; t.papers.forEach(function (p) { ids[p.id] = true; });
      Object.keys(stages).forEach(function (k) { if (!ids[k]) delete stages[k]; });
    }
    function face() { items.forEach(function (it) { it.mesh.quaternion.copy(st.cam.quaternion); }); }
    function px(it) { var r = host.rect(it.mesh); return r ? { w: r.width, h: r.height } : null; }
    function ctlsOf(it) { return it.kind === 'paper' ? plan(it.data, stages[it.data.id] === 'confirm' ? 'confirm' : 'ask', it.narrow) : []; }
    function refresh() {
      if (dead) return;
      scan();
      var narrow = (root.innerWidth || 1360) < NARROW, now = Math.floor(Date.now() / 1000);
      items.forEach(function (it) {
        it.narrow = narrow;
        var sig = [it.kind, it.data && it.data.text, it.data && it.data.until, stages[it.id] || '', narrow, hover === it, hoverCtl, it.kind === 'paper' ? now : 0, K.tok === lastTok].join('|');
        if (it.sig === sig) return;
        it.sig = sig; paint(it);
      });
      lastTok = K.tok;
    }

    // ----- picks -----
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
    function ctlAt(it, hit) {
      if (!it || it.kind !== 'paper' || !hit || !hit.uv) return null;
      var f = host.focused(); if (!f || f.key !== keyOf(it)) return null;
      var pp = px(it);
      return pp ? SH.hitAt(ctlsOf(it), hit.uv, pp, HIT) : null;
    }
    function keyOf(it) { return 'desk:' + it.key; }
    function verbOf(it, ctl) {
      var f = host.focused(), on = f && f.key === keyOf(it);
      if (it.kind === 'paper') return !on ? 'Look at the request' : ctl ? ({ approve: 'Approve', confirm: 'Confirm', decline: 'Decline', always: 'Always allow', cancel: 'Cancel' })[ctl] : 'Choose a stamp';
      if (it.kind === 'note') return on ? 'Answer the question' : 'Look at the question';
      return on ? 'Pause the turn' : 'Look at the pause key';
    }
    var target = {
      name: 'desk',
      active: function () { return !dead; },
      meshes: function () { return items.filter(function (it) { return host.shown(it.mesh); }).map(function (it) { return it.mesh; }); },
      itemOf: function (mesh) { return items.filter(function (it) { return it.mesh === mesh; })[0] || null; },
      hover: function (it, hit) {
        var ctl = ctlAt(it, hit);
        if (it !== hover || ctl !== hoverCtl) { hover = it; hoverCtl = ctl; refresh(); }
        setHint(it ? verbOf(it, ctl) : '', hit && hit.point);
      },
      // a paper and a note are looked at close; the key is a small plane, so the camera shows its monitor around it
      look: function (it) {
        var narrow = (root.innerWidth || 1360) < NARROW;
        // a note is a pinned screen: once the camera lands, the page lays its text field over it (o.layer, kind 'note')
        return { key: keyOf(it), mesh: it.mesh, verb: it.kind === 'key' ? 'Pause' : '', kind: it.kind === 'note' ? 'note' : 'desk', pin: it.kind === 'note', fill: it.kind === 'key' ? 0.12 : it.kind === 'note' ? (narrow ? 0.95 : 0.7) : narrow ? 0.9 : 0.5, clear: 0 };
      },
      // the second click: a stamp of a paper, the note's text field, the pause key
      open: function (it, hit) {
        if (it.kind === 'paper') { var ctl = ctlAt(it, hit); if (ctl) press(it, ctl); }
        else if (it.kind === 'key' && o.onPause) o.onPause(it.data.uid);
      },
      find: function (key) { var it = items.filter(function (x) { return keyOf(x) === key && host.inScene(x.mesh); })[0]; return it ? { item: it, mesh: it.mesh } : null; },
      anchors: function () { return []; }
    };

    // One control pressed: through step() (the rules), then the page answers the hold.
    function press(it, ctl) {
      var r = step(stages, it.data, ctl);
      stages = r.stages; it.sig = '';
      if (r.act && o.onAnswer) o.onAnswer(it.data, r.act);
      refresh();
    }
    // The keyboard path (Ctrl+K): the same rules as a click. Returns true when it did something.
    function act(action, id) {
      if (dead) return false;
      scan();
      var it = items.filter(function (x) { return x.id === id; })[0], paper = it && it.kind === 'paper' ? it : null;
      var data = paper ? paper.data : (o.targets ? o.targets().papers.filter(function (p) { return p.id === id; })[0] : null);
      if (action === 'paper-approve' || action === 'paper-confirm' || action === 'paper-decline' || action === 'paper-always') {
        if (!data) return false;
        var r = step(stages, data, { 'paper-approve': 'approve', 'paper-confirm': 'confirm', 'paper-decline': 'decline', 'paper-always': 'always' }[action]);
        stages = r.stages; if (paper) paper.sig = '';
        if (r.act && o.onAnswer) o.onAnswer(data, r.act);
        refresh();
        return true;
      }
      if (action === 'note-answer') return show(id, false);   // looking at the note opens its pinned field
      if (action === 'pause') { if (o.onPause) { o.onPause(id); return true; } return false; }
      return false;
    }

    // look at the paper, note or key of a request (the Needs you go-to, Ctrl+K), and with open take the second step too
    function show(id, open) {
      scan();
      var it = items.filter(function (x) { return x.id === id; })[0];
      return !!it && host.show(target, it, !!open);
    }
    function paintFrame(dt) {
      if (dead) return;
      face();
      if (!hint) return;
      var op = hint.material.opacity;
      if (op !== hintOn) { op += (hintOn - op) * (st.rm ? 1 : Math.min(1, dt * 9)); if (Math.abs(hintOn - op) < 0.02) op = hintOn; hint.material.opacity = op; }
      hint.visible = op > 0 && !!hint.material.map;
      if (hint.visible) placeHint();
    }
    var free = host.screen({ target: target, rebuild: refresh, frame: paintFrame, tick: refresh, every: 1000, gone: function () { return st.dead; }, onGone: function () { dispose(); } });
    try { refresh(); } catch (x) { /* the first tick tries again */ }

    function dispose() {
      if (dead) return;
      dead = true; free();
      items.forEach(drop); items = [];
      if (hint) { if (hint.parent) hint.parent.remove(hint); if (hint.material.map) hint.material.map.dispose(); hint.material.dispose(); hint = null; }
    }
    return {
      refresh: refresh, dispose: dispose, act: act,
      stages: function () { return Object.assign({}, stages); },
      // the objects on the shown floor, for tests and the console
      items: function () { return items.map(function (it) { return { kind: it.kind, id: it.id, bot: it.bot, shown: host.shown(it.mesh) }; }); },
      show: show
    };
  }

  root.OfficeDesk = { attach: attach, pure: pure };
})(typeof globalThis !== 'undefined' ? globalThis : window);
