// The run broker of the office adapter (src/paperclip-runs.mjs, #200) through its Interface: start, wait, cancel and tick, with the office
// session injected (a stand-in the test moves by hand). No server, no provider, no timer: the wait limit runs on a fake timer.
// Run: node --test test/paperclip-runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuns, cleanRun, resultOf, WAIT_MS, MAX_RUNS } from '../src/paperclip-runs.mjs';
import { askFirst } from '../src/office-core.mjs';

globalThis.OfficeAsk ||= { answer: (kind, text) => ({ status: 200, body: { confirm: kind, error: text } }) };

const BODY = { run_id: 'run-1', agent: { id: 'agent-1', company_id: 'co-1', name: 'Ada' }, agent_kind: 'claude-code', model: 'haiku', cwd: 'C:\\work\\acme', prompt: 'Add a health route.', task_id: 'task-9' };

function rig(over = {}) {
  const sessions = new Map(), calls = { open: [], send: [], close: [], feed: [] }, timers = [];
  let n = 0;
  const deps = {
    open: async (o) => {
      calls.open.push(o);
      if (over.openError) throw over.openError;
      const uid = 'o' + ++n;
      sessions.set(uid, { uid, provider: o.provider, status: 'starting', replies: [], calls: [], pending: [], usage: { tokens: 0, input: 0, cached: 0 }, cost: null, costUnknown: false, turns: 0, turnEnded: false, error: null, model: o.model, sid: null });
      return uid;
    },
    send: (uid, text) => { calls.send.push([uid, text]); if (over.sendError) throw over.sendError; Object.assign(sessions.get(uid), { status: 'working', turnEnded: false }); },
    session: (uid) => sessions.get(uid),
    close: async (uid) => { calls.close.push(uid); const s = sessions.get(uid); if (s) s.status = 'ended'; },
    feed: (s, kind, text) => calls.feed.push([s.uid, kind, text]),
    setTimer: (fn, ms) => { const t = { fn, ms, off: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.off = true; },
    now: () => 1000,
  };
  const runs = createRuns(deps);
  const fire = (ms) => { for (const t of timers.filter((x) => !x.off && x.ms === ms)) { t.off = true; t.fn(); } };
  return { runs, sessions, calls, timers, fire };
}
const end = (s, patch = {}) => Object.assign(s, { status: 'idle', turnEnded: true, turns: 1 }, patch);

test('cleanRun checks every field and fills the defaults', () => {
  const x = cleanRun(BODY);
  assert.deepEqual(x, { runId: 'run-1', agent: { id: 'agent-1', company: 'co-1', name: 'Ada' }, kind: 'claude-code', model: 'haiku', cwd: 'C:\\work\\acme', isolation: 'same', prompt: 'Add a health route.', task: 'task-9', context: null });
  const d = cleanRun({ ...BODY, agent_kind: undefined, model: undefined, task_id: undefined, agent: { ...BODY.agent, name: '' } });
  assert.deepEqual([d.kind, d.model, d.task, d.agent.name], ['claude-code', null, null, 'Employee']);
  for (const [what, body] of [['run id', { ...BODY, run_id: '../x' }], ['agent id', { ...BODY, agent: { ...BODY.agent, id: 'a b' } }], ['company', { ...BODY, agent: { ...BODY.agent, company_id: '' } }],
    ['kind', { ...BODY, agent_kind: 'Claude Code' }], ['model', { ...BODY, model: 5 }], ['cwd', { ...BODY, cwd: ' ' }], ['isolation', { ...BODY, isolation: 'both' }], ['prompt', { ...BODY, prompt: '' }], ['task', { ...BODY, task_id: 'x y' }], ['body', null]]) {
    assert.throws(() => cleanRun(body), (e) => e.status === 400, what);
  }
  assert.equal(cleanRun({ ...BODY, prompt: 'x'.repeat(9000) }).prompt.length, 4000, 'the office message limit');
});

test('start opens an office session with the employee kind and sends the prompt; the bot carries the Paperclip ids', async () => {
  const { runs, sessions, calls } = rig();
  assert.deepEqual(await runs.start(BODY), { key: 'run-1', resumed: false });
  assert.deepEqual(calls.open, [{ cwd: 'C:\\work\\acme', name: 'Ada', provider: 'claude-code', model: 'haiku', where: 'office', isolation: 'same' }]);
  assert.deepEqual(calls.send, [['o1', 'Add a health route.']]);
  assert.deepEqual(sessions.get('o1').paperclip, { agent: 'agent-1', company: 'co-1', run: 'run-1', task: 'task-9' });
  assert.match(calls.feed[0][2], /Paperclip run for Ada.*supervises/);
});

test('a run Paperclip starts twice is one run, and the office keeps at most MAX_RUNS live', async () => {
  const { runs, calls } = rig();
  await runs.start(BODY);
  assert.deepEqual(await runs.start(BODY), { key: 'run-1', resumed: true });
  assert.equal(calls.open.length, 1);
  for (let i = 2; i <= MAX_RUNS; i++) await runs.start({ ...BODY, run_id: 'run-' + i });
  await assert.rejects(runs.start({ ...BODY, run_id: 'run-over' }), (e) => e.status === 429);
});

test('a refusal of the office (ungated agent, unknown kind) reaches Paperclip as the error; the cost question says where to decide', async () => {
  const refused = rig({ openError: Object.assign(new Error('Hermes opens only in a room of its own.'), { status: 409 }) });
  await assert.rejects(refused.runs.start(BODY), (e) => e.status === 409 && /room of its own/.test(e.message));
  assert.deepEqual(refused.runs.live(), []);
  const q = rig({ openError: askFirst('cost', 'This agent does not report cost. Run it?') });
  await assert.rejects(q.runs.start(BODY), (e) => e.status === 409 && /does not report cost.*Nobody can confirm it inside a Paperclip run.*Security room/.test(e.message));
});

test('a prompt the session refuses ends the run and the session', async () => {
  const { runs, calls } = rig({ sendError: Object.assign(new Error('That session has left the office.'), { status: 404 }) });
  await assert.rejects(runs.start(BODY), (e) => e.status === 404);
  assert.deepEqual(runs.live(), []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.close, ['o1']);
});

test('tick turns what the session shows into log lines: replies, calls, a call that waits in Needs you, and a failed call, each once', async () => {
  const { runs, sessions } = rig();
  await runs.start(BODY);
  const s = sessions.get('o1');
  s.replies.push({ id: 1, text: 'Looking at the API.' });
  s.calls.push({ id: 'c1', name: 'Bash', detail: 'npm test', ok: null, agent: undefined });
  s.calls.push({ id: 'c2', name: 'Edit', detail: 'a.js', ok: false, err: 'Declined', agent: undefined });
  s.calls.push({ id: 'c3', name: 'Read', detail: 'helper.js', ok: true, agent: 'helper-1' });
  s.pending.push({ id: 'p1', tool: 'Bash', detail: 'npm test' });
  runs.tick(); runs.tick();
  const w = await runs.wait({ key: 'run-1', cursor: 0 });
  const text = w.log.map((l) => `${l.stream}:${l.text}`);
  assert.equal(w.done, false);
  assert.ok(text.includes('stdout:Looking at the API.'));
  assert.ok(text.includes('stdout:> Bash npm test') && text.includes('stdout:> Edit a.js'));
  assert.ok(text.includes('stderr:x Edit a.js: Declined'));
  assert.ok(text.some((t) => /Waiting for your answer in Agent Office \(Needs you\): Bash npm test/.test(t)));
  assert.ok(!text.some((t) => /helper\.js/.test(t)), 'a helper call is the helper\'s');
  assert.equal(text.filter((t) => t === 'stdout:> Bash npm test').length, 1, 'once, though ticked twice');
});

test('the run does not end while its call waits; it ends with the turn, with result, cost and usage, and the session closes', async () => {
  const { runs, sessions, calls } = rig();
  await runs.start(BODY);
  const s = sessions.get('o1');
  s.status = 'waiting'; s.pending.push({ id: 'p1', tool: 'Bash', detail: 'ls' });
  runs.tick();
  assert.equal((await runs.wait({ key: 'run-1', cursor: 99 }, AbortSignal.abort())).done, false);
  s.pending.length = 0; s.replies.push({ id: 1, text: 'Done. The route is in.' });
  end(s, { cost: 0.0421, model: 'claude-haiku-4-5', sid: 'sid-1', usage: { tokens: 1500, input: 1200, cached: 700 } });
  runs.tick();
  const w = await runs.wait({ key: 'run-1', cursor: 0 });
  assert.equal(w.done, true);
  assert.deepEqual(w.result, { ok: true, error: null, uid: 'o1', provider: 'claude-code', model: 'claude-haiku-4-5', sessionId: 'sid-1', summary: 'Done. The route is in.', turns: 1, cost: 0.0421, costUnknown: false,
    usage: { inputTokens: 500, outputTokens: 300, cachedInputTokens: 700 } });
  assert.equal(w.log.at(-1).text, '[agent-office] The run finished.');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.close, ['o1'], 'the session ends with its run');
  assert.equal((await runs.wait({ key: 'run-1', cursor: w.cursor })).done, true, 'a late wait still gets the result');
});

