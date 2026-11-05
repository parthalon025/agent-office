/* Agent Office for Claude Code x0.1: the toast list rules.
   Pure: no DOM, no timers. The page (office.js) owns the timer and calls these with the time.
   - A toast with an action or an error stays until the user closes it.
   - Every other toast closes after AFTER_MS. The time stands still while the pointer or the focus is on the stack.
   - The stack holds MAX toasts. A new toast pushes out the oldest timed toast first, so one that needs action stays.
   - On a narrow screen the stack sits above the boxes that stand on the dock (lift, #79). */
(function (root) {
  'use strict';
  var MAX = 4, AFTER_MS = 8000;
  var GAP = 8, TOP = 64, ROOM = 96;   // px: gap above a box; top of the view kept for the DS header; room the stack needs (about one toast)

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

  // Distance (px) from the bottom of the view to the bottom edge of the stack. viewH is the window height, strip is
  // --strip-clear (the dock and its gap), boxes are { top, bottom } rects of visible boxes. A box on the dock ends at
  // the dock (within 1 px); the stack goes above the highest one. It never goes lower than the dock, and never so high
  // that fewer than ROOM px stay between it and the top of the view.
  function lift(viewH, strip, boxes) {
    var top = viewH;
    (boxes || []).forEach(function (b) {
      if (b.bottom - b.top > 0 && b.bottom >= viewH - strip - 1 && b.top < top) top = b.top;
    });
    if (top >= viewH) return strip;
    return Math.max(strip, Math.min(viewH - top + GAP, viewH - TOP - ROOM));
  }

  root.OfficeToasts = { MAX: MAX, AFTER_MS: AFTER_MS, GAP: GAP, TOP: TOP, ROOM: ROOM, lift: lift, sticky: sticky, add: add, tick: tick, hasTimed: hasTimed, remove: remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
