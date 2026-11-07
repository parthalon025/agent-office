// Office Managers as Paperclip employees through the real office in process (#204): GET /api/managers, POST /api/manager/hire (the one hire
// plan of #201 with a monthly budget; the write grid's Hires cell: Confirm by default, the ask-first question, then one POST of agent-hires), the Manager saved in the state, and a task assigned to it becoming a goal
// on the plan board that the snapshot carries. Paperclip is the fake. No Claude Code runs and nothing is paid for.
// Run: node --test test/manager-employees-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';

let base, rig, pc;
const CO = DEMO().companies[0].id, BUILDING = 'e:/work/acme';

before(async () => {
  pc = await startFakePaperclip();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mgr-emp-'));
  rig = await startInProcess({ dir: base, port: 4393 });
  rig.office.own(); rig.office.claim();
});
after(async () => { if (rig) rig.stop(); if (pc) await pc.close(); if (base) await removeTree(base); });
const posts = () => pc.requests.filter((r) => r.method === 'POST');

test('both routes are page routes', () => {
  assert.equal(rig.office.core.groupOf('GET', '/api/managers'), 'page');
  assert.equal(rig.office.core.groupOf('POST', '/api/manager/hire'), 'page');
});

test('not connected: a hire is 409 and sends nothing; the list is empty', async () => {
  const r = await rig.call('/api/manager/hire', { building: BUILDING, budgetDollars: 20 });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not connected/);
  assert.deepEqual((await rig.call('/api/managers')).json, { managers: [] });
  assert.equal(pc.requests.length, 0);
});

test('connected: the hire asks first, then sends one POST; the task assigned to the Manager is a goal on the board', async () => {
  assert.equal((await rig.call('/api/paperclip/connect', { url: pc.url })).status, 200);
  await until(async () => (await rig.call('/api/paperclip')).json.hq?.state === 'on', 'the live events');
  const none = await rig.call('/api/manager/hire', { building: BUILDING, name: 'Mara' });
  assert.equal(none.status, 400, 'no budget, no hire');
  assert.match(none.json.error, /budget/);
  const q = await rig.call('/api/manager/hire', { building: BUILDING, name: 'Mara', budgetDollars: 20 });
  assert.equal(q.status, 409);
  assert.match(q.json.write.summary, /office Manager \(Project manager role\).*\$20\.00 a month/);
  assert.equal(q.json.confirm, 'write');
  assert.equal(posts().length, 0);
  const ok = await rig.call('/api/manager/hire', { building: BUILDING, name: 'Mara', budgetDollars: 20, confirmed: true });
  assert.equal(ok.status, 200);
  assert.match(ok.json.id, /^a4000000/);
  assert.deepEqual(posts().map((x) => x.path), [`/api/companies/${CO}/agent-hires`]);
  assert.equal(posts()[0].body.role, 'pm');
  assert.deepEqual((await rig.call('/api/managers')).json.managers, [{ id: ok.json.id, name: 'Mara', building: BUILDING }]);
  assert.equal((await rig.call('/api/manager/hire', { building: BUILDING, budgetDollars: 20, confirmed: true })).status, 409, 'one Manager for each building');

  pc.state.issues.push({ id: 'i3000000-0000-4000-8000-000000000001', companyId: CO, identifier: 'ACM-30', title: 'Fix the login bug', description: 'Find it\nFix it', status: 'todo', assigneeAgentId: ok.json.id, assigneeAdapterOverrides: null });
  pc.emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'issue.created', entityType: 'issue', entityId: 'i3000000-0000-4000-8000-000000000001', agentId: null, runId: null, details: {} });
  const plan = await until(() => rig.snapshot().plans.plans.find((p) => p.source === 'office' && p.task), 'the goal from the task');
  assert.equal(plan.task.identifier, 'ACM-30');
  assert.equal(plan.building, BUILDING);
  assert.equal(plan.steps.length, 2);
  await until(() => pc.state.issues.filter((i) => i.parentId).length === 2, 'two sub-issues');
  // one Manager board: the Paperclip plan is on it too
  assert.ok(rig.snapshot().plans.plans.some((p) => p.source === 'paperclip'));
  mara = ok.json.id;
});

