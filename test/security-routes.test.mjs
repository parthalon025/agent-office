// The Security room rules (#70) against a real server.mjs: the check before a hold, the feed lines, the per-building override,
// the route that changes a rule (page group), and what the snapshot and state.json carry. The server runs from a throwaway copy
// of the code (like test/mcp-routes.test.mjs), on a free port, with its own LOCALAPPDATA and OFFICE_OPEN=0. A terminal session
// is made by posting Claude Code hook payloads to /hook/http, so no Claude Code runs and nothing is paid for.
// The server gets its own home folder (USERPROFILE, HOME), so a session can start "in the home folder" without touching the
// real one. The snapshot is lean (public/wire.js): session data and feed lines come from GET /api/session.
// Run: node --test test/security-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../auth.mjs';
import { officeFiles } from '../files.mjs';
import { shortOf } from './fixtures/short-name.mjs';
import { startOnFreePort, until as waitUntil, START_MS } from './fixtures/office-server.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// shortRepo: the 8.3 short spelling of repo, or null when the volume keeps none (base is not made real on purpose: on
// GitHub's Windows runner os.tmpdir() is C:\Users\RUNNER~1\..., and git answers the long path).
let base, copy, work, home, repo, shortRepo, office, port, agentToken, pageToken;

// The fixture's wait: long under load, and a failure shows the end of the server log.
const until = (fn, what, ms = START_MS) => waitUntil(fn, what, { ms, log: () => office?.out() ?? '' });
const post = (route, body, token, signal) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token }, body: JSON.stringify(body || {}), signal,
}).then(async (r) => ({ status: r.status, text: await r.text() })).then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })() }));
const page = (route, body) => post(route, body, pageToken);
const hook = (body, signal) => post('/hook/http', body, agentToken, signal);
async function snapshot() {
  const ctl = new AbortController();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/events`, { headers: { 'x-office-token': pageToken }, signal: ctl.signal });
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += Buffer.from(value).toString('utf8');
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  } finally { ctl.abort(); }
}
const SID = 'sid-sec-1';
const ev = (name, extra = {}) => ({ hook_event_name: name, session_id: SID, cwd: work, ...extra });
const permission = (tool, input, extra = {}) => ev('PermissionRequest', { tool_name: tool, tool_input: input, permission_suggestions: [], ...extra });
const set = (change) => page('/api/security/set', change);
const fullOf = async (uid) => { const r = await fetch(`http://127.0.0.1:${port}/api/session?uid=${encodeURIComponent(uid)}`, { headers: { 'x-office-token': pageToken } }); return r.ok ? r.json() : null; };
// The terminal session that started in a folder (its cwd), as the page sees it (lean), and its feed lines.
const sessionIn = async (cwd) => (await snapshot()).sessions.find((x) => x.cwd === cwd);
const feedOf = async (cwd) => { const s = await sessionIn(cwd); return s ? (await fullOf(s.uid)).feed.map((f) => f.text) : []; };
const feedHas = async (text, cwd = work) => (await feedOf(cwd)).includes(text);
// A request that the office holds: the hook waits until the test answers it on the page route (declined).
async function heldThenDeclined(body, cwd) {
  const ctl = new AbortController();
  const answer = hook(body, ctl.signal);
  const s = await until(async () => { const x = await sessionIn(cwd); return x && x.pending.length ? x : null; }, `the ${body.tool_name} request in ${cwd} to wait`);
  assert.equal(s.pending.length, 1);
  assert.equal((await page('/api/answer', { id: s.pending[0].id, allow: false })).status, 200);
  return (await answer).json;
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sec-'));
  copy = path.join(base, 'office');
  work = path.join(base, 'work');
  home = path.join(base, 'home');
  repo = path.join(base, 'repo');
  for (const d of [work, copy, home, repo]) fs.mkdirSync(d);
  // a git repository: a terminal session there is in a worktree (its main checkout)
  const { resolveExe } = await import('../git.mjs');
  const { execFileSync } = await import('node:child_process');
  const g = (...a) => execFileSync(resolveExe('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'b\n');
  shortRepo = shortOf(fs.realpathSync.native(repo));
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !/^(state|history)(-\d+)?\.json$/.test(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  const env = { ...process.env, OFFICE_HOOKS: 'command', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: home, HOME: home };
  // Ready is the server's own "is open" line, after it wrote its files; a busy port starts again on a new one.
  const started = await startOnFreePort(copy, env);
  ({ office, port } = started);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).token; } catch { return null; } };
  // the office's files carry the port in their names (files.mjs), as the port is not the default one
  agentToken = read(officeFiles(copy, port).token);
  pageToken = read(pageFile(started.env, port));
  assert.ok(agentToken && pageToken, `the office is open but a token file is missing\n${office.out().slice(-800)}`);
  // A terminal Claude Code session in a folder outside git (building key ''), seated once its place is known.
  assert.equal((await hook(ev('SessionStart', { source: 'startup' }))).status, 200);
  await until(async () => (await sessionIn(work))?.place, 'the session to be placed');
  // and one in a git repository, and one in the (server's) home folder. The one in the repository waits until git placed
  // it there (the lean git is { branch }, null outside git): placed outside git (git did not answer in time), its edits are
  // not Edit inside, and a test would wait 60 s.
  for (const [sid, cwd] of [['sid-sec-git', repo], ['sid-sec-home', home]]) {
    assert.equal((await hook({ hook_event_name: 'SessionStart', session_id: sid, cwd, source: 'startup' })).status, 200);
    await until(async () => { const x = await sessionIn(cwd); return x?.place && (cwd !== repo || x.git); }, `the session in ${path.basename(cwd)} to be placed`);
  }
});
after(async () => {
  if (office) await office.stop();
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
});

