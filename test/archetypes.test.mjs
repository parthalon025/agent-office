// Function floors (#92): the catalog, the archetypes, detection from file names, and the user's changes to a building's floors.
// Pure: no I/O. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { WINGS, FUNCTIONS, ARCHETYPES, detect, newRecord, cleanRecord, floorsOf, shownFloors, edit, layoutView, catalogView, floorOfKind, functionOf } from '../src/archetypes.mjs';

const ids = (floors) => floors.map((f) => f.id);

test('the catalog: every function has a known wing and a DS role icon; the archetypes in scope name catalog floors', () => {
  const wings = new Set(WINGS.map((w) => w.id));
  const roles = new Set(['coder', 'research', 'writer', 'analyst', 'designer', 'ops', 'sales', 'planner', 'media', 'ae', 'specialist', 'partner', 'se', 'csa', 'csam', 'fde']);
  for (const f of FUNCTIONS) {
    if (f.id !== 'lobby') assert.ok(wings.has(f.wing), f.id + ' has a wing');
    assert.ok(roles.has(f.role), f.id + ' has a DS role');
  }
  assert.deepEqual(ARCHETYPES.map((a) => a.name), ['Software product', 'Knowledge base', 'Operations Hub', 'General']);
  for (const a of ARCHETYPES) for (const id of a.floors) assert.ok(functionOf(id), a.id + ': ' + id);
  // the rest of the company is data, so later presets need no code
  for (const id of ['sales', 'marketing', 'customer-success', 'partnerships', 'communications', 'finance', 'legal', 'people', 'procurement', 'facilities', 'strategy', 'supply-chain', 'delivery', 'field-operations', 'executive', 'governance']) assert.ok(functionOf(id), id);
  // plain company terms only
  const all = FUNCTIONS.map((f) => f.name).concat(WINGS.map((w) => w.name)).join(' ');
  assert.doesNotMatch(all, /\b(command|ops center|mission|squad|platoon|brigade|hq)\b/i);
});

test('detection: sample repository shapes', () => {
  assert.equal(detect(['package.json', 'test/', 'test/a.test.mjs', 'README.md']).archetype, 'software');
  assert.equal(detect(['pyproject.toml', 'src/', 'src/app.py']).archetype, 'software');
  assert.equal(detect(['Cargo.toml', 'src/', 'src/main.rs', 'tests/']).archetype, 'software');
  assert.equal(detect(['.obsidian/', '.obsidian/app.json', 'Inbox/', 'Daily.md']).archetype, 'knowledge');
  assert.equal(detect(['a.md', 'b.md', 'c.md', 'notes/', 'notes/d.md', 'notes/e.md']).archetype, 'knowledge');
  assert.equal(detect(['package.json', 'test/', '.claude/', '.claude/agents/', 'CLAUDE.md']).archetype, 'ops-hub');
  assert.equal(detect(['package.json', 'src/', '.claude/', '.claude/worktrees/']).archetype, 'ops-hub');
});

test('detection: a mixed or unclear repository gives General; deeper names are ignored', () => {
  assert.equal(detect(['package.json', 'test/', '.obsidian/']).archetype, 'general');   // mixed: code and a notes vault
  assert.equal(detect([]).archetype, 'general');
  assert.equal(detect(['photo.jpg', 'data/', 'data/x.csv']).archetype, 'general');
  assert.equal(detect(['package.json']).archetype, 'general');   // a manifest alone is not sure
  assert.equal(detect(['package.json', 'a/b/c.test.js']).archetype, 'general');   // two levels down does not count
  assert.match(detect(['package.json', 'test/']).why, /manifest/);
});

test('a new record proposes the detected archetype and is not confirmed; Lobby first and Records last on every building', () => {
  const r = newRecord(detect(['package.json', 'test/']));
  assert.equal(r.proposed, 'software'); assert.equal(r.archetype, 'software'); assert.equal(r.confirmed, false);
  assert.deepEqual(ids(floorsOf(r)), ['lobby', 'engineering', 'quality', 'security', 'it-ops', 'design', 'support', 'docs', 'records']);
  assert.deepEqual(ids(floorsOf(newRecord({ archetype: 'ops-hub' }))), ['lobby', 'executive', 'planning', 'research', 'engineering', 'quality', 'security', 'it-ops', 'communications', 'records']);
  assert.deepEqual(ids(floorsOf(newRecord({ archetype: 'knowledge' }))), ['lobby', 'capture', 'organize', 'publish', 'archive', 'records']);
  assert.deepEqual(ids(floorsOf(newRecord(null))), ['lobby', 'work', 'review', 'records']);
  const f = floorsOf(r)[1];
  assert.deepEqual(f, { id: 'engineering', name: 'Engineering', wing: 'product', wingName: 'Product and tech', role: 'coder', hidden: false, fixed: false });
});

