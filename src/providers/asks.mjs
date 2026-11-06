// The ask module: how an agent kind asks the office and waits (#175). Local models, Agent Framework teams, ACP agents, the
// OpenClaw gate and the cloud kinds all hold their requests here, so the wait code exists once.
//
// Interface (createAsks({ events, setTimer?, clearTimer? }) -> asks):
//   hold(s, st, request, done, opts?) -> id | null   ask the office (events.permission: the Security room rules first, then the
//       user). done(verdict, why) runs once with 'allow', 'deny', 'cancel' or 'withdraw'; why is the reason the office refused
//       (a Deny rule). Null when the office made no request (the session is closed, or the office held nothing): done('deny')
//       has run already. request: { tool_name, tool_input, agent_id?, ask_reason? } (permission_suggestions are added).
//       opts: { firm } (an Allow rule does not answer it), { timeoutMs, onTimeout } (the agent stops waiting by itself).
//   wait(s, st, request, opts?) -> Promise<{ allow, message }>   hold() as a promise; a refusal says why in message.
//   answer(st, id, d) the office's decision on request id ({ allow, message }); no decision declines, or cancels when the
//       agent stopped waiting, the turn is stopping or the session closed. A request that is gone is ignored.
//   withdraw(s, st, id, why)  the office answers it itself: the agent stopped waiting. The hold goes (events.drop).
//   cancelAll(st)  every request that waits ends as 'cancel' (an interrupt, a close, the end of a turn).
// st.asks (Map: request id -> ask) is the one place that keeps them; the provider's state starts it as `asks: new Map()`.
// Pure apart from events and the injected timers; tested in test/asks.test.mjs.

export function createAsks({ events, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
  function hold(s, st, request, done, opts = {}) {
    const id = st.closed ? undefined : events.permission(s, { permission_suggestions: [], ...request }, opts.firm === undefined ? undefined : { firm: opts.firm });
    if (!id) { done('deny'); return null; }
    const ask = { gaveUp: false, timer: null, done: (v, why) => { if (st.asks.get(id) !== ask) return; st.asks.delete(id); if (ask.timer) clearTimer(ask.timer); done(v, why); } };
    st.asks.set(id, ask);
    if (opts.timeoutMs) ask.timer = setTimer(() => (opts.onTimeout ? opts.onTimeout(id) : withdraw(s, st, id, 'The agent moved on without an answer.')), opts.timeoutMs);
    return id;
  }

  function wait(s, st, request, opts) {
    return new Promise((resolve) => {
      hold(s, st, request, (v, why) => resolve({ allow: v === 'allow', message: why || '' }), opts);
    });
  }

  function answer(st, id, d = {}) {
    const ask = st.asks.get(id);
    if (!ask) return;
    ask.done(d.allow === true ? 'allow' : d.allow === false ? 'deny' : ask.gaveUp || st.interrupted || st.closed ? 'cancel' : 'deny', typeof d.message === 'string' ? d.message : '');
  }

  function withdraw(s, st, id, why) {
    const ask = st.asks.get(id);
    if (!ask) return;
    ask.gaveUp = true;
    ask.done('withdraw');
    if (!st.closed) events.drop(s, id, why);
  }

  function cancelAll(st) {
    for (const ask of [...st.asks.values()]) { ask.gaveUp = true; ask.done('cancel'); }
  }

  return { hold, wait, answer, withdraw, cancelAll };
}
