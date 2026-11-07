// The office adapter all the way through (#200): a stand-in Paperclip adapter host loads the real plugin; the plugin talks HTTP to a thin
// front of the office core (the real office, in process); the run opens a local-model session through the provider seam against the fake
// OpenAI server. A call the agent makes is held in Needs you until the test answers it as the user would, and the result, usage and cost
// come back to the host. No Paperclip, no paid call. Opening sessions is only implemented for Windows.
// Run: node --test test/paperclip-adapter-routes.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';
import { loadAdapter } from './fixtures/fake-paperclip-host.mjs';
import { freePort } from './fixtures/office-server.mjs';

const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'integrations', 'paperclip-adapter');
let base, work, rig, fake, front, tokenFile;
const until = async (fn, what, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 25)); } };

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pc-adapter-routes-'));
  work = path.join(base, 'work'); fs.mkdirSync(work);
  fake = await startFakeOpenAI({ script: [{ text: 'ok' }] });
  const noServer = `http://127.0.0.1:${await freePort()}/v1`;
  rig = await startInProcess({ dir: base, port: 4392, env: { OFFICE_OLLAMA_URL: fake.url, OFFICE_LMSTUDIO_URL: noServer, OFFICE_FOUNDRY_ENDPOINT: '', OFFICE_COPILOTSTUDIO_ENDPOINT: '' } });
  // The front: what the HTTP server does for an agent route, minus the gate (the gate has its own tests): parse the body, call the core.
  front = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const ctl = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
      const out = await rig.office.core.handle({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(b || '{}'), signal: ctl.signal });
      if (ctl.signal.aborted) return;
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  tokenFile = path.join(base, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: 'agent-token', port: front.address().port }));
});
after(async () => {
  if (front) { front.closeAllConnections?.(); front.close(); }
  if (rig) rig.stop();
  if (fake) await fake.close();
  if (base) await removeTree(base);
});

// The lean snapshot the page gets has no Paperclip ids; the whole session (GET /api/session) has. The session of one run that has a call waiting:
const fullOf = async (uid) => (await rig.call('/api/session?uid=' + encodeURIComponent(uid))).json?.session;
const waitingRun = (runId, what) => until(async () => {
  for (const s of rig.snapshot().sessions.filter((x) => x.pending.length)) { const f = await fullOf(s.uid); if (f?.paperclip?.run === runId) return s; }
  return null;
}, what);
const config = (over = {}) => ({ tokenFile, agentKind: 'ollama', model: 'fake-model', cwd: work, ...over });

test('the run routes are agent routes: the agent token opens them, the page token does not', { skip: SKIP }, () => {
  for (const r of ['start', 'wait', 'cancel']) assert.equal(rig.office.core.groupOf('POST', `/hook/paperclip/run/${r}`), 'agent', r);
});

