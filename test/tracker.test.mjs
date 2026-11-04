// Session tracker tests: recorded hook payloads and stream lines in, sessions snapshot out.
// No server, no git, no timers, no paid calls. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTracker, MAX_CALLS } from '../tracker.mjs';
import { slimPayload } from '../payload.mjs';

const load = (f) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const HOOKS = load('hooks.json'), STREAM = load('stream.json');
const REPO = 'C:\\work\\repo';
const GIT = { repo: REPO, root: REPO, branch: 'main' };

// A tracker with in-memory adapters. Time moves only when the test says so.
function rig(over = {}) {
  const r = { t: 1_000_000, changes: 0, released: [], history: [], dirs: [], commands: [], placed: [], controls: [], timers: [], located: [], ids: {} };
  r.tracker = createTracker({
    now: () => r.t,
    makeId: (kind) => `${kind[0]}${(r.ids[kind] = (r.ids[kind] || 0) + 1)}`,
    locate: async (cwd) => { r.located.push(cwd); return over.git === undefined ? GIT : over.git; },
    onChange: () => { r.changes++; },
    releaseHold: (id, decision) => r.released.push({ id, decision }),
    onControlResponse: (resp) => r.controls.push(resp),
    setTimer: (fn, ms) => { r.timers.push({ fn, ms }); return r.timers.length; },
    persist: {
      history: (s) => r.history.push({ uid: s.uid, status: s.status }),
      recentDir: (d) => r.dirs.push(d),
      commands: (c) => r.commands.push(c),
      placed: (s, g) => r.placed.push({ uid: s.uid, git: g }),
    },
  });
  r.hook = (raw, officeId = null) => r.tracker.onHook(slimPayload(raw, officeId));
  r.play = (list) => list.map((p) => r.hook(p));
  r.line = (s, obj) => r.tracker.onStream(s, JSON.stringify(obj));
  r.only = () => [...r.tracker.sessions.values()][0];
  return r;
}
const wait = () => new Promise((res) => setImmediate(res));

test('importing starts nothing, and a tracker with no adapters works', () => {
  const t = createTracker();
  assert.equal(t.sessions.size, 0);
  assert.equal(t.onHook({ hook_event_name: 'SessionStart', session_id: 'x', cwd: 'C:\\a\\b' }), null);
  assert.equal([...t.sessions.values()][0].name, 'b');
});

test('a payload without a session id changes nothing; an unknown SessionEnd is ignored', () => {
  const r = rig();
  assert.equal(r.hook({ hook_event_name: 'Stop' }), null);
  assert.equal(r.hook({ hook_event_name: 'SessionEnd', session_id: 'gone', cwd: REPO }), null);
  assert.equal(r.tracker.sessions.size, 0);
});

test('turn with an edit: idle, working, tool on the bot, closed call, idle again', async () => {
  const r = rig();
  const [start, prompt, pre, post, stop] = HOOKS.turnWithEdit;
  r.hook(start);
  let s = r.only();
  assert.equal(s.name, 'repo');
  assert.equal(s.status, 'idle');
  assert.equal(s.model, 'claude-sonnet-4-5');
  assert.deepEqual(r.dirs, [REPO], 'SessionStart remembers the folder');
  r.t += 1000; r.hook(prompt);
  assert.equal(s.status, 'working');
  assert.equal(s.turns, 1);
  assert.equal(s.prompt, 'Add a line to hello.txt');
  r.hook(pre);
  assert.deepEqual(s.tool, { name: 'Edit', detail: 'hello.txt' });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].ok, null, 'open until PostToolUse');
  await wait();
  if (process.platform === 'win32') assert.equal(s.calls[0].file, 'src/hello.txt');
  r.hook(post);
  assert.equal(s.tool, null);
  assert.deepEqual([s.calls[0].ok, s.calls[0].ms], [true, 41]);
  r.hook(stop);
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.feed, undefined);
  assert.deepEqual(r.tracker.feed.map((f) => f.kind), ['start', 'prompt', 'tool', 'stop']);
  assert.ok(r.changes >= 5, 'every event reports a change');
});

test('the place is looked up on start, then at most every 15 seconds unless forced', async () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[0]);
  await wait();
  const s = r.only();
  assert.deepEqual(s.git, GIT);
  assert.equal(s.placed, true);
  assert.deepEqual(r.placed.map((p) => p.git), [GIT]);
  assert.equal(r.located.length, 1);
  r.t += 5000; r.hook(HOOKS.turnWithEdit[2]); await wait();
  assert.equal(r.located.length, 1, 'PreToolUse inside 15 s does not look again');
  r.t += 20000; r.hook(HOOKS.turnWithEdit[2]); await wait();
  assert.equal(r.located.length, 2, 'older than 15 s looks again');
  r.hook(HOOKS.turnWithEdit[1]); await wait();
  assert.equal(r.located.length, 3, 'a prompt always looks again');
});

