// Remote tool providers (#218): Cursor cloud agents and a Hermes gateway. Shapes follow Paperclip's cursor-cloud and
// hermes-gateway adapters (MIT) and the vendors' public API notes; they are NOT checked against a recording (no account, no paid
// call). A fake fetch stands in for the service. The kinds are off until the Security room turns them on and make no call before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/tracker.mjs';
import { providerEvents, checkProvider, createRegistry, traitsOf, spendLimitFor } from '../src/providers/index.mjs';
import { cloudConfig } from '../src/providers/cloud.mjs';
import { createCursorCloud, createHermesGateway } from '../src/providers/remote-tools.mjs';

const KEY = 'key_' + 'abcdef0123456789'.repeat(3);
const REPO = 'https://github.com/acme/widgets';
const noFetch = () => { throw new Error('The office must not call the network.'); };
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 3)); }
}
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map(), json: async () => body, body: null });
const sse = (lines) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({}),
  body: (async function* () { for (const l of lines) yield l; })() });

function office(make, kind) {
  const o = { ids: {} };
  o.tracker = createTracker({ now: Date.now, makeId: (k) => `${k[0]}${(o.ids[k] = (o.ids[k] || 0) + 1)}`, locate: async () => null, setTimer: () => 0, releaseHold: () => {} });
  o.events = providerEvents({ tracker: o.tracker, hold: () => {} });
  o.provider = make(o.events);
  o.session = () => {
    const s = o.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'bot', cwd: process.cwd(), headless: true, status: 'starting', provider: kind });
    o.provider.open(s, {});
    return s;
  };
  o.say = (s, text) => { o.provider.message(s, { text }); o.tracker.startTurn(s, text); };
  return o;
}
const idle = (s) => s.status === 'idle' || s.status === 'waiting';

// ---------- Cursor cloud ----------
const cursorEnv = (env = {}) => ({ OFFICE_CURSORCLOUD_TOKEN: KEY, ...env });
const cursor = (fetch, { env = {}, blocked, pollMs = 1 } = {}) => {
  const e = { OFFICE_CURSORCLOUD_REPOSITORY: REPO, ...env };
  return (events) => createCursorCloud({ events, config: cloudConfig(cursorEnv(e), 'OFFICE_CURSORCLOUD'), env: e, fetch, blocked, pollMs });
};
// A fake Cursor: records calls; status answers walk through the list, then repeat the last.
function fakeCursor({ statuses = ['RUNNING', 'FINISHED'], messages = [], status } = {}) {
  const calls = []; let i = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push({ method, path: u.pathname, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined, host: u.host });
    if (method === 'POST' && u.pathname === '/v0/agents') return json({ id: 'bc_1', status: 'CREATING', target: { url: 'https://cursor.com/agents?id=bc_1' } });
    if (method === 'POST' && /\/(followup|stop)$/.test(u.pathname)) return json({ id: 'bc_1' });
    if (u.pathname === '/v0/agents/bc_1') return json({ id: 'bc_1', status: status || statuses[Math.min(i++, statuses.length - 1)], summary: 'Added the widget.', target: { url: 'https://cursor.com/agents?id=bc_1' } });
    if (u.pathname === '/v0/agents/bc_1/conversation') return json({ id: 'bc_1', messages });
    return json({ error: { message: 'not found' } }, 404);
  };
  fetch.calls = calls;
  return fetch;
}

test('both kinds have the seam shape and are off with no settings: Not configured with the steps, and no call', async () => {
  const c = createCursorCloud({ events: {}, config: cloudConfig({}, 'OFFICE_CURSORCLOUD'), env: {}, fetch: noFetch });
  const h = createHermesGateway({ events: {}, config: cloudConfig({}, 'OFFICE_HERMESGATEWAY'), env: {}, fetch: noFetch });
  for (const p of [c, h]) { checkProvider(p); assert.equal(p.cloud, true); }
  const rc = await c.readiness();
  assert.equal(rc.ready, false); assert.equal(rc.configured, false);
  assert.match(rc.needs.join(' '), /OFFICE_CURSORCLOUD_TOKEN_FILE/);
  assert.match(rc.needs.join(' '), /OFFICE_CURSORCLOUD_REPOSITORY/);
  const rh = await h.readiness();
  assert.equal(rh.configured, false);
  assert.match(rh.needs.join(' '), /OFFICE_HERMESGATEWAY_ENDPOINT/);
  assert.deepEqual(await c.models(), []);
  assert.throws(() => c.open({ uid: 'x' }, {}), /not configured/i);
});

