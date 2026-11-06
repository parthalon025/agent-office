// The Security room's wall screens (public/security.js, #70): what a screen paints and where its hotspots are, and what a
// click or a key does. The pure part only: no browser, no THREE, no server. Run: node --test test/security-screens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/vocab.mjs';
import '../public/format.js';
import '../public/screen-kit.js';
import '../public/security.js';
import { enforcement } from '../src/security.mjs';
import { AGENTS } from '../src/providers/acp.mjs';
import { createFoundry } from '../src/providers/foundry.mjs';
import { createCopilotStudio } from '../src/providers/copilot-studio.mjs';
import { cloudConfig } from '../src/providers/cloud.mjs';

const P = globalThis.OfficeSecurity.pure;
const SET = 'securitySet';
const NOT_SET_UP = { reason: 'The office has no provider for this agent kind yet. The rule applies when it has one.', rows: {} };
const enforce = { 'claude-code': { reason: '', rows: {} }, hermes: NOT_SET_UP, dsh: NOT_SET_UP, openclaw: NOT_SET_UP, copilot: NOT_SET_UP, local: { reason: '', rows: {} }, 'agent-framework': { reason: '', rows: {} } };
const B = 'c:/work/repo';
const data = (rules = { office: {}, buildings: {} }, spend = { limit: 2, month: '2026-11', byColumn: { 'claude-code': 1.5 } }) => ({ sec: { rules, enforce, spend }, building: B, buildingName: 'repo' });
const view = (o = {}) => ({ screen: 'files', w: 1280, h: 686, focused: true, paged: false, page: 0, scope: 'office', pending: null, edit: null, hover: null, busy: false, note: null, ...o });
const cell = (p, row, col) => p.hots.find((h) => h.kind === 'cell' && h.row === row && h.col === col);
const hotOf = (p, kind) => p.hots.find((h) => h.kind === kind);
const uvOf = (h, v) => ({ x: (h.x + h.w / 2) / v.w, y: 1 - (h.y + h.h / 2) / v.h });
const texts = (p) => p.items.filter((i) => i.t === 'text').map((i) => i.text);
// What a screen says, with the wrapped lines of a reason put back together.
const said = (p) => texts(p).join(' ').replace(/\s+/g, ' ');

test('full screen: one cell per row and agent kind, found again from the point the host gives', () => {
  const v = view(), p = P.plan(v, data());
  assert.equal(p.hots.filter((h) => h.kind === 'cell').length, 21, '3 rows x 7 agent kinds');
  for (const [row, col] of [['read-inside', 'claude-code'], ['files-outside', 'local'], ['edit-inside', 'openclaw']]) {
    assert.equal(P.hotAt(p, uvOf(cell(p, row, col), v), v.w, v.h), cell(p, row, col), `${row} ${col}`);
  }
  assert.equal(P.hotAt(p, { x: 0.01, y: 0.99 }, v.w, v.h), null, 'the title is no hotspot');
  const t = texts(p);
  assert.ok(t.includes('Files') && t.includes('Read inside the worktree') && t.includes('Read or edit outside it'));
  assert.ok(t.includes('Allow') && t.includes('Ask'), 'every cell says its value in words');
  assert.ok(t.includes('Not enforced'), 'a cell the office cannot enforce says so');
  assert.ok(said(p).includes('Not enforced for Hermes, dsh, OpenClaw, Copilot. The office has no provider for this agent kind yet. The rule applies when it has one.'), 'and why, once for the kinds it is true for');
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
  assert.deepEqual(ok.send, { cmd: SET, body: { scope: 'office', row: 'files-outside', col: 'claude-code', value: 'allow', confirmed: true } });
  assert.equal(ok.view.pending, null);
  assert.equal(P.step(r1.view, hotOf(p1, 'cancel'), d).view.pending, null);
  const on = P.step(r1.view, c, d);
  assert.deepEqual(on.send, { cmd: SET, body: { scope: 'office', row: 'files-outside', col: 'claude-code', value: 'deny' } }, 'Deny applies at once');
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
  assert.match(said(P.plan(r.view, d)), /Confirm: Allow every command for Claude Code, high risk too \(rm -rf, git push --force\)\?/, 'back to an office Allow on Shell commands says what Allow means');
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
  assert.ok(texts(p).includes('Claude Code (1 of 8)'));
  const next = P.step(v, hotOf(p, 'next'), d);
  assert.equal(next.view.page, 1);
  assert.ok(texts(P.plan(next.view, d)).includes('Hermes (2 of 8)'));
  assert.ok(texts(P.plan(next.view, d)).includes('Not enforced for this agent'));
  assert.equal(P.step(v, hotOf(p, 'prev'), d).view.page, 7, 'Previous from the first goes to the last');
  // a looser change in the paged view: the row turns to the Confirm
  const r = P.step(v, cell(p, 'files-outside', 'claude-code'), d);
  const pp = P.plan(r.view, d);
  assert.ok(texts(pp).includes('Confirm: Allow'));
  assert.ok(hotOf(pp, 'confirm'));
  // not in focus: the whole grid (the paged view is for reading in focus)
  assert.equal(P.plan(view({ paged: true, focused: false }), d).hots.filter((h) => h.kind === 'cell').length, 21, 'the Cloud agent has no file cells (#24); Copilot has them (#22)');
});

