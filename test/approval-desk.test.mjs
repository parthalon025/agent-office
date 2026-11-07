// Paperclip approval controls (#225): Needs you and the HQ lobby decide a waiting approval through hq.write.
// The first click sends no confirmed flag. The Approvals cell's 409 is the painted Confirm. A render sends nothing.
// A task row stays a link. No DOM, no browser, no Paperclip.
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
const buttons = (tree, AO) => all(tree).filter((e) => e.type === AO.Button);
const byText = (tree, AO, label) => buttons(tree, AO).find((e) => text(e) === label);
// The painted Confirm is ConfirmBar, one component under the row. Render it to reach its buttons.
function confirmBar(tree, React) {
  const bar = all(tree).find((e) => e.type && e.type.name === 'ConfirmBar');
  return bar ? mount(React, bar.type, bar.props).render() : null;
}

const ID = 'p1000000-0000-4000-8000-000000000001';

function askErr(action) {
  const e = new Error('Approve an approval in Acme? The office sends this one change to Paperclip and nothing else.');
  e.status = 409;
  e.body = { error: e.message, confirm: 'write', write: { kind: 'approval', action, summary: 'Approve an approval' } };
  return e;
}

function rig() {
  const { React, AO, sb } = loadBundle();
  const calls = [], toasts = [];
  let mode = 'ask';
  const client = {
    hqWrite(body) {
      calls.push(JSON.parse(JSON.stringify(body)));
      if (mode === 'ask' && body.confirmed !== true) return Promise.reject(askErr(body.action));
      if (mode === 'deny') return Promise.reject(Object.assign(new Error('Denied by the HQ write grid: Approvals.'), { status: 403, body: { error: 'Denied by the HQ write grid: Approvals.' } }));
      if (mode === 'stale') return Promise.reject(Object.assign(new Error('This approval is not waiting for a decision.'), { status: 409, body: { error: 'This approval is not waiting for a decision.' } }));
      if (mode === 'fail') return Promise.reject(Object.assign(new Error('Paperclip did not answer.'), { status: 502, body: { error: 'Paperclip did not answer.' } }));
      return Promise.resolve({ ok: true });
    },
    get() { return Promise.resolve({}); },
    send(name, body) { if (name === 'hqWrite') return client.hqWrite(body); return Promise.resolve({}); },
  };
  const Stub = () => null;
  sb.OfficePage = {
    Tag: (p) => React.createElement('span', null, p.children), ago: () => 'just now', client, clip: (s) => s,
    plural: (n, a, b) => n + ' ' + (n === 1 ? a : b), refocusRow() {}, sceneName: (s) => s.name,
    useSnapshot: () => sb.snap, Merge: { use: () => ({ busy: '', node: null, start() {} }), Row: Stub },
  };
  sb.snap = { hq: { approvalWrite: true, company: { name: 'Acme' } } };
  sb.officeAdapter = { queue: () => ({ items: sb.items }) };
  sb.items = [];
  vm.runInContext(src('public/vocab.js'), sb, { filename: 'vocab.js' });
  vm.runInContext(src('public/ask.js'), sb, { filename: 'ask.js' });
  vm.runInContext(src('public/hq.js'), sb, { filename: 'hq.js' });
  vm.runInContext(src('public/needs.js'), sb, { filename: 'needs.js' });
  return { React, AO, sb, calls, toasts, Decide: sb.OfficePage.Hq.ApprovalDecide, Needs: sb.OfficePage.Needs, setMode: (m) => { mode = m; }, toast: (t) => toasts.push(t) };
}

test('hq.js loads before needs.js, so Needs you can use ApprovalDecide', () => {
  const html = src('public/index.html');
  assert.ok(html.indexOf('/hq.js"') < html.indexOf('/needs.js"'));
});

test('a render sends nothing; Confirm is a second click with the same body', async () => {
  const { React, AO, Decide, calls, toasts, toast } = rig();
  const m = mount(React, Decide, { id: ID, write: true, toast, place: 'lobby' });
  let tree = m.render();
  assert.equal(calls.length, 0, 'render sends nothing');
  tree = m.render();
  assert.equal(calls.length, 0, 'a second render sends nothing');
  assert.ok(byText(tree, AO, 'Approve'));
  assert.ok(byText(tree, AO, 'Reject'));
  assert.ok(byText(tree, AO, 'Request revision'));
  const input = all(tree).find((e) => e.type === AO.TextInput);
  input.props.onChange('Add a budget.');
  tree = m.render();
  byText(tree, AO, 'Approve').props.onClick();
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { kind: 'approval', action: 'approve', approval: ID, note: 'Add a budget.' });
  assert.equal(calls[0].confirmed, undefined, 'the first click does not confirm');
  tree = m.render();
  const bar = confirmBar(tree, React);
  assert.ok(bar, 'the Approvals cell question is the painted Confirm');
  const confirm = buttons(bar, AO).find((e) => text(e).startsWith('Confirm:'));
  assert.ok(confirm);
  assert.match(text(confirm), /Approve an approval in Acme/);
  assert.equal(byText(tree, AO, 'Approve'), undefined, 'the decision waits for Confirm');
  confirm.props.onClick();
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { kind: 'approval', action: 'approve', approval: ID, note: 'Add a budget.', confirmed: true });
  assert.equal(toasts.at(-1).title, 'Approval sent');
  tree = m.render();
  assert.ok(byText(tree, AO, 'Approve'), 'the row stays until Paperclip drops it');
  assert.equal(calls.length, 2, 'showing the row again sends nothing');
});

