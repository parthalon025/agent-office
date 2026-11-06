// Earned trust (#153) against a real server.mjs copy: the user's answers are recorded, a proposal shows in the snapshot, it
// applies only with confirmed: true, a Secrets row is never proposed, and withdraw restores the old cell. Terminal sessions
// are made by posting Claude Code hook payloads, so no Claude Code runs and nothing is paid for.
// Run: node --test test/trust-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../src/auth.mjs';
import { officeFiles } from '../src/files.mjs';
import { startOnFreePort, until as waitUntil, START_MS, copyOffice } from './fixtures/office-server.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let base, copy, work, office, port, agentToken, pageToken;
const until = (fn, what, ms = START_MS) => waitUntil(fn, what, { ms, log: () => office?.out() ?? '' });
const post = (route, body, token, signal) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token }, body: JSON.stringify(body || {}), signal,
}).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json }; });
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
const SID = 'sid-trust-1';
const permission = (tool, input) => ({ hook_event_name: 'PermissionRequest', session_id: SID, cwd: work, tool_name: tool, tool_input: input, permission_suggestions: [] });
const sessionIn = async (cwd) => (await snapshot()).sessions.find((x) => x.cwd === cwd);
// A held request that the test answers on the page route (allow or decline), like the user.
async function answered(body, allow) {
  const ctl = new AbortController();
  const out = hook(body, ctl.signal);
  const s = await until(async () => { const x = await sessionIn(work); return x && x.pending.length ? x : null; }, `the ${body.tool_name} request to wait`);
  assert.equal((await page('/api/answer', { id: s.pending[0].id, allow })).status, 200);
  return (await out).json;
}
const trust = async () => (await snapshot()).security.trust;

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-trust-'));
  copy = path.join(base, 'office'); work = path.join(base, 'work');
  for (const d of [work, copy]) fs.mkdirSync(d);
  copyOffice(copy);
  const env = { ...process.env, OFFICE_HOOKS: 'command', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: path.join(base, 'home'), HOME: path.join(base, 'home') };
  const started = await startOnFreePort(copy, env);
  ({ office, port } = started);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).token; } catch { return null; } };
  agentToken = read(officeFiles(copy, port).token);
  pageToken = read(pageFile(started.env, port));
  assert.ok(agentToken && pageToken, 'a token file is missing');
  assert.equal((await hook({ hook_event_name: 'SessionStart', session_id: SID, cwd: work, source: 'startup' })).status, 200);
  await until(async () => (await sessionIn(work))?.place, 'the session to be placed');
});
after(async () => {
  if (office) await office.stop();
  if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test('the trust routes are page routes: the agent token does not open them', async () => {
  for (const r of ['apply', 'withdraw', 'dismiss']) assert.equal((await post(`/api/trust/${r}`, { id: 'x' }, agentToken)).status, 401, r);
});

test('five approvals propose a rule; Secrets rows get none; apply needs confirmed: true; withdraw restores the cell', async () => {
  assert.deepEqual((await trust()).proposals, []);
  // Secrets: five approved reads of a secret file are never a proposal
  for (let i = 0; i < 5; i++) await answered(permission('Read', { file_path: path.join(work, '.env') }), true);
  assert.deepEqual((await trust()).proposals, [], 'no proposal for a Secrets row');
  for (let i = 0; i < 5; i++) await answered(permission('Bash', { command: 'npm test --silent' }), true);
  const t = await until(async () => { const x = await trust(); return x.proposals.length ? x : null; }, 'a proposal');
  assert.equal(t.proposals.length, 1);
  const p = t.proposals[0];
  assert.deepEqual({ row: p.row, col: p.col, value: p.value, pattern: p.pattern, building: p.building }, { row: 'shell', col: 'claude-code', value: 'allow', pattern: 'npm test', building: '' });
  // nothing is applied by itself: the call is still held
  const ctl = new AbortController();
  const held = hook(permission('Bash', { command: 'npm test' }), ctl.signal);
  const s = await until(async () => { const x = await sessionIn(work); return x && x.pending.length ? x : null; }, 'the call to be held');
  assert.equal(s.pending.length, 1);
  ctl.abort(); // the terminal answered first: the hold goes, and it is no decision
  await held.catch(() => {});
  await until(async () => !(await sessionIn(work)).pending.length, 'the hold to go');
  assert.equal((await page('/api/trust/apply', { id: p.id })).status, 409, 'no Confirm, no rule');
  assert.deepEqual((await snapshot()).security.rules, { office: {}, buildings: {} });
  assert.equal((await page('/api/trust/apply', { id: 'nope|x|y', confirmed: true })).status, 404);
  assert.equal((await page('/api/trust/apply', { id: p.id, confirmed: true })).status, 200);
  const after1 = await snapshot();
  assert.equal(after1.security.rules.buildings['']['shell|claude-code'], 'allow');
  assert.equal(after1.security.trust.grants.length, 1);
  assert.equal(after1.security.trust.proposals.length, 0);
  const auto = await hook(permission('Bash', { command: 'npm test' }));
  assert.equal(auto.json.hookSpecificOutput.decision.behavior, 'allow');
  // withdraw: the cell is as before
  assert.equal((await page('/api/trust/withdraw', { id: p.id })).status, 200);
  const after2 = await snapshot();
  assert.deepEqual(after2.security.rules, { office: {}, buildings: {} });
  assert.equal(after2.security.trust.grants.length, 0);
  assert.equal((await page('/api/trust/withdraw', { id: p.id })).status, 404);
});
