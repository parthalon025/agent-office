// The painted screen kit (#182): the text helpers every wall and desk screen shares, through its interface only.
// A stand-in canvas context measures 10 px per character. The screens' own files hold no second copy (the last test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../public/screen-kit.js';

const K = globalThis.OfficeScreenKit;
const c = { measureText: (t) => ({ width: String(t).length * 10 }) };

test('clip: text that fits stays; else its start and the ellipsis fit the width', () => {
  assert.equal(K.clip(c, 'short', 60), 'short');
  assert.equal(K.clip(c, 'a long sentence', 60), 'a lon…');
  assert.equal(K.clip(c, 'a long sentence', 60, '...'), 'a l...');
  assert.equal(K.clip(c, 'abcdef', 60, ''), 'abcdef');
  assert.equal(K.clip(c, 'abcdefgh', 60, ''), 'abcdef');
  assert.equal(K.clip(c, null, 60), '');
});

test('chop adds the ellipsis even when the text fits', () => {
  assert.equal(K.chop(c, 'ab', 100, '…'), 'ab…');
  assert.equal(K.chop(c, 'abcdefgh', 50, '…'), 'abcd…');
});

test('wrap breaks on words by the measured width', () => {
  assert.deepEqual(K.wrap(c, 'one two three four', 100), ['one two', 'three four']);
  assert.deepEqual(K.wrap(c, '', 90), []);
});

test('wrap para keeps newlines and empty lines', () => {
  assert.deepEqual(K.wrap(c, 'one two\n\nthree', 90, { para: true }), ['one two', '', 'three']);
});

test('wrap lines caps the rows and cuts the last with an ellipsis', () => {
  assert.deepEqual(K.wrap(c, 'one two three four five six', 70, { lines: 2, clip: '' }), ['one two', 'three…']);
  assert.deepEqual(K.wrap(c, 'one two', 70, { lines: 2, clip: '' }), ['one two'], 'no cut, no ellipsis');
});

test('wrap clip cuts a word longer than the width on its line', () => {
  assert.deepEqual(K.wrap(c, 'supercalifragilistic ok', 80, { clip: '…' }), ['superca…', 'ok']);
  assert.deepEqual(K.wrap(c, 'supercalifragilistic', 80), ['supercalifragilistic'], 'not asked: kept whole');
});

test('wrapCols breaks to a column count with prefixes and keeps leading spaces', () => {
  assert.deepEqual(K.wrapCols('aaa bbb ccc', 8), ['aaa bbb', 'ccc']);
  assert.deepEqual(K.wrapCols('aaa bbb ccc', 10, '> ', '  '), ['> aaa bbb', '  ccc']);
  assert.deepEqual(K.wrapCols('  indented words here', 12), ['  indented', '  words here']);
  assert.deepEqual(K.wrapCols('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(K.wrapCols('', 10), ['']);
});

test('the estimate: a character is a share of the size; a line made by the plan fits', () => {
  assert.ok(Math.abs(K.charW(10, 400) - 5.6) < 1e-9);
  assert.equal(K.charW(10, 600), 6);
  const lines = K.wrapEst('one two three four five', 20, 100, 400);
  for (const l of lines) assert.ok(l.length * K.charW(20, 400) <= 100, l);
  assert.equal(lines.join(' '), 'one two three four five');
  assert.deepEqual(K.wrapEstAll(['aa bb', 'cc'], 20, 1000, 400), ['aa bb', 'cc'], 'each text on its own lines');
  assert.equal(K.fitSize('Hello', 28, 1000, 600), 28);
  assert.ok(K.fitSize('Hello world kinds', 28, 120, 600) < 28);
  assert.equal(K.fitSize('x'.repeat(200), 28, 50, 600), 14, 'never under 14');
  assert.equal(K.fitSize('', 28, 50, 600), 28);
});

test('font builds the CSS font from the stage kit', () => {
  assert.equal(K.font({ f: { sans: 'Plex', mono: 'Mono' } }, 20, 700), '700 20px Plex');
  assert.equal(K.font({ f: { sans: 'Plex', mono: 'Mono' } }, 20, null, true), '500 20px Mono');
  assert.equal(K.font({}, 12), '500 12px sans-serif');
});

test('rr never takes a radius past half the box', () => {
  const calls = [];
  const g = new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) });
  K.rr(g, 0, 0, 10, 4, 99);
  assert.deepEqual(calls[1], ['moveTo', 2, 0]);
});

test('no screen file keeps its own copy of the text helpers (#182)', () => {
  for (const f of ['board', 'terminal', 'security', 'lobby', 'desk']) {
    const src = fs.readFileSync(new URL(`../public/${f}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /function (wrap|fit|clipW|wrapCols|wrapAll|newTex|font|mix|rr|charW)\(/, `${f}.js uses OfficeScreenKit`);
  }
});
