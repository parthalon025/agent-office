// Provider seam: one interface for every agent tool the office runs. Claude Code is the first provider
// (providers/claude-code.mjs). Local models (#19, providers/local.mjs with providers/local-tools.mjs) and Agent Framework teams
// (#23, providers/agent-framework.mjs) are next to it; Copilot CLI (#22) is the next one. Each is a factory that gets `events` (providerEvents below) and returns a provider object.
//
// The server calls the provider's methods. The provider reports what its agent does through `events`, in the session
// tracker's input vocabulary (hook-shaped events and stream messages). The rules stay in tracker.mjs: a provider never
// sets a session's status, calls, to-dos or error itself.
//
// Provider (checkProvider tests the shape)
//   kind                               id of the agent kind: 'claude-code'. A session keeps it as `s.provider`.
//   label                              name for the user: 'Claude Code'.
//   readiness() -> Promise<{ ready, version, needs, configured? }>
//                                      installed, signed in, model server up. needs: steps for the user, in plain words.
//                                      configured: false when the user has not set the kind up yet (a cloud kind with no endpoint or
//                                      token): the page says "Not configured" in place of "Not ready". Without it: true.
//   models() -> Promise<[{ id, label }]>   the models the user can pick.
//   open(s, opts)                      start the agent for tracker session s, in s.cwd. opts: { model, permissionMode, budget,
//                                      resume, fork }. fork: the session id of a past session to copy (only with the fork feature). May set s.pid when the
//                                      agent runs in its own process.
//   message(s, { text, attachments })  send one user message. Throws a status error (409) when the agent does not run.
//   answer(s, request, decision)       the user's decision on a request. request: { id, suggestions }. decision: { allow, always }
//                                      or {} (no decision: the request was dropped or timed out). Returns the reply body when the
//                                      request waits on a hook (Claude Code), else nothing.
//   interrupt(s)                       stop the turn that runs.
//   close(s) -> Promise                stop the agent. The office then ends the session.
//   check(opts)            (optional)  throws a status error for options the provider does not take (400) or a program it
//                                      cannot find (409). The office calls it before it makes a worktree or a session;
//                                      check({}) checks only that a session can start (Reopen).
//   paid                   (optional)  false when the agent costs no money (a local model). Without it the provider is paid and gets the
//                                      default spend limit (spendLimitFor). true or false only.
//   canResume              (optional)  true when open(s, { resume }) continues a past conversation (Claude Code). Without it,
//                                      Reopen starts a fresh session in the same folder with the same model (reopenPlan).
//                                      May be a getter: an ACP agent says it at its handshake (loadSession).
//   learn() -> Promise     (optional)  refresh what the provider knows about its agent before the office reads canResume or
//                                      features (ACP: one handshake). The office calls it before Reopen.
//   gated                  (optional)  false when the agent runs tool calls without asking the office first (ADR 0001), also
//                                      when only some of its calls are held. Without it the provider is gated: every tool call
//                                      goes to the office first (the Security room rules, then a hold). true or false only. An
//                                      ungated provider opens only in a room of its own (server.mjs), and its sessions carry its
//                                      supervision label.
//   supervision            (optional)  the label of an ungated provider (gated: false), for example "Partly supervised: file
//                                      edits and risky commands ask". Without it an ungated provider is "Unsupervised"
//                                      (supervisionOf). A gated provider has none.
//   preflight() -> Promise (optional)  why the agent would not start now (text), or null, from a check that needs no
//                                      session (OpenClaw: its Gateway config). The office asks it before the cost question
//                                      and before a worktree, and answers 409 with that text.
//   cost                   (optional)  'unknown' when the agent reports no cost (ACP). Such a provider is paid, the office asks
//                                      once per session before it runs, no spend limit can stop it, and the page shows
//                                      "unknown", never $0.00. Without it the agent reports cost ('reported').
//   features               (optional)  names of what the agent has beyond the seam, for the page (#72): resume, images, skills,
//                                      memory, fork, reason, teams, schedules. May be a getter. status() reads it after readiness.
//   modes                  (optional)  the permission modes open() takes (opts.permissionMode), as names. Without it: none.
//   needsModel             (optional)  true when open() needs opts.model (a local model). Without it the agent has a default.
//   team                   (optional)  true when the session is a team of agents (Agent Framework): its members show as helper
//                                      bots when the work passes to them. Without it: one agent.
//   modelLabel             (optional)  what the dialog calls the pick when it is not a model: 'Foundry agent'. Without it: 'Model'.
//   cloud                  (optional)  true when the agent runs in the owner's cloud account, not on this machine (Foundry, Copilot Studio).
//                                      The agent cannot read the folder; the folder only sets its desk. Such a kind is off until configured.
//   openWindow(s, opts)    (optional)  open the agent in its own terminal window (Claude Code). Without it: in the office only.
//   control(s, request, onDone) (optional) a control request to a running session: change mode or model, connectors
//                                      (Claude Code). Without it the office refuses those requests (409).
//   The Open dialog shows each kind's options from these facts (registry.kinds), so the page keeps no copy of them.
//                                      The page shows a feature only for a kind that declares it. skills: also skillsDir() -> the folder of the skills
//                                      the agent writes, or null. fork: open(s, { fork }). reason: the reason the agent gives for a request (ask_reason).
//   Two timing rules. (1) A method returns before the events that follow from it: report them on a later tick. The office
//   marks the turn after the call (startTurn after message, tracker.interrupt after interrupt), so a stopped turn reported
//   inside interrupt() would read as an error. (2) After close, or after events.end, report nothing more for that session:
//   a hook-shaped event brings an ended session back (a Claude Code terminal session can come back that way).
//
// events (one object per server, given to each provider factory)
//   hook(s, p)          a hook-shaped event. p.hook_event_name: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
//                       PostToolUseFailure, SubagentStart, SubagentStop, Notification, Stop, SessionEnd. Fields as in payload.mjs:
//                       tool_name, tool_use_id, tool_input, agent_id, agent_type, duration_ms, error, is_interrupt, prompt,
//                       message, reason. A PostToolUse of TodoWrite with tool_input.todos is the plan.
//                       Returns the tracker's answer: queued office messages for the agent, or null.
//                       A provider must deliver hook()'s return value (queued office messages: additionalContext, or
//                       decision:block on Stop) to its agent.
//                       Subagents (the contract for every provider that has them). An agent is a top-level session (uid); a subagent
//                       is a guest of its parent. A provider reports a subagent with SubagentStart (agent_id, agent_type) after the
//                       parent's Agent or Task tool call, tags every hook of the subagent with the same agent_id, and ends it with
//                       SubagentStop (agent_id). The office then shows it as a helper bot in the parent's room: it never gets a
//                       room, a desk or a count of its own (the room sign counts top-level sessions only), and its calls and
//                       requests stay on the helper. A provider with no subagents reports no agent_id.
//   permission(s, p, { firm }?) a request the provider holds itself (no hook): tool_name, tool_input, agent_id, permission_suggestions.
//                       Returns the request id. The office checks the Security room rules first (#70): an Allow or Deny rule
//                       answers through provider.answer on a later tick ({ allow, message }: message says why it refused), and
//                       nothing waits. Else the office holds it until the user answers, then calls provider.answer.
//                       A provider that runs tools itself asks about every call, so the rules decide all of them. firm: true when the
//                       user must answer this call (an Allow rule does not answer it; a Deny rule still does).
//   stream(s, m)        a stream message, as an object or a JSON line: system init (model, permissionMode, session_id,
//                       slash_commands, skills), stream_event text deltas (live text), assistant (text blocks and usage),
//                       result (total_cost_usd, the turn ends, errors).
//   reply(s, text)      agent text outside the stream, for example why the agent could not start.
//   feed(s, kind, text) one activity line.
//   drop(s, id, why)    the agent no longer waits for request id (it gave up, or its own time ran out): the office frees the
//                       hold as if no one answered (provider.answer gets {}), and the feed says why.
//   fresh(s, why)       open(s, { resume }) could not continue the past conversation and started a new one (an ACP agent that
//                       no longer says loadSession). Report it before the session id: the office keeps the past record.
//   end(s, why)         the agent stopped: the session ends.
import { slimPayload } from '../payload.mjs';

