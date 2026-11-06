// Session tracker tests: recorded hook payloads and stream lines in, sessions snapshot out.
// No server, no git, no timers, no paid calls. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTracker, MAX_CALLS } from '../src/tracker.mjs';
import { slimPayload } from '../src/payload.mjs';

const load = (f) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));
const HOOKS = load('hooks.json'), STREAM = load('stream.json');
const REPO = 'C:\\work\\repo';
const GIT = { repo: REPO, root: REPO, branch: 'main' };

// A tracker with in-memory adapters. Time moves only when the test says so.
function rig(over = {}) {
  const r = { t: 1_000_000, changes: 0, released: [], history: [], dirs: [], commands: [], placed: [], timers: [], located: [], ids: {} };
  r.tracker = createTracker({
    now: () => r.t,
    makeId: (kind) => `${kind[0]}${(r.ids[kind] = (r.ids[kind] || 0) + 1)}`,
    // over.locate lets a test hold the git place back.
    locate: async (cwd) => { r.located.push(cwd); return over.locate ? over.locate(cwd) : over.git === undefined ? GIT : over.git; },
    onChange: () => { r.changes++; },
    releaseHold: (id, decision) => r.released.push({ id, decision }),
    setTimer: (fn, ms) => { r.timers.push({ fn, ms }); return r.timers.length; },
    // over.screen: the check before a hold (the server passes the Security room rules)
    ...(over.screen ? { screen: over.screen } : {}),
    record: (what, a, b) => {
      if (what === 'history') r.history.push({ uid: a.uid, status: a.status });
      else if (what === 'recentDir') r.dirs.push(a);
      else if (what === 'commands') r.commands.push(a);
      else if (what === 'placed') r.placed.push({ uid: a.uid, git: b });
      else if (what === 'spent') (r.spent = r.spent || []).push({ uid: a.uid, kind: a.provider, dollars: b });
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

test('a failed git lookup keeps the last known place when the folder is the same', async () => {
  let fail = false;
  const r = rig({ locate: () => (fail ? null : GIT) });
  r.hook(HOOKS.turnWithEdit[0]); await wait();
  const s = r.only();
  assert.deepEqual(s.git, GIT);
  const before = r.changes, placedBefore = r.placed.length;
  fail = true;
  r.t += 20000; r.tracker.placeSession(s); await wait();
  assert.deepEqual(s.git, GIT, 'null from locate does not drop the place');
  assert.equal(s.placed, true);
  assert.equal(r.changes, before, 'no change is announced');
  assert.equal(r.placed.length, placedBefore, 'the kept place is not saved again');
  fail = false;
  r.t += 20000; r.tracker.placeSession(s); await wait();
  assert.deepEqual(s.git, GIT, 'the next good lookup is fine');
});

test('a null git lookup is believed when the folder changed', async () => {
  let there = GIT;
  const r = rig({ locate: () => there });
  r.hook(HOOKS.turnWithEdit[0]); await wait();
  const s = r.only();
  assert.deepEqual(s.git, GIT);
  there = null;
  s.cwd = 'C:\\elsewhere';
  r.tracker.placeSession(s); await wait();
  assert.equal(s.git, null, 'a new folder outside git is Other folders');
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
  // the held request is freed when the tool finishes (PostToolUse carries the same tool_input as the request)
  r.hook({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'toolu_02', tool_input: { ...HOOKS.permission.tool_input } });
  assert.deepEqual(r.released, [{ id: 'p1', decision: {} }]);
  assert.deepEqual(s.pending, []);
  assert.equal(s.status, 'working', 'the tracker alone ends the wait');
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
  assert.equal(s.status, 'waiting', 'a subagent tool does not end the wait');
  assert.equal(s.tool, null, 'a subagent tool does not become the bot task line');
  r.hook({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Read', tool_use_id: 'toolu_s', agent_id: 'ag-a', tool_input: { file_path: 'a.js' } });
  assert.equal(s.pending.length, 1, 'a subagent PostToolUse leaves the main request');
  assert.equal(s.status, 'waiting');
});

test('a finished call settles only the request of its own agent, tool and input', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const input = HOOKS.permission.tool_input;
  const sub = r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, agent_id: 'ag-a' }));
  const main = r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  const done = (ev, extra = {}) => r.hook({ hook_event_name: ev, session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'tx', tool_input: { ...input }, ...extra });
  done('PostToolUse', { tool_input: { command: 'ls' } });
  assert.deepEqual(s.pending.map((x) => x.id), [sub.id, main.id], 'another input settles nothing');
  done('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
  assert.equal(s.pending.length, 2, 'another tool settles nothing');
  done('PostToolUse', { agent_id: 'ag-b' });
  assert.equal(s.pending.length, 2, 'another subagent settles nothing');
  done('PostToolUse');
  assert.deepEqual(s.pending.map((x) => x.id), [sub.id], 'the main call settles the main request only');
  assert.deepEqual(r.released, [{ id: main.id, decision: {} }]);
  assert.equal(s.status, 'waiting', 'the subagent request still waits');
  done('PostToolUse', { agent_id: 'ag-a' });
  assert.deepEqual(s.pending, []);
  assert.equal(s.status, 'working');
});

test('two requests with the same short label: the result settles the one for its own input', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const edit = (ev, file) => ({ hook_event_name: ev, session_id: 'sid-1', cwd: REPO, tool_name: 'Edit', tool_use_id: 'te-' + file, tool_input: { file_path: `C:/x/${file}/index.js`, old_string: 'a', new_string: 'b' } });
  const one = r.tracker.permissionRequest(slimPayload(edit('PermissionRequest', 'one')));
  const two = r.tracker.permissionRequest(slimPayload(edit('PermissionRequest', 'two')));
  assert.equal(s.pending[0].detail, s.pending[1].detail, 'both labels read index.js');
  r.hook(edit('PostToolUse', 'one'));
  assert.deepEqual(r.released, [{ id: one.id, decision: {} }]);
  assert.deepEqual(s.pending.map((x) => x.id), [two.id]);
  assert.equal(s.status, 'waiting');
});

test('two requests for the very same call: one result settles one of them, the oldest', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const a = r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  const b = r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  r.hook({ hook_event_name: 'PostToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'tx', tool_input: { ...HOOKS.permission.tool_input } });
  assert.deepEqual(r.released.map((x) => x.id), [a.id]);
  assert.deepEqual(r.only().pending.map((x) => x.id), [b.id]);
});

test('a failed call settles its own request and leaves the others', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const push = r.tracker.permissionRequest(slimPayload(HOOKS.permission));
  const other = r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, tool_input: { command: 'rm -rf build' } }));
  r.hook({ hook_event_name: 'PostToolUseFailure', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'tf', error: 'exit code 1', tool_input: { ...HOOKS.permission.tool_input } });
  assert.deepEqual(r.released, [{ id: push.id, decision: {} }], 'the failure settles its own request');
  assert.deepEqual(s.pending.map((x) => x.id), [other.id], 'the other request stays');
  assert.equal(s.status, 'waiting');
});

