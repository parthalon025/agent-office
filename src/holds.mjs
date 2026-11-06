// Hold queue (#174, #168 ticket 6): the requests the office holds for the user. A permission prompt or an office_ask question
// waits here until the user answers, the agent stops waiting, or its own timeout runs out. A hold ends once, with one decision:
// { allow, always } for a permission prompt, { text } for a question, {} for none. `reply` takes that decision to the agent:
// the hook's or office_ask's HTTP answer, or the provider's answer. Nothing here answers for the user: the only decision the
// queue makes is the timeout's, which the caller names in `timeout.decision` (default {}, "no decision"), and the callers
// never name an allow (ADR 0009: no request is answered by a timer or a count).
//
// Interface (createHolds(deps) -> queue):
//   queue.add(id, { uid, reply, kind?, suggestions?, call?, timeout?: { ms, decision?, after? } })
//   queue.has(id), queue.kindOf(id), queue.uidOf(id), queue.callOf(id)   what the hold is, while it waits
//   queue.release(id, decision) -> true when a hold ended; false for an unknown id (answered, dropped or timed out already)
//   queue.forget(id) -> the hold that ended without a reply (its HTTP request closed), or null
//   queue.size
// Deps, injected so a test needs no server: settle(uid, id) (the tracker clears the request), changed() (the broadcast),
// setTimer / clearTimer (default setTimeout / clearTimeout). `timeout.after()` runs only when the timeout ended the hold.
export function createHolds({ settle = () => {}, changed = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  /** @type {Map<string, {uid: string, timer: any, kind?: 'ask', suggestions?: object[], call?: object, reply: (decision: object) => void}>} */
  const holds = new Map();

  function forget(id) {
    const h = holds.get(id);
    if (!h) return null;
    holds.delete(id);
    clearTimer(h.timer);
    settle(h.uid, id);
    changed();
    return h;
  }
  function release(id, decision) {
    const h = forget(id);
    if (!h) return false;
    h.reply(decision || {});
    return true;
  }
  function add(id, { uid, reply, kind, suggestions, call, timeout }) {
    const timer = timeout ? setTimer(() => {
      if (release(id, timeout.decision || {})) timeout.after?.();
    }, timeout.ms) : null;
    holds.set(id, { uid, timer, kind, suggestions, call, reply });
  }
  return {
    add, release, forget,
    has: (id) => holds.has(id),
    kindOf: (id) => holds.get(id)?.kind,
    uidOf: (id) => holds.get(id)?.uid,
    callOf: (id) => holds.get(id)?.call,
    get size() { return holds.size; },
  };
}
