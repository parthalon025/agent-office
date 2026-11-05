// The Security room rules (#70) against a real server.mjs: the check before a hold, the feed lines, the per-building override,
// the route that changes a rule (page group), and what the snapshot and state.json carry. The server runs from a throwaway copy
// of the code (like test/mcp-routes.test.mjs), on a free port, with its own LOCALAPPDATA and OFFICE_OPEN=0. A terminal session
// is made by posting Claude Code hook payloads to /hook/http, so no Claude Code runs and nothing is paid for.
// Run: node --test test/security-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../auth.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let base, copy, work, child, port, agentToken, pageToken, log = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  s.on('error', reject);
});
const until = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}\n${log.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
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
const permission = (tool, input) => ev('PermissionRequest', { tool_name: tool, tool_input: input, permission_suggestions: [] });
const set = (change) => page('/api/security/set', change);
const feedHas = async (text) => (await snapshot()).feed.some((f) => f.text === text);

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sec-'));
  copy = path.join(base, 'office');
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !['state.json', 'history.json'].includes(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  port = await freePort();
  const env = { ...process.env, OFFICE_PORT: String(port), OFFICE_HOOKS: 'command', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local') };
  child = spawn(process.execPath, ['server.mjs'], { cwd: copy, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).token; } catch { return null; } };
  agentToken = await until(() => read(path.join(copy, '.office-token')), 'the server to listen');
  pageToken = await until(() => read(pageFile(env, port)), 'the page token file');
  // A terminal Claude Code session in a folder outside git (building key ''), seated once its place is known.
  assert.equal((await hook(ev('SessionStart', { source: 'startup' }))).status, 200);
  await until(async () => (await snapshot()).sessions.find((s) => s.sid === SID && s.place), 'the session to be placed');
});
after(async () => {
  if (child) child.kill();
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
});

test('the snapshot carries the rules, what each agent kind enforces, and the Spend screen figures', async () => {
  const s = await snapshot();
  assert.deepEqual(s.security.rules, { office: {}, buildings: {} });
  assert.equal(s.security.enforce['claude-code'].reason, '');
  assert.match(s.security.enforce.hermes.reason, /no provider for this agent kind yet/);
  assert.equal(s.security.spend.limit, 2);
  assert.match(s.security.spend.month, /^\d{4}-\d{2}$/);
  assert.deepEqual(s.security.spend.byColumn, {});
});

test('the rule route is a page route: the agent token does not open it', async () => {
  assert.equal((await post('/api/security/set', { scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' }, agentToken)).status, 401);
});

test('Allow answers at once, with a feed line (the default for an edit inside the worktree)', async () => {
  const r = await hook(permission('Edit', { file_path: path.join(work, 'a.txt'), old_string: 'a', new_string: 'b' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.ok(await feedHas('allowed by Security: Edit inside the worktree'));
});

test('Ask holds the request as today, until the user answers', async () => {
  const ctl = new AbortController();
  const answer = hook(permission('Bash', { command: 'npm test' }), ctl.signal);
  const s = await until(async () => (await snapshot()).sessions.find((x) => x.sid === SID && x.pending.length), 'the request to wait');
  assert.equal(s.pending[0].tool, 'Bash');
  assert.equal((await page('/api/answer', { id: s.pending[0].id, allow: false })).status, 200);
  const r = await answer;
  assert.equal(r.json.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(r.json.hookSpecificOutput.decision.message, 'Declined from Agent Office.');
});

test('Deny refuses at once without a prompt, and Claude hears why', async () => {
  assert.equal((await set({ scope: 'office', row: 'shell', col: 'claude-code', value: 'deny' })).status, 200);
  const r = await hook(permission('Bash', { command: 'npm test' }));
  assert.deepEqual(r.json.hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied by the Security room: Shell commands.' });
  assert.ok(await feedHas('denied by Security: Shell commands'));
  const s = (await snapshot()).sessions.find((x) => x.sid === SID);
  assert.deepEqual(s.pending, [], 'nothing waits');
  // PreToolUse: the call is refused before Claude Code's own permission check, and it ends as failed
  const pre = await hook(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_sec_1', tool_input: { command: 'ls' } }));
  assert.deepEqual(pre.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied by the Security room: Shell commands.' } });
  const call = (await snapshot()).sessions.find((x) => x.sid === SID).calls.find((c) => c.id === 'toolu_sec_1');
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

test('the rules are saved in state.json', async () => {
  const saved = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(copy, 'state.json'), 'utf8')).security; } catch { return null; } }, 'state.json');
  assert.equal(saved.office['shell|claude-code'], 'deny');
});
