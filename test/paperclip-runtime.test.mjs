// The Paperclip runtime (#193): install, start, health, the board key and stop, with a fake package, a fake spawn, a fake Paperclip
// and a manual clock. No network, no real process, no real npm. Run: node --test test/paperclip-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  PINNED, VERIFIED, INSTANCE, runtimePaths, buildConfig, childEnv, npmCli, installArgs, cleanRuntime, createRuntime, withSecrets,
} from '../src/paperclip-runtime.mjs';

const URL_ = 'http://127.0.0.1:3100';
const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BOOT = 'pcp_bootstrap_' + 'ab12'.repeat(12);

// ---------- rigs ----------
function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prt-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// A fake Paperclip: the routes the runtime uses, with state the test changes.
function fakePaperclip() {
  const pc = {
    up: false, mode: 'authenticated', bootstrapStatus: 'bootstrap_pending', code: 200, other: false, requests: [],
    challenge: { status: 'pending' }, keyValid: false, keyExpires: '2026-12-06T00:00:00.000Z', badOrigin: false, createStatus: 201,
  };
  pc.fetch = async (u, init = {}) => {
    const x = new URL(u);
    const route = x.pathname + x.search;
    pc.requests.push({ method: init.method || 'GET', route, headers: init.headers || {}, body: init.body });
    if (!pc.up) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (pc.other) return { status: 404, ok: false, json: async () => { throw new Error('not json'); } };
    if (x.pathname === '/api/health') return json(pc.code, { status: pc.code === 200 ? 'ok' : 'unhealthy', deploymentMode: pc.mode, deploymentExposure: 'private', bootstrapStatus: pc.bootstrapStatus });
    if (x.pathname === '/api/cli-auth/challenges' && init.method === 'POST') {
      return json(pc.createStatus, { id: GUID, token: 'c'.repeat(40), boardApiToken: 'pcp_board_' + 'd'.repeat(40), approvalPath: `/cli-auth/${GUID}?token=${'c'.repeat(40)}`, approvalUrl: pc.badOrigin ? 'http://evil.test/x' : `${URL_}/cli-auth/${GUID}`, pollPath: `/cli-auth/challenges/${GUID}`, expiresAt: '2099-01-01T00:00:00.000Z', suggestedPollIntervalMs: 1000 });
    }
    if (x.pathname === `/api/cli-auth/challenges/${GUID}`) return json(200, { id: GUID, ...pc.challenge });
    const auth = (init.headers || {}).authorization || '';
    const okKey = pc.keyValid && /^Bearer pcp_board_/.test(auth);
    if (x.pathname === '/api/cli-auth/me') return okKey ? json(200, { userId: 'u1', keyId: 'k1', source: 'board_key', isInstanceAdmin: true }) : json(401, { error: 'Board authentication required' });
    if (x.pathname === '/api/board-api-keys') return okKey ? json(200, [{ id: 'k1', expiresAt: pc.keyExpires }]) : json(401, { error: 'no' });
    return json(404, { error: 'not found' });
  };
  return pc;
}
function fakeChild(pid = 4242) {
  const c = new EventEmitter();
  Object.assign(c, { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null });
  c.end = (code) => { c.exitCode = code; c.emit('exit', code); };
  return c;
}
// A manual clock: timers run when the test says so.
function clock() {
  const q = [];
  let t = 0, id = 0;
  return {
    setTimer(fn, ms) { const h = ++id; q.push({ h, at: t + ms, fn }); return h; },
    clearTimer(h) { const i = q.findIndex((x) => x.h === h); if (i >= 0) q.splice(i, 1); },
    async advance(ms) { t += ms; for (;;) { const i = q.findIndex((x) => x.at <= t); if (i < 0) return; const [x] = q.splice(i, 1); await x.fn(); } },
    pending: () => q.length,
    elapsed: () => t,
  };
}
// The package that npm would put in the install folder: the file layout and the lock entry of paperclipai.
function plantPackage(install, { version = PINNED.version, integrity = PINNED.integrity, marker = false } = {}) {
  fs.mkdirSync(install, { recursive: true });
  if (marker) fs.writeFileSync(path.join(install, VERIFIED), JSON.stringify({ version, integrity }));
  const pkg = path.join(install, 'node_modules', 'paperclipai');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'paperclipai', version }));
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '// fake\n');
  fs.writeFileSync(path.join(install, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/paperclipai': { version, integrity } } }));
}
function rig({ plant = false, pin, port = 4392, env = {} } = {}) {
  const f = folder();
  const root = path.join(f.dir, 'office'), local = path.join(f.dir, 'local');
  fs.mkdirSync(root, { recursive: true });
  const paths = runtimePaths({ root, env: { LOCALAPPDATA: local }, port });
  if (plant) plantPackage(paths.install, plant === true ? {} : plant);
  const pc = fakePaperclip(), clk = clock();
  const r = { f, root, local, paths, pc, clk, spawned: [], killed: [], killedSync: [], feeds: [], changes: 0, secrets: [], children: [], npmExit: 0, npmPlant: true, npmOut: '', npmIntegrity: '', npmVersion: '' };
  r.runtime = createRuntime({
    root, port, ...(pin ? { pin } : {}), env: { LOCALAPPDATA: local, PATH: '/bin', ...env }, fetch: (u, i) => pc.fetch(u, i), setTimer: clk.setTimer, clearTimer: clk.clearTimer,
    exe: (n) => `/abs/${path.basename(n)}`, npmCli: () => '/abs/npm-cli.js', processStart: async (p) => `start-${p}`,
    killTree: async (p) => { r.killed.push(p); const c = r.children.find((x) => x.pid === p); if (c && !c.isNpm) pc.up = false; if (c && c.exitCode === null) c.end(1); },
    killSync: (p) => r.killedSync.push(p), writeSecret: (file, text) => { r.secrets.push(file); fs.writeFileSync(file, text); },
    onChange: () => { r.changes++; }, onFeed: (text, kind) => r.feeds.push([kind, text]), now: () => new Date(Date.parse('2026-11-06T12:00:00Z') + clk.elapsed()),
    spawn: (file, args, opts) => {
      r.spawned.push({ file, args, opts });
      const c = fakeChild(4242 + r.spawned.length);
      c.isNpm = args[0] === '/abs/npm-cli.js';
      r.children.push(c);
      if (args[0] === '/abs/npm-cli.js') {
        setImmediate(() => { if (r.npmPlant) plantPackage(opts.cwd, { ...(r.npmIntegrity ? { integrity: r.npmIntegrity } : {}), ...(r.npmVersion ? { version: r.npmVersion } : {}) }); if (r.npmOut) c.stderr.emit('data', r.npmOut); c.end(r.npmExit); });
      }
      return c;
    },
  });
  return r;
}

// ---------- pure parts ----------
test('the pin is an exact version and a sha512 integrity', () => {
  assert.match(PINNED.version, /^\d{4}\.\d{3,4}\.\d+$/);
  assert.match(PINNED.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
});

test('runtimePaths: install in the office folder, data and key outside it, per port', () => {
  const a = runtimePaths({ root: 'R:\\office', env: { LOCALAPPDATA: 'L:\\Local' }, port: 4317 });
  assert.equal(a.install, path.join('R:\\office', '.paperclip-runtime'));
  assert.equal(a.data, path.join('L:\\Local', 'AgentOffice', 'paperclip'));
  assert.equal(a.key, path.join('L:\\Local', 'AgentOffice', 'paperclip-board-key.json'));
  assert.equal(a.config, path.join(a.data, 'instances', INSTANCE, 'config.json'));
  const b = runtimePaths({ root: 'R:\\office', env: { LOCALAPPDATA: 'L:\\Local' }, port: 4392 });
  assert.equal(b.data, path.join('L:\\Local', 'AgentOffice', 'paperclip-4392'));
  assert.equal(b.key, path.join('L:\\Local', 'AgentOffice', 'paperclip-board-key-4392.json'));
  assert.notEqual(b.pid, a.pid);
  const c = runtimePaths({ root: '/o', env: {}, port: 4317, home: '/home/u' });
  assert.equal(c.data, path.join('/home/u', '.agent-office', 'paperclip'));
});

test('buildConfig: authenticated, private, loopback, nothing outside the data folder, no telemetry', () => {
  const data = path.resolve('/d/paperclip');
  const c = buildConfig({ data, port: 3100, dbPort: 54339, now: () => new Date('2026-11-06T00:00:00Z') });
  assert.equal(c.server.deploymentMode, 'authenticated');
  assert.equal(c.server.exposure, 'private');
  assert.equal(c.server.bind, 'loopback');
  assert.equal(c.server.host, '127.0.0.1');
  assert.equal(c.server.port, 3100);
  assert.equal(c.database.embeddedPostgresPort, 54339);
  assert.equal(c.telemetry.enabled, false);
  assert.equal(c.secrets.strictMode, true);
  for (const p of [c.database.embeddedPostgresDataDir, c.database.backup.dir, c.logging.logDir, c.storage.localDisk.baseDir, c.secrets.localEncrypted.keyFilePath]) {
    assert.ok(p.startsWith(data), p + ' is under the data folder');
    assert.ok(!p.includes('~'), p);
  }
});

test('childEnv: the owner\'s Paperclip, database and address settings never reach it; the office sets its own', () => {
  const env = childEnv({
    PATH: '/bin', DATABASE_URL: 'postgres://owner@real/db', PAPERCLIP_HOME: '/home/u/.paperclip', PAPERCLIP_DEPLOYMENT_MODE: 'local_trusted', HOST: '0.0.0.0', PORT: '1',
    BETTER_AUTH_URL: 'x', OFFICE_FOUNDRY_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k', paperclip_bind: 'lan',
  }, { data: '/d', config: '/d/c.json', port: 3100 });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.OFFICE_FOUNDRY_TOKEN, undefined);
  assert.equal(env.BETTER_AUTH_URL, undefined);
  assert.equal(env.paperclip_bind, undefined);
  assert.equal(env.PAPERCLIP_HOME, '/d');
  assert.equal(env.PAPERCLIP_INSTANCE_ID, INSTANCE);
  assert.equal(env.PAPERCLIP_CONFIG, '/d/c.json');
  assert.equal(env.PAPERCLIP_DEPLOYMENT_MODE, 'authenticated');
  assert.equal(env.PAPERCLIP_BIND, 'loopback');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '3100');
  assert.equal(env.PAPERCLIP_NO_BROWSER, 'true');
});

