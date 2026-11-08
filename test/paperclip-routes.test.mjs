// Paperclip HQ (#76) through a real server.mjs: off until connected, a non-loopback address refused before any request,
// the HQ part of the snapshot (company, budget, agents), Supervise in office as one PATCH only after the Confirm, a Paperclip
// run's labels from the ids that the real hook.mjs reads from its environment, the hold of a Paperclip run (no terminal
// dialog to fall back to), the feed line when Paperclip marks a run succeeded after the office denied a call, and watch only.
// The server runs from a throwaway copy of the code on a free port (test/fixtures/office-server.mjs); Paperclip is the fake
// in test/fixtures/fake-paperclip.mjs. No Claude Code runs and nothing is paid for. Run: node --test test/paperclip-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../src/auth.mjs';
import { officeFiles } from '../src/files.mjs';
import { startOnFreePort, until, copyOffice } from './fixtures/office-server.mjs';
import { startFakePaperclip, DEMO } from './fixtures/fake-paperclip.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let base, copy, work, office, port, env, agentToken, pageToken, pc;
const ADA = DEMO().agents[1], COMPANY = DEMO().companies[0];
const RUN = { PAPERCLIP_AGENT_ID: ADA.id, PAPERCLIP_COMPANY_ID: COMPANY.id, PAPERCLIP_RUN_ID: 'run-ada-7', PAPERCLIP_TASK_ID: DEMO().issues[0].id };

const call = (route, body, token, method = 'POST') => fetch(`http://127.0.0.1:${port}${route}`, {
  method, headers: { 'content-type': 'application/json', 'x-office-token': token }, ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
}).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json }; });
const page = (route, body) => call(route, body, pageToken);
const hq = async () => (await call('/api/paperclip', null, pageToken, 'GET')).json.hq;
const full = async (uid) => (await call(`/api/session?uid=${encodeURIComponent(uid)}`, null, pageToken, 'GET')).json;
const state = () => JSON.parse(fs.readFileSync(officeFiles(copy, port).state, 'utf8'));
// The sessions as the page gets them (/events, the lean snapshot), first message.
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
// The real command hook of the copy, with a hook payload on stdin and the given environment. Resolves to what it printed.
function runHook(payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...extraEnv };
    for (const k of Object.keys(e)) if (k.startsWith('PAPERCLIP_') && !(k in extraEnv)) delete e[k];
    const c = spawn(process.execPath, [path.join(copy, 'src', 'hook.mjs'), String(port)], { cwd: work, env: e, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', reject);
    c.on('exit', () => resolve(out));
    c.stdin.end(JSON.stringify(payload));
  });
}
const ev = (sid, name, extra = {}) => ({ hook_event_name: name, session_id: sid, cwd: work, ...extra });

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pc-'));
  copy = path.join(base, 'office'); work = path.join(base, 'work');
  for (const d of [copy, work, path.join(base, 'home')]) fs.mkdirSync(d);
  copyOffice(copy);
  pc = await startFakePaperclip();
  const started = await startOnFreePort(copy, { ...process.env, OFFICE_HOOKS: 'command', OFFICE_OPEN: '0', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'),
    LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: path.join(base, 'home'), HOME: path.join(base, 'home'), OFFICE_ASK_TIMEOUT_S: '1', OFFICE_PAPERCLIP_ASK_S: '4' });
  ({ office, port, env } = started);
  await office.done;
  agentToken = JSON.parse(fs.readFileSync(officeFiles(copy, port).token, 'utf8')).token;
  pageToken = JSON.parse(fs.readFileSync(pageFile(env, port), 'utf8')).token;
});
after(async () => {
  if (office) await office.stop();
  if (pc) await pc.close();
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test('off until the user connects it: no HQ in the snapshot, nothing asked of Paperclip', async () => {
  assert.equal(await hq(), null);
  assert.equal((await snapshot()).hq, null);
  assert.equal(pc.requests.length, 0);
  assert.equal(state().paperclip, undefined);
});

test('an address that is not on 127.0.0.1 is refused (400) before any request', async () => {
  for (const url of ['http://localhost:' + pc.port, 'http://192.168.1.20:3100', 'https://127.0.0.1:' + pc.port, 'http://paperclip.example.com']) {
    const r = await page('/api/paperclip/connect', { url });
    assert.equal(r.status, 400, url);
    assert.match(r.json.error, /The office connects only to a Paperclip on this computer, at http:\/\/127\.0\.0\.1:<port>/);
  }
  assert.equal(pc.requests.length, 0, 'no request left the office');
  assert.equal(await hq(), null);
});

test('connect: the HQ in the snapshot with its company, budget, agents and routines; the connection is kept', async () => {
  const r = await page('/api/paperclip/connect', { url: pc.url });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.ok, r.json.company], [true, COMPANY.id]);
  await until(async () => (await hq())?.state === 'on', 'the live events');
  const s = (await snapshot()).hq;
  assert.equal(s.company.name, 'Acme Robotics');
  assert.deepEqual(s.budget, { spent: 12.4, limit: 100 });
  assert.deepEqual(s.agents.map((a) => [a.name, a.role, a.supervision.state]), [['Grace', 'CEO', 'unsupervised'], ['Ada', 'Engineer', 'unsupervised'], ['Linus', 'DevOps', 'unsupervised']]);
  assert.equal(s.routines[0].title, 'Weekly status report');
  assert.deepEqual(state().paperclip, { url: pc.url, company: COMPANY.id }, 'state.json keeps the address and company, no secret');
});