test('a failed turn, a stopped turn and a session closed in the office end the run as failed, with the reason', async () => {
  for (const [patch, why] of [[{ error: { id: 1, text: 'Claude Code stopped: rate limit.' } }, /rate limit/], [{ interrupted: true }, /stopped in the office/]]) {
    const { runs, sessions } = rig();
    await runs.start(BODY);
    end(sessions.get('o1'), patch);
    runs.tick();
    const w = await runs.wait({ key: 'run-1' });
    assert.deepEqual([w.done, w.result.ok], [true, false]);
    assert.match(w.result.error, why);
  }
  const { runs, sessions } = rig();
  await runs.start(BODY);
  sessions.get('o1').status = 'ended';
  runs.tick();
  assert.match((await runs.wait({ key: 'run-1' })).result.error, /closed in the office/);
  const gone = rig();
  await gone.runs.start(BODY);
  gone.sessions.delete('o1');
  gone.runs.tick();
  assert.match((await gone.runs.wait({ key: 'run-1' })).result.error, /left the office/);
});

test('cost is a number only when the agent reported one: unknown stays null, free is 0; usage that is only a total is not given', () => {
  const base = { uid: 'o1', status: 'idle', replies: [], usage: { tokens: 10, input: 4, cached: 0 } };
  assert.deepEqual([resultOf({ ...base, costUnknown: true, cost: null }, { ok: true }).cost, resultOf({ ...base, costUnknown: true, cost: null }, { ok: true }).costUnknown], [null, true]);
  assert.deepEqual([resultOf({ ...base, cost: 0 }, { ok: true }).cost, resultOf({ ...base, cost: 0 }, { ok: true }).costUnknown], [0, false]);
  assert.equal(resultOf({ ...base, cost: null }, { ok: true }).cost, null, 'no report yet is unknown, not 0');
  assert.equal(resultOf({ ...base, usageTotal: true }, { ok: true }).usage, null);
  assert.equal(resultOf({ ...base, cost: 1, costUnknown: true }, { ok: true }).cost, null, 'a kind that reports no cost never shows a number');
});

