// Hiring at the HR desk (#201): the `hire` plan of the one HQ writer. A hire is refused without a budget, runs through the office adapter by
// default, shows exactly what it creates in its Confirm, and (route) can send the onboarding task, a second write of the same writer. The
// fake Paperclip records every request. No paid call. Run: node --test test/hq-hire.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../public/ask.js';
import { askFirst } from '../src/office-core.mjs';
import { createHq } from '../src/paperclip.mjs';
import { planWrite } from '../src/hq-writes/index.mjs';
import { HIRE_ROLES } from '../src/hq-writes/hire.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { officeKinds } from './fixtures/office-kinds.mjs';

const D = DEMO(), CO = D.companies[0].id, GRACE = D.agents[0].id;
const KEY = 'board-key-0123456789abcdef';
const base0 = { kind: 'hire', action: 'create', name: 'Mira', role: 'engineer', manager: GRACE, budgetDollars: 25 };

test('plan: a hire is refused without a budget, with a bad budget, a bad role or a bad skill', () => {
  for (const bad of [{ budgetDollars: undefined }, { budgetDollars: 0 }, { budgetDollars: -3 }, { budgetDollars: '25' }, { budgetDollars: NaN }, { budgetDollars: 1e9 },
    { role: 'wizard' }, { role: undefined }, { name: '  ' }, { skills: 'x' }, { skills: ['a b'] }, { agentKind: 'Bad Kind' }, { isolation: 'elsewhere' }, { manager: '../x' }]) {
    assert.throws(() => planWrite({ ...base0, ...bad }), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => planWrite({ ...base0, budgetDollars: undefined }), /budget/);
});

test('plan: the office adapter by default, the budget in cents, and the Confirm names everything', () => {
  const p = planWrite({ ...base0, title: 'Backend', model: 'sonnet', skills: ['tdd', 'review', 'tdd'] });
  assert.equal(p.method, 'POST');
  assert.equal(p.path(CO), `/api/companies/${CO}/agent-hires`);
  assert.deepEqual(p.body, { name: 'Mira', role: 'engineer', adapterType: 'agent_office', adapterConfig: { agentKind: 'claude-code', isolation: 'worktree', model: 'sonnet' }, budgetMonthlyCents: 2500, title: 'Backend', reportsTo: GRACE, desiredSkills: ['tdd', 'review'] });
  const r = p.review([{ id: GRACE, name: 'Grace' }], { kindOf: officeKinds });
  assert.equal(r.summary, 'Hire Mira as Engineer, reporting to Grace, agent kind claude-code (Supervised), model sonnet, $25.00 a month, skills tdd, review');
  assert.equal(p.review([], { kindOf: officeKinds }).status, 404);
  // the agent kind with its supervision (ADR 0001): an ungated kind names its label; a kind the office does not have is refused
  assert.match(planWrite({ ...base0, agentKind: 'hermes' }).review([{ id: GRACE, name: 'Grace' }], { kindOf: officeKinds }).summary, /agent kind hermes \(Partly supervised: file edits and risky commands ask\)/);
  for (const ctx of [{ kindOf: officeKinds }, {}]) assert.equal(planWrite({ ...base0, agentKind: 'codex' }).review([{ id: GRACE, name: 'Grace' }], ctx).status, 400, 'no such agent kind in the office');
  // the opt-in first task: the Confirm names it and the run it starts
  const w = planWrite({ ...base0, welcome: true });
  assert.equal(w.body.welcome, undefined, 'welcome is words of the Confirm, never sent to Paperclip');
  assert.match(w.review([{ id: GRACE, name: 'Grace' }], { kindOf: officeKinds }).summary, /\. Then the first task "Welcome, Mira: post your first stand-up note", assigned to Mira: Paperclip wakes Mira on it, which starts a run of Mira$/);
  assert.doesNotMatch(r.summary, /first task/, 'no first task unless asked for');
  assert.throws(() => planWrite({ ...base0, welcome: 'yes' }), (e) => e.status === 400);
  assert.deepEqual(p.targets, [{ type: 'agent', id: GRACE }]);
  assert.ok(HIRE_ROLES.length >= 6);
});

async function rig(grid = {}) {
  const pc = await startFakePaperclip({ ...DEMO(), boardKey: KEY });
  const feed = [];
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, kinds: officeKinds, grid: () => grid, askFirst, onFeed: (t, k) => feed.push([k, t]) });
  await hq.connect({ url: pc.url });
  await until(() => hq.state() === 'on', 'the events socket');
  return { pc, hq, feed, writes: () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE'), done: async () => { hq.disconnect(); await pc.close(); } };
}

