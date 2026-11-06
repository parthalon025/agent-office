// The command hook and the MCP server post with node:http, not fetch (#128). The global fetch gives up after 300 s
// without answer headers (UND_ERR_HEADERS_TIMEOUT), but a held request waits up to 15 min (permission) or 10 min
// (office_ask). A real 300 s wait is too long for a test, so a preload (stand-in) gives fetch a headers timeout of
// 400 ms, the same failure at a smaller size. The code that does not use fetch is not affected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { httpPost } from '../src/post.mjs';
import { officeFiles } from '../src/files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLD_MS = 1200; // longer than the stand-in's 400 ms headers timeout

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

/** Runs a copy of hook.mjs against a token file for `port`. Resolves { code, out }. */
function runHook(dir, port, event, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'src', 'hook.mjs'), String(port)], {
      cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ session_id: 's1', cwd: dir, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } }));
  });
}

function rig(t, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-post-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  for (const f of ['hook.mjs', 'payload.mjs', 'files.mjs', 'post.mjs']) {
    if (fs.existsSync(path.join(ROOT, 'src', f))) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(dir, 'src', f));
  }
  fs.writeFileSync(officeFiles(dir, port).token, JSON.stringify({ token: 'tok', port }));
  const preload = path.join(dir, 'fetch-timeout.cjs');
  fs.writeFileSync(preload, `
    const real = globalThis.fetch;
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })), 400);
      real(url, opts).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
    });
  `);
  return { dir, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload.replace(/\\/g, '/'))}` } };
}

test('hook: a held PermissionRequest answered after the old fetch limit still returns its answer', async (t) => {
  const answer = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
  const { server, port } = await listen((req, res) => {
    req.resume();
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(answer); }, HOLD_MS);
  });
  t.after(() => server.close());
  const { dir, env } = rig(t, port);
  const r = await runHook(dir, port, 'PermissionRequest', env);
  assert.equal(r.code, 0);
  assert.equal(r.out, answer);
});

test('hook: a refused connection, a non-JSON answer and an abort exit 0 with empty stdout', async (t) => {
  // refused: a port nothing listens on
  const probe = await listen(() => {});
  const closedPort = probe.port;
  await new Promise((r) => probe.server.close(r));
  let { dir } = rig(t, closedPort);
  let r = await runHook(dir, closedPort, 'PermissionRequest');
  assert.deepEqual([r.code, r.out], [0, '']);

  // non-JSON answer
  const html = await listen((req, res) => { req.resume(); res.writeHead(200); res.end('<html>nope</html>'); });
  t.after(() => html.server.close());
  ({ dir } = rig(t, html.port));
  r = await runHook(dir, html.port, 'PermissionRequest');
  assert.deepEqual([r.code, r.out], [0, '']);

  // abort: a non-ask call gives up after 1500 ms while the office holds the request
  const hold = await listen((req) => { req.resume(); });
  t.after(() => { hold.server.closeAllConnections?.(); hold.server.close(); });
  ({ dir } = rig(t, hold.port));
  r = await runHook(dir, hold.port, 'Stop');
  assert.deepEqual([r.code, r.out], [0, '']);
});

test('hook: only hookSpecificOutput or decision bodies reach stdout', async (t) => {
  const bodies = ['{}', '{"ok":true}', '{"decision":"block","reason":"x"}', '{"hookSpecificOutput":{"permissionDecision":"deny"}}', '{"other":1}'];
  let i = 0;
  const { server, port } = await listen((req, res) => { req.resume(); res.writeHead(200); res.end(bodies[i++]); });
  t.after(() => server.close());
  const { dir } = rig(t, port);
  const outs = [];
  for (let n = 0; n < bodies.length; n++) outs.push((await runHook(dir, port, 'PostToolUse')).out);
  assert.deepEqual(outs, ['', '', bodies[2], bodies[3], '']);
});

test('httpPost: waits past the headers limit, caps the answer, ends on the caller signal', async (t) => {
  const slow = await listen((req, res) => { req.resume(); setTimeout(() => res.end('{"ok":1}'), 600); });
  t.after(() => slow.server.close());
  const ok = await httpPost({ port: slow.port, path: '/x', headers: {}, body: '{}' });
  assert.deepEqual(ok, { status: 200, text: '{"ok":1}' });

  const big = await listen((req, res) => { req.resume(); res.end('x'.repeat(5000)); });
  t.after(() => big.server.close());
  await assert.rejects(httpPost({ port: big.port, path: '/x', headers: {}, body: '{}', maxAnswer: 100 }), /too large/);

  const hold = await listen((req) => { req.resume(); });
  t.after(() => { hold.server.closeAllConnections?.(); hold.server.close(); });
  await assert.rejects(httpPost({ port: hold.port, path: '/x', headers: {}, body: '{}', signal: AbortSignal.timeout(200) }));
});

test('hook.mjs and mcp.mjs post through post.mjs, not fetch', () => {
  for (const f of ['hook.mjs', 'mcp.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    assert.match(src, /from '\.\/post\.mjs'/, f);
    assert.doesNotMatch(src, /\bfetch\(/, f);
  }
  assert.ok(pathToFileURL(ROOT));
});
