// The Changes feature (#183): public/changes.js runs in a VM with the DS bundle, the vendored React and a fake page client,
// and is tested through its Interface (window.OfficePage.Changes). No DOM, no browser, no server. A small hook harness runs
// state and effects, so the data hook is tested too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadBundle } from './fixtures/ds-bundle.mjs';

const src = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

/** A component instance with state and effects. render() calls it; effects run after the render, in order, when their deps changed. */
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
    render() {
      i = 0;
      const prev = D.current; D.current = hooks;
      try { out = Comp(props); } finally { D.current = prev; }
      while (effects.length) effects.shift()();
      return out;
    },
  };
}
const all = (n, o = []) => { if (Array.isArray(n)) n.forEach((x) => all(x, o)); else if (n && typeof n === 'object' && n.$$typeof) { o.push(n); all(n.props.children, o); } return o; };
const text = (n) => (Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && n.props ? text(n.props.children) : '');
const tick = () => new Promise((r) => setImmediate(r));

function rig(over = {}) {
  const { React, AO, sb } = loadBundle();
  const calls = [];
  const reply = { files: [{ code: 'M ', word: 'Edited', path: 'a.js' }], diff: '+x', branch: 'agent/x', stat: '1 file', ahead: 0, worktree: { branch: 'agent/x', root: 'E:\\r.worktrees\\x' }, ...over };
  const client = {
    changes: (b) => { calls.push(['changes', { ...b }]); return Promise.resolve(reply); },
    pr: (b) => { calls.push(['pr', { ...b }]); return Promise.resolve({ url: 'https://example.test/pr/1' }); },
    worktreeRemove: (b) => { calls.push(['worktreeRemove', { ...b }]); return Promise.resolve({ removed: true }); },
  };
  const Stub = () => null;
  sb.OfficePage = { Busy: Stub, Tag: Stub, Bezel: Stub, client, putBox() {}, usePinBox: () => false, usePinFocus() {} };
  vm.runInContext(src('public/ask.js'), sb, { filename: 'ask.js' });
  vm.runInContext(src('public/changes.js'), sb, { filename: 'changes.js' });
  return { React, AO, C: sb.OfficePage.Changes, calls, toasts: [] };
}

test('the Interface is one object with the parts of the feature', () => {
  const { C } = rig();
  assert.deepEqual(Object.keys(C).sort(), ['Body', 'Confirm', 'Dialog', 'Screen', 'actions', 'paletteAction', 'use']);
});

test('the data hook loads the changes of its session, and a pull request goes through the client, toasts and loads again', async () => {
  const { React, C, calls } = rig();
  const toasts = [];
  const m = mount(React, (p) => C.use(p.uid, p.toast), { uid: 'u1', toast: (t) => toasts.push(t) });
  let c = m.render();
  assert.equal(c.data, null);
  await tick(); c = m.render();
  assert.deepEqual(calls, [['changes', { uid: 'u1' }]]);
  assert.equal(c.data.branch, 'agent/x');
  assert.equal(c.wt.branch, 'agent/x');
  c.pr();
  await tick(); await tick();
  assert.deepEqual(calls.map((x) => x[0]), ['changes', 'pr', 'changes']);
  assert.equal(toasts[0].title, 'Pull request created');
  c = m.render();
  assert.equal(c.result.url, 'https://example.test/pr/1');
  c.remove(true);
  await tick(); await tick();
  assert.deepEqual(calls.find((x) => x[0] === 'worktreeRemove')[1], { uid: 'u1', force: true });
  assert.equal(toasts.at(-1).title, 'Worktree removed');
});

test('the buttons: Remove worktree waits for a closed session, Create pull request waits for something to send', async () => {
  const { React, AO, C } = rig({ files: [], ahead: 0 });
  const m = mount(React, (p) => C.use(p.uid), { uid: 'u2' });
  m.render(); await tick();
  const c = m.render();
  const btn = (ended) => Object.fromEntries(all(C.actions(c, ended)).filter((e) => e.type === AO.Button).map((e) => [text(e), e.props]));
  assert.equal(btn(false)['Remove worktree'].disabled, true);
  assert.equal(btn(true)['Remove worktree'].disabled, false);
  assert.equal(btn(true)['Create pull request'].disabled, true, 'no files and no commit ahead');
  assert.ok(btn(true).Refresh);
});

test('a button opens its confirm, and the dialog shows the confirm instead of itself', async () => {
  const { React, AO, C } = rig();
  const m = mount(React, C.Dialog, { uid: 'u3', name: 'Scout', ended: true, onClose() {} });
  m.render(); await tick();
  let tree = m.render();
  const dlg = all(tree).find((e) => e.type === AO.Dialog);
  assert.equal(dlg.props.title, 'Changes in Scout');
  all(dlg.props.actions).find((e) => e.type === AO.Button && text(e) === 'Create pull request').props.onClick();
  tree = m.render();
  assert.equal(tree.type, C.Confirm, 'the dialog hands over to the confirm');
  const confirm = all(C.Confirm(tree.props)).find((e) => e.type === AO.Dialog);
  assert.equal(confirm.props.title, 'Create a pull request');
  assert.match(text(confirm), /git push -u origin agent\/x/);
});

test('the body names the files and says so when nothing changed', async () => {
  const { React, AO, C } = rig();
  const m = mount(React, (p) => C.use(p.uid), { uid: 'u4' });
  m.render(); await tick();
  const full = all(C.Body({ c: m.render() }));
  assert.ok(full.some((e) => typeof e.type === 'function' && e.type.name === 'DiffView' && e.props.text === '+x'));
  assert.match(text(full.filter((e) => e.type === 'ul')), /a\.js/);
  const e = rig({ files: [], diff: '' });
  const m2 = mount(e.React, (p) => e.C.use(p.uid), { uid: 'u5' });
  m2.render(); await tick();
  const empty = all(e.C.Body({ c: m2.render() })).find((x) => x.type === e.AO.EmptyState);
  assert.equal(empty.props.title, 'Nothing changed yet');
});

test('the palette action calls the page with the session and its scene name', () => {
  const { C } = rig();
  let got = null;
  const a = C.paletteAction({ uid: 'u9' }, 'Scout', 'in room x', 'kw', (u, n) => { got = [u, n]; });
  assert.equal(a.id, 'page-s-chg-u9');
  assert.equal(a.label, 'Changes of Scout');
  a.run();
  assert.deepEqual(got, ['u9', 'Scout']);
});

test('the screen mounts its confirm and its wall box, and no style prop', () => {
  const { React, AO, C } = rig();
  const m = mount(React, (p) => C.Screen(p), { uid: 'u6', name: 'Scout', host: {}, shown: true, ended: false, waiting: 2, onBack() {}, onGo() {} });
  const tree = all(m.render());
  assert.ok(tree.some((e) => e.type === 'section' && e.props.className.includes('pin-changes') && e.props.hidden === false));
  assert.ok(tree.some((e) => e.type === C.Confirm));
  assert.ok(tree.every((e) => !(e.props && e.props.style)));
  assert.ok(AO);
});