test('a session outside git is placed with git null and still counts as placed', async () => {
  const r = rig({ git: null });
  r.hook(HOOKS.turnWithEdit[0]); await wait();
  const s = r.only();
  assert.equal(s.git, null);
  assert.equal(s.placed, true);
  const before = r.changes;
  s.gitAt = 0; r.tracker.placeSession(s); await wait();
  assert.equal(r.changes, before, 'same place again is not a change');
});

test('a permission request waits, then the tool result clears it', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const got = r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  assert.equal(got.s, s);
  assert.equal(got.id, 'p1');
  assert.equal(s.status, 'waiting');
  assert.equal(s.note, 'Bash git push origin main');
  assert.equal(s.pending.length, 1);
  assert.equal(s.pending[0].risk, 'high');
  assert.equal(s.pending[0].always, 'Bash(git push:*)');
  assert.equal(got.suggestions.length, 1, 'only plain allow rules come back');
  assert.match(s.pending[0].preview, /git push origin main/);
  // the held request is freed when the tool finishes
  r.hook({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'toolu_02', tool_input: { command: 'x' } });
  assert.deepEqual(r.released, [{ id: 'p1', decision: {} }]);
  assert.deepEqual(s.pending, []);
});

test('settle returns a waiting session to working only when nothing else waits', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const a = r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  const q = r.tracker.askQuestion(s, 'Which branch?');
  assert.equal(q, 'q1');
  assert.equal(s.status, 'waiting');
  assert.equal(s.questions[0].text, 'Which branch?');
  r.tracker.settle(s.uid, a.id);
  assert.equal(s.status, 'waiting', 'the question still waits');
  r.tracker.settle(s.uid, q);
  assert.equal(s.status, 'working');
});

test('a subagent tool call leaves a waiting request in place', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Read', tool_use_id: 'toolu_s', agent_id: 'ag-a', tool_input: { file_path: 'a.js' } });
  assert.equal(s.pending.length, 1, 'the request is still on the session');
  assert.equal(s.tool, null, 'a subagent tool does not become the bot task line');
});

test('subagent links go to the oldest unlinked call of the same type', () => {
  const r = rig();
  r.hook({ ...HOOKS.turnWithEdit[1] });
  const s = r.only();
  r.play(HOOKS.subagent.slice(0, 4));
  assert.deepEqual(s.agents.map((a) => [a.type, a.id]), [['Explore', 'ag-a'], ['general-purpose', 'ag-b']]);
  assert.equal(s.agents[0].task, 'Find the bug');
  r.play(HOOKS.subagent.slice(4));
  assert.equal(s.agents[0].done, true);
  assert.equal(s.agents[0].ok, true);
  assert.equal(s.agents[1].done, false);
  const sub = s.calls.find((c) => c.id === 'toolu_g1');
  assert.deepEqual([sub.agent, sub.ok], ['ag-a', true], 'the subagent call is marked with its agent');
  // finishing the Task tool call closes its subagent
  r.hook({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Task', tool_use_id: 'toolu_t2', tool_input: {} });
  assert.deepEqual([s.agents[1].done, s.agents[1].ok], [true, true]);
});

test('a start with no matching call links nothing', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  r.hook({ hook_event_name: 'SubagentStart', session_id: 'sid-1', cwd: REPO, agent_id: 'x', agent_type: 'Explore' });
  assert.deepEqual(r.only().agents, []);
});

test('the call list keeps 60 calls, drops the oldest closed ones and never an open one', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const pre = (id) => r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: id, tool_input: { command: id } });
  const post = (id) => r.hook({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: id, tool_input: {} });
  pre('open-first'); // stays open the whole time
  for (let i = 0; i < 80; i++) { pre('c' + i); post('c' + i); }
  assert.equal(s.calls.length, MAX_CALLS);
  assert.equal(s.calls[0].id, 'open-first');
  assert.equal(s.calls[s.calls.length - 1].id, 'c79');
  assert.ok(!s.calls.some((c) => c.id === 'c0'));
  // with only open calls nothing can be dropped
  const r2 = rig();
  r2.hook(HOOKS.turnWithEdit[1]);
  for (let i = 0; i < 70; i++) r2.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'o' + i, tool_input: {} });
  assert.equal(r2.only().calls.length, 70);
  // the same id twice is one call
  pre('dup'); pre('dup');
  assert.equal(s.calls.filter((c) => c.id === 'dup').length, 1);
});