test('a call of the run waits in Needs you until the user answers; then the run ends and result, usage and cost reach the host', { skip: SKIP }, async () => {
  fake.reset([{ toolCalls: [{ name: 'Bash', args: { command: 'echo from-paperclip' } }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } }, { text: 'All done.', usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 } }]);
  const host = await loadAdapter(DIR);
  let settled = false;
  const running = host.run({ config: config(), context: { taskId: 'task-9', issueIdentifier: 'ACM-12', issueTitle: 'Say hello', wakeReason: 'issue_assigned' }, runId: 'run-e2e-1' }).finally(() => { settled = true; });
  const waiting = await waitingRun('run-e2e-1', 'the call to wait in Needs you');
  assert.equal(waiting.provider, 'ollama');
  assert.equal(waiting.name, 'Ada');
  assert.deepEqual([waiting.pending.length, waiting.pending[0].tool], [1, 'Bash'], 'every call cell is Ask: nothing is answered for the user');
  const desk = { wake: 'issue_assigned', resumed: false, fresh: 'Paperclip saved no earlier session for this employee.', instructions: null, skills: [] };
  assert.deepEqual((await fullOf(waiting.uid)).paperclip, { agent: 'agent-1', company: 'co-1', run: 'run-e2e-1', task: 'task-9', desk });
  assert.deepEqual(waiting.deskCtx, desk, 'the page gets the run context in its snapshot (#206)');
  assert.equal(fake.requests[0].messages.at(-1).content.includes('ACM-12 Say hello'), true, 'the task reached the agent in its prompt');
  // The desk screen shows the run's transcript (#211): the session says it is a run, and the page route gives the log, live.
  assert.equal(waiting.paperclipRun, true, 'the snapshot marks the session as a Paperclip run');
  const live = (await rig.call('/api/paperclip/transcript?uid=' + encodeURIComponent(waiting.uid))).json;
  assert.equal(live.done, false);
  assert.match(live.lines.map((l) => l.text).join('\n'), /Waiting for your answer in Agent Office \(Needs you\): Bash echo from-paperclip/);
  assert.equal((await rig.call('/api/paperclip/transcript?uid=nope')).status, 404, 'a session that is not a run has no transcript');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(settled, false, 'the run does not end while the call waits');
  assert.equal((await rig.call('/api/answer', { id: waiting.pending[0].id, allow: true })).status, 200);
  const { result, logs } = await running;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.summary, 'All done.');
  assert.equal(result.costUsd, 0, 'a local model reports a cost of 0');
  assert.equal(result.costStatus, 'reported');
  assert.deepEqual(result.usage && Object.keys(result.usage).sort(), ['cachedInputTokens', 'inputTokens', 'outputTokens']);
  assert.equal(result.provider, 'ollama');
  const text = logs.map((l) => l[1]).join('');
  assert.match(text, /> Bash echo from-paperclip/);
  assert.match(text, /Waiting for your answer in Agent Office \(Needs you\): Bash echo from-paperclip/);
  assert.match(text, /All done\./);
  assert.match(text, /\[agent-office\] The run finished\./);
  const kept = (await rig.call('/api/paperclip/transcript?uid=' + encodeURIComponent(waiting.uid))).json;
  assert.equal(kept.done, true, 'the transcript stays after the run ends');
  assert.match(kept.lines.map((l) => l.text).join('\n'), /All done\./);
  // The session ended with its run and is a past session.
  const past = await until(async () => (await rig.call('/api/history', {})).json.sessions.find((h) => h.uid === waiting.uid), 'the past record');
  assert.equal(past.provider, 'ollama');
  assert.equal(rig.snapshot().sessions.some((s) => s.uid === waiting.uid && s.status !== 'ended'), false);
});

test('a call the user declines is declined for the agent, and the run still ends with the agent\'s own answer', { skip: SKIP }, async () => {
  fake.reset([{ toolCalls: [{ name: 'Bash', args: { command: 'rm -rf everything' } }] }, { text: 'I did not run it.' }]);
  const running = (await loadAdapter(DIR)).run({ config: config(), runId: 'run-e2e-2' });
  const waiting = await waitingRun('run-e2e-2', 'the call to wait');
  assert.equal((await rig.call('/api/answer', { id: waiting.pending[0].id, allow: false })).status, 200);
  const { result, logs } = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'I did not run it.');
  assert.equal(fake.requests[1].messages.some((m) => m.role === 'tool' && /declin|denied|not allowed/i.test(String(m.content))), true, 'the agent was told');
  assert.match(logs.map((l) => l[1]).join(''), /x Bash rm -rf everything/);
});

test('the user closing the session in the office ends the run as failed, with the reason', { skip: SKIP }, async () => {
  fake.reset([{ toolCalls: [{ name: 'Bash', args: { command: 'sleep 99' } }] }, { text: 'never' }]);
  const running = (await loadAdapter(DIR)).run({ config: config(), runId: 'run-e2e-3' });
  const waiting = await waitingRun('run-e2e-3', 'the call to wait');
  assert.equal((await rig.call('/api/close', { uid: waiting.uid })).status, 200);
  const { result } = await running;
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage, /closed|ended/i);
});

test('a kind the office refuses (an ungated agent that is off) fails the run with the office\'s words and opens no session', { skip: SKIP }, async () => {
  const before = rig.snapshot().sessions.length;
  const { result } = await (await loadAdapter(DIR)).run({ config: config({ agentKind: 'hermes', model: undefined }), runId: 'run-e2e-4' });
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage, /^Agent Office refused the run: /);
  assert.equal(rig.snapshot().sessions.length, before);
});

test('an unknown agent kind and a start with a bad body are refused, not guessed', { skip: SKIP }, async () => {
  const unknown = await (await loadAdapter(DIR)).run({ config: config({ agentKind: 'nonesuch' }), runId: 'run-e2e-5' });
  assert.match(unknown.result.errorMessage, /^Agent Office refused the run: /);
  assert.equal((await rig.call('/hook/paperclip/run/start', { run_id: '../x' })).status, 400);
  assert.equal((await rig.call('/hook/paperclip/run/wait', { key: 'nope' })).status, 404);
  assert.equal((await rig.call('/hook/paperclip/run/cancel', { key: 'nope' })).status, 404);
});