test('npmCli finds npm\'s JS entry next to node (Windows) or under lib (Linux), or says what to set', () => {
  const win = path.join('C:\\node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.equal(npmCli({ env: {}, execPath: path.join('C:\\node', 'node.exe'), exists: (p) => p === win }), win);
  const lin = path.normalize(path.join('/opt/node/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.equal(npmCli({ env: {}, execPath: '/opt/node/bin/node', exists: (p) => path.normalize(p) === lin }), lin);
  assert.throws(() => npmCli({ env: {}, execPath: '/opt/node/bin/node', exists: () => false }), /OFFICE_NPM_CLI/);
  const abs = path.resolve('/x/npm-cli.js');
  assert.equal(npmCli({ env: { OFFICE_NPM_CLI: abs }, exists: (p) => p === abs }), abs);
  assert.throws(() => npmCli({ env: { OFFICE_NPM_CLI: 'npm-cli.js' }, exists: () => true }), /absolute path/);
});

test('installArgs names the exact pinned version and nothing like a range or a tag', () => {
  const a = installArgs('/c/npm-cli.js');
  assert.deepEqual(a.slice(0, 3), ['/c/npm-cli.js', 'install', `paperclipai@${PINNED.version}`]);
  assert.ok(a.includes('--save-exact'));
  assert.ok(a.includes('--ignore-scripts'), 'no package runs code at install time');
  assert.ok(!a.some((x) => /latest|canary|\^|~/.test(x)));
});

test('cleanRuntime keeps only enabled: true', () => {
  assert.deepEqual(cleanRuntime({ enabled: true, x: 1 }), { enabled: true });
  assert.equal(cleanRuntime({ enabled: false }), undefined);
  assert.equal(cleanRuntime('yes'), undefined);
  assert.equal(cleanRuntime(undefined), undefined);
});

// ---------- install ----------
test('install: runs npm\'s JS entry with node by absolute path, in the install folder, and checks the pin', async () => {
  const r = rig();
  try {
    assert.equal(r.runtime.status().state, 'off');
    assert.equal(r.runtime.status().installed, false);
    const s = await r.runtime.install();
    assert.equal(s.state, 'stopped');
    assert.equal(s.installed, true);
    assert.equal(r.spawned.length, 1);
    const { file, args, opts } = r.spawned[0];
    assert.match(file, /^\/abs\/node/);
    assert.equal(args[0], '/abs/npm-cli.js');
    assert.ok(args.includes(`paperclipai@${PINNED.version}`));
    assert.equal(opts.cwd, r.paths.install);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.paths.install, 'package.json'), 'utf8')).private, true);
    assert.ok(r.feeds.some(([, t]) => /installed paperclipai/.test(t)));
  } finally { r.f.done(); }
});

