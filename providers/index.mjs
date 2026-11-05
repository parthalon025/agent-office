// Provider seam: one interface for every agent tool the office runs. Claude Code is the first provider
// (providers/claude-code.mjs). Local models (#19, with providers/local-tools.mjs), Copilot CLI (#22) and Agent Framework (#23)
// are the next ones. Each is a factory that gets `events` (providerEvents below) and returns a provider object.
//
// The server calls the provider's methods. The provider reports what its agent does through `events`, in the session
// tracker's input vocabulary (hook-shaped events and stream messages). The rules stay in tracker.mjs: a provider never
// sets a session's status, calls, to-dos or error itself.
//
// Provider (checkProvider tests the shape)
//   kind                               id of the agent kind: 'claude-code'. A session keeps it as `s.provider`.
//   label                              name for the user: 'Claude Code'.
//   readiness() -> Promise<{ ready, version, needs }>
//                                      installed, signed in, model server up. needs: steps for the user, in plain words.
//   models() -> Promise<[{ id, label }]>   the models the user can pick.
//   open(s, opts)                      start the agent for tracker session s, in s.cwd. opts: { model, permissionMode, budget,
//                                      resume }. May set s.pid when the agent runs in its own process.
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
//   permission(s, p)    a request the provider holds itself (no hook): tool_name, tool_input, agent_id, permission_suggestions.
//                       Returns the request id. The office holds it until the user answers, then calls provider.answer.
//   stream(s, m)        a stream message, as an object or a JSON line: system init (model, permissionMode, session_id,
//                       slash_commands, skills), stream_event text deltas (live text), assistant (text blocks and usage),
//                       result (total_cost_usd, the turn ends, errors).
//   reply(s, text)      agent text outside the stream, for example why the agent could not start.
//   feed(s, kind, text) one activity line.
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
/**
 * The spend limit of a new session in dollars, or null for no limit.
 * requested: what the caller asked for. Missing (undefined, null, '' or not a number) means the default; 0 or less means the user
 * cleared it (no limit); more is that limit, up to MAX_SPEND_LIMIT. fallback: the default (0 or less: no default limit).
 * A provider that is not paid never has a limit.
 */
export function spendLimitFor({ paid, requested, fallback = DEFAULT_SPEND_LIMIT }) {
  if (!paid) return null;
  const top = (n) => (n > 0 ? Math.min(n, MAX_SPEND_LIMIT) : null);
  if (requested === undefined || requested === null || requested === '') return top(Number(fallback));
  const n = Number(requested);
  return Number.isFinite(n) ? top(n) : top(Number(fallback));
}

const KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;
const STATUS_MS = 15000;

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
 */
export function providerEvents({ tracker, onChange = () => {}, hold = () => {} }) {
  // A provider's hook-shaped event carries the session's ids, and it is trimmed like the HTTP hook route trims a hook.
  // So no file content is kept, and a tool result finds its permission request by the same call key (payload.mjs).
  const tag = (s, p) => slimPayload({ session_id: s.sid || s.uid, cwd: s.cwd, ...p }, s.officeId);
  return {
    hook: (s, p) => tracker.onHook(tag(s, p)),
    permission: (s, p) => {
      const r = tracker.permissionRequest(tag(s, { ...p, hook_event_name: 'PermissionRequest' }));
      if (!r) return null;
      hold(r);
      return r.id;
    },
    stream: (s, m) => tracker.onStream(s, m),
    reply: (s, text) => tracker.pushReply(s, text),
    feed: (s, kind, text) => { tracker.addFeed(s, kind, text); onChange(); },
    end: (s, why) => { tracker.endSession(s, why); onChange(); },
  };
}

// A promise that gives `fallback(error)` when p fails or takes longer than ms.
function settled(p, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback(new Error('No answer in time.'))), ms); });
  return Promise.race([Promise.resolve().then(p).catch(fallback), late]).finally(() => clearTimeout(timer));
}

/** The providers of one office, by kind. */
export function createRegistry(list) {
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
  return {
    get,
    /** The provider of a session. A session the tracker first saw in a hook is a Claude Code session. */
    of: (s) => get(s.provider),
    list: () => [...by.values()],
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
     * Readiness and models of every provider, for the settings view (#20). A provider that fails or does not answer in
     * time is not ready, and the reason is its need. Models are asked only of a ready provider.
     */
    status({ timeoutMs = STATUS_MS } = {}) {
      return Promise.all([...by.values()].map(async (p) => {
        const r = await settled(() => p.readiness(), timeoutMs,
          (e) => ({ ready: false, version: null, needs: [`The office could not check ${p.label}: ${e.message}`] }));
        const models = r.ready ? await settled(() => p.models(), timeoutMs, () => []) : [];
        return { kind: p.kind, label: p.label, ready: r.ready === true, version: r.version || null, needs: Array.isArray(r.needs) ? r.needs : [], models };
      }));
    },
  };
}
