// The HQ writer (#198, spec #191): every Paperclip write goes through hq.write(body, { confirmed }), keyed by write kind, after the
// write grid. Allow sends, Deny refuses, Confirm returns the ask-first question until the same call comes with the confirmation, and
// every write leaves a feed line. The fake Paperclip records every request: the test asserts the exact non-GET requests per write
// kind. No Paperclip is real, nothing is paid for. Run: node --test test/hq-write.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/ask.js';
import { askFirst } from '../src/office-core.mjs';
import { createHq } from '../src/paperclip.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';
import { until } from './fixtures/office-server.mjs';

const fast = { refetchMs: 20, retryMs: [50, 50] };
const D = DEMO();
const CO = D.companies[0].id, ADA = D.agents[1].id, ISSUE = D.issues[0].id, APPROVAL = D.approvals[0].id;
const KEY = 'board-key-0123456789abcdef';

async function rig(grid = {}, seed = DEMO()) {
  const pc = await startFakePaperclip({ ...seed, boardKey: KEY });
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, grid: () => grid, askFirst, onFeed: (t, k) => feed.push([k, t]) });
  await hq.connect({ url: pc.url });
  await until(() => hq.state() === 'on', 'the events socket');
  const writes = () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').map((r) => [r.method, r.path, r.body]);
  return { pc, hq, feed, writes, done: async () => { hq.disconnect(); await pc.close(); } };
}
const ALLOW_ALL = { task: 'allow', comment: 'allow', approval: 'allow' };

test('exact non-GET requests per write kind', async () => {
  const r = await rig(ALLOW_ALL);
  try {
    const made = await r.hq.write({ kind: 'task', action: 'create', title: 'Fix the build', description: 'It fails.', assigneeAgentId: ADA });
    assert.match(made.id, /^i2000000/);
    await r.hq.write({ kind: 'task', action: 'assign', issue: ISSUE, agent: ADA });
    await r.hq.write({ kind: 'comment', action: 'add', issue: ISSUE, text: 'Looks good.' });
    await r.hq.write({ kind: 'approval', action: 'approve', approval: APPROVAL });
    assert.deepEqual(r.writes(), [
      ['POST', `/api/companies/${CO}/issues`, { title: 'Fix the build', description: 'It fails.', assigneeAgentId: ADA }],
      ['PATCH', `/api/issues/${ISSUE}`, { assigneeAgentId: ADA }],
      ['POST', `/api/issues/${ISSUE}/comments`, { body: 'Looks good.' }],
      ['POST', `/api/approvals/${APPROVAL}/approve`, {}],
    ], 'one write request each, and nothing else');
  } finally { await r.done(); }
});

test('reject and request revision are one POST each, with the note', async () => {
  for (const [action, route] of [['reject', 'reject'], ['revise', 'request-revision']]) {
    const r = await rig(ALLOW_ALL);
    try {
      await r.hq.write({ kind: 'approval', action, approval: APPROVAL, note: 'Add a budget.' });
      assert.deepEqual(r.writes(), [['POST', `/api/approvals/${APPROVAL}/${route}`, { decisionNote: 'Add a budget.' }]]);
    } finally { await r.done(); }
  }
});

test('the defaults: a task and a comment send at once, an approval waits for the Confirm', async () => {
  const r = await rig({});
  try {
    await r.hq.write({ kind: 'comment', action: 'add', issue: ISSUE, text: 'Hi' });
    await r.hq.write({ kind: 'task', action: 'create', title: 'A task' });
    assert.equal(r.writes().length, 2);
    await assert.rejects(r.hq.write({ kind: 'approval', action: 'approve', approval: APPROVAL }), (e) => e.status === 409 && e.answer.body.confirm === 'write');
    assert.equal(r.writes().length, 2, 'the approval was not sent');
  } finally { await r.done(); }
});

test('Confirm returns the ask-first question until the same call comes confirmed', async () => {
  const r = await rig({ task: 'confirm', approval: 'confirm' });
  try {
    const body = { kind: 'approval', action: 'approve', approval: APPROVAL };
    const e = await r.hq.write(body).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.deepEqual(e.answer.body, { error: e.message, confirm: 'write', write: { kind: 'approval', action: 'approve', summary: 'Approve an approval' } });
    assert.match(e.message, /^Approve an approval in Acme Robotics\? /);
    assert.equal(r.writes().length, 0, 'nothing is sent before the yes');
    const ok = await r.hq.write(body, { confirmed: true });
    assert.equal(ok.ok, true);
    assert.deepEqual(r.writes(), [['POST', `/api/approvals/${APPROVAL}/approve`, {}]]);
    // the question names what a task create writes
    const t = await r.hq.write({ kind: 'task', action: 'create', title: 'Pay the rent' }).then(() => null, (x) => x);
    assert.match(t.message, /Create the task "Pay the rent" in Acme Robotics\?/);
    assert.equal(t.answer.body.write.summary, 'Create the task "Pay the rent"');
  } finally { await r.done(); }
});

