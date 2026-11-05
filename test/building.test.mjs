// Snapshot store and building adapter tests. Snapshots come from the real session tracker fed with recorded
// hook payloads, shaped like the server's snapshot (place.mjs, vocab.js). Every event the adapter emits is checked
// against the design system schema (kit/schema.json, the same rules as kit/check.py).
// No browser, no server, no timers, no paid calls. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTracker } from '../tracker.mjs';
import { slimPayload } from '../payload.mjs';
import { placeOfSession, placeOfWorktree, normPath } from '../place.mjs';
import '../public/vocab.js';
import '../public/building.js';

const V = globalThis.OfficeVocab, B = globalThis.OfficeBuilding;
const load = (f) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const HOOKS = load('hooks.json'), STREAM = load('stream.json');
const SCHEMA = JSON.parse(fs.readFileSync(new URL('../kit/schema.json', import.meta.url), 'utf8'));
const STATES = new Set(['working', 'waiting', 'error', 'resting', 'finished']);

const REPO_A = 'C:\\work\\repo', REPO_B = 'C:\\work\\other';
const GITS = {
  [REPO_A]: { repo: REPO_A, root: REPO_A, branch: 'main' },
  [REPO_B]: { repo: REPO_B, root: REPO_B, branch: 'main' },
  'C:\\work\\repo-feat': { repo: REPO_A, root: 'C:\\work\\repo-feat', branch: 'feat/x' },
};
const KEY_A = normPath(REPO_A), KEY_B = normPath(REPO_B);

// The checks of kit/check.py check_event, in JS.
function problems(ev) {
  const sp = SCHEMA.events[ev.type];
  if (!sp) return ['unknown type: ' + ev.type];
  const out = [];
  for (const [k, t0] of Object.entries({ ...SCHEMA.common.fields, ...sp.fields })) {   // common: seeded, at (every event)
    const opt = t0.endsWith('?'), t = t0.replace(/\?$/, ''), v = ev[k];
    if (v === undefined || v === null) { if (!opt) out.push('missing ' + k); continue; }
    const ok = { string: typeof v === 'string', number: typeof v === 'number', boolean: typeof v === 'boolean', Status: STATES.has(v) }[t]
      ?? (t.endsWith('[]') ? Array.isArray(v) : typeof v === 'object');
    if (!ok) out.push(`${k} must be ${t}`);
  }
  return out;
}

// A rig: a tracker with in-memory adapters, a store, and a way to take a snapshot like the server does.
function rig(over = {}) {
  const r = { t: 1_000_000, timers: [], events: [], repos: over.repos || [], store: null, tracker: null };
  r.tracker = createTracker({
    now: () => r.t,
    makeId: (kind) => `${kind[0]}${(r.n = (r.n || 0) + 1)}`,
    locate: async (cwd) => GITS[cwd] || null,
    onChange: () => {},
    setTimer: () => 0,
  });
  r.store = B.createStore({ now: () => r.t, defer: over.defer || ((fn) => fn()), setTimer: (fn, ms) => { r.timers.push({ fn, ms }); } });
  r.snap = () => {
    const sessions = [...r.tracker.sessions.values()].map((s) => ({ ...s, place: s.placed ? placeOfSession(s.git, s.cwd) : null }));
    const by = {};
    for (const s of sessions) if (s.status !== 'ended' && s.place) (by[s.place.noteKey] ||= []).push(s);
    const figures = {};
    for (const k of Object.keys(by)) figures[k] = V.figures(by[k]);
    return {
      sessions, figures, notes: {}, pins: {}, plan: r.plan || null, now: r.t,
      repos: r.repos.map((p) => ({ key: normPath(p.path), path: p.path, name: p.path.split('\\').pop(), worktrees: p.worktrees.map((w) => ({ ...w, place: placeOfWorktree(p.path, w) })) })),
    };
  };
  r.push = () => r.store.set(JSON.parse(JSON.stringify(r.snap())));   // as over SSE
  r.hook = async (raw) => { r.tracker.onHook(slimPayload(raw, null)); await new Promise((res) => setImmediate(res)); r.push(); };
  r.play = async (list) => { for (const p of list) await r.hook(p); };
  // Mount a building the way the page does, and collect its events (each checked against the schema).
  r.mount = (repo) => {
    const m = r.store.mount(repo), ev = [];
    m.attach((e) => { const p = problems(e); assert.deepEqual(p, [], `${JSON.stringify(e)} breaks the schema`); ev.push(e); });
    return Object.assign(m, { ev });
  };
  return r;
}
const types = (ev) => ev.map((e) => e.type);
const of = (ev, type) => ev.filter((e) => e.type === type);
const fromHooks = (name, cwd, sid) => HOOKS[name].map((p) => ({ ...p, cwd, session_id: sid }));

