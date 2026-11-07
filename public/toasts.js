/* Agent Office for Claude Code x0.2: the toast list rules.
   Pure: no DOM, no timers. The page (office.js) owns the timer and calls these with the time.
   - A toast with an action or an error stays until the user closes it.
   - Every other toast closes after AFTER_MS. The time stands still while the pointer or the focus is on the stack.
   - The stack holds MAX toasts. A new toast pushes out the oldest timed toast first, so one that needs action stays.
   - The stack never covers the top controls, the floors card, the dock, a request bar or a message box, at any width (place, #79).
   Tested in test/toasts.test.mjs. office.js owns the timer.
   Placement. The page toast stack (.page-toasts) is placed by one rule at every width and window height: OfficeToasts.place,
   fed by office.js, which measures the boxes and sets --toast-x, --toast-bottom and --toast-room on the stack.
   - It never covers a KEEP box: the top controls, the floors card, the zoom column, the dock and More list, every request
     bar (.asks), the panel head and message box, the chat's Approve and Decline (.ao-act) and composer, the decisions
     inbox and the city controls.
   - It covers an AVOID box (DS HUD boxes, the panels, the welcome card) only when no band is free of it.
   - A request bar can sit anywhere and grow: it is measured, cut by its scrolling parents, never assumed.
   - With no band of 40 px the stack waits out of sight (is-off) and its clocks wait.
   - Add a new box to KEEP or AVOID in office.js. Do not write a left, top or bottom rule for .page-toasts
     (test/toasts.test.mjs fails on one).
   - The Ctrl+K palette (.ao-cmdk-o) is one layer above the stack. */
(function (root) {
  'use strict';
  var MAX = 4, AFTER_MS = 8000;
  // px: the gap kept around a box and at the window edges; the window edge of a column (--space-4); a band that shows a
  // toast title and a line of text; the least band the stack takes at all (one line, then it scrolls)
  var GAP = 8, EDGE = 16, MIN_H = 64, LEAST = 40;

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

  // Where the stack goes (#79): one rule at every width and window height. Pure: the page measures, this decides.
  //   view  { w, h }: the window.  stack { w }: the width of the stack.
  //   home  { x, y }: the stack's own place: its left edge, and the line its bottom stands on (the top of the dock).
  //   keep  [{ left, top, right, bottom }]: what the stack never covers: the top controls, the floors card, the dock,
  //         every request bar (Approve, Decline) and message box, wherever it sits and however tall it grows.
  //   avoid [rects]: what it covers only when no band is free of it: the chat, the room card, the panels.
  // Candidate left edges are home.x, the window edge, and the edges of every box. In each column the free bands are
  // the gaps between the boxes that cross it (GAP kept clear around each box and at the window edges). The stack takes a
  // band of at least MIN_H free of keep and avoid; else one free of keep only; else the tallest band free of keep that
  // is at least LEAST high. It prefers its own column, then the band nearest its home line, then the taller band.
  // Result: { x, bottom, maxH } in px (bottom from the bottom of the window; the stack scrolls when it is taller than
  // maxH), or { hidden: true } when no band of LEAST is free of keep: the stack then waits out of sight.
  function place(view, stack, home, keep, avoid) {
    var W = view.w, H = view.h, sw = Math.max(0, stack.w || 0);
    var real = function (r) { return r && r.right > r.left && r.bottom > r.top; };
    keep = (keep || []).filter(real); avoid = (avoid || []).filter(real);
    var all = keep.concat(avoid), hi = Math.max(EDGE, W - EDGE - sw);
    var at = function (x) { return Math.min(Math.max(x, EDGE), hi); };
    var xs = [at(home.x), at(EDGE)];
    all.forEach(function (r) { xs.push(at(r.right + GAP), at(r.left - GAP - sw)); });
    xs = xs.filter(function (x, i) { return xs.indexOf(x) === i; });
    var homeY = Math.min(home.y, H - GAP);
    function bands(x, boxes) {   // the free bands of the column [x, x + sw), top to bottom
      var cut = boxes.filter(function (r) { return r.left - GAP < x + sw && r.right + GAP > x; })
        .map(function (r) { return [r.top - GAP, r.bottom + GAP]; }).sort(function (a, b) { return a[0] - b[0]; });
      var out = [], y = GAP;
      cut.forEach(function (c) { if (c[0] > y) out.push({ top: y, bottom: c[0] }); y = Math.max(y, c[1]); });
      if (H - GAP > y) out.push({ top: y, bottom: H - GAP });
      return out;
    }
    function pick(boxes, least, score) {
      var best = null;
      xs.forEach(function (x) {
        bands(x, boxes).forEach(function (b) {
          var tall = b.bottom - b.top;
          if (tall < least) return;
          var y = Math.min(Math.max(homeY, b.top + Math.min(MIN_H, tall)), b.bottom);   // the bottom edge, as near home as the band lets it
          var s = score(x, y, tall);
          for (var i = 0; best && i < s.length && s[i] === best.s[i]; i++);
          if (!best || (i < s.length && s[i] < best.s[i])) best = { s: s, x: x, y: y, top: b.top };
        });
      });
      return best ? { x: best.x, bottom: H - best.y, maxH: best.y - best.top } : null;
    }
    var near = function (x, y, tall) { return [Math.abs(x - home.x), Math.abs(y - homeY), -tall]; };
    return pick(all, MIN_H, near) || pick(keep, MIN_H, near)
      || pick(keep, LEAST, function (x, y, tall) { return [-tall, Math.abs(x - home.x), Math.abs(y - homeY)]; })
      || { hidden: true };
  }

  root.OfficeToasts = { MAX: MAX, AFTER_MS: AFTER_MS, GAP: GAP, EDGE: EDGE, MIN_H: MIN_H, LEAST: LEAST, place: place, sticky: sticky, add: add, tick: tick, hasTimed: hasTimed, remove: remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
