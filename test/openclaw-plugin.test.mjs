// The Agent Office plugin for OpenClaw (integrations/openclaw-plugin, #77), loaded by the stand-in plugin host
// test/fixtures/fake-openclaw.mjs and pointed at a fake office: a real HTTP server on loopback that reads each request with the
// office's own parser (providers/openclaw.mjs gateRequest, the one the /hook/openclaw route uses). No OpenClaw, no model.
// Run: node --test test/openclaw-plugin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, DEFAULT_HOOK_MS } from './fixtures/fake-openclaw.mjs';
import { OFFICE_KEY as PLUGIN_KEY, officeIdOf as pluginIdOf, ROUTE, WAIT_MS, createGate } from '../integrations/openclaw-plugin/gate.js';
import { OFFICE_KEY, officeKey, officeIdOf, gateRequest, PLUGIN_ID, PLUGIN_DIR } from '../providers/openclaw.mjs';
import { routeOf } from '../auth.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integrations', 'openclaw-plugin');
const KEY = 'agent:main:agent-office:o1a2b3c4d';

// A fake office: answer(body) gives { status, json } or a promise of it (or never settles). It records each request.
async function office(answer) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const body = JSON.parse(b);
      const rec = { method: req.method, url: req.url, headers: req.headers, body, parsed: gateRequest(body), closed: false };
      seen.push(rec);
      res.on('close', () => { rec.closed = !res.writableEnded; });
      const a = await answer(rec);
      if (a) { res.writeHead(a.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(a.json)); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-claw-plugin-'));
  const tokenFile = path.join(base, '.office-token');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'agent-token-1', port: srv.address().port }));
  return { seen, tokenFile, base, port: srv.address().port, close: () => { srv.closeAllConnections?.(); srv.close(); fs.rmSync(base, { recursive: true, force: true }); } };
}
const call = (over = {}) => ({ toolName: 'edit', params: { path: 'src/a.js', old_string: 'a', new_string: 'b' }, toolCallId: 'call-1', runId: 'run-1', ...over });
const ctxOf = (over = {}) => ({ sessionKey: KEY, sessionId: 'sess-1', agentId: 'main', toolName: 'edit', ...over });

test('the plugin folder is what OpenClaw loads: package entry, manifest id and entry id agree, and the config takes tokenFile only', async () => {
  const host = await load(DIR, { config: { tokenFile: 'x' } });
  assert.equal(host.entry.id, 'agent-office');
  assert.equal(host.manifest.id, PLUGIN_ID, 'the office checks the config entry of this id');
  assert.equal(path.resolve(PLUGIN_DIR), path.resolve(DIR), 'the office names this folder in its install step');
  assert.deepEqual(host.hooks.map((h) => [h.name, h.matcher, h.timeoutMs]), [['before_tool_call', undefined, 600_000]], 'every tool, with the longest handler limit OpenClaw config takes');
  assert.ok(WAIT_MS < 600_000, 'the plugin answers before OpenClaw blocks the call by itself');
  await assert.rejects(load(DIR, { config: { tokenFile: 'x', url: 'http://example.com' } }), /unknown settings: url/);
});

test('the key rule of the plugin is the office\'s own: an office session key ends in agent-office:<uid>', () => {
  assert.equal(String(PLUGIN_KEY), String(OFFICE_KEY));
  for (const k of [officeKey('o1a2b3c4d'), KEY, 'AGENT:MAIN:AGENT-OFFICE:O1A2B3C4D']) {
    assert.equal(pluginIdOf(k), 'o1a2b3c4d', k);
    assert.equal(officeIdOf(k), 'o1a2b3c4d', k);
  }
  for (const k of ['agent:main:main', 'acp-bridge:1234', 'agent:main:agent-office:o1a2b3c4d:sub', 'agent-office:x', null, 42]) {
    assert.equal(pluginIdOf(k), null, String(k));
    assert.equal(officeIdOf(k), null, String(k));
  }
});

test('an office call goes to POST /hook/openclaw with the agent token, in the shape the route reads; allow lets it run', async () => {
  const o = await office(() => ({ json: { decision: 'allow' } }));
  try {
    const host = await load(DIR, { config: { tokenFile: o.tokenFile } });
    const r = await host.beforeToolCall(call({ derivedPaths: ['src/a.js'] }), ctxOf());
    assert.equal(r, undefined, 'no block: OpenClaw runs the call');
    const [q] = o.seen;
    assert.deepEqual([q.method, q.url, q.headers['content-type'], q.headers['x-office-token']], ['POST', ROUTE, 'application/json', 'agent-token-1']);
    assert.equal(routeOf('POST', ROUTE), 'agent', 'the route is in the agent token group');
    assert.ok(q.parsed.ok, q.parsed.error);
    assert.deepEqual(q.parsed.call, { sessionKey: KEY, toolName: 'edit', params: { path: 'src/a.js', old_string: 'a', new_string: 'b' }, toolCallId: 'call-1', runId: 'run-1', derivedPaths: ['src/a.js'] });
  } finally { o.close(); }
});

