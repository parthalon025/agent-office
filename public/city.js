/* Agent Office for Claude Code x0.2: the city.
   Every git repository is a building on one plaza: a floor per branch, a pip per session, a beacon
   when a session needs you. Built on the DS stage (AgentOffice.office.Stage), so lights, theme, post
   effects and every color come from the DS tokens. Drag to turn, scroll or pinch to zoom, click a
   building to fly to it and go inside.
   Effects: a new building rises, a removed one sinks; a new floor grows from the roof, a removed one
   shrinks away; sessions pop in and out. Reduced motion skips them. */
(function () {
  'use strict';
  var A = window.AgentOffice, T = window.THREE;
  if (!A || !T || !A.office || !A.office.Stage) return;
  var O = A.office, X = O.helpers;
  var FLOOR_H = 1.9, BW = 4.2, BD = 4.2, PITCH = 10;
  var FLOOR_KEYS = ['ops', 'sales', 'research', 'content', 'hq'];

  function cssMs(name, fallback) {
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name));
    return isFinite(v) && v > 0 ? v : fallback;
  }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  // A tween that runs in the stage loop: from a to b over ms, calls set(v) each frame, then done().
  function tween(stage, ms, a, b, set, done) {
    if (stage.rm || ms <= 0) { set(b); if (done) done(); return; }
    var t = 0;
    var f = function (dt) {
      t = Math.min(1, t + dt * 1000 / ms);
      set(a + (b - a) * easeOut(t));
      if (t >= 1) { stage.anim.splice(stage.anim.indexOf(f), 1); if (done) done(); }
    };
    stage.anim.push(f);
  }

  // Camera feel for a DS stage: the wheel zooms toward the mouse, and a right drag (or Shift+drag)
  // moves the view sideways, kept inside bounds() when given. Returns a function that undoes it.
  function cameraFeel(stage, o) {
    o = o || {};
    var ctl = stage.ctl, cam = stage.cam, cv = stage.r && stage.r.domElement;
    if (!ctl || !cv) return function () {};
    ctl.enableZoom = false; ctl.enablePan = true; ctl.screenSpacePanning = true;
    var v0 = new T.Vector3(), v1 = new T.Vector3();
    function onWheel(e) {
      e.preventDefault();
      stage.goal = null;
      if (o.onWheel) o.onWheel(e);
      var r = cv.getBoundingClientRect();
      var nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = -((e.clientY - r.top) / r.height) * 2 + 1;
      var f = Math.pow(0.9985, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY);
      var z = Math.max(ctl.minZoom, Math.min(ctl.maxZoom, cam.zoom * f));
      if (z === cam.zoom) return;
      v0.set(nx, ny, 0).unproject(cam);
      cam.zoom = z; cam.updateProjectionMatrix();
      v1.set(nx, ny, 0).unproject(cam);
      v0.sub(v1);
      cam.position.add(v0); ctl.target.add(v0);
    }
    cv.addEventListener('wheel', onWheel, { passive: false });
    var clamp = function () {
      if (!o.bounds) return;
      var b = o.bounds(), t = ctl.target;
      var dx = Math.max(b[0], Math.min(b[1], t.x)) - t.x, dz = Math.max(b[2], Math.min(b[3], t.z)) - t.z;
      if (dx || dz) { t.x += dx; t.z += dz; cam.position.x += dx; cam.position.z += dz; }
    };
    stage.anim.push(clamp);
    return function () { cv.removeEventListener('wheel', onWheel); var i = stage.anim.indexOf(clamp); if (i >= 0) stage.anim.splice(i, 1); };
  }

  // A per-frame tick on a stage. With o.host (the scene host) the tick registers there; without, on the stage loop.
  // Returns the function that removes it.
  function addTick(stage, o, fn) {
    if (o && o.host) return o.host.frame(fn);
    stage.anim.push(fn);
    return function () { var i = stage.anim.indexOf(fn); if (i >= 0) stage.anim.splice(i, 1); };
  }

  // A flock that circles over a point: two thin wings per bird that flap, a slow bank as they turn.
  // center() gives [x, y, z] each frame, so the flock follows the city or the tower. Reduced motion
  // shows no birds. Returns { group, dispose }.
  function birds(stage, o) {
    o = o || {};
    var g = new T.Group(), K = stage.K, flock = [];
    g.userData.decor = true;
    var mat = K.t('scene-dark', { side: T.DoubleSide, roughness: 1 });
    var wing = new T.BufferGeometry();
    wing.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, 0.55, 0, 0.18, 0, 0, 0.32], 3));
    wing.computeVertexNormals();
    var n = o.count || 7;
    for (var i = 0; i < n; i++) {
      var b = new T.Group();
      b.scale.setScalar(o.size || 1);
      var l = new T.Mesh(wing, mat), r = new T.Mesh(wing, mat);
      r.scale.x = -1;
      l.castShadow = r.castShadow = false;
      var body = new T.Mesh(new T.BoxGeometry(0.08, 0.06, 0.34), mat);
      body.position.z = 0.16;
      b.add(l, r, body);
      b.userData = { l: l, r: r, phase: Math.random() * 6.28, rad: (o.radius || 14) * (0.75 + Math.random() * 0.5), lift: Math.random() * 2.5, speed: 0.12 + Math.random() * 0.08, dir: i % 3 === 0 ? -1 : 1 };
      b.traverse(function (m) { m.userData.noNav = 1; });
      flock.push(b); g.add(b);
    }
    stage.scene.add(g);
    var tick = function (dt, t) {
      g.visible = !stage.rm && (!o.visible || o.visible());
      if (!g.visible) return;
      var c = o.center ? o.center() : [0, 12, 0];
      flock.forEach(function (b) {
        var u = b.userData, a = u.phase + t * u.speed * u.dir;
        b.position.set(c[0] + Math.cos(a) * u.rad, c[1] + u.lift + Math.sin(t * 0.7 + u.phase) * 0.6, c[2] + Math.sin(a) * u.rad);
        b.rotation.set(0, -a + (u.dir > 0 ? Math.PI : 0), u.dir * 0.25);
        var flap = Math.sin(t * 9 + u.phase * 3) * 0.7;
        u.l.rotation.z = flap; u.r.rotation.z = -flap;
      });
    };
    var off = addTick(stage, o, tick);
    return { group: g, dispose: function () { off(); stage.clear(g); } };
  }

  // Streets around the lot of a DS tower (the building view): a road with lane marks along the front
  // and the right side of everything the stage shows, a curb, trees, and two street lights.
  // visible() hides it with the floor view. Returns { dispose }.
  function streetsAround(stage, o) {
    o = o || {};
    var K = stage.K, g = new T.Group(), built = false;
    g.userData.decor = true;
    stage.scene.add(g);
    var m = function (t, x) { return K.t(t, x); };
    function build() {
      // measure the scene without our own group
      g.visible = false;
      var box = new T.Box3(), mb = new T.Box3();
      // what the stage shows now: visible meshes, not our own decor and not sprites (labels)
      (function walk(c) {
        if (!c.visible || c === g || (c.userData && c.userData.decor)) return;
        if (c.isMesh && c.geometry) { if (!c.geometry.boundingBox) c.geometry.computeBoundingBox(); mb.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld); if (isFinite(mb.min.x)) box.union(mb); }
        c.children.forEach(walk);
      })(stage.scene);
      if (box.isEmpty()) return false;
      var y = box.min.y + 0.03, W = box.max.x - box.min.x, D = box.max.z - box.min.z, R = 2.4;
      var fz = box.max.z + R / 2 + 0.4, rx = box.max.x + R / 2 + 0.4;
      var flat = function (mm) { mm.castShadow = false; mm.userData.noNav = 1; return mm; };
      flat(X.mesh(X.box(W + R * 2 + 2, 0.06, R), m('scene-dark', { roughness: 0.95 }), (box.min.x + rx) / 2 + R / 2, y, fz, g));
      flat(X.mesh(X.box(R, 0.06, D + R * 2 + 2), m('scene-dark', { roughness: 0.95 }), rx, y, (box.min.z + fz) / 2 + R / 2, g));
      for (var x = box.min.x; x < rx; x += 1.6) flat(X.mesh(X.box(0.7, 0.07, 0.12), m('scene-rail'), x, y + 0.01, fz, g));
      for (var z = box.min.z; z < fz; z += 1.6) flat(X.mesh(X.box(0.12, 0.07, 0.7), m('scene-rail'), rx, y + 0.01, z, g));
      // the far sidewalks, with trees
      flat(X.mesh(X.box(W + R * 2 + 2, 0.12, 1.4), m('scene-slab'), (box.min.x + rx) / 2 + R / 2, y + 0.03, fz + R / 2 + 0.7, g));
      flat(X.mesh(X.box(1.4, 0.12, D + R * 2 + 2), m('scene-slab'), rx + R / 2 + 0.7, y + 0.03, (box.min.z + fz) / 2 + R / 2, g));
      for (var tx = box.min.x + 1; tx < rx; tx += 4.5) if (O.Parts && O.Parts.tree) O.Parts.tree(K, g, tx, fz + R / 2 + 0.7, 0.8);
      for (var tz = box.min.z + 1; tz < fz; tz += 4.5) if (O.Parts && O.Parts.tree) O.Parts.tree(K, g, rx + R / 2 + 0.7, tz, 0.8);
      [[box.min.x + W * 0.25, fz - R / 2 - 0.3], [rx - R / 2 - 0.3, box.min.z + D * 0.3]].forEach(function (q) {
        X.mesh(X.cyl(0.06, 0.08, 2.6), m('scene-metal'), q[0], y + 1.3, q[1], g);
        flat(X.mesh(X.sph(0.16, 12, 8), m('bubble'), q[0], y + 2.65, q[1], g));
        stage.lamp(g, q[0], y + 2.5, q[1], null, 9);
      });
      g.traverse(function (mm) { mm.userData.noNav = 1; });
      return true;
    }
    var tick = function () {
      var want = !o.visible || o.visible();
      if (want && !built) built = build();
      g.visible = want && built;
    };
    var off = addTick(stage, o, tick);
    return { dispose: function () { off(); stage.clear(g); } };
  }

  function City(el, opts) {
    opts = opts || {};
    var s = new O.Stage(el, { root: opts.root || null, quality: opts.quality || 'auto', label: '3D city. Each building is a repository. Click one to go inside.', D: 22 });
    if (s.dead) return { update: function () {}, focus: function () {}, fit: function () {}, zoomBy: function () {}, dispose: function () {},
      setMode: function (m) { var t = (A.MODES || []).filter(function (x) { return x.id === m; })[0]; if (t && opts.root) opts.root.setAttribute('data-theme', t.theme); }, state: function () { return null; } };
    var K = s.K, world = new T.Group(), mats = {};
    // one themed material per token, so a theme change repaints them all
    function mat(token, o) { var k = token + (o ? JSON.stringify(o) : ''); return mats[k] || (mats[k] = K.t(token, o)); }
    s.scene.add(world);
    var SHOW_ZOOM = 1.35;   // the zoom that Show all gives
    if (s.ctl) { s.ctl.minZoom = SHOW_ZOOM; s.ctl.maxZoom = 5; }

    // ground: a wide slab and a plaza that grows with the city
    var ground = X.mesh(X.box(400, 0.4, 400), mat('scene-slab'), 0, -0.8, 0, world);
    ground.castShadow = false;
    var plaza = X.mesh(X.box(1, 0.2, 1), mat('scene-floor'), 0, -0.5, 0, world);
    plaza.castShadow = false;

    // streets between the lots, trees on the lot corners, a light at each crossing (lit in a theme with room lamps: Night, Fluent Dark)
    var streets = null, gridKey = '';
    var ROAD = 2.4;
    function buildStreets(cols, rows) {
      if (streets) s.clear(streets);
      streets = new T.Group();
      world.add(streets);
      var W = cols * PITCH, D = rows * PITCH, y = -0.38;
      var road = mat('scene-dark', { roughness: 0.95 }), dash = mat('scene-rail'), curb = mat('scene-slab');
      var flat = function (m) { m.castShadow = false; m.userData.noNav = 1; return m; };
      // roads on every lot edge, the outer ring included
      for (var c = 0; c <= cols; c++) {
        var x = (c - cols / 2) * PITCH;
        flat(X.mesh(X.box(ROAD, 0.06, D + ROAD), road, x, y, 0, streets));
        for (var zz = -D / 2 + 0.8; zz < D / 2; zz += 1.6) flat(X.mesh(X.box(0.12, 0.07, 0.7), dash, x, y + 0.01, zz, streets));
      }
      for (var r = 0; r <= rows; r++) {
        var z = (r - rows / 2) * PITCH;
        flat(X.mesh(X.box(W + ROAD, 0.06, ROAD), road, 0, y, z, streets));
        for (var xx = -W / 2 + 0.8; xx < W / 2; xx += 1.6) flat(X.mesh(X.box(0.7, 0.07, 0.12), dash, xx, y + 0.01, z, streets));
      }
      // lot corners: a curb square and trees
      for (var i = 0; i < cols * rows; i++) {
        var cx = ((i % cols) - (cols - 1) / 2) * PITCH, cz = (Math.floor(i / cols) - (rows - 1) / 2) * PITCH;
        flat(X.mesh(X.box(PITCH - ROAD, 0.1, PITCH - ROAD), curb, cx, y + 0.02, cz, streets));
        var e = (PITCH - ROAD) / 2 - 0.7;
        [[-e, -e], [e, -e], [-e, e], [e, e]].forEach(function (q, j) { if (O.Parts && O.Parts.tree) O.Parts.tree(K, streets, cx + q[0], cz + q[1], 0.75 + ((i + j) % 3) * 0.12); });
      }
      // street lights at the crossings (a few: each is a real light)
      var n = 0;
      for (var a = 0; a <= cols && n < 6; a++) for (var bq = 0; bq <= rows && n < 6; bq += Math.max(1, rows)) {
        var lx = (a - cols / 2) * PITCH + ROAD / 2 + 0.3, lz = (bq - rows / 2) * PITCH + ROAD / 2 + 0.3;
        X.mesh(X.cyl(0.06, 0.08, 2.6), mat('scene-metal'), lx, y + 1.3, lz, streets);
        var bulb = X.mesh(X.sph(0.16, 12, 8), mat('bubble'), lx, y + 2.65, lz, streets);
        bulb.castShadow = false;
        s.lamp(streets, lx, y + 2.5, lz, null, 9);
        n++;
      }
      streets.traverse(function (m) { if (m.isMesh) m.userData.noNav = 1; });
    }
    var flock = birds(s, { count: 9, radius: 16, center: function () {
      var tall = 2; Object.keys(items).forEach(function (k) { tall = Math.max(tall, items[k].floors.length * FLOOR_H); });
      return [0, tall + 5, 0];
    } });

    var items = {};      // key -> building
    var slots = [];      // slot index -> key
    var hover = null;

    function slotXZ(i) {
      var cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(slots.length, 1))));
      var r = Math.floor(i / cols), c = i % cols;
      return [(c - (cols - 1) / 2) * PITCH, (r - (Math.ceil(slots.length / cols) - 1) / 2) * PITCH];
    }
    // the page version is in the title ("Agent Office x0.2"); no second copy of it lives in the code
    function pageVersion() {
      var m = /x\d+(?:\.\d+)*/.exec(typeof document !== 'undefined' ? document.title : '');
      return m ? m[0] : '';
    }
    function signTex(name, sub) {
      var tok = K.tok, f = K.f || {};
      return X.canvasTex(512, 160, function (g, w, hh) {
        // a rounded label like the DS floor tags: name, then floors and sessions. The card is bg (opaque; K.tok
        // has no chip or line), and ink and muted read on bg in every theme.
        var r = 28;
        g.fillStyle = tok['bg'];
        g.beginPath(); g.moveTo(r, 4); g.arcTo(w - 4, 4, w - 4, hh - 4, r); g.arcTo(w - 4, hh - 4, 4, hh - 4, r); g.arcTo(4, hh - 4, 4, 4, r); g.arcTo(4, 4, w - 4, 4, r); g.closePath(); g.fill();
        g.strokeStyle = tok['line'] || tok['muted']; g.lineWidth = 3; g.stroke();
        var ver0 = pageVersion();
        g.textBaseline = 'middle'; g.fillStyle = tok['ink']; g.font = '600 62px ' + (f.sans || 'sans-serif');
        g.fillText(name.length > 15 ? name.slice(0, 14) + '…' : name, 32, sub || ver0 ? 62 : hh / 2);
        // the page version (x0.2, from the title) sits small and right-aligned on the count line; the counts shrink to leave it room
        var mono = f.mono || 'monospace', ver = ver0, vw = 0;
        g.fillStyle = tok['muted'];
        if (ver) { g.font = '500 26px ' + mono; vw = g.measureText(ver).width + 16; }
        if (!sub && !ver) return;
        var fs = 38; g.font = '500 ' + fs + 'px ' + mono;
        while (sub && g.measureText(sub).width > w - 64 - vw && fs > 18) { fs -= 2; g.font = '500 ' + fs + 'px ' + mono; }
        if (sub) g.fillText(sub, 32, 124, w - 64 - vw); // maxWidth: the counts never run under the version
        if (ver) { g.font = '500 26px ' + mono; g.textAlign = 'right'; g.fillText(ver, w - 32, 124); g.textAlign = 'left'; }
      });
    }
    function setSign(b) {
      // sub: a building's own count line (the Paperclip HQ: its agents and budget, #76), else the Glance layer (ADR 0006):
      // the name alone, and a line only when the building needs the owner (OfficeVocab.layers.glance).
      var V = globalThis.OfficeVocab, sub = b.data.sub || V.layers.glance({ waiting: b.data.waiting }, b.data.state).text;
      var key = b.data.name + '|' + sub + '|' + K.look;
      if (b.signKey === key) return;
      b.signKey = key;
      var old = b.sign.material.map;
      b.sign.material.map = signTex(b.data.name, sub);
      b.sign.material.needsUpdate = true;
      if (old) old.dispose();
    }

    function addFloor(b, i, f) {
      var g = new T.Group();
      g.position.y = i * FLOOR_H;
      var band = X.mesh(X.box(BW + 0.3, 0.22, BD + 0.3), mat('floor-' + (f.key || FLOOR_KEYS[i % FLOOR_KEYS.length])), 0, 0.11, 0, g);
      var hh = FLOOR_H - 0.22, cy = 0.22 + hh / 2;
      // a solid core behind a glass shell, with corner posts: it reads as an office floor
      var core = X.mesh(X.box(BW - 0.7, hh, BD - 0.7), mat('scene-wall'), 0, cy, 0, g);
      var glass = X.mesh(X.box(BW, hh, BD), mat('scene-glass', { transparent: true, opacity: 0.42, roughness: 0.06, metalness: 0.1, depthWrite: false }), 0, cy, 0, g);
      glass.castShadow = false;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) { var post = X.mesh(X.box(0.12, hh, 0.12), mat('scene-metal'), c[0] * BW / 2, cy, c[1] * BD / 2, g); post.userData.city = b.key; });
      band.userData.city = glass.userData.city = core.userData.city = b.key;
      g.scale.y = 0.001;
      b.body.add(g);
      b.floors.push({ g: g, name: f.name, glass: glass, lit: null });
      tween(s, cssMs('duration-floor', 450), 0.001, 1, function (v) { g.scale.y = v; });
    }
    function removeFloor(b) {
      var f = b.floors.pop();
      if (!f) return;
      tween(s, cssMs('duration-floor', 450), f.g.scale.y, 0.001, function (v) { f.g.scale.y = v; }, function () { s.clear(f.g); });
    }
    function placeRoof(b, animate) {
      var y = b.floors.length * FLOOR_H;
      // the HQ's penthouse and mast stand on the roof, so its sign and beacon sit above them
      var top = b.crown ? 2.1 : 0;
      var set = function (v) { b.roof.position.y = v + 0.15; if (b.crown) b.crown.position.y = v + 0.3; b.sign.position.y = v + 1.9 + top; b.beacon.position.y = v + 0.65 + top; };
      if (animate) tween(s, cssMs('duration-floor', 450), b.roof.position.y, y, set); else set(y);
    }
    function syncPips(b) {
      var want = {};
      (b.data.bots || []).forEach(function (bot, i) { want[bot.name] = { bot: bot, i: i }; });
      Object.keys(b.pips).forEach(function (n) {
        if (want[n]) return;
        var p = b.pips[n]; delete b.pips[n];
        tween(s, cssMs('duration-base', 240), p.scale.x, 0.001, function (v) { p.scale.setScalar(v); }, function () { s.clear(p); });
      });
      Object.keys(want).forEach(function (n) {
        var w = want[n], p = b.pips[n];
        var fi = Math.max(0, b.floors.findIndex(function (f) { return f.name === w.bot.floor; }));
        var x = -BW / 2 + 0.6 + (w.i % 6) * 0.6, y = fi * FLOOR_H + 0.55, z = BD / 2 + 0.25;
        if (!p) {
          p = X.mesh(X.sph(0.22, 16, 12), mat('status-' + w.bot.status), x, y, z, b.body);
          p.userData.city = b.key; p.userData.status = w.bot.status; p.scale.setScalar(0.001);
          b.pips[n] = p;
          tween(s, cssMs('duration-base', 240), 0.001, 1, function (v) { p.scale.setScalar(v); });
        } else if (p.userData.status !== w.bot.status) {
          p.material = mat('status-' + w.bot.status); p.userData.status = w.bot.status;
        }
        p.userData.home = [x, y, z];
      });
    }

    // The Paperclip HQ (#76) is told apart from the repositories by its top: a penthouse in the HQ floor color with a glass
    // band, and a mast with a light. Not a repository: it has one floor, its pips are Paperclip agents, a click opens its dialog.
    function crown(key, body) {
      var c = new T.Group();
      var house = X.mesh(X.box(BW * 0.62, 1.1, BD * 0.62), mat('floor-hq'), 0, 0.55, 0, c);
      var band = X.mesh(X.box(BW * 0.64, 0.34, BD * 0.64), mat('scene-glass', { transparent: true, opacity: 0.5, roughness: 0.06, depthWrite: false }), 0, 0.72, 0, c);
      band.castShadow = false;
      var mast = X.mesh(X.cyl(0.05, 0.07, 1.4), mat('scene-metal'), BW * 0.18, 1.8, -BD * 0.18, c);
      var tip = X.mesh(X.sph(0.12, 12, 8), mat('emphasis'), BW * 0.18, 2.55, -BD * 0.18, c);
      tip.castShadow = false;
      [house, band, mast, tip].forEach(function (m) { m.userData.city = key; });
      body.add(c);
      return c;
    }
    function addBuilding(d) {
      var slot = slots.indexOf(null);
      if (slot < 0) { slot = slots.length; slots.push(d.key); } else slots[slot] = d.key;
      var g = new T.Group(), body = new T.Group();
      g.add(body);
      var base = X.mesh(X.box(BW + 1.4, 0.3, BD + 1.4), mat('scene-slab'), 0, -0.25, 0, g);
      base.userData.city = d.key;
      var roof = X.mesh(X.box(BW + 0.5, 0.3, BD + 0.5), mat('scene-wall'), 0, 0, 0, body);
      roof.userData.city = d.key;
      var sign = new T.Sprite(new T.SpriteMaterial({ transparent: true, depthWrite: false }));
      sign.scale.set(6.4, 2, 1); sign.userData.city = d.key;
      sign.layers.set(1);   // the stage draws layer 1 after the post effects, so labels never bloom
      body.add(sign);
      var beacon = X.mesh(X.sph(0.32, 16, 12), mat('emphasis'), 0, 0, 0, body);
      beacon.visible = false; beacon.castShadow = false;
      world.add(g);
      var b = items[d.key] = { key: d.key, g: g, body: body, roof: roof, sign: sign, beacon: beacon, floors: [], pips: {}, slot: slot, data: d, signKey: '', crown: d.hq ? crown(d.key, body) : null };
      var xz = slotXZ(slot);
      g.position.set(xz[0], 0, xz[1]);
      // rise out of the plaza
      g.scale.set(1, 0.001, 1);
      tween(s, cssMs('duration-camera', 600), 0.001, 1, function (v) { g.scale.y = v; });
      return b;
    }
    function removeBuilding(key) {
      var b = items[key];
      delete items[key];
      slots[b.slot] = null;
      tween(s, cssMs('duration-camera', 600), b.g.scale.y, 0.001, function (v) { b.g.scale.y = v; b.g.position.y = -(1 - v) * 0.5; }, function () { s.clear(b.g); });
    }

    function layout() {
      Object.keys(items).forEach(function (k) {
        var b = items[k], xz = slotXZ(b.slot);
        if (Math.abs(b.g.position.x - xz[0]) < 0.01 && Math.abs(b.g.position.z - xz[1]) < 0.01) return;
        var x0 = b.g.position.x, z0 = b.g.position.z;
        tween(s, cssMs('duration-camera', 600), 0, 1, function (v) { b.g.position.x = x0 + (xz[0] - x0) * v; b.g.position.z = z0 + (xz[1] - z0) * v; });
      });
      var cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(slots.length, 1)))), rows = Math.max(1, Math.ceil(slots.length / cols));
      plaza.scale.set(cols * PITCH + 6, 1, rows * PITCH + 6);
      if (gridKey !== cols + 'x' + rows) { gridKey = cols + 'x' + rows; buildStreets(cols, rows); }
    }

    // The windows of a building light in the worst state of its desks when it needs the user (#92, AgentOffice.worstOf): an error
    // or a request. The beacon and the count in the list say it too, so it is not in color alone.
    var GLASS = { transparent: true, opacity: 0.42, roughness: 0.06, metalness: 0.1, depthWrite: false };
    function litWindows(b, state) {
      var lit = state === 'error' || state === 'waiting' ? state : null;
      b.floors.forEach(function (f) {
        if (f.lit === lit || !f.glass) return;
        f.lit = lit;
        var m = lit ? mat('status-' + lit, { transparent: true, opacity: 0.55, roughness: 0.2, depthWrite: false }) : mat('scene-glass', GLASS);
        if (lit) { m.emissive.set(K.tok['status-' + lit]); m.emissiveIntensity = 0.6; }
        f.glass.material = m;
      });
    }
    // list: [{ key, name, sessions, waiting, state, floors: [{ name, key }], bots: [{ name, status, floor }] }]
    function update(list) {
      var seen = {};
      list.forEach(function (d) {
        seen[d.key] = true;
        var b = items[d.key], fresh = !b;
        if (!b) b = addBuilding(d);
        b.data = d;
        var floors = d.floors.length ? d.floors : [{ name: '', key: 'ops' }];
        // floors are matched by position: a branch that is gone shrinks away from the top
        while (b.floors.length > floors.length) removeFloor(b);
        floors.forEach(function (f, i) { if (!b.floors[i]) addFloor(b, i, f); else b.floors[i].name = f.name; });
        placeRoof(b, !fresh);
        setSign(b);
        syncPips(b);
        b.beacon.visible = d.waiting > 0;
        litWindows(b, d.state);
      });
      Object.keys(items).forEach(function (k) { if (!seen[k]) removeBuilding(k); });
      layout();
    }

    // The widest view is Show all: the city never shrinks to a small shape at the ground edge. The zoom that
    // shows all of it depends on how far the camera stands (s.D) against how far Show all would stand.
    function showAllExt() {
      var cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(slots.length, 1)))), rows = Math.max(1, Math.ceil(slots.length / cols));
      var tall = 2;
      Object.keys(items).forEach(function (k) { tall = Math.max(tall, items[k].floors.length * FLOOR_H + 2); });
      return { tall: tall, ext: [cols * PITCH, tall, rows * PITCH] };
    }
    function minZoom() {
      if (!s.ctl) return SHOW_ZOOM;
      var d = s.fitD ? s.fitD(showAllExt().ext) : s.D;
      return Math.max(0.2, Math.min(s.ctl.maxZoom * 0.5, d > 0 ? SHOW_ZOOM * s.D / d : SHOW_ZOOM));
    }
    s.anim.push(function () { if (s.ctl) s.ctl.minZoom = minZoom(); });

    // living city: working pips bob, the beacon of a building that needs you pulses, hover lifts
    s.anim.push(function (dt, t) {
      Object.keys(items).forEach(function (k) {
        var b = items[k];
        var lift = hover === k ? 0.35 : 0;
        b.body.position.y += (lift - b.body.position.y) * (s.rm ? 1 : Math.min(1, dt * 10));
        if (b.beacon.visible && !s.rm) b.beacon.scale.setScalar(1 + 0.25 * Math.sin(t * 5));
        Object.keys(b.pips).forEach(function (n) {
          var p = b.pips[n], h0 = p.userData.home;
          if (h0 && p.userData.status === 'working' && !s.rm) p.position.y = h0[1] + 0.08 * Math.sin(t * 4 + p.position.x * 3);
          else if (h0) p.position.y = h0[1];
        });
      });
    });

    // smooth zoom for the buttons
    var zoomGoal = null;
    s.anim.push(function (dt) {
      if (zoomGoal == null) return;
      s.cam.zoom += (zoomGoal - s.cam.zoom) * (s.rm ? 1 : Math.min(1, dt * 8));
      s.cam.updateProjectionMatrix();
      if (Math.abs(zoomGoal - s.cam.zoom) < 0.002) zoomGoal = null;
    });
    function zoomBy(f) { zoomGoal = Math.max(s.ctl ? s.ctl.minZoom : SHOW_ZOOM, Math.min(5, (zoomGoal || s.cam.zoom) * f)); }

    function fit(now) {
      var a = showAllExt();
      zoomGoal = SHOW_ZOOM;
      // reduced motion: the engine cuts every camera move (stage.goal ends on its first step), so the page passes no flag
      s.frame([0, a.tall / 3, 0], 20, 1, !!now, a.ext, cssMs('duration-camera', 600));
    }
    // Fly to a building, then call done (the page goes inside).
    function focus(key, done) {
      var b = items[key];
      if (!b) { if (done) done(); return; }
      var hgt = b.floors.length * FLOOR_H;
      zoomGoal = 1;
      s.frame([b.g.position.x, hgt / 2, b.g.position.z], 4.5, 1, false, [BW + 2, hgt + 2, BD + 2], cssMs('duration-camera', 600));
      if (done) setTimeout(done, s.rm ? 0 : cssMs('duration-camera', 600) + 80);
    }

    // pointer: hover lifts a building, a click flies in
    var cv = s.r.domElement, ray = new T.Raycaster(), ndc = new T.Vector2(), down = null;
    ray.layers.enableAll();
    function hit(e) {
      var r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, s.cam);
      var hits = ray.intersectObjects(world.children, true);
      for (var i = 0; i < hits.length; i++) { var k = hits[i].object.userData.city; if (k != null && items[k]) return k; }
      return null;
    }
    cv.addEventListener('pointermove', function (e) {
      var k = hit(e);
      if (k !== hover) { hover = k; cv.style.cursor = k != null ? 'pointer' : ''; if (opts.onHover) opts.onHover(k == null ? null : items[k].data); }
    });
    cameraFeel(s, {
      onWheel: function () { zoomGoal = null; },
      bounds: function () { var hx = plaza.scale.x / 2, hz = plaza.scale.z / 2; return [-hx, hx, -hz, hz]; }
    });
    // zoom in to go inside: scrolling in at full zoom enters the building under the cursor, or the one
    // in the middle of the view
    var pushes = 0, pushT = 0, entering = false;
    function nearest() {
      var tg = s.ctl ? s.ctl.target : s.target, best = null, bd = Infinity;
      Object.keys(items).forEach(function (k) { var b = items[k], d = Math.hypot(b.g.position.x - tg.x, b.g.position.z - tg.z); if (d < bd) { bd = d; best = k; } });
      return best;
    }
    cv.addEventListener('wheel', function (e) {
      if (entering || e.deltaY >= 0 || !s.ctl) { pushes = 0; return; }
      if (s.cam.zoom < s.ctl.maxZoom * 0.97) return;
      var now = Date.now();
      pushes = now - pushT < 800 ? pushes + 1 : 1; pushT = now;
      if (pushes < 2) return;
      var k = hover != null ? hover : (hitAt(0, 0) || nearest());
      if (k == null || !opts.onPick) return;
      entering = true;
      opts.onPick(items[k].data);
    }, { passive: true });
    function hitAt(x, y) {
      ndc.set(x, y); ray.setFromCamera(ndc, s.cam);
      var hits = ray.intersectObjects(world.children, true);
      for (var i = 0; i < hits.length; i++) { var k = hits[i].object.userData.city; if (k != null && items[k]) return k; }
      return null;
    }
    cv.addEventListener('pointerleave', function () { hover = null; cv.style.cursor = ''; if (opts.onHover) opts.onHover(null); });
    cv.addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointerup', function (e) {
      if (!down) return;
      var moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 6) return;
      var k = hit(e);
      if (k != null && opts.onPick) opts.onPick(items[k].data);
    });

    // theme changes repaint the signs (their text is drawn on a canvas)
    var mo = new MutationObserver(function () { setTimeout(function () { Object.keys(items).forEach(function (k) { setSign(items[k]); }); }, 0); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return {
      update: update, focus: focus, fit: fit, zoomBy: zoomBy,
      // the theme of the page: an id of AgentOffice.MODES (day, night, sublevel, fluent, fluent-dark); the stage sets data-theme on the root
      setMode: function (m) { s.setMode(m); },
      // for tests and the console: the camera zoom and its limits
      state: function () { return { zoom: s.cam.zoom, min: s.ctl ? s.ctl.minZoom : null, max: s.ctl ? s.ctl.maxZoom : null, buildings: Object.keys(items).length, entering: entering }; },
      dispose: function () { mo.disconnect(); flock.dispose(); s.dispose(); }
    };
  }

  window.OfficeCity = { cameraFeel: cameraFeel, birds: birds, streetsAround: streetsAround, mount: function (el, opts) { var c = City(el, opts); window.OfficeCity.last = c; return c; } };
})();
