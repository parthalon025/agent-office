/* Agent Office for Claude Code x0.2: the layers of detail (ADR 0006, #145).
   A topic file of the session vocabulary: it adds layers to globalThis.OfficeVocab (one global, public/vocab.js).
   Load it after vocab.js. Plain script, no I/O, no timers. */
(function (root) {
  'use strict';
  var shared = root.OfficeVocab.shared;
  var own = shared.own, bare = shared.bare, count = shared.count, clip = shared.clip, oneLine = shared.oneLine, money = shared.money;
  var V = root.OfficeVocab;
  var status = V.status, plan = V.plan, taskLine = V.taskLine, figures = V.figures;
  // ---------- layers (ADR 0006, #145) ----------
  // Every surface shows one layer of detail and opens the next with one tap. Glance: a color and a mood, text only when
  // something needs the owner. Look: one sentence of intent, goal progress, cost so far. Inspect: chat, terminal, timeline,
  // diff, raw calls. Deep: the Security room, raw request text, logs. The facts live here; the page only reads them.
  var LAYER_ORDER = ['glance', 'look', 'inspect', 'deep'];
  function layerOpens(l) { var i = LAYER_ORDER.indexOf(l); return i >= 0 && i < LAYER_ORDER.length - 1 ? LAYER_ORDER[i + 1] : ''; }
  var LAYER_SURFACES = bare({
    city: { layer: 'glance' }, floor: { layer: 'glance' }, room: { layer: 'look' }, agent: { layer: 'look' },
    chat: { layer: 'inspect' }, terminal: { layer: 'inspect' }, changes: { layer: 'inspect' }, timeline: { layer: 'inspect' },
    security: { layer: 'deep' }, request: { layer: 'deep' }, logs: { layer: 'deep' }
  });
  Object.keys(LAYER_SURFACES).forEach(function (k) { LAYER_SURFACES[k].opens = layerOpens(LAYER_SURFACES[k].layer); });
  var MOOD = { error: 'Failed', waiting: 'Needs you', review: 'Needs you', working: 'Busy', finished: 'Calm', resting: 'Calm' };
  function mood(state) { var k = state || 'resting'; return { key: k, word: MOOD[k] || 'Calm' }; }
  // fig: figures() of a city building, floor or room; worst: its worst state. Text only on need: "2 need you", or "Failed".
  function glance(fig, worst) {
    var f = fig || {}, w = worst || (f.waiting > 0 ? 'waiting' : f.working > 0 ? 'working' : 'resting');
    var text = w === 'error' ? 'Failed' : w === 'waiting' && f.waiting > 0 ? f.waiting + (f.waiting === 1 ? ' needs you' : ' need you') : w === 'waiting' || w === 'review' ? 'Needs you' : '';
    return { state: w, mood: mood(w), text: text };
  }
  // The Look layer of one session: intent (one sentence), progress ("2 of 5 steps", '' with no plan) and cost so far.
  function look(s) {
    var t = (s && s.todos) || [], done = t.filter(function (x) { return x.status === 'completed'; }).length;
    var intent = oneLine(s && s.prompt) || taskLine(s || {});
    return { intent: clip(intent, 120), progress: t.length ? done + ' of ' + t.length + (t.length === 1 ? ' step' : ' steps') : '',
      cost: s && s.costUnknown ? 'unknown' : s && typeof s.cost === 'number' ? money(s.cost) : '' };
  }
  // The layer a place is used at most: mem is { place: { layer: count } }. A tie goes to the lower layer. A new place opens at Glance.
  function remember(mem, place, layer) {
    var m = Object.assign({}, mem || {});
    if (!place || LAYER_ORDER.indexOf(layer) < 0) return m;
    var c = Object.assign({}, own(m, place) ? m[place] : {});
    c[layer] = (c[layer] || 0) + 1;
    m[place] = c;
    return m;
  }
  function layerFor(mem, place) {
    var c = own(mem, place) ? mem[place] : null, best = 'glance', n = 0;
    LAYER_ORDER.forEach(function (l) { if (c && (c[l] || 0) > n) { n = c[l]; best = l; } });
    return best;
  }
  // The Look layer of a room: its agents together. Intent is the newest agent's; steps and cost are sums.
  function lookRoom(list) {
    var l = list || [], steps = 0, done = 0, cost = 0, unknown = false, newest = null;
    l.forEach(function (s) {
      var t = s.todos || [];
      steps += t.length; done += t.filter(function (x) { return x.status === 'completed'; }).length;
      if (s.costUnknown) unknown = true; else if (typeof s.cost === 'number') cost += s.cost;
      if (!newest || (s.lastEvent || 0) >= (newest.lastEvent || 0)) newest = s;
    });
    return { count: l.length, intent: newest ? look(newest).intent : '', progress: steps ? done + ' of ' + steps + (steps === 1 ? ' step' : ' steps') : '',
      cost: unknown ? 'unknown' : l.some(function (s) { return typeof s.cost === 'number'; }) ? money(cost) : '' };
  }
  // Remembered layers come back from storage text: only known layers with whole counts are kept.
  function parseMem(raw) {
    var out = {}, m;
    try { m = JSON.parse(raw); } catch (x) { return out; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    Object.keys(m).forEach(function (p) {
      var c = m[p], k = {}, any = false;
      if (p === '__proto__' || !c || typeof c !== 'object') return;
      LAYER_ORDER.forEach(function (l) { if (own(c, l) && Number.isInteger(c[l]) && c[l] > 0) { k[l] = c[l]; any = true; } });
      if (any) out[p] = k;
    });
    return out;
  }
  // A place used at Inspect or Deep opens there on the first tap; Glance and Look show the Look card first.
  function opensAt(l) { return LAYER_ORDER.indexOf(l) >= LAYER_ORDER.indexOf('inspect'); }
  var layers = { lookRoom: lookRoom, parse: parseMem, opensAt: opensAt, order: LAYER_ORDER, opens: layerOpens, surfaces: LAYER_SURFACES, surface: function (id) { return own(LAYER_SURFACES, id) ? LAYER_SURFACES[id] : null; },
    mood: mood, glance: glance, look: look, remember: remember, layerFor: layerFor };

  Object.assign(root.OfficeVocab, { layers: layers });
})(typeof globalThis !== 'undefined' ? globalThis : window);