test('importing starts nothing, and a store with no snapshot answers with empty values', () => {
  const s = B.createStore();
  assert.equal(s.latest(), null);
  assert.deepEqual(s.buildings(), []);
  assert.equal(s.session('x'), null);
  assert.equal(s.lookup('x'), null);
  const m = s.mount(KEY_A);
  assert.equal(m.def.floors[0].name, 'No sessions');
  assert.equal(m.stale(), false);
});

test('a scene mounted on an empty building gets a floor and a room when the first session arrives', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  assert.deepEqual(types(m.ev), [], 'nothing to say yet');
  await r.hook(HOOKS.turnWithEdit[0]);
  assert.deepEqual(types(m.ev).slice(0, 4), ['floor.add', 'bot.add', 'session.start', 'model']);
  const fl = of(m.ev, 'floor.add')[0].floor;
  assert.equal(fl.name, 'main');
  assert.equal(fl.rooms[0].name, 'repo');
  assert.equal(of(m.ev, 'bot.add')[0].roomId, fl.rooms[0].id);
  assert.equal(of(m.ev, 'bot.add')[0].bot.status, 'resting');
  assert.equal(m.stale(), true, 'it was empty and now has a room, so the page mounts it again');
});

test('a turn with an edit: working, tool call without a bubble on replay, result, finished', async () => {
  const r = rig();
  const m0 = r.mount(KEY_A);
  const [start, prompt, pre, post, stop] = HOOKS.turnWithEdit;
  await r.hook(start);
  m0.ev.length = 0;
  await r.hook(prompt);
  assert.deepEqual(m0.ev.map((e) => [e.type, e.status]), [['status', 'working']]);
  await r.hook(pre);
  const call = of(m0.ev, 'tool.call')[0];
  assert.deepEqual([call.tool, call.kind, call.say, call.args], ['Edit', 'code', true, { file: 'hello.txt' }]);
  await r.hook(post);
  const res = of(m0.ev, 'tool.result')[0];
  assert.deepEqual([res.id, res.ok, res.ms], [call.id, true, 41]);
  await r.hook(stop);
  assert.equal(m0.ev.at(-1).status, 'finished');
  // The same state mounted later (a page opened mid-session) replays quietly, in one pass.
  const late = r.mount(KEY_A);
  assert.deepEqual(types(late.ev), ['bot.add', 'session.start', 'model', 'tool.call', 'tool.result']);
  assert.equal(of(late.ev, 'tool.call')[0].say, false);
  assert.equal(late.def.floors[0].rooms[0].name, 'repo', 'the definition already holds the room');
  assert.equal(late.stale(), false);
});

test('the same snapshot twice says nothing the second time', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.play(HOOKS.turnWithEdit);
  const n = m.ev.length;
  r.push(); r.push();
  assert.equal(m.ev.length, n);
});

test('a failed turn shows Error once; Dismiss moves the bot off Error', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  const s = [...r.tracker.sessions.values()][0];
  await r.hook(HOOKS.turnWithEdit[1]);
  s.error = { id: 1, text: 'Out of budget.' }; r.push(); r.push();
  assert.deepEqual(of(m.ev, 'error').map((e) => e.text), ['Out of budget.']);
  r.tracker.dismissError(s); r.push();
  const last = m.ev.at(-1);
  assert.equal(last.type, 'status', 'the next snapshot moves the bot off Error');
  assert.notEqual(last.status, 'error');
});

test('a permission prompt becomes one request; a question has no risk value', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.permissionRequest(slimPayload(HOOKS.permission, null));
  r.tracker.askQuestion?.(s, 'Which file?');
  r.push(); r.push();
  const reqs = of(m.ev, 'request');
  assert.ok(reqs.length >= 1);
  assert.equal(reqs[0].tool, 'Bash');
  assert.match(reqs[0].text, /^Allow Bash/);
  assert.equal(reqs.length, new Set(reqs.map((e) => e.id)).size, 'each request once');
  for (const q of reqs.filter((e) => e.tool === 'office_ask')) assert.equal(q.risk, undefined);
  assert.equal(m.ev.filter((e) => e.type === 'status').at(-1).status, 'waiting');
});

test('subagents: a helper bot is spawned, its tool calls show on it, and it leaves when done', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.play(HOOKS.subagent);
  const d = of(m.ev, 'delegate');
  assert.equal(d.length, 2);
  assert.equal(d[0].spawn.role, 'research');
  assert.match(d[0].spawn.name, /^repo /);
  assert.ok(of(m.ev, 'subagent.done').length >= 1);
  const grep = of(m.ev, 'tool.call').find((e) => e.tool === 'Grep');
  assert.equal(grep.bot, d[0].spawn.name, 'the subagent call shows on its helper');
  assert.equal(of(m.ev, 'tool.result').find((e) => e.id === grep.id).bot, d[0].spawn.name);
});

