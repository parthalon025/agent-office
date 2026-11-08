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
    assert.deepEqual(l.approvals, { pending: 1, items: [{ id: 'p1000000-0000-4000-8000-000000000001', kind: 'hire_agent', by: 'Grace', approval: 'p1000000-0000-4000-8000-000000000001', link: `${pc.url}/ACM/approvals/p1000000-0000-4000-8000-000000000001` }] });
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

test('costs (#208): three months per agent and project, the budgets; a month Paperclip lacks is unknown; only reads', async () => {
  const pc = await startFakePaperclip(DEMO());
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, now: () => Date.UTC(2026, 10, 6) });
  try {
    assert.equal(await hq.costs(), null, 'not connected: nothing');
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const c = await hq.costs();
    assert.deepEqual(c.months.map((m) => [m.key, m.total, m.partial]), [['2026-11', 12.4, false], ['2026-10', 20, false], ['2026-09', null, false]]);
    assert.deepEqual(c.months[0].agents.map((a) => [a.name, a.cost]), [['Ada', 8.3], ['Grace', 4.1]]);
    assert.deepEqual(c.months[0].projects, [{ id: 'pr1', name: 'Web', cost: 12.4 }]);
    assert.equal(c.months[2].agents, null, 'a month that cannot be read is unknown, not $0.00');
    assert.deepEqual(c.budgets.map((b) => [b.name, b.limit, b.used, b.percent, b.status]), [['Ada', 50, 45, 90, 'warning'], ['Acme Robotics', 100, 12.4, 12.4, 'ok']]);
    assert.doesNotMatch(JSON.stringify(c), /do-not-show/);
    assert.equal(pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').length, 0, 'the Costs view only reads');
  } finally { hq.disconnect(); await pc.close(); }
});

test('costs (#208): a changed shape is not used, and a Paperclip without the budgets route has no budgets, not none set', async () => {
  const pc = await startFakePaperclip({ ...DEMO(), budgets: null });
  pc.state.costMonths['2026-10'].agents = [{ agentId: 'x', agentName: 'X', costCents: 'a lot' }];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, now: () => Date.UTC(2026, 10, 6) });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const c = await hq.costs();
    assert.equal(c.budgets, null);
    assert.equal(c.months[1].agents, null, 'a retyped cost is not read');
    assert.match(c.contract[0], /costsByAgent: costCents is string, expected number/);
  } finally { hq.disconnect(); await pc.close(); }
});

test('catalog (#212): skills, secret names, plugins and adapters; no value, file or manifest; a missing or retyped route is unknown; only reads', async () => {
  const pc = await startFakePaperclip(DEMO());
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    assert.equal(await hq.catalog(), null, 'not connected: nothing');
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const c = await hq.catalog();
    assert.deepEqual(c.skills, [{ id: 'k1', key: 'acme/review', name: 'Code review', description: 'How we review a change', source: 'local_path', trust: 'markdown_only' }]);
    assert.deepEqual(c.secrets, [{ id: 's1', name: 'GITHUB_TOKEN', provider: 'local_encrypted' }]);
    assert.deepEqual(c.plugins, [{ id: 'pl1', name: 'acme.linear', version: '1.2.0', status: 'ready', error: '' }]);
    assert.deepEqual(c.adapters.map((a) => [a.type, a.source, a.version, a.disabled]), [['claude_local', 'builtin', '', false], ['agent_office', 'external', '0.1.0', false]]);
    assert.deepEqual(c.contract, []);
    assert.doesNotMatch(JSON.stringify(c), /do-not-show|secret-path/, 'a secret value, a skill file, a manifest and a source path never leave the HQ module');
    assert.equal(pc.requests.filter((r) => r.method !== 'GET' && r.method !== 'UPGRADE').length, 0);
    pc.state.plugins = [{ id: 'x', pluginKey: 7, status: 'ready' }];   // retyped
    const bad = await hq.catalog();
    assert.equal(bad.plugins, null, 'a retyped route is unknown, not an empty list');
    assert.match(bad.contract[0], /plugins: pluginKey is number, expected string/);
    assert.equal(bad.skills.length, 1, 'the other parts still read');
  } finally { hq.disconnect(); await pc.close(); }
});

test('catalog (#212): a Paperclip without the skills route has unknown skills, not none', async () => {
  const pc = await startFakePaperclip({ ...DEMO(), noSkills: true });
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const c = await hq.catalog();
    assert.equal(c.skills, null);
    assert.equal(c.secrets.length, 1);
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

test('read model: projects are rooms with their workspaces, and an employee sits in the room of its open task (#211)', async () => {
  const seed = DEMO(), cid = seed.companies[0].id;
  seed.issues[0] = { ...seed.issues[0], projectId: 'proj-web', projectWorkspaceId: 'ws-main' };
  seed.projects = [{ id: 'proj-web', companyId: cid, name: 'Web app', status: 'in_progress', env: null, workspaces: [{ id: 'ws-main', name: 'main', cwd: 'C:/work/acme', isPrimary: true, env: { SECRET: 'do-not-show' } }] },
    { id: 'proj-idle', companyId: cid, name: 'Idle', status: 'planned', env: null }];
  const pc = await startFakePaperclip(seed);
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const v = hq.view();
    assert.deepEqual(v.rooms, [
      { id: 'proj-web', name: 'Web app', status: 'in_progress', workspaces: [{ id: 'ws-main', name: 'main', folder: 'C:/work/acme', primary: true }], employees: [{ id: 'a1000000-0000-4000-8000-000000000002', name: 'Ada', workspace: 'main' }] },
      { id: 'proj-idle', name: 'Idle', status: 'planned', workspaces: [], employees: [] }]);
    assert.doesNotMatch(JSON.stringify(v), /do-not-show/, 'a workspace env value never leaves the HQ module');
  } finally { hq.disconnect(); await pc.close(); }
});

test('read model: a Paperclip with no projects route has no rooms, not an error (#211)', async () => {
  const pc = await startFakePaperclip({ ...DEMO(), noProjects: true });
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    assert.deepEqual(hq.view().rooms, []);
  } finally { hq.disconnect(); await pc.close(); }
});

