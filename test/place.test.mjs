import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { placeOfSession, placeOfWorktree, legacyNoteKey, legacyRoomId, roomIdOf, normPath, adoptLegacy, OTHER_NAME, OTHER_FLOOR } from '../place.mjs';
import * as git from '../git.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const R = path.resolve('/work/Repo'), W = path.resolve('/work/Repo-wt');

test('git session: building, floor, room and notes key', () => {
  const p = placeOfSession({ repo: R, root: R, branch: 'main' }, R);
  assert.equal(p.building, 'Repo');
  assert.equal(p.buildingKey, normPath(R));
  assert.equal(p.floor, 'main');
  assert.equal(p.room, 'Repo');
  assert.match(p.roomId, /^w-[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.equal(p.noteKey, p.buildingKey + '|' + p.roomId);
});

test('no git: one spelling for building, floor and notes key', () => {
  const dir = path.resolve('/work/Scratch');
  const p = placeOfSession(null, dir);
  assert.equal(p.building, OTHER_NAME);
  assert.equal(p.buildingKey, '');
  assert.equal(p.floor, OTHER_FLOOR);
  assert.equal(p.room, 'Scratch');
  assert.equal(p.noteKey, 'other|' + p.roomId);
  assert.equal(placeOfSession(null, dir).noteKey, p.noteKey);
});

test('no git and no folder still gets a room', () => {
  const p = placeOfSession(null, '');
  assert.equal(p.room, 'Folder');
  assert.ok(p.roomId.startsWith('w-'));
});

test('two worktrees on one branch are two rooms', () => {
  const a = placeOfSession({ repo: R, root: R, branch: 'feat' }, R);
  const b = placeOfSession({ repo: R, root: W, branch: 'feat' }, W);
  assert.equal(a.floor, b.floor);
  assert.equal(a.buildingKey, b.buildingKey);
  assert.notEqual(a.roomId, b.roomId);
  assert.notEqual(a.noteKey, b.noteKey);
});

test('folders with look-alike names are two rooms', () => {
  const x = placeOfSession(null, path.resolve('/a/my_app'));
  const y = placeOfSession(null, path.resolve('/a/my-app'));
  assert.notEqual(x.roomId, y.roomId);
  // same tail, long different parents (the old id cut the front off)
  const tail = 'x'.repeat(60);
  const l1 = placeOfSession(null, path.resolve('/one/' + tail));
  const l2 = placeOfSession(null, path.resolve('/two/' + tail));
  assert.notEqual(l1.roomId, l2.roomId);
});

test('path case and separators do not matter', () => {
  const a = placeOfSession({ repo: path.resolve('/Work/REPO'), root: path.resolve('/Work/REPO/Wt'), branch: 'b' }, '');
  const b = placeOfSession({ repo: path.resolve('/work/repo/'), root: path.resolve('/work/repo/wt') + path.sep, branch: 'b' }, '');
  if (process.platform === 'win32') {
    assert.equal(a.buildingKey, b.buildingKey);
    assert.equal(a.roomId, b.roomId);
    assert.equal(a.noteKey, b.noteKey);
  }
  // trailing separators never matter, on any platform
  const c = placeOfSession(null, path.resolve('/work/x') + path.sep);
  const d = placeOfSession(null, path.resolve('/work/x'));
  assert.equal(c.roomId, d.roomId);
});

test('a worktree has the same place as a session in it', () => {
  const s = placeOfSession({ repo: R, root: W, branch: 'feat' }, W);
  const w = placeOfWorktree(R, { root: W, branch: 'feat', main: false });
  assert.deepEqual(w, s);
});

test('legacy note key matches the old page rule', () => {
  const p = placeOfSession({ repo: R, root: W, branch: 'feat' }, W);
  const slug = normPath(W).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  assert.equal(legacyRoomId(p.rootKey), 'w-' + slug.slice(-48));
  assert.equal(legacyNoteKey(p), p.buildingKey + '|w-' + slug.slice(-48));
});

test('normPath is idempotent at a drive root', () => {
  const root = path.parse(process.cwd()).root;
  assert.equal(normPath(normPath(root)), normPath(root));
  const pl = placeOfSession({ repo: root, root, branch: 'main' }, root);
  assert.equal(normPath(pl.buildingKey), pl.buildingKey);
  assert.equal(legacyNoteKey(pl).split('|')[0], path.normalize(root).toLowerCase());
});

test('room id format is pinned', () => {
  // Changing this value orphans every saved note and pin. It needs a migration in adoptNotes().
  assert.equal(roomIdOf('e:\\agent-office'), 'w-e-agent-office-fe4d9e73');
});

test('adoptLegacy moves a note and a pin to the new key', () => {
  const p = placeOfSession({ repo: R, root: R, branch: 'main' }, R), old = legacyNoteKey(p);
  const notes = { [old]: 'n' }, pins = { [old]: 'p' };
  assert.equal(adoptLegacy([notes, pins], p), true);
  assert.deepEqual(notes, { [p.noteKey]: 'n' });
  assert.deepEqual(pins, { [p.noteKey]: 'p' });
});

test('adoptLegacy keeps an existing new-key entry and leaves the old one', () => {
  const p = placeOfSession({ repo: R, root: R, branch: 'main' }, R), old = legacyNoteKey(p);
  const notes = { [old]: 'old', [p.noteKey]: 'new' };
  assert.equal(adoptLegacy([notes], p), false);
  assert.deepEqual(notes, { [old]: 'old', [p.noteKey]: 'new' });
});

test('adoptLegacy returns false when nothing is under the old key', () => {
  const p = placeOfSession({ repo: R, root: R, branch: 'main' }, R);
  assert.equal(adoptLegacy([{}, { other: 'x' }], p), false);
});

test('one repository has one building name and path whatever the cwd case', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'Ao-Case-')));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    const g = await git.locate(dir.toUpperCase());
    assert.ok(g, 'locate finds the repository');
    assert.equal(g.repo, path.normalize(dir), 'repo path has the case git stores');
    const s = placeOfSession(g, dir.toUpperCase());
    const w = placeOfWorktree(g.repo, (await git.layout(g.repo))[0]);
    assert.equal(s.building, w.building);
    assert.equal(s.repoPath, w.repoPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