test('two sessions with one name get two bot names; an ended bot leaves after the delay, and not after detach', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 's1' });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 's2' });
  assert.deepEqual(of(m.ev, 'bot.add').map((e) => e.bot.name), ['repo', 'repo 2']);
  const s1 = [...r.tracker.sessions.values()][0];
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: REPO_A }, null)); r.push();
  assert.deepEqual(m.ev.slice(-2).map((e) => e.type), ['session.end', 'status']);
  assert.equal(s1.status, 'ended');
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 6000);
  r.timers[0].fn();
  assert.deepEqual(m.ev.at(-1), { type: 'bot.remove', bot: 'repo' });
  // an ended bot of a scene that is gone does not touch the next scene
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 's2', cwd: REPO_A }, null)); r.push();
  const n = m.ev.length;
  m.detach();
  r.timers[1].fn();
  assert.equal(m.ev.length, n);
});

test('switching buildings: each mount seats only its own sessions and keeps its own names', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_B });
  const a = r.mount(KEY_A);
  assert.deepEqual(of(a.ev, 'bot.add').map((e) => e.bot.name), ['repo']);
  assert.equal(r.store.session('repo').sid, 'a');
  a.detach();
  const b = r.mount(KEY_B);
  assert.deepEqual(of(b.ev, 'bot.add').map((e) => e.bot.name), ['other']);
  assert.equal(b.def.name, 'other');
  assert.equal(r.store.session('repo'), null, 'the bot of the building that is gone is not looked up');
  assert.equal(r.store.session('other').sid, 'b');
  const n = a.ev.length;
  await r.hook({ ...HOOKS.turnWithEdit[1], session_id: 'a', cwd: REPO_A });
  assert.equal(a.ev.length, n, 'a detached mount stays quiet');
  assert.equal(of(b.ev, 'status').length, 0, 'the other building is not told');
  assert.deepEqual(r.store.buildings().map((x) => [x.name, x.sessions]).sort(), [['other', 1], ['repo', 1]]);
});

test('the city round trip: leave a building, come back, and every bot is seated again', async () => {
  const r = rig();
  await r.play(HOOKS.turnWithEdit.slice(0, 3));
  const first = r.mount(KEY_A);
  first.detach();            // the page shows the city
  await r.hook(HOOKS.turnWithEdit[3]);
  const back = r.mount(KEY_A);   // the page shows the building again: a new adapter
  assert.notEqual(back.id, first.id);
  assert.deepEqual(types(back.ev), ['bot.add', 'session.start', 'model', 'tool.call', 'tool.result']);
  assert.equal(of(back.ev, 'bot.add')[0].bot.name, 'repo');
  // attaching the same adapter again starts clean as well
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-f', cwd: 'C:\\work\\repo-feat' });   // a new room appears between the attaches
  const again = [];
  back.attach((e) => again.push(e));
  const known = new Set([...back.def.floors.flatMap((f) => (f.rooms || []).map((x) => x.id)), ...again.filter((e) => e.type === 'floor.add' || e.type === 'room.add').flatMap((e) => (e.room ? [e.room.id] : (e.floor && e.floor.rooms || []).map((x) => x.id)))]);
  for (const e of of(again, 'bot.add')) assert.ok(known.has(e.roomId), `bot.add into unknown room ${e.roomId}`);
});

test('removing rooms: a worktree that goes makes the adapter stale; its replacement is not', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }, { branch: 'feat/x', root: 'C:\\work\\repo-feat' }] }] });
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(m.def.floors.map((f) => f.name), ['main', 'feat/x'], 'the default branch is the ground floor');
  assert.equal(m.roomsShown().length, 2);
  assert.equal(m.stale(), false);
  r.repos[0].worktrees.pop();
  r.push();
  assert.equal(m.stale(), true);
  const next = r.mount(KEY_A);
  assert.deepEqual(next.def.floors.map((f) => f.name), ['main']);
  assert.equal(next.stale(), false);
});

test('a building that empties out is stale once, then the empty mount is steady', async () => {
  const r = rig();
  await r.hook(HOOKS.turnWithEdit[0]);
  const m = r.mount(KEY_A);
  assert.equal(m.stale(), false);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'sid-1', cwd: REPO_A }, null)); r.push();
  assert.equal(m.stale(), true);
  const empty = r.mount(KEY_A);
  assert.equal(empty.def.floors[0].name, 'No sessions');
  assert.equal(empty.stale(), false);
});

test('a branch change moves the bot: removed, then seated on the new floor', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-1', cwd: 'C:\\work\\repo-feat' });   // same session, another folder
  const s = [...r.tracker.sessions.values()][0];
  assert.equal(s.cwd, 'C:\\work\\repo-feat');
  const kinds = types(m.ev);
  assert.ok(kinds.includes('bot.remove'));
  assert.deepEqual(of(m.ev, 'floor.add').map((e) => e.floor.name), ['main', 'feat/x']);
  assert.equal(of(m.ev, 'bot.add').length, 2);
});