test('an open question keeps the session waiting through a main-agent tool call', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  r.tracker.askQuestion(s, 'Which branch?');
  r.hook(HOOKS.turnWithEdit[2]);
  assert.equal(s.status, 'waiting', 'PreToolUse does not end the wait while a question is open');
  assert.equal(s.note, 'Which branch?');
  r.hook(HOOKS.turnWithEdit[3]);
  assert.equal(s.status, 'waiting', 'PostToolUse does not end it either');
  assert.equal(s.questions.length, 1);
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
  r.tracker.askQuestion(s, 'Which branch?');
  r.tracker.interrupt(s);
  assert.equal(s.interrupted, true);
  assert.deepEqual(r.released.map((x) => x.id), ['p1', 'q1'], 'the request and the question are freed');
  assert.deepEqual(r.released[1].decision, { text: 'The user stopped this turn.' });
  assert.deepEqual([s.pending, s.questions], [[], []]);
  assert.equal(r.tracker.feed.at(-1).text, 'stopped the turn from the office');
  r.line(s, STREAM.resultAfterInterrupt);
  assert.equal(s.error, null);
  assert.equal(s.replies.length, 0);
  assert.equal(s.status, 'idle');
  assert.deepEqual([s.calls[0].ok, s.calls[0].err], [false, 'Stopped']);
  assert.equal(s.status, 'idle');
});

test('interrupt: after the next user message a failed turn is an error again', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working' });
  r.tracker.interrupt(s);
  r.line(s, STREAM.resultAfterInterrupt);
  assert.equal(s.error, null);
  r.tracker.userMessage(s);
  assert.equal(s.interrupted, false);
  r.line(s, STREAM.resultError);
  assert.equal(s.error.text, 'API Error: 529 overloaded');
});

