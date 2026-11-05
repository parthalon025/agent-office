// The Security room's wall screens (public/security.js, #70): what a screen paints and where its hotspots are, and what a
// click or a key does. The pure part only: no browser, no THREE, no server. Run: node --test test/security-screens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/vocab.js';
import '../public/format.js';
import '../public/security.js';

const P = globalThis.OfficeSecurity.pure;
const SET = '/api/security/set';
const NOT_SET_UP = { reason: 'The office has no provider for this agent kind yet. The rule applies when it has one.', rows: {} };
const enforce = { 'claude-code': { reason: '', rows: { supervise: 'Paperclip is not connected to this office.' } }, hermes: NOT_SET_UP, dsh: NOT_SET_UP, openclaw: NOT_SET_UP, local: { reason: '', rows: {} } };
const B = 'c:/work/repo';
const data = (rules = { office: {}, buildings: {} }, spend = { limit: 2, month: '2026-11', byColumn: { 'claude-code': 1.5 } }) => ({ sec: { rules, enforce, spend }, building: B, buildingName: 'repo' });
const view = (o = {}) => ({ screen: 'files', w: 1280, h: 686, focused: true, paged: false, page: 0, scope: 'office', pending: null, edit: null, hover: null, busy: false, note: null, ...o });
const cell = (p, row, col) => p.hots.find((h) => h.kind === 'cell' && h.row === row && h.col === col);
const hotOf = (p, kind) => p.hots.find((h) => h.kind === kind);
const uvOf = (h, v) => ({ x: (h.x + h.w / 2) / v.w, y: 1 - (h.y + h.h / 2) / v.h });
const texts = (p) => p.items.filter((i) => i.t === 'text').map((i) => i.text);

test('full screen: one cell per row and agent kind, found again from the point the host gives', () => {
  const v = view(), p = P.plan(v, data());
  assert.equal(p.hots.filter((h) => h.kind === 'cell').length, 15, '3 rows x 5 agent kinds');
  for (const [row, col] of [['read-inside', 'claude-code'], ['files-outside', 'local'], ['edit-inside', 'openclaw']]) {
    assert.equal(P.hotAt(p, uvOf(cell(p, row, col), v), v.w, v.h), cell(p, row, col), `${row} ${col}`);
  }
  assert.equal(P.hotAt(p, { x: 0.01, y: 0.99 }, v.w, v.h), null, 'the title is no hotspot');
  const t = texts(p);
  assert.ok(t.includes('Files') && t.includes('Read inside the worktree') && t.includes('Read or edit outside it'));
  assert.ok(t.includes('Allow') && t.includes('Ask'), 'every cell says its value in words');
  assert.ok(t.includes('Not enforced'), 'a cell the office cannot enforce says so');
  assert.ok(t.includes('Not enforced for Hermes, dsh, OpenClaw. The office has no provider for this agent kind yet. The rule applies when it has one.'), 'and why, once for the kinds it is true for');
});

test('a click on Ask paints the Confirm; a second click moves on to Deny; Confirm sends the looser rule', () => {
  const d = data(), v = view(), p = P.plan(v, d), c = cell(p, 'files-outside', 'claude-code');
  const r1 = P.step(v, c, d);
  assert.equal(r1.send, undefined, 'a looser change waits');
  assert.deepEqual(r1.view.pending, { row: 'files-outside', col: 'claude-code', to: 'allow', office: null });
  const p1 = P.plan(r1.view, d);
  assert.ok(texts(p1).includes('Confirm: Allow') && texts(p1).includes('Read or edit outside it, Claude Code'), 'the change, then what it is for');
  assert.ok(texts(p1).includes('Confirm?'), 'the cell itself turns to the Confirm');
  assert.ok(p1.items.some((i) => i.t === 'fill' && i.c === 'pending'), 'amber');
  assert.ok(hotOf(p1, 'confirm') && hotOf(p1, 'cancel'));
  const ok = P.step(r1.view, hotOf(p1, 'confirm'), d);
  assert.deepEqual(ok.send, { route: SET, body: { scope: 'office', row: 'files-outside', col: 'claude-code', value: 'allow', confirmed: true } });
  assert.equal(ok.view.pending, null);
  assert.equal(P.step(r1.view, hotOf(p1, 'cancel'), d).view.pending, null);
  const on = P.step(r1.view, c, d);
  assert.deepEqual(on.send, { route: SET, body: { scope: 'office', row: 'files-outside', col: 'claude-code', value: 'deny' } }, 'Deny applies at once');
});

