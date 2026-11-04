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
  for (const [k, t0] of Object.entries(sp.fields)) {
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
  });
  r.store = B.createStore({ now: () => r.t, defer: (fn) => fn(), setTimer: (fn, ms) => { r.timers.push({ fn, ms }); } });
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
  const again = [];
  back.attach((e) => again.push(e));
  assert.deepEqual(types(again), types(back.ev));
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
