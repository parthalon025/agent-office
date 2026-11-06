// Saved-state slices and the one writer (#181), through createState with an in-memory file. No server, no port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, SLICES } from '../src/state.mjs';
import { exportCustom } from '../src/personas.mjs';

const memory = (initial) => {
  const m = { text: initial, writes: [], firsts: [] };
  return { m, read: () => { if (m.text === undefined) throw new Error('ENOENT'); return m.text; },
    write: (f, t) => { m.writes.push(t); m.text = t; }, writeFirst: (f, t) => { m.firsts.push(t); m.text = t; } };
};
const open = (initial) => { const f = memory(initial); return { f, st: createState({ file: 'state.json', read: f.read, write: f.write, writeFirst: f.writeFirst, exists: () => true }) }; };

test('a state file with bad slices: each area cleans its own, the rest is kept', () => {
  const bad = {
    security: 'nope', costs: [1, 2], trust: 7, layouts: { b1: 'x', b2: null }, rooms: 'x',
    notes: { 'k': { text: 'hi', at: 1 } }, pins: [], merges: { not: 'a list' }, standups: 'x', focus: 'yes',
    personas: 5, teams: [], screens: 'x', templates: 'x', schedules: { a: 1 }, spendLimit: -3, paperclip: { company: 'c' },
    recent: 'x', future: { kept: true },
  };
  const { st } = open(JSON.stringify(bad));
  assert.deepEqual(st.get('layouts'), {});
  assert.deepEqual(st.get('costs'), {});
  assert.deepEqual(st.get('pins'), {});
  assert.deepEqual(st.get('merges'), []);
  assert.deepEqual(st.get('standups'), {});
  assert.equal(st.get('focus'), false);
  assert.deepEqual(st.get('templates'), []);
  assert.deepEqual(st.get('schedules'), []);
  assert.equal(st.get('spendLimit'), undefined);
  assert.equal(st.get('paperclip'), undefined);
  assert.deepEqual(st.get('recent'), []);
  assert.equal(st.get('notes').k.v, 1, 'a board without a version counter gets 1');
  assert.deepEqual(st.get('future'), { kept: true }, 'a key no slice knows is kept');
  for (const k of ['security', 'trust', 'rooms', 'personas', 'teams', 'screens']) assert.ok(st.get(k) && typeof st.get(k) === 'object', k);
});

test('a missing or unreadable file gives every slice its default', () => {
  for (const initial of [undefined, 'not json', '[]']) {
    const { st } = open(initial);
    for (const k of Object.keys(SLICES)) if (['templates', 'schedules', 'recent', 'merges'].includes(k)) assert.deepEqual(st.get(k), [], k);
    assert.equal(st.get('focus'), false);
  }
});

test('recent drops folders that are gone', () => {
  const f = memory(JSON.stringify({ recent: ['C:\\keep', 'C:\\gone'] }));
  const st = createState({ file: 'x', read: f.read, write: f.write, exists: (d) => d !== 'C:\\gone' });
  assert.deepEqual(st.get('recent'), ['C:\\keep']);
});

test('the second-office rule: nothing is written before claim, claim writes the whole file owner-only, then saves are plain', () => {
  const { f, st } = open(JSON.stringify({ focus: true, notes: { a: { text: 't', at: 1, v: 2 } } }));
  st.set('focus', false); st.save();
  assert.equal(f.m.writes.length, 0, 'a copy that does not own its port writes nothing');
  assert.equal(f.m.firsts.length, 0);
  assert.equal(st.owned(), false);
  st.claim();
  assert.equal(st.owned(), true);
  assert.equal(f.m.firsts.length, 1, 'the first write goes through the owner-only writer');
  assert.equal(f.m.writes.length, 0);
  assert.equal(JSON.parse(f.m.firsts[0]).focus, false, 'with the state kept in memory');
  assert.equal(JSON.parse(f.m.firsts[0]).notes.a.v, 2);
  st.set('focus', true); st.save();
  assert.equal(f.m.writes.length, 1, 'later saves are plain writes');
  assert.equal(JSON.parse(f.m.writes[0]).focus, true);
});

test('set(undefined) removes the key, and a failing write never throws', () => {
  const m = { n: 0 };
  const st = createState({ file: 'x', read: () => '{}', write: () => { m.n++; throw new Error('disk'); }, writeFirst: () => {}, exists: () => true });
  st.set('paperclip', { url: 'u', company: null }); assert.ok(st.get('paperclip'));
  st.set('paperclip', undefined); assert.equal(st.get('paperclip'), undefined);
  st.claim(); st.save();
  assert.equal(m.n, 1);
});

test('slice(): one object over some keys, reads and writes go to the state', () => {
  const { st } = open('{}');
  const s = st.slice('layouts', 'rooms', 'merges');
  s.merges = [{ key: 'k' }]; s.rooms = { r: 1 };
  assert.deepEqual(st.get('merges'), [{ key: 'k' }]);
  assert.deepEqual(s.rooms, { r: 1 });
  assert.deepEqual(Object.keys(s), ['layouts', 'rooms', 'merges']);
  assert.equal(s.focus, undefined, 'only the keys asked for');
  const out = exportCustom(st.slice('personas', 'teams', 'screens', 'layouts'));
  assert.deepEqual(out.layouts, {});
});
