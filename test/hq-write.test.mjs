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
import { officeKinds } from './fixtures/office-kinds.mjs';

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

test('goals (#207): create and update are one request each, the parent and owner must be in the company, the view shows the new goal', async () => {
  const r = await rig({ goal: 'allow' });
  const G1 = D.goals[0].id;
  try {
    const made = await r.hq.write({ kind: 'goal', action: 'create', title: 'Cut build time', description: 'Under two minutes.', level: 'team', parent: G1, owner: ADA });
    assert.match(made.id, /^g2000000/);
    await r.hq.write({ kind: 'goal', action: 'update', goal: G1, status: 'achieved' });
    await r.hq.write({ kind: 'goal', action: 'update', goal: G1, owner: null });
    assert.deepEqual(r.writes(), [
      ['POST', `/api/companies/${CO}/goals`, { title: 'Cut build time', description: 'Under two minutes.', level: 'team', parentId: G1, ownerAgentId: ADA }],
      ['PATCH', `/api/goals/${G1}`, { status: 'achieved' }],
      ['PATCH', `/api/goals/${G1}`, { ownerAgentId: null }],
    ]);
    await until(() => (r.hq.view().goals.rows.find((x) => x.id === made.id) || {}).parentId === G1, 'the new goal in the view');
    assert.equal(r.hq.view().goals.rows.find((x) => x.id === made.id).owner, 'Ada');
    await assert.rejects(r.hq.write({ kind: 'goal', action: 'update', goal: 'g9999999', status: 'active' }), (e) => e.status === 404);
    await assert.rejects(r.hq.write({ kind: 'goal', action: 'create', title: 'X', parent: 'g9999999' }), (e) => e.status === 404);
    assert.equal(r.writes().length, 3, 'a refused write sends nothing');
  } finally { await r.done(); }
});

