// The orientation company step (#199): create the company in the Paperclip the office runs or the user connected. The route sends it
// through the HQ writer (#198: the write grid's Company cell, then the ask-first 'write'), refuses while the first account or the board key
// still waits for the user, writes one company and nothing else, and connects the HQ to it. Paperclip is the fake (test/fixtures/fake-paperclip.mjs) and the runtime a stand-in. No paid call.
// Run: node --test test/orientation-company.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { startFakePaperclip } from './fixtures/fake-paperclip.mjs';
import { companyDraft, createHq } from '../src/paperclip.mjs';

let base, rig, pc;
const st = { state: 'running', reason: '', version: '2026.1106.0', installed: true, mode: 'own', url: '', port: 0, bootstrap: 'pending', inviteUrl: '', key: { state: 'none', reason: '', expiresAt: null, approvalUrl: '' }, steps: [] };
const stand = { status: () => st, key: () => 'pcp_board_' + 'a'.repeat(40), keyFor: () => null, resume: async () => st, killNow() {}, connectExisting: async () => st };
const page = (route, body = {}) => rig.call(route, body);

before(async () => {
  pc = await startFakePaperclip({ companies: [] });
  Object.assign(st, { url: pc.url, port: Number(new URL(pc.url).port) });
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-orient-co-'));
  rig = await startInProcess({ dir: base, port: 4392, runtime: stand });
  rig.office.own(); rig.office.claim();
});
after(async () => { if (rig) rig.stop(); if (pc) await pc.close(); if (base) await removeTree(base); });
const posts = () => pc.requests.filter((r) => r.method === 'POST');

test('companyDraft names the company and says its building kind; a bad kind falls back to General, a bad name is refused', () => {
  const d = companyDraft({ name: '  Acme  ', archetype: 'software' });
  assert.equal(d.name, 'Acme');
  assert.match(d.description, /Software product/);
  assert.equal(companyDraft({ name: 'X', archetype: 'nope' }).archetype, 'general');
  assert.throws(() => companyDraft({ name: '   ' }), (e) => e.status === 400);
  assert.throws(() => companyDraft({ name: 'x'.repeat(81) }), (e) => e.status === 400);
});

test('the route is a page route', () => {
  assert.equal(rig.office.core.groupOf('POST', '/api/paperclip/company'), 'page');
});

test('it waits while the first account is not made, and while the board key is not approved', async () => {
  let r = await page('/api/paperclip/company', { name: 'Acme', confirmed: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /first account/);
  Object.assign(st, { bootstrap: 'ready' });
  r = await page('/api/paperclip/company', { name: 'Acme', confirmed: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /board key/);
  assert.deepEqual(posts(), [], 'nothing was written');
});

test('it asks first with the exact company, then writes one POST and connects the HQ', async () => {
  st.key = { state: 'ready', reason: '', expiresAt: null, approvalUrl: '' };
  const ask = await page('/api/paperclip/company', { name: 'Acme', archetype: 'software' });
  assert.equal(ask.status, 409);
  assert.equal(ask.json.confirm, 'write');
  assert.deepEqual([ask.json.write.kind, ask.json.write.action, ask.json.write.summary], ['company', 'create', 'Create the company "Acme"']);
  assert.match(ask.json.error, /Paperclip at http:\/\/127\.0\.0\.1:\d+\?/);
  assert.deepEqual(posts(), [], 'the ask writes nothing');
  const done = await page('/api/paperclip/company', { name: 'Acme', archetype: 'software', confirmed: true });
  assert.equal(done.status, 200);
  assert.equal(done.json.existed, false);
  assert.deepEqual(posts().map((r) => `${r.method} ${r.path}`), ['POST /api/companies']);
  assert.equal(posts()[0].body.name, 'Acme');
  assert.equal(done.json.hq.company.name, 'Acme');
  assert.equal(rig.snapshot().hq.company.name, 'Acme');
});

test('a connected company is not made twice', async () => {
  const n = posts().length;
  const r = await page('/api/paperclip/company', { name: 'Acme', confirmed: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already/);
  assert.equal(posts().length, n);
});

test('the first company is a write of hq.write: the grid decides, a name that exists is reused, an address that is not loopback is refused', async () => {
  let grid = {};
  const hq = createHq({ onChange() {}, onFeed() {}, grid: () => grid });
  const w = (b, o) => hq.write({ kind: 'company', action: 'create', url: pc.url, description: 'x', ...b }, o);
  const n = posts().length;
  const r = await w({ name: 'Acme' });
  assert.equal(r.existed, true, 'a name that exists is reused with no question and no write');
  assert.equal(posts().length, n, 'no POST for a name that exists');
  await assert.rejects(w({ name: 'B', url: 'http://10.0.0.5:3100' }), (e) => e.status === 400);
  await assert.rejects(w({ name: 'Beta' }), (e) => e.status === 409 && e.confirm === 'write', 'Confirm by default: it asks first');
  assert.equal(posts().length, n, 'the ask writes nothing');
  grid = { company: 'deny' };
  await assert.rejects(w({ name: 'Beta' }, { confirmed: true }), (e) => e.status === 403, 'Deny refuses, also with a confirmation');
  assert.equal(posts().length, n);
  grid = { company: 'allow' };
  const made = await w({ name: 'Beta', description: 'y' });
  assert.equal(made.existed, false);
  assert.ok(made.id);
  assert.equal(posts().length, n + 1, 'Allow sends with no question');
  grid = {};
  const made2 = await w({ name: 'Gamma' }, { confirmed: true });
  assert.equal(made2.name, 'Gamma');
  assert.equal(posts().length, n + 2);
});
