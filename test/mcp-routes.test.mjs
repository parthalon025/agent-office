// The /mcp/* routes (office_inbox, office_room, office_ask), and the same office tools called by a local agent in-process,
// against a real server.mjs. The server runs from a throwaway copy of the code, so its state, hook files and .office-token
// stay out of this folder and a running office is never touched. A random port, a fake OpenAI server on 127.0.0.1 for the
// local provider, no model, no Claude. Sessions are opened through /api/open, which is Windows-only, so other systems skip.
// Run: npm test
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
let base, work, child, port, token, fake, log = '';

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
const call = (route, body, { auth = true } = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-office-token': token } : {}) }, body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
// A local agent session, opened as the page opens one. Its uid is also its office id.
async function open(name) {
  const r = await call('/api/open', { cwd: work, name, provider: 'ollama', model: 'fake-model', where: 'office' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.uid;
}
// The sessions the server shows: the first snapshot of the event stream.
async function snapshot() {
  const ctl = new AbortController();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/events?t=${token}`, { signal: ctl.signal });
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
const sessionOf = async (uid) => (await snapshot()).sessions.find((s) => s.uid === uid);

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mcp-'));
  const copy = path.join(base, 'office');
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !['state.json', 'history.json'].includes(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  fake = await startFakeOpenAI({ script: [{ text: 'ok' }], models: ['fake-model'] });
  port = await freePort();
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: copy, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OFFICE_PORT: String(port), OFFICE_HOOKS: 'command', OFFICE_OLLAMA_URL: fake.url, OFFICE_RATE_FILE: path.join(base, 'no-rate.json') },
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  token = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(copy, '.office-token'), 'utf8')).token; } catch { return null; } }, 'the server to listen');
});
after(async () => {
  if (child) child.kill();
  if (fake) await fake.close();
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
});

test('every /mcp route needs the token', { skip: SKIP }, async () => {
  for (const r of ['/mcp/inbox', '/mcp/ask', '/mcp/room', '/mcp/room/update']) assert.equal((await call(r, {}, { auth: false })).status, 401, r);
});

test('an unknown caller is told so: inbox and ask answer text, room answers 404', { skip: SKIP }, async () => {
  const inbox = await call('/mcp/inbox', { office_id: 'nobody' });
  assert.equal(inbox.status, 200);
  assert.match(inbox.json.text, /does not recognise this session/);
  const ask = await call('/mcp/ask', { office_id: 'nobody', question: 'hi?' });
  assert.equal(ask.status, 200);
  assert.match(ask.json.text, /does not recognise this session/);
  const room = await call('/mcp/room', { office_id: 'nobody' });
  assert.equal(room.status, 404);
  assert.match(room.json.error, /does not recognise this session/);
});

test('the local providers are registered, and an unknown agent kind is refused', { skip: SKIP }, async () => {
  const bad = await call('/api/open', { cwd: work, provider: 'nope', model: 'm' });
  assert.equal(bad.status, 400);
  const noModel = await call('/api/open', { cwd: work, provider: 'ollama' });
  assert.equal(noModel.status, 400);
  assert.match(noModel.json.error, /Pick a model/);
  const info = await fetch(`http://127.0.0.1:${port}/api/providers`, { headers: { 'x-office-token': token } }).then((r) => r.json());
  const kinds = info.providers.map((p) => p.kind);
  assert.deepEqual(kinds.sort(), ['claude-code', 'lmstudio', 'ollama']);
  const ollama = info.providers.find((p) => p.kind === 'ollama');
  assert.equal(ollama.ready, true);
  assert.deepEqual(ollama.models.map((m) => m.id), ['fake-model']);
});

test('office_inbox returns what the user sent during a turn, once', { skip: SKIP }, async () => {
  fake.reset([{ text: 'slow answer', delayMs: 1200 }]);
  const uid = await open('inbox');
  assert.equal((await call('/mcp/inbox', { office_id: uid })).json.text, 'No new messages.');
  assert.equal((await call('/api/message', { uid, text: 'start' })).json.sent, true);
  const sent = await call('/api/message', { uid, text: 'please read me' }); // the turn is running, so it waits in the inbox
  assert.equal(sent.json.queued, 1);
  assert.equal((await call('/mcp/inbox', { office_id: uid })).json.text, '- please read me');
  assert.equal((await call('/mcp/inbox', { office_id: uid })).json.text, 'No new messages.');
  await until(async () => (await sessionOf(uid)).status === 'idle', 'the turn to end');
});

test('office_room describes the room, and office_room_update checks its arguments', { skip: SKIP }, async () => {
  const uid = await open('room');
  const room = await call('/mcp/room', { office_id: uid });
  assert.equal(room.status, 200);
  assert.match(room.json.text, /notes board/i);
  assert.equal((await call('/mcp/room/update', { office_id: uid })).status, 400);
  assert.equal((await call('/mcp/room/update', { office_id: uid, notes_append: 'a', notes_replace: 'b' })).status, 400);
  const ok = await call('/mcp/room/update', { office_id: uid, pin: 'Deploy at 5' });
  assert.equal(ok.status, 200);
  assert.match(ok.json.text, /Pinned on the blackboard: "Deploy at 5"/);
});

test('office_ask waits, and the next message the user sends is its answer', { skip: SKIP }, async () => {
  const uid = await open('ask');
  const waiting = call('/mcp/ask', { office_id: uid, question: 'Deploy now?' });
  const s = await until(async () => { const x = await sessionOf(uid); return x.questions.length ? x : null; }, 'the question to show');
  assert.equal(s.questions[0].text, 'Deploy now?');
  assert.equal((await call('/api/message', { uid, text: 'yes, go ahead' })).json.answered, true);
  const answer = await waiting;
  assert.equal(answer.status, 200);
  assert.equal(answer.json.text, 'yes, go ahead');
  assert.equal((await sessionOf(uid)).questions.length, 0);
});

test('a local agent calls office_ask in-process: the user answers, and the model gets the answer', { skip: SKIP }, async () => {
  fake.reset([{ toolCalls: [{ name: 'office_ask', args: { question: 'Ship it?' } }] }, { text: 'shipping' }]);
  const uid = await open('inproc');
  await call('/api/message', { uid, text: 'go' });
  const s = await until(async () => { const x = await sessionOf(uid); return x.questions.length ? x : null; }, 'the question to show');
  assert.equal(s.questions[0].text, 'Ship it?');
  assert.equal(s.status, 'waiting');
  assert.equal((await call('/api/message', { uid, text: 'yes' })).json.answered, true);
  await until(async () => (await sessionOf(uid)).status === 'idle', 'the turn to end');
  assert.ok(fake.requests[0].tools.some((t) => t.function.name === 'office_ask'));
  assert.equal(fake.requests[1].messages.at(-1).role, 'tool');
  assert.equal(fake.requests[1].messages.at(-1).content, 'yes');
});

test('a past local session reopens as a fresh local session in the same folder', { skip: SKIP }, async () => {
  fake.reset([{ text: 'hello there' }]);
  const uid = await open('past');
  await call('/api/message', { uid, text: 'hi' });
  await until(async () => (await sessionOf(uid)).status === 'idle', 'the turn to end');
  assert.equal((await call('/api/close', { uid })).status, 200);
  const rec = await until(async () => {
    const h = await call('/api/history', {});
    return (h.json.sessions || []).find((x) => x.uid === uid);
  }, 'the past session in the history');
  assert.ok(rec, 'the closed local session is in the history');
  const re = await call('/api/reopen', { uid });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const s = await sessionOf(re.json.uid);
  assert.notEqual(re.json.uid, uid);
  assert.equal(s.provider, 'ollama');
  assert.equal(s.model, 'fake-model', 'the same model as the past session');
  assert.equal(s.cwd.toLowerCase(), work.toLowerCase());
  const snap = await snapshot();
  assert.ok(snap.feed.some((f) => /cannot resume a past session/.test(f.text || '')), 'the feed says why it is a new session');
});