test('Deny refuses with 403 and sends nothing, even confirmed; the feed says so', async () => {
  const r = await rig({ comment: 'deny' });
  try {
    for (const confirmed of [false, true]) {
      await assert.rejects(r.hq.write({ kind: 'comment', action: 'add', issue: ISSUE, text: 'Hi' }, { confirmed }), (e) => e.status === 403 && /Denied by the HQ write grid: Comments\./.test(e.message));
    }
    assert.equal(r.writes().length, 0);
    assert.equal(r.feed.filter(([, t]) => /refused.*Comments/i.test(t)).length, 2);
  } finally { await r.done(); }
});

test('every write leaves a feed line, and a failed one does not claim success', async () => {
  const r = await rig(ALLOW_ALL);
  try {
    await r.hq.write({ kind: 'task', action: 'create', title: 'Fix the build' });
    await r.hq.write({ kind: 'approval', action: 'revise', approval: APPROVAL });
    assert.deepEqual(r.feed.map(([, t]) => t), ['Wrote to Acme Robotics: Create the task "Fix the build".', 'Wrote to Acme Robotics: Request a revision of an approval.']);
    const before = r.feed.length;
    r.pc.failIssueAfter = r.pc.created;   // Paperclip fails the next create
    await assert.rejects(r.hq.write({ kind: 'task', action: 'create', title: 'Second' }), (e) => e.status === 502);
    assert.equal(r.feed.length, before + 1);
    assert.match(r.feed.at(-1)[1], /Paperclip refused.*Create the task "Second"/);
    assert.equal(r.feed.at(-1)[0], 'wait');
    assert.doesNotMatch(r.feed.slice(2, -1).join(), /Second/, 'no success line for it');
  } finally { await r.done(); }
});

test('a thing of another company or one Paperclip does not know is refused before the write, and a bad body is 400', async () => {
  const r = await rig(ALLOW_ALL);
  try {
    r.pc.state.issues.push({ id: 'i9000000-0000-4000-8000-000000000001', companyId: 'other-company', identifier: 'X-1', title: 'Theirs', status: 'todo' });
    await assert.rejects(r.hq.write({ kind: 'comment', action: 'add', issue: 'i9000000-0000-4000-8000-000000000001', text: 'Hi' }), (e) => e.status === 404 && /another company|no such/i.test(e.message));
    await assert.rejects(r.hq.write({ kind: 'comment', action: 'add', issue: 'i0000000-0000-4000-8000-000000000404', text: 'Hi' }), (e) => e.status === 404);
    await assert.rejects(r.hq.write({ kind: 'task', action: 'assign', issue: ISSUE, agent: 'a0000000-0000-4000-8000-000000000404' }), (e) => e.status === 404 && /agent/i.test(e.message));
    await assert.rejects(r.hq.write({ kind: 'task', action: 'create', title: 'T', assigneeAgentId: 'a0000000-0000-4000-8000-000000000404' }), (e) => e.status === 404);
    await assert.rejects(r.hq.write({ kind: 'task', action: 'create', title: '' }), (e) => e.status === 400);
    await assert.rejects(r.hq.write({ kind: 'secret', action: 'set' }), (e) => e.status === 400);
    assert.equal(r.writes().length, 0);
  } finally { await r.done(); }
});

test('not connected: 409, nothing sent, and the key is in no result', async () => {
  const hq = createHq({ grid: () => ({}), askFirst });
  await assert.rejects(hq.write({ kind: 'comment', action: 'add', issue: ISSUE, text: 'Hi' }), (e) => e.status === 409 && /not connected/.test(e.message));
  const r = await rig(ALLOW_ALL);
  try {
    const out = await r.hq.write({ kind: 'task', action: 'create', title: 'T' });
    assert.deepEqual(Object.keys(out).sort(), ['id', 'identifier', 'ok'].sort());
    assert.doesNotMatch(JSON.stringify(out) + JSON.stringify(r.feed), new RegExp(KEY));
  } finally { await r.done(); }
});