test('room info, figures and note keys come from the snapshot', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }, { branch: 'feat/x', root: 'C:\\work\\repo-feat' }] }] });
  await r.play(HOOKS.turnWithEdit.slice(0, 3));
  const m = r.mount(KEY_A);
  const main = placeOfSession(GITS[REPO_A], REPO_A), feat = placeOfWorktree(REPO_A, { branch: 'feat/x', root: 'C:\\work\\repo-feat' });
  const info = m.roomInfo(main.roomId);
  assert.equal(info.sessions.length, 1);
  assert.equal(info.place.noteKey, main.noteKey);
  assert.equal(m.noteKey(main.roomId), main.noteKey);
  assert.equal(m.figures(main.roomId).sessions, 1);
  assert.equal(m.figures(main.roomId).toolCalls, 1);
  assert.equal(m.roomInfo(feat.roomId).sessions.length, 0, 'an empty worktree room');
  assert.equal(m.noteKey(feat.roomId), feat.noteKey);
  assert.equal(m.figures(feat.roomId).sessions, 0);
  assert.equal(m.noteKey('w-unknown'), '');
  assert.equal(m.roomInfo(main.roomId, { sessions: [], repos: [] }).sessions.length, 0, 'an older snapshot can be passed');
});

// ---------- agent rooms (#69) ----------
const WT = (n) => `C:\\work\\repo.worktrees\\${n}`;
for (const n of ['a', 'b', 'c']) GITS[WT(n)] = { repo: REPO_A, root: WT(n), branch: `agent/${n}-1`, base: 'main' };

test('three agents in three agent worktrees: three rooms on one floor (the base branch), each named by its branch', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }] }] });
  for (const n of ['a', 'b', 'c']) await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-' + n, cwd: WT(n) });
  const m = r.mount(KEY_A);
  assert.deepEqual(m.def.floors.map((f) => f.name), ['main'], 'one floor, no floor per agent branch');
  assert.deepEqual(m.def.floors[0].rooms.map((x) => x.name), ['repo', 'agent/a-1', 'agent/b-1', 'agent/c-1']);
  const adds = of(m.ev, 'bot.add');
  assert.equal(new Set(adds.map((e) => e.roomId)).size, 3, 'each agent has its own room');
  assert.equal(of(m.ev, 'floor.add').length, 0, 'the scene has the floor from its definition');
});

test('an agent worktree with no session yet is a room on the base floor', () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }, { branch: 'agent/z-9', root: WT('z'), base: 'main' }] }] });
  r.push();
  const m = r.mount(KEY_A);
  assert.equal(m.def.floors.length, 1);
  assert.equal(m.def.floors[0].rooms.length, 2);
});

test('room sign count: two top-level sessions share one room, helpers do not count', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'one', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'two', cwd: REPO_A });
  const m = r.mount(KEY_A);
  const room = m.def.floors[0].rooms[0].id;
  assert.equal(m.def.floors[0].rooms.length, 1, 'one folder, one room');
  assert.equal(m.roomInfo(room).sessions.length, 2);
  assert.equal(m.figures(room).sessions, 2);
  // a subagent of one of them is a helper in that room, and the count stays 2
  await r.play(HOOKS.subagent.map((p) => ({ ...p, session_id: 'one', cwd: REPO_A })));
  assert.ok(of(m.ev, 'delegate').length >= 1, 'helpers appear');
  assert.equal(m.roomInfo(room).sessions.length, 2, 'helpers are not agents');
  assert.equal(m.figures(room).sessions, 2);
  assert.equal(V.agentsSign(m.figures(room).sessions), '2 agents');
  assert.ok(of(m.ev, 'delegate').every((e) => e.roomId === room), 'helpers sit in the parent room');
});

test('room sign text: only a shared room says how many agents', () => {
  assert.equal(V.agentsSign(0), '');
  assert.equal(V.agentsSign(1), '');
  assert.equal(V.agentsSign(2), '2 agents');
  assert.equal(V.agentsSign(5), '5 agents');
  assert.equal(V.agentsSign(undefined), '');
});

test('a session ended or closed leaves the room count', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'one', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'two', cwd: REPO_A });
  const m = r.mount(KEY_A);
  const room = m.def.floors[0].rooms[0].id;
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'one', cwd: REPO_A }, null)); r.push();
  assert.equal(m.roomInfo(room).sessions.length, 1);
  assert.equal(V.agentsSign(m.figures(room).sessions), '');
});

