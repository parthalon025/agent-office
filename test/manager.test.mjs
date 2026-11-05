import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, DEFAULT_LIMITS } from '../manager.mjs';
import { NOTES_MAX } from '../notes.mjs';

// A world of two agents. dispatched lists what the Manager handed out; spend is per agent, in dollars.
function world(over = {}) {
  const agents = [
    { id: 'a1', name: 'Scout', role: 'analyst', room: 'r1', free: true },
    { id: 'a2', name: 'Coder', role: 'coder', room: 'r2', free: true },
  ];
  const w = { agents, dispatched: [], changes: 0, mail: [], interrupted: [], spend: {}, planCalls: 0 };
  let n = 0;
  w.plan = over.plan || [{ text: 'Find the bug', role: 'analyst' }, { text: 'Fix the bug', role: 'coder' }];
  w.m = createManager({
    planner: async () => { w.planCalls += 1; if (over.plannerError) throw new Error(over.plannerError); return w.plan; },
    agents: () => agents,
    dispatch: async (a, task, ctx) => { if (over.dispatchError) throw new Error(over.dispatchError); a.free = false; w.dispatched.push({ agent: a.name, task, ...ctx }); },
    interrupt: (id) => w.interrupted.push(id),
    deliver: (to, from, text, hops) => w.mail.push({ to, from, text, hops }),
    spendOf: (id) => w.spend[id] || 0,
    clock: () => 1000,
    makeId: () => String(++n),
    onChange: () => { w.changes += 1; },
    managerName: (b) => 'Manager ' + b,
    board: over.board === false ? undefined : (r) => { if (over.boardError) throw new Error('x'); (w.boards ||= []).push(r); },
    limits: over.limits,
    defaultSpendLimit: over.defaultSpendLimit,
  });
  return w;
}
const free = (w, id) => { w.agents.find((a) => a.id === id).free = true; };

test('importing starts nothing, and a manager needs a planner, agents and dispatch', () => {
  assert.throws(() => createManager({}), /planner/);
  assert.throws(() => createManager({ planner() {} }), /agents/);
  assert.throws(() => createManager({ planner() {}, agents() {} }), /dispatch/);
  assert.equal(DEFAULT_LIMITS.maxHops > 0, true);
});

test('a goal becomes a plan, and each step goes to the free agent of its role, one at a time', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'Fix the login bug');
  assert.deepEqual(w.dispatched.map((d) => [d.agent, d.task]), [['Scout', 'Find the bug']]);
  assert.equal(w.m.get(id).status, 'running');
  await w.m.finish('a1', { ok: true, text: 'found it' });
  free(w, 'a1');
  assert.deepEqual(w.dispatched.map((d) => d.agent), ['Scout', 'Coder']);
  await w.m.finish('a2', { ok: true });
  const g = w.m.snapshot()[0];
  assert.equal(g.status, 'finished');
  assert.deepEqual(g.steps.map((s) => [s.status, s.owner]), [['finished', 'Scout'], ['finished', 'Coder']]);
  assert.equal(g.steps[0].result, 'found it');
});

test('the room breaks a tie, and a named bot beats role and room', async () => {
  const w = world({ plan: [{ text: 'x', role: 'coder', room: 'r2' }] });
  w.agents.push({ id: 'a3', name: 'Coder2', role: 'coder', room: 'r9', free: true });
  await w.m.submit('b1', 'g');
  assert.equal(w.dispatched[0].agent, 'Coder');
  const v = world({ plan: [{ text: 'x', role: 'coder', bot: 'Scout' }] });
  await v.m.submit('b1', 'g');
  assert.equal(v.dispatched[0].agent, 'Scout');
});

test('with no free agent the step waits, and agentFreed gives it out', async () => {
  const w = world();
  w.agents.forEach((a) => { a.free = false; });
  const id = await w.m.submit('b1', 'g');
  assert.equal(w.dispatched.length, 0);
  assert.equal(w.m.get(id).waitingFor, `${id}-1`);
  free(w, 'a1');
  await w.m.agentFreed();
  assert.equal(w.dispatched.length, 1);
  assert.equal(w.m.get(id).waitingFor, '');
});

test('approve-plan-first holds the plan until approve()', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'g', { approveFirst: true });
  assert.equal(w.m.get(id).status, 'awaiting-approval');
  assert.equal(w.dispatched.length, 0);
  assert.equal(w.m.snapshot()[0].steps.length, 2); // the plan is visible while it waits
  assert.equal(await w.m.approve(id), true);
  assert.equal(w.dispatched.length, 1);
  assert.equal(await w.m.approve(id), false); // only once
});

