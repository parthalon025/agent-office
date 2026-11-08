// The page features of #184 (schedules, extensions, hq, characters, reception, skills, merge, the pinned screens, needs): each public/<name>.js runs in a VM with the DS
// bundle, the vendored React and a page core of stand-ins, and is tested through its Interface on window.OfficePage.
// Changes (#183) has its own test file. No DOM, no browser, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadBundle } from './fixtures/ds-bundle.mjs';

const src = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function load(file) {
  const { sb } = loadBundle();
  const Stub = () => null;
  const store = {};
  sb.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  for (const f of ['vocab', 'vocab-security', 'vocab-layers', 'vocab-persona']) vm.runInContext(src('public/' + f + '.js'), sb, { filename: f + '.js' });
  // Every name the feature reads from the page core is a stand-in; the Interface is what the feature puts back.
  sb.OfficePage = new Proxy({}, { get: (t, k) => (k in t ? t[k] : Stub), has: () => true });
  vm.runInContext(src('public/' + file), sb, { filename: file });
  return { O: sb.OfficePage, store };
}

const SHAPES = {
  'schedules.js': ['Schedules', ['Dialog']],
  'extensions.js': ['Extensions', ['Dialog']],
  'hq.js': ['Hq', ['AdapterInstall', 'ApprovalDecide', 'Hire', 'HireForm', 'Hq', 'Manager', 'Memory', 'PaperclipLink', 'Trust']],
  'characters.js': ['Characters', ['Dialog']],
  'skills.js': ['Skills', ['Dialog']],
  'merge.js': ['Merge', ['Flow', 'Row', 'use']],
  'screens.js': ['Screens', ['Desk', 'Note']],
  'reception.js': ['Reception', ['Orientation', 'Recap', 'Reception', 'TourCard', 'orientationDue', 'setTourSeen', 'tourSeen']],
};

for (const [file, [name, keys]] of Object.entries(SHAPES)) {
  test(`${file}: the Interface is OfficePage.${name} with ${keys.join(', ')}`, () => {
    const { O } = load(file);
    const I = O[name];
    assert.deepEqual(Object.keys(I).sort(), keys);
    for (const k of keys) assert.equal(typeof I[k], 'function', k);
  });
}

test('the old flat names are gone from the page core, so a caller must use the Interface', () => {
  const { O } = load('hq.js');
  assert.equal(Object.prototype.hasOwnProperty.call(O, 'ManagerDialog'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(O, 'HqDialog'), false);
});

test('the lobby tour mark is kept in the browser storage under one key', () => {
  const { O, store } = load('reception.js');
  assert.equal(O.Reception.tourSeen(), false);
  O.Reception.setTourSeen();
  assert.equal(store['ao-tour'], '1');
  assert.equal(O.Reception.tourSeen(), true);
});

test('the page files load in an order where each feature file comes after page-core.js and before office.js', () => {
  const html = src('public/index.html');
  const at = (f) => html.indexOf(`/${f}"`);
  for (const f of Object.keys(SHAPES)) {
    assert.ok(at('page-core.js') < at(f) && at(f) < at('office.js'), f);
  }
  assert.equal(html.includes('dialogs-extra.js'), false);
});

test('needs.js: the Interface is OfficePage.Needs, and the paper flow and the pinned screens moved out of the shared namespace', () => {
  const { O } = load('needs.js');
  assert.deepEqual(Object.keys(O.Needs).sort(), ['Dialog', 'PHONE_MAX', 'Phone', 'openPalette']);
  assert.equal(typeof O.Needs.PHONE_MAX, 'number');
  for (const k of ['Dialog', 'Phone', 'openPalette']) assert.equal(typeof O.Needs[k], 'function', k);
  for (const old of ['FlowDialog', 'NeedsDialog', 'PhoneView', 'PHONE_MAX', 'openPalette', 'DeskScreen', 'NoteScreen', 'SkillsDialog']) {
    assert.equal(Object.prototype.hasOwnProperty.call(O, old), false, old);
  }
});

test('Orientation opens by itself once: the server has not seen it closed and this browser has not either (#196)', () => {
  const { O, store } = load('reception.js');
  assert.equal(O.Reception.orientationDue(null), false);
  assert.equal(O.Reception.orientationDue({ seen: true }), false);
  assert.equal(O.Reception.orientationDue({ seen: false }), true);
  store['ao-orientation'] = '1';
  assert.equal(O.Reception.orientationDue({ seen: false }), false);
});

test('hq.js: every inline ask-first Confirm is the one shared ConfirmBar, which scrolls its buttons into view', () => {
  const code = src('public/hq.js');
  const fn = (name) => {
    const at = code.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    const next = code.indexOf('\n  function ', at + 1);
    return code.slice(at, next < 0 ? code.length : next);
  };
  // The shared part scrolls on mount and keeps the busy state of its caller.
  const bar = fn('ConfirmBar');
  assert.match(bar, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(bar, /loading: p\.busy, disabled: p\.busy/);
  // Each Confirm path renders it and has no scroll code of its own.
  for (const name of ['OrgChart', 'MemoryPanel', 'Access', 'useConfirm', 'SelfApproval', 'Goals', 'AdapterInstall', 'TrustDialog', 'Instance']) {
    const body = fn(name);
    assert.match(body, /h\(ConfirmBar,/, name + ' uses ConfirmBar');
    assert.doesNotMatch(body, /scrollIntoView/, name + ' has no scroll code of its own');
  }
  // Outside the shared part and the hire form (another change) no hand-built scroll or "Confirm: " button is left.
  const outside = code.replace(fn('ConfirmBar'), '').replace(fn('HireForm'), '');
  assert.doesNotMatch(outside, /ref\.current\.scrollIntoView|actionsRef\.current\.scrollIntoView/);
  assert.doesNotMatch(outside, /'Confirm: '/);
});
