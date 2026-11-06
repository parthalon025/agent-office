// Azure AI Foundry and Copilot Studio provider tests (#24). A fake service on 127.0.0.1 (test/fixtures/fake-azure.mjs), a real tracker.
// No Azure account, no sign-in, no cost. The cloud kinds are off until configured: the first tests check that they stay off and
// make no call. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/tracker.mjs';
import { providerEvents, checkProvider, createRegistry } from '../src/providers/index.mjs';
import { cloudConfig, checkEndpoint, readSse, explain } from '../src/providers/cloud.mjs';
import { createFoundry, FOUNDRY_HOSTS } from '../src/providers/foundry.mjs';
import { createCopilotStudio, STUDIO_HOSTS } from '../src/providers/copilot-studio.mjs';
import { startFakeFoundry, startFakeCopilotStudio } from './fixtures/fake-azure.mjs';

const TOKEN = 'tok_' + 'abcdef0123456789'.repeat(3);
async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const noFetch = () => { throw new Error('The office must not call the network when a kind is not configured.'); };

// The office side: a tracker, the events, the holds without sockets (as server.mjs holds them).
function office(make, kind) {
  const o = { holds: new Map(), ids: {}, tracker: null, provider: null };
  o.tracker = createTracker({
    now: Date.now, makeId: (k) => `${k[0]}${(o.ids[k] = (o.ids[k] || 0) + 1)}`, locate: async () => null,
    setTimer: () => 0, releaseHold: (id, d) => o.release(id, d),
  });
  o.events = providerEvents({ tracker: o.tracker, hold: (r) => o.holds.set(r.id, { s: r.s, suggestions: r.suggestions }) });
  o.release = (id, d) => {
    const h = o.holds.get(id);
    if (!h) return false;
    o.holds.delete(id); o.tracker.settle(h.s.uid, id); o.provider.answer(h.s, { id, suggestions: h.suggestions }, d || {});
    return true;
  };
  o.provider = make(o.events);
  o.session = (budget = null, model = 'asst_1') => {
    const s = o.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'bot', cwd: process.cwd(), headless: true, status: 'starting', provider: kind, budget });
    o.provider.open(s, { model, budget });
    return s;
  };
  o.say = (s, text) => { o.provider.message(s, { text }); o.tracker.startTurn(s, text); };
  // What server.mjs sendMessage does: a session that works gets the message in its inbox, and a hook hands it out.
  o.send = (s, text) => { if (s.status === 'working') s.inbox.push({ t: Date.now(), text }); else o.say(s, text); };
  // Runs fn(s, p) on every hook a provider reports, before the tracker reads it.
  o.onHook = (fn) => { const orig = o.events.hook; o.events.hook = (s, p) => { fn(s, p); return orig(s, p); }; };
  return o;
}
const idle = (s) => s.status === 'idle' || s.status === 'waiting';
const last = (s) => s.replies[s.replies.length - 1]?.text;

// ---------- Foundry ----------
const run = (o = {}) => ({ id: 'run_1', object: 'thread.run', model: 'gpt-4o', status: 'in_progress', ...o });
const delta = (text) => ['thread.message.delta', { id: 'msg_1', object: 'thread.message.delta', delta: { content: [{ index: 0, type: 'text', text: { value: text } }] } }];
const said = (text) => ['thread.message.completed', { id: 'msg_1', object: 'thread.message', content: [{ type: 'text', text: { value: text } }] }];
const done = (u = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) => ['thread.run.completed', run({ status: 'completed', usage: u })];
const start = [['thread.run.created', run({ status: 'queued' })], ['thread.run.in_progress', run()]];
const toolStep = (calls, status = 'completed', extra = {}) => ['thread.run.step.' + status, { id: 'step_1', run_id: 'run_1', type: 'tool_calls', status, created_at: 100, completed_at: 102, step_details: { type: 'tool_calls', tool_calls: calls }, ...extra }];
const approval = (calls) => ['thread.run.requires_action', run({ status: 'requires_action', required_action: { type: 'submit_tool_approval', submit_tool_approval: { tool_calls: calls } } })];

async function foundry(script, { env = {}, budget = null, agents, runInfo, stallMs = 2000 } = {}) {
  const fake = await startFakeFoundry({ script, agents, runInfo });
  const config = cloudConfig({ OFFICE_FOUNDRY_ENDPOINT: fake.url, OFFICE_FOUNDRY_TOKEN: TOKEN, ...env }, 'OFFICE_FOUNDRY');
  const o = office((events) => createFoundry({ events, config, allowLoopback: true, stallMs, pollMs: 5 }), 'foundry');
  o.fake = fake; o.s = o.session(budget);
  o.runCalls = () => fake.calls.filter((c) => c.method === 'POST' && /\/runs$|submit_tool_outputs$/.test(c.path));
  o.done = () => fake.close();
  return o;
}

test('both providers have the seam shape, are paid and cloud, and are off with no settings', async () => {
  const f = createFoundry({ events: {}, config: cloudConfig({}, 'OFFICE_FOUNDRY'), fetch: noFetch });
  const c = createCopilotStudio({ events: {}, config: cloudConfig({}, 'OFFICE_COPILOTSTUDIO'), fetch: noFetch });
  for (const p of [f, c]) {
    assert.doesNotThrow(() => checkProvider(p));
    assert.equal(p.paid, true);
    assert.equal(p.cloud, true);
    assert.equal(p.canResume, false);
    assert.equal(typeof p.openWindow, 'undefined');
  }
  assert.equal(f.kind, 'foundry');
  assert.equal(c.kind, 'copilot-studio');
  assert.equal(f.needsModel, true);
  assert.equal(f.modelLabel, 'Foundry agent');
  assert.notEqual(c.needsModel, true);
  const reg = createRegistry([f, c]);
  assert.deepEqual(reg.kinds().map((k) => [k.kind, k.cloud, k.paid]), [['foundry', true, true], ['copilot-studio', true, true]]);
});

test('with no settings a kind says Not configured with the steps, and makes no call', async () => {
  const f = createFoundry({ events: {}, config: cloudConfig({}, 'OFFICE_FOUNDRY'), fetch: noFetch });
  const r = await f.readiness();
  assert.equal(r.ready, false);
  assert.equal(r.configured, false);
  assert.match(r.needs.join('\n'), /OFFICE_FOUNDRY_ENDPOINT/);
  assert.match(r.needs.join('\n'), /OFFICE_FOUNDRY_TOKEN_FILE/);
  assert.match(r.needs.join('\n'), /docs\/agents\.md/);
  assert.deepEqual(await f.models(), []);
  assert.throws(() => f.check({}), (e) => e.status === 409 && /not configured/i.test(e.message));
  assert.throws(() => f.check({ model: 'asst_1' }), (e) => e.status === 409);
  const c = createCopilotStudio({ events: {}, config: cloudConfig({}, 'OFFICE_COPILOTSTUDIO'), fetch: noFetch });
  const rc = await c.readiness();
  assert.equal(rc.configured, false);
  assert.match(rc.needs.join('\n'), /OFFICE_COPILOTSTUDIO_ENDPOINT/);
  assert.throws(() => c.check({}), (e) => e.status === 409);
  // The registry status carries the flag to the page.
  const st = await createRegistry([f, c]).status();
  assert.deepEqual(st.map((x) => [x.kind, x.ready, x.configured]), [['foundry', false, false], ['copilot-studio', false, false]]);
});

