/* Agent Office for Claude Code x0.1: wheel gate.
   Decides when scrolling out leaves a level (floor, then building, then city). One trackpad flick sends
   dozens of wheel events, some of them after the finger lifts. Without a gate one flick would leave the
   floor and the building in one go. The gate lets one gesture change one level.
   Plain script, no I/O, no timers: the caller passes the time. The page loads it as a script
   (window.OfficeWheelGate). The tests import it for its side effect and read globalThis.OfficeWheelGate.

     OfficeWheelGate.create(opts) -> gate
       opts.pause   ms after a level change in which wheel input is ignored (default 600)
       opts.window  ms in which pushes count together (default 800)
       opts.gap     ms of quiet that ends a gesture (default 140)
       opts.need    { level: pushes } (default floor 2, building 3)
     gate.push(level, now, eligible) -> true when the push should leave the level.
       eligible false means the wheel event does not count (not zoomed out, wrong place); it still keeps
       the gesture and the pause up to date.
     gate.holding(now) -> true during the pause after a level change and for the rest of that gesture.
       The caller stops these events, so the DS camera does not cancel the framing the change started.
     gate.reset() clears the pushes (the view changed by other means). */
(function (root) {
  'use strict';
  function create(o) {
    o = o || {};
    var pause = o.pause == null ? 600 : o.pause, win = o.window == null ? 800 : o.window, gap = o.gap == null ? 140 : o.gap;
    var need = Object.assign({ floor: 2, building: 3 }, o.need || {});
    var pushes = 0, pushT = -Infinity, pushLevel = null, lastEv = -Infinity, pauseUntil = -Infinity, spent = false;
    return {
      push: function (level, now, eligible) {
        if (now - lastEv > gap) spent = false;   // quiet for a moment: a new gesture
        lastEv = now;
        if (now < pauseUntil || spent || eligible === false) { pushes = 0; return false; }
        pushes = level === pushLevel && now - pushT < win ? pushes + 1 : 1;
        pushLevel = level; pushT = now;
        if (pushes < (need[level] || 2)) return false;
        pushes = 0; spent = true; pauseUntil = now + pause;   // the rest of this gesture does nothing
        return true;
      },
      // true while this gesture or the pause after a level change is still running
      holding: function (now) { return spent || now < pauseUntil; },
      reset: function () { pushes = 0; }
    };
  }
  root.OfficeWheelGate = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
