// Goal handoff (#159, ADR 0007): the office hands an office goal to Paperclip as tasks, the second and last write to Paperclip.
// A fake Paperclip records every request. The set of non-GET requests is exactly the Supervise PATCH and the task POST; a new
// one fails this test until a new ADR allows it. No server, no Claude Code, nothing is paid for. Run: node --test test/goal-handoff.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHq } from '../paperclip.mjs';
import { createManager } from '../manager.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';

const HOOKS = 'C:/office/office-hooks.json';
const fast = { refetchMs: 600000, retryMs: [50, 50] };
const writes = (pc) => pc.requests.filter((q) => q.method !== 'GET' && q.method !== 'UPGRADE');
const company = DEMO().companies[0].id;
const POST = `/api/companies/${company}/issues`;

async function rig(seed = DEMO()) {
  const pc = await startFakePaperclip(seed);
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  await hq.connect({ url: pc.url });
  let n = 0;
  const dispatched = [];
  const m = createManager({
    planner: async () => [{ text: 'Find the bug', bot: 'Scout' }, { text: 'Fix it', role: 'engineer' }, { text: 'Write the test' }],
    agents: () => [], dispatch: async (a, t) => { dispatched.push(t); }, makeId: () => String(++n),
  });
  const id = await m.submit('b1', 'Fix the login bug', { approveFirst: true });
  const send = (goal, written) => hq.handoffGoal(goal, written);
  return { pc, hq, m, id, send, dispatched, close: async () => { hq.disconnect(); await pc.close(); } };
}

test('a handoff posts one task per step with the exact body, and the goal moves to Paperclip', async () => {
  const r = await rig();
  try {
    await until(() => r.hq.state() === 'on', 'the events socket');
    const out = await r.m.handoff(r.id, r.send);
    assert.equal(out.ok, true);
    const w = writes(r.pc);
    assert.deepEqual(w.map((q) => [q.method, q.path]), [['POST', POST], ['POST', POST], ['POST', POST]], 'only the task POST');
    assert.deepEqual(Object.keys(w[0].body).sort(), ['description', 'status', 'title']);
    assert.equal(w[0].body.title, 'Find the bug');
    assert.equal(w[0].body.status, 'backlog', 'not assigned, not started');
    assert.equal(w[0].body.description, `Agent Office goal ${r.id} step ${r.id}-1\n\nFix the login bug\n\nStep: Find the bug\nSuggested agent: Scout`);
    assert.match(w[1].body.description, /Suggested agent: engineer$/);
    assert.ok(!('assigneeAgentId' in w[0].body), 'the office assigns nobody');
    const g = r.m.get(r.id);
    assert.equal(g.status, 'handed-off');
    assert.equal(Object.keys(g.handoff.tasks).length, 3);
    assert.equal(g.handoff.company, 'Acme Robotics');
    await r.m.approve(r.id);
    await r.m.agentFreed();
    assert.deepEqual(r.dispatched, [], 'the office stops dispatching it');
    assert.equal((await r.m.handoff(r.id, r.send)).ok, false, 'a handed-off goal cannot go twice');
    assert.equal(writes(r.pc).length, 3);
  } finally { await r.close(); }
});

test('a failure after 2 tasks is Handoff failed; Retry creates only the rest, and a task is never doubled', async () => {
  const r = await rig();
  try {
    r.pc.failIssueAfter = 2;
    const bad = await r.m.handoff(r.id, r.send);
    assert.equal(bad.ok, false);
    const g = r.m.get(r.id);
    assert.equal(g.status, 'handoff-failed');
    assert.match(g.reason, /2 of 3 tasks written, 1 left/);
    assert.deepEqual(Object.keys(g.handoff.tasks), [`${r.id}-1`, `${r.id}-2`]);
    assert.equal(r.pc.state.issues.filter((i) => /^Agent Office goal/.test(i.description || '')).length, 2);
    r.pc.failIssueAfter = null;
    const ok = await r.m.handoff(r.id, r.send);
    assert.equal(ok.ok, true);
    const made = r.pc.state.issues.filter((i) => /^Agent Office goal/.test(i.description || ''));
    assert.equal(made.length, 3, 'three tasks in all');
    assert.equal(new Set(made.map((i) => i.title)).size, 3);
    assert.equal(writes(r.pc).filter((q) => q.method === 'POST').length, 4, 'two, one that failed, one more');
    assert.equal(r.m.get(r.id).status, 'handed-off');
  } finally { await r.close(); }
});

test('the marker check skips a step that Paperclip already has, even when the office lost its record', async () => {
  const r = await rig();
  try {
    r.pc.state.issues.push({ id: 'i-had', companyId: company, identifier: 'ACM-9', title: 'Find the bug', status: 'done', description: `Agent Office goal ${r.id} step ${r.id}-1\n\nold`, assigneeAgentId: null });
    const out = await r.m.handoff(r.id, r.send);
    assert.equal(out.ok, true);
    assert.equal(writes(r.pc).length, 2, 'a done task counts: only the other two are posted');
    assert.equal(r.m.get(r.id).handoff.tasks[`${r.id}-1`], 'i-had');
  } finally { await r.close(); }
});

test('only the goals that run nothing can go, and a goal with a working step cannot', async () => {
  const r = await rig();
  try {
    assert.deepEqual(await r.m.handoff('nope', r.send), { ok: false, status: 404, reason: 'No such goal.' });
    await r.m.approve(r.id);
    const g = r.m.get(r.id);
    g.steps[0].status = 'working';
    assert.equal((await r.m.handoff(r.id, r.send)).status, 409);
    assert.equal(writes(r.pc).length, 0, 'nothing written');
  } finally { await r.close(); }
});

test('the handoff reads the company again, and writes nothing when it is another one', async () => {
  const r = await rig();
  try {
    r.pc.state.companies[0].id = 'c0ffee00-0000-4000-8000-0000000000ff';
    const out = await r.m.handoff(r.id, r.send);
    assert.equal(out.ok, false);
    assert.equal(writes(r.pc).length, 0);
  } finally { await r.close(); }
});

test('the whole write surface is the Supervise PATCH and the task POST', async () => {
  const r = await rig(DEMO());
  try {
    await until(() => r.hq.state() === 'on', 'the events socket');
    const ada = r.hq.view().agents.find((a) => a.name === 'Ada');
    await r.hq.supervise(ada.id);
    await r.m.handoff(r.id, r.send);
    const set = new Set(writes(r.pc).map((q) => `${q.method} ${q.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`));
    assert.deepEqual([...set].sort(), ['PATCH /api/agents/:id', `POST /api/companies/:id/issues`]);
  } finally { await r.close(); }
});