test('Agents: turning on an ungated agent needs the Confirm; a gated kind has no cell, it says why', () => {
  const d = data(), v = view({ screen: 'agents', h: 738 }), p = P.plan(v, d);
  assert.deepEqual(p.hots.filter((h) => h.kind === 'cell').map((h) => h.id).sort(),
    ['cell:no-cost|cloud', 'cell:no-cost|copilot', 'cell:no-cost|dsh', 'cell:no-cost|hermes', 'cell:no-cost|openclaw', 'cell:ungated|cloud', 'cell:ungated|copilot', 'cell:ungated|hermes'], 'Hermes and Copilot are ungated (M1, #22), and the cloud kinds (#24); OpenClaw is gated through its office plugin (#77)');
  assert.ok(texts(p).includes('Gated') && texts(p).includes('Reports cost') && texts(p).includes('Free'));
  const r = P.step(v, cell(p, 'ungated', 'copilot'), d);
  assert.deepEqual(r.view.pending, { row: 'ungated', col: 'copilot', to: 'on', office: null });
  assert.equal(P.step(v, cell(p, 'no-cost', 'hermes'), d).send, undefined, 'Ask to Allow on no cost reports is looser too');
  assert.equal(p.hots.some((h) => h.kind === 'scope'), false, 'the Agents rules are office-wide');
  assert.ok(said(p).includes('Office-wide'), 'the Agents rules say they are office-wide');
  assert.equal(p.hots.some((h) => h.kind === 'cell' && h.row === 'supervise'), false, 'Paperclip agents are listed by name in their own part (#76), not as one cell');
});

