// The office side of the office adapter (#200, ADR 0010): the run records of runs that Paperclip hands to the office. A distinct job from
// paperclip.mjs (the watcher) and paperclip-runtime.mjs (the process). The plugin in src/integrations/paperclip-adapter runs inside
// Paperclip. When Paperclip wakes an employee whose adapter is `agent_office`, the plugin posts the run here (agent token,
// /hook/paperclip/run/*). The office opens an ordinary office session with the employee's agent kind (default claude-code) through
// `openSession`, so admission, the provider seam, the Security room, the holds and Needs you apply as for any session. The plugin then
// asks for the log and the result. This module owns the run records and the wire rules; opening, messaging and closing a session are
// injected by office.mjs (open, send, session, close, feed and changed).
//
// transcript(uid) gives the log of a run by its office session (live or kept after the end), for the desk screen (#211). The session
// carries `paperclipRun: true`.
// The wire (all POST, JSON, agent token):
//   start  { run_id, agent: { id, company_id, name }, agent_kind?, model?, cwd, isolation?, prompt, task_id? } -> { key, resumed }
//   wait   { key, cursor? }  -> { done, cursor, log: [{ stream, text }], result? }   holds up to WAIT_MS for news, then answers with none
//   cancel { key }           -> { ok }
//
// Start. `isolation` defaults to `same`, because Paperclip already gives the run its own workspace folder. So an ungated kind (ADR 0001)
// is refused there (the 409 text reaches Paperclip), unless the plugin asks for `worktree`. A refusal, or the cost question, is the
// start's error, because nobody can answer it inside a run. A run that Paperclip starts twice (same run_id, still live) starts nothing
// twice: it is one run. At most MAX_RUNS (16) are live. The start puts the Paperclip ids on the session (`s.paperclip`, the bot label)
// and sends the prompt with `sendMessage` (4000 characters, the office limit).
//
// Log and end. `tick` is called from `broadcast()`. It turns replies, calls and requests that wait into log lines. It ends the run when
// the turn ends (`turnEnded` and idle), when the session ends, or when it leaves the office. `wait` is a held poll (25 s, answers at once
// for news or a result), so a run of hours needs no long request. `cancel` ends the run and closes the session. The session closes with
// its run and stays in Past sessions. Nothing here answers a request for the user: a held call is in Needs you like any session's, and
// the run waits for it; the plugin's polls keep the run alive for hours. Runs live in memory: an office restart loses them, and the
// plugin says so (the 404 of wait and cancel).
//
// Result. `resultOf` carries cost only when the agent reported one (null, never 0, for an agent without cost reports), usage only when
// it splits into input and output, the last reply as summary, and the session uid.
//
// A Manager run (#204, review of the HQ build: one run of work, not two). Before it opens a session, start asks `deps.goals.take`
// (manager-employees.mjs runGoal). For a registered office Manager the run opens no session: it is the goal of its task (made now when the
// Manager sync has not made it yet, through the same take, so the task is one goal). `tick` logs the goal's state and each step that moves,
// and the run ends with the goal (finished, failed, stopped, cancelled, handed off) and its result as the summary (no cost: the steps' sessions
// keep theirs). A goal that waits for approval or for a retry holds the run. Paperclip's cancel cancels the goal. A run with nothing to do as a
// goal (no task, a sub-task, a closed task) ends at once with the reason.
//
// Context (#206). The start body may carry `context`: `wake_reason`, `prior` (the session Paperclip saved: `session_id`, `cwd`,
// `task_id`, `instructions`), `instructions` (`file`, `key`) and `skills`. `cleanContext` checks it. `deskOf` gives the session
// `paperclip.desk`: the wake reason, `resumed` (always false) and `fresh`, the reason: no saved session, another task, another folder,
// changed instructions, else that the office does not resume. The snapshot carries it as `deskCtx` (`SESSION_FIELDS`), and the desk
// screen shows it with the context window of the session. A run with no context shows no block. A session is not resumed on the next
// wake: each run is a fresh session, and `sessionParams` are not returned; the desk says so and why. This module writes nothing to
// Paperclip.
//
// Tested in test/paperclip-runs.test.mjs (broker, injected session) and test/paperclip-adapter-routes.test.mjs (the whole way: stand-in
// host, plugin, HTTP, real office in process, local model, Windows only).
import { httpError } from './office-core.mjs';
import path from 'node:path';
import { fileKey } from './risk.mjs';