test('a tightening change goes to the server at once; the Secrets cells cycle Ask and Deny', () => {
  const d = data({ office: { 'secrets|local': 'deny' }, buildings: {} });
  const fv = view(), fp = P.plan(fv, d);
  assert.deepEqual(P.step(fv, cell(fp, 'read-inside', 'local'), d).send.body.value, 'deny', 'Allow to Deny');
  const sv = view({ screen: 'secrets', h: 738 }), sp = P.plan(sv, d);
  assert.equal(P.step(sv, cell(sp, 'secrets', 'claude-code'), d).send.body.value, 'deny');
  assert.equal(P.step(sv, cell(sp, 'secrets', 'local'), d).send.body.value, 'ask');
  assert.ok(texts(sp).includes('Click a cell to change it: Ask or Deny.'));
});

test('This building: a click changes the building rule; Use office rule clears it, with the Confirm when that is looser', () => {
  const d = data({ office: { 'shell|claude-code': 'allow' }, buildings: { [B]: { 'shell|claude-code': 'deny' } } });
  const v = view({ screen: 'commands', scope: 'building' }), p = P.plan(v, d);
  assert.ok(p.items.some((i) => i.t === 'mark'), 'a corner mark on the building rule');
  const c = cell(p, 'shell', 'claude-code');
  assert.deepEqual(P.step(v, c, d).send.body, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'ask' });
  const clear = p.hots.find((h) => h.kind === 'clear');
  const r = P.step(v, clear, d);
  assert.equal(r.send, undefined, 'back to the office Allow is looser');
  assert.deepEqual(r.view.pending, { row: 'shell', col: 'claude-code', to: null, office: 'allow' });
  assert.ok(texts(P.plan(r.view, d)).includes('Confirm: the office rule (Allow)'));
  const ok = P.step(r.view, hotOf(P.plan(r.view, d), 'confirm'), d);
  assert.deepEqual(ok.send.body, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: null, confirmed: true });
  // the scope switch
  const s = P.step(view({ screen: 'commands' }), P.plan(view({ screen: 'commands' }), d).hots.find((h) => h.kind === 'scope' && h.scope === 'building'), d);
  assert.equal(s.view.scope, 'building');
});

test('below 700 px of free view a screen in focus shows one agent kind, with Previous and Next', () => {
  assert.equal(P.PAGED_BELOW, 700);
  const d = data(), v = view({ paged: true }), p = P.plan(v, d);
  assert.equal(p.hots.filter((h) => h.kind === 'cell').length, 3, 'one column');
  assert.ok(texts(p).includes('Claude Code (1 of 5)'));
  const next = P.step(v, hotOf(p, 'next'), d);
  assert.equal(next.view.page, 1);
  assert.ok(texts(P.plan(next.view, d)).includes('Hermes (2 of 5)'));
  assert.ok(texts(P.plan(next.view, d)).includes('Not enforced for this agent'));
  assert.equal(P.step(v, hotOf(p, 'prev'), d).view.page, 4, 'Previous from the first goes to the last');
  // a looser change in the paged view: the row turns to the Confirm
  const r = P.step(v, cell(p, 'files-outside', 'claude-code'), d);
  const pp = P.plan(r.view, d);
  assert.ok(texts(pp).includes('Confirm: Allow'));
  assert.ok(hotOf(pp, 'confirm'));
  // not in focus: the whole grid (the paged view is for reading in focus)
  assert.equal(P.plan(view({ paged: true, focused: false }), d).hots.filter((h) => h.kind === 'cell').length, 15);
});

test('Agents: turning on an ungated agent needs the Confirm; a gated kind has no cell, it says why', () => {
  const d = data(), v = view({ screen: 'agents', h: 738 }), p = P.plan(v, d);
  assert.deepEqual(p.hots.filter((h) => h.kind === 'cell').map((h) => h.id).sort(),
    ['cell:no-cost|dsh', 'cell:no-cost|hermes', 'cell:no-cost|openclaw', 'cell:supervise|claude-code', 'cell:ungated|hermes', 'cell:ungated|openclaw'], 'Hermes is ungated too (M1)');
  assert.ok(texts(p).includes('Gated') && texts(p).includes('Reports cost') && texts(p).includes('Free'));
  const r = P.step(v, cell(p, 'ungated', 'openclaw'), d);
  assert.deepEqual(r.view.pending, { row: 'ungated', col: 'openclaw', to: 'on', office: null });
  assert.equal(P.step(v, cell(p, 'no-cost', 'hermes'), d).send, undefined, 'Ask to Allow on no cost reports is looser too');
  assert.equal(p.hots.some((h) => h.kind === 'scope'), false, 'the Agents rules are office-wide');
  assert.ok(texts(p).includes('Office-wide'));
});

