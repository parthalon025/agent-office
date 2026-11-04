import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, DEFAULT_LIMITS } from '../manager.mjs';

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
    limits: over.limits,
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
