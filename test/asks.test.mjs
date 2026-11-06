// The ask module (#175): the one wait every agent kind shares, tested through its interface with a fake events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsks } from '../src/providers/asks.mjs';

function rig(over = {}) {
  let n = 0;
  const calls = { permission: [], drop: [] };
  const timers = [];
  const events = {
    permission: (s, p, o) => { calls.permission.push([p, o]); return over.noId ? null : 'r' + ++n; },
    drop: (s, id, why) => calls.drop.push([id, why]),
  };
  const asks = createAsks({ events, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
  return { asks, calls, timers, st: { closed: false, interrupted: false, asks: new Map() }, s: { uid: 'u' } };
}
const req = { tool_name: 'Bash', tool_input: { command: 'ls' } };

test('wait: the office decision comes back as { allow, message }', async () => {
  const { asks, st, s, calls } = rig();
  const p = asks.wait(s, st, req);
  assert.deepEqual(calls.permission[0][0], { permission_suggestions: [], ...req });
  asks.answer(st, 'r1', { allow: true });
  assert.deepEqual(await p, { allow: true, message: '' });
  const q = asks.wait(s, st, req);
  asks.answer(st, 'r2', { allow: false, message: 'Denied by the Security room: Shell.' });
  assert.deepEqual(await q, { allow: false, message: 'Denied by the Security room: Shell.' });
  assert.equal(st.asks.size, 0);
});

test('wait: no request id, or a closed session, declines at once and asks nothing when closed', async () => {
  const a = rig({ noId: true });
  assert.deepEqual(await a.asks.wait(a.s, a.st, req), { allow: false, message: '' });
  const b = rig();
  b.st.closed = true;
  assert.deepEqual(await b.asks.wait(b.s, b.st, req), { allow: false, message: '' });
  assert.equal(b.calls.permission.length, 0);
});

test('hold passes firm through, and agent_id and ask_reason stay on the request', () => {
  const { asks, st, s, calls } = rig();
  asks.hold(s, st, { ...req, agent_id: 'a1', ask_reason: 'why' }, () => {}, { firm: true });
  assert.deepEqual(calls.permission[0][1], { firm: true });
  assert.equal(calls.permission[0][0].agent_id, 'a1');
  assert.equal(calls.permission[0][0].ask_reason, 'why');
});

test('answer with no decision declines, but cancels once the turn stops or the agent gave up', () => {
  const { asks, st, s } = rig();
  const got = [];
  asks.hold(s, st, req, (v) => got.push(v));
  asks.answer(st, 'r1', {});
  st.interrupted = true;
  asks.hold(s, st, req, (v) => got.push(v));
  asks.answer(st, 'r2', {});
  asks.answer(st, 'r2', { allow: true }); // gone: ignored
  assert.deepEqual(got, ['deny', 'cancel']);
});

test('withdraw drops the hold once and ends it as withdraw; cancelAll cancels every waiting request', () => {
  const { asks, st, s, calls } = rig();
  const got = [];
  asks.hold(s, st, req, (v) => got.push(['a', v]));
  asks.hold(s, st, req, (v) => got.push(['b', v]));
  asks.withdraw(s, st, 'r1', 'it moved on');
  asks.withdraw(s, st, 'r1', 'again');
  assert.deepEqual(calls.drop, [['r1', 'it moved on']]);
  asks.cancelAll(st);
  assert.deepEqual(got, [['a', 'withdraw'], ['b', 'cancel']]);
  assert.equal(st.asks.size, 0);
});

test('timeoutMs withdraws by itself; an answer clears the timer', () => {
  const { asks, st, s, calls, timers } = rig();
  const got = [];
  asks.hold(s, st, req, (v) => got.push(v), { timeoutMs: 60000 });
  asks.hold(s, st, req, (v) => got.push(v), { timeoutMs: 60000 });
  assert.equal(timers[0].ms, 60000);
  asks.answer(st, 'r2', { allow: true });
  assert.equal(timers[1].cleared, true);
  timers[0].fn();
  assert.deepEqual(got, ['allow', 'withdraw']);
  assert.equal(calls.drop.length, 1);
});
