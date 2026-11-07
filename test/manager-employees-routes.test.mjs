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
});