test('a failed step blocks the goal, and retry runs it again, up to the attempt cap', async () => {
  const w = world({ limits: { maxAttempts: 2 } });
  const id = await w.m.submit('b1', 'g');
  await w.m.finish('a1', { ok: false, text: 'tests failed' });
  assert.equal(w.m.get(id).status, 'blocked');
  assert.equal(w.m.snapshot()[0].steps[0].status, 'error');
  assert.deepEqual(await w.m.retry(id, `${id}-2`), { ok: false, reason: 'That step has not failed.' });
  free(w, 'a1');
  assert.deepEqual(await w.m.retry(id, `${id}-1`), { ok: true });
  assert.equal(w.dispatched.length, 2);
  await w.m.finish('a1', { ok: false });
  free(w, 'a1');
  const r = await w.m.retry(id, `${id}-1`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ran 2 times/);
});

test('a dispatch that throws marks the step failed and frees the agent', async () => {
  const w = world({ dispatchError: 'no such model' });
  const id = await w.m.submit('b1', 'g');
  const g = w.m.snapshot()[0];
  assert.equal(g.status, 'blocked');
  assert.equal(g.steps[0].status, 'error');
  assert.match(g.steps[0].result, /no such model/);
  assert.equal(w.m.get(id).status, 'blocked');
  // the agent is not stuck as reserved: a later retry can pick it again
  free(w, 'a1');
  const w2 = await w.m.retry(id, `${id}-1`);
  assert.equal(w2.ok, true);
});

test('the spend limit is checked before the next dispatch, not after', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'g', { spendLimit: 0.5 });
  assert.equal(w.dispatched.length, 1);
  w.spend.a1 = 0.6; // the first step cost more than the limit
  await w.m.finish('a1', { ok: true });
  free(w, 'a1');
  assert.equal(w.dispatched.length, 1, 'the second step never started');
  assert.equal(w.m.get(id).status, 'stopped');
  assert.equal(w.m.get(id).reason, 'Spend limit reached');
  assert.equal(w.m.snapshot()[0].spent, 0.6);
});

test('spend counts only what agents spent during the goal, and zero cost never stops it', async () => {
  const w = world();
  w.spend.a1 = 5; // spent before the goal
  const id = await w.m.submit('b1', 'g', { spendLimit: 1 });
  await w.m.finish('a1', { ok: true });
  free(w, 'a1');
  assert.equal(w.m.snapshot()[0].spent, 0);
  assert.equal(w.dispatched.length, 2);
  await w.m.finish('a2', { ok: true });
  assert.equal(w.m.get(id).status, 'finished');
});

test('planner failure and an empty plan end the goal with a reason', async () => {
  const a = world({ plannerError: 'model offline' });
  const ia = await a.m.submit('b1', 'g');
  assert.equal(a.m.get(ia).status, 'failed');
  assert.match(a.m.get(ia).reason, /model offline/);
  const b = world({ plan: [{ text: '  ' }, null] });
  const ib = await b.m.submit('b1', 'g');
  assert.equal(b.m.get(ib).reason, 'The plan has no steps.');
  await assert.rejects(() => b.m.submit('b1', '  '), /goal is required/);
});

test('a long plan is cut to the step cap', async () => {
  const w = world({ plan: Array.from({ length: 30 }, (_, i) => ({ text: 's' + i })) });
  await w.m.submit('b1', 'g');
  assert.equal(w.m.snapshot()[0].steps.length, DEFAULT_LIMITS.maxSteps);
});

