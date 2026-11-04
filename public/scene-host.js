/* Agent Office for Claude Code x0.1: scene host.
   The one module that reads the DS stage (office.inspect().stage) for the page's 3D additions. Board,
   terminal, street and bird decor are adapters: they ask the host for the shown floor and view, the room
   groups by DS room id, a rebuild event, a per-frame tick, one pick and the pointer cursor.

   Pure part (no THREE, no DOM; the tests run it on plain scene graphs; window.OfficeSceneHost.pure):
     inScene(scene, m)                 -> true when m hangs under the scene
     shown(scene, m)                   -> true when m and all its parents are visible
     floorOf(scene, m)                 -> the floor group (child of the scene) that holds m, or null
     floorGroups(scene)                -> the DS floor groups (userData.LB and userData.elev)
     shownFloor(scene, ins)            -> the floor the user looks at, or null (building view, or unclear)
     viewOf(scene)                     -> 'floor' | 'building' | 'none'
     roomGroups(fg, rooms, isBack)     -> [{ rg, room }], left to right, or [] when the counts differ
     rebuilt(prev, cur)                -> list of reasons the scene was rebuilt or changed (empty: nothing)
     choose(cands, botDistance)        -> the nearest candidate, or null when a bot stands in front
     focusStep(state, ev)              -> { state, act }: the two-step focus (look, then open); see below
     freeRect(view, covers, gap, aspect) -> the part of the view that no cover hides (client px)
     facing(it, cam)                   -> how an item faces the camera: direction, camera axes, half size of its picture
     framePose(it, cam, view, free, fill) -> { target, pos, zoom }: the camera that shows an item in the free part
     parts                             -> finders for the DS geometry: isWall, isBackWall, isSideWall, isSign, isBoard

   Browser part: attach(office, { covers() -> [rect] }) -> host, one per mounted office.
     covers: the page's boxes over the scene (HUD columns, the dock, a side panel), in client px.
     host.view(), host.inBuilding(), host.shownFloor(), host.onShownFloor(m, fg), host.inScene(m), host.shown(m)
     host.rooms()                      -> [{ rg, room }] of the shown floor
     host.frame(fn)                    -> off(); fn(dt, t) runs every frame before the engine draws
     host.onRebuild(fn)                -> off(); fn(reasons) runs before the frame when the scene changed
     host.register(target)             -> off(); a pick target (see below)
     host.leave()                      -> the target drops its hover (the host clears the cursor)
     host.rehover()                    -> pick again under the pointer on the next frame
     host.focused()                    -> { key, name, open, item, verb, kind } of the item in focus, or null
     host.flying()                     -> true while the camera flies to an item or back
     host.open()                       -> the second step for the item in focus (the page's Open button)
     host.show(target, item, open?)    -> the keyboard path: look at an item, and with open take the second step too
     host.blur()                       -> fly back to the camera the first look saved
     host.refit()                      -> frame the item in focus again (a panel opened, the window changed)
     host.free(covers?)                -> the free part of the screen, the box that shows the item in focus largest
                                          (covers: default opts.covers())
     host.rect(mesh?)                  -> the screen box of a plane (default: the item in focus)
     host.onFocus(fn)                  -> off(); fn(focused() or null) after each change
     host.dispose()

   A pick target: { name, active() -> bool, meshes() -> [mesh], itemOf(mesh) -> item,
                    hover(item|null, hit), click(item, hit, event),
                    look(item) -> { key, mesh, verb, kind, fill? } or null, open(item, hit, event),
                    find(key) -> { item, mesh } or null,
                    anchors() -> [mesh] that must stay in the scene (a rebuild when one is gone) }.
   The host raycasts all active targets together, so there is one winner. A bot in front of it wins the click
   (it is the engine's). The host owns the pointer cursor on the stage canvas.
   Two steps: an item whose look() gives a spec is a screen. The first click looks at it: the camera flies so the
   plane fills most of the free part of the screen. A second click on it calls open(). An item without a spec (the
   door) calls click() at once. A click on another screen looks at that one; a click on empty scene, Esc (the
   page) or Back flies back. The camera flies here only, and the engine does not reframe while an item is in focus. */
