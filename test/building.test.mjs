// Snapshot store and building adapter tests. Snapshots come from the real session tracker fed with recorded
// hook payloads, shaped like the server's snapshot (place.mjs, vocab.js). Every event the adapter emits is checked
// against the design system schema (kit/schema.json, the same rules as kit/check.py).
// No browser, no server, no timers, no paid calls. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTracker } from '../tracker.mjs';
import { slimPayload } from '../payload.mjs';
import { placeOfSession, placeOfWorktree, normPath, securityRoomIdOf, seatOf, settleRooms, viewRooms } from '../place.mjs';
import { newRecord, shownFloors, layoutView, edit as editLayout } from '../archetypes.mjs';
import '../public/vocab.js';
import '../public/wire.js';
import '../public/building.js';
import { loadBundle } from './fixtures/ds-bundle.mjs';

// building.js reads the DS's worst-state order (AgentOffice.worstOf) at each call, as on the page, where the bundle loads first.
globalThis.AgentOffice = loadBundle().AO;

const V = globalThis.OfficeVocab, B = globalThis.OfficeBuilding, W = globalThis.OfficeWire;
const load = (f) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const HOOKS = load('hooks.json'), STREAM = load('stream.json');
const SCHEMA = JSON.parse(fs.readFileSync(new URL('../kit/schema.json', import.meta.url), 'utf8'));
const STATES = new Set(['working', 'waiting', 'error', 'resting', 'finished']);

const REPO_A = 'C:\\work\\repo', REPO_B = 'C:\\work\\other';
const GITS = {
  [REPO_A]: { repo: REPO_A, root: REPO_A, branch: 'main' },
  [REPO_B]: { repo: REPO_B, root: REPO_B, branch: 'main' },
  'C:\\work\\repo-feat': { repo: REPO_A, root: 'C:\\work\\repo-feat', branch: 'feat/x' },
  'C:\\work\\repo-y': { repo: REPO_A, root: 'C:\\work\\repo-y', branch: 'feat/y' },
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
  r.store = B.createStore({ now: () => r.t, defer: over.defer || ((fn) => fn()), setTimer: (fn, ms) => { r.timers.push({ fn, ms }); }, fetchReplies: over.fetchReplies, onProblem: over.onProblem });
  // Function floors (#92), as the server does them: one record per building (r.layouts[key]; default General), the seat of
  // each session (place.mjs seatOf), and the room records (place.mjs settleRooms, viewRooms), kept across snapshots like persisted.rooms.
  r.layouts = over.layouts || {};
  r.rooms = {};
  const recOf = (key) => r.layouts[key] || (r.layouts[key] = newRecord(null));
  r.snap = () => {
    const sessions = [...r.tracker.sessions.values()].map((s) => {
      const place = s.placed ? placeOfSession(s.git, s.cwd) : null;
      return { ...s, place, seat: place ? seatOf({ assigned: s.assignedRole, desk: s.deskRole, agentType: s.agentType }, shownFloors(recOf(place.buildingKey))) : null };
    });
    const by = {};
    for (const s of sessions) if (s.status !== 'ended' && s.place) (by[s.place.noteKey] ||= []).push(s);
    const figures = {};
    for (const k of Object.keys(by)) figures[k] = V.figures(by[k]);
    const repos = r.repos.map((p) => ({ key: normPath(p.path), path: p.path, name: p.path.split('\\').pop(), securityRoomId: securityRoomIdOf(normPath(p.path)), worktrees: p.worktrees.map((w) => ({ ...w, place: placeOfWorktree(p.path, w) })) }));
    // a worktree that is gone takes its room record with it (server dropGoneRooms)
    for (const [nk, rec] of Object.entries(r.rooms)) { const rp = repos.find((x) => x.key === rec.building); if (rp && !rp.worktrees.some((w) => w.place.rootKey === rec.root)) delete r.rooms[nk]; }
    const liveRooms = sessions.filter((s) => s.status !== 'ended' && s.place).sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => ({ pl: s.place, seat: s.seat, goal: s.goal, firstPrompt: s.firstPrompt }));
    r.rooms = settleRooms(r.rooms, liveRooms).rooms;
    const rooms = viewRooms(r.rooms, liveRooms);
    const layouts = {};
    for (const key of new Set([...repos.map((x) => x.key), ...sessions.filter((s) => s.place).map((s) => s.place.buildingKey)])) layouts[key] = layoutView(recOf(key));
    return {
      sessions, figures, notes: {}, pins: {}, plan: r.plan || null, now: r.t, kinds: over.kinds || [], repos, layouts, rooms,
    };
  };
  // as over SSE. wire: the server's way (wire.js): the lean snapshot, whole once, then patches; r.reconnect() starts again.
  const tx = W.sender();
  let fresh = true;
  r.reconnect = () => { tx.reset(); fresh = true; };
  r.push = over.wire
    ? () => {
      const p = tx.next(W.lean(r.snap()));
      const msg = fresh ? tx.full() : p;
      fresh = false;
      if (msg) assert.equal(r.store.receive(JSON.parse(JSON.stringify(msg))), true, 'the message fits');
    }
    : () => r.store.set(JSON.parse(JSON.stringify(r.snap())));
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
// the worktree rooms of a floor (the ground floor also has the Security room, #70)
const labs = (f) => f.rooms.filter((x) => x.type === 'lab');
const of = (ev, type) => ev.filter((e) => e.type === type);
const fromHooks = (name, cwd, sid) => HOOKS[name].map((p) => ({ ...p, cwd, session_id: sid }));

test('a scene mounted before the building has a layout shows the Lobby, and is mounted again once the floors come', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  assert.deepEqual(m.def.floors.map((f) => f.fn), ['lobby']);
  await r.hook(HOOKS.turnWithEdit[0]);
  assert.equal(m.stale(), true, 'the layout came: the DS cannot add floors below the top, so the page mounts again');
  const next = r.mount(KEY_A);
  assert.deepEqual(next.def.floors.map((f) => f.fn), ['lobby', 'work', 'review', 'records']);
  assert.equal(next.stale(), false);
});

test('importing starts nothing, and a store with no snapshot answers with empty values', () => {
  const s = B.createStore();
  assert.equal(s.latest(), null);
  assert.deepEqual(s.buildings(), []);
  assert.equal(s.session('x'), null);
  assert.equal(s.lookup('x'), null);
  const m = s.mount(KEY_A);
  assert.deepEqual(m.def.floors.map((f) => f.name), ['Lobby'], 'no layout yet: the Lobby only');
  assert.equal(m.stale(), false);
});

test('a scene mounted on an empty building seats the first session at the open desks of the Lobby', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }] }] });
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(types(m.ev), [], 'nothing to say yet');
  await r.hook(HOOKS.turnWithEdit[0]);
  assert.deepEqual(types(m.ev).slice(0, 4), ['room.add', 'bot.add', 'session.start', 'model']);
  assert.equal(of(m.ev, 'floor.add').length, 0, 'the floors come from the layout, at mount');
  const ra = of(m.ev, 'room.add')[0];
  assert.deepEqual([ra.floorId, ra.room.name, ra.room.note], [1, 'main', 'main · Shared workspace'], 'no role: the Lobby; no task yet: the branch names the room');
  assert.equal(of(m.ev, 'bot.add')[0].roomId, ra.room.id);
  assert.equal(of(m.ev, 'bot.add')[0].bot.status, 'resting');
  assert.equal(m.stale(), false, 'nothing is mounted again');
});

test('a bot names its agent kind on its card (platform), from the snapshot\'s kinds; the store gives the same word', async () => {
  const kinds = [{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'ollama', label: 'Ollama' }];
  const r = rig({ wire: true, kinds });
  await r.hook(fromHooks('turnWithEdit', REPO_A, 'cc-1')[0]);
  const local = r.tracker.newSession({ uid: 'o-local', officeId: 'o-local', provider: 'ollama', name: 'local', cwd: REPO_A, startDir: REPO_A, launched: true, headless: true, status: 'starting' });
  r.tracker.placeSession(local, true);
  await new Promise((res) => setImmediate(res));
  r.push();
  const m = r.mount(KEY_A);
  const cards = Object.fromEntries(of(m.ev, 'bot.add').map((e) => [e.bot.name, e.bot.platform]));
  assert.deepEqual(cards, { repo: 'Claude Code', local: 'Ollama' });
  assert.equal(r.store.kindWord(r.store.sessionByUid('o-local')), 'Ollama');
  assert.deepEqual(r.store.kinds(), kinds);
  assert.equal(B.createStore().kindWord({ provider: 'ollama' }), 'ollama', 'no snapshot yet: the kind id');
});