test('install again with the package in place runs nothing', async () => {
  const r = rig({ plant: true });
  try {
    const s = await r.runtime.install();
    assert.equal(s.state, 'stopped');
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
});

test('install fails closed when the tarball does not match the pinned integrity', async () => {
  const r = rig();
  r.npmIntegrity = 'sha512-' + 'A'.repeat(86) + '==';
  try {
    await assert.rejects(() => r.runtime.install(), /does not match the SHA-512/);
    assert.equal(r.runtime.status().state, 'failed');
    assert.equal(r.runtime.status().installed, false, 'files that do not match the pin do not count as installed');
    await assert.rejects(() => r.runtime.start(), /not installed/);
    assert.equal(r.spawned.filter((x) => x.args[0] !== '/abs/npm-cli.js').length, 0);
  } finally { r.f.done(); }
});

test('install fails with the end of npm\'s output when npm stops with an error code', async () => {
  const r = rig();
  r.npmPlant = false; r.npmExit = 1; r.npmOut = 'npm error code E404\nnpm error 404 Not Found - paperclipai\n';
  try {
    await assert.rejects(() => r.runtime.install(), /npm stopped with code 1.*E404/s);
    const s = r.runtime.status();
    assert.equal(s.state, 'failed');
    assert.match(s.reason, /The install failed/);
  } finally { r.f.done(); }
});

test('install never goes over a Paperclip that already answers on the port, nor a program that holds it', async () => {
  const r = rig();
  r.pc.up = true;
  try {
    await assert.rejects(() => r.runtime.install(), /already runs/);
    assert.equal(r.runtime.status().state, 'external');
    assert.equal(r.spawned.length, 0);
    r.pc.other = true;
    await assert.rejects(() => r.runtime.install(), /Something else uses port 3100/);
    assert.equal(r.runtime.status().state, 'busy');
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
});

test('install says what to set when npm cannot be found', async () => {
  const f = folder();
  try {
    const rt = createRuntime({ root: f.dir, port: 4392, env: { LOCALAPPDATA: path.join(f.dir, 'l') }, fetch: fakePaperclip().fetch, npmCli: () => { throw new Error('npm was not found. Set OFFICE_NPM_CLI.'); }, spawn: () => { throw new Error('no spawn'); } });
    await assert.rejects(() => rt.install(), /OFFICE_NPM_CLI/);
    assert.equal(rt.status().state, 'failed');
  } finally { f.done(); }
});

// ---------- start, health, stop ----------
test('start writes the login-mode config once, runs the CLI by absolute path from the data folder, and runs after health', async () => {
  const r = rig({ plant: true });
  try {
    let s = await r.runtime.start();
    assert.equal(s.state, 'starting');
    const { file, args, opts } = r.spawned[0];
    assert.match(file, /^\/abs\/node/);
    assert.equal(args[0], path.join(r.paths.install, 'node_modules', 'paperclipai', 'dist', 'index.js'));
    assert.deepEqual(args.slice(1), ['run', '-c', r.paths.config, '-i', INSTANCE]);
    assert.equal(opts.cwd, r.paths.data, 'not the office folder: a process keeps its folder busy on Windows');
    assert.equal(opts.env.PAPERCLIP_HOME, r.paths.data);
    assert.equal(opts.env.PAPERCLIP_DEPLOYMENT_MODE, 'authenticated');
    const cfg = JSON.parse(fs.readFileSync(r.paths.config, 'utf8'));
    assert.equal(cfg.server.deploymentMode, 'authenticated');
    assert.equal(cfg.server.host, '127.0.0.1');
    const rec = JSON.parse(fs.readFileSync(r.paths.pid, 'utf8'));
    assert.equal(rec.pid, r.children[0].pid);
    // not up yet: still starting
    await r.clk.advance(2000);
    assert.equal(r.runtime.status().state, 'starting');
    r.pc.up = true;
    await r.clk.advance(2000);
    s = r.runtime.status();
    assert.equal(s.state, 'running');
    assert.equal(s.bootstrap, 'pending');
    assert.ok(r.feeds.some(([, t]) => /Paperclip is running/.test(t)));
  } finally { r.f.done(); }
});

test('withSecrets adds what is missing and keeps what is there', () => {
  const rnd = (n) => Buffer.alloc(n, 0xab);
  const fresh = withSecrets('', rnd);
  assert.match(fresh, /^# Paperclip environment variables/);
  assert.match(fresh, /^PAPERCLIP_AGENT_JWT_SECRET=(?:ab){32}$/m);
  assert.match(fresh, /^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=(?:ab){32}$/m);
  assert.equal(withSecrets(fresh, rnd), null, 'nothing missing');
  const kept = withSecrets(['FOO=bar', 'PAPERCLIP_AGENT_JWT_SECRET=mine', ''].join('\n'), rnd);
  assert.match(kept, /^FOO=bar$/m);
  assert.match(kept, /^PAPERCLIP_AGENT_JWT_SECRET=mine$/m);
  assert.equal((kept.match(/PAPERCLIP_AGENT_JWT_SECRET/g) || []).length, 1);
  assert.match(kept, /^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=(?:ab){32}$/m);
});

test('start makes the first-run secrets owner-only before Paperclip starts, and never overwrites them', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    const dir = path.dirname(r.paths.config);
    assert.deepEqual(r.secrets, [path.join(dir, '.env'), path.join(dir, 'secrets', 'master.key')], 'through writeSecret');
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, /^PAPERCLIP_AGENT_JWT_SECRET=[0-9a-f]{64}$/m);
    assert.match(env, /^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=[0-9a-f]{64}$/m);
    assert.equal(Buffer.from(fs.readFileSync(path.join(dir, 'secrets', 'master.key'), 'utf8'), 'base64').length, 32);
    await r.runtime.stop();
    r.secrets.length = 0;
    const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    await r.runtime.start();
    assert.deepEqual(r.secrets, [], 'the second start writes nothing');
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  } finally { r.f.done(); }
});

test('start keeps an existing config and does not overwrite it', async () => {
  const r = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(r.paths.config), { recursive: true });
    fs.writeFileSync(r.paths.config, '{"mine":true}');
    await r.runtime.start();
    assert.equal(fs.readFileSync(r.paths.config, 'utf8'), '{"mine":true}');
  } finally { r.f.done(); }
});