test('confirm once: the memo stays confirmed, and a confirm of another archetype takes its floors', () => {
  const r = newRecord({ archetype: 'software' });
  const c = edit(r, { action: 'confirm' });
  assert.equal(c.confirmed, true); assert.equal(c.archetype, 'software');
  assert.equal(r.confirmed, false, 'the old record does not change');
  const o = edit(r, { action: 'confirm', archetype: 'ops-hub' });
  assert.equal(o.archetype, 'ops-hub'); assert.equal(o.proposed, 'software'); assert.equal(o.confirmed, true);
  assert.deepEqual(ids(floorsOf(o)).slice(1, 3), ['executive', 'planning']);
  assert.throws(() => edit(r, { action: 'switch', archetype: 'army' }), /No such archetype/);
});

test('the user can switch, rename, add, hide and reorder floors', () => {
  let r = edit(newRecord({ archetype: 'general' }), { action: 'switch', archetype: 'software' });
  assert.equal(r.archetype, 'software');
  r = edit(r, { action: 'rename', floor: 'quality', name: '  Review   desk ' });
  assert.equal(floorsOf(r).find((f) => f.id === 'quality').name, 'Review desk');
  r = edit(r, { action: 'rename', floor: 'quality', name: '' });
  assert.equal(floorsOf(r).find((f) => f.id === 'quality').name, 'Quality', 'an empty name gives the catalog name back');
  r = edit(r, { action: 'add', floor: 'finance' });
  assert.deepEqual(ids(floorsOf(r)).slice(-2), ['finance', 'records']);
  assert.throws(() => edit(r, { action: 'add', floor: 'finance' }), /already a floor/);
  assert.throws(() => edit(r, { action: 'add', floor: 'lobby' }), /every building/);
  r = edit(r, { action: 'hide', floor: 'design' });
  assert.equal(floorsOf(r).find((f) => f.id === 'design').hidden, true);
  assert.ok(!ids(shownFloors(r)).includes('design'));
  r = edit(r, { action: 'show', floor: 'design' });
  assert.ok(ids(shownFloors(r)).includes('design'));
  r = edit(r, { action: 'move', floor: 'docs', by: -1 });
  const order = ids(floorsOf(r));
  assert.ok(order.indexOf('docs') < order.indexOf('support'), 'docs moved down below support');
  assert.throws(() => edit(r, { action: 'hide', floor: 'lobby' }), /Lobby/);
  r = edit(r, { action: 'hide', floor: 'records' });
  assert.ok(!ids(shownFloors(r)).includes('records'));
  // a switch keeps the user's names
  r = edit(edit(r, { action: 'rename', floor: 'engineering', name: 'Build' }), { action: 'switch', archetype: 'ops-hub' });
  assert.equal(floorsOf(r).find((f) => f.id === 'engineering').name, 'Build');
});

test('a building keeps at least one function floor; a hidden floor added again is shown', () => {
  let r = newRecord(null);
  r = edit(r, { action: 'hide', floor: 'work' });
  assert.throws(() => edit(r, { action: 'hide', floor: 'review' }), /at least one/);
  r = edit(r, { action: 'add', floor: 'work' });
  assert.ok(ids(shownFloors(r)).includes('work'));
});

test('cleanRecord keeps known floors once and drops the rest; layoutView and catalogView carry names', () => {
  const r = cleanRecord({ archetype: 'software', confirmed: true, floors: ['engineering', { id: 'engineering' }, { id: 'nope' }, { id: 'lobby' }, { id: 'quality', hidden: true }], names: { quality: 'QA', nope: 'x' } });
  assert.deepEqual(r.floors, [{ id: 'engineering' }, { id: 'quality', hidden: true }]);
  assert.deepEqual(r.names, { quality: 'QA' });
  assert.equal(cleanRecord('x'), null);
  const v = layoutView(r);
  assert.equal(v.archetypeName, 'Software product'); assert.equal(v.confirmed, true);
  assert.deepEqual(ids(v.floors), ['lobby', 'engineering', 'quality', 'records']);
  const c = catalogView();
  assert.ok(c.functions.every((f) => f.id !== 'lobby' && f.id !== 'records'));
  assert.equal(c.archetypes.length, 4);
});

test('floorOfKind: an agent type picks the first shown floor whose words it has', () => {
  const floors = shownFloors(newRecord({ archetype: 'ops-hub' }));
  assert.equal(floorOfKind('code-reviewer', floors), 'quality');
  assert.equal(floorOfKind('security-auditor', floors), 'quality', 'the lower floor wins a tie: Quality comes before Security in Operations Hub');
  assert.equal(floorOfKind('Explore', floors), 'research');
  assert.equal(floorOfKind('lane-hard', floors), 'engineering');
  assert.equal(floorOfKind('planner', floors), 'planning');
  assert.equal(floorOfKind('', floors), null);
  assert.equal(floorOfKind('photographer', floors), null);
  assert.equal(floorOfKind('docs-writer', floors), null, 'Docs is not a floor of an Operations Hub');
});
