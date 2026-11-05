// Windows startup entry: a .cmd file in the user's Startup folder that starts the office at sign-in.
// Why the Startup folder: it needs no admin rights, the user can see and delete the file (Task Manager > Startup apps),
// and removing the entry is deleting one file we own. A Run registry key would need reg.exe and hide the entry.
// The path functions are pure; enable/disable/state take the folder as a parameter so tests never touch the real one.
// The entry never stops a process, by image name or any other way.
// The entry is one file for the whole user, so one office owns it (#108): the one on the default port, in the main
// folder. An office on another port, or in a git worktree, shows the entry read-only with a reason, and enable and
// disable refuse (status 403). Otherwise a second office could turn the owner's entry off, or point sign-in at a worktree.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT } from './files.mjs';

export const ENTRY_NAME = 'Agent Office.cmd';

/** The per-user Startup folder, from the APPDATA value. '' when it is not known. */
export function startupDir(appData) {
  return appData ? path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : '';
}
// The file goes in a real folder on this machine, so it is joined with this platform's rules (CI runs the tests on Linux).
export function entryPath(dir) { return path.join(dir, ENTRY_NAME); }

/** The .cmd text. root = the office folder, node = the node.exe path. CRLF lines. % is doubled so cmd keeps it. */
export function entryContent(root, node) {
  const q = (p) => '"' + String(p).replace(/%/g, '%%').replace(/"/g, '') + '"';
  return [
    '@echo off',
    'rem Starts Agent Office when you sign in. Delete this file, or use the office settings, to stop that.',
    'cd /d ' + q(root),
    'start "Office" /min ' + q(node) + ' server.mjs',
    '',
  ].join('\r\n');
}

/** { available, enabled, path }. available is false when there is no Startup folder (not Windows, no APPDATA). */
export function state(dir) {
  if (!dir) return { available: false, enabled: false, path: '' };
  const p = entryPath(dir);
  return { available: true, enabled: fs.existsSync(p), path: p };
}

// A linked git worktree has a .git file that points to <repo>/.git/worktrees/<name>, and that folder holds a commondir file.
// A main checkout has a .git folder. A download has no .git. A .git file is not enough: a clone made with
// --separate-git-dir and a submodule also have one, and each is a main folder. A relative gitdir (newer git) is read
// against the folder.
function inWorktree(root) {
  if (!root) return false;
  try {
    const dot = path.join(root, '.git');
    if (!fs.statSync(dot).isFile()) return false;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dot, 'utf8'));
    if (!m) return false;
    const gitdir = path.resolve(root, m[1]);
    return fs.existsSync(path.join(gitdir, 'commondir')) || path.basename(path.dirname(gitdir)) === 'worktrees';
  } catch { return false; }
}

/**
 * { canChange, reason }: whether the office in folder root on port may add or remove the entry. reason says why not,
 * and is '' when it may. No port means the default port.
 */
export function access(root, port = DEFAULT_PORT) {
  if (Number(port) !== DEFAULT_PORT) return { canChange: false, reason: `Only the office on port ${DEFAULT_PORT} can change this. This office runs on port ${Number(port)}.` };
  if (inWorktree(root)) return { canChange: false, reason: 'Only the office in the main folder can change this. This office runs in a worktree.' };
  return { canChange: true, reason: '' };
}
function guard(root, port) {
  const a = access(root, port);
  if (!a.canChange) throw Object.assign(new Error(a.reason), { status: 403 });
}

/** state(dir) with access(root, port): what the Attach dialog shows. */
export function status(dir, root, port = DEFAULT_PORT) { return { ...state(dir), ...access(root, port) }; }

/** Adds the entry. Throws (status 403) when the office in folder root on port does not own it. */
export function enable(dir, root, node, port = DEFAULT_PORT) {
  guard(root, port);
  if (!dir) throw new Error('This computer has no Startup folder.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(entryPath(dir), entryContent(root, node));
  return state(dir);
}
/** Removes the entry. Throws (status 403) when the office in folder root on port does not own it. */
export function disable(dir, root = '', port = DEFAULT_PORT) {
  guard(root, port);
  if (dir) fs.rmSync(entryPath(dir), { force: true });
  return state(dir);
}

/**
 * One turn-on or turn-off from the page: enable (enabled === true) or disable, then the reply the page shows:
 * the entry state with access. Throws (status 403) when this office does not own the entry.
 */
export function change(dir, root, node, port, enabled) {
  const r = enabled === true ? enable(dir, root, node, port) : disable(dir, root, port);
  return { ...r, ...access(root, port) };
}
