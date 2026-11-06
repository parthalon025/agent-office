// Rituals on a real server.mjs run from a throwaway copy (#151): the recap and away route, Focus mode, and the stand-up line at an
// agent's first turn of the day (a fake local model records the prompt). Windows only (sessions open through /api/open).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';
import { pageFile } from '../auth.mjs';
import { startOnFreePort, until as untilTrue } from './fixtures/office-server.mjs';
import { officeFiles } from '../files.mjs';
import { normPath } from '../place.mjs';
import * as git from '../git.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
const GIT = git.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let base, repo, child, port, pageToken, fake, copy;

const until = (fn, what) => untilTrue(fn, what, { log: () => child?.out() });
const call = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': pageToken }, body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-office-token': pageToken } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const userTexts = () => fake.requests.map((q) => String([...q.messages].reverse().find((m) => m.role === 'user')?.content || ''));

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rituals-'));
  fs.mkdirSync(path.join(base, 'repo'));
  repo = fs.realpathSync.native(path.join(base, 'repo'));
  plain(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  plain(repo, 'add', '-A'); plain(repo, 'commit', '-m', 'one');
  copy = path.join(base, 'office');
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !/^(state|history)(-\d+)?\.json$/.test(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  fake = await startFakeOpenAI({ script: [{ text: 'ok' }], models: ['fake-model'] });
  const env = { ...process.env, OFFICE_HOOKS: 'command', OFFICE_OLLAMA_URL: fake.url, OFFICE_RATE_FILE: path.join(base, 'no-rate.json'),
    OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local') };
  const merges = [{ key: `${normPath(repo)}#4`, repo: normPath(repo), number: 4, title: 'Add the thing', head: 'agent/x', at: Date.now() - 3600000 }];
  const started = await startOnFreePort(copy, env, { prepare: (p) => fs.writeFileSync(officeFiles(copy, p).state, JSON.stringify({ recent: [repo], merges })) });
  child = started.office;
  port = started.port;
  pageToken = JSON.parse(fs.readFileSync(pageFile(started.env, port), 'utf8')).token;
  await until(async () => (await call('/api/branches', { repo })).status === 200, 'the repository to be known');
});
after(async () => {
  try {
    if (child) await child.stop();
    if (fake) await fake.close();
  } finally {
    if (base) try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* a temp folder may stay */ }
  }
});

const open = (name) => call('/api/open', { cwd: repo, name, provider: 'ollama', model: 'fake-model', where: 'office', isolation: 'same', prompt: `Work as ${name}` });

test('the recap route reads the merges the office kept, and the away list', { skip: SKIP }, async () => {
  const r = await get('/api/recap?since=0');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.shipped.map((m) => m.number), [4]);
  assert.equal(r.json.days, 7);
  assert.equal(r.json.metrics.merges, 1);
  assert.ok(Array.isArray(r.json.away));
  assert.equal(r.json.focus, false);
});

test('the first turn of the day carries the stand-up line once per agent name; Focus mode turns it off', { skip: SKIP }, async () => {
  assert.equal((await open('Ada')).status, 200);
  await until(() => userTexts().length >= 1, 'the first prompt');
  assert.match(userTexts()[0], /^Stand-up\./);
  assert.match(userTexts()[0], /Work as Ada$/);
  const n = userTexts().length;
  assert.equal((await open('ada')).status, 200);
  await until(() => userTexts().length > n, 'the second prompt');
  assert.doesNotMatch(userTexts()[n], /Stand-up/, 'the same agent name, the same day');
  let f = await call('/api/settings/focus', { on: true });
  assert.equal(f.json.focus, true);
  assert.equal((await get('/api/recap')).json.focus, true);
  const m = userTexts().length;
  assert.equal((await open('Bob')).status, 200);
  await until(() => userTexts().length > m, 'the prompt of Bob');
  assert.doesNotMatch(userTexts()[m], /Stand-up/, 'Focus mode');
  f = await call('/api/settings/focus', { on: false });
  assert.equal(f.json.focus, false);
  const k = userTexts().length;
  assert.equal((await open('Cleo')).status, 200);
  await until(() => userTexts().length > k, 'the prompt of Cleo');
  assert.match(userTexts()[k], /^Stand-up\./);
});
