// The HQ read model (#197), pure part: the org chart as floors, the Lobby dashboard, and the contract of the Paperclip API shapes the
// office reads (test/fixtures/paperclip-shapes.json: the recorded shapes). No server, no network except the fake Paperclip in the
// contract test. Run: node --test test/hq-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { floorsOf, lobbyOf, shapeProblems, shapeOf, SHAPES } from '../src/hq-model.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';

const RECORDED = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/paperclip-shapes.json', import.meta.url)), 'utf8'));
const a = (id, reportsTo, name = id) => ({ id, name, reportsTo, role: 'General' });

test('floors follow the org chart: the top role on the top floor, Records and Lobby fixed, bottom to top', () => {
  const f = floorsOf([a('ceo', null), a('cto', 'ceo'), a('dev', 'cto'), a('dev2', 'cto'), a('cmo', 'ceo')]);
  assert.deepEqual(f.map((x) => x.key), ['records', 'lobby', 'rank-2', 'rank-1', 'rank-0']);
  assert.deepEqual(f.map((x) => x.employees.map((e) => e.id)), [[], [], ['dev', 'dev2'], ['cto', 'cmo'], ['ceo']]);
  assert.equal(f.at(-1).name, 'Executive');
  assert.equal(f.find((x) => x.key === 'lobby').name, 'Lobby');
});

test('floors: a loop in reporting lines, a missing manager and a self report never loop or lose an employee', () => {
  const f = floorsOf([a('x', 'y'), a('y', 'x'), a('z', 'ghost'), a('s', 's')]);
  const ids = f.flatMap((x) => x.employees.map((e) => e.id)).sort();
  assert.deepEqual(ids, ['s', 'x', 'y', 'z']);
  assert.deepEqual(floorsOf([]).map((x) => x.key), ['records', 'lobby']);
  assert.equal(floorsOf(Array.from({ length: 40 }, (_, i) => a('n' + i, i ? 'n' + (i - 1) : null))).length, 2 + 8, 'depth is capped at 8 ranks; deeper employees share the last one');
});

test('the Lobby counts what Paperclip said and says unknown (null) for what it could not read', () => {
  const agents = [{ id: 'a', name: 'Ada', status: 'idle', run: { status: 'running' }, supervision: { state: 'supervised' } }, { id: 'b', name: 'Bo', status: 'paused', supervision: { state: 'unsupervised' } }];
  const l = lobbyOf({ agents, issues: [{ status: 'todo' }, { status: 'in_progress' }, { status: 'blocked' }], approvals: [{ id: 'p', type: 'hire_agent', requestedByAgentId: 'a' }], goals: null, activity: [], costs: { spent: 12.4, limit: 100 }, secrets: ['A'], unread: ['goals'] });
  assert.deepEqual(l.employees, { total: 2, working: 1, paused: 1, error: 0, unsupervised: 1 });
  assert.deepEqual(l.tasks, { open: 3, todo: 1, inProgress: 1, blocked: 1, inReview: 0, backlog: 0 });
  assert.equal(l.goals, null);
  assert.deepEqual(l.approvals, { pending: 1, items: [{ id: 'p', kind: 'hire_agent', by: 'Ada' }] });
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
});

test('contract: the office needs only what was recorded, and the fake Paperclip still answers the recorded shapes', async () => {
  assert.equal(RECORDED.pinned, '2026.1106.0', 'the recording belongs to the pinned release; a new pin needs a new recording');
  for (const [name, spec] of Object.entries(SHAPES)) for (const f of Object.keys(spec.fields)) assert.ok(RECORDED.routes[name]?.fields?.[f], `${name}.${f} is read but was never recorded`);
  const pc = await startFakePaperclip(DEMO());
  try {
    const id = DEMO().companies[0].id;
    const route = { company: `/api/companies/${id}`, agents: `/api/companies/${id}/agents`, issues: `/api/companies/${id}/issues`, goals: `/api/companies/${id}/goals`, approvals: `/api/companies/${id}/approvals?status=pending`,
      activity: `/api/companies/${id}/activity`, costs: `/api/companies/${id}/costs/summary`, secrets: `/api/companies/${id}/secrets` };
    for (const [name, r] of Object.entries(route)) {
      const json = await (await fetch(pc.url + r)).json();
      assert.deepEqual(shapeProblems(name, json), [], name);
      const got = shapeOf(json), want = RECORDED.routes[name];
      assert.equal(got.list, want.list, `${name}: list or object`);
      for (const [k, t] of Object.entries(want.fields)) assert.equal(got.fields[k], t, `${name}.${k} changed from ${t} to ${got.fields[k]}`);
    }
  } finally { await pc.close(); }
});
