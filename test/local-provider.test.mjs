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
import { cleanRules, setRule, decide } from '../security.mjs';
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
// rules: the Security room rules (security.mjs); the tracker checks them before a hold, as the server's tracker does,
// and a decision is answered at once on a later tick (the server's holdRequest).
async function rig(script, { models, kind = 'lmstudio', stallMs, officeTools, rules = cleanRules(null) } = {}) {
  const fake = await startFakeOpenAI({ script, models });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-local-'));
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello file');
  const o = { fake, cwd, holds: new Map(), ids: {}, tracker: null, provider: null };
  o.tracker = createTracker({
    now: Date.now, makeId: (k) => `${k[0]}${(o.ids[k] = (o.ids[k] || 0) + 1)}`, locate: async () => null,
    setTimer: () => 0, releaseHold: (id, d) => o.release(id, d),
    screen: (s, p, opts) => decide(rules, { building: null, kind: s.provider, tool: p.tool_name, input: p.full_input || p.tool_input, root: o.tracker.rootOf(s), provider: opts.provider }),
  });
  o.events = providerEvents({
    tracker: o.tracker,
    hold: (r) => (r.auto ? setImmediate(() => o.provider.answer(r.s, { id: r.id, suggestions: [] }, r.auto)) : o.holds.set(r.id, { s: r.s, suggestions: r.suggestions })),
  });
  o.release = (id, d) => {
    const h = o.holds.get(id);
    if (!h) return false;
    o.holds.delete(id); o.tracker.settle(h.s.uid, id); o.provider.answer(h.s, { id, suggestions: h.suggestions }, d || {});
    return true;
  };
  o.provider = createLocal({ events: o.events, kind, baseUrl: fake.url, stallMs, officeTools });
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
  assert.throws(() => p.check({ cwd: 'x' }), (e) => e.status === 400 && /Pick a model/.test(e.message));
  assert.doesNotThrow(() => p.check({ model: 'llama3' }));
  assert.doesNotThrow(() => p.check({}), 'check({}) only asks whether a session can start (Reopen)');
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

// ---------- the Security room rules decide before a hold (#70) ----------
const rule = (row, value, r = cleanRules(null)) => setRule(r, { scope: 'office', row, col: 'local', value, confirmed: true }).rules;

test('a Deny rule refuses a call at once: no hold, the model hears why, one feed line', async () => {
  const o = await rig([{ toolCalls: [{ name: 'Bash', args: { command: 'node -e "console.log(1)"' } }] }, { text: 'ok' }], { rules: rule('shell', 'deny') });
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => s.status === 'idle', 'the turn to end');
    assert.equal(o.holds.size, 0, 'nothing waited for the user');
    assert.match(o.fake.requests[1].messages.at(-1).content, /Denied by the Security room: Shell commands/);
    assert.deepEqual(s.calls.map((c) => c.ok), [false]);
    assert.ok(o.tracker.feed.some((f) => f.text === 'denied by Security: Shell commands'));
  } finally { await o.done(); }
});

test('a tightened read is held; an Allow on shell commands runs one without a hold, with a feed line', async () => {
  const o = await rig([
    { toolCalls: [{ name: 'Read', args: { file_path: 'a.txt' } }] },
    { toolCalls: [{ name: 'Bash', args: { command: 'node -e "console.log(41+1)"' } }] },
    { text: 'ok' },
  ], { rules: rule('shell', 'allow', rule('read-inside', 'ask')) });
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => o.holds.size === 1, 'the read to wait');
    assert.equal(s.pending[0].tool, 'Read');
    o.release([...o.holds.keys()][0], { allow: true });
    await until(() => s.status === 'idle', 'the turn to end');
    assert.match(o.fake.requests[2].messages.at(-1).content, /42/);
    assert.ok(o.tracker.feed.some((f) => f.text === 'allowed by Security: Shell commands'));
    assert.ok(!o.tracker.feed.some((f) => /Read inside/.test(f.text)), 'a held request writes no automatic line');
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

test('a message sent during a turn reaches the model: on a tool result, and as a new message when the turn would end', async () => {
  const o = await rig([
    { toolCalls: [{ name: 'LS', args: {} }], delayMs: 150 },
    { text: 'first answer', delayMs: 150 },
    { text: 'second answer' },
  ]);
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'start');
    await until(() => o.fake.requests.length === 1, 'the first model call');
    s.inbox.push({ t: Date.now(), text: 'also check the tests' }); // the server queues a message while the turn runs
    await until(() => o.fake.requests.length === 2, 'the model call after the tool');
    s.inbox.push({ t: Date.now(), text: 'and run them' }); // a second message while the model writes its answer
    await until(() => s.status === 'idle' && last(s) === 'second answer', 'the turn to go on and end');
    assert.match(o.fake.requests[1].messages.at(-1).content, /Message from the user in Agent Office:\n- also check the tests/);
    const third = o.fake.requests[2].messages.at(-1);
    assert.equal(third.role, 'user');
    assert.match(third.content, /and run them/);
  } finally { await o.done(); }
});

