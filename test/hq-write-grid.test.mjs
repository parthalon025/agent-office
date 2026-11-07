// The HQ write grid (#198, spec #191): the pure rules in src/hq-model.mjs. Which write kinds the grid has, their defaults, the saved
// slice, a change (loosening needs the painted Confirm, a secret never takes Allow) and the plan of each first write (the exact
// request, checked before anything is asked or sent). No server, no network. Run: node --test test/hq-write-grid.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_KINDS, cleanWriteGrid, writeValueOf, setWriteCell, planWrite } from '../src/hq-model.mjs';

test('the grid has the ten write kinds of ADR 0010 and the first company (#199); Allow only for the user\'s own task edits and comments', () => {
  assert.deepEqual(Object.keys(WRITE_KINDS), ['hire', 'pause', 'budget', 'approval', 'reporting', 'routine', 'access', 'secret', 'task', 'comment', 'company', 'goal', 'instance']);
  for (const k of Object.keys(WRITE_KINDS)) assert.equal(writeValueOf({}, k), k === 'task' || k === 'comment' ? 'allow' : 'confirm', k);
  assert.deepEqual(WRITE_KINDS.secret.options, ['confirm', 'deny'], 'a secret never takes Allow');
  assert.deepEqual(WRITE_KINDS.task.options, ['confirm', 'allow', 'deny']);
});

test('cleanWriteGrid keeps only cells the grid has, with values the kind offers', () => {
  const g = cleanWriteGrid({ task: 'deny', comment: 'bogus', secret: 'allow', nothing: 'allow', approval: 'confirm' });
  assert.deepEqual(g, { task: 'deny', approval: 'confirm' }, 'the user set a value equal to the default: it is kept');
  assert.deepEqual(cleanWriteGrid(null), {});
  assert.deepEqual(cleanWriteGrid([1]), {});
  assert.equal(writeValueOf(g, 'task'), 'deny');
  assert.equal(writeValueOf(g, 'comment'), 'allow', 'a cell not set uses its default');
  assert.equal(writeValueOf(JSON.parse('{"__proto__":{"task":"deny"}}'), 'task'), 'allow', 'a prototype is never a cell');
});

test('setWriteCell: stricter changes apply at once, a looser one needs the painted Confirm', () => {
  const start = {};
  const r = setWriteCell(start, { kind: 'task', value: 'confirm' });
  assert.deepEqual([r.grid, r.from, r.to], [{ task: 'confirm' }, 'allow', 'confirm']);
  assert.deepEqual(start, {}, 'the old grid is not changed');
  const d = setWriteCell(r.grid, { kind: 'task', value: 'deny' });
  assert.deepEqual([d.grid, d.from, d.to], [{ task: 'deny' }, 'confirm', 'deny']);
  assert.throws(() => setWriteCell(d.grid, { kind: 'task', value: 'confirm' }), (e) => e.status === 409 && /Confirm the looser/.test(e.message), 'Deny to Confirm loosens');
  assert.throws(() => setWriteCell({}, { kind: 'approval', value: 'allow' }), (e) => e.status === 409);
  const ok = setWriteCell({}, { kind: 'approval', value: 'allow', confirmed: true });
  assert.deepEqual(ok.grid, { approval: 'allow' });
  assert.deepEqual(setWriteCell(ok.grid, { kind: 'approval', value: null }).grid, {}, 'null is Use default');
  assert.deepEqual(setWriteCell({}, { kind: 'task', value: 'allow' }).grid, { task: 'allow' }, 'the same value: nothing loosens, and it is stored');
});

test('setWriteCell: an unknown kind or value is 400, and a secret never takes Allow, confirmed or not', () => {
  for (const c of [{ kind: 'nope', value: 'deny' }, { kind: 'task', value: 'maybe' }, { kind: '__proto__', value: 'deny' }, { kind: 'secret', value: 'allow', confirmed: true }]) {
    assert.throws(() => setWriteCell({}, c), (e) => e.status === 400, JSON.stringify(c));
  }
});

const ID = 'i2000000-0000-4000-8000-000000000001', AG = 'a1000000-0000-4000-8000-000000000002', AP = 'p1000000-0000-4000-8000-000000000001';