test('writer: Confirm asks with the exact summary and sends nothing; the confirmed call hires once and returns the id only', async () => {
  const r = await rig();
  try {
    const e = await r.hq.write(base0).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.confirm, 'write');
    assert.equal(e.answer.body.write.summary, 'Hire Mira as Engineer, reporting to Grace, agent kind claude-code (Supervised), model the default, $25.00 a month, skills none');
    assert.equal(r.writes().length, 0);
    const made = await r.hq.write(base0, { confirmed: true });
    assert.deepEqual(Object.keys(made).sort(), ['id', 'name', 'ok', 'pendingApproval']);
    assert.match(made.id, /^a4000000/, 'the id of the agent in Paperclip\'s { agent, approval } answer');
    assert.equal(made.pendingApproval, false);
    assert.equal(r.writes().length, 1);
    assert.equal(r.writes()[0].body.adapterType, 'agent_office');
    assert.ok(r.feed.some(([, t]) => /Wrote to Acme Robotics: Hire Mira/.test(t)));
    await until(() => r.hq.view().agents.some((a) => a.name === 'Mira'), 'the new employee in the view');
    const mira = r.hq.view().agents.find((a) => a.name === 'Mira');
    assert.equal(mira.supervision.state, 'supervised', 'a new hire is supervised');
  } finally { await r.done(); }
});

test('writer: Deny refuses, a missing budget never reaches Paperclip, a stranger manager is 404', async () => {
  let r = await rig({ hire: 'deny' });
  try {
    await assert.rejects(r.hq.write(base0, { confirmed: true }), (e) => e.status === 403);
    assert.equal(r.writes().length, 0);
  } finally { await r.done(); }
  r = await rig({ hire: 'allow' });
  try {
    await assert.rejects(r.hq.write({ ...base0, budgetDollars: 0 }, { confirmed: true }), (e) => e.status === 400);
    await assert.rejects(r.hq.write({ ...base0, manager: 'a9999999-0000-4000-8000-000000000009' }, { confirmed: true }), (e) => e.status === 404);
    assert.equal(r.writes().length, 0);
    await r.hq.write(base0);   // Allow sends with no question
    assert.equal(r.writes().length, 1);
  } finally { await r.done(); }
});

test('plan: the office Manager (#204) is the same hire: Project manager role (Paperclip has no manager role), marked, budgeted', () => {
  assert.throws(() => planWrite({ ...base0, role: 'manager' }), (e) => e.status === 400, 'manager is not a Paperclip role');
  const m = { kind: 'hire', action: 'create', officeManager: true, name: 'Mara', isolation: 'same' };
  assert.throws(() => planWrite(m), (e) => e.status === 400 && /budget/.test(e.message), 'a Manager hire needs a budget too');
  assert.throws(() => planWrite({ ...m, budgetDollars: 10, officeManager: 'yes' }), (e) => e.status === 400);
  const p = planWrite({ ...m, budgetDollars: 10 });
  assert.equal(p.path(CO), `/api/companies/${CO}/agent-hires`);
  assert.deepEqual(p.body, { name: 'Mara', role: 'pm', adapterType: 'agent_office', adapterConfig: { agentKind: 'claude-code', isolation: 'same', manager: true }, budgetMonthlyCents: 1000, title: 'Agent Office Manager' });
  assert.equal(p.review([], { kindOf: officeKinds }).summary, 'Hire Mara as the office Manager (Project manager role), reporting to no manager, agent kind claude-code (Supervised), model the default, $10.00 a month, skills none');
  assert.equal(planWrite(base0).body.adapterConfig.manager, undefined, 'an ordinary hire is not marked');
});

test('writer: a company that asks the board to approve new employees answers a pending approval; the office says so', async () => {
  const pcA = await startFakePaperclip({ ...DEMO(), boardKey: KEY, companies: DEMO().companies.map((c) => ({ ...c, requireBoardApprovalForNewAgents: true })) });
  const feed = [];
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, kinds: officeKinds, grid: () => ({ hire: 'allow' }), askFirst, onFeed: (t, k) => feed.push([k, t]) });
  try {
    await hq.connect({ url: pcA.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const made = await hq.write(base0);
    assert.match(made.id, /^a4000000/);
    assert.equal(made.pendingApproval, true);
    assert.ok(feed.some(([, t]) => /waits for the board to approve the hire/.test(t)), 'the feed says the hire waits');
  } finally { hq.disconnect(); await pcA.close(); }
});

// ---- the route: hire, then the onboarding task through the same writer ----
let base, office, pc;
before(async () => {
  pc = await startFakePaperclip(DEMO());
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hire-'));
  office = await startInProcess({ dir: base, port: 4393, state: { hqGrid: { hire: 'confirm' } } });
  office.office.own(); office.office.claim();
  assert.equal((await office.call('/api/paperclip/connect', { url: pc.url })).status, 200);
  await until(() => office.snapshot().hq && office.snapshot().hq.state === 'on', 'the HQ connected');
});
after(async () => { if (office) office.stop(); if (pc) await pc.close(); if (base) await removeTree(base); });

