// Employee management (#203, spec #191): pause, resume and let go of an employee, company and employee budgets, and self-approval per approval
// kind. Every write is a plan of the one HQ writer (hq.write) behind the write grid; the fake Paperclip records every request. Self-approval
// is a setting of the user, never for the hire or the budget kinds. No paid call. Run: node --test test/hq-employees.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../public/ask.js';
import { askFirst } from '../src/office-core.mjs';
import { createHq } from '../src/paperclip.mjs';
import { setSelfApproval, cleanSelfApproval, selfApprovalOn, SELF_APPROVAL_KINDS, NEVER_SELF_APPROVED } from '../src/hq-model.mjs';
import { planWrite, WRITE_KINDS } from '../src/hq-writes/index.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';

const D = DEMO(), CO = D.companies[0].id, GRACE = D.agents[0].id, ADA = D.agents[1].id, LINUS = D.agents[2].id;
const KEY = 'board-key-0123456789abcdef';
const fast = { refetchMs: 20, retryMs: [50, 50] };

async function rig(grid = {}, self = {}, seed = DEMO()) {
  const pc = await startFakePaperclip({ ...seed, boardKey: KEY });
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, grid: () => grid, selfApproval: () => self, askFirst, onFeed: (t, k) => feed.push([k, t]) });
  await hq.connect({ url: pc.url });
  await until(() => hq.state() === 'on', 'the events socket');
  const writes = () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').map((r) => [r.method, r.path, r.body]);
  return { pc, hq, feed, writes, done: async () => { hq.disconnect(); await pc.close(); } };
}
const agentOf = (r, id) => r.hq.view().agents.find((a) => a.id === id);

test('plan: pause, resume and let go are one POST each; budgets are one PATCH in whole cents', () => {
  assert.deepEqual([planWrite({ kind: 'pause', action: 'pause', agent: ADA })].map((p) => [p.method, p.path(CO), p.body]), [['POST', `/api/agents/${ADA}/pause`, {}]]);
  assert.equal(planWrite({ kind: 'pause', action: 'resume', agent: ADA }).path(CO), `/api/agents/${ADA}/resume`);
  const retire = planWrite({ kind: 'pause', action: 'retire', agent: ADA });
  assert.equal(retire.method, 'POST');
  assert.equal(retire.path(CO), `/api/agents/${ADA}/terminate`, 'terminate keeps the work and history; DELETE is never sent');
  assert.match(retire.summary, /its tasks and history stay/);
  const co = planWrite({ kind: 'budget', action: 'company', budgetDollars: 120.5 });
  assert.deepEqual([co.method, co.path(CO), co.body], ['PATCH', `/api/companies/${CO}/budgets`, { budgetMonthlyCents: 12050 }]);
  const ag = planWrite({ kind: 'budget', action: 'agent', agent: ADA, budgetDollars: 40 });
  assert.deepEqual([ag.method, ag.path(CO), ag.body], ['PATCH', `/api/agents/${ADA}/budgets`, { budgetMonthlyCents: 4000 }]);
  assert.deepEqual(ag.targets, [{ type: 'agent', id: ADA }]);
});

