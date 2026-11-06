// Admission (#172): the order of the checks before any session starts, through the module's Interface only: real Security room
// rules and a fake provider. A refusal always comes before the cost question; the plan comes last.
// Run: node --test test/admission.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmission } from '../src/admission.mjs';
import { setRule } from '../src/security.mjs';

const on = (rules, row, col, value) => setRule(rules, { scope: 'office', row, col, value, confirmed: true }).rules;
// An ungated agent that reports no cost (a Hermes-like kind): every check has something to say.
function fake(over = {}) {
  const log = [];
  const p = { kind: 'hermes', label: 'Hermes', gated: false, supervision: 'Partly supervised', cost: 'unknown', paid: true, features: ['fork'],
    check: () => { log.push('check'); }, preflight: async () => { log.push('preflight'); return null; }, learn: async () => { log.push('learn'); }, ...over };
  return { p, log };
}
const admitWith = (rules, spend = 2) => createAdmission({ rules: () => rules, defaultSpend: () => spend }).admit;
const open = { mode: 'open', ownRoom: true, ownRoomText: 'opens only in a room of its own.' };

test('order: provider check, then Security refusal, then own room, then preflight, then cost, then plan', async () => {
  // 1 provider check beats everything
  let { p } = fake({ check: () => { throw Object.assign(new Error('Unknown model.'), { status: 400 }); } });
  assert.deepEqual(await admitWith({})({ ...open, provider: p, ownRoom: false }), { kind: 'refusal', status: 400, text: 'Unknown model.' });
  // 2 Security refusal (ungated kind off) beats the own-room refusal and preflight
  ({ p } = fake({ preflight: async () => 'broken' }));
  let v = await admitWith({})({ ...open, provider: p, ownRoom: false });
  assert.equal(v.kind, 'refusal'); assert.equal(v.status, 409); assert.match(v.text, /Security room/);
  // 3 own room only (ADR 0001) beats preflight and the cost question
  const rules = on({}, 'ungated', 'hermes', 'on');
  ({ p } = fake({ preflight: async () => 'broken' }));
  v = await admitWith(rules)({ ...open, provider: p, ownRoom: false });
  assert.match(v.text, /Hermes runs some tool calls without asking the office \(Partly supervised\), so it opens only in a room of its own\./);
  // 4 preflight beats the cost question
  v = await admitWith(rules)({ ...open, provider: p });
  assert.deepEqual(v, { kind: 'refusal', status: 409, text: 'Hermes cannot start: broken' });
  // 5 the cost question: a normal answer, with the supervision label
  ({ p } = fake());
  v = await admitWith(rules)({ ...open, provider: p });
  assert.deepEqual(v, { kind: 'question', ask: 'cost', text: 'This agent does not report cost. Partly supervised. Run it?' });
  // 6 plan: confirmed; cost unknown means no spend limit
  v = await admitWith(rules)({ ...open, provider: p, confirmed: true });
  assert.deepEqual(v, { kind: 'plan', budget: null });
});

test('a refusal never reaches the preflight or the cost question', async () => {
  const { p, log } = fake();
  await admitWith({})({ ...open, provider: p });
  assert.deepEqual(log, ['check']);
});

test('the own room is read lazily, only for an ungated kind the Security room let through', async () => {
  let asked = 0;
  const ownRoom = async () => { asked++; return true; };
  const gated = fake({ gated: true, supervision: null, cost: 'reported' }).p;
  await admitWith({})({ ...open, provider: gated, ownRoom });
  assert.equal(asked, 0);
  await admitWith({})({ ...open, provider: fake().p, ownRoom }); // refused by Security first
  assert.equal(asked, 0);
  await admitWith(on({}, 'ungated', 'hermes', 'on'))({ ...open, provider: fake().p, ownRoom, confirmed: true });
  assert.equal(asked, 1);
});

