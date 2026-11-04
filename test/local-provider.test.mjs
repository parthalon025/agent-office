// Local model provider tests: a fake OpenAI-compatible server, a real tracker and the real tools in a scratch folder.
// No model, no network beyond 127.0.0.1, no cost. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTracker } from '../tracker.mjs';
import { providerEvents, checkProvider } from '../providers/index.mjs';
import { createLocal, KINDS, MAX_ROUNDS } from '../providers/local.mjs';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';

const SLEEP = 'node -e "setTimeout(()=>{},60000)"';

async function until(fn, what, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// The office side: a tracker, the events, and the holds without sockets (as server.mjs holds them).
async function rig(script, { models, kind = 'lmstudio', stallMs } = {}) {
  const fake = await startFakeOpenAI({ script, models });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-local-'));
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello file');
  const o = { fake, cwd, holds: new Map(), ids: {}, tracker: null, provider: null };
  o.tracker = createTracker({
    now: Date.now, makeId: (k) => `${k[0]}${(o.ids[k] = (o.ids[k] || 0) + 1)}`, locate: async () => null,
    setTimer: () => 0, releaseHold: (id, d) => o.release(id, d),
  });
  o.events = providerEvents({
    tracker: o.tracker,
    hold: (r) => o.holds.set(r.id, { s: r.s, suggestions: r.suggestions }),
  });
  o.release = (id, d) => {
    const h = o.holds.get(id);
    if (!h) return false;
    o.holds.delete(id); o.tracker.settle(h.s.uid, id); o.provider.answer(h.s, { id, suggestions: h.suggestions }, d || {});
    return true;
  };
  o.provider = createLocal({ events: o.events, kind, baseUrl: fake.url, stallMs });
  o.session = () => o.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'bot', cwd, headless: true, status: 'starting', provider: kind });
  // What the server does for a user message: the provider call, then the tracker marks the turn.
  o.say = (s, text) => { o.provider.message(s, { text }); o.tracker.startTurn(s, text); };
  o.done = async () => { await o.provider.close(o.tracker.sessions.get('o1') || { uid: 'o1' }); await fake.close(); fs.rmSync(base, { recursive: true, force: true }); };
  return o;
}
const last = (s) => s.replies[s.replies.length - 1]?.text;

test('the provider has the seam shape for both kinds, and talks to this machine only', () => {
  for (const kind of Object.keys(KINDS)) {
    const p = createLocal({ events: {}, kind });
    assert.doesNotThrow(() => checkProvider(p));
    assert.equal(p.kind, kind);
  }
  assert.throws(() => createLocal({ events: {}, kind: 'ollama', baseUrl: 'http://example.com/v1' }), /this machine only/);
  assert.throws(() => createLocal({ events: {}, kind: 'nope' }), /Unknown local kind/);
  assert.doesNotThrow(() => createLocal({ events: {}, kind: 'ollama', baseUrl: 'http://localhost:11434/v1' }));
});

test('readiness and models: embedding models are hidden, and a down server says what to do', async () => {
  const o = await rig([{ text: 'x' }], { models: ['llama3', 'text-embedding-bge-m3@fp16', 'qwen'] });
  try {
    assert.deepEqual(await o.provider.readiness(), { ready: true, version: '2 models', needs: [] });
    assert.deepEqual((await o.provider.models()).map((m) => m.id), ['llama3', 'qwen']);
  } finally { await o.done(); }
  const down = createLocal({ events: {}, kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1/v1' });
  const r = await down.readiness();
  assert.equal(r.ready, false);
  assert.match(r.needs[0], /LM Studio local server/);
  const empty = await rig([{ text: 'x' }], { models: ['text-embedding-only'] });
  try { assert.equal((await empty.provider.readiness()).ready, false); } finally { await empty.done(); }
});

test('check() asks for a model before a worktree is made', () => {
  const p = createLocal({ events: {}, kind: 'ollama' });
  assert.throws(() => p.check({}), (e) => e.status === 400 && /Pick a model/.test(e.message));
  assert.doesNotThrow(() => p.check({ model: 'llama3' }));
});

test('a text turn: working, then at rest with the reply, real tokens and no cost', async () => {
  const o = await rig([{ text: 'All done here.', usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'llama3' });
    assert.equal(s.model, null, 'nothing is reported before open returns');
    o.say(s, 'hi');
    assert.equal(s.status, 'working');
    await until(() => s.status === 'idle', 'the turn to end');
    assert.equal(s.model, 'llama3');
    assert.equal(last(s), 'All done here.');
    assert.equal(s.usage.tokens, 48);
    assert.equal(s.cost, 0);
    assert.equal(s.error, null);
    assert.equal(o.fake.requests[0].model, 'llama3');
    assert.equal(o.fake.requests[0].messages[1].content, 'hi');
  } finally { await o.done(); }
});

test('a low-risk tool runs at once and its result goes back to the model', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Read', args: { file_path: 'a.txt' } }] }, { text: 'It says hello.' }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'read it');
    await until(() => s.status === 'idle' && last(s) === 'It says hello.', 'the answer');
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].name, 'Read');
    assert.equal(s.calls[0].ok, true);
    const back = o.fake.requests[1].messages.at(-1);
    assert.equal(back.role, 'tool');
    assert.match(back.content, /hello file/);
    assert.equal(o.holds.size, 0, 'no question for a read');
  } finally { await o.done(); }
});

