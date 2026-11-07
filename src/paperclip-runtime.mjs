// The Paperclip runtime (#193, ADR 0010): the office installs a pinned release of the official `paperclipai` package into a
// folder of its own that git ignores, starts it in its authenticated (login) mode on 127.0.0.1 with its data outside the
// repository, watches its health, keeps the one board key in an owner-only file and stops Paperclip with the office.
// A distinct job from paperclip.mjs, which reads a Paperclip (the HQ); this module only runs one. Nothing here talks to a
// Paperclip that the user runs: a Paperclip that already answers on the port is `external`, never installed over or started again.
//
// Facts (Paperclip source at v2026.1106.0, read only, and one real run of `paperclipai@2026.1106.0` in a temp folder):
//   - `paperclipai run -c <config> -i <instance>` starts it in the foreground. With the config file in place it asks nothing.
//     Its doctor step (repair on) makes the agent JWT secret and the local secrets key file when they are missing.
//   - Its doctor step finds the agent JWT secret missing on the first start, counts that as a failed check (the repair comes after
//     the check) and ends with code 1: only the second start passes. So the office makes the first-run secrets itself, owner-only:
//     the instance `.env` (PAPERCLIP_AGENT_JWT_SECRET, PAPERCLIP_TOOL_ACTION_SIGNING_SECRET) and secrets/master.key.
//   - The mode comes from the config file and from PAPERCLIP_DEPLOYMENT_MODE, PAPERCLIP_DEPLOYMENT_EXPOSURE, PAPERCLIP_BIND and
//     HOST in the environment (the environment wins). Authenticated mode answers GET /api/health without a token with
//     { status, deploymentMode, deploymentExposure, bootstrapStatus: 'ready' | 'bootstrap_pending', ... }.
//   - The first admin is a person: a bootstrap invite (printed once at start while no admin exists) or "Claim this instance"
//     in a signed-in browser. No route makes one without a signed-in session, and the office does not invent an account.
//   - A board key comes from the CLI approval flow: POST /api/cli-auth/challenges (no sign-in) gives an approval link and a pending
//     key; a signed-in admin approves the link in a browser; the office polls the challenge, checks the key with
//     GET /api/cli-auth/me and then writes it. A board key lives 30 days (Paperclip's rule); the office reads the expiry.
//
// Pure apart from createRuntime, whose file system, programs, network, clock and timers are injected: test/paperclip-runtime.test.mjs
// runs it with a fake package and a fake Paperclip, so no test installs anything or opens a socket.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as launch from './launch.mjs';

/**
 * The release the office installs: an exact version of the `paperclipai` package and the SHA-512 of its tarball as the registry
 * publishes it (`npm view paperclipai@2026.1106.0 dist.integrity`, read 2026-11-06). The install is checked against it. A new
 * release is a change here, with its own test run; "Update Paperclip" at the HQ (a later ticket) asks for a Confirm first.
 */
export const PINNED = Object.freeze({
  version: '2026.1106.0',
  integrity: 'sha512-jcZrSB5DItxeDJGO7TccI0WcYca2IbBJxpbaKZN6kZp+isNIbVF2AgmfFQq394mjXD+TTHwS5P3AT6jjpqXbng==',
});
export const DEFAULT_PORT = 3100;       // Paperclip's own default
export const DEFAULT_DB_PORT = 54339;   // not 54329, the default of a Paperclip the user may run too
export const INSTANCE = 'agent-office'; // not `default`: another instance than the user's own, so no service of theirs is touched
export const INSTALL_DIR_NAME = '.paperclip-runtime';

const START_WAIT_MS = 180000;   // a first start makes the database
const POLL_MS = 15000;
const START_POLL_MS = 2000;
const KEY_POLL_MS = 1500;
const MISSES = 3;               // health answers missed in a row before a running Paperclip is called failed
const INSTALL_MS = 15 * 60 * 1000;
const TAIL_LINES = 40;

// ---------- where things are ----------
/**
 * The folders and files of a runtime. The install folder is in the office folder (git ignores it). The data folder and the
 * key file are outside it, next to the page token file (auth.mjs pageFile): %LOCALAPPDATA%\AgentOffice on Windows, ~/.agent-office
 * elsewhere. An office on another port than 4317 has its own data and key (a second office never shares or rewrites the first one's).
 */