export const DEFAULT_PROVIDER = 'claude-code';
export const PROVIDER_METHODS = ['readiness', 'models', 'open', 'message', 'answer', 'interrupt', 'close'];
// The default spend limit: a new session of a paid provider, a schedule or a Manager goal stops at this many dollars unless the user
// changes or clears it. A local provider costs nothing and has no limit. Settings can change the default (server.mjs).
export const DEFAULT_SPEND_LIMIT = 2;
export const MAX_SPEND_LIMIT = 1000;
/** True unless the provider says paid: false. A provider that does not say is treated as paid, so it is never left without a limit. */
export const isPaid = (p) => !p || p.paid !== false;
/** True unless the provider says gated: false (ADR 0001). A provider that does not say holds every call that is not low risk. */
export const isGated = (p) => !p || p.gated !== false;
/** The label of an ungated provider (ADR 0001): its own, else 'Unsupervised'. null for a gated one. */
export const supervisionOf = (p) => (isGated(p) ? null : typeof p.supervision === 'string' && p.supervision ? p.supervision : 'Unsupervised');
/** The provider's cost word: 'unknown' when its agent reports no cost, else 'reported'. */
export const costOf = (p) => (p && p.cost === 'unknown' ? 'unknown' : 'reported');
/** A copy of the feature names the provider declares now (#72). A getter is read at this call: an ACP agent says some at its handshake. */
export const featuresOf = (p) => (p && Array.isArray(p.features) ? [...p.features] : []);
const FEATURE_RE = /^[a-z][a-z0-9-]{0,30}$/;
/**
 * The spend limit of a new session in dollars, or null for no limit.
 * requested: what the caller asked for. Missing (undefined, null, '' or not a number) means the default; 0 or less means the user
 * cleared it (no limit); more is that limit, up to MAX_SPEND_LIMIT. fallback: the default (0 or less: no default limit).
 * A provider that is not paid never has a limit. A provider with cost 'unknown' has none either: nothing reports what it spent,
 * so no limit could stop it, and the office does not show one as if it did (the feed says so at the start).
 */
