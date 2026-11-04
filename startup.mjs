// Windows startup entry: a .cmd file in the user's Startup folder that starts the office at sign-in.
// Why the Startup folder: it needs no admin rights, the user can see and delete the file (Task Manager > Startup apps),
// and removing the entry is deleting one file we own. A Run registry key would need reg.exe and hide the entry.
// The path functions are pure; enable/disable/state take the folder as a parameter so tests never touch the real one.
// The entry never stops a process, by image name or any other way.
import fs from 'node:fs';
import path from 'node:path';

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
export function enable(dir, root, node) {
  if (!dir) throw new Error('This computer has no Startup folder.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(entryPath(dir), entryContent(root, node));
  return state(dir);
}
export function disable(dir) {
  if (dir) fs.rmSync(entryPath(dir), { force: true });
  return state(dir);
}
