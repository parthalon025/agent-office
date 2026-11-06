/* Agent Office for Claude Code x0.2: display formats.
   One home for how the page and the server write money, counts and folder paths, so every surface reads the same.
   Plain script, no I/O, no timers. The page loads it as a script (window.OfficeFormat). The server and the tests
   import it for its side effect and read globalThis.OfficeFormat.

     money(n)        -> '$0.00', '<$0.01' (a cost above zero but under one cent), '$0.26'; a dash when n is not a number
     cost(n, unknown) -> money(n), or 'unknown' when an agent reports no cost (session.costUnknown, or the count of such
                        sessions in a room), never '$0.00'. A known part above zero keeps its figure: '$0.26 + unknown'.
     costLabel(n, unknown) -> the same in a line of other facts: money(n), 'cost unknown' or '$0.26 + cost unknown'
     plural(n, one, many?) -> '1 turn', '2 turns' (many defaults to one + 's')
     folderName(p)   -> the last folder of a path
     shortPath(p)    -> the last two folders with a leading cut mark when the path is deeper than a drive and two
                        folders. Show the full path on hover (title).
     maskSecret(text, secret) -> the text with every copy of the secret replaced by SECRET_MASK (a fixed length, so the
                        length of the secret does not show). The secret is text, not a pattern. Used by the Attach
                        sessions dialog to hide the agent token until the user clicks Show.
     redactSecrets(text) -> the text with keys, bearer tokens and token, password or secret values replaced by SECRET_MASK. By
                        pattern, for commands and errors that are kept or exported (history.json, Export). notes.mjs keeps
                        its own list of the key shapes it refuses; test/format.test.mjs holds both to the same samples.
     cleanupNote(result) -> [tone, title, text] for the toast after a floor clean-up ({ deleted, skipped } from the server).
     remoteNote(remote) -> the text of the Remote access part of the Attach sessions dialog ({ state, host, missing, reason } from GET /api/info).
     cleanupEmpty(kept) -> the empty text of the clean-up dialog: the true reason (the user kept every floor, or none was ready).
     tokens(n)       -> '999', '1.2k', '3.4M' (token counts, one form on every surface)
     clock(t, zone?) -> 'HH:MM:SS' local time (zone 'utc' for tests); a dash when t is not a time
     duration(ms)    -> '420 ms', '1.5 s', '2 min 5 s'; a dash when unknown
     timeline(calls, { start, zone }) -> the tool calls as rows, oldest first: { id, time, after, duration, state (done, failed, open), text, err }
     exportText(s, { zone }) / exportFileName(s, zone) -> a session (live or a past record) as Markdown, and its file name (#72)
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
  function cost(n, unknown) {
    if (!unknown) return money(n);
    return typeof n === 'number' && isFinite(n) && n > 0 ? money(n) + ' + unknown' : 'unknown';
  }
  function costLabel(n, unknown) { var c = cost(n, unknown); return unknown ? c.replace(/unknown$/, 'cost unknown') : c; }
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
  /** What the Attach sessions dialog says about remote access (#133): on with the address, a setting that is missing or wrong, or off. */
  function remoteNote(r) {
    if (r && r.state === 'on') return 'Remote access is on. Open the office at https://' + r.host + '. Cloudflare Access signs you in, and the office checks that login on every request.';
    if (r && r.state === 'incomplete') return 'Remote access is off. A setting is not right: ' + (r.reason || 'check the OFFICE_REMOTE settings.') + ' See docs/remote-access.md.';
    return 'Remote access is off. docs/remote-access.md says how to turn it on.';
  }
  /** The empty text of the clean-up dialog. kept = how many floors the user left out with Keep this floor. */
  function cleanupEmpty(kept) {
    if (kept > 0) return (kept === 1 ? 'You kept the floor.' : 'You kept all ' + kept + ' floors.') + ' No floor is deleted.';
    return 'No floor is ready. A floor must be merged, have no changes and no session, and be over an hour old.';
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
  // Key shapes (private key header, sk-, AWS, GitHub), a bearer token, and the value after a token, password, secret or API key
  // flag, header or variable. A command in a session can hold any of them; the record of calls must not keep them.
  var SECRET_SHAPES = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}/g;
  var SECRET_BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi;
  var SECRET_NAMED = /(--(?:token|password|passwd|secret|api-?key)[= ]|\b[\w-]*(?:token|password|passwd|secret|api[_-]?key)\s*[:=]\s*)(["']?)[^\s"']+/gi;
  function redactSecrets(text) {
    return String(text == null ? '' : text).replace(SECRET_SHAPES, SECRET_MASK).replace(SECRET_BEARER, '$1' + SECRET_MASK)
      .replace(SECRET_NAMED, function (m, a, q) { return a + q + SECRET_MASK; });
  }
  // ----- token counts, the call timeline and the export of a session (#72) -----
  function tokens(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)); }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  // Parts of a time in local time, or in UTC when zone is 'utc' (tests).
  function parts(t, zone) {
    var d = new Date(t), u = zone === 'utc';
    return { y: u ? d.getUTCFullYear() : d.getFullYear(), mo: (u ? d.getUTCMonth() : d.getMonth()) + 1, d: u ? d.getUTCDate() : d.getDate(),
      h: u ? d.getUTCHours() : d.getHours(), mi: u ? d.getUTCMinutes() : d.getMinutes(), s: u ? d.getUTCSeconds() : d.getSeconds() };
  }
  function clock(t, zone) { if (typeof t !== 'number' || !isFinite(t) || t <= 0) return '–'; var p = parts(t, zone); return two(p.h) + ':' + two(p.mi) + ':' + two(p.s); }
  function dateTime(t, zone) { var p = parts(t, zone); return p.y + '-' + two(p.mo) + '-' + two(p.d) + ' ' + two(p.h) + ':' + two(p.mi); }
  function duration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '–';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 10000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + ' s';
    var s = Math.round(ms / 1000);
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }
  /** The tool calls of a session as timeline rows, oldest first: { id, time, after, duration, state, text, err }. state: done, failed or open.
      o.start: the session start (after = time since it, '+5 s'); o.zone: 'utc' for tests. */
  function timeline(calls, o) {
    o = o || {};
    return (calls || []).slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); }).map(function (c) {
      var after = o.start && c.t >= o.start ? '+' + duration(c.t - o.start).replace(/^(\d+) ms$/, '0 s') : '';
      return { id: c.id, time: clock(c.t, o.zone), after: after, duration: duration(c.ms), state: c.ok === true ? 'done' : c.ok === false ? 'failed' : 'open',
        text: String(c.name || '') + (c.detail ? ' ' + c.detail : ''), err: c.err || '' };
    });
  }
  function cell(t) { return String(t).replace(/\|/g, '\\|').replace(/\s+/g, ' '); }
  /** A session (live, or a past record) as Markdown: its facts, first instruction, call timeline and replies. s.agent: the agent kind's label. */
  function exportText(s, o) {
    o = o || {};
    var out = ['# ' + (s.name || 'Session'), ''];
    var branch = (s.worktree && s.worktree.branch) || (s.git && s.git.branch) || '';
    [['Agent', s.agent], ['Model', s.model], ['Folder', s.cwd], ['Branch', branch], ['Started', s.startedAt ? dateTime(s.startedAt, o.zone) : ''],
      ['Turns', s.turns != null ? String(s.turns) : ''], ['Tokens', s.usage && s.usage.tokens ? tokens(s.usage.tokens) : ''], ['Cost', cost(s.cost, s.costUnknown)]].forEach(function (kv) {
      if (kv[1]) out.push('- ' + kv[0] + ': ' + kv[1]);
    });
    out.push('');
    if (s.prompt) out.push('## First instruction', '', s.prompt, '');
    out.push('## Timeline', '');
    var calls = (s.calls || []).map(function (c) { return Object.assign({}, c, { detail: redactSecrets(c.detail), err: c.err ? redactSecrets(c.err) : c.err }); });
    var rows = timeline(calls, { start: s.startedAt, zone: o.zone });
    if (!rows.length) out.push('No tool calls were recorded.', '');
    else {
      out.push('| Time | Call | Result | Duration |', '| --- | --- | --- | --- |');
      rows.forEach(function (r) { out.push('| ' + r.time + ' | ' + cell(r.text) + ' | ' + r.state + (r.err ? ': ' + cell(r.err) : '') + ' | ' + r.duration + ' |'); });
      out.push('');
    }
    if ((s.replies || []).length) {
      out.push('## Replies', '');
      s.replies.forEach(function (r) { out.push('### ' + clock(r.t, o.zone), '', String(r.text || ''), ''); });
    }
    return out.join('\n');
  }
  function exportFileName(s, zone) {
    var base = String(s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
    var p = parts(s.startedAt || 0, zone);
    return base + '-' + p.y + '-' + two(p.mo) + '-' + two(p.d) + '-' + two(p.h) + two(p.mi) + '.md';
  }
  root.OfficeFormat = { tokens: tokens, clock: clock, duration: duration, timeline: timeline, exportText: exportText, exportFileName: exportFileName, money: money, cost: cost, costLabel: costLabel, plural: plural, folderName: folderName, shortPath: shortPath, hintPill: hintPill, cleanupNote: cleanupNote, remoteNote: remoteNote, cleanupEmpty: cleanupEmpty, maskSecret: maskSecret, redactSecrets: redactSecrets, SECRET_MASK: SECRET_MASK };
})(typeof globalThis !== 'undefined' ? globalThis : window);