test('Spend: minus and plus in 1 dollar steps, minus never under $1; a click on the value types it; Enter saves, Esc cancels', () => {
  const d = data(), v = view({ screen: 'spend', h: 738 }), p = P.plan(v, d);
  assert.deepEqual(P.step(v, hotOf(p, 'spend-plus'), d).send, { cmd: 'settingsSpend', body: { limit: 3 } });
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
  assert.deepEqual(P.key(e, { key: 'Enter' }).send, { cmd: 'settingsSpend', body: { limit: 7.5 } });
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
    assert.deepEqual(ok.send, { cmd: 'settingsSpend', body: { limit: 0, confirmed: true } });
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
  assert.ok(said(P.plan(v, d({ office: {}, buildings: {} }))).includes('Partly enforced for Claude Code. ' + why));
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
    assert.ok(said(P.plan(v, d(rules))).includes('Partly enforced for Hermes. ' + why));
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
  assert.ok(said(p).includes('Partly enforced for Claude Code. ' + why), texts(p).join(' / '));
  const r = P.step(v, cell(p, 'read-inside', 'claude-code'), d({}));
  assert.deepEqual(r.send, { cmd: SET, body: { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'ask' } }, 'the same word, now set by the user');
  const setD = d({ 'read-inside|claude-code': 'ask' }), sp = P.plan(v, setD);
  assert.equal(texts(sp).filter((x) => x === 'Partly enforced').length, 1, 'only Edit inside still has its note');
  assert.equal(P.step(v, cell(sp, 'read-inside', 'claude-code'), setD).view.pending.to, 'allow', 'a set Ask cycles on to Allow');
  const use = sp.hots.find((h) => h.kind === 'clear' && h.row === 'read-inside' && h.col === 'claude-code');
  assert.ok(use && texts(sp).includes('Use default'), 'a set cell offers Use default');
  assert.deepEqual(P.step(v, use, setD).send, { cmd: SET, body: { scope: 'office', row: 'read-inside', col: 'claude-code', value: null } });
  // back to a looser default (the local model's Allow) waits for the Confirm
  const ld = d({ 'read-inside|local': 'ask' }), lp = P.plan(v, ld);
  const lr = P.step(v, lp.hots.find((h) => h.kind === 'clear' && h.col === 'local'), ld);
  assert.equal(lr.send, undefined);
  assert.ok(texts(P.plan(lr.view, ld)).includes('Confirm: the default (Allow)'));
  assert.ok(!P.plan(view({ focused: false }), setD).hots.some((h) => h.kind === 'clear'), 'only in focus');
});

// Review minor: the Spend screen cut "Not reported" off (the cost columns sat right of the 480 px label column, 142 px
// each). Node has no canvas to measure text, so the check is a safe estimate: 0.62 of the font size per character at 600.
test('Spend: every cost word fits its column, in the full and the paged view', () => {
  const NONE = { reason: '', rows: {} };
  const enf = { 'claude-code': NONE, hermes: NONE, dsh: NONE, openclaw: { reason: 'The office has no provider for this agent kind yet.', rows: {} }, copilot: NONE, local: NONE, 'agent-framework': NONE, cloud: NONE };
  const d = { sec: { rules: { office: {}, buildings: {} }, enforce: enf, spend: { limit: 2, month: '2026-11', byColumn: { 'claude-code': 1234.5 } } }, building: B, buildingName: 'repo' };
  const words = /^(Not reported|Not set up|Free|\$[\d,.]+)$/;
  for (const v of [view({ screen: 'spend', h: 686 }), view({ screen: 'spend', h: 738 })]) {
    const items = P.plan(v, d).items.filter((i) => i.t === 'text' && words.test(i.text));
    assert.deepEqual(items.map((i) => i.text).sort(), ['$2.00', '$1234.50', 'Free', 'Free', 'Not reported', 'Not reported', 'Not reported', 'Not reported', 'Not set up'].sort(), 'the limit and the eight cost words: an Agent Framework team is free (#23)');
    for (const i of items) assert.ok(i.text.length * i.s * 0.62 <= i.maxW, `${i.text} at ${i.s} px needs about ${Math.round(i.text.length * i.s * 0.62)} px, has ${i.maxW}`);
    // a head that does not fit one line takes two (Agent / Framework): every word of every kind is painted
    const labels = P.plan(v, d).items.filter((i) => i.t === 'text' && /^(Claude|Code|Hermes|dsh|OpenClaw|Copilot|Local|model|Agent|Framework|Cloud|Claude Code|Copilot|Local model|Agent Framework|Cloud agent)$/.test(i.text));
    const said = labels.map((i) => i.text).join(' ');
    for (const c of globalThis.OfficeVocab.security.columns) for (const w of c.label.split(' ')) assert.ok(said.includes(w), `${w} of ${c.label} has its cost column head`);
    for (const i of labels) assert.ok(i.text.length * i.s * 0.62 <= i.maxW, `${i.text} fits`);
  }
  for (let page = 0; page < 7; page++) {
    const t = P.plan(view({ screen: 'spend', h: 1100, paged: true, page }), d).items.find((i) => i.t === 'text' && /: /.test(i.text) && i.s === 44);
    assert.ok(t.text.length * t.s * 0.62 <= t.maxW, `${t.text} fits the paged view`);
  }
  // #24: a column whose agents all report cost (a cloud kind with its prices set) spent nothing yet: $0.00, not "Not reported".
  const priced = { ...d, sec: { ...d.sec, enforce: { ...enf, cloud: { ...NONE, reports: true } } } };
  const words2 = P.plan(view({ screen: 'spend', h: 738 }), priced).items.filter((i) => i.t === 'text' && words.test(i.text)).map((i) => i.text);
  assert.equal(words2.filter((w) => w === '$0.00').length, 1, 'the Cloud agent column says $0.00');
  // every word of a grid column fits its column at six columns, by the same estimate
  for (const screen of ['files', 'agents', 'network']) {
    for (const i of P.plan(view({ screen, h: 738 }), d).items.filter((x) => x.t === 'text' && x.align === 'center' && x.maxW < 300)) {
      assert.ok(i.text.length * i.s * 0.6 <= i.maxW, `${screen}: "${i.text}" at ${i.s} px fits ${i.maxW}`);
    }
  }
});

