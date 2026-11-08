// The HQ write kinds (#232): one file per kind in src/hq-writes/, and one writer pipeline that names no kind.
// - The table: every kind against its own samples (the exact method, path and body each action plans, byte for byte; what Paperclip
//   must name in its answer; the ids the write returns), its grid row, and that a kind file never reaches the network by itself.
// - The pipeline: hq.write with a stand-in kind (createHq deps.writeKinds) against the fake Paperclip: Deny, Confirm, Allow, the target
//   check, `before`, a busy employee, the feed line, and an answer that lacks what the kind expects (502).
// No Paperclip is real, nothing is paid for. Run: node --test test/hq-writes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/ask.js';
import { askFirst } from '../src/office-core.mjs';
import { createHq } from '../src/paperclip.mjs';
import { KINDS, WRITE_KINDS, planWrite, problemOf, resultOf } from '../src/hq-writes/index.mjs';
import { RULES, SAMPLE } from '../src/hq-writes/shared.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- the table: every kind against its samples ----------

test('every kind has a grid row: a label, the values it offers and a default it offers; the index lists each kind once', () => {
  assert.equal(new Set(KINDS.map((k) => k.kind)).size, KINDS.length);
  assert.deepEqual(Object.keys(WRITE_KINDS), KINDS.map((k) => k.kind), 'the grid order is the order of the index');
  for (const k of KINDS) {
    assert.ok(typeof k.label === 'string' && k.label, k.kind);
    assert.ok(k.options.length >= 2 && k.options.every((o) => RULES.includes(o)), k.kind);
    assert.ok(k.options.includes(k.def), `${k.kind}: the default is a value it offers`);
    assert.ok(k.actions && typeof k.actions === 'object' && k.samples && typeof k.samples === 'object', k.kind);
  }
});

test('every action of every kind has a sample, and every sample is an action', () => {
  for (const k of KINDS) assert.deepEqual(Object.keys(k.samples).sort(), Object.keys(k.actions).sort(), k.kind);
  assert.ok(KINDS.filter((k) => Object.keys(k.actions).length).length >= 15, 'every kind but the secret has a write');
});

test('each sample plans its exact request: method, path and body, byte for byte', () => {
  let n = 0;
  for (const k of KINDS) {
    for (const [action, s] of Object.entries(k.samples)) {
      const at = `${k.kind}/${action}`;
      assert.deepEqual([s.body.kind, s.body.action], [k.kind, action], at);
      const plan = planWrite(s.body);
      assert.deepEqual({ method: plan.method, path: plan.path(SAMPLE.co), body: plan.body }, s.request, at);
      assert.equal(JSON.stringify(plan.body), JSON.stringify(s.request.body), `${at}: the same keys in the same order`);
      assert.ok(typeof plan.summary === 'string' && plan.summary, `${at}: a summary for the Confirm and the feed`);
      assert.ok(Array.isArray(plan.targets), at);
      n += 1;
    }
  }
  assert.ok(n >= 30, `${n} samples`);
});

test('each sample answer gives the ids the write returns, and an answer that names nothing is refused where the kind expects a name', async () => {
  for (const k of KINDS) {
    for (const [action, s] of Object.entries(k.samples)) {
      const at = `${k.kind}/${action}`, plan = planWrite(s.body);
      assert.equal(problemOf(plan, s.answer), null, `${at}: the sample answer names what the kind expects`);
      if (!('result' in s)) { assert.equal(typeof k.send, 'function', `${at}: only a kind with its own send leaves its result to the writer tests`); continue; }
      if (k.send) {
        // a kind that sends its own way, run against a stand-in context that answers the sample
        const feed = [];
        const ctx = { company: 'Acme', companyId: SAMPLE.co, confirm() {}, connected: () => true, feed: (t) => feed.push(t), request: async (body) => { assert.deepEqual(body, s.request.body, at); return s.answer; } };
        assert.deepEqual(await k.send(plan, ctx), s.result, at);
        assert.equal(feed.length, 1, `${at}: one feed line`);
      } else {
        assert.deepEqual(resultOf(plan, s.answer), s.result, at);
        if (s.result.id !== undefined) assert.ok(problemOf(plan, {}), `${at}: Paperclip that names no id is a problem, not a result`);
      }
      assert.doesNotMatch(JSON.stringify(s.result || {}), /never-shown|pcp_/, `${at}: no token or link of the answer in the result`);
    }
  }
});