test('a building names the agent kinds of its open sessions (the HUD connection name), not always Claude Code', async () => {
  const kinds = [{ kind: 'claude-code', label: 'Claude Code' }, { kind: 'ollama', label: 'Ollama' }];
  const r = rig({ wire: true, kinds });
  r.push();
  const m = r.mount(KEY_A);
  assert.equal(m.agentName(), 'Claude Code', 'an empty building: the kind a new session gets (the first kind)');
  const local = r.tracker.newSession({ uid: 'o-local', officeId: 'o-local', provider: 'ollama', name: 'local', cwd: REPO_A, startDir: REPO_A, launched: true, headless: true, status: 'starting' });
  r.tracker.placeSession(local, true);
  await new Promise((res) => setImmediate(res));
  r.push();
  assert.equal(m.agentName(), 'Ollama', 'only Ollama bots: Ollama');
  await r.hook(fromHooks('turnWithEdit', REPO_A, 'cc-1')[0]);
  assert.equal(m.agentName(), 'Claude Code, Ollama', 'both kinds, in the order of the kinds');
  assert.equal(r.store.mount(KEY_B).agentName(), 'Claude Code', 'another building does not count these sessions');
  assert.equal(B.createStore().mount(KEY_A).agentName(), '', 'no snapshot: no name (the page has its own word)');
});

test('the bot of an ungated agent carries its supervision label on its card; a gated one says its agent kind (ADR 0001, #73)', async () => {
  const r = rig({ kinds: [{ kind: 'claude-code', label: 'Claude Code' }] });
  await r.hook(HOOKS.turnWithEdit[0]);
  assert.equal(of(r.mount(KEY_A).ev, 'bot.add')[0].bot.platform, 'Claude Code');
  const r2 = rig();
  await r2.hook(HOOKS.turnWithEdit[0]);
  [...r2.tracker.sessions.values()][0].supervision = 'Partly supervised: commands ask, file edits do not';
  r2.push();
  assert.equal(of(r2.mount(KEY_A).ev, 'bot.add')[0].bot.platform, 'Partly supervised: commands ask, file edits do not');
});

test('a supervision label that changes after the bot is seated seats it again, so the card never keeps a label that is no longer true', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  const s = [...r.tracker.sessions.values()][0];
  s.supervision = 'Partly supervised: commands ask, file edits do not';
  r.push();
  assert.equal(of(m.ev, 'bot.add').at(-1).bot.platform, 'Partly supervised: commands ask, file edits do not');
  const adds = of(m.ev, 'bot.add').length;
  s.supervision = 'Unsupervised';   // the config said commands do not ask
  r.push();
  assert.equal(of(m.ev, 'bot.add').length, adds + 1);
  assert.equal(of(m.ev, 'bot.add').at(-1).bot.platform, 'Unsupervised');
  assert.ok(of(m.ev, 'bot.remove').length >= 2, 'the old card is removed first');
  r.push();   // nothing changed: nothing is seated again
  assert.equal(of(m.ev, 'bot.add').length, adds + 1);
});

test('a Paperclip run (#76) is labelled with its role, company and task; the label that comes once the office watches it seats the bot again', async () => {
  const r = rig({ kinds: [{ kind: 'claude-code', label: 'Claude Code' }] });
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  assert.equal(of(m.ev, 'bot.add').at(-1).bot.owner, undefined, 'not a Paperclip run (yet): no owner');
  const adds = of(m.ev, 'bot.add').length;
  const s = [...r.tracker.sessions.values()][0];
  s.hq = { agent: 'Ada', role: 'Backend engineer', company: 'Acme Robotics', task: 'ACM-12 Add a health route to the API', budget: { spent: 8.3, limit: 50 }, run: 'run-1' };
  r.push();
  assert.equal(of(m.ev, 'bot.add').length, adds + 1, 'the card lines come only with bot.add');
  const bot = of(m.ev, 'bot.add').at(-1).bot;
  assert.equal(bot.platform, 'Paperclip Backend engineer, Claude Code');
  assert.equal(bot.owner, 'Acme Robotics (Ada)');
  assert.equal(bot.task, 'ACM-12 Add a health route to the API', 'its Paperclip task, not the wake-up prompt');
  r.push();
  assert.equal(of(m.ev, 'bot.add').length, adds + 1, 'nothing changed: not seated again');
  s.hq = { ...s.hq, task: 'ACM-13 Next task', budget: { spent: 9, limit: 50 } };
  r.push();
  assert.equal(of(m.ev, 'bot.add').length, adds + 1, 'a new task or budget is a status line, not a new seat');
});

test('a turn with an edit: working, tool call without a bubble on replay, result, finished', async () => {
  const r = rig();
  const m0 = r.mount(KEY_A);
  const [start, prompt, pre, post, stop] = HOOKS.turnWithEdit;
  await r.hook(start);
  m0.ev.length = 0;
  await r.hook(prompt);
  // the main checkout is shared by ad-hoc sessions: its branch names it, and a prompt there does not rename it (#92 review)
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
  assert.equal(labs(late.def.floors[0])[0].name, 'main', 'the definition already holds the room, named from its branch');
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

test('the reason an agent gives for a request goes with the request to the scene (#72)', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, ask_reason: 'The test failed; I need the full log.' }, null));
  r.push(); r.push();
  const req = of(m.ev, 'request').find((e) => e.tool === 'Bash');
  assert.match(req.text, /^Allow Bash.*\? Reason: The test failed; I need the full log\.$/);
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

// ---------- helper bot lifecycle (#94, #95) ----------
const task = (id, type) => ({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO_A, tool_name: 'Task', tool_use_id: id, tool_input: { description: 'Look ' + id, subagent_type: type } });
const taskDone = (id, type) => ({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO_A, tool_name: 'Task', tool_use_id: id, duration_ms: 5, tool_input: { subagent_type: type } });
const helperDone = (ev, bot) => ev.filter((e) => e.type === 'subagent.done' && e.bot === bot);

test('a new helper never reuses the name of a helper bot that is still walking out (#94)', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(task('t1', 'Explore'));
  await r.hook(taskDone('t1', 'Explore'));   // the first helper is told to leave; its bot is still in the scene
  await r.hook(task('t2', 'Explore'));
  await r.hook(taskDone('t2', 'Explore'));
  await r.hook(task('t3', 'Explore'));
  const names = of(m.ev, 'delegate').map((e) => e.spawn.name);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3, `three helpers, three names: ${names}`);
  assert.equal(helperDone(m.ev, names[0]).length, 1, 'the first helper left once');
  assert.equal(helperDone(m.ev, names[2]).length, 0, 'the third helper is still at work');
});

test('a session that moves to another folder sends its open helpers away (#95)', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  await r.hook(task('t1', 'Explore'));
  await r.hook(task('t2', 'general-purpose'));
  await r.hook(taskDone('t2', 'general-purpose'));
  const [h1, h2] = of(m.ev, 'delegate').map((e) => e.spawn.name);
  const n = m.ev.length;
  // A plain tool call from the other folder moves the session. A SessionStart would close every subagent
  // ("The session restarted"), and then no helper would be open to move.
  await r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: 'C:\\work\\repo-feat', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.txt' } });
  const after = m.ev.slice(n);
  assert.equal(helperDone(after, h1).length, 1, 'the open helper is told to leave');
  assert.equal(helperDone(after, h1)[0].remove, true);
  assert.equal(helperDone(after, h1)[0].result, 'Moved with its session', 'the helper is not called stopped: its subagent runs on');
  assert.equal(helperDone(m.ev, h2).length, 1, 'a helper that was done is not told twice');
  // the open helper sits down again in the new room, under a new name, and its later finish goes to that name
  const again = of(after, 'delegate').map((e) => e.spawn.name);
  assert.equal(again.length, 1, 'only the open helper comes back');
  assert.notEqual(again[0], h1, 'the old name is still taken while that bot walks out');
  await r.hook({ ...taskDone('t1', 'Explore'), cwd: 'C:\\work\\repo-feat' });
  assert.equal(helperDone(m.ev, again[0]).length, 1, 'the finish goes to the new helper');
  assert.equal(helperDone(m.ev, h1).length, 1, 'the old helper is not told again');
});

test('a session the server forgets sends its open helpers away (#95)', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  await r.hook(task('t1', 'Explore'));
  const h1 = of(m.ev, 'delegate')[0].spawn.name;
  const n = m.ev.length;
  r.tracker.sessions.clear(); r.push();
  const after = m.ev.slice(n);
  assert.equal(of(after, 'bot.remove').length, 1);
  assert.equal(helperDone(after, h1).length, 1, 'the open helper is told to leave');
  r.push();
  assert.equal(helperDone(m.ev, h1).length, 1, 'once');
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
  const m0 = r.mount(KEY_A);
  assert.equal(m0.roomsShown().length, 0, 'a worktree no agent ever used is no room');
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'f', cwd: 'C:\\work\\repo-feat' });
  const m = r.mount(KEY_A);
  assert.equal(m.roomsShown().length, 1);
  assert.equal(m.stale(), false);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'f', cwd: 'C:\\work\\repo-feat' }, null));
  r.repos[0].worktrees.pop();
  r.push();
  assert.equal(m.stale(), true);
  const next = r.mount(KEY_A);
  assert.equal(next.roomsShown().length, 0);
  assert.equal(next.stale(), false);
});