test('a paid agent that reports cost gets the requested limit, or the default; no question', async () => {
  const p = fake({ gated: true, supervision: null, cost: 'reported' }).p;
  const a = admitWith({}, 2);
  assert.deepEqual(await a({ ...open, provider: p }), { kind: 'plan', budget: 2 });
  assert.deepEqual(await a({ ...open, provider: p, requested: 5 }), { kind: 'plan', budget: 5 });
  assert.deepEqual(await a({ ...open, provider: p, requested: 0 }), { kind: 'plan', budget: null });
});

test('a no-cost Deny refuses before the cost question; Allow skips the question', async () => {
  const rules = on({}, 'ungated', 'hermes', 'on');
  const { p } = fake();
  const denied = await admitWith(on(rules, 'no-cost', 'hermes', 'deny'))({ ...open, provider: p });
  assert.equal(denied.kind, 'refusal'); assert.match(denied.text, /denies agents without cost reports/);
  const allowed = await admitWith(on(rules, 'no-cost', 'hermes', 'allow'))({ ...open, provider: p });
  assert.equal(allowed.kind, 'plan');
});

test('reopen: same order, no provider check, no spend limit', async () => {
  const rules = on({}, 'ungated', 'hermes', 'on');
  const { p, log } = fake();
  const req = { mode: 'reopen', provider: p, ownRoomText: 'reopens only in its own worktree.' };
  assert.match((await admitWith(rules)({ ...req, ownRoom: false })).text, /reopens only in its own worktree\./);
  assert.equal((await admitWith(rules)({ ...req, ownRoom: true })).ask, 'cost');
  assert.deepEqual(await admitWith(rules)({ ...req, ownRoom: true, confirmed: true }), { kind: 'plan', budget: null });
  assert.ok(!log.includes('check'));
});

test('fork: refusal, preflight, capability, then the fork question; the yes covers the cost question', async () => {
  const rules = on({}, 'ungated', 'hermes', 'on');
  const a = admitWith(rules);
  assert.equal((await a({ mode: 'fork', provider: fake().p, forkText: 'Fork it?' })).ask, 'fork');
  assert.equal((await admitWith({})({ mode: 'fork', provider: fake().p, forkText: 'x' })).kind, 'refusal');
  const no = fake({ features: [] });
  assert.deepEqual(await a({ mode: 'fork', provider: no.p, forkText: 'x' }), { kind: 'refusal', status: 409, text: 'Hermes cannot fork a session.' });
  assert.ok(no.log.indexOf('preflight') < no.log.indexOf('learn'));
  const bad = fake({ preflight: async () => 'broken' });
  assert.match((await a({ mode: 'fork', provider: bad.p, forkText: 'x' })).text, /cannot start: broken/);
  const yes = fake();
  assert.deepEqual(await a({ mode: 'fork', provider: yes.p, forkText: 'x', confirmed: true }), { kind: 'plan', budget: null });
  assert.equal(yes.log.at(-1), 'check', 'the program check runs after the yes, as before');
});

test('fork: features learned at the handshake count; the record check comes after the capability check, before the question', async () => {
  const rules = on({}, 'ungated', 'hermes', 'on');
  const late = fake({ features: [] });
  late.p.learn = async () => { late.p.features = ['fork']; };
  assert.equal((await admitWith(rules)({ mode: 'fork', provider: late.p, forkText: 'x' })).ask, 'fork');
  const problem = () => 'That session never started, so there is nothing to fork.';
  assert.deepEqual(await admitWith(rules)({ mode: 'fork', provider: fake().p, forkText: 'x', recordProblem: problem }), { kind: 'refusal', status: 409, text: problem() });
  assert.match((await admitWith(rules)({ mode: 'fork', provider: fake({ features: [] }).p, forkText: 'x', recordProblem: problem })).text, /cannot fork/);
});

test('a schedule is an open: same checks, its own limit', async () => {
  const p = fake({ gated: true, supervision: null, cost: 'reported' }).p;
  assert.deepEqual(await admitWith({}, 3)({ mode: 'schedule', provider: p }), { kind: 'plan', budget: 3 });
});

test('an unknown mode is a bug and throws', async () => {
  await assert.rejects(admitWith({})({ mode: 'goal', provider: fake().p }), /Unknown admission mode/);
});
