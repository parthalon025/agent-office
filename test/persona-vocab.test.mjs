// Agent character on the page (#150): the words, the look and the body cue, one copy in vocab.js. Pure: no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/vocab.js';
import { SHAPES, COLORS, ACCESSORIES, STYLES, bodyCue } from '../personas.mjs';

const P = globalThis.OfficeVocab.persona;

test('every persona shape maps to a DS bot shape, and every style and accessory has a word', () => {
  const ds = ['blob', 'cone', 'octa', 'capsule'];
  for (const s of SHAPES) assert.ok(ds.includes(P.shapeOf({ shape: s })), s);
  assert.equal(P.shapeOf({}), undefined);
  assert.equal(P.shapeOf(null), undefined);
  for (const s of Object.keys(STYLES)) assert.equal(P.styleWord(s), STYLES[s].label);
  for (const a of ACCESSORIES) assert.ok(P.accessoryWord(a));
  assert.equal(P.styleWord('nope'), '');
});

test('every persona color index has a word', () => {
  assert.equal(P.COLOR_COUNT, COLORS);
  for (let i = 0; i < COLORS; i++) assert.ok(P.colorWord(i));
});

test('the look reads the record only: color by index into the DS colors, accessory, none for no record', () => {
  const colors = ['#a', '#b', '#c'];
  assert.deepEqual(P.lookOf({ name: 'x', shape: 'tall', color: 1, accessory: 'hat' }, colors), { shape: 'cone', color: '#b', accessory: 'hat' });
  assert.deepEqual(P.lookOf({ name: 'x', color: 7 }, colors), { shape: undefined, color: undefined, accessory: undefined });
  assert.equal(P.lookOf(null, colors), null);
});

test('the cue rule has one copy: the server rule and the page rule agree for every status', () => {
  for (const st of ['waiting', 'error', 'finished', 'working', 'resting', 'review', 'x']) {
    assert.equal(P.cueOf(st, false), bodyCue(st));
    assert.equal(P.cueOf(st, true), null);
  }
});

test('a cue pose is a small bounded movement, and none for no cue', () => {
  for (const c of ['raise-hand', 'scratch-head', 'stretch']) {
    const a = P.pose(c, 0.37);
    assert.ok(Math.abs(a.arm) <= Math.PI, c);
    assert.ok(a.lift >= 0 && a.lift <= 0.3, c);
  }
  assert.deepEqual(P.pose(null, 1), { arm: 0, lift: 0 });
});

test('the blackboard views: ids, words, which columns each shows, and an unknown id falls back to Overview', () => {
  const W = globalThis.OfficeVocab.wall;
  assert.deepEqual(W.VIEWS.map((v) => v.id), ['overview', 'steps', 'repo']);
  assert.ok(W.VIEWS.every((v) => v.word && v.note));
  assert.deepEqual(W.columnsOf('overview'), ['browser', 'recent', 'repo']);
  assert.deepEqual(W.columnsOf('steps'), ['browser', 'recent']);
  assert.deepEqual(W.columnsOf('repo'), ['repo']);
  assert.deepEqual(W.columnsOf('constructor'), ['browser', 'recent', 'repo']);
  assert.equal(W.viewOf({ a: 'repo' }, 'a'), 'repo');
  assert.equal(W.viewOf({ a: 'weather' }, 'a'), 'overview');
  assert.equal(W.viewOf(null, 'a'), 'overview');
  assert.equal(W.viewOf({}, '__proto__'), 'overview');
});