(function (root) {
  'use strict';

  // ---------- pure ----------
  function topOf(m) { var p = m; while (p && p.parent) p = p.parent; return p; }
  function inScene(scene, m) { return !!m && topOf(m) === scene; }
  function shown(scene, m) { for (var p = m; p; p = p.parent) { if (!p.visible) return false; if (p === scene) return true; } return false; }
  function floorOf(scene, m) { var p = m; while (p && p.parent && p.parent !== scene) p = p.parent; return p && p.parent === scene ? p : null; }
  function floorGroups(scene) {
    return (scene.children || []).filter(function (g) { var u = g.userData; return u && u.LB != null && u.elev; });
  }
  // The engine hides all floors but one, and all of them in the building view. During the elevator ride to
  // another floor both floors show for a moment: the one that holds the bots of the current floor wins.
  function shownFloor(scene, ins) {
    var vis = floorGroups(scene).filter(function (g) { return g.visible; });
    if (vis.length < 2) return vis[0] || null;
    var b = ((ins && ins.bots) || []).filter(function (x) { return x && x.g && x.floor === ins.floor; })[0];
    var g = b && floorOf(scene, b.g);
    return g && vis.indexOf(g) >= 0 ? g : null;
  }
  function viewOf(scene) {
    var all = floorGroups(scene);
    if (!all.length) return 'none';
    return all.some(function (g) { return g.visible; }) ? 'floor' : 'building';
  }
  // The engine lays the rooms out left to right in building order; each room group has a back wall.
  function roomGroups(fg, rooms, isBack) {
    if (!fg || !rooms) return [];
    var rgs = (fg.children || []).filter(function (c) { return c.isGroup && (c.children || []).some(isBack); });
    rgs.sort(function (a, c) { return a.position.x - c.position.x; });
    if (rgs.length !== rooms.length) return [];
    return rooms.map(function (room, i) { return { rg: rgs[i], room: room }; });
  }
  function sameList(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // cur and prev: { bots, floor, fg, groups, tok, look, gone }
  function rebuilt(prev, cur) {
    var r = [];
    if (!prev) return r;
    if (cur.gone) r.push('gone');
    if (!sameList(prev.groups, cur.groups)) r.push('floors');
    if (prev.tok !== cur.tok || prev.look !== cur.look) r.push('theme');
    if (prev.bots !== cur.bots) r.push('bots');
    if (prev.floor !== cur.floor || prev.fg !== cur.fg) r.push('floor');
    return r;
  }
  // cands: [{ distance, ... }] from one raycast. A bot in front of the nearest one wins the click: the click is the engine's.
  function choose(cands, botDistance) {
    var best = null;
    (cands || []).forEach(function (c) { if (!best || c.distance < best.distance) best = c; });
    if (!best) return null;
    if (botDistance != null && botDistance < best.distance) return null;
    return best;
  }

  // ----- focus: look first, then open -----
  // state: { key, open }; key null: nothing is in focus. ev: { type: 'click', key } | { type: 'empty' } | { type: 'back' }.
  // act: 'look' (fly to the item), 'open' (open its input), 'back' (fly back) or null (nothing to do).
  var IDLE = { key: null, open: false };
  function focusStep(state, ev) {
    var s = state && state.key != null ? state : IDLE;
    if (ev && ev.type === 'click' && ev.key != null) {
      if (s.key === ev.key) return { state: { key: ev.key, open: true }, act: 'open' };   // also when it is open: the page shows it again
      return { state: { key: ev.key, open: false }, act: 'look' };
    }
    if (ev && (ev.type === 'empty' || ev.type === 'back') && s.key != null) return { state: IDLE, act: 'back' };
    return { state: s, act: null };
  }

  // The part of the view that no cover hides: the box, among all boxes whose edges are view or cover edges, that
  // overlaps no cover and shows the largest item of the given aspect (width / height). Without an aspect: the
  // largest area. Ties go to the larger area. gap: px kept clear around each cover. Rects: { left, top, right, bottom }
  // in client px. The page has about ten covers, so trying every box is cheap.
  function freeRect(view, covers, gap, aspect) {
    var g = gap || 0, a = aspect > 0 ? aspect : 0;
    var cs = (covers || []).filter(function (c) { return c && c.right > c.left && c.bottom > c.top; })
      .map(function (c) { return { left: c.left - g, top: c.top - g, right: c.right + g, bottom: c.bottom + g }; })
      .filter(function (c) { return c.right > view.left && c.left < view.right && c.bottom > view.top && c.top < view.bottom; });
    function edges(first, list, lo, hi) { return [first].concat(list).filter(function (v, i, all) { return v >= lo && v <= hi && all.indexOf(v) === i; }); }
    var ls = edges(view.left, cs.map(function (c) { return c.right; }), view.left, view.right);
    var rs = edges(view.right, cs.map(function (c) { return c.left; }), view.left, view.right);
    var ts = edges(view.top, cs.map(function (c) { return c.bottom; }), view.top, view.bottom);
    var bs = edges(view.bottom, cs.map(function (c) { return c.top; }), view.top, view.bottom);
    function clear(l, t, r, b) {
      for (var i = 0; i < cs.length; i++) { var c = cs[i]; if (c.left < r && c.right > l && c.top < b && c.bottom > t) return false; }
      return true;
    }
    var best = null, bestS = -1, bestA = -1;
    ls.forEach(function (l) { rs.forEach(function (r) {
      if (r <= l) return;
      ts.forEach(function (t) { bs.forEach(function (b) {
        if (b <= t) return;
        var w = r - l, h = b - t, area = w * h, s = a ? Math.min(w / a, h) : area;
        if (s < bestS - 1e-9 || (s < bestS + 1e-9 && area <= bestA) || !clear(l, t, r, b)) return;
        bestS = s; bestA = area; best = { left: l, top: t, right: r, bottom: b };
      }); });
    }); });
    return best || { left: view.left, top: view.top, right: view.right, bottom: view.bottom };
  }

  // The camera that shows an item: it faces the item and the item fills `fill` of the free part of the screen
  // (the side that limits), in its middle. Plain arrays, so the tests need no THREE.
  // it:  { c: center, n: face normal, ax: half width vector, ay: half height vector } (world)
  // cam: { dist, span (world height at zoom 1), h (CSS px height of the canvas), minPolar, maxPolar, back (fallback direction) }
  // The direction comes from the normal, turned into the polar range of the orbit controls (they clamp it each frame).
  function v3(a) { return [+a[0] || 0, +a[1] || 0, +a[2] || 0]; }
  function vadd(a, b, k) { return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vnorm(a) { var l = Math.sqrt(vdot(a, a)); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; }
  // facing(it, cam) -> { dir, right, up, sx, sy }: the direction to the camera, the camera axes, and the half size
  // of the item's picture along them (world units).
  function facing(it, cam) {
    var n = vnorm(v3(it.n)) || [0, 0, 1];
    var hz = vnorm([n[0], 0, n[2]]) || vnorm([cam.back ? cam.back[0] : 0, 0, cam.back ? cam.back[2] : 1]) || [0, 0, 1];
    var lo = cam.minPolar != null ? cam.minPolar : 0, hi = cam.maxPolar != null ? cam.maxPolar : Math.PI;
    var polar = Math.max(lo, Math.min(hi, Math.acos(Math.max(-1, Math.min(1, n[1])))));
    var dir = [Math.sin(polar) * hz[0], Math.cos(polar), Math.sin(polar) * hz[2]];
    var right = vnorm(vcross([0, 1, 0], dir)) || [1, 0, 0], up = vcross(dir, right);
    var ax = v3(it.ax), ay = v3(it.ay);
    return { dir: dir, right: right, up: up, sx: Math.abs(vdot(ax, right)) + Math.abs(vdot(ay, right)), sy: Math.abs(vdot(ax, up)) + Math.abs(vdot(ay, up)) };
  }
  function framePose(it, cam, view, free, fill) {
    var fc = facing(it, cam), dir = fc.dir, right = fc.right, up = fc.up, sx = fc.sx, sy = fc.sy;
    var fr = free && free.right - free.left >= 60 && free.bottom - free.top >= 60 ? free : view;
    var fw = fr.right - fr.left, fh = fr.bottom - fr.top, h = cam.h || 1, span = cam.span || 1;
    var px = Math.min(sx > 1e-6 ? fw / (2 * sx) : Infinity, sy > 1e-6 ? fh / (2 * sy) : Infinity);   // CSS px per world unit at fill 1
    if (!isFinite(px)) px = h / span;
    var zoom = Math.max(0.05, (fill || 0.88) * px * span / h);
    var wpp = span / (zoom * h);   // world units per CSS px
    var dx = (fr.left + fr.right) / 2 - (view.left + view.right) / 2, dy = (fr.top + fr.bottom) / 2 - (view.top + view.bottom) / 2;
    var target = vadd(vadd(v3(it.c), right, -dx * wpp), up, dy * wpp);
    return { target: target, pos: vadd(target, dir, cam.dist || 60), zoom: zoom, dir: dir, right: right, up: up };
  }

  // The DS geometry the page's decor looks for.
  function geo(m, type) { return m && m.isMesh && m.geometry && m.geometry.type === type && m.geometry.parameters; }
  function isWall(m) { var p = geo(m, 'BoxGeometry'); return !!p && Math.abs(p.height - 5.2) < 0.001; }
  var parts = {
    isWall: isWall,
    isBackWall: function (m) { return isWall(m) && m.geometry.parameters.depth < 0.5 && m.geometry.parameters.width > 1; },
    isSideWall: function (m) { return isWall(m) && m.geometry.parameters.width < 0.5; },   // the solid left wall of the first room; other rooms have a glass divider there
    isSign: function (m) { var p = geo(m, 'PlaneGeometry'); return !!p && p.width === 4.8 && p.height === 1.2; },
    isBoard: function (m) { var p = geo(m, 'PlaneGeometry'); return !!p && p.width === 4 && p.height === 2.5; }
  };

  var pure = { inScene: inScene, shown: shown, floorOf: floorOf, floorGroups: floorGroups, shownFloor: shownFloor, viewOf: viewOf, roomGroups: roomGroups, rebuilt: rebuilt, choose: choose,
    focusStep: focusStep, freeRect: freeRect, facing: facing, framePose: framePose, parts: parts };

  // ---------- browser ----------
  // A token in px or ms from the page's CSS (no DOM in the tests: the fallback).
  function cssNum(name, fallback) {
    try { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; } catch (x) { return fallback; }
  }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  var FILL = 0.88;   // a screen in focus fills this much of the free part of the view (the side that limits)

  function attach(office, opts) {
    opts = opts || {};
    var T = root.THREE, st = null;
    try { var ins0 = office && office.inspect && office.inspect(); st = ins0 && ins0.stage; } catch (x) { st = null; }
    if (!T || !st || !st.scene || !st.K || !st.r || !st.cam || !st.anim) return null;
    var K = st.K, cv = st.r.domElement, scene = st.scene;
    var targets = [], frames = [], rebuildFns = [], focusFns = [], dead = false;
    var ray = new T.Raycaster(), ndc = new T.Vector2();
    var ptr = null, hoverT = null, hoverItem = null, cursorMine = false, down = null, downFg = null, prev = null;
    // focus: the item in focus ({ target, item, key, mesh, spec, open }), its state for focusStep, the camera the
    // first look saved, the flight, and the controls' max zoom before the look widened it
    var foc = null, focusS = { key: null, open: false }, saved = null, fly = null, maxZ = null;

    function inspect() { try { return office.inspect(); } catch (x) { return null; } }
    function curShownFloor() { return shownFloor(scene, inspect()); }
    function onShownFloor(m, fg) { return !!fg && floorOf(scene, m) === fg && shown(scene, m); }

    // ----- cursor: the host owns it. It clears only a pointer it set. -----
    function setCursor(on) {
      if (on) { if (cv.style.cursor !== 'pointer') cv.style.cursor = 'pointer'; cursorMine = true; }
      else if (cursorMine) { if (cv.style.cursor === 'pointer') cv.style.cursor = ''; cursorMine = false; }
    }

    // ----- pick: one raycast over all active targets, one winner -----
    function aim(x, y) {
      var r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      ndc.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, st.cam);
      return true;
    }
    function botHits() {
      var ins = inspect(), bl = [];
      if (ins) (ins.bots || []).forEach(function (b) { if (b && b.hit && b.floor === ins.floor) bl.push(b.hit); });
      return bl.length ? ray.intersectObjects(bl, false) : [];
    }
    function pick(x, y) {
      var fg = curShownFloor();
      if (!fg || st.intro || !aim(x, y)) return null;   // the engine's intro flythrough owns the camera until it ends
      var owner = new Map(), meshes = [];
      targets.forEach(function (t) {
        if (!t.active()) return;
        t.meshes().forEach(function (m) { if (onShownFloor(m, fg) && !owner.has(m)) { owner.set(m, t); meshes.push(m); } });
      });
      if (!meshes.length) return null;
      var hits = ray.intersectObjects(meshes, false);
      if (!hits.length) return null;
      var bh = botHits()[0];
      var cands = hits.map(function (h) { return { distance: h.distance, hit: h, target: owner.get(h.object), item: owner.get(h.object).itemOf(h.object) }; }).filter(function (c) { return c.item; });
      return choose(cands, bh ? bh.distance : null);
    }
    // a click on no item: empty scene, unless a bot is under the pointer (that click is the engine's)
    function emptyAt(x, y) { return !!curShownFloor() && aim(x, y) && !botHits().length; }
    function release() {
      var t = hoverT; hoverT = null; hoverItem = null;
      if (t) { try { t.hover(null, null); } catch (x) { /* the target is gone */ } }
      setCursor(false);
    }
    function hoverStep() {
      var w = ptr ? pick(ptr.x, ptr.y) : null;
      if (hoverT && (!w || w.target !== hoverT || !hoverT.active())) { var old = hoverT; hoverT = null; hoverItem = null; old.hover(null, null); }
      if (w) { hoverT = w.target; hoverItem = w.item; w.target.hover(w.item, w.hit); }
      setCursor(!!w);
    }

    // ----- focus: look first, then open. The camera flies here and nowhere else. -----
    function ctlTarget() { return st.ctl ? st.ctl.target : st.target; }
    function vec(v) { return [v.x, v.y, v.z]; }
    function viewRect() { var r = cv.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }
    function coversNow() { try { return (opts.covers && opts.covers()) || []; } catch (x) { return []; } }
    // the free part of the view, the box that shows the item (aspect) largest; the page places its look bar in it
    function free(list, aspect) {
      if (aspect == null && foc) { var it = planeOf(foc.mesh), fc = it && facing(it, camOf()); aspect = fc && fc.sy > 0 ? fc.sx / fc.sy : 0; }
      return freeRect(viewRect(), list || coversNow(), cssNum('space-2', 8), aspect || 0);
    }
    // A plane mesh in world terms: center, half width and half height vectors, face normal (its world matrix is column-major).
    function planeOf(mesh) {
      var g = mesh && mesh.geometry && mesh.geometry.parameters;
      if (!g || !(g.width > 0) || !(g.height > 0) || !mesh.matrixWorld) return null;
      if (mesh.updateWorldMatrix) mesh.updateWorldMatrix(true, false);
      var e = mesh.matrixWorld.elements, hw = g.width / 2, hh = g.height / 2;
      return { c: [e[12], e[13], e[14]], ax: [e[0] * hw, e[1] * hw, e[2] * hw], ay: [e[4] * hh, e[5] * hh, e[6] * hh], n: [e[8], e[9], e[10]] };
    }
    function camNow() {
      var p = st.cam.position, tg = ctlTarget(), b = [p.x - tg.x, p.y - tg.y, p.z - tg.z];
      return { p: vec(p), t: vec(tg), z: st.cam.zoom, back: b, dist: Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) || 60 };
    }
    // the camera terms framePose needs
    function camOf() {
      var now = camNow(), vr = viewRect(), ctl = st.ctl;
      return { dist: saved ? saved.dist : now.dist, span: (st.cam.top - st.cam.bottom) || 1, h: cv.clientHeight || (vr.bottom - vr.top),
        minPolar: ctl ? ctl.minPolarAngle : 0, maxPolar: ctl ? ctl.maxPolarAngle : Math.PI, back: now.back };
    }
    function poseOf(spec) {
      var it = planeOf(spec.mesh);
      if (!it) return null;
      var cam = camOf(), fc = facing(it, cam);
      return framePose(it, cam, viewRect(), free(null, fc.sy > 0 ? fc.sx / fc.sy : 0), spec.fill || FILL);
    }
    // The wheel (city.js cameraFeel) keeps the zoom under the controls' max: while an item is in focus the max is above its zoom.
    function widenZoom(z) { if (!st.ctl) return; if (maxZ == null) maxZ = st.ctl.maxZoom; st.ctl.maxZoom = Math.max(maxZ, z * 1.5); }
    function restoreZoom() { if (st.ctl && maxZ != null) st.ctl.maxZoom = maxZ; maxZ = null; }
    // A flight: camera, controls target and zoom ease from where they are now. The controls are off until it lands.
    // home: the camera a look saved, while the flight goes back to it.
    function flyTo(pose, ms, home) {
      var now = camNow();
      fly = { t: 0, ms: st.rm ? 1 : ms, p0: now.p, p1: pose.pos, t0: now.t, t1: pose.target, z0: now.z, z1: pose.zoom, home: home || null };
      if (st.ctl) st.ctl.enabled = false;
    }
    function stepFly(dt) {
      var f = fly;
      if (!f) return;
      f.t = Math.min(1, f.t + (dt || 0) * 1000 / f.ms);
      var e = easeInOut(f.t), L = function (a, b) { return a + (b - a) * e; };
      st.cam.position.set(L(f.p0[0], f.p1[0]), L(f.p0[1], f.p1[1]), L(f.p0[2], f.p1[2]));
      ctlTarget().set(L(f.t0[0], f.t1[0]), L(f.t0[1], f.t1[1]), L(f.t0[2], f.t1[2]));
      st.cam.zoom = L(f.z0, f.z1); st.cam.updateProjectionMatrix();
      if (f.t >= 1) { fly = null; if (st.ctl) st.ctl.enabled = true; }   // after the flight the camera is the user's again
    }
    function info() {
      return foc ? { key: foc.key, name: foc.target.name, open: foc.open, item: foc.item, verb: foc.spec.verb || '', kind: foc.spec.kind || foc.target.name } : null;
    }
    function notify() {
      var f = info();
      focusFns.slice().forEach(function (fn) { try { fn(f); } catch (x) { /* one listener must not stop the others */ } });
      if (ptr) ptr.dirty = true;   // the hint says the next step
    }
    // Step 1: fly to face the item. The first look saves the camera; a look at another item keeps it, so Back goes to the room.
    function look(t, item, spec) {
      var home = fly && fly.home;
      if (!saved) saved = home || Object.assign(camNow(), { floor: (inspect() || {}).floor });
      var pose = poseOf(spec);
      if (!pose) { if (!foc) saved = null; return false; }
      foc = { target: t, item: item, key: spec.key, mesh: spec.mesh, spec: spec, open: false };
      focusS = { key: spec.key, open: false };
      widenZoom(pose.zoom);
      flyTo(pose, cssNum('duration-camera', 600) * 1.4, null);
      notify();
      return true;
    }
    // The keyboard path (Ctrl+K): look at an item of a registered target, and with andOpen take step 2 at once.
    // Returns false when the item has no screen to face.
    function show(t, item, andOpen) {
      if (dead || targets.indexOf(t) < 0) return false;
      var spec = null;
      try { spec = t.look ? t.look(item) : null; } catch (x) { spec = null; }
      if (!spec || spec.key == null || !spec.mesh) return false;
      if (focusS.key !== spec.key && !look(t, item, spec)) return false;
      if (andOpen) openFocus(item, null, null);
      return true;
    }
    // Step 2: the target opens the item's input (the page shows a panel or a text box).
    function openFocus(item, hit, e) {
      if (!foc) return;
      if (item) foc.item = item;
      foc.open = true; focusS = { key: foc.key, open: true };
      try { if (foc.target.open) foc.target.open(foc.item, hit || null, e || null); } catch (x) { /* the page shows nothing */ }
      notify();
    }
    function back() {
      if (!foc) return;
      var s = saved;
      foc = null; focusS = { key: null, open: false }; saved = null; restoreZoom();
      if (s) flyTo({ pos: s.p, target: s.t, zoom: s.z }, cssNum('duration-camera', 600) * 1.4, s);
      notify();
    }
    // The floor or the view changed under the item: the engine frames the new one, so the camera does not fly back.
    function drop() {
      var had = !!foc;
      foc = null; focusS = { key: null, open: false }; saved = null; fly = null; restoreZoom();
      if (st.ctl) st.ctl.enabled = true;
      if (had) notify();
    }
    // After a rebuild the item in focus has a new mesh: follow it. When it is gone, go back (same floor) or let go.
    // A theme change rebuilds every floor and the engine frames the floor at once (zoom 1): put the camera back
    // on the item in the same frame, so the user does not see the jump.
    function follow(why) {
      if (!foc) return;
      var fg = curShownFloor(), f = null;
      try { f = foc.target.find ? foc.target.find(foc.key) : null; } catch (x) { f = null; }
      if (f && f.mesh && onShownFloor(f.mesh, fg)) {
        foc.item = f.item || foc.item;
        if (f.mesh !== foc.mesh) { foc.mesh = f.mesh; foc.spec = Object.assign({}, foc.spec, { mesh: f.mesh }); }
        if (why.indexOf('theme') >= 0 || why.indexOf('floors') >= 0) refit(true);
        return;
      }
      var ins = inspect() || {};
      if (fg && saved && ins.floor === saved.floor) back(); else drop();
    }
    // Frame the item in focus again. now: at once (no flight), unless a flight to it still runs.
    function refit(now) {
      if (!foc) return;
      var pose = poseOf(foc.spec);
      if (!pose) return;
      widenZoom(pose.zoom);
      if (fly && !fly.home) { fly.p1 = pose.pos; fly.t1 = pose.target; fly.z1 = pose.zoom; return; }   // still flying in: land on the new frame
      if (now === true) {
        fly = null;
        st.cam.position.set(pose.pos[0], pose.pos[1], pose.pos[2]); ctlTarget().set(pose.target[0], pose.target[1], pose.target[2]);
        st.cam.zoom = pose.zoom; st.cam.updateProjectionMatrix();
        if (st.ctl) st.ctl.enabled = true;
        return;
      }
      flyTo(pose, cssNum('duration-camera', 600), null);
    }
    // the screen box of a plane: the notes editor lays its text box exactly over the board
    function rect(mesh) {
      var m = mesh || (foc && foc.mesh), g = m && m.geometry && m.geometry.parameters;
      if (!g || !(g.width > 0) || !(g.height > 0) || !m.localToWorld) return null;
      var r = cv.getBoundingClientRect(), xs = [], ys = [];
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
        var v = new T.Vector3(q[0] * g.width / 2, q[1] * g.height / 2, 0);
        m.localToWorld(v); v.project(st.cam);
        xs.push(r.left + (v.x + 1) / 2 * r.width); ys.push(r.top + (1 - v.y) / 2 * r.height);
      });
      return { left: Math.min.apply(null, xs), top: Math.min.apply(null, ys), width: Math.max.apply(null, xs) - Math.min.apply(null, xs), height: Math.max.apply(null, ys) - Math.min.apply(null, ys) };
    }

    // ----- clicks: one click, one action -----
    function onMove(e) { ptr = { x: e.clientX, y: e.clientY, dirty: true }; }
    function onLeave() { ptr = null; release(); }
    function onDown(e) { down = e.button === 0 ? [e.clientX, e.clientY] : null; downFg = curShownFloor(); }
    function onCancel() { down = null; }
    function onUp(e) {
      if (!down || dead) return;
      var moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
      if (moved > 6) return;
      // the engine handles pointerup first: a click on a floor in the building view shows that floor now
      if (curShownFloor() !== downFg) return;
      var w = pick(e.clientX, e.clientY);
      if (!w) { if (foc && emptyAt(e.clientX, e.clientY) && focusStep(focusS, { type: 'empty' }).act === 'back') back(); return; }
      var spec = null;
      try { spec = w.target.look ? w.target.look(w.item) : null; } catch (x) { spec = null; }
      if (!spec || spec.key == null || !spec.mesh) { if (w.target.click) w.target.click(w.item, w.hit, e); return; }   // one step: the door
      var r = focusStep(focusS, { type: 'click', key: spec.key });
      if (r.act === 'open') openFocus(w.item, w.hit, e);
      else if (r.act === 'look' && !look(w.target, w.item, spec) && w.target.open) w.target.open(w.item, w.hit, e);   // no plane to face: open at once
    }
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerleave', onLeave);

    // ----- rebuild: bots join or leave, the floor or view changes, the theme changes, a target's anchor is gone -----
    function state() {
      var ins = inspect() || {};
      var gone = false;
      for (var i = 0; i < targets.length && !gone; i++) {
        var a = targets[i].anchors ? targets[i].anchors() : [];
        for (var j = 0; j < a.length && !gone; j++) gone = !inScene(scene, a[j]);
      }
      return { bots: ins.bots, floor: ins.floor, fg: shownFloor(scene, ins), groups: floorGroups(scene), tok: K.tok, look: K.look, gone: gone };
    }
    function tick(dt, t) {
      if (dead) return;
      try {
        var now = state(), why = rebuilt(prev, now);
        prev = now;
        if (why.length && ptr) ptr.dirty = true;   // meshes changed: pick again under the pointer
        if (why.length) rebuildFns.slice().forEach(function (fn) { try { fn(why); } catch (x) { /* one adapter must not stop the others */ } });
        if (why.length) follow(why);   // the adapters scanned: the item in focus has its new mesh, or it is gone
      } catch (x) { /* one bad frame must not stop the office */ }
      try {
        if (foc && st.goal) st.goal = null;   // the engine must not reframe while an item is in focus
        stepFly(dt);
        if (fly && ptr) ptr.dirty = true;     // the item under the pointer moves while the camera flies
        if (ptr && ptr.dirty) { ptr.dirty = false; hoverStep(); }
      } catch (x) { /* one bad frame must not stop the office */ }
      frames.slice().forEach(function (fn) { try { fn(dt, t); } catch (x) { /* one bad frame must not stop the office */ } });
    }
    try { prev = state(); } catch (x) { prev = null; }
    st.anim.push(tick);

    function add(list, fn) { list.push(fn); return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; }
    function register(t) {
      var off = add(targets, t);
      return function () { off(); if (foc && foc.target === t) drop(); };
    }
    function dispose() {
      if (dead) return;
      dead = true;
      var k = st.anim.indexOf(tick);
      if (k >= 0) st.anim.splice(k, 1);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onCancel);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerleave', onLeave);
      setCursor(false);
      if (foc || fly) { fly = null; if (st.ctl) st.ctl.enabled = true; }
      restoreZoom();
      foc = null; saved = null;
      targets = []; frames = []; rebuildFns = []; focusFns = []; hoverT = null;
    }
    return {
      stage: st, canvas: cv,
      inScene: function (m) { return inScene(scene, m); },
      shown: function (m) { return shown(scene, m); },
      floorOf: function (m) { return floorOf(scene, m); },
      shownFloor: curShownFloor,
      onShownFloor: onShownFloor,
      view: function () { return viewOf(scene); },
      inBuilding: function () { return viewOf(scene) === 'building'; },
      rooms: function () {
        var ins = inspect(), fg = curShownFloor();
        var b = fg && office.getBuilding && office.getBuilding();
        var fl = b && ins && b.floors.filter(function (f) { return f.id === ins.floor; })[0];
        return fl ? roomGroups(fg, fl.rooms, parts.isBackWall) : [];
      },
      frame: function (fn) { return add(frames, fn); },
      onRebuild: function (fn) { return add(rebuildFns, fn); },
      register: register,
      leave: release,
      rehover: function () { if (ptr) ptr.dirty = true; },
      hovered: function () { return hoverT ? { target: hoverT, item: hoverItem } : null; },
      focused: info,
      flying: function () { return !!fly; },
      open: function () { if (foc && focusStep(focusS, { type: 'click', key: foc.key }).act === 'open') openFocus(null, null, null); },
      show: show,
      blur: function () { if (focusStep(focusS, { type: 'back' }).act === 'back') back(); },
      refit: function () { refit(false); },
      free: free,
      rect: rect,
      onFocus: function (fn) { return add(focusFns, fn); },
      dispose: dispose
    };
  }

  root.OfficeSceneHost = { attach: attach, pure: pure };
})(typeof globalThis !== 'undefined' ? globalThis : window);
