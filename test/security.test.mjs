// Security room rules (security.mjs, #70): pure, no server, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanRules, setRule, decide, permissionModeFor, openRefusal, enforcement, preToolDecision, addCost, costThisMonth } from '../security.mjs';

const WIN = process.platform === 'win32';
const root = WIN ? 'C:\\work\\repo' : '/work/repo';
const inside = path.join(root, 'src', 'a.js');
const outside = WIN ? 'C:\\Windows\\win.ini' : '/etc/hosts';
const B = 'c:\\work\\repo';
const none = () => cleanRules(null);
const call = (tool, input, extra = {}) => ({ building: B, kind: 'claude-code', tool, input, root, ...extra });
const status = (fn) => { try { fn(); } catch (e) { return [e.status, e.message]; } return null; };

test('cleanRules keeps only cells the grid has, with values the row offers', () => {
  const r = cleanRules({ office: { 'shell|claude-code': 'deny', 'secrets|local': 'allow', 'nope|local': 'ask', 'shell|nobody': 'ask' },
    buildings: { [B]: { 'web|local': 'allow', 'ungated|openclaw': 'on' }, bad: 'x' } });
  assert.deepEqual(r, { office: { 'shell|claude-code': 'deny' }, buildings: { [B]: { 'web|local': 'allow' } } });
  assert.deepEqual(none(), { office: {}, buildings: {} });
});