test('buildings: waiting first, then the busiest; preview carries the bots', async () => {
  const r = rig({ repos: [{ path: REPO_B, worktrees: [{ branch: 'main', root: REPO_B }] }] });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a2', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_B });
  assert.deepEqual(r.store.buildings().map((b) => b.name), ['repo', 'other']);
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'b', cwd: REPO_B }, null));
  r.push();
  const list = r.store.buildings();
  assert.deepEqual(list.map((b) => [b.name, b.waiting]), [['other', 1], ['repo', 0]]);
  const pv = r.store.preview(KEY_B);
  assert.deepEqual(pv.floors[0].rooms[0].bots.map((b) => [b.name, b.status]), [['other', 'waiting']]);
  assert.equal(r.store.buildingOf(r.store.latest().sessions[0]), KEY_A);
});

test('a session outside git sits in the Other folders building', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], cwd: 'C:\\scratch\\notes' });
  assert.deepEqual(r.store.buildings().map((b) => b.name), ['Other folders']);
  const m = r.mount('');
  assert.deepEqual(types(m.ev), ['bot.add', 'session.start', 'model']);
  assert.equal(m.def.name, 'Other folders');
  assert.equal(m.def.floors[0].name, 'No branch');
});

test('usage is sent once, and again after 15 seconds', () => {
  const r = rig();
  const m = r.mount(KEY_A);
  r.plan = { week: { percent: 42 } };
  r.push(); r.push();
  assert.deepEqual(m.ev, [{ type: 'usage', percent: 42 }]);
  r.t += 16_000; r.push();
  assert.equal(of(m.ev, 'usage').length, 2);
  r.plan = { week: { percent: 43 } }; r.push();
  assert.equal(of(m.ev, 'usage').length, 3);
});

test('uidsOf finds the open sessions of the bots a command names', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 's1' });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 's2' });
  const uids = [...r.tracker.sessions.values()].map((s) => s.uid);
  assert.deepEqual(m.uidsOf({ bot: 'repo 2' }), [uids[1]]);
  assert.deepEqual(m.uidsOf({ bots: ['repo', 'repo 2'] }), uids);
  assert.deepEqual(m.uidsOf({ bot: 'nobody' }), []);
  assert.deepEqual(m.uidsOf({}), []);
  assert.equal(m.lookup('repo').uid, uids[0]);
  assert.equal(m.lookup('nobody'), null);
});

test('onSnapshot calls at once with the latest snapshot, and stops after unsubscribe', async () => {
  const r = rig();
  const seen = [];
  r.push();
  const off = r.store.onSnapshot((s) => seen.push(s));
  assert.equal(seen.length, 1);
  r.push();
  assert.equal(seen.length, 2);
  off(); r.push();
  assert.equal(seen.length, 2);
  r.store.onSnapshot(() => { throw new Error('bad listener'); });
  assert.doesNotThrow(() => r.push());
});

test('the schema check itself rejects a bad event', () => {
  assert.deepEqual(problems({ type: 'status', bot: 'x', status: 'nope' }), ['status must be Status']);
  assert.deepEqual(problems({ type: 'nope' }), ['unknown type: nope']);
});

test('plan, skill, knowledge, message, trigger and stream error events all pass the schema', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.play(HOOKS.turnWithEdit.slice(0, 2));
  await r.hook(HOOKS.todoWrite);
  const s = [...r.tracker.sessions.values()][0];
  s.todos[1].status = 'completed'; r.push();
  await r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO_A, tool_name: 'Skill', tool_use_id: 'toolu_sk', tool_input: { skill: 'tdd' } });
  await r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO_A, tool_name: 'WebFetch', tool_use_id: 'toolu_wf', tool_input: { url: 'https://example.com/a', prompt: 'x' } });
  await r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO_A, tool_name: 'Bash', tool_use_id: 'toolu_04', tool_input: { command: 'false' } });
  await r.hook(HOOKS.failedTool);
  r.tracker.pushReply(s, 'Hello there.'); r.push();
  s.inbox.push({ text: 'hi' }); r.push();
  s.inbox.length = 0; r.push();
  const h = r.tracker.newSession({ name: 'nightly', cwd: REPO_A, headless: true, scheduleId: 'job1' });
  await r.tracker.placeSession(h); r.push();
  for (const k of ['init', 'assistantA', 'resultBudget']) r.tracker.onStream(h, JSON.stringify(STREAM[k]));
  r.push();
  const seen = types(m.ev);
  for (const t of ['plan', 'plan.step', 'skill.load', 'knowledge', 'message', 'trigger.run', 'error']) assert.ok(seen.includes(t), `no ${t} event`);
  assert.ok(of(m.ev, 'message').some((e) => e.format === 'plain'), 'no plain inbox line');
  assert.ok(of(m.ev, 'tool.result').some((e) => e.ok === false && e.summary), 'no failed tool.result with a summary');
});

