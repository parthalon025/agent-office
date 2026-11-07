// The tool gate of the Agent Office plugin for OpenClaw (#77). OpenClaw loads this plugin into its Gateway, not the office
// (index.js is the entry). createGate is pure apart from the file read and the HTTP call, which are injected, so the office's
// tests run it without OpenClaw (test/openclaw-plugin.test.mjs, with the stand-in host test/fixtures/fake-openclaw.mjs).
//
// before_tool_call (OpenClaw v2026.10.10: docs/plugins/hooks/tool-policy.md, src/plugins/hook-types.ts) for a session the
// office opened: the call goes to the office hold (POST /hook/openclaw with the agent token) and waits for the decision.
//   - An office session has a Gateway session key that ends in "agent-office:<uid>": the office sets it in session/new
//     (`_meta.sessionKey`). A session of another client is not the office's: the plugin returns nothing and OpenClaw decides.
//   - Allow: the plugin returns nothing (no decision), so the call runs. Deny: { block: true, blockReason }.
//   - No answer means deny: no token file, no office, a refused request, an answer that is not allow, the wait limit.
//
// The office keeps the same key rule in providers/openclaw.mjs (OFFICE_KEY); test/openclaw-plugin.test.mjs checks that the two agree.
//
// Timing (OpenClaw v2026.10.10): a handler that throws or passes its timeoutMs blocks the call (default 15 s). The plugin asks for 600 s,
// the most the operator settings take, and waits 595 s itself. The operator settings plugins.entries.agent-office.hooks.timeouts.before_tool_call,
// then .hooks.timeoutMs, win over it, so the plugin reads them from api.config and waits 5 s less. OpenClaw does not cancel a handler that
// timed out, which is why the plugin ends its own wait first and closes its request. An approval after 5 minutes still runs (the 310 s check
// passed with httpPost on Node 22.18, 2026-11-05; the global fetch would give up at 300 s).
// The plugin reads the token and port from the office token file at each call and posts only to 127.0.0.1. The file is named by its config
// (plugins.entries.agent-office.config.tokenFile, read as api.pluginConfig). The plugin stays self-contained: it imports nothing from the office
// or from OpenClaw, and has its own httpPost. Install steps are in docs/agents.md (OpenClaw).
import http from 'node:http';

export const OFFICE_KEY = /(?:^|:)agent-office:(o[0-9a-f]{8})$/i;
export const ROUTE = '/hook/openclaw';
// OpenClaw's limit for this handler: the plugin asks for 600 s, the most the operator settings take. An operator can make it
// shorter (plugins.entries.agent-office.hooks.timeouts.before_tool_call, then .hooks.timeoutMs; src/plugins/registry-state.ts
// resolveTypedHookTimeoutMs). When it ends first, OpenClaw blocks the call by itself while the office card stays open.
export const HOOK_MS = 600_000;
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
// How long one call waits for the office under the default limit: 5 s less, so the plugin ends the wait itself, says why,
// and closes its request (the office then takes the card away).
export const WAIT_MS = waitFor(HOOK_MS);
const MAX_BODY = 1_000_000;  // characters of one request: the office does not hold what it cannot show
const MAX_ANSWER = 65_536;   // bytes of the office's answer the plugin reads
const PREFIX = 'Agent Office: ';

const block = (why) => ({ block: true, blockReason: PREFIX + why });

/** The office session id in an OpenClaw session key, or null when the session is not one the office opened. */
export function officeIdOf(sessionKey) {
  const m = typeof sessionKey === 'string' ? OFFICE_KEY.exec(sessionKey) : null;
  return m ? m[1].toLowerCase() : null;
}

/**
 * OpenClaw's limit for this plugin's before_tool_call handler, from the Gateway config (api.config), the way OpenClaw picks
 * it: plugins.entries.<id>.hooks.timeouts.before_tool_call, else .hooks.timeoutMs, else the plugin's own HOOK_MS.
 */