// Review minor: the paged header had one button that named the current scope, so "This building" was not on the wall while the
// scope was All buildings. Both choices show, as in the full view, and fit at the paged size.
// #22: with six agent kinds a column is 134 px wide, and "Claude Code" and "Local model" were cut at 24 px. A label that does not
// fit takes two lines (one word each), so every word of every column label is on the wall in full, by the plan's estimate.
test('the column labels of a rules screen fit their column: a long one takes two lines', () => {
  for (const [screen, h] of [['files', 686], ['commands', 686], ['agents', 738]]) {
    const p = P.plan(view({ screen, h }), data());
    const heads = p.items.filter((i) => i.t === 'text' && i.align === 'center' && i.c === 'muted' && i.wt === 600 && i.y < 230);
    const words = heads.map((i) => i.text).join(' ').split(/\s+/);
    for (const c of globalThis.OfficeVocab.security.columns) for (const w of c.label.split(' ')) assert.ok(words.includes(w), `${screen}: "${w}" of ${c.label} is painted`);
    for (const i of heads) assert.ok(i.text.length * P.charW(i.s, 600) <= i.maxW, `${screen}: "${i.text}" at ${i.s} px fits ${i.maxW}`);
    assert.ok(heads.every((i) => !i.text.includes('…')));
  }
});

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

// Review M6: paged mode (one agent kind, big text) went by the free width only. A wide but short free view framed the screen
// small too, so the measure is the width the screen can take: the free width, or the free height times the screen's aspect.
test('M6: paged mode starts on a narrow or a short free view, from the width the screen can take', () => {
  const at = (w, h) => ({ left: 0, top: 0, right: w, bottom: h });
  const aspect = 1280 / 700;
  assert.equal(P.pagedFor(at(1300, 800), aspect), false, 'room for the full grid');
  assert.equal(P.pagedFor(at(600, 800), aspect), true, 'narrow');
  assert.equal(P.pagedFor(at(1300, 300), aspect), true, 'wide but short: the screen is only 549 px wide');
  assert.equal(P.pagedFor(at(1300, 400), aspect), false, '731 px wide');
  assert.equal(P.pagedFor(null, aspect), false, 'not in focus');
});