test('an execution error result with no interrupt is an error', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working' });
  r.line(s, STREAM.resultExecError);
  assert.equal(s.error.text, 'Tool execution failed');
  assert.equal(s.replies.at(-1).text, 'Stopped: Tool execution failed');
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
  // at: when the turn failed, so a scene mounted later can send the error with its real time (seeded, building.js)
  assert.deepEqual(s.error, { id: 1, text: 'API Error: 529 overloaded', at: 1_000_000 });
  r.t += 5000;
  r.line(s, STREAM.resultError);
  assert.equal(s.error.id, 2);
  assert.equal(s.error.at, 1_005_000);
  r.hook(HOOKS.turnWithEdit[1], 'o1');
  assert.equal(s.error, null);
});

test('a failed first turn (no hook yet, status starting) shows at rest with its error', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'starting', budget: 0.0001 });
  r.line(s, STREAM.resultBudget);
  assert.equal(s.status, 'idle');
  assert.equal(s.error.text, 'This session reached its spending limit of $0.0001.');
});

test('a new turn from the office is working at once and clears the last error', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working' });
  r.line(s, STREAM.resultError);
  assert.equal(s.status, 'idle');
  assert.ok(s.error);
  const before = r.changes;
  r.tracker.startTurn(s, 'Try again');
  assert.deepEqual([s.status, s.error, s.prompt], ['working', null, 'Try again']);
  assert.equal(r.tracker.feed.at(-1).text, 'sent from the office: Try again');
  assert.equal(r.changes, before + 1);
});

test('Dismiss clears the error once; a session with no error is no change', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', headless: true, status: 'working' });
  r.line(s, STREAM.resultError);
  const before = r.changes;
  r.tracker.dismissError(s);
  assert.equal(s.error, null);
  assert.equal(s.status, 'idle');
  assert.equal(r.changes, before + 1);
  r.tracker.dismissError(s);
  assert.equal(r.changes, before + 1, 'nothing to dismiss, nothing sent');
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

test('bad lines and non-objects are ignored; a parsed message counts like its line', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', headless: true });
  for (const bad of ['not json', '{"type":"unknown"}', 'null', '5', null, 7]) r.tracker.onStream(s, bad);
  assert.equal(s.replies.length, 0);
  // A control response is the provider's own (providers/claude-code.mjs); the tracker does nothing with one.
  r.line(s, STREAM.controlResponse);
  assert.equal(s.replies.length, 0);
  r.tracker.onStream(s, STREAM.assistantA);
  assert.deepEqual(s.replies.map((x) => x.text), ['Hello from Claude.']);
  assert.deepEqual(s.usage, { tokens: 105, cached: 90, input: 100 });
});

test('a session is a Claude Code session unless the office opened it with another provider', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[0]);
  assert.equal(r.only().provider, 'claude-code');
  assert.equal(r.tracker.newSession({ uid: 'l1', provider: 'local' }).provider, 'local');
});

test('a usage line sets the token total of an agent that reports totals (ACP usage_update); it sets no context and no cost', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', headless: true, costUnknown: true });
  r.line(s, { type: 'usage', used: 1200, size: 200000 });
  assert.equal(s.usage.tokens, 1200);
  assert.deepEqual([s.ctxTokens, s.ctxWindow], [null, null], 'a session total is not the tokens in context: the Context bar must not read it');
  r.line(s, { type: 'usage', used: 3400, size: 200000 });
  assert.equal(s.usage.tokens, 3400, 'a total replaces the last total; it does not add to it');
  r.line(s, { type: 'usage', used: 'x', size: -5 });
  r.line(s, { type: 'usage' });
  assert.equal(s.usage.tokens, 3400, 'a line without numbers changes nothing');
  assert.equal(s.cost, null);
  assert.equal(s.costUnknown, true);
});

// An ACP agent can send both: per-turn usage in its prompt answer (#72) and session totals in usage_update (#73).
test('an agent that reports a token total: its per-turn usage after that does not add to the total a second time', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', headless: true, costUnknown: true });
  const turn = (id) => r.line(s, { type: 'assistant', message: { id, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, content: [] } });
  turn('acp-1');
  assert.equal(s.usage.tokens, 150, 'no total yet: the turns add up');
  r.line(s, { type: 'usage', used: 4200, size: 128000 });
  turn('acp-2');
  assert.equal(s.usage.tokens, 4200, 'the total already holds that turn');
  r.line(s, { type: 'usage', used: 4400, size: 128000 });
  assert.equal(s.usage.tokens, 4400);
});