test('route: the hire desk lists the role cards; the route asks first, then hires and sends the onboarding task', async () => {
  assert.equal(office.office.core.groupOf('POST', '/api/hq/hire'), 'page');
  const desk = await office.call('/api/hq/hire-desk');
  assert.equal(desk.json.roles.length, HIRE_ROLES.length);
  assert.equal(desk.json.write, true);
  const before = pc.requests.filter((x) => x.method === 'POST').length;
  const body = { name: 'Mira', role: 'engineer', manager: GRACE, budgetDollars: 25, welcome: true };
  const ask = await office.call('/api/hq/hire', body);
  assert.equal(ask.status, 409);
  assert.equal(ask.json.confirm, 'write');
  // the Confirm names what the confirmed call creates: the employee, and the first task with the run Paperclip starts for it (#201, review)
  assert.match(ask.json.write.summary, /^Hire Mira as Engineer, reporting to Grace, agent kind claude-code \(Supervised\), .*\. Then the first task "Welcome, Mira: post your first stand-up note", assigned to Mira: Paperclip wakes Mira on it, which starts a run of Mira$/);
  assert.equal(pc.requests.filter((x) => x.method === 'POST').length, before, 'nothing was sent');
  const ok = await office.call('/api/hq/hire', { ...body, confirmed: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.onboarding, 'sent', 'Tasks is Allow by default: the task goes through its own cell with no question');
  const posts = pc.requests.filter((x) => x.method === 'POST').slice(before);
  assert.equal(posts.length, 2);
  assert.match(posts[0].path, /agent-hires$/);
  assert.match(posts[1].path, /\/issues$/);
  assert.equal(posts[1].body.assigneeAgentId, ok.json.id);
  assert.match(posts[1].body.description, /office_room_update/);
  const none = await office.call('/api/hq/hire', { ...body, budgetDollars: 0, confirmed: true });
  assert.equal(none.status, 400);
});

// Review of the HQ build, finding 2: the first task is opt-in, and it never rides on the hire's Confirm. Its own Tasks cell decides it.
test('route: the first task is off by default; with Tasks on Confirm it asks on its own after the hire; with Tasks on Deny nothing is sent', async () => {
  const posts = () => pc.requests.filter((x) => x.method === 'POST');
  const set = (value, confirmed) => office.call('/api/hq/grid/set', { kind: 'task', value, ...(confirmed ? { confirmed: true } : {}) });
  try {
    // no welcome: one POST, the hire only, and the Confirm names no task
    let n = posts().length;
    const ask0 = await office.call('/api/hq/hire', { name: 'Noor', role: 'qa', budgetDollars: 10 });
    assert.doesNotMatch(ask0.json.write.summary, /first task/);
    const plain = await office.call('/api/hq/hire', { name: 'Noor', role: 'qa', budgetDollars: 10, confirmed: true });
    assert.deepEqual([plain.status, plain.json.onboarding], [200, 'none']);
    assert.deepEqual(posts().slice(n).map((x) => x.path.split('/').pop()), ['agent-hires']);
    // Tasks on Confirm: the hire's Confirm sends the hire only; the task comes back with its own question
    assert.equal((await set('confirm')).status, 200);
    n = posts().length;
    const hired = await office.call('/api/hq/hire', { name: 'Ola', role: 'qa', budgetDollars: 10, welcome: true, confirmed: true });
    assert.deepEqual([hired.status, hired.json.onboarding], [200, 'ask']);
    assert.deepEqual(posts().slice(n).map((x) => x.path.split('/').pop()), ['agent-hires'], 'the task did not ride on the hire\'s Confirm');
    assert.match(hired.json.onboardingAsk, /^Create the task "Welcome, Ola: post your first stand-up note" in Acme Robotics\?/);
    assert.deepEqual(Object.keys(hired.json.onboardingTask).sort(), ['action', 'assigneeAgentId', 'description', 'kind', 'title']);
    assert.equal(hired.json.onboardingTask.assigneeAgentId, hired.json.id);
    const sent = await office.call('/api/hq/write', { ...hired.json.onboardingTask, confirmed: true });
    assert.equal(sent.status, 200);
    assert.deepEqual(posts().slice(n).map((x) => x.path.split('/').pop()), ['agent-hires', 'issues'], 'the task\'s own Confirm sent it');
    // Tasks on Deny: a hire with the first task is refused before anything is asked or sent
    assert.equal((await set('deny')).status, 200);
    n = posts().length;
    const denied = await office.call('/api/hq/hire', { name: 'Pia', role: 'qa', budgetDollars: 10, welcome: true });
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /Tasks/);
    assert.equal(denied.json.confirm, undefined, 'no Confirm is asked for a hire whose task cannot be sent');
    assert.equal(posts().length, n);
  } finally { await set(null, true); }
});