// Review (re-review 4): a reason must show in full for every cell that is not fully enforced (CLAUDE.md). The plan wraps a reason
// by a safe estimate of the width of a character (P.charW; the screenshots check it against the browser), so a line never
// reaches the paint's ellipsis. The data is what the server sends with the real agent entries: Claude Code (default Ask cells
// it decides), Hermes (Partly and Not enforced), OpenClaw (every call unsupervised, or its config does not carry a rule), and
// the two cloud kinds with no settings (#24: no file cells, MCP partly, the rest not enforced),
// Copilot (Partly and Not enforced, #22).
{
  const cloud = [createFoundry({ events: {}, config: cloudConfig({}, 'OFFICE_FOUNDRY') }), createCopilotStudio({ events: {}, config: cloudConfig({}, 'OFFICE_COPILOTSTUDIO') })];
  const real = (policies) => enforcement([...cloud,
    { kind: 'claude-code' }, { kind: 'ollama', gated: true },
    { kind: 'hermes', gated: false, cost: 'unknown', enforces: AGENTS.hermes.enforces, unenforced: AGENTS.hermes.unenforced, partly: AGENTS.hermes.partly },
    { kind: 'dsh', gated: true, cost: 'unknown' }, { kind: 'openclaw', gated: false, cost: 'unknown', enforces: ['shell'] }, { kind: 'agent-framework', gated: true },
    { kind: 'copilot', gated: false, cost: 'unknown', enforces: AGENTS.copilot.enforces, unenforced: AGENTS.copilot.unenforced, partly: AGENTS.copilot.partly }], policies);
  const gaps = { openclaw: { config: { settings: [
    { path: 'tools.fs.workspaceOnly', have: 'false', ok: false, fix: 'openclaw config set tools.fs.workspaceOnly true', rows: ['files-outside', 'read-inside', 'edit-inside'] },
    { path: 'tools.exec.ask', have: 'off', ok: false, fix: 'openclaw config set tools.exec.ask always', rows: ['shell', 'web'] }] } } };
  const norm = (t) => t.replace(/\s+/g, ' ');
  const SEC = () => globalThis.OfficeVocab.security;
  // [viewport width, paged]: a free width under 700 px pages the screen (PAGED_BELOW)
  const WIDTHS = [[1360, false], [820, false], [400, true]];
  // the screen planes: Files and Commands on the back wall (1280 x 686), the others on the side walls (1280 x 738)
  const SCREENS = [['files', 686], ['commands', 686], ['network', 738], ['secrets', 738]];
  const D = (enf, rules) => ({ sec: { rules: rules || { office: {}, buildings: {} }, enforce: enf, spend: {} }, building: B, buildingName: 'repo' });
  // the reasons a cell shows, from the plan's own rule (noteOf)
  const wanted = (d, screen, scope, col) => {
    const out = [];
    for (const row of SEC().screens.find((x) => x.id === screen).rows) {
      if (!SEC().applies(row, col)) continue;
      const n = P.noteOf(d, scope, row, col);
      if (n) out.push(n);
    }
    return out;
  };

  for (const [name, enf] of [['defaults', real()], ['with the OpenClaw config gaps', real(gaps)]]) {
    test(`every reason of a cell that is not fully enforced is painted in full, at 1360, 820 and 400 px (${name})`, () => {
      const cols = SEC().columns.map((c) => c.id);
      let checked = 0;
      for (const [width, paged] of WIDTHS) {
        for (const [screen, h] of SCREENS) {
          for (const scope of ['office', 'building']) {
            const d = D(enf);
            for (const page of paged ? cols : [null]) {
              const v = view({ screen, h, paged, page: paged ? cols.indexOf(page) : 0, scope }), p = P.plan(v, d), said_ = norm(texts(p).join(' '));
              for (const col of paged ? [page] : cols) for (const n of wanted(d, screen, scope, col)) {
                assert.ok(said_.includes(norm(n.why)), `${width} px, ${screen}, ${scope}, ${col}: "${n.why}" is not painted in full`);
                checked++;
              }
              // every line fits its width by the plan's own estimate, and stays on the screen
              for (const i of p.items.filter((x) => x.t === 'text' && x.maxW >= 600)) {
                if (i.align === 'center' || i.mono) continue;
                const need = i.text.length * P.charW(i.s, i.wt);
                assert.ok(need <= i.maxW + 0.5, `${width} px, ${screen}: "${i.text}" at ${i.s} px needs ${Math.round(need)} px, has ${i.maxW}`);
                assert.ok(i.y <= h && i.y > 0, `${screen}: "${i.text}" is on the screen`);
              }
            }
          }
        }
      }
      assert.ok(checked > 40, 'the check looked at the reasons: ' + checked);
    });
  }

  test('the reasons sit below the grid and above the hint; Files takes the compact layout for them', () => {
    const d = D(real(gaps));
    for (const scope of ['office', 'building']) {
      const v = view({ screen: 'files', h: 686, scope }), p = P.plan(v, d), lay = P.levelFor(v, d);
      assert.equal(lay.L.fs, 18, 'five agent kinds and their reasons need the smaller type: ' + lay.lines.length + ' lines');
      const firstTop = lay.first - lay.L.fs * 0.8;
      assert.ok(firstTop >= lay.end, `the reasons start (${Math.round(firstTop)}) under the grid (${lay.end})`);
      const last = lay.first + (lay.lines.length - 1) * lay.L.lh;
      assert.ok(last < lay.hintTop - lay.L.hint * 0.8, 'and end above the hint');
      const rowBottom = Math.max(...p.hots.filter((h) => h.kind === 'cell').map((h) => h.y + h.h));
      assert.ok(rowBottom <= lay.end, 'no cell reaches into them');
    }
    // a screen with few reasons keeps the roomy layout
    assert.equal(P.levelFor(view({ screen: 'commands', h: 686 }), D(real())).L.fs, 21);
    assert.equal(P.levelFor(view({ screen: 'secrets', h: 738 }), D(real())).L.fs, 21);
  });

  test('the paged Spend screen wraps the Extensions line and the hint, none of it cut', () => {
    for (const edit of [null, { text: '7' }]) for (const note of [null, 'The spend limit is a number from 0 to 1000. 0 means no limit.']) {
      const v = view({ screen: 'spend', h: 738, paged: true, edit, note }), p = P.plan(v, D(real()));
      assert.match(norm(texts(p).join(' ')), /Extensions: local or project scope only\. User scope stays out of reach\./);
      for (const i of p.items.filter((x) => x.t === 'text' && x.maxW >= 1000)) assert.ok(i.text.length * P.charW(i.s, i.wt) <= i.maxW, `"${i.text}" fits`);
    }
  });
}