test('wait holds until news or WAIT_MS, answers at once for news and results, and a client that goes away frees it', async () => {
  const { runs, sessions, fire, timers } = rig();
  await runs.start(BODY);
  const first = await runs.wait({ key: 'run-1', cursor: 0 });
  const quiet = runs.wait({ key: 'run-1', cursor: first.cursor });
  sessions.get('o1').replies.push({ id: 1, text: 'hello' });
  runs.tick();
  assert.deepEqual((await quiet).log.map((l) => l.text), ['hello'], 'news wakes the wait');
  const silent = runs.wait({ key: 'run-1', cursor: (await runs.wait({ key: 'run-1', cursor: 0 })).cursor });
  assert.ok(timers.some((t) => t.ms === WAIT_MS && !t.off));
  fire(WAIT_MS);
  assert.deepEqual([(await silent).done, (await silent).log], [false, []], 'the limit answers with no news');
  const ctl = new AbortController();
  const gone = runs.wait({ key: 'run-1', cursor: 1e6 }, ctl.signal);
  ctl.abort();
  assert.equal((await gone).done, false);
  assert.throws(() => runs.wait({ key: 'nope' }), (e) => e.status === 404);
});

test('cancel ends the run as failed and closes the session; an unknown run is 404', async () => {
  const { runs, calls } = rig();
  await runs.start(BODY);
  assert.deepEqual(await runs.cancel({ key: 'run-1' }), { ok: true, done: true });
  const w = await runs.wait({ key: 'run-1' });
  assert.deepEqual([w.done, w.result.ok, w.result.error], [true, false, 'Paperclip cancelled the run.']);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.close, ['o1']);
  await assert.rejects(runs.cancel({ key: 'zzz' }), (e) => e.status === 404);
});

