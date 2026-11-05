/* Agent Office for Claude Code x0.1: display formats.
   One home for how the page and the server write money, counts and folder paths, so every surface reads the same.
   Plain script, no I/O, no timers. The page loads it as a script (window.OfficeFormat). The server and the tests
   import it for its side effect and read globalThis.OfficeFormat.

     money(n)        -> '$0.00', '<$0.01' (a cost above zero but under one cent), '$0.26'; a dash when n is not a number
     plural(n, one, many?) -> '1 turn', '2 turns' (many defaults to one + 's')
     folderName(p)   -> the last folder of a path
     shortPath(p)    -> the last two folders with a leading cut mark when the path is deeper than a drive and two
                        folders. Show the full path on hover (title).
     maskSecret(text, secret) -> the text with every copy of the secret replaced by SECRET_MASK (a fixed length, so the
                        length of the secret does not show). The secret is text, not a pattern. Used by the Attach
                        sessions dialog to hide the agent token until the user clicks Show.
     cleanupNote(result) -> [tone, title, text] for the toast after a floor clean-up ({ deleted, skipped } from the server).
     hintPill(textW, keyW) -> where the parts of a scene hint pill sit, in pill pixels: { w, textX, keyX, keyW }.
                        The pill grows with its label. keyW 0 gives a label only (keyX is null).
*/
(function (root) {
  'use strict';
  var SEP = /[\\/]/;
  var CUT = '…';
  function money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '–';
    if (n > 0 && n < 0.01) return '<$0.01';
    return '$' + n.toFixed(2);
  }
  /** The toast after a floor clean-up, as [tone, title, text]. The server answers { deleted, skipped }; a skipped floor is a failure the user must see. */
  function cleanupNote(r) {
    var d = (r && r.deleted) || [], k = (r && r.skipped) || [];
    var gone = d.length === 1 ? '1 floor and its rooms are gone.' : d.length + ' floors and their rooms are gone.';
    if (!d.length && !k.length) return ['info', 'Nothing to clean up', 'No floor was deleted.'];
    if (!k.length) return ['info', 'Floors cleaned up', gone];
    var why = (k.length === 1 ? 'It changed' : 'They changed') + ' or a session works there.';
    if (!d.length) return ['error', 'No floor deleted', 'Kept: ' + k.join(', ') + '. ' + why];
    return ['error', 'Some floors stayed', plural(d.length, 'floor') + ' deleted. Kept: ' + k.join(', ') + '. ' + why];
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function trimmed(p) { var s = String(p == null ? '' : p); return s.length > 1 ? s.replace(/[\\/]+$/, '') : s; }
  function folderName(p) { var a = trimmed(p).split(SEP); return a[a.length - 1] || ''; }
  function shortPath(p) {
    var s = trimmed(p);
    if (!s) return '';
    var a = s.split(SEP), sep = s.indexOf('\\') >= 0 ? '\\' : '/';
    if (a.length <= 3) return s;
    return CUT + sep + a.slice(-2).join(sep);
  }
  // Hint pill of the 3D scene (board.js): the rounded box spans x 6 .. w - 6. The label starts after the left pad;
  // the key chip (the Ctrl+K hint) sits at the right end, inside the round end.
  var PILL_EDGE = 6, PILL_PAD = 56, PILL_GAP = 32, PILL_END = 26;
  function hintPill(textW, keyW) {
    var t = Math.max(0, +textW || 0), k = Math.max(0, +keyW || 0), textX = PILL_EDGE + PILL_PAD;
    if (!k) return { w: Math.ceil(textX + t + PILL_PAD + PILL_EDGE), textX: textX, keyX: null, keyW: 0 };
    var keyX = textX + t + PILL_GAP;
    return { w: Math.ceil(keyX + k + PILL_END + PILL_EDGE), textX: textX, keyX: keyX, keyW: k };
  }
  var SECRET_MASK = '••••••••••••';
  function maskSecret(text, secret) {
    var t = String(text == null ? '' : text), k = String(secret == null ? '' : secret);
    return k ? t.split(k).join(SECRET_MASK) : t;
  }
  root.OfficeFormat = { money: money, plural: plural, folderName: folderName, shortPath: shortPath, hintPill: hintPill, cleanupNote: cleanupNote, maskSecret: maskSecret, SECRET_MASK: SECRET_MASK };
})(typeof globalThis !== 'undefined' ? globalThis : window);
