/* Agent Office for Claude Code x0.1: the city.
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

  function City(el, opts) {
    opts = opts || {};
    var s = new O.Stage(el, { root: opts.root || null, quality: opts.quality || 'auto', label: '3D city. Each building is a repository. Click one to go inside.', D: 22 });
    if (s.dead) return { update: function () {}, focus: function () {}, fit: function () {}, zoomBy: function () {}, dispose: function () {} };
    var K = s.K, world = new T.Group(), mats = {};
    // one themed material per token, so a theme change repaints them all
    function mat(token, o) { var k = token + (o ? JSON.stringify(o) : ''); return mats[k] || (mats[k] = K.t(token, o)); }
    s.scene.add(world);
    if (s.ctl) { s.ctl.minZoom = 0.35; s.ctl.maxZoom = 5; }

    // ground: a wide slab and a plaza that grows with the city
    var ground = X.mesh(X.box(400, 0.4, 400), mat('scene-slab'), 0, -0.8, 0, world);
    ground.castShadow = false;
    var plaza = X.mesh(X.box(1, 0.2, 1), mat('scene-floor'), 0, -0.5, 0, world);
    plaza.castShadow = false;

    var items = {};      // key -> building
    var slots = [];      // slot index -> key
    var hover = null;

    function slotXZ(i) {
      var cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(slots.length, 1))));
      var r = Math.floor(i / cols), c = i % cols;
      return [(c - (cols - 1) / 2) * PITCH, (r - (Math.ceil(slots.length / cols) - 1) / 2) * PITCH];
    }
    function signTex(name, sub) {
      var tok = K.tok, f = K.f || {};
      return X.canvasTex(512, 160, function (g, w, hh) {
        // a rounded label like the DS floor tags: name, then floors and sessions
        var r = 28;
        g.fillStyle = tok['bubble'] || tok['bg'];
        g.beginPath(); g.moveTo(r, 4); g.arcTo(w - 4, 4, w - 4, hh - 4, r); g.arcTo(w - 4, hh - 4, 4, hh - 4, r); g.arcTo(4, hh - 4, 4, 4, r); g.arcTo(4, 4, w - 4, 4, r); g.closePath(); g.fill();
        g.strokeStyle = tok['line'] || tok['muted']; g.lineWidth = 3; g.stroke();
        g.textBaseline = 'middle'; g.fillStyle = tok['ink']; g.font = '600 62px ' + (f.sans || 'sans-serif');
        g.fillText(name.length > 15 ? name.slice(0, 14) + '…' : name, 32, 62);
        g.fillStyle = tok['muted']; g.font = '500 38px ' + (f.mono || 'monospace');
        g.fillText(sub, 32, 124);
      });
    }
    function setSign(b) {
      var sub = b.floors.length + (b.floors.length === 1 ? ' floor' : ' floors') + ' · ' + b.data.sessions + (b.data.sessions === 1 ? ' session' : ' sessions');
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
      b.floors.push({ g: g, name: f.name });
      tween(s, cssMs('duration-floor', 450), 0.001, 1, function (v) { g.scale.y = v; });
    }
    function removeFloor(b) {
      var f = b.floors.pop();
      if (!f) return;
      tween(s, cssMs('duration-floor', 450), f.g.scale.y, 0.001, function (v) { f.g.scale.y = v; }, function () { s.clear(f.g); });
    }
    function placeRoof(b, animate) {
      var y = b.floors.length * FLOOR_H;
      var set = function (v) { b.roof.position.y = v + 0.15; b.sign.position.y = v + 1.9; b.beacon.position.y = v + 0.65; };
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
      var b = items[d.key] = { key: d.key, g: g, body: body, roof: roof, sign: sign, beacon: beacon, floors: [], pips: {}, slot: slot, data: d, signKey: '' };
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
      plaza.scale.set(cols * PITCH + 4, 1, rows * PITCH + 4);
    }

    // list: [{ key, name, sessions, waiting, floors: [{ name, key }], bots: [{ name, status, floor }] }]
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
      });
      Object.keys(items).forEach(function (k) { if (!seen[k]) removeBuilding(k); });
      layout();
    }

    // living city: working pips bob, the beacon of a building that needs you pulses, hover lifts
    s.anim.push(function (dt, t) {
      Object.keys(items).forEach(function (k) {
        var b = items[k];
        var lift = hover === k ? 0.35 : 0;
        b.body.position.y += (lift - b.body.position.y) * Math.min(1, dt * 10);
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
      s.cam.zoom += (zoomGoal - s.cam.zoom) * Math.min(1, dt * 8);
      s.cam.updateProjectionMatrix();
      if (Math.abs(zoomGoal - s.cam.zoom) < 0.002) zoomGoal = null;
    });
    function zoomBy(f) { zoomGoal = Math.max(0.35, Math.min(5, (zoomGoal || s.cam.zoom) * f)); }

    function fit(now) {
      var cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(slots.length, 1)))), rows = Math.max(1, Math.ceil(slots.length / cols));
      var tall = 2;
      Object.keys(items).forEach(function (k) { tall = Math.max(tall, items[k].floors.length * FLOOR_H + 2); });
      zoomGoal = 1.35;
      s.frame([0, tall / 3, 0], 20, 1, !!now, [cols * PITCH, tall, rows * PITCH], cssMs('duration-camera', 600));
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
      // for tests and the console: the camera zoom and its limits
      state: function () { return { zoom: s.cam.zoom, max: s.ctl ? s.ctl.maxZoom : null, buildings: Object.keys(items).length, entering: entering }; },
      dispose: function () { mo.disconnect(); s.dispose(); }
    };
  }

  window.OfficeCity = { cameraFeel: cameraFeel, mount: function (el, opts) { var c = City(el, opts); window.OfficeCity.last = c; return c; } };
})();
