// The HQ read model (#197), pure part: the org chart as floors, the Lobby dashboard, and the contract of the Paperclip API shapes the
// office reads (test/fixtures/paperclip-shapes.json: the recorded shapes). No server, no network except the fake Paperclip in the
// contract test. Run: node --test test/hq-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { goalsOf, floorsOf, departmentsOf, cablesOf, reportingProblem, lobbyOf, costsOf, monthWindows, shapeProblems, shapeOf, SHAPES, officeAdapterOf } from '../src/hq-model.mjs';
import { planWrite } from '../src/hq-writes/index.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';

const ADAPTER_DIR = fileURLToPath(new URL('../src/integrations/paperclip-adapter', import.meta.url));
const RECORDED = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/paperclip-shapes.json', import.meta.url)), 'utf8'));
const a = (id, reportsTo, name = id, role = 'General') => ({ id, name, reportsTo, role });

test('floors follow the org chart (#226): a floor per department, going up by rank, a room per rank; Records and Lobby fixed, bottom to top', () => {
  // roles as the office labels them (roleLabel): the department comes from the Paperclip role
  const f = floorsOf([a('ceo', null, 'Grace', 'CEO'), a('cto', 'ceo', 'Ada', 'CTO'), a('dev', 'cto', 'Linus', 'Engineer'), a('ops', 'cto', 'Ken', 'DevOps'),
    a('cmo', 'ceo', 'Mia', 'CMO'), a('pm', 'cmo', 'Pat', 'PM'), a('gen', 'cto', 'Gus')]);
  assert.deepEqual(f.map((x) => x.key), ['records', 'lobby', 'dept-product', 'dept-marketing', 'dept-engineering', 'dept-executive']);
  assert.deepEqual(f.map((x) => x.name), ['Records', 'Lobby', 'Product', 'Marketing', 'Engineering', 'Executive'], 'the top role on the top floor; a tie of ranks keeps the department order (Engineering above Marketing)');
  assert.deepEqual(f.map((x) => x.wing), ['', '', 'Teams', 'Leads', 'Leads', 'Executive'], 'the elevator groups the floors by the rank of their highest employee');
  const eng = f.find((x) => x.dept === 'engineering');
  assert.deepEqual(eng.rooms.map((r) => [r.key, r.name, r.employees.map((e) => e.id)]), [['rank-1', 'Leads', ['cto']], ['rank-2', 'Teams', ['dev', 'ops', 'gen']]],
    'a room per rank, highest first; a general employee works in the department of its manager');
  assert.deepEqual(eng.employees.map((e) => [e.id, e.rank]), [['cto', 1], ['dev', 2], ['ops', 2], ['gen', 2]]);
  assert.equal(eng.rank, 1);
  assert.deepEqual(f.find((x) => x.key === 'lobby').rooms, []);
  assert.deepEqual(departmentsOf([a('g', 'ceo'), a('ceo', null, 'C', 'CEO'), a('h', null)]), new Map([['g', 'general'], ['ceo', 'executive'], ['h', 'general']]),
    'a general employee under the CEO only, or with no manager, is in General');
});

test('floors: a loop in reporting lines, a missing manager and a self report never loop or lose an employee', () => {
  const f = floorsOf([a('x', 'y'), a('y', 'x'), a('z', 'ghost'), a('s', 's')]);
  const ids = f.flatMap((x) => x.employees.map((e) => e.id)).sort();
  assert.deepEqual(ids, ['s', 'x', 'y', 'z']);
  assert.deepEqual(f.flatMap((x) => x.rooms.flatMap((r) => r.employees.map((e) => e.id))).sort(), ids, 'every employee sits in one room');
  assert.deepEqual(floorsOf([]).map((x) => x.key), ['records', 'lobby']);
  const deep = floorsOf(Array.from({ length: 40 }, (_, i) => a('n' + i, i ? 'n' + (i - 1) : null)));
  assert.equal(deep.length, 3, 'one department, one floor');
  assert.equal(deep[2].rooms.length, 8, 'depth is capped at 8 ranks; deeper employees share the last room');
  assert.equal(deep[2].rooms.at(-1).employees.length, 33);
  assert.equal(deep[2].rooms.at(-1).name, 'Rank 8');
});