test('a finished run is forgotten after KEEP_MS', async () => {
  const { runs, sessions, timers } = rig();
  await runs.start(BODY);
  end(sessions.get('o1'));
  runs.tick();
  const keep = timers.find((t) => t.ms === 30 * 60 * 1000);
  assert.ok(keep);
  keep.fn();
  assert.throws(() => runs.wait({ key: 'run-1' }), (e) => e.status === 404);
});

test('a start under the id of a run that has ended is a new run, not the old result', async () => {
  const { runs, sessions, calls } = rig();
  await runs.start(BODY);
  end(sessions.get('o1'));
  runs.tick();
  assert.deepEqual(await runs.start(BODY), { key: 'run-1', resumed: false });
  assert.equal(calls.open.length, 2);
  assert.equal((await runs.wait({ key: 'run-1', cursor: 99 }, AbortSignal.abort())).done, false);
});

// ---------- the context of a run on the employee desk (#206) ----------
import { cleanContext, deskOf } from '../src/paperclip-runs.mjs';

test('cleanContext keeps only what the run said, clipped, and says nothing for a run with no context', () => {
  assert.equal(cleanContext(undefined), null);
  assert.equal(cleanContext({}), null);
  const c = cleanContext({ wake_reason: 'issue_assigned', prior: { session_id: 'sess-1', cwd: 'C:\\work\\acme', task_id: 'task-8', instructions: 'k1' }, instructions: { file: 'C:\\work\\acme\\AGENTS.md', key: 'k2' }, skills: ['review', 'deploy', 5, '', 'review'] });
  assert.deepEqual(c, { wake: 'issue_assigned', prior: { session: 'sess-1', cwd: 'C:\\work\\acme', task: 'task-8', instructions: 'k1' }, instructions: { file: 'C:\\work\\acme\\AGENTS.md', key: 'k2' }, skills: ['review', 'deploy'] });
  assert.equal(cleanContext({ skills: Array.from({ length: 80 }, (_, i) => `s${i}`) }).skills.length, 40);
  assert.equal(cleanContext({ wake_reason: 'x'.repeat(500) }).wake.length, 80);
  assert.equal(cleanRun({ ...BODY, context: { wake_reason: 'timer' } }).context.wake, 'timer');
  assert.equal(cleanRun(BODY).context, null);
});

test('deskOf: a fresh session says why, from what the run carried; the office never claims a resume', () => {
  const base = { wake: 'issue_assigned', instructions: { file: 'AGENTS.md', key: 'k1' }, skills: ['review'], prior: null };
  const x = { cwd: 'C:\\Work\\Acme', task: 'task-9' };
  const why = (prior) => deskOf({ ...base, prior }, x).fresh;
  assert.equal(deskOf(null, x), null, 'no context: nothing to show');
  assert.equal(deskOf(base, x).resumed, false);
  assert.match(why(null), /no earlier session/i);
  assert.match(why({ session: 's', task: 'task-1', cwd: 'C:\\work\\acme' }), /another task/i);
  assert.match(why({ session: 's', task: 'task-9', cwd: 'D:\\other' }), /another folder/i);
  assert.match(why({ session: 's', task: 'task-9', cwd: 'c:/work/acme/', instructions: 'k0' }), /instructions changed/i);
  assert.match(why({ session: 's', task: 'task-9', cwd: 'c:/work/acme/', instructions: 'k1' }), /does not resume/i, 'same folder (any spelling), task and instructions: still fresh, and it says so');
  const d = deskOf(base, x);
  assert.deepEqual([d.wake, d.skills, d.instructions.file], ['issue_assigned', ['review'], 'AGENTS.md']);
});

test('start keeps the run context on the session for the desk', async () => {
  const r = rig();
  await r.runs.start({ ...BODY, context: { wake_reason: 'issue_assigned', skills: ['review'], prior: { session_id: 's0', task_id: 'task-1' } } });
  const d = r.sessions.get('o1').paperclip.desk;
  assert.equal(d.wake, 'issue_assigned');
  assert.match(d.fresh, /another task/i);
  const r2 = rig();
  await r2.runs.start(BODY);
  assert.equal(r2.sessions.get('o1').paperclip.desk, undefined, 'no context: no desk block, nothing guessed');
});
