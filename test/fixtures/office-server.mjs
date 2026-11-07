// Shared start of a real server.mjs copy for the tests (#98). One place for the three things that made server tests fail
// under load (40 to 60 node processes at once):
// - Ready means the server's own line "Agent Office is open: ...". The server prints it after it listens and after it
//   wrote the token, hooks, MCP, state and page files. The helper waits on that line, never on a fixed delay or a file.
//   A server that exits before the line fails the wait at once, with its output.
// - The wait is long (a loaded machine needs more than 15 s), but a fast start still returns at once.
// - A free port is a guess: freePort() closes the port before the server binds it, and another run can take it in
//   between. startOnFreePort() sees that (the server says "already running" or "is busy" and exits) and starts again
//   on a new port. A copy of the office takes its file names from its port (files.mjs), so `prepare(port)` makes the
//   files that depend on the port, once for each try.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { killTree, resolveExe, helperCwd } from '../../src/launch.mjs';

// Windows keeps a process's ParentProcessId after the parent has exited, so the children of an office that ended first can
// still be found by pid (#161). Every process of the process table that descends from `root` and started at or after
// `since` (ms) and after its own parent (a reused pid never does). Never rejects; [] when the table cannot be read.
const TABLE_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([datetimeoffset]$_.CreationDate | ForEach-Object { $_.ToUnixTimeMilliseconds() })" }';
export function descendantsOf(rows, root, since) {
  const born = new Map(rows.map((r) => [r.pid, r.at]));
  const found = []; const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const r of rows) if (r.ppid === p && r.pid !== root && !found.includes(r.pid) && r.at >= since && (!born.has(p) || r.at >= born.get(p))) { found.push(r.pid); queue.push(r.pid); }
  }
  return found;
}
const processTable = () => new Promise((resolve) => {
  try {
    execFile(resolveExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT], { cwd: helperCwd(), windowsHide: true, timeout: 20000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 3 && a.every(Number.isFinite)).map(([pid, ppid, at]) => ({ pid, ppid, at })));
    });
  } catch { resolve([]); }
});

// The repository root, and the copy a test makes of the office layout: package.json, launch.ps1, src/ (every server module),
// public/, and with `components` also tokens.css and components/ (what the static routes serve). The copy has the same layout
// as the repository, so files.mjs OFFICE_ROOT is the copy's folder and the server writes its runtime files there, never in
// the repository. Every test that runs a real server.mjs copy starts with this, so none keeps its own file list.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function copyOffice(dest, { components = false, from = REPO_ROOT } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['package.json', 'launch.ps1', ...(components ? ['tokens.css'] : [])]) fs.copyFileSync(path.join(from, f), path.join(dest, f));
  for (const d of ['src', 'public', ...(components ? ['components'] : [])]) fs.cpSync(path.join(from, d), path.join(dest, d), { recursive: true });
}

