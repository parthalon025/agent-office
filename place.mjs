// Place: where a session or a worktree sits in the office. One home for the rule, computed on the server and
// carried in the snapshot (session.place, worktree.place). The page reads these values and keeps no copy.
//   building  a repository (key: its normalized path), or "Other folders" outside git (key: '')
//   floor     a branch ('No branch' outside git). A worktree the office made for an agent (branch agent/<name>-<id>)
//             sits on the floor of its base branch (baseBranch), not on a floor of its own
//   room      a worktree folder, or the folder itself outside git. An agent worktree shows its branch name
// Pure functions, no I/O, no timers: safe to import in tests.
import { win32 as path } from 'node:path'; // Windows-first: folder keys follow Windows rules on every host (non-Windows launch is not built)
import crypto from 'node:crypto';

export const OTHER_NAME = 'Other folders';
export const OTHER_FLOOR = 'No branch';
// The notes key of a room outside git. It is only a prefix inside noteKey; the building key stays ''.
const OTHER_NOTE_PREFIX = 'other';

/** A path as a key: normalized, no trailing separator, lower case (Windows paths ignore case). */
export function normPath(p) {
  const n = path.normalize(String(p || ''));
  const root = path.parse(n).root; // a root keeps its separator, so normPath(normPath(x)) === normPath(x)
  return (n.length > root.length ? n.replace(/[\\/]+$/, '') : n).toLowerCase();
}
/** A folder as the office stores and shows it: normalized, no trailing separator, the case the user typed. */
function dirForm(p) {
  if (!p || !String(p).trim()) return '';
  const n = path.normalize(String(p));
  const root = path.parse(n).root;
  return n.length > root.length ? n.replace(/[\\/]+$/, '') : n;
}
/** The recent-folders list with dir first. One form per folder, no duplicates in any case or slash style. */
export function addRecent(list, dir, max = 12) {
  const d = dirForm(dir);
  if (!d) return cleanRecent(list, max);
  return [d, ...cleanRecent(list, max + 1).filter((x) => normPath(x) !== normPath(d))].slice(0, max);
}
/** An older list, rewritten in the one form, without duplicates (first one wins) and without empty entries. */
export function cleanRecent(list, max = 12) {
  const seen = new Set(), out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const d = typeof x === 'string' ? dirForm(x) : '';
    if (!d || seen.has(normPath(d))) continue;
    seen.add(normPath(d)); out.push(d);
  }
  return out.slice(0, max);
}
/** The folders offered as one-click choices: first (the shown building), then the recent ones, each folder once. */
export function recentChoices(recent, first, max = 6) {
  return cleanRecent([first, ...(Array.isArray(recent) ? recent : [])], max);
}
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

/** Room id: a readable tail of the folder name plus a hash of the whole normalized path, so two folders whose
 *  names look alike (or differ only in punctuation or in the part that is cut off) are still two rooms. */
export function roomIdOf(rootKey) {
  const hash = crypto.createHash('sha1').update(rootKey).digest('hex').slice(0, 8);
  return 'w-' + slug(rootKey).slice(-32).replace(/^-/, '') + '-' + hash;
}
// The Security room (#70): one per building, on its ground floor, where the user sets the permission rules. It is never a
// worktree: its id starts with 's-' and a worktree's with 'w-', so no folder can ever be taken for it. It has no notes key.
export const SECURITY_ROOM_NAME = 'Security';
/** The Security room id of a building (buildingKey: '' for Other folders). */
export function securityRoomIdOf(buildingKey) { return 's-' + roomIdOf(String(buildingKey || '')).slice(2); }
/** True for a Security room id. */
export function isSecurityRoom(roomId) { return /^s-/.test(String(roomId || '')); }

/** The room id before the hash was added (it is lossy). Used only to carry old notes over. */
export function legacyRoomId(rootKey) { return 'w-' + slug(rootKey).slice(-48); }

/** branch: what the folder has checked out. base: the branch an agent worktree was made from ('' or undefined: none). */
function make(buildingKey, building, repoPath, branch, root, base) {
  const rootKey = normPath(root);
  const roomId = roomIdOf(rootKey);
  const baseBranch = base && base !== branch ? String(base) : '';
  return {
    buildingKey, building, repoPath, floor: baseBranch || branch, branch, baseBranch,
    room: (baseBranch && branch) || baseName(root) || 'Folder', root: String(root || ''), rootKey, roomId,
    noteKey: (buildingKey || OTHER_NOTE_PREFIX) + '|' + roomId,
    securityRoomId: securityRoomIdOf(buildingKey),
  };
}

/** Where a session sits. g is git.locate()'s result ({ repo, root, branch, base? }) or null outside git. */
export function placeOfSession(g, cwd) {
  if (!g) return make('', OTHER_NAME, '', OTHER_FLOOR, cwd, '');
  return make(normPath(g.repo), baseName(g.repo), g.repo, g.branch, g.root, g.base);
}

/** Where a worktree of a repository sits (a room that may have no session in it). wt is a git.layout() entry. */
export function placeOfWorktree(repoPath, wt) {
  return make(normPath(repoPath), baseName(repoPath), repoPath, wt.branch, wt.root, wt.base);
}

/** Moves a note or pin from the legacy key to the current key. Never overwrites a current entry. Returns true if anything moved. */
export function adoptLegacy(maps, place) {
  const old = legacyNoteKey(place);
  if (old === place.noteKey) return false;
  let moved = false;
  for (const m of maps) if (m[old] && !m[place.noteKey]) { m[place.noteKey] = m[old]; delete m[old]; moved = true; }
  return moved;
}

/** The notes key a room had before room ids carried a hash. */
export function legacyNoteKey(place) {
  return (place.buildingKey || OTHER_NOTE_PREFIX) + '|' + legacyRoomId(place.rootKey);
}
