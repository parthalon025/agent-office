/* Agent Office for Claude Code x0.2: agent character, wall views and rituals (#150, #151, #152).
   A topic file of the session vocabulary: it adds persona, wall, rituals to globalThis.OfficeVocab (one global, public/vocab.js).
   Load it after vocab.js. Plain script, no I/O, no timers. */
(function (root) {
  'use strict';
  var shared = root.OfficeVocab.shared;
  var own = shared.own;
  var V = root.OfficeVocab;
  var status = V.status, plan = V.plan;
  // Agent character (#150). The record is personas.mjs; these are the words, the look and the body cue the page and the
  // server share. A persona shape is a plain word; the DS bot shape it draws is below. The cue comes from a DS status key only
  // (adapter events), and is none under reduced motion. pose() is the arm angle (0 hangs down, PI points up) and lift of a cue at a time in seconds: small,
  // bounded, smooth. The 3D part (public/persona.js) only applies it.
  var PERSONA_SHAPE = { round: 'blob', square: 'octa', tall: 'cone', wide: 'capsule' };
  var STYLE_WORD = { careful: 'Careful', fast: 'Fast', chatty: 'Chatty' };
  var ACCESSORY_WORD = { none: 'None', glasses: 'Glasses', hat: 'Hat', headset: 'Headset', scarf: 'Scarf' };
  var COLOR_WORD = ['Blue', 'Green', 'Orange', 'Purple', 'Pink', 'Teal', 'Yellow', 'Violet'];   // the first 8 of the DS body colors (AgentOffice.BODY_COLORS)
  var CUE = { waiting: 'raise-hand', error: 'scratch-head', finished: 'stretch' };
  function pshape(p) { return p && own(PERSONA_SHAPE, p.shape) ? PERSONA_SHAPE[p.shape] : undefined; }
  function lookOf(p, colors) {
    if (!p) return null;
    var c = colors && p.color != null && p.color >= 0 && p.color < colors.length ? colors[p.color] : undefined;
    return { shape: pshape(p), color: c, accessory: p.accessory };
  }
  function cueOf(statusKey, reduced) { return reduced || !own(CUE, statusKey) ? null : CUE[statusKey]; }
  function pose(cue, t) {
    var s = Math.sin(t * 2 * Math.PI * 0.8);
    if (cue === 'raise-hand') return { arm: Math.PI * 0.85 + s * 0.2, lift: 0 };
    if (cue === 'scratch-head') return { arm: Math.PI * 0.75 + s * 0.35, lift: 0 };
    if (cue === 'stretch') return { arm: Math.PI * 0.97 + s * 0.03, lift: 0.15 + 0.1 * s };
    return { arm: 0, lift: 0 };
  }
  // The token an accessory or the arm is drawn in on a body color: the dark scene token or the light bubble token, whichever
  // reads better (WCAG ratio). Colors are #rrggbb. A body that is not a hex color gets the dark one.
  function lum(h) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(h || ''));
    if (!m) return null;
    return [0, 2, 4].map(function (i) { var c = parseInt(m[1].substr(i, 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); })
      .reduce(function (a, c, i) { return a + c * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // The token of the mark on a body color: 'scene-dark' or 'bubble', whichever reads better on it (the token name, never a theme word).
  function markOn(body, deep, pale) {
    if (lum(body) == null || lum(deep) == null || lum(pale) == null) return 'scene-dark';
    return ratio(deep, body) >= ratio(pale, body) ? 'scene-dark' : 'bubble';
  }
  var persona = {
    markOn: markOn, ratio: ratio,
    shapeOf: pshape, lookOf: lookOf, cueOf: cueOf, pose: pose,
    colorWord: function (i) { return COLOR_WORD[i] || ''; }, COLOR_COUNT: COLOR_WORD.length,
    styleWord: function (k) { return own(STYLE_WORD, k) ? STYLE_WORD[k] : ''; },
    accessoryWord: function (k) { return own(ACCESSORY_WORD, k) ? ACCESSORY_WORD[k] : ''; }
  };

  // The blackboard views of a room (#152): what the room's wall screen shows. The choice is saved by room key (personas.mjs setScreen,
  // exported with the setup). Overview is the default and is never saved. A view names the columns under the plan line.
  var WALL_VIEWS = [
    { id: 'overview', word: 'Overview', note: 'Browser steps, last steps and the repository.', cols: ['browser', 'recent', 'repo'] },
    { id: 'steps', word: 'Steps', note: 'Browser steps and last steps, wider.', cols: ['browser', 'recent'] },
    { id: 'repo', word: 'Repository', note: 'The folders of the repository and which ones agents touched.', cols: ['repo'] }
  ];
  function wallView(id) { for (var i = 0; i < WALL_VIEWS.length; i++) if (WALL_VIEWS[i].id === id) return WALL_VIEWS[i]; return WALL_VIEWS[0]; }
  var wall = {
    VIEWS: WALL_VIEWS,
    isView: function (id) { return typeof id === 'string' && WALL_VIEWS.some(function (v) { return v.id === id; }); },
    columnsOf: function (id) { return wallView(id).cols.slice(); },
    viewOf: function (map, key) { return map && typeof key === 'string' && own(map, key) ? wallView(map[key]).id : 'overview'; },
    word: function (id) { return wallView(id).word; },
    note: function (id) { return wallView(id).note; }
  };

  // Rituals (#151): the small moments of the office. Shared by the page and the server. Focus mode and reduced motion turn every one off.
  // A ritual never covers or delays a request: a moment waits while any request is open, and a stand-up is only a line in a prompt.
  var MOMENT_MS = 10 * 60000;
  var STANDUP = 'Stand-up. Before you start, add one note to the room notes board with office_room_update (notes_append): Yesterday, Today, Blocked, one short line each. Then go on with the task.';
  function ritualsOn(o) { o = o || {}; return !o.focus && !o.reduced; }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function standupKey(name) { return 'n:' + String(name == null ? '' : name).trim().toLowerCase(); }
  function standupDue(seen, name, t, o) { return ritualsOn(o) && seen[standupKey(name)] !== dayKey(t); }
  function standupDone(seen, name, t) { seen[standupKey(name)] = dayKey(t); }
  // The merges to play now: not played yet, under 10 minutes old, and none while a request is open (they wait; the request is never held back).
  function moments(merges, played, o) {
    o = o || {};
    if (!ritualsOn(o) || o.waiting > 0) return [];
    var t = o.now == null ? Date.now() : o.now;
    return (merges || []).filter(function (m) { return !own(played || {}, m.key) && t - m.at <= MOMENT_MS; });
  }
  var rituals = { on: ritualsOn, dayKey: dayKey, standupDue: standupDue, standupDone: standupDone, moments: moments, STANDUP: STANDUP, MOMENT_MS: MOMENT_MS };


  Object.assign(root.OfficeVocab, { persona: persona, wall: wall, rituals: rituals });
})(typeof globalThis !== 'undefined' ? globalThis : window);
