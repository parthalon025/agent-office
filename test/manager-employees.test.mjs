// Office Managers as Paperclip employees (#204, spec #191): the hire, a task assigned to the Manager becoming a goal, the steps reported as
// sub-issues, the result on the parent task, and the office-only goal still working with no Paperclip. The fake Paperclip records every
// request; the HQ is the real createHq and the Manager the real createManager. No Claude Code runs and nothing is paid for.
// Run: node --test test/manager-employees.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/ask.js';
import '../public/vocab.js';
import { askFirst } from '../src/office-core.mjs';
import { createHq } from '../src/paperclip.mjs';
import { createManager, createPlanBoard, officeSource } from '../src/manager.mjs';
import { createManagerEmployees, cleanManagers, goalTextOf } from '../src/manager-employees.mjs';
import { planWrite } from '../src/hq-writes/index.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';
import { officeKinds } from './fixtures/office-kinds.mjs';

const D = DEMO(), CO = D.companies[0].id, KEY = 'board-key-0123456789abcdef', BUILDING = 'b1';

async function rig({ grid = { hire: 'allow' }, seed = DEMO(), agents } = {}) {
  const pc = await startFakePaperclip({ ...seed, boardKey: KEY });
  const feed = [], store = {};
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, kinds: officeKinds, grid: () => grid, askFirst, onFeed: (t) => feed.push(t) });
  await hq.connect({ url: pc.url });
  await until(() => hq.state() === 'on', 'the events socket');
  let n = 0;
  const free = agents || [{ id: 'bot1', name: 'Scout', role: '', room: '', free: true, paid: false, tiers: ['local'] }];
  const dispatched = [];
  const manager = createManager({ agents: () => free, dispatch: async (a, t) => { dispatched.push([a.id, t]); }, makeId: () => String(++n), onChange: () => {} });
  const state = { get: (k) => store[k], set: (k, v) => { store[k] = v; }, save: () => {} };
  const me = createManagerEmployees({ hq, manager, state, feed: (t) => feed.push(t), now: () => 1e9 });
  const writes = () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').map((r) => [r.method, r.path, r.body]);
  return { pc, hq, manager, me, store, feed, writes, dispatched, done: async () => { hq.disconnect(); await pc.close(); } };
}
// A task assigned to the hired Manager, as Paperclip lists it.
const assign = async (r, id, fields = {}) => {
  r.pc.state.issues.push({ id: 'i3000000-0000-4000-8000-000000000001', companyId: CO, identifier: 'ACM-30', title: 'Fix the login bug', description: 'Find the bug\nFix the bug', status: 'todo', assigneeAgentId: id, assigneeAdapterOverrides: null, ...fields });
  r.pc.emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'issue.created', entityType: 'issue', entityId: 'i3000000-0000-4000-8000-000000000001', agentId: null, runId: null, details: {} });
  await until(() => r.hq.tasksOf(id)?.tasks.length === 1, 'the task in the read model');
};

test('the hire plan: the Manager is the one hire (#201) with officeManager, the Project manager role (no manager role in Paperclip) and a budget', () => {
  const p = planWrite({ kind: 'hire', action: 'create', officeManager: true, name: 'Mara', isolation: 'same', budgetDollars: 20 });
  assert.equal(p.method, 'POST');
  assert.equal(p.path(CO), `/api/companies/${CO}/agent-hires`);
  assert.deepEqual(p.body, { name: 'Mara', role: 'pm', title: 'Agent Office Manager', adapterType: 'agent_office', adapterConfig: { agentKind: 'claude-code', isolation: 'same', manager: true }, budgetMonthlyCents: 2000 });
  assert.throws(() => planWrite({ kind: 'hire', action: 'manager', name: 'X' }), (e) => e.status === 400, 'the second hire plan is gone');
  assert.throws(() => planWrite({ kind: 'hire', action: 'create', officeManager: true, name: 'X' }), (e) => e.status === 400, 'no budget, no hire');
  assert.throws(() => planWrite({ kind: 'hire', action: 'engineer', name: 'X' }), (e) => e.status === 400);
  assert.deepEqual(planWrite({ kind: 'task', action: 'create', title: 'Step', parentId: 'i1' }).targets, [{ type: 'issue', id: 'i1' }]);
  assert.deepEqual(planWrite({ kind: 'task', action: 'status', issue: 'i1', status: 'done' }).body, { status: 'done' });
  assert.throws(() => planWrite({ kind: 'task', action: 'status', issue: 'i1', status: 'bad' }), (e) => e.status === 400);
});