test('the HQ building (#197): floors from the org chart and the Lobby in the snapshot, the fuller model on GET /api/hq/lobby, no key or secret in any answer', async () => {
  const s = (await snapshot()).hq;
  assert.deepEqual(s.floors.map((f) => f.key), ['records', 'lobby', 'rank-2', 'rank-1', 'rank-0']);
  assert.equal(s.floors.at(-1).employees[0].name, 'Grace');
  assert.deepEqual([s.lobby.employees.total, s.lobby.tasks.open, s.lobby.approvals.pending, s.lobby.goals.total, s.lobby.secrets.names], [3, 2, 1, 2, ['GITHUB_TOKEN']]);
  const r = await call('/api/hq/lobby', null, pageToken, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.hq.goals.length, 2);
  assert.equal(r.json.hq.approvals[0].type, 'hire_agent');
  assert.equal(r.json.hq.activity.length, 2);
  const agent = await call('/api/hq/lobby', null, agentToken, 'GET');
  assert.equal(agent.status, 401, 'the agent token never opens an HQ route');
  const all = JSON.stringify(r.json) + JSON.stringify(s);
  assert.doesNotMatch(all, new RegExp(`do-not-show|${pageToken}|${agentToken}`), 'a secret value, an approval payload, activity details and the tokens never leave the office');
  assert.equal(pc.requests.filter((q) => q.method !== 'GET' && q.method !== 'UPGRADE').length, 0, 'reading the HQ sent no write');
});

test('the Costs view (#208): GET /api/hq/costs gives months and budgets to the page, never to the agent token, and reads only', async () => {
  const r = await call('/api/hq/costs', null, pageToken, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.costs.months.length, 3);
  assert.ok(r.json.costs.months.every((m) => /^\d{4}-\d{2}$/.test(m.key)));
  assert.ok(Array.isArray(r.json.costs.budgets), 'the budgets of the company');
  assert.equal((await call('/api/hq/costs', null, agentToken, 'GET')).status, 401);
  assert.doesNotMatch(JSON.stringify(r.json), new RegExp(`do-not-show|${pageToken}|${agentToken}`));
  assert.equal(pc.requests.filter((q) => q.method !== 'GET' && q.method !== 'UPGRADE').length, 0);
});

