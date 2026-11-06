/* Agent Office for Claude Code x0.2: agent character in the scene (#150).
   A bot that has a persona (the record is personas.mjs, set in the Agents dialog) wears its accessory, and shows a body cue
   when its status asks for one: a raised hand when it waits for you, a head scratch after an error, a stretch when it is
   finished. The cue comes from the session status only (the adapter's events, OfficeVocab.persona.cueOf), so a bot never
   moves by itself and never moves itself anywhere: only a small arm turns on the spot. Under reduced motion (stage.rm) there is
   no cue and the arm stays hidden. The shape and the color of the persona are the bot's own look, set when the bot is seated
   (building.js), not here. Colors are DS tokens of the stage (stage.K.tok): scene-dark or bubble, whichever reads on the bot's body. A host adapter, like terminal.js: it registers a frame,
   never a pick target, and reads the stage only through office.inspect().

   window.OfficePersona
     attach(office, { session(botName) -> session or null, host? }) -> { dispose(), cueOf(botName) }
       cueOf: the cue now shown on that bot ('raise-hand', 'scratch-head', 'stretch') or null. For tests and the console. */
(function () {
  'use strict';
  var T = window.THREE, H = window.OfficeSceneHost, V = window.OfficeVocab;
  var NOOP = { dispose: function () {}, cueOf: function () { return null; } };

  // Where the bot's head is, by DS shape (components/bundle.js Parts.bot): the top of the body, the eye height, the eye depth.
  var HEAD = { blob: { top: 1.03, eye: 0.58, ez: 0.42 }, cone: { top: 1.2, eye: 0.5, ez: 0.32 }, octa: { top: 1.04, eye: 0.58, ez: 0.42 }, capsule: { top: 1.23, eye: 0.7, ez: 0.42 } };

  function attach(office, o) {
    o = o || {};
    var st = null;
    try { var ins0 = office && office.inspect && office.inspect(); st = ins0 && ins0.stage; } catch (x) { st = null; }
    if (!T || !H || !V || !V.persona || !st || !st.scene || !st.K) return NOOP;
    var host = o.host || H.attach(office);
    if (!host) return NOOP;
    var K = st.K, self = { dead: false }, cues = {};
    var sessionOf = typeof o.session === 'function' ? o.session
      : function (n) { var a = window.officeAdapter; return a && a.session ? a.session(n) : null; };

    function inspect() { try { return office.inspect(); } catch (x) { return null; } }
    function mat(tok) { return K.m(K.tok[tok] || K.tok['scene-dark']); }
    // The mark token on this bot's body: scene-dark or bubble, whichever reads better (OfficeVocab.persona.markOn; test/contrast.test.mjs).
    function markTok(b) { return V.persona.markOn(b.color, K.tok['scene-dark'], K.tok.bubble); }
    function add(g, geo, m, x, y, z) { var me = new T.Mesh(geo, m); me.position.set(x, y, z); me.castShadow = false; me.userData.noNav = 1; me.userData.officePersonaDecor = 1; g.add(me); return me; }

    // The accessory as a group on the bot's body. Shapes only: no texture, no text.
    function accessory(kind, shape, tok) {
      var h = HEAD[shape] || HEAD.blob, g = new T.Group();
      g.userData.noNav = 1; g.userData.officePersonaDecor = 1;
      if (kind === 'glasses') {
        var ink = mat(tok);
        [-0.13, 0.13].forEach(function (x) { var r = add(g, new T.TorusGeometry(0.095, 0.014, 8, 20), ink, x, h.eye, -h.ez - 0.03); r.castShadow = false; });
        add(g, new T.BoxGeometry(0.08, 0.014, 0.014), ink, 0, h.eye, -h.ez - 0.03);
      } else if (kind === 'hat') {
        var hm = mat(tok);
        add(g, new T.CylinderGeometry(0.4, 0.4, 0.04, 24), hm, 0, h.top - 0.02, 0);
        add(g, new T.CylinderGeometry(0.24, 0.27, 0.24, 24), hm, 0, h.top + 0.1, 0);
      } else if (kind === 'headset') {
        var hs = mat(tok);
        var arc = add(g, new T.TorusGeometry(0.5, 0.025, 8, 24, Math.PI), hs, 0, h.top - 0.5 + 0.02, 0);
        arc.rotation.z = 0;
        [-1, 1].forEach(function (sd) { add(g, new T.SphereGeometry(0.09, 12, 10), hs, sd * 0.5, h.top - 0.5 + 0.02, 0); });
        add(g, new T.BoxGeometry(0.015, 0.015, 0.2), hs, 0.5, h.top - 0.5 - 0.06, -0.1);
      } else if (kind === 'scarf') {
        var sm = mat(tok);
        var sc = add(g, new T.TorusGeometry(0.42, 0.07, 8, 28), sm, 0, h.eye - 0.32, 0);
        sc.rotation.x = Math.PI / 2;
      } else return null;
      return g;
    }

    // The arm: one small cylinder that hangs from the shoulder. Hidden until a cue asks for it.
    function arm(tok) {
      var pivot = new T.Group();
      pivot.userData.noNav = 1; pivot.userData.officePersonaDecor = 1;
      var m = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 0.4, 10), mat(tok));
      m.position.y = -0.2; m.castShadow = false; m.userData.noNav = 1; m.userData.officePersonaDecor = 1;
      pivot.add(m);
      pivot.visible = false;
      return pivot;
    }

    function dress(b, persona) {
      var body = b.body, shape = (b.shape in HEAD) ? b.shape : 'blob';
      var u = b.g.userData.officePersona;
      var sig = (persona.accessory || 'none') + '|' + shape + '|' + markTok(b) + (K.tok && K.tok['scene-dark']) + (K.tok && K.tok.bubble);
      if (u && u.sig === sig && u.body === body) return u;
      if (u && u.acc && u.acc.parent) u.acc.parent.remove(u.acc);
      if (u && u.arm && u.arm.parent) u.arm.parent.remove(u.arm);
      var h = HEAD[shape];
      var tok = markTok(b), a = accessory(persona.accessory, shape, tok), ar = arm(tok);
      ar.position.set(0.5, h.eye - 0.2, 0);
      if (a) body.add(a);
      body.add(ar);
      u = b.g.userData.officePersona = { sig: sig, body: body, acc: a, arm: ar, y: ar.position.y };
      return u;
    }

    function undress(b) {
      var u = b.g && b.g.userData.officePersona;
      if (!u) return;
      if (u.acc && u.acc.parent) u.acc.parent.remove(u.acc);
      if (u.arm && u.arm.parent) u.arm.parent.remove(u.arm);
      b.g.userData.officePersona = null;
    }

    function frame(dt, t) {
      if (self.dead) return;
      if (st.dead) { dispose(); return; }
      try {
        var ins = inspect();
        cues = {};
        ((ins && ins.bots) || []).forEach(function (b) {
          if (!b || !b.name || !b.g || !b.body || b.floor !== ins.floor) return;
          var s = null;
          try { s = sessionOf(b.name); } catch (x) { s = null; }
          var p = s && s.persona;
          if (!p) { undress(b); return; }
          var u = dress(b, p);
          var cue = V.persona.cueOf(V.status(s).key, !!st.rm);
          cues[b.name] = cue;
          var pose = V.persona.pose(cue, t || 0);
          u.arm.visible = !!cue;
          if (cue) { u.arm.rotation.z = pose.arm; u.arm.position.y = u.y + pose.lift; }
        });
      } catch (x) { /* one bad frame must not stop the office */ }
    }

    var offFrame = host.frame(frame);
    function dispose() {
      if (self.dead) return;
      self.dead = true;
      try { offFrame(); } catch (x) { /* gone already */ }
      var ins = inspect();
      ((ins && ins.bots) || []).forEach(function (b) { if (b && b.g) undress(b); });
    }
    return { dispose: dispose, cueOf: function (name) { return cues[name] || null; } };
  }

  window.OfficePersona = { attach: attach };
})();