test('hiring: Confirm by default asks first and sends nothing; the Confirm sends one POST and keeps the Manager', async () => {
  const r = await rig({ grid: {} });
  try {
    await assert.rejects(r.me.register({ building: BUILDING, name: 'Mara' }), (e) => e.status === 400 && /budget/.test(e.message), 'a Manager hire needs a budget like every hire');
    await assert.rejects(r.me.register({ building: BUILDING, name: 'Mara', budgetDollars: 20 }), (e) => e.status === 409 && e.answer.body.confirm === 'write' && /Hire Mara as the office Manager \(Project manager role\).*\$20\.00 a month/.test(e.message));
    assert.deepEqual(r.writes(), []);
    const out = await r.me.register({ building: BUILDING, name: 'Mara', budgetDollars: 20, confirmed: true });
    assert.equal(out.ok, true);
    assert.equal(out.pendingApproval, false);
    assert.match(out.id, /^a4000000/, 'the id of the agent in the { agent, approval } answer');
    assert.deepEqual(r.writes().map((w) => [w[0], w[1]]), [['POST', `/api/companies/${CO}/agent-hires`]]);
    assert.equal(r.writes()[0][2].role, 'pm');
    assert.equal(r.writes()[0][2].budgetMonthlyCents, 2000);
    assert.equal(r.writes()[0][2].adapterConfig.manager, true);
    assert.deepEqual(r.store.managers, { [out.id]: { building: BUILDING, name: 'Mara', company: CO } });
    assert.deepEqual(r.me.list(), [{ id: out.id, name: 'Mara', building: BUILDING }]);
    await assert.rejects(r.me.register({ building: BUILDING, budgetDollars: 20, confirmed: true }), (e) => e.status === 409 && /already has a Manager/.test(e.message));
    await assert.rejects(r.me.register({ building: '', budgetDollars: 20, confirmed: true }), (e) => e.status === 400);
  } finally { await r.done(); }
});

test('Deny on Hires refuses the hire and records nothing', async () => {
  const r = await rig({ grid: { hire: 'deny' } });
  try {
    await assert.rejects(r.me.register({ building: BUILDING, name: 'Mara', budgetDollars: 20, confirmed: true }), (e) => e.status === 403);
    assert.deepEqual(r.writes(), []);
    assert.equal(r.store.managers, undefined);
  } finally { await r.done(); }
});