test('a kind file reaches Paperclip only through the writer: no fetch, no socket, no import of the watcher', () => {
  const dir = path.join(ROOT, 'src', 'hq-writes');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /\bfetch\(|WebSocket|node:(http|https|net|fs|child_process)|paperclip\.mjs'/, f);
  }
});

test('write() names no kind: the pipeline reads what differs from the kind', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'paperclip.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('\n  async function write(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\n  }\n', at));
  assert.doesNotMatch(body, /\.kind\s*===|\.action\s*===|\.fill\b|\.bundle\b/);
  for (const k of KINDS) assert.doesNotMatch(body, new RegExp(`['"\`]${k.kind}['"\`]`), `write() names ${k.kind}`);
});

// ---------- the pipeline, with a stand-in kind ----------

const D = DEMO();
const ADA = D.agents[1].id, KEY = 'board-key-0123456789abcdef';
const issues = (co) => `/api/companies/${encodeURIComponent(co)}/issues`;
// A stand-in kind: it plans a task create (a route the fake serves), checks its employee, and has a `before` that answers with no write
// (skip), one that changes the summary (every other action), an action whose answer lacks what it expects (strict) and one that marks
// its employee busy (busy).
const PROBE = {
  kind: 'probe', label: 'Probes', options: RULES, def: 'confirm',
  actions: {
    poke: (b) => ({ method: 'POST', path: issues, body: { title: b.title }, targets: b.agent ? [{ type: 'agent', id: b.agent }] : [], summary: `Poke "${b.title}"` }),
    strict: (b) => ({ method: 'POST', path: issues, body: { title: b.title }, targets: [], summary: 'Poke strictly' }),
    skip: () => ({ method: 'POST', path: issues, body: { title: 'never' }, targets: [], summary: 'Skip' }),
    busy: (b) => ({ method: 'POST', path: issues, body: { title: b.title }, targets: [{ type: 'agent', id: b.agent }], summary: `Busy "${b.title}"` }),
  },
  async before(plan, ctx) {
    if (plan.action === 'skip') { ctx.feed('Probe: nothing to send.'); return { ok: true, skipped: true }; }
    plan.summary = `${plan.summary}, checked`;
    return undefined;
  },
  busy: (plan) => (plan.action === 'busy' ? plan.targets[0].id : null),
  expect: (plan, made) => (plan.action === 'strict' && !made.probeId ? 'Paperclip did not name the probe' : ''),
  result: (plan, made) => ({ id: String(made.id) }),
  samples: {},
};

async function rig(grid) {
  const pc = await startFakePaperclip({ ...DEMO(), boardKey: KEY });
  const feed = [];
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, grid: () => grid, askFirst, writeKinds: [PROBE], onFeed: (t, k) => feed.push([k, t]) });
  await hq.connect({ url: pc.url });
  await until(() => hq.state() === 'on', 'the events socket');
  const writes = () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').map((r) => [r.method, r.path, r.body]);
  return { pc, hq, feed, writes, done: async () => { hq.disconnect(); await pc.close(); } };
}

test('pipeline: Deny refuses with 403 and the label of the kind, sends nothing, and leaves a feed line', async () => {
  const r = await rig({ probe: 'deny' });
  try {
    for (const confirmed of [false, true]) await assert.rejects(r.hq.write({ kind: 'probe', action: 'poke', title: 'A' }, { confirmed }), (e) => e.status === 403 && e.message === 'Denied by the HQ write grid: Probes.');
    assert.deepEqual(r.writes(), []);
    assert.deepEqual(r.feed.filter(([, t]) => /Probes/.test(t)), [['wait', 'Refused by the HQ write grid: Probes. Nothing was sent.'], ['wait', 'Refused by the HQ write grid: Probes. Nothing was sent.']]);
    await assert.rejects(r.hq.write({ kind: 'task', action: 'create', title: 'T' }), (e) => e.status === 400, 'a kind this writer does not know is 400');
  } finally { await r.done(); }
});