export function runtimePaths({ root, env = process.env, port = 4317, home = os.homedir() }) {
  const base = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'AgentOffice') : path.join(home, '.agent-office');
  const tag = Number(port) === 4317 ? '' : `-${Number(port) | 0}`;
  const data = path.join(base, `paperclip${tag}`);
  return {
    install: path.join(root, INSTALL_DIR_NAME),
    data,
    config: path.join(data, 'instances', INSTANCE, 'config.json'),
    pid: path.join(data, 'office-runtime.json'),
    key: path.join(base, `paperclip-board-key${tag}.json`),
  };
}

/** The Paperclip config of the office's instance: authenticated, private, loopback, everything under `data`. */
export function buildConfig({ data, port = DEFAULT_PORT, dbPort = DEFAULT_DB_PORT, now = () => new Date() }) {
  const inst = path.join(data, 'instances', INSTANCE);
  return {
    $meta: { version: 1, updatedAt: now().toISOString(), source: 'onboard' },
    database: {
      mode: 'embedded-postgres',
      embeddedPostgresDataDir: path.join(inst, 'db'),
      embeddedPostgresPort: dbPort,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 7, dir: path.join(inst, 'data', 'backups') },
    },
    logging: { mode: 'file', logDir: path.join(inst, 'logs') },
    server: { deploymentMode: 'authenticated', exposure: 'private', bind: 'loopback', host: '127.0.0.1', port, allowedHostnames: [], serveUi: true },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    auth: { baseUrlMode: 'auto', disableSignUp: false },
    storage: { provider: 'local_disk', localDisk: { baseDir: path.join(inst, 'data', 'storage') }, s3: { bucket: 'paperclip', region: 'us-east-1', prefix: '', forcePathStyle: false } },
    secrets: { provider: 'local_encrypted', strictMode: true, localEncrypted: { keyFilePath: path.join(inst, 'secrets', 'master.key') } },
  };
}

// What decides Paperclip's mode, database and address must not come from the office's own environment (an owner who runs another
// Paperclip has DATABASE_URL or PAPERCLIP_* set for it). The office sets its own below.
const DROP_ENV = /^(PAPERCLIP_|BETTER_AUTH_|OFFICE_)|^(DATABASE_URL|HOST|PORT|SERVE_UI)$/i;
/** The environment of the Paperclip process: the office's, without what configures another Paperclip, plus this instance's own. */
export function childEnv(base, { data, config, port = DEFAULT_PORT }) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) if (!DROP_ENV.test(k)) env[k] = v;
  return Object.assign(env, {
    PAPERCLIP_HOME: data, PAPERCLIP_INSTANCE_ID: INSTANCE, PAPERCLIP_CONFIG: config,
    PAPERCLIP_DEPLOYMENT_MODE: 'authenticated', PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private', PAPERCLIP_BIND: 'loopback',
    HOST: '127.0.0.1', PORT: String(port), PAPERCLIP_NO_BROWSER: 'true', PAPERCLIP_OPEN_ON_LISTEN: 'false',
    PAPERCLIP_UI_DEV_MIDDLEWARE: 'false', DO_NOT_TRACK: '1',
  });
}

/**
 * The JS entry of npm for this Node. npm on Windows is npm.cmd, which resolveExe refuses (the office starts no shell), so the
 * office runs npm's own JS file with node: <node folder>/node_modules/npm/bin/npm-cli.js (the Windows installer and nvm for
 * Windows), <prefix>/lib/node_modules/npm/bin/npm-cli.js (Linux and macOS). OFFICE_NPM_CLI names another file (an absolute path).
 */
export function npmCli({ env = process.env, execPath = process.execPath, exists = (p) => fs.existsSync(p) } = {}) {
  const set = env.OFFICE_NPM_CLI;
  if (set) {
    if (path.isAbsolute(set) && exists(set)) return set;
    throw new Error(`OFFICE_NPM_CLI is ${set}, which is not an existing file with an absolute path.`);
  }
  const dir = path.dirname(execPath);
  const tail = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const c of [path.join(dir, tail), path.join(dir, '..', 'lib', tail)]) if (exists(c)) return path.normalize(c);
  throw new Error(`npm was not found next to node (${dir}). Install Node with npm, or set OFFICE_NPM_CLI to the full path of npm-cli.js.`);
}

