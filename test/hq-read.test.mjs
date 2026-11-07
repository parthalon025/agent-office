// The HQ read model of the Paperclip watcher (#197): floors from the org chart, the Lobby, the board key and the contract of the
// API shapes, against the fake Paperclip (test/fixtures/fake-paperclip.mjs). No paid call, no real Paperclip. Run: node --test test/hq-read.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHq } from '../src/paperclip.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';

const HOOKS = 'C:/office/office-hooks.json';
const fast = { refetchMs: 20, retryMs: [50, 50] };

test('read model: the view carries floors from the org chart and the Lobby, and no key, secret value or approval payload', async () => {
  const pc = await startFakePaperclip(DEMO());
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const v = hq.view();
    assert.deepEqual(v.floors.map((f) => [f.key, f.employees.map((e) => e.name)]), [['records', []], ['lobby', []], ['rank-2', ['Linus']], ['rank-1', ['Ada']], ['rank-0', ['Grace']]], 'the CEO is on the top floor');
    assert.equal(v.floors.at(-1).name, 'Executive');
    assert.equal(v.floors.at(-1).employees[0].floor, 'Executive');
    const l = v.lobby;
    assert.deepEqual(l.employees, { total: 3, working: 1, paused: 0, error: 0, unsupervised: 3 });
    assert.deepEqual(l.tasks, { open: 2, todo: 1, inProgress: 1, blocked: 0, inReview: 0, backlog: 0 });
    assert.deepEqual(l.approvals, { pending: 1, items: [{ id: 'p1000000-0000-4000-8000-000000000001', kind: 'hire_agent', by: 'Grace' }] });
    assert.equal(l.goals.total, 2);
    assert.deepEqual(l.spend, { spent: 12.4, limit: 100, percent: 12 });
    assert.deepEqual(l.secrets, { count: 1, names: ['GITHUB_TOKEN'] });
    assert.deepEqual(l.activity.map((x) => x.text), ['Ada: issue.updated (issue)', 'board: agent.updated (agent)']);
    assert.deepEqual(l.unread, []);
    assert.deepEqual(v.contract, []);
    assert.doesNotMatch(JSON.stringify(hq.model()) + JSON.stringify(v), /do-not-show/, 'a secret value, an approval payload and activity details never leave the HQ module');
    assert.equal(pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').length, 0, 'the read model only reads');
  } finally { hq.disconnect(); await pc.close(); }
});

test('read model: a route Paperclip lacks is unknown, not zero; a changed shape is named, fed once and not used', async () => {
  const pc = await startFakePaperclip({ ...DEMO(), noGoals: true });
  pc.state.approvals = [{ id: 'p1', companyId: DEMO().companies[0].id, type: 7, status: 'pending' }];   // type is a number now: the shape changed
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, onFeed: (t) => feed.push(t) });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const l = hq.view().lobby;
    assert.equal(l.goals, null, 'a 404 is unknown');
    assert.equal(l.approvals, null, 'a changed shape is not used');
    assert.deepEqual([...l.unread].sort(), ['approvals', 'goals']);
    assert.deepEqual(hq.view().contract, ['approvals: type is number, expected string.']);
    const named = () => feed.filter((t) => /approvals: type is number/.test(t)).length;
    assert.equal(named(), 1);
    const reads = () => pc.requests.filter((r) => /\/approvals/.test(r.path)).length, before = reads();
    pc.emit('activity.logged', { action: 'x' });
    await until(() => reads() > before, 'the read again');
    assert.equal(named(), 1, 'the same problem is named once');
  } finally { hq.disconnect(); await pc.close(); }
});

test('the board key: sent as a bearer to Paperclip, never held in a view; without it a login-mode Paperclip refuses', async () => {
  const KEY = 'board-key-0123456789abcdef';
  const pc = await startFakePaperclip({ ...DEMO(), key: KEY });
  try {
    const none = createHq({ ...fast, hooksFile: () => HOOKS });
    await assert.rejects(() => none.connect({ url: pc.url }), /asks for sign-in \(401\)/);
    none.disconnect();
    const asked = [];
    const hq = createHq({ ...fast, hooksFile: () => HOOKS, key: (url) => { asked.push(url); return KEY; } });
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    assert.deepEqual([...new Set(asked)], [pc.url], 'the key is asked for the address it is used at');
    assert.equal(hq.view().company.name, 'Acme Robotics');
    assert.doesNotMatch(JSON.stringify(hq.view()) + JSON.stringify(hq.model()), new RegExp(KEY));
    hq.disconnect();
  } finally { await pc.close(); }
});
