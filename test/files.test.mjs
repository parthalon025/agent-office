// A second office in the same folder (#100). A test office (npm run start:branch, or OFFICE_PORT=<n>) next to the
// owner's office must never rewrite the owner's .office-token, hook settings, MCP settings, state or past sessions.
// The hooks and the MCP server of each office's settings reach that office, also after the other office stops.
// The offices run from a copy of the code in a temp folder on free ports, with their own LOCALAPPDATA (as
// test/auth.test.mjs does). No claude on PATH, no browser, no paid call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from '../auth.mjs';
import * as startup from '../startup.mjs';
import { officeFiles, portArg, portArgs, DEFAULT_PORT } from '../files.mjs';
import { startOffice, startOnFreePort } from './fixtures/office-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

// ---------- the names ----------

test('officeFiles: the default port keeps the plain names; any other port has its own', () => {
  assert.equal(DEFAULT_PORT, 4317);
  const r = path.join('C:', 'office');
  const plain = { token: '.office-token', hooksCmd: 'office-hooks.json', hooksHttp: 'office-hooks-http.json', mcp: 'office-mcp.json', state: 'state.json', history: 'history.json' };
  const at = (names) => Object.fromEntries(Object.entries(names).map(([k, v]) => [k, path.join(r, v)]));
  assert.deepEqual(officeFiles(r), at(plain));
  assert.deepEqual(officeFiles(r, 4317), at(plain));
  assert.deepEqual(officeFiles(r, '4317'), at(plain));
  assert.deepEqual(officeFiles(r, 4392), at({ token: '.office-token-4392', hooksCmd: 'office-hooks-4392.json', hooksHttp: 'office-hooks-http-4392.json', mcp: 'office-mcp-4392.json', state: 'state-4392.json', history: 'history-4392.json' }));
  // Two ports never share a file, and no port shares one with the default office.
  const names = [4317, 4330, 4392, 5000, 65535].map((p) => Object.values(officeFiles(r, p)));
  assert.equal(new Set(names.flat()).size, names.flat().length);
  for (const bad of [0, -1, 65536, 4317.5, NaN, 'x', '', null]) assert.throws(() => officeFiles(r, bad), RangeError, String(bad));
});

test('portArg and portArgs: the command line of hook.mjs and mcp.mjs', () => {
  assert.deepEqual(portArgs(4317), [], 'the default office bakes no argument: its settings stay as they were');
  assert.deepEqual(portArgs(4392), ['4392']);
  assert.equal(portArg(undefined), 4317, 'no argument: the default office (also settings made before #100)');
  assert.equal(portArg(''), 4317);
  assert.equal(portArg('4392'), 4392);
  assert.equal(portArg('4317'), 4317);
  for (const bad of ['0', '65536', '43.5', '-4392', '4392x', 'x', '--port', ' 4392', '0x10f5']) assert.equal(portArg(bad), null, bad);
});

// ---------- hook.mjs and mcp.mjs find their office ----------

/** A stand-in office: records each request (path, token, body) and answers with one text, as /mcp/inbox does. */
async function fakeOffice() {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push({ path: req.url, token: req.headers['x-office-token'], body: JSON.parse(b || '{}') }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'from the stand-in' })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, got, close: () => new Promise((r) => server.close(r)) };
}