test('the feed keeps the last 200 lines', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', name: 'n' });
  for (let i = 0; i < 250; i++) r.tracker.addFeed(s, 'tool', 'x' + i);
  assert.equal(r.tracker.feed.length, 200);
  assert.equal(r.tracker.feed[0].text, 'x50');
});

// Risk is rated against the session's root (worktree, else the folder it started in), never a later cwd.
const ROOT = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
const ELSEWHERE = process.platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone';
const readAsk = (sid, cwd, file, officeId = null) => slimPayload({ hook_event_name: 'PermissionRequest', session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: file } }, officeId);

test('risk uses the folder a terminal session started in, not the cwd of a later hook', () => {
  const r = rig();
  r.hook({ hook_event_name: 'SessionStart', session_id: 'sid-r', cwd: ROOT, source: 'startup' });
  r.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-r', cwd: ELSEWHERE, prompt: 'x' });
  const s = r.only();
  assert.deepEqual([s.cwd, s.startDir], [ELSEWHERE, ROOT]);
  for (const f of [path.join(ELSEWHERE, 'notes.txt'), path.join(ROOT, 'src', 'a.js'), 'src/b.js']) r.tracker.permissionRequest(readAsk('sid-r', ELSEWHERE, f));
  assert.deepEqual(s.pending.map((p) => p.risk), ['medium', 'low', 'low'], 'a relative path is read against the root');
});

test('risk uses the whole worktree of an office worktree session, and the launch folder of another one', () => {
  const r = rig();
  const wt = ROOT + '-wt';
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', name: 'wt', cwd: path.join(wt, 'pkg'), worktree: { root: wt, branch: 'office/wt', repo: ROOT }, headless: true, status: 'working' });
  for (const f of [path.join(wt, 'other', 'x.js'), path.join(ROOT, 'x.js'), path.join(wt, '.git')]) r.tracker.permissionRequest(readAsk('sid-w', path.join(wt, 'pkg'), f, 'o1'));
  assert.deepEqual(s.pending.map((p) => p.risk), ['low', 'medium', 'medium']);
  const t = r.tracker.newSession({ officeId: 'o2', uid: 'o2', name: 'plain', cwd: ROOT, headless: true, status: 'working' });
  assert.equal(t.startDir, ROOT);
  r.tracker.permissionRequest(readAsk('sid-p', ELSEWHERE, path.join(ELSEWHERE, 'a.txt'), 'o2'));
  assert.equal(t.cwd, ELSEWHERE);
  assert.deepEqual(t.pending.map((p) => p.risk), ['medium']);
});

// A local agent sends paths relative to its session folder. The call's file is read against that folder, never the server's cwd.
test('a relative tool path is resolved against the session cwd, then made relative to the repo root', async () => {
  const r = rig();
  const sub = path.join(REPO, 'sub');
  r.hook({ hook_event_name: 'SessionStart', session_id: 'sid-rel', cwd: sub, source: 'startup' });
  await wait(); // the git place is known from here on
  const s = r.only();
  const pre = (id, tool, input) => r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-rel', cwd: sub, tool_name: tool, tool_use_id: id, tool_input: input });
  pre('t1', 'Write', { file_path: 'hello.txt' });
  pre('t2', 'Read', { path: 'notes.txt' });
  pre('t3', 'Read', { file_path: path.join(sub, 'abs.txt') });
  pre('t4', 'Read', { file_path: path.join('..', '..', 'outside.txt') });
  await wait();
  assert.deepEqual(s.calls.map((c) => c.file), ['sub/hello.txt', 'sub/notes.txt', 'sub/abs.txt', null]);
});

test('fail: a session that ended before it started shows as an error until Dismiss', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'bot', cwd: REPO, headless: true, status: 'starting' });
  r.tracker.endSession(s, 'exited (1)');
  const before = r.changes;
  r.tracker.fail(s, 'Could not reopen. Stays in Past sessions.');
  assert.equal(s.status, 'ended');
  assert.equal(s.error.text, 'Could not reopen. Stays in Past sessions.');
  assert.ok(r.changes > before, 'the page is told');
  r.tracker.dismissError(s);
  assert.equal(s.error, null);
});