test('a risky tool waits for you: allow runs it, decline tells the model', async () => {
  const o = await rig([
    { toolCalls: [{ name: 'Write', args: { file_path: '../outside.txt', content: 'x' } }] }, // outside the folder: medium risk
    { toolCalls: [{ name: 'Bash', args: { command: 'node -e "console.log(41+1)"' } }] },
    { text: 'ok' },
  ]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => o.holds.size === 1, 'the first request');
    assert.equal(s.status, 'waiting');
    assert.equal(s.pending[0].tool, 'Write');
    o.release([...o.holds.keys()][0], { allow: false });
    await until(() => o.holds.size === 1, 'the second request');
    assert.match(o.fake.requests[1].messages.at(-1).content, /Declined from Agent Office/);
    assert.equal(fs.existsSync(path.join(o.cwd, '..', 'outside.txt')), false);
    o.release([...o.holds.keys()][0], { allow: true });
    await until(() => s.status === 'idle', 'the turn to end');
    assert.match(o.fake.requests[2].messages.at(-1).content, /42/);
    assert.equal(s.pending.length, 0);
    assert.deepEqual(s.calls.map((c) => c.ok), [false, true]);
  } finally { await o.done(); }
});

test('a request that times out (empty decision) is a decline', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Bash', args: { command: 'echo hi' } }] }, { text: 'ok' }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => o.holds.size === 1, 'the request');
    o.release([...o.holds.keys()][0], {});
    await until(() => s.status === 'idle', 'the turn to end');
    assert.match(o.fake.requests[1].messages.at(-1).content, /Declined/);
  } finally { await o.done(); }
});

test('interrupt stops a running command and the turn reads as stopped, not as an error', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Bash', args: { command: SLEEP } }] }, { text: 'never' }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => o.holds.size === 1, 'the request');
    o.release([...o.holds.keys()][0], { allow: true });
    await until(() => s.calls.some((c) => c.name === 'Bash'), 'the command to start');
    await new Promise((r) => setTimeout(r, 300));
    o.provider.interrupt(s);
    o.tracker.interrupt(s); // the server marks the interrupt after the call
    await until(() => s.status === 'idle', 'the stop');
    assert.equal(s.error, null);
    assert.equal(s.interrupted, true);
    assert.equal(o.fake.requests.length, 1, 'the model is not asked again');
  } finally { await o.done(); }
});

test('interrupt while a request waits drops it', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Bash', args: { command: 'echo hi' } }] }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => o.holds.size === 1, 'the request');
    o.provider.interrupt(s);
    o.tracker.interrupt(s);
    await until(() => s.status === 'idle', 'the stop');
    assert.equal(s.pending.length, 0);
    assert.equal(s.error, null);
  } finally { await o.done(); }
});

test('a server error ends the turn as an error with its reason', async () => {
  const o = await rig([{ status: 500 }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => s.error, 'the error');
    assert.match(s.error.text, /API Error: LM Studio answered 500: fake failure/);
    assert.equal(s.status, 'idle');
    // the next turn clears it
    o.say(s, 'again');
    assert.equal(s.error, null);
    await until(() => s.error, 'the second error');
  } finally { await o.done(); }
});

test('bad tool arguments come back to the model as a failed call, not a crash', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Read', args: '{not json' }] }, { text: 'sorry' }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => s.status === 'idle' && last(s) === 'sorry', 'the answer');
    assert.match(o.fake.requests[1].messages.at(-1).content, /not valid JSON/);
    assert.equal(s.calls[0].ok, false);
  } finally { await o.done(); }
});

test('a model that never stops asking for tools is cut at the round cap', async () => {
  const o = await rig([{ toolCalls: [{ name: 'LS', args: {} }] }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => s.error, 'the cap', 8000);
    assert.match(s.error.text, new RegExp(`all ${MAX_ROUNDS} steps`));
    assert.equal(o.fake.requests.length, MAX_ROUNDS);
  } finally { await o.done(); }
});

test('a message sent during a turn waits and runs after it', async () => {
  const o = await rig([{ text: 'first' }, { text: 'second' }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'one');
    o.say(s, 'two'); // the same tick: the turn is not over yet
    await until(() => last(s) === 'second', 'both replies');
    assert.deepEqual(o.fake.requests.map((r) => r.messages.filter((m) => m.role === 'user').map((m) => m.content)), [['one'], ['one', 'two']]);
  } finally { await o.done(); }
});

test('after close nothing is reported, and a message is refused', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Bash', args: { command: SLEEP } }] }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => o.holds.size === 1, 'the request');
    await o.provider.close(s);
    o.tracker.endSession(s, 'closed');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.status, 'ended');
    assert.equal(s.pending.length, 0);
    assert.throws(() => o.provider.message(s, { text: 'x' }), (e) => e.status === 409);
  } finally { await o.done(); }
});

test('attachments are refused, because local agents take text only', async () => {
  const o = await rig([{ text: 'x' }]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    assert.throws(() => o.provider.message(s, { text: 'x', attachments: [{ name: 'a.png' }] }), (e) => e.status === 415);
  } finally { await o.done(); }
});