test('goals (#207): Confirm asks first and Deny refuses', async () => {
  const r = await rig({ goal: 'confirm' });
  try {
    const e = await r.hq.write({ kind: 'goal', action: 'create', title: 'Ship it' }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.deepEqual(e.answer.body.write, { kind: 'goal', action: 'create', summary: 'Create the goal "Ship it"' });
    assert.equal(r.writes().length, 0);
    await r.hq.write({ kind: 'goal', action: 'create', title: 'Ship it' }, { confirmed: true });
    assert.equal(r.writes().length, 1);
  } finally { await r.done(); }
  const d = await rig({ goal: 'deny' });
  try {
    await assert.rejects(d.hq.write({ kind: 'goal', action: 'update', goal: D.goals[0].id, status: 'active' }, { confirmed: true }), (e) => e.status === 403);
    assert.equal(d.writes().length, 0);
  } finally { await d.done(); }
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

// ---------- company admin (#213): settings, invites and access ----------
const INVITE = D.invites[0].id, JOIN = D.joinRequests[0].id, PAT = D.members[1].id;

test('company settings and every access write are one request each', async () => {
  const r = await rig({ company: 'allow', access: 'allow' });
  try {
    await r.hq.write({ kind: 'company', action: 'update', name: 'Acme Labs', requireBoardApprovalForNewAgents: true });
    const made = await r.hq.write({ kind: 'access', action: 'invite', allowedJoinTypes: 'human', humanRole: 'viewer', agentMessage: 'Welcome.' });
    await r.hq.write({ kind: 'access', action: 'revoke', invite: INVITE });
    await r.hq.write({ kind: 'access', action: 'approveJoin', join: JOIN });
    await r.hq.write({ kind: 'access', action: 'member', member: PAT, role: 'operator' });
    assert.deepEqual(Object.keys(made).sort(), ['id', 'ok']);
    assert.deepEqual(r.writes(), [
      ['PATCH', `/api/companies/${CO}`, { name: 'Acme Labs', requireBoardApprovalForNewAgents: true }],
      ['POST', `/api/companies/${CO}/invites`, { allowedJoinTypes: 'human', humanRole: 'viewer', agentMessage: 'Welcome.' }],
      ['POST', `/api/invites/${INVITE}/revoke`, {}],
      ['POST', `/api/companies/${CO}/join-requests/${JOIN}/approve`, {}],
      ['PATCH', `/api/companies/${CO}/members/${PAT}`, { membershipRole: 'operator' }],
    ]);
    assert.doesNotMatch(JSON.stringify(made) + JSON.stringify(r.feed), /do-not-show|pcp_invite/, 'the invite token and link reach no result or feed line');
  } finally { await r.done(); }
});

test('access writes wait for the Confirm by default, and Deny refuses them', async () => {
  const r = await rig({});
  try {
    const e = await r.hq.write({ kind: 'access', action: 'rejectJoin', join: JOIN }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.write.summary, 'Reject a join request');
    const u = await r.hq.write({ kind: 'company', action: 'update', description: 'Robots.' }).then(() => null, (x) => x);
    assert.equal(u.status, 409);
    assert.equal(r.writes().length, 0);
    await r.hq.write({ kind: 'access', action: 'rejectJoin', join: JOIN }, { confirmed: true });
    assert.deepEqual(r.writes(), [['POST', `/api/companies/${CO}/join-requests/${JOIN}/reject`, {}]]);
  } finally { await r.done(); }
  const d = await rig({ access: 'deny' });
  try {
    await assert.rejects(d.hq.write({ kind: 'access', action: 'invite', allowedJoinTypes: 'both' }, { confirmed: true }), (e) => e.status === 403 && /Invites and access/.test(e.message));
    assert.equal(d.writes().length, 0);
  } finally { await d.done(); }
});

test('an invite, join request or member that is not in the company, or already decided, is refused before the write; bad bodies are 400', async () => {
  const r = await rig({ access: 'allow' });
  try {
    await assert.rejects(r.hq.write({ kind: 'access', action: 'revoke', invite: 'v0000000-0000-4000-8000-000000000404' }), (e) => e.status === 404);
    await assert.rejects(r.hq.write({ kind: 'access', action: 'member', member: 'm0000000-0000-4000-8000-000000000404', role: 'admin' }), (e) => e.status === 404);
    await r.hq.write({ kind: 'access', action: 'approveJoin', join: JOIN });
    await assert.rejects(r.hq.write({ kind: 'access', action: 'rejectJoin', join: JOIN }), (e) => e.status === 409);
    await r.hq.write({ kind: 'access', action: 'revoke', invite: INVITE });
    await assert.rejects(r.hq.write({ kind: 'access', action: 'revoke', invite: INVITE }), (e) => e.status === 409);
    for (const b of [{ allowedJoinTypes: 'everyone' }, { humanRole: 'owner' }, { humanRole: 'root' }]) await assert.rejects(r.hq.write({ kind: 'access', action: 'invite', ...b }), (e) => e.status === 400, JSON.stringify(b));
    await assert.rejects(r.hq.write({ kind: 'access', action: 'member', member: PAT }), (e) => e.status === 400);
    await assert.rejects(r.hq.write({ kind: 'access', action: 'member', member: PAT, status: 'banned' }), (e) => e.status === 400);
    await assert.rejects(r.hq.write({ kind: 'company', action: 'update' }), (e) => e.status === 400);
    await assert.rejects(r.hq.write({ kind: 'company', action: 'update', requireBoardApprovalForNewAgents: 'yes' }), (e) => e.status === 400);
    assert.equal(r.writes().length, 2, 'only the approval and the revoke were sent');
  } finally { await r.done(); }
});

test('access() lists names, roles and states, never a token, a link or an address', async () => {
  const r = await rig({});
  try {
    const a = await r.hq.access();
    assert.deepEqual(a.invites.map((x) => [x.id, x.state, x.joins, x.role]), [[INVITE, 'active', 'human', 'operator']]);
    assert.deepEqual(a.joins.map((x) => [x.id, x.status, x.type, x.name]), [[JOIN, 'pending_approval', 'human', 'sam@example.com']]);
    assert.deepEqual(a.members.map((x) => [x.name, x.role, x.status]), [['Justin', 'owner', 'active'], ['Pat', 'viewer', 'active']]);
    assert.equal(a.error, null);
    assert.doesNotMatch(JSON.stringify(a), /do-not-show|203\.0\.113|tokenHash/);
  } finally { await r.done(); }
});

// ---------- company admin, the rest (#221): other companies, export and import, instance settings and environments ----------
const ENV_LOCAL = D.environments[0].id, ENV_BOX = D.environments[1].id;
const BUNDLE = { rootPath: 'acme', files: { 'COMPANY.md': '---\nname: Acme Labs\n---\n', 'agents/grace/AGENTS.md': 'Grace', 'agents/ada/AGENTS.md': 'Ada', 'projects/web/PROJECT.md': 'Web', 'tasks/fix/TASK.md': 'Fix' } };

test('other companies of the Paperclip are listed as others, and a new company shows after a write that makes one', async () => {
  const r = await rig({ company: 'allow' });
  try {
    assert.deepEqual(r.hq.view().others, [], 'one company: no other building');
    await r.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE, name: 'Acme Labs' });
    await until(() => r.hq.view().others.length === 1, 'the company list read again');
    assert.deepEqual(r.hq.view().others.map((x) => x.name), ['Acme Labs']);
    assert.equal(r.hq.view().company.name, 'Acme Robotics', 'the watched company stays');
  } finally { await r.done(); }
});

test('company import: the preview first, then one POST as a new company with automations paused, never replace', async () => {
  const r = await rig({ company: 'allow' });
  try {
    const made = await r.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE, name: 'Acme Labs' });
    assert.deepEqual(Object.keys(made).sort(), ['id', 'name', 'ok']);
    assert.equal(made.name, 'Acme Labs');
    const sent = r.pc.requests.filter((x) => x.method === 'POST' && x.path.startsWith('/api/companies/import'));
    assert.deepEqual(sent.map((x) => x.path), ['/api/companies/import/preview', '/api/companies/import']);
    for (const x of sent) {
      assert.equal(x.body.collisionStrategy, 'rename');
      assert.deepEqual(x.body.target, { mode: 'new_company', newCompanyName: 'Acme Labs' });
      assert.equal(x.body.source.expectedFileCount, 5);
      assert.ok(!('secretValues' in x.body) && !('adapterOverrides' in x.body));
    }
    assert.equal(sent[1].body.pauseAutomations, true);
    assert.deepEqual(r.pc.imports, [{ name: 'Acme Labs', agents: 2, projects: 1, tasks: 1, pauseAutomations: true, collisionStrategy: 'rename' }]);
    assert.ok(r.feed.some(([, t]) => /Import "Acme Labs" as a new company/.test(t)));
  } finally { await r.done(); }
});