test('the office tools run in-process, need no approval, and are offered only when the server gives them', async () => {
  const calls = [];
  const officeTools = {
    inbox: async (s) => { calls.push(['inbox', s.uid]); return 'No new messages.'; },
    ask: async (s, q) => { calls.push(['ask', q]); return 'Yes.'; },
    room: async () => 'Room: lab',
    roomUpdate: async (s, a) => { calls.push(['update', a]); throw Object.assign(new Error('Give notes_append, notes_replace or pin.'), { status: 400 }); },
  };
  const o = await rig([
    { toolCalls: [{ name: 'office_ask', args: { question: 'Deploy now?' } }, { name: 'office_room', args: {} }, { name: 'office_room_update', args: {} }] },
    { text: 'asked' },
  ], { officeTools });
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'ask the owner');
    await until(() => s.status === 'idle' && last(s) === 'asked', 'the answer');
    assert.equal(o.holds.size, 0, 'an office tool is not a permission request');
    const names = o.fake.requests[0].tools.map((t) => t.function.name);
    for (const n of ['office_inbox', 'office_ask', 'office_room', 'office_room_update', 'Read']) assert.ok(names.includes(n), n);
    const back = o.fake.requests[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.deepEqual(back, ['Yes.', 'Room: lab', 'Give notes_append, notes_replace or pin.']);
    assert.deepEqual(calls, [['ask', 'Deploy now?'], ['update', {}]]);
    assert.deepEqual(s.calls.map((c) => c.ok), [true, true, false]);
  } finally { await o.done(); }
  const bare = await rig([{ text: 'x' }]);
  try {
    const s = bare.session();
    bare.provider.open(s, { model: 'm' });
    bare.say(s, 'hi');
    await until(() => s.status === 'idle', 'the turn');
    assert.equal(bare.fake.requests[0].tools.some((t) => /^office_/.test(t.function.name)), false);
  } finally { await bare.done(); }
});

// LM Studio can run its own MCP servers (for example run-command). Any extra request field or endpoint could hand a tool call to them,
// past riskOf and the approval check. So the chat request has exactly these keys and goes to one endpoint.
const CHAT_KEYS = ['messages', 'model', 'stream', 'stream_options', 'tools'];

test('the chat request carries only model, messages, tools, stream and stream_options, to /chat/completions only', async () => {
  for (const withOffice of [false, true]) {
    const officeTools = withOffice ? { inbox: async () => 'none', ask: async () => 'y', room: async () => 'r', roomUpdate: async () => 'u' } : undefined;
    const o = await rig([
      { toolCalls: [{ name: 'Read', args: { file_path: 'a.txt' } }, ...(withOffice ? [{ name: 'office_room', args: {} }] : [])] },
      { toolCalls: [{ name: 'Bash', args: { command: 'echo hi' } }] },
      { text: 'done' },
    ], { officeTools, kind: withOffice ? 'lmstudio' : 'ollama' });
    try {
      const s = o.session();
      o.provider.open(s, { model: 'm' });
      o.say(s, 'go');
      await until(() => o.holds.size === 1, 'the Bash approval');
      o.release([...o.holds.keys()][0], { allow: true });
      await until(() => s.status === 'idle' && last(s) === 'done', 'the answer');
      const label = withOffice ? 'with office tools' : 'without office tools';
      assert.equal(o.fake.requests.length, 3, 'one request per round, ' + label);
      for (const [i, body] of o.fake.requests.entries()) {
        assert.deepEqual(Object.keys(body).sort(), CHAT_KEYS, `request ${i} keys, ${label}`);
        assert.equal(body.stream, true);
        assert.deepEqual(body.stream_options, { include_usage: true });
        assert.ok(Array.isArray(body.tools) && body.tools.every((t) => t.type === 'function' && Object.keys(t).sort().join() === 'function,type'), 'tools are plain function definitions');
      }
      assert.ok(o.fake.calls.length >= 3);
      for (const c of o.fake.calls) assert.deepEqual(c, { method: 'POST', path: '/v1/chat/completions' }, 'the only call a session makes');
    } finally { await o.done(); }
  }
});

test('office_ask waits for the user and an interrupt frees it', async () => {
  let release;
  const officeTools = { inbox() {}, room() {}, roomUpdate() {}, ask: () => new Promise((r) => { release = r; }) };
  const o = await rig([{ toolCalls: [{ name: 'office_ask', args: { question: 'ok?' } }] }, { text: 'never' }], { officeTools });
  try {
    const s = o.session();
    o.provider.open(s, { model: 'm' });
    o.say(s, 'go');
    await until(() => release, 'the question');
    o.provider.interrupt(s);
    o.tracker.interrupt(s);
    release({ text: 'No.' }.text); // the server drops the question, which frees the waiting call
    await until(() => s.status === 'idle', 'the stop');
    assert.equal(s.error, null);
    assert.equal(o.fake.requests.length, 1);
  } finally { await o.done(); }
});

test('a local agent says it cannot resume a past session', () => {
  assert.equal(createLocal({ events: {}, kind: 'ollama' }).canResume, false);
});