test('planWrite: the exact request of each first write', () => {
  const plan = (b) => { const p = planWrite(b); return [p.kind, p.method, p.path('C1'), p.body, p.targets]; };
  assert.deepEqual(plan({ kind: 'task', action: 'create', title: ' Fix the build ', description: 'It fails.' }),
    ['task', 'POST', '/api/companies/C1/issues', { title: 'Fix the build', description: 'It fails.' }, []]);
  assert.deepEqual(plan({ kind: 'task', action: 'create', title: 'T', status: 'todo', assigneeAgentId: AG }),
    ['task', 'POST', '/api/companies/C1/issues', { title: 'T', status: 'todo', assigneeAgentId: AG }, [{ type: 'agent', id: AG }]]);
  assert.deepEqual(plan({ kind: 'task', action: 'assign', issue: ID, agent: AG }),
    ['task', 'PATCH', `/api/issues/${ID}`, { assigneeAgentId: AG }, [{ type: 'issue', id: ID }, { type: 'agent', id: AG }]]);
  assert.deepEqual(plan({ kind: 'comment', action: 'add', issue: ID, text: 'Looks good.' }),
    ['comment', 'POST', `/api/issues/${ID}/comments`, { body: 'Looks good.' }, [{ type: 'issue', id: ID }]]);
  assert.deepEqual(plan({ kind: 'approval', action: 'approve', approval: AP }),
    ['approval', 'POST', `/api/approvals/${AP}/approve`, {}, [{ type: 'approval', id: AP }]]);
  assert.deepEqual(plan({ kind: 'approval', action: 'reject', approval: AP, note: 'No.' }),
    ['approval', 'POST', `/api/approvals/${AP}/reject`, { decisionNote: 'No.' }, [{ type: 'approval', id: AP }]]);
  assert.deepEqual(plan({ kind: 'approval', action: 'revise', approval: AP, note: 'Add a budget.' }),
    ['approval', 'POST', `/api/approvals/${AP}/request-revision`, { decisionNote: 'Add a budget.' }, [{ type: 'approval', id: AP }]]);
  const co = planWrite({ kind: 'company', action: 'create', url: 'http://127.0.0.1:3100', name: ' Acme ', description: 'Made here.' });
  assert.deepEqual([co.kind, co.method, co.path('ignored'), co.body, co.targets, co.scope, co.url], ['company', 'POST', '/api/companies', { name: 'Acme', description: 'Made here.' }, [], 'none', 'http://127.0.0.1:3100']);
  assert.equal(co.summary, 'Create the company "Acme"');
  assert.throws(() => planWrite({ kind: 'company', action: 'create', url: 'http://127.0.0.1:3100', name: '  ' }), (e) => e.status === 400);
  assert.throws(() => planWrite({ kind: 'company', action: 'create', name: 'Acme' }), (e) => e.status === 400, 'the address is required');
  assert.throws(() => planWrite({ kind: 'company', action: 'create', url: 'http://127.0.0.1:3100', name: 'x'.repeat(81) }), (e) => e.status === 400);
});

test('planWrite goals (#207): create and update, the targets, and the refusals', () => {
  const G = 'g1', A = 'a1';
  const c = planWrite({ kind: 'goal', action: 'create', title: ' Ship ', description: 'Soon.', level: 'team', status: 'active', parent: G, owner: A });
  assert.deepEqual([c.method, c.path('co 1'), c.body, c.targets, c.summary],
    ['POST', '/api/companies/co%201/goals', { title: 'Ship', description: 'Soon.', level: 'team', status: 'active', parentId: G, ownerAgentId: A }, [{ type: 'goal', id: G }, { type: 'agent', id: A }], 'Create the goal "Ship"']);
  assert.deepEqual(planWrite({ kind: 'goal', action: 'create', title: 'T' }).body, { title: 'T' });
  const u = planWrite({ kind: 'goal', action: 'update', goal: G, status: 'achieved' });
  assert.deepEqual([u.method, u.path(), u.body, u.targets, u.summary], ['PATCH', '/api/goals/g1', { status: 'achieved' }, [{ type: 'goal', id: G }], 'Mark a goal achieved']);
  assert.deepEqual(planWrite({ kind: 'goal', action: 'update', goal: G, owner: null }).body, { ownerAgentId: null });
  assert.deepEqual(planWrite({ kind: 'goal', action: 'update', goal: G, title: 'New', owner: A }).targets, [{ type: 'goal', id: G }, { type: 'agent', id: A }]);
  for (const b of [{ action: 'create', title: '' }, { action: 'create', title: 'T', level: 'galaxy' }, { action: 'create', title: 'T', status: 'weird' }, { action: 'create', title: 'T', parent: '../x' },
    { action: 'update', goal: G }, { action: 'update', goal: '../x', status: 'active' }, { action: 'update', goal: G, status: 'weird' }, { action: 'update', goal: G, title: '' }, { action: 'delete', goal: G }]) {
    assert.throws(() => planWrite({ kind: 'goal', ...b }), (e) => e.status === 400, JSON.stringify(b));
  }
});

test('planWrite: a bad write is 400 before anything is asked, and an id never changes the path', () => {
  const bad = [{}, { kind: 'task' }, { kind: 'task', action: 'delete' }, { kind: 'hire', action: 'create' }, { kind: '__proto__', action: 'x' }, { kind: 'task', action: 'toString' },
    { kind: 'task', action: 'create', title: '' }, { kind: 'task', action: 'create', title: 'x'.repeat(201) }, { kind: 'task', action: 'create', title: 'T', status: 'weird' },
    { kind: 'task', action: 'create', title: 'T', assigneeAgentId: '../x' },
    { kind: 'task', action: 'assign', issue: '../../agents/x', agent: AG }, { kind: 'task', action: 'assign', issue: ID },
    { kind: 'comment', action: 'add', issue: ID, text: '   ' }, { kind: 'comment', action: 'add', issue: ID, text: 'x'.repeat(10001) },
    { kind: 'approval', action: 'approve', approval: 'a/b' }, { kind: 'approval', action: 'approve', approval: AP, note: 5 }];
  for (const b of bad) assert.throws(() => planWrite(b), (e) => e.status === 400, JSON.stringify(b));
});

test('planWrite: the summary says what is written, in plain words, for the Confirm and the feed', () => {
  assert.equal(planWrite({ kind: 'task', action: 'create', title: 'Fix the build' }).summary, 'Create the task "Fix the build"');
  assert.equal(planWrite({ kind: 'task', action: 'assign', issue: ID, agent: AG }).summary, 'Assign a task');
  assert.equal(planWrite({ kind: 'comment', action: 'add', issue: ID, text: 'Hi' }).summary, 'Comment on a task');
  assert.equal(planWrite({ kind: 'approval', action: 'revise', approval: AP }).summary, 'Request a revision of an approval');
});
