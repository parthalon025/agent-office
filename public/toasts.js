/* Agent Office for Claude Code x0.1: the toast list rules.
   Pure: no DOM, no timers. The page (office.js) owns the timer and calls these with the time.
   - A toast with an action or an error stays until the user closes it.
   - Every other toast closes after AFTER_MS. The time stands still while the pointer or the focus is on the stack.
   - The stack holds MAX toasts. A new toast pushes out the oldest timed toast first, so one that needs action stays.
   - On a narrow screen the stack sits above the boxes that stand on the dock and below the top controls (lift, #79). */
(function (root) {
  'use strict';
  var MAX = 4, AFTER_MS = 8000;
  var GAP = 8, MIN_H = 64;   // px: gap between the stack and a box or the top controls; least height of the stack (a toast title and a line of text, then it scrolls)

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

  // Where the stack stands on a narrow screen: { bottom, maxH } in px. viewH is the window height, strip is --strip-clear
  // (the dock and its gap), boxes are { top, bottom } rects of the visible boxes, topEdge is the bottom of the top
  // controls (the DS header and the floors card; 0 when none shows). A box on the dock ends at the dock (within 1 px);
  // the stack goes above the highest one, and its height is the free band between the top controls and its bottom edge
  // (it scrolls when a toast is taller). When that band is shorter than MIN_H, the stack does not rise: it stands on the
  // dock edge over the boxes and takes the band above the dock, because a request must stay in sight and the top
  // controls stay free. Never less than MIN_H high.
  function lift(viewH, strip, boxes, topEdge) {
    var top = viewH, edge = topEdge > 0 ? topEdge : 0;
    (boxes || []).forEach(function (b) {
      if (b.bottom - b.top > 0 && b.bottom >= viewH - strip - 1 && b.top < top) top = b.top;
    });
    var bottom = top >= viewH ? strip : Math.max(strip, viewH - top + GAP);
    var room = viewH - bottom - edge - GAP;
    if (room < MIN_H) { bottom = strip; room = viewH - strip - edge - GAP; }
    return { bottom: bottom, maxH: Math.max(MIN_H, room) };
  }

  root.OfficeToasts = { MAX: MAX, AFTER_MS: AFTER_MS, GAP: GAP, MIN_H: MIN_H, lift: lift, sticky: sticky, add: add, tick: tick, hasTimed: hasTimed, remove: remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