test('a session that ends leaves its room on screen: the scene is not stale', async () => {
  const r = rig();
  await r.hook(HOOKS.turnWithEdit[0]);
  const m = r.mount(KEY_A);
  assert.equal(m.stale(), false);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'sid-1', cwd: REPO_A }, null)); r.push();
  assert.equal(m.stale(), false, 'the room stays, empty; a restart would flash the scene');
});

test('a move to another folder seats the bot again, in the new room; a branch change alone does not', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  const s = [...r.tracker.sessions.values()][0];
  s.git = { ...s.git, branch: 'feat/y' }; r.push();   // the same folder on another branch: the same room, the same floor
  assert.equal(of(m.ev, 'bot.remove').length, 0, 'a branch is a label, not a floor');
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-1', cwd: 'C:\\work\\repo-feat' });   // same session, another folder
  assert.equal(s.cwd, 'C:\\work\\repo-feat');
  assert.ok(types(m.ev).includes('bot.remove'));
  assert.equal(of(m.ev, 'floor.add').length, 0);
  assert.equal(of(m.ev, 'room.add').length, 2, 'a room for each folder, both in the Lobby');
  assert.equal(of(m.ev, 'bot.add').length, 2);
});

test('room info, figures and note keys come from the snapshot', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }, { branch: 'feat/x', root: 'C:\\work\\repo-feat' }] }] });
  // an agent works in the feat/x worktree, then leaves: its room stays in this mount, empty
  await busy(r, 'gone', 'C:\\work\\repo-feat', 'work');
  await r.play(HOOKS.turnWithEdit.slice(0, 3));
  const m = r.mount(KEY_A);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'gone', cwd: 'C:\\work\\repo-feat' }, null)); r.push();
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

test('three agents in three agent worktrees: three rooms on the floor of their role, each named by its task', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }] }] });
  for (const n of ['a', 'b', 'c']) await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-' + n, cwd: WT(n) });
  for (const x of r.tracker.sessions.values()) x.deskRole = 'work';
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(m.def.floors.map((f) => f.name), ['Lobby', 'Work', 'Review', 'Records'], 'no floor per agent branch');
  const work = m.def.floors[1];
  assert.deepEqual(labs(work).map((x) => [x.name, x.note]), [['agent/a-1', 'agent/a-1 · Private'], ['agent/b-1', 'agent/b-1 · Private'], ['agent/c-1', 'agent/c-1 · Private']]);
  assert.equal(new Set(of(m.ev, 'bot.add').map((e) => e.roomId)).size, 3, 'each agent has its own room');
  assert.equal(of(m.ev, 'floor.add').length, 0, 'the scene has the floors from its definition');
});

test('an agent worktree is a room on a floor while an agent of it sits there; with none, the floor has its open desks', async () => {
  GITS[WT('z')] = { repo: REPO_A, root: WT('z'), branch: 'agent/z-9', base: 'main' };
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }, { branch: 'agent/z-9', root: WT('z'), base: 'main' }] }] });
  r.push();
  assert.deepEqual(labs(r.mount(KEY_A).def.floors[2]).map((x) => x.id), ['spare-review'], 'no session yet: only the open desks');
  await busy(r, 'z', WT('z'), 'review');
  assert.deepEqual(labs(r.mount(KEY_A).def.floors[2]).map((x) => x.name), ['agent/z-9']);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'z', cwd: WT('z') }, null)); r.push();
  assert.deepEqual(labs(r.mount(KEY_A).def.floors[2]).map((x) => x.id), ['spare-review'], 'the agent left: the next mount has the open desks');
  assert.deepEqual(r.store.latest().rooms[placeOfWorktree(REPO_A, { branch: 'agent/z-9', root: WT('z'), base: 'main' }).noteKey].floors, []);
  delete GITS[WT('z')];
});

test('room sign count: two top-level sessions share one room, helpers do not count', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'one', cwd: REPO_A });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'two', cwd: REPO_A });
  const m = r.mount(KEY_A);
  const room = labs(m.def.floors[0])[0].id;
  assert.equal(labs(m.def.floors[0]).length, 1, 'one folder, one room');
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
  const room = labs(m.def.floors[0])[0].id;
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
  assert.deepEqual(labs(pv.floors[0])[0].bots.map((b) => [b.name, b.status]), [['other', 'waiting']]);
  assert.equal(r.store.buildingOf(r.store.latest().sessions[0]), KEY_A);
});

test('a session outside git sits in the Other folders building', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], cwd: 'C:\\scratch\\notes' });
  assert.deepEqual(r.store.buildings().map((b) => b.name), ['Other folders']);
  const m = r.mount('');
  assert.deepEqual(types(m.ev), ['bot.add', 'session.start', 'model']);
  assert.equal(m.def.name, 'Other folders');
  assert.equal(m.def.floors[0].name, 'Lobby');
  assert.deepEqual(labs(m.def.floors[0]).map((x) => [x.name, x.note]), [['notes', 'notes']], 'no git: the folder names the room; no tag for one agent');
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

test('a bot seated again on another floor is seeded: its open request does not toast a second time', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }] }] }); r.push();
  const m = r.mount(KEY_A);
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  r.push();
  assert.equal(of(m.ev, 'request').filter((e) => !e.seeded).length, 1, 'the new request is live news');
  const s = [...r.tracker.sessions.values()][0];
  s.assignedRole = 'review';   // the Manager gave it a role on another floor
  const n = m.ev.length;
  r.push();
  const again = m.ev.slice(n);
  assert.deepEqual(types(again).slice(0, 3), ['bot.remove', 'room.update', 'bot.add'], 'the open desks of the new floor become its room');
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
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }] }] }); r.push();
  const m = r.mount(KEY_A);
  await r.play(HOOKS.turnWithEdit.slice(0, 3).map((p) => ({ ...p, session_id: 'a', cwd: REPO_A })));   // an open tool call
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  r.tracker.pushReply(s, 'Earlier answer.');
  r.push();
  const oldReq = s.pending[0].id;
  // the session gets a role on another floor, and in the same snapshot asks a new question and says something new
  s.assignedRole = 'review';
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

// ---------- the Security room (#70): first on the ground floor of every building, no bots, never a worktree ----------
const SEC_A = securityRoomIdOf(KEY_A);
test('every building has a Security room first on its ground floor: no bots, no notes key, never stale', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [{ branch: 'main', root: REPO_A }, { branch: 'feat/x', root: 'C:\\work\\repo-feat' }] }] });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'f', cwd: 'C:\\work\\repo-feat' });
  const m = r.mount(KEY_A);
  const sec = m.def.floors[0].rooms[0];
  assert.deepEqual(sec, { id: SEC_A, type: 'security', name: 'Security', bots: [], screens: ['Files', 'Commands', 'Network', 'Secrets', 'Agents', 'Spend'] });
  assert.equal(m.def.floors.slice(1).some((f) => f.rooms.some((x) => x.type === 'security')), false, 'one Security room, on the ground floor');
  assert.equal(m.securityRoom(), SEC_A);
  assert.equal(m.noteKey(SEC_A), '');
  assert.deepEqual(m.roomInfo(SEC_A).sessions, []);
  assert.equal(m.roomsShown().length, 1, 'the workspace rooms only');
  assert.equal(m.stale(), false);
  assert.equal(of(m.ev, 'room.add').length, 0, 'the scene has it from its definition');
});

test('an empty building has its Security room and its Reception, and they stay when the first session comes', async () => {
  const r = rig({ repos: [{ path: REPO_A, worktrees: [] }] });
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(m.def.floors[0].rooms.map((x) => x.type), ['security', 'lobby']);
  assert.equal(m.def.floors[0].rooms[1].spare, 2, 'the Reception has open desks');
  await r.hook(HOOKS.turnWithEdit[0]);
  const ra = of(m.ev, 'room.add')[0];
  assert.equal(ra.floorId, 1, 'the session joins the Lobby in a room of its own');
  assert.ok(!m.ev.some((e) => e.roomId === SEC_A || e.roomId === 'reception'), 'nothing is said to the Security room or the Reception');
});

test('a building known only from a session gets its Security room from the session place', async () => {
  const r = rig();
  await r.hook(HOOKS.turnWithEdit[0]);
  const m = r.mount(KEY_A);
  assert.equal(m.def.floors[0].rooms[0].id, SEC_A);
  assert.notEqual(of(m.ev, 'bot.add')[0].roomId, SEC_A);
});

// #58: a reply that came before the page saw the session must be in that bot's chat, whichever way the bot first shows.
const said = (ev, bot) => of(ev, 'message').filter((e) => !bot || e.bot === bot).map((e) => e.text);