export function spendLimitFor({ paid, cost, requested, fallback = DEFAULT_SPEND_LIMIT }) {
  if (!paid || cost === 'unknown') return null;
  const top = (n) => (n > 0 ? Math.min(n, MAX_SPEND_LIMIT) : null);
  if (requested === undefined || requested === null || requested === '') return top(Number(fallback));
  const n = Number(requested);
  return Number.isFinite(n) ? top(n) : top(Number(fallback));
}

const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;
const STATUS_MS = 15000;
// How long GET /api/providers keeps its answer (#104). A round can take a second (Claude Code runs claude --version) or
// the whole time limit (a silent local server), and the page asks each time a dialog opens.
const STATUS_KEEP_MS = 30000;

/** An error the HTTP layer answers with `status`, like the rule errors of notes.mjs. */
export function providerError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Throws when p is not a provider. Returns p. */
export function checkProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('A provider is an object.');
  const missing = [];
  for (const k of ['kind', 'label']) if (typeof p[k] !== 'string' || !p[k]) missing.push(k);
  for (const m of PROVIDER_METHODS) if (typeof p[m] !== 'function') missing.push(m + '()');
  if (p.check !== undefined && typeof p.check !== 'function') missing.push('check() (optional, but then a function)');
  if (p.paid !== undefined && typeof p.paid !== 'boolean') missing.push('paid (optional, but then true or false)');
  if (p.canResume !== undefined && typeof p.canResume !== 'boolean') missing.push('canResume (optional, but then true or false)');
  if (p.modes !== undefined && !(Array.isArray(p.modes) && p.modes.every((m) => typeof m === 'string' && m))) missing.push('modes (optional, but then a list of mode names)');
  if (p.needsModel !== undefined && typeof p.needsModel !== 'boolean') missing.push('needsModel (optional, but then true or false)');
  if (p.team !== undefined && typeof p.team !== 'boolean') missing.push('team (optional, but then true or false)');
  if (p.cloud !== undefined && typeof p.cloud !== 'boolean') missing.push('cloud (optional, but then true or false)');
  if (p.modelLabel !== undefined && !(typeof p.modelLabel === 'string' && p.modelLabel)) missing.push('modelLabel (optional, but then a word)');
  if (p.openWindow !== undefined && typeof p.openWindow !== 'function') missing.push('openWindow() (optional, but then a function)');
  if (p.control !== undefined && typeof p.control !== 'function') missing.push('control() (optional, but then a function)');
  if (p.learn !== undefined && typeof p.learn !== 'function') missing.push('learn() (optional, but then a function)');
  if (p.gated !== undefined && typeof p.gated !== 'boolean') missing.push('gated (optional, but then true or false)');
  if (p.supervision !== undefined && p.supervision !== null && (typeof p.supervision !== 'string' || p.gated !== false)) missing.push('supervision (optional, but then text, and only with gated: false)');
  if (p.cost !== undefined && p.cost !== 'unknown') missing.push("cost (optional, but then 'unknown')");
  if (p.cost === 'unknown' && p.paid === false) missing.push("cost 'unknown' with paid: false (an agent that reports no cost is paid)");
  const f = p.features;
  if (f !== undefined && !(Array.isArray(f) && f.every((x) => typeof x === 'string' && FEATURE_RE.test(x)))) missing.push('features (optional, but then a list of lower-case names)');
  if (missing.length) throw new Error(`The provider ${p.kind || '(no kind)'} lacks: ${missing.join(', ')}.`);
  if (!KIND_RE.test(p.kind)) throw new Error(`The provider kind ${p.kind} must be lower-case letters, digits and dashes.`);
  return p;
}

