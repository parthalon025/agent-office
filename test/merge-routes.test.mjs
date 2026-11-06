// Paper flow on a real server.mjs run from a throwaway copy (#93): the office reads pull requests with `gh` (read-only), puts the
// ready ones in the snapshot, and POST /api/merge still needs the confirm. A copy of node.exe named gh.exe, with a preload that
// answers `gh pr list` and `gh pr merge`, stands for gh (as test/mcp-routes.test.mjs does for openclaw). Windows only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageFile } from '../src/auth.mjs';
import { startOnFreePort, until as untilTrue, copyOffice } from './fixtures/office-server.mjs';
import { officeFiles } from '../src/files.mjs';
import { normPath } from '../src/place.mjs';
import * as git from '../src/git.mjs';
import * as launch from '../src/launch.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = process.platform !== 'win32' ? 'the fake gh is a Windows .exe' : false;
const GIT = launch.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let base, repo, key, child, port, pageToken, copy, listFile, logFile;

const until = (fn, what) => untilTrue(fn, what, { log: () => child?.out() });
const call = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': pageToken }, body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const merges = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
const ok = { status: 'COMPLETED', conclusion: 'SUCCESS' };
const pr = (o) => ({ number: 7, title: 'Seven', state: 'OPEN', isDraft: false, headRefName: 'feat/seven', baseRefName: 'main', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', statusCheckRollup: [ok], additions: 2, deletions: 1, changedFiles: 1, url: 'https://example.test/7', ...o });
const setList = (list) => fs.writeFileSync(listFile, JSON.stringify(list));
async function snapshot() {
  const ev = await fetch(`http://127.0.0.1:${port}/events`, { headers: { 'x-office-token': pageToken } });
  const reader = ev.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
  await reader.cancel();
  return JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')));
}

before(async () => {
  if (SKIP) return;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-merge-'));
  fs.mkdirSync(path.join(base, 'repo'));
  repo = fs.realpathSync.native(path.join(base, 'repo'));
  key = normPath(repo);
  plain(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  plain(repo, 'add', '-A'); plain(repo, 'commit', '-m', 'one');
  copy = path.join(base, 'office');
  fs.mkdirSync(copy);
  copyOffice(copy);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(process.execPath, path.join(bin, 'gh.exe'));
  listFile = path.join(base, 'list.json'); logFile = path.join(base, 'merges.log');
  const pre = path.join(base, 'fake-gh.cjs');
  fs.writeFileSync(pre, `
if (require('path').basename(process.execPath).toLowerCase() === 'gh.exe') {
  const fs = require('fs'), a = [require('path').basename(process.argv[1]), ...process.argv.slice(2)];
  if (a[0] === 'pr' && a[1] === 'list') {
    if (!fs.existsSync(process.env.GH_FAKE_LIST)) { console.error('gh: not signed in'); process.exit(1); }
    process.stdout.write(fs.readFileSync(process.env.GH_FAKE_LIST, 'utf8')); process.exit(0);
  }
  if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(process.env.GH_FAKE_LOG, a.join(' ') + '\\n'); process.exit(0); }
  console.error('gh: unexpected ' + a.join(' ')); process.exit(2);
}`);
  setList([pr({})]);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NODE_OPTIONS: `--require ${pre.replace(/\\/g, '/')}`, GH_FAKE_LIST: listFile, GH_FAKE_LOG: logFile,
    OFFICE_HOOKS: 'command', OFFICE_RATE_FILE: path.join(base, 'no-rate.json'), OFFICE_OPEN: '0', LOCALAPPDATA: path.join(base, 'local') };
  const started = await startOnFreePort(copy, env, { prepare: (p) => fs.writeFileSync(officeFiles(copy, p).state, JSON.stringify({ recent: [repo] })) });
  child = started.office; port = started.port;
  pageToken = JSON.parse(fs.readFileSync(pageFile(started.env, port), 'utf8')).token;
  await until(async () => (await call('/api/branches', { repo })).status === 200, 'the repository to be known');
});
after(async () => {
  try { if (child) await child.stop(); } finally {
    if (base) try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a temp folder may stay */ }
  }
});

test('the snapshot carries the pull requests gh lists, and the ready one in the Ready to merge entries', { skip: SKIP }, async () => {
  await until(async () => (await snapshot()).changes?.[key]?.ok === true, 'the office to read the pull requests');
  const c = (await snapshot()).changes[key];
  assert.equal(c.prs[0].number, 7); assert.equal(c.prs[0].state, 'ready'); assert.equal(c.prs[0].stage, 'merge');
  assert.deepEqual(c.ready.map((e) => [e.kind, e.number, e.recommendation]), [['merge', 7, 'Merge']]);
  assert.equal(merges().length, 0, 'reading merges nothing');
});

test('merge still needs the confirm: the first call is 409 with confirm: merge and nothing runs; the confirmed call merges', { skip: SKIP }, async () => {
  const ask = await call('/api/merge', { repo: key, number: 7 });
  assert.equal(ask.status, 409, JSON.stringify(ask.json));
  assert.equal(ask.json.confirm, 'merge');
  assert.match(ask.json.error, /Merge #7/);
  assert.equal((await call('/api/merge', { repo: key, number: 7, confirmed: 'yes' })).status, 409, 'only true confirms');
  assert.equal(merges().length, 0);
  const yes = await call('/api/merge', { repo: key, number: 7, confirmed: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.deepEqual(merges(), ['pr merge 7 --merge']);
});

test('merge refuses a change that is not ready now, an unknown building and a bad number', { skip: SKIP }, async () => {
  setList([pr({ number: 8, reviewDecision: 'REVIEW_REQUIRED' })]);
  const notReady = await call('/api/merge', { repo: key, number: 8, confirmed: true });
  assert.equal(notReady.status, 409); assert.match(notReady.json.error, /not ready/);
  assert.equal((await call('/api/merge', { repo: 'nowhere', number: 8, confirmed: true })).status, 404);
  assert.equal((await call('/api/merge', { repo: key, number: 'x', confirmed: true })).status, 400);
  assert.equal(merges().length, 1, 'no new merge');
});

test('a failed gh read is PR state unknown: no merge, and no old list in the snapshot', { skip: SKIP }, async () => {
  fs.rmSync(listFile);
  const r = await call('/api/merge', { repo: key, number: 7, confirmed: true });
  assert.equal(r.status, 409); assert.match(r.json.error, /PR state unknown/);
  await until(async () => (await snapshot()).changes?.[key]?.ok === false, 'the snapshot to say the read failed');
  const c = (await snapshot()).changes[key];
  assert.deepEqual(c.prs, []); assert.deepEqual(c.ready, []); assert.equal(c.error, 'PR state unknown');
  assert.equal(merges().length, 1);
});
