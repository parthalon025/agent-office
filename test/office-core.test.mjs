// The office core (src/office-core.mjs): the route table and handle(request), through its Interface only. First the core with a fake
// table (dispatch, answers, errors, a client that goes away), then the real table of the office (src/office.mjs) built in process:
// every route has one group, the group agrees with the prefix rule of auth.mjs, and the gate reads the table.
// Run: node --test test/office-core.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore, reply, httpError, askFirst, staticFiles } from '../src/office-core.mjs';
import * as auth from '../src/auth.mjs';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { REPO_ROOT } from './fixtures/office-server.mjs';
import '../public/ask.js';

const R = (method, p, group, run) => ({ method, path: p, group, run });

test('handle runs the handler of the method and path; a value is a 200 JSON answer', async () => {
  const core = createCore({ routes: [R('GET', '/api/a', 'page', () => ({ ok: 1 })), R('POST', '/api/a', 'page', ({ body }) => ({ got: body }))] });
  assert.deepEqual(await core.handle({ method: 'GET', path: '/api/a' }), { status: 200, body: { ok: 1 } });
  assert.deepEqual((await core.handle({ method: 'POST', path: '/api/a', body: { x: 2 } })).body, { got: { x: 2 } });
  assert.deepEqual((await core.handle({ method: 'POST', path: '/api/a' })).body, { got: {} }, 'no body is an empty object');
});

test('a path or method the table does not list is 404, and nothing runs', async () => {
  let ran = 0;
  const core = createCore({ routes: [R('POST', '/api/a', 'page', () => { ran++; return {}; })] });
  for (const q of [{ method: 'GET', path: '/api/a' }, { method: 'POST', path: '/api/b' }, { method: 'PUT', path: '/api/a' }]) {
    assert.deepEqual(await core.handle(q), { status: 404, body: { error: 'Not found' } });
  }
  assert.equal(ran, 0);
});

test('reply sets a status, a type, headers and a feed; the handler gets the query, the headers and the signal', async () => {
  const seen = {};
  const core = createCore({
    routes: [
      R('GET', '/x', 'public', () => reply(200, '<p>', { type: 'text/html' })),
      R('POST', '/launch', 'launch', () => reply(401, { error: 'no' }, { headers: { 'set-cookie': 'a=b' } })),
      R('GET', '/events', 'page', () => reply(200, '', { stream: () => () => {} })),
      R('GET', '/api/q', 'page', ({ query, headers, signal, remote }) => { Object.assign(seen, { first: query.get('first'), h: headers.h, signal, remote }); return {}; }),
    ],
  });
  assert.deepEqual(await core.handle({ method: 'GET', path: '/x' }), { status: 200, body: '<p>', type: 'text/html', headers: undefined, bare: undefined, stream: undefined });
  const l = await core.handle({ method: 'POST', path: '/launch' });
  assert.equal(l.status, 401); assert.deepEqual(l.headers, { 'set-cookie': 'a=b' });
  assert.equal(typeof (await core.handle({ method: 'GET', path: '/events' })).stream, 'function');
  const ac = new AbortController();
  await core.handle({ method: 'GET', path: '/api/q', query: new URLSearchParams('first=abc'), headers: { h: '7' }, signal: ac.signal, remote: { email: 'a@b' } });
  assert.deepEqual({ first: seen.first, h: seen.h, remote: seen.remote }, { first: 'abc', h: '7', remote: { email: 'a@b' } });
  assert.equal(seen.signal, ac.signal);
});

test('a refusal carries its status; a call that needs the user\'s yes first answers with the ask-first body', async () => {
  const core = createCore({
    routes: [
      R('POST', '/a', 'page', () => { throw httpError(409, 'Close it first.'); }),
      R('POST', '/b', 'page', () => { throw new Error('boom'); }),
      R('POST', '/c', 'page', () => { throw askFirst('cost', 'This agent does not report cost. Run it?'); }),
    ],
  });
  assert.deepEqual(await core.handle({ method: 'POST', path: '/a' }), { status: 409, body: { error: 'Close it first.' } });
  assert.deepEqual(await core.handle({ method: 'POST', path: '/b' }), { status: 500, body: { error: 'boom' } });
  const c = await core.handle({ method: 'POST', path: '/c' });
  const want = globalThis.OfficeAsk.answer('cost', 'This agent does not report cost. Run it?');
  assert.deepEqual({ status: c.status, body: c.body }, { status: want.status, body: want.body });
});

test('a held request settles with the handler\'s promise; a client that goes away ends it at once', async () => {
  let release;
  const core = createCore({ routes: [R('POST', '/hold', 'agent', () => new Promise((resolve) => { release = resolve; }))] });
  const held = core.handle({ method: 'POST', path: '/hold' });
  release({ allow: true });
  assert.deepEqual((await held).body, { allow: true });
  const ac = new AbortController();
  const gone = core.handle({ method: 'POST', path: '/hold', signal: ac.signal });
  ac.abort();
  assert.equal((await gone).status, 499, 'nobody waits for ever on a hold the client gave up');
  assert.equal((await core.handle({ method: 'POST', path: '/hold', signal: ac.signal })).status, 499, 'a signal that is already aborted runs nothing');
});

test('a route listed twice is refused, and groupOf reads the group by method and path', () => {
  assert.throws(() => createCore({ routes: [R('GET', '/a', 'page', () => 1), R('GET', '/a', 'page', () => 2)] }), /listed twice/);
  const core = createCore({ routes: [R('GET', '/a', 'page', () => 1), R('POST', '/a', 'agent', () => 1)] });
  assert.equal(core.groupOf('GET', '/a'), 'page');
  assert.equal(core.groupOf('POST', '/a'), 'agent');
  assert.equal(core.groupOf('PUT', '/a'), undefined);
});