test('an endpoint with a missing token names only the token step; a bad endpoint is Not configured, with the reason', async () => {
  const onlyEndpoint = createFoundry({ events: {}, config: cloudConfig({ OFFICE_FOUNDRY_ENDPOINT: 'https://acme.services.ai.azure.com/api/projects/p1' }, 'OFFICE_FOUNDRY'), fetch: noFetch });
  const r = await onlyEndpoint.readiness();
  assert.equal(r.configured, false);
  assert.doesNotMatch(r.needs.join('\n'), /OFFICE_FOUNDRY_ENDPOINT/);
  assert.match(r.needs.join('\n'), /OFFICE_FOUNDRY_TOKEN/);
  for (const [raw, word] of [
    ['http://acme.services.ai.azure.com/api/projects/p1', /https/],
    ['https://evil.example.com/api/projects/p1', /Microsoft host/],
    ['https://user:pw@acme.services.ai.azure.com/api/projects/p1', /user name/],
    ['https://acme.services.ai.azure.com.evil.com/api', /Microsoft host/],
    ['not a url', /valid address/],
  ]) {
    const p = createFoundry({ events: {}, config: cloudConfig({ OFFICE_FOUNDRY_ENDPOINT: raw, OFFICE_FOUNDRY_TOKEN: TOKEN }, 'OFFICE_FOUNDRY'), fetch: noFetch });
    const x = await p.readiness();
    assert.equal(x.configured, false, raw);
    assert.match(x.needs.join('\n'), word, raw);
  }
  // Loopback http is for tests only: the default refuses it.
  assert.ok(checkEndpoint('http://127.0.0.1:9/x', { suffixes: FOUNDRY_HOSTS, allowLoopback: true }).url);
  assert.ok(checkEndpoint('http://127.0.0.1:9/x', { suffixes: FOUNDRY_HOSTS }).problem);
  assert.ok(checkEndpoint('https://acme.services.ai.azure.com/api/projects/p', { suffixes: FOUNDRY_HOSTS }).url);
  assert.ok(checkEndpoint('https://acme.environment.api.powerplatform.com/x', { suffixes: STUDIO_HOSTS }).url);
});

test('the token comes from the user: a fixed value or a file read at each call; a malformed one counts as none', () => {
  assert.equal(cloudConfig({ P_TOKEN: TOKEN }, 'P').getToken(), TOKEN);
  let file = TOKEN + '\n';
  const c = cloudConfig({ P_TOKEN_FILE: 'tok.txt' }, 'P', () => file);
  assert.equal(c.getToken(), TOKEN, 'a line break at the end is trimmed');
  file = 'tok_' + 'z'.repeat(30);
  assert.equal(c.getToken(), file, 'a new token in the file works with no restart');
  assert.equal(cloudConfig({ P_TOKEN: 'short' }, 'P').getToken(), null);
  assert.equal(cloudConfig({ P_TOKEN: 'abc def ghi jkl mno pqr' }, 'P').getToken(), null, 'a space cannot split a header');
  assert.equal(cloudConfig({ P_TOKEN_FILE: 'missing.txt' }, 'P', () => { throw new Error('ENOENT'); }).getToken(), null);
  assert.equal(cloudConfig({}, 'P').hasToken, false);
});

test('Foundry readiness lists the agents with the token as a bearer, and asks no model to answer', async () => {
  const o = await foundry([{ events: [] }], { agents: [{ id: 'asst_9', name: 'Reviewer', model: 'gpt-4o' }, { id: 'asst_2', name: null, model: 'gpt-4.1' }] });
  try {
    const r = await o.provider.readiness();
    assert.deepEqual(r, { ready: true, configured: true, version: '2 agents', needs: [] });
    assert.deepEqual(await o.provider.models(), [{ id: 'asst_9', label: 'Reviewer (gpt-4o)' }, { id: 'asst_2', label: 'asst_2 (gpt-4.1)' }]);
    const gets = o.fake.calls.filter((c) => c.method === 'GET');
    assert.ok(gets.length >= 1 && gets.every((c) => c.path === '/assistants' && c.auth === 'Bearer ' + TOKEN && c.query['api-version']));
    assert.equal(o.fake.calls.filter((c) => c.method !== 'GET').length, 0, 'readiness only reads');
  } finally { await o.done(); }
});

test('Foundry readiness: a refused token says to make a new one, and the token is never in the words', async () => {
  const fake = await startFakeFoundry({});
  const p = createFoundry({ events: {}, config: cloudConfig({ OFFICE_FOUNDRY_ENDPOINT: fake.url + '/nope', OFFICE_FOUNDRY_TOKEN: TOKEN }, 'OFFICE_FOUNDRY'), allowLoopback: true });
  try {
    const r = await p.readiness();
    assert.equal(r.ready, false);
    assert.equal(r.configured, true, 'the settings are there; the service said no');
    assert.doesNotMatch(r.needs.join('\n'), new RegExp(TOKEN));
  } finally { await fake.close(); }
  assert.match(explain('Foundry', 401, '', TOKEN), /refused the token.*new token/);
  assert.doesNotMatch(explain('Foundry', 500, 'bad ' + TOKEN + ' here', TOKEN), new RegExp(TOKEN));
});

test('check() wants an agent for Foundry, and a Copilot Studio agent takes none', async () => {
  const o = await foundry([{ events: [] }]);
  try {
    assert.doesNotThrow(() => o.provider.check({}));
    assert.doesNotThrow(() => o.provider.check({ model: 'asst_abc-1' }));
    assert.throws(() => o.provider.check({ model: '' }), (e) => e.status === 400 && /Pick an agent/.test(e.message));
    assert.throws(() => o.provider.check({ model: 'asst 1; rm' }), (e) => e.status === 400);
  } finally { await o.done(); }
  const fake = await startFakeCopilotStudio({});
  try {
    const c = createCopilotStudio({ events: {}, config: cloudConfig({ OFFICE_COPILOTSTUDIO_ENDPOINT: fake.url, OFFICE_COPILOTSTUDIO_TOKEN: TOKEN }, 'OFFICE_COPILOTSTUDIO'), allowLoopback: true });
    assert.doesNotThrow(() => c.check({}));
    assert.doesNotThrow(() => c.check({ model: null }));
    assert.throws(() => c.check({ model: 'gpt' }), (e) => e.status === 400);
  } finally { await fake.close(); }
});