test('hook.mjs and mcp.mjs read the token file of the port in their first argument', { timeout: 60000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-files-')));
  for (const f of ['hook.mjs', 'mcp.mjs', 'payload.mjs', 'files.mjs']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  const plain = await fakeOffice(), other = await fakeOffice();
  try {
    // The default office's file names port `plain`; the file of port `other` names port `other`.
    fs.writeFileSync(officeFiles(tmp).token, JSON.stringify({ token: 'plain-token', port: plain.port }));
    fs.writeFileSync(officeFiles(tmp, other.port).token, JSON.stringify({ token: 'other-token', port: other.port }));
    const run = (script, args, input) => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [path.join(tmp, script), ...args], { cwd: tmp, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
        if (script === 'mcp.mjs' && out.includes('\n')) c.stdin.end();
      });
      c.on('error', reject);
      c.on('exit', (code) => resolve({ code, out }));
      if (script === 'hook.mjs') c.stdin.end(input); else c.stdin.write(input);
    });
    const payload = JSON.stringify({ hook_event_name: 'Notification', session_id: 's1', cwd: tmp, message: 'hi' });
    const inbox = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'office_inbox', arguments: {} } }) + '\n';

    assert.equal((await run('hook.mjs', [String(other.port)], payload)).code, 0);
    assert.equal((await run('hook.mjs', [], payload)).code, 0);
    assert.deepEqual(other.got.map((g) => [g.path, g.token, g.body.session_id]), [['/hook', 'other-token', 's1']]);
    assert.deepEqual(plain.got.map((g) => [g.path, g.token, g.body.session_id]), [['/hook', 'plain-token', 's1']]);

    const mcpOther = await run('mcp.mjs', [String(other.port)], inbox);
    const mcpPlain = await run('mcp.mjs', [], inbox);
    assert.equal(JSON.parse(mcpOther.out).result.content[0].text, 'from the stand-in');
    assert.equal(JSON.parse(mcpPlain.out).result.content[0].text, 'from the stand-in');
    assert.deepEqual(other.got.slice(1).map((g) => [g.path, g.token]), [['/mcp/inbox', 'other-token']]);
    assert.deepEqual(plain.got.slice(1).map((g) => [g.path, g.token]), [['/mcp/inbox', 'plain-token']]);

    // A port with no office file, or an argument that is not a port: nothing is sent, the hook still exits 0 silently,
    // and the MCP tool says the office is not running.
    for (const args of [['1'], ['x'], ['99999']]) {
      const h = await run('hook.mjs', args, payload);
      assert.deepEqual([h.code, h.out], [0, ''], args[0]);
      const m = JSON.parse((await run('mcp.mjs', args, inbox)).out).result;
      assert.equal(m.isError, true, args[0]);
      assert.match(m.content[0].text, /not running/, args[0]);
    }
    assert.equal(plain.got.length + other.got.length, 4, 'no request for a bad port');

    // A token file that names another port than the argument is not this office's: the hook is silent, the MCP tool fails clearly.
    fs.writeFileSync(officeFiles(tmp, 4391).token, JSON.stringify({ token: 'wrong-token', port: other.port }));
    const hm = await run('hook.mjs', ['4391'], payload);
    assert.deepEqual([hm.code, hm.out], [0, '']);
    const mm = JSON.parse((await run('mcp.mjs', ['4391'], inbox)).out).result;
    assert.equal(mm.isError, true);
    assert.match(mm.content[0].text, /names port/);
    assert.equal(plain.got.length + other.got.length, 4, 'no request for a mismatched token file');
  } finally {
    await plain.close();
    await other.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

function copyOffice(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['providers', 'public']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
}

// The test's own environment without OFFICE_ID (this test may run inside an office session) and with a short PATH:
// no claude, so no paid call and a fast start. Programs from System32 come by absolute path anyway.
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['path', 'office_id', 'office_port'].includes(k.toLowerCase())));
  return { ...env, PATH: [path.dirname(process.execPath), ...(win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter), ...extra };
}

// Starting and stopping a copy: test/fixtures/office-server.mjs. `done` resolves 'open' when it listens, or 'exited' when it exits
// with a launch link (a copy on a busy port). A port taken before the bind starts the copy again on a new port (startOnFreePort).
const stopOffice = (o) => (o ? o.stop() : undefined);

function filesOf(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f), st = fs.statSync(p);
    if (st.isFile()) out[f] = { text: fs.readFileSync(p, 'utf8'), mtime: st.mtimeMs };
  }
  return out;
}
function assertUnchanged(dir, before, what) {
  const now = filesOf(dir);
  for (const [f, was] of Object.entries(before)) {
    assert.ok(now[f], `${what}: ${f} is gone`);
    assert.equal(now[f].text, was.text, `${what}: ${f} has new text`);
    assert.equal(now[f].mtime, was.mtime, `${what}: ${f} was written again`);
  }
}

