// The Paperclip search of Ctrl+K (#214): the index the server builds (hq-model.mjs searchOf, paperclip.mjs view().search), the entries the
// page makes of it (OfficeVocab.hq.searchItems) and the open target. No paid call: the fake Paperclip. Run: node --test test/hq-search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';
import { floorsOf, searchOf, SEARCH_CAPS } from '../src/hq-model.mjs';
import { createHq } from '../src/paperclip.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';

const V = globalThis.OfficeVocab;

test('search index: employees, floors, tasks, goals, approvals and routines, capped, names only', () => {
  const agents = [{ id: 'g', name: 'Grace', role: 'CEO', title: 'Chief', task: { title: 'Plan the year' } }, { id: 'a', name: 'Ada', role: 'Engineer', title: '' }];
  const floors = floorsOf([{ ...agents[0], reportsTo: null }, { ...agents[1], reportsTo: 'g' }]);
  const issues = [{ id: 'i1', identifier: 'ACM-1', title: 'Add a route', status: 'in_progress', assigneeAgentId: 'a' }, { id: 'i2' }];
  const s = searchOf({ agents, floors, issues, goals: [{ id: 'go', title: 'Ship', status: 'active' }], approvals: [{ id: 'p', type: 'hire_agent', status: 'pending', requestedByAgentId: 'g', payload: { secret: 'x' } }], routines: [{ id: 'r', title: 'Nightly', status: 'active', agent: 'Ada' }] });
  const by = (k) => s.filter((x) => x.kind === k);
  assert.deepEqual(by('floor').map((x) => x.id), ['lobby', 'rank-1', 'rank-0'], 'Records is not searched');
  assert.deepEqual(by('employee').map((x) => [x.id, x.label, x.hint]), [['g', 'Grace', 'Chief · Plan the year'], ['a', 'Ada', 'Engineer']]);
  assert.deepEqual(by('task').map((x) => [x.id, x.label, x.hint]), [['i1', 'ACM-1 Add a route', 'Task · in progress · Ada']], 'a task with no title is left out');
  assert.deepEqual(by('approval').map((x) => [x.label, x.hint]), [['Approval: hire agent', 'Approval · from Grace · pending']]);
  assert.deepEqual([by('goal')[0].hint, by('routine')[0].hint], ['Goal · active', 'Routine · for Ada · active']);
  assert.ok(!JSON.stringify(s).includes('secret'));
  const many = searchOf({ agents: [], floors: [], issues: Array.from({ length: 300 }, (_, n) => ({ id: 'i' + n, title: 't' + n })) });
  assert.equal(many.length, SEARCH_CAPS.task);
  assert.deepEqual(searchOf({ agents: [], floors: [] }), []);
});

test('the view carries the index of the connected company', async () => {
  const pc = await startFakePaperclip(DEMO());
  const hq = createHq({ refetchMs: 20, retryMs: [50, 50], hooksFile: () => ({}) });
  try {
    await hq.connect({ url: pc.url });
    for (let n = 0; n < 200 && hq.state() !== 'on'; n++) await new Promise((r) => setTimeout(r, 25));
    const s = hq.view().search;
    assert.ok(s.some((x) => x.kind === 'employee' && x.label === 'Ada'));
    assert.ok(s.some((x) => x.kind === 'floor' && x.id === 'lobby'));
    assert.ok(s.some((x) => x.kind === 'approval'));
    assert.ok(s.some((x) => x.kind === 'goal'));
    assert.ok(s.some((x) => x.kind === 'task'));
  } finally { hq.disconnect(); await pc.close(); }
});

test('page entries: a label and keywords to type, a group, an icon, and the target to open', () => {
  assert.deepEqual(V.hq.searchItems(null), []);
  assert.deepEqual(V.hq.searchItems({ search: [] }), []);
  const items = V.hq.searchItems({ company: { name: 'Acme' }, search: [{ kind: 'employee', id: 'a', label: 'Ada', hint: 'Engineer' }, { kind: 'task', id: 'i1', label: 'ACM-1 Add a route', hint: 'Task · todo' }, { kind: 'floor', id: 'lobby', label: 'Lobby', hint: 'Floor of the HQ' }] });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { id: 'hq-employee-a', label: 'Ada (employee, Acme)', hint: 'Engineer', icon: 'bot', group: 'Paperclip', keywords: 'paperclip hq employee Ada Engineer', ref: { kind: 'employee', id: 'a' } });
  assert.equal(items[1].icon, 'plan');
  assert.equal(items[2].ref.kind, 'floor');
});