// Review of the HQ build, finding 3: the Manager is hired on the office adapter, so Paperclip wakes it on the task it assigned, and the office
// adapter hands that run here. The run must be the goal of the task, not a Claude Code session beside the goal: one goal per task, and no
// session but the goal's steps (none here: the goal waits for its approval).
let mara = '';
const T1 = 'i3000000-0000-4000-8000-000000000001', T2 = 'i3000000-0000-4000-8000-000000000002';
const goalsOf = (task) => rig.snapshot().plans.plans.filter((p) => p.source === 'office' && p.task && p.task.id === task);
const runOf = (run_id, task_id) => ({ run_id, agent: { id: mara, company_id: CO, name: 'Mara' }, agent_kind: 'claude-code', cwd: base, prompt: 'Continue your work.', task_id });
test('a run of the Manager is the goal of its task: one goal per task, no agent session, the goal reported as the run log and result', async () => {
  assert.ok(mara, 'the Manager of the test before');
  // the task sync already took: the run links to that goal
  const s1 = await rig.call('/hook/paperclip/run/start', runOf('run-mgr-1', T1));
  assert.deepEqual([s1.status, s1.json.resumed], [200, false]);
  assert.equal(goalsOf(T1).length, 1, 'still one goal for the task');
  const w1 = await rig.call('/hook/paperclip/run/wait', { key: 'run-mgr-1', cursor: 0 });
  assert.equal(w1.json.done, false, 'the goal waits for its approval, and the run with it');
  assert.ok(w1.json.log.some((l) => /Mara is an office Manager: the office runs this task as its goal/.test(l.text)));
  assert.ok(w1.json.log.some((l) => /waits for your approval/.test(l.text)));
  // a task the watcher has not read yet: the run makes its goal (Paperclip read now), and the sync that follows takes it once
  pc.state.issues.push({ id: T2, companyId: CO, identifier: 'ACM-31', title: 'Write the release note', description: 'Draft it\nPost it', status: 'todo', assigneeAgentId: mara, assigneeAdapterOverrides: null });
  const s2 = await rig.call('/hook/paperclip/run/start', runOf('run-mgr-2', T2));
  assert.equal(s2.status, 200);
  assert.equal(goalsOf(T2).length, 1, 'the run made the goal of the task');
  pc.emit('activity.logged', { actorType: 'user', actorId: 'board', action: 'issue.created', entityType: 'issue', entityId: T2, agentId: null, runId: null, details: {} });
  await until(() => pc.state.issues.filter((i) => i.parentId === T2).length === 2, 'the sync reported the steps of that goal');
  assert.equal(goalsOf(T2).length, 1, 'the sync did not make a second goal');
  assert.equal(rig.snapshot().sessions.length, 0, 'no agent session: the Manager run opened none');
  // the goal ends: the run ends with its result
  const gid = goalsOf(T2)[0].id;
  assert.equal((await rig.call('/api/goal/cancel', { id: gid })).status, 200);
  const done = await until(async () => { const w = await rig.call('/hook/paperclip/run/wait', { key: 'run-mgr-2', cursor: 0 }); return w.json.done ? w.json : null; }, 'the run ends with the goal');
  assert.deepEqual([done.result.ok, done.result.uid], [false, null]);
  assert.match(done.result.summary, /The Manager stopped with the goal cancelled/);
  // a Paperclip cancel of the first run cancels its goal
  assert.equal((await rig.call('/hook/paperclip/run/cancel', { key: 'run-mgr-1' })).status, 200);
  assert.equal(goalsOf(T1)[0].status, 'cancelled');
  assert.equal(rig.snapshot().sessions.length, 0);
});

// Review of the HQ build, finding 4: the goal handoff's task POSTs go through the one writer, so the Tasks cell can Deny them. Its own
// Confirm (the exact tasks) stays, and a handoff the grid denies is not asked at all.
test('the goal handoff: Deny on Tasks refuses it before its Confirm and sends nothing; else its own Confirm sends one task per step', async () => {
  const start = await rig.call('/api/goal/start', { building: BUILDING, goal: 'Write the docs\nReview the docs', approveFirst: true, confirmed: true });
  assert.equal(start.status, 200);
  const id = start.json.id;
  const issuePosts = () => posts().filter((x) => x.path === `/api/companies/${CO}/issues` && !x.body.parentId);
  const n = issuePosts().length;
  assert.equal((await rig.call('/api/hq/grid/set', { kind: 'task', value: 'deny' })).status, 200);
  try {
    const denied = await rig.call('/api/goal/handoff', { id });
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /Denied by the HQ write grid: Tasks/);
    assert.equal(denied.json.confirm, undefined, 'no Confirm for a handoff the grid refuses');
    assert.equal((await rig.call('/api/goal/handoff', { id, confirmed: true })).status, 403);
    assert.equal(issuePosts().length, n, 'nothing was sent');
  } finally { assert.equal((await rig.call('/api/hq/grid/set', { kind: 'task', value: null, confirmed: true })).status, 200); }
  const ask = await rig.call('/api/goal/handoff', { id });
  assert.deepEqual([ask.status, ask.json.confirm, ask.json.tasks.length], [409, 'handoff', 2]);
  assert.equal(issuePosts().length, n);
  const ok = await rig.call('/api/goal/handoff', { id, confirmed: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(issuePosts().slice(n).map((x) => x.body.title), ['Write the docs', 'Review the docs']);
});