test('supervision words say the office cannot hold the calls, for each tool; cost is unknown, so no spend limit', () => {
  const c = createCursorCloud({ events: {}, config: cloudConfig({}, 'OFFICE_CURSORCLOUD'), env: {}, fetch: noFetch });
  const h = createHermesGateway({ events: {}, config: cloudConfig({}, 'OFFICE_HERMESGATEWAY'), env: {}, fetch: noFetch });
  assert.equal(traitsOf(c).gated, false);
  assert.equal(traitsOf(h).gated, false);
  assert.equal(traitsOf(c).supervision, "Unsupervised: its tools run in Cursor's cloud");
  assert.equal(traitsOf(h).supervision, 'Unsupervised: its tools run on the gateway');
  assert.equal(traitsOf(c).cost, 'unknown');
  assert.equal(spendLimitFor(c, undefined, 2, 'unknown'), null);
  const k = createRegistry([c, h]).kinds();
  assert.deepEqual(k.map((x) => [x.kind, x.host]), [['cursor-cloud', "Cursor's cloud"], ['hermes-gateway', 'the Hermes gateway']]);
});

test('Cursor: the endpoint must be a Cursor host, the repository a GitHub https address; a bad one is named', async () => {
  const bad = (env) => createCursorCloud({ events: {}, config: cloudConfig(cursorEnv(env), 'OFFICE_CURSORCLOUD'), env, fetch: noFetch });
  let r = await bad({ OFFICE_CURSORCLOUD_REPOSITORY: REPO, OFFICE_CURSORCLOUD_ENDPOINT: 'https://evil.example.com' }).readiness();
  assert.match(r.needs[0], /Cursor host/);
  r = await bad({ OFFICE_CURSORCLOUD_REPOSITORY: 'git@github.com:acme/w.git' }).readiness();
  assert.match(r.needs.join(' '), /OFFICE_CURSORCLOUD_REPOSITORY cannot be used/);
  r = await bad({ OFFICE_CURSORCLOUD_REPOSITORY: REPO }).readiness();
  assert.equal(r.ready, true);
});

test('Cursor: off in the Security room is not ready and makes no call; turned on it is ready', async () => {
  let off = 'Cursor cloud agent runs tool calls without asking the office. Turn on Cloud agent on the Agents screen of the Security room first.';
  const p = cursor(noFetch, { blocked: () => off })({});
  assert.deepEqual(await p.readiness(), { ready: false, configured: true, version: null, needs: [off] });
  off = null;
  assert.equal((await p.readiness()).ready, true);
});

test('Cursor: a message launches an agent on the repository, polls until it finishes, shows the reply, then follows up on the same agent', async () => {
  const fetch = fakeCursor({ messages: [{ id: 'm1', type: 'user_message', text: 'hi' }, { id: 'm2', type: 'assistant_message', text: 'I added the widget.' }] });
  const o = office(cursor(fetch), 'cursor-cloud');
  const s = o.session();
  o.say(s, 'add a widget');
  await until(() => idle(s) && s.replies.length, 'the first reply');
  const launch = fetch.calls.find((c) => c.method === 'POST' && c.path === '/v0/agents');
  assert.equal(launch.host, 'api.cursor.com');
  assert.equal(launch.auth, 'Bearer ' + KEY);
  assert.match(launch.body.prompt.text, /add a widget/);
  assert.equal(launch.body.source.repository, REPO);
  assert.equal(launch.body.target?.autoCreatePr, false, 'the office never asks Cursor to open a pull request');
  assert.ok(s.replies.some((r) => /added the widget/.test(r.text)));
  assert.equal(s.cost ?? null, null, 'no dollars are made up');
  fetch.calls.length = 0;
  o.say(s, 'now a test');
  await until(() => fetch.calls.some((c) => /followup$/.test(c.path)), 'the follow-up');
  assert.equal(fetch.calls.filter((c) => c.method === 'POST' && c.path === '/v0/agents').length, 0, 'no second agent');
  assert.match(fetch.calls.find((c) => /followup$/.test(c.path)).body.prompt.text, /now a test/);
});

test('Cursor: an agent that ends in ERROR or EXPIRED ends the turn as an error in words', async () => {
  for (const [st, re] of [['ERROR', /Cursor stopped with an error/], ['EXPIRED', /expired/]]) {
    const o = office(cursor(fakeCursor({ status: st })), 'cursor-cloud');
    const s = o.session();
    o.say(s, 'go');
    await until(() => idle(s) || s.status === 'error', 'the end');
    assert.match(s.error?.text || s.error || JSON.stringify(s.replies), re);
  }
});

