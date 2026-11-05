import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { placeOfSession, placeOfWorktree, legacyNoteKey, legacyRoomId, roomIdOf, normPath, adoptLegacy, addRecent, cleanRecent, recentChoices, OTHER_NAME, OTHER_FLOOR, securityRoomIdOf, isSecurityRoom } from '../place.mjs';
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
  assert.equal(legacyNoteKey(pl).split('|')[0], path.win32.normalize(root).toLowerCase());
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
    execFileSync(git.resolveExe('git'), ['init', '-q'], { cwd: dir });
    execFileSync(git.resolveExe('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    const g = await git.locate(dir.toUpperCase());
    assert.ok(g, 'locate finds the repository');
    assert.equal(g.repo, path.win32.normalize(dir), 'repo path has the case git stores');
    const s = placeOfSession(g, dir.toUpperCase());
    const w = placeOfWorktree(g.repo, (await git.layout(g.repo))[0]);
    assert.equal(s.building, w.building);
    assert.equal(s.repoPath, w.repoPath);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recent folders: one form, no duplicates in any case or slash, newest first', () => {
  let list = [];
  list = addRecent(list, 'E:/pensiv/');
  list = addRecent(list, 'e:\\PENSIV');
  assert.equal(list.length, 1);
  assert.equal(list[0], path.win32.normalize('e:\\PENSIV'));
  list = addRecent(list, 'E:\\agent-office');
  assert.deepEqual(list.map((d) => d.toLowerCase()), [path.win32.normalize('E:\\agent-office').toLowerCase(), path.win32.normalize('e:\\pensiv').toLowerCase()]);
  assert.equal(addRecent(list, 'E:\\x', 2).length, 2);
});

test('clean recent folders drops duplicates that were stored in different forms', () => {
  const out = cleanRecent(['E:/pensiv', 'E:\\pensiv\\', 'E:\\other', '', null]);
  assert.equal(out.length, 2);
  assert.equal(out[1], path.win32.normalize('E:\\other'));
});

test('folder choices: the shown folder first, each folder once in any case or slash, at most the cap', () => {
  const out = recentChoices(['E:\\pensiv', 'e:/agent-office/', 'E:\\other'], 'E:/PENSIV/');
  assert.deepEqual(out.map((d) => d.toLowerCase()), ['e:\\pensiv', 'e:\\agent-office', 'e:\\other']);
  assert.equal(recentChoices(['E:\\a', 'E:\\b', 'E:\\c'], '', 2).length, 2);
  assert.deepEqual(recentChoices(undefined, ''), []);
});

// ---------- agent rooms (#69): a room of an agent worktree sits on the floor of its base branch ----------
test('agent worktree: the room sits on the base branch floor and the sign shows the worktree branch', () => {
  const p = placeOfSession({ repo: R, root: W, branch: 'agent/fix-login-ab12', base: 'main' }, W);
  assert.equal(p.floor, 'main');
  assert.equal(p.baseBranch, 'main');
  assert.equal(p.branch, 'agent/fix-login-ab12');
  assert.equal(p.room, 'agent/fix-login-ab12');
  const own = placeOfSession({ repo: R, root: R, branch: 'main' }, R);
  assert.equal(p.floor, own.floor, 'same floor as the main folder');
  assert.notEqual(p.roomId, own.roomId, 'but another room');
  assert.equal(p.buildingKey, own.buildingKey);
});

test('three agent worktrees are three rooms on one floor', () => {
  const rooms = ['a', 'b', 'c'].map((n) => placeOfSession({ repo: R, root: path.resolve('/work/Repo.worktrees/' + n), branch: 'agent/' + n + '-1', base: 'dev' }, ''));
  assert.deepEqual([...new Set(rooms.map((x) => x.floor))], ['dev']);
  assert.equal(new Set(rooms.map((x) => x.roomId)).size, 3);
});

