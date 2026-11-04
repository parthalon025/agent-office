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
     parts                             -> finders for the DS geometry: isWall, isBackWall, isSideWall, isSign, isBoard

   Browser part: attach(office) -> host, one per mounted office.
     host.view(), host.inBuilding(), host.shownFloor(), host.onShownFloor(m, fg), host.inScene(m), host.shown(m)
     host.rooms()                      -> [{ rg, room }] of the shown floor
     host.frame(fn)                    -> off(); fn(dt, t) runs every frame before the engine draws
     host.onRebuild(fn)                -> off(); fn(reasons) runs before the frame when the scene changed
     host.register(target)             -> off(); a pick target (see below)
     host.leave()                      -> the target drops its hover (the host clears the cursor)
     host.rehover()                    -> pick again under the pointer on the next frame
     host.dispose()

   A pick target: { name, active() -> bool, meshes() -> [mesh], itemOf(mesh) -> item,
                    hover(item|null, hit), click(item, hit, event), bypass(event) -> true to consume a click,
                    anchors() -> [mesh] that must stay in the scene (a rebuild when one is gone) }.
   The host raycasts all active targets together, so there is one winner. A bot in front of it wins the click
   (it is the engine's). The host owns the pointer cursor on the stage canvas. */
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

  var pure = { inScene: inScene, shown: shown, floorOf: floorOf, floorGroups: floorGroups, shownFloor: shownFloor, viewOf: viewOf, roomGroups: roomGroups, rebuilt: rebuilt, choose: choose, parts: parts };

  // ---------- browser ----------
  function attach(office) {
    var T = root.THREE, st = null;
    try { var ins0 = office && office.inspect && office.inspect(); st = ins0 && ins0.stage; } catch (x) { st = null; }
    if (!T || !st || !st.scene || !st.K || !st.r || !st.cam || !st.anim) return null;
    var K = st.K, cv = st.r.domElement, scene = st.scene;
    var targets = [], frames = [], rebuildFns = [], dead = false;
    var ray = new T.Raycaster(), ndc = new T.Vector2();
    var ptr = null, hoverT = null, hoverItem = null, cursorMine = false, down = null, downFg = null, prev = null;

    function inspect() { try { return office.inspect(); } catch (x) { return null; } }
    function curShownFloor() { return shownFloor(scene, inspect()); }
    function onShownFloor(m, fg) { return !!fg && floorOf(scene, m) === fg && shown(scene, m); }

    // ----- cursor: the host owns it. It clears only a pointer it set. -----
    function setCursor(on) {
      if (on) { if (cv.style.cursor !== 'pointer') cv.style.cursor = 'pointer'; cursorMine = true; }
      else if (cursorMine) { if (cv.style.cursor === 'pointer') cv.style.cursor = ''; cursorMine = false; }
    }

    // ----- pick: one raycast over all active targets, one winner -----
    function pick(x, y) {
      var r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      var fg = curShownFloor();
      if (!fg) return null;
      var owner = new Map(), meshes = [];
      targets.forEach(function (t) {
        if (!t.active()) return;
        t.meshes().forEach(function (m) { if (onShownFloor(m, fg) && !owner.has(m)) { owner.set(m, t); meshes.push(m); } });
      });
      if (!meshes.length) return null;
      ndc.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, st.cam);
      var hits = ray.intersectObjects(meshes, false);
      if (!hits.length) return null;
      var ins = inspect(), bl = [];
      if (ins) (ins.bots || []).forEach(function (b) { if (b && b.hit && b.floor === ins.floor) bl.push(b.hit); });
      var bh = bl.length ? ray.intersectObjects(bl, false)[0] : null;
      var cands = hits.map(function (h) { return { distance: h.distance, hit: h, target: owner.get(h.object), item: owner.get(h.object).itemOf(h.object) }; }).filter(function (c) { return c.item; });
      return choose(cands, bh ? bh.distance : null);
    }
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
      for (var i = 0; i < targets.length; i++) { if (targets[i].bypass && targets[i].bypass(e)) return; }
      var w = pick(e.clientX, e.clientY);
      if (w) w.target.click(w.item, w.hit, e);   // one click, one action
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
        var cur = state(), why = rebuilt(prev, cur);
        prev = cur;
        if (why.length && ptr) ptr.dirty = true;   // meshes changed: pick again under the pointer
        if (why.length) rebuildFns.slice().forEach(function (fn) { try { fn(why); } catch (x) { /* one adapter must not stop the others */ } });
        if (ptr && ptr.dirty) { ptr.dirty = false; hoverStep(); }
      } catch (x) { /* one bad frame must not stop the office */ }
      frames.slice().forEach(function (fn) { try { fn(dt, t); } catch (x) { /* one bad frame must not stop the office */ } });
    }
    try { prev = state(); } catch (x) { prev = null; }
    st.anim.push(tick);

    function add(list, fn) { list.push(fn); return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; }
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
      targets = []; frames = []; rebuildFns = []; hoverT = null;
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
      register: function (t) { return add(targets, t); },
      leave: release,
      rehover: function () { if (ptr) ptr.dirty = true; },
      hovered: function () { return hoverT ? { target: hoverT, item: hoverItem } : null; },
      dispose: dispose
    };
  }

  root.OfficeSceneHost = { attach: attach, pure: pure };
})(typeof globalThis !== 'undefined' ? globalThis : window);