test('a task assigned to the Manager becomes a goal; the steps are sub-issues; the result is a comment on the task and it is done', async () => {
  const r = await rig();
  try {
    const { id } = await r.me.register({ building: BUILDING, name: 'Mara', budgetDollars: 20 });
    await assign(r, id);
    await r.me.sync();
    const [g] = r.manager.snapshot();
    assert.equal(g.building, BUILDING);
    assert.equal(g.goal, 'Find the bug\nFix the bug', 'the task text, one step for each line');
    assert.equal(g.paperclip.task, 'i3000000-0000-4000-8000-000000000001');
    assert.equal(g.status, 'awaiting-approval', 'the plan waits for the user, as any office goal');
    assert.equal(g.steps.length, 2);
    const w = r.writes().slice(1);   // after the hire
    assert.deepEqual(w[0], ['PATCH', '/api/issues/i3000000-0000-4000-8000-000000000001', { status: 'in_progress' }]);
    assert.deepEqual(w.slice(1, 3).map((x) => [x[0], x[1], x[2].parentId, x[2].title, x[2].status]), [
      ['POST', `/api/companies/${CO}/issues`, 'i3000000-0000-4000-8000-000000000001', 'Find the bug', 'backlog'],
      ['POST', `/api/companies/${CO}/issues`, 'i3000000-0000-4000-8000-000000000001', 'Fix the bug', 'backlog'],
    ]);
    assert.ok(!w.some((x) => 'assigneeAgentId' in (x[2] || {})), 'a sub-issue is assigned to nobody');
    const subs = Object.values(manager(r).paperclip.subs);
    assert.equal(subs.length, 2);
    // a second pass changes nothing: no task is made twice, no sub-issue twice
    const count = r.writes().length;
    await r.me.sync(); await r.me.sync();
    assert.equal(r.manager.snapshot().length, 1);
    assert.equal(r.writes().length, count);

    // the plan is approved, the first step runs and ends: its sub-issue moves
    await r.manager.approve(g.id);
    assert.deepEqual(r.dispatched.length, 1);
    await r.me.sync();
    assert.deepEqual(r.writes().at(-1), ['PATCH', `/api/issues/${subs[0]}`, { status: 'in_progress' }]);
    await r.manager.finish('bot1', { ok: true, text: '' });
    await r.manager.agentFreed();
    await r.manager.finish('bot1', { ok: true, text: '' });
    assert.equal(r.manager.get(g.id).status, 'finished');
    await r.me.sync();
    const last = r.writes().slice(-2);
    assert.equal(last[0][1], '/api/issues/i3000000-0000-4000-8000-000000000001/comments');
    assert.match(last[0][2].body, /^The Manager finished this task\.\n\[x\] Find the bug\n\[x\] Fix the bug$/);
    assert.deepEqual(last[1], ['PATCH', '/api/issues/i3000000-0000-4000-8000-000000000001', { status: 'done' }]);
    assert.deepEqual(r.pc.state.issues.filter((i) => i.parentId).map((i) => i.status), ['done', 'done'], 'both sub-issues are done in Paperclip');
    assert.equal(r.manager.get(g.id).paperclip.reported, 'finished');
    const done = r.writes().length;
    await r.me.sync();
    assert.equal(r.writes().length, done, 'the result is reported once');
  } finally { await r.done(); }
});
const manager = (r) => r.manager.get(r.manager.snapshot()[0].id);

test('a failed step is blocked in Paperclip and the result is reported without done', async () => {
  const r = await rig();
  try {
    const { id } = await r.me.register({ building: BUILDING, budgetDollars: 20 });
    await assign(r, id, { description: 'Only step' });
    await r.me.sync();
    const g = manager(r);
    await r.manager.approve(g.id);
    await r.me.sync();
    await r.manager.finish('bot1', { ok: false, text: 'It broke.' });
    await r.me.sync();
    const sub = Object.values(manager(r).paperclip.subs)[0];
    assert.equal(r.pc.state.issues.find((i) => i.id === sub).status, 'blocked');
    const comment = r.writes().filter((x) => x[1].endsWith('/comments')).at(-1);
    assert.match(comment[2].body, /^The Manager stopped with the goal blocked\./);
    assert.match(comment[2].body, /\[!\] Only step: It broke\./);
    assert.notEqual(r.pc.state.issues.find((i) => i.id === 'i3000000-0000-4000-8000-000000000001').status, 'done');
  } finally { await r.done(); }
});

test('the write grid still rules: Tasks on Confirm leaves the report undone, says so once, and waits before it tries again', async () => {
  const r = await rig({ grid: { hire: 'allow', task: 'confirm', comment: 'confirm' } });
  try {
    const { id } = await r.me.register({ building: BUILDING, budgetDollars: 20 });
    await assign(r, id);
    const before = r.writes().length;
    await r.me.sync();
    assert.equal(r.manager.snapshot().length, 1, 'the goal is made: it is an office goal');
    assert.equal(r.writes().length, before, 'nothing was sent');
    assert.equal(r.feed.filter((t) => /write grid asks first for tasks/.test(t)).length, 1);
    await r.me.sync();
    assert.equal(r.feed.filter((t) => /write grid asks first for tasks/.test(t)).length, 1, 'it waits 30 s (the clock does not move)');
  } finally { await r.done(); }
});