test('replies from before the page opened fill the chat, in order, each once, equal texts too', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.pushReply(s, 'Done.'); r.t += 5; r.tracker.pushReply(s, 'Done.'); r.t += 5; r.tracker.pushReply(s, 'Last.');
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(said(m.ev), ['Done.', 'Done.', 'Last.']);
  r.push(); r.push();
  assert.deepEqual(said(m.ev), ['Done.', 'Done.', 'Last.'], 'a later snapshot repeats nothing');
});

test('a bot that first shows after the mount (its place came late) brings the replies it already had', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  s.placed = false;   // the server has not found the repo and branch yet
  r.tracker.pushReply(s, 'Early answer.');
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(said(m.ev), [], 'no place, no bot yet');
  s.placed = true;
  r.t += 10;
  r.push();
  assert.deepEqual(said(m.ev), ['Early answer.']);
  r.push();
  assert.deepEqual(said(m.ev), ['Early answer.'], 'once');
});

test('a bot that moves in from another building brings the replies it already had', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_B });
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.pushReply(s, 'Said in the other building.');
  r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(said(m.ev), []);
  s.git = { ...GITS[REPO_A] }; s.cwd = REPO_A;   // it moved into this building
  r.t += 10;
  r.push();
  assert.deepEqual(said(m.ev), ['Said in the other building.']);
});

test('replies of a bot first seen in a live pass are restored, not spoken: seeded without at, no bubble; later replies speak', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_B });
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.pushReply(s, 'One.'); r.t += 5; r.tracker.pushReply(s, 'Two.');
  r.push();
  const m = r.mount(KEY_A);
  s.git = { ...GITS[REPO_A] }; s.cwd = REPO_A;
  r.t += 10;
  r.push();
  const old = of(m.ev, 'message');
  assert.deepEqual(old.map((e) => [e.text, e.seeded, e.say, e.at]), [['One.', true, false, undefined], ['Two.', true, false, undefined]]);
  r.t += 10;
  r.tracker.pushReply(s, 'Three.'); r.push();
  const nw = of(m.ev, 'message').at(-1);
  assert.deepEqual([nw.text, nw.seeded, nw.say], ['Three.', undefined, undefined]);
});

test('a bot that leaves this building and comes back restores its replies once: nothing is recorded twice', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  const m = r.mount(KEY_A);
  r.t += 5; r.tracker.pushReply(s, 'Said here.'); r.push();
  const live = of(m.ev, 'message');
  assert.deepEqual(live.map((e) => [e.text, e.seeded, e.say]), [['Said here.', undefined, undefined]], 'first said live');
  s.git = { ...GITS[REPO_B] }; s.cwd = REPO_B; r.t += 5; r.push();   // it leaves
  s.git = { ...GITS[REPO_A] }; s.cwd = REPO_A; r.t += 5; r.push();   // and comes back
  const all = of(m.ev, 'message');
  assert.equal(all.length, 2);
  assert.deepEqual([all[1].text, all[1].seeded, all[1].say, all[1].at], ['Said here.', true, false, undefined], 'restored, with no time, so the DS does not count it as news again');
});

test('a reopened session carries its old replies: restored in a live pass, no bubbles, no time; its new reply speaks', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const old = [...r.tracker.sessions.values()][0];
  const m = r.mount(KEY_A);
  r.t += 5; r.tracker.pushReply(old, 'First.'); r.t += 5; r.tracker.pushReply(old, 'Second.'); r.push();
  // the server opens a new session (new uid) with the replies of the old one (openHeadless, prior)
  r.tracker.onHook(slimPayload({ ...HOOKS.turnWithEdit[0], session_id: 'b', cwd: REPO_A }, null));
  await new Promise((res) => setImmediate(res));   // no push yet: the page's first sight of the session has its replies
  const fresh = [...r.tracker.sessions.values()].find((x) => x.uid !== old.uid);
  fresh.replies = old.replies.map((x) => ({ ...x })); fresh.replySeq = 2;
  r.t += 5; r.push();
  const botB = m.botName(fresh.uid);
  const restored = of(m.ev, 'message').filter((e) => e.bot === botB);
  assert.ok(botB && botB !== old.name, 'a second bot');
  assert.deepEqual(restored.map((e) => [e.text, e.seeded, e.say, e.at]), [['First.', true, false, undefined], ['Second.', true, false, undefined]]);
  r.t += 5; r.tracker.pushReply(fresh, 'Third.'); r.push();
  const nw = of(m.ev, 'message').filter((e) => e.bot === botB).at(-1);
  assert.deepEqual([nw.text, nw.seeded, nw.say], ['Third.', undefined, undefined]);
});

// #80: the lean snapshot (wire.js) leaves out the oldest replies of a session whose replies go over the cap. The page
// asks the server for the whole list (GET /api/session) before it fills the chat, so the lines go in in order.
const bigReplies = (r, s, n) => { for (let i = 0; i < n; i++) { r.t += 5; r.tracker.pushReply(s, 'R' + i + ' ' + 'x'.repeat(7990)); } };
const names = (ev, bot) => said(ev, bot).map((t) => t.split(' ')[0]);
const upTo = (n) => Array.from({ length: n }, (_, i) => 'R' + i);
const settle = () => new Promise((res) => setImmediate(res));
// what GET /api/session answers: the whole reply list of the session, as JSON
const serverReplies = (r, asked) => async (uid) => { asked.push(uid); return JSON.parse(JSON.stringify([...r.tracker.sessions.values()].find((x) => x.uid === uid).replies)); };

test('a session with more replies than the snapshot carries: the chat gets the older ones first, in order, each once, restored', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12);
  r.push();
  const lean = r.store.sessionByUid(s.uid);
  assert.equal(lean.replies.length + lean.olderReplies, 12, 'the snapshot says how many replies it left out');
  assert.ok(lean.olderReplies > 0);
  const m = r.mount(KEY_A);
  assert.deepEqual(said(m.ev), [], 'newer lines wait: they would go in before the older ones');
  await settle();
  assert.deepEqual(names(m.ev), upTo(12), 'every reply the tracker keeps, in order');
  assert.deepEqual(of(m.ev, 'message').map((e) => [e.seeded, e.say]), Array(12).fill([true, false]), 'restored: no speech bubble');
  r.push(); r.push();
  assert.equal(of(m.ev, 'message').length, 12, 'a later snapshot repeats nothing');
  r.t += 5; r.tracker.pushReply(s, 'New.'); r.push();
  const nw = of(m.ev, 'message').at(-1);
  assert.deepEqual([nw.text, nw.seeded, nw.say], ['New.', undefined, undefined], 'a reply after that speaks');
  assert.deepEqual(asked, [s.uid], 'one request');
});

test('a reply that comes while the older ones load goes in after them and speaks', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const m = r.mount(KEY_A);
  r.t += 5; r.tracker.pushReply(s, 'New.'); r.push();   // the request is out
  assert.deepEqual(said(m.ev), []);
  await settle();
  assert.deepEqual(said(m.ev).map((t) => t.split(' ')[0]), [...upTo(12), 'New.']);
  assert.deepEqual(of(m.ev, 'message').map((e) => e.say), [...Array(12).fill(false), undefined]);
});

test('older replies that cannot load: the newest ones show, the page is told once, and a new scene tries again', async () => {
  const problems = [], asked = [];
  let fail = true;
  const r = rig({ wire: true, onProblem: (t) => problems.push(t),
    fetchReplies: (uid) => (fail ? (asked.push(uid), Promise.reject(new Error('down'))) : serverReplies(r, asked)(uid)) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const lean = r.store.sessionByUid(s.uid);
  const m = r.mount(KEY_A);
  await settle();
  assert.deepEqual(names(m.ev), upTo(12).slice(12 - lean.replies.length), 'the replies the snapshot carries');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /older replies/i);
  r.push(); r.push(); await settle();
  assert.equal(asked.length, 1, 'no new request on every snapshot');
  assert.equal(problems.length, 1);
  fail = false;
  const m2 = r.mount(KEY_A);
  await settle();
  assert.deepEqual(names(m2.ev), upTo(12), 'a new scene gets them all');
});

test('older replies that never answer: after a wait the newest ones show and the page is told once', async () => {
  const problems = [], asked = [];
  const r = rig({ wire: true, onProblem: (t) => problems.push(t), fetchReplies: (uid) => (asked.push(uid), new Promise(() => {})) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12);
  s.error = { id: 1, text: 'Out of budget.', at: r.t + 1 }; r.push();
  const lean = r.store.sessionByUid(s.uid);
  const m = r.mount(KEY_A);
  await settle();
  assert.deepEqual([of(m.ev, 'message').length, of(m.ev, 'error').length], [0, 0], 'the bot waits whole');
  assert.equal(r.timers.length, 1, 'one timer for the request');
  assert.equal(r.timers[0].ms, 15000);
  r.timers[0].fn();
  await settle();
  assert.deepEqual(names(m.ev), upTo(12).slice(12 - lean.replies.length), 'the replies the snapshot carries');
  assert.equal(of(m.ev, 'error').length, 1, 'the error comes after them');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /older replies/i);
  r.timers[0].fn(); r.push(); await settle();
  assert.equal(problems.length, 1, 'a late timer tells nothing twice');
  assert.equal(asked.length, 1);
});

test('a second scene of the building has the older replies at once: the page asks the server once', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const m = r.mount(KEY_A);
  await settle();
  m.detach();
  const m2 = r.mount(KEY_A);
  assert.deepEqual(names(m2.ev), upTo(12), 'no waiting: the page kept them');
  assert.equal(asked.length, 1);
});

