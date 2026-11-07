// The Paperclip runtime through the office core (#193), in process: the routes are page routes, install asks first (409 with the
// ask-first body) and runs only with confirmed: true, start and stop keep the user's wish in state.json (the runtime comes back with the
// office), the snapshot carries the status and never a key, an error of the runtime is the route's error, and the office hands the
// runtime to the adapter that ends it at exit. The runtime is a stand-in here (its own rules are in test/paperclip-runtime.test.mjs).
// Run: node --test test/paperclip-runtime-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { officeFiles } from '../src/files.mjs';
import { runtimeError } from '../src/paperclip-runtime.mjs';

let base, rig, rt;
const PORT = 4391;
const secretKey = 'pcp_board_' + 'e'.repeat(40);
function standIn() {
  const x = { calls: [], st: { state: 'off', reason: '', version: '2026.1106.0', installed: false, url: 'http://127.0.0.1:3100', port: 3100, bootstrap: null, inviteUrl: '', key: { state: 'none', reason: '', expiresAt: null, approvalUrl: '' }, steps: ['Install Paperclip.'] }, fail: null };
  const act = (name, next) => async () => { x.calls.push(name); if (x.fail) throw x.fail; Object.assign(x.st, next); return x.st; };
  Object.assign(x, {
    status: () => x.st, install: act('install', { state: 'stopped', installed: true }), start: act('start', { state: 'running' }), stop: act('stop', { state: 'stopped' }),
    connectKey: act('key', { key: { state: 'waiting', reason: '', expiresAt: null, approvalUrl: 'http://127.0.0.1:3100/cli-auth/x' } }),
    resume: async (enabled) => { x.calls.push('resume:' + enabled); return x.st; }, killNow() { x.calls.push('killNow'); }, key: () => secretKey,
  });
  return x;
}
const page = (route, body = {}) => rig.call(route, body);

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-prt-routes-'));
  rt = standIn();
  rig = await startInProcess({ dir: base, port: PORT, runtime: rt });
  rig.office.own(); rig.office.claim();
});
after(async () => {
  if (rig) rig.stop();
  if (base) await removeTree(base);
});

test('the runtime routes are page routes: the agent token does not open them', () => {
  for (const [m, r] of [['GET', '/api/paperclip/runtime'], ['POST', '/api/paperclip/runtime/install'], ['POST', '/api/paperclip/runtime/start'], ['POST', '/api/paperclip/runtime/stop'], ['POST', '/api/paperclip/runtime/key']]) {
    assert.equal(rig.office.core.groupOf(m, r), 'page', r);
  }
});

test('GET gives the status, and the snapshot carries it', async () => {
  const r = await rig.call('/api/paperclip/runtime');
  assert.equal(r.status, 200);
  assert.equal(r.json.runtime.state, 'off');
  assert.equal(rig.snapshot().paperclipRuntime.state, 'off');
});

test('install asks first: 409 with the ask-first body and no install; with confirmed: true it installs', async () => {
  const ask = await page('/api/paperclip/runtime/install', {});
  assert.equal(ask.status, 409);
  assert.equal(ask.json.confirm, 'runtime');
  assert.match(ask.json.error, /Install Paperclip 2026\.1106\.0 from npm/);
  assert.match(ask.json.error, /SHA-512/);
  assert.deepEqual(rt.calls, []);
  const done = await page('/api/paperclip/runtime/install', { confirmed: true });
  assert.equal(done.status, 200);
  assert.equal(done.json.runtime.installed, true);
  assert.deepEqual(rt.calls, ['install']);
  assert.equal(rig.snapshot().paperclipRuntime.installed, true, 'the snapshot follows');
});

test('start keeps the wish in state.json; stop removes it', async () => {
  const state = () => JSON.parse(fs.readFileSync(officeFiles(base, PORT).state, 'utf8'));
  assert.equal((await page('/api/paperclip/runtime/start')).status, 200);
  assert.deepEqual(state().paperclipRuntime, { enabled: true });
  assert.equal((await page('/api/paperclip/runtime/stop')).status, 200);
  assert.equal(state().paperclipRuntime, undefined);
  assert.deepEqual(rt.calls.slice(-2), ['start', 'stop']);
});

test('the key route starts the approval and answers the status, never the key', async () => {
  const r = await page('/api/paperclip/runtime/key');
  assert.equal(r.status, 200);
  assert.equal(r.json.runtime.key.state, 'waiting');
  assert.equal(r.json.runtime.key.approvalUrl, 'http://127.0.0.1:3100/cli-auth/x');
  const everything = JSON.stringify([r.json, rig.snapshot()]);
  assert.ok(!everything.includes(secretKey), 'no answer and no snapshot carries the board key');
  assert.ok(!/pcp_board_/.test(everything));
});

test('an error of the runtime is the route\'s status and words', async () => {
  rt.fail = runtimeError(409, 'A Paperclip already runs at http://127.0.0.1:3100.');
  const r = await page('/api/paperclip/runtime/start');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already runs/);
  rt.fail = null;
  const failed = JSON.stringify(rt.calls);
  assert.ok(failed.includes('start'));
});

test('the office hands its runtime to the adapter, and resume gives it the saved wish', async () => {
  assert.equal(rig.office.runtime, rt);
  rt.calls.length = 0;
  rig.office.resume();
  await new Promise((r) => setImmediate(r));
  assert.ok(rt.calls.includes('resume:false'), 'no wish saved after stop: it stays off');
});
