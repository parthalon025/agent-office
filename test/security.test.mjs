// Security room rules (security.mjs, #70): pure, no server, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cleanRules, setRule, decide, permissionModeFor, openRefusal, costAsk, cellsOf, enforcement, preToolDecision, addCost, costThisMonth } from '../security.mjs';

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
  assert.equal(r.office['shell|claude-code'], 'ask', 'the user set Ask: it is stored, so it counts as set (B1)');
  r = setRule(r, { scope: 'office', row: 'shell', col: 'claude-code', value: null }).rules;
  assert.equal(r.office['shell|claude-code'], undefined, 'Use default');
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
  let r = setRule(none(), { scope: 'office', row: 'edit-inside', col: 'claude-code', value: 'allow', confirmed: true }).rules;
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
  assert.equal(decide(r, call('Read', { file_path: inside }, { worktree: false, kind: 'ollama', provider: true })).quiet, true, 'the local model: its folder counts (M4)');
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

test('preToolDecision: an Ask the user set on Settings and Secrets makes Claude Code ask, since it reads files in its folder without asking', () => {
  let r = setRule(none(), { scope: 'office', row: 'secrets', col: 'claude-code', value: 'ask' }).rules;
  r = setRule(r, { scope: 'office', row: 'settings', col: 'claude-code', value: 'ask' }).rules;
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
  const allowRead = setRule(r, { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.equal(decide(allowRead, call('Read', { file_path: inside }, { kind: 'claude-code' })).quiet, false, 'Claude Code asked: the answer is news');
  const tight = setRule(r, { scope: 'office', row: 'read-inside', col: 'local', value: 'ask' }).rules;
  assert.equal(decide(tight, call('Read', { file_path: inside }, { kind: 'ollama', provider: true })), null, 'a tightened read is held');
});

test('decide: a firm request (the provider must ask the user) is held under an Allow rule; a Deny still refuses it', () => {
  const firm = (tool, input) => call(tool, input, { kind: 'hermes', provider: true, firm: true });
  const allowEdit = setRule(none(), { scope: 'office', row: 'edit-inside', col: 'hermes', value: 'allow', confirmed: true }).rules;
  assert.equal(decide(allowEdit, firm('Write', { file_path: inside, content: 'x' })), null, 'Edit inside is Allow, but this one asks');
  const deny = setRule(none(), { scope: 'office', row: 'edit-inside', col: 'hermes', value: 'deny' }).rules;
  assert.equal(decide(deny, firm('Write', { file_path: inside, content: 'x' })).allow, false);
  assert.equal(decide(allowEdit, call('Write', { file_path: inside, content: 'x' }, { kind: 'hermes', provider: true })).allow, true, 'not firm: the Allow rule answers');
});

test('preToolDecision: Claude Code refuses a Deny before its own permission check, and asks for a tightened low row', () => {
  let r = setRule(none(), { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }).rules;
  assert.deepEqual(preToolDecision(r, call('Bash', { command: 'ls' })), { decision: 'deny', reason: 'Denied by the Security room: Shell commands.', line: 'denied by Security: Shell commands' });
  assert.equal(preToolDecision(r, call('WebFetch', { url: 'https://x.test' })), null, 'Ask on a row whose default is Ask: Claude Code decides, the office holds its prompt');
  r = setRule(r, { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(preToolDecision(r, call('Read', { file_path: inside })).decision, 'ask', 'Claude Code does not ask about reads by itself');
  assert.equal(preToolDecision(none(), call('Read', { file_path: inside })), null, 'the default Ask forces nothing: Claude Code decides (B1)');
  const allow = setRule(none(), { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.equal(preToolDecision(allow, call('Read', { file_path: inside })), null, 'a user-set Allow: no question');
});

// Owner decision pending (#67): by default no call is answered for the user, also a low-risk read or edit inside the worktree.
// A Claude Code call is held only when Claude Code asks (B1: a default Ask forces no prompt).
test('decide: with the default cells a low-risk Claude Code edit or read inside a worktree is held; only a cell the user set answers', () => {
  const edit = call('Edit', { file_path: inside, old_string: 'a', new_string: 'b' });
  const read = call('Read', { file_path: inside });
  for (const c of [edit, read, call('Write', { file_path: inside, content: 'x' }), call('Edit', { file_path: inside, old_string: 'a', new_string: 'b' }, { kind: 'hermes', provider: true })]) {
    assert.equal(decide(none(), c), null, `${c.tool} ${c.kind}: held`);
  }
  assert.equal(preToolDecision(none(), edit), null, 'Claude Code decides whether to ask');
  const allow = setRule(none(), { scope: 'office', row: 'edit-inside', col: 'claude-code', value: 'allow', confirmed: true }).rules;
  assert.deepEqual(decide(allow, edit), { allow: true, line: 'allowed by Security: Edit inside the worktree', quiet: false });
  assert.equal(decide(allow, read), null, 'the Read row is a cell of its own');
  const deny = setRule(none(), { scope: 'office', row: 'edit-inside', col: 'claude-code', value: 'deny' }).rules;
  assert.equal(decide(deny, edit).allow, false);
  // the local model keeps its old behaviour: a low call it asks about is answered without a feed line, until the user tightens the cell
  const local = call('Edit', { file_path: inside, old_string: 'a', new_string: 'b' }, { kind: 'ollama', provider: true });
  assert.deepEqual(decide(none(), local), { allow: true, line: 'allowed by Security: Edit inside the worktree', quiet: true });
});

test('permissionModeFor: a Claude Code session opens in default mode while any cell the user set is Ask', () => {
  const r = setRule(none(), { scope: 'office', row: 'web', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(permissionModeFor(r, B, null), 'default');
  assert.equal(permissionModeFor(r, B, 'acceptEdits'), 'default');
  assert.equal(permissionModeFor(r, B, 'plan'), 'plan', 'plan mode runs no tool: it stays');
  let all = r;
  for (const row of ['read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp']) all = setRule(all, { scope: 'office', row, col: 'claude-code', value: 'allow', confirmed: true }).rules;
  for (const row of ['settings', 'secrets']) all = setRule(all, { scope: 'office', row, col: 'claude-code', value: 'deny' }).rules;
  assert.equal(permissionModeFor(all, B, null), null, 'no Ask cell: Claude Code\'s own default');
  assert.equal(permissionModeFor(all, B, 'acceptEdits'), 'acceptEdits');
  const back = setRule(all, { scope: 'building', building: B, row: 'shell', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(permissionModeFor(back, B, null), 'default', 'the building override counts');
});

// Review B1 (#67): a default cell never forces a prompt. Claude Code decides, as on main, and the office holds what it asks.
// Only a cell the user set (sourceOf !== 'default') makes Claude Code ask, or opens the session in default mode.
test('B1: a default Ask forces nothing; a cell the user set to Ask makes Claude Code ask and opens default mode', () => {
  const r = none();
  for (const c of [call('Read', { file_path: inside }), call('Edit', { file_path: inside, old_string: 'a', new_string: 'b' }),
    call('Read', { file_path: path.join(root, '.env') }), call('Edit', { file_path: path.join(root, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' }),
    call('Read', { file_path: inside }, { worktree: false })]) {
    assert.equal(preToolDecision(r, c), null, `${c.tool} ${c.input.file_path}: Claude Code decides`);
  }
  assert.equal(permissionModeFor(r, B, 'acceptEdits'), 'acceptEdits', 'the Permissions picker of the Open dialog takes effect');
  assert.equal(permissionModeFor(r, B, null), null);
  // the user clicks Ask on the wall: stored, so it counts as set, also office-wide
  const set = setRule(r, { scope: 'office', row: 'read-inside', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(set.office['read-inside|claude-code'], 'ask');
  assert.equal(preToolDecision(set, call('Read', { file_path: inside })).decision, 'ask');
  assert.equal(permissionModeFor(set, B, 'acceptEdits'), 'default');
  // a building override counts in its building only
  const here = setRule(r, { scope: 'building', building: B, row: 'secrets', col: 'claude-code', value: 'ask' }).rules;
  assert.equal(preToolDecision(here, call('Read', { file_path: path.join(root, '.env') })).decision, 'ask');
  assert.equal(preToolDecision(here, call('Read', { file_path: path.join(root, '.env') }, { building: 'c:\\other' })), null);
  assert.equal(preToolDecision(here, call('Read', { file_path: path.join(root, '.env') }, { building: null })).decision, 'ask', 'not placed yet: its building may have set Ask');
  assert.equal(permissionModeFor(here, 'c:\\other', 'acceptEdits'), 'acceptEdits');
  // Use default: null at the office scope clears the user's rule
  assert.equal(setRule(set, { scope: 'office', row: 'read-inside', col: 'claude-code', value: null }).rules.office['read-inside|claude-code'], undefined);
  assert.equal(status(() => setRule(setRule(r, { scope: 'office', row: 'read-inside', col: 'local', value: 'ask' }).rules, { scope: 'office', row: 'read-inside', col: 'local', value: null }))[0], 409, 'back to the local default Allow loosens');
});

test('B1: the wall says Partly enforced for a default Ask that Claude Code decides, on every row', () => {
  const e = enforcement([{ kind: 'claude-code', label: 'Claude Code' }])['claude-code'];
  for (const row of ['read-inside', 'edit-inside', 'settings', 'secrets']) assert.match(e.unset[row], /decides until you click the cell/, row);
  for (const row of ['files-outside', 'shell', 'web', 'mcp']) assert.equal(e.unset[row], undefined, `${row}: partly enforced at any Ask (asks)`);
});

test('M4: the local model runs its low calls unasked in a plain folder outside git too, as on main; never in a wide root', () => {
  const local = (tool, input, extra) => call(tool, input, { kind: 'ollama', provider: true, worktree: false, ...extra });
  assert.deepEqual(decide(none(), local('Read', { file_path: inside })), { allow: true, line: 'allowed by Security: Read inside the worktree', quiet: true });
  assert.equal(decide(none(), local('Edit', { file_path: inside, old_string: 'a', new_string: 'b' })).quiet, true);
  assert.equal(decide(none(), local('Read', { file_path: outside })), null, 'outside the folder: held');
  const home = os.homedir();
  assert.equal(decide(none(), local('Read', { file_path: path.join(home, 'notes.txt') }, { root: home })), null, 'a home-folder root has no inside');
  assert.equal(decide(none(), call('Read', { file_path: inside }, { worktree: false })), null, 'Claude Code outside git: held (it decides)');
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

test('enforcement: Hermes edit requests are enforced; reads and its own skill and memory writes are not, and say why', () => {
  const EDITS = 'Edit requests come to the office and the rule applies. Reads, and writes to its own skills and memory, run without asking.';
  const READS = 'This agent reads files without asking the office.';
  const hermes = { kind: 'hermes', label: 'Hermes Agent', gated: false, enforces: ['edit-inside'], unenforced: { 'read-inside': READS, secrets: READS }, partly: { 'files-outside': EDITS, settings: EDITS } };
  const e = enforcement([hermes]).hermes;
  assert.equal(e.reason, '');
  assert.equal(e.rows['edit-inside'], undefined, 'an edit request inside the worktree comes through session/request_permission: enforced');
  assert.equal(e.rows['read-inside'], READS);
  assert.equal(e.rows.secrets, READS);
  assert.equal(e.rows.shell, 'This agent runs this kind of call without asking the office.', 'a row with no reason of its own keeps the general one');
  assert.equal(e.rows['files-outside'], undefined, 'partly enforced is not "Not enforced"');
  assert.deepEqual(e.partly, { 'files-outside': EDITS, settings: EDITS });
  // an agent with no such fields shows no partly rows
  assert.deepEqual(enforcement([{ kind: 'openclaw', label: 'OpenClaw', gated: false, enforces: ['shell'] }]).openclaw.partly, {});
});

test('cellsOf: the call cells of one agent kind in a building, for an agent whose own config carries the rules (OpenClaw)', () => {
  let r = setRule(none(), { scope: 'office', row: 'shell', col: 'openclaw', value: 'deny' }).rules;
  r = setRule(r, { scope: 'building', building: B, row: 'web', col: 'openclaw', value: 'deny' }).rules;
  const office = cellsOf(r, null, 'openclaw');
  assert.deepEqual(office, { 'read-inside': 'ask', 'edit-inside': 'ask', 'files-outside': 'ask', shell: 'deny', web: 'ask', mcp: 'ask', settings: 'ask', secrets: 'ask' });
  assert.equal(cellsOf(r, B, 'openclaw').web, 'deny', 'the building override counts');
  assert.equal(cellsOf(r, null, 'openclaw').ungated, undefined, 'no Agents row: those are not calls');
});

test('enforcement: an ungated agent whose config the office read shows what that config really carries', () => {
  const claw = { kind: 'openclaw', label: 'OpenClaw', gated: false, enforces: ['shell'] };
  const NO_ASK = 'OpenClaw has no approval step for this kind of call, so it cannot ask.';
  const policy = {
    config: { ok: false, unreadable: false, execAsks: false, settings: [
      { path: 'tools.fs.workspaceOnly', value: true, have: 'true', ok: true, fix: null, rows: ['files-outside'] },
      { path: 'tools.exec.ask', value: 'always', have: '"off"', ok: false, fix: 'openclaw config set tools.exec.ask always', rows: ['shell'] },
      { path: 'tools.deny', value: ['group:web'], have: 'unknown', ok: false, fix: null, rows: ['web'] }] },
    gaps: [{ row: 'mcp', value: 'ask', reason: NO_ASK }],
  };
  const e = enforcement([claw], { openclaw: policy }).openclaw;
  assert.equal(e.reason, '');
  assert.equal(e.rows.shell, 'Its config does not carry this rule: tools.exec.ask is "off". Run: openclaw config set tools.exec.ask always');
  assert.equal(e.rows.web, 'The office could not read tools.deny in its config, so it cannot confirm this rule.');
  assert.equal(e.rows.mcp, NO_ASK);
  assert.equal(e.rows['files-outside'], undefined, 'workspace-only is on');
  assert.equal(e.rows['read-inside'], undefined, 'Allow: the agent runs it, as the cell says');
  const good = enforcement([claw], { openclaw: { config: { settings: [{ path: 'tools.exec.ask', value: 'always', have: '"always"', ok: true, fix: null, rows: ['shell'] }] }, gaps: [] } }).openclaw;
  assert.deepEqual(good.rows, {}, 'a config that carries every cell: all enforced');
  assert.equal(enforcement([claw]).openclaw.rows['edit-inside'], 'This agent runs this kind of call without asking the office.', 'no config read yet: what the provider says it takes');
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