test('setRule: a tightening change applies at once; a looser one needs the painted Confirm', () => {
  let r = setRule(none(), { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(r.office['shell|claude-code'], 'deny');
  assert.deepEqual(status(() => setRule(r, { scope: 'office', row: 'shell', col: 'claude-code', value: 'allow' })), [409, 'Confirm the looser rule on the wall first.']);
  r = setRule(r, { scope: 'office', row: 'shell', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.equal(r.office['shell|claude-code'], 'allow');
  r = setRule(r, { scope: 'office', row: 'shell', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(r.office['shell|claude-code'], undefined, 'the default is not stored');
});

test('setRule: the Secrets cells never take Allow, even with a confirm', () => {
  for (const row of ['secrets', 'settings']) {
    const e = status(() => setRule(none(), { scope: 'office', row, col: 'claude-code', value: 'allow', confirmed: true }));
    assert.equal(e[0], 400, row);
    assert.match(e[1], /only Ask or Deny/);
  }
});

test('setRule: unknown rows, agent kinds and values are refused; the Agents rows are office-wide', () => {
  assert.equal(status(() => setRule(none(), { scope: 'office', row: 'x', col: 'local', value: 'ask' }))[0], 400);
  assert.equal(status(() => setRule(none(), { scope: 'office', row: 'shell', col: 'x', value: 'ask' }))[0], 400);
  assert.equal(status(() => setRule(none(), { scope: 'office', row: 'shell', col: 'local', value: 'maybe' }))[0], 400);
  assert.equal(status(() => setRule(none(), { scope: 'office', row: 'ungated', col: 'claude-code', value: 'on', confirmed: true }))[0], 400, 'Claude Code is gated: no such cell');
  assert.equal(status(() => setRule(none(), { scope: 'building', building: B, row: 'ungated', col: 'openclaw', value: 'on', confirmed: true }))[0], 400);
  assert.equal(status(() => setRule(none(), { scope: 'elsewhere', row: 'shell', col: 'local', value: 'ask' }))[0], 400);
  assert.equal(setRule(none(), { scope: 'office', row: 'ungated', col: 'openclaw', value: 'on', confirmed: true }).rules.office['ungated|openclaw'], 'on');
});

test('setRule: a building override, and clearing it (a clear that loosens needs the confirm too)', () => {
  let r = setRule(none(), { scope: 'building', building: B, row: 'shell', col: 'local', value: 'deny' }).rules;
  assert.equal(r.buildings[B]['shell|local'], 'deny');
  assert.equal(r.office['shell|local'], undefined);
  r = setRule(r, { scope: 'building', building: B, row: 'shell', col: 'local', value: null }).rules;
  assert.equal(r.buildings[B], undefined, 'an empty override map goes');
  r = setRule(r, { scope: 'office', row: 'shell', col: 'local', value: 'allow', confirmed: true }).rules;
  r = setRule(r, { scope: 'building', building: B, row: 'shell', col: 'local', value: 'ask' }).rules;
  assert.equal(status(() => setRule(r, { scope: 'building', building: B, row: 'shell', col: 'local', value: null }))[0], 409, 'back to the office Allow is looser');
  assert.equal(status(() => setRule(r, { scope: 'building', row: 'shell', col: 'local', value: 'ask' }))[0], 400, 'a building scope needs its building');
});

test('decide: Allow answers, Deny refuses, Ask holds, with the feed line', () => {
  let r = none();
  const allow = decide(r, call('Edit', { file_path: inside }));
  assert.deepEqual([allow.allow, allow.line], [true, 'allowed by Security: Edit inside the worktree']);
  assert.equal(decide(r, call('Bash', { command: 'npm test' })), null, 'Ask holds as today');
  r = setRule(r, { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  const deny = decide(r, call('Bash', { command: 'npm test' }));
  assert.deepEqual([deny.allow, deny.line, deny.message], [false, 'denied by Security: Shell commands', 'Denied by the Security room: Shell commands.']);
  assert.equal(decide(r, call('Bash', { command: 'npm test' }, { kind: 'ollama' })), null, 'the rule is per agent kind');
  assert.equal(decide(r, call('Task', { prompt: 'x' })), null, 'a call with no row keeps today\'s hold');
  assert.equal(decide(r, call('Bash', { command: 'x' }, { kind: 'unknown-kind' })), null, 'an agent kind with no column keeps today\'s hold');
});

test('decide: the per-building override applies only in its building', () => {
  const r = setRule(none(), { scope: 'building', building: B, row: 'files-outside', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(decide(r, call('Read', { file_path: outside })).allow, false);
  assert.equal(decide(r, call('Read', { file_path: outside }, { building: 'c:\\other' })), null);
  assert.equal(decide(r, call('Read', { file_path: outside }, { building: null })), null, 'a session not placed yet: the office-wide rule');
});

test('decide: a provider asks about every call; a low call it may run is allowed without a feed line', () => {
  const r = none();
  assert.equal(decide(r, call('Read', { file_path: inside }, { kind: 'ollama', provider: true })).quiet, true);
  assert.equal(decide(r, call('Read', { file_path: inside }, { kind: 'claude-code' })).quiet, false, 'Claude Code asked: the answer is news');
  const tight = setRule(r, { scope: 'office', row: 'read-inside', col: 'local', value: 'ask' }).rules;
  assert.equal(decide(tight, call('Read', { file_path: inside }, { kind: 'ollama', provider: true })), null, 'a tightened read is held');
});

test('preToolDecision: Claude Code refuses a Deny before its own permission check, and asks for a tightened low row', () => {
  let r = setRule(none(), { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  assert.deepEqual(preToolDecision(r, call('Bash', { command: 'ls' })), { decision: 'deny', reason: 'Denied by the Security room: Shell commands.', line: 'denied by Security: Shell commands' });
  assert.equal(preToolDecision(r, call('WebFetch', { url: 'https://x.test' })), null, 'Ask on a row whose default is Ask: Claude Code decides, the office holds its prompt');
  r = setRule(r, { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(preToolDecision(r, call('Read', { file_path: inside })).decision, 'ask', 'Claude Code does not ask about reads by itself');
  assert.equal(preToolDecision(none(), call('Read', { file_path: inside })), null);
});

test('permissionModeFor: a Claude Code session opens in default mode while any of its cells is Ask', () => {
  const r = none();
  assert.equal(permissionModeFor(r, B, null), 'default');
  assert.equal(permissionModeFor(r, B, 'acceptEdits'), 'default');
  assert.equal(permissionModeFor(r, B, 'plan'), 'plan', 'plan mode runs no tool: it stays');
  let all = r;
  for (const row of ['files-outside', 'shell', 'web', 'mcp']) all = setRule(all, { scope: 'office', row, col: 'claude-code', value: 'allow', confirmed: true }).rules;
  for (const row of ['settings', 'secrets']) all = setRule(all, { scope: 'office', row, col: 'claude-code', value: 'deny' }).rules;
  assert.equal(permissionModeFor(all, B, null), null, 'no Ask cell: Claude Code\'s own default');
  assert.equal(permissionModeFor(all, B, 'acceptEdits'), 'acceptEdits');
  const back = setRule(all, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(permissionModeFor(back, B, null), 'default', 'the building override counts');
});

test('openRefusal: an ungated agent kind is off until turned on; an agent without cost reports can be denied', () => {
  const ungated = { kind: 'openclaw', label: 'OpenClaw', gated: false };
  assert.match(openRefusal(none(), ungated), /Turn on OpenClaw on the Agents screen of the Security room/);
  assert.equal(openRefusal(setRule(none(), { scope: 'office', row: 'ungated', col: 'openclaw', value: 'on', confirmed: true }).rules, ungated), null);
  const noCost = { kind: 'hermes', label: 'Hermes', cost: 'unknown' };
  assert.equal(openRefusal(none(), noCost), null);
  assert.match(openRefusal(setRule(none(), { scope: 'office', row: 'no-cost', col: 'hermes', value: 'deny' }).rules, noCost), /does not report cost/);
  assert.equal(openRefusal(none(), { kind: 'claude-code', label: 'Claude Code' }), null);
});

test('enforcement: a gated provider enforces every cell; a missing or ungated one says why not', () => {
  const e = enforcement([{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'ollama', label: 'Ollama' }, { kind: 'openclaw', label: 'OpenClaw', gated: false, enforces: ['shell'] }]);
  assert.equal(e['claude-code'].reason, '');
  assert.equal(e['claude-code'].rows.supervise, 'Paperclip is not connected to this office.');
  assert.equal(e.local.reason, '');
  assert.equal(e.hermes.reason, 'The office has no provider for this agent kind yet. The rule applies when it has one.');
  assert.equal(e.openclaw.rows.shell, undefined, 'OpenClaw takes the shell rule into its own config');
  assert.equal(e.openclaw.rows['edit-inside'], 'This agent runs this kind of call without asking the office.');
});

test('cost per agent kind this month: a ledger by month, the last three months kept', () => {
  const at = (y, m) => new Date(y, m - 1, 15).getTime();
  let l = addCost({}, at(2026, 11), 'claude-code', 0.5);
  l = addCost(l, at(2026, 11), 'claude-code', 0.25);
  l = addCost(l, at(2026, 11), 'local', 0);
  l = addCost(l, at(2026, 10), 'claude-code', 9);
  assert.deepEqual(costThisMonth(l, at(2026, 11)), { month: '2026-11', byColumn: { 'claude-code': 0.75 } });
  for (const m of [7, 8, 9, 12]) l = addCost(l, at(2026, m), 'claude-code', 1);
  assert.deepEqual(Object.keys(l).sort(), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(addCost({}, at(2026, 11), 'claude-code', -1), {}, 'no negative or bad amounts');
});