export const WAIT_MS = 25_000;          // how long one wait holds for news (a plain HTTP poll, so a run of hours needs no long request)
export const MAX_RUNS = 16;             // live runs at once
export const KEEP_MS = 30 * 60 * 1000;  // a finished run stays this long for a plugin that asks late
const PROMPT_MAX = 4000;                // sendMessage's own limit
const LOG_MAX = 2000;                   // lines of one run's log (a long run drops the oldest, the cursor keeps counting)
const CHUNK = 4000;                     // characters of one log line

const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const PLAIN = /^[A-Za-z0-9_-]{1,80}$/;
const KIND = /^[a-z][a-z0-9-]{0,40}$/;
const clip = (t, n) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };

const word = (v, n) => (typeof v === 'string' && v.trim() ? clip(v.trim(), n) : null);
/**
 * What Paperclip said about the run besides its prompt (#206): the wake reason, the session it saved last (prior), the instructions bundle
 * and the skills. Null when it said none of it. Only what the run carried: nothing is read from a file or guessed.
 */
export function cleanContext(c) {
  const b = c && typeof c === 'object' ? c : {};
  const p = b.prior && typeof b.prior === 'object' ? b.prior : null;
  const i = b.instructions && typeof b.instructions === 'object' ? b.instructions : null;
  const prior = p ? { session: word(p.session_id, 120), cwd: word(p.cwd, 300), task: word(p.task_id, 80), instructions: word(p.instructions, 120) } : null;
  const instructions = i && (word(i.file, 300) || word(i.key, 120)) ? { file: word(i.file, 300), key: word(i.key, 120) } : null;
  const skills = [...new Set((Array.isArray(b.skills) ? b.skills : []).map((x) => word(x, 60)).filter(Boolean))].slice(0, 40);
  const wake = word(b.wake_reason, 80);
  const out = { wake, prior: prior && Object.values(prior).some(Boolean) ? prior : null, instructions, skills };
  return wake || out.prior || instructions || skills.length ? out : null;
}

// One folder whatever its spelling (case, slash style, a trailing slash, an 8.3 short name, a junction): risk.mjs fileKey, the office's path
// identity. Two folders with no key (a path that is not text) are not the same.
// A Windows path (drive letter) is a Windows folder whatever the office runs on: off Windows, fileKey keeps case and backslashes,
// so it is compared by the Windows rule there.
const WIN = /^[A-Za-z]:[\\/]/;
const winKey = (p) => path.win32.normalize(p).replace(/\\+$/, '').toLowerCase();
const sameDir = (a, b) => {
  try {
    if (process.platform !== 'win32' && WIN.test(String(a)) && WIN.test(String(b))) return winKey(a) === winKey(b);
    return fileKey('', a) === fileKey('', b);
  } catch { return false; }
};
/**
 * What the employee desk shows of a run's context (#206), or null with none. The office opens a new session on every wake and cannot
 * resume one (ADR 0010), so `resumed` is false; `fresh` says why it is not a continuation, from the run's own facts: no saved session,
 * another task, another folder, changed instructions, else that the office does not resume. x: { cwd, task }.
 */
export function deskOf(ctx, x) {
  if (!ctx) return null;
  const p = ctx.prior;
  let fresh;
  if (!p || !p.session) fresh = 'Paperclip saved no earlier session for this employee.';
  else if (p.task && p.task !== x.task) fresh = 'It works on another task than the saved session.';
  else if (p.cwd && !sameDir(p.cwd, x.cwd)) fresh = 'It works in another folder than the saved session.';
  else if (p.instructions && ctx.instructions && ctx.instructions.key && p.instructions !== ctx.instructions.key) fresh = 'Its instructions changed since the saved session.';
  else fresh = 'The office does not resume a saved session yet.';
  return { wake: ctx.wake, resumed: false, fresh, instructions: ctx.instructions, skills: ctx.skills };
}