test('the Lobby counts what Paperclip said and says unknown (null) for what it could not read', () => {
  const agents = [{ id: 'a', name: 'Ada', status: 'idle', run: { status: 'running' }, supervision: { state: 'supervised' } }, { id: 'b', name: 'Bo', status: 'paused', supervision: { state: 'unsupervised' } }];
  const l = lobbyOf({ agents, issues: [{ status: 'todo' }, { status: 'in_progress' }, { status: 'blocked' }], approvals: [{ id: 'p', type: 'hire_agent', requestedByAgentId: 'a' }], goals: null, activity: [], costs: { spent: 12.4, limit: 100 }, secrets: ['A'], unread: ['goals'] });
  assert.deepEqual(l.employees, { total: 2, working: 1, paused: 1, error: 0, unsupervised: 1 });
  assert.deepEqual(l.tasks, { open: 3, todo: 1, inProgress: 1, blocked: 1, inReview: 0, backlog: 0 });
  assert.equal(l.goals, null);
  assert.deepEqual(l.approvals, { pending: 1, items: [{ id: 'p', kind: 'hire_agent', by: 'Ada', approval: 'p', link: null }] });
  assert.deepEqual(l.spend, { spent: 12.4, limit: 100, percent: 12 });
  assert.deepEqual(l.secrets, { count: 1, names: ['A'] });
  assert.equal(lobbyOf({ agents: [], issues: null, approvals: null, goals: null, activity: null, costs: null, secrets: null, unread: [] }).tasks, null);
});

test('contract: the shapes the office reads are checked, and a change is a named problem', () => {
  assert.deepEqual(shapeProblems('goals', [{ id: 'g', title: 't', status: 'active' }]), []);
  assert.deepEqual(shapeProblems('goals', []), [], 'an empty list says nothing about the shape');
  assert.match(shapeProblems('goals', [{ id: 'g', title: 7, status: 'active' }])[0], /goals: title is number, expected string/);
  assert.match(shapeProblems('goals', [{ id: 'g', status: 'active' }])[0], /goals: title is missing/);
  assert.match(shapeProblems('goals', { rows: [] })[0], /goals: expected a list/);
  assert.match(shapeProblems('costs', [])[0], /costs: expected an object/);
  assert.deepEqual(shapeProblems('costs', { spendCents: 0, budgetCents: null }), [], 'no budget set is null, not a changed shape');
  assert.match(shapeProblems('costs', { spendCents: null, budgetCents: 0 })[0], /spendCents is null, expected number/);
});

test('costs (#208): per month, agents and projects sorted by cost; unknown stays unknown', () => {
  assert.deepEqual(monthWindows(Date.UTC(2026, 0, 15)).map((m) => m.key), ['2026-01', '2025-12', '2025-11'], 'the window crosses the year');
  assert.equal(monthWindows(Date.UTC(2026, 10, 6))[0].to, '2026-12-01T00:00:00.000Z');
  const c = costsOf({
    months: [
      { key: '2026-11', agents: [{ id: 'a', name: 'Ada', cost: 2 }, { id: 'g', name: 'Grace', cost: 4.5 }], projects: [{ id: 'p', name: 'Web', cost: 6.5 }] },
      { key: '2026-10', agents: [{ id: 'a', name: 'Ada', cost: null }, { id: 'g', name: 'Grace', cost: 1 }], projects: null },
      { key: '2026-09', agents: null, projects: null },
    ],
    budgets: { paused: 1, policies: [{ id: 'b1', scope: 'agent', name: 'Ada', metric: 'billed_cents', limit: 50, used: 8, percent: 16, status: 'ok', paused: false }, { id: 'b2', scope: 'company', name: 'Acme', metric: 'billed_cents', limit: 100, used: 90, percent: 90, status: 'warning', paused: false }] },
  });
  assert.deepEqual(c.months.map((m) => [m.label, m.total, m.partial]), [['November 2026', 6.5, false], ['October 2026', 1, true], ['September 2026', null, false]]);
  assert.deepEqual(c.months[0].agents.map((a) => a.name), ['Grace', 'Ada']);
  assert.equal(c.months[1].projects, null);
  assert.equal(c.months[2].agents, null, 'an unread month is null, not zero');
  assert.deepEqual(c.budgets.map((b) => b.id), ['b2', 'b1']);
  assert.equal(c.pausedAgents, 1);
  assert.equal(costsOf({ months: [], budgets: null }).budgets, null);
});