test('company import waits for the Confirm and says what it holds; a preview with errors, no COMPANY.md and a bad bundle are refused', async () => {
  const r = await rig({});
  try {
    const e = await r.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.write.summary, 'Import "Acme Labs" as a new company (2 employees, 1 project, 1 task; routines start paused)');
    assert.deepEqual(r.writes().map((w) => w[1]), ['/api/companies/import/preview'], 'only the preview was sent');
    await assert.rejects(r.hq.write({ kind: 'company', action: 'import', bundle: { files: { 'agents/a/AGENTS.md': 'x' } } }, { confirmed: true }), (x) => x.status === 502 && /COMPANY\.md/.test(x.message));
    for (const bundle of [null, {}, { files: {} }, { files: { '../x': 'a' } }, { files: { '/x': 'a' } }, { files: { 'a\\b': 'a' } }, { files: { a: 5 } }, { files: { a: { encoding: 'hex', data: 'zz' } } }, { files: ['COMPANY.md'] }]) {
      await assert.rejects(r.hq.write({ kind: 'company', action: 'import', bundle }, { confirmed: true }), (x) => x.status === 400, JSON.stringify(bundle));
    }
    await assert.rejects(r.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE, include: { agents: 'yes' } }, { confirmed: true }), (x) => x.status === 400);
    await assert.rejects(r.hq.write({ kind: 'company', action: 'import', bundle: { files: { 'COMPANY.md': 'x'.repeat(10 * 1024 * 1024 + 1) } } }, { confirmed: true }), (x) => x.status === 413);
    assert.ok(r.writes().every((w) => w[1] === '/api/companies/import/preview'), 'only previews, never the import');
  } finally { await r.done(); }
  const bad = await rig({ company: 'allow' }, { ...DEMO(), importErrors: ['Safe import does not allow project web.'] });
  try {
    await assert.rejects(bad.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE }), (x) => x.status === 400 && /does not allow project web/.test(x.message));
    assert.ok(bad.writes().every((w) => w[1].endsWith('/preview')), 'a preview with errors stops the write');
  } finally { await bad.done(); }
  const d = await rig({ company: 'deny' });
  try {
    await assert.rejects(d.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE }, { confirmed: true }), (x) => x.status === 403);
    assert.equal(d.pc.requests.filter((x) => x.path.startsWith('/api/companies/import')).length, 0, 'Deny: not even a preview');
  } finally { await d.done(); }
});