test('failReopen: the error says the past session stays, whatever the last reply is (#124 review)', () => {
  const r = rig();
  const mk = (uid, reply) => {
    const s = r.tracker.newSession({ uid, officeId: uid, name: 'bot', cwd: REPO, headless: true, status: 'starting' });
    if (reply) s.replies.push({ text: reply });
    r.tracker.endSession(s, 'exited (1)');
    return s;
  };
  const stays = 'The past session stays in Past sessions.';
  const none = mk('o1', '');
  r.tracker.failReopen(none);
  assert.equal(none.error.text, `Could not reopen. ${stays}`);
  const short = mk('o2', 'Claude Code stopped before it started: bad option');
  r.tracker.failReopen(short);
  assert.equal(short.error.text, `Could not reopen. ${stays} Claude Code stopped before it started: bad option`);
  // A long reply (a stderr with a long path) is cut; the hint is not.
  const long = mk('o3', 'Claude Code stopped before it started: ' + '/some/long/folder/name/ao-mcp-abc123 '.repeat(20));
  r.tracker.failReopen(long);
  assert.ok(long.error.text.startsWith(`Could not reopen. ${stays} `), long.error.text);
  assert.ok(long.error.text.length <= 200, 'the error text keeps its cap');
  assert.ok(long.error.text.endsWith('…'), 'the cut shows');
});

test('a session records itself as soon as it has a sid, from the init line or the first hook, and only then', () => {
  const r = rig();
  const a = r.tracker.newSession({ uid: 'o1', officeId: 'o1', name: 'bot', cwd: REPO, headless: true, status: 'starting' });
  assert.equal(r.history.length, 0, 'no sid, no record');
  r.line(a, { type: 'system', subtype: 'init', model: 'm', session_id: 'sid-a' });
  assert.equal(a.sid, 'sid-a');
  assert.deepEqual(r.history, [{ uid: 'o1', status: 'starting' }], 'the init line gives the sid, and the session records itself');
  r.line(a, { type: 'system', subtype: 'init', model: 'm', session_id: 'sid-a' });
  assert.equal(r.history.length, 1, 'a later init does not record again');
  const b = r.tracker.newSession({ uid: 'o2', officeId: 'o2', name: 'bot2', cwd: REPO, headless: true, status: 'starting' });
  const n = r.history.length;
  r.hook({ ...HOOKS.turnWithEdit[0], session_id: 'sid-b' }, 'o2');
  assert.equal(b.sid, 'sid-b');
  assert.equal(r.history.length, n + 1, 'the first hook gives the sid, and the session records itself');
  assert.equal(r.history.at(-1).uid, 'o2');
});

// Issue #57: the first call can arrive before the git place is known. Its file must not stay relative to the session folder.
test('a call opened before locate resolves gets its file against the repo root once the place is known', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = rig({ locate: () => gate.then(() => GIT) });
  const sub = path.join(REPO, 'sub');
  r.hook({ hook_event_name: 'SessionStart', session_id: 'sid-57', cwd: sub, source: 'startup' });
  r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-57', cwd: sub, tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: 'hello.txt' } });
  const s = r.only();
  assert.equal(s.placed, false, 'the place is not known yet');
  assert.equal(s.calls[0].file, null, 'no path against the session folder while the place is unknown');
  release();
  await wait();
  assert.equal(s.placed, true);
  assert.equal(s.calls[0].file, 'sub/hello.txt');
  assert.ok(!('abs' in JSON.parse(JSON.stringify(s)).calls[0]), 'the snapshot carries no private field');
});

// Review of #57: only calls opened before the first place get their file recomputed. A later folder change keeps the others.
test('a call opened after the place is known keeps its file when the session folder changes later', async () => {
  const OUT = 'C:/a/b';
  const r = rig({ git: null }); // outside git: the root is the session folder
  r.hook({ hook_event_name: 'SessionStart', session_id: 'sid-57b', cwd: OUT, source: 'startup' });
  await wait();
  r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-57b', cwd: OUT, tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: 'x.txt' } });
  const s = r.only();
  assert.equal(s.calls[0].file, 'x.txt');
  r.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-57b', cwd: 'C:/c', prompt: 'go' });
  await wait();
  assert.equal(s.calls[0].file, 'x.txt', 'the folder change does not re-base an earlier call');
});