test('start before install says so, and a second start while it runs starts nothing', async () => {
  const r = rig();
  try {
    await assert.rejects(() => r.runtime.start(), /not installed/);
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
  const q = rig({ plant: true });
  try {
    await q.runtime.start();
    await q.runtime.start();
    assert.equal(q.spawned.length, 1);
  } finally { q.f.done(); }
});

test('start refuses a Paperclip that is already there: the user\'s own is external, a stranger is busy', async () => {
  const r = rig({ plant: true });
  try {
    r.pc.up = true;
    await assert.rejects(() => r.runtime.start(), /already runs/);
    assert.equal(r.runtime.status().state, 'external');
    assert.match(r.runtime.status().reason, /did not start/);
    assert.equal(r.spawned.length, 0);
    r.pc.other = true;
    await assert.rejects(() => r.runtime.start(), /Something else uses port/);
    assert.equal(r.runtime.status().state, 'busy');
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
});

test('a Paperclip that answers in another mode than login is stopped and called failed', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.pc.up = true; r.pc.mode = 'local_trusted';
    await r.clk.advance(2000);
    const s = r.runtime.status();
    assert.equal(s.state, 'failed');
    assert.match(s.reason, /local_trusted mode, not login mode/);
    assert.deepEqual(r.killed, [r.children[0].pid]);
  } finally { r.f.done(); }
});

test('a start that never answers fails after the wait with the end of its output, and kills the process', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.children[0].stderr.emit('data', 'doctor: port 54339 is busy\n');
    await r.clk.advance(181000);
    const s = r.runtime.status();
    assert.equal(s.state, 'failed');
    assert.match(s.reason, /did not answer in 180 seconds.*port 54339 is busy/s);
    assert.deepEqual(r.killed, [r.children[0].pid]);
    assert.equal(fs.existsSync(r.paths.pid), false);
  } finally { r.f.done(); }
});

test('a process that exits by itself is failed with its last lines, and a bootstrap token in them is hidden', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.children[0].stdout.emit('data', `Invite URL: ${URL_}/invite/${BOOT}\nError: EADDRINUSE\n`);
    r.children[0].end(1);
    const s = r.runtime.status();
    assert.equal(s.state, 'failed');
    assert.match(s.reason, /code 1.*EADDRINUSE/s);
    assert.ok(!s.reason.includes(BOOT), 'the one-time token is not in a reason');
    assert.ok(!JSON.stringify(r.feeds).includes(BOOT));
    assert.equal(fs.existsSync(r.paths.pid), false);
  } finally { r.f.done(); }
});

test('while no admin exists the first-account link of Paperclip is shown, and it goes once the instance is claimed', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.children[0].stdout.emit('data', `\x1b[36mInvite URL: ${URL_}/invite/${BOOT}\x1b[39m\n`);
    r.pc.up = true;
    await r.clk.advance(2000);
    let s = r.runtime.status();
    assert.equal(s.inviteUrl, `${URL_}/invite/${BOOT}`);
    assert.match(s.steps[0], /first-account link/);
    r.pc.bootstrapStatus = 'ready';
    await r.clk.advance(15000);
    s = r.runtime.status();
    assert.equal(s.bootstrap, 'ready');
    assert.equal(s.inviteUrl, '');
    assert.match(s.steps[0], /Connect the board key/);
  } finally { r.f.done(); }
});

test('without a link in the output the step says to claim the instance in Paperclip', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.pc.up = true;
    await r.clk.advance(2000);
    const s = r.runtime.status();
    assert.equal(s.inviteUrl, '');
    assert.match(s.steps[0], /Claim this instance/);
  } finally { r.f.done(); }
});

test('three missed answers in a row end a running Paperclip as failed; one miss does not', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.pc.up = true;
    await r.clk.advance(2000);
    assert.equal(r.runtime.status().state, 'running');
    r.pc.up = false;
    await r.clk.advance(15000);
    assert.equal(r.runtime.status().state, 'running');
    r.pc.up = true;
    await r.clk.advance(15000);
    r.pc.up = false;
    await r.clk.advance(15000); await r.clk.advance(15000);
    assert.equal(r.runtime.status().state, 'running', 'two misses after a good answer');
    await r.clk.advance(15000);
    assert.equal(r.runtime.status().state, 'failed');
    assert.match(r.runtime.status().reason, /stopped answering/);
  } finally { r.f.done(); }
});

test('stop ends the process tree by pid and leaves the owner\'s processes alone', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.pc.up = true;
    await r.clk.advance(2000);
    const pid = r.children[0].pid;
    const s = await r.runtime.stop();
    assert.equal(s.state, 'stopped');
    assert.deepEqual(r.killed, [pid]);
    assert.equal(fs.existsSync(r.paths.pid), false);
    assert.equal(r.clk.pending(), 0, 'no timer is left to poll a stopped Paperclip');
    // nothing to stop: no kill
    await r.runtime.stop();
    assert.deepEqual(r.killed, [pid]);
  } finally { r.f.done(); }
});

test('stop of a Paperclip that is not this office\'s kills nothing', async () => {
  const r = rig({ plant: true });
  try {
    r.pc.up = true;
    await assert.rejects(() => r.runtime.start());
    await r.runtime.stop();
    assert.deepEqual(r.killed, []);
    assert.deepEqual(r.killedSync, []);
  } finally { r.f.done(); }
});

test('killNow (the office exit) ends the tree synchronously by pid', async () => {
  const r = rig({ plant: true });
  try {
    await r.runtime.start();
    r.runtime.killNow();
    assert.deepEqual(r.killedSync, [r.children[0].pid]);
    r.runtime.killNow();
    assert.equal(r.killedSync.length, 1, 'once');
  } finally { r.f.done(); }
});

test('a Paperclip that an office left running is taken over by pid and start time, not by port alone', async () => {
  const r = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(r.paths.pid), { recursive: true });
    fs.writeFileSync(r.paths.pid, JSON.stringify({ pid: 777, startedAt: 'start-777', port: 3100 }));
    r.pc.up = true; r.pc.bootstrapStatus = 'ready';
    const s = await r.runtime.start();
    assert.equal(s.state, 'running');
    assert.equal(r.spawned.length, 0);
    await r.runtime.stop();
    assert.deepEqual(r.killed, [777]);
  } finally { r.f.done(); }
  // the pid names another process now (start time differs): it is not adopted, and the Paperclip on the port is external
  const q = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(q.paths.pid), { recursive: true });
    fs.writeFileSync(q.paths.pid, JSON.stringify({ pid: 777, startedAt: 'an-older-start', port: 3100 }));
    q.pc.up = true;
    await assert.rejects(() => q.runtime.start(), /already runs/);
    assert.deepEqual(q.killed, []);
    assert.equal(fs.existsSync(q.paths.pid), false, 'the stale record is dropped');
  } finally { q.f.done(); }
});

test('a taken-over Paperclip in another mode is stopped', async () => {
  const r = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(r.paths.pid), { recursive: true });
    fs.writeFileSync(r.paths.pid, JSON.stringify({ pid: 777, startedAt: 'start-777', port: 3100 }));
    r.pc.up = true; r.pc.mode = 'local_trusted';
    await assert.rejects(() => r.runtime.start(), /not in login mode/);
    assert.deepEqual(r.killed, [777]);
  } finally { r.f.done(); }
});