test('Spend: minus and plus in 1 dollar steps, minus never under $1; a click on the value types it; Enter saves, Esc cancels', () => {
  const d = data(), v = view({ screen: 'spend', h: 738 }), p = P.plan(v, d);
  assert.deepEqual(P.step(v, hotOf(p, 'spend-plus'), d).send, { route: '/api/settings/spend', body: { limit: 3 } });
  assert.deepEqual(P.step(v, hotOf(p, 'spend-minus'), d).send.body, { limit: 1 });
  const zero = data(undefined, { limit: 0, month: '2026-11', byColumn: {} });
  assert.equal(P.step(v, hotOf(P.plan(v, zero), 'spend-minus'), zero).send, undefined, 'No limit: minus does nothing');
  assert.deepEqual(P.step(v, hotOf(P.plan(v, zero), 'spend-plus'), zero).send.body, { limit: 1 }, 'plus sets a limit of $1');
  assert.ok(texts(P.plan(v, zero)).includes('No limit'));
  assert.ok(texts(p).includes('$2.00') && texts(p).includes('$1.50') && texts(p).includes('Not set up'), 'the limit and the cost per agent kind');
  assert.ok(texts(p).includes('Cost, November 2026'));
  assert.ok(texts(p).includes('Extensions: local or project scope only. User scope stays out of reach.'));
  assert.deepEqual(p.items.filter((i) => i.t === 'icon').map((i) => i.name), ['remove', 'add'], 'minus and plus are DS icons, not text glyphs');
  let e = P.step(v, hotOf(p, 'spend-edit'), d).view;
  assert.deepEqual(e.edit, { text: '2' });
  e = P.key(e, { key: 'Backspace' }).view;
  e = P.key(e, { key: '7' }).view;
  e = P.key(e, { key: '.' }).view;
  e = P.key(e, { key: '5' }).view;
  assert.ok(texts(P.plan(e, d)).includes('$7.5|'), 'the typed value with a caret');
  assert.equal(P.key(e, { key: 'x' }).taken, true, 'a letter does nothing while typing');
  assert.deepEqual(P.key(e, { key: 'Enter' }).send, { route: '/api/settings/spend', body: { limit: 7.5 } });
  assert.equal(P.key(e, { key: 'Escape' }).view.edit, null);
  assert.equal(P.key(view(), { key: '5' }).taken, false, 'no typing, no keys taken');
  const big = P.key({ ...e, edit: { text: '5000' } }, { key: 'Enter' });
  assert.equal(big.send, undefined);
  assert.match(big.view.note, /from 0 to 1000/);
});

// #70 review: No limit is the loosest spend setting, and paid spend is the owner's one-way door. It never comes from one click.
test('Spend: minus at $1 (or under $1.50) never removes the limit; No limit needs the painted Confirm', () => {
  const v = view({ screen: 'spend', h: 738 });
  for (const limit of [1, 1.4, 0.5]) {
    const d = data(undefined, { limit, month: '2026-11', byColumn: {} });
    const r = P.step(v, hotOf(P.plan(v, d), 'spend-minus'), d);
    assert.ok(!r.send || r.send.body.limit >= 1, `minus at $${limit} sends ${JSON.stringify(r.send)}`);
    if (limit <= 1) { assert.equal(r.send, undefined, `minus at $${limit}`); assert.match(r.view.note, /lowest step is \$1/); }
  }
  const d = data(undefined, { limit: 5, month: '2026-11', byColumn: {} });
  for (const typed of ['0', '']) {
    const e = { ...v, edit: { text: typed } };
    const r = P.key(e, { key: 'Enter' });
    assert.equal(r.send, undefined, `typed "${typed}": nothing is sent yet`);
    assert.deepEqual(r.view.pending, { spend: 0 });
    assert.equal(r.view.edit, null);
    const p = P.plan(r.view, d), t = texts(p);
    assert.ok(t.includes('Confirm: No limit'), t.join(' / '));
    assert.ok(p.items.some((i) => i.c === 'pending'), 'the value turns amber');
    const ok = P.step(r.view, hotOf(p, 'confirm'), d);
    assert.deepEqual(ok.send, { route: '/api/settings/spend', body: { limit: 0, confirmed: true } });
    assert.equal(ok.view.pending, null);
    assert.equal(P.step(r.view, hotOf(p, 'cancel'), d).view.pending, null);
    assert.equal(P.step(r.view, hotOf(p, 'cancel'), d).send, undefined);
  }
  const paged = P.key({ ...v, paged: true, edit: { text: '0' } }, { key: 'Enter' }).view;
  assert.ok(texts(P.plan(paged, d)).includes('Confirm: No limit'), 'the paged view paints it too');
  const already = data(undefined, { limit: 0, month: '2026-11', byColumn: {} });
  assert.equal(P.key({ ...v, edit: { text: '' } }, { key: 'Enter' }, already).view.pending, null, 'No limit again: nothing to confirm');
});