test('plan: a bad id or budget is 400, and no budget is ever removed', () => {
  for (const bad of [{ kind: 'pause', action: 'pause', agent: '../x' }, { kind: 'pause', action: 'pause' }, { kind: 'pause', action: 'delete', agent: ADA },
    { kind: 'budget', action: 'company', budgetDollars: 0 }, { kind: 'budget', action: 'company', budgetDollars: -1 }, { kind: 'budget', action: 'company', budgetDollars: '5' },
    { kind: 'budget', action: 'company', budgetDollars: 1e9 }, { kind: 'budget', action: 'agent', agent: ADA }, { kind: 'budget', action: 'agent', budgetDollars: 5 },
    { kind: 'budget', action: 'agent', agent: ADA, budgetDollars: 0.001 }]) {
    assert.throws(() => planWrite(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('self-approval rules: hire and budget kinds are never, turning one on needs the Confirm, junk is dropped', () => {
  assert.ok(NEVER_SELF_APPROVED.includes('hire_agent') && NEVER_SELF_APPROVED.includes('budget_override_required'));
  for (const type of [...NEVER_SELF_APPROVED, 'access', 'secret', 'nothing']) assert.throws(() => setSelfApproval({}, { type, value: true, confirmed: true }), (e) => e.status === 400, type);
  const t = SELF_APPROVAL_KINDS[0].type;
  assert.throws(() => setSelfApproval({}, { type: t, value: true }), (e) => e.status === 409);
  assert.throws(() => setSelfApproval({}, { type: t, value: 'yes', confirmed: true }), (e) => e.status === 400);
  const on = setSelfApproval({}, { type: t, value: true, confirmed: true });
  assert.deepEqual(on.slice, { [t]: true });
  assert.equal(selfApprovalOn(on.slice, t), true);
  assert.deepEqual(setSelfApproval(on.slice, { type: t, value: false }).slice, {}, 'turning off is stricter: no Confirm');
  assert.deepEqual(cleanSelfApproval({ hire_agent: true, budget_override_required: true, [t]: true, x: true, approve_ceo_strategy: 'yes' }), { [t]: true });
  assert.equal(selfApprovalOn({ hire_agent: true }, 'hire_agent'), false, 'a saved never-kind does not count');
  assert.equal(selfApprovalOn({ __proto__: { [t]: true } }, t), false);
});

test('writer: each management write waits for the Confirm, then sends one request and the view shows it', async () => {
  const r = await rig({});
  try {
    for (const body of [{ kind: 'pause', action: 'pause', agent: ADA }, { kind: 'budget', action: 'agent', agent: ADA, budgetDollars: 40 }, { kind: 'budget', action: 'company', budgetDollars: 99 }]) {
      const e = await r.hq.write(body).then(() => null, (x) => x);
      assert.equal(e.status, 409, JSON.stringify(body));
      assert.equal(e.answer.body.confirm, 'write');
    }
    assert.equal(r.writes().length, 0, 'nothing is sent before the yes');
    await r.hq.write({ kind: 'pause', action: 'pause', agent: ADA }, { confirmed: true });
    await until(() => agentOf(r, ADA).status === 'paused', 'the paused agent in the view');
    await r.hq.write({ kind: 'budget', action: 'agent', agent: ADA, budgetDollars: 40 }, { confirmed: true });
    await until(() => agentOf(r, ADA).budget.limit === 40, 'the new agent budget');
    await r.hq.write({ kind: 'budget', action: 'company', budgetDollars: 99 }, { confirmed: true });
    await r.hq.write({ kind: 'pause', action: 'resume', agent: ADA }, { confirmed: true });
    await until(() => agentOf(r, ADA).status === 'idle', 'the resumed agent');
    assert.deepEqual(r.writes(), [
      ['POST', `/api/agents/${ADA}/pause`, {}],
      ['PATCH', `/api/agents/${ADA}/budgets`, { budgetMonthlyCents: 4000 }],
      ['PATCH', `/api/companies/${CO}/budgets`, { budgetMonthlyCents: 9900 }],
      ['POST', `/api/agents/${ADA}/resume`, {}],
    ]);
    assert.ok(r.feed.some(([, t]) => /Wrote to Acme Robotics: Pause Ada/.test(t)), 'the feed names the employee');
    assert.ok(r.feed.some(([, t]) => /Set the budget of Ada to \$40\.00 a month/.test(t)));
  } finally { await r.done(); }
});

test('writer: let go ends the employee, keeps it in Paperclip, and never sends DELETE', async () => {
  const r = await rig({ pause: 'allow' });
  try {
    const out = await r.hq.write({ kind: 'pause', action: 'retire', agent: LINUS });
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(r.writes(), [['POST', `/api/agents/${LINUS}/terminate`, {}]]);
    assert.equal(r.pc.state.agents.find((a) => a.id === LINUS).status, 'terminated', 'the record stays with its status');
    assert.equal(r.pc.requests.some((x) => x.method === 'DELETE'), false);
    await assert.rejects(r.hq.write({ kind: 'pause', action: 'pause', agent: LINUS }), (e) => e.status === 404, 'a terminated employee is not in the company any more');
  } finally { await r.done(); }
});

test('writer: pause of a paused employee, resume of a working one, a stranger and Deny are refused before anything is sent', async () => {
  const r = await rig({ pause: 'allow', budget: 'deny' });
  try {
    await assert.rejects(r.hq.write({ kind: 'pause', action: 'resume', agent: ADA }), (e) => e.status === 409 && /not paused/.test(e.message));
    await r.hq.write({ kind: 'pause', action: 'pause', agent: ADA });
    await until(() => agentOf(r, ADA).status === 'paused', 'paused');
    await assert.rejects(r.hq.write({ kind: 'pause', action: 'pause', agent: ADA }), (e) => e.status === 409 && /already paused/.test(e.message));
    await assert.rejects(r.hq.write({ kind: 'pause', action: 'pause', agent: 'a0000000-0000-4000-8000-000000000404' }), (e) => e.status === 404);
    await assert.rejects(r.hq.write({ kind: 'budget', action: 'company', budgetDollars: 5 }, { confirmed: true }), (e) => e.status === 403 && /Budgets/.test(e.message));
    assert.equal(r.writes().length, 1, 'only the one pause went out');
    assert.ok(WRITE_KINDS.pause && WRITE_KINDS.budget, 'both are grid cells');
  } finally { await r.done(); }
});

test('self-approval: an employee approval of a kind the user turned on is approved by the writer; others wait', async () => {
  const t = SELF_APPROVAL_KINDS[0].type;
  const seed = DEMO();
  const mk = (id, type, by) => ({ id, companyId: CO, type, status: 'pending', requestedByAgentId: by, requestedByUserId: null, payload: { secret: 'x' }, createdAt: '2026-11-06T10:00:00.000Z' });
  seed.approvals = [mk('p3000000-0000-4000-8000-000000000001', t, ADA), mk('p3000000-0000-4000-8000-000000000002', 'hire_agent', ADA),
    mk('p3000000-0000-4000-8000-000000000003', t, null), mk('p3000000-0000-4000-8000-000000000004', 'approve_ceo_strategy', GRACE)];
  const self = { [t]: true, hire_agent: true };   // a saved hire_agent counts for nothing
  const r = await rig({}, self, seed);
  try {
    await until(() => r.writes().length >= 1, 'the self-approval');
    await new Promise((res) => setTimeout(res, 150));
    assert.deepEqual(r.writes(), [['POST', '/api/approvals/p3000000-0000-4000-8000-000000000001/approve', { decisionNote: 'Approved by the office: self-approval is on for this kind.' }]],
      'only the employee request of the allowed kind; not the hire, not a request of nobody, not another kind');
    assert.ok(r.feed.some(([, x]) => /Self-approval: Ada approved its own request board approval/.test(x)));
    assert.equal(r.pc.state.approvals.filter((a) => a.status === 'pending').length, 3);
  } finally { await r.done(); }
});

test('self-approval: the grid Deny for Approvals still wins, and the refusal is in the feed', async () => {
  const t = SELF_APPROVAL_KINDS[0].type, seed = DEMO();
  seed.approvals = [{ id: 'p3000000-0000-4000-8000-000000000001', companyId: CO, type: t, status: 'pending', requestedByAgentId: ADA, requestedByUserId: null, payload: {}, createdAt: '2026-11-06T10:00:00.000Z' }];
  const r = await rig({ approval: 'deny' }, { [t]: true }, seed);
  try {
    await until(() => r.feed.some(([, x]) => /Self-approval did not apply: Denied by the HQ write grid/.test(x)), 'the refusal');
    assert.equal(r.writes().length, 0);
  } finally { await r.done(); }
});

// ---- the routes of the office ----
let base, office, pc;
before(async () => {
  pc = await startFakePaperclip(DEMO());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-emp-'));
  office = await startInProcess({ dir: base, port: 4394 });
  office.office.own(); office.office.claim();
  assert.equal((await office.call('/api/paperclip/connect', { url: pc.url })).status, 200);
  await until(() => office.snapshot().hq && office.snapshot().hq.state === 'on', 'the HQ connected');
});
after(async () => { if (office) office.stop(); if (pc) await pc.close(); if (base) await removeTree(base); });

test('route: pause asks first through the one writer, then sends; the self-approval setting asks before it loosens', async () => {
  assert.equal(office.office.core.groupOf('POST', '/api/hq/self-approval/set'), 'page');
  const ask = await office.call('/api/hq/write', { kind: 'pause', action: 'pause', agent: GRACE });
  assert.equal(ask.status, 409);
  assert.match(ask.json.write.summary, /^Pause Grace$/);
  assert.equal(pc.requests.filter((x) => x.method === 'POST').length, 0);
  assert.equal((await office.call('/api/hq/write', { kind: 'pause', action: 'pause', agent: GRACE, confirmed: true })).status, 200);
  assert.ok(pc.requests.some((x) => x.method === 'POST' && x.path === `/api/agents/${GRACE}/pause`));

  const g = await office.call('/api/hq/grid');
  assert.deepEqual(g.json.selfApproval.never, NEVER_SELF_APPROVED);
  assert.ok(g.json.selfApproval.kinds.every((k) => k.on === false));
  const t = SELF_APPROVAL_KINDS[0].type;
  assert.equal((await office.call('/api/hq/self-approval/set', { type: t, value: true })).status, 409);
  for (const type of NEVER_SELF_APPROVED) assert.equal((await office.call('/api/hq/self-approval/set', { type, value: true, confirmed: true })).status, 400, type);
  const on = await office.call('/api/hq/self-approval/set', { type: t, value: true, confirmed: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.selfApproval.kinds.find((k) => k.type === t).on, true);
  assert.equal((await office.call('/api/hq/self-approval/set', { type: t, value: false })).status, 200, 'off needs no Confirm');
});