test('resume starts it only when the user asked for it and it is installed', async () => {
  const a = rig({ plant: true });
  try {
    assert.equal((await a.runtime.resume(false)).state, 'stopped');
    assert.equal(a.spawned.length, 0);
    assert.equal((await a.runtime.resume(true)).state, 'starting');
    assert.equal(a.spawned.length, 1);
  } finally { a.f.done(); }
  const b = rig();
  try {
    assert.equal((await b.runtime.resume(true)).state, 'off');
    assert.equal(b.spawned.length, 0);
  } finally { b.f.done(); }
});

// ---------- the board key ----------
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((res) => setImmediate(res)); };
async function running(r, { admin = true } = {}) {
  await r.runtime.start();
  r.pc.up = true;
  r.pc.bootstrapStatus = admin ? 'ready' : 'bootstrap_pending';
  await r.clk.advance(2000);
  await settle();
  assert.equal(r.runtime.status().state, 'running');
  r.secrets.length = 0; // the first-run secrets of the start are not what these tests count
}

test('connectKey: needs a running Paperclip with an admin', async () => {
  const r = rig({ plant: true });
  try {
    await assert.rejects(() => r.runtime.connectKey(), /not running/);
    await running(r, { admin: false });
    await assert.rejects(() => r.runtime.connectKey(), /no admin yet/);
    assert.ok(!r.pc.requests.some((q) => q.route.startsWith('/api/cli-auth/challenges')));
  } finally { r.f.done(); }
});

test('connectKey: shows an approval link built on Paperclip\'s own address, and never the pending key', async () => {
  const r = rig({ plant: true });
  try {
    await running(r);
    const s = await r.runtime.connectKey();
    assert.equal(s.key.state, 'waiting');
    assert.equal(s.key.approvalUrl, `${URL_}/cli-auth/${GUID}?token=${'c'.repeat(40)}`);
    const post = r.pc.requests.find((q) => q.method === 'POST' && q.route === '/api/cli-auth/challenges');
    assert.equal(JSON.parse(post.body).requestedAccess, 'board');
    assert.ok(!JSON.stringify(r.runtime.status()).includes('pcp_board_'), 'the pending key is not in the status');
    assert.ok(!JSON.stringify(r.feeds).includes('pcp_board_'));
    assert.equal(r.secrets.length, 0, 'nothing is written before the approval');
  } finally { r.f.done(); }
});

test("connectKey: an approval link that is not on Paperclip's own address is refused", async () => {
  const r = rig({ plant: true });
  try {
    await running(r);
    const real = r.pc.fetch;
    r.pc.fetch = async (u, init) => {
      const res = await real(u, init);
      if (new URL(u).pathname !== '/api/cli-auth/challenges') return res;
      const j = await res.json();
      return { status: 201, json: async () => ({ ...j, approvalPath: 'http://evil.test/cli-auth/' + GUID }) };
    };
    await assert.rejects(() => r.runtime.connectKey(), /not on its own address/);
    assert.equal(r.runtime.status().key.state, 'none');
  } finally { r.f.done(); }
});

test('the key is written to an owner-only file after approval and a check of the key; the status then says ready', async () => {
  const r = rig({ plant: true });
  try {
    await running(r);
    await r.runtime.connectKey();
    await r.clk.advance(1500);
    assert.equal(r.runtime.status().key.state, 'waiting', 'still pending');
    r.pc.challenge = { status: 'approved' }; r.pc.keyValid = true;
    await r.clk.advance(1500);
    const s = r.runtime.status();
    assert.equal(s.key.state, 'ready');
    assert.equal(s.key.approvalUrl, '');
    assert.equal(s.key.expiresAt, '2026-12-06T00:00:00.000Z');
    assert.deepEqual(r.secrets, [r.paths.key], 'through writeSecret, to the key file outside the office folder');
    assert.ok(!r.paths.key.startsWith(r.root));
    const rec = JSON.parse(fs.readFileSync(r.paths.key, 'utf8'));
    assert.equal(rec.apiBase, URL_);
    assert.match(rec.token, /^pcp_board_/);
    assert.equal(rec.userId, 'u1');
    assert.ok(!JSON.stringify(s).includes(rec.token), 'no route answer carries the key');
    assert.equal(r.runtime.key(), rec.token, 'the HQ asks the runtime for it');
    assert.equal(r.clk.pending() > 0, true, 'only the health timer is left');
  } finally { r.f.done(); }
});

test('an approved link whose key does not work is refused, and nothing is written', async () => {
  const r = rig({ plant: true });
  try {
    await running(r);
    await r.runtime.connectKey();
    r.pc.challenge = { status: 'approved' }; r.pc.keyValid = false;
    await r.clk.advance(1500);
    assert.equal(r.runtime.status().key.state, 'refused');
    assert.equal(r.secrets.length, 0);
    assert.equal(r.runtime.key(), null);
  } finally { r.f.done(); }
});

test('a cancelled or expired challenge is refused with the reason, and can be started again', async () => {
  const r = rig({ plant: true });
  try {
    await running(r);
    await r.runtime.connectKey();
    r.pc.challenge = { status: 'cancelled' };
    await r.clk.advance(1500);
    assert.equal(r.runtime.status().key.state, 'refused');
    assert.match(r.runtime.status().key.reason, /cancelled/);
    r.pc.challenge = { status: 'pending' };
    const s = await r.runtime.connectKey();
    assert.equal(s.key.state, 'waiting');
    r.pc.challenge = { status: 'expired' };
    await r.clk.advance(1500);
    assert.match(r.runtime.status().key.reason, /expired/);
  } finally { r.f.done(); }
});

test('an existing key file is checked at start: ready with its expiry, expired when Paperclip refuses it', async () => {
  const r = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(r.paths.key), { recursive: true });
    fs.writeFileSync(r.paths.key, JSON.stringify({ token: 'pcp_board_' + 'd'.repeat(40), apiBase: URL_, userId: 'u1', expiresAt: null }));
    r.pc.keyValid = true;
    await running(r);
    await settle();
    assert.equal(r.runtime.status().key.state, 'ready');
    assert.equal(r.runtime.status().key.expiresAt, '2026-12-06T00:00:00.000Z');
  } finally { r.f.done(); }
  const q = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(q.paths.key), { recursive: true });
    fs.writeFileSync(q.paths.key, JSON.stringify({ token: 'pcp_board_' + 'd'.repeat(40), apiBase: URL_, userId: 'u1' }));
    q.pc.keyValid = false;
    await running(q);
    await settle();
    assert.equal(q.runtime.status().key.state, 'expired');
    assert.equal(q.runtime.key(), null, 'a key that Paperclip refuses is not handed out');
    assert.match(q.runtime.status().steps[0], /new board key/);
  } finally { q.f.done(); }
});