test('replies that came after the page kept the older ones: a new scene asks again, so no reply is missing between them', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const m = r.mount(KEY_A);
  await settle();
  m.detach();
  for (let i = 12; i < 24; i++) { r.t += 5; r.tracker.pushReply(s, 'R' + i + ' ' + 'x'.repeat(7990)); }
  r.push();
  const m2 = r.mount(KEY_A);
  await settle();
  assert.deepEqual(names(m2.ev), upTo(24));
  assert.equal(asked.length, 2);
});

test('a bot that leaves and comes back keeps the older replies: restored once, nothing is recorded twice', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const m = r.mount(KEY_A);
  await settle();
  s.git = { ...GITS[REPO_B] }; s.cwd = REPO_B; r.t += 5; r.push();
  s.git = { ...GITS[REPO_A] }; s.cwd = REPO_A; r.t += 5; r.push();
  await settle();
  const all = of(m.ev, 'message');
  assert.deepEqual(all.slice(12).map((e) => e.text.split(' ')[0]), upTo(12));
  assert.ok(all.slice(12).every((e) => e.seeded === true && e.say === false && e.at === undefined), 'restored with no time');
  assert.equal(asked.length, 1);
});

// A held bot is not told in part: its error, its end and its seat wait for its replies, so the chat reads in the order it happened.
test('a failed turn shows after the replies it followed, not before them', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12);
  s.error = { id: 1, text: 'Out of budget.', at: r.t + 1 }; r.push();
  const m = r.mount(KEY_A);
  assert.deepEqual(of(m.ev, 'error'), [], 'the error waits for the replies');
  await settle();
  const line = m.ev.filter((e) => e.type === 'message' || e.type === 'error').map((e) => (e.type === 'error' ? 'ERROR' : e.text.split(' ')[0]));
  assert.deepEqual(line, [...upTo(12), 'ERROR']);
  assert.equal(of(m.ev, 'status').filter((e) => e.status === 'error').length, 0, 'the error is told once, as the error');
  const err = of(m.ev, 'error')[0];
  assert.equal(err.seeded, true, 'an old error is not news: no sound, no toast');
  assert.equal(err.at, s.error.at, 'it keeps its own time');
});

test('an old error stays restored when the bot moves in from another building while its replies load', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_B });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12);
  s.error = { id: 1, text: 'Out of budget.', at: r.t + 1 }; r.push();
  const m = r.mount(KEY_A);
  s.git = { ...GITS[REPO_A] }; s.cwd = REPO_A; r.t += 5; r.push();   // first seen here, in a live pass
  assert.deepEqual(of(m.ev, 'error'), [], 'the error waits for the replies');
  await settle();
  const line = m.ev.filter((e) => e.type === 'message' || e.type === 'error').map((e) => (e.type === 'error' ? 'ERROR' : e.text.split(' ')[0]));
  assert.deepEqual(line, [...upTo(12), 'ERROR']);
  const err = of(m.ev, 'error')[0];
  assert.equal(err.seeded, true);
  assert.equal(err.at, undefined, 'restored in a live pass: no time, so the DS records it once');
});

test('an old error stays seeded when the bot is seated again while its replies load, and a new error is news', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12);
  s.error = { id: 1, text: 'Out of budget.', at: r.t + 1 }; r.push();
  const m = r.mount(KEY_A);
  s.git = { ...GITS['C:\\work\\repo-feat'] }; s.cwd = 'C:\\work\\repo-feat'; r.t += 5; r.push();
  await settle();
  const errs = of(m.ev, 'error');
  assert.equal(errs.length, 1, 'told once');
  assert.equal(errs[0].seeded, true, 'the old seat never told it, so it is not news');
  assert.deepEqual(m.ev.filter((e) => e.type === 'message' || e.type === 'error').map((e) => e.type).slice(-2), ['message', 'error']);
  s.error = { id: 2, text: 'Again.', at: r.t + 9 }; r.t += 10; r.push();
  assert.equal(of(m.ev, 'error').at(-1).seeded, undefined, 'a new failure is live');
});

test('a failure during the hold is news: a bot first seen on page load, a bot that moves in, and a bot seated again', async () => {
  const pageLoad = async () => {
    const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
    await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
    const s = [...r.tracker.sessions.values()][0];
    bigReplies(r, s, 12); r.push();
    const m = r.mount(KEY_A);
    return { r, s, m, again: () => { s.git = { ...GITS['C:\\work\\repo-feat'] }; s.cwd = 'C:\\work\\repo-feat'; r.t += 5; r.push(); } };
  };
  const fail = (r, s, id) => { s.error = { id, text: 'Out of budget.', at: r.t + 1 }; r.t += 2; r.push(); };
  { // first seen on page load
    const { r, s, m } = await pageLoad();
    fail(r, s, 1);
    await settle();
    assert.equal(of(m.ev, 'error').length, 1);
    assert.equal(of(m.ev, 'error')[0].seeded, undefined, 'page load: live');
  }
  { // moves in from another building
    const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
    await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_B });
    const s = [...r.tracker.sessions.values()][0];
    bigReplies(r, s, 12); r.push();
    const m = r.mount(KEY_A);
    s.git = { ...GITS[REPO_A] }; s.cwd = REPO_A; r.t += 5; r.push();
    fail(r, s, 1);
    await settle();
    assert.equal(of(m.ev, 'error').length, 1);
    assert.equal(of(m.ev, 'error')[0].seeded, undefined, 'moved in: live');
  }
  { // seated again
    const { r, s, m, again } = await pageLoad();
    again();
    fail(r, s, 1);
    await settle();
    assert.equal(of(m.ev, 'error').length, 1);
    assert.equal(of(m.ev, 'error')[0].seeded, undefined, 're-seat: live');
  }
});

test('a session that ends while the older replies load still shows its replies, then its end', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const m = r.mount(KEY_A);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'a', cwd: REPO_A }, null)); r.push();
  assert.equal(s.status, 'ended');
  assert.deepEqual(of(m.ev, 'session.end'), [], 'the end waits for the replies');
  await settle();
  const line = m.ev.filter((e) => e.type === 'message' || e.type === 'session.end').map((e) => (e.type === 'message' ? e.text.split(' ')[0] : 'END'));
  assert.deepEqual(line, [...upTo(12), 'END']);
});

test('a bot seated again while the older replies load tells them as it would have: restored, no bubble', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  bigReplies(r, s, 12); r.push();
  const m = r.mount(KEY_A);
  s.git = { ...GITS['C:\\work\\repo-feat'] }; s.cwd = 'C:\\work\\repo-feat'; r.t += 5; r.push();   // another floor, request still out
  await settle();
  const msgs = of(m.ev, 'message');
  assert.deepEqual(msgs.map((e) => e.text.split(' ')[0]), upTo(12));
  assert.ok(msgs.every((e) => e.seeded === true && e.say === false), 'none of them is news');
  r.t += 5; r.tracker.pushReply(s, 'New.'); r.push();
  assert.deepEqual([of(m.ev, 'message').at(-1).text, of(m.ev, 'message').at(-1).say], ['New.', undefined]);
});

test('replies that all fit the snapshot need no request', async () => {
  const asked = [], r = rig({ wire: true, fetchReplies: (uid) => serverReplies(r, asked)(uid) });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'a', cwd: REPO_A });
  const s = [...r.tracker.sessions.values()][0];
  r.tracker.pushReply(s, 'One.'); r.tracker.pushReply(s, 'Two.'); r.push();
  assert.equal(r.store.sessionByUid(s.uid).olderReplies, 0);
  const m = r.mount(KEY_A);
  assert.deepEqual(said(m.ev), ['One.', 'Two.']);
  assert.equal(asked.length, 0);
});