test('a worktree with no base branch keeps its own branch as the floor and the folder as the room', () => {
  const p = placeOfSession({ repo: R, root: W, branch: 'feat' }, W);
  assert.equal(p.floor, 'feat');
  assert.equal(p.baseBranch, '');
  assert.equal(p.branch, 'feat');
  assert.equal(p.room, 'Repo-wt');
});

test('outside git there is no base branch', () => {
  const p = placeOfSession(null, path.resolve('/work/Scratch'));
  assert.equal(p.baseBranch, '');
  assert.equal(p.floor, OTHER_FLOOR);
});

test('placeOfWorktree follows the same floor rule as a session in that worktree', () => {
  const wt = { root: W, branch: 'agent/x-1', base: 'main' };
  const a = placeOfWorktree(R, wt), b = placeOfSession({ repo: R, root: W, branch: 'agent/x-1', base: 'main' }, W);
  assert.deepEqual(a, b);
  assert.equal(a.floor, 'main');
  assert.equal(placeOfWorktree(R, { root: W, branch: 'feat' }).floor, 'feat');
});

test('a base equal to the branch is no base', () => {
  const p = placeOfSession({ repo: R, root: R, branch: 'main', base: 'main' }, R);
  assert.equal(p.baseBranch, '');
  assert.equal(p.room, 'Repo');
});

// ---------- the Security room (#70): one per building, never a worktree ----------
test('every place carries its building\'s Security room id; it is never a worktree room id', () => {
  const p = placeOfSession({ repo: R, root: R, branch: 'main' }, R);
  const w = placeOfWorktree(R, { root: W, branch: 'feat' });
  assert.equal(p.securityRoomId, w.securityRoomId, 'one Security room per building');
  assert.equal(p.securityRoomId, securityRoomIdOf(p.buildingKey));
  assert.match(p.securityRoomId, /^s-[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.ok(!p.securityRoomId.startsWith('w-'), 'a worktree room id starts with w-, so the two never meet');
  assert.notEqual(p.securityRoomId, roomIdOf(p.buildingKey), 'the main worktree has the same path as the building, but its own room');
  assert.notEqual(securityRoomIdOf(normPath(path.resolve('/work/Other'))), p.securityRoomId);
  assert.equal(isSecurityRoom(p.securityRoomId), true);
  assert.equal(isSecurityRoom(p.roomId), false);
  assert.equal(isSecurityRoom('spare-room'), false);
});

test('the Other folders building has a Security room too', () => {
  const p = placeOfSession(null, path.resolve('/work/Scratch'));
  assert.equal(p.securityRoomId, securityRoomIdOf(''));
});

test('Security room id format is pinned', () => {
  // The page matches the room by this id; a change makes every scene stale once, nothing is lost.
  assert.equal(securityRoomIdOf('e:\\agent-office'), 's-e-agent-office-fe4d9e73');
});

// Review minor: agent rooms live in <repo>.worktrees (git.createWorktree, #69); the old filter knew only .agent-office/worktrees.
// A worktree folder is an implementation detail, never a recent folder to start from.
test('recent folders leave out agent room folders (<repo>.worktrees/<name>) and the old .agent-office/worktrees ones', () => {
  const top = path.resolve('/pensiv'), holder = top + '.worktrees';
  const room = path.join(holder, 'bot-1'), deep = path.join(room, 'src');
  const old = path.join(top, '.agent-office', 'worktrees', 'x');
  const upper = path.join(holder.toUpperCase(), 'Other'), lookalike = top + '.worktrees.notes';
  assert.deepEqual(addRecent([top], room), [top], 'an agent room is not added');
  assert.deepEqual(addRecent([], deep), [], 'nor a folder inside one');
  assert.deepEqual(cleanRecent([top, room, old, upper, lookalike]), [top, lookalike]);
  assert.deepEqual(recentChoices([room, top], deep), [top], 'the shown building in a room is no choice either');
  assert.deepEqual(addRecent([], holder), [holder], 'the folder that holds the rooms is a plain folder');
});