// ---- the real route table
let base, rig;
const room = async () => {
  if (rig) return rig;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-core-'));
  rig = await startInProcess({ dir: base });
  return rig;
};
after(async () => {
  if (rig) rig.stop();
  if (base) await removeTree(base);
});

test('every route of the office is listed once, in a group that agrees with the prefix rule of auth.routeOf', async () => {
  const { office } = await room();
  const routes = office.core.routes;
  assert.ok(routes.length > 90, `${routes.length} routes`);
  const seen = new Set();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `${key} twice`);
    seen.add(key);
    // The table cannot loosen the prefix rule: a group listed here is the group the prefix rule would give, so a path the table
    // does not list still gets the token of its prefix.
    assert.equal(auth.routeOf(r.method, r.path, () => r.group === 'public'), r.group, key);
  }
  const groups = (g) => routes.filter((r) => r.group === g).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(groups('launch'), ['POST /remote/signin', 'POST /launch']);
  assert.ok(groups('agent').includes('POST /hook/openclaw') && groups('agent').includes('POST /mcp/ask'));
  assert.ok(groups('page').includes('GET /events') && groups('page').includes('POST /api/open'));
  assert.ok(routes.filter((r) => r.group === 'public').every((r) => r.method === 'GET'));
  assert.ok(groups('agent').every((p) => /^POST \/(hook|mcp)(\/|$)/.test(p)), 'agent routes are hooks and MCP');
  assert.ok(groups('page').every((p) => /^(GET|POST) \/(api\/|events$)/.test(p)), 'page routes are /api/ and /events');
});

test('the gate reads the table, and a path the table does not list keeps the token of its prefix', async () => {
  const { office } = await room();
  const site = { port: 4391, agentToken: auth.newAgentToken(), pageToken: auth.newPageToken(), groupOf: office.core.groupOf };
  const q = (method, p, headers = {}) => auth.checkRequest({ method, path: p, headers: { host: '127.0.0.1:4391', 'content-type': 'application/json', ...headers } }, site);
  assert.equal(q('GET', '/').group, 'public');
  assert.equal(q('GET', '/office.js').group, 'public');
  assert.equal(q('POST', '/api/open').status, 401, 'a listed page route needs the page token');
  assert.equal(q('POST', '/api/open', { 'x-office-token': site.agentToken }).status, 401, 'the agent token does not open a page route');
  assert.equal(q('POST', '/hook/http', { 'x-office-token': site.pageToken }).status, 401, 'the page token does not open a hook');
  assert.equal(q('POST', '/api/not-a-route').status, 401, 'an unlisted path under /api/ still needs the page token');
  assert.equal(q('POST', '/hook/not-a-route').status, 401, 'an unlisted hook path still needs the agent token');
  assert.equal(q('GET', '/not-a-route').status, 404);
  assert.equal(q('POST', '/api/open', { 'x-office-token': site.pageToken }).ok, true);
  assert.equal(q('GET', '/hook/http', { 'x-office-token': site.agentToken }).ok, true, 'a method the table does not list falls back to the prefix rule, then 404 at handle');
});

test('the static routes serve the page, the DS and the vendored files; the favicon is a bare 204', async () => {
  const { call } = await room();
  const page = await call('/');
  assert.equal(page.status, 200); assert.equal(page.response.type, 'text/html; charset=utf-8');
  assert.match(page.response.body.toString('utf8'), /<title>/);
  const ico = await call('/favicon.ico');
  assert.deepEqual({ status: ico.status, bare: ico.response.bare }, { status: 204, bare: true });
  const files = staticFiles(REPO_ROOT);
  for (const [url, rel] of files) assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${url} -> ${rel} exists`);
  const css = await call('/office.css');
  assert.equal(css.response.type, 'text/css; charset=utf-8');
  const font = [...files.keys()].find((u) => u.endsWith('.woff2'));
  assert.equal((await call(font)).response.type, 'font/woff2');
  assert.equal((await call('/src/server.mjs')).status, 404, 'a path is only a key: source files are not served');
  assert.equal((await call('/vendor/fonts/%2e%2e/%2e%2e/src/server.mjs')).status, 404);
});

test('POST /launch refuses a code the office did not give, and /remote/signin needs a remote login', async () => {
  const { call } = await room();
  assert.equal((await call('/launch', { code: 'deadbeef' })).status, 401);
  assert.equal((await call('/remote/signin', {})).status, 404, 'no remote login: nothing to sign in');
});

test('the page feed: subscribe gives the whole snapshot first, and a state change sends a patch', async () => {
  const { office, call } = await room();
  const chunks = [];
  const stop = office.subscribe((c) => chunks.push(c));
  assert.match(chunks[0], /^data: \{/);
  assert.ok(JSON.parse(chunks[0].slice(6)).sessions, 'the first chunk is the whole snapshot');
  assert.equal((await call('/api/settings/focus', { on: true })).status, 200);
  await new Promise((r) => setTimeout(r, 250)); // the broadcast waits 100 ms to join changes
  assert.ok(chunks.length >= 2, 'a patch follows the change');
  stop();
  const n = chunks.length;
  await call('/api/settings/focus', { on: false });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(chunks.length, n, 'a feed that stopped gets nothing');
});