test('company import: Paperclip refusing a non instance admin is an error, nothing changes', async () => {
  const r = await rig({ company: 'allow' }, { ...DEMO(), notInstanceAdmin: true });
  try {
    await assert.rejects(r.hq.write({ kind: 'company', action: 'import', bundle: BUNDLE }), (x) => x.status === 502);
    assert.equal(r.pc.imports.length, 0);
  } finally { await r.done(); }
});

test('company export is one POST of the writer (the export cell, never asked), returns the bundle, and leaves a feed line', async () => {
  const r = await rig({});
  try {
    const out = await r.hq.exportCompany({ include: { agents: false } });
    assert.deepEqual(Object.keys(out).sort(), ['files', 'manifest', 'rootPath', 'warnings']);
    assert.deepEqual(Object.keys(out.files), ['COMPANY.md']);
    assert.deepEqual(r.writes(), [['POST', `/api/companies/${CO}/export`, { include: { agents: false } }]]);
    assert.ok(r.feed.some(([, t]) => /Exported the company Acme Robotics/.test(t)));
    await assert.rejects(r.hq.exportCompany({ include: { agents: 'no' } }), (e) => e.status === 400);
    const again = await r.hq.exportCompany({});
    assert.ok(again.files['agents/grace/AGENTS.md']);
  } finally { await r.done(); }
});

// Review of the HQ build, finding 4: Supervise in office, the goal handoff and the company export were sent beside the writer. Now each is a
// write of it, so Deny in the grid stops it and nothing reaches Paperclip.
test('Deny in the grid stops Supervise in office, the goal handoff and the company export: nothing is sent, the feed says so', async () => {
  const r = await rig({ supervise: 'deny', task: 'deny', export: 'deny' });
  try {
    const ada = r.hq.view().agents.find((a) => a.name === 'Ada');
    await assert.rejects(r.hq.supervise(ada.id), (e) => e.status === 403 && /Supervise in office/.test(e.message));
    await assert.rejects(r.hq.handoffGoal({ id: 'g1', goal: 'Ship it', steps: [{ id: 'g1-1', text: 'Write the code' }] }), (e) => e.status === 403 && /Tasks/.test(e.message) && e.written && Object.keys(e.written).length === 0);
    await assert.rejects(r.hq.exportCompany({}), (e) => e.status === 403 && /Company export/.test(e.message));
    assert.deepEqual(r.writes(), [], 'no PATCH, no task POST, no export POST');
    assert.equal(r.feed.filter(([, t]) => /^Refused by the HQ write grid/.test(t)).length, 3);
  } finally { await r.done(); }
  // Supervise on Confirm (the default): the route's painted Confirm is its Confirm, so it sends; the writer's own call without it asks first
  const c = await rig({});
  try {
    const ada = c.hq.view().agents.find((a) => a.name === 'Ada');
    const e = await c.hq.write({ kind: 'supervise', action: 'set', agent: ada.id }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.confirm, 'write');
    assert.match(e.answer.body.write.summary, /^Supervise Ada in the office/);
    assert.deepEqual(c.writes(), [], 'asked, not sent');
    const ok = await c.hq.supervise(ada.id);
    assert.deepEqual([ok.ok, ok.supervision.state], [true, 'supervised']);
    assert.deepEqual(c.writes().map((w) => [w[0], w[1]]), [['PATCH', `/api/agents/${ada.id}`]]);
    assert.deepEqual(Object.keys(c.writes()[0][2]), ['adapterConfig'], 'the body the writer built from its read, nothing from the request');
  } finally { await c.done(); }
});