test('contract: the office needs only what was recorded, and the fake Paperclip still answers the recorded shapes', async () => {
  assert.equal(RECORDED.pinned, '2026.1106.0', 'the recording belongs to the pinned release; a new pin needs a new recording');
  for (const [name, spec] of Object.entries(SHAPES)) for (const f of Object.keys(spec.fields)) assert.ok(RECORDED.routes[name]?.fields?.[f], `${name}.${f} is read but was never recorded`);
  const pc = await startFakePaperclip(DEMO());
  try {
    const id = DEMO().companies[0].id;
    const route = { company: `/api/companies/${id}`, agents: `/api/companies/${id}/agents`, issues: `/api/companies/${id}/issues`, goals: `/api/companies/${id}/goals`, approvals: `/api/companies/${id}/approvals?status=pending`,
      activity: `/api/companies/${id}/activity`, costs: `/api/companies/${id}/costs/summary`, secrets: `/api/companies/${id}/secrets`,
      skills: `/api/companies/${id}/skills`, plugins: '/api/plugins', adapters: '/api/adapters',
      costsByAgent: `/api/companies/${id}/costs/by-agent?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z`, costsByProject: `/api/companies/${id}/costs/by-project?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z`, budgets: `/api/companies/${id}/budgets/overview`,
      instanceSettings: '/api/instance/settings', environments: `/api/companies/${id}/environments` };
    for (const [name, r] of Object.entries(route)) {
      const json = await (await fetch(pc.url + r)).json();
      assert.deepEqual(shapeProblems(name, json), [], name);
      const got = shapeOf(json), want = RECORDED.routes[name];
      assert.equal(got.list, want.list, `${name}: list or object`);
      for (const [k, t] of Object.entries(want.fields)) assert.equal(got.fields[k], t, `${name}.${k} changed from ${t} to ${got.fields[k]}`);
    }
  } finally { await pc.close(); }
});