test('the catalog (#212): GET /api/hq/catalog gives skills, secret names, plugins and adapters to the page only; no secret value or file reaches any page response', async () => {
  const r = await call('/api/hq/catalog', null, pageToken, 'GET');
  assert.equal(r.status, 200);
  const c = r.json.catalog;
  assert.deepEqual(c.skills.map((x) => [x.name, x.key]), [['Code review', 'acme/review']]);
  assert.deepEqual(c.secrets, [{ id: 's1', name: 'GITHUB_TOKEN', provider: 'local_encrypted' }]);
  assert.deepEqual(c.plugins.map((x) => [x.name, x.status]), [['acme.linear', 'ready']]);
  assert.deepEqual(c.adapters.map((x) => [x.type, x.source]), [['claude_local', 'builtin'], ['agent_office', 'external']]);
  assert.equal((await call('/api/hq/catalog', null, agentToken, 'GET')).status, 401, 'the agent token never opens an HQ route');
  // every page route that carries Paperclip data, and the snapshot: none holds a secret value, a skill file, a manifest or a path
  const bodies = [r.json, (await call('/api/hq/lobby', null, pageToken, 'GET')).json, (await call('/api/hq/costs', null, pageToken, 'GET')).json, (await call('/api/paperclip', null, pageToken, 'GET')).json, await snapshot()];
  assert.doesNotMatch(JSON.stringify(bodies), new RegExp(`do-not-show|secret-path|${pageToken}|${agentToken}`));
  assert.equal(pc.requests.filter((q) => q.method !== 'GET' && q.method !== 'UPGRADE').length, 0, 'the catalog only reads');
});

test('the page never calls Paperclip: no Paperclip route in any page script', () => {
  for (const f of fs.readdirSync(path.join(SRC, 'public')).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(SRC, 'public', f), 'utf8');
    assert.doesNotMatch(code, /\/api\/companies\/|\/api\/cli-auth|\/api\/board-api-keys/, `${f} names a Paperclip route`);
  }
});

test('the snapshot plans field carries the Paperclip plan beside the office goals, read only (#157)', async () => {
  const s = await snapshot();
  const p = s.plans.plans.find((x) => x.source === 'paperclip');
  assert.ok(p, 'the Paperclip plan is on the board');
  assert.deepEqual([p.sourceWord, p.frozen, p.steps.length > 0], ['Paperclip', false, true]);
  assert.deepEqual(s.plans.unreadable, []);
});

test('org chart editor (#202): the snapshot carries the cables; the reporting line is a write of the HQ write grid (#198): Confirm asks, Deny refuses and turns the editor read only', async () => {
  const s = await snapshot();
  assert.ok(Array.isArray(s.hq.cables) && s.hq.cables.length === 2, 'cables in the snapshot');
  assert.equal(s.hq.reportingWrite, true, 'the grid does not deny reporting lines by default: the editor is writable');
  assert.equal(s.hq.superviseWrite, true, 'Supervise in office is not denied by the grid by default: the wall shows its button');
  assert.equal(s.hq.goalWrite, true, 'goal writes are not denied by the grid by default (Confirm): the goal forms show');
  assert.equal(s.hq.approvalWrite, true, 'approval writes are not denied by the grid by default (Confirm): the decision buttons show');
  assert.deepEqual(s.hq.goals.rows.map((r) => [r.title, r.depth, r.owner]), [['Ship the Q1 roadmap', 0, 'Grace'], ['Health route', 1, 'Ada']], 'the executive floor goals are a tree with owner names');
  const [grace, ada, linus] = DEMO().agents;
  const patches = () => pc.requests.filter((q) => q.method === 'PATCH').length;
  const before = patches();
  const ask = await page('/api/hq/reporting-line', { agent: linus.id, manager: grace.id });
  assert.equal(ask.status, 409);
  assert.equal(ask.json.confirm, 'write');
  assert.equal(ask.json.write.kind, 'reporting');
  assert.equal(ask.json.write.summary, 'Make Linus report to Grace', 'the question names both employees');
  const bad = await page('/api/hq/reporting-line', { agent: grace.id, manager: linus.id, confirmed: true });
  assert.equal(bad.status, 400, 'a loop is refused first');
  assert.equal(patches(), before, 'neither the question nor the refusal sent a PATCH');
  const deny = await page('/api/hq/grid/set', { kind: 'reporting', value: 'deny' });
  assert.equal(deny.status, 200);
  assert.equal((await snapshot()).hq.reportingWrite, false, 'Deny: the editor is read only');
  const refused = await page('/api/hq/reporting-line', { agent: linus.id, manager: grace.id, confirmed: true });
  assert.equal(refused.status, 403);
  assert.equal(patches(), before);
  assert.equal((await page('/api/hq/grid/set', { kind: 'reporting', value: null, confirmed: true })).status, 200);
  const done = await page('/api/hq/reporting-line', { agent: linus.id, manager: grace.id, confirmed: true });
  assert.equal(done.status, 200);
  assert.equal(patches(), before + 1);
  assert.equal((await page('/api/hq/reporting-line', { agent: linus.id, manager: ada.id, confirmed: true })).status, 200, 'and back, for the tests after this one');
});

