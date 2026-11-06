// The ACP client's wire: a JSON-RPC 2.0 channel on a child's stdio, one message per line (#176). It knows nothing of
// sessions, files or approvals: the provider (acp.mjs) hands it a child and two handlers. Split out of acp.mjs so the wire is
// tested alone (test/acp-rpc.test.mjs) with a fake child.
//
// Interface: channel(child, { onRequest, onNotify }) -> { request(method, params) -> Promise, notify(method, params), fail(why) };
// within(promise, ms, why, setTimer, clearTimer); rpcError(code, message); textOf(e); isAuth(e); REFUSED (the error code for
// "the office said no"); MAX_LINE.

export const MAX_LINE = 8_000_000;      // characters of one JSON-RPC line; more is dropped
export const textOf = (e) => String((e && e.message) || e || 'unknown error');
// ACP auth_required: -32000 "Authentication required" (recorded from Copilot CLI 1.0.105). -32000 alone is JSON-RPC's generic
// server error (a rate limit, a quota), so the text decides.
export const isAuth = (e) => /\bauthentication required\b/i.test(textOf(e));
export function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }
export const REFUSED = -32000; // the office said no (a path outside the root, a declined call)

/**
 * A JSON-RPC 2.0 channel on a child's stdio, one message per line. onRequest(method, params) answers with a value or a
 * promise (an error becomes the error answer); onNotify(method, params) gets notifications.
 */
export function channel(child, { onRequest, onNotify }) {
  let next = 1, buf = '';
  const waiting = new Map();
  const write = (m) => { if (child.stdin && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); };
  function take(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.method === 'string' && m.id !== undefined && m.id !== null) {
      // At once, not on a later tick: a notification on the next line (a change to the call this request asks about) must
      // find the request already held. Messages are handled in the order the agent sent them.
      let r;
      try { r = onRequest(m.method, m.params || {}, m.id); } catch (e) { r = Promise.reject(e); }
      Promise.resolve(r).then(
        (result) => write({ id: m.id, result: result ?? null }),
        (e) => write({ id: m.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: textOf(e) } }));
    } else if (typeof m.method === 'string') onNotify(m.method, m.params || {});
    else if (m.id !== undefined) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(rpcError(m.error.code, String(m.error.message || 'The agent answered with an error.')));
      else w.resolve(m.result);
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) take(line); }
    if (buf.length > MAX_LINE) buf = '';
  });
  child.stdin?.on?.('error', () => {});
  return {
    request(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); write({ id, method, params }); });
    },
    notify(method, params) { write({ method, params }); },
    /** Every request that waits fails: the agent is gone. */
    fail(why) { for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); },
  };
}

// A promise that rejects with `why` after ms.
export function within(p, ms, why, setTimer, clearTimer) {
  let t;
  const late = new Promise((_r, reject) => { t = setTimer(() => reject(new Error(why)), ms); });
  return Promise.race([p, late]).finally(() => clearTimer(t));
}