test('the company is read again after a write, so the view shows it', async () => {
  const r = await rig(ALLOW_ALL);
  try {
    const n = r.hq.view().lobby.tasks.open;
    await r.hq.write({ kind: 'task', action: 'create', title: 'One more', status: 'todo' });
    await until(() => r.hq.view().lobby.tasks.open === n + 1, 'the task in the Lobby');
  } finally { await r.done(); }
});

// ---------- routines (#209) ----------
const ROUTINE = D.routines[0].id, TRIGGER = D.routines[0].triggers[0].id;

test('routines: create, edit, schedule and run are one request each, nothing else', async () => {
  const r = await rig({ routine: 'allow' });
  try {
    const made = await r.hq.write({ kind: 'routine', action: 'create', title: 'Daily check', description: 'Look at the build.', agent: ADA });
    assert.match(made.id, /^r2000000/);
    await r.hq.write({ kind: 'routine', action: 'update', routine: ROUTINE, title: 'Weekly report', status: 'paused' });
    await r.hq.write({ kind: 'routine', action: 'schedule', routine: ROUTINE, trigger: TRIGGER, cron: '0 8 * * 1-5', timezone: 'UTC' });
    await r.hq.write({ kind: 'routine', action: 'run', routine: ROUTINE });
    assert.deepEqual(r.writes(), [
      ['POST', `/api/companies/${CO}/routines`, { title: 'Daily check', description: 'Look at the build.', assigneeAgentId: ADA }],
      ['PATCH', `/api/routines/${ROUTINE}`, { title: 'Weekly report', status: 'paused' }],
      ['PATCH', `/api/routine-triggers/${TRIGGER}`, { cronExpression: '0 8 * * 1-5', timezone: 'UTC' }],
      ['POST', `/api/routines/${ROUTINE}/run`, {}],
    ]);
  } finally { await r.done(); }
});

test('routines: Run waits for the Confirm by default, Deny sends nothing, and a stranger routine is 404', async () => {
  const r = await rig({});
  try {
    await assert.rejects(r.hq.write({ kind: 'routine', action: 'run', routine: ROUTINE }), (e) => e.status === 409 && e.answer.body.confirm === 'write');
    assert.deepEqual(r.writes(), [], 'no request before the Confirm');
    await r.hq.write({ kind: 'routine', action: 'run', routine: ROUTINE }, { confirmed: true });
    assert.equal(r.writes().length, 1);
    await assert.rejects(r.hq.write({ kind: 'routine', action: 'run', routine: 'r9999999-0000-4000-8000-000000000000' }, { confirmed: true }), (e) => e.status === 404);
    await assert.rejects(r.hq.write({ kind: 'routine', action: 'schedule', routine: ROUTINE, trigger: 'nope', cron: '0 8 * * *' }, { confirmed: true }), (e) => e.status === 404);
    assert.equal(r.writes().length, 1, 'refused writes send nothing');
  } finally { await r.done(); }
  const d = await rig({ routine: 'deny' });
  try {
    await assert.rejects(d.hq.write({ kind: 'routine', action: 'run', routine: ROUTINE }, { confirmed: true }), (e) => e.status === 403);
    assert.deepEqual(d.writes(), []);
  } finally { await d.done(); }
});

test('routines: bad fields are 400 before anything is asked', async () => {
  const r = await rig({ routine: 'allow' });
  try {
    for (const b of [{ action: 'create' }, { action: 'create', title: 'x', status: 'weird' }, { action: 'update', routine: ROUTINE }, { action: 'schedule', routine: ROUTINE, trigger: TRIGGER, cron: 'drop table' }, { action: 'run', routine: '../x' }]) {
      await assert.rejects(r.hq.write({ kind: 'routine', ...b }), (e) => e.status === 400, JSON.stringify(b));
    }
    assert.deepEqual(r.writes(), []);
  } finally { await r.done(); }
});

test('routines: the view carries what the page edits (agent id, schedule trigger)', async () => {
  const r = await rig({});
  try {
    const v = r.hq.view().routines[0];
    assert.equal(v.id, ROUTINE);
    assert.equal(v.agentId, D.routines[0].assigneeAgentId);
    assert.deepEqual(v.trigger, { id: TRIGGER, cron: '0 9 * * 1', timezone: 'UTC', enabled: true });
  } finally { await r.done(); }
});
