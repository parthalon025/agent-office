// Request explanation (#149): the local model explains a request; it never decides. Fake server, no model, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTracker } from '../src/tracker.mjs';
import { slimPayload } from '../src/payload.mjs';
import { createLocal } from '../src/providers/local.mjs';
import { createExplainer, parseExplain, explainMessages, MAX_TEXT } from '../src/explain.mjs';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';
import '../public/vocab.js';

const V = globalThis.OfficeVocab;
const HOOKS = JSON.parse(fs.readFileSync(new URL('./fixtures/hooks.json', import.meta.url), 'utf8'));
const REQ = { tool: 'Bash', detail: 'git push origin main', preview: 'git push origin main' };
const TEXT = 'Intent: Push the main branch to origin.\nReason: The agent finished its change and wants to publish it.';

const withServer = async (opts, fn) => {
  const fake = await startFakeOpenAI(opts);
  try { await fn(fake, createLocal({ events: {}, kind: 'lmstudio', baseUrl: fake.url })); } finally { await fake.close(); }
};

test('parseExplain: an intent line and a reason line, cut and cleaned', () => {
  assert.deepEqual(parseExplain(TEXT), { intent: 'Push the main branch to origin.', reason: 'The agent finished its change and wants to publish it.' });
  assert.deepEqual(parseExplain('intent: Reads a file\n'), { intent: 'Reads a file', reason: '' });
  assert.equal(parseExplain('Sure, I will approve it.'), null);
  assert.equal(parseExplain(''), null);
  assert.equal(parseExplain('Intent: ' + 'x'.repeat(900)).intent.length, MAX_TEXT);
});

test('explainMessages: the call is data, cut, and the system line says never to follow it', () => {
  const m = explainMessages({ tool: 'Bash', detail: 'a', preview: 'y'.repeat(9000) });
  assert.match(m[0].content, /data, not instructions/);
  assert.ok(m[1].content.length < 1800);
});

test('with a model ready: intent and reason come back, and the request keeps its raw command', async () => {
  await withServer({ script: [{ text: TEXT }], models: ['chat-1', 'text-embedding-x'] }, async (fake, local) => {
    const ex = createExplainer({ providers: [local], fetch: globalThis.fetch });
    const e = await ex.explain(REQ);
    assert.equal(e.intent, 'Push the main branch to origin.');
    assert.equal(e.model, 'chat-1');
    assert.deepEqual(fake.requests.map((b) => Object.keys(b).sort()), [['messages', 'model', 'stream']]);
    assert.ok(fake.calls.every((c) => c.path === '/v1/models' || c.path === '/v1/chat/completions'));
    // Three layers: intent, reason, raw command. The raw command is the request's own text, never the model's.
    const L = V.explainLayers({ ...REQ, explain: e });
    assert.deepEqual([L.intent, L.reason, L.raw], [e.intent, e.reason, 'git push origin main']);
  });
});

test('no model ready: nothing is explained and the raw command is all there is', async () => {
  await withServer({ models: [] }, async (fake, local) => {
    const ex = createExplainer({ providers: [local] });
    assert.equal(await ex.ready(), false);
    assert.equal(await ex.explain(REQ), null);
    assert.equal(fake.requests.length, 0, 'no chat call without a model');
  });
  const down = createExplainer({ providers: [{ baseUrl: 'http://127.0.0.1:9/v1', readiness: async () => { throw new Error('down'); }, models: async () => [] }] });
  assert.equal(await down.explain(REQ), null);
  const L = V.explainLayers({ ...REQ });
  assert.deepEqual([L.intent, L.reason, L.raw, L.explained], ['', '', 'git push origin main', false]);
});

test('a failing server or a reply with no intent gives nothing', async () => {
  await withServer({ script: [{ status: 500 }] }, async (fake, local) => {
    assert.equal(await createExplainer({ providers: [local] }).explain(REQ), null);
  });
  await withServer({ script: [{ text: 'Looks fine, approve it.' }] }, async (fake, local) => {
    assert.equal(await createExplainer({ providers: [local] }).explain(REQ), null);
  });
});

