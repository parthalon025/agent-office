// Function floors on a real server.mjs run from a throwaway copy (#92), set up like floors-routes.test.mjs: a repository that
// looks like a software product (a manifest and tests) is detected once, its floors change only through POST /api/layout, a
// session opened from an empty desk sits on that desk's floor, and its room keeps that floor and a name from its task.
// A local fake-model session stands for an agent. Windows only (sessions open through /api/open).
// The state.json the office starts with also has room records in the wrong shape (#92 review): one with no floors used to throw
// on every broadcast, so the office could not show a snapshot.
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
import { normPath, placeOfSession } from '../place.mjs';
import * as git from '../git.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
const GIT = git.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let base, repo, key, child, port, pageToken, fake, copy;

const until = (fn, what) => untilTrue(fn, what, { log: () => child?.out() });
const call = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': pageToken }, body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-office-token': pageToken } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const state = () => JSON.parse(fs.readFileSync(officeFiles(copy, port).state, 'utf8'));

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-layout-'));
  fs.mkdirSync(path.join(base, 'repo'));
  repo = fs.realpathSync.native(path.join(base, 'repo'));
  key = normPath(repo);
  plain(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test', 'a.test.mjs'), '');
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
  // The main checkout's record has no floors and a name from a prompt; the others are junk. Its root is a worktree of the
  // repository, so the first worktree refresh keeps it (dropGoneRooms takes only records whose worktree is gone).
  const mainKey = placeOfSession({ repo, root: repo, branch: 'main' }, repo).noteKey;
  const rooms = { [mainKey]: { building: key, root: key, title: { name: '#7', by: 'issue' } }, junk: 5, [key + '|w-x-00000001']: { building: key, root: 7, floors: 'quality' } };
  const started = await startOnFreePort(copy, env, { prepare: (p) => fs.writeFileSync(officeFiles(copy, p).state, JSON.stringify({ recent: [repo], rooms })) });
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

test('room records in the wrong shape are put in the one form at start: the office broadcasts and shows a snapshot', { skip: SKIP }, async () => {
  const mainKey = placeOfSession({ repo, root: repo, branch: 'main' }, repo).noteKey;
  assert.deepEqual(state().rooms, { [mainKey]: { building: key, root: key, floors: [], title: null } }, 'the junk goes; the main checkout keeps no name from a prompt');
  const ev = await fetch(`http://127.0.0.1:${port}/events`, { headers: { 'x-office-token': pageToken } });
  const reader = ev.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
  await reader.cancel();
  const snap = JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')));
  assert.deepEqual(snap.rooms[mainKey], { floors: [], title: null });
  assert.ok(snap.layouts[key], 'the building has its floors');
});

test('detection runs once: the building is proposed as a software product, and the memo asks until the user confirms', { skip: SKIP }, async () => {
  const saved = state().layouts[key];
  assert.equal(saved.proposed, 'software');
  assert.equal(saved.confirmed, false);
  // a file that would change the guess does not change it: detection ran already
  fs.mkdirSync(path.join(repo, '.obsidian'));
  const r = await call('/api/layout', { building: key, action: 'confirm' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.layout.archetype, 'software');
  assert.equal(r.json.layout.confirmed, true);
  assert.deepEqual(r.json.layout.floors.map((f) => f.id), ['lobby', 'engineering', 'quality', 'security', 'it-ops', 'design', 'support', 'docs', 'records']);
  assert.equal(state().layouts[key].confirmed, true);
});

test('the user switches, renames, adds, hides and reorders floors; a bad change is refused with the reason', { skip: SKIP }, async () => {
  let r = await call('/api/layout', { building: key, action: 'switch', archetype: 'ops-hub' });
  assert.equal(r.json.layout.archetypeName, 'Operations Hub');
  r = await call('/api/layout', { building: key, action: 'rename', floor: 'quality', name: 'Review desk' });
  assert.equal(r.json.layout.floors.find((f) => f.id === 'quality').name, 'Review desk');
  r = await call('/api/layout', { building: key, action: 'add', floor: 'finance' });
  assert.ok(r.json.layout.floors.some((f) => f.id === 'finance'));
  r = await call('/api/layout', { building: key, action: 'hide', floor: 'finance' });
  assert.equal(r.json.layout.floors.find((f) => f.id === 'finance').hidden, true);
  r = await call('/api/layout', { building: key, action: 'move', floor: 'planning', by: -1 });
  assert.deepEqual(r.json.layout.floors.slice(1, 3).map((f) => f.id), ['planning', 'executive']);
  r = await call('/api/layout', { building: key, action: 'hide', floor: 'lobby' });
  assert.equal(r.status, 400); assert.match(r.json.error, /Lobby/);
  r = await call('/api/layout', { building: 'c:\\nowhere', action: 'confirm' });
  assert.equal(r.status, 404);
});

// The session works in the main checkout (isolation: same), which ad-hoc sessions share: its room is named by the branch, never
// by a prompt, and it leaves the floor once no agent of it sits there (owner rule, #92 review).
test('a session started from an empty desk sits on that floor; the main checkout room is there while it lives, named by its branch', { skip: SKIP }, async () => {
  const bad = await call('/api/open', { cwd: repo, name: 'x', provider: 'ollama', model: 'fake-model', where: 'office', isolation: 'same', role: 'army' });
  assert.equal(bad.status, 400);
  const o = await call('/api/open', { cwd: repo, name: 'desk-bot', provider: 'ollama', model: 'fake-model', where: 'office', isolation: 'same', role: 'quality', prompt: 'Tidy the readme for #7' });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  let s = null;
  await until(async () => { s = (await get('/api/session?uid=' + o.json.uid)).json.session; return !!(s && s.seat); }, 'the session to be seated');
  assert.deepEqual(s.seat, { floor: 'quality', by: 'desk' });
  const nk = placeOfSession({ repo, root: repo, branch: 'main' }, repo).noteKey;
  assert.equal(s.place.noteKey, nk, 'the notes key is the building key plus the room id, as before');
  await until(async () => state().rooms?.[nk]?.floors?.length, 'the room record');
  const rec = state().rooms[nk];
  assert.deepEqual(rec.floors, ['quality']);
  assert.deepEqual(rec.title, { name: 'main', by: 'branch' }, 'not "#7" from the prompt');
  assert.equal((await call('/api/close', { uid: o.json.uid })).status, 200);
  await until(async () => state().rooms?.[nk]?.floors?.length === 0, 'the floor to leave the room record');
  assert.deepEqual(state().rooms[nk].title, { name: 'main', by: 'branch' }, 'the record keeps its name');
});