test('instance settings, the default environment and an environment are one PATCH each', async () => {
  const r = await rig({ instance: 'allow' });
  try {
    await r.hq.write({ kind: 'instance', action: 'general', censorUsernameInLogs: true, feedbackDataSharingPreference: 'not_allowed' });
    await r.hq.write({ kind: 'instance', action: 'defaultEnvironment', environment: ENV_BOX });
    await r.hq.write({ kind: 'instance', action: 'environment', environment: ENV_BOX, name: 'Builder', status: 'archived' });
    await r.hq.write({ kind: 'instance', action: 'defaultEnvironment', environment: null });
    assert.deepEqual(r.writes(), [
      ['PATCH', '/api/instance/settings/general', { censorUsernameInLogs: true, feedbackDataSharingPreference: 'not_allowed' }],
      ['PATCH', '/api/instance/settings', { defaultEnvironmentId: ENV_BOX }],
      ['PATCH', `/api/environments/${ENV_BOX}`, { name: 'Builder', status: 'archived' }],
      ['PATCH', '/api/instance/settings', { defaultEnvironmentId: null }],
    ]);
  } finally { await r.done(); }
});

test('instance writes wait for the Confirm by default; bad bodies and unknown environments are refused before anything is sent', async () => {
  const r = await rig({});
  try {
    const e = await r.hq.write({ kind: 'instance', action: 'environment', environment: ENV_LOCAL, status: 'archived' }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.write.summary, 'Archive an environment');
    assert.equal(r.writes().length, 0);
    for (const b of [{ action: 'general' }, { action: 'general', censorUsernameInLogs: 'yes' }, { action: 'general', feedbackDataSharingPreference: 'sometimes' }, { action: 'environment', environment: ENV_LOCAL }, { action: 'environment', environment: ENV_LOCAL, status: 'gone' }, { action: 'environment', environment: ENV_LOCAL, name: ' ' }, { action: 'environment' }]) {
      await assert.rejects(r.hq.write({ kind: 'instance', ...b }, { confirmed: true }), (x) => x.status === 400, JSON.stringify(b));
    }
    await assert.rejects(r.hq.write({ kind: 'instance', action: 'environment', environment: 'e0000000-0000-4000-8000-000000000404', name: 'X' }, { confirmed: true }), (x) => x.status === 404);
    await assert.rejects(r.hq.write({ kind: 'instance', action: 'defaultEnvironment', environment: 'e0000000-0000-4000-8000-000000000404' }, { confirmed: true }), (x) => x.status === 404);
    assert.equal(r.writes().length, 0);
  } finally { await r.done(); }
  const d = await rig({ instance: 'deny' });
  try {
    await assert.rejects(d.hq.write({ kind: 'instance', action: 'general', censorUsernameInLogs: true }, { confirmed: true }), (x) => x.status === 403 && /Instance and environments/.test(x.message));
    assert.equal(d.writes().length, 0);
  } finally { await d.done(); }
});

test('instance() lists environments by name and state and the settings, never a config or an env value', async () => {
  const r = await rig({});
  try {
    const i = await r.hq.instance();
    assert.deepEqual(i.environments.map((x) => [x.id, x.name, x.driver, x.status, x.isDefault]), [[ENV_LOCAL, 'Local', 'local', 'active', false], [ENV_BOX, 'Build box', 'ssh', 'active', false]]);
    assert.deepEqual(i.general, { censorUsernameInLogs: false, feedbackDataSharingPreference: 'prompt' });
    assert.equal(i.defaultEnvironmentId, null);
    assert.equal(i.error, null);
    assert.doesNotMatch(JSON.stringify(i), /do-not-show|privateKey|build\.example/);
  } finally { await r.done(); }
});

