// Floors and rooms: a named room, and the clean-up list of unused floors (git.mjs staleFloors).
// Offline: a throwaway repo in os.tmpdir. Rooms are made under the office's worktree folder with a unique
// name and removed at the end of each test.
import test from 'node:test';
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

function repo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-floors-')));
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