test('Cancel sends nothing more, and a 409 that is not the ask is an error', async () => {
  const { React, AO, Decide, calls, toasts, toast, setMode } = rig();
  const m = mount(React, Decide, { id: ID, write: true, toast, place: 'needs' });
  let tree = m.render();
  byText(tree, AO, 'Reject').props.onClick();
  await tick();
  tree = m.render();
  const bar = confirmBar(tree, React);
  assert.ok(bar, 'Reject waits for the painted Confirm');
  const cancel = byText(bar, AO, 'Cancel');
  assert.ok(cancel);
  cancel.props.onClick();
  tree = m.render();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'reject');
  assert.equal(calls[0].confirmed, undefined);
  assert.ok(byText(tree, AO, 'Reject'), 'Cancel returns the three decisions');
  setMode('stale');
  byText(tree, AO, 'Request revision').props.onClick();
  await tick();
  tree = m.render();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'revise');
  assert.equal(calls[1].confirmed, undefined);
  assert.equal(toasts.at(-1).tone, 'error');
  assert.match(text(tree), /not waiting for a decision/);
  assert.equal(confirmBar(tree, React), null, 'a stale approval is not a Confirm');
});

test('Deny shows the reason and sends nothing; a bad id sends nothing', async () => {
  const { React, AO, Decide, calls, toast } = rig();
  const denied = mount(React, Decide, { id: ID, write: false, toast, place: 'lobby' });
  let tree = denied.render();
  assert.match(text(tree), /denies approvals/);
  assert.equal(buttons(tree, AO).length, 0);
  assert.equal(calls.length, 0);
  const bad = mount(React, Decide, { id: 'approval:' + ID, write: true, toast, place: 'lobby' });
  tree = bad.render();
  assert.match(text(tree), /cannot be decided here/);
  assert.equal(calls.length, 0);
});

test('Allow sends on the first click; a failed send shows the error and does not confirm', async () => {
  const { React, AO, Decide, calls, toasts, toast, setMode } = rig();
  setMode('allow');
  const m = mount(React, Decide, { id: ID, write: true, toast, place: 'lobby' });
  let tree = m.render();
  byText(tree, AO, 'Approve').props.onClick();
  await tick();
  assert.deepEqual(calls, [{ kind: 'approval', action: 'approve', approval: ID }]);
  assert.equal(toasts[0].title, 'Approval sent');
  setMode('fail');
  tree = m.render();
  byText(tree, AO, 'Reject').props.onClick();
  await tick();
  tree = m.render();
  assert.equal(calls.at(-1).confirmed, undefined);
  assert.equal(toasts.at(-1).tone, 'error');
  assert.match(text(tree), /did not answer/);
  assert.equal(confirmBar(tree, React), null, 'a failed send is not a Confirm');
});

test('a double click sends one request, and a late answer for another approval does not confirm it', async () => {
  const rigged = rig();
  const gates = [];
  rigged.sb.OfficePage.client.hqWrite = (body) => {
    rigged.calls.push(JSON.parse(JSON.stringify(body)));
    return new Promise((resolve) => { gates.push(resolve); });
  };
  const m = mount(rigged.React, rigged.Decide, { id: ID, write: true, toast: rigged.toast, place: 'lobby' });
  const tree = m.render();
  byText(tree, rigged.AO, 'Approve').props.onClick();
  byText(tree, rigged.AO, 'Approve').props.onClick();
  assert.equal(rigged.calls.length, 1, 'the second click waits');
  const tree2 = m.render({ id: 'p2', write: true, toast: rigged.toast, place: 'lobby' });
  byText(tree2, rigged.AO, 'Approve').props.onClick();
  assert.equal(rigged.calls.length, 2, 'the approval now on screen can be decided while the old request is in flight');
  assert.equal(rigged.calls[1].approval, 'p2');
  assert.equal(rigged.calls[1].confirmed, undefined);
  byText(tree2, rigged.AO, 'Reject').props.onClick();
  assert.equal(rigged.calls.length, 2, 'the new approval still ignores a second click');
  gates[0]({ ok: true });
  await tick();
  assert.equal(rigged.toasts.length, 0, 'the answer was for the approval that left');
  assert.equal(rigged.calls.length, 2);
  assert.equal(rigged.calls[0].confirmed, undefined);
  assert.equal(rigged.calls[1].approval, 'p2');
});