test('an Ask that Claude Code decides by itself says Partly enforced, and why; Deny there says nothing', () => {
  const why = 'The agent asks only when its own allow rules and permission mode say so.';
  const enf = { ...enforce, 'claude-code': { ...enforce['claude-code'], asks: { shell: why } } };
  const d = (rules) => ({ sec: { rules, enforce: enf, spend: {} }, building: B, buildingName: 'repo' });
  const v = view({ screen: 'commands' });
  const t = texts(P.plan(v, d({ office: {}, buildings: {} })));
  assert.ok(t.includes('Partly enforced'), t.join(' / '));
  assert.ok(t.includes('Partly enforced for Claude Code. ' + why));
  const deny = texts(P.plan(v, d({ office: { 'shell|claude-code': 'deny' }, buildings: {} })));
  assert.ok(!deny.includes('Partly enforced'), 'a Deny is enforced');
  const pagedT = texts(P.plan(view({ screen: 'commands', paged: true }), d({ office: {}, buildings: {} })));
  assert.ok(pagedT.includes('Partly enforced for this agent'), pagedT.join(' / '));
});

test('a row where only some calls reach the office says Partly enforced with its reason, whatever the value (Hermes edits outside)', () => {
  const why = 'Edit requests come to the office and the rule applies. Reads, and writes to its own skills and memory, run without asking.';
  const enf = { ...enforce, hermes: { reason: '', rows: {}, asks: {}, partly: { 'files-outside': why } } };
  const d = (rules) => ({ sec: { rules, enforce: enf, spend: {} }, building: B, buildingName: 'repo' });
  const v = view({ screen: 'files' });
  for (const rules of [{ office: {}, buildings: {} }, { office: { 'files-outside|hermes': 'deny' }, buildings: {} }]) {
    const t = texts(P.plan(v, d(rules)));
    assert.ok(t.includes('Partly enforced'), t.join(' / '));
    assert.ok(t.includes('Partly enforced for Hermes. ' + why));
  }
  assert.ok(!texts(P.plan(v, d({ office: {}, buildings: {} }))).some((x) => /^Not enforced for [^.]*Hermes/.test(x)), 'it is not "Not enforced"');
});

test('the outside plate of a right-wall screen shows its title and has no hotspot; a click in flight is ignored', () => {
  const p = P.plan(view({ screen: 'agents', face: 'back' }), data());
  assert.deepEqual(p.hots, []);
  assert.ok(texts(p).includes('Agents'));
  const v = view({ busy: true }), c = cell(P.plan(v, data()), 'shell', 'claude-code') || cell(P.plan(view(), data()), 'read-inside', 'local');
  assert.deepEqual(P.step(v, c, data()), { view: v });
});

// Review B1: a default Ask on a row Claude Code does not ask about by itself forces nothing, so the wall says Partly enforced.
// A click on it sets Ask (the office then makes Claude Code ask, at once: a tightening). Use default takes a set cell back.
test('B1: a default Ask that Claude Code decides says Partly enforced; a click sets it; Use default clears it', () => {
  const why = 'The agent decides until you click the cell: then the office makes it ask.';
  const enf = { ...enforce, 'claude-code': { ...enforce['claude-code'], asks: {}, unset: { 'read-inside': why, 'edit-inside': why } } };
  const d = (office) => ({ sec: { rules: { office, buildings: {} }, enforce: enf, spend: {} }, building: B, buildingName: 'repo' });
  const v = view(), p = P.plan(v, d({}));
  assert.ok(texts(p).includes('Partly enforced for Claude Code. ' + why), texts(p).join(' / '));
  const r = P.step(v, cell(p, 'read-inside', 'claude-code'), d({}));
  assert.deepEqual(r.send, { route: SET, body: { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'ask' } }, 'the same word, now set by the user');
  const setD = d({ 'read-inside|claude-code': 'ask' }), sp = P.plan(v, setD);
  assert.equal(texts(sp).filter((x) => x === 'Partly enforced').length, 1, 'only Edit inside still has its note');
  assert.equal(P.step(v, cell(sp, 'read-inside', 'claude-code'), setD).view.pending.to, 'allow', 'a set Ask cycles on to Allow');
  const use = sp.hots.find((h) => h.kind === 'clear' && h.row === 'read-inside' && h.col === 'claude-code');
  assert.ok(use && texts(sp).includes('Use default'), 'a set cell offers Use default');
  assert.deepEqual(P.step(v, use, setD).send, { route: SET, body: { scope: 'office', row: 'read-inside', col: 'claude-code', value: null } });
  // back to a looser default (the local model's Allow) waits for the Confirm
  const ld = d({ 'read-inside|local': 'ask' }), lp = P.plan(v, ld);
  const lr = P.step(v, lp.hots.find((h) => h.kind === 'clear' && h.col === 'local'), ld);
  assert.equal(lr.send, undefined);
  assert.ok(texts(P.plan(lr.view, ld)).includes('Confirm: the default (Allow)'));
  assert.ok(!P.plan(view({ focused: false }), setD).hots.some((h) => h.kind === 'clear'), 'only in focus');
});