test('pipeline: Confirm asks with the summary `before` made, sends nothing, then sends one request when the same call comes confirmed', async () => {
  const r = await rig({});
  try {
    const e = await r.hq.write({ kind: 'probe', action: 'poke', title: 'A', agent: ADA }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.deepEqual(e.answer.body, { error: e.message, confirm: 'write', write: { kind: 'probe', action: 'poke', summary: 'Poke "A", checked' } });
    assert.equal(e.message, 'Poke "A", checked in Acme Robotics? The office sends this one change to Paperclip and nothing else.');
    assert.deepEqual(r.writes(), [], 'nothing before the yes');
    const ok = await r.hq.write({ kind: 'probe', action: 'poke', title: 'A', agent: ADA }, { confirmed: true });
    assert.match(ok.id, /^i2000000/);
    assert.deepEqual(Object.keys(ok), ['ok', 'id']);
    assert.deepEqual(r.writes(), [['POST', `/api/companies/${D.companies[0].id}/issues`, { title: 'A' }]]);
  } finally { await r.done(); }
});

test('pipeline: Allow sends at once and the feed says what was written; a stranger target is 404 before anything is asked', async () => {
  const r = await rig({ probe: 'allow' });
  try {
    await r.hq.write({ kind: 'probe', action: 'poke', title: 'B' });
    assert.equal(r.writes().length, 1);
    assert.deepEqual(r.feed.at(-1), ['tool', 'Wrote to Acme Robotics: Poke "B", checked.']);
    await assert.rejects(r.hq.write({ kind: 'probe', action: 'poke', title: 'C', agent: 'a0000000-0000-4000-8000-000000000404' }), (e) => e.status === 404);
    assert.equal(r.writes().length, 1, 'the refused write sent nothing');
  } finally { await r.done(); }
});

test('pipeline: a `before` that answers ends the write: nothing is asked and nothing is sent, also under Confirm', async () => {
  const r = await rig({});
  try {
    assert.deepEqual(await r.hq.write({ kind: 'probe', action: 'skip' }), { ok: true, skipped: true });
    assert.deepEqual(r.writes(), []);
    assert.deepEqual(r.feed.at(-1), ['tool', 'Probe: nothing to send.']);
  } finally { await r.done(); }
});

test('pipeline: an answer without what the kind expects is 502 with a feed line, and no success line', async () => {
  const r = await rig({ probe: 'allow' });
  try {
    const before = r.feed.length;
    await assert.rejects(r.hq.write({ kind: 'probe', action: 'strict', title: 'D' }), (e) => e.status === 502 && e.message === 'Paperclip did not name the probe.');
    assert.equal(r.writes().length, 1, 'the request went out; its answer is what failed');
    assert.deepEqual(r.feed.slice(before), [['wait', 'Paperclip did not name the probe: Poke strictly, checked.']]);
  } finally { await r.done(); }
});

test('pipeline: a busy employee takes one change at a time, and is read again after the write', async () => {
  const r = await rig({ probe: 'allow' });
  try {
    const [one, two] = await Promise.allSettled([
      r.hq.write({ kind: 'probe', action: 'busy', title: 'E', agent: ADA }),
      r.hq.write({ kind: 'probe', action: 'busy', title: 'F', agent: ADA }),
    ]);
    assert.equal(one.status, 'fulfilled');
    assert.equal(two.status, 'rejected');
    assert.deepEqual([two.reason.status, two.reason.message], [409, 'The office is already changing this employee.']);
    assert.deepEqual(r.writes().map((w) => w[2].title), ['E']);
    const post = r.pc.requests.findIndex((x) => x.method === 'POST' && x.body && x.body.title === 'E');
    assert.ok(r.pc.requests.slice(post + 1).some((x) => x.method === 'GET' && x.path === `/api/agents/${ADA}`), 'the employee is read again after the write');
    assert.equal(r.hq.view().agents.find((a) => a.id === ADA).busy, false, 'and is free again');
  } finally { await r.done(); }
});