test('an agent reply goes to the chat as Markdown with its text unchanged: the DS RichText makes remote images click-to-load (M1)', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.play(HOOKS.turnWithEdit.slice(0, 2));
  const s = [...r.tracker.sessions.values()][0];
  const reply = 'Done. ![Coverage](https://img.example/c.png?d=secret) and ![dot](data:image/png;base64,iVBORw0KGgo=)';
  r.tracker.pushReply(s, reply); r.push();
  const msgs = of(m.ev, 'message').filter((e) => e.text === reply);
  assert.equal(msgs.length, 1);
  // No format: 'plain' and no attachments: the text reaches RichText, where the click-to-load rule lives
  // (test/rich.test.mjs). The adapter turns no image into an event of its own.
  assert.equal(msgs[0].format, undefined);
  assert.equal(msgs[0].attachments, undefined);
  assert.equal(m.ev.filter((e) => JSON.stringify(e).includes('img.example')).length, 1, 'the URL is only in the message text');
});

test('botName gives the scene name of a seated bot, with the number of a repeated folder name', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 's1' });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 's2' });
  const [a, b] = [...r.tracker.sessions.values()];
  assert.equal(m.botName(a.uid), 'repo');
  assert.equal(m.botName(b.uid), 'repo 2');
  assert.equal(m.botName('nobody'), null);
  assert.equal(r.store.botName(b.uid), 'repo 2');
});

test('colorOf is one stable DS color per uid, and bots of one shape still get different colors', () => {
  const prev = globalThis.AgentOffice;
  try {
    assert.equal((delete globalThis.AgentOffice, B.colorOf('a')), undefined);
    const palette = {}; for (let i = 0; i < 10; i++) palette['s' + i] = '#' + i;
    globalThis.AgentOffice = { BOT_COLORS: palette };
    const uids = Array.from({ length: 200 }, (_, i) => 'uid-' + i);
    for (const u of uids) assert.ok(Object.values(palette).includes(B.colorOf(u)));
    assert.equal(B.colorOf('uid-3'), B.colorOf('uid-3'));
    const sameShape = uids.filter((u) => B.shapeOf(u) === B.shapeOf(uids[0]));
    assert.ok(new Set(sameShape.map(B.colorOf)).size > 3);
  } finally { if (prev === undefined) delete globalThis.AgentOffice; else globalThis.AgentOffice = prev; }
});

test('requests: every open request and question of every building, oldest first, with the building named', async () => {
  const r = rig({ repos: [{ path: REPO_B, worktrees: [{ branch: 'main', root: REPO_B }] }] });
  assert.deepEqual(r.store.requests(), [], 'no snapshot, no requests');
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_B });
  r.t += 10;
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'b', cwd: REPO_B }, null));
  r.t += 10;
  const sa = [...r.tracker.sessions.values()].find((s) => s.cwd === REPO_A);
  r.tracker.askQuestion(sa, 'Use the old schema?');
  r.push();
  const list = r.store.requests();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => [x.kind, x.building, x.buildingName]), [['permission', KEY_B, 'other'], ['question', KEY_A, 'repo']]);
  assert.ok(list[0].t < list[1].t, 'oldest first');
  assert.equal(list[1].text, 'Use the old schema?');
  assert.equal(list[1].risk, undefined, 'a question has no risk value');
  assert.ok(list[0].id && list[0].uid && list[0].bot && list[0].tool);
  assert.equal(list.length, r.store.buildings().reduce((n, b) => n + b.waiting, 0), 'the total matches the buildings');
  // one owner: each item is the vocab item of its session, plus the place and the preview
  const sb = r.store.latest().sessions.find((s) => s.cwd === REPO_B);
  const own = V.requests(sb)[0];
  assert.deepEqual({ ...list[0], uid: undefined, bot: undefined, building: undefined, buildingName: undefined, roomName: undefined, preview: undefined },
    { ...own, uid: undefined, bot: undefined, building: undefined, buildingName: undefined, roomName: undefined, preview: undefined });
  assert.equal(list[0].preview, sb.pending[0].preview || sb.pending[0].detail || '');
  // the same list for a snapshot passed in, and an ended session adds nothing
  r.tracker.sessions.forEach((s) => { s.status = 'ended'; });
  r.push();
  assert.deepEqual(r.store.requests(), []);
});

