// Room records (#92): the names and floors of the rooms of git workspaces, kept in state.json (persisted.rooms). One job:
// the rules that name a room from its task and settle its floors from the agents in it. Place rules (which room a folder is)
// stay in place.mjs. Pure functions, no I/O, no timers: safe to import in tests.
import { functionOf } from './archetypes.mjs';

// A room's name comes from its task (#88): the Manager goal, the linked issue, the first prompt, then the branch (or the
// folder outside git). The branch stays small print on the room and the desk. Returns { name, by }.
// The number starts the last part of the branch ("feat/92-function-floors", "57-fix", "issue-12"), so an agent branch
// such as "agent/a-1" links no issue.
const ISSUE_IN_BRANCH = /(?:^|\/)(?:issue[-_]|gh[-_]|#)?(\d{1,6})(?:[-_](.+))?$/i;
const ISSUE_IN_TEXT = /(?:^|[\s(])(?:#|issue\s+#?)(\d{1,6})\b/i;
const firstLine = (t) => String(t || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
const cut = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
const words = (t) => { const s = String(t || '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
/** The issue a branch or a prompt links to: { n, words } or null. */
export function linkedIssue(branch, prompt) {
  const b = ISSUE_IN_BRANCH.exec(String(branch || ''));
  if (b) return { n: Number(b[1]), words: words(b[2]) };
  const p = ISSUE_IN_TEXT.exec(String(prompt || ''));
  return p ? { n: Number(p[1]), words: '' } : null;
}
export function roomTitle(task) {
  const t = task || {};
  const goal = firstLine(t.goal);
  if (goal) return { name: cut(goal, 40), by: 'goal' };
  const issue = linkedIssue(t.branch, t.prompt);
  if (issue) return { name: cut('#' + issue.n + (issue.words ? ' ' + issue.words : ''), 40), by: 'issue' };
  const p = firstLine(t.prompt);
  if (p) return { name: cut(p, 40), by: 'prompt' };
  if (t.branch) return { name: cut(String(t.branch), 40), by: 'branch' };
  return { name: cut(String(t.folder || 'Folder'), 40), by: 'folder' };
}
const TITLE_RANK = { folder: 0, branch: 1, prompt: 2, issue: 3, goal: 4 };
/** The better of two room titles: a title from a source higher in the chain wins; a tie keeps the old one, so a room
 *  is not renamed by every new prompt. */
export function betterTitle(old, next) {
  if (!old) return next;
  if (!next) return old;
  return (TITLE_RANK[next.by] || 0) > (TITLE_RANK[old.by] || 0) ? next : old;
}

// ---------- room records (#92) ----------
// persisted.rooms in state.json: notes key -> { building, root, floors, title }, one record per git workspace that had an agent.
//   floors  the function floors where an agent of the room sits now, the oldest first (owner rule, #92 review: a floor no agent
//           of the room sits on is dropped, so a room never collects floors; a room with no agent left has none)
//   title   its name from the task (roomTitle), kept for the next agent until a better source comes. The main checkout is shared
//           by ad-hoc sessions, so only its branch names it, never a prompt, a goal or an issue in a prompt.
// The server drops a record when its worktree goes (server.mjs dropGoneRooms).
const TITLE_BY = new Set(Object.keys(TITLE_RANK));
const SHARED_BY = new Set(['branch', 'folder']);   // the sources that may name the main checkout
const cleanTitle = (t) => {
  if (!t || typeof t !== 'object' || !TITLE_BY.has(t.by)) return null;
  const name = cut(String(t.name == null ? '' : t.name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim(), 40);
  return name ? { name, by: t.by } : null;
};
/** True for the place or record of a repository's main folder (its own checkout, not a linked worktree). */
export function isMainCheckout(x) { return !!x && !!(x.buildingKey ?? x.building) && (x.rootKey ?? x.root) === (x.buildingKey ?? x.building); }
/** The room records of state.json in the one form, like archetypes.mjs cleanRecord for a building. A record that is not an
 *  object, has no building or root, or sits under a key that is not a notes key of its building is dropped; floors keeps known
 *  function ids once each; a title in another shape is none; the main checkout keeps no title from a prompt, a goal or an
 *  issue (an older state.json may have one). Anything that is not an object gives {}. */
export function cleanRooms(rooms) {
  const out = {};
  if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) return out;
  for (const [key, rec] of Object.entries(rooms)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const building = typeof rec.building === 'string' ? rec.building : '', root = typeof rec.root === 'string' ? rec.root : '';
    if (!building || !root || !key.startsWith(building + '|') || !/^w-[a-z0-9-]+$/.test(key.slice(building.length + 1))) continue;
    const floors = [];
    for (const f of Array.isArray(rec.floors) ? rec.floors : []) if (typeof f === 'string' && functionOf(f) && !floors.includes(f)) floors.push(f);
    let title = cleanTitle(rec.title);
    if (title && root === building && !SHARED_BY.has(title.by)) title = null;
    out[key] = { building, root, floors, title };
  }
  return out;
}
const sameRec = (a, b) => !!a && !!b && a.building === b.building && a.root === b.root && a.floors.length === b.floors.length
  && a.floors.every((f, i) => f === b.floors[i]) && (a.title ? !!b.title && a.title.name === b.title.name && a.title.by === b.title.by : !b.title);
/** The room records after one look at the live sessions (the server runs it on every broadcast). rooms: cleanRooms records.
 *  live: [{ pl: the session's place, seat: seatOf, goal, firstPrompt }], oldest first. A room's floors are the seats of its
 *  agents now: the floors it had keep their order, a new one comes last, and one no agent of it sits on goes. A room with no
 *  live agent keeps its record and its name with no floors. Only rooms in git keep a record. Returns { rooms, moved }: the
 *  same rooms object when nothing changed. */
export function settleRooms(rooms, live) {
  const old = rooms || {}, now = new Map();
  for (const x of Array.isArray(live) ? live : []) {
    const pl = x && x.pl;
    if (!pl || !pl.buildingKey || !x.seat || !x.seat.floor) continue;
    const e = now.get(pl.noteKey) || { pl, floors: [], sessions: [] };
    if (!e.floors.includes(x.seat.floor)) e.floors.push(x.seat.floor);
    e.sessions.push(x);
    now.set(pl.noteKey, e);
  }
  let next = null;
  for (const key of new Set([...Object.keys(old), ...now.keys()])) {
    const was = old[key] || null, e = now.get(key);
    if (!e && (!was || !was.floors.length)) continue;
    const rec = was ? { ...was, floors: was.floors.slice() } : { building: e.pl.buildingKey, root: e.pl.rootKey, floors: [], title: null };
    rec.floors = e ? rec.floors.filter((f) => e.floors.includes(f)).concat(e.floors.filter((f) => !rec.floors.includes(f))) : [];
    if (e && isMainCheckout(e.pl)) rec.title = roomTitle({ branch: e.pl.branch, folder: e.pl.room });
    else if (e) for (const s of e.sessions) rec.title = betterTitle(rec.title, roomTitle({ goal: s.goal, branch: e.pl.branch, prompt: s.firstPrompt, folder: e.pl.room }));
    if (sameRec(was, rec)) continue;
    (next ||= { ...old })[key] = rec;
  }
  return next ? { rooms: next, moved: true } : { rooms: old, moved: false };
}
/** What the snapshot carries as `rooms` (building.js reads it): each record's floors and name (a copy), and each live room
 *  outside git, named from its oldest session (such a room keeps no record). live: as settleRooms, oldest first. */
export function viewRooms(rooms, live) {
  const out = {};
  for (const [k, r] of Object.entries(rooms || {})) out[k] = { floors: r.floors.slice(), title: r.title ? { ...r.title } : null };
  for (const x of Array.isArray(live) ? live : []) {
    const pl = x && x.pl;
    if (!pl || pl.buildingKey || out[pl.noteKey]) continue;
    out[pl.noteKey] = { floors: [], title: roomTitle({ goal: x.goal, prompt: x.firstPrompt, folder: pl.room }) };
  }
  return out;
}