/**
 * The arguments of the install: this exact version only, in the install folder (the office has no dependencies of its own), and no
 * install scripts. The tree has 442 packages; a few have install scripts (native builds of optional modules such as ssh2 and
 * cpu-features, which node-gyp compiles for minutes or fails on a new Node, a binary download of opencode-ai, a symlink step of the
 * embedded database for Linux and macOS). Paperclip ran in login mode on Windows x64 without any of them (verified on 2026.1106.0), and
 * the office then runs the code of no package at install time.
 */
export const installArgs = (cli, pin = PINNED) => [cli, 'install', `paperclipai@${pin.version}`, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'];

// ---------- what Paperclip says ----------
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const BOOTSTRAP = /\/invite\/(pcp_bootstrap_[0-9a-f]{16,96})/;
const INVITE_TOKEN = /pcp_bootstrap_[0-9a-f]+/g;
const clean = (text) => String(text || '').replace(ANSI, '').replace(INVITE_TOKEN, 'pcp_bootstrap_...');
const oneLine = (lines, n = 3, max = 400) => clean(lines.filter((l) => l.trim()).slice(-n).join(' | ')).slice(0, max);

const ENV_KEYS = ['PAPERCLIP_AGENT_JWT_SECRET', 'PAPERCLIP_TOOL_ACTION_SIGNING_SECRET'];
/**
 * The instance `.env` text with the two first-run secrets in it: what is there stays (another line, a secret already made), a
 * missing key gets 32 random bytes as hex (what the Paperclip CLI makes). Returns null when nothing is missing.
 */
export function withSecrets(text, random = (n) => crypto.randomBytes(n)) {
  const old = String(text || '');
  const have = new Set(old.split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*\S/.exec(l)).filter(Boolean).map((m) => m[1]));
  const missing = ENV_KEYS.filter((k) => !have.has(k));
  if (!missing.length) return null;
  const base = old.trim() ? old.replace(/\s*$/, '\n') : '# Paperclip environment variables\n# Made by Agent Office. Owner only.\n\n';
  return base + missing.map((k) => `${k}=${random(32).toString('hex')}`).join('\n') + '\n';
}

/** What the saved state keeps: whether the user asked for Paperclip to run with the office. */
export function cleanRuntime(raw) { return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.enabled === true ? { enabled: true } : undefined; }

/** An answer for a route: the status and a message in plain words. */
export const runtimeError = (status, message) => Object.assign(new Error(message), { status });

/**
 * createRuntime(deps): the runtime of one office. deps (all injectable):
 *   root, port (the office's port), env, paths? (override of runtimePaths), pin, serverPort, dbPort
 *   fs, spawn(file, args, opts), exe(name), npmCli(), processStart(pid), killTree(pid), killSync(pid), fetch, writeSecret(file, text)
 *   now, random(n), setTimer(fn, ms), clearTimer(h), onChange(), onFeed(text, kind)
 * Methods: status(), install({ background }), start(), stop(), killNow(), resume(enabled), connectKey(), key() (the token, for the
 * HQ's own calls: never in a route answer).
 */