test('the snapshot carries the rules, what each agent kind enforces, and the Spend screen figures', async () => {
  const s = await snapshot();
  assert.deepEqual(s.security.rules, { office: {}, buildings: {} });
  assert.equal(s.security.enforce['claude-code'].reason, '');
  // Hermes Agent (#71) is ungated: it runs commands through its own tools, but its edit requests come to the office
  // (session/request_permission), so the Edit inside cell is enforced. Reads and its own skill and memory writes are not.
  const h = s.security.enforce.hermes;
  assert.equal(h.reason, '');
  assert.equal(h.rows.shell, undefined, 'review M1: commands Hermes rates dangerous come to the office');
  assert.match(h.partly.shell, /rates dangerous come to the office/);
  assert.equal(h.rows['edit-inside'], undefined, 'Edit inside the worktree is enforced for Hermes');
  assert.match(h.rows['read-inside'], /reads files without asking/);
  assert.match(h.partly['files-outside'], /its own skills and memory/);
  assert.match(h.partly.settings, /its own skills and memory/);
  assert.equal(s.security.enforce.dsh.reason, '', 'dsh is gated: it asks the office before its tool calls');
  assert.deepEqual(s.security.enforce.dsh.rows, {});
  // OpenClaw (#77) is gated through its office plugin. Not installed here, so its config is not read: every cell enforced.
  assert.equal(s.security.enforce.openclaw.reason, '');
  assert.deepEqual(s.security.enforce.openclaw.rows, {});
  assert.equal(s.security.spend.limit, 2);
  assert.match(s.security.spend.month, /^\d{4}-\d{2}$/);
  assert.deepEqual(s.security.spend.byColumn, {});
});

test('the rule route is a page route: the agent token does not open it', async () => {
  assert.equal((await post('/api/security/set', { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }, agentToken)).status, 401);
});

// Owner decision pending (#67): with the default cells nothing is answered for the user, a low-risk edit in a worktree included.
// Review B1: a default cell forces no prompt either. Claude Code decides, as on main (PreToolUse has no answer), and the office
// holds what Claude Code asks.
test('with the default cells a low-risk Claude Code edit in a worktree is held only when Claude Code asks; PreToolUse forces nothing', async () => {
  const edit = { file_path: path.join(repo, 'a.txt'), old_string: 'a', new_string: 'b' };
  for (const [tool, input] of [['Edit', edit], ['Read', { file_path: path.join(repo, 'a.txt') }], ['Read', { file_path: path.join(repo, '.env') }]]) {
    const pre = await hook({ hook_event_name: 'PreToolUse', session_id: 'sid-sec-git', cwd: repo, tool_name: tool, tool_use_id: 'toolu_sec_free_' + tool + path.basename(input.file_path), tool_input: input });
    assert.deepEqual([pre.status, pre.text], [200, ''], tool + ' ' + input.file_path + ': no forced ask in a terminal session');
  }
  const r = await heldThenDeclined(permission('Edit', edit, { session_id: 'sid-sec-git', cwd: repo }), repo);
  assert.equal(r.hookSpecificOutput.decision.behavior, 'deny', 'the user declined it: Security answered nothing');
  assert.ok(!(await feedOf(repo)).some((t) => /by Security/.test(t)), 'no Security line');
});