test('Supervise in office: 409 without the Confirm (no PATCH), then one PATCH with this office\'s own hooks file', async () => {
  const no = await page('/api/paperclip/supervise', { agent: ADA.id });
  assert.equal(no.status, 409);
  assert.match(no.json.error, /Confirm Supervise in office first/);
  const p0 = pc.requests.filter((q) => q.method === 'PATCH').length;   // the two reporting line writes of the test before are earlier PATCHes
  assert.equal(p0, 2);
  const ok = await page('/api/paperclip/supervise', { agent: ADA.id, confirmed: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.ok, ok.json.supervision.state], [true, 'supervised']);
  const patches = pc.requests.filter((q) => q.method === 'PATCH').slice(p0);
  assert.equal(patches.length, 1);
  const hooksFile = officeFiles(copy, port).hooksCmd.replace(/\\/g, '/');
  assert.deepEqual(patches[0].body, { adapterConfig: { engine: 'cli', dangerouslySkipPermissions: false, extraArgs: ['--max-turns', '8', '--permission-mode', 'default', '--settings', hooksFile] } });
  assert.ok(fs.existsSync(hooksFile), 'the file Paperclip now passes to Claude Code is this office\'s command hooks file');
  assert.equal((await hq()).agents.find((a) => a.id === ADA.id).supervision.state, 'supervised');
  // an agent the office cannot set up: 409 with the reason, and still one PATCH
  const linus = await page('/api/paperclip/supervise', { agent: DEMO().agents[2].id, confirmed: true });
  assert.equal(linus.status, 409);
  assert.match(linus.json.error, /codex_local, not Claude Code/);
  assert.equal(pc.requests.filter((q) => q.method === 'PATCH').length, 3, 'still one Supervise PATCH, after the two reporting line PATCHes');
});

