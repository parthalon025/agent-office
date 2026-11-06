// Earned trust (#153) through the office core, in process: the user's answers are recorded, a proposal shows in the snapshot, it
// applies only with confirmed: true, a Secrets row is never proposed, and withdraw restores the old cell. Terminal sessions
// are made by posting Claude Code hook payloads, so no Claude Code runs and nothing is paid for. The office is the real one
// (src/office.mjs) called through core.handle; the gate (which token opens a route) is tested on real HTTP in test/auth.test.mjs.
// Run: node --test test/trust-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { until as waitUntil } from './fixtures/office-server.mjs';

let base, work, rig;
const until = (fn, what, ms = 20000) => waitUntil(fn, what, { ms });
const page = (route, body) => rig.call(route, body || {});
const hook = (body, signal) => rig.hook(body, signal);
const snapshot = async () => rig.snapshot();
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
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  rig = await startInProcess({ dir: base });
  assert.equal((await hook({ hook_event_name: 'SessionStart', session_id: SID, cwd: work, source: 'startup' })).status, 200);
  await until(async () => (await sessionIn(work))?.place, 'the session to be placed');
});
after(async () => {
  if (rig) rig.stop();
  if (base) await removeTree(base);
});

test('the trust routes are page routes in the route table, so the agent token does not open them', () => {
  for (const r of ['apply', 'withdraw', 'dismiss']) assert.equal(rig.office.core.groupOf('POST', `/api/trust/${r}`), 'page', r);
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
  await held;
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
