// The tool gate of the Agent Office plugin for OpenClaw (#77). OpenClaw loads this plugin into its Gateway, not the office
// (index.js is the entry). Pure apart from the file read and the HTTP call, which are injected, so the office's tests run it
// without OpenClaw (test/openclaw-plugin.test.mjs, with the stand-in host test/fixtures/fake-openclaw.mjs).
//
// before_tool_call (OpenClaw v2026.10.10: docs/plugins/hooks/tool-policy.md, src/plugins/hook-types.ts) for a session the
// office opened: the call goes to the office hold (POST /hook/openclaw with the agent token) and waits for the decision.
//   - An office session has a Gateway session key that ends in "agent-office:<uid>": the office sets it in session/new
//     (`_meta.sessionKey`). A session of another client is not the office's: the plugin returns nothing and OpenClaw decides.
//   - Allow: the plugin returns nothing (no decision), so the call runs. Deny: { block: true, blockReason }.
//   - No answer means deny: no token file, no office, a refused request, an answer that is not allow, the wait limit.
//
// The office keeps the same key rule in providers/openclaw.mjs (OFFICE_KEY); test/openclaw-plugin.test.mjs checks that the two agree.
export const OFFICE_KEY = /(?:^|:)agent-office:(o[0-9a-f]{8})$/i;
export const ROUTE = '/hook/openclaw';
// How long one call waits for the office. OpenClaw's own limit for this handler is 600 s (index.js: the most its config takes), and an
// operator setting can only make it shorter; when it ends first, OpenClaw blocks the call (its failure rule for before_tool_call).
export const WAIT_MS = 595_000;
const MAX_BODY = 1_000_000; // characters of one request: the office does not hold what it cannot show
const PREFIX = 'Agent Office: ';

const block = (why) => ({ block: true, blockReason: PREFIX + why });

/** The office session id in an OpenClaw session key, or null when the session is not one the office opened. */
export function officeIdOf(sessionKey) {
  const m = typeof sessionKey === 'string' ? OFFICE_KEY.exec(sessionKey) : null;
  return m ? m[1].toLowerCase() : null;
}

/** The token file of the office: { token, port }. Throws with a short reason. */
function tokenOf(text) {
  let c;
  try { c = JSON.parse(text); } catch { throw new Error('the office token file is not JSON'); }
  const port = Number(c && c.port);
  if (!c || typeof c.token !== 'string' || !c.token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the office token file has no token and port');
  return { token: c.token, port };
}

/**
 * @param {object} deps
 * @param {() => object} deps.config the plugin config (OpenClaw api.pluginConfig): { tokenFile }.
 * @param {(file: string) => Promise<string>} deps.readFile reads the token file.
 * @param {typeof fetch} deps.fetch the HTTP client.
 * @param {number} [deps.waitMs] how long one call waits for the office (WAIT_MS).
 * @param {Function} [deps.setTimer] setTimeout.  @param {Function} [deps.clearTimer] clearTimeout.
 */
export function createGate(deps) {
  const waitMs = deps.waitMs || WAIT_MS;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;

  /** The before_tool_call handler: nothing (the call runs, or is not an office call) or a block. */
  async function beforeToolCall(event = {}, ctx = {}) {
    const uid = officeIdOf(ctx.sessionKey);
    if (!uid) return undefined; // not an office session: OpenClaw decides as it would without this plugin
    const file = deps.config()?.tokenFile;
    if (typeof file !== 'string' || !file.trim()) return block('the plugin has no tokenFile setting, so it cannot ask the office. The call is denied.');
    let office;
    try { office = tokenOf(await deps.readFile(file)); } catch (e) { return block(`the plugin cannot read the office token file ${file} (${e.message}). The call is denied.`); }
    const body = JSON.stringify({
      session_key: ctx.sessionKey, session_id: ctx.sessionId ?? null, agent_id: ctx.agentId ?? null, run_id: event.runId ?? ctx.runId ?? null,
      tool_call_id: event.toolCallId ?? ctx.toolCallId ?? null, tool_name: String(event.toolName || ctx.toolName || ''),
      params: event.params && typeof event.params === 'object' ? event.params : {},
      derived_paths: Array.isArray(event.derivedPaths) ? event.derivedPaths.map(String) : [],
    });
    if (body.length > MAX_BODY) return block('the call is too large for the office to show. The call is denied.');
    // The wait ends at the limit, or when OpenClaw cancels the call (ctx.abortSignal): the office then frees its hold.
    const stop = new AbortController();
    const timer = setTimer(() => stop.abort(new Error('timeout')), waitMs);
    const cancel = () => stop.abort(new Error('cancelled'));
    ctx.abortSignal?.addEventListener?.('abort', cancel, { once: true });
    try {
      const res = await deps.fetch(`http://127.0.0.1:${office.port}${ROUTE}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': office.token }, body, signal: stop.signal,
      });
      if (!res.ok) return block(`the office refused the request (HTTP ${res.status}). The call is denied.`);
      let d;
      try { d = await res.json(); } catch { return block('the office answer is not JSON. The call is denied.'); }
      if (d && d.decision === 'allow') return undefined;
      const why = d && typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim() : 'Declined in Agent Office.';
      return block(why);
    } catch {
      if (stop.signal.aborted && String(stop.signal.reason?.message) === 'timeout') return block(`no answer from the office in ${Math.round(waitMs / 1000)} s. The call is denied.`);
      if (stop.signal.aborted) return block('OpenClaw cancelled the call while it waited for the office.');
      return block(`the office does not answer on 127.0.0.1:${office.port}. The call is denied.`);
    } finally {
      clearTimer(timer);
      ctx.abortSignal?.removeEventListener?.('abort', cancel);
    }
  }
  return { beforeToolCall };
}