// ---------- the wire (wire.js): lean snapshots and patches give the scene the same events ----------
// One story told twice: once as whole server snapshots (r.store.set), once as the server sends it now (the lean
// snapshot whole, then patches, and a reconnect in the middle). The scene must get the same events, seeded flags and
// times included, and the store must answer the same.
async function story(r) {
  const queued = [];
  await r.play(fromHooks('turnWithEdit', REPO_A, 'a').slice(0, 3));
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'a', cwd: REPO_A }, null));
  const sa = [...r.tracker.sessions.values()][0];
  r.tracker.pushReply(sa, 'Earlier answer.'); r.push();
  r.deferNext = (fn) => queued.push(fn);
  const m = r.store.mount(KEY_A), ev = [];
  m.attach((e) => ev.push(e));
  r.t += 10;
  await r.play(fromHooks('turnWithEdit', REPO_A, 'b').slice(0, 2));   // lands before the deferred first pass
  queued.forEach((f) => f());
  r.t += 10;
  await r.play(fromHooks('subagent', REPO_A, 'a'));
  await r.hook({ ...HOOKS.todoWrite, session_id: 'a', cwd: REPO_A });
  r.reconnect();   // the stream drops and comes back: a whole snapshot, then patches again
  r.t += 10;
  await r.hook({ ...HOOKS.failedTool, session_id: 'b', cwd: REPO_A });
  r.tracker.askQuestion(sa, 'Use the old schema?'); r.push();
  r.tracker.pushReply(sa, 'New answer.'); r.push();
  const sb = [...r.tracker.sessions.values()][1];
  sb.error = { id: 1, text: 'Out of budget.', at: r.t }; r.push();
  sa.git = { ...sa.git, branch: 'feat/y' }; r.push();   // a re-seat on another floor
  r.t += 10;
  r.tracker.endSession(sb, 'closed'); r.push();
  return { ev, requests: r.store.requests(), alerts: r.store.alerts(), buildings: r.store.buildings(), stale: m.stale(), names: [sa.uid, sb.uid].map(m.botName) };
}

test('the scene gets the same events from lean snapshots and patches as from whole snapshots, across a reconnect', async () => {
  const full = rig({ defer: (fn) => full.deferNext(fn) }), lean = rig({ wire: true, defer: (fn) => lean.deferNext(fn) });
  const a = await story(full), b = await story(lean);
  assert.ok(a.ev.length > 20, `${a.ev.length} events`);
  assert.ok(a.ev.some((e) => e.seeded) && a.ev.some((e) => !e.seeded), 'the story has a restore and live news');
  assert.deepEqual(b.ev, a.ev);
  assert.deepEqual(b.requests, a.requests);
  assert.deepEqual(b.alerts, a.alerts);
  assert.deepEqual(b.buildings, a.buildings);
  assert.deepEqual([b.stale, b.names], [a.stale, a.names]);
});

test('receive: a patch that does not start from the latest snapshot changes nothing and asks for a reconnect', async () => {
  const r = rig({ wire: true });
  await r.play(fromHooks('turnWithEdit', REPO_A, 'a').slice(0, 3));
  const before = r.store.latest();
  const seen = [];
  r.store.onSnapshot((s) => seen.push(s));
  assert.equal(r.store.receive({ patch: 1, base: before.seq + 5, seq: before.seq + 6, set: { plan: { week: null } } }), false);
  assert.equal(r.store.latest(), before, 'the snapshot is the same');
  assert.equal(seen.length, 1, 'no listener hears of it');
  assert.equal(r.store.receive({ patch: 1, base: before.seq, seq: before.seq + 1, set: { plan: { week: { percent: 5 } } } }), true);
  assert.equal(r.store.latest().plan.week.percent, 5);
  assert.equal(r.store.latest().sessions, before.sessions, 'what did not change is shared');
  assert.equal(B.createStore().receive({ patch: 1, base: 1, seq: 2 }), false, 'a patch before any snapshot does not fit');
});

// Which floor a scene opens on (#85, #111). floorMemory().start(mount, snap, was) answers { id, branch }: the floor on
// screen before a rebuild, else the busiest floor, else the user's last pick, else the first floor. Never the DS default.
const FEAT = 'C:\\work\\repo-feat', FEAT_Y = 'C:\\work\\repo-y';
const wt = (branch, root) => ({ branch, root });
// An Operations Hub building with three worktrees. Floors are functions now: a floor is found by its key.
const HUB = () => ({ layouts: { [KEY_A]: newRecord({ archetype: 'ops-hub' }) }, repos: [{ path: REPO_A, worktrees: [wt('main', REPO_A), wt('feat/x', FEAT), wt('feat/y', FEAT_Y)] }] });
const idOf = (m, key) => m.floorId(key);
const at = (m, key) => ({ id: idOf(m, key), key });
// A session in a folder, seated from an empty desk of a floor (its desk role).
// The role is there before the first snapshot, as the server sets it when it opens the session.
async function busy(r, id, cwd, role) {
  r.tracker.onHook(slimPayload({ ...HOOKS.turnWithEdit[0], session_id: id, cwd }, null));
  await new Promise((res) => setImmediate(res));
  const s = [...r.tracker.sessions.values()].find((x) => x.sid === id);
  if (role) s.deskRole = role;
  r.push();
  return s;
}

test('a rebuild keeps the floor on screen, by floor key, when that floor still exists (#85)', () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A);
  const picked = idOf(m, 'quality');
  assert.equal(m.floorKey(picked), 'quality');
  // a floor is hidden: the page mounts again, and the ids of the floors move
  r.layouts[KEY_A] = editLayout(r.layouts[KEY_A], { action: 'hide', floor: 'planning' });
  r.push();
  assert.equal(m.stale(), true);
  const next = r.mount(KEY_A);
  assert.notEqual(idOf(next, 'quality'), picked, 'the id changed, so the page must not carry the id');
  assert.deepEqual(B.floorMemory().start(next, r.store.latest(), m.floorKey(picked)), at(next, 'quality'), 'the floor on screen stays');
});

test('a rebuild does not keep a floor that is gone or unknown; the page still opens a floor (#85, #111)', () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A);
  const x = idOf(m, 'planning');
  r.layouts[KEY_A] = editLayout(r.layouts[KEY_A], { action: 'hide', floor: 'planning' });
  r.push();
  const next = r.mount(KEY_A), mem = B.floorMemory();
  assert.deepEqual(mem.start(next, r.store.latest(), m.floorKey(x)), at(next, 'lobby'), 'the floor is gone, nothing is busy: the ground floor');
  assert.deepEqual(mem.start(next, r.store.latest(), m.floorKey(999)), at(next, 'lobby'));
  assert.deepEqual(mem.start(next, r.store.latest(), null), at(next, 'lobby'));
  assert.equal(mem.start(null, r.store.latest(), 'quality'), null, 'no scene, no floor');
  const empty = rig().mount(KEY_A);
  assert.deepEqual(mem.start(empty, null, 'quality'), { id: 1, key: 'lobby' }, 'a building with no layout yet has its Lobby');
});

test('a building with many floors opens on the floor with the most live sessions (#111)', async () => {
  const r = rig(HUB());
  await busy(r, 'a', FEAT, 'engineering');
  await busy(r, 'b', FEAT_Y, 'quality');
  await busy(r, 'c', FEAT_Y, 'quality');
  const m = r.mount(KEY_A);
  assert.deepEqual(B.floorMemory().start(m, r.store.latest(), null), at(m, 'quality'));
  assert.deepEqual(B.floorMemory().start(m, r.store.latest(), 'gone'), at(m, 'quality'), 'a floor that is gone does not count');
});

test('a tie between busy floors takes the lowest floor, and an ended session does not count (#111)', async () => {
  const r = rig(HUB());
  await busy(r, 'a', FEAT, 'engineering');
  await busy(r, 'b', FEAT_Y, 'quality');
  const m = r.mount(KEY_A);
  assert.equal(B.floorMemory().start(m, r.store.latest(), null).key, 'engineering', 'one each: the lower floor');
  const snap = JSON.parse(JSON.stringify(r.store.latest()));
  snap.sessions.filter((s) => s.seat.floor === 'engineering').forEach((s) => { s.status = 'ended'; });
  assert.equal(B.floorMemory().start(m, snap, null).key, 'quality', 'the ended session left its floor');
});

test('a floor with live sessions beats an earlier pick; the pick counts when nothing is busy; other buildings do not count (#111)', async () => {
  const r = rig(HUB());
  r.repos.push({ path: REPO_B, worktrees: [wt('main', REPO_B)] });
  await busy(r, 'a', FEAT_Y, 'quality');
  await busy(r, 'b', REPO_B);
  await busy(r, 'c', REPO_B);
  const m = r.mount(KEY_A), mem = B.floorMemory();
  mem.start(m, r.store.latest(), null);
  mem.see(KEY_A, 'security');   // the user moved to Security
  assert.equal(mem.picked(KEY_A), 'security');
  assert.equal(mem.start(m, r.store.latest(), null).key, 'quality', 'a bot works on Quality: not an empty floor');
  const none = rig(HUB());
  none.push();
  const m2 = none.mount(KEY_A);
  assert.equal(mem.start(m2, none.store.latest(), null).key, 'security', 'nothing is busy: the floor the user picked');
  assert.equal(B.floorMemory().start(m2, none.store.latest(), null).key, 'lobby', 'no live session and no pick: the ground floor, not the DS default');
});

