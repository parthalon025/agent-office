// The ACP client wire (#176, providers/acp-rpc.mjs): JSON-RPC lines on a child's stdio, tested with a fake child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { channel, within, rpcError, isAuth, textOf, REFUSED } from '../src/providers/acp-rpc.mjs';

function rig(handlers = {}) {
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const sent = [];
  child.stdin.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => sent.push(JSON.parse(l))));
  const ch = channel(child, { onRequest: handlers.onRequest || (() => { throw rpcError(-32601, 'no'); }), onNotify: handlers.onNotify || (() => {}) });
  const feed = (m) => child.stdout.write(JSON.stringify(m) + '\n');
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { ch, feed, sent, tick, child };
}

test('request: the answer with the same id resolves, an error answer rejects with its code', async () => {
  const { ch, feed, sent, tick } = rig();
  const a = ch.request('initialize', { v: 1 }), b = ch.request('x', {});
  await tick();
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'initialize', params: { v: 1 } });
  feed({ id: 2, error: { code: -32000, message: 'Authentication required' } });
  feed({ id: 1, result: { ok: true } });
  assert.deepEqual(await a, { ok: true });
  await assert.rejects(b, (e) => e.code === -32000 && isAuth(e));
});

test('a request from the agent gets a result, or an error with the code of what the handler threw', async () => {
  const { feed, sent, tick } = rig({ onRequest: (m) => { if (m === 'ok') return { fine: 1 }; throw rpcError(REFUSED, 'declined'); } });
  feed({ id: 'a', method: 'ok', params: {} });
  feed({ id: 'b', method: 'bad', params: {} });
  await tick();
  assert.deepEqual(sent.find((m) => m.id === 'a').result, { fine: 1 });
  assert.deepEqual(sent.find((m) => m.id === 'b').error, { code: REFUSED, message: 'declined' });
});

test('a notification reaches onNotify; a broken line and a line split over two chunks are handled', async () => {
  const got = [];
  const { feed, child, tick } = rig({ onNotify: (m, p) => got.push([m, p]) });
  child.stdout.write('not json\n');
  child.stdout.write('{"method":"session/update",');
  child.stdout.write('"params":{"a":1}}\n');
  feed({ method: 'n2' });
  await tick();
  assert.deepEqual(got, [['session/update', { a: 1 }], ['n2', {}]]);
});

test('fail: every request that waits is rejected once the agent is gone', async () => {
  const { ch } = rig();
  const a = ch.request('x', {});
  ch.fail('The session ended.');
  await assert.rejects(a, /The session ended\./);
});

test('within: a promise that is too slow rejects with the reason and clears its timer', async () => {
  const timers = [];
  const p = within(new Promise(() => {}), 50, 'too slow', (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, (t) => { t.cleared = true; });
  timers[0].fn();
  await assert.rejects(p, /too slow/);
  assert.equal(timers[0].cleared, true);
  assert.equal(textOf(new Error('x')), 'x');
  assert.equal(isAuth(new Error('rate limit')), false);
});
