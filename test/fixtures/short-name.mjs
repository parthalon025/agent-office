// The 8.3 short spelling of a folder, for the tests that check that one folder in two spellings is one place (risk.mjs
// realInside). GitHub's Windows runner has TEMP in C:\Users\RUNNER~1\AppData\Local\Temp, and git gives the long path, so
// the office sees both spellings there. A volume can have 8.3 names off (fsutil 8dot3name), and then a folder has none.
import { execFileSync } from 'node:child_process';
import { resolveExe, helperCwd } from '../../src/launch.mjs';

/**
 * The 8.3 short spelling of an existing folder (cmd's %~s), or null: not Windows, the volume keeps no short name for it,
 * or the folder has a character cmd would read as more than text (the folder is part of the cmd line).
 */
export function shortOf(dir) {
  const d = String(dir ?? '');
  if (process.platform !== 'win32' || !d || /["%&|<>^!\r\n]/.test(d)) return null;
  try {
    const out = execFileSync(resolveExe('cmd'), ['/d', '/s', '/c', `"for %I in ("${d}") do @echo %~sI"`], { cwd: helperCwd(), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
    return out.includes('~') && out.toLowerCase() !== d.toLowerCase() ? out : null;
  } catch { return null; }
}