test('mail: allowed inside a running goal, cut by the hop cap and by the per-goal cap', async () => {
  const w = world({ limits: { maxHops: 3, maxMessages: 4 } });
  const id = await w.m.submit('b1', 'g');
  let r = w.m.route({ goalId: id, from: 'Scout', to: 'Coder', text: 'hi' });
  assert.deepEqual(r, { ok: true, hops: 1 });
  assert.deepEqual(w.mail[0], { to: 'Coder', from: 'Scout', text: 'hi', hops: 1 });
  r = w.m.route({ goalId: id, from: 'Coder', to: 'Scout', text: 're', hops: 2 });
  assert.equal(r.ok, true);
  r = w.m.route({ goalId: id, from: 'Scout', to: 'Coder', text: 're re', hops: 3 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reply chain reached 3/);
  w.m.route({ goalId: id, from: 'a', to: 'b', text: '1' });
  w.m.route({ goalId: id, from: 'a', to: 'b', text: '2' });
  r = w.m.route({ goalId: id, from: 'a', to: 'b', text: '3' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reached 4 messages/);
  assert.equal(w.mail.length, 4, 'a refused message is never delivered');
  assert.equal(w.m.route({ goalId: 'nope', from: 'a', to: 'b', text: 'x' }).ok, false);
});

test('mail is refused when the goal is not running', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'g', { approveFirst: true });
  assert.equal(w.m.route({ goalId: id, from: 'a', to: 'b', text: 'x' }).ok, false);
});

test('cancel interrupts the running step and stops the goal; a finished goal cannot be cancelled', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'g');
  assert.equal(w.m.cancel(id), true);
  assert.deepEqual(w.interrupted, ['a1']);
  assert.equal(w.m.get(id).status, 'cancelled');
  assert.equal(w.m.snapshot()[0].steps[0].status, 'pending');
  assert.equal(w.m.cancel(id), false);
  assert.deepEqual(w.m.events(), [], 'a cancelled plan is not shown again');
  // a freed agent is not taken by a cancelled goal
  free(w, 'a1');
  await w.m.agentFreed();
  assert.equal(w.dispatched.length, 1);
});

test('events() re-creates the plan for a new scene: plan first, then the steps that moved', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'g');
  await w.m.finish('a1', { ok: true });
  const ev = w.m.events(id);
  assert.equal(ev[0].type, 'plan');
  assert.equal(ev[0].bot, 'Manager b1');
  assert.deepEqual(ev[0].steps.map((s) => s.status), ['resting', 'resting']);
  assert.deepEqual(ev.slice(1).map((e) => [e.type, e.id, e.status, e.owner]), [
    ['plan.step', `${id}-1`, 'finished', 'Scout'],
    ['plan.step', `${id}-2`, 'working', 'Coder'],
  ]);
  assert.deepEqual(w.m.events('other'), []);
});

test('finish() for an agent that holds no step changes nothing', async () => {
  const w = world();
  await w.m.submit('b1', 'g');
  const before = w.changes;
  assert.equal(await w.m.finish('zzz', { ok: true }), false);
  assert.equal(w.changes, before);
});

test('every change calls onChange, and the snapshot is plain data', async () => {
  const w = world();
  await w.m.submit('b1', 'g');
  assert.ok(w.changes >= 3);
  assert.doesNotThrow(() => JSON.stringify(w.m.snapshot()));
});

// ---------- default spend limit (#33) ----------

test('a goal with paid agents gets the default $2 limit; the user can change or clear it', async () => {
  const w = world();
  await w.m.submit('b1', 'g');
  await w.m.submit('b1', 'g', { spendLimit: 5 });
  await w.m.submit('b1', 'g', { spendLimit: 0 });
  assert.deepEqual(w.m.snapshot().map((g) => g.spendLimit), [2, 5, 0]);
});

test('a goal that only local agents can take has no limit, and the default can be set or cleared', async () => {
  const w = world();
  for (const a of w.agents) a.paid = false;
  await w.m.submit('b1', 'g');
  await w.m.submit('b1', 'g', { spendLimit: 9 });
  assert.deepEqual(w.m.snapshot().map((g) => g.spendLimit), [0, 0], 'local agents cost $0, so no limit, even when one is asked for');
  w.agents[0].paid = true; // one paid agent in the building: the goal can spend money
  await w.m.submit('b1', 'g');
  assert.equal(w.m.snapshot()[2].spendLimit, 2);
  const w2 = world({ defaultSpendLimit: 7 });
  await w2.m.submit('b1', 'g');
  const w3 = world({ defaultSpendLimit: 0 });
  await w3.m.submit('b1', 'g');
  assert.deepEqual([w2.m.snapshot()[0].spendLimit, w3.m.snapshot()[0].spendLimit], [7, 0]);
});

test('the default limit stops a goal before the next dispatch', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'g');
  w.spend.a1 = 2.5;
  await w.m.finish('a1', { ok: true });
  free(w, 'a1');
  assert.equal(w.m.get(id).status, 'stopped');
  assert.equal(w.dispatched.length, 1);
});