// Review minor: the Spend screen cut "Not reported" off (the five cost columns sat right of the 480 px label column, 142 px
// each). Node has no canvas to measure text, so the check is a safe estimate: 0.62 of the font size per character at 600.
test('Spend: every cost word fits its column, in the full and the paged view', () => {
  const NONE = { reason: '', rows: {} };
  const enf = { 'claude-code': NONE, hermes: NONE, dsh: NONE, openclaw: { reason: 'The office has no provider for this agent kind yet.', rows: {} }, local: NONE };
  const d = { sec: { rules: { office: {}, buildings: {} }, enforce: enf, spend: { limit: 2, month: '2026-11', byColumn: { 'claude-code': 1234.5 } } }, building: B, buildingName: 'repo' };
  const words = /^(Not reported|Not set up|Free|\$[\d,.]+)$/;
  for (const v of [view({ screen: 'spend', h: 686 }), view({ screen: 'spend', h: 738 })]) {
    const items = P.plan(v, d).items.filter((i) => i.t === 'text' && words.test(i.text));
    assert.deepEqual(items.map((i) => i.text).sort(), ['$2.00', '$1234.50', 'Free', 'Not reported', 'Not reported', 'Not set up'].sort(), 'the limit and the five cost words');
    for (const i of items) assert.ok(i.text.length * i.s * 0.62 <= i.maxW, `${i.text} at ${i.s} px needs about ${Math.round(i.text.length * i.s * 0.62)} px, has ${i.maxW}`);
    const labels = P.plan(v, d).items.filter((i) => i.t === 'text' && /^(Claude Code|Hermes|dsh|OpenClaw|Local model)$/.test(i.text));
    for (const i of labels) assert.ok(i.text.length * i.s * 0.62 <= i.maxW, `${i.text} fits`);
  }
  for (let page = 0; page < 5; page++) {
    const t = P.plan(view({ screen: 'spend', h: 1100, paged: true, page }), d).items.find((i) => i.t === 'text' && /: /.test(i.text) && i.s === 44);
    assert.ok(t.text.length * t.s * 0.62 <= t.maxW, `${t.text} fits the paged view`);
  }
});

// Review minor: the paged header had one button that named the current scope, so "This building" was not on the wall while the
// scope was All buildings. Both choices show, as in the full view, and fit at the paged size.
test('paged view: both scope choices are on the wall, the chosen one marked; a click on the other switches', () => {
  for (const scope of ['office', 'building']) {
    const v = view({ screen: 'commands', paged: true, h: 1100, scope }), p = P.plan(v, data());
    const hots = p.hots.filter((h) => h.kind === 'scope');
    assert.deepEqual(hots.map((h) => h.scope).sort(), ['building', 'office']);
    const t = p.items.filter((i) => i.t === 'text' && /^(All buildings|This building)$/.test(i.text));
    assert.deepEqual(t.map((i) => i.text).sort(), ['All buildings', 'This building']);
    for (const i of t) assert.ok(i.text.length * i.s * 0.62 <= i.maxW, i.text + ' fits');
    const other = hots.find((h) => h.scope !== scope);
    assert.equal(P.step(v, other, data()).view.scope, other.scope);
    const title = p.items.find((i) => i.t === 'text' && i.text === 'Commands');
    assert.ok(title.x + title.text.length * title.s * 0.62 < Math.min(...hots.map((h) => h.x)), 'the title does not run under the choices');
  }
});