// ---------- the office adapter install (#222): POST /api/adapters/install, idempotent, through the grid ----------
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ADAPTER_DIR = path.resolve(fileURLToPath(new URL('../src/integrations/paperclip-adapter', import.meta.url)));
async function adapterRig(grid = {}, seed = { ...DEMO(), adapters: [{ type: 'claude_local', label: 'Claude Code', source: 'builtin', modelsCount: 3, loaded: true, disabled: false, capabilities: {} }] }, adapterDir = ADAPTER_DIR) {
  const pc = await startFakePaperclip({ ...seed, boardKey: KEY });
  const feed = [];
  const hq = createHq({ ...fast, hooksFile: () => 'C:/office/office-hooks.json', key: () => KEY, kinds: officeKinds, grid: () => grid, askFirst, adapterDir, onFeed: (t, k) => feed.push([k, t]) });
  await hq.connect({ url: pc.url });
  await until(() => hq.state() === 'on', 'the events socket');
  return { pc, hq, feed, writes: () => pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE'), done: async () => { hq.disconnect(); await pc.close(); } };
}
const INSTALL = { kind: 'adapter', action: 'install' };

test('adapter: Confirm asks first and sends nothing; the confirmed call sends one POST with the office folder, and the adapter is then installed', async () => {
  const r = await adapterRig();
  try {
    assert.equal((await r.hq.adapter()).state, 'missing');
    const e = await r.hq.write(INSTALL).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.confirm, 'write');
    assert.equal(e.answer.body.write.summary, 'Install the office adapter in Paperclip');
    assert.equal(r.writes().length, 0, 'nothing was sent before the Confirm');
    const made = await r.hq.write({ ...INSTALL, packageName: 'C:/evil', localPath: 'C:/evil' }, { confirmed: true });
    assert.deepEqual(made, { ok: true, type: 'agent_office', existed: false, requiresRestart: false });
    assert.deepEqual(r.writes().map((x) => [x.method, x.path, x.body]), [['POST', '/api/adapters/install', { isLocalPath: true, packageName: ADAPTER_DIR }]], 'the folder is the office folder, never the caller folder');
    assert.equal((await r.hq.adapter()).state, 'installed');
    assert.ok(!JSON.stringify([r.feed, made]).includes(KEY), 'the board key reaches no feed line or answer');
  } finally { await r.done(); }
});

test('adapter: a second install sends nothing (idempotent), also when it was switched off in Paperclip', async () => {
  const r = await adapterRig({ adapter: 'allow' });
  try {
    await r.hq.write(INSTALL);
    assert.equal(r.writes().length, 1);
    const again = await r.hq.write(INSTALL);
    assert.deepEqual(again, { ok: true, type: 'agent_office', existed: true, off: false });
    assert.equal(r.writes().length, 1, 'no second request');
    r.pc.state.adapters.find((x) => x.type === 'agent_office').disabled = true;
    const off = await r.hq.write(INSTALL);
    assert.equal(off.off, true);
    assert.equal(r.writes().length, 1);
    assert.equal((await r.hq.adapter()).state, 'off');
  } finally { await r.done(); }
});

test('adapter: Deny refuses with 403 and sends nothing; a Paperclip refusal (not an instance admin) is named, with no key in it', async () => {
  const d = await adapterRig({ adapter: 'deny' });
  try {
    const e = await d.hq.write(INSTALL, { confirmed: true }).then(() => null, (x) => x);
    assert.equal(e.status, 403);
    assert.match(e.message, /Office adapter/);
    assert.equal(d.writes().length, 0);
  } finally { await d.done(); }
  const n = await adapterRig({ adapter: 'allow' }, { ...DEMO(), adapters: [], notAdmin: true });
  try {
    const e = await n.hq.write(INSTALL).then(() => null, (x) => x);
    assert.ok(e && e.status >= 400, 'refused');
    assert.match(e.message, /needs an instance admin/);
    assert.ok(!(e.message + JSON.stringify(n.feed)).includes(KEY));
    assert.ok(n.feed.some(([, t]) => /Paperclip refused the write: Install the office adapter/.test(t)));
  } finally { await n.done(); }
});