// Review (re-review 5): the check before a hold ignores the risk rating (security.mjs decide), so an Allow on Shell commands
// approves rm -rf and git push --force too. The painted Confirm says it, in the full and in the paged view.
test('Allow on Shell commands paints a Confirm that names high risk commands, in the full and the paged view', () => {
  const asked = data({ office: { 'shell|claude-code': 'ask' }, buildings: {} });   // a cell the user set to Ask: the next value is Allow
  const full = view({ screen: 'commands' });
  const r = P.step(full, cell(P.plan(full, asked), 'shell', 'claude-code'), asked);
  assert.equal(r.send, undefined, 'a looser change waits');
  assert.deepEqual(r.view.pending, { row: 'shell', col: 'claude-code', to: 'allow', office: null });
  const want = /Confirm: Allow every command for Claude Code, high risk too \(rm -rf, git push --force\)\?/;
  assert.match(said(P.plan(r.view, asked)), want, 'full view');
  const pv = { ...r.view, paged: true, h: 686, page: 0 }, pp = P.plan(pv, asked);
  assert.match(said(pp), want, 'paged view');
  assert.ok(hotOf(pp, 'confirm') && hotOf(pp, 'cancel'), 'with its Confirm and Cancel');
  for (const plan of [P.plan(r.view, asked), pp]) for (const i of plan.items.filter((x) => x.t === 'text' && x.maxW && x.align !== 'center')) assert.ok(i.text.length * P.charW(i.s, i.wt) <= i.maxW + 0.5, `"${i.text}" fits`);
  assert.equal(P.step(pv, hotOf(pp, 'confirm'), asked).send.body.value, 'allow');
  // other rows keep the short Confirm
  const files = view({ screen: 'files' }), d = data(), fr = P.step(files, cell(P.plan(files, d), 'files-outside', 'claude-code'), d);
  assert.ok(texts(P.plan(fr.view, d)).includes('Confirm: Allow'));
});