test('the board shows the goal at once and follows every step, one report per change', async () => {
  const w = world();
  const id = await w.m.submit('b1', 'Fix the login bug');
  const first = w.boards.at(-1);
  assert.equal(first.goalId, id);
  assert.match(first.text, /Goal: Fix the login bug/);
  assert.match(first.text, /Running\. 0 of 2 steps done\./);
  assert.match(first.text, /\[~\] Find the bug \(Scout\)/);
  assert.match(first.text, /\[ \] Fix the bug/);
  assert.deepEqual(first.todos.map((t) => t.status), ['in_progress', 'pending']);
  const before = w.boards.length;
  await w.m.agentFreed(); // nothing changed
  assert.equal(w.boards.length, before);
  await w.m.finish('a1', { ok: true });
  free(w, 'a1');
  await w.m.agentFreed();
  await w.m.finish('a2', { ok: true });
  assert.match(w.boards.at(-1).text, /Done\. 2 of 2 steps done\./);
  assert.deepEqual(w.m.todos(id).map((t) => t.status), ['completed', 'completed']);
});

test('the board names a failed step and a wait, and a bad board does not stop the goal', async () => {
  const w = world({ boardError: true });
  const id = await w.m.submit('b1', 'g');
  assert.equal(w.m.get(id).status, 'running');
  const v = world();
  v.agents.forEach((a) => { a.free = false; });
  await v.m.submit('b1', 'g');
  assert.match(v.boards.at(-1).text, /waits for a free agent/);
  const u = world();
  await u.m.submit('b1', 'g');
  await u.m.finish('a1', { ok: false, text: 'no access' });
  assert.match(u.boards.at(-1).text, /Blocked/);
  assert.match(u.boards.at(-1).text, /\[!\] Find the bug \(Scout\): no access/);
});

test('a goal over 2000 characters is refused, never planned from a cut text; one of 2000 gets every report', async () => {
  const w = world();
  await assert.rejects(() => w.m.submit('b1', 'x'.repeat(2001)), /too long/);
  assert.equal(w.planCalls, 0, 'the planner never saw it');
  assert.equal(w.m.snapshot().length, 0);
  const id = await w.m.submit('b1', 'x'.repeat(2000));
  assert.equal(w.m.get(id).goal.length, 2000);
  assert.ok(w.boards.at(-1).text.split('\n')[0].length <= 'Goal: '.length + 300);
  const n = w.boards.length;
  await w.m.finish('a1', { ok: true }); free(w, 'a1');
  await w.m.agentFreed();
  assert.ok(w.boards.length > n);
  await w.m.finish('a2', { ok: true });
  assert.equal(w.boards.at(-1).status, 'finished');
});

test('twelve long steps fit the board, and the last step change still reports', async () => {
  const plan = Array.from({ length: 12 }, (_, i) => ({ text: `${i} ` + 'y'.repeat(400), role: 'analyst' }));
  const w = world({ plan, limits: { maxSteps: 12 } });
  await w.m.submit('b1', 'g');
  assert.ok(w.boards.at(-1).text.length <= NOTES_MAX);
  assert.match(w.boards.at(-1).text, /\[ \] 11 /);
});

test('a report that changes nothing is not sent: every agent busy, agentFreed twice', async () => {
  const w = world();
  w.agents.forEach((a) => { a.free = false; });
  await w.m.submit('b1', 'g');
  const n = w.boards.length;
  await w.m.agentFreed(); await w.m.agentFreed();
  assert.equal(w.boards.length, n);
});

test('the board and to-dos say: waiting for approval, spend, a failed step, a retry, a cancel', async () => {
  const a = world({ plan: [{ text: 'one', role: 'analyst' }] });
  a.m.submit('b1', 'g', { approveFirst: true }); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
  assert.match(a.boards.at(-1).text, /Waiting for your approval/);
  assert.deepEqual(a.boards.at(-1).todos.map((t) => t.status), ['pending']);

  const b = world({ plan: [{ text: 'one', role: 'analyst' }] });
  const id = await b.m.submit('b1', 'g', { spendLimit: 5 });
  b.spend.a1 = 1.5;
  await b.m.finish('a1', { ok: false, text: 'no access' });
  assert.match(b.boards.at(-1).text, /Spent \$1\.50 of \$5\.00\./);
  assert.deepEqual(b.m.todos(id).map((t) => t.status), ['error']);
  free(b, 'a1');
  await b.m.retry(id, `${id}-1`);
  assert.match(b.boards.at(-1).text, /\[~\] one \(Scout\)/);
  b.m.cancel(id);
  assert.match(b.boards.at(-1).text, /Cancelled/);
  assert.match(b.boards.at(-1).text, /Stopped by the user/);
});

