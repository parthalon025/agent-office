// Admission (#172): the one ordered check before any session starts. Open, reopen, fork and schedules all pass it, so a new
// check applies to every way a session starts, and a refusal always comes before a worktree or a cost question.
//
// Interface: createAdmission({ rules, defaultSpend }) -> { admit(req) }.
//   rules()        the Security room rules now (persisted.security).
//   defaultSpend() the office's default spend limit in dollars.
//   req            { mode: 'open' | 'reopen' | 'fork' | 'schedule', provider, ownRoom, ownRoomText, confirmed, requested, opts, forkText }
//     ownRoom      boolean, or a function (sync or async) read only when the provider is ungated and the Security room did not refuse.
//     ownRoomText  the rest of the ungated refusal ("opens only in a room of its own: ...").
//     confirmed    the user's yes: the cost question (open, reopen, schedule) or the fork question (fork).
//     requested    the spend limit the caller asked for (spendLimitFor); not for reopen.
//     opts         open and schedule: handed to the provider's own check (an unknown model or mode).
//     forkText     fork only: the question the user answers.
//     recordProblem fork only: a function giving the reason the past record cannot be forked (409), or null; read after the capability check.
// Result, data and never a throw (a wrong mode is a bug and throws):
//   { kind: 'refusal', status, text }
//   { kind: 'question', ask: 'cost' | 'fork', text }   a normal answer, not an error
//   { kind: 'plan', budget }                           the caller makes the worktree and the session now
// The order (pinned in test/admission.test.mjs):
//   1 provider check  2 Security refusal  3 own room only (ADR 0001)  4 preflight  5 question (cost; fork: the fork
//   capability, the record check, then the fork question)  6 spend limit.
// Provider facts come from traitsOf (providers/index.mjs); the Security rules from security.mjs.
// Callers (openSession, which schedules also use, reopenSession and forkSession in office.mjs) make the worktree and the session
// only after a plan. ruled() there turns the answer into the route's error or question.
// Tested in test/admission.test.mjs with real rules and a fake provider.
import { traitsOf, spendLimitFor } from './providers/index.mjs';
import { openRefusal, costAsk } from './security.mjs';

const refusal = (status, text) => ({ kind: 'refusal', status, text });
const MODES = new Set(['open', 'reopen', 'fork', 'schedule']);

export function createAdmission({ rules, defaultSpend }) {
  const check = (provider, opts) => { try { provider.check?.(opts); return null; } catch (e) { return refusal(e.status || 500, e.message); } };
  async function admit(req) {
    const { mode, provider } = req;
    if (!MODES.has(mode)) throw new Error(`Unknown admission mode: ${mode}`);
    let tr = traitsOf(provider);
    // 1 The provider's own check (an unknown model or mode), before a worktree is made. Reopen and fork have none here:
    //   a reopen keeps its past model, and a fork checks that its program is there when the user has said yes (step 5).
    if (mode === 'open' || mode === 'schedule') { const r = check(provider, req.opts || {}); if (r) return r; }
    // 2 The Security room: an ungated kind that is off, a kind without cost reports set to Deny.
    const why = openRefusal(rules(), provider);
    if (why) return refusal(409, why);
    // 3 An ungated agent (ADR 0001) runs only in a room of its own. A fork always makes one.
    if (mode !== 'fork' && !tr.gated) {
      const room = typeof req.ownRoom === 'function' ? await req.ownRoom() : req.ownRoom;
      if (!room) return refusal(409, `${provider.label} runs some tool calls without asking the office (${tr.supervision}), so it ${req.ownRoomText}`);
    }
    // 4 What the provider needs before it can start (an OpenClaw config), before any question.
    const bad = await tr.preflight();
    if (bad) return refusal(409, `${provider.label} cannot start: ${bad}`);
    // 5 The question. The fork's yes also covers the cost question.
    if (mode === 'fork') {
      if (provider.learn) { await provider.learn(); tr = traitsOf(provider); } // the handshake may add 'fork'
      if (!tr.features.includes('fork')) return refusal(409, `${provider.label} cannot fork a session.`);
      const problem = req.recordProblem?.(); if (problem) return refusal(409, problem);
      if (req.confirmed !== true) return { kind: 'question', ask: 'fork', text: req.forkText };
      const r = check(provider, {}); if (r) return r;
    } else if (req.confirmed !== true && costAsk(rules(), provider)) {
      const label = tr.supervision;
      return { kind: 'question', ask: 'cost', text: `This agent does not report cost. ${label ? label + '. ' : ''}Run it?` };
    }
    // 6 The spend limit of the new session. A past session keeps what it had (reopenPlan).
    const budget = mode === 'reopen' ? null : spendLimitFor({ paid: tr.paid, cost: tr.cost, requested: req.requested, fallback: defaultSpend() });
    return { kind: 'plan', budget };
  }
  return { admit };
}
