// Orientation (#196): the steps, the saved progress and its cleaner. Pure; no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, cleanOrientation, mark, view } from '../src/orientation.mjs';
import { createState } from '../src/state.mjs';

test('the steps run in the order of the issue; company and memory are placeholders', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['kinds', 'security', 'spend', 'startup', 'remote', 'company', 'memory', 'tour']);
  assert.deepEqual(STEPS.filter((s) => s.later).map((s) => s.id), ['company', 'memory']);
  for (const s of STEPS) assert.ok(s.title && s.text, s.id);
});

test('a fresh state has no progress and the first step is next', () => {
  const v = view(cleanOrientation(undefined));
  assert.equal(v.seen, false);
  assert.equal(v.next, 'kinds');
  assert.equal(v.finished, false);
  assert.ok(v.steps.every((s) => s.status === 'open'));
});

test('mark saves done or skipped, open puts a step back, unknown steps and words are refused', () => {
  const st = cleanOrientation(undefined);
  mark(st, 'kinds', 'done'); mark(st, 'security', 'skipped');
  assert.deepEqual(st.steps, { kinds: 'done', security: 'skipped' });
  assert.equal(view(st).next, 'spend');
  mark(st, 'security', 'open');
  assert.deepEqual(st.steps, { kinds: 'done' });
  assert.throws(() => mark(st, 'nope', 'done'), (e) => e.status === 400);
  assert.throws(() => mark(st, 'kinds', 'maybe'), (e) => e.status === 400);
});

test('skipped steps stay reachable: they are listed as skipped once the rest are done', () => {
  const st = cleanOrientation(undefined);
  for (const s of STEPS) mark(st, s.id, s.id === 'spend' ? 'skipped' : 'done');
  const v = view(st);
  assert.equal(v.finished, true);
  assert.deepEqual(v.skipped, ['spend']);
  assert.equal(v.steps.find((s) => s.id === 'spend').status, 'skipped');
});

test('the cleaner keeps only known steps with a known status, and seen only when true', () => {
  const c = cleanOrientation({ seen: true, steps: { kinds: 'done', evil: 'done', spend: 'x' } });
  assert.deepEqual(c, { seen: true, steps: { kinds: 'done' } });
  assert.deepEqual(cleanOrientation('junk'), { seen: false, steps: {} });
});

test('progress is saved in the state file as the orientation slice and loads again', () => {
  let text = '';
  const mk = () => createState({ file: 'f', read: () => text, write: (f, t) => { text = t; }, writeFirst: (f, t) => { text = t; }, exists: () => true });
  const a = mk(); a.claim();
  mark(a.get('orientation'), 'startup', 'skipped'); a.get('orientation').seen = true; a.save();
  const b = mk();
  assert.deepEqual(b.get('orientation'), { seen: true, steps: { startup: 'skipped' } });
});
