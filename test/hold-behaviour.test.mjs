// Hold behaviour (#173, prefactor for #168 tickets 6 and 7): what a held permission request or question does today, pinned
// through the HTTP interface of a real server.mjs copy, so the tests survive the move of the hold code into its own module.
// Terminal sessions are made by posting Claude Code hook payloads, local agents run against a fake OpenAI server: no paid call.
// Pinned: the hold waits for the user; a timeout is no decision and no trust evidence; a terminal timeout goes back to the
// terminal and says so; a Paperclip run is denied with a reason (paperclip-routes.test.mjs has the full run); a hook the
// terminal answered first (cancel) frees its hold; an unknown or answered id is 409; Always allow is refused for a high-risk
// request; office_ask is answered by the page and freed by a closed request; the explanation is added text and never a decision;
// the ledger records the user's answers only. Provider-side waits are pinned in local-provider.test.mjs (interrupt frees a
// request), providers.test.mjs (events.drop) and acp-provider.test.mjs (withdraw).
// Run: node --test test/hold-behaviour.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageFile } from '../src/auth.mjs';
import { officeFiles } from '../src/files.mjs';
import { startOnFreePort, until as waitUntil, START_MS, copyOffice, freePort } from './fixtures/office-server.mjs';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';

let base, copy, work, office, port, agentToken, pageToken, fake;
const until = (fn, what, ms = START_MS) => waitUntil(fn, what, { ms, log: () => office?.out() ?? '' });
const post = (route, body, token, signal) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token }, body: JSON.stringify(body || {}), signal,
}).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text }; });
const page = (route, body) => post(route, body, pageToken);
const agent = (route, body, signal) => post(route, body, agentToken, signal);
const hook = (body, signal) => agent('/hook/http', body, signal);
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
const full = async (uid) => (await fetch(`http://127.0.0.1:${port}/api/session?uid=${encodeURIComponent(uid)}`, { headers: { 'x-office-token': pageToken } })).json();
const ledger = () => { try { return JSON.parse(fs.readFileSync(officeFiles(copy, port).state, 'utf8')).trust?.ledger ?? []; } catch { return []; } };
const SID = 'sid-hold-1';
// The lean snapshot has no session id, so each hook session sits in a folder of its own and is found by that folder.
const cwdOf = (sid) => { const d = path.join(work, sid); fs.mkdirSync(d, { recursive: true }); return d; };
const permission = (tool, input, sid = SID) => ({ hook_event_name: 'PermissionRequest', session_id: sid, cwd: cwdOf(sid), tool_name: tool, tool_input: input, permission_suggestions: [] });
const sessionBy = async (sid) => (await snapshot()).sessions.find((x) => x.cwd === cwdOf(sid));
const waiting = (sid, what) => until(async () => { const x = await sessionBy(sid); return x && x.pending.length ? x : null; }, what);
const decisionOf = (r) => r.json?.hookSpecificOutput?.decision;

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hold-'));
  copy = path.join(base, 'office'); work = path.join(base, 'work');
  for (const d of [work, copy, path.join(base, 'home')]) fs.mkdirSync(d);
  copyOffice(copy);
  // A fake local model: it explains held requests (LM Studio kind) and runs the local agent that asks a question (Ollama kind).
  fake = await startFakeOpenAI({ script: [{ text: 'Intent: Run the test script.\nReason: The agent wants to check its change.' }], models: ['fake-model'] });
  const env = { ...process.env, OFFICE_HOOKS: 'command', OFFICE_EXPLAIN: 'on', OFFICE_ASK_TIMEOUT_S: '4', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), OFFICE_OPEN: '0',
    OFFICE_LMSTUDIO_URL: fake.url, OFFICE_OLLAMA_URL: `http://127.0.0.1:${await freePort()}/v1`,
    LOCALAPPDATA: path.join(base, 'local'), USERPROFILE: path.join(base, 'home'), HOME: path.join(base, 'home') };
  const started = await startOnFreePort(copy, env);
  ({ office, port } = started);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).token; } catch { return null; } };
  agentToken = read(officeFiles(copy, port).token);
  pageToken = read(pageFile(started.env, port));
  assert.ok(agentToken && pageToken, 'a token file is missing');
});
after(async () => {
  if (office) await office.stop();
  if (fake) await fake.close();
  if (base) fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test('a terminal request waits, goes back to the terminal after its hold with no decision, and the feed says so', async () => {
  const t0 = Date.now();
  const out = hook(permission('Bash', { command: 'echo timeout-case' }));
  const s = await waiting(SID, 'the request to be held');
  assert.equal(s.pending.length, 1);
  const r = await out;
  assert.deepEqual(r.json, {}, 'no decision: the terminal dialog answers');
  assert.ok(Date.now() - t0 >= 3500, `it waited its hold (4 s here): ${Date.now() - t0} ms`);
  const x = await sessionBy(SID);
  assert.equal(x.pending.length, 0, 'the hold is gone');
  assert.ok((await full(x.uid)).feed.some((f) => f.text === 'question went back to the terminal'));
  assert.equal((await page('/api/answer', { id: s.pending[0].id, allow: true })).status, 409, 'a hold that ended cannot be answered');
});

test('a timed-out request is no trust evidence: five of them leave the ledger and the proposals empty', async () => {
  const before = ledger().length;
  await Promise.all([1, 2, 3, 4, 5].map((i) => hook(permission('Bash', { command: 'npm test --silent' }, 'sid-hold-t' + i))));
  assert.equal(ledger().length, before);
  assert.deepEqual((await snapshot()).security.trust.proposals, []);
});

test('the user answers: allow gives the allow reply, decline gives a deny reply, and each is one ledger entry', async () => {
  const before = ledger().length;
  for (const allow of [true, false]) {
    const ctl = new AbortController();
    const out = hook(permission('Bash', { command: allow ? 'echo yes-case' : 'echo no-case' }), ctl.signal);
    const s = await waiting(SID, 'the request to be held');
    assert.equal((await page('/api/answer', { id: s.pending[0].id, allow })).status, 200);
    assert.equal(decisionOf(await out).behavior, allow ? 'allow' : 'deny');
    assert.equal((await sessionBy(SID)).pending.length, 0);
  }
  await until(() => ledger().length === before + 2, 'two ledger entries');
  assert.deepEqual(ledger().slice(-2).map((e) => e.allow), [true, false]);
  assert.equal((await post('/api/answer', { id: 'no-such-id', allow: true }, pageToken)).status, 409, 'an unknown id is 409');
});

test('a request the terminal answered first (the hook is cancelled) frees its hold and records nothing', async () => {
  const before = ledger().length;
  const ctl = new AbortController();
  const out = hook(permission('Bash', { command: 'echo cancel-case' }), ctl.signal);
  const s = await waiting(SID, 'the request to be held');
  const id = s.pending[0].id;
  ctl.abort();
  await out.catch(() => {});
  await until(async () => !(await sessionBy(SID)).pending.length, 'the hold to go');
  assert.equal((await page('/api/answer', { id, allow: true })).status, 409);
  assert.equal(ledger().length, before);
});

test('Always allow is refused with 400 for a high-risk request, and the request still waits', async () => {
  const ctl = new AbortController();
  const out = hook(permission('Write', { file_path: path.join(cwdOf(SID), '.vscode', 'tasks.json'), content: '{}' }), ctl.signal);
  const s = await waiting(SID, 'the request to be held');
  assert.equal(s.pending[0].risk, 'high');
  assert.equal((await page('/api/answer', { id: s.pending[0].id, allow: true, always: true })).status, 400);
  assert.equal((await sessionBy(SID)).pending.length, 1, 'still held');
  assert.equal((await page('/api/answer', { id: s.pending[0].id, allow: false })).status, 200);
  assert.equal(decisionOf(await out).behavior, 'deny');
});

test('the explanation is added text: the request keeps its raw command, and answering is the only decision', async () => {
  const ctl = new AbortController();
  const out = hook(permission('Bash', { command: 'npm test --explained' }), ctl.signal);
  const s = await until(async () => { const x = await sessionBy(SID); return x?.pending[0]?.explain ? x : null; }, 'the explanation to arrive');
  const r = s.pending[0];
  assert.equal(r.explain.intent, 'Run the test script.');
  assert.equal(r.explain.reason, 'The agent wants to check its change.');
  assert.match(r.detail, /npm test --explained/, 'the raw command is the request\'s own text');
  assert.equal(s.pending.length, 1, 'the explanation decided nothing');
  await page('/api/answer', { id: r.id, allow: false });
  assert.equal(decisionOf(await out).behavior, 'deny');
});

test('office_ask is held until the page answers it: yes and no are the text of the answer, and the hold is gone', { skip: process.platform !== 'win32' && 'opening sessions is only implemented for Windows' }, async () => {
  const opened = await page('/api/open', { cwd: work, name: 'asker', provider: 'ollama', model: 'fake-model', where: 'office', isolation: 'same' });
  assert.equal(opened.status, 200, opened.text);
  const uid = opened.json.uid;
  for (const [allow, text] of [[true, 'Yes.'], [false, 'No.']]) {
    const asked = agent('/mcp/ask', { office_id: uid, question: 'Ship it?' });
    const s = await until(async () => { const x = (await full(uid)).session; return x.questions.length ? x : null; }, 'the question to show');
    assert.equal((await page('/api/answer', { id: s.questions[0].id, allow })).status, 200);
    const a = await asked;
    assert.equal(a.json.text, text);
    assert.equal((await full(uid)).session.questions.length, 0);
  }
});

test('office_ask: a request the agent closed frees the question', { skip: process.platform !== 'win32' && 'opening sessions is only implemented for Windows' }, async () => {
  const uid = (await snapshot()).sessions.find((x) => x.name === 'asker').uid;
  const ctl = new AbortController();
  const asked = agent('/mcp/ask', { office_id: uid, question: 'Still there?' }, ctl.signal);
  const s = await until(async () => { const x = (await full(uid)).session; return x.questions.length ? x : null; }, 'the question to show');
  ctl.abort();
  await asked.catch(() => {});
  await until(async () => !(await full(uid)).session.questions.length, 'the question to go');
  assert.equal((await page('/api/answer', { id: s.questions[0].id, allow: true })).status, 409);
});
