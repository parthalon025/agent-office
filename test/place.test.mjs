import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { placeOfSession, placeOfWorktree, legacyNoteKey, legacyRoomId, roomIdOf, normPath, adoptLegacy, addRecent, cleanRecent, recentChoices, OTHER_NAME, OTHER_FLOOR, securityRoomIdOf, isSecurityRoom } from '../src/place.mjs';
import { seatOf, roomTitle, betterTitle, linkedIssue, cleanRooms, settleRooms, viewRooms } from '../src/place.mjs';
import { shownFloors, newRecord, edit } from '../src/archetypes.mjs';
import * as git from '../src/git.mjs';
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
  // place.mjs keeps folders in Windows form on every host, so the test builds Windows paths too (Linux CI).
  const top = path.win32.resolve('C:\\pensiv'), holder = top + '.worktrees';
  const room = path.win32.join(holder, 'bot-1'), deep = path.win32.join(room, 'src');
  const old = path.win32.join(top, '.agent-office', 'worktrees', 'x');
  const upper = path.win32.join(holder.toUpperCase(), 'Other'), lookalike = top + '.worktrees.notes';
  assert.deepEqual(addRecent([top], room), [top], 'an agent room is not added');
  assert.deepEqual(addRecent([], deep), [], 'nor a folder inside one');
  assert.deepEqual(cleanRecent([top, room, old, upper, lookalike]), [top, lookalike]);
  assert.deepEqual(recentChoices([room, top], deep), [top], 'the shown building in a room is no choice either');
  assert.deepEqual(addRecent([], holder), [holder], 'the folder that holds the rooms is a plain folder');
});

// ---------- function floors (#92) ----------
test('role seating: each step of the fallback chain (Manager, clicked desk, agent kind, lobby)', () => {
  const floors = shownFloors(newRecord({ archetype: 'ops-hub' }));
  assert.deepEqual(seatOf({ assigned: 'executive', desk: 'quality', agentType: 'planner' }, floors), { floor: 'executive', by: 'manager' });
  assert.deepEqual(seatOf({ desk: 'quality', agentType: 'planner' }, floors), { floor: 'quality', by: 'desk' });
  assert.deepEqual(seatOf({ agentType: 'planner' }, floors), { floor: 'planning', by: 'kind' });
  assert.deepEqual(seatOf({}, floors), { floor: 'lobby', by: 'lobby' });
  assert.deepEqual(seatOf(null, floors), { floor: 'lobby', by: 'lobby' });
  // the desk the user clicked in the lobby seats there on purpose
  assert.deepEqual(seatOf({ desk: 'lobby', agentType: 'planner' }, floors), { floor: 'lobby', by: 'desk' });
});

test('role seating: a role whose floor is hidden or not in the building goes on down the chain', () => {
  const rec = edit(newRecord({ archetype: 'ops-hub' }), { action: 'hide', floor: 'executive' });
  const floors = shownFloors(rec);
  assert.deepEqual(seatOf({ assigned: 'executive', desk: 'quality' }, floors), { floor: 'quality', by: 'desk' });
  assert.deepEqual(seatOf({ assigned: 'finance', desk: 'design', agentType: 'reviewer' }, floors), { floor: 'quality', by: 'kind' });
  assert.deepEqual(seatOf({ assigned: 'finance', desk: 'design', agentType: 'poet' }, floors), { floor: 'lobby', by: 'lobby' });
});

test('notes keys do not change with the floor rule: they are building key plus room id, with no floor in them', () => {
  const p = placeOfSession({ repo: R, root: W, branch: 'feat/x' }, W);
  assert.equal(p.noteKey, p.buildingKey + '|' + roomIdOf(normPath(W)));
  // the same folder on another branch (and so on any floor) keeps its key
  assert.equal(placeOfSession({ repo: R, root: W, branch: 'other' }, W).noteKey, p.noteKey);
  assert.doesNotMatch(p.noteKey, /feat|engineering|lobby/);
});

test('room names come from the task: Manager goal, linked issue, first prompt, then branch', () => {
  assert.deepEqual(roomTitle({ goal: 'Ship the lobby\nmore', branch: 'feat/92-function-floors', prompt: 'hi' }), { name: 'Ship the lobby', by: 'goal' });
  assert.deepEqual(roomTitle({ branch: 'feat/92-function-floors', prompt: 'hi' }), { name: '#92 Function floors', by: 'issue' });
  assert.deepEqual(roomTitle({ branch: 'main', prompt: 'Fix issue #57 in the path' }), { name: '#57', by: 'issue' });
  assert.deepEqual(roomTitle({ branch: 'main', prompt: '  \n Tidy the readme\nthen more' }), { name: 'Tidy the readme', by: 'prompt' });
  assert.deepEqual(roomTitle({ branch: 'agent/claude-1a2b3c' }), { name: 'agent/claude-1a2b3c', by: 'branch' });
  assert.deepEqual(roomTitle({ folder: 'Scratch' }), { name: 'Scratch', by: 'folder' });
  assert.equal(roomTitle({ prompt: 'x'.repeat(80) }).name.length, 40);
  assert.deepEqual(linkedIssue('fix/57', ''), { n: 57, words: '' });
  assert.equal(linkedIssue('main', 'no number'), null);
});