test('adapter: an adapter folder that is missing is a 500 before anything is sent', async () => {
  const r = await adapterRig({ adapter: 'allow' }, undefined, path.join(ADAPTER_DIR, 'nowhere'));
  try {
    const e = await r.hq.write(INSTALL).then(() => null, (x) => x);
    assert.equal(e.status, 500);
    assert.equal(r.writes().length, 0);
  } finally { await r.done(); }
});

test('hire: refused with the reason while the adapter is missing or off, before any Confirm; allowed once it is installed', async () => {
  const r = await adapterRig({ hire: 'allow', adapter: 'allow' });
  const hire = { kind: 'hire', action: 'create', name: 'Mira', role: 'engineer', manager: D.agents[0].id, budgetDollars: 25 };
  try {
    const e = await r.hq.write(hire).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.match(e.message, /does not have the office adapter yet\. Install it at the HQ first/);
    assert.equal(r.writes().length, 0, 'no hire request');
    assert.ok(r.feed.some(([, t]) => /^Hire not sent/.test(t)));
    await r.hq.write(INSTALL);
    r.pc.state.adapters.find((x) => x.type === 'agent_office').disabled = true;
    const off = await r.hq.write(hire).then(() => null, (x) => x);
    assert.match(off.message, /switched off/);
    r.pc.state.adapters.find((x) => x.type === 'agent_office').disabled = false;
    const made = await r.hq.write(hire);
    assert.match(made.id, /^a4000000/);
  } finally { await r.done(); }
});

// ---------- profile settings (#228): the signed-in person's name, PATCH /api/auth/profile through the grid ----------
test('profile() reads the signed-in person and drops the picture; a key that is no person\'s is an error, not a throw', async () => {
  const r = await rig({});
  try {
    const p = await r.hq.profile();
    assert.deepEqual(p, { id: 'u1', name: 'Justin', email: 'j@example.com', error: null });
    assert.doesNotMatch(JSON.stringify(p), /do-not-show|base64/);
  } finally { await r.done(); }
  const n = await rig({}, { ...DEMO(), noProfile: true });
  try {
    const p = await n.hq.profile();
    assert.equal(p.name, null);
    assert.match(p.error, /does not accept the board key/);
    assert.doesNotMatch(JSON.stringify(p), new RegExp(KEY));
  } finally { await n.done(); }
});

test('the profile name waits for the Confirm, then is one PATCH with the name only; bad names are refused before anything is sent', async () => {
  const r = await rig({});
  try {
    const e = await r.hq.write({ kind: 'profile', action: 'name', name: ' Justin M ' }).then(() => null, (x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.answer.body.write.summary, 'Change your Paperclip profile name to "Justin M"');
    assert.equal(r.writes().length, 0);
    for (const b of [{}, { name: '' }, { name: '   ' }, { name: 7 }, { name: 'x'.repeat(121) }]) {
      await assert.rejects(r.hq.write({ kind: 'profile', action: 'name', ...b }, { confirmed: true }), (x) => x.status === 400, JSON.stringify(b));
    }
    assert.equal(r.writes().length, 0);
    assert.deepEqual(await r.hq.write({ kind: 'profile', action: 'name', name: ' Justin M ' }, { confirmed: true }), { ok: true });
    assert.deepEqual(r.writes(), [['PATCH', '/api/auth/profile', { name: 'Justin M' }]]);
    assert.equal((await r.hq.profile()).name, 'Justin M');
    assert.ok(r.feed.some(([, t]) => /Justin M/.test(t)));
    assert.ok(!JSON.stringify(r.feed).includes(KEY));
  } finally { await r.done(); }
  const d = await rig({ profile: 'deny' });
  try {
    await assert.rejects(d.hq.write({ kind: 'profile', action: 'name', name: 'X' }, { confirmed: true }), (x) => x.status === 403 && /Your Paperclip profile/.test(x.message));
    assert.equal(d.writes().length, 0);
  } finally { await d.done(); }
});