test('the board spends its limit on the head and tail: twelve long steps and a failed one keep the status and the spend line', async () => {
  const plan = Array.from({ length: 12 }, (_, i) => ({ text: `${i} ` + 'y'.repeat(500), role: 'analyst' }));
  const w = world({ plan, limits: { maxSteps: 12, boardMax: 1500 } });
  const id = await w.m.submit('b1', 'g'.repeat(1000), { spendLimit: 5 });
  w.spend.a1 = 1.25;
  await w.m.finish('a1', { ok: false, text: 'z'.repeat(500) });
  const text = w.boards.at(-1).text;
  assert.ok(text.length <= 1500, `the board text is ${text.length} characters`);
  assert.ok(text.length > 1000, 'the steps shrink to fit, they are not dropped');
  assert.match(text, /Blocked\. 0 of 12 steps done\./);
  assert.match(text, /Spent \$1\.25 of \$5\.00\.$/);
  assert.match(text, /Step failed: /);
  assert.equal((text.match(/^\[[ ~x!]\] /gm) || []).length, 12);
  assert.match(text, /^\[!\] 0 /m);
  assert.equal(w.m.get(id).status, 'blocked');
});

test('a change of status alone, or of one to-do alone, is a new report', async () => {
  // status alone: a held plan is approved (the steps do not change)
  const a = world({ plan: [{ text: 'one', role: 'analyst' }] });
  a.agents.forEach((x) => { x.free = false; });
  const p = a.m.submit('b1', 'g', { approveFirst: true }); await p;
  const held = a.boards.length;
  await a.m.approve(a.boards.at(-1).goalId);
  assert.ok(a.boards.length > held);
  assert.notEqual(a.boards.at(-1).text, a.boards.at(-2).text);
  assert.equal(a.boards.at(-2).todos[0].status, a.boards.at(-1).todos[0].status);
  // one to-do alone: the first of two steps finishes while the goal stays running and nobody is free for the second
  const b = world();
  await b.m.submit('b1', 'g');
  b.agents.forEach((x) => { x.free = false; });
  const before = b.boards.at(-1);
  await b.m.finish('a1', { ok: true });
  const after = b.boards.at(-1);
  assert.equal(before.status, after.status);
  assert.notDeepEqual(before.todos.map((x) => x.status), after.todos.map((x) => x.status));
  assert.notEqual(before.text, after.text);
});

test('the default board limit fits a notes board', () => {
  assert.equal(DEFAULT_LIMITS.boardMax, NOTES_MAX - 100);
});

test('a cancelled goal does not say it waits for an agent', async () => {
  const w = world();
  w.agents.forEach((x) => { x.free = false; });
  const id = await w.m.submit('b1', 'g');
  assert.match(w.boards.at(-1).text, /waits for a free agent/);
  w.m.cancel(id);
  assert.equal(w.m.get(id).waitingFor, '');
  assert.match(w.boards.at(-1).text, /Cancelled/);
  assert.doesNotMatch(w.boards.at(-1).text, /waits for a free agent/);
});

test('a 300-character agent name is cut on the board, and the status and spend lines stay', async () => {
  const plan = Array.from({ length: 12 }, (_, i) => ({ text: `${i} ` + 'y'.repeat(500), role: 'analyst' }));
  const w = world({ plan, limits: { maxSteps: 12, boardMax: 1500 } });
  w.agents[0].name = 'N'.repeat(300);
  await w.m.submit('b1', 'g', { spendLimit: 5 });
  await w.m.finish('a1', { ok: false, text: 'z'.repeat(500) });
  const text = w.boards.at(-1).text;
  assert.ok(text.length <= 1500);
  assert.doesNotMatch(text, /N{41}/);
  assert.match(text, /Blocked\. 0 of 12 steps done\./);
  assert.match(text, /Spent \$0\.00 of \$5\.00\.$/);
});

test('one step is "1 step", not "1 steps"', async () => {
  const w = world({ plan: [{ text: 'only', role: 'analyst' }] });
  await w.m.submit('b1', 'g');
  assert.match(w.boards.at(-1).text, /Running\. 0 of 1 step done\./);
});
