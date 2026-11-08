// The ways in to Orientation (#238): the dialog opens on a given step (`at`) and tells the page its view (`onView`), so the top bar
// button, the HQ site and Ctrl+K can open it where the person needs it and the page can count the steps left.
// public/reception.js runs in a VM with the DS bundle and a fake client; no DOM, no browser, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadBundle } from './fixtures/ds-bundle.mjs';

const src = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function mount(React, Comp, props) {
  const D = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const slots = [], effects = [];
  let i = 0, out = null;
  const hooks = {
    useState(init) { const k = i++; if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init; return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }]; },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useMemo(f) { i++; return f(); },
    useCallback(f) { i++; return f; },
    useContext(c) { return c._currentValue; },
    useLayoutEffect() { i++; },
    useEffect(fn) { const k = i++; if (!slots[k]) { slots[k] = true; effects.push(fn); } },
  };
  return { render() { i = 0; const prev = D.current; D.current = hooks; try { out = Comp(props); } finally { D.current = prev; } while (effects.length) effects.shift()(); return out; } };
}
const all = (n, o = []) => { if (Array.isArray(n)) n.forEach((x) => all(x, o)); else if (n && typeof n === 'object' && n.$$typeof) { o.push(n); all(n.props.children, o); } return o; };
const tick = () => new Promise((r) => setImmediate(r));

const VIEW = { seen: false, next: 'security', finished: false, skipped: [], steps: ['kinds', 'security', 'company', 'tour'].map((id, n) => ({ id, title: 'T-' + id, text: 'X-' + id, status: n === 0 ? 'done' : 'open' })) };

function rig() {
  const { React, sb } = loadBundle();
  const Stub = () => null;
  const client = { get: () => Promise.resolve(VIEW), orientationStep: () => Promise.resolve(VIEW) };
  sb.localStorage = { getItem: () => null, setItem() {} };
  for (const f of ['vocab', 'vocab-security', 'vocab-layers', 'vocab-persona']) vm.runInContext(src('public/' + f + '.js'), sb, { filename: f + '.js' });
  sb.OfficePage = new Proxy({ client }, { get: (t, k) => (k in t ? t[k] : Stub), has: () => true });
  vm.runInContext(src('public/reception.js'), sb, { filename: 'reception.js' });
  return { React, O: sb.OfficePage };
}
const heading = (tree) => all(tree).filter((e) => e.props && e.props.className === 'reception-h').map((e) => e.props.children)[0];

test('with no `at`, Orientation opens on the first step that is open', async () => {
  const { React, O } = rig();
  const m = mount(React, O.Reception.Orientation, { info: { port: 1 }, toast() {}, onClose() {} });
  m.render(); await tick();
  assert.equal(heading(m.render()), 'T-security');
});

test('`at` opens Orientation on that step, and onView hands the page the view', async () => {
  const { React, O } = rig();
  const seen = [];
  const m = mount(React, O.Reception.Orientation, { info: { port: 1 }, at: 'company', onView: (v) => seen.push(v), toast() {}, onClose() {} });
  m.render(); await tick();
  assert.equal(heading(m.render()), 'T-company');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].next, 'security');
});