test('a key file for another address is not used', async () => {
  const r = rig({ plant: true });
  try {
    fs.mkdirSync(path.dirname(r.paths.key), { recursive: true });
    fs.writeFileSync(r.paths.key, JSON.stringify({ token: 'pcp_board_' + 'd'.repeat(40), apiBase: 'http://127.0.0.1:3199', userId: 'u1' }));
    r.pc.keyValid = true;
    await running(r);
    await settle();
    assert.equal(r.runtime.status().key.state, 'none');
    assert.equal(r.runtime.key(), null);
    assert.ok(!r.pc.requests.some((q) => (q.headers.authorization || '').includes('pcp_board_')), 'the key was not sent anywhere');
  } finally { r.f.done(); }
});

test('stop ends a waiting approval too', async () => {
  const r = rig({ plant: true });
  try {
    await running(r);
    await r.runtime.connectKey();
    await r.runtime.stop();
    assert.equal(r.runtime.status().key.state, 'none');
    assert.equal(r.clk.pending(), 0);
  } finally { r.f.done(); }
});

test('install in the background answers once it has started: installing now, stopped when npm is done, failed with the reason when it fails', async () => {
  const r = rig();
  try {
    const s = await r.runtime.install({ background: true });
    assert.equal(s.state, 'installing');
    assert.equal(r.runtime.status().installed, false);
    await assert.rejects(() => r.runtime.install({ background: true }), /being installed already/);
    await settle();
    assert.equal(r.runtime.status().state, 'stopped');
    assert.equal(r.runtime.status().installed, true);
  } finally { r.f.done(); }
  const q = rig();
  q.npmPlant = false; q.npmExit = 1; q.npmOut = 'npm error code ENOTFOUND\n';
  try {
    const s = await q.runtime.install({ background: true });
    assert.equal(s.state, 'installing');
    await settle();
    assert.equal(q.runtime.status().state, 'failed');
    assert.match(q.runtime.status().reason, /The install failed.*ENOTFOUND/s);
    assert.ok(q.feeds.some(([k, t]) => k === 'error' && /install failed/.test(t)));
  } finally { q.f.done(); }
});