export function createRuntime(deps = {}) {
  const d = {
    env: process.env, port: 4317, fs, spawn: null, exe: launch.resolveExe, npmCli, processStart: launch.processStart, killTree: launch.killTree,
    killSync: launch.killTreeSync, fetch: globalThis.fetch, writeSecret: (f, t) => fs.writeFileSync(f, t), now: () => new Date(),
    random: (n) => crypto.randomBytes(n), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), onChange() {}, onFeed() {}, pin: PINNED, ...deps,
  };
  const fsx = d.fs;
  const P = d.paths || runtimePaths({ root: d.root, env: d.env, port: d.port });
  const serverPort = Number(d.serverPort) || Number(d.env.OFFICE_PAPERCLIP_PORT) || DEFAULT_PORT;
  const dbPort = Number(d.dbPort) || Number(d.env.OFFICE_PAPERCLIP_DB_PORT) || DEFAULT_DB_PORT;
  const url = `http://127.0.0.1:${serverPort}`;
  const cliPath = () => path.join(P.install, 'node_modules', 'paperclipai', 'dist', 'index.js');

  let state = 'off', reason = '', child = null, pid = 0, tail = [], bootstrap = null, invite = '', wantStop = false, busy = false;
  let timer = null, misses = 0, startedAt = 0;
  let key = { state: 'none', reason: '', expiresAt: null, approvalUrl: '' };
  let challenge = null, keyTimer = null;

  const change = () => { try { d.onChange(); } catch { /* the page catches up at the next one */ } };
  const feed = (text, kind = 'start') => { try { d.onFeed(text, kind); } catch { /* feed only */ } };
  const set = (s, r = '') => { state = s; reason = r; change(); };
  const read = (file) => { try { return JSON.parse(fsx.readFileSync(file, 'utf8')); } catch { return null; } };

  // ---------- install ----------
  function installedVersion() {
    const j = read(path.join(P.install, 'node_modules', 'paperclipai', 'package.json'));
    return j && typeof j.version === 'string' ? j.version : null;
  }
  // Checked fresh before an install or a start; status() (each snapshot) reads what the last check found, not the lock file again.
  let installedOk = null;
  const isInstalled = () => (installedOk = verifyInstall() === '');
  const installedNow = () => (installedOk === null ? isInstalled() : installedOk);

  /** Checks the install against the pinned release: the version and the tarball's SHA-512 from npm's own lock file. */
  function verifyInstall() {
    const v = installedVersion();
    if (v !== d.pin.version) return `npm installed ${v || 'no paperclipai'}, not ${d.pin.version}.`;
    const lock = read(path.join(P.install, 'package-lock.json'));
    const entry = lock && lock.packages && lock.packages['node_modules/paperclipai'];
    if (!entry || entry.integrity !== d.pin.integrity) return `The package that npm installed does not match the SHA-512 that the office pins for paperclipai ${d.pin.version}.`;
    if (!fsx.existsSync(cliPath())) return 'The package has no dist/index.js.';
    return '';
  }

  const run = (file, args, opts, { limitMs } = {}) => new Promise((resolve) => {
    const lines = [];
    let c, over = false, done = false;
    const end = (r) => { if (done) return; done = true; if (t) d.clearTimer(t); resolve({ ...r, lines }); };
    let t = null;
    try { c = d.spawn(file, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return end({ code: null, error: e.message }); }
    const eat = (chunk) => { for (const l of String(chunk).split(/\r?\n/)) { lines.push(l); if (lines.length > TAIL_LINES) lines.shift(); } };
    if (c.stdout) c.stdout.on('data', eat);
    if (c.stderr) c.stderr.on('data', eat);
    c.once('error', (e) => end({ code: null, error: e.message }));
    c.once('exit', (code) => end({ code, over }));
    if (limitMs) t = d.setTimer(() => { over = true; void d.killTree(c.pid); }, limitMs);
  });

  /**
   * Installs the pinned release. One at a time. A Paperclip that already answers on the port is never installed over. It answers when
   * the install is done; with background: true it answers as soon as the install has started (the checks that can refuse come first),
   * and the state, the reason and the feed tell how it ends (a download of minutes is not held in a request).
   */
  async function install({ background = false } = {}) {
    if (busy || state === 'installing') throw runtimeError(409, 'Paperclip is being installed already.');
    if (isInstalled()) { if (state === 'off' || state === 'failed') set('stopped'); return status(); }
    const seen = await probe();
    if (seen.kind === 'paperclip') { set('external', `A Paperclip already runs at ${url}. The office does not install another one. Connect to it instead.`); throw runtimeError(409, reason); }
    if (seen.kind === 'other') { set('busy', `Something else uses port ${serverPort}, so Paperclip could not start there.`); throw runtimeError(409, reason); }
    let cli;
    try { cli = d.npmCli(); } catch (e) { set('failed', e.message); throw runtimeError(409, e.message); }
    busy = true; set('installing', `Installing paperclipai ${d.pin.version} with npm. This takes a few minutes.`);
    feed(`installing paperclipai ${d.pin.version} into ${P.install}`);
    const work = (async () => {
      try {
        fsx.mkdirSync(P.install, { recursive: true });
        const pj = path.join(P.install, 'package.json');
        if (!fsx.existsSync(pj)) fsx.writeFileSync(pj, JSON.stringify({ name: 'agent-office-paperclip', private: true, description: 'The Paperclip release that Agent Office installs. Not part of the repository.' }, null, 2));
        const r = await run(d.exe(process.execPath), installArgs(cli, d.pin), { cwd: P.install, env: d.env }, { limitMs: INSTALL_MS });
        const why = r.error ? r.error : r.over ? 'npm did not finish in 15 minutes.' : r.code !== 0 ? `npm stopped with code ${r.code}: ${oneLine(r.lines, 4)}` : verifyInstall();
        if (why) throw new Error(why);
        isInstalled(); set('stopped'); feed(`installed paperclipai ${d.pin.version} (checked against its pinned SHA-512)`);
        return status();
      } catch (e) {
        isInstalled();
        set('failed', `The install failed. ${e.message}`); feed(`install failed: ${e.message}`, 'error');
        throw runtimeError(500, reason);
      } finally { busy = false; }
    })();
    if (!background) return work;
    work.catch(() => { /* the state and the feed carry it */ });
    return status();
  }

  // ---------- health ----------
  async function get(route, headers) {
    const r = await d.fetch(url + route, { headers, signal: AbortSignal.timeout(4000), redirect: 'error' });
    let json = null;
    try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json };
  }
  /** What answers on the port: nothing ('free'), a Paperclip ('paperclip', with its health), or another program ('other'). */
  async function probe() {
    try {
      const r = await get('/api/health');
      const j = r.json;
      const mine = r.status === 200 || r.status === 503;
      if (mine && j && typeof j.status === 'string' && (typeof j.deploymentMode === 'string' || typeof j.version === 'string')) return { kind: 'paperclip', health: j, code: r.status };
      return { kind: 'other' };
    } catch (e) {
      const code = e && e.cause && e.cause.code;
      return { kind: code === 'ECONNREFUSED' ? 'free' : 'other' }; // a timeout or a reset: something holds the port
    }
  }
  function readHealth(h) {
    bootstrap = h.bootstrapStatus === 'bootstrap_pending' ? 'pending' : h.bootstrapStatus === 'ready' ? 'ready' : bootstrap;
    if (bootstrap !== 'pending') invite = '';
  }

  // ---------- start and stop ----------
  const savePid = async () => {
    try { fsx.writeFileSync(P.pid, JSON.stringify({ pid, startedAt: await d.processStart(pid), port: serverPort })); } catch { /* adoption is optional */ }
  };
  const dropPid = () => { try { fsx.rmSync(P.pid, { force: true }); } catch { /* gone */ } };

  /** A Paperclip that an earlier office started and left running (the office was killed): the same process, by pid and start time. */
  async function adopt() {
    const rec = read(P.pid);
    if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0 || rec.port !== serverPort) return false;
    const at = await d.processStart(rec.pid);
    if (!at || !rec.startedAt || at !== rec.startedAt) { dropPid(); return false; }
    const seen = await probe();
    if (seen.kind !== 'paperclip') return false;
    pid = rec.pid; child = null;
    return seen;
  }

  // The first-run secrets of Paperclip, owner-only (the CLI would make them after its first doctor run failed). Never overwritten.
  function ensureSecrets() {
    const envFile = path.join(path.dirname(P.config), '.env');
    let text = '';
    try { text = fsx.readFileSync(envFile, 'utf8'); } catch { /* none yet */ }
    const next = withSecrets(text, d.random);
    if (next !== null) d.writeSecret(envFile, next);
    const keyFile = path.join(path.dirname(P.config), 'secrets', 'master.key');
    if (!fsx.existsSync(keyFile)) { fsx.mkdirSync(path.dirname(keyFile), { recursive: true }); d.writeSecret(keyFile, d.random(32).toString('base64')); }
  }

  async function start() {
    if (['starting', 'running'].includes(state)) return status();
    if (busy || state === 'installing') throw runtimeError(409, 'Paperclip is being installed. Start it when that is done.');
    if (!isInstalled()) throw runtimeError(409, 'Paperclip is not installed yet. Install it first.');
    busy = true;
    try {
      const adopted = await adopt();
      if (adopted) {
        readHealth(adopted.health); misses = 0; startedAt = d.now().getTime();
        if (adopted.health.deploymentMode !== 'authenticated') { await killAdopted(); set('failed', 'The Paperclip of an earlier office is not in login mode, so the office stopped it.'); throw runtimeError(409, reason); }
        set('running'); feed('Paperclip from an earlier office still ran, so the office took it over'); schedule(POLL_MS); void checkKey(); return status();
      }
      const seen = await probe();
      if (seen.kind === 'paperclip') { set('external', `A Paperclip already runs at ${url} that this office did not start. The office does not start another one. Connect to it instead.`); throw runtimeError(409, reason); }
      if (seen.kind === 'other') { set('busy', `Something else uses port ${serverPort}, so Paperclip cannot start there.`); throw runtimeError(409, reason); }
      fsx.mkdirSync(path.dirname(P.config), { recursive: true });
      if (!fsx.existsSync(P.config)) fsx.writeFileSync(P.config, JSON.stringify(buildConfig({ data: P.data, port: serverPort, dbPort, now: d.now }), null, 2));
      ensureSecrets();
      tail = []; invite = ''; bootstrap = null; wantStop = false; misses = 0; startedAt = d.now().getTime();
      const env = childEnv(d.env, { data: P.data, config: P.config, port: serverPort });
      let c;
      try { c = d.spawn(d.exe(process.execPath), [cliPath(), 'run', '-c', P.config, '-i', INSTANCE], { cwd: P.data, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { set('failed', `Paperclip did not start: ${e.message}`); throw runtimeError(500, reason); }
      child = c; pid = c.pid;
      const eat = (chunk) => {
        for (const l of String(chunk).split(/\r?\n/)) {
          const m = BOOTSTRAP.exec(l.replace(ANSI, ''));
          if (m && bootstrap !== 'ready') invite = `${url}/invite/${m[1]}`;
          tail.push(l); if (tail.length > TAIL_LINES) tail.shift();
        }
      };
      if (c.stdout) c.stdout.on('data', eat);
      if (c.stderr) c.stderr.on('data', eat);
      c.once('error', (e) => { if (child === c) onGone(null, e.message); });
      c.once('exit', (code) => { if (child === c) onGone(code); });
      void savePid();
      set('starting', 'Paperclip is starting. The first start makes its database and takes a minute or two.');
      feed(`Paperclip ${d.pin.version} starting at ${url} (login mode, this computer only)`);
      schedule(START_POLL_MS);
      return status();
    } finally { busy = false; }
  }

  function onGone(code, error) {
    child = null; pid = 0; unschedule(); dropPid(); stopKeyWatch();
    if (wantStop) { set('stopped'); return; }
    const why = error || `Paperclip stopped with code ${code}. ${oneLine(tail, 3)}`.trim();
    set('failed', why); feed(`Paperclip stopped: ${why}`, 'error');
  }

  function unschedule() { if (timer) { d.clearTimer(timer); timer = null; } }
  function schedule(ms) { unschedule(); timer = d.setTimer(() => { timer = null; return beat(); }, ms); }

  // One health check. While starting, the first good answer in login mode makes it running; a late one or a wrong mode is a failure.
  async function beat() {
    if (!['starting', 'running'].includes(state)) return;
    const seen = await probe();
    if (!['starting', 'running'].includes(state)) return;
    if (seen.kind === 'paperclip' && seen.code === 200 && seen.health.status === 'ok') {
      if (seen.health.deploymentMode !== 'authenticated') { await killAny(); set('failed', `Paperclip answered in ${seen.health.deploymentMode || 'an unknown'} mode, not login mode, so the office stopped it. Nothing was kept.`); feed(reason, 'error'); return; }
      misses = 0; readHealth(seen.health);
      if (state === 'starting') { set('running'); feed(`Paperclip is running at ${url}`); void checkKey(); } else change();
      return schedule(POLL_MS);
    }
    if (state === 'starting') {
      if (d.now().getTime() - startedAt > START_WAIT_MS) { await killAny(); set('failed', `Paperclip did not answer in ${START_WAIT_MS / 1000} seconds. ${oneLine(tail, 3)}`.trim()); feed(reason, 'error'); return; }
      return schedule(START_POLL_MS);
    }
    if (++misses >= MISSES) { await killAny(); set('failed', `Paperclip stopped answering at ${url}. ${oneLine(tail, 3)}`.trim()); feed(reason, 'error'); return; }
    schedule(POLL_MS);
  }

  async function killAdopted() { const p = pid; pid = 0; dropPid(); if (p) await d.killTree(p); }
  async function killAny() { unschedule(); wantStop = true; const p = pid; if (p) await d.killTree(p); pid = 0; dropPid(); }

  /** Stops Paperclip that this office runs. The user's own Paperclip is never touched (it has no pid here). */
  async function stop() {
    unschedule(); stopKeyWatch();
    if (!pid) { if (['starting', 'running'].includes(state)) set('stopped'); return status(); }
    wantStop = true;
    const c = child, p = pid;
    await d.killTree(p);
    if (c && c.exitCode === null) await new Promise((resolve) => { let t = null; const fin = () => { if (t) d.clearTimer(t); resolve(); }; c.once('exit', fin); t = d.setTimer(fin, 10000); });
    child = null; pid = 0; dropPid(); set('stopped'); feed('Paperclip stopped');
    return status();
  }

  /** The office is closing: end the process now (the exit handler of the office cannot wait). */
  function killNow() { unschedule(); stopKeyWatch(); wantStop = true; const p = pid; pid = 0; if (p) { try { d.killSync(p); } catch { /* gone */ } dropPid(); } }

  // ---------- the board key ----------
  const keyOk = (rec) => rec && typeof rec.token === 'string' && rec.token.length >= 16;
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  /** The key file, checked against Paperclip: who it is, and when it expires. */
  async function checkKey() {
    const rec = read(P.key);
    if (!keyOk(rec) || rec.apiBase !== url) { if (key.state !== 'waiting') { key = { state: 'none', reason: '', expiresAt: null, approvalUrl: '' }; change(); } return; }
    try {
      const me = await get('/api/cli-auth/me', bearer(rec.token));
      if (me.status === 200 && me.json && me.json.userId) {
        let expiresAt = rec.expiresAt || null;
        try {
          const list = await get('/api/board-api-keys', bearer(rec.token));
          const mine = Array.isArray(list.json) ? list.json.find((k) => k && k.id === me.json.keyId) : null;
          if (mine) expiresAt = mine.expiresAt || null;
        } catch { /* keep what was written */ }
        const days = expiresAt ? (Date.parse(expiresAt) - d.now().getTime()) / 86400000 : null;
        key = days !== null && days <= 0 ? { state: 'expired', reason: 'The board key expired. Connect a new one.', expiresAt, approvalUrl: '' } : { state: 'ready', reason: '', expiresAt, approvalUrl: '' };
      } else if (me.status === 401 || me.status === 403) key = { state: 'expired', reason: 'Paperclip no longer accepts the board key. Connect a new one.', expiresAt: rec.expiresAt || null, approvalUrl: '' };
    } catch { /* Paperclip is not answering: keep what the file says for now */ }
    change();
  }
  function stopKeyWatch() { if (keyTimer) { d.clearTimer(keyTimer); keyTimer = null; } challenge = null; if (key.state === 'waiting') key = { state: 'none', reason: '', expiresAt: null, approvalUrl: '' }; }

  /**
   * Starts the board key approval: Paperclip makes a challenge and the office shows its approval link. A signed-in admin of Paperclip
   * approves it in a browser (a step only a person can do); the office then writes the key to its owner-only file. Needs a
   * running Paperclip whose first admin exists.
   */
  async function connectKey() {
    if (state !== 'running') throw runtimeError(409, 'Paperclip is not running. Start it first.');
    if (bootstrap === 'pending') throw runtimeError(409, 'Paperclip has no admin yet. Create the first account and claim the instance in Paperclip, then connect the key.');
    stopKeyWatch();
    const r = await d.fetch(`${url}/api/cli-auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ command: 'agent-office', clientName: 'Agent Office', requestedAccess: 'board', requestedCompanyId: null }),
    });
    const j = await r.json().catch(() => null);
    if (r.status !== 201 || !j || !j.id || !j.token || !j.boardApiToken || typeof j.approvalPath !== 'string') throw runtimeError(502, `Paperclip did not make an approval link (it answered ${r.status}).`);
    // The link is built here from the path and this Paperclip's own address, never taken from the answer's host.
    const link = new URL(j.approvalPath, url);
    if (link.origin !== url || !/^\/cli-auth\/[0-9a-f-]{36}$/i.test(link.pathname)) throw runtimeError(502, 'Paperclip gave an approval link that is not on its own address.');
    challenge = { id: String(j.id), token: String(j.token), pending: String(j.boardApiToken), expires: Date.parse(j.expiresAt) || d.now().getTime() + 600000 };
    key = { state: 'waiting', reason: 'Open the link and approve the office in Paperclip.', expiresAt: new Date(challenge.expires).toISOString(), approvalUrl: link.href };
    change(); feed('board key requested: waiting for you to approve it in Paperclip');
    keyTimer = d.setTimer(pollKey, KEY_POLL_MS);
    return status();
  }
  async function pollKey() {
    keyTimer = null;
    const c = challenge;
    if (!c) return;
    const refuse = (why) => { challenge = null; key = { state: 'refused', reason: why, expiresAt: null, approvalUrl: '' }; change(); feed(why, 'error'); };
    try {
      if (d.now().getTime() > c.expires) return refuse('The approval link expired before you approved it. Connect the key again.');
      const s = await get(`/api/cli-auth/challenges/${encodeURIComponent(c.id)}?token=${encodeURIComponent(c.token)}`);
      const st = s.json && s.json.status;
      if (s.status === 200 && st === 'approved') {
        const me = await get('/api/cli-auth/me', bearer(c.pending));
        if (me.status !== 200 || !me.json || !me.json.userId || me.json.source !== 'board_key') return refuse('Paperclip approved the link, but the key did not work. Connect the key again.');
        let expiresAt = null;
        try { const list = await get('/api/board-api-keys', bearer(c.pending)); const mine = Array.isArray(list.json) ? list.json.find((k) => k && k.id === me.json.keyId) : null; expiresAt = mine && mine.expiresAt || null; } catch { /* the expiry is shown when known */ }
        fsx.mkdirSync(path.dirname(P.key), { recursive: true });
        d.writeSecret(P.key, JSON.stringify({ token: c.pending, apiBase: url, userId: me.json.userId, keyId: me.json.keyId || null, expiresAt, createdAt: d.now().toISOString() }));
        challenge = null; key = { state: 'ready', reason: '', expiresAt, approvalUrl: '' }; change(); feed('board key saved in an owner-only file');
        return;
      }
      if (st === 'cancelled') return refuse('The approval was cancelled in Paperclip. Connect the key again.');
      if (st === 'expired') return refuse('The approval link expired before you approved it. Connect the key again.');
    } catch { /* Paperclip did not answer once: try again until the link expires */ }
    if (challenge === c) keyTimer = d.setTimer(pollKey, KEY_POLL_MS);
  }

  // ---------- what the page shows ----------
  // Installed but never started in this process: stopped, not off.
  const stateNow = () => (state === 'off' && installedNow() ? 'stopped' : state);
  function steps() {
    if (stateNow() === 'off') return ['Install Paperclip. The office downloads one pinned release with npm into its own folder.'];
    if (stateNow() === 'stopped') return ['Start Paperclip.'];
    if (state !== 'running') return [];
    const out = [];
    if (bootstrap === 'pending') out.push(invite ? 'Open the first-account link, create an account in Paperclip and finish the sign-up. That account becomes the admin.' : `Open Paperclip at ${url}, create an account and choose Claim this instance. That account becomes the admin.`);
    else if (key.state === 'none' || key.state === 'refused') out.push('Connect the board key: the office shows a link, you approve it in Paperclip.');
    else if (key.state === 'waiting') out.push('Open the approval link and approve the office in Paperclip.');
    else if (key.state === 'expired') out.push('Connect a new board key.');
    return out;
  }
  function status() {
    return {
      state: stateNow(), reason, version: d.pin.version, installed: installedNow(), url, port: serverPort,
      bootstrap, inviteUrl: state === 'running' && bootstrap === 'pending' ? invite : '',
      key: { state: key.state, reason: key.reason, expiresAt: key.expiresAt, approvalUrl: key.state === 'waiting' ? key.approvalUrl : '' },
      steps: steps(),
    };
  }

  /** At the office start: the runtime comes back when the user asked for it (and it is installed). */
  async function resume(enabled) {
    if (isInstalled() && state === 'off') set('stopped');
    if (!enabled || !isInstalled()) return status();
    try { return await start(); } catch (e) { feed(`Paperclip did not start with the office: ${e.message}`, 'error'); return status(); }
  }

  return { status, install, start, stop, killNow, resume, connectKey, key: () => { const rec = read(P.key); return keyOk(rec) && rec.apiBase === url && key.state === 'ready' ? rec.token : null; }, paths: P, url };
}
