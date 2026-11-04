/* Agent Office for Claude Code x0.1: display formats.
   One home for how the page and the server write money, counts and folder paths, so every surface reads the same.
   Plain script, no I/O, no timers. The page loads it as a script (window.OfficeFormat). The server and the tests
   import it for its side effect and read globalThis.OfficeFormat.

     money(n)        -> '$0.00', '<$0.01' (a cost above zero but under one cent), '$0.26'; a dash when n is not a number
     plural(n, one, many?) -> '1 turn', '2 turns' (many defaults to one + 's')
     folderName(p)   -> the last folder of a path
     shortPath(p)    -> the last two folders with a leading cut mark when the path is deeper than a drive and two
                        folders. Show the full path on hover (title).
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
  root.OfficeFormat = { money: money, plural: plural, folderName: folderName, shortPath: shortPath };
})(typeof globalThis !== 'undefined' ? globalThis : window);
