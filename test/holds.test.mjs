// Hold queue (#174): the rules of src/holds.mjs through its interface, with a fake clock and no server.
// Run: node --test test/holds.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHolds } from '../src/holds.mjs';

function rig() {
  const timers = [];
  const log = { settled: [], changed: 0, replies: [], after: 0 };
  const q = createHolds({
    settle: (uid, id) => log.settled.push([uid, id]),
    changed: () => { log.changed++; },
    setTimer: (fn, ms) => { const t = { fn, ms, off: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.off = true; },
  });
  const reply = (d) => log.replies.push(d);
  const fire = (i = 0) => { if (!timers[i].off) timers[i].fn(); };
  return { q, timers, log, reply, fire };
}

test('a hold waits: nothing is answered until a release', () => {
  const { q, log, reply } = rig();
  q.add('a', { uid: 'u1', reply, call: { tool: 'Bash' } });
  assert.equal(q.has('a'), true);
  assert.equal(q.uidOf('a'), 'u1');
  assert.deepEqual(q.callOf('a'), { tool: 'Bash' });
  assert.deepEqual(log.replies, []);
});

test('release answers once, settles the request and says it changed; the second release is false', () => {
  const { q, log, reply } = rig();
  q.add('a', { uid: 'u1', reply });
  assert.equal(q.release('a', { allow: true, always: false }), true);
  assert.deepEqual(log.replies, [{ allow: true, always: false }]);
  assert.deepEqual(log.settled, [['u1', 'a']]);
  assert.equal(log.changed, 1);
  assert.equal(q.release('a', { allow: true }), false);
  assert.equal(q.has('a'), false);
  assert.equal(q.callOf('a'), undefined);
  assert.equal(log.replies.length, 1);
});

test('a missing decision is {} (no decision)', () => {
  const { q, log, reply } = rig();
  q.add('a', { uid: 'u1', reply });
  q.release('a');
  assert.deepEqual(log.replies, [{}]);
});

test('a timeout releases with the decision the caller named, then runs after()', () => {
  const { q, timers, log, reply, fire } = rig();
  q.add('a', { uid: 'u1', reply, timeout: { ms: 60000, decision: { allow: false, message: 'denied' }, after: () => { log.after++; } } });
  assert.equal(timers[0].ms, 60000);
  fire();
  assert.deepEqual(log.replies, [{ allow: false, message: 'denied' }]);
  assert.equal(log.after, 1);
  assert.equal(q.has('a'), false);
});

test('a timeout with no named decision is no decision, never an allow (ADR 0009)', () => {
  const { q, log, reply, fire } = rig();
  q.add('a', { uid: 'u1', reply, timeout: { ms: 1 } });
  fire();
  assert.deepEqual(log.replies, [{}]);
});

test('a release stops the timer, so the timeout never answers a second time', () => {
  const { q, timers, log, reply, fire } = rig();
  q.add('a', { uid: 'u1', reply, timeout: { ms: 1, after: () => { log.after++; } } });
  q.release('a', { allow: true });
  assert.equal(timers[0].off, true);
  fire();
  assert.equal(log.replies.length, 1);
  assert.equal(log.after, 0);
});

test('a timeout that fires after the hold was forgotten does nothing', () => {
  const { q, timers, log, reply } = rig();
  q.add('a', { uid: 'u1', reply, timeout: { ms: 1, after: () => { log.after++; } } });
  q.forget('a');
  timers[0].fn();
  assert.deepEqual(log.replies, []);
  assert.equal(log.after, 0);
});

test('forget ends a hold without a reply, settles it and returns it; unknown ids give null', () => {
  const { q, log, reply } = rig();
  q.add('a', { uid: 'u1', kind: 'ask', reply });
  assert.equal(q.kindOf('a'), 'ask');
  const h = q.forget('a');
  assert.equal(h.uid, 'u1');
  assert.deepEqual(log.replies, []);
  assert.deepEqual(log.settled, [['u1', 'a']]);
  assert.equal(q.forget('a'), null);
  assert.equal(q.size, 0);
});

test('holds are independent', () => {
  const { q, log, reply } = rig();
  q.add('a', { uid: 'u1', reply });
  q.add('b', { uid: 'u2', reply });
  q.release('b', { text: 'x' });
  assert.equal(q.has('a'), true);
  assert.equal(q.size, 1);
  assert.deepEqual(log.replies, [{ text: 'x' }]);
});