// The rule goes back to its default also when the test fails, so a failure here does not fail the tests after it.
const allowEditsUntilDone = async (t) => {
  t.after(() => set({ scope: 'office', row: 'edit-inside', col: 'claude-code', value: null }));
  assert.equal((await set({ scope: 'office', row: 'edit-inside', col: 'claude-code', value: 'allow', confirmed: true })).status, 200);
};
const allowed = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

test('Allow set by the user answers at once, with a feed line', async (t) => {
  const edit = { file_path: path.join(repo, 'a.txt'), old_string: 'a', new_string: 'b' };
  await allowEditsUntilDone(t);
  const r = await hook(permission('Edit', edit, { session_id: 'sid-sec-git', cwd: repo }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, allowed);
  assert.ok(await feedHas('allowed by Security: Edit inside the worktree', repo));
  assert.equal((await set({ scope: 'office', row: 'edit-inside', col: 'claude-code', value: null })).status, 200); // Use default
  assert.deepEqual((await snapshot()).security.rules, { office: {}, buildings: {} });
});

// git gives the long path of the worktree; the session's folder and its tool paths can be the 8.3 short name (TEMP on
// GitHub's Windows runner). The session is in its worktree, and the user's Edit inside rule applies, in either spelling.
test('a session that started in the 8.3 short name of its worktree gets the Edit inside rule, for a path in either spelling', async (t) => {
  if (!shortRepo) { t.skip('no 8.3 short name for the temp folder here (8.3 names are off on this volume); test/risk.test.mjs checks the rule'); return; }
  const cwd = path.join(shortRepo, 'src'), sid = 'sid-sec-short';
  assert.equal((await hook({ hook_event_name: 'SessionStart', session_id: sid, cwd, source: 'startup' })).status, 200);
  await until(async () => (await sessionIn(cwd))?.git, 'the session in the short folder to be placed in git');
  await allowEditsUntilDone(t);
  for (const file of [path.join(cwd, 'b.txt'), path.join(fs.realpathSync.native(repo), 'src', 'b.txt')]) {
    const r = await hook(permission('Edit', { file_path: file, old_string: 'b', new_string: 'c' }, { session_id: sid, cwd }));
    assert.deepEqual(r.json, allowed, file);
  }
  assert.ok(await feedHas('allowed by Security: Edit inside the worktree', cwd));
});

// #70 review (blocker): the default Allow of the inside rows is for a git worktree only. A terminal session in a folder
// outside git, or in the home folder, has no worktree: its edits wait for the user as they did before the Security room.
test('a session outside git, or in the home folder, has no worktree: its edits are held, also the Startup folder', async () => {
  const outside = await heldThenDeclined(permission('Edit', { file_path: path.join(work, 'a.txt'), old_string: 'a', new_string: 'b' }), work);
  assert.equal(outside.hookSpecificOutput.decision.behavior, 'deny', 'the user declined it: it was not allowed by Security');
  const startup = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.cmd');
  const profile = path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  for (const f of [startup, profile, path.join(home, 'notes.txt')]) {
    const r = await heldThenDeclined(permission('Write', { file_path: f, content: 'x' }, { session_id: 'sid-sec-home', cwd: home }), home);
    assert.equal(r.hookSpecificOutput.decision.behavior, 'deny', f);
  }
  assert.ok(!(await feedOf(home)).some((t) => /allowed by Security/.test(t)), 'nothing in the home folder was allowed by Security');
});

test('an Ask the user set makes Claude Code ask before it reads a secret file in its own folder (it would not ask by itself)', async () => {
  assert.equal((await set({ scope: 'office', row: 'secrets', col: 'claude-code', value: 'ask' })).status, 200);
  assert.equal((await snapshot()).security.rules.office['secrets|claude-code'], 'ask', 'the user set it: stored');
  const pre = await hook({ hook_event_name: 'PreToolUse', session_id: 'sid-sec-git', cwd: repo, tool_name: 'Read', tool_use_id: 'toolu_sec_env', tool_input: { file_path: path.join(repo, '.env') } });
  assert.deepEqual(pre.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'The Security room asks for secret files.' } });
  assert.equal((await set({ scope: 'office', row: 'secrets', col: 'claude-code', value: null })).status, 200);
});

