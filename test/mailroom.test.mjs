// The mailroom (#224): the HQ lists the open tasks and makes, assigns, moves and comments on them through hq.write (the Tasks and Comments cells).
// A render sends nothing. Confirm is a second call with confirmed: true. Deny hides the forms and says why. No DOM, no Paperclip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadBundle } from './fixtures/ds-bundle.mjs';

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
const byText = (tree, AO, label) => all(tree).find((e) => e.type === AO.Button && text(e) === label);
function confirmBar(tree, React) {
  const bar = all(tree).find((e) => e.type && e.type.name === 'ConfirmBar');
  return bar ? mount(React, bar.type, bar.props).render() : null;
}

const T1 = 'i1000000-0000-4000-8000-000000000001', A1 = 'a1000000-0000-4000-8000-000000000001';
const Q = { company: { name: 'Acme' }, taskWrite: true, commentWrite: true, agents: [{ id: A1, name: 'Ada' }],
  tasks: [{ id: T1, identifier: 'ACM-1', title: 'Fix it', status: 'todo', assigneeId: '', assignee: '', link: 'http://127.0.0.1:3100/ACM/issues/ACM-1' }] };

function rig(grid) {
  const { React, AO, sb } = loadBundle();
  const calls = [], toasts = [];
  const client = {
    hqWrite(body) {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (grid === 'confirm' && body.confirmed !== true) {
        const e = new Error('Send this change to Paperclip?'); e.status = 409; e.body = { error: e.message, confirm: 'write', write: { kind: body.kind, action: body.action, summary: 'Change' } };
        return Promise.reject(e);
      }
      return Promise.resolve({ ok: true });
    },
    get() { return Promise.resolve({}); },
    send(name, body) { return client.hqWrite(body); },
  };
  sb.OfficePage = { Tag: (p) => React.createElement('span', null, p.children), ago: () => '', client, clip: (s) => s, plural: (n, a, b) => n + ' ' + (n === 1 ? a : b), refocusRow() {}, sceneName: (s) => s.name, useSnapshot: () => ({}),
    Area: (p) => React.createElement('textarea', null) };
  vm.runInContext(src('public/vocab.js'), sb, { filename: 'vocab.js' });
  vm.runInContext(src('public/ask.js'), sb, { filename: 'ask.js' });
  vm.runInContext(src('public/hq.js'), sb, { filename: 'hq.js' });
  return { React, AO, sb, calls, toasts, M: sb.OfficePage.Hq.Mailroom, toast: (t) => toasts.push(t) };
}
const sel = (tree, AO, id) => all(tree).find((e) => e.type === AO.Select && e.props.id === id);

test('vocab: the bodies of the four actions, and nothing for an empty title, comment or unknown status', () => {
  const { sb } = rig('allow');
  const v = sb.OfficeVocab.hq.tasks(Q);
  assert.deepEqual(JSON.parse(JSON.stringify(v.create({ title: ' New ', description: '', assignee: A1 }))), { kind: 'task', action: 'create', title: 'New', assigneeAgentId: A1 });
  assert.equal(v.create({ title: '  ' }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(v.assign(T1, A1))), { kind: 'task', action: 'assign', issue: T1, agent: A1 });
  assert.equal(v.assign(T1, ''), null);
  assert.deepEqual(JSON.parse(JSON.stringify(v.move(T1, 'done'))), { kind: 'task', action: 'status', issue: T1, status: 'done' });
  assert.equal(v.move(T1, 'weird'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(v.comment(T1, ' hi '))), { kind: 'comment', action: 'add', issue: T1, text: 'hi' });
  assert.equal(v.comment(T1, ''), null);
  assert.equal(v.rows[0].line, 'Not assigned');
  assert.equal(sb.OfficeVocab.hq.tasks({ ...Q, tasks: null }).unknown, true);
});

test('a render sends nothing; a status change under Allow is one call', async () => {
  const { React, AO, M, calls, toast, toasts } = rig('allow');
  const m = mount(React, M, { q: Q, toast, mark: () => false });
  m.render();
  const tree = m.render();
  assert.equal(calls.length, 0);
  sel(tree, AO, 'task-st-' + T1).props.onChange('done');
  await tick();
  assert.deepEqual(calls, [{ kind: 'task', action: 'status', issue: T1, status: 'done' }]);
  assert.equal(toasts[0].title, 'Task moved');
});

test('under Confirm the assign waits for the painted Confirm, which sends the same body with confirmed', async () => {
  const { React, AO, M, calls, toast } = rig('confirm');
  const m = mount(React, M, { q: Q, toast, mark: () => false });
  m.render();
  sel(m.render(), AO, 'task-as-' + T1).props.onChange(A1);
  await tick();
  const tree = m.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].confirmed, undefined);
  const bar = confirmBar(tree, React);
  assert.ok(bar, 'the Confirm shows');
  all(bar).find((e) => e.type === AO.Button && /^Confirm/.test(text(e))).props.onClick();
  await tick();
  assert.deepEqual(calls[1], { kind: 'task', action: 'assign', issue: T1, agent: A1, confirmed: true });
});

test('a new task needs a title, and the comment box sends a comment write', async () => {
  const { React, AO, M, calls, toast } = rig('allow');
  const m = mount(React, M, { q: Q, toast, mark: () => false });
  m.render();
  byText(m.render(), AO, 'New task').props.onClick();
  let tree = m.render();
  assert.equal(byText(tree, AO, 'Create task').props.disabled, true);
  all(tree).find((e) => e.type === AO.TextInput && e.props.id === 'task-new-title').props.onChange('Ship');
  tree = m.render();
  byText(tree, AO, 'Create task').props.onClick();
  await tick();
  assert.deepEqual(calls[0], { kind: 'task', action: 'create', title: 'Ship' });
  byText(m.render(), AO, 'Comment').props.onClick();
  tree = m.render();
  all(tree).find((e) => e.props && e.props.id === 'task-cm-' + T1).props.onChange('Looks good');
  tree = m.render();
  byText(tree, AO, 'Add comment').props.onClick();
  await tick();
  assert.deepEqual(calls[1], { kind: 'comment', action: 'add', issue: T1, text: 'Looks good' });
});

test('Deny on the Tasks cell hides the forms; Deny on Comments hides the comment box; both say why', () => {
  const { React, AO, M, calls, toast } = rig('allow');
  const tree = mount(React, M, { q: { ...Q, taskWrite: false, commentWrite: false }, toast, mark: () => false }).render();
  assert.equal(byText(tree, AO, 'New task'), undefined);
  assert.equal(sel(tree, AO, 'task-st-' + T1), undefined);
  assert.equal(byText(tree, AO, 'Comment'), undefined);
  assert.match(text(tree), /denies task changes/);
  assert.match(text(tree), /denies comments/);
  assert.equal(calls.length, 0);
});
