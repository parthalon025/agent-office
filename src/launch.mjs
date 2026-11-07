// Program launch: the one place that decides how the office starts a program safely.
// Four rules live here: the absolute program path (resolveExe), the helper folder (helperCwd), the process start time
// (processStart) and the process-tree kill (killTree). Providers and the server import this module to start a program,
// never git.mjs. test/spawn-safety.test.mjs scans every source for a start that does not go through resolveExe.
// (#169) Start every program with resolveExe(name) from this module, never a bare name. On Windows a bare name is looked up in the
// child's folder first, so a planted git.exe in a repo would run. The entry points also set NoDefaultCurrentDirectoryInExePath.
// resolveExe throws for a .cmd, .bat or .ps1 install with code 'SCRIPT_INSTALL' and the file; callers read those, not the message.
// killTree(pid, run) is taskkill /T by absolute path, else the process group, and never rejects; killTreeSync(pid, run) is the
// same, waiting, for an exit handler. processStart(pid) gives a pid's start time, so a reused pid is not mistaken for the old
// process. Only node: built-ins.
// Every program the office starts names its cwd: the session folder for work in it, helperCwd() (%SystemRoot%) for a helper. On
// Windows a process keeps its current folder busy, so a helper that inherited the office folder (the walker, icacls, the ACL
// reader) made rmSync of a test's temp office fail with EBUSY after the server was killed (#78). test/spawn-safety.test.mjs
// checks the sources, bare names and cwd included.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- programs ----------
// On Windows a bare program name ('git') is looked up in the child's folder before PATH, unless the
// office's own environment has NoDefaultCurrentDirectoryInExePath. A git.exe planted in a session folder
// would then run as the user with no click. So every program the office starts (git, gh, claude, cmd.exe,
// powershell.exe, taskkill, icacls) starts from the absolute path that resolveExe gives, never from a bare name.
const SYSTEM32 = { cmd: 'cmd.exe', powershell: 'WindowsPowerShell\\v1.0\\powershell.exe', taskkill: 'taskkill.exe', icacls: 'icacls.exe' };
const exeCache = new Map();
// Environment names are not case-sensitive on Windows; a plain object (a test's env) is.
const envGet = (env, key) => env[key] ?? env[Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase())];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function isRunnable(p, win) {
  if (!isFile(p)) return false;
  if (win) return true; // Windows has no execute bit; the extension decides (.com or .exe only)
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * The absolute path of a program. Windows tools (cmd, powershell, taskkill, icacls) come from %SystemRoot%\System32.
 * Other names come from the absolute folders of PATH, in order; relative entries ('.', '') and the current
 * folder are never searched. On Windows only .com and .exe count: a .cmd, .bat or .ps1 shim cannot start
 * without a shell, and the office never starts programs through a shell. An absolute path is checked and
 * returned as is. Throws when nothing is found, or for a relative path. Cached per name for process.env.
 */
export function resolveExe(name, env = process.env) {
  const own = env === process.env;
  const hit = own ? exeCache.get(name) : null;
  if (hit && isFile(hit)) return hit;
  const exe = findExe(String(name ?? ''), env, process.platform === 'win32');
  if (own) exeCache.set(name, exe);
  return exe;
}

/**
 * The start time of a process, as text, or null when no such process runs (#27 L11). A pid alone can name another process
 * after the first one ended; a pid with its start time cannot. Never by image name. deps.execFile is injectable.
 */
export function processStart(pid, deps = {}) {
  const run = deps.execFile || execFile;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve(null);
  const win = process.platform === 'win32';
  const file = deps.exe ? deps.exe(win ? 'powershell.exe' : 'ps') : resolveExe(win ? 'powershell.exe' : 'ps');
  const args = win
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${n} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`]
    : ['-o', 'lstart=', '-p', String(n)];
  return new Promise((resolve) => {
    try {
      run(file, args, { cwd: helperCwd(), windowsHide: true, timeout: 10000 }, (err, out) => {
        const t = err ? '' : String(out || '').trim();
        resolve(t || null);
      });
    } catch { resolve(null); }
  });
}

/**
 * The folder a helper starts in when it works on no folder of its own (the walkToClaude PowerShell, icacls, the ACL
 * reader, taskkill, `claude --version`): %SystemRoot% on Windows, else the root of the file system. Never the office
 * folder, which a helper would otherwise inherit: on Windows a running process keeps its current folder busy, so nobody
 * can remove or rename the folder until the process ends (#78). Work in a session folder passes that folder instead.
 */
export function helperCwd(env = process.env) {
  if (process.platform !== 'win32') return '/';
  const root = String(envGet(env, 'SystemRoot') || envGet(env, 'windir') || '');
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  return /^[A-Za-z]:[\\/]/.test(root) && isDir(root) ? root : path.parse(os.homedir()).root;
}

function findExe(name, env, win) {
  const p = win ? path.win32 : path.posix;
  // Drive or UNC paths only on Windows: '\dir' and 'C:dir' depend on the current drive or folder.
  const absolute = (x) => (win ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(x) : p.isAbsolute(x));
  if (!name || name.includes('\0')) throw new Error('A program name is required.');
  if (absolute(name)) { if (isRunnable(name, win)) return name; throw new Error(`Program not found: ${name}`); }
  if (/[\\/]/.test(name) || (win && name.includes(':'))) throw new Error(`Give a program name or an absolute path, not ${name}.`);
  if (win) {
    const sys = SYSTEM32[name.toLowerCase().replace(/\.exe$/, '')];
    if (sys) {
      const root = String(envGet(env, 'SystemRoot') || envGet(env, 'windir') || '');
      const exe = absolute(root) ? p.join(root, 'System32', sys) : '';
      if (exe && isFile(exe)) return exe;
      throw new Error(`${name} was not found in the Windows System32 folder (SystemRoot is ${root || 'not set'}).`);
    }
  }
  const dirs = String(envGet(env, 'PATH') || '').split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(absolute);
  const exts = !win || /\.(com|exe)$/i.test(name) ? [''] : ['.com', '.exe'];
  for (const d of dirs) for (const x of exts) { const f = p.join(d, name + x); if (isRunnable(f, win)) return f; }
  if (win) {
    for (const d of dirs) for (const x of ['.cmd', '.bat', '.ps1']) {
      const f = p.join(d, name + x);
      // code and file: callers name the file in their own words without reading this message (providers' programPath).
      if (isFile(f)) throw Object.assign(new Error(`${name} is installed as a script (${f}). The office starts programs without a shell, so it needs ${name}.exe on PATH.`), { code: 'SCRIPT_INSTALL', file: f });
    }
  }
  throw new Error(`${name} was not found on PATH.`);
}

/**
 * Kill a process and its children. Windows: taskkill /T by PID by its absolute path (a shell's children outlive a plain
 * kill). Elsewhere the process group, else the process. Never rejects. deps.execFile is injectable for tests.
 */
export function killTree(pid, run = execFile) {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try { run(resolveExe('taskkill'), ['/PID', String(pid), '/T', '/F'], { cwd: helperCwd(), windowsHide: true }, () => resolve()); }
      catch { resolve(); }
    });
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  return Promise.resolve();
}

/**
 * killTree for a moment that cannot wait: the exit handler of the office (an async kill would not finish). Same rule, same
 * absolute taskkill; it waits for the kill and never throws. deps.execFileSync is injectable for tests.
 */
export function killTreeSync(pid, run = execFileSync) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { run(resolveExe('taskkill'), ['/PID', String(pid), '/T', '/F'], { cwd: helperCwd(), windowsHide: true, stdio: 'ignore', timeout: 15000 }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
