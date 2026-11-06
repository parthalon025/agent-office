/* Agent Office for Claude Code x0.2: the /events wire format.
   The server sends the whole snapshot when a page connects, then one patch per broadcast with only what changed.
   The snapshot is lean: per session only the fields the page reads, with caps. Full data of one session is on
   request (GET /api/session?uid=). Both ends use this one file, so they never disagree. Plain script, no I/O, no
   timers. The page loads it as a script (window.OfficeWire). The server and the tests import it for its side effect
   and read globalThis.OfficeWire.

     lean(state)        -> the snapshot the page gets. state: { sessions (each with place), plan, figures, notes, pins, repos, kinds, security }
     leanCall(c)        -> one tool call as the page reads it
     diff(prev, next)   -> the patch from one lean snapshot to the next, or null when nothing changed
     apply(prev, patch) -> the next snapshot. prev does not change; the parts that did not change are shared
     fits(snap, patch)  -> true when the patch starts from that snapshot (same seq)
     sender()           -> the server side: next(snap) gives the numbered patch for connected pages, full() the
                           snapshot for a page that connects now, reset() when no page is connected
     SESSION_FIELDS, CAPS

   Patch: { patch: 1, base, seq, set: { field: value }, unset: [field], sub: { field: sub-patch } }.
   A keyed list (sessions by uid; calls and replies by id) has the sub-patch { drop: [key], put: [new or changed item],
   edit: [{ k: key, p: patch of the item }], order?: [key], all?: [whole list] }. A map (figures, notes, pins) has
   { put: { key: value }, drop: [key] }. A page that gets a patch that does not fit connects again and gets a snapshot.
*/
(function (root) {
  'use strict';

  // Every session field the page reads (building.js, office.js, terminal.js, board.js, chat-extras.js, vocab.js).
  // A field the page does not read stays on the server. Add a field here when the page starts to read it.
  var SESSION_FIELDS = ['uid', 'provider', 'name', 'status', 'cwd', 'headless', 'note', 'model', 'mode', 'tool', 'prompt', 'promptAt', 'live',
    'error', 'turns', 'cost', 'costUnknown', 'supervision', 'usage', 'ctxTokens', 'ctxWindow', 'todos', 'agents', 'calls', 'replies', 'pending', 'questions',
    'inbox', 'commands', 'skills', 'features', 'scheduleId', 'startedAt', 'endedAt', 'lastEvent', 'git', 'place', 'olderReplies', 'hq'];
  // Per session and broadcast. calls: the tracker's own limit (MAX_CALLS); the boards and the terminal count all of them.
  // replyChars: the newest replies whose text fits, and always the newest one. The rest is on request, and the session says
  // how many it left out (olderReplies), so the page asks for them before it fills the chat (#80).
  var CAPS = { calls: 60, replyChars: 32000 };
  var SHAPE = {
    sessions: { key: 'uid', item: { calls: { key: 'id' }, replies: { key: 'id' } } },
    figures: { map: true }, notes: { map: true }, pins: { map: true }
  };

  function leanCall(c) {
    var o = { id: c.id, name: c.name, detail: c.detail, t: c.t, ok: c.ok === undefined ? null : c.ok };   // ok: null is an open call
    if (c.file) o.file = c.file;
    if (c.agent) o.agent = c.agent;
    if (typeof c.ms === 'number') o.ms = c.ms;
    if (c.err) o.err = c.err;
    return o;
  }
  function capReplies(list) {
    var out = [], n = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      var len = String(list[i].text || '').length;
      if (out.length && n + len > CAPS.replyChars) break;
      n += len; out.unshift(list[i]);
    }
    return out;
  }
  function pick(o, fields) {
    var out = {};
    fields.forEach(function (f) { out[f] = o[f] === undefined ? null : o[f]; });
    return out;
  }
  function leanSession(s) {
    var o = pick(s, SESSION_FIELDS);
    o.calls = (s.calls || []).slice(-CAPS.calls).map(leanCall);
    o.replies = capReplies(s.replies || []);
    o.olderReplies = (s.replies || []).length - o.replies.length;
    o.pending = (s.pending || []).map(function (r) { var x = Object.assign({}, r); delete x.key; return x; });   // key: the call key, server only
    o.inbox = (s.inbox || []).map(function (m) { return { t: m.t }; });   // the page counts queued messages
    o.git = s.git ? { branch: s.git.branch } : null;
    ['todos', 'agents', 'questions', 'commands', 'skills', 'features'].forEach(function (f) { if (!o[f]) o[f] = []; });
    return o;
  }
  function lean(state) {
    return {
      sessions: (state.sessions || []).map(leanSession),
      plan: state.plan || null,
      figures: state.figures || {},
      notes: state.notes || {},
      pins: state.pins || {},
      repos: state.repos || [],
      kinds: state.kinds || [],   // the agent kinds (providers/index.mjs kinds): fixed while the server runs, so no patch repeats them
      security: state.security || null,  // the Security room (#70): rules, what is enforced, the Spend screen
      hq: state.hq || null               // Paperclip HQ (#76, paperclip.mjs view): null until the user connects it
    };
  }

  // ---------- diff ----------
  function same(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }
  function keysOf(list, key) {
    var out = {}, n = 0;
    for (var i = 0; i < list.length; i++) { var k = list[i] && list[i][key]; if (k == null || out[k] !== undefined) return null; out[k] = list[i]; n++; }
    return out;
  }
  function diffList(a, b, sp) {
    var key = sp.key, old = keysOf(a, key), now = keysOf(b, key);
    if (!old || !now) return same(a, b) ? null : { all: b };   // no unique keys: send the whole list
    var p = { drop: [], put: [], edit: [] }, order = [];
    a.forEach(function (x) { if (now[x[key]] === undefined) p.drop.push(x[key]); else order.push(x[key]); });
    b.forEach(function (x) {
      var k = x[key], o = old[k];
      if (o === undefined) { p.put.push(x); order.push(k); return; }
      if (sp.item) { var e = diffObj(o, x, sp.item); if (e) p.edit.push({ k: k, p: e }); }
      else if (!same(o, x)) p.put.push(x);
    });
    // apply keeps the old order and adds new items at the end; send the order only when that is not the result
    if (order.join('\u0000') !== b.map(function (x) { return x[key]; }).join('\u0000')) p.order = b.map(function (x) { return x[key]; });
    ['drop', 'put', 'edit'].forEach(function (f) { if (!p[f].length) delete p[f]; });
    return Object.keys(p).length ? p : null;
  }
  function diffMap(a, b) {
    var p = { put: {}, drop: [] };
    Object.keys(b).forEach(function (k) { if (!(k in a) || !same(a[k], b[k])) p.put[k] = b[k]; });
    Object.keys(a).forEach(function (k) { if (!(k in b)) p.drop.push(k); });
    if (!Object.keys(p.put).length) delete p.put;
    if (!p.drop.length) delete p.drop;
    return Object.keys(p).length ? p : null;
  }
  function isList(v) { return Array.isArray(v); }
  function isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function diffObj(a, b, shape) {
    var p = {};
    Object.keys(b).forEach(function (k) {
      var sp = shape && shape[k], x = a[k], y = b[k], d;
      if (y === undefined) return;
      if (x === undefined) { (p.set || (p.set = {}))[k] = y; return; }
      if (sp && sp.key && isList(x) && isList(y)) d = diffList(x, y, sp);
      else if (sp && sp.map && isMap(x) && isMap(y)) d = diffMap(x, y);
      else { if (!same(x, y)) (p.set || (p.set = {}))[k] = y; return; }
      if (d) (p.sub || (p.sub = {}))[k] = d;
    });
    Object.keys(a).forEach(function (k) { if (a[k] !== undefined && b[k] === undefined) (p.unset || (p.unset = [])).push(k); });
    return Object.keys(p).length ? p : null;
  }
  function diff(prev, next) { return diffObj(prev, next, SHAPE); }

  // ---------- apply ----------
  function applyList(a, p, sp) {
    if (p.all) return p.all;
    var key = sp.key, drop = {}, put = {}, edit = {}, had = {}, out = [];
    (p.drop || []).forEach(function (k) { drop[k] = true; });
    (p.put || []).forEach(function (x) { put[x[key]] = x; });
    (p.edit || []).forEach(function (e) { edit[e.k] = e.p; });
    a.forEach(function (x) {
      var k = x[key];
      had[k] = true;
      if (drop[k]) return;
      out.push(put[k] || (edit[k] ? applyObj(x, edit[k], sp.item) : x));
    });
    (p.put || []).forEach(function (x) { if (!had[x[key]]) out.push(x); });
    if (p.order) {
      var by = {};
      out.forEach(function (x) { by[x[key]] = x; });
      out = p.order.map(function (k) { return by[k]; }).filter(function (x) { return x !== undefined; });
    }
    return out;
  }
  function applyMap(a, p) {
    var o = Object.assign({}, a);
    (p.drop || []).forEach(function (k) { delete o[k]; });
    Object.assign(o, p.put || {});
    return o;
  }
  function applyObj(a, p, shape) {
    var o = Object.assign({}, a);
    Object.assign(o, p.set || {});
    (p.unset || []).forEach(function (k) { delete o[k]; });
    Object.keys(p.sub || {}).forEach(function (k) {
      var sp = (shape && shape[k]) || {};
      o[k] = sp.map ? applyMap(a[k] || {}, p.sub[k]) : applyList(a[k] || [], p.sub[k], sp);
    });
    return o;
  }
  function apply(prev, patch) {
    var o = applyObj(prev, patch, SHAPE);
    if (patch.seq !== undefined) o.seq = patch.seq;
    return o;
  }
  function fits(snap, patch) { return !!snap && !!patch && snap.seq === patch.base; }

  function sender() {
    var base = null, seq = 0;
    return {
      next: function (snap) {
        // A copy: the tracker changes its objects in place (a call closes, usage grows), and the base must stay
        // what the pages have, or the next diff misses the change.
        snap = JSON.parse(JSON.stringify(snap));
        if (!base) { base = snap; seq++; return null; }
        var p = diff(base, snap);
        if (!p) return null;
        p.patch = 1; p.base = seq; p.seq = ++seq;
        base = snap;
        return p;
      },
      full: function () { return base ? Object.assign({ seq: seq }, base) : null; },
      has: function () { return !!base; },
      reset: function () { base = null; }
    };
  }

  root.OfficeWire = { lean: lean, leanCall: leanCall, diff: diff, apply: apply, fits: fits, sender: sender, SESSION_FIELDS: SESSION_FIELDS, CAPS: CAPS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