test('a task of another employee, a sub-task and a task under another company are not taken', async () => {
  const r = await rig();
  try {
    const { id } = await r.me.register({ building: BUILDING, budgetDollars: 20 });
    r.pc.state.issues.push({ id: 'i3000000-0000-4000-8000-000000000002', companyId: CO, identifier: 'ACM-31', title: 'Not mine', status: 'todo', assigneeAgentId: D.agents[1].id });
    r.pc.state.issues.push({ id: 'i3000000-0000-4000-8000-000000000003', companyId: CO, identifier: 'ACM-32', title: 'A sub-task', status: 'todo', assigneeAgentId: id, parentId: 'i1' });
    r.pc.state.issues.push({ id: 'i3000000-0000-4000-8000-000000000004', companyId: CO, identifier: 'ACM-33', title: 'Done already', status: 'done', assigneeAgentId: id });
    r.pc.emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'issue.created', entityType: 'issue', entityId: 'x', agentId: null, runId: null, details: {} });
    await until(() => r.hq.tasksOf(id)?.tasks.length === 1, 'the sub-task in the read model');
    await r.me.sync();
    assert.equal(r.manager.snapshot().length, 0);
  } finally { await r.done(); }
});

test('the office-only goal works with no Paperclip, and one board shows both', async () => {
  const hq = createHq({ refetchMs: 20, hooksFile: () => 'C:/office/office-hooks.json' });
  let n = 0;
  const manager = createManager({ agents: () => [{ id: 'bot1', name: 'Scout', role: '', room: '', free: true, paid: false, tiers: ['local'] }], dispatch: async () => {}, makeId: () => String(++n) });
  const me = createManagerEmployees({ hq, manager, state: { get: () => undefined, set() {}, save() {} } });
  const id = await manager.submit(BUILDING, 'One\nTwo', { approveFirst: false });
  await me.sync();   // nothing to do, and no throw
  assert.equal(manager.get(id).status, 'running');
  assert.equal(manager.get(id).paperclip, undefined);
  assert.deepEqual(me.list(), []);
  const board = createPlanBoard({ sources: [officeSource(manager), hq.planSource] });
  assert.equal(board.snapshot().plans[0].task, null, 'an office goal has no task');
});

test('one Manager board: a goal made from a task names the task; the link is saved and restored', async () => {
  const r = await rig();
  try {
    const { id } = await r.me.register({ building: BUILDING, budgetDollars: 20 });
    await assign(r, id);
    await r.me.sync();
    const board = createPlanBoard({ sources: [officeSource(r.manager), r.hq.planSource] });
    const p = board.snapshot().plans.find((x) => x.source === 'office');
    assert.deepEqual(p.task, { id: 'i3000000-0000-4000-8000-000000000001', identifier: 'ACM-30', title: 'Fix the login bug' });
    assert.ok(board.snapshot().plans.some((x) => x.source === 'paperclip'), 'the Paperclip tasks are on the same board');
    assert.equal(globalThis.OfficeVocab.plan.board(board.snapshot()).groups.find((x) => x.source === 'office').fromTask, 'From the Paperclip task ACM-30 Fix the login bug');
    const saved = JSON.parse(JSON.stringify(r.manager.export()));
    const m2 = createManager({ agents: () => [], dispatch: async () => {} });
    m2.restore(saved);
    assert.deepEqual(m2.get(p.id).paperclip.subs, manager(r).paperclip.subs);
    assert.equal(m2.get(p.id).paperclip.task, 'i3000000-0000-4000-8000-000000000001');
  } finally { await r.done(); }
});

test('the saved slice drops junk and keeps good records; the goal text is the lines of the task, else its title', () => {
  assert.deepEqual(cleanManagers({ a1: { building: 'b', name: 'M', company: 'c' }, '../x': { building: 'b', company: 'c' }, a2: { building: 3, company: 'c' }, a3: { building: 'b', company: '' } }), { a1: { building: 'b', name: 'M', company: 'c' } });
  assert.deepEqual(cleanManagers([1]), {});
  assert.equal(goalTextOf({ title: 'T', description: '  one\ntwo ' }), 'one\ntwo');
  assert.equal(goalTextOf({ title: 'T', description: '' }), 'T');
});
