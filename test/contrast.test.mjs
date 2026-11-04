// Readable in every theme: the text and ink pairs that the page and the 3D scripts draw, from tokens.json.
// Each pair needs 4.5:1 (text) or 3:1 (a status dot) in Day, Night and Sublevel. The CSS checks pin the rules
// that use those pairs, so a later edit cannot put a status color back on text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const tokens = JSON.parse(read('tokens.json')).color.tokens;
const TH = ['light', 'dark', 'sublevel'];
const val = (name, th) => { let v = tokens.find((t) => t.name === name).value[th]; while (/^\{/.test(v)) v = tokens.find((t) => t.name === v.slice(1, -1)).value[th]; return v; };
const rgb = (h) => {
  const m = h.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
};
const mix = (a, b, w) => [0, 1, 2].map((i) => a[i] * w + b[i] * (1 - w)).concat(1);   // w of a, rest of b (CSS color-mix)
const over = (a, b) => [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function each(fn) { for (const th of TH) { const T = (n) => rgb(val(n, th)); fn(T, th, over(T('panel'), T('bg'))); } }
function atLeast(label, min, a, b, th) { const r = ratio(a, b); assert.ok(r >= min, `${label} in ${th}: ${r.toFixed(2)} < ${min}`); }

test('notes editor: ink and placeholder on the whiteboard face', () => each((T, th) => {
  const ink = mix(T('scene-dark'), T('status-finished'), 0.7), hint = mix(T('scene-dark'), T('bubble'), 0.82);
  atLeast('notes ink', 4.5, ink, T('bubble'), th);
  atLeast('notes placeholder', 4.5, hint, T('bubble'), th);
}));

test('City label card: ink and muted on bg', () => each((T, th) => {
  atLeast('label name', 4.5, T('ink'), T('bg'), th);
  atLeast('label sub', 4.5, T('muted'), T('bg'), th);
}));

test('status words: ink on the panel, the chip and the page', () => each((T, th, panel) => {
  for (const bg of [['panel', panel], ['chip', T('chip')], ['bg', T('bg')]]) atLeast('ink on ' + bg[0], 4.5, T('ink'), bg[1], th);
}));

test('status dots next to the words read at 3:1 on the panel', () => each((T, th, panel) => {
  for (const s of ['working', 'waiting', 'error', 'finished']) atLeast('dot ' + s, 3, T('status-' + s), panel, th);
  atLeast('dot emphasis', 3, T('emphasis'), panel, th);
}));

test('diff: ink on the chip, and on the added and removed lines', () => each((T, th) => {
  const add = over([...T('status-working').slice(0, 3), 0.16], T('chip')), del = over([...T('status-error').slice(0, 3), 0.16], T('chip'));
  const hunk = over([...T('accent').slice(0, 3), 0.12], T('chip'));
  for (const bg of [T('chip'), add, del, hunk]) atLeast('diff ink', 4.5, T('ink'), bg, th);
}));

test('the CSS keeps status colors off text and uses the ink pairs above', () => {
  const css = read('public/office.css');
  const NL = String.fromCharCode(10);
  const rule = (sel) => {   // every declaration block of the selector
    let out = '', at = css.indexOf(NL + sel + ' {');
    while (at >= 0) { out += css.slice(at, css.indexOf('}', at)); at = css.indexOf(NL + sel + ' {', at + 1); }
    assert.ok(out, 'rule ' + sel);
    return out;
  };
  assert.match(rule('.notes-text'), /color: color-mix\(in srgb, var\(--scene-dark\) 70%, var\(--status-finished\)\)/);
  assert.match(css, /\.notes-text::placeholder \{ color: color-mix\(in srgb, var\(--scene-dark\) 82%, var\(--bubble\)\)/);
  assert.match(rule('.ext-err'), /color: var\(--ink\)/);
  assert.match(rule('.city-wait'), /color: var\(--ink\)/);
  assert.match(rule('.dl.hunk'), /color: var\(--ink\)/);
  assert.match(rule('.dl.meta'), /color: var\(--ink\)/);
  assert.match(rule('.board-tree li.is-hot span:nth-child(2)'), /color: var\(--ink\)/);
  assert.match(rule('.fcode'), /color: var\(--muted\)|color: var\(--ink\)/);
  // no rule colors text with a status token (dots and tints use them as backgrounds only)
  for (const m of css.matchAll(/(?:^|[;{\s])color: var\(--(status-[a-z]+)\)/g)) assert.fail('text colored with ' + m[1]);
});

test('the City label draws on bg, not a bubble', () => {
  const city = read('public/city.js');
  assert.match(city, /g\.fillStyle = tok\['bg'\]/);
  assert.doesNotMatch(city, /g\.fillStyle = tok\['bubble'\]/);
});
