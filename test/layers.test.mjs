// Layers (ADR 0006, #145): the layer vocabulary in public/vocab.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';

const V = globalThis.OfficeVocab;
const L = V.layers;
const mk = (o) => ({ status: 'idle', turns: 0, pending: [], questions: [], calls: [], todos: [], usage: { tokens: 0 }, error: null, cost: null, lastEvent: 0, note: '', prompt: '', live: '', tool: null, ...o });

test('layers: order, opens and surfaces', () => {
  assert.deepEqual(L.order, ['glance', 'look', 'inspect', 'deep']);
  assert.deepEqual(L.order.map(L.opens), ['look', 'inspect', 'deep', '']);
  assert.equal(L.opens('nope'), '');
  assert.deepEqual([L.surface('city').layer, L.surface('city').opens], ['glance', 'look']);
  assert.equal(L.surface('floor').layer, 'glance');
  assert.deepEqual([L.surface('room').layer, L.surface('room').opens], ['look', 'inspect']);
  assert.equal(L.surface('chat').opens, 'deep');
  assert.equal(L.surface('security').opens, '');
  assert.equal(L.surface('__proto__'), null);
});

test('layers: every surface opens the layer after its own', () => {
  for (const id of Object.keys(L.surfaces)) assert.equal(L.surface(id).opens, L.opens(L.surface(id).layer), id);
});

test('layers: Glance is a mood, with text only when something needs the owner', () => {
  assert.deepEqual(L.glance(V.figures([]), null), { state: 'resting', mood: { key: 'resting', word: 'Calm' }, text: '' });
  assert.equal(L.glance({ working: 2, waiting: 0 }).text, '');
  assert.equal(L.glance({ working: 2, waiting: 0 }).mood.word, 'Busy');
  assert.equal(L.glance({ waiting: 1 }).text, '1 needs you');
  assert.equal(L.glance({ waiting: 3 }).text, '3 need you');
  assert.equal(L.glance({ waiting: 3 }, 'error').text, 'Failed');
  assert.equal(L.glance({ waiting: 0 }, 'finished').text, '');
});

test('layers: Look is one intent sentence, progress and cost', () => {
  const s = mk({ prompt: 'Fix the\nlogin bug', todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'pending' }], cost: 0.4 });
  assert.deepEqual(L.look(s), { intent: 'Fix the login bug', progress: '1 of 3 steps', cost: '$0.40' });
  assert.equal(L.look(mk({ todos: [{ status: 'pending' }] })).progress, '0 of 1 step');
  assert.equal(L.look(mk({ costUnknown: true })).cost, 'unknown');
  assert.equal(L.look(mk({})).cost, '');
  assert.equal(L.look(mk({ prompt: 'x'.repeat(500) })).intent.length, 120);
});

test('layers: a place remembers the layer used most', () => {
  let m = {};
  assert.equal(L.layerFor(m, 'b1'), 'glance');
  m = L.remember(m, 'b1', 'inspect');
  m = L.remember(m, 'b1', 'look');
  m = L.remember(m, 'b1', 'inspect');
  assert.equal(L.layerFor(m, 'b1'), 'inspect');
  assert.equal(L.layerFor(m, 'b2'), 'glance');
  const before = JSON.stringify(m);
  L.remember(m, 'b1', 'deep');
  assert.equal(JSON.stringify(m), before, 'remember does not change its input');
  assert.deepEqual(L.remember(m, 'b1', 'bogus'), m);
  assert.equal(L.layerFor(L.remember({}, '__proto__', 'deep'), 'constructor'), 'glance');
});

test('layers: Look of a room sums its agents', () => {
  const a = mk({ prompt: 'Fix login', todos: [{ status: 'completed' }, { status: 'pending' }], cost: 0.4, lastEvent: 5 });
  const b = mk({ prompt: 'Write docs', todos: [{ status: 'pending' }], cost: 0.1, lastEvent: 9 });
  const r = L.lookRoom([a, b]);
  assert.deepEqual([r.count, r.progress, r.cost, r.intent], [2, '1 of 3 steps', '$0.50', 'Write docs']);
  assert.deepEqual(L.lookRoom([]), { count: 0, intent: '', progress: '', cost: '' });
  assert.equal(L.lookRoom([a, mk({ costUnknown: true })]).cost, 'unknown');
});

test('layers: the remembered layer is read from storage text, never trusted', () => {
  assert.deepEqual(L.parse('{"r1":{"look":2,"bogus":1,"inspect":"x"}}'), { r1: { look: 2 } });
  assert.deepEqual(L.parse('not json'), {});
  assert.deepEqual(L.parse('[1]'), {});
  assert.deepEqual(L.parse('{"__proto__":{"look":1}}'), {});
});

test('layers: a place opens straight at the remembered layer past Look', () => {
  assert.equal(L.opensAt('glance'), false);
  assert.equal(L.opensAt('look'), false);
  assert.equal(L.opensAt('inspect'), true);
  assert.equal(L.opensAt('deep'), true);
});
