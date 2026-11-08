// The HQ write grid wall (#223): every write kind with value and source, the painted Confirm for a looser change, no Allow for a secret.
// The fake client runs the real grid rules (src/hq-writes). No DOM, no browser, no Paperclip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadBundle } from './fixtures/ds-bundle.mjs';
import { gridRows, setWriteCell, WRITE_KINDS } from '../src/hq-writes/index.mjs';

const src = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

/** A component instance with state and effects. render() calls it; effects run after the render when their deps changed. */
function mount(React, Comp, props) {
  const D = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const slots = [], effects = [];
  let i = 0, out = null;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  const hooks = {
    useState(init) { const k = i++; if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init; return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }]; },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useMemo(f) { i++; return f(); },
    useCallback(f) { i++; return f; },
    useContext(c) { return c._currentValue; },
    useLayoutEffect() { i++; },
    useEffect(fn, deps) { const k = i++; const prev = slots[k]; if (!prev || !deps || !same(prev.deps, deps)) { slots[k] = { deps }; effects.push(fn); } },
  };
  return {
    render(next) {
      if (next) props = next;
      i = 0;
      const prev = D.current; D.current = hooks;
      try { out = Comp(props); } finally { D.current = prev; }
      while (effects.length) effects.shift()();
      return out;
    },
  };
}
const all = (n, o = []) => { if (Array.isArray(n)) n.forEach((x) => all(x, o)); else if (n && typeof n === 'object' && n.$$typeof) { o.push(n); all(n.props && n.props.children, o); } return o; };
const text = (n) => (Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && n.props ? text(n.props.children) : '');
const tick = () => new Promise((r) => setImmediate(r));
const buttons = (tree, AO) => all(tree).filter((e) => e.type === AO.Button);
const byText = (tree, AO, label) => buttons(tree, AO).find((e) => text(e) === label);
// The painted Confirm is ConfirmBar, one component under the row. Render it to reach its buttons.
function confirmBar(tree, React) {
  const bar = all(tree).find((e) => e.type && e.type.name === 'ConfirmBar');
  return bar ? mount(React, bar.type, bar.props).render() : null;
}


function rig(start = {}) {
  const { React, AO, sb } = loadBundle();
  const sent = [], toasts = [];
  let grid = start;
  const client = {
    get() { return Promise.resolve({ grid: gridRows(grid), selfApproval: null }); },
    send(name, b) {
      sent.push([name, JSON.parse(JSON.stringify(b))]);
      try { const r = setWriteCell(grid, { kind: b.kind, value: b.value, confirmed: b.confirmed === true }); grid = r.grid; return Promise.resolve({ ok: true, grid: gridRows(grid) }); }
      catch (e) { return Promise.reject(e); }
    },
  };
  const Stub = () => null;
  sb.OfficePage = { Tag: (p) => React.createElement('span', null, p.children), client, ago: () => '', plural: (n, a, b) => n + ' ' + (n === 1 ? a : b), refocusRow() {}, sceneName: (s) => s.name, useSnapshot: () => ({}), Merge: { use: () => ({}), Row: Stub } };
  vm.runInContext(src('public/vocab.js'), sb, { filename: 'vocab.js' });
  vm.runInContext(src('public/ask.js'), sb, { filename: 'ask.js' });
  vm.runInContext(src('public/hq.js'), sb, { filename: 'hq.js' });
  return { React, AO, sent, toasts, Grid: sb.OfficePage.Hq.WriteGrid, toast: (t) => toasts.push(t) };
}
const row = (tree, label) => all(tree).find((e) => e.type === 'li' && text(e.props.children[0]).startsWith(label));
const btn = (li, AO, label) => buttons(li, AO).find((e) => text(e) === label);

test('every write kind is shown with its value and its source', async () => {
  const { React, Grid, toast } = rig({ task: 'deny' });
  const m = mount(React, Grid, { toast });
  m.render(); await tick();
  const tree = m.render();
  const lis = all(tree).filter((e) => e.type === 'li');
  assert.equal(lis.length, Object.keys(WRITE_KINDS).length, 'one row per kind');
  const t = text(row(tree, 'Tasks'));
  assert.match(t, /Deny/); assert.match(t, /Never sends/); assert.match(t, /Set by you/);
  assert.match(text(row(tree, 'Hires')), /Default/);
});

test('a looser change shows the painted Confirm and sends nothing until it; a stricter one applies at once', async () => {
  const { React, AO, sent, toasts, Grid, toast } = rig({});
  const m = mount(React, Grid, { toast });
  m.render(); await tick();
  let tree = m.render();
  btn(row(tree, 'Hires'), AO, 'Allow').props.onClick();
  assert.equal(sent.length, 0, 'the first click sends nothing');
  tree = m.render();
  const bar = all(row(tree, 'Hires')).find((e) => e.type && e.type.name === 'ConfirmBar');
  assert.ok(bar, 'the Confirm shows under the row');
  const ok = buttons(mount(React, bar.type, bar.props).render(), AO).find((e) => text(e).startsWith('Confirm: '));
  assert.match(text(ok), /set Hires to Allow/);
  ok.props.onClick(); await tick();
  assert.deepEqual(sent, [['hqGridSet', { kind: 'hire', value: 'allow', confirmed: true }]]);
  assert.equal(toasts.at(-1).title, 'Hires: Allow');
  tree = m.render();
  assert.match(text(row(tree, 'Hires')), /Set by you/);
  btn(row(tree, 'Hires'), AO, 'Deny').props.onClick(); await tick();
  assert.deepEqual(sent.at(-1), ['hqGridSet', { kind: 'hire', value: 'deny', confirmed: false }], 'stricter: at once, no Confirm');
  tree = m.render();
  btn(row(tree, 'Hires'), AO, 'Use default').props.onClick();
  tree = m.render();
  assert.ok(all(row(tree, 'Hires')).find((e) => e.type && e.type.name === 'ConfirmBar'), 'Deny to the default Confirm is looser: it asks');
  assert.equal(sent.length, 2);
});

test('a secret has no Allow button', async () => {
  const { React, AO, Grid, toast } = rig({});
  const m = mount(React, Grid, { toast });
  m.render(); await tick();
  const li = row(m.render(), 'Secrets');
  assert.ok(li, 'the secret row is shown');
  assert.equal(btn(li, AO, 'Allow'), undefined);
  assert.ok(btn(li, AO, 'Deny'));
});

test('the Ctrl+K action and the dialog focus reach the wall', () => {
  const office = src('public/office.js');
  assert.ok(office.includes("id: 'page-hq-grid'") && office.includes("focus: { kind: 'grid', id: 'rules' }"));
  assert.match(src('public/hq.js'), /id: 'hq-grid-rules'/);
});
