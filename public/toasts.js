/* Agent Office for Claude Code x0.1: the toast list rules.
   Pure: no DOM, no timers. The page (office.js) owns the timer and calls these with the time.
   - A toast with an action or an error stays until the user closes it.
   - Every other toast closes after AFTER_MS. The time stands still while the pointer or the focus is on the stack.
   - The stack holds MAX toasts. A new toast pushes out the oldest timed toast first, so one that needs action stays. */
(function (root) {
  'use strict';
  var MAX = 4, AFTER_MS = 8000;

  function sticky(t) { return !!(t && (t.action || t.tone === 'error')); }

  // The list with toast t added at time now. id and until are set here.
  function add(list, t, id, now) {
    var next = list.concat([Object.assign({}, t, { id: id, until: sticky(t) ? 0 : now + AFTER_MS })]);
    while (next.length > MAX) {
      var i = 0;
      for (var k = 0; k < next.length - 1; k++) { if (!sticky(next[k])) { i = k; break; } }   // the newest toast is never the one that goes
      next.splice(i, 1);
    }
    return next;
  }

  // The list at time now. last is the time of the previous call. While paused, the clocks wait.
  function tick(list, now, last, paused) {
    if (paused) {
      var dt = Math.max(0, now - last);
      return dt ? list.map(function (t) { return t.until ? Object.assign({}, t, { until: t.until + dt }) : t; }) : list;
    }
    var keep = list.filter(function (t) { return !t.until || t.until > now; });
    return keep.length === list.length ? list : keep;
  }

  function hasTimed(list) { return list.some(function (t) { return !!t.until; }); }
  function remove(list, id) { return list.filter(function (t) { return t.id !== id; }); }

  root.OfficeToasts = { MAX: MAX, AFTER_MS: AFTER_MS, sticky: sticky, add: add, tick: tick, hasTimed: hasTimed, remove: remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
