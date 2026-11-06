// Manager goals through a real server.mjs (#156, spec #130): start, approve, cancel, retry, reload the office and see the same board, and one planner per building (a connected Paperclip company refuses an office goal until confirmed).
// The server runs from a throwaway copy on a free port (test/fixtures/office-server.mjs). The agents are terminal sessions that the test makes with
// hooks, so no Claude Code runs and nothing is paid for. Run: node --test test/goal-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../auth.mjs';
import { officeFiles } from '../files.mjs';
import { startOnFreePort, startOffice, until as untilLong } from './fixtures/office-server.mjs';
const until = (fn, what) => untilLong(fn, what, { ms: 20000, log: () => JSON.stringify(dump) });
let dump = null;
import { startFakePaperclip } from './fixtures/fake-paperclip.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let base, copy, work, office, port, env, agentToken, pageToken, pc, boot;

const call = (route, body, token, method = 'POST') => fetch(`http://127.0.0.1:${port}${route}`, {
  method, headers: { 'content-type': 'application/json', 'x-office-token': token }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
}).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json }; });
const page = (route, body) => call(route, body, pageToken);
const hook = (sid, name, extra = {}) => call('/hook', { hook_event_name: name, session_id: sid, cwd: work, ...extra }, agentToken);
const full = async (sid) => (await call('/api/sessions', null, pageToken, 'GET')).json;
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
const plans = async () => { const s = await snapshot(); dump = { plans: s.plans, sessions: s.sessions.map((x) => [x.uid, x.status, x.place && x.place.buildingKey, !!x.error]) }; return s.plans; };
const planOf = async (id) => (await plans()).plans.find((p) => p.id === id);
const state = () => JSON.parse(fs.readFileSync(officeFiles(copy, port).state, 'utf8'));
const up = async (again) => {
  if (again) { office = startOffice(copy, env); await office.done; } else { const started = await startOnFreePort(copy, boot); ({ office, port, env } = started); await office.done; }
  agentToken = JSON.parse(fs.readFileSync(officeFiles(copy, port).token, 'utf8')).token;
  pageToken = JSON.parse(fs.readFileSync(pageFile(env, port), 'utf8')).token;
};
// An agent that is idle in the building: a terminal session that has taken one turn.
async function seat(sid) {
  const known = new Set((await snapshot()).sessions.map((x) => x.uid));
  await hook(sid, 'SessionStart');
  await hook(sid, 'UserPromptSubmit', { prompt: 'hello' });
  await hook(sid, 'Stop');
  const uid = await until(async () => (await snapshot()).sessions.find((x) => !known.has(x.uid) && x.status === 'idle')?.uid, 'the idle agent');
  return uid;
}
const GOAL = 'Find the bug\nFix the bug';

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-goal-'));
  copy = path.join(base, 'office'); work = path.join(base, 'work');
  for (const d of [copy, work, path.join(base, 'home')]) fs.mkdirSync(d);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !/^(state|history)(-\d+)?\.json$/.test(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  pc = await startFakePaperclip();
  boot = { ...process.env, OFFICE_HOOKS: 'command', OFFICE_OPEN: '0', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'),
    LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: path.join(base, 'home'), HOME: path.join(base, 'home') };
  await up();
});
after(async () => {
  if (office) await office.stop();
  if (pc) await pc.close();
  await new Promise((r) => setTimeout(r, 300));
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test('start holds the plan for approval; nothing is sent before it, and the board has the Office source', async () => {
  await seat('a-1');
  const r = await page('/api/goal/start', { building: '', goal: GOAL });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = await planOf(r.json.id);
  assert.equal(p.source, 'office'); assert.equal(p.sourceWord, 'Office'); assert.equal(p.status, 'awaiting-approval');
  assert.deepEqual(p.steps.map((s) => [s.title, s.state]), [['Find the bug', 'pending'], ['Fix the bug', 'pending']]);
  const a = await page('/api/goal/approve', { id: r.json.id });
  assert.equal(a.status, 200);
  await until(async () => (await planOf(r.json.id)).steps[0].state === 'working', 'the first step to go to the agent');
  assert.equal((await planOf(r.json.id)).steps[0].owner.length > 0, true);
  assert.equal((await page('/api/goal/approve', { id: r.json.id })).status, 409, 'approve twice');
  // The agent's turn ends: the next step follows, then the goal is done.
  await hook('a-1', 'UserPromptSubmit', { prompt: 'Find the bug' }); await hook('a-1', 'Stop');
  await until(async () => (await planOf(r.json.id)).steps[1].state === 'working', 'the second step');
  await hook('a-1', 'UserPromptSubmit', { prompt: 'Fix the bug' }); await hook('a-1', 'Stop');
  await until(async () => (await planOf(r.json.id)).status === 'finished', 'the goal to finish');
});

test('cancel stops an open goal; an empty goal is 400', async () => {
  const r = await page('/api/goal/start', { building: '', goal: 'One step' });
  assert.equal((await page('/api/goal/cancel', { id: r.json.id })).status, 200);
  assert.equal((await planOf(r.json.id)).status, 'cancelled');
  assert.equal((await page('/api/goal/cancel', { id: r.json.id })).status, 409);
  assert.equal((await page('/api/goal/start', { building: '', goal: '  ' })).status, 400);
  assert.equal((await page('/api/goal/start', { building: '', goal: 'x', spendLimit: 'abc' })).status, 400);
});

test('a failed step offers retry; a goal waits for a free agent when none is idle', async () => {
  const r = await page('/api/goal/start', { building: '', goal: 'Risky step', approveFirst: false });
  await until(async () => (await planOf(r.json.id)).steps[0].state === 'working', 'the step to start');
  await hook('a-1', 'UserPromptSubmit', { prompt: 'Risky step' });
  await hook('a-1', 'SessionEnd', { reason: 'other' });
  await until(async () => (await planOf(r.json.id)).steps[0].state === 'error', 'the error step');
  assert.equal((await planOf(r.json.id)).status, 'blocked');
  await seat('a-2');
  const t = await page('/api/goal/retry', { id: r.json.id, step: (await planOf(r.json.id)).steps[0].id });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  await until(async () => (await planOf(r.json.id)).steps[0].state === 'working', 'the retry');
  assert.equal((await page('/api/goal/retry', { id: r.json.id, step: 'nope' })).status, 409);
});

test('reload the office: the same board, a running step is an error step to retry', async () => {
  const mid = await page('/api/goal/start', { building: '', goal: 'Held plan' });
  const before = (await planOf(mid.json.id));
  assert.equal(state().goals.some((g) => g.id === mid.json.id), true, 'goals are saved in the state file');
  const ids = (await plans()).plans.map((p) => p.id).sort();
  await office.stop();
  await up(true);
  assert.deepEqual((await plans()).plans.map((p) => p.id).sort(), ids);
  const after = await planOf(mid.json.id);
  assert.deepEqual([after.status, after.steps.map((s) => s.title)], [before.status, before.steps.map((s) => s.title)]);
  assert.equal((await page('/api/goal/approve', { id: mid.json.id })).status, 200, 'a held plan can still be approved');
});

test('one planner per building: a connected Paperclip company refuses an office goal (409) until confirmed', async () => {
  const c = await page('/api/paperclip/connect', { url: pc.url });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const n = (await plans()).plans.length;
  const r = await page('/api/goal/start', { building: '', goal: 'Second planner' });
  assert.equal(r.status, 409);
  assert.equal(r.json.confirm, 'goal');
  assert.match(r.json.error, /Paperclip plans the work/);
  assert.equal((await plans()).plans.length, n, 'nothing was planned');
  const ok = await page('/api/goal/start', { building: '', goal: 'Second planner', confirmed: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await plans()).plans.length, n + 1);
});
