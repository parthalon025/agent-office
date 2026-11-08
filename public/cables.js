/* Agent Office for Claude Code x0.2: the reporting lines of the HQ as cables (#226).
   A host adapter like lobby.js: in the HQ building (building.js mount.hq), each reporting line of the floor on screen is a cable. It rises
   from the employee's desk to the ceiling, runs under the DS cable tray and comes down at the manager's desk. When the manager (or the
   report) sits on another floor, the cable runs along the tray to the elevator and goes up or down the shaft there, and a label at the
   elevator names that floor and the people at the other end. The lines come from the server (snap.hq.cables, hq-model.mjs cablesOf) by
   way of mount.cables(): the page keeps no copy of the org chart.
   The engine builds the floors, the desks and the tray; this file only adds the cables (decor, noNav) to the shown floor group, and only
   in the floor view. It never moves a bot. The cable is the HQ office type color (type-hq, a themed DS material: K.t), so a theme change
   colors it again. A label has the faces of a desk nameplate (FACE: scene-dark with bubble ink, test/contrast.test.mjs) and keeps the DS
   body and caption sizes on screen at every zoom, as a nameplate does (lobby.js). It reads the stage only through the host (shown floor,
   view, rebuild, frames) and office.inspect().bots, like lobby.js.

   Pure part (window.OfficeCables.pure; tested in test/cables.test.mjs):
     routes(cables, floorId, seats, geo) -> [{ key, points: [[x, y, z]...] }] and labels: { routes, labels: [{ key, title, sub, at }] }
       cables: [{ from, to, fromFloor, toFloor, fromFloorName, toFloorName }] (bot names and DS floor ids), floorId: the floor on screen,
       seats: { botName: { x, z } } of the bots seated on it, geo: { tray: { y, z, sx }, elev: { x, z }, depth }.
     boxes(points, t) -> [{ x, y, z, w, h, d }]: one box of thickness t per segment (every segment runs along one axis).
   Browser part: attach(office, { host, cables() }) -> { refresh(), dispose(), count() }. */
