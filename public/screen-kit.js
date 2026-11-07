/* Agent Office for Claude Code x0.2: the painted screen kit (#182).
   One Module for what every painted wall and desk screen (board.js, terminal.js, security.js, lobby.js, desk.js) shares:
   text measure, clip, wrap and fit (by a canvas context, by a column count, or by an estimate of the character width where
   Node has no canvas), color mix, the rounded rectangle, the font string and the canvas texture. A fix to wrapping applies to
   every screen. A screen file never keeps its own copy of these helpers (test/screen-kit.test.mjs fails on one). Plain script,
   no DOM at load: the canvas, the texture and the stage tokens come in as arguments. Load it before the screens (index.html),
   and import it before a screen in a test. The estimate (charW, fitSize, wrapEst, wrapEstAll) is one rule for a plan and its
   test. Tested in test/screen-kit.test.mjs.
   window.OfficeScreenKit
     clip(c, text, maxW, ell = '…')          text, or its start and ell, so it measures <= maxW
     chop(c, text, maxW, ell)                the start of text and ell (ell added even when it fits)
     wrap(c, text, maxW, { lines?, para?, clip? })  words into lines by c.measureText. lines: at most that many, the last cut with '…'.
                                             para: split on newlines and keep empty lines. clip: an ellipsis ('' for none) cut on each line.
     clipCols(text, n)                       text cut to n columns, '...' at the end
     wrapCols(text, cols, first?, rest?)     words into rows of a column count (the terminal)
     charW(size, wt), fitSize(str, s, maxW, wt), wrapEst(str, size, maxW, wt), wrapEstAll(list, ...)   the estimate (no canvas): the plan and its test
     mix(a, b, t), rr(c, x, y, w, h, r), font(K, px, weight, mono), newTex(w, h)   drawing set-up (K is the stage's kit)  */
(function (root) {
  'use strict';

  function chop(c, text, maxW, ell) {
    text = String(text == null ? '' : text); ell = ell || '';
    while (text.length > 1 && c.measureText(text + ell).width > maxW) text = text.slice(0, -1);
    return text + ell;
  }
  function clip(c, text, maxW, ell) {
    text = String(text == null ? '' : text);
    if (c.measureText(text).width <= maxW) return text;
    return chop(c, text, maxW, ell == null ? '…' : ell);
  }
  function wrap(c, text, maxW, o) {
    o = o || {};
    var cap = o.lines || 0, out = [], full = String(text == null ? '' : text);
    (o.para ? full.split(/\n/) : [full]).forEach(function (para) {
      var line = '', words = para.split(/\s+/);
      for (var i = 0; i < words.length; i++) {
        var t = line ? line + ' ' + words[i] : words[i];
        if (line && c.measureText(t).width > maxW) { out.push(line); line = words[i]; if (cap && out.length === cap) break; } else line = t;
      }
      if (o.para || (line && (!cap || out.length < cap))) out.push(line);
    });
    var cut = !!cap && out.length === cap && full.split(/\s+/).join(' ').length > out.join(' ').length;
    return out.map(function (l, i) {
      if (cut && i === out.length - 1) return chop(c, l, maxW, '…');
      return o.clip == null ? l : clip(c, l, maxW, o.clip);
    });
  }

  function clipCols(t, n) { t = t == null ? '' : String(t); if (n <= 0) return ''; return t.length > n ? (n > 3 ? t.slice(0, n - 3) + '...' : t.slice(0, n)) : t; }
  // Word wrap to a column count. first and rest are the prefixes of the first and the next rows; the leading spaces of the text
  // stay on every row. A word longer than a row breaks.
  function wrapCols(text, cols, first, rest) {
    first = first || ''; rest = rest == null ? first : rest;
    var s = String(text == null ? '' : text);
    var lead = (s.match(/^ */) || [''])[0].slice(0, 12);
    var words = s.trim().split(/\s+/), out = [];
    var pre = rest + lead, line = first + lead, empty = true;
    if (pre.length > cols - 4) pre = '';
    if (line.length > cols - 4) line = first.length <= cols - 4 ? first : '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var sep = empty ? '' : ' ';
      if (line.length + sep.length + w.length <= cols) { line += sep + w; empty = false; continue; }
      if (!empty) { out.push(line); line = pre; empty = true; }
      while (line.length + w.length > cols) {
        var room = Math.max(1, cols - line.length);
        out.push(line + w.slice(0, room)); w = w.slice(room); line = pre;
      }
      if (w) { line += w; empty = false; }
    }
    if (!empty || !out.length) out.push(line);
    return out;
  }

  // The estimate. Node has no canvas to measure text, so a plan wraps by a safe estimate of the width of a character: a share of
  // the font size (IBM Plex Sans, checked against the browser's measureText in the screenshots: the average English text is
  // about 0.48 em at 400 and 0.52 at 600). The share is higher than that on purpose, so a line the plan makes fits in the browser
  // and the paint's ellipsis never cuts it. One rule for the plan and for the test.
  function charW(size, wt) { return size * (wt >= 600 ? 0.6 : 0.56); }
  // The size a one-line word takes: s, or smaller so that it fits maxW by the same estimate, with 5 % more room than charW.
  // Never under 14 px.
  function fitSize(str, s, maxW, wt) { var n = String(str).length; return n ? Math.max(14, Math.min(s, Math.floor(maxW / (n * charW(1, wt) * 1.08)))) : s; }
  function wrapEst(str, size, maxW, wt) {
    var cap = Math.max(1, Math.floor(maxW / charW(size, wt))), lines = [], cur = '';
    String(str).split(/\s+/).filter(Boolean).forEach(function (w) {
      while (w.length > cap) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, cap)); w = w.slice(cap); }
      if (!cur) cur = w; else if (cur.length + 1 + w.length <= cap) cur += ' ' + w; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  function wrapEstAll(list, size, maxW, wt) { var out = []; list.forEach(function (t) { out = out.concat(wrapEst(t, size, maxW, wt)); }); return out; }

  function mix(a, b, t) { try { return '#' + new root.THREE.Color(a).lerp(new root.THREE.Color(b), t).getHexString(); } catch (e) { return a; } }
  function rr(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function font(K, px, weight, mono) { var f = (K && K.f) || {}; return (weight || 500) + ' ' + px + 'px ' + (mono ? f.mono || 'monospace' : f.sans || 'sans-serif'); }
  function newTex(w, h) {
    var T = root.THREE, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var tex = new T.CanvasTexture(cv); tex.encoding = T.sRGBEncoding; tex.anisotropy = 4;
    return { canvas: cv, tex: tex };
  }

  root.OfficeScreenKit = { clip: clip, chop: chop, wrap: wrap, wrapCols: wrapCols, clipCols: clipCols, charW: charW, fitSize: fitSize, wrapEst: wrapEst, wrapEstAll: wrapEstAll, mix: mix, rr: rr, font: font, newTex: newTex };
})(typeof window !== 'undefined' ? window : globalThis);
