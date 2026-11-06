// Agent character (#150): persona record, working style as tone only, body cue from status only.
// Pure: no I/O. Run: node --test test/personas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, SHAPES, ACCESSORIES, cleanPersona, setPersona, removePersona, personaOf, stylePrompt, bodyCue } from '../personas.mjs';
import { decide, permissionModeFor } from '../security.mjs';

test('cleanPersona keeps only known fields and drops the rest', () => {
  const p = cleanPersona({ name: '  Ada  ', style: 'chatty', shape: SHAPES[0], accessory: ACCESSORIES[0], color: 3, permissions: 'allow', evil: 1 });
  assert.deepEqual(p, { name: 'Ada', style: 'chatty', shape: SHAPES[0], accessory: ACCESSORIES[0], color: 3 });
  assert.equal(cleanPersona({ name: 'x', style: 'reckless' }).style, undefined);
  assert.equal(cleanPersona({ name: 'x'.repeat(100) }).name.length, 40);
  assert.equal(cleanPersona(null), null);
  assert.equal(cleanPersona({ name: '   ' }), null);
});

test('persona map: set, read by name in any case, remove; keys that could poison a map are refused', () => {
  const map = {};
  setPersona(map, 'Ada', { style: 'fast' });
  assert.equal(personaOf(map, 'ada').style, 'fast');
  assert.equal(personaOf(map, 'nobody'), null);
  for (const bad of ['__proto__', 'constructor', 'prototype']) assert.throws(() => setPersona(map, bad, { style: 'fast' }), /name/i);
  removePersona(map, 'ADA');
  assert.equal(personaOf(map, 'ada'), null);
});

test('style prompt: tone only, short, and none for no style', () => {
  assert.equal(stylePrompt(null), '');
  assert.equal(stylePrompt({ name: 'Ada' }), '');
  for (const id of Object.keys(STYLES)) {
    const t = stylePrompt({ name: 'Ada', style: id });
    assert.ok(t.length > 0 && t.length < 400, id);
    assert.doesNotMatch(t, /permission|allow|approve|deny|security|without asking|skip/i, id + ' must say nothing about what the agent may do');
  }
});

test('the Security decision is the same with and without a style', () => {
  const rules = {};
  const calls = [
    { provider: 'claude-code', agent: 'claude-code', action: 'read-inside', risk: 'low', worktree: true },
    { provider: 'claude-code', agent: 'claude-code', action: 'shell', risk: 'high' },
    { provider: 'claude-code', agent: 'claude-code', action: 'secrets', risk: 'high' },
  ];
  for (const style of [undefined, ...Object.keys(STYLES)]) {
    const persona = style ? { name: 'Ada', style } : null;
    for (const c of calls) {
      const base = JSON.stringify([decide(rules, c), permissionModeFor(rules, null, 'default')]);
      const withStyle = JSON.stringify([decide(rules, { ...c, persona, style }), permissionModeFor(rules, null, 'default')]);
      assert.equal(withStyle, base, `${style}: ${c.action}`);
    }
  }
  assert.equal(decide.length, 2); // a call and the rules: no input for a persona
});

test('body cue comes from the status only and is still under reduced motion', () => {
  assert.equal(bodyCue('waiting'), 'raise-hand');
  assert.equal(bodyCue('error'), 'scratch-head');
  assert.equal(bodyCue('finished'), 'stretch');
  assert.equal(bodyCue('working'), null);
  assert.equal(bodyCue('resting'), null);
  assert.equal(bodyCue('nonsense'), null);
  assert.equal(bodyCue('waiting', { reduced: true }), null);
});