test('Needs you decides an approval and leaves a task as a link', async () => {
  const { React, AO, sb, Needs, calls, toast } = rig();
  sb.items = [
    { id: 'hq:approval:' + ID, kind: 'paperclip', item: 'approval', approval: ID, text: 'Approval from Grace: hire agent', buildingName: 'Acme', roomName: 'Approval', t: 5, bot: 'Paperclip' },
    { id: 'hq:issue:i1', kind: 'paperclip', item: 'issue', approval: null, text: 'Task for you: ACM-1 Plan', buildingName: 'Acme', roomName: 'Task', t: 9, bot: 'Paperclip' },
  ];
  const opened = [];
  const dialog = mount(React, Needs.Dialog, { onClose() {}, onHq: () => opened.push('hq'), onManager() {}, onGo() {}, toast });
  let tree = dialog.render();
  const list = all(tree).find((e) => e.props && e.props.onHq && e.type !== AO.Dialog);
  const rows = mount(React, list.type, list.props);
  tree = rows.render();
  assert.equal(calls.length, 0, 'the list sends nothing when it renders');
  const decide = all(tree).find((e) => e.type === sb.OfficePage.Hq.ApprovalDecide);
  assert.equal(decide.props.id, ID);
  assert.equal(decide.props.write, true);
  const task = all(tree).filter((e) => e.type === 'li').find((e) => text(e).includes('Task for you'));
  assert.ok(task);
  assert.equal(all(task).some((e) => e.type === sb.OfficePage.Hq.ApprovalDecide), false);
  assert.match(text(task), /Decide it in Paperclip/);
  assert.ok(byText(task, AO, 'Open Paperclip HQ'));
  const part = mount(React, decide.type, decide.props);
  part.render();
  assert.equal(calls.length, 0);
  byText(part.render(), AO, 'Approve').props.onClick();
  await tick();
  assert.equal(calls[0].approval, ID);
  assert.equal(calls[0].confirmed, undefined);
});

test('Deny on the snapshot hides the decision and keeps the task link', () => {
  const { React, AO, sb, Needs } = rig();
  sb.snap = { hq: { approvalWrite: false, company: { name: 'Acme' } } };
  sb.items = [{ id: 'hq:approval:' + ID, kind: 'paperclip', item: 'approval', approval: ID, text: 'Approval from Grace: hire agent', buildingName: 'Acme', roomName: 'Approval', t: 5, bot: 'Paperclip' }];
  const dialog = mount(React, Needs.Dialog, { onClose() {}, onHq() {}, onManager() {}, onGo() {}, toast() {} });
  const tree = dialog.render();
  const list = all(tree).find((e) => e.props && e.props.onHq && e.type !== AO.Dialog);
  const rows = mount(React, list.type, list.props).render();
  const decide = all(rows).find((e) => e.type === sb.OfficePage.Hq.ApprovalDecide);
  assert.equal(decide.props.write, false);
  const part = mount(React, decide.type, decide.props).render();
  assert.match(text(part), /denies approvals/);
  assert.equal(all(part).some((e) => e.type === AO.Button), false);
});

test('the HQ lobby uses the same decision part and sends nothing on render', () => {
  const { React, sb, calls } = rig();
  const q = {
    company: { name: 'Acme' }, approvalWrite: true, agents: [], routines: [],
    lobby: { employees: { total: 0, working: 0, paused: 0, error: 0, unsupervised: 0 }, tasks: { open: 0, inProgress: 0, blocked: 0 }, approvals: { pending: 1, items: [{ id: ID, kind: 'hire_agent', by: 'Grace' }] }, goals: { total: 0, items: [] }, spend: null, activity: [] },
  };
  const dialog = mount(React, sb.OfficePage.Hq.Hq, { snap: { hq: q }, onClose() {}, onAttach() {}, toast() {} });
  const tree = dialog.render();
  assert.equal(calls.length, 0);
  const lobby = all(tree).find((e) => e.props && e.props.q === q);
  const lobbyTree = mount(React, lobby.type, lobby.props).render();
  const decide = all(lobbyTree).find((e) => e.type === sb.OfficePage.Hq.ApprovalDecide);
  assert.equal(decide.props.id, ID);
  assert.equal(decide.props.write, true);
  assert.match(text(lobbyTree), /hire agent/);
  assert.match(text(lobbyTree), /Decide them here/);
});
