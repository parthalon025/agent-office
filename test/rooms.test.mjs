import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { roomTitle, betterTitle, linkedIssue, cleanRooms, settleRooms, viewRooms } from '../src/rooms.mjs';
import { shownFloors, newRecord, edit } from '../src/archetypes.mjs';
import { placeOfSession, seatOf } from '../src/place.mjs';

const R = path.resolve('/work/Repo'), W = path.resolve('/work/Repo-wt');

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