test('Cursor: a refused token is explained, and the key never shows in the words', async () => {
  const fetch = async () => json({ error: { message: 'bad key ' + KEY } }, 401);
  const o = office(cursor(fetch), 'cursor-cloud');
  const s = o.session();
  o.say(s, 'go');
  await until(() => s.error, 'the error');
  const text = s.error.text || String(s.error);
  assert.match(text, /refused the token/);
  assert.ok(!text.includes(KEY));
});

test('Cursor: interrupt tells Cursor to stop the agent and reads as stopped', async () => {
  const fetch = fakeCursor({ statuses: ['RUNNING'] });
  const o = office(cursor(fetch, { pollMs: 5 }), 'cursor-cloud');
  const s = o.session();
  o.say(s, 'long job');
  await until(() => fetch.calls.some((c) => c.method === 'GET'), 'polling');
  o.provider.interrupt(s); o.tracker.interrupt(s);
  await until(() => fetch.calls.some((c) => /\/stop$/.test(c.path)), 'the stop call');
  await until(() => idle(s), 'idle');
  assert.ok(!s.error, 'a stop is not an error');
});

// ---------- Hermes gateway ----------
const GW = 'http://127.0.0.1:8642/v1';
const gateway = (fetch, { env = {}, blocked } = {}) => {
  const e = { OFFICE_HERMESGATEWAY_ENDPOINT: GW, ...env };
  return (events) => createHermesGateway({ events, config: cloudConfig({ OFFICE_HERMESGATEWAY_TOKEN: KEY, ...e }, 'OFFICE_HERMESGATEWAY'), env: e, fetch, blocked });
};
const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (t) => chunk({ choices: [{ delta: { content: t } }] });

test('Hermes gateway: a message streams a chat completion with the key as a bearer; the reply shows; history goes with the next message', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return sse([delta('Hello'), delta(' there'), chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), 'data: [DONE]\n\n']);
  };
  const o = office(gateway(fetch), 'hermes-gateway');
  const s = o.session();
  o.say(s, 'hi');
  await until(() => idle(s) && s.replies.length, 'the reply');
  assert.equal(calls[0].url, GW + '/chat/completions');
  assert.equal(calls[0].auth, 'Bearer ' + KEY);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(s.replies.at(-1).text, 'Hello there');
  o.say(s, 'again');
  await until(() => calls.length === 2, 'the second call');
  assert.deepEqual(calls[1].body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('Hermes gateway: the key goes only to https or to this PC; any other http address is refused', async () => {
  const mk = (ep) => createHermesGateway({ events: {}, config: cloudConfig({ OFFICE_HERMESGATEWAY_ENDPOINT: ep, OFFICE_HERMESGATEWAY_TOKEN: KEY }, 'OFFICE_HERMESGATEWAY'), env: {}, fetch: noFetch });
  assert.equal((await mk('http://127.0.0.1:8642/v1').readiness()).ready, true);
  assert.equal((await mk('https://gateway.example.com/v1').readiness()).ready, true);
  const r = await mk('http://gateway.example.com/v1').readiness();
  assert.equal(r.ready, false);
  assert.match(r.needs[0], /must start with https/);
});

test('Hermes gateway: off in the Security room is not ready and makes no call; an HTTP error ends the turn in words', async () => {
  let off = 'Hermes gateway runs tool calls without asking the office. Turn on Cloud agent on the Agents screen of the Security room first.';
  const p = gateway(noFetch, { blocked: () => off })({});
  assert.deepEqual((await p.readiness()).needs, [off]);
  off = null;
  assert.equal((await p.readiness()).ready, true);
  const o = office(gateway(async () => json({ error: { message: 'down' } }, 503)), 'hermes-gateway');
  const s = o.session();
  o.say(s, 'x');
  await until(() => s.error, 'the error');
  assert.match(s.error.text || String(s.error), /answered 503/);
});

test('server and office wire both kinds: settings read before any process starts, kinds in the registry', async () => {
  const fs = await import('node:fs');
  const server = fs.readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const first = server.search(/\b(spawn|execFileSync|execFile|exec)\(/);
  for (const prefix of ['OFFICE_CURSORCLOUD', 'OFFICE_HERMESGATEWAY']) {
    const at = server.indexOf(`cloudConfig(process.env, '${prefix}')`);
    assert.ok(at > 0 && at < first, prefix + ' is read before the first process start');
  }
  const office2 = fs.readFileSync(new URL('../src/office.mjs', import.meta.url), 'utf8');
  assert.match(office2, /createCursorCloud/);
  assert.match(office2, /createHermesGateway/);
});

test('the Security room puts both kinds in the Cloud agent column', async () => {
  await import('../src/vocab.mjs');
  const V = globalThis.OfficeVocab.security;
  assert.equal(V.columnOf('cursor-cloud'), 'cloud');
  assert.equal(V.columnOf('hermes-gateway'), 'cloud');
});
