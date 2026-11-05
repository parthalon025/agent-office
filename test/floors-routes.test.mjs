// The floor clean-up routes (/api/floor/stale, /api/floor/cleanup) against a real server.mjs run from a throwaway
// copy (same setup as mcp-routes.test.mjs): a repo with floors that are safe, dirty, ahead, busy and unknown.
// A local fake-model session stands for "a session works in this room". Rooms are made under the office's worktree
// folder with unique names and removed at the end. Windows only (sessions open through /api/open).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI } from './fixtures/fake-openai.mjs';
import { pageFile } from '../auth.mjs';
import { officeFiles } from '../files.mjs';
import * as git from '../git.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = process.platform !== 'win32' ? 'opening sessions is only implemented for Windows' : false;
const GIT = git.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
const FLOORS = ['done', 'dirty', 'ahead', 'busy'];
let base, repo, child, port, pageToken, fake, log = '', rooms = {};

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
  s.on('error', reject);
});
// A server that starts while other suites run can need more than 15 s; a fast start still returns at once.
const until = async (fn, what, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}\n${log.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const call = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': pageToken }, body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const openIn = async (cwd, name) => {
  const r = await call('/api/open', { cwd, name, provider: 'ollama', model: 'fake-model', where: 'office' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
};

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-floorsr-'));
  fs.mkdirSync(path.join(base, 'repo'));
  repo = fs.realpathSync.native(path.join(base, 'repo'));
  plain(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  plain(repo, 'add', '-A'); plain(repo, 'commit', '-m', 'one');
  for (const f of FLOORS) rooms[f] = (await git.createFloor(repo, f, '', tag + f)).root;
  fs.writeFileSync(path.join(rooms.dirty, 'new.txt'), 'x');
  fs.writeFileSync(path.join(rooms.ahead, 'b.txt'), 'b');
  plain(rooms.ahead, 'add', '-A'); plain(rooms.ahead, 'commit', '-m', 'two');
  const copy = path.join(base, 'office');
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(SRC)) {
    if (/\.(mjs|json|ps1)$/.test(f) && !/^(state|history)(-\d+)?\.json$/.test(f) && !f.startsWith('office-')) fs.copyFileSync(path.join(SRC, f), path.join(copy, f));
  }
  for (const d of ['providers', 'public']) fs.cpSync(path.join(SRC, d), path.join(copy, d), { recursive: true });
  fake = await startFakeOpenAI({ script: [{ text: 'ok' }], models: ['fake-model'] });
  port = await freePort();
  // The repo is a building before any session. The state file of an office on a free port has the port in its name.
  fs.writeFileSync(officeFiles(copy, port).state, JSON.stringify({ recent: [repo] }));
  const env = { ...process.env, OFFICE_PORT: String(port), OFFICE_HOOKS: 'command', OFFICE_OLLAMA_URL: fake.url, OFFICE_RATE_FILE: path.join(base, 'no-rate.json'),
    OFFICE_FLOOR_MIN_AGE_MS: '0', OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local') };
  child = spawn(process.execPath, ['server.mjs'], { cwd: copy, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  pageToken = await until(() => { try { return JSON.parse(fs.readFileSync(pageFile(env, port), 'utf8')).token; } catch { return null; } }, 'the page token file');
  await until(async () => (await call('/api/branches', { repo })).status === 200, 'the repository to be known');
  await openIn(rooms.busy, 'busy-bot');
});
after(async () => {
  if (child) child.kill();
  if (fake) await fake.close();
  for (const b of [...FLOORS, 'late', 'fresh']) await git.deleteFloor(repo, b, true).catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); // let Windows release the folder
  if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* a temp folder may stay */ }
});

test('stale lists only merged, clean floors with no session', { skip: SKIP }, async () => {
  const r = await call('/api/floor/stale', { repo });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.floors.map((f) => f.branch), ['done']);
});

test('cleanup deletes the safe floor and skips dirty, ahead, busy, main and unknown ones', { skip: SKIP }, async () => {
  const r = await call('/api/floor/cleanup', { repo, branches: ['done', 'dirty', 'ahead', 'busy', 'main', 'nope'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.deleted, ['done']);
  assert.deepEqual([...r.json.skipped].sort(), ['ahead', 'busy', 'dirty', 'main', 'nope']);
  const left = (await git.layout(repo)).map((w) => w.branch);
  assert.ok(!left.includes('done') && ['dirty', 'ahead', 'busy'].every((b) => left.includes(b)), left.join());
});

test('cleanup takes branches that are not a list as an empty list', { skip: SKIP }, async () => {
  for (const branches of ['done', null, { 0: 'dirty' }, 7]) {
    const r = await call('/api/floor/cleanup', { repo, branches });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { deleted: [], skipped: [] });
  }
});

test('a room made outside the office, with a session in it, is not removed before the 30 s refresh', { skip: SKIP }, async () => {
  const root = path.join(path.dirname(rooms.busy), tag + 'late');
  plain(repo, 'worktree', 'add', '-b', 'late', root, 'main');
  await openIn(root, 'late-bot');
  const s = await call('/api/floor/stale', { repo });
  assert.ok(!s.json.floors.some((f) => f.branch === 'late'), 'stale offers a floor a session works on');
  const r = await call('/api/floor/cleanup', { repo, branches: ['late'] });
  assert.deepEqual(r.json, { deleted: [], skipped: ['late'] });
  assert.ok(fs.existsSync(root));
  const d = await call('/api/floor/delete', { repo, branch: 'late' });
  assert.equal(d.status, 409, 'delete floor must also see the session');
});

// No call before this one refreshes the office's copy of the room list (clean-up does, after each run), so a
// delete that read the cached list would not know the new room and would delete the floor under the session.
test('delete floor reads git, not the cached room list, so it sees a room made a moment ago', { skip: SKIP }, async () => {
  const root = path.join(path.dirname(rooms.busy), tag + 'fresh');
  plain(repo, 'worktree', 'add', '-b', 'fresh', root, 'main');
  await openIn(root, 'fresh-bot');
  const d = await call('/api/floor/delete', { repo, branch: 'fresh' });
  assert.equal(d.status, 409, JSON.stringify(d.json));
  assert.match(d.json.error || '', /works on this floor/);
  assert.ok(fs.existsSync(root), 'the room must stay');
});
