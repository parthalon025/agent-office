// Security room rules (security.mjs, #70): pure, no server, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cleanRules, setRule, decide, permissionModeFor, openRefusal, costAsk, enforcement, preToolDecision, addCost, costThisMonth } from '../security.mjs';

const WIN = process.platform === 'win32';
const root = WIN ? 'C:\\work\\repo' : '/work/repo';
const inside = path.join(root, 'src', 'a.js');
const outside = WIN ? 'C:\\Windows\\win.ini' : '/etc/hosts';
const B = 'c:\\work\\repo';
const none = () => cleanRules(null);
// worktree: the root is inside a git worktree (the server knows it from the session's worktree or its git place).
const call = (tool, input, extra = {}) => ({ building: B, kind: 'claude-code', tool, input, root, worktree: true, ...extra });
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
  assert.equal(decide(r, call('Read', { file_path: outside }, { building: null })), null, 'a session not placed yet: its building may deny, so it is held');
});

// ---------- #70 review fixes ----------
test('decide: the inside rows are for a git worktree; a root outside git or a wide root holds the call (Ask)', () => {
  const r = none();
  assert.equal(decide(r, call('Edit', { file_path: inside }, { worktree: false })), null, 'an edit in a folder outside git waits for the user');
  assert.equal(decide(r, call('Read', { file_path: inside }, { worktree: false })), null);
  assert.equal(decide(r, call('Read', { file_path: inside }, { worktree: false, kind: 'ollama', provider: true })), null, 'a local agent outside git asks too');
  const home = os.homedir();
  const startup = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.cmd');
  assert.equal(decide(r, call('Write', { file_path: startup }, { root: home, worktree: true })), null, 'the home folder is no worktree, even in git');
  assert.equal(decide(r, call('Write', { file_path: path.join(home, 'Documents', 'a.txt') }, { root: home, worktree: false })), null);
  const allowOut = setRule(r, { scope: 'office', row: 'files-outside', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.equal(decide(allowOut, call('Edit', { file_path: inside }, { worktree: false })).line, 'allowed by Security: Read or edit outside it', 'the feed names the row that decided');
  assert.equal(decide(allowOut, call('Write', { file_path: startup }, { root: home, worktree: false })), null, 'the Startup folder is settings: never Allow');
});

test('setRule refuses building keys that would reach Object.prototype, and changes nothing shared', () => {
  for (const building of ['__proto__', 'constructor', 'prototype']) {
    const e = status(() => setRule(none(), { scope: 'building', building, row: 'shell', col: 'claude-code', value: 'allow', confirmed: true }));
    assert.equal(e && e[0], 400, building);
    assert.equal(status(() => setRule(none(), { scope: 'building', building, row: 'shell', col: 'claude-code', value: 'allow' }))[0], 400, `${building}, no confirm`);
  }
  assert.equal(({})['shell|claude-code'], undefined, 'Object.prototype has no rule');
  assert.equal(decide(none(), call('Bash', { command: 'rm -rf /' })), null, 'a shell call is still held');
});

test('cleanRules drops hostile keys from state.json and never throws on them', () => {
  const raw = JSON.parse('{"office":{"constructor|claude-code":"ask","__proto__|local":"deny","shell|claude-code":"deny"},"buildings":{"__proto__":{"shell|claude-code":"allow"},"constructor":{"shell|local":"deny"}}}');
  const r = cleanRules(raw);
  assert.deepEqual(r, { office: { 'shell|claude-code': 'deny' }, buildings: {} });
  assert.equal(Object.getPrototypeOf(r.buildings), Object.prototype);
  assert.equal(decide(r, call('Bash', { command: 'ls' }, { building: 'c:\\other' })).allow, false, 'the office Deny still applies');
});

test('the shared vocabulary reads only own rules: an inherited key is no rule', () => {
  const S = globalThis.OfficeVocab.security;
  const office = Object.create({ 'shell|claude-code': 'allow' });
  assert.equal(S.valueOf({ office, buildings: {} }, null, 'shell', 'claude-code'), 'ask');
  assert.equal(S.valueOf({ office: {}, buildings: Object.create({ [B]: { 'shell|claude-code': 'allow' } }) }, B, 'shell', 'claude-code'), 'ask');
  assert.equal(S.applies('constructor', 'claude-code'), false);
  assert.deepEqual(S.options('__proto__'), []);
  assert.equal(S.columnOf('constructor'), null);
});

test('a session not placed yet: the office rule when no building differs, else the call is held (decide) or asked (PreToolUse)', () => {
  const unplaced = (tool, input) => call(tool, input, { building: null });
  let r = setRule(none(), { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(decide(r, unplaced('Bash', { command: 'ls' })).allow, false, 'no building differs: the office Deny');
  r = setRule(none(), { scope: 'office', row: 'shell', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.equal(decide(r, unplaced('Bash', { command: 'ls' })).allow, true);
  r = setRule(r, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(decide(r, unplaced('Bash', { command: 'ls' })), null, 'its building may deny: held, never allowed');
  assert.equal(preToolDecision(r, unplaced('Bash', { command: 'ls' })).decision, 'ask', 'Claude Code must ask, so the office sees it');
  assert.equal(decide(r, call('Bash', { command: 'ls' })).allow, false, 'once placed, its building decides');
});

test('preToolDecision: Ask on Settings and Secrets makes Claude Code ask, since it reads files in its folder without asking', () => {
  const r = none();
  const env = preToolDecision(r, call('Read', { file_path: path.join(root, '.env') }));
  assert.deepEqual(env, { decision: 'ask', reason: 'The Security room asks for secret files.', line: null });
  assert.equal(preToolDecision(r, call('Read', { file_path: path.join(root, '.git', 'config') })).decision, 'ask');
  assert.equal(preToolDecision(r, call('Bash', { command: 'ls' })), null, 'shell: Claude Code asks by itself (its rules and mode decide)');
  const deny = setRule(r, { scope: 'office', row: 'secrets', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(preToolDecision(deny, call('Read', { file_path: path.join(root, '.env') })).decision, 'deny');
});

test('enforcement: an Ask that only Claude Code decides is partly enforced, and says why; Allow and Deny are enforced', () => {
  const e = enforcement([{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'ollama', label: 'Ollama' }]);
  for (const row of ['files-outside', 'shell', 'web', 'mcp']) assert.match(e['claude-code'].asks[row], /allow rules and permission mode/, row);
  for (const row of ['read-inside', 'edit-inside', 'settings', 'secrets']) assert.equal(e['claude-code'].asks[row], undefined, `${row}: the office makes Claude Code ask`);
  assert.deepEqual(e.local.asks, {}, 'a local agent asks the office about every call');
  assert.equal(e.hermes.asks['no-cost'], undefined, 'the office asks once per session (costAsk), so Ask is enforced');
});

test('costAsk: an agent without cost reports asks once before it runs while its cell is Ask; Allow runs it; Deny never skips the question', () => {
  const hermes = { kind: 'hermes', label: 'Hermes Agent', cost: 'unknown' };
  assert.equal(costAsk(none(), hermes), true, 'the default is Ask');
  const allow = setRule(none(), { scope: 'office', row: 'no-cost', col: 'hermes', value: 'allow', confirmed: true }).rules;
  assert.equal(costAsk(allow, hermes), false, 'Allow: it runs without the question');
  assert.equal(costAsk(allow, { ...hermes, kind: 'dsh', label: 'DeepSeek Harness' }), true, 'the rule is per agent kind');
  const deny = setRule(none(), { scope: 'office', row: 'no-cost', col: 'hermes', value: 'deny' }).rules;
  assert.equal(costAsk(deny, hermes), true, 'Deny: openRefusal refuses it first; the question is never skipped');
  assert.equal(costAsk(allow, { kind: 'claude-code', label: 'Claude Code' }), false, 'an agent that reports cost is never asked');
  assert.equal(costAsk(none(), { kind: 'copilot', label: 'Copilot', cost: 'unknown' }), true, 'a kind with no cell asks');
});

test('decide: a provider asks about every call; a low call it may run is allowed without a feed line', () => {
  const r = none();
  assert.equal(decide(r, call('Read', { file_path: inside }, { kind: 'ollama', provider: true })).quiet, true);
  assert.equal(decide(r, call('Read', { file_path: inside }, { kind: 'claude-code' })).quiet, false, 'Claude Code asked: the answer is news');
  const tight = setRule(r, { scope: 'office', row: 'read-inside', col: 'local', value: 'ask' }).rules;
  assert.equal(decide(tight, call('Read', { file_path: inside }, { kind: 'ollama', provider: true })), null, 'a tightened read is held');
});

test('decide: a firm request (the provider must ask the user) is held under an Allow rule; a Deny still refuses it', () => {
  const firm = (tool, input) => call(tool, input, { kind: 'hermes', provider: true, firm: true });
  assert.equal(decide(none(), firm('Write', { file_path: inside, content: 'x' })), null, 'Edit inside is Allow by default, but this one asks');
  const deny = setRule(none(), { scope: 'office', row: 'edit-inside', col: 'hermes', value: 'deny' }).rules;
  assert.equal(decide(deny, firm('Write', { file_path: inside, content: 'x' })).allow, false);
  assert.equal(decide(none(), call('Write', { file_path: inside, content: 'x' }, { kind: 'hermes', provider: true })).allow, true, 'not firm: the Allow rule answers');
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