test('outside git, a call opened before locate resolves gets its file against the session folder', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = rig({ locate: () => gate.then(() => null) });
  const OUT = 'C:/a/b';
  r.hook({ hook_event_name: 'SessionStart', session_id: 'sid-57c', cwd: OUT, source: 'startup' });
  r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-57c', cwd: OUT, tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: 'sub/hello.txt' } });
  r.hook({ hook_event_name: 'PreToolUse', session_id: 'sid-57c', cwd: OUT, tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'ls' } });
  const s = r.only();
  assert.deepEqual(s.calls.map((c) => c.file), [null, null]);
  release();
  await wait();
  assert.deepEqual(s.calls.map((c) => c.file), ['sub/hello.txt', null], 'a call with no path stays null');
});

// ---------- the Security room: the check before a hold (#70) ----------
test('an Allow or Deny rule answers a request at once: no wait, no pending request, one feed line', () => {
  const seen = [];
  const r = rig({ screen: (s, p, opts) => { seen.push({ tool: p.tool_name, opts }); return p.tool_input.command === 'git push origin main' ? { allow: false, line: 'denied by Security: Shell commands', message: 'Denied by the Security room: Shell commands.' } : null; } });
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const got = r.tracker.permissionRequest(slimPayload(HOOKS.permission), { provider: true });
  assert.deepEqual(got.auto, { allow: false, message: 'Denied by the Security room: Shell commands.' });
  assert.equal(got.s, s);
  assert.ok(got.id, 'the answer still has a request id for the provider');
  assert.deepEqual(s.pending, []);
  assert.notEqual(s.status, 'waiting');
  assert.equal(r.tracker.feed.at(-1).text, 'denied by Security: Shell commands');
  assert.deepEqual(seen, [{ tool: 'Bash', opts: { provider: true } }]);
  // Ask (the screen says nothing): held as today
  const held = r.tracker.permissionRequest(slimPayload({ ...HOOKS.permission, tool_input: { command: 'npm test' } }));
  assert.equal(held.auto, undefined);
  assert.equal(s.pending.length, 1);
  assert.equal(s.status, 'waiting');
});

test('a quiet answer (a low call a provider may run) writes no feed line', () => {
  const r = rig({ screen: () => ({ allow: true, line: 'allowed by Security: Read inside the worktree', quiet: true }) });
  r.hook(HOOKS.turnWithEdit[1]);
  const before = r.tracker.feed.length;
  const s = r.only(), seen = s.lastEvent;
  r.t += 1000;
  const [changes, located] = [r.changes, r.located.length];
  const got = r.tracker.permissionRequest(slimPayload(HOOKS.permission), { provider: true });
  assert.deepEqual(got.auto, { allow: true });
  assert.equal(got.quiet, true, 'the server sends no snapshot for it');
  assert.equal(r.tracker.feed.length, before);
  // #70 review: a local agent asks about every Read, LS and Grep. A quiet answer changes nothing the page shows, so it
  // costs no snapshot and no git lookup.
  assert.equal(r.changes, changes, 'no change callback');
  assert.equal(r.located.length, located, 'no git lookup');
  assert.equal(s.lastEvent, seen, 'the session is not touched');
});

test('refuseCall: a call the office refused before it ran ends as failed, with the reason and a feed line', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  const pre = { hook_event_name: 'PreToolUse', session_id: 'sid-1', cwd: REPO, tool_name: 'Bash', tool_use_id: 'toolu_x', tool_input: { command: 'ls' } };
  r.hook(pre);
  r.tracker.refuseCall(s, slimPayload(pre), 'Denied by the Security room: Shell commands.', 'denied by Security: Shell commands');
  const c = s.calls.find((x) => x.id === 'toolu_x');
  assert.deepEqual([c.ok, c.err], [false, 'Denied by the Security room: Shell commands.']);
  assert.equal(r.tracker.feed.at(-1).text, 'denied by Security: Shell commands');
});