test('a room keeps its name until a source higher in the chain comes', () => {
  const b = { name: 'main', by: 'branch' }, p = { name: 'Tidy', by: 'prompt' }, p2 = { name: 'Other', by: 'prompt' }, g = { name: 'Goal', by: 'goal' };
  assert.equal(betterTitle(b, p), p);
  assert.equal(betterTitle(p, p2), p, 'a new prompt does not rename the room');
  assert.equal(betterTitle(p, b), p);
  assert.equal(betterTitle(p, g), g);
  assert.equal(betterTitle(null, b), b);
});

// ---------- room records (#92 review: cleanRooms, settleRooms, viewRooms) ----------
const MAIN = placeOfSession({ repo: R, root: R, branch: 'feat/92-function-floors' }, R);
const AGENT = placeOfSession({ repo: R, root: W, branch: 'agent/bot-1-ab12', base: 'main' }, W);
const at = (pl, floor, extra = {}) => ({ pl, seat: { floor, by: 'desk' }, goal: '', firstPrompt: '', ...extra });

test('cleanRooms: a state.json record in the wrong shape is fixed or dropped, so no broadcast throws on it', () => {
  const K = MAIN.buildingKey;
  const good = { building: K, root: AGENT.rootKey, floors: ['quality'], title: { name: 'Tidy', by: 'prompt' } };
  const out = cleanRooms({
    [AGENT.noteKey]: good,
    [MAIN.noteKey]: { building: K, root: MAIN.rootKey },                                              // no floors: the review's crash
    [K + '|w-x-00000001']: { building: K, root: 'c:\\x', floors: 'quality', title: 'x' },
    [K + '|w-y-00000002']: { building: K, root: 'c:\\y', floors: ['quality', 'quality', 'army', 7, null, 'lobby'], title: { name: '  A\u0000 name  ', by: 'goal' } },
    [K + '|w-z-00000003']: { building: K, root: 'c:\\z', floors: [], title: { name: 'x'.repeat(90), by: 'nonsense' } },
    junk: { building: K, root: 'c:\\j', floors: [] },                                                  // not a notes key
    ['other|' + AGENT.roomId]: { building: 'c:\\elsewhere', root: 'c:\\j', floors: [] },               // the key is not of its building
    [K + '|w-n-00000004']: null,
    [K + '|w-a-00000005']: [1, 2],
    [K + '|w-r-00000006']: { building: K, floors: [] },                                                // no root
  });
  assert.deepEqual(Object.keys(out).sort(), [AGENT.noteKey, MAIN.noteKey, K + '|w-x-00000001', K + '|w-y-00000002', K + '|w-z-00000003'].sort());
  assert.deepEqual(out[AGENT.noteKey], good);
  assert.deepEqual(out[MAIN.noteKey], { building: K, root: MAIN.rootKey, floors: [], title: null });
  assert.deepEqual(out[K + '|w-x-00000001'], { building: K, root: 'c:\\x', floors: [], title: null });
  assert.deepEqual(out[K + '|w-y-00000002'], { building: K, root: 'c:\\y', floors: ['quality', 'lobby'], title: { name: 'A name', by: 'goal' } });
  assert.equal(out[K + '|w-z-00000003'].title, null);
  for (const bad of [null, 5, 'x', [1]]) assert.deepEqual(cleanRooms(bad), {});
  const proto = cleanRooms(JSON.parse('{"__proto__": {"building": "x", "root": "y", "floors": []}}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype, 'no prototype change');
  assert.deepEqual(Object.keys(proto), []);
  // the main checkout keeps no name from a prompt, a goal or an issue in a prompt: an older state.json may have one
  const old = cleanRooms({ [MAIN.noteKey]: { building: K, root: MAIN.rootKey, floors: [], title: { name: '#7', by: 'issue' } } });
  assert.equal(old[MAIN.noteKey].title, null);
});

test('settleRooms: a room is on the floors where its agents sit; a floor with no agent of the room goes (owner rule)', () => {
  let r = settleRooms({}, [at(AGENT, 'engineering', { firstPrompt: 'Tidy the readme' })]);
  assert.equal(r.moved, true);
  assert.deepEqual(r.rooms[AGENT.noteKey], { building: AGENT.buildingKey, root: AGENT.rootKey, floors: ['engineering'], title: { name: 'Tidy the readme', by: 'prompt' } });
  const same = settleRooms(r.rooms, [at(AGENT, 'engineering', { firstPrompt: 'Tidy the readme' })]);
  assert.equal(same.moved, false, 'nothing changed');
  assert.equal(same.rooms, r.rooms, 'and the records are the same object');
  // the agent ends: the room leaves its floor and keeps its name for the next agent
  r = settleRooms(r.rooms, []);
  assert.equal(r.moved, true);
  assert.deepEqual(r.rooms[AGENT.noteKey].floors, []);
  assert.deepEqual(r.rooms[AGENT.noteKey].title, { name: 'Tidy the readme', by: 'prompt' });
  r = settleRooms(r.rooms, [at(AGENT, 'quality', { firstPrompt: 'Something else' })]);
  assert.deepEqual(r.rooms[AGENT.noteKey].floors, ['quality']);
  assert.equal(r.rooms[AGENT.noteKey].title.name, 'Tidy the readme', 'a new prompt does not rename the room');
  r = settleRooms(r.rooms, [at(AGENT, 'quality', { goal: 'Ship the lobby' })]);
  assert.equal(r.rooms[AGENT.noteKey].title.name, 'Ship the lobby', 'a Manager goal does');
  // outside git: no record
  const out = placeOfSession(null, path.resolve('/work/Scratch'));
  assert.deepEqual(settleRooms({}, [at(out, 'lobby')]).rooms, {});
  // a session that is not seated yet counts for nothing
  assert.deepEqual(settleRooms({}, [{ pl: AGENT, seat: null }]).rooms, {});
});

test('settleRooms: the main checkout drops the floors its agents left, the Lobby too, and takes no name from a prompt', () => {
  // two ad-hoc agents in the main folder on two floors: a room on each
  let r = settleRooms({}, [at(MAIN, 'engineering', { firstPrompt: 'Fix #7 now' }), at(MAIN, 'quality', { firstPrompt: 'Review it' })]);
  assert.deepEqual(r.rooms[MAIN.noteKey].floors, ['engineering', 'quality']);
  assert.deepEqual(r.rooms[MAIN.noteKey].title, { name: '#92 Function floors', by: 'issue' }, 'the branch names it, not "#7" from a prompt');
  // the Quality agent ends: only Engineering is left
  r = settleRooms(r.rooms, [at(MAIN, 'engineering', { firstPrompt: 'Fix #7 now' })]);
  assert.deepEqual(r.rooms[MAIN.noteKey].floors, ['engineering']);
  // the user hides Engineering: the agent sits in the Lobby, and the room is there only
  r = settleRooms(r.rooms, [at(MAIN, 'lobby', { firstPrompt: 'Fix #7 now' })]);
  assert.deepEqual(r.rooms[MAIN.noteKey].floors, ['lobby']);
  // shown again: back on Engineering, and the Lobby goes
  r = settleRooms(r.rooms, [at(MAIN, 'engineering', { firstPrompt: 'Fix #7 now' })]);
  assert.deepEqual(r.rooms[MAIN.noteKey].floors, ['engineering']);
  // a branch with no issue: the branch name; a goal does not name a shared room either
  const plain = placeOfSession({ repo: R, root: R, branch: 'main' }, R);
  r = settleRooms({}, [at(plain, 'engineering', { goal: 'Ship it', firstPrompt: 'Fix issue #12' })]);
  assert.deepEqual(r.rooms[plain.noteKey].title, { name: 'main', by: 'branch' });
  // an older record with a prompt name gets the branch name
  r = settleRooms({ [plain.noteKey]: { building: plain.buildingKey, root: plain.rootKey, floors: ['engineering'], title: { name: '#7', by: 'issue' } } }, [at(plain, 'engineering')]);
  assert.deepEqual(r.rooms[plain.noteKey].title, { name: 'main', by: 'branch' });
});

test('viewRooms: the records, and a live room outside git named from its oldest session', () => {
  const out = placeOfSession(null, path.resolve('/work/Scratch'));
  const recs = settleRooms({}, [at(AGENT, 'engineering', { firstPrompt: 'Tidy' })]).rooms;
  const v = viewRooms(recs, [at(out, 'lobby', { firstPrompt: 'Look around' }), at(out, 'lobby', { firstPrompt: 'Later one' }), at(AGENT, 'engineering')]);
  assert.deepEqual(v[AGENT.noteKey], { floors: ['engineering'], title: { name: 'Tidy', by: 'prompt' } });
  assert.deepEqual(v[out.noteKey], { floors: [], title: { name: 'Look around', by: 'prompt' } });
  v[AGENT.noteKey].floors.push('x');
  assert.deepEqual(recs[AGENT.noteKey].floors, ['engineering'], 'the view is a copy');
});