// #23: a sixth agent kind (Agent Framework) makes the grid columns narrower. A column head that does not fit on one line takes
// two, never the paint's ellipsis, and stays between the subtitle and the first row line, in both layouts.
test('every column head of a rules screen is painted in full: a long one takes two lines above the grid', () => {
  const heads = (p) => p.items.filter((i) => i.t === 'text' && i.c === 'muted' && i.wt === 600 && i.align === 'center' && i.s <= 24);
  for (const [screen, h] of [['files', 686], ['commands', 686], ['network', 738], ['secrets', 738], ['agents', 738]]) {
    for (const scope of ['office', 'building']) {
      const v = view({ screen, h, scope }), d = data(), p = P.plan(v, d), L = P.levelFor(v, d).L;
      const said_ = heads(p).map((i) => i.text).join(' ');
      for (const c of globalThis.OfficeVocab.security.columns) assert.ok(said_.includes(c.label.split(' ')[0]), `${screen}: ${c.label} has its head`);
      assert.match(said_, /Agent Framework/);
      for (const i of heads(p)) {
        assert.ok(i.text.length * P.charW(i.s, i.wt) <= i.maxW + 0.5, `${screen}: "${i.text}" at ${i.s} px needs ${Math.round(i.text.length * P.charW(i.s, i.wt))} px, has ${i.maxW}`);
        assert.ok(i.y - i.s * 0.8 > L.sub + 6, `${screen}: "${i.text}" sits under the subtitle`);
        assert.ok(i.y + i.s * 0.25 < L.y0 + 52, `${screen}: "${i.text}" sits above the first row line`);
      }
    }
  }
});

// #76: the Paperclip part of the Agents screen. Each agent of the watched company, by name, with its supervision and, when the
// office can set it up, Supervise in office: a click paints the Confirm, Confirm sends one change for one agent.
const HQ = { state: 'on', url: 'http://127.0.0.1:3100', error: '', company: { id: 'c1', name: 'Acme Robotics' }, budget: { spent: 12.4, limit: 100 }, routines: [], agents: [
  { id: 'a1', name: 'Grace', role: 'CEO', title: '', supervision: { state: 'unsupervised', label: 'Unsupervised', why: 'It runs on the ACP engine (the default), which approves every call and ignores the office hooks.', can: true } },
  { id: 'a2', name: 'Ada', role: 'Engineer', title: 'Backend engineer', supervision: { state: 'supervised', label: '', why: '', can: false } },
  { id: 'a3', name: 'Linus', role: 'DevOps', title: '', supervision: { state: 'unsupervised', label: 'Unsupervised: runs without the office hooks', why: 'Its runs use codex_local, not Claude Code, so they never reach the office hooks.', can: false } },
] };
const withHq = (hq = HQ) => ({ ...data(), hq });
const hqView = (o = {}) => view({ screen: 'agents', h: 738, section: 'hq', ...o });

test('Agents, Paperclip part: two parts in the header; not connected says where to connect; no Supervise without agents', () => {
  const v = view({ screen: 'agents', h: 738 }), p = P.plan(v, withHq());
  const sec = p.hots.filter((h) => h.kind === 'section');
  assert.deepEqual(sec.map((h) => h.section), ['kinds', 'hq']);
  assert.ok(texts(p).includes('Agent kinds') && texts(p).includes('Paperclip'));
  assert.equal(P.step(v, sec[1], withHq()).view.section, 'hq');
  const off = P.plan(hqView(), { ...data(), hq: null });
  assert.match(said(off), /Paperclip is not connected\. Connect it in Attach sessions/);
  assert.equal(off.hots.some((h) => h.kind === 'supervise'), false);
  assert.equal(off.hots.some((h) => h.kind === 'cell'), false, 'the kinds grid is the other part');
});