test('failures: a real failure keeps its error, an interrupt reads as Stopped', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  for (const [id, ev] of [['toolu_04', HOOKS.failedTool], ['toolu_03', HOOKS.interruptedTool]]) {
    r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'x' } });
    r.hook(ev);
  }
  const by = Object.fromEntries(s.calls.map((c) => [c.id, c]));
  assert.deepEqual([by.toolu_04.ok, by.toolu_04.err], [false, 'exit code 2']);
  assert.deepEqual([by.toolu_03.ok, by.toolu_03.err], [false, 'Stopped']);
  assert.equal(s.tool, null);
  assert.equal(r.tracker.feed.at(-1).text, 'Bash failed (stopped)');
});

test('Stop closes calls that are still open and frees held requests', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  r.hook(HOOKS.turnWithEdit[2]);
  r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  r.hook(HOOKS.turnWithEdit[4]);
  assert.equal(s.status, 'idle');
  assert.deepEqual([s.calls[0].ok, s.calls[0].err], [false, 'The turn ended first.']);
  assert.equal(r.released.length, 1);
  assert.deepEqual(s.pending, []);
});

test('the plan comes from the main agent TodoWrite, with bad states made pending', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  r.hook(HOOKS.todoWrite);
  assert.deepEqual(r.only().todos, [
    { text: 'Read', status: 'completed' }, { text: 'Edit', status: 'in_progress' }, { text: 'Bogus', status: 'pending' },
  ]);
  r.hook({ ...HOOKS.todoWrite, agent_id: 'ag-a', tool_input: { todos: [{ content: 'Other', status: 'pending' }] } });
  assert.equal(r.only().todos.length, 3, 'a subagent plan does not replace the main plan');
});

test('queued office messages come back at the tool result, the prompt and the stop', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  s.inbox.push({ t: 1, text: 'use tabs' });
  const out = r.hook(HOOKS.turnWithEdit[3]);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /- use tabs/);
  assert.deepEqual(s.inbox, []);
  assert.equal(r.hook(HOOKS.turnWithEdit[3]), null, 'nothing queued, nothing returned');
  s.inbox.push({ t: 2, text: 'one more' });
  const stop = r.hook(HOOKS.turnWithEdit[4]);
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /one more[\s\S]*Answer it/);
  assert.equal(s.status, 'working', 'a blocked stop keeps the bot working');
});

test('a new prompt clears the last error', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  s.error = { id: 1, text: 'x' };
  r.hook(HOOKS.turnWithEdit[1]);
  assert.equal(s.error, null);
  assert.equal(s.turns, 2);
});

test('SessionEnd ends the session, frees holds and saves it; a later event brings it back', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  r.tracker.askQuestion(s, 'Sure?');
  r.t += 5000;
  r.hook({ hook_event_name: 'SessionEnd', session_id: 'sid-1', cwd: REPO, reason: 'logout' });
  assert.equal(s.status, 'ended');
  assert.equal(s.endedAt, r.t);
  assert.equal(r.tracker.feed.at(-1).text, 'left (logout)');
  assert.deepEqual(r.released.map((x) => x.id), ['p1', 'q1']);
  assert.match(r.released[1].decision.text, /ended before the user answered/);
  assert.deepEqual(r.history.at(-1), { uid: s.uid, status: 'ended' });
  r.hook(HOOKS.turnWithEdit[1]);
  assert.equal(s.status, 'working');
  assert.equal(s.endedAt, null);
  r.tracker.endSession(s, 'x'); r.tracker.endSession(s, 'again');
  assert.equal(r.tracker.feed.filter((f) => f.kind === 'end').length, 2, 'ending an ended session adds no feed line');
});

test('hooks find an office session by office id first, then by session id', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', name: 'mine', cwd: REPO, headless: true, status: 'starting' });
  r.hook(HOOKS.turnWithEdit[0], 'o1');
  assert.equal(r.tracker.sessions.size, 1);
  assert.equal(s.sid, 'sid-1');
  assert.equal(s.name, 'mine');
  r.hook(HOOKS.turnWithEdit[1]); // no office id now: found by session id
  assert.equal(r.tracker.sessions.size, 1);
  assert.equal(s.turns, 1);
});

test('interrupt: the flag is set, holds are freed, and the stopped result is not an error', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', name: 'mine', cwd: REPO, headless: true, status: 'working' });
  r.hook(HOOKS.turnWithEdit[1], 'o1');
  r.hook(HOOKS.turnWithEdit[2]);
  r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  r.tracker.interrupt(s);
  assert.equal(s.interrupted, true);
  assert.equal(r.released.length, 1);
  assert.equal(r.tracker.feed.at(-1).text, 'stopped the turn from the office');
  r.line(s, STREAM.resultAfterInterrupt);
  assert.equal(s.error, null);
  assert.equal(s.replies.length, 0);
  assert.equal(s.status, 'idle');
  assert.deepEqual([s.calls[0].ok, s.calls[0].err], [false, 'Stopped']);
});

