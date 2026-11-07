// The office side of the office adapter (#200, ADR 0010): runs that Paperclip hands to the office. The plugin in
// src/integrations/paperclip-adapter runs inside Paperclip. When Paperclip wakes an employee whose adapter is `agent_office`, the plugin
// posts the run here (agent token, /hook/paperclip/run/*). The office opens an ordinary office session with the employee's agent kind
// through its provider seam, so the Security room, the holds and Needs you apply as for any session. The plugin then asks for the log and
// the result. This module owns the run records and the wire rules; opening, messaging and closing a session are injected.
//
// transcript(uid) gives the log of a run by its office session, for the desk screen (#211).
// The wire (all POST, JSON, agent token):
//   start  { run_id, agent: { id, company_id, name }, agent_kind?, model?, cwd, isolation?, prompt, task_id? } -> { key, resumed }
//   wait   { key, cursor? }  -> { done, cursor, log: [{ stream, text }], result? }   holds up to WAIT_MS for news, then answers with none
//   cancel { key }           -> { ok }
// A run that Paperclip starts twice (same run_id, still live) is one run. A session ends with the first turn: the run ends and the
// session closes (it stays in Past sessions). Nothing here answers a request for the user: a held call waits in Needs you.
import { httpError } from './office-core.mjs';

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

const sameDir = (a, b) => String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
 * deps: open(opts) -> uid (an office session, opened as the Open dialog opens one: refusals and the cost question are thrown),
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

  function finish(r, s, ok, why) {
    if (r.done) return;
    r.done = true;
    r.result = s ? resultOf(s, { ok, why }) : { ok: false, error: clip(why, 500), uid: r.uid, provider: null, model: null, sessionId: null, summary: null, turns: 0, cost: null, costUnknown: true, usage: null };
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
      const s = deps.session(r.uid);
      if (!s) { finish(r, null, false, 'The session left the office before the run ended.'); continue; }
      collect(r, s);
      if (s.status === 'ended') finish(r, s, false, s.error?.text || 'The session was closed in the office before the run ended.');
      else if (s.turnEnded && s.status === 'idle') finish(r, s, !s.error && !s.interrupted, s.error?.text || (s.interrupted ? 'The turn was stopped in the office.' : ''));
    }
  }

  async function start(body) {
    const x = cleanRun(body);
    const live = runs.get(x.runId);
    if (live && !live.done) return { key: live.key, resumed: true };
    if (live) { clearTimer(live.timer); runs.delete(live.key); } // an ended run under the same id: this start is a new run
    if ([...runs.values()].filter((r) => !r.done).length >= MAX_RUNS) throw httpError(429, `The office runs ${MAX_RUNS} Paperclip runs at once. Try again when one ends.`);
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
