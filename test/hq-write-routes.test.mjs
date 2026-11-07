// The HQ write grid and the writer (#198) through a real server.mjs: GET /api/hq/grid, POST /api/hq/grid/set (a looser change is 409 until
// confirmed, a secret never takes Allow, the cells the user set are kept in state.json), and POST /api/hq/write (Allow sends, Deny is 403,
// Confirm is the ask-first 409 until the same call comes confirmed). Only the page token reaches these routes. The server runs from a
// throwaway copy on a free port; Paperclip is the fake in test/fixtures/fake-paperclip.mjs. No Claude Code runs and nothing is paid for.
// Run: node --test test/hq-write-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageFile } from '../src/auth.mjs';
import { officeFiles } from '../src/files.mjs';
import { startOnFreePort, until, copyOffice } from './fixtures/office-server.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';

let base, copy, office, port, env, agentToken, pageToken, pc;
const D = DEMO(), ISSUE = D.issues[0].id, APPROVAL = D.approvals[0].id, ADA = D.agents[1].id, CO = D.companies[0].id;

const call = (route, body, token = pageToken, method = 'POST') => fetch(`http://127.0.0.1:${port}${route}`, {
  method, headers: { 'content-type': 'application/json', 'x-office-token': token }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
}).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json }; });
const get = (route) => call(route, null, pageToken, 'GET');
const state = () => JSON.parse(fs.readFileSync(officeFiles(copy, port).state, 'utf8'));
const writes = () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').map((r) => [r.method, r.path, r.body]);

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hqw-'));
  copy = path.join(base, 'office');
  for (const d of [copy, path.join(base, 'home')]) fs.mkdirSync(d);
  copyOffice(copy);
  pc = await startFakePaperclip();
  const started = await startOnFreePort(copy, { ...process.env, OFFICE_OPEN: '0', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: path.join(base, 'home'), HOME: path.join(base, 'home') });
  ({ office, port, env } = started);
  await office.done;
  agentToken = JSON.parse(fs.readFileSync(officeFiles(copy, port).token, 'utf8')).token;
  pageToken = JSON.parse(fs.readFileSync(pageFile(env, port), 'utf8')).token;
});
after(async () => {
  if (office) await office.stop();
  if (pc) await pc.close();
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test('not connected: a write is 409 and nothing is sent', async () => {
  const r = await call('/api/hq/write', { kind: 'comment', action: 'add', issue: ISSUE, text: 'Hi' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not connected/);
  assert.equal(pc.requests.length, 0);
});

test('the grid: twelve kinds, the defaults, and no cell saved until the user sets one', async () => {
  const r = await get('/api/hq/grid');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.grid.map((x) => [x.kind, x.value, x.set]), [['hire', 'confirm', false], ['pause', 'confirm', false], ['budget', 'confirm', false], ['approval', 'confirm', false], ['reporting', 'confirm', false],
    ['routine', 'confirm', false], ['access', 'confirm', false], ['secret', 'confirm', false], ['task', 'allow', false], ['comment', 'allow', false], ['company', 'confirm', false], ['goal', 'confirm', false]]);
  assert.deepEqual(r.json.grid.find((x) => x.kind === 'secret').options, ['confirm', 'deny']);
  assert.deepEqual(state().hqGrid || {}, {});
});

test('connect, then the defaults: a comment sends at once, an approval is the ask-first question until confirmed', async () => {
  assert.equal((await call('/api/paperclip/connect', { url: pc.url })).status, 200);
  await until(async () => (await get('/api/paperclip')).json.hq?.state === 'on', 'the live events');
  const ok = await call('/api/hq/write', { kind: 'comment', action: 'add', issue: ISSUE, text: 'Looks good.' });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.deepEqual(writes(), [['POST', `/api/issues/${ISSUE}/comments`, { body: 'Looks good.' }]]);

  const body = { kind: 'approval', action: 'approve', approval: APPROVAL };
  const q = await call('/api/hq/write', body);
  assert.equal(q.status, 409);
  assert.equal(q.json.confirm, 'write');
  assert.match(q.json.error, /^Approve an approval in Acme Robotics\? /);
  assert.deepEqual(q.json.write, { kind: 'approval', action: 'approve', summary: 'Approve an approval' });
  assert.equal(writes().length, 1, 'the question sent nothing');
  const yes = await call('/api/hq/write', { ...body, confirmed: true });
  assert.deepEqual([yes.status, yes.json], [200, { ok: true }]);
  assert.deepEqual(writes().at(-1), ['POST', `/api/approvals/${APPROVAL}/approve`, {}]);
});

test('a task create answers with its id; a bad write is 400', async () => {
  const r = await call('/api/hq/write', { kind: 'task', action: 'create', title: 'Fix the build', assigneeAgentId: ADA });
  assert.equal(r.status, 200);
  assert.match(r.json.id, /^i2000000/);
  assert.deepEqual(writes().at(-1), ['POST', `/api/companies/${CO}/issues`, { title: 'Fix the build', assigneeAgentId: ADA }]);
  const n = writes().length;
  for (const b of [{}, { kind: 'task', action: 'create' }, { kind: 'hire', action: 'create' }, { kind: 'comment', action: 'add', issue: '../x', text: 'x' }]) {
    assert.equal((await call('/api/hq/write', b)).status, 400, JSON.stringify(b));
  }
  assert.equal(writes().length, n);
});

test('changing a cell: stricter at once, looser only with the painted Confirm, a secret never Allow; only set cells are saved', async () => {
  const deny = await call('/api/hq/grid/set', { kind: 'comment', value: 'deny' });
  assert.deepEqual([deny.status, deny.json.from, deny.json.to], [200, 'allow', 'deny']);
  assert.equal(deny.json.grid.find((x) => x.kind === 'comment').set, true);
  assert.deepEqual(state().hqGrid, { comment: 'deny' });
  const n = writes().length;
  const refused = await call('/api/hq/write', { kind: 'comment', action: 'add', issue: ISSUE, text: 'Again' });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /Denied by the HQ write grid: Comments\./);
  assert.equal(writes().length, n);

  const loose = await call('/api/hq/grid/set', { kind: 'comment', value: 'allow' });
  assert.equal(loose.status, 409);
  assert.deepEqual(state().hqGrid, { comment: 'deny' }, 'a refused change saves nothing');
  assert.equal((await call('/api/hq/grid/set', { kind: 'comment', value: 'allow', confirmed: true })).status, 200);
  assert.equal((await call('/api/hq/write', { kind: 'comment', action: 'add', issue: ISSUE, text: 'Again' })).status, 200);
  for (const c of [{ kind: 'secret', value: 'allow', confirmed: true }, { kind: 'nope', value: 'deny' }, { kind: 'task', value: 'maybe' }]) {
    assert.equal((await call('/api/hq/grid/set', c)).status, 400, JSON.stringify(c));
  }
  assert.equal((await call('/api/hq/grid/set', { kind: 'comment', value: null })).status, 200, 'Use default');
  assert.deepEqual(state().hqGrid || {}, {});
});

test('only the page token reaches the grid and the writer; the agent token does not', async () => {
  for (const [route, body] of [['/api/hq/write', { kind: 'comment', action: 'add', issue: ISSUE, text: 'Hi' }], ['/api/hq/grid/set', { kind: 'task', value: 'deny' }]]) {
    const r = await call(route, body, agentToken);
    assert.ok(r.status === 401 || r.status === 403, `${route}: ${r.status}`);
  }
  assert.equal((await call('/api/hq/grid', null, agentToken, 'GET')).status === 200, false);
});