/**
 * The events every provider reports with. One tracker, one change callback, one hold for requests a provider raises itself.
 * @param {object} deps
 * @param {object} deps.tracker the session tracker (tracker.mjs createTracker).
 * @param {() => void} [deps.onChange] a state change the tracker does not report itself (the server broadcasts).
 * @param {(request: {s: object, id: string, suggestions: object[]}) => void} [deps.hold] holds a provider's request
 *   until the user answers (the server's holds; the answer goes to provider.answer).
 * @param {(id: string) => void} [deps.release] frees a held request with no decision (the server's releaseHold(id, {})).
 * @param {(s: object) => void} [deps.fresh] a reopen that started a new conversation (the server keeps the past record).
 */
export function providerEvents({ tracker, onChange = () => {}, hold = () => {}, release = () => {}, fresh = () => {} }) {
  // A provider's hook-shaped event carries the session's ids, and it is trimmed like the HTTP hook route trims a hook.
  // So no file content is kept, and a tool result finds its permission request by the same call key (payload.mjs).
  const tag = (s, p) => slimPayload({ session_id: s.sid || s.uid, cwd: s.cwd, ...p }, s.officeId);
  return {
    hook: (s, p) => tracker.onHook(tag(s, p)),
    permission: (s, p, opts = {}) => {
      // { provider: true }: the Security room check knows the provider asks about every call (security.mjs decide, quiet).
      // firm: the provider must hear the user on this call, so an Allow rule does not answer it (a Deny rule still does).
      // A decided request (r.auto) goes to hold too: the server answers it at once on a later tick (holdRequest).
      const r = tracker.permissionRequest(tag(s, { ...p, hook_event_name: 'PermissionRequest' }), { provider: true, firm: opts.firm === true });
      if (!r) return null;
      hold(r);
      return r.id;
    },
    stream: (s, m) => tracker.onStream(s, m),
    reply: (s, text) => tracker.pushReply(s, text),
    feed: (s, kind, text) => { tracker.addFeed(s, kind, text); onChange(); },
    drop: (s, id, why) => { tracker.addFeed(s, 'wait', why); release(id); onChange(); },
    fresh: (s, why) => { tracker.addFeed(s, 'start', why); fresh(s); onChange(); },
    end: (s, why) => { tracker.endSession(s, why); onChange(); },
  };
}

// A promise that gives `fallback(error)` when p fails or takes longer than ms.
function settled(p, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback(new Error('No answer in time.'))), ms); });
  return Promise.race([Promise.resolve().then(p).catch(fallback), late]).finally(() => clearTimeout(timer));
}

/**
 * What the page needs to know of one agent kind to offer it, with no call to the provider:
 * { kind, label, paid (a spend limit applies), terminal (it can open in a terminal window), modes (permission modes it
 * takes), needsModel (the user must pick a model), control (a running session takes control requests: a model or mode
 * change, connectors; the dock offers them only then), gated and supervision (ADR 0001: an ungated kind opens only in a
 * room of its own, with its label), cost ('unknown': the office asks before it runs and shows no dollars),
 * team (a team of agents: members show as helper bots) }, and only when the provider says so: cloud (it runs in the
 * owner's cloud account), modelLabel (the pick is not called Model).
 */
export function describe(p) {
  return { kind: p.kind, label: p.label, paid: isPaid(p), terminal: typeof p.openWindow === 'function', modes: Array.isArray(p.modes) ? [...p.modes] : [],
    needsModel: p.needsModel === true, control: typeof p.control === 'function', gated: isGated(p), supervision: supervisionOf(p), cost: costOf(p),
    team: p.team === true,
    ...(p.cloud === true ? { cloud: true } : {}), ...(p.modelLabel ? { modelLabel: p.modelLabel } : {}) };
}