// A new scene starts empty, so the adapter sends the state again (DS Reference, Scene mount). Those events are
// seeded: the scene applies them, but plays no sound and sends no toast or onNotify. Live events after that are not.
test('a scene mounted later gets the whole state in one seeded pass: open requests and the error too, with their times', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[1], session_id: 'a', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[2], session_id: 'a', cwd: REPO_A });   // a tool call that is still open
  r.t += 10;
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  r.t += 10;
  const [sa, sb] = [...r.tracker.sessions.values()];
  r.tracker.askQuestion(sa, 'Use the old schema?');
  sb.error = { id: 1, text: 'Out of budget.', at: r.t };
  r.push();
  const m = r.mount(KEY_A);
  assert.ok(m.ev.length > 0);
  for (const e of m.ev) assert.equal(e.seeded, true, `${e.type} is seeded`);
  // the open requests and the error are in the first pass, not one snapshot later
  const reqs = of(m.ev, 'request');
  assert.deepEqual(reqs.map((e) => e.id).sort(), [...sa.pending.map((x) => x.id), ...sa.questions.map((x) => x.id)].sort());
  assert.equal(reqs.find((e) => e.tool === 'Bash').at, sa.pending[0].t);
  assert.equal(reqs.find((e) => e.tool === 'office_ask').at, sa.questions[0].t);
  assert.deepEqual(of(m.ev, 'error').map((e) => [e.bot, e.text, e.at]), [['repo 2', 'Out of budget.', sb.error.at]]);
  assert.equal(of(m.ev, 'bot.add').find((e) => e.bot.name === 'repo').at, sa.startedAt);
  assert.equal(of(m.ev, 'tool.call')[0].at, sa.calls[0].t);
  // the next snapshot says nothing new, and live news after that is not seeded
  const n = m.ev.length;
  r.push();
  assert.equal(m.ev.length, n, 'nothing is sent twice');
  r.t += 10;
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, tool_input: { command: 'npm test' }, session_id: 'b', cwd: REPO_A }, null));
  r.push();
  const live = m.ev.slice(n);
  assert.ok(of(live, 'request').length === 1);
  for (const e of live) assert.equal(e.seeded, undefined, `live ${e.type} is not seeded`);
});

test('a bot seated again after a branch change is seeded: its open request does not toast a second time', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  r.push();
  assert.equal(of(m.ev, 'request').filter((e) => !e.seeded).length, 1, 'the new request is live news');
  const s = [...r.tracker.sessions.values()][0];
  s.git = { ...s.git, branch: 'feat/y' };   // the session checked out another branch
  const n = m.ev.length;
  r.push();
  const again = m.ev.slice(n);
  assert.deepEqual(types(again).slice(0, 3), ['bot.remove', 'floor.add', 'bot.add']);
  assert.equal(again[0].seeded, undefined, 'the bot leaving its old floor is news');
  for (const e of again.slice(1)) assert.equal(e.seeded, true, `${e.type} restores state the scene had`);
  assert.equal(of(again, 'request').length, 1, 'the open request is shown on the new floor');
});

test('a snapshot that lands before the deferred first pass: what the scene mounted with is seeded, only later news is live', async () => {
  const queued = [];
  const r = rig({ defer: (fn) => queued.push(fn) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  r.push();
  const old = r.store.requests()[0];
  const m = r.mount(KEY_A);
  assert.deepEqual(m.ev, [], 'the first pass waits for the deferred call');
  // an SSE snapshot is handled before the timer: a broadcast follows every hook
  r.t += 10;
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, tool_input: { command: 'npm test' }, session_id: 'a', cwd: REPO_A }, null));
  r.push();
  const fresh = r.store.requests().find((x) => x.id !== old.id);
  // first the restore (all seeded), then the live pass on top of it (none seeded)
  const cut = m.ev.findIndex((e) => !e.seeded);
  assert.ok(cut > 0, 'the restore comes first');
  const restore = m.ev.slice(0, cut), news = m.ev.slice(cut);
  for (const e of news) assert.equal(e.seeded, undefined, `live ${e.type} after the restore is not seeded`);
  assert.equal(of(restore, 'bot.add').length, 1, 'the state at mount is restored');
  assert.deepEqual(of(restore, 'request').map((e) => e.id), [old.id]);
  assert.deepEqual(of(news, 'request').map((e) => e.id), [fresh.id], 'the request that came after the mount is news');
  const n = m.ev.length;
  queued.forEach((f) => f());
  assert.equal(m.ev.length, n, 'the deferred pass sends nothing twice');
});

test('restored replies fill the chat without speech bubbles; a new reply is live and speaks', async () => {
  const r = rig();
  await r.play(HOOKS.turnWithEdit.slice(0, 2));
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.pushReply(s, 'Earlier answer.'); r.push();
  const m = r.mount(KEY_A);
  const old = of(m.ev, 'message').filter((e) => e.text === 'Earlier answer.');
  assert.equal(old.length, 1);
  assert.deepEqual([old[0].seeded, old[0].say, old[0].at], [true, false, s.replies[0].t]);
  r.t += 10;
  r.tracker.pushReply(s, 'New answer.'); r.push();
  const nw = of(m.ev, 'message').filter((e) => e.text === 'New answer.');
  assert.equal(nw.length, 1);
  assert.deepEqual([nw[0].seeded, nw[0].say], [undefined, undefined], 'a live reply shows its bubble');
});