export const READY = /is open: /;
// What a server prints when its port is taken (server.mjs, server.on('error')).
export const BUSY = /already running on port|is busy/;
export const START_MS = 240000;

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Polls fn until it gives a truthy value. On timeout the failure names `what` and shows the end of `log()`. */
export async function until(fn, what, { ms = START_MS, log = () => '', step = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\n${String(log()).slice(-800)}`);
    await new Promise((r) => setTimeout(r, step));
  }
}


/**
 * Starts server.mjs in `dir` and returns { child, done, exited, out, stop }.
 * `done` resolves 'open' on the ready line, and 'exited' when the copy printed "already running" and exited 0 (a copy on
 * a busy port). It rejects when the server exits any other way or the ready line does not come in `ms`. A rejection for a
 * busy port has `busy: true`.  `script` is for a test that starts a stand-in instead of the server.
 */
export function startOffice(dir, env, { ms = START_MS, script = path.join(dir, 'src', 'server.mjs'), execPath = process.execPath } = {}) {
  const since = Date.now() - 1000;
  const child = spawn(execPath, [script], { cwd: dir, env: { OFFICE_EXPLAIN: 'off', ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  // A child that cannot start gives `error` and no `exit`: exited settles with null then, so no caller waits for ever.
  const exited = new Promise((r) => { child.once('exit', r); child.once('error', () => r(null)); });
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill(); reject(new Error(`the office did not say it is open in ${ms} ms:\n${out}`)); }, ms);
    const onData = (d) => { out += d; if (READY.test(out)) { clearTimeout(t); resolve('open'); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (e) => { clearTimeout(t); reject(e); });
    exited.then((code) => {
      clearTimeout(t);
      if (READY.test(out)) return;
      if (/already running/.test(out) && code === 0) return resolve('exited');
      reject(Object.assign(new Error(`the office stopped (${code}) before it was open:\n${out}`), { busy: BUSY.test(out) }));
    });
  });
  // The caller may only look at done after a failure elsewhere; a rejection nobody awaits must not end the run.
  done.catch(() => {});
  return {
    child, done, exited, out: () => out,
    /**
     * Stops this child and everything it started, by pid, never by image name (#161). On Windows that is
     * `taskkill /PID <pid> /T /F`: child.kill() ends only the server, so a git it started could still hold a folder.
     * Waits for taskkill and for the server to exit.
     */
    async stop() {
      if (!child.pid) return;
      const gone = child.exitCode !== null || child.signalCode !== null;
      if (process.platform === 'win32') {
        // Walk the tree first, then kill: when the server ended before stop(), taskkill /T has no parent left to walk,
        // but each child still names it (#161). Children go by pid, newest first, so none restarts a sibling.
        const kids = descendantsOf(await processTable(), child.pid, since);
        if (!gone) await killTree(child.pid);
        for (const pid of kids.reverse()) await killTree(pid);
      }
      if (gone) return;
      child.kill();
      await exited;
    },
  };
}

/**
 * Starts a copy of the office on a free port; if the port is taken meanwhile, tries again on a new one.
 * `env` is the environment without OFFICE_PORT; `prepare(port)` (optional, may be async) makes what depends on the port;
 * `envFor(port)` (optional) adds the environment that names the port (a setting that must equal it).
 * Returns { office, port, env } where office is the startOffice result and env has OFFICE_PORT.
 */
export async function startOnFreePort(dir, env, { prepare, envFor, attempts = 6, ms = START_MS } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const port = await freePort();
    if (prepare) await prepare(port);
    const withPort = { ...env, ...(envFor ? envFor(port) : {}), OFFICE_PORT: String(port) };
    const office = startOffice(dir, withPort, { ms });
    try {
      if ((await office.done) === 'open') return { office, port, env: withPort };
      last = new Error(`port ${port} was taken by another office:\n${office.out()}`);
    } catch (e) {
      await office.stop();
      if (!e.busy) throw e;
      last = e;
    }
  }
  throw new Error(`no free port after ${attempts} tries. ${last?.message || ''}`);
}

// Ports a test holds. closeHeld() closes every one that is still open, so a failed or timed-out test never leaves a
// listening socket that keeps the test process alive (#122). Closing twice is harmless.
// server.close() waits for every accepted connection, so a client that keeps one open (keep-alive) would hang it (#190):
// the accepted sockets are remembered and destroyed before close.
const held = new Set();
const accepted = new WeakMap();
const track = (s) => {
  if (accepted.has(s)) return s;
  const sockets = new Set();
  accepted.set(s, sockets);
  s.on('connection', (c) => { sockets.add(c); c.once('close', () => sockets.delete(c)); });
  return s;
};
export const holdPort = (port) => new Promise((resolve, reject) => {
  const s = track(net.createServer());
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => { held.add(s); resolve(s); });
});
export const hold = (s) => { held.add(track(s)); return s; };
export const close = (s) => new Promise((r) => {
  if (!s.listening) return r();
  s.close(() => r());
  for (const c of accepted.get(s) || []) c.destroy();
});
export const closeHeld = async () => { const all = [...held]; held.clear(); for (const s of all) await close(s); };

/** listening: the office said it is open. Else its exit code (null: it never ran, or was killed at the limit `ms`). */
export async function settle(o, ms = START_MS + 30000) {
  let timer;
  const limit = new Promise((r) => { timer = setTimeout(() => { o.child.kill(); r('limit'); }, ms); });
  try {
    const listening = await Promise.race([o.done.then(() => true, () => false), limit]);
    if (listening === 'limit') throw new Error(`the office did not settle in ${ms} ms:
${o.out()}`);
    const code = listening ? null : await Promise.race([o.exited, limit]);
    if (code === 'limit') throw new Error(`the office did not stop in ${ms} ms:
${o.out()}`);
    return { listening, code };
  } finally { clearTimeout(timer); }
}