test('contract: the adapter install answer of the fake is the recorded shape (routes/adapters.ts POST /adapters/install)', async () => {
  const pc = await startFakePaperclip({ ...DEMO(), adapters: [] });
  try {
    const r = await fetch(`${pc.url}/api/adapters/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packageName: ADAPTER_DIR, isLocalPath: true }) });
    assert.equal(r.status, 201);
    const json = await r.json();
    assert.deepEqual(shapeProblems('adapterInstall', json), []);
    const got = shapeOf(json), want = RECORDED.routes.adapterInstall;
    assert.equal(got.list, want.list);
    for (const [k, t] of Object.entries(want.fields)) assert.equal(got.fields[k], t, `adapterInstall.${k}`);
    assert.equal(json.type, 'agent_office', 'the type comes from createServerAdapter() of the plugin, loaded the way Paperclip loads it');
    assert.equal(json.requiresRestart, false);
    assert.equal((await fetch(`${pc.url}/api/adapters/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  } finally { await pc.close(); }
});

test('officeAdapterOf: installed, off, missing and unknown', () => {
  assert.equal(officeAdapterOf([{ type: 'claude_local' }, { type: 'agent_office', disabled: false }]).state, 'installed');
  assert.equal(officeAdapterOf([{ type: 'agent_office', disabled: true }]).state, 'off');
  assert.match(officeAdapterOf([{ type: 'claude_local' }]).why, /Install it at the HQ/);
  assert.equal(officeAdapterOf(null).state, 'unknown');
});

test('plan: the adapter install is one POST with no folder from the caller', () => {
  const p = planWrite({ kind: 'adapter', action: 'install', packageName: 'C:/evil', localPath: 'C:/evil' });
  assert.equal(p.method, 'POST');
  assert.equal(p.path('c'), '/api/adapters/install');
  assert.deepEqual(p.body, { isLocalPath: true }, 'the folder is set by the writer, never by the request');
  assert.throws(() => planWrite({ kind: 'adapter', action: 'remove' }), (e) => e.status === 400);
});

// ---------- projects and workspaces as rooms (#211) ----------
import { roomsOf } from '../src/hq-model.mjs';

test('rooms: a project is a room, its workspaces are listed, an employee sits in the room of its open task', () => {
  const projects = [
    { id: 'p1', name: 'Web app', status: 'in_progress', workspaces: [{ id: 'w1', name: 'main', cwd: 'C:\\work\\web', isPrimary: true }, { id: 'w2', name: 'docs', cwd: 'C:\\work\\docs' }] },
    { id: 'p2', name: 'Empty', status: 'planned' },
  ];
  const agents = [{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bo' }, { id: 'a3', name: 'Cy' }];
  const issues = [
    { id: 'i1', status: 'in_progress', assigneeAgentId: 'a1', projectId: 'p1', projectWorkspaceId: 'w2' },
    { id: 'i2', status: 'todo', assigneeAgentId: 'a1', projectId: 'p2' },
    { id: 'i3', status: 'todo', assigneeAgentId: 'a2', projectId: 'p1' },
    { id: 'i4', status: 'done', assigneeAgentId: 'a3', projectId: 'p1' },
  ];
  const r = roomsOf({ projects, agents, issues });
  assert.deepEqual(r.map((x) => x.id), ['p1', 'p2']);
  assert.deepEqual(r[0].workspaces, [{ id: 'w1', name: 'main', folder: 'C:\\work\\web', primary: true }, { id: 'w2', name: 'docs', folder: 'C:\\work\\docs', primary: false }]);
  assert.deepEqual(r[0].employees, [{ id: 'a1', name: 'Ada', workspace: 'docs' }, { id: 'a2', name: 'Bo', workspace: 'main' }], 'in progress beats todo; no workspace on the task: the primary one');
  assert.deepEqual(r[1].employees, [], 'an employee sits in one room: the room of its best open task');
  assert.deepEqual(r[1].workspaces, []);
});

test('rooms: unreadable shapes give no room and never throw; the folder is never invented', () => {
  assert.deepEqual(roomsOf({ projects: null, agents: [], issues: [] }), []);
  const r = roomsOf({ projects: [null, { name: 'x' }, { id: 'p', name: 'P', workspaces: [{ id: 'w' }, 5] }], agents: [], issues: null });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].workspaces, [{ id: 'w', name: 'w', folder: null, primary: false }]);
});

test('cables: one per reporting line whose manager is in the chart; no cable for a self report, a ghost manager or a loop', () => {
  assert.deepEqual(cablesOf([a('ceo', null), a('cto', 'ceo'), a('dev', 'cto')]), [{ from: 'cto', to: 'ceo' }, { from: 'dev', to: 'cto' }]);
  assert.deepEqual(cablesOf([a('x', 'y'), a('y', 'x'), a('z', 'ghost'), a('s', 's'), a('r', null)]), []);
});

test('a reporting line change: a root, a new manager and the refusals (unknown, self, loop)', () => {
  const org = [a('ceo', null, 'Grace'), a('cto', 'ceo', 'Ada'), a('dev', 'cto', 'Linus'), a('cmo', 'ceo', 'Mae')];
  assert.equal(reportingProblem(org, 'dev', 'cmo'), '');
  assert.equal(reportingProblem(org, 'dev', null), '');
  assert.match(reportingProblem(org, 'ghost', 'cmo'), /not in the company/);
  assert.match(reportingProblem(org, 'dev', 'ghost'), /manager is not in the company/);
  assert.match(reportingProblem(org, 'dev', 'dev'), /itself/);
  assert.match(reportingProblem(org, 'ceo', 'dev'), /loop/);
});

test('goals (#207): a tree, parents first, owner names, loop-safe, null is unknown', () => {
  const g = (id, parentId, extra = {}) => ({ id, title: id.toUpperCase(), status: 'active', level: 'task', description: '', parentId, ownerAgentId: null, ...extra });
  const out = goalsOf([g('b', 'a'), g('a', null, { ownerAgentId: 'x', level: 'company' }), g('c', 'b'), g('z', 'ghost')], [{ id: 'x', name: 'Grace' }]);
  assert.equal(out.total, 4);
  assert.deepEqual(out.rows.map((r) => [r.id, r.depth, r.children]), [['a', 0, 1], ['b', 1, 1], ['c', 2, 0], ['z', 0, 0]]);
  assert.deepEqual([out.rows[0].owner, out.rows[0].level, out.rows[3].parentId], ['Grace', 'company', null], 'a parent that is not in the list makes a root');
  const loop = goalsOf([g('p', 'q'), g('q', 'p'), g('s', 's')], []);
  assert.deepEqual(loop.rows.map((r) => r.id).sort(), ['p', 'q', 's'], 'a loop and a self parent drop no goal');
  assert.equal(goalsOf(null, []), null);
  assert.deepEqual(goalsOf([], []), { total: 0, rows: [] });
});
