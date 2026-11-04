// Place: where a session or a worktree sits in the office. One home for the rule, computed on the server and
// carried in the snapshot (session.place, worktree.place). The page reads these values and keeps no copy.
//   building  a repository (key: its normalized path), or "Other folders" outside git (key: '')
//   floor     a branch ('No branch' outside git)
//   room      a worktree folder, or the folder itself outside git
// Pure functions, no I/O, no timers: safe to import in tests.
import path from 'node:path';
import crypto from 'node:crypto';

export const OTHER_NAME = 'Other folders';
export const OTHER_FLOOR = 'No branch';
// The notes key of a room outside git. It is only a prefix inside noteKey; the building key stays ''.
const OTHER_NOTE_PREFIX = 'other';

/** A path as a key: normalized, no trailing separator, lower case (Windows paths ignore case). */
export function normPath(p) {
  const n = path.normalize(String(p || '')).replace(/[\\/]+$/, '');
  return n.toLowerCase();
}
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

/** Room id: a readable tail of the folder name plus a hash of the whole normalized path, so two folders whose
 *  names look alike (or differ only in punctuation or in the part that is cut off) are still two rooms. */
export function roomIdOf(rootKey) {
  const hash = crypto.createHash('sha1').update(rootKey).digest('hex').slice(0, 8);
  return 'w-' + slug(rootKey).slice(-32).replace(/^-/, '') + '-' + hash;
}
/** The room id before the hash was added (it is lossy). Used only to carry old notes over. */
export function legacyRoomId(rootKey) { return 'w-' + slug(rootKey).slice(-48); }

function make(buildingKey, building, repoPath, floor, root) {
  const rootKey = normPath(root);
  const roomId = roomIdOf(rootKey);
  return {
    buildingKey, building, repoPath, floor,
    room: baseName(root) || 'Folder', root: String(root || ''), rootKey, roomId,
    noteKey: (buildingKey || OTHER_NOTE_PREFIX) + '|' + roomId,
  };
}

/** Where a session sits. g is git.locate()'s result ({ repo, root, branch }) or null outside git. */
export function placeOfSession(g, cwd) {
  if (!g) return make('', OTHER_NAME, '', OTHER_FLOOR, cwd);
  return make(normPath(g.repo), baseName(g.repo), g.repo, g.branch, g.root);
}

/** Where a worktree of a repository sits (a room that may have no session in it). */
export function placeOfWorktree(repoPath, wt) {
  return make(normPath(repoPath), baseName(repoPath), repoPath, wt.branch, wt.root);
}

/** The notes key a room had before room ids carried a hash. */
export function legacyNoteKey(place) {
  return (place.buildingKey || OTHER_NOTE_PREFIX) + '|' + legacyRoomId(place.rootKey);
}