test('the page always knows the floor it opened: the DS default is never used (#111)', () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A), f = B.floorMemory().start(m, r.store.latest(), null);
  assert.deepEqual(f, at(m, 'lobby'));
  assert.notEqual(f.id, m.def.floors[2].id, 'the DS opens floors[2] when it is given no floor');
});

test('flow: opened with nothing live, left, sessions start on another floor, opened again: the busy floor (#111)', async () => {
  const r = rig(HUB());
  r.push();
  const mem = B.floorMemory();
  const m1 = r.mount(KEY_A);
  const first = mem.start(m1, r.store.latest(), null);
  assert.equal(first.key, 'lobby');
  mem.see(KEY_A, m1.floorKey(first.id));   // the user leaves for the city without moving
  assert.equal(mem.picked(KEY_A), null, 'an automatic floor is not a pick');
  await busy(r, 'a', FEAT_Y, 'research');
  await busy(r, 'b', FEAT_Y, 'research');
  const m2 = r.mount(KEY_A);
  assert.deepEqual(mem.start(m2, r.store.latest(), null), at(m2, 'research'));
});

test('flow: a rebuild after a move keeps the floor on screen over a busy floor and a pick (#85, #111)', async () => {
  const r = rig(HUB());
  await busy(r, 'a', FEAT_Y, 'research');
  const mem = B.floorMemory(), m1 = r.mount(KEY_A);
  assert.equal(mem.start(m1, r.store.latest(), null).key, 'research');
  mem.see(KEY_A, 'security');   // the user looks at Security, where nobody works
  r.layouts[KEY_A] = editLayout(r.layouts[KEY_A], { action: 'add', floor: 'finance' });   // a floor is added: the page mounts again
  r.push();
  assert.equal(m1.stale(), true);
  const m2 = r.mount(KEY_A);
  assert.deepEqual(mem.start(m2, r.store.latest(), 'security'), at(m2, 'security'), 'the rebuild stays where the user looks');
  assert.equal(mem.picked(KEY_A), 'security');
});

test('floor memory: a floor the page chose is not a pick; a floor the user moved to is, also a move back (#111)', () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A), mem = B.floorMemory();
  assert.equal(mem.picked(KEY_A), null);
  mem.start(m, r.store.latest(), null);      // the page opened the Lobby
  mem.see(KEY_A, 'lobby');                   // seen again: no move
  mem.see(KEY_A, null);                      // the building view
  assert.equal(mem.picked(KEY_A), null, 'not a pick');
  mem.see(KEY_A, 'quality');                 // the user went to another floor
  assert.equal(mem.picked(KEY_A), 'quality');
  mem.see(KEY_A, 'lobby');                   // and back to the floor the page opened: on purpose, so a pick
  assert.equal(mem.picked(KEY_A), 'lobby');
  assert.equal(mem.picked(KEY_B), null, 'each building has its own');
  mem.see(KEY_B, 'quality');                 // a building the page never opened records no move
  assert.equal(mem.picked(KEY_B), null);
});

test('a helper cut from the 20-entry agent list while open still leaves, once (#116)', async () => {
  const r = rig();
  const m = r.mount(KEY_A);
  await r.hook(HOOKS.turnWithEdit[0]);
  for (let i = 1; i <= 22; i++) await r.hook(task('c' + i, 'Explore'));
  const names = of(m.ev, 'delegate').map((e) => e.spawn.name);
  assert.equal(names.length, 22);
  await r.hook({ hook_event_name: 'Stop', session_id: 'sid-1', cwd: REPO_A });   // closeAll cuts c1 and c2
  for (const n of names) assert.equal(helperDone(m.ev, n).length, 1, `${n} left once`);
  assert.equal(helperDone(m.ev, names[0])[0].remove, true);
  assert.equal(helperDone(m.ev, names[0])[0].result, 'Stopped before it finished');
  await r.hook(task('c23', 'Explore'));   // a later snapshot
  for (const n of names) assert.equal(helperDone(m.ev, n).length, 1, `${n} is not told twice`);
  const h = of(m.ev, 'delegate').map((e) => e.spawn.name)[22];
  assert.equal(helperDone(m.ev, h).length, 0, 'a helper still listed and open stays');
});


test('Other folders: a room whose session ended keeps its name and notes key', async () => {
  const r = rig();
  await r.hook({ ...HOOKS.turnWithEdit[0], cwd: 'C:\\scratch\\notes' });
  await r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-2', cwd: 'C:\\scratch\\other' });
  const m = r.mount('');
  const bots = of(m.ev, 'bot.add');
  const roomOfFirst = bots[0].roomId;
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'sid-1', cwd: 'C:\\scratch\\notes' }, null)); r.push();
  const info = m.roomInfo(roomOfFirst);
  assert.equal(info.sessions.length, 0);
  assert.equal(info.place && info.place.roomName, 'notes', 'not the bare word Room');
  assert.ok(m.noteKey(roomOfFirst), 'the notes key is kept');
});

test('a room of open desks has no notes key: it is not usable, and the room that replaces it is', async () => {
  const r = rig({ layouts: { [KEY_A]: newRecord({ archetype: 'software' }) }, repos: [{ path: REPO_A, worktrees: [] }] });
  r.push();
  const m = r.mount(KEY_A);
  assert.equal(m.spare(), true, 'no workspace room yet');
  assert.equal(m.noteKey('spare-engineering'), '');
  assert.equal(m.usable('spare-engineering'), false, 'no board, no notes, no Ctrl+K room tools for it');
  await busy(r, 'a', REPO_A, 'engineering');
  const ru = of(m.ev, 'room.update').find((e) => e.roomId === 'spare-engineering');
  assert.ok(ru, 'the open desks of the floor become the workspace room');
  assert.equal(m.spare(), false);
  assert.ok(m.noteKey(ru.room.id), 'the renamed room has the key of its place');
  assert.equal(m.usable(ru.room.id), true);
  assert.equal(m.usable('spare-engineering'), false, 'the old id is gone');
});

// ---------- function floors (#92): floors per archetype, rooms by task, tags, roll-up ----------
const floorKeys = (m) => m.def.floors.map((f) => f.fn);

test('floors come from the archetype: the Lobby first, the function floors, Records on top; wings and names go to the DS', () => {
  for (const [arch, keys] of [['software', ['lobby', 'engineering', 'quality', 'security', 'it-ops', 'design', 'support', 'docs', 'records']],
    ['knowledge', ['lobby', 'capture', 'organize', 'publish', 'archive', 'records']],
    ['ops-hub', ['lobby', 'executive', 'planning', 'research', 'engineering', 'quality', 'security', 'it-ops', 'communications', 'records']],
    ['general', ['lobby', 'work', 'review', 'records']]]) {
    const r = rig({ layouts: { [KEY_A]: newRecord({ archetype: arch }) }, repos: [{ path: REPO_A, worktrees: [wt('main', REPO_A)] }] });
    r.push();
    const m = r.mount(KEY_A);
    assert.deepEqual(floorKeys(m), keys, arch);
    assert.deepEqual(m.def.floors.map((f) => f.id), keys.map((k, i) => i + 1));
  }
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A), eng = m.def.floors.find((f) => f.fn === 'engineering');
  assert.deepEqual([eng.name, eng.wing, eng.wingName, eng.key], ['Engineering', 'product', 'Product and tech', 'research']);
  assert.equal(m.def.floors.find((f) => f.fn === 'executive').wingName, 'Leadership');
  // an empty function floor has one room of open desks that says what to do; the Lobby has its Reception
  assert.deepEqual(eng.rooms.map((x) => [x.id, x.type, x.name, x.spare]), [['spare-engineering', 'lab', 'Open desks', 2]]);
  assert.equal(eng.rooms[0].note, 'No agents here. Click a desk to start one.');
  assert.deepEqual(m.def.floors[0].rooms.map((x) => x.type), ['security', 'lobby']);
  assert.equal(m.roomFloor('spare-engineering'), 'engineering');
  assert.equal(m.roomFloor('reception'), 'lobby');
  assert.deepEqual(m.floors().map((f) => f.key).slice(0, 2), ['lobby', 'executive']);
});