test('a refusal that comes before the download (a Paperclip already there) still answers the call, also in the background', async () => {
  const r = rig();
  r.pc.up = true;
  try {
    await assert.rejects(() => r.runtime.install({ background: true }), /already runs/);
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
});

test('a port that accepts a connection and never answers counts as held, not as free', async () => {
  const r = rig({ plant: true });
  try {
    r.pc.fetch = async () => { const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError'); throw e; };
    await assert.rejects(() => r.runtime.start(), /Something else uses port/);
    assert.equal(r.runtime.status().state, 'busy');
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
});

// ---------- update (#195) ----------
const OLD = { version: '2026.1001.0', integrity: 'sha512-' + 'B'.repeat(86) + '==' };
const oldInstall = { ...OLD, marker: true };
const lastNpm = (r) => r.spawned.filter((x) => x.args[0] === '/abs/npm-cli.js').at(-1);
const runs = (r) => r.spawned.filter((x) => x.args[0] !== '/abs/npm-cli.js');
const verOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', 'paperclipai', 'package.json'), 'utf8')).version;

test('an older verified install is installed but not current: it starts, install refuses, update is offered', async () => {
  const r = rig({ plant: oldInstall });
  try {
    const s = r.runtime.status();
    assert.equal(s.installed, true);
    assert.equal(s.installedVersion, OLD.version);
    assert.equal(s.updateAvailable, true);
    assert.equal(s.state, 'stopped');
    await assert.rejects(() => r.runtime.install(), /Update/);
    assert.equal(r.spawned.length, 0);
    await r.runtime.start();
    assert.equal(runs(r).length, 1, 'the old release runs');
  } finally { r.f.done(); }
});

test('an older install with no marker is not trusted and shows no update', async () => {
  const r = rig({ plant: { ...OLD } });
  try {
    assert.equal(r.runtime.status().installed, false);
    assert.equal(r.runtime.status().updateAvailable, false);
    await assert.rejects(() => r.runtime.update(), /not installed|Install/);
  } finally { r.f.done(); }
});

test('a verified current install writes the marker and offers no update', async () => {
  const r = rig({ plant: true });
  try {
    const s = r.runtime.status();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.installedVersion, PINNED.version);
    assert.ok(fs.existsSync(path.join(r.paths.install, VERIFIED)));
    await assert.rejects(() => r.runtime.update(), /already/);
  } finally { r.f.done(); }
});

test('update of a stopped Paperclip installs the pin in a staging folder, checks it, swaps it in and starts nothing', async () => {
  const r = rig({ plant: oldInstall });
  try {
    const s = await r.runtime.update();
    const npm = lastNpm(r);
    assert.equal(npm.opts.cwd, r.paths.next, 'the running release is not touched while npm works');
    assert.ok(npm.args.includes(`paperclipai@${PINNED.version}`));
    assert.equal(verOf(r.paths.install), PINNED.version);
    assert.ok(!fs.existsSync(r.paths.next) && !fs.existsSync(r.paths.prev), 'no staging or backup folder is left');
    assert.equal(s.state, 'stopped');
    assert.equal(s.updateAvailable, false);
    assert.equal(s.installedVersion, PINNED.version);
    assert.equal(runs(r).length, 0);
    assert.ok(r.feeds.some(([, t]) => /updated paperclipai/.test(t)));
  } finally { r.f.done(); }
});

test('update of a running Paperclip downloads while the old one runs, then stops it, swaps and starts the new one', async () => {
  const r = rig({ plant: oldInstall });
  try {
    await r.runtime.start(); r.pc.up = true; await r.clk.advance(2000);
    assert.equal(r.runtime.status().state, 'running');
    const first = await r.runtime.update({ background: true });
    assert.equal(first.state, 'updating');
    assert.equal(r.killed.length, 0, 'the old one still runs during the download');
    await settle();
    assert.equal(r.killed.length, 1, 'then it is stopped');
    r.pc.up = true;
    await settle(); await r.clk.advance(2000); await settle();
    const s = r.runtime.status();
    assert.equal(s.state, 'running');
    assert.equal(s.installedVersion, PINNED.version);
    assert.equal(runs(r).length, 2);
    assert.equal(runs(r)[1].args[0], path.join(r.paths.install, 'node_modules', 'paperclipai', 'dist', 'index.js'));
    assert.ok(!fs.existsSync(r.paths.prev));
  } finally { r.f.done(); }
});

test('a failed download keeps the old version running and says why', async () => {
  const r = rig({ plant: oldInstall });
  r.npmPlant = false; r.npmExit = 1; r.npmOut = 'npm error code ENOTFOUND\n';
  try {
    await r.runtime.start(); r.pc.up = true; await r.clk.advance(2000);
    await assert.rejects(() => r.runtime.update(), /npm stopped with code 1.*ENOTFOUND/s);
    const s = r.runtime.status();
    assert.equal(s.state, 'running', 'the old Paperclip was never stopped');
    assert.equal(r.killed.length, 0);
    assert.equal(s.installedVersion, OLD.version);
    assert.equal(s.updateAvailable, true);
    assert.match(s.update.error, /ENOTFOUND/);
    assert.ok(!fs.existsSync(r.paths.next));
    assert.ok(r.feeds.some(([k, t]) => k === 'error' && /update failed/.test(t)));
  } finally { r.f.done(); }
});

test('a download that does not match the pinned SHA-512 is dropped and the old version stays', async () => {
  const r = rig({ plant: oldInstall });
  r.npmIntegrity = 'sha512-' + 'A'.repeat(86) + '==';
  try {
    await assert.rejects(() => r.runtime.update(), /does not match the SHA-512/);
    assert.equal(verOf(r.paths.install), OLD.version);
    assert.ok(!fs.existsSync(r.paths.next));
    assert.equal(r.runtime.status().state, 'stopped');
  } finally { r.f.done(); }
});

test('a new release that does not start is rolled back: the old folder comes back and runs again', async () => {
  const r = rig({ plant: oldInstall });
  try {
    await r.runtime.start(); r.pc.up = true; await r.clk.advance(2000);
    const first = await r.runtime.update({ background: true });
    assert.equal(first.state, 'updating');
    await settle();
    // the new release starts but never answers: the start wait ends it
    await settle(); await r.clk.advance(200000); await settle();
    r.pc.up = true;
    await settle(); await r.clk.advance(2000); await settle();
    const s = r.runtime.status();
    assert.equal(verOf(r.paths.install), OLD.version, 'the old release is back');
    assert.equal(s.state, 'running');
    assert.equal(s.installedVersion, OLD.version);
    assert.equal(s.updateAvailable, true);
    assert.match(s.update.error, /rolled back/i);
    assert.ok(!fs.existsSync(r.paths.prev) && !fs.existsSync(r.paths.next));
    assert.ok(r.feeds.some(([k, t]) => k === 'error' && /update failed/.test(t)));
  } finally { r.f.done(); }
});

test('update refuses while a Paperclip of the user answers on the port, and while an update runs', async () => {
  const r = rig({ plant: oldInstall });
  try {
    r.pc.up = true;
    await assert.rejects(() => r.runtime.update(), /already runs/i);
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
  const q = rig({ plant: oldInstall });
  try {
    await q.runtime.update({ background: true });
    await assert.rejects(() => q.runtime.update({ background: true }), /being updated/);
    await assert.rejects(() => q.runtime.start(), /being updated/);
    await settle();
  } finally { q.f.done(); }
});

// ---------- connect mode (#194): the user's own Paperclip, by address and board key ----------
const MINE = 'http://127.0.0.1:3555';
const GOOD = 'pcp_board_' + 'f'.repeat(40);
async function connected(r, over = {}) {
  r.pc.up = true; r.pc.bootstrapStatus = 'ready'; r.pc.keyValid = true;
  return r.runtime.connectExisting({ url: MINE, key: GOOD, ...over });
}

test('cleanRuntime keeps a connect address that is on 127.0.0.1, and nothing else', () => {
  assert.deepEqual(cleanRuntime({ connect: MINE }), { connect: MINE });
  assert.deepEqual(cleanRuntime({ connect: MINE, enabled: true }), { connect: MINE });
  assert.equal(cleanRuntime({ connect: 'http://example.com:3100' }), undefined);
  assert.equal(cleanRuntime({ connect: 5 }), undefined);
});

test('connect: skips the install, checks the key against Paperclip, keeps it owner-only and says connected', async () => {
  const r = rig();   // nothing installed
  try {
    const s = await connected(r);
    assert.equal(s.state, 'connected');
    assert.equal(s.url, MINE);
    assert.equal(s.port, 3555);
    assert.equal(s.installed, false, 'the office installed nothing');
    assert.equal(s.key.state, 'ready');
    assert.equal(s.key.expiresAt, '2026-12-06T00:00:00.000Z');
    assert.equal(r.spawned.length, 0, 'no npm and no Paperclip process');
    assert.deepEqual(r.secrets, [r.paths.key], 'through writeSecret');
    const rec = JSON.parse(fs.readFileSync(r.paths.key, 'utf8'));
    assert.equal(rec.apiBase, MINE);
    assert.equal(rec.token, GOOD);
    assert.ok(!JSON.stringify(s).includes(GOOD), 'the status never carries the key');
    assert.equal(r.runtime.keyFor(MINE), GOOD, 'the HQ can ask for it, for this address only');
    assert.equal(r.runtime.keyFor('http://127.0.0.1:3100'), null);
    assert.ok(r.pc.requests.every((q) => q.route !== '/api/cli-auth/challenges'), 'no approval was started on the user\'s Paperclip');
    assert.ok(r.feeds.some(([, t]) => /connected to your Paperclip/i.test(t)));
  } finally { r.f.done(); }
});

test('connect: a wrong address says why, before or after a request, and keeps nothing', async () => {
  const r = rig();
  try {
    for (const [url, re] of [['http://example.com:3100', /127\.0\.0\.1/], ['https://127.0.0.1:3100', /http/], ['', /address/i]]) {
      await assert.rejects(r.runtime.connectExisting({ url, key: GOOD }), (e) => e.status === 400 && re.test(e.message), url);
    }
    assert.equal(r.pc.requests.length, 0, 'no request left the office');
    await assert.rejects(r.runtime.connectExisting({ url: MINE, key: GOOD }), (e) => e.status === 502 && /No Paperclip answers at http:\/\/127\.0\.0\.1:3555/.test(e.message));
    r.pc.up = true; r.pc.other = true;
    await assert.rejects(r.runtime.connectExisting({ url: MINE, key: GOOD }), (e) => e.status === 502 && /not Paperclip/i.test(e.message));
    assert.equal(r.secrets.length, 0);
    assert.equal(fs.existsSync(r.paths.key), false);
    assert.notEqual(r.runtime.status().state, 'connected');
  } finally { r.f.done(); }
});

test('connect: a key that Paperclip refuses, an empty key in login mode, and a key of the wrong shape say why and write nothing', async () => {
  const r = rig();
  try {
    r.pc.up = true; r.pc.bootstrapStatus = 'ready'; r.pc.keyValid = false;
    await assert.rejects(r.runtime.connectExisting({ url: MINE, key: GOOD }), (e) => e.status === 400 && /does not accept this board key/i.test(e.message) && !e.message.includes(GOOD));
    await assert.rejects(r.runtime.connectExisting({ url: MINE, key: 'nope' }), (e) => e.status === 400 && /board key/i.test(e.message) && !e.message.includes('nope'));
    await assert.rejects(r.runtime.connectExisting({ url: MINE, key: '' }), (e) => e.status === 400 && /login mode.*board key/i.test(e.message));
    assert.equal(r.secrets.length, 0);
    assert.equal(fs.existsSync(r.paths.key), false);
    assert.notEqual(r.runtime.status().state, 'connected');
  } finally { r.f.done(); }
});

test('connect: a Paperclip in local trusted mode needs no key, and the office keeps none', async () => {
  const r = rig();
  try {
    r.pc.up = true; r.pc.mode = 'local_trusted'; r.pc.bootstrapStatus = 'ready';
    const s = await r.runtime.connectExisting({ url: MINE, key: '' });
    assert.equal(s.state, 'connected');
    assert.equal(s.key.state, 'none');
    assert.equal(r.runtime.keyFor(MINE), null);
    assert.equal(r.secrets.length, 0);
  } finally { r.f.done(); }
});

test('connect: install and start refuse while connected; connect refuses while the office\'s own Paperclip runs', async () => {
  const r = rig({ plant: true });
  try {
    await connected(r);
    await assert.rejects(r.runtime.install(), (e) => e.status === 409 && /connected to your Paperclip/i.test(e.message));
    await assert.rejects(r.runtime.start(), (e) => e.status === 409 && /Disconnect/i.test(e.message));
    assert.equal(r.spawned.length, 0);
  } finally { r.f.done(); }
  const own = rig({ plant: true });
  try {
    await running(own);
    own.pc.keyValid = true;
    await assert.rejects(own.runtime.connectExisting({ url: MINE, key: GOOD }), (e) => e.status === 409 && /Stop Paperclip/i.test(e.message));
  } finally { own.f.done(); }
});

test('connect: install, start and update all refuse while connected; no update is offered and nothing is run or changed (#194 with #195)', async () => {
  const r = rig({ plant: oldInstall });   // an older verified release is on disk
  try {
    assert.equal(r.runtime.status().updateAvailable, true, 'own mode offers the update');
    const s = await connected(r);
    assert.equal(s.state, 'connected');
    assert.equal(s.updateAvailable, false, 'a connected Paperclip is never offered an update');
    await assert.rejects(() => r.runtime.install(), (e) => e.status === 409 && /connected to your Paperclip/i.test(e.message));
    await assert.rejects(() => r.runtime.start(), (e) => e.status === 409 && /Disconnect/i.test(e.message));
    await assert.rejects(() => r.runtime.update(), (e) => e.status === 409 && /connected to your Paperclip/i.test(e.message));
    await assert.rejects(() => r.runtime.update({ background: true }), (e) => e.status === 409);
    assert.equal(r.spawned.length, 0, 'no npm and no Paperclip process');
    assert.equal(verOf(r.paths.install), OLD.version, 'the installed release is untouched');
    assert.equal(fs.existsSync(r.paths.next), false, 'no staging folder');
    assert.equal(fs.existsSync(r.paths.prev), false, 'no backup folder');
  } finally { r.f.done(); }
});

test('disconnect forgets the key file and the address, writes nothing to the user\'s Paperclip, and the office can install again', async () => {
  const r = rig({ plant: true });
  try {
    await connected(r);
    r.pc.requests.length = 0;
    const s = await r.runtime.disconnect();
    assert.equal(s.state, 'stopped');
    assert.equal(s.url, 'http://127.0.0.1:3100', 'back to the office\'s own address');
    assert.equal(fs.existsSync(r.paths.key), false);
    assert.equal(r.runtime.keyFor(MINE), null);
    assert.equal(r.pc.requests.filter((q) => q.method !== 'GET').length, 0);
    assert.equal(r.killed.length, 0, 'the user\'s Paperclip has no pid here');
  } finally { r.f.done(); }
});

test('connect with no key reuses the saved key of the same address, and not one of another address', async () => {
  const r = rig();
  try {
    r.pc.up = true; r.pc.bootstrapStatus = 'ready'; r.pc.keyValid = true;
    fs.mkdirSync(path.dirname(r.paths.key), { recursive: true });
    fs.writeFileSync(r.paths.key, JSON.stringify({ token: GOOD, apiBase: MINE, userId: 'u1', keyId: 'k1', expiresAt: null }));
    assert.equal((await r.runtime.connectExisting({ url: MINE, key: '' })).state, 'connected');
    await r.runtime.disconnect();
    fs.mkdirSync(path.dirname(r.paths.key), { recursive: true });
    fs.writeFileSync(r.paths.key, JSON.stringify({ token: GOOD, apiBase: 'http://127.0.0.1:3777', userId: 'u1', keyId: 'k1', expiresAt: null }));
    await assert.rejects(r.runtime.connectExisting({ url: MINE, key: '' }), (e) => e.status === 400);
  } finally { r.f.done(); }
});

test('resume with a saved connect address connects again; a Paperclip that is gone is failed with the reason and can retry', async () => {
  const a = rig();
  try {
    fs.mkdirSync(path.dirname(a.paths.key), { recursive: true });
    fs.writeFileSync(a.paths.key, JSON.stringify({ token: GOOD, apiBase: MINE, userId: 'u1', keyId: 'k1', expiresAt: null }));
    a.pc.up = false;
    const s = await a.runtime.resume(false, MINE);
    assert.equal(s.state, 'failed');
    assert.match(s.reason, /No Paperclip answers at http:\/\/127\.0\.0\.1:3555/);
    assert.equal(a.spawned.length, 0);
    a.pc.up = true; a.pc.bootstrapStatus = 'ready'; a.pc.keyValid = true;
    assert.equal((await a.runtime.connectExisting({ url: MINE, key: '' })).state, 'connected', 'retry with the saved key');
  } finally { a.f.done(); }
  const b = rig();
  try {
    fs.mkdirSync(path.dirname(b.paths.key), { recursive: true });
    fs.writeFileSync(b.paths.key, JSON.stringify({ token: GOOD, apiBase: MINE, userId: 'u1', keyId: 'k1', expiresAt: null }));
    b.pc.up = true; b.pc.bootstrapStatus = 'ready'; b.pc.keyValid = true;
    assert.equal((await b.runtime.resume(false, MINE)).state, 'connected');
  } finally { b.f.done(); }
});
