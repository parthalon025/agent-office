// Rituals through the office core, in process (#151): the recap and away route, Focus mode, and the stand-up line at an
// agent's first turn of the day (a fake local model records the prompt). Windows only (sessions open through /api/open).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';
import { startInProcess, removeTree } from './fixtures/office-inproc.mjs';
import { until as untilTrue } from './fixtures/office-server.mjs';
import { normPath } from '../src/place.mjs';
import * as git from '../src/git.mjs';
import * as launch from '../src/launch.mjs';

const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
const GIT = launch.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let base, repo, rig, fake;

const until = (fn, what) => untilTrue(fn, what, { ms: 30000 });
const call = (route, body) => rig.call(route, body || {});
const get = (route) => rig.call(route);
const userTexts = () => fake.requests.map((q) => String([...q.messages].reverse().find((m) => m.role === 'user')?.content || ''));

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rituals-'));
  fs.mkdirSync(path.join(base, 'repo'));
  repo = fs.realpathSync.native(path.join(base, 'repo'));
  plain(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  plain(repo, 'add', '-A'); plain(repo, 'commit', '-m', 'one');
  fake = await startFakeOpenAI({ script: [{ text: 'ok' }], models: ['fake-model'] });
  const merges = [{ key: `${normPath(repo)}#4`, repo: normPath(repo), number: 4, title: 'Add the thing', head: 'agent/x', at: Date.now() - 3600000 }];
  rig = await startInProcess({ dir: base, env: { OFFICE_OLLAMA_URL: fake.url }, state: { recent: [repo], merges } });
  await until(async () => (await call('/api/branches', { repo })).status === 200, 'the repository to be known');
});
after(async () => {
  try {
    if (rig) rig.stop();
    if (fake) await fake.close();
  } finally {
    if (base) await removeTree(base);
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