test('floors are added once at mount and then only renamed; a switch, an added, hidden or moved floor mounts again', () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A);
  r.layouts[KEY_A] = editLayout(r.layouts[KEY_A], { action: 'rename', floor: 'quality', name: 'Review desk' });
  r.push();
  assert.deepEqual(of(m.ev, 'floor.update').map((e) => [e.floorId, e.floor.name]), [[m.floorId('quality'), 'Review desk']]);
  assert.equal(of(m.ev, 'floor.add').length, 0);
  assert.equal(m.stale(), false, 'a rename is done in place');
  for (const op of [{ action: 'switch', archetype: 'software' }, { action: 'add', floor: 'finance' }, { action: 'hide', floor: 'security' }, { action: 'move', floor: 'quality', by: -1 }]) {
    const r2 = rig(HUB());
    r2.push();
    const m2 = r2.mount(KEY_A);
    r2.layouts[KEY_A] = editLayout(r2.layouts[KEY_A], op);
    r2.push();
    assert.equal(m2.stale(), true, op.action);
    assert.equal(of(m2.ev, 'floor.add').length, 0, op.action + ': the DS has no floor removal, so the page mounts again');
  }
});

test('role seating in the scene: an agent sits on the floor of its role; with no role in the Lobby; a new role seats it again', async () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A);
  const s = await busy(r, 'a', FEAT, 'quality');
  const adds = of(m.ev, 'bot.add');
  const last = adds.at(-1);
  assert.equal(m.roomFloor(last.roomId), 'quality');
  assert.equal(last.bot.role, 'analyst', 'the desk is the floor role');
  // the floor's room of open desks became the agent's room
  const ru = of(m.ev, 'room.update').find((e) => e.roomId === 'spare-quality');
  assert.ok(ru, 'the room of open desks takes the first agent');
  assert.equal(ru.room.id, last.roomId);
  await busy(r, 'b', FEAT_Y);
  assert.equal(m.roomFloor(of(m.ev, 'bot.add').at(-1).roomId), 'lobby', 'no role: the open desks of the Lobby');
  // the Manager gives the first agent a role on another floor: removed, then seated on that floor
  s.assignedRole = 'security'; r.push();
  assert.equal(of(m.ev, 'bot.remove').length, 1);
  assert.equal(m.roomFloor(of(m.ev, 'bot.add').at(-1).roomId), 'security');
  // its old room stays on Quality: a room never changes floor
  assert.ok(m.def.floors && m.floorId('quality'));
  assert.equal(m.roomFloor(ru.room.id), 'quality');
});

test('one workspace with agents on two floors is a room on each, with one notes key', async () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A);
  await busy(r, 'a', REPO_A, 'engineering');
  await busy(r, 'b', REPO_A, 'quality');
  const ids = of(m.ev, 'bot.add').map((e) => e.roomId);
  assert.equal(new Set(ids).size, 2);
  const main = placeOfSession(GITS[REPO_A], REPO_A);
  assert.ok(ids.includes(main.roomId), 'the first room keeps the place room id');
  const other = ids.find((x) => x !== main.roomId);
  assert.equal(B.baseRoomId(other), main.roomId);
  assert.equal(m.noteKey(other), main.noteKey, 'both rooms share the workspace notes');
  assert.equal(m.roomInfo(other).sessions.length, 1, 'each room shows the agents of its floor');
  assert.equal(m.dsRoom(main.roomId), main.roomId);
});

test('room names come from the task, and the tags say shared or private', async () => {
  GITS[WT('n')] = { repo: REPO_A, root: WT('n'), branch: 'feat/57-first-call-path', base: 'main' };
  const r = rig({ ...HUB(), repos: [{ path: REPO_A, worktrees: [wt('main', REPO_A), { branch: 'feat/57-first-call-path', root: WT('n'), base: 'main' }] }] });
  r.push();
  const m = r.mount(KEY_A);
  await busy(r, 'a', WT('n'), 'engineering');
  const ru = of(m.ev, 'room.update').find((e) => e.roomId === 'spare-engineering');
  assert.equal(ru.room.name, '#57 First call path', 'a linked issue names the room');
  assert.equal(ru.room.note, 'feat/57-first-call-path · Private', 'an agent room with one agent is private; the branch is small print');
  await busy(r, 'b', REPO_A, 'quality');
  const main = of(m.ev, 'room.update').find((e) => e.roomId === 'spare-quality');
  assert.equal(main.room.name, 'main', 'no task yet: the branch');
  assert.equal(main.room.note, 'main · Shared workspace', 'the main checkout is shared');
  await r.hook({ ...HOOKS.turnWithEdit[1], session_id: 'b', cwd: REPO_A });
  assert.deepEqual(of(m.ev, 'room.update').filter((e) => e.roomId === main.room.id), [], 'a prompt in the main checkout does not rename it: ad-hoc sessions share it (#92 review)');
  assert.deepEqual(r.store.latest().rooms[placeOfSession(GITS[REPO_A], REPO_A).noteKey].title, { name: 'main', by: 'branch' });
  // a second agent in the agent room makes it shared
  await busy(r, 'c', WT('n'), 'engineering');
  const up = of(m.ev, 'room.update').filter((e) => e.roomId === ru.room.id).at(-1);
  assert.equal(up.room.note, 'feat/57-first-call-path · Shared workspace');
  assert.equal(B.tagOf(r.store.latest(), m.roomInfo(ru.room.id).place), 'shared');
  delete GITS[WT('n')];
});

test('a room leaves a floor once no agent of it sits there: empty in this mount, gone in the next; its name stays (#92 review)', async () => {
  const r = rig(HUB());
  r.push();
  const s = await busy(r, 'a', FEAT, 'research');
  await r.hook({ ...HOOKS.turnWithEdit[1], session_id: 'a', cwd: FEAT });   // its first prompt names the room
  const m = r.mount(KEY_A);
  const room = of(m.ev, 'bot.add')[0].roomId;
  const nk = placeOfSession(GITS[FEAT], FEAT).noteKey;
  assert.deepEqual(r.store.latest().rooms[nk].floors, ['research']);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'a', cwd: FEAT }, null)); r.push();
  assert.equal(s.status, 'ended');
  assert.equal(m.stale(), false, 'the DS has no room removal: the room stays on screen, empty, until the next mount');
  assert.deepEqual(r.store.latest().rooms[nk].floors, [], 'no agent of the room sits on Research: the floor goes from its record');
  const next = r.mount(KEY_A);
  assert.deepEqual(next.def.floors.find((f) => f.fn === 'research').rooms.map((x) => x.id), ['spare-research'], 'the next mount has the open desks');
  // the next agent in the worktree, on another floor: the room is there only, and keeps the name of its task
  await busy(r, 'b', FEAT, 'quality');
  assert.deepEqual(r.store.latest().rooms[nk].floors, ['quality']);
  const again = r.mount(KEY_A);
  assert.deepEqual(labs(again.def.floors.find((f) => f.fn === 'quality')).map((x) => x.name), ['Add a line to hello.txt']);
  assert.deepEqual(again.def.floors.find((f) => f.fn === 'research').rooms.map((x) => x.id), ['spare-research']);
  assert.ok(room);
  r.tracker.onHook(slimPayload({ hook_event_name: 'SessionEnd', session_id: 'b', cwd: FEAT }, null));
  r.repos[0].worktrees = r.repos[0].worktrees.filter((w) => w.root !== FEAT);
  r.push();
  assert.equal(again.stale(), true, 'the worktree went: the room goes with a new mount');
  assert.equal(r.store.latest().rooms[nk], undefined, 'and its record');
});

test('roll-up: the worst state of the desks shows on the room door, the elevator button and the city windows', async () => {
  const r = rig(HUB());
  r.push();
  const m = r.mount(KEY_A);
  const a = await busy(r, 'a', FEAT, 'quality');
  await r.hook({ ...HOOKS.turnWithEdit[1], session_id: 'a', cwd: FEAT });   // a prompt: working
  await busy(r, 'b', FEAT_Y, 'quality');
  const ra = m.rollup(), qa = m.floorId('quality');
  assert.equal(ra.floors[qa], 'working');
  assert.equal(ra.building, 'working');
  r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, session_id: 'b', cwd: FEAT_Y }, null)); r.push();
  const rb = m.rollup(), roomB = m.botName && of(m.ev, 'bot.add').at(-1).roomId;
  assert.equal(rb.floors[qa], 'waiting', 'needs you is worse than working');
  assert.equal(rb.rooms[roomB], 'waiting');
  assert.equal(rb.floors[m.floorId('engineering')], undefined, 'a floor with no desk has no state');
  assert.equal(r.store.buildings().find((b) => b.key === KEY_A).state, 'waiting', 'the city windows');
  a.error = { id: 1, text: 'boom', at: r.t }; a.status = 'idle'; r.push();
  assert.equal(m.rollup().floors[qa], 'error', 'an error is the worst');
  assert.equal(r.store.buildings().find((b) => b.key === KEY_A).state, 'error');
  // one order: the DS's (the elevator buttons), no copy in the page vocabulary (#92 review)
  assert.equal(V.WORST, undefined);
  assert.equal(V.worst, undefined);
  assert.equal(globalThis.AgentOffice.worstOf(['finished', 'review', 'working']), 'review');
});