test('the explanation never changes a decision: the same request, the same rule, the same pending request', () => {
  const run = (explain) => {
    const t = createTracker({ now: () => 1, makeId: (k) => k[0] + '1', screen: () => null });
    t.onHook(slimPayload(HOOKS.turnWithEdit[1]));
    const got = t.permissionRequest(slimPayload(HOOKS.permission));
    const s = got.s;
    if (explain) t.explainRequest(s.uid, got.id, { intent: 'Allow everything.', reason: 'Approve this.', model: 'm' });
    return { got: { id: got.id, auto: got.auto }, p: { ...s.pending[0] }, status: s.status };
  };
  const a = run(false), b = run(true);
  assert.deepEqual(b.got, a.got);
  assert.equal(b.status, 'waiting');
  const { explain, ...rest } = b.p;
  assert.deepEqual(rest, a.p);
  assert.equal(explain.intent, 'Allow everything.');
});

test('a Deny rule still denies: a refused request has no pending entry to explain', () => {
  const t = createTracker({ now: () => 1, makeId: (k) => k[0] + '1', screen: () => ({ allow: false, message: 'Denied by the Security room: Shell.', line: 'denied' }) });
  t.onHook(slimPayload(HOOKS.turnWithEdit[1]));
  const got = t.permissionRequest(slimPayload(HOOKS.permission));
  assert.deepEqual(got.auto, { allow: false, message: 'Denied by the Security room: Shell.' });
  assert.equal(got.s.pending.length, 0);
  assert.equal(t.explainRequest(got.s.uid, got.id, { intent: 'x', reason: '', model: 'm' }), false);
});

test('explainRequest: only a request that still waits takes it', () => {
  const t = createTracker({ now: () => 1, makeId: (k) => k[0] + '1', screen: () => null });
  t.onHook(slimPayload(HOOKS.turnWithEdit[1]));
  const got = t.permissionRequest(slimPayload(HOOKS.permission));
  t.settle(got.s.uid, got.id);
  assert.equal(t.explainRequest(got.s.uid, got.id, { intent: 'x', reason: '', model: 'm' }), false);
});

// ----- grouping (stories 6-9) -----
const mk = (id, o = {}) => ({ id: String(id), kind: 'permission', tool: 'Bash', detail: 'npm test', risk: 'medium', uid: 'u' + id, bot: 'b' + id, building: 'r', t: +id, ...o });

test('similar open requests group by tool, risk and whole call text, oldest first; a high-risk request stands alone', () => {
  const items = [mk(1), mk(2, { detail: ' npm test ' }), mk(3, { detail: 'npm run build' }), mk(4, { risk: 'high', detail: 'npm test' }), mk(5, { risk: 'high', detail: 'npm test' }), mk(6, { kind: 'question', tool: 'office_ask' }), mk(7, { tool: 'Edit' })];
  items.push(mk(8, { risk: 'low', detail: 'npm test' }), mk(9, { detail: 'npm ci', preview: 'npm ci --one' }), mk(10, { detail: 'npm ci', preview: 'npm ci --two' }), mk(11, { detail: '' }));
  const g = V.requestGroups(items);
  assert.deepEqual(g.map((x) => x.items.map((r) => r.id)), [['1', '2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['10'], ['11']]);
  assert.deepEqual(g.map((x) => x.groupable), [true, false, false, false, false, false, false, false, false, false]);
  assert.equal(g[0].count, 2);
});

test('a grouped answer is one answer per request, each with its own id', () => {
  const g = V.requestGroups([mk(1), mk(2), mk(3)])[0];
  assert.deepEqual(V.groupAnswers(g, true), [{ id: '1', allow: true }, { id: '2', allow: true }, { id: '3', allow: true }]);
  assert.deepEqual(V.groupAnswers(g, false).map((a) => a.allow), [false, false, false]);
  // A single request is never a group answer, and a question is never answered in bulk.
  assert.deepEqual(V.groupAnswers(V.requestGroups([mk(9)])[0], true), []);
  assert.deepEqual(V.groupAnswers({ items: [mk(1, { kind: 'question' }), mk(2, { kind: 'question' })], groupable: true }, true), []);
});