test('org chart (#202): the view carries the reporting cables; a reporting line is one write of hq.write: one PATCH, and the floors rebuild from the change', async () => {
  const pc = await startFakePaperclip(DEMO());
  const [grace, ada, linus] = DEMO().agents;
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  const line = (id, mgr, o = { confirmed: true }) => hq.write({ kind: 'reporting', action: 'set', agent: id, manager: mgr }, o);
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    assert.deepEqual(hq.view().cables, [{ from: ada.id, to: grace.id }, { from: linus.id, to: ada.id }]);
    assert.equal(hq.view().floors.at(-3).employees[0].reportsTo, ada.id, 'an employee carries its manager');
    const before = pc.requests.filter((r) => r.method === 'PATCH').length;
    const r = await line(linus.id, grace.id);
    assert.equal(r.ok, true);
    const patches = pc.requests.filter((r2) => r2.method === 'PATCH').slice(before);
    assert.equal(patches.length, 1, 'one PATCH');
    assert.deepEqual(patches[0].body, { reportsTo: grace.id }, 'the body names the reporting line and nothing else');
    assert.deepEqual(hq.view().floors.map((f) => [f.key, f.employees.map((e) => e.name).sort()]), [['records', []], ['lobby', []], ['rank-1', ['Ada', 'Linus']], ['rank-0', ['Grace']]], 'Linus moved up a floor');
    assert.deepEqual(hq.view().cables, [{ from: ada.id, to: grace.id }, { from: linus.id, to: grace.id }]);
    await line(ada.id, null);   // a root: no manager
    assert.equal(hq.view().cables.length, 1);
  } finally { hq.disconnect(); await pc.close(); }
});

test('org chart (#202): the write grid decides a reporting line: Confirm asks, Deny refuses, Allow sends; the write names both employees', async () => {
  const pc = await startFakePaperclip(DEMO());
  const [grace, , linus] = DEMO().agents;
  let grid = {};
  const fed = [];
  const hq = createHq({ ...fast, hooksFile: () => HOOKS, grid: () => grid, onFeed: (t) => fed.push(t) });
  const line = (o) => hq.write({ kind: 'reporting', action: 'set', agent: linus.id, manager: grace.id }, o);
  const patches = () => pc.requests.filter((r) => r.method === 'PATCH').length;
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    await assert.rejects(() => line({}), (e) => e.status === 409 && e.confirm === 'write' && e.write.summary === 'Make Linus report to Grace', 'Confirm is the default: it asks first, with both names');
    assert.equal(patches(), 0);
    grid = { reporting: 'deny' };
    await assert.rejects(() => line({ confirmed: true }), (e) => e.status === 403, 'Deny refuses, also with a confirmation');
    assert.equal(patches(), 0);
    grid = { reporting: 'allow' };
    assert.equal((await line({})).ok, true, 'Allow sends with no question');
    assert.equal(patches(), 1);
    assert.ok(fed.some((t) => /Wrote to .*Make Linus report to Grace/.test(t)), 'the write leaves its feed line');
  } finally { hq.disconnect(); await pc.close(); }
});

test('org chart (#202): a loop, a self report, an unknown employee or manager is refused before any PATCH', async () => {
  const pc = await startFakePaperclip(DEMO());
  const [grace, ada, linus] = DEMO().agents;
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    const line = (id, mgr) => hq.write({ kind: 'reporting', action: 'set', agent: id, manager: mgr }, { confirmed: true });
    await assert.rejects(() => line(linus.id, grace.id), (e) => e.status === 409, 'not connected');
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    for (const [id, mgr, status, re] of [[grace.id, linus.id, 400, /loop/], [ada.id, ada.id, 400, /itself/], ['nobody', grace.id, 404, /not in the company/], [linus.id, 'ghost', 400, /manager is not/]]) {
      await assert.rejects(() => line(id, mgr), (e) => e.status === status && re.test(e.message), `${id} -> ${mgr}`);
    }
    assert.equal(pc.requests.filter((r) => r.method === 'PATCH').length, 0);
  } finally { hq.disconnect(); await pc.close(); }
});

test('read model: the view lists the open tasks for the mailroom with the assignee and a link, and no description (#224)', async () => {
  const pc = await startFakePaperclip(DEMO());
  const hq = createHq({ ...fast, hooksFile: () => HOOKS });
  try {
    await hq.connect({ url: pc.url });
    await until(() => hq.state() === 'on', 'the events socket');
    const t = hq.view().tasks;
    assert.equal(t.length, 2, 'the two open tasks of the demo company');
    for (const x of t) {
      assert.deepEqual(Object.keys(x).sort(), ['assignee', 'assigneeId', 'id', 'identifier', 'link', 'status', 'title']);
      assert.match(x.link, /^http:\/\/127\.0\.0\.1:\d+\/ACM\/issues\//);
    }
    assert.ok(t.some((x) => x.assignee), 'an assigned task names its employee');
  } finally { hq.disconnect(); await pc.close(); }
});