/** A page route of the office with its page token: JSON, or the first /events message. */
function page(port, env, p) {
  const token = JSON.parse(fs.readFileSync(auth.pageFile(env, port), 'utf8')).token;
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, 'x-office-token': token } }, (res) => {
      let b = '';
      res.on('data', (c) => {
        b += c;
        if (p === '/events' && b.includes('\n\n')) { res.destroy(); resolve(JSON.parse(b.slice(b.indexOf('data: ') + 6, b.indexOf('\n\n')))); }
      });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
  });
}
// A POST to a page route: { status, json }. The Startup folder of these offices is a temp one (APPDATA in the env).
function postPage(port, env, p, body) {
  const token = JSON.parse(fs.readFileSync(auth.pageFile(env, port), 'utf8')).token;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'x-office-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.end(data);
  });
}
const sessionNames = async (port, env) => (await page(port, env, '/events')).sessions.map((s) => s.name);

// A command line from a settings file, split the way a shell does for these quoted paths and plain words.
const argvOf = (cmd) => [...String(cmd).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

/** Runs the UserPromptSubmit command hook of a settings file, as Claude Code does: the payload on stdin. */
function runHook(settingsFile, payload) {
  const cmd = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(cmd.type, 'command');
  const [exe, ...args] = argvOf(cmd.command);
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, { cwd: payload.cwd, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', reject);
    c.on('exit', (code) => resolve({ code, out }));
    c.stdin.end(JSON.stringify(payload));
  });
}

/** Runs the office MCP server of an MCP config file and calls office_inbox once. */
function callInbox(mcpFile) {
  const { command, args } = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.office;
  return new Promise((resolve, reject) => {
    const c = spawn(command, args, { cwd: os.tmpdir(), env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { c.kill(); reject(new Error('the MCP server gave no answer: ' + out)); }, 20000);
    c.stdout.on('data', (d) => {
      out += d;
      const i = out.indexOf('\n');
      if (i < 0) return;
      clearTimeout(t);
      c.stdin.end();
      resolve(JSON.parse(out.slice(0, i)).result);
    });
    c.on('error', reject);
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'office_inbox', arguments: {} } }) + '\n');
  });
}