/** The run a request describes, checked: { runId, agent: { id, company, name }, kind, model, cwd, isolation, prompt, task, context }. Throws httpError 400. */
export function cleanRun(body) {
  const b = body && typeof body === 'object' ? body : {};
  const agent = b.agent && typeof b.agent === 'object' ? b.agent : {};
  const bad = (m) => { throw httpError(400, m); };
  if (typeof b.run_id !== 'string' || !ID.test(b.run_id)) bad('run_id must be a plain id.');
  if (typeof agent.id !== 'string' || !PLAIN.test(agent.id)) bad('agent.id must be a plain id.');
  if (typeof agent.company_id !== 'string' || !PLAIN.test(agent.company_id)) bad('agent.company_id must be a plain id.');
  const kind = b.agent_kind == null || b.agent_kind === '' ? 'claude-code' : b.agent_kind;
  if (typeof kind !== 'string' || !KIND.test(kind)) bad('agent_kind must be an agent kind such as claude-code.');
  if (b.model != null && (typeof b.model !== 'string' || b.model.length > 80)) bad('model must be text of 80 characters or fewer.');
  if (typeof b.cwd !== 'string' || !b.cwd.trim()) bad('cwd is the folder the employee works in.');
  const isolation = b.isolation == null || b.isolation === '' ? 'same' : b.isolation;
  if (isolation !== 'same' && isolation !== 'worktree') bad('isolation is same or worktree.');
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) bad('The run needs a prompt.');
  if (b.task_id != null && (typeof b.task_id !== 'string' || !PLAIN.test(b.task_id))) bad('task_id must be a plain id.');
  return {
    runId: b.run_id, agent: { id: agent.id, company: agent.company_id, name: clip(String(agent.name || '').trim(), 40) || 'Employee' },
    kind, model: b.model ? b.model.trim() || null : null, cwd: b.cwd.trim(), isolation, prompt: b.prompt.trim().slice(0, PROMPT_MAX), task: b.task_id || null, context: cleanContext(b.context),
  };
}

/**
 * The result Paperclip gets, from the session as it ended. Cost is a number only when the agent reported one: an agent without cost
 * reports gives null, never 0 (the office shows it as unknown). Usage is given only when the tokens split into input and output.
 */
export function resultOf(s, { ok, why = '' }) {
  const u = s.usage || {};
  const split = !s.usageTotal && Number.isFinite(u.tokens) && Number.isFinite(u.input);
  const cost = !s.costUnknown && typeof s.cost === 'number' && Number.isFinite(s.cost) ? s.cost : null;
  const last = [...(s.replies || [])].reverse().find((r) => r && r.text);
  return {
    ok, error: ok ? null : clip(why || 'The run failed.', 500), uid: s.uid, provider: s.provider || null, model: s.model || null, sessionId: s.sid || null,
    summary: last ? clip(last.text, 2000) : null, turns: s.turns || 0, cost, costUnknown: !!s.costUnknown || cost === null,
    usage: split ? { inputTokens: Math.max(0, u.input - (u.cached || 0)), outputTokens: Math.max(0, u.tokens - u.input), cachedInputTokens: u.cached || 0 } : null,
  };
}

/**
 * createRuns(deps) -> { start, wait, cancel, tick, transcript, live }.
 * deps: goals (optional, the office Managers, manager-employees.mjs): { take({ employee, company, task, run }) -> promise of null (not a
 *   Manager: a session run) | { goal } | { none, ok }, read(goalId) -> goalState or null, cancel(goalId) },
 *   open(opts) -> uid (an office session, opened as the Open dialog opens one: refusals and the cost question are thrown),
 *   send(uid, text), session(uid) -> the tracker's session or undefined, close(uid) -> promise, feed(s, kind, text), changed(),
 *   setTimer(fn, ms), clearTimer(h), now(), recall(company, query) -> promise of a prompt block ('' for none; company memory, #205: it never
 *   throws), remember(company, { text, source, employee, employeeId, task, run }) -> promise (what a finished run learned; a refusal is ignored).
 */
