/* Agent Office for Claude Code x0.1: the room board.
   The chalkboard on the back wall of each room becomes a live screen for the sessions in that room:
   the to-do list, what the browser tool (Playwright) does, the last tool calls, and the top of the
   repository with the folders the agents touched. A click on the board flies the camera to face it;
   the page then shows the same data in full (office.js, BoardPanel). Esc or Back flies out again.
   Colors and fonts come from the DS tokens. The engine draws the room; this file only repaints the
   board's picture and moves the camera on request.
   Each room also gets a notes board next to it: the user's own reminders. A click flies to it and
   the page lays a text box over the board itself, so the user writes on the board.
   The engine builds walls 5.2 high with the room sign at 4.45, where the cable tray covers it, so
   the walls go up to WALL_H and the sign moves above the tray. */
(function () {
  'use strict';
  var T = window.THREE;
  if (!T) return;

  var WALL_H = 7, SIGN_Y = 6.15;
  function isWall(m) { return m.isMesh && m.geometry && m.geometry.type === 'BoxGeometry' && m.geometry.parameters && Math.abs(m.geometry.parameters.height - 5.2) < 0.001; }
  function isSign(m) { return m.isMesh && m.geometry && m.geometry.type === 'PlaneGeometry' && m.geometry.parameters && m.geometry.parameters.width === 4.8 && m.geometry.parameters.height === 1.2; }
  function isBoard(m) { return m.isMesh && m.geometry && m.geometry.type === 'PlaneGeometry' && m.geometry.parameters && m.geometry.parameters.width === 4 && m.geometry.parameters.height === 2.5; }
  function cssMs(name, fallback) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

  // Short names for tools on the board: mcp__plugin_playwright_playwright__browser_click -> click
  function toolWord(name) {
    var n = String(name || '');
    var m = n.match(/__browser_([a-z_]+)$/i);
    if (m) return m[1].replace(/_/g, ' ');
    m = n.match(/^mcp__(.+?)__(.+)$/);
    return m ? m[2].replace(/_/g, ' ') : n;
  }
  function isBrowser(c) { return /playwright|__browser_/i.test(c.name); }

  // What a room board shows, from the sessions in the room.
  function boardData(info, tree) {
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
      touched: touched
    };
  }

  function paint(c, w, h, d, tok, f) {
    var pad = 36, sans = f.sans || 'sans-serif', mono = f.mono || 'monospace';
    var col = function (k, fb) { return tok[k] || fb; };
    c.fillStyle = col('scene-dark'); c.fillRect(0, 0, w, h);
    c.strokeStyle = col('scene-metal'); c.lineWidth = 14; c.strokeRect(7, 7, w - 14, h - 14);
    // header
    c.fillStyle = col('bubble'); c.font = '600 40px ' + sans; c.textBaseline = 'top';
    c.fillText(clip(d.room, 26), pad, 30);
    c.fillStyle = col('status-finished'); c.font = '500 26px ' + mono;
    c.fillText(clip(d.branch, 40), pad, 78);
    var dot = function (x, y, status) { c.fillStyle = col('status-' + status, col('muted')); c.beginPath(); c.arc(x, y, 8, 0, 7); c.fill(); };
    var x2 = w / 2 + 12, y0 = 128;
    var title = function (t, x, y) { c.fillStyle = col('muted'); c.font = '600 20px ' + sans; c.fillText(t.toUpperCase(), x, y); };
    // left: to-do list, or the sessions when there is no plan
    if (d.todos.length) {
      var done = d.todos.filter(function (t) { return t.status === 'completed'; }).length;
      title('To do · ' + done + ' / ' + d.todos.length, pad, y0);
      d.todos.slice(0, 9).forEach(function (t, i) {
        var y = y0 + 40 + i * 42;
        dot(pad + 8, y + 12, t.status === 'completed' ? 'finished' : t.status === 'in_progress' ? 'working' : 'resting');
        c.fillStyle = col(t.status === 'completed' ? 'muted' : 'bubble'); c.font = '400 24px ' + sans;
        c.fillText(clip(t.text, 32), pad + 28, y);
      });
    } else {
      title(d.sessions.length ? 'Sessions' : 'No session here', pad, y0);
      d.sessions.slice(0, 6).forEach(function (s, i) {
        var y = y0 + 40 + i * 64;
        dot(pad + 8, y + 12, s.status);
        c.fillStyle = col('bubble'); c.font = '600 24px ' + sans; c.fillText(clip(s.name, 28), pad + 28, y);
        c.fillStyle = col('muted'); c.font = '400 20px ' + sans; c.fillText(clip(s.task, 40), pad + 28, y + 30);
      });
      if (!d.sessions.length) { c.fillStyle = col('muted'); c.font = '400 22px ' + sans; c.fillText('Open a session in this folder to use the room.', pad, y0 + 44); }
    }
    // right top: the browser
    title('Browser', x2, y0);
    if (!d.browser.length) { c.fillStyle = col('muted'); c.font = '400 22px ' + sans; c.fillText('No browser steps yet', x2, y0 + 40); }
    d.browser.slice(-5).forEach(function (b, i) {
      var y = y0 + 40 + i * 36;
      dot(x2 + 8, y + 12, b.ok === null ? 'working' : b.ok ? 'finished' : 'error');
      c.fillStyle = col('bubble'); c.font = '500 22px ' + mono; c.fillText(clip(toolWord(b.name), 14), x2 + 28, y);
      c.fillStyle = col('muted'); c.font = '400 20px ' + mono; c.fillText(clip(b.detail, 26), x2 + 200, y + 2);
    });
    // right bottom: the repository
    var y3 = y0 + 250;
    title('Repository' + (d.tree ? ' · ' + d.tree.total + ' files' : ''), x2, y3);
    var ents = d.tree ? d.tree.entries.filter(function (e) { return e.dir; }).slice(0, 6) : [];
    if (!ents.length) { c.fillStyle = col('muted'); c.font = '400 22px ' + sans; c.fillText(d.tree ? 'Only files at the top' : 'Loading', x2, y3 + 40); }
    ents.forEach(function (e, i) {
      var y = y3 + 40 + i * 32, hot = d.touched[e.name];
      c.fillStyle = col(hot ? 'status-working' : 'muted'); c.font = (hot ? '600 ' : '400 ') + '22px ' + mono;
      c.fillText(clip(e.name + '/', 22), x2 + 8, y);
      c.fillStyle = col('muted'); c.font = '400 20px ' + mono;
      c.fillText(e.files + (hot ? ' · ' + hot + ' touched' : ''), x2 + 250, y + 2);
    });
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
  function paintNotes(c, w, h, text, tok, f) {
    var col = function (k, fb) { return tok[k] || fb; }, sans = f.sans || 'sans-serif';
    c.fillStyle = col('scene-wood'); c.fillRect(0, 0, w, h);
    c.fillStyle = col('bubble'); c.fillRect(22, 22, w - 44, h - 44);
    c.fillStyle = col('emphasis'); c.beginPath(); c.arc(w / 2, 40, 12, 0, 7); c.fill();
    c.textBaseline = 'top'; c.fillStyle = col('muted'); c.font = '600 26px ' + sans; c.fillText('NOTES', 56, 62);
    if (!String(text || '').trim()) { c.fillStyle = col('muted'); c.font = '400 30px ' + sans; c.fillText('Click to write a reminder.', 56, 120); return; }
    c.fillStyle = col('ink'); c.font = '400 32px ' + sans;
    wrap(c, text, w - 112).slice(0, 11).forEach(function (l, i) { c.fillText(l, 56, 116 + i * 40); });
  }

  // Attach boards to a mounted office. o: { room(roomId) -> info, tree(root) -> Promise, onFocus(roomId), onBlur() }
  function attach(office, o) {
    var ins = office.inspect && office.inspect(), st = ins && ins.stage;
    if (!st) return { refresh: function () {}, blur: function () {}, dispose: function () {} };
    var boards = [];      // { mesh, roomId, tex, canvas }
    var notes = [];       // { mesh, roomId, tex, canvas } the user's notes boards
    var trees = {};       // root -> tree
    var focused = null, focusedKind = null, focusedMesh = null, saved = null, dead = false;

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
        var cv = document.createElement('canvas'); cv.width = 1024; cv.height = 640;
        var tex = new T.CanvasTexture(cv); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
        m.material.map = tex; m.material.emissive = new T.Color(0xffffff); m.material.emissiveMap = tex; m.material.emissiveIntensity = 0.55; m.material.needsUpdate = true;
        m.userData.officeBoard = id;
        boards.push({ mesh: m, roomId: id, tex: tex, canvas: cv, sig: '' });
      });
      // a notes board left of each activity board, on the same wall
      found.forEach(function (m, i) {
        var id = rooms[i].id;
        if (notes.some(function (n) { return n.mesh.parent === m.parent && n.roomId === id; })) return;
        var cv = document.createElement('canvas'); cv.width = 900; cv.height = 560;
        var tex = new T.CanvasTexture(cv); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
        var nm = new T.Mesh(new T.PlaneGeometry(3.6, 2.24), new T.MeshStandardMaterial({ map: tex, roughness: 1 }));
        nm.position.set(m.position.x - 4.1, m.position.y, m.position.z + 0.005);
        nm.userData.officeNotes = id; nm.userData.noNav = 1;
        m.parent.add(nm);
        notes.push({ mesh: nm, roomId: id, tex: tex, canvas: cv, sig: null });
      });
      notes = notes.filter(function (n) { var p = n.mesh; while (p.parent) p = p.parent; return p === st.scene; });
      boards = boards.filter(function (x) { return found.indexOf(x.mesh) >= 0 || x.mesh.parent; });
    }
    function refresh() {
      if (dead) return;
      scan();
      boards.forEach(function (bd) {
        var info = o.room(bd.roomId);
        var root = info.place && info.place.root;
        if (root && !(root in trees) && o.tree) { trees[root] = null; o.tree(root).then(function (t) { trees[root] = t; refresh(); }, function () { trees[root] = { total: 0, entries: [] }; }); }
        var d = boardData(info, root ? trees[root] : null);
        var sig = JSON.stringify(d);
        if (sig === bd.sig) return;
        bd.sig = sig; bd.data = d;
        paint(bd.canvas.getContext('2d'), bd.canvas.width, bd.canvas.height, d, st.K.tok, st.K.f || {});
        bd.tex.needsUpdate = true;
      });
      notes.forEach(function (n) {
        var text = o.note ? o.note(n.roomId) : '';
        if (text === n.sig) return;
        n.sig = text;
        paintNotes(n.canvas.getContext('2d'), n.canvas.width, n.canvas.height, text, st.K.tok, st.K.f || {});
        n.tex.needsUpdate = true;
      });
    }

    // camera: fly to face the board, and back
    var fly = null;
    st.anim.push(function (dt) {
      if (focused && st.goal) st.goal = null;   // the engine must not reframe while a board is open
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
      var tg = st.ctl ? st.ctl.target : st.target;
      saved = { p: st.cam.position.clone(), t: tg.clone(), z: st.cam.zoom };
      var c = bd.mesh.getWorldPosition(new T.Vector3());
      var n = new T.Vector3(0, 0, 1).applyQuaternion(bd.mesh.getWorldQuaternion(new T.Quaternion()));
      var dist = saved.p.distanceTo(saved.t);
      // face the board, a little from above, close enough to read it
      var p1 = c.clone().addScaledVector(n, dist).add(new T.Vector3(0, dist * 0.12, 0));
      var span = (st.cam.top - st.cam.bottom) || 1;
      var z1 = Math.min(st.ctl ? st.ctl.maxZoom * 1.6 : 6, span / 4.4);   // the board fills most of the view, with room around it
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

    // clicks on a board (not drags)
    var cv = st.r.domElement, ray = new T.Raycaster(), ndc = new T.Vector2(), down = null;
    function onDown(e) { down = [e.clientX, e.clientY]; }
    function onUp(e) {
      if (!down) return;
      var moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
      if (moved > 6 || focused) return;
      var r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, st.cam);
      var all = boards.concat(notes);
      var hit = ray.intersectObjects(all.map(function (b) { return b.mesh; }), false)[0];
      if (!hit) return;
      var bd = all.filter(function (b) { return b.mesh === hit.object; })[0];
      if (bd) focus(bd, notes.indexOf(bd) >= 0 ? 'notes' : 'board');
    }
    function onMove(e) {
      if (focused) return;
      var r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, st.cam);
      var hit = ray.intersectObjects(boards.concat(notes).map(function (b) { return b.mesh; }), false)[0];
      cv.style.cursor = hit ? 'pointer' : '';
      boards.forEach(function (b) { b.mesh.material.emissiveIntensity = hit && hit.object === b.mesh ? 0.8 : 0.55; });
    }
    function onKey(e) { if (e.key === 'Escape' && focused) blur(); }
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    var timer = setInterval(refresh, 1500);
    refresh();
    return {
      refresh: refresh, blur: blur, focused: function () { return focused; }, kind: function () { return focusedKind; },
      flying: function () { return !!fly; },
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
        cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointermove', onMove);
        window.removeEventListener('keydown', onKey);
      }
    };
  }

  window.OfficeBoard = { attach: attach, data: boardData, toolWord: toolWord };
})();