test('a turn result adds what the session spent since the last result (the Spend screen ledger)', () => {
  const r = rig();
  r.hook(HOOKS.turnWithEdit[1]);
  const s = r.only();
  r.line(s, { type: 'result', subtype: 'success', total_cost_usd: 0.25 });
  r.line(s, { type: 'result', subtype: 'success', total_cost_usd: 0.4 });
  r.line(s, { type: 'result', subtype: 'success', total_cost_usd: 0.4 });
  assert.deepEqual(r.spent.map((x) => [x.kind, Math.round(x.dollars * 100) / 100]), [['claude-code', 0.25], ['claude-code', 0.15]]);
});

test('rootOf: requests are rated against the worktree, else the folder the session started in', () => {
  const r = rig();
  const s = r.tracker.newSession({ cwd: 'C:\\w\\sub', startDir: 'C:\\w' });
  assert.equal(r.tracker.rootOf(s), 'C:\\w');
  s.worktree = { root: 'C:\\wt' };
  assert.equal(r.tracker.rootOf(s), 'C:\\wt');
});

// The reason an agent gives for a request (dsh asks again with a reason, #72) rides on the payload as ask_reason and shows on the request.
test('a permission request keeps the reason the agent gave, trimmed; a request without one has none', () => {
  const r = rig();
  const s = r.tracker.newSession({ officeId: 'o1', uid: 'o1', name: 'a', cwd: ROOT, headless: true, status: 'working' });
  const ask = (extra) => slimPayload({ hook_event_name: 'PermissionRequest', session_id: 'sid-q', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'npm test' }, ...extra }, 'o1');
  r.tracker.permissionRequest(ask({ ask_reason: 'The last run failed. I need to see the full output. ' + 'x'.repeat(400) }));
  r.tracker.permissionRequest(ask({ tool_input: { command: 'ls' } }));
  assert.equal(s.pending[0].reason.length, 301);
  assert.match(s.pending[0].reason, /^The last run failed\./);
  assert.equal(s.pending[1].reason, null);
  // Only a permission request carries it.
  assert.equal(slimPayload({ hook_event_name: 'PostToolUse', tool_name: 'Bash', ask_reason: 'x' }).ask_reason, undefined);
});

// #27 L3: a cut preview says so.
test('makePreview says how much a Write or MultiEdit preview left out', async () => {
  const { makePreview } = await import('../src/tracker.mjs');
  const big = Array.from({ length: 55 }, (_, i) => 'line ' + i).join('\n');
  assert.match(makePreview('Write', { file_path: 'a.txt', content: big }), /15 more lines/);
  assert.doesNotMatch(makePreview('Write', { file_path: 'a.txt', content: 'one\ntwo' }), /more line/);
  const edits = Array.from({ length: 9 }, (_, i) => ({ old_string: 'a' + i, new_string: 'b' + i }));
  assert.match(makePreview('MultiEdit', { file_path: 'a.txt', edits }), /3 more edits/);
  assert.doesNotMatch(makePreview('MultiEdit', { file_path: 'a.txt', edits: edits.slice(0, 2) }), /more edit/);
});

// #164: one rule for the context of an agent that reports it. A usage line carries `ctx: { used, size }` only when the
// provider knows `used` is the tokens in context. Both numbers or nothing: a half-known context stays unknown.
test('a usage line with ctx sets the Context bar; a ctx without a usable window or count changes nothing', () => {
  const r = rig();
  const s = r.tracker.newSession({ uid: 'c1', headless: true });
  r.line(s, { type: 'usage', ctx: { used: 15259, size: 128000 } });
  assert.deepEqual([s.ctxTokens, s.ctxWindow], [15259, 128000]);
  assert.equal(s.usage.tokens, 0, 'a ctx line alone is no session total');
  r.line(s, { type: 'usage', used: 20000, ctx: { used: 16000, size: 128000 } });
  assert.deepEqual([s.ctxTokens, s.ctxWindow, s.usage.tokens], [16000, 128000, 20000], 'a line can carry both');
  for (const bad of [{ used: 5 }, { size: 100 }, { used: 5, size: 0 }, { used: -1, size: 10 }, { used: 'x', size: 10 }, { used: 1, size: null }]) r.line(s, { type: 'usage', ctx: bad });
  assert.deepEqual([s.ctxTokens, s.ctxWindow], [16000, 128000], 'bad numbers are ignored, never guessed');
  const t = r.tracker.newSession({ uid: 'c2', headless: true });
  r.line(t, { type: 'usage', ctx: { used: 5, size: 0 } });
  assert.deepEqual([t.ctxTokens, t.ctxWindow], [null, null]);
});