/**
 * The providers of one office, by kind.
 * opts: now (the clock) and statusTtlMs (how long statusCached keeps an answer). Both are injected so tests need no waiting.
 */
export function createRegistry(list, { now = Date.now, statusTtlMs = STATUS_KEEP_MS } = {}) {
  const by = new Map();
  for (const p of list) {
    checkProvider(p);
    if (by.has(p.kind)) throw new Error(`Two providers have the kind ${p.kind}.`);
    by.set(p.kind, p);
  }
  function get(kind) {
    const p = by.get(kind || DEFAULT_PROVIDER);
    if (!p) throw providerError(400, 'Unknown agent kind.');
    return p;
  }
  // The kept answer of statusCached: { at, answer } once a round has ended, and the round that runs now ({ promise, fresh }).
  let kept = null, running = null;
  const api = {
    get,
    statusTtlMs,
    /** The provider of a session. A session the tracker first saw in a hook is a Claude Code session. */
    of: (s) => get(s.provider),
    list: () => [...by.values()],
    /** Every agent kind as describe() gives it, in the order the office lists them (Claude Code first). The snapshot sends it. */
    kinds: () => [...by.values()].map(describe),
    /**
     * How the office opens a past session (a history record) again. A provider that can resume continues the conversation
     * with its replies, cost and turns; the record leaves the past list, because the reopened session records itself.
     * Any other provider starts a fresh session in the same folder with the same model; the record stays.
     * A record from before providers (no `provider`) is Claude Code's.
     */
    reopenPlan(rec) {
      const provider = get(rec.provider);
      const opts = { cwd: rec.cwd, name: rec.name, prompt: '', worktree: rec.worktree || null, budget: rec.budget || null, model: rec.model || null };
      if (provider.canResume === true) return { provider, opts: { ...opts, resume: rec.sid, prior: rec }, fresh: false, note: null };
      return { provider, opts, fresh: true, note: 'A new session started. This agent kind cannot resume a past session.' };
    },
    /**
     * describe() of every provider with its readiness and models, for the Open dialog and the Agent kinds view (#20).
     * A provider that fails or does not answer in time is not ready, and the reason is its need. Models are asked only
     * of a ready provider. canResume and features (#72) are read after readiness, because an ACP agent says what it can
     * do at its handshake.
     */
    status({ timeoutMs = STATUS_MS } = {}) {
      return Promise.all([...by.values()].map(async (p) => {
        const r = await settled(() => p.readiness(), timeoutMs,
          (e) => ({ ready: false, version: null, needs: [`The office could not check ${p.label}: ${e.message}`] }));
        const models = r.ready ? await settled(() => p.models(), timeoutMs, () => []) : [];
        return { ...describe(p), ready: r.ready === true, configured: r.configured !== false, version: r.version || null, needs: Array.isArray(r.needs) ? r.needs : [], models,
          canResume: p.canResume === true, features: featuresOf(p) };
      }));
    },
    /**
     * status() with a short memory, for GET /api/providers (#104). The answer is the same.
     * - A plain ask inside statusTtlMs gets the kept answer and calls no provider.
     * - A round that runs is shared: asks that arrive meanwhile get its answer, so one set of provider calls serves all.
     * - fresh: true (the page's Check again) runs a new round and replaces the kept answer. It shares a running round only
     *   when a fresh ask started that round. A plain round began before this ask and may hold a reading from before the
     *   user fixed the problem, so it does not count.
     * - A round that rejects keeps nothing: the next ask runs a new round. A round that ends after a newer one began
     *   leaves the newer answer alone.
     */
    statusCached({ fresh = false, timeoutMs } = {}) {
      if (running && (!fresh || running.fresh)) return running.promise;
      if (!fresh && kept && now() - kept.at < statusTtlMs) return Promise.resolve(kept.answer);
      const round = { fresh, promise: null };
      round.promise = api.status(timeoutMs === undefined ? undefined : { timeoutMs }).then((answer) => {
        if (running === round) { running = null; kept = { at: now(), answer }; }
        return answer;
      }, (e) => {
        if (running === round) running = null;
        throw e;
      });
      running = round;
      return round.promise;
    },
  };
  return api;
}