(function (root) {
  'use strict';

  // ---------- pure ----------
  var DESK_Y = 0.95, LIFT_Y = 5.7, LANES = 5;
  function r2(v) { return Math.round(v * 100) / 100; }
  // The point at a desk where its cable starts: the left edge of the desk, in front of the seat (the nameplate stands on the right edge).
  function deskAt(s) { return [r2(s.x - 0.95), DESK_Y, r2(s.z - 0.9)]; }
  function names(list) { return list.length <= 2 ? list.join(' and ') : list.slice(0, 2).join(', ') + ' and ' + (list.length - 2) + ' more'; }
  function routes(cables, floorId, seats, geo) {
    var out = [], far = {}, lane = 0;
    var tr = geo.tray, E = geo.elev, dz = r2(geo.depth / 2 - 0.6);
    (cables || []).forEach(function (c) {
      var hereFrom = c.fromFloor === floorId && seats[c.from], hereTo = c.toFloor === floorId && seats[c.to];
      if (!hereFrom && !hereTo) return;
      if (c.fromFloor === c.toFloor && !(hereFrom && hereTo)) return;   // both ends here, one not seated yet: the next look draws it
      var i = lane++ % LANES, y = r2(tr.y - 0.3 - 0.1 * i), z = r2(tr.z + 0.45 + 0.1 * i);
      if (hereFrom && hereTo) {
        var a = deskAt(seats[c.from]), b = deskAt(seats[c.to]);
        out.push({ key: c.from + '>' + c.to, points: [a, [a[0], y, a[2]], [a[0], y, z], [b[0], y, z], [b[0], y, b[2]], b] });
        return;
      }
      // one end here: to the elevator, then up or down the shaft toward the other floor
      var mine = hereFrom ? c.from : c.to, other = hereFrom ? c.toFloor : c.fromFloor, up = other > floorId, d = deskAt(seats[mine]), sx = r2(tr.sx + 0.45 + 0.1 * i);
      if (!E || !seats[mine]) return;
      out.push({ key: c.from + '>' + c.to, points: [d, [d[0], y, d[2]], [d[0], y, z], [sx, y, z], [sx, y, dz], [sx, LIFT_Y, dz], [E.x, LIFT_Y, dz], [E.x, LIFT_Y, E.z], [E.x, up ? LIFT_Y + 1.5 : 3.75, E.z]] });
      var g = far[other] || (far[other] = { floor: other, name: hereFrom ? c.toFloorName : c.fromFloorName, up: up, managers: [], reports: [] });
      (hereFrom ? g.managers : g.reports).push(hereFrom ? c.to : c.from);
    });
    var labels = Object.keys(far).map(function (k) { return far[k]; }).sort(function (a, b) { return b.floor - a.floor; }).map(function (g, n) {
      var sub = [g.managers.length ? 'Reports to ' + names(g.managers) : '', g.reports.length ? names(g.reports) + (g.reports.length === 1 ? ' reports here' : ' report here') : ''].filter(Boolean).join(' · ');
      return { key: 'floor:' + g.floor, title: (g.up ? 'Up to ' : 'Down to ') + g.name, sub: sub, at: E ? [E.x, r2(LIFT_Y + 2.2 + n * 1.3), E.z] : null };
    }).filter(function (l) { return l.at; });
    return { routes: out, labels: labels };
  }
  function boxes(points, t) {
    var out = [];
    for (var i = 1; i < points.length; i++) {
      var a = points[i - 1], b = points[i], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]), dz = Math.abs(b[2] - a[2]);
      if (dx + dy + dz < 0.01) continue;
      out.push({ x: r2((a[0] + b[0]) / 2), y: r2((a[1] + b[1]) / 2), z: r2((a[2] + b[2]) / 2), w: r2(dx + t), h: r2(dy + t), d: r2(dz + t) });
    }
    return out;
  }
  // The label at the elevator: the faces of a desk nameplate (lobby.js FACES.plate, checked in test/contrast.test.mjs), as DS token names.
  var FACE = { face: 'scene-dark', ink: 'bubble', subAlpha: 0.85 };
  var pure = { routes: routes, boxes: boxes, FACE: FACE };

  // ---------- browser ----------
  function cssNum(name, fallback) { try { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--' + name)); return isFinite(v) && v > 0 ? v : fallback; } catch (x) { return fallback; } }
  function attach(office, o) {
    o = o || {};
    var T = root.THREE, host = o.host, ins0 = null, Kit = root.OfficeScreenKit;
    try { ins0 = office && office.inspect && office.inspect(); } catch (x) { ins0 = null; }
    var st = ins0 && ins0.stage;
    var none = { refresh: function () {}, dispose: function () {}, count: function () { return 0; } };
    if (!T || !st || !host || !Kit) return none;
    var K = st.K, dead = false, group = null, made = { geos: [], mats: [], labels: [] }, sig = '', acc = 0;
    function clear() {
      if (group && group.parent) group.parent.remove(group);
      made.geos.forEach(function (g) { g.dispose(); });
      made.mats.forEach(function (m) { m.dispose(); });
      made.labels.forEach(function (l) { if (l.mesh.material.map) l.mesh.material.map.dispose(); l.mesh.material.dispose(); });
      made = { geos: [], mats: [], labels: [] }; group = null; sig = '';
    }
    // A label is a sprite drawn at the DS body and caption sizes (LK canvas px per CSS px) and scaled each frame to that many CSS pixels,
    // so it reads at every zoom (the nameplate rule of lobby.js). Its lower middle stands on the point it names.
    var LK = 3, LPAD = 8;
    function makeLabel(l) {
      var body = cssNum('type-body-size', 13), cap = cssNum('type-caption-size', 11), t0 = Kit.newTex(8, 8), c = t0.canvas.getContext('2d');
      c.font = Kit.font(K, body, 600); var tw = c.measureText(l.title).width;
      c.font = Kit.font(K, cap, 500); var sw = l.sub ? c.measureText(l.sub).width : 0;
      var w = Math.min(260, Math.ceil(Math.max(tw, sw)) + 2 * LPAD), h = Math.round(body * 1.45 + (l.sub ? cap * 1.4 : 0) + LPAD);
      t0.tex.dispose();
      var t = Kit.newTex(Math.round(w * LK), Math.round(h * LK)), g = t.canvas.getContext('2d'), k = LK, tok = K.tok;
      g.fillStyle = tok[FACE.face]; g.fillRect(0, 0, t.canvas.width, t.canvas.height);
      g.fillStyle = tok[FACE.ink]; g.textBaseline = 'middle';
      g.font = Kit.font(K, body * k, 600); g.fillText(Kit.clip(g, l.title, (w - 2 * LPAD) * k), LPAD * k, (LPAD / 2 + body * 0.72) * k);
      if (l.sub) { g.globalAlpha = FACE.subAlpha; g.font = Kit.font(K, cap * k, 500); g.fillText(Kit.clip(g, l.sub, (w - 2 * LPAD) * k), LPAD * k, (LPAD / 2 + body * 1.45 + cap * 0.7) * k); g.globalAlpha = 1; }
      t.tex.needsUpdate = true;
      var m = new T.Sprite(new T.SpriteMaterial({ map: t.tex, transparent: true, depthTest: false, depthWrite: false }));
      m.material.fog = false; m.material.toneMapped = false; m.renderOrder = 900; m.layers.set(1);   // like a nameplate: no bloom, no light
      m.center.set(0.5, 0); m.userData.noNav = 1; m.name = 'hq-cable-label';
      m.position.set(l.at[0], l.at[1], l.at[2]);
      return { mesh: m, w: w, h: h };
    }
    function placeLabels() {
      if (!made.labels.length) return;
      var cv = st.r.domElement, wpp = (st.cam.top - st.cam.bottom) / (st.cam.zoom || 1) / (cv.clientHeight || 1);
      made.labels.forEach(function (l) { l.mesh.scale.set(l.w * wpp, l.h * wpp, 1); });
    }
    function geoOf(fg) {
      var u = fg.userData || {}, E = u.elev, ex = E && (E.x != null ? E.x : E.position && E.position.x), ez = E && (E.z != null ? E.z : E.position && E.position.z);
      return u.tray ? { tray: u.tray, elev: ex != null && ez != null ? { x: r2(ex), z: r2(ez) } : null, depth: 12 } : null;
    }
    function refresh() {
      if (dead) return;
      var fg = host.view() === 'floor' ? host.shownFloor() : null, ins = null;
      try { ins = office.inspect(); } catch (x) { ins = null; }
      var geo = fg && geoOf(fg);
      if (!fg || !ins || !geo) { if (group) clear(); return; }
      var seats = {};
      (ins.bots || []).forEach(function (b) { if (b && b.g && b.seat && !b.ephemeral && b.floor === ins.floor && host.floorOf(b.g) === fg) seats[b.name] = { x: b.seat.x, z: b.seat.z }; });
      var r = routes(o.cables ? o.cables() : [], ins.floor, seats, geo), color = K.tok['type-hq'] || K.tok.accent;
      var s = JSON.stringify([fg.uuid, r, color, K.tok[FACE.face], K.tok[FACE.ink], K.f && K.f.sans]);
      if (s === sig && group && group.parent === fg) return;
      clear(); sig = s;
      if (!r.routes.length) return;
      group = new T.Group(); group.name = 'hq-cables'; group.userData.noNav = 1;
      var mat = K.t('type-hq', { roughness: 0.5 });
      made.mats.push(mat);
      r.routes.forEach(function (c) {
        boxes(c.points, 0.08).forEach(function (b) {
          var g = new T.BoxGeometry(b.w, b.h, b.d), me = new T.Mesh(g, mat);
          made.geos.push(g);
          me.position.set(b.x, b.y, b.z); me.castShadow = false; me.receiveShadow = false; me.userData.noNav = 1; me.name = 'hq-cable';
          group.add(me);
        });
      });
      r.labels.forEach(function (l) { var lb = makeLabel(l); made.labels.push(lb); group.add(lb.mesh); });
      fg.add(group);
      placeLabels();
    }
    // a floor or theme rebuild redraws at once; the bots' seats settle a moment after a mount, so a 1 s tick looks again
    var offRebuild = host.onRebuild(function () { try { refresh(); } catch (x) { /* the next tick tries again */ } });
    var offFrame = host.frame(function (dt) {
      placeLabels();
      acc += dt || 0; if (acc < 1) return; acc = 0;
      try { refresh(); } catch (x) { /* the next tick tries again */ }
    });
    try { refresh(); } catch (x) { /* the first tick tries again */ }
    function dispose() { if (dead) return; dead = true; offRebuild(); offFrame(); clear(); }
    return { refresh: refresh, dispose: dispose, count: function () { return group ? group.children.filter(function (c) { return c.name === 'hq-cable'; }).length : 0; } };
  }

  root.OfficeCables = { attach: attach, pure: pure };
})(typeof globalThis !== 'undefined' ? globalThis : window);