test('the wall cannot remove the spend limit in one step: No limit needs confirmed', async () => {
  const r = await page('/api/settings/spend', { limit: 0 });
  assert.equal(r.status, 409);
  assert.equal((await snapshot()).security.spend.limit, 2);
});

test('Ask holds the request as today, until the user answers', async () => {
  const r = await heldThenDeclined(permission('Bash', { command: 'npm test' }), work);
  assert.equal(r.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(r.hookSpecificOutput.decision.message, 'Declined from Agent Office.');
});

test('Deny refuses at once without a prompt, and Claude hears why', async () => {
  assert.equal((await set({ scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' })).status, 200);
  const r = await hook(permission('Bash', { command: 'npm test' }));
  assert.deepEqual(r.json.hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied by the Security room: Shell commands.' });
  assert.ok(await feedHas('denied by Security: Shell commands'));
  const s = await sessionIn(work);
  assert.deepEqual(s.pending, [], 'nothing waits');
  // PreToolUse: the call is refused before Claude Code's own permission check, and it ends as failed
  const pre = await hook(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_sec_1', tool_input: { command: 'ls' } }));
  assert.deepEqual(pre.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied by the Security room: Shell commands.' } });
  const call = (await sessionIn(work)).calls.find((c) => c.id === 'toolu_sec_1');
  assert.deepEqual([call.ok, call.err], [false, 'Denied by the Security room: Shell commands.']);
  // a PreToolUse with no rule to apply has no answer
  const free = await hook(ev('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_sec_2', tool_input: { file_path: path.join(work, 'a.txt') } }));
  assert.equal(free.text, '');
});

test('a loosening change needs the painted Confirm; the Secrets cells refuse Allow', async () => {
  const loose = await set({ scope: 'office', row: 'shell', col: 'claude-code', value: 'allow' });
  assert.equal(loose.status, 409);
  assert.match(loose.json.error, /Confirm/);
  for (const row of ['secrets', 'settings']) {
    const r = await set({ scope: 'office', row, col: 'claude-code', value: 'allow', confirmed: true });
    assert.equal(r.status, 400, row);
    assert.match(r.json.error, /only Ask or Deny/);
  }
  assert.equal((await set({ scope: 'office', row: 'nope', col: 'claude-code', value: 'ask' })).status, 400);
});

test('a per-building override applies in its building only', async () => {
  // this session's building is Other folders (key ''): its override wins over the office-wide Deny
  assert.equal((await set({ scope: 'building', building: '', row: 'shell', col: 'claude-code', value: 'allow', confirmed: true })).status, 200);
  const r = await hook(permission('Bash', { command: 'npm test' }));
  assert.equal(r.json.hookSpecificOutput.decision.behavior, 'allow');
  assert.ok(await feedHas('allowed by Security: Shell commands'));
  // an override of another building changes nothing here
  assert.equal((await set({ scope: 'building', building: '', row: 'shell', col: 'claude-code', value: null })).status, 200);
  assert.equal((await set({ scope: 'building', building: 'c:\\elsewhere', row: 'shell', col: 'claude-code', value: 'allow', confirmed: true })).status, 200);
  const d = await hook(permission('Bash', { command: 'npm test' }));
  assert.equal(d.json.hookSpecificOutput.decision.behavior, 'deny');
  const s = await snapshot();
  assert.deepEqual(s.security.rules, { office: { 'shell|claude-code': 'deny' }, buildings: { 'c:\\elsewhere': { 'shell|claude-code': 'allow' } } });
});

test('the rules are saved in the state file (state.json, or state-<port>.json on another port)', async () => {
  const saved = await until(() => { try { return JSON.parse(fs.readFileSync(officeFiles(copy, port).state, 'utf8')).security; } catch { return null; } }, 'the state file');
  assert.equal(saved.office['shell|claude-code'], 'deny');
});
