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
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { resolveExe, helperCwd } from '../../git.mjs';

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

// Ends a process and its children by pid. A pid that is already gone is no failure.
const killTree = (pid) => new Promise((resolve) => {
  execFile(resolveExe('taskkill'), ['/PID', String(pid), '/T', '/F'], { cwd: helperCwd(), windowsHide: true }, () => resolve());
});

/**
 * Starts server.mjs in `dir` and returns { child, done, exited, out, stop }.
 * `done` resolves 'open' on the ready line, and 'exited' when the copy printed "already running" and exited 0 (a copy on
 * a busy port). It rejects when the server exits any other way or the ready line does not come in `ms`. A rejection for a
 * busy port has `busy: true`.  `script` is for a test that starts a stand-in instead of the server.
 */
export function startOffice(dir, env, { ms = START_MS, script = path.join(dir, 'server.mjs'), execPath = process.execPath } = {}) {
  const child = spawn(execPath, [script], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') await killTree(child.pid);
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
const held = new Set();
export const holdPort = (port) => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => { held.add(s); resolve(s); });
});
export const hold = (s) => { held.add(s); return s; };
export const close = (s) => new Promise((r) => { if (!s.listening) return r(); s.close(() => r()); });
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