test('Foundry: opening makes no call. The first message makes a thread, sends the text, runs the agent; the reply, tokens and cost show', async () => {
  const o = await foundry([{ events: [...start, delta('Hel'), delta('lo'), said('Hello there'), done()] }], { env: { OFFICE_FOUNDRY_PRICE_IN: '2', OFFICE_FOUNDRY_PRICE_OUT: '10' } });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(o.fake.calls.length, 0, 'open() is silent');
    o.say(o.s, 'hi');
    await until(() => last(o.s) === 'Hello there' && idle(o.s) && o.s.cost !== null, 'the reply');
    assert.deepEqual(o.fake.calls.map((c) => c.method + ' ' + c.path), ['POST /threads', 'POST /threads/thread_1/messages', 'POST /threads/thread_1/runs']);
    assert.ok(o.fake.calls.every((c) => c.auth === 'Bearer ' + TOKEN));
    assert.ok(o.fake.calls.every((c) => c.query['api-version']));
    assert.deepEqual(o.fake.calls[1].body, { role: 'user', content: 'hi' });
    assert.deepEqual(o.runCalls()[0].body, { assistant_id: 'asst_1', stream: true });
    assert.equal(o.s.usage.tokens, 150);
    assert.equal(o.s.cost, (100 * 2 + 50 * 10) / 1e6);
    assert.equal(o.s.model, 'asst_1', 'the bot shows the agent id: Reopen sends the model back to check()');
    assert.equal(o.s.error, null);
    assert.ok(!JSON.stringify([o.s, o.tracker.feed]).includes(TOKEN), 'the token is in no session field and no feed line');
    // The second message reuses the thread.
    o.say(o.s, 'again');
    await until(() => o.runCalls().length === 2 && idle(o.s) && o.s.turns === 2, 'the second turn');
    assert.equal(o.fake.calls.filter((c) => c.path === '/threads').length, 1);
    assert.equal(o.fake.calls.filter((c) => c.path === '/threads/thread_1/messages').length, 2);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: a tool step shows as a call, a connected agent as a helper, and failures show as failed calls', async () => {
  const o = await foundry([{ events: [...start,
    toolStep([{ id: 'call_a', type: 'code_interpreter', code_interpreter: { input: 'print(1)', outputs: [] } }]),
    toolStep([{ id: 'call_b', type: 'bing_grounding', bing_grounding: { requesturl: 'https://x', response_metadata: '{}' } }]),
    toolStep([{ id: 'call_c', type: 'connected_agent', connected_agent: { name: 'billing', arguments: '{"prompt":"find invoice 7"}', output: 'ok' } }]),
    toolStep([{ id: 'call_d', type: 'mcp', server_label: 'docs', name: 'search', arguments: '{"query":"x"}', output: 'o' }]),
    ['thread.run.step.failed', { id: 'step_2', run_id: 'run_1', type: 'tool_calls', status: 'failed', last_error: { code: 'tool_error', message: 'The tool failed.' }, step_details: { type: 'tool_calls', tool_calls: [{ id: 'call_e', type: 'azure_function', azure_function: { name: 'lookup', arguments: '{}' } }] } }],
    said('done'), done()] }]);
  try {
    o.say(o.s, 'work');
    await until(() => last(o.s) === 'done' && idle(o.s), 'the turn');
    const by = Object.fromEntries(o.s.calls.map((c) => [c.id, c]));
    assert.equal(by.call_a.name, 'code_interpreter');
    assert.equal(by.call_a.ok, true);
    assert.equal(by.call_b.name, 'bing_grounding');
    assert.equal(by.call_c.name, 'Agent');
    assert.equal(by.call_d.name, 'mcp__docs__search');
    assert.equal(by.call_e.ok, false);
    assert.match(by.call_e.err, /The tool failed/);
    assert.equal(o.s.agents.length, 1);
    assert.equal(o.s.agents[0].type, 'billing');
    assert.equal(o.s.agents[0].done, true);
    assert.equal(o.s.error, null, 'a failed step the agent recovered from is not a failed turn');
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: a tool approval waits for you. Allow and decline go back to the run as approvals', async () => {
  const calls = [{ id: 'call_1', type: 'mcp', server_label: 'docs', name: 'delete', arguments: '{"id":"7"}' }, { id: 'call_2', type: 'mcp', server_label: 'docs', name: 'read', arguments: '{"id":"8"}' }];
  const o = await foundry([{ events: [...start, approval(calls)] }, { events: [said('ok, one done'), done()] }]);
  try {
    o.say(o.s, 'clean up');
    await until(() => o.holds.size === 2, 'two requests');
    assert.equal(o.s.status, 'waiting');
    assert.deepEqual(o.s.pending.map((p) => p.tool).sort(), ['mcp__docs__delete', 'mcp__docs__read']);
    assert.equal(o.runCalls().length, 1, 'nothing goes back before you answer');
    const [a, b] = [...o.holds.keys()];
    const first = o.s.pending.find((p) => p.id === a).tool;
    o.release(a, { allow: true });
    assert.equal(o.runCalls().length, 1, 'the run waits for every request');
    o.release(b, { allow: false });
    await until(() => last(o.s) === 'ok, one done' && idle(o.s), 'the reply');
    const sent = o.runCalls()[1];
    assert.match(sent.path, /\/runs\/run_1\/submit_tool_outputs$/);
    assert.equal(sent.body.stream, true);
    const by = Object.fromEntries(sent.body.tool_approvals.map((x) => [x.tool_call_id, x.approve]));
    assert.deepEqual(by, first === 'mcp__docs__delete' ? { call_1: true, call_2: false } : { call_1: false, call_2: true });
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: a request that times out (no decision) is a decline', async () => {
  const o = await foundry([{ events: [...start, approval([{ id: 'call_1', type: 'mcp', server_label: 'docs', name: 'delete', arguments: '{}' }])] }, { events: [said('declined'), done()] }]);
  try {
    o.say(o.s, 'x');
    await until(() => o.holds.size === 1, 'a request');
    o.release([...o.holds.keys()][0], {});
    await until(() => o.runCalls().length === 2 && idle(o.s) && o.s.turns >= 1 && last(o.s) === 'declined', 'the run goes on');
    assert.equal(o.runCalls()[1].body.tool_approvals[0].approve, false);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: a function the agent wants the office to run is refused, the run is cancelled and the turn fails in words', async () => {
  const o = await foundry([{ events: [...start, ['thread.run.requires_action', run({ status: 'requires_action', required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls: [{ id: 'call_f', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } } })]] }]);
  try {
    o.say(o.s, 'weather');
    await until(() => o.s.error && idle(o.s), 'the error');
    assert.match(o.s.error.text, /get_weather/);
    assert.match(o.s.error.text, /office has no functions/i);
    assert.ok(o.fake.calls.some((c) => /\/runs\/run_1\/cancel$/.test(c.path)), 'the run is cancelled so it does not wait');
    assert.equal(o.holds.size, 0);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: a failed run, an error event and an HTTP error each end the turn as an error with the reason', async () => {
  const cases = [
    [{ events: [...start, ['thread.run.failed', run({ status: 'failed', last_error: { code: 'rate_limit_exceeded', message: 'Rate limit is exceeded.' } })]] }, /Rate limit is exceeded/],
    [{ events: [...start, ['error', { code: 'server_error', message: 'The service broke.' }]] }, /The service broke/],
    [{ status: 429 }, /slow down/],
    [{ status: 401 }, /refused the token/],
    [{ events: [...start, delta('part')] }, /closed the connection/],
  ];
  for (const [step, re] of cases) {
    const o = await foundry([step]);
    try {
      o.say(o.s, 'x');
      await until(() => o.s.error && idle(o.s), 'the error');
      assert.match(o.s.error.text, re);
      assert.doesNotMatch(o.s.error.text, new RegExp(TOKEN));
    } finally { await o.provider.close(o.s); await o.done(); }
  }
});

test('Foundry: the spend limit stops the next turn with no call to the service', async () => {
  const o = await foundry([{ events: [...start, said('one'), done({ prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 })] }], { env: { OFFICE_FOUNDRY_PRICE_IN: '3', OFFICE_FOUNDRY_PRICE_OUT: '9' }, budget: 2 });
  try {
    o.say(o.s, 'first');
    await until(() => last(o.s) === 'one' && idle(o.s) && o.s.cost === 3, 'the first turn');
    const before = o.fake.calls.length;
    o.say(o.s, 'second');
    await until(() => o.s.turns === 2 && idle(o.s) && o.s.error, 'the stop');
    assert.match(o.s.error.text, /spending limit of \$2/);
    assert.equal(o.fake.calls.length, before, 'no call after the limit');
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: interrupt stops the stream, cancels the run, and the turn reads as stopped, not as an error', async () => {
  const o = await foundry([{ events: [...start, delta('thinking')], hang: true }]);
  try {
    o.say(o.s, 'long');
    await until(() => o.s.live === 'thinking', 'the live text');
    o.provider.interrupt(o.s);
    o.tracker.interrupt?.(o.s);
    await until(() => idle(o.s) && o.fake.calls.some((c) => /\/cancel$/.test(c.path)), 'the stop');
    assert.equal(o.s.error, null);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: after close nothing more is reported, a message is refused, and no thread is deleted', async () => {
  const o = await foundry([{ events: [...start, delta('x')], hang: true }]);
  try {
    o.say(o.s, 'go');
    await until(() => o.s.live === 'x', 'streaming');
    await o.provider.close(o.s);
    const turns = o.s.turns, live = o.s.live;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(o.s.live, live);
    assert.equal(o.s.turns, turns);
    assert.throws(() => o.provider.message(o.s, { text: 'again' }), (e) => e.status === 409);
    assert.equal(o.fake.calls.filter((c) => c.method === 'DELETE').length, 0, 'the office does not delete the owner\'s cloud data');
  } finally { await o.done(); }
});

test('Foundry: text only, and a message sent during a turn waits for its end', async () => {
  const o = await foundry([{ events: [...start, said('a'), done()] }]);
  try {
    assert.throws(() => o.provider.message(o.s, { text: 'x', attachments: [{ name: 'f' }] }), (e) => e.status === 415);
    o.say(o.s, 'one');
    o.provider.message(o.s, { text: 'two' });
    await until(() => o.runCalls().length === 2 && idle(o.s), 'both turns');
    assert.deepEqual(o.fake.calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.body.content), ['one', 'two']);
  } finally { await o.provider.close(o.s); await o.done(); }
});

// The server path, not provider.message: a message to a working session goes to the tracker's inbox, and the next PostToolUse
// hands it out. A cloud run cannot take it in the middle, so it is the next prompt of the same turn.
test('Foundry: a message you send during a tool step reaches the agent as the next prompt, through the inbox', async () => {
  const code = { id: 'call_a', type: 'code_interpreter', code_interpreter: { input: 'print(1)', outputs: [] } };
  const o = await foundry([{ events: [...start, toolStep([code]), said('a'), done()] }, { events: [...start, said('b'), done()] }]);
  try {
    o.onHook((s, p) => { if (p.hook_event_name === 'PreToolUse' && p.tool_use_id === 'call_a') o.send(s, 'URGENT-NOTE'); });
    o.send(o.s, 'one');
    await until(() => last(o.s) === 'b' && idle(o.s), 'the second prompt');
    assert.deepEqual(o.s.inbox, []);
    const sent = o.fake.calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.body.content);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], 'one');
    assert.match(sent[1], /URGENT-NOTE/);
    assert.match(o.s.prompt, /URGENT-NOTE/, 'the note shows as the prompt of the next round, as a Stop block does');
    assert.equal(o.s.error, null);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: notes that keep coming are all sent; past the round cap they go out as a new turn, none is lost', async () => {
  const code = { id: 'call_a', type: 'code_interpreter', code_interpreter: { input: 'x', outputs: [] } };
  const o = await foundry([{ events: [...start, toolStep([code]), said('ok'), done()] }]);
  try {
    let n = 0;
    o.onHook((s, p) => { if (p.hook_event_name === 'PreToolUse' && n < 8) o.send(s, `NOTE-${++n}`); });
    o.send(o.s, 'go');
    await until(() => n === 8 && o.fake.calls.filter((c) => c.path.endsWith('/messages')).length === 9 && idle(o.s) && o.s.inbox.length === 0, 'every note');
    const sent = o.fake.calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.body.content).join('\n');
    for (let i = 1; i <= 8; i++) assert.match(sent, new RegExp(`NOTE-${i}\\b`));
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: two messages at once, or one that lands as a turn ends, never start two runs on one thread', async () => {
  const o = await foundry([{ events: [...start, said('a'), done()] }]);
  try {
    let once = false;
    const orig = o.events.stream;
    o.events.stream = (s, m) => {
      const r = orig(s, m);
      if (m.type === 'result' && !once) { once = true; o.provider.message(s, { text: 'three' }); } // in finish(), before the queue
      return r;
    };
    o.provider.message(o.s, { text: 'one' });
    o.provider.message(o.s, { text: 'two' });
    await until(() => o.runCalls().length === 3 && idle(o.s), 'three turns');
    assert.equal(o.fake.calls.filter((c) => c.path === '/threads').length, 1, 'one thread');
    assert.deepEqual(o.fake.calls.filter((c) => c.method === 'POST').map((c) => c.path.endsWith('/messages') ? c.body.content : c.path.split('/').pop()),
      ['threads', 'one', 'runs', 'two', 'runs', 'three', 'runs'], 'each run ends before the next message goes out');
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: the tokens of a stopped run are counted when Foundry has cancelled it, and the limit then stops the next message', async () => {
  const o = await foundry([{ events: [...start, delta('thinking')], hang: true }],
    { env: { OFFICE_FOUNDRY_PRICE_IN: '3', OFFICE_FOUNDRY_PRICE_OUT: '9' }, budget: 2, runInfo: { status: 'cancelled', usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 } } });
  try {
    o.say(o.s, 'long');
    await until(() => o.s.live === 'thinking', 'the live text');
    o.provider.interrupt(o.s);
    await until(() => idle(o.s) && o.fake.calls.some((c) => c.method === 'GET' && c.path === '/threads/thread_1/runs/run_1'), 'the stop and the read of the run');
    await new Promise((r) => setTimeout(r, 30));
    const before = o.fake.calls.length;
    o.say(o.s, 'next');
    await until(() => o.s.turns === 2 && idle(o.s) && o.s.error, 'the limit');
    assert.match(o.s.error.text, /spending limit of \$2/);
    assert.equal(o.s.cost, 3, 'the stopped run is in the cost');
    assert.equal(o.fake.calls.length, before, 'no call after the limit');
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: a run that stalls is cancelled, and the tokens of each stopped run are counted once', async () => {
  const o = await foundry([{ events: [...start, delta('x')], hang: true }, { events: [['thread.run.created', run({ id: 'run_2', status: 'queued' })], delta('y')], hang: true }],
    { env: { OFFICE_FOUNDRY_PRICE_IN: '1', OFFICE_FOUNDRY_PRICE_OUT: '9' }, stallMs: 100, runInfo: { status: 'cancelled', usage: { prompt_tokens: 500_000, completion_tokens: 0 } } });
  const read = (id) => o.fake.calls.some((c) => c.method === 'GET' && c.path === `/threads/thread_1/runs/${id}`);
  try {
    o.say(o.s, 'go');
    await until(() => o.s.error && idle(o.s), 'the stall');
    assert.match(o.s.error.text, /stopped answering/);
    await until(() => o.fake.calls.some((c) => /\/runs\/run_1\/cancel$/.test(c.path)) && read('run_1'), 'the cancel of run 1');
    await new Promise((r) => setTimeout(r, 30));
    o.say(o.s, 'again');
    await until(() => o.s.turns === 2 && o.s.error && idle(o.s), 'the second stall');
    await until(() => read('run_2'), 'the cancel of run 2');
    await new Promise((r) => setTimeout(r, 30));
    o.say(o.s, 'third');
    await until(() => o.s.turns === 3 && o.s.error && idle(o.s), 'the third turn');
    assert.ok(Math.abs(o.s.cost - 1) < 1e-9, `each stopped run once (got ${o.s.cost}); run_2 is counted in the third result`);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: the limit is checked again before an approval goes back to the run', async () => {
  // Turn one is stopped. Its tokens come in late: the fake holds the read of the run until turn two waits for an approval.
  let open;
  const gate = new Promise((r) => { open = r; });
  const ask = [{ id: 'call_1', type: 'mcp', server_label: 'docs', name: 'delete', arguments: '{}' }];
  const two = [['thread.run.created', run({ id: 'run_2', status: 'queued' })], ['thread.run.requires_action', run({ id: 'run_2', status: 'requires_action', required_action: { type: 'submit_tool_approval', submit_tool_approval: { tool_calls: ask } } })]];
  const o = await foundry([{ events: [...start, delta('one')], hang: true }, { events: two }, { events: [said('should not run'), done()] }],
    { env: { OFFICE_FOUNDRY_PRICE_IN: '3', OFFICE_FOUNDRY_PRICE_OUT: '9' }, budget: 2, runInfo: async (id) => { await gate; return { status: 'cancelled', usage: id === 'run_1' ? { prompt_tokens: 1_000_000, completion_tokens: 0 } : null }; } });
  try {
    o.say(o.s, 'one');
    await until(() => o.s.live === 'one', 'turn one');
    o.provider.interrupt(o.s);
    await until(() => idle(o.s), 'stopped');
    o.say(o.s, 'two');
    await until(() => o.holds.size === 1, 'the request');
    open();
    await new Promise((r) => setTimeout(r, 60));
    o.release([...o.holds.keys()][0], { allow: true });
    await until(() => idle(o.s) && o.s.error, 'the limit');
    assert.match(o.s.error.text, /spending limit of \$2/);
    assert.equal(o.fake.calls.filter((c) => /submit_tool_outputs$/.test(c.path)).length, 0, 'the approval does not go back');
    assert.ok(o.fake.calls.some((c) => /\/runs\/run_2\/cancel$/.test(c.path)), 'the waiting run is cancelled');
    assert.equal(o.s.cost, 3);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('cloudConfig takes the token settings out of the environment, so no process the office starts inherits them', async () => {
  const { execFileSync } = await import('node:child_process');
  process.env.OFFICE_TESTCLOUD_ENDPOINT = 'https://acme.services.ai.azure.com/api/projects/p';
  process.env.OFFICE_TESTCLOUD_TOKEN = TOKEN;
  process.env.OFFICE_TESTCLOUD_TOKEN_FILE = 'C:\\secret\\token.txt';
  try {
    const c = cloudConfig(process.env, 'OFFICE_TESTCLOUD', () => TOKEN);
    assert.equal(c.getToken(), TOKEN, 'the config keeps the token');
    assert.equal(c.hasToken, true);
    assert.equal(process.env.OFFICE_TESTCLOUD_TOKEN, undefined);
    assert.equal(process.env.OFFICE_TESTCLOUD_TOKEN_FILE, undefined, 'the path to the token is not handed on either');
    const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^OFFICE_TESTCLOUD/i.test(k))))'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(seen), ['OFFICE_TESTCLOUD_ENDPOINT'], 'a child process sees the endpoint only');
  } finally { delete process.env.OFFICE_TESTCLOUD_ENDPOINT; delete process.env.OFFICE_TESTCLOUD_TOKEN; delete process.env.OFFICE_TESTCLOUD_TOKEN_FILE; }
});

test('server.mjs reads the cloud settings before it can start any process', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const read = src.indexOf("cloudConfig(process.env, 'OFFICE_FOUNDRY')");
  const read2 = src.indexOf("cloudConfig(process.env, 'OFFICE_COPILOTSTUDIO')");
  const firstStart = src.search(/\b(spawn|execFileSync|execFile|exec)\(/);
  assert.ok(read > 0 && read2 > 0, 'both kinds read their settings');
  assert.ok(read < firstStart && read2 < firstStart, 'the token leaves process.env before the first line that starts a process');
});

// ---------- Copilot Studio ----------
const botSays = (text, id) => ({ type: 'message', id: id || 'a' + text.length, from: { role: 'bot' }, text });
const ev = (valueType, value) => ({ type: 'event', valueType, from: { role: 'bot' }, value });

async function studio(script, { env = {}, budget = null } = {}) {
  const fake = await startFakeCopilotStudio({ script });
  const config = cloudConfig({ OFFICE_COPILOTSTUDIO_ENDPOINT: fake.url, OFFICE_COPILOTSTUDIO_TOKEN: TOKEN, ...env }, 'OFFICE_COPILOTSTUDIO');
  const o = office((events) => createCopilotStudio({ events, config, allowLoopback: true, stallMs: 2000 }), 'copilot-studio');
  o.fake = fake; o.s = o.session(budget, null);
  o.sendCalls = () => fake.calls.filter((c) => c.method === 'POST' && /\/conversations\/[^/]+$/.test(c.path));
  o.done = () => fake.close();
  return o;
}

test('Copilot Studio readiness: configured is ready with no call; the version is the agent name from the endpoint', async () => {
  const o = await studio([{ activities: [] }]);
  try {
    const r = await o.provider.readiness();
    assert.deepEqual(r, { ready: true, configured: true, version: 'cr123_helper', needs: [] });
    assert.deepEqual(await o.provider.models(), []);
    assert.equal(o.fake.calls.length, 0, 'there is no free probe, so the office asks nothing');
  } finally { await o.done(); }
  for (const raw of ['https://acme.environment.api.powerplatform.com/copilotstudio/other', 'http://acme.environment.api.powerplatform.com/x/agents/a/conversations', 'https://evil.example.com/copilotstudio/dataverse-backed/authentication/agents/a/conversations']) {
    const p = createCopilotStudio({ events: {}, config: cloudConfig({ OFFICE_COPILOTSTUDIO_ENDPOINT: raw, OFFICE_COPILOTSTUDIO_TOKEN: TOKEN }, 'OFFICE_COPILOTSTUDIO'), fetch: noFetch });
    const r = await p.readiness();
    assert.equal(r.configured, false, raw);
    assert.ok(r.needs.length, raw);
  }
});

test('Copilot Studio: opening is silent. The first message starts a conversation, sends the text, shows the replies; cost is the price per message', async () => {
  const o = await studio([{ activities: [{ type: 'typing', from: { role: 'bot' } }, botSays('Hello, I can help.'), botSays('Anything else?'), { type: 'message', from: { role: 'user' }, text: 'echo of the user' }] }], { env: { OFFICE_COPILOTSTUDIO_PRICE_MESSAGE: '0.02' } });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(o.fake.calls.length, 0);
    o.say(o.s, 'hi');
    await until(() => o.s.replies.length >= 2 && idle(o.s) && o.s.cost !== null, 'the replies');
    assert.deepEqual(o.s.replies.map((r) => r.text), ['Hello, I can help.', 'Anything else?']);
    assert.equal(o.fake.calls[0].method + ' ' + o.fake.calls[0].path.split('/').pop(), 'POST conversations');
    assert.deepEqual(o.fake.calls[0].body, { emitStartConversationEvent: false });
    const send = o.sendCalls()[0];
    assert.equal(send.path.split('/').pop(), 'conv-1');
    assert.deepEqual(send.body, { activity: { type: 'message', text: 'hi', conversation: { id: 'conv-1' } } });
    assert.ok(o.fake.calls.every((c) => c.auth === 'Bearer ' + TOKEN && c.query['api-version'] === '2022-03-01-preview'));
    assert.equal(o.s.cost, 0.02);
    assert.equal(o.s.error, null);
    o.say(o.s, 'more');
    await until(() => o.sendCalls().length === 2 && idle(o.s) && o.s.turns === 2, 'the second turn');
    assert.equal(o.fake.calls.filter((c) => c.path.endsWith('/conversations')).length, 1, 'the conversation is reused');
    assert.equal(o.s.cost, 0.04);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Copilot Studio: plan events become the plan, knowledge lookups, connector calls, topics and connected agents become calls and helpers', async () => {
  const acts = [
    ev('DynamicPlanReceived', { planIdentifier: 'p1', steps: ['cr123.topic.Weather', 'cr123.knowledge.HR', 'cr123.action.SendMail', 'cr123.agent.Billing'], isFinalPlan: true }),
    ev('DynamicPlanStepTriggered', { planIdentifier: 'p1', stepId: 's1', taskDialogId: 'cr123.topic.Weather', thought: 'Check the weather', type: 'CustomTopic', state: 'inProgress' }),
    ev('DynamicPlanStepFinished', { planIdentifier: 'p1', stepId: 's1', taskDialogId: 'cr123.topic.Weather', state: 'completed', observation: { text: 'sunny' } }),
    ev('DynamicPlanStepTriggered', { planIdentifier: 'p1', stepId: 's2', taskDialogId: 'cr123.knowledge.HR', thought: 'Look up the leave policy', type: 'KnowledgeSource', state: 'inProgress' }),
    ev('DynamicPlanStepFinished', { planIdentifier: 'p1', stepId: 's2', taskDialogId: 'cr123.knowledge.HR', state: 'completed' }),
    ev('DynamicPlanStepTriggered', { planIdentifier: 'p1', stepId: 's3', taskDialogId: 'cr123.action.SendMail', thought: 'Send the mail', type: 'ConnectorAction', state: 'inProgress' }),
    ev('DynamicPlanStepFinished', { planIdentifier: 'p1', stepId: 's3', taskDialogId: 'cr123.action.SendMail', state: 'failed', error: 'The connector is not allowed.' }),
    ev('DynamicPlanStepTriggered', { planIdentifier: 'p1', stepId: 's4', taskDialogId: 'cr123.agent.Billing', thought: 'Ask billing', type: 'ConnectedAgent', state: 'inProgress' }),
    ev('DynamicPlanStepFinished', { planIdentifier: 'p1', stepId: 's4', taskDialogId: 'cr123.agent.Billing', state: 'completed' }),
    ev('DynamicPlanFinished', { planId: 'p1', wasCancelled: false }),
    botSays('Done.'),
  ];
  const o = await studio([{ activities: acts }]);
  try {
    o.say(o.s, 'plan it');
    await until(() => last(o.s) === 'Done.' && idle(o.s), 'the turn');
    const by = Object.fromEntries(o.s.calls.filter((c) => c.name !== 'TodoWrite').map((c) => [c.id, c]));
    assert.equal(by.s1.name, 'Topic');
    assert.equal(by.s1.ok, true);
    assert.equal(by.s2.name, 'Knowledge');
    assert.match(by.s2.detail, /leave policy/);
    assert.equal(by.s3.name, 'Connector');
    assert.equal(by.s3.ok, false);
    assert.match(by.s3.err, /not allowed/);
    assert.equal(by.s4.name, 'Agent');
    assert.equal(o.s.agents.length, 1);
    assert.equal(o.s.agents[0].type, 'Billing');
    assert.equal(o.s.agents[0].done, true);
    assert.deepEqual(o.s.todos.map((t) => t.text), ['Weather', 'HR', 'SendMail', 'Billing']);
    assert.deepEqual(o.s.todos.map((t) => t.status), ['completed', 'completed', 'completed', 'completed'], 'a finished plan leaves no open step');
    assert.equal(o.s.error, null, 'a failed step is a failed call, not a failed turn');
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Copilot Studio: a sign-in card ends the turn in words, because the office never signs in', async () => {
  const card = { type: 'message', from: { role: 'bot' }, text: 'Sign in to continue', attachments: [{ contentType: 'application/vnd.microsoft.card.oauth', content: { connectionName: 'x', buttons: [{ type: 'signin', value: 'https://login.example/x' }] } }] };
  const o = await studio([{ activities: [card, botSays('after')] }]);
  try {
    o.say(o.s, 'send mail');
    await until(() => o.s.error && idle(o.s), 'the error');
    assert.match(o.s.error.text, /sign-in/i);
    assert.match(o.s.error.text, /never signs in/i);
    assert.doesNotMatch(JSON.stringify(o.s.replies), /login\.example/, 'the sign-in link is not shown');
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Copilot Studio: the end of a conversation makes the next message start a new one', async () => {
  const o = await studio([{ activities: [botSays('bye'), { type: 'endOfConversation', from: { role: 'bot' } }] }, { activities: [botSays('hello again')] }]);
  try {
    o.say(o.s, 'one');
    await until(() => last(o.s) === 'bye' && idle(o.s), 'the first turn');
    o.say(o.s, 'two');
    await until(() => last(o.s) === 'hello again' && idle(o.s) && o.s.turns === 2, 'the second turn');
    assert.equal(o.fake.calls.filter((c) => c.path.endsWith('/conversations')).length, 2);
    assert.deepEqual(o.sendCalls().map((c) => c.path.split('/').pop()), ['conv-1', 'conv-2']);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Copilot Studio: HTTP errors end the turn in words; the spend limit stops the next turn with no call; interrupt reads as stopped', async () => {
  let o = await studio([{ status: 403 }]);
  try {
    o.say(o.s, 'x');
    await until(() => o.s.error && idle(o.s), 'the error');
    assert.match(o.s.error.text, /no access/);
  } finally { await o.provider.close(o.s); await o.done(); }

  o = await studio([{ activities: [botSays('ok')] }], { env: { OFFICE_COPILOTSTUDIO_PRICE_MESSAGE: '1.5' }, budget: 2 });
  try {
    o.say(o.s, 'a');
    await until(() => last(o.s) === 'ok' && idle(o.s) && o.s.cost === 1.5, 'one');
    o.say(o.s, 'b');
    await until(() => o.s.cost === 3 && idle(o.s) && o.s.turns === 2, 'two');
    const before = o.fake.calls.length;
    o.say(o.s, 'c');
    await until(() => o.s.turns === 3 && idle(o.s) && o.s.error, 'the stop');
    assert.match(o.s.error.text, /spending limit of \$2/);
    assert.equal(o.fake.calls.length, before);
  } finally { await o.provider.close(o.s); await o.done(); }

  o = await studio([{ activities: [botSays('thinking')], hang: true }]);
  try {
    o.say(o.s, 'long');
    await until(() => last(o.s) === 'thinking', 'the reply');
    o.provider.interrupt(o.s);
    o.tracker.interrupt?.(o.s);
    await until(() => idle(o.s), 'the stop');
    assert.equal(o.s.error, null);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('the SSE reader handles CRLF, comments, multi-line data and a last event with no blank line', async () => {
  const seen = [];
  const chunks = [': hi\r\nevent: a\r\ndata: 1\r\n\r\nda', 'ta: 2\ndata: 3\n\nevent: b\ndata: {"x":1}'];
  await readSse((async function* () { for (const c of chunks) yield Buffer.from(c); })(), (e) => seen.push(e));
  assert.deepEqual(seen, [{ event: 'a', data: '1' }, { event: 'message', data: '2\n3' }, { event: 'b', data: '{"x":1}' }]);
  await assert.rejects(readSse((async function* () { yield 'data: ' + 'x'.repeat(5 * 1024 * 1024) + '\n\n'; })(), () => {}), /too large/);
});

// The same inbox path for Copilot Studio: a plan update reports a TodoWrite, and its PostToolUse hands out the note.
test('Copilot Studio: a message you send while the plan runs reaches the agent as the next prompt, through the inbox', async () => {
  const o = await studio([{ activities: [ev('DynamicPlanReceived', { planIdentifier: 'p1', steps: ['cr123.topic.Weather'] }), botSays('first')] }, { activities: [botSays('second')] }]);
  try {
    let sent = false;
    o.onHook((s, p) => { if (!sent && p.hook_event_name === 'PreToolUse' && p.tool_name === 'TodoWrite') { sent = true; o.send(s, 'URGENT-NOTE'); } });
    o.send(o.s, 'one');
    await until(() => last(o.s) === 'second' && idle(o.s), 'the second prompt');
    assert.deepEqual(o.s.inbox, []);
    const texts = o.sendCalls().map((c) => c.body.activity.text);
    assert.equal(texts.length, 2);
    assert.match(texts[1], /URGENT-NOTE/);
  } finally { await o.provider.close(o.s); await o.done(); }
});

// ---------- the seam of spec #67: ungated, the Security room, cost ----------
// The cloud tools run in the cloud with no hold in the office, so both kinds are ungated (ADR 0001): labelled, off until the
// Security room turns them on, in a room of their own. Cost: Foundry reports tokens and Copilot Studio nothing, so a kind
// reports cost only from the prices the owner set; without them it is cost 'unknown' (owner decision Q22): the office asks
// before it runs, shows "unknown", never $0.00, and sets no spend limit that could not stop it.
test('#67: both cloud kinds are ungated, with a label that says what comes to the office', async () => {
  const { traitsOf } = await import('../src/providers/index.mjs');
  const f = createFoundry({ events: {}, config: cloudConfig({}, 'OFFICE_FOUNDRY'), fetch: noFetch });
  const c = createCopilotStudio({ events: {}, config: cloudConfig({}, 'OFFICE_COPILOTSTUDIO'), fetch: noFetch });
  assert.equal(traitsOf(f).gated, false);
  assert.equal(traitsOf(c).gated, false);
  assert.equal(traitsOf(f).supervision, 'Partly supervised: only MCP approvals ask');
  assert.equal(traitsOf(c).supervision, 'Unsupervised: its tools run in the cloud');
  const k = createRegistry([f, c]).kinds();
  assert.deepEqual(k.map((x) => [x.kind, x.gated, x.supervision]), [['foundry', false, traitsOf(f).supervision], ['copilot-studio', false, traitsOf(c).supervision]]);
  // The Security room: an MCP approval Foundry asks for is the MCP row; its other tools never reach the office (partly).
  assert.deepEqual(f.enforces || [], []);
  assert.match(f.partly.mcp, /Only an MCP tool that a Foundry agent sets to ask/);
  assert.equal(c.partly, undefined, 'Copilot Studio asks the office about nothing');
});

test('#67: a cloud kind reports cost only with its prices; without them its cost is unknown and no spend limit applies', async () => {
  const { spendLimitFor, traitsOf } = await import('../src/providers/index.mjs');
  const fd = (env) => createFoundry({ events: {}, config: cloudConfig(env, 'OFFICE_FOUNDRY'), fetch: noFetch });
  const cs = (env) => createCopilotStudio({ events: {}, config: cloudConfig(env, 'OFFICE_COPILOTSTUDIO'), fetch: noFetch });
  assert.equal(traitsOf(fd({})).cost, 'unknown');
  assert.equal(traitsOf(fd({ OFFICE_FOUNDRY_PRICE_IN: '2' })).cost, 'unknown', 'one price is not enough: the other tokens would count as free');
  assert.equal(traitsOf(fd({ OFFICE_FOUNDRY_PRICE_IN: '2', OFFICE_FOUNDRY_PRICE_OUT: '8' })).cost, 'reported');
  assert.equal(traitsOf(cs({})).cost, 'unknown');
  assert.equal(traitsOf(cs({ OFFICE_COPILOTSTUDIO_PRICE_MESSAGE: '0.01' })).cost, 'reported');
  for (const p of [fd({}), cs({})]) {
    assert.doesNotThrow(() => checkProvider(p));
    assert.equal(spendLimitFor({ paid: traitsOf(p).paid, cost: traitsOf(p).cost, requested: 5 }), null, p.kind);
  }
  assert.equal(spendLimitFor({ paid: true, cost: traitsOf(cs({ OFFICE_COPILOTSTUDIO_PRICE_MESSAGE: '0.01' })).cost, requested: 5 }), 5);
  assert.deepEqual(createRegistry([fd({}), cs({ OFFICE_COPILOTSTUDIO_PRICE_MESSAGE: '1' })]).kinds().map((k) => k.cost), ['unknown', 'reported']);
});

test('#67: with no prices a turn says no dollars, so the session cost stays unknown, never $0.00', async () => {
  const seen = [];
  const o = await foundry([{ events: [...start, said('Hi'), done()] }]);
  try {
    const orig = o.events.stream;
    o.events.stream = (s, m) => { if (m && m.type === 'result') seen.push(m); return orig(s, m); };
    o.say(o.s, 'hi');
    await until(() => last(o.s) === 'Hi' && idle(o.s), 'the reply');
    assert.equal(o.s.cost, null, 'no figure: every surface reads unknown');
    assert.ok(seen.length && seen.every((m) => !('total_cost_usd' in m)), 'the turn result carries no dollar figure');
    assert.equal(o.s.usage.tokens, 150, 'the tokens still show');
  } finally { await o.provider.close(o.s); await o.done(); }
  const st = await studio([{ activities: [botSays('ok')] }]);
  try {
    st.say(st.s, 'hi');
    await until(() => last(st.s) === 'ok' && idle(st.s), 'the reply');
    assert.equal(st.s.cost, null);
  } finally { await st.provider.close(st.s); await st.done(); }
});

// ---------- review fixes (#24) ----------
test('Foundry: off in the Security room is not ready and makes no call, also not to list the agents; models() is empty', async () => {
  const fake = await startFakeFoundry({ script: [{ events: [] }] });
  let off = 'Azure AI Foundry runs tool calls without asking the office. Turn on Cloud agent on the Agents screen of the Security room first.';
  try {
    const config = cloudConfig({ OFFICE_FOUNDRY_ENDPOINT: fake.url, OFFICE_FOUNDRY_TOKEN: TOKEN }, 'OFFICE_FOUNDRY');
    const p = createFoundry({ events: {}, config, allowLoopback: true, blocked: () => off });
    assert.deepEqual(await p.readiness(), { ready: false, configured: true, version: null, needs: [off] });
    assert.deepEqual(await p.models(), []);
    assert.equal(fake.calls.length, 0, 'no call while the kind is off');
    off = null; // the user turns it on
    assert.equal((await p.readiness()).ready, true);
    assert.equal((await p.models()).length, 1);
    assert.ok(fake.calls.length >= 2);
    // Not configured still says the setup steps first, off or on.
    const bare = createFoundry({ events: {}, config: cloudConfig({}, 'OFFICE_FOUNDRY'), fetch: noFetch, blocked: () => 'off' });
    const r = await bare.readiness();
    assert.equal(r.configured, false);
    assert.notDeepEqual(r.needs, ['off']);
  } finally { await fake.close(); }
});

test('Copilot Studio: off in the Security room is not ready, with the reason; turned on it is ready', async () => {
  let off = 'Copilot Studio runs tool calls without asking the office. Turn on Cloud agent on the Agents screen of the Security room first.';
  const config = cloudConfig({ OFFICE_COPILOTSTUDIO_ENDPOINT: 'https://acme.environment.api.powerplatform.com/copilotstudio/dataverse-backed/authenticated/agents/cr123_helper/conversations?api-version=2022-03-01-preview', OFFICE_COPILOTSTUDIO_TOKEN: TOKEN }, 'OFFICE_COPILOTSTUDIO');
  const p = createCopilotStudio({ events: {}, config, fetch: noFetch, blocked: () => off });
  assert.deepEqual(await p.readiness(), { ready: false, configured: true, version: null, needs: [off] });
  assert.deepEqual(await p.models(), []);
  off = null;
  assert.equal((await p.readiness()).ready, true);
});

test('Foundry: an MCP server label can never be "office", and holds only safe characters', async () => {
  const o = await foundry([{ events: [...start,
    toolStep([{ id: 'c1', type: 'mcp', server_label: 'office', name: 'office_ask', arguments: '{}', output: 'o' }]),
    toolStep([{ id: 'c2', type: 'mcp', server_label: 'Office', name: 'x', arguments: '{}', output: 'o' }]),
    toolStep([{ id: 'c3', type: 'mcp', server_label: 'a__b c', name: 'x', arguments: '{}', output: 'o' }]),
    said('done'), done()] }]);
  try {
    o.say(o.s, 'work');
    await until(() => last(o.s) === 'done' && idle(o.s), 'the turn');
    const by = Object.fromEntries(o.s.calls.map((c) => [c.id, c.name]));
    assert.equal(by.c1, 'mcp__office-server__office_ask');
    assert.equal(by.c2, 'mcp__office-server__x');
    assert.equal(by.c3, 'mcp__a_b_c__x');
    for (const n of Object.values(by)) assert.ok(!/^mcp__office__/.test(n), n);
  } finally { await o.provider.close(o.s); await o.done(); }
});

test('Foundry: the ids of the service go into a request path as one segment each', async () => {
  const fake = await startFakeFoundry({ script: [{ events: [...start, said('ok'), done()] }], threadId: 'a/../b?x=1' });
  try {
    const config = cloudConfig({ OFFICE_FOUNDRY_ENDPOINT: fake.url, OFFICE_FOUNDRY_TOKEN: TOKEN }, 'OFFICE_FOUNDRY');
    const o = office((events) => createFoundry({ events, config, allowLoopback: true, stallMs: 2000, pollMs: 5 }), 'foundry');
    const s = o.session();
    o.say(s, 'hi');
    await until(() => last(s) === 'ok' && idle(s), 'the reply');
    const enc = encodeURIComponent('a/../b?x=1');
    assert.deepEqual(fake.calls.map((c) => c.method + ' ' + c.path), ['POST /threads', `POST /threads/${enc}/messages`, `POST /threads/${enc}/runs`]);
    await o.provider.close(s);
  } finally { await fake.close(); }
});