// Review of the HQ build, finding 1, through the real office: the agent kinds come from the providers, the hire's Confirm names the kind's
// supervision, and an employee on the office adapter shows the supervision of its kind.
test('route: the hire Confirm names the supervision of the agent kind, and the HQ shows the employee with it', async () => {
  const kinds = office.snapshot().kinds;
  const hermes = kinds.find((k) => k.kind === 'hermes');
  assert.ok(hermes && hermes.gated === false && /^Partly supervised/.test(hermes.supervision), 'Hermes is an ungated kind of the office');
  const ask = await office.call('/api/hq/hire', { name: 'Hana', role: 'researcher', budgetDollars: 10, agentKind: 'hermes' });
  assert.equal(ask.status, 409);
  assert.ok(ask.json.write.summary.includes(`agent kind hermes (${hermes.supervision})`), ask.json.write.summary);
  const unknown = await office.call('/api/hq/hire', { name: 'Kit', role: 'researcher', budgetDollars: 10, agentKind: 'no-such-kind' });
  assert.equal(unknown.status, 400);
  const ok = await office.call('/api/hq/hire', { name: 'Hana', role: 'researcher', budgetDollars: 10, agentKind: 'hermes', confirmed: true });
  assert.equal(ok.status, 200);
  const hana = await until(() => (office.snapshot().hq.agents || []).find((a) => a.id === ok.json.id), 'Hana in the HQ view');
  assert.deepEqual([hana.supervision.state, hana.supervision.label], ['partly', hermes.supervision], 'never Supervised: Hermes is ungated (ADR 0001)');
  const cc = await until(() => (office.snapshot().hq.agents || []).find((a) => a.name === 'Mira'), 'Mira in the HQ view');
  assert.equal(cc.supervision.state, 'supervised', 'a Claude Code employee on the office adapter is Supervised');
});

// ---- the office adapter (#222): the HR desk and the Manager hire say what to do while it is missing; the install is the writer's ----
test('route: the adapter state is on the hire desk and GET /api/hq/adapter; hires are refused with a reason while it is missing, until the install', async () => {
  assert.equal(office.office.core.groupOf('GET', '/api/hq/adapter'), 'page');
  const here = await office.call('/api/hq/adapter');
  assert.deepEqual([here.json.adapter.state, here.json.write], ['installed', true]);
  const pc2 = await startFakePaperclip({ ...DEMO(), adapters: [] });
  try {
    assert.equal((await office.call('/api/paperclip/connect', { url: pc2.url })).status, 200);
    await until(() => office.snapshot().hq && office.snapshot().hq.state === 'on' && office.snapshot().hq.url === pc2.url, 'the HQ connected to the second Paperclip');
    const desk = await office.call('/api/hq/hire-desk');
    assert.equal(desk.json.adapter.state, 'missing');
    assert.match(desk.json.adapter.why, /Install it at the HQ first/);
    const hire = await office.call('/api/hq/hire', { name: 'Mira', role: 'engineer', budgetDollars: 25 });
    assert.equal(hire.status, 409);
    assert.match(hire.json.error, /office adapter/);
    assert.equal(hire.json.confirm, undefined, 'no Confirm is asked for a hire that cannot happen');
    const mgr = await office.call('/api/manager/hire', { building: 'any', budgetDollars: 25 });
    assert.equal(mgr.status, 409);
    assert.match(mgr.json.error, /office adapter/);
    assert.equal(pc2.requests.filter((x) => x.method === 'POST').length, 0, 'nothing was sent');
    const ask = await office.call('/api/hq/write', { kind: 'adapter', action: 'install' });
    assert.equal(ask.status, 409);
    assert.equal(ask.json.confirm, 'write');
    const ok = await office.call('/api/hq/write', { kind: 'adapter', action: 'install', confirmed: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.type, 'agent_office');
    assert.equal(pc2.adapterInstalls.length, 1);
    assert.equal((await office.call('/api/hq/hire-desk')).json.adapter.state, 'installed');
    const again = await office.call('/api/hq/write', { kind: 'adapter', action: 'install', confirmed: true });
    assert.equal(again.json.existed, true);
    assert.equal(pc2.adapterInstalls.length, 1, 'a second install sends nothing');
    assert.equal((await office.call('/api/hq/hire', { name: 'Mira', role: 'engineer', budgetDollars: 25, confirmed: true })).status, 200);
  } finally { await pc2.close(); }
});
