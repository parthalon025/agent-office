// Notes board: the one owner of a room's notes and its blackboard pin.
// Owns: read, the user's save with a base version, the agent's append and replace, and the pin.
// The version is a counter that only goes up. A cleared board keeps its counter (text ''), so a
// version never comes back with other text. A save with an old base is merged three ways against the
// text the user started from, so the user's deletions and changes stay and an agent's new lines stay.
//
// Pure: the two maps it changes (notes, pins) and the clock are injected. No timers, no I/O. The
// server saves the maps after a change (state.json). Importing this module starts nothing.

export const NOTES_MAX = 4000;
export const PIN_MAX = 140;
const KEEP_VERSIONS = 12; // old texts kept in memory per board, as merge bases

export class NotesError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const lines = (t) => (t === '' ? [] : String(t).split('\n'));
const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');

// Longest common subsequence of two line lists: for each index of a, the matching index in b or -1.
function match(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = new Array(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out[i] = j; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Three-way merge by lines. base: the text the user started from. mine: the user's text.
 * theirs: the text on the server now. Where only one side changed, that side wins. Where both
 * changed the same lines, the user's lines win and the other side's new lines follow them.
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
    else { out.push(...m); const seen = new Set([...b, ...m]); out.push(...t.filter((l) => !seen.has(l))); }
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
     * The editor shows `text` when `merged` is true.
     */
    save(key, text, base) {
      text = norm(text);
      checkCap(text, 'A note');
      const cur = versionOf(key);
      const hasBase = base !== undefined && base !== null;
      if (!hasBase || Number(base) === cur) {
        if (text === textOf(key) || (!text.trim() && !textOf(key).trim())) return { version: cur, text: textOf(key), merged: false };
        return { version: write(key, text), text, merged: false };
      }
      const old = (past.get(key) || []).find((x) => x.v === Number(base));
      const merged = old ? merge3(old.text, text, textOf(key)) : union(textOf(key), text);
      checkCap(merged, 'The notes board');
      if (merged === textOf(key)) return { version: cur, text: merged, merged: true };
      return { version: write(key, merged), text: merged, merged: true };
    },

    /** An agent adds lines at the end. Each line starts with the session name. Returns the added text. */
    append(key, name, text) {
      const add = norm(text).split('\n').map((l) => l.trim()).filter(Boolean);
      if (!add.length) throw new NotesError(400, 'notes_append is empty. Give the text to add.');
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
      checkCap(next, 'The notes board');
      const old = textOf(key);
      write(key, next, name);
      return { old, cleared: !next.trim(), text: next };
    },

    /** The blackboard pin: { text, by, at } or null. */
    pinOf(key) { return pins[key] || null; },

    /** Sets or clears the pin. One line: whitespace runs become one space, control characters go. Returns 'set', 'cleared' or 'none'. */
    pin(key, name, text) {
      const t = cleanPin(text);
      if (t) { pins[key] = { text: t, by: name, at: now() }; return 'set'; }
      if (pins[key]) { delete pins[key]; return 'cleared'; }
      return 'none';
    },
  };
}