test('a Paperclip run is labelled from the ids hook.mjs reads in its environment; its held call waits longer and is denied with a reason', async () => {
  // a Paperclip run of Ada, through the real command hook (the environment Paperclip gives Claude Code), and a plain terminal session
  await runHook(ev('sid-pc-run', 'UserPromptSubmit', { prompt: 'Paperclip wake-up text' }), RUN);
  await runHook(ev('sid-plain', 'UserPromptSubmit', { prompt: 'plain' }));
  const both = await until(async () => { const l = (await snapshot()).sessions.filter((s) => s.cwd === work); return l.length === 2 ? l : null; }, 'two sessions');
  const run = both.find((s) => s.hq), plain = both.find((s) => !s.hq);
  assert.ok(run && plain, JSON.stringify(both.map((s) => s.hq)));
  assert.deepEqual(run.hq, { agent: 'Ada', role: 'Backend engineer', company: 'Acme Robotics', task: 'ACM-12 Add a health route to the API', budget: { spent: 8.3, limit: 50 }, run: 'run-ada-7' });
  assert.equal(plain.hq, null);
  // A made-up id in a hook body is no label: only an agent of the watched company counts
  await runHook(ev('sid-fake', 'UserPromptSubmit', { prompt: 'x' }), { PAPERCLIP_AGENT_ID: 'nobody', PAPERCLIP_COMPANY_ID: COMPANY.id });

  // Both ask. The plain one goes back to its terminal after 1 s (OFFICE_ASK_TIMEOUT_S); the Paperclip run has no terminal, so it waits.
  const runAsk = runHook(ev('sid-pc-run', 'PermissionRequest', { tool_name: 'Write', tool_input: { file_path: path.join(work, 'hello.txt'), content: 'hi' }, permission_suggestions: [] }), RUN);
  const plainAsk = runHook(ev('sid-plain', 'PermissionRequest', { tool_name: 'Write', tool_input: { file_path: path.join(work, 'b.txt'), content: 'b' }, permission_suggestions: [] }));
  await until(async () => (await full(plain.uid)).session.pending.length === 1 && (await full(run.uid)).session.pending.length === 1, 'both requests held');
  assert.equal(await plainAsk, '', 'the plain request went back to the terminal dialog: no decision');
  assert.ok((await full(plain.uid)).feed.some((f) => f.text === 'question went back to the terminal'));
  assert.equal((await full(run.uid)).session.pending.length, 1, 'the Paperclip run still waits');
  // then it ends with the office's own deny, which says why (fail closed)
  const out = JSON.parse(await runAsk);
  assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'deny', message: 'Agent Office got no answer in time, so this call is denied.' });
  assert.ok((await full(run.uid)).feed.some((f) => f.text === 'question timed out, the office denied the call. Paperclip may still mark this run succeeded.'));
  // Paperclip marks the run succeeded anyway (spike #75): the feed says the office denied a call of it
  pc.emit('heartbeat.run.status', { runId: 'run-ada-7', agentId: ADA.id, status: 'succeeded', error: null });
  await until(async () => (await full(run.uid)).feed.some((f) => f.text === 'Paperclip marked this run succeeded, but the office denied a call of it that waited with no answer.'), 'the feed line');
});

// Review 76, finding 5: the hold follows from the run having no terminal (claude --print), not from the office knowing its
// company. The company match is only for the labels.
test('a run with Paperclip ids of a company the office does not watch has no label, but its held call still waits and ends in a deny', async () => {
  const OTHER = { PAPERCLIP_AGENT_ID: ADA.id, PAPERCLIP_COMPANY_ID: 'c-not-watched', PAPERCLIP_RUN_ID: 'run-other-1' };
  await runHook(ev('sid-pc-other', 'UserPromptSubmit', { prompt: 'a run of a company not watched' }), OTHER);
  const s = await until(async () => (await snapshot()).sessions.find((x) => x.prompt === 'a run of a company not watched'), 'the session', { ms: 15000 });
  assert.equal(s.hq, null, 'no label: not an agent of the watched company');
  const t0 = Date.now();
  const out = await runHook(ev('sid-pc-other', 'PermissionRequest', { tool_name: 'Write', tool_input: { file_path: path.join(work, 'c.txt'), content: 'c' }, permission_suggestions: [] }), OTHER);
  assert.notEqual(out, '', 'not sent back to a terminal dialog: a --print run has none');
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'deny', message: 'Agent Office got no answer in time, so this call is denied.' });
  assert.ok(Date.now() - t0 >= 3500, `it waited the Paperclip hold (4 s here), not the terminal one (1 s): ${Date.now() - t0} ms`);
  assert.ok((await full(s.uid)).feed.some((f) => f.text === 'question timed out, the office denied the call. Paperclip may still mark this run succeeded.'));
});

test('watch only: the office only read Paperclip, apart from the one Supervise PATCH and the two reporting line PATCHes; Disconnect forgets the connection', async () => {
  const methods = pc.requests.map((q) => q.method);
  assert.deepEqual([...new Set(methods)].sort(), ['GET', 'PATCH', 'UPGRADE']);
  assert.equal(methods.filter((m) => m === 'PATCH').length, 3);
  assert.ok(pc.requests.every((q) => q.method !== 'POST'), 'no heartbeat, no task, no routine run');
  assert.equal((await page('/api/paperclip/disconnect', {})).status, 200);
  assert.equal(await hq(), null);
  assert.equal(state().paperclip, undefined);
  await until(() => pc.sockets() === 0, 'the events socket closed');
});