export function createRuns(deps) {
  const setTimer = deps.setTimer || ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; });
  const clearTimer = deps.clearTimer || clearTimeout;
  const now = deps.now || Date.now;
  const runs = new Map(); // key (the run id) -> record

  const push = (r, stream, text) => {
    for (let i = 0; i < text.length || i === 0; i += CHUNK) r.log.push({ stream, text: text.slice(i, i + CHUNK) });
    r.base += Math.max(0, r.log.length - LOG_MAX);
    if (r.log.length > LOG_MAX) r.log.splice(0, r.log.length - LOG_MAX);
    wake(r);
  };
  const wake = (r) => { for (const w of [...r.waiters]) w(); };
  const reply = (r, from) => {
    const start = Math.max(0, from - r.base);
    return { done: r.done, cursor: r.base + r.log.length, log: r.log.slice(start), ...(r.done ? { result: r.result } : {}) };
  };

  // made: a result built by the caller (a Manager run: the goal's result, no session).
  function finish(r, s, ok, why, made = null) {
    if (r.done) return;
    r.done = true;
    r.result = made || (s ? resultOf(s, { ok, why }) : { ok: false, error: clip(why, 500), uid: r.uid, provider: null, model: null, sessionId: null, summary: null, turns: 0, cost: null, costUnknown: true, usage: null });
    r.doneAt = now();
    // Company memory (#205): what a run that ended well said last is kept, with where it came from. The scan refuses what it must (ignored).
    if (ok && r.result.summary && r.agent?.company && deps.remember) {
      Promise.resolve(deps.remember(r.agent.company, { text: clip(r.result.summary, 600), source: 'run', employee: r.agent.name, employeeId: r.agent.id, task: r.task, run: r.key })).catch(() => {});
    }
    push(r, ok ? 'stdout' : 'stderr', ok ? '[agent-office] The run finished.' : `[agent-office] The run failed: ${r.result.error}`);
    // The session ends with its run. Its record stays in Past sessions; a session the user closed first is already gone.
    if (s && s.status !== 'ended') Promise.resolve().then(() => deps.close(r.uid)).catch(() => {});
    r.timer = setTimer(() => { runs.delete(r.key); }, KEEP_MS);
    deps.changed?.();
  }

  /** The session's news since the last look goes to the log: replies, calls, requests that wait for the user. */
  function collect(r, s) {
    for (const x of s.replies || []) if (x.id > r.seen.reply && x.text) { r.seen.reply = x.id; push(r, 'stdout', x.text); }
    for (const c of s.calls || []) {
      if (c.agent) continue; // a helper's call is the helper's
      if (!r.seen.calls.has(c.id)) { r.seen.calls.add(c.id); push(r, 'stdout', `> ${c.name} ${c.detail || ''}`.trimEnd()); }
      if (c.ok === false && !r.seen.failed.has(c.id)) { r.seen.failed.add(c.id); push(r, 'stderr', `x ${c.name} ${c.detail || ''}: ${c.err || 'failed'}`.trimEnd()); }
    }
    for (const p of s.pending || []) {
      if (r.seen.asks.has(p.id)) continue;
      r.seen.asks.add(p.id);
      push(r, 'stdout', `[agent-office] Waiting for your answer in Agent Office (Needs you): ${p.tool} ${p.detail || ''}`.trimEnd());
    }
  }

  /** Called after every state change of the office: reads each live run's session and ends a run whose turn is over. */
  let ticking = false;
  function tick() {
    if (ticking) return; // finish() reports a change, which ticks again: the outer pass goes on
    ticking = true;
    try { pass(); } finally { ticking = false; }
  }
  function pass() {
    for (const r of runs.values()) {
      if (r.done) continue;
      if (r.goal) { goalPass(r); continue; }
      const s = deps.session(r.uid);
      if (!s) { finish(r, null, false, 'The session left the office before the run ended.'); continue; }
      collect(r, s);
      if (s.status === 'ended') finish(r, s, false, s.error?.text || 'The session was closed in the office before the run ended.');
      else if (s.turnEnded && s.status === 'idle') finish(r, s, !s.error && !s.interrupted, s.error?.text || (s.interrupted ? 'The turn was stopped in the office.' : ''));
    }
  }

  // ---------- a Manager run: the goal of its task, no session (manager-employees.mjs runGoal) ----------
  // The result of a run that opened no session: the goal's result as the summary. No cost: the goal's steps are office sessions whose cost the
  // office keeps (the Manager board), and the run reports none rather than a total that could leave an agent out.
  const goalResult = (ok, text) => ({ ok, error: ok ? null : clip(text || 'The goal did not finish.', 500), uid: null, provider: null, model: null, sessionId: null, summary: text ? clip(text, 2000) : null, turns: 0, cost: null, costUnknown: true, usage: null });
  const GOAL_LINE = {
    planning: 'The office makes the plan of the goal.',
    'awaiting-approval': 'The plan waits for your approval in Agent Office (Manager board).',
    running: 'The goal runs. Each step is an office session, and the Security room decides its calls.',
    blocked: 'The goal is blocked. Retry the step or cancel the goal in Agent Office (Manager board).',
  };
  /** The goal's news since the last look goes to the log: its state, and each step that moved. */
  function collectGoal(r, g) {
    if (g.status !== r.seen.goal) {
      r.seen.goal = g.status;
      push(r, g.status === 'blocked' ? 'stderr' : 'stdout', `[agent-office] ${GOAL_LINE[g.status] || `The goal is ${g.status}.`}${g.reason && g.status !== 'running' ? ` ${clip(g.reason, 300)}` : ''}`);
    }
    g.steps.forEach((st, k) => {
      if (r.seen.steps.get(st.id) === st.status) return;
      r.seen.steps.set(st.id, st.status);
      if (st.status === 'pending' && !r.seen.listed) return;   // the plan is listed once, below
      push(r, st.status === 'error' ? 'stderr' : 'stdout', `[agent-office] Step ${k + 1} ${st.status}: ${clip(st.text, 300)}${st.result ? ` (${clip(st.result, 300)})` : ''}`);
    });
    if (!r.seen.listed && g.steps.length) {
      r.seen.listed = true;
      push(r, 'stdout', `[agent-office] The plan has ${g.steps.length} step${g.steps.length === 1 ? '' : 's'}:\n${g.steps.map((st, k) => `${k + 1}. ${clip(st.text, 300)}`).join('\n')}`);
    }
  }
  function goalPass(r) {
    const g = deps.goals.read(r.goal);
    if (!g) { finish(r, null, false, '', goalResult(false, 'The goal of this task left the office before it ended.')); return; }
    collectGoal(r, g);
    if (g.ended) finish(r, null, g.ok, '', goalResult(g.ok, g.summary));
  }
  /** A run of a registered Manager (deps.goals.take answered): no session, the run is the goal of its task. */
  function startGoal(x, taken) {
    const r = { key: x.runId, uid: null, goal: taken.goal || null, log: [], base: 0, done: false, result: null, doneAt: 0, waiters: new Set(), timer: null, agent: x.agent, task: x.task, seen: { goal: '', steps: new Map(), listed: false } };
    runs.set(r.key, r);
    if (!r.goal) {
      push(r, 'stdout', `[agent-office] ${x.agent.name} is an office Manager. ${taken.none}`);
      finish(r, null, taken.ok !== false, '', goalResult(taken.ok !== false, taken.none));
      return { key: r.key, resumed: false };
    }
    push(r, 'stdout', `[agent-office] ${x.agent.name} is an office Manager: the office runs this task as its goal ${r.goal}, and opens no session for the run itself. Each step of the goal is an office session.`);
    goalPass(r);
    deps.changed?.();
    return { key: r.key, resumed: false };
  }

  async function start(body) {
    const x = cleanRun(body);
    const live = runs.get(x.runId);
    if (live && !live.done) return { key: live.key, resumed: true };
    if (live) { clearTimer(live.timer); runs.delete(live.key); } // an ended run under the same id: this start is a new run
    if ([...runs.values()].filter((r) => !r.done).length >= MAX_RUNS) throw httpError(429, `The office runs ${MAX_RUNS} Paperclip runs at once. Try again when one ends.`);
    // A registered office Manager (#204): its run is the goal of its task, never a second run of the same work (review of the HQ build).
    const taken = deps.goals ? await deps.goals.take({ employee: x.agent.id, company: x.agent.company, task: x.task, run: x.runId }) : null;
    if (taken) {
      const again = runs.get(x.runId);   // the take awaited: a start of the same run that came in meanwhile is this run
      if (again && !again.done) return { key: again.key, resumed: true };
      return startGoal(x, taken);
    }
    let uid;
    try {
      uid = await deps.open({ cwd: x.cwd, name: x.agent.name, provider: x.kind, model: x.model, where: 'office', isolation: x.isolation });
    } catch (e) {
      // The cost question and the like (askFirst): nobody can answer it in a run, so it is a refusal that says where to decide.
      if (e.answer) throw httpError(409, `${e.message} Nobody can confirm it inside a Paperclip run: decide it in the Security room, then wake the employee again.`);
      throw e;
    }
    const s = deps.session(uid);
    if (!s) throw httpError(500, 'The office session did not open.');
    // The ids of a Paperclip run label the bot (paperclip.mjs labelOf) and name its Paperclip task, as for a run that comes in by hooks.
    const desk = deskOf(x.context, x);
    s.paperclip = { agent: x.agent.id, company: x.agent.company, run: x.runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80), ...(x.task ? { task: x.task } : {}), ...(desk ? { desk } : {}) };
    const r = { key: x.runId, uid, log: [], base: 0, done: false, result: null, doneAt: 0, waiters: new Set(), timer: null, agent: x.agent, task: x.task, seen: { reply: 0, calls: new Set(), failed: new Set(), asks: new Set() } };
    runs.set(r.key, r);
    s.paperclipRun = true; // the desk screen shows this session's transcript (#211)
    push(r, 'stdout', `[agent-office] ${x.kind} opened for ${x.agent.name} in ${x.cwd}. Its calls follow the Security room.`);
    deps.feed?.(s, 'start', `a Paperclip run for ${x.agent.name} (run ${x.runId}): the office supervises its calls`);
    // Company memory (#205): a few matching memories go in front of the prompt, only while the whole text fits the office message limit.
    let prompt = x.prompt;
    if (deps.recall && x.agent.company) {
      const block = await deps.recall(x.agent.company, x.prompt.slice(0, 500));
      if (block && block.length + 2 + prompt.length <= PROMPT_MAX) prompt = `${block}\n\n${prompt}`;
    }
    try { deps.send(uid, prompt); } catch (e) {
      finish(r, s, false, `The office could not send the prompt: ${e.message}`);
      throw httpError(e.status || 500, e.message);
    }
    deps.changed?.();
    return { key: r.key, resumed: false };
  }

  /** News after `cursor`, or none after WAIT_MS. A run that has ended answers at once, with its result. signal: the client went away. */
  function wait(body, signal) {
    const key = typeof body?.key === 'string' ? body.key : '';
    const r = runs.get(key);
    if (!r) throw httpError(404, 'No such run. The office may have restarted.');
    const from = Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
    if (r.done || r.base + r.log.length > from || signal?.aborted) return reply(r, from);
    return new Promise((resolve) => {
      let timer;
      const end = () => { clearTimer(timer); r.waiters.delete(end); signal?.removeEventListener?.('abort', end); resolve(reply(r, from)); };
      timer = setTimer(end, WAIT_MS);
      r.waiters.add(end);
      signal?.addEventListener?.('abort', end, { once: true });
    });
  }

  async function cancel(body) {
    const r = runs.get(typeof body?.key === 'string' ? body.key : '');
    if (!r) throw httpError(404, 'No such run.');
    if (r.done) return { ok: true, done: true };
    if (r.goal) {
      // The run is the goal: Paperclip's cancel stops it (its working step is interrupted), as a session run's cancel closes the session.
      deps.goals.cancel(r.goal);
      finish(r, null, false, '', goalResult(false, 'Paperclip cancelled the run, so the office cancelled the goal of the task.'));
      return { ok: true, done: true };
    }
    const s = deps.session(r.uid);
    finish(r, s, false, 'Paperclip cancelled the run.');
    return { ok: true, done: true };
  }

  /** The log of the run an office session belongs to ({ key, done, lines }), live or kept after the end, or null when the session is not a run. For the desk screen (#211). */
  function transcript(uid) {
    for (const r of runs.values()) {
      if (r.uid !== uid) continue;
      const s = deps.session(uid);
      if (s && !r.done) collect(r, s);
      return { key: r.key, done: r.done, lines: r.log.map((l) => ({ stream: l.stream, text: l.text })) };
    }
    return null;
  }

  return { start, wait, cancel, tick, transcript, live:() => [...runs.values()].filter((r) => !r.done).map((r) => ({ key: r.key, uid: r.uid })) };
}
