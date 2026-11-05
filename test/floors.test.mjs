// Floors and rooms: a named room, and the clean-up list of unused floors (git.mjs staleFloors).
// Offline: a throwaway repo in os.tmpdir. Rooms are made under the office's worktree folder with a unique
// name and removed at the end of each test.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as git from '../git.mjs';

const GIT = git.resolveExe('git');
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const plain = (cwd, ...a) => execFileSync(GIT, [...IDENT, ...a], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

// Every repository this file makes, and the <repo>.worktrees folder next to it that an agent room (createWorktree) makes:
// removed at the end, so no run leaves folders in %TEMP% (a test's own finally may have removed them already).
const made = [];
after(() => { for (const d of made) for (const x of [d, d + '.worktrees']) fs.rmSync(x, { recursive: true, force: true }); });
function repo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-floors-')));
  made.push(dir);
  plain(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  plain(dir, 'add', '-A'); plain(dir, 'commit', '-m', 'one');
  return dir;
}

test('roomNameOf keeps a safe folder name and refuses a name with no letters', () => {
  assert.equal(git.roomNameOf(''), '');
  assert.equal(git.roomNameOf('  Login work! '), 'Login-work');
  assert.equal(git.roomNameOf('../../x'), 'x');
  assert.throws(() => git.roomNameOf('???'), /letters or digits/);
});

test('roomNameOf turns accented letters into plain ones and does not drop them', () => {
  assert.equal(git.roomNameOf('Ünïcode'), 'Unicode');
  assert.equal(git.roomNameOf('café déjà vu'), 'cafe-deja-vu');
  assert.equal(git.roomNameOf('Straße Ørsted'), 'Strasse-Orsted');
  assert.equal(git.roomNameOf('Łódź'), 'Lodz');
  assert.throws(() => git.roomNameOf('日本語'), /letters or digits/);
});

test('a named room gets that folder name, and a second one with the same name gets a number', async () => {
  const dir = repo();
  const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
  try {
    const a = await git.createFloor(dir, 'feat/x', '', tag);
    assert.equal(path.basename(a.root), tag);
    const b = await git.createRoom(dir, 'feat/x', tag);
    assert.equal(path.basename(b.root), tag + '-2');
  } finally {
    await git.deleteFloor(dir, 'feat/x', true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleFloors lists merged clean floors only', async () => {
  const dir = repo();
  const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
  try {
    await git.createFloor(dir, 'done', '', tag + 'a');          // merged (same commit as main), clean
    const dirty = await git.createFloor(dir, 'dirty', '', tag + 'b');
    fs.writeFileSync(path.join(dirty.root, 'new.txt'), 'x');    // an untracked file
    const ahead = await git.createFloor(dir, 'ahead', '', tag + 'c');
    fs.writeFileSync(path.join(ahead.root, 'b.txt'), 'b');
    plain(ahead.root, 'add', '-A'); plain(ahead.root, 'commit', '-m', 'two'); // not merged
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), [{ branch: 'done', rooms: 1 }]);
  } finally {
    for (const b of ['done', 'dirty', 'ahead']) await git.deleteFloor(dir, b, true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #69 with #86: an agent room (createWorktree) sits on the floor of its base branch. Its branch is no floor, and the floor it
// sits on is in use (deleteFloor refuses it until the agent room is removed), so neither is offered for clean-up.
test('staleFloors offers no agent branch, and no floor an agent room sits on', async () => {
  const dir = repo();
  const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
  let agent = null;
  try {
    await git.createFloor(dir, 'done', '', tag + 'a');
    const busy = await git.createFloor(dir, 'busy', '', tag + 'b');
    agent = await git.createWorktree(busy.root, tag + 'bot');   // an agent opened from the busy floor
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), [{ branch: 'done', rooms: 1 }]);
  } finally {
    if (agent) await git.removeRoom(dir, agent.root, true).catch(() => {});
    for (const b of ['done', 'busy']) await git.deleteFloor(dir, b, true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('roomNameOf refuses Windows reserved names and never ends in a dot or dash after the cut', () => {
  for (const n of ['con', 'NUL', 'aux', 'COM1', 'lpt9', 'con.txt']) assert.throws(() => git.roomNameOf(n), /reserves/i, n);
  assert.equal(git.roomNameOf('console'), 'console');
  const cut = git.roomNameOf('a'.repeat(39) + '.b');
  assert.ok(!/[.-]$/.test(cut), cut);
  assert.ok(cut.length <= 40);
});

test('staleFloors never offers the default branch, even when the main folder is on another branch', async () => {
  const dir = repo();
  const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
  try {
    plain(dir, 'checkout', '-b', 'feat/work');
    await git.createRoom(dir, 'main', tag);                    // main is open in a room, merged and clean
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), []);
  } finally {
    plain(dir, 'worktree', 'prune');
    await git.deleteFloor(dir, 'main', true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleFloors: a floor with two rooms is not stale when one room is dirty; a detached main folder lists nothing', async () => {
  const dir = repo();
  const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
  try {
    await git.createFloor(dir, 'two', '', tag + 'a');
    const second = await git.createRoom(dir, 'two', tag + 'b');
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), [{ branch: 'two', rooms: 2 }]);
    fs.writeFileSync(path.join(second.root, 'x.txt'), 'x');
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), []);
    fs.rmSync(path.join(second.root, 'x.txt'));
    plain(dir, 'checkout', '--detach');
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), []);
  } finally {
    await git.deleteFloor(dir, 'two', true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staleFloors leaves out a floor whose room is younger than the minimum age', async () => {
  const dir = repo();
  const tag = 'aotest' + crypto.randomBytes(3).toString('hex');
  try {
    await git.createFloor(dir, 'fresh', '', tag);
    assert.deepEqual(await git.staleFloors(dir), []);                                    // default: one hour
    assert.deepEqual(await git.staleFloors(dir, { minAgeMs: 0 }), [{ branch: 'fresh', rooms: 1 }]);
  } finally {
    await git.deleteFloor(dir, 'fresh', true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- relayout: a failed `git worktree list` must not make the office forget a repository (#81) ----------
const LAST = [{ root: path.normalize('C:\\r'), branch: 'main', main: true, prunable: false }];
const NEW = [...LAST, { root: path.normalize('C:\\r2'), branch: 'x', main: false, prunable: false }];

const later = (ms, fn) => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, ms));
const entry = () => ({ path: 'C:\r', name: 'r', worktrees: LAST });

test('relayout gives the fresh list when git answers', async () => {
  assert.deepEqual(await git.relayout('C:\r', { list: async () => NEW, exists: () => true }), NEW);
});

test('relayout says KEEP when git fails and the folder is still there', async () => {
  for (const msg of ['Command failed: timed out', 'fatal: Unable to create index.lock: File exists', 'fatal: detected dubious ownership in repository']) {
    const failing = async () => { throw new Error(msg); };
    assert.equal(await git.relayout('C:\r', { list: failing, exists: () => true }), git.KEEP, msg);
  }
});

test('relayout drops the repository when its folder is gone', async () => {
  const failing = async () => { throw new Error('spawn git ENOENT'); };
  assert.equal(await git.relayout('C:\r', { list: failing, exists: () => false }), null);
});

test('relayout drops the repository when git says it is no longer a repository', async () => {
  const failing = async () => { throw new Error('fatal: not a git repository (or any of the parent directories): .git'); };
  assert.equal(await git.relayout('C:\r', { list: failing, exists: () => true }), null);
});

test('refreshEntry: a failed read leaves the entry as it is', async () => {
  const e = entry();
  assert.equal(await git.refreshEntry(e, { list: async () => { throw new Error('Command failed: timed out'); }, exists: () => true }), 'same');
  assert.equal(e.worktrees, LAST);
});

test('refreshEntry: changed, same, gone', async () => {
  const e = entry();
  assert.equal(await git.refreshEntry(e, { list: async () => NEW, exists: () => true }), 'changed');
  assert.deepEqual(e.worktrees, NEW);
  assert.equal(await git.refreshEntry(e, { list: async () => [...NEW], exists: () => true }), 'same');
  assert.equal(await git.refreshEntry(e, { list: async () => { throw new Error('fatal: not a git repository'); }, exists: () => true }), 'gone');
});

test('refreshEntry: a slow failing refresh does not put an older list back over a newer one (#81)', async () => {
  const e = entry();
  const slowFail = git.refreshEntry(e, { list: () => later(40, () => { throw new Error('Command failed: timed out'); }), exists: () => true });
  const fast = git.refreshEntry(e, { list: async () => NEW, exists: () => true });
  assert.equal(await fast, 'changed');
  assert.equal(await slowFail, 'same');
  assert.deepEqual(e.worktrees, NEW);
});

test('refreshEntry: a slow older read that succeeds cannot undo a newer one', async () => {
  const e = entry();
  const slowOld = git.refreshEntry(e, { list: () => later(40, () => LAST), exists: () => true });
  const fast = git.refreshEntry(e, { list: async () => NEW, exists: () => true });
  assert.equal(await fast, 'changed');
  assert.equal(await slowOld, 'stale');
  assert.deepEqual(e.worktrees, NEW);
});

test('refreshEntry: a failed newer read does not block an older read that succeeds', async () => {
  const e = entry();
  const slowOk = git.refreshEntry(e, { list: () => later(40, () => NEW), exists: () => true });
  const fastFail = git.refreshEntry(e, { list: async () => { throw new Error('Command failed: timed out'); }, exists: () => true });
  assert.equal(await fastFail, 'same');
  assert.equal(await slowOk, 'changed');
  assert.deepEqual(e.worktrees, NEW);
});

test('relayout still drops a plain folder under a German locale (git is asked for English)', async () => {
  const plainDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plain-')));
  const keep = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  try {
    Object.assign(process.env, { LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' });
    assert.equal(await git.relayout(plainDir), null);
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});

test('relayout, with real git: a repo stays, a plain folder and a removed folder are dropped', async () => {
  const dir = repo();
  const plainDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plain-')));
  try {
    const first = await git.relayout(dir);
    assert.equal(first.length, 1);
    assert.equal(await git.relayout(plainDir), null);         // a folder that is not a repository
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(await git.relayout(dir), null);              // the folder is gone
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});

// Review M5: two agent rooms opened at once in one repository wrote the repo config at the same time, and one failed with
// "could not lock config file". Room creation is serialized per repository, so every open gets its room and its base.
test('M5: agent rooms opened at once in one repository all get their room and their base branch', async () => {
  const dir = repo();
  const made = [];
  try {
    const all = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => git.createWorktree(dir, 'bot' + i)));
    for (const r of all) if (r.status === 'fulfilled') made.push(r.value);
    assert.deepEqual(all.map((r) => r.status === 'rejected' ? String(r.reason && r.reason.message) : 'ok'), Array(8).fill('ok'));
    assert.equal(new Set(made.map((w) => w.root.toLowerCase())).size, 8, 'eight folders');
    for (const w of made) assert.equal(plain(dir, 'config', '--get', `branch.${w.branch}.officebase`).trim(), 'main', w.branch);
  } finally {
    for (const w of made) await git.removeRoom(dir, w.root, true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir + '.worktrees', { recursive: true, force: true });
  }
});

test('M5: perRepo runs the tasks of one repository one after the other, also after a failure; other repositories do not wait', async () => {
  const log = [];
  const step = (name, ms, fail) => () => new Promise((res, rej) => { log.push(name + '+'); setTimeout(() => { log.push(name + '-'); fail ? rej(new Error(name)) : res(name); }, ms); });
  const a = git.perRepo('C:\Repo', step('a', 40, true));
  const b = git.perRepo('c:/repo/', step('b', 5));          // the same repository in another spelling
  const c = git.perRepo('C:\Other', step('c', 5));
  await assert.rejects(a, /a/);
  assert.equal(await b, 'b');
  assert.equal(await c, 'c');
  assert.ok(log.indexOf('b+') > log.indexOf('a-'), 'b starts after a ends: ' + log.join(' '));
  assert.ok(log.indexOf('c+') < log.indexOf('a-'), 'c does not wait for a: ' + log.join(' '));
});

// The one exception to "the office never removes a worktree by itself" (CLAUDE.md): a fork that did not start removes the
// worktree the same call made for it, which never held work. discardNew takes only an object createWorktree returned in this
// process: a copy (a past record, a session's worktree field) is refused, so no other worktree can be removed this way.
test('discardNew removes only a worktree createWorktree made in this call; a copy of one is refused and the worktree stays', async () => {
  const dir = repo();
  let keep = null;
  try {
    const wt = await git.createWorktree(dir, 'fork');
    await git.discardNew(wt);
    assert.equal(fs.existsSync(wt.root), false, 'the new worktree is gone');
    assert.equal(plain(dir, 'branch', '--list', wt.branch).trim(), '', 'and its branch');
    keep = await git.createWorktree(dir, 'keep');
    for (const copy of [{ ...keep }, JSON.parse(JSON.stringify(keep)), { root: keep.root, repo: keep.repo, branch: keep.branch }]) {
      await assert.rejects(git.discardNew(copy), /made in this call/);
    }
    assert.equal(fs.existsSync(keep.root), true, 'a worktree it did not just make stays');
    await assert.rejects(git.discardNew(wt), /made in this call/, 'once only');
  } finally {
    if (keep) await git.removeRoom(dir, keep.root, true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir + '.worktrees', { recursive: true, force: true });
  }
});

// Review minor: layout read the base branches, then the branch list. When the list failed after the bases had been read,
// live stayed null and live.has threw, so the whole layout failed. Now a room keeps the base its config names.
test('layout: when the branch list cannot be read after the bases, the rooms still come back with the base their config names', async () => {
  const dir = repo();
  let agent = null;
  try {
    agent = await git.createWorktree(dir, 'based');
    const broken = async () => { throw new Error('git for-each-ref timed out'); };
    const list = await git.layout(dir, { readBranches: broken });
    const room = list.find((w) => w.branch === agent.branch);
    assert.ok(room, 'the layout is there');
    assert.equal(room.base, 'main');
    const noBases = await git.layout(dir, { readBases: broken });
    assert.equal(noBases.find((w) => w.branch === agent.branch).base, undefined, 'bases unreadable: no base, and no throw');
  } finally {
    if (agent) await git.removeRoom(dir, agent.root, true).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir + '.worktrees', { recursive: true, force: true });
  }
});

// ---------- locate: a git that fails for a passing reason must not make a folder look like it is outside git (#98) ----------
// Under load git can pass its time limit. The office reads its recent folders once, at start: a folder that locate gave up on
// was never a building until the next start. A passing failure is tried again; "not a git repository" and a missing folder are answers.
const TOP = ['/r', 'main', '/r/.git'].join('\n');
const seq = (...steps) => { const calls = []; return Object.assign(async () => { const s = steps[Math.min(calls.length, steps.length - 1)]; calls.push(1); if (s instanceof Error) throw s; return s; }, { calls }); };
const retry = { wait: async () => {}, exists: () => true };

test('locate answers from git at once when git answers', async () => {
  const exec = seq(TOP);
  const g = await git.locate('/r', { exec, ...retry });
  assert.equal(g.branch, 'main');
  assert.equal(exec.calls.length, 1);
});

test('locate tries again when git fails for a passing reason, and answers when a later try works', async () => {
  for (const msg of ['Command failed: git rev-parse (timed out)', 'fatal: Unable to create index.lock: File exists', 'spawn git ETIMEDOUT']) {
    const exec = seq(new Error(msg), new Error(msg), TOP);
    const g = await git.locate('/r', { exec, ...retry });
    assert.equal(g && g.branch, 'main', msg);
    assert.equal(exec.calls.length, 3, msg);
  }
});

test('locate gives null after its tries when git keeps failing', async () => {
  const exec = seq(new Error('timed out'));
  assert.equal(await git.locate('/r', { exec, attempts: 3, ...retry }), null);
  assert.equal(exec.calls.length, 3);
});

test('locate does not try again for a folder that is not a repository, or is gone', async () => {
  for (const msg of ['fatal: not a git repository (or any of the parent directories): .git', 'fatal: Not a git repository']) {
    const exec = seq(new Error(msg));
    assert.equal(await git.locate('/nope', { exec, ...retry }), null, msg);
    assert.equal(exec.calls.length, 1, msg);
  }
  const exec = seq(new Error('timed out'));
  assert.equal(await git.locate('/nope', { exec, ...retry, exists: () => false }), null);
  assert.equal(exec.calls.length, 1, 'a folder that is gone is an answer');
});
