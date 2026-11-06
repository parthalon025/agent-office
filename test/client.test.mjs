// The page client (#178): every route the page calls is a named command; the error and question rules live in one place.
// Tested with a fake fetch, no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/ask.js';
import '../public/client.js';

const Client = globalThis.OfficeClient;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function rig(answer) {
  const calls = [];
  const fetch = async (path, opts) => {
    calls.push({ path, opts });
    const a = typeof answer === 'function' ? answer(path, opts) : answer;
    return { ok: a.status < 400, status: a.status, json: async () => { if (a.raw) throw new Error('not json'); return a.body; }, text: async () => a.text ?? '' };
  };
  const events = [];
  const client = Client.createClient({ fetch, ready: () => { events.push('ready'); return Promise.resolve(); } });
  return { client, calls, events };
}

test('a command posts JSON to its own route, after the page is ready', async () => {
  const { client, calls, events } = rig({ status: 200, body: { ok: true } });
  const j = await client.open({ cwd: 'C:/x' });
  assert.deepEqual(j, { ok: true });
  assert.deepEqual(events, ['ready']);
  assert.equal(calls[0].path, '/api/open');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  assert.equal(calls[0].opts.body, '{"cwd":"C:/x"}');
});

test('a command without a body sends an empty object; send(name) reaches the same route as the named method', async () => {
  const { client, calls } = rig({ status: 200, body: {} });
  await client.historyForget();
  await client.send('skillsList', { provider: 'hermes' });
  assert.equal(calls[0].path, '/api/history/forget');
  assert.equal(calls[0].opts.body, '{}');
  assert.equal(calls[1].path, '/api/skills/list');
});

test('a failed call rejects with the server text, the status and the body', async () => {
  const { client } = rig({ status: 409, body: { error: 'Its room was removed.', confirm: 'merge' } });
  await assert.rejects(client.merge({}), (e) => e.message === 'Its room was removed.' && e.status === 409 && e.body.confirm === 'merge');
});

test('a failed call with no text, or no JSON, says the status', async () => {
  const a = rig({ status: 500, body: {} });
  await assert.rejects(a.client.close({}), (e) => e.message === 'The office could not do that (500).' && e.status === 500);
  const b = rig({ status: 502, raw: true });
  await assert.rejects(b.client.close({}), (e) => e.message === 'The office could not do that (502).' && e.body && typeof e.body === 'object');
});

test('a question that answers 200 rejects like a 409, and OfficeAsk reads it', async () => {
  const { client } = rig({ status: 200, body: { confirm: 'cost', question: 'Run it?' } });
  await assert.rejects(client.open({}), (e) => {
    const q = globalThis.OfficeAsk.asked(e, 'cost', false);
    return e.status === 200 && q && q.text === 'Run it?';
  });
});

test('reads: get() puts the query in the address, encoded, and drops empty values', async () => {
  const { client, calls } = rig({ status: 200, body: { folders: [] } });
  await client.get('choices', { first: 'C:/a b' });
  await client.get('info', { first: '' });
  await client.get('providers', { fresh: 1 });
  assert.equal(calls[0].path, '/api/choices?first=C%3A%2Fa%20b');
  assert.equal(calls[1].path, '/api/info');
  assert.equal(calls[2].path, '/api/providers?fresh=1');
  assert.equal(calls[0].opts, undefined);
});

test('a read that fails rejects with the status; text() gives the raw body', async () => {
  const a = rig({ status: 503, body: {} });
  await assert.rejects(a.client.get('providers'), (e) => e.message === '503' && e.status === 503);
  const b = rig({ status: 200, text: '{"a":1}' });
  assert.equal(await b.client.text('customExport'), '{"a":1}');
});

test('the access calls do not wait for ready (they are how the page gets ready)', async () => {
  const { client, calls, events } = rig((p) => p === '/api/auth' ? { status: 401, body: { error: 'No access.' } } : { status: 200, body: {} });
  const r = await client.auth();
  assert.deepEqual(r, { ok: false, status: 401, body: { error: 'No access.' } });
  const l = await client.launch('abc');
  assert.equal(l.ok, true);
  await client.signin();
  assert.deepEqual(events, []);
  assert.deepEqual(calls.map((c) => c.path), ['/api/auth', '/launch', '/remote/signin']);
  assert.equal(calls[1].opts.body, '{"code":"abc"}');
});

test('an unknown command is refused at once', () => {
  const { client } = rig({ status: 200, body: {} });
  assert.throws(() => client.send('nope', {}), /Unknown office command: nope/);
  assert.throws(() => client.get('nope'), /Unknown office command: nope/);
});

test('every command is a server route, and no other page file has a route string', () => {
  const src = readFileSync(join(root, 'src/server.mjs'), 'utf8');
  const server = new Set([...src.matchAll(/'(\/api\/[a-z/]+)'/g)].map((m) => m[1]));
  const skills = ['/api/skills/list', '/api/skills/read', '/api/skills/save', '/api/skills/delete'];
  for (const p of Object.values(Client.ROUTES)) {
    if (p.startsWith('/api/')) assert.ok(server.has(p) || skills.includes(p), `${p} is not a server route`);
  }
  const pub = join(root, 'public');
  for (const f of readdirSync(pub).filter((n) => n.endsWith('.js') && n !== 'client.js')) {
    const text = readFileSync(join(pub, f), 'utf8');
    assert.ok(!/\/api\//.test(text), `${f} has a route string: only client.js knows the routes`);
  }
});
