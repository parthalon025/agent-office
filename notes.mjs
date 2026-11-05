// Notes board: the one owner of a room's notes and its blackboard pin.
// Owns: read, the user's save with a base version, the agent's append and replace, and the pin.
// The version is a counter that only goes up. A cleared board keeps its counter (text ''), so a
// version never comes back with other text. A save with an old base is merged three ways against the
// text the user started from, so the user's deletions and changes stay and an agent's new lines stay.
// Each version also keeps `sent`, the text the user sent from it. It is the merge base for the next save of
// an editor that typed on while a merged answer came back.
//
// Pure: the two maps it changes (notes, pins) and the clock are injected. No timers, no I/O. The
// server saves the maps after a change (state.json). Importing this module starts nothing.

export const NOTES_MAX = 4000;
export const PIN_MAX = 140;
// What an agent writes to the board is capped lower than the board (small capped memory, #72): the next agent reads the board, so it
// holds short facts, not a dump. The user's own save keeps the board cap.
export const AGENT_WRITE_MAX = 1500;
const KEEP_VERSIONS = 12; // old texts kept in memory per board, as merge bases

export class NotesError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Prompt-injection scan of what an agent writes to the board (#72). The next agent reads the board as context, so a line there can act
// as an instruction. [pattern, why]. A match refuses the write (422): the agent rewrites it as a plain fact. The user is not scanned.
// Zero-width, direction-control and byte-order characters (U+200B, U+200E-200F, 202A-202E, 2060-2064, 2066-2069, FEFF): text a reader
// cannot see. U+200C and U+200D are not on the list: an emoji sequence (a family, a flag with a modifier) needs the joiner. They are
// removed from the copy that is scanned for phrases, so a joiner inside a word does not hide it.
const HIDDEN = new RegExp('[' + [[0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']');
const IGNORE = 'it tells the reader to ignore its instructions';
const SCAN = [
  [/\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^\n]{0,30}\b(instructions?|prompts?|rules|guidelines|context|everything)\b/i, IGNORE],
  [/\bforget (everything|all)\b/i, IGNORE],
  [/\b(new|updated|real) (system )?(instructions?|rules)\s*:/i, 'it gives new instructions'],
  [/<\|[a-z_]+\|>|\[\/?INST\]|<<\/?SYS>>/i, 'it holds a chat control token'],
  [/(^|\n)\s*(system|assistant|developer)\s*:/i, 'it speaks as the system'],
  [/\byou are now\b/i, 'it tells the reader who it is now'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sh|bash|zsh|iex|powershell|pwsh)\b/i, 'it pipes a download into a shell'],
  [/\b(do not|don't|never) (tell|show|inform|mention)\b[^\n]{0,20}\b(user|human|owner)\b/i, 'it asks the reader to hide something from the user'],
  [HIDDEN, 'it holds hidden characters'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}/, 'it holds a secret'],
];
/** Why an agent's note text is refused, or null when it is a plain note. */
export function scanNote(text) {
  const t = String(text ?? '');
  // The text as written, and a copy with joiners gone and every whitespace run as one space: a line break must not split a phrase.
  const flat = t.replace(/[\u200c\u200d]/g, '').replace(/\s+/g, ' ');
  for (const [re, why] of SCAN) if (re.test(t) || re.test(flat)) return why;
  return null;
}
// What an agent wants to write: the cap (an append only; a rewrite is held by the board cap), then the scan. Throws a NotesError.
function checkAgentWrite(text, capped = true) {
  if (capped && text.length > AGENT_WRITE_MAX) throw new NotesError(413, `An agent can write ${AGENT_WRITE_MAX} characters at a time to the notes board. This text has ${text.length}. Write the short facts only.`);
  const why = scanNote(text);
  if (why) throw new NotesError(422, `The notes board refused this text: ${why}. The next agent reads the board as context. Write a plain fact instead.`);
}

const lines = (t) => (t === '' ? [] : String(t).split('\n'));
const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');

// Longest common subsequence of two line lists: for each index of a, the matching index in b or -1.
function match(a, b) {
  const n = a.length, m = b.length;
  const out = new Array(n).fill(-1);
  // The common start and end need no table, so an append or one changed line builds an almost empty one.
  let p = 0, s = 0;
  while (p < n && p < m && a[p] === b[p]) { out[p] = p; p++; }
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) { out[n - 1 - s] = m - 1 - s; s++; }
  const x = a.slice(p, n - s), y = b.slice(p, m - s), xn = x.length, ym = y.length;
  const L = Array.from({ length: xn + 1 }, () => new Int32Array(ym + 1));
  for (let i = xn - 1; i >= 0; i--) for (let j = ym - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0;
  while (i < xn && j < ym) {
    if (x[i] === y[j]) { out[p + i] = p + j; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Three-way merge by lines. base: the text the user started from. mine: the user's text.
 * theirs: the text on the server now. Where only one side changed, that side wins. Where both
 * changed the same lines, the user's lines win and the other side's new lines follow them. A base
 * line that the other side removed stays removed. So when an agent rewrites the board (notes_replace)
 * while the user edits, the agent's removal of lines the user did not touch holds.
 */
export function merge3(base, mine, theirs) {
  const B = lines(base), M = lines(mine), T = lines(theirs);
  const mm = match(B, M), tm = match(B, T);
  const out = [];
  let bi = 0, mi = 0, ti = 0;
  const chunk = (bEnd, mEnd, tEnd) => {
    const b = B.slice(bi, bEnd), m = M.slice(mi, mEnd), t = T.slice(ti, tEnd);
    if (same(m, b)) out.push(...t);
    else if (same(t, b) || same(t, m)) out.push(...m);
    else {
      // Both sides changed these lines. Base lines the other side removed stay removed; the user's lines win.
      const bs = new Set(b), ms = new Set(m), ts = new Set(t);
      out.push(...m.filter((l) => !(bs.has(l) && !ts.has(l))));
      out.push(...t.filter((l) => !bs.has(l) && !ms.has(l)));
    }
    bi = bEnd; mi = mEnd; ti = tEnd;
  };
  for (let i = 0; i < B.length; i++) {
    if (mm[i] < 0 || tm[i] < 0) continue;      // a base line that one side changed or removed
    chunk(i, mm[i], tm[i]);
    out.push(B[i]); bi = i + 1; mi = mm[i] + 1; ti = tm[i] + 1;
  }
  chunk(B.length, M.length, T.length);
  return out.join('\n');
}

/** Used when the base text is gone: the server text plus the user's lines it does not have. */
function union(server, mine) {
  const have = new Set(lines(server));
  const extra = lines(mine).filter((l) => l.trim() && !have.has(l));
  if (!extra.length) return server;
  return server + (server && !server.endsWith('\n') ? '\n' : '') + extra.join('\n');
}

/** The pin text as one line. Throws when it is too long (check before a change, so nothing changes half way). */
export function cleanPin(text) {
  const t = String(text).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (t.length > PIN_MAX) throw new NotesError(413, `A pin can have ${PIN_MAX} characters. This one has ${t.length}.`);
  // Every other agent in the room reads the pin (office_room), so it gets the same scan as a note. It sees the text as given, so a
  // line break in the middle of a phrase is caught by the scan's flat pass.
  const why = scanNote(String(text));
  if (why) throw new NotesError(422, `The blackboard refused this pin: ${why}. Every agent in the room reads it as context. Write a plain fact instead.`);
  return t;
}

export function createNotes({ notes, pins, now = Date.now }) {
  const past = new Map(); // key -> [{ v, text }] newest last; memory only

  const entry = (key) => notes[key] || null;
  const versionOf = (key) => { const e = entry(key); return e ? (Number.isInteger(e.v) ? e.v : 1) : 0; };
  const textOf = (key) => entry(key)?.text || '';

  function remember(key) {
    const list = past.get(key) || [];
    const v = versionOf(key);
    if (!list.some((x) => x.v === v)) list.push({ v, text: textOf(key) });
    past.set(key, list.slice(-KEEP_VERSIONS));
  }
  // Writes the next text as the next version. A board with no text keeps its counter and no `at`.
  function write(key, text, by) {
    remember(key);
    const v = versionOf(key) + 1;
    const blank = !text.trim();
    const e = { text: blank ? '' : text, at: blank ? 0 : now(), v };
    if (by && !blank) e.by = by;
    notes[key] = e;
    remember(key);
    return v;
  }
  function checkCap(text, what) {
    if (text.length > NOTES_MAX) throw new NotesError(413, `${what} can have ${NOTES_MAX} characters. With this change it would have ${text.length}.`);
  }

  return {
    /** The board of a room: { text, version, at, by? }. Version 0 and text '' when it never had notes. */
    read(key) {
      const e = entry(key);
      if (!e || !e.text?.trim()) return { text: '', version: versionOf(key), at: 0 };
      return { text: e.text, version: versionOf(key), at: e.at || 0, ...(e.by ? { by: e.by } : {}) };
    },

    /**
     * The user's save. base: the version the editor started from (omit it to overwrite).
     * When the board moved on, the text is merged three ways. Returns { version, text, merged }.
     * The editor shows `text` when `merged` is true. sent: the editor started from the text it sent
     * with this version (it typed on while a merged answer came back), so merge against that text.
     */
    save(key, text, base, sent = false) {
      text = norm(text);
      checkCap(text, 'A note');
      const cur = versionOf(key);
      const hasBase = base !== undefined && base !== null;
      if (!hasBase || (Number(base) === cur && !sent)) {
        if (text === textOf(key) || (!text.trim() && !textOf(key).trim())) return { version: cur, text: textOf(key), merged: false };
        return { version: write(key, text), text, merged: false };
      }
      const old = (past.get(key) || []).find((x) => x.v === Number(base));
      const baseText = old ? (sent ? (old.sent ?? old.text) : old.text) : undefined;
      const merged = baseText !== undefined ? merge3(baseText, text, textOf(key)) : union(textOf(key), text);
      checkCap(merged, 'The notes board');
      const v = merged === textOf(key) ? cur : write(key, merged);
      remember(key);
      past.get(key).find((x) => x.v === v).sent = text;
      return { version: v, text: merged, merged: true };
    },

    /** An agent adds lines at the end. Each line starts with the session name. Returns the added text. */
    append(key, name, text) {
      const add = norm(text).split('\n').map((l) => l.trim()).filter(Boolean);
      if (!add.length) throw new NotesError(400, 'notes_append is empty. Give the text to add.');
      checkAgentWrite(add.join('\n'));
      const line = add.map((l) => `${name}: ${l}`).join('\n');
      const cur = textOf(key);
      const next = cur ? cur + (cur.endsWith('\n') ? '' : '\n') + line : line;
      checkCap(next, 'The notes board');
      write(key, next, name);
      return { line, text: next };
    },

    /** An agent replaces all notes. An empty text clears the board. Returns the old text. */
    replace(key, name, text) {
      const next = norm(text);
      checkAgentWrite(next, false); // a rewrite may fill the board; the board cap below is its limit
      checkCap(next, 'The notes board');
      const old = textOf(key);
      write(key, next, name);
      return { old, cleared: !next.trim(), text: next };
    },

    /** The blackboard pin: { text, by, at } or null. */
    pinOf(key) { return pins[key] || null; },

    /** Sets or clears the pin. One line: whitespace runs become one space, control characters go. Returns 'set', 'cleared' or 'none'. */
    pin(key, name, text) {
      const t = cleanPin(text); // the length check and the scan: a refused pin changes nothing
      if (t) { pins[key] = { text: t, by: name, at: now() }; return 'set'; }
      if (pins[key]) { delete pins[key]; return 'cleared'; }
      return 'none';
    },
  };
}