test('a deny blocks the call with the office\'s reason; any other answer blocks too', async () => {
  const answers = [{ json: { decision: 'deny', reason: 'Denied by the Security room: Shell commands.' } }, { json: { decision: 'maybe' } }, { status: 401, json: { error: 'Unauthorized' } }];
  const o = await office(() => answers.shift());
  try {
    const host = await load(DIR, { config: { tokenFile: o.tokenFile } });
    assert.deepEqual(await host.beforeToolCall(call(), ctxOf()), { block: true, blockReason: 'Agent Office: Denied by the Security room: Shell commands.' });
    assert.deepEqual(await host.beforeToolCall(call(), ctxOf()), { block: true, blockReason: 'Agent Office: Declined in Agent Office.' });
    assert.match((await host.beforeToolCall(call(), ctxOf())).blockReason, /refused the request \(HTTP 401\)/);
  } finally { o.close(); }
});

test('no answer means deny: the wait limit blocks the call and closes the request, so the office frees its hold', async () => {
  const o = await office(() => new Promise(() => {})); // the office never answers
  try {
    let fire;
    const gate = createGate({ config: () => ({ tokenFile: o.tokenFile }), readFile: (f) => fs.promises.readFile(f, 'utf8'), fetch, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
    const p = gate.beforeToolCall(call(), ctxOf());
    while (!o.seen.length) await new Promise((r) => setTimeout(r, 10));
    fire();
    const r = await p;
    assert.deepEqual(r, { block: true, blockReason: `Agent Office: no answer from the office in ${Math.round(WAIT_MS / 1000)} s. The call is denied.` });
    while (!o.seen[0].closed) await new Promise((r) => setTimeout(r, 10));
  } finally { o.close(); }
});

test('the host\'s own handler limit blocks a call too, and a call OpenClaw cancels stops the wait', async () => {
  const o = await office(() => new Promise(() => {}));
  try {
    let fire;
    const host = await load(DIR, { config: { tokenFile: o.tokenFile }, setTimer: (fn, ms) => { if (ms === 600_000) fire = fn; return 1; }, clearTimer: () => {} });
    const p = host.beforeToolCall(call(), ctxOf());
    while (!o.seen.length) await new Promise((r) => setTimeout(r, 10));
    fire();
    assert.deepEqual(await p, { block: true, blockReason: 'plugin agent-office timed out' });
    const stop = new AbortController();
    const q = (await load(DIR, { config: { tokenFile: o.tokenFile } })).beforeToolCall(call(), ctxOf({ abortSignal: stop.signal }));
    while (o.seen.length < 2) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    assert.deepEqual(await q, { block: true, blockReason: 'Agent Office: OpenClaw cancelled the call while it waited for the office.' });
    while (!o.seen[1].closed) await new Promise((r) => setTimeout(r, 10));
  } finally { o.close(); }
  assert.equal(DEFAULT_HOOK_MS, 15_000, 'without its own limit a handler would get 15 s');
});

test('no office, no token file, no setting: an office call is denied; a session of another client is not the office\'s', async () => {
  const o = await office(() => ({ json: { decision: 'allow' } }));
  const tokenFile = o.tokenFile, port = o.port;
  try {
    const none = await load(DIR, {});
    assert.match((await none.beforeToolCall(call(), ctxOf())).blockReason, /no tokenFile setting/);
    const missing = await load(DIR, { config: { tokenFile: path.join(o.base, 'nope') } });
    assert.match((await missing.beforeToolCall(call(), ctxOf())).blockReason, /cannot read the office token file/);
    const host = await load(DIR, { config: { tokenFile } });
    assert.equal(await host.beforeToolCall(call(), ctxOf({ sessionKey: 'agent:main:main' })), undefined, 'another client: OpenClaw decides');
    assert.equal(await host.beforeToolCall(call(), ctxOf({ sessionKey: undefined })), undefined);
    assert.equal(o.seen.length, 0, 'nothing went to the office for them');
    o.close();
    fs.mkdirSync(o.base, { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ token: 'agent-token-1', port }));
    assert.match((await host.beforeToolCall(call(), ctxOf())).blockReason, /does not answer on 127\.0\.0\.1:\d+\. The call is denied\./);
  } finally { fs.rmSync(o.base, { recursive: true, force: true }); }
});

test('gateRequest: the route takes a session key, a tool name and params; anything else is refused', () => {
  assert.equal(gateRequest({ session_key: KEY, tool_name: 'read', params: {} }).ok, true);
  for (const bad of [{}, { session_key: KEY }, { session_key: KEY, tool_name: '' }, { session_key: KEY, tool_name: 'read', params: [] }, { session_key: 7, tool_name: 'read' }, null]) {
    assert.equal(gateRequest(bad).ok, false, JSON.stringify(bad));
  }
});