test('a re-seat restores without times, so the DS records nothing twice; news in the same snapshot stays live', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.play(HOOKS.turnWithEdit.slice(0, 3).map((p) => ({ ...p, session_id: 'a', cwd: REPO_A })));   // an open tool call
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  r.tracker.pushReply(s, 'Earlier answer.');
  r.push();
  const oldReq = s.pending[0].id;
  // the session checks out another branch, and in the same snapshot asks a new question and says something new
  s.git = { ...s.git, branch: 'feat/y' };
  r.t += 10;
  r.tracker.askQuestion(s, 'Use the old schema?');
  r.tracker.pushReply(s, 'New answer.');
  const n = m.ev.length;
  r.push();
  const again = m.ev.slice(n);
  const isNews = (e) => (e.type === 'request' && e.tool === 'office_ask') || (e.type === 'message' && e.text === 'New answer.');
  for (const e of again.slice(1).filter((e) => !isNews(e))) {
    assert.equal(e.seeded, true, `${e.type} restores state the scene had`);
    assert.equal(e.at, undefined, `restored ${e.type} has no time: it is not news`);
  }
  assert.deepEqual(of(again, 'request').filter((e) => e.seeded).map((e) => e.id), [oldReq]);
  const q = of(again, 'request').filter((e) => e.tool === 'office_ask');
  assert.equal(q.length, 1);
  assert.equal(q[0].seeded, undefined, 'a question asked in the re-seat snapshot is news');
  const said = of(again, 'message');
  assert.deepEqual(said.map((e) => [e.text, e.seeded, e.say]), [['Earlier answer.', true, false], ['New answer.', undefined, undefined]]);
  assert.ok(of(again, 'tool.call').length === 1 && of(again, 'tool.call')[0].seeded, 'the open tool call is restored');
});

test('a bot first seen in a live pass with an error it already had restores the error, and does not toast it', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_B });
  const s = [...r.tracker.sessions.values()][0];
  s.error = { id: 1, text: 'Out of budget.', at: r.t }; r.push();
  assert.deepEqual(of(m.ev, 'error'), [], 'another building');
  // the session moves to a folder of this building while it is in Error
  r.t += 10;
  s.git = GITS[REPO_A]; s.cwd = REPO_A; r.push();
  const errs = of(m.ev, 'error');
  assert.equal(errs.length, 1, 'the bot shows its error');
  assert.deepEqual([errs[0].seeded, errs[0].at], [true, undefined], 'an old failure is not news');
  // a new failure later is news
  s.error = { id: 2, text: 'Stopped again.', at: r.t }; r.push();
  const e2 = of(m.ev, 'error').at(-1);
  assert.deepEqual([e2.text, e2.seeded], ['Stopped again.', undefined]);
});

test('alerts: the requests and errors of every building, for the page Notifier', async () => {
  const r = rig();
  assert.deepEqual(r.store.alerts(), [], 'no snapshot, no alerts');
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_B });
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'b', cwd: REPO_B }, null));
  const sa = [...r.tracker.sessions.values()].find((s) => s.cwd === REPO_A);
  sa.error = { id: 3, text: 'Out of budget.', at: r.t };
  r.push();
  const list = r.store.alerts();
  const req = r.store.requests()[0];
  assert.deepEqual(list, [
    { id: req.id, kind: 'request', bot: req.bot, risk: req.risk, text: 'other. ' + req.text, uid: req.uid, building: KEY_B },
    { id: 'error:' + sa.uid + ':3', kind: 'error', bot: sa.name, text: 'repo. Out of budget.', uid: sa.uid, building: KEY_A },
  ]);
  // a new error is a new alert (a new id); a dismissed one is gone
  sa.error = { id: 4, text: 'Out of budget.', at: r.t }; r.push();
  assert.equal(r.store.alerts()[1].id, 'error:' + sa.uid + ':4');
  r.tracker.dismissError(sa); r.push();
  assert.deepEqual(r.store.alerts().map((x) => x.kind), ['request']);
});

test('two sessions with one name in one building get unique scene names, found by uid', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(fromHooks('turnWithEdit', REPO_A, 'sid-one')[0]);
  await r.hook(fromHooks('turnWithEdit', REPO_A, 'sid-two')[0]);
  const [a, b] = r.store.latest().sessions.filter((s) => s.status !== 'ended');
  assert.equal(a.name, b.name, 'the page sees one name twice');
  const names = [m.botName(a.uid), m.botName(b.uid)];
  assert.equal(names[1], names[0] + ' 2');
  assert.equal(r.store.botName(b.uid), names[1], 'the store answers for the mounted building');
  assert.equal(m.botName('nope'), null);
  // the preview (cards, city palette) names and identifies them the same way, so a pick can be matched by uid
  const pv = r.store.preview(KEY_A).floors.flatMap((f) => f.rooms.flatMap((rm) => rm.bots));
  assert.deepEqual(pv.map((x) => x.name), names);
  assert.deepEqual(pv.map((x) => x.uid), [a.uid, b.uid]);
});