test('stream init: model, mode, session id, and the last command list is saved', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true });
  r.line(s, STREAM.init);
  assert.deepEqual([s.model, s.mode, s.sid], ['claude-haiku-4-5', 'default', 'sid-9']);
  assert.deepEqual(s.commands, ['compact', 'review'], 'non-text entries are dropped');
  assert.deepEqual(r.commands, [{ commands: ['compact', 'review'], skills: ['tdd'] }]);
  // an init without commands saves nothing
  const s2 = r.tracker.newSession({ uid: 'o2', headless: true });
  r.line(s2, { type: 'system', subtype: 'init', model: 'm' });
  assert.equal(r.commands.length, 1);
});

test('stream replies and usage: one API call counts once, a subagent line does not count', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true });
  r.line(s, STREAM.assistantA);
  r.line(s, STREAM.assistantADup);
  r.line(s, STREAM.assistantSub);
  r.line(s, STREAM.assistantB);
  assert.deepEqual(s.replies.map((x) => x.text), ['Hello from Claude.', 'Second block of the same call.']);
  assert.deepEqual(s.replies.map((x) => x.id), [1, 2]);
  assert.deepEqual(s.usage, { tokens: (100 + 5) + (100 + 7), cached: 90, input: 200 });
  assert.equal(s.ctxTokens, 100);
});

test('live text is throttled to one change per 300 ms and cleared by the reply', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true });
  const before = r.changes;
  r.line(s, STREAM.delta1); r.line(s, STREAM.delta2); r.line(s, STREAM.deltaSub);
  assert.equal(s.live, 'Hello');
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 300);
  assert.equal(r.changes, before, 'nothing is sent until the timer fires');
  r.timers[0].fn();
  assert.equal(r.changes, before + 1);
  r.line(s, STREAM.delta1);
  assert.equal(r.timers.length, 2, 'a new timer after the last one fired');
  r.line(s, STREAM.messageStart);
  assert.equal(s.live, '');
  r.line(s, STREAM.delta1);
  r.line(s, STREAM.assistantA);
  assert.equal(s.live, '');
  assert.equal(s.live.length <= 600, true);
});

test('a result ends the turn: cost, context window, idle, history saved', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working', costBase: 1 });
  r.tracker.newSession({ uid: 'other' });
  r.line(s, STREAM.resultOk);
  assert.equal(s.cost, 1.0123);
  assert.equal(s.ctxWindow, 200000);
  assert.equal(s.status, 'idle');
  assert.equal(s.error, null);
  assert.deepEqual(r.history.at(-1), { uid: 'o1', status: 'idle' });
});

test('a budget stop shows an error with the limit and a Stopped reply', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working', budget: 1 });
  r.line(s, STREAM.resultBudget);
  assert.equal(s.status, 'idle');
  assert.equal(s.error.text, 'This session reached its spending limit of $1.');
  assert.equal(s.replies.at(-1).text, 'Stopped: This session reached its spending limit of $1.');
  assert.equal(s.cost, 1.01);
});

test('a failed result sets an error with a growing id, and the next turn clears it', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working' });
  r.line(s, STREAM.resultError);
  assert.deepEqual(s.error, { id: 1, text: 'API Error: 529 overloaded' });
  r.line(s, STREAM.resultError);
  assert.equal(s.error.id, 2);
  r.hook(HOOKS.turnWithEdit[1], 'o1');
  assert.equal(s.error, null);
});

test('a result frees held requests and closes open calls', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true });
  r.hook(HOOKS.turnWithEdit[1], 'o1');
  r.hook(HOOKS.turnWithEdit[2]);
  r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  assert.equal(s.status, 'waiting');
  r.line(s, STREAM.resultOk);
  assert.equal(s.status, 'idle');
  assert.equal(s.tool, null);
  assert.equal(s.calls[0].ok, false);
  assert.equal(r.released.length, 1);
});

test('control responses go to the server, bad lines are ignored', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', headless: true });
  r.line(s, STREAM.controlResponse);
  assert.equal(r.controls[0].request_id, 'cabc');
  r.tracker.onStream(s, 'not json');
  r.tracker.onStream(s, '{"type":"unknown"}');
  assert.equal(s.replies.length, 0);
});

test('the feed keeps the last 200 lines', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', name: 'n' });
  for (let i = 0; i < 250; i++) r.tracker.addFeed(s, 'tool', 'x' + i);
  assert.equal(r.tracker.feed.length, 200);
  assert.equal(r.tracker.feed[0].text, 'x50');
});
