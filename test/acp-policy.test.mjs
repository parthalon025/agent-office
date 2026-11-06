// The ACP permission policy (#176, providers/acp-policy.mjs): tracked calls, frozen request cards, one approval per call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/providers/acp-policy.mjs';
import { createAsks } from '../src/providers/asks.mjs';
import { AGENTS } from '../src/providers/acp.mjs';

function rig(kind = 'hermes') {
  const feed = [], hooks = [], perms = [];
  let n = 0;
  const events = { permission: (s, p) => { perms.push(p); return 'r' + ++n; }, feed: (s, k, t) => feed.push(t), drop: () => {} };
  const asks = createAsks({ events });
  const emit = (st, fn) => (st.closed ? undefined : fn());
  const policy = createPolicy({ spec: AGENTS[kind], label: 'Agent', events, emit, hook: (s, st, p) => { hooks.push(p); return undefined; }, asks, killChild() {} });
  const st = { root: 'E:\\r', closed: false, interrupted: false, asks: new Map(), calls: new Map(), terminalIds: new Set(), grants: new Map(), denied: new Set(), askFirst: new Set(), wrote: new Set(), gated: new Map(), deniedVague: false };
  return { policy, st, s: { uid: 'u' }, feed, hooks, perms };
}
const OPTS = [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }];
const edit = (over = {}) => ({ toolCallId: 'c1', kind: 'edit', title: 'Edit a', locations: [{ path: 'E:\\r\\a.txt' }], ...over });

test('track names the tool and input from the kind and keeps what an update did not repeat', () => {
  const { policy, st } = rig();
  const c = policy.track(st, { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: ['ls', '-la'] } });
  assert.equal(c.tool_name, 'Bash');
  assert.deepEqual(c.tool_input, { command: 'ls -la' });
  assert.equal(policy.track(st, { toolCallId: 'c1', status: 'in_progress' }).tool_input.command, 'ls -la');
  assert.equal(policy.track(st, {}), null);
});

test('a request is held on its card; the allow once answer is picked and the call is approved', async () => {
  const { policy, st, s, perms } = rig();
  const p = policy.onPermission(s, st, { toolCall: edit(), options: OPTS });
  assert.equal(perms[0].tool_name, 'Edit');
  st.asks.get('r1').done('allow');
  assert.deepEqual(await p, { outcome: { outcome: 'selected', optionId: 'y' } });
  assert.equal(st.grants.size, 1);
});

test('a declined edit refuses that file for the turn; a cancel gives the cancelled outcome', async () => {
  const { policy, st, s } = rig();
  const p = policy.onPermission(s, st, { toolCall: edit(), options: OPTS });
  st.asks.get('r1').done('deny');
  assert.deepEqual(await p, { outcome: { outcome: 'selected', optionId: 'n' } });
  assert.equal(st.denied.size, 1);
  const q = policy.onPermission(s, st, { toolCall: edit({ toolCallId: 'c2' }), options: OPTS });
  st.asks.get('r2').done('cancel');
  assert.deepEqual(await q, { outcome: { outcome: 'cancelled' } });
});

test('a call changed while its request waits is declined at once and its file asks first', async () => {
  const { policy, st, s } = rig();
  const p = policy.onPermission(s, st, { toolCall: edit(), options: OPTS });
  const c = policy.track(st, { toolCallId: 'c1', locations: [{ path: 'E:\\r\\b.txt' }] });
  policy.recheck(s, st, c);
  assert.deepEqual(await p, { outcome: { outcome: 'selected', optionId: 'n' } });
  assert.equal(st.askFirst.size, 2); // the file it showed and the file it became
  assert.equal(st.asks.size, 0);
});

test('a command that ran without a request is named in the feed when the call ends', () => {
  const { policy, st, s, feed, hooks } = rig();
  const c = policy.track(st, { toolCallId: 'c9', kind: 'execute', title: 'rm x', rawInput: { command: 'rm x' } });
  policy.openCall(s, st, c);
  policy.endCall(s, st, c, { status: 'completed' });
  assert.match(feed[0], /ran a command without asking the office: rm x/);
  assert.deepEqual(hooks.map((h) => h.hook_event_name), ['PreToolUse', 'PostToolUse']);
});