test('Agents, Paperclip part: each agent with its state in words; Supervise in office waits for the Confirm, then one change for one agent', () => {
  const d = withHq(), v = hqView(), p = P.plan(v, d);
  const t = said(p);
  for (const w of ['Grace', 'Ada', 'Linus', 'Backend engineer', 'Supervised', 'Unsupervised', 'Watching Acme Robotics at http://127.0.0.1:3100']) assert.ok(t.includes(w), w);
  assert.match(t, /codex_local, not Claude Code/, 'why an agent is not supervised, on the wall');
  const sup = p.hots.filter((h) => h.kind === 'supervise');
  assert.deepEqual(sup.map((h) => h.agent), ['a1'], 'only the agent the office can set up: not the supervised one, not the codex one');
  assert.equal(P.hotAt(p, uvOf(sup[0], v), v.w, v.h), sup[0]);
  const r = P.step(v, sup[0], d);
  assert.equal(r.send, undefined, 'a write to Paperclip waits for the painted Confirm');
  assert.deepEqual(r.view.pending, { hq: 'a1', name: 'Grace' });
  const pp = P.plan(r.view, d);
  assert.ok(texts(pp).includes('Confirm: Supervise Grace in office?'));
  assert.match(said(pp), /The office writes to its config in Paperclip: engine cli, skip permissions off, permission mode default and the office hooks file/);
  assert.ok(pp.items.some((i) => i.t === 'fill' && i.c === 'pending'), 'amber');
  assert.equal(pp.hots.some((h) => h.kind === 'supervise'), false, 'no second click starts another write while one waits');
  assert.deepEqual(P.step(r.view, hotOf(pp, 'confirm'), d).send, { cmd: 'paperclipSupervise', body: { agent: 'a1', confirmed: true } });
  assert.equal(P.step(r.view, hotOf(pp, 'cancel'), d).view.pending, null);
  for (const i of p.items.filter((x) => x.t === 'text' && x.maxW && x.align !== 'center')) assert.ok(i.text.length * P.charW(i.s, i.wt) <= i.maxW + 0.5 || i.text.endsWith('…'), `"${i.text}" fits`);
});

test('Agents, Paperclip part: many agents page in the full view; the narrow view shows one agent at a time with its Supervise', () => {
  const many = { ...HQ, agents: Array.from({ length: 9 }, (_, i) => ({ ...HQ.agents[0], id: 'g' + i, name: 'Agent ' + (i + 1) })) };
  const d = withHq(many), v = hqView(), p = P.plan(v, d);
  assert.ok(hotOf(p, 'hq-next') && hotOf(p, 'hq-prev'));
  const shown = p.hots.filter((h) => h.kind === 'supervise').length;
  assert.ok(shown >= 3 && shown < 9, `${shown} rows on the first page`);
  assert.match(said(p), new RegExp(`Agents 1 to ${shown} of 9`));
  const p2 = P.plan(P.step(v, hotOf(p, 'hq-next'), d).view, d);
  assert.equal(p2.hots.filter((h) => h.kind === 'supervise')[0].agent, 'g' + shown);
  for (const h of p.hots) assert.ok(h.y + h.h <= v.h - 40, `${h.id} sits above the hint`);
  // narrow: one agent, big, with Previous and Next
  const nv = hqView({ paged: true }), np = P.plan(nv, withHq());
  assert.deepEqual(np.hots.filter((h) => h.kind === 'supervise').map((h) => h.agent), ['a1']);
  assert.ok(texts(np).includes('1 of 3') && hotOf(np, 'hq-next'));
  const n2 = P.plan(P.step(nv, hotOf(np, 'hq-next'), withHq()).view, withHq());
  assert.ok(texts(n2).includes('Ada') && texts(n2).includes('2 of 3'));
  assert.equal(n2.hots.some((h) => h.kind === 'supervise'), false, 'Ada is supervised: nothing to set up');
});