export function hookLimit(config, id = 'agent-office') {
  let hooks;
  try { hooks = config?.plugins?.entries?.[id]?.hooks; } catch { hooks = undefined; }
  return positive(hooks?.timeouts?.before_tool_call) ?? positive(hooks?.timeoutMs) ?? HOOK_MS;
}
/** The plugin's own wait under a handler limit: 5 s less, or half of a limit of 10 s or less. */
export function waitFor(limitMs) {
  const l = positive(limitMs) ?? HOOK_MS;
  return l > 10_000 ? l - 5_000 : Math.max(1, Math.floor(l / 2));
}

/**
 * One POST to the office on loopback with node:http, not the global fetch: fetch gives up after 300 s without answer headers
 * (undici headersTimeout), and the OpenClaw host may replace the global fetch or agent. No socket timeout: the caller's
 * signal ends the wait. Resolves { status, text }; rejects when the request fails or the signal aborts.
 */
export function httpPost({ port, path, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, timeout: 0, signal,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '', size = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => { size += Buffer.byteLength(c); if (size <= MAX_ANSWER) text += c; else res.destroy(new Error('the answer is too large')); });
        res.on('end', () => resolve({ status: res.statusCode || 0, text }));
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('the answer stopped')));
      });
    } catch (e) { reject(e); return; }
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * @param {object} deps
 * @param {() => object} deps.config the plugin config (OpenClaw api.pluginConfig): { tokenFile }.
 * @param {(file: string) => Promise<string>} deps.readFile reads the token file.
 * @param {typeof httpPost} [deps.post] the HTTP call (httpPost).
 * @param {number} [deps.waitMs] how long one call waits for the office (WAIT_MS, or waitFor(hookLimit(api.config))).
 * @param {Function} [deps.setTimer] setTimeout.  @param {Function} [deps.clearTimer] clearTimeout.
 */
export function createGate(deps) {
  const waitMs = deps.waitMs || WAIT_MS;
  const post = deps.post || httpPost;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const seconds = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

  /** The token file of the office: { token, port }. Throws with a short reason. */
  function tokenOf(text) {
    let c;
    try { c = JSON.parse(text); } catch { throw new Error('the office token file is not JSON'); }
    const port = Number(c && c.port);
    if (!c || typeof c.token !== 'string' || !c.token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the office token file has no token and port');
    return { token: c.token, port };
  }

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
    // The wait ends at the limit, or when OpenClaw cancels the call (ctx.abortSignal): the request closes, so the office frees its hold.
    const stop = new AbortController();
    const timer = setTimer(() => stop.abort(new Error('timeout')), waitMs);
    const cancel = () => stop.abort(new Error('cancelled'));
    ctx.abortSignal?.addEventListener?.('abort', cancel, { once: true });
    try {
      const res = await post({ port: office.port, path: ROUTE, headers: { 'content-type': 'application/json', 'x-office-token': office.token }, body, signal: stop.signal });
      if (res.status < 200 || res.status > 299) return block(`the office refused the request (HTTP ${res.status}). The call is denied.`);
      let d;
      try { d = JSON.parse(res.text); } catch { return block('the office answer is not JSON. The call is denied.'); }
      if (d && d.decision === 'allow') return undefined;
      const why = d && typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim() : 'Declined in Agent Office.';
      return block(why);
    } catch {
      if (stop.signal.aborted && String(stop.signal.reason?.message) === 'timeout') return block(`no answer from the office in ${seconds(waitMs)}. The call is denied.`);
      if (stop.signal.aborted) return block('OpenClaw cancelled the call while it waited for the office.');
      return block(`the office does not answer on 127.0.0.1:${office.port}. The call is denied.`);
    } finally {
      clearTimer(timer);
      ctx.abortSignal?.removeEventListener?.('abort', cancel);
    }
  }
  return { beforeToolCall };
}