const launchFiles = (info) => ({ settings: info.hooksFile, mcp: info.launchCommand.match(/--mcp-config "([^"]+)"/)[1] });

test('a second office in the same folder never rewrites the first office\'s files, and each office\'s hooks reach it', { timeout: 900000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-two-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local'), work = path.join(tmp, 'work');
  copyOffice(dir);
  fs.mkdirSync(lad);
  for (const n of ['hook-a', 'hook-b', 'hook-a-alone']) fs.mkdirSync(path.join(work, n), { recursive: true });
  // The owner's office on the default port (4317) has run in this folder: its files are there. The test never listens on
  // 4317, so it makes them by hand. The owner's state has a schedule; no other office may take it over.
  const owner = {
    '.office-token': JSON.stringify({ token: 'a'.repeat(48), port: 4317 }),
    'office-hooks.json': JSON.stringify({ owner: 'command hooks' }),
    'office-hooks-http.json': JSON.stringify({ owner: 'http hooks' }),
    'office-mcp.json': JSON.stringify({ owner: 'mcp' }),
    'state.json': JSON.stringify({ recent: [], schedules: [{ id: 'owner-schedule', name: 'Owner', prompt: 'x', cwd: tmp, kind: 'every', every: 10080, at: '09:00', enabled: false, lastRun: Date.now() }] }),
    'history.json': '[]',
  };
  for (const [f, text] of Object.entries(owner)) fs.writeFileSync(path.join(dir, f), text);
  const ownerFiles = filesOf(dir);

  const baseEnv = cleanEnv({ OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'), OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json') });
  let a = null, b = null, again = null, portA, portB, envA, envB;
  try {
    // The first office on another port: the owner's files stay as they were.
    const startedA = await startOnFreePort(dir, baseEnv);
    a = startedA.office; portA = startedA.port; envA = startedA.env;
    assertUnchanged(dir, ownerFiles, 'after the first office started');
    const infoA = await page(portA, envA, '/api/info');
    assert.equal(infoA.port, portA);
    assert.ok(!infoA.schedules.some((s) => s.id === 'owner-schedule'), 'the first office took over the owner\'s schedule');
    // The Start with Windows entry is one file for the user, so an office on another port shows it read-only and cannot change it (#108).
    assert.equal(infoA.startup.canChange, false);
    assert.match(infoA.startup.reason, /port 4317/);
    const startupDir = startup.startupDir(envA.APPDATA);
    startup.enable(startupDir, dir, process.execPath); // the owner's entry, in the temp Startup folder
    const entry = fs.readFileSync(startup.entryPath(startupDir), 'utf8');
    for (const enabled of [true, false]) {
      const r = await postPage(portA, envA, '/api/startup', { enabled });
      assert.equal(r.status, 403, JSON.stringify(r.json));
      assert.match(r.json.error, /port 4317/);
    }
    assert.equal(fs.readFileSync(startup.entryPath(startupDir), 'utf8'), entry, 'a refused turn-on or turn-off changed the owner\'s entry');
    assert.equal((await page(portA, envA, '/api/info')).startup.enabled, true, 'the office shows the real state');
    const filesA = launchFiles(infoA);
    for (const f of Object.values(filesA)) assert.ok(!Object.keys(owner).includes(path.basename(f)), `the first office uses the owner's ${path.basename(f)}`);
    const own = officeFiles(dir, portA);
    assert.deepEqual(filesA, { settings: own.hooksCmd, mcp: own.mcp });
    for (const f of Object.values(own)) assert.ok(fs.existsSync(f), path.basename(f));
    const tokenA = JSON.parse(fs.readFileSync(own.token, 'utf8'));
    assert.equal(tokenA.port, portA);
    assert.notEqual(tokenA.token, 'a'.repeat(48), 'a token from a file that names another port is not taken');
    const before = filesOf(dir);

    // The second office on another port: no file that was there changes, not even its time.
    const startedB = await startOnFreePort(dir, baseEnv);
    b = startedB.office; portB = startedB.port; envB = startedB.env;
    assertUnchanged(dir, before, 'after the second office started');
    const filesB = launchFiles(await page(portB, envB, '/api/info'));
    assert.notEqual(filesB.settings, filesA.settings);
    assert.notEqual(filesB.mcp, filesA.mcp);

    // A third copy on the first office's port stops (the port is busy) and writes nothing either.
    again = startOffice(dir, envA);
    assert.equal(await again.done, 'exited');
    assertUnchanged(dir, before, 'after a copy on a busy port');

    // Each office's settings send its hooks to that office only.
    assert.equal((await runHook(filesA.settings, { hook_event_name: 'UserPromptSubmit', session_id: 'sid-a', cwd: path.join(work, 'hook-a'), prompt: 'Go.' })).code, 0);
    assert.equal((await runHook(filesB.settings, { hook_event_name: 'UserPromptSubmit', session_id: 'sid-b', cwd: path.join(work, 'hook-b'), prompt: 'Go.' })).code, 0);
    const [namesA, namesB] = [await sessionNames(portA, envA), await sessionNames(portB, envB)];
    assert.ok(namesA.includes('hook-a'), 'the first office got its hook: ' + namesA);
    assert.ok(!namesA.includes('hook-b'), 'the first office got the second office\'s hook');
    assert.ok(namesB.includes('hook-b'), 'the second office got its hook: ' + namesB);
    assert.ok(!namesB.includes('hook-a'), 'the second office got the first office\'s hook');

    // The second office stops: the first office's hooks and MCP server still reach it.
    await stopOffice(b);
    assert.equal((await runHook(filesA.settings, { hook_event_name: 'UserPromptSubmit', session_id: 'sid-a2', cwd: path.join(work, 'hook-a-alone'), prompt: 'Go.' })).code, 0);
    assert.ok((await sessionNames(portA, envA)).includes('hook-a-alone'), 'the first office got its hook after the second one stopped');
    const inbox = await callInbox(filesA.mcp);
    assert.equal(inbox.isError, undefined, 'the MCP server of the first office reached it: ' + JSON.stringify(inbox));
    assert.match(inbox.content[0].text, /does not recognise this session/);
    assertUnchanged(dir, ownerFiles, 'at the end');
  } finally {
    for (const o of [again, b, a]) await stopOffice(o);
    // The server's helpers start in %SystemRoot% (git.helperCwd), so once the copies are gone nothing is in the folder.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('an office on another port keeps the token of an older .office-token that names its port, and never writes the plain files', { timeout: 900000 }, async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-upgrade-')));
  const dir = path.join(tmp, 'office'), lad = path.join(tmp, 'local'), work = path.join(tmp, 'work', 'old-settings');
  copyOffice(dir);
  fs.mkdirSync(lad);
  fs.mkdirSync(work, { recursive: true });
  // Before #100 this office (on `port`) wrote the plain files. Sessions started then use them: their command hooks run
  // hook.mjs with no argument, which reads .office-token, and their HTTP hooks carry its token.
  const OLD = 'b'.repeat(48);
  let plain = null;
  // The token file names the port, so it is made for each try (a port taken before the bind starts the copy again on a new one).
  const prepare = (port) => {
    fs.writeFileSync(path.join(dir, '.office-token'), JSON.stringify({ token: OLD, port }));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ recent: [], schedules: [{ id: 'plain-schedule', name: 'Plain', prompt: 'x', cwd: tmp, kind: 'every', every: 10080, at: '09:00', enabled: false, lastRun: Date.now() }] }));
    plain = filesOf(dir);
  };
  const baseEnv = cleanEnv({ OFFICE_OPEN: '0', OFFICE_HOOKS: 'command', LOCALAPPDATA: lad, APPDATA: path.join(tmp, 'roaming'), OFFICE_RATE_FILE: path.join(tmp, 'no-rate.json') });
  let o = null, port, env;
  try {
    for (const round of ['first start', 'restart']) {
      if (round === 'first start') {
        const started = await startOnFreePort(dir, baseEnv, { prepare });
        o = started.office; port = started.port; env = started.env;
      } else {
        o = startOffice(dir, env);
        assert.equal(await o.done, 'open', round);
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(officeFiles(dir, port).token, 'utf8')), { token: OLD, port }, `${round}: the token is kept`);
      assertUnchanged(dir, plain, round);
      // Only the token comes over: the plain state.json may be the default office's (its schedules run there).
      assert.deepEqual((await page(port, env, '/api/info')).schedules, [], round);
      await stopOffice(o);
    }
    // A session with the old settings still reaches the office: hook.mjs with no argument reads .office-token.
    o = startOffice(dir, env);
    await o.done;
    const hook = spawn(process.execPath, [path.join(dir, 'hook.mjs')], { cwd: work, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const code = await new Promise((r) => { hook.on('exit', r); hook.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'old', cwd: work, prompt: 'Go.' })); });
    assert.equal(code, 0);
    assert.ok((await sessionNames(port, env)).includes('old-settings'), 'the old settings reached the office');
  } finally {
    await stopOffice(o);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('smoke.mjs takes a port like probe.mjs and stops before any session', { timeout: 30000 }, async () => {
  const run = (args) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'test', 'smoke.mjs'), ...args], { cwd: ROOT, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('exit', (code) => resolve({ code, err }));
  });
  const bad = await run(['x']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /is not a port/);
  const none = await run(['1']);
  assert.equal(none.code, 1);
  assert.match(none.err, /port 1 is not running/);
});
