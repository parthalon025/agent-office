// Cloud agent plumbing, shared by the Azure AI Foundry (providers/foundry.mjs) and Copilot Studio (providers/copilot-studio.mjs)
// providers. Three jobs, none of them about one vendor:
//   1. Setup: an endpoint from the environment that must be https on a Microsoft host, and a token the USER made. The office
//      never signs in and never asks Azure for a token. A kind with no endpoint or no token is "Not configured" and makes no call.
//   2. Calls: one `cloudSend` that sends the bearer token to the checked endpoint and turns a failure into words the user can act on
//      (the token is never part of a message), and `readSse` for the event streams both services answer with.
//   3. Turns: `createRemoteAgents` is the session loop of a remote agent (one turn at a time, a queue, the spend limit, stop, close).
//      A provider only supplies the exchange with its service (`turn`).
// Cost (spec #67, owner decision Q22): neither service reports dollars. A kind reports cost only when the owner set its prices
// (`priced`); else the provider says cost: 'unknown', the office asks before it runs, shows "unknown" (never $0.00) and sets no
// spend limit, and a turn result carries no dollar figure.
// Approval (ADR 0001): the cloud tools run in the cloud and the office cannot hold them, so both kinds are gated: false, with a
// supervision label, off until the Security room turns them on (one column, 'cloud', public/vocab.js).
// Nothing here touches the network on import. Fetch, files and the environment are injected, so tests use a fake server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { providerError } from './index.mjs';
import { createAsks } from './asks.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,8000}$/; // a JWT or an opaque token: no space, no line break, so it cannot split a header
const STALL_MS = 120_000;                          // no bytes from the service for this long ends the turn
const CALL_MS = 30_000;                            // a call that is not a stream
const MAX_EVENT = 4 * 1024 * 1024;                 // one event of a stream, in characters
const MAX_ROUNDS = 6;                              // prompts in one turn (the first and the notes after it); more start a new turn

const clip = (t, n) => { const x = String(t ?? ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
export const textOf = (e) => String((e && e.message) || e || 'unknown error');

// ---------- 1. setup ----------

/** A number from the environment: a price in dollars. Missing, not a number or below 0 is 0 (no price known). */
const price = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * The settings of one cloud kind from the environment. prefix: 'OFFICE_FOUNDRY'. Reads <prefix>_ENDPOINT, _TOKEN, _TOKEN_FILE,
 * _API_VERSION, _PRICE_IN, _PRICE_OUT, _PRICE_MESSAGE. The token file is read on every call, so a fresh token in the file
 * works with no restart (Entra tokens last about an hour). The user makes the token; the office never does.
 * It TAKES <prefix>_TOKEN and <prefix>_TOKEN_FILE out of env: every process the office starts (Claude Code sessions, the
 * commands of a local agent) inherits the environment, and an agent could print the token into the chat. So call it with
 * process.env before the office starts any process (server.mjs does it first).
 */
export function cloudConfig(env, prefix, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const e = (k) => String(env[`${prefix}_${k}`] || '').trim();
  const fileName = e('TOKEN_FILE'), fixed = e('TOKEN');
  delete env[`${prefix}_TOKEN`];
  delete env[`${prefix}_TOKEN_FILE`];
  return {
    endpoint: e('ENDPOINT'), apiVersion: e('API_VERSION'),
    priceIn: price(e('PRICE_IN')), priceOut: price(e('PRICE_OUT')), priceMessage: price(e('PRICE_MESSAGE')),
    tokenFile: fileName, hasToken: !!(fixed || fileName),
    getToken() {
      let raw = fixed;
      if (!raw && fileName) { try { raw = readFile(fileName); } catch { raw = ''; } }
      raw = String(raw || '').trim();
      return TOKEN_RE.test(raw) ? raw : null;
    },
  };
}

/**
 * Checks an endpoint. https only, on one of the Microsoft host suffixes (so a wrong value in the environment cannot send the token
 * to another host), with no user name, password or fragment. allowLoopback is for tests with a fake server: the server never sets it.
 * Returns { url } or { problem } (a sentence for the user).
 */
export function checkEndpoint(raw, { suffixes, allowLoopback = false }) {
  let url;
  try { url = new URL(raw); } catch { return { problem: 'The endpoint is not a valid address.' }; }
  const loop = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopback && loop && url.protocol === 'http:')) return { problem: 'The endpoint must start with https://.' };
  if (url.username || url.password || url.hash) return { problem: 'The endpoint must not hold a user name, a password or a # part.' };
  const host = url.hostname.toLowerCase();
  if (!(allowLoopback && loop) && !suffixes.some((x) => host.endsWith(x))) return { problem: `The endpoint host must end with ${suffixes.join(' or ')}. The office sends your token only to a Microsoft host.` };
  return { url };
}

/**
 * Is a cloud kind set up? Reads the endpoint and the token now (the token file may have changed). Returns { ok: true, url, token }
 * or { ok: false, needs } where needs are the steps for the user, in plain words, only for what is missing or wrong.
 * @param {object} config cloudConfig() of the kind.
 * @param {object} o { prefix, hosts (allowed host suffixes), allowLoopback, endpointHelp (what the endpoint looks like),
 *   tokenHelp (what the token is for), validate(url) -> problem text or '' (a check of the path), readme (the section of docs/agents.md) }
 */
export function cloudSetup(config, { prefix, hosts, allowLoopback = false, endpointHelp, tokenHelp, validate = () => '', readme }) {
  const needs = [];
  let url = null;
  if (!config.endpoint) needs.push(`Set ${prefix}_ENDPOINT to ${endpointHelp}.`);
  else {
    const c = checkEndpoint(config.endpoint, { suffixes: hosts, allowLoopback });
    const problem = c.problem || validate(c.url);
    if (problem) needs.push(`${prefix}_ENDPOINT cannot be used. ${problem}`);
    else url = c.url;
  }
  const token = config.getToken();
  if (!token) {
    needs.push(config.hasToken
      ? `The token in ${config.tokenFile ? prefix + '_TOKEN_FILE' : prefix + '_TOKEN'} is missing or not valid. Make a new token. ${tokenHelp}`
      : `Set ${prefix}_TOKEN_FILE to a file that holds an access token. ${tokenHelp} You make the token. The office never signs in.`);
  }
  if (needs.length) {
    if (!url) needs.push(`Restart the office after you set ${prefix}_ENDPOINT. A new token in the token file needs no restart.`);
    needs.push(`The section "${readme}" of docs/agents.md has the steps.`);
    return { ok: false, needs };
  }
  return { ok: true, url, token };
}

// ---------- 2. calls ----------

/** The words for a failed call. `secret` is cut out of any text the service sent back. */
export function explain(label, status, why = '', secret = '') {
  let tail = clip(why, 200);
  if (secret) tail = tail.split(secret).join('…');
  if (status === 401) return `${label} refused the token. Make a new token and try again.`;
  if (status === 403) return `${label} says this token has no access. Check the role of your account.`;
  if (status === 404) return `${label} did not find the agent or the conversation. Check the endpoint.`;
  if (status === 429) return `${label} asks you to slow down (429). Try again later.`;
  return `${label} answered ${status}${tail ? ': ' + tail : ''}`;
}

/**
 * One call to the checked endpoint with the bearer token. Throws an Error with the explained text when the answer is not ok.
 * Returns the Response (the body of a stream is not read). signal: stops the call; a call that is not a stream also times out.
 */
export async function cloudSend({ fetch: doFetch, label, url, method = 'POST', token, body, signal, stream = false, callMs = CALL_MS }) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) { if (signal.aborted) ctl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = stream ? null : setTimeout(() => ctl.abort(new Error('timeout')), callMs);
  try {
    const r = await doFetch(String(url), {
      method, signal: ctl.signal,
      headers: { authorization: `Bearer ${token}`, accept: stream ? 'text/event-stream' : 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      let why = '';
      try { const j = await r.json(); why = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : ''); } catch { /* no body */ }
      throw new Error(explain(label, r.status, why, token));
    }
    return r;
  } catch (e) {
    if (ctl.signal.aborted && textOf(ctl.signal.reason) === 'timeout') throw new Error(`${label} did not answer in ${callMs / 1000} seconds.`);
    throw e;
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
}

/** The JSON body of a Response, or {} when it has none. */
export async function jsonOf(r) { try { return await r.json(); } catch { return {}; } }

/**
 * Reads a server-sent event stream. Calls onEvent({ event, data }) for each event; data is the raw text.
 * stallMs: no bytes for this long throws 'stalled' (the caller says it in words). Stops quietly at the end of the body.
 */
export async function readSse(body, onEvent, { stallMs = STALL_MS, signal } = {}) {
  const dec = new TextDecoder();
  let buf = '', ev = '', data = [], size = 0, timer;
  const ctl = new AbortController();
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error('stalled')), stallMs); };
  // One promise that fails when the stream stalls or the caller stops it. A read races against it.
  const aborted = new Promise((_, rej) => ctl.signal.addEventListener('abort', () => rej(ctl.signal.reason), { once: true }));
  aborted.catch(() => {});
  const stop = () => ctl.abort(signal.reason);
  if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  const flush = async () => {
    if (data.length) await onEvent({ event: ev || 'message', data: data.join('\n') });
    ev = ''; data = []; size = 0;
  };
  const line = async (l) => {
    if (l === '') return flush();
    if (l.startsWith(':')) return undefined;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    const val = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
    if (field === 'event') ev = val;
    else if (field === 'data') { size += val.length; if (size > MAX_EVENT) throw new Error('An event of the stream is too large.'); data.push(val); }
    return undefined;
  };
  kick();
  const it = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = it.next();
      next.catch(() => {}); // a read that loses the race to a stall or a stop must not become an unhandled rejection
      const r = await Promise.race([next, aborted]);
      if (r.done) break;
      kick();
      buf += typeof r.value === 'string' ? r.value : dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
        const nl = buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1;
        const l = buf.slice(0, i);
        buf = buf.slice(i + nl);
        await line(l);
      }
      if (buf.length > MAX_EVENT) throw new Error('A line of the stream is too large.');
    }
    if (buf) await line(buf);
    await flush();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
    // Free the connection. Not awaited: a read that is still pending (a stalled stream) would hold it.
    try { Promise.resolve(it.return?.()).catch(() => {}); } catch { /* done */ }
  }
}

// ---------- 3. turns ----------

/**
 * The session loop of a remote agent. The service does the work; the office sends one message at a time, shows what comes back
 * and holds the spend limit. A turn that cost money is counted when it ends, and the next message does not start once the
 * session reached its limit.
 *
 * Messages the user sends while a turn runs: the server puts them in the tracker's inbox, and the next PostToolUse (or Stop) hook
 * hands them out. A cloud run cannot take text in the middle, so a note from any hook of the turn waits in st.notes and is the next
 * prompt of the same turn, the way a Stop block is. Past MAX_ROUNDS it goes out as a new turn. A note is never dropped: after a
 * stop, a failure or the spend limit it waits for the next message.
 *
 * @param {object} o
 * @param {object} o.events the provider events (providers/index.mjs providerEvents).
 * @param {string} o.label name of the service, for messages.
 * @param {() => string} [o.makeId]
 * @param {(s: object, opts: object) => object} [o.newState] extra state of one open session (the service's own ids).
 * @param {(ctx: object) => Promise<{last?: string, overBudget?: boolean}>} o.turn one exchange with the service. ctx: { s, st, prompt,
 *   signal, emit, stream, hook, ask(tool, input) -> Promise<boolean> (the user's decision on a request the service made),
 *   charge(usd), overBudget() (true once the session reached its limit), makeId, stopped() }. It throws an Error for a failed
 *   turn, and returns overBudget: true when it stopped for the limit. After an interrupt or a close, what it throws is ignored.
 * @param {(s: object, st: object) => void} [o.onStop] called when the user interrupts, to tell the service (best effort).
 * @param {boolean} [o.priced] the owner set the prices of the kind: a turn result says the dollars counted. Without them it
 *   carries no total_cost_usd, so the session cost stays unknown, never $0.00.
 */
export function createRemoteAgents({ events, label, makeId = () => crypto.randomBytes(5).toString('hex'), newState = () => ({}), turn, onStop = () => {}, priced = false }) {
  /** @type {Map<string, object>} uid -> the agent state of an open session */
  const agents = new Map();
  // Every report goes through emit(): after close, nothing more is reported (the seam's timing rule 2).
  const emit = (st, fn) => (st.closed ? undefined : fn());
  const noteOf = (back) => back?.hookSpecificOutput?.additionalContext || '';
  const asks = createAsks({ events });

  async function ask(st, s, tool, input) {
    if (st.closed || st.interrupted) return false;
    return (await asks.wait(s, st, { tool_name: tool, tool_input: input })).allow;
  }

  // Money the session spent, from the prices the owner set. A provider may call it after a turn ended (the tokens of a stopped
  // run come in late): the next turn's limit check then counts them.
  function charge(st, usd) { if (usd > 0) st.cost += usd; }
  const overBudget = (st) => !!(st.budget && st.cost >= st.budget);

  // One run at a time: busy is set here, before the run starts on a later tick, so a message in between waits in the queue.
  function start(s, st, prompt) {
    st.busy = true;
    st.interrupted = false;
    setImmediate(() => run(s, st, prompt));
  }

  async function run(s, st, first) {
    let prompt = first, last = '', failure = null, over = false;
    try {
      for (let round = 0; ; round++) {
        if (st.interrupted || st.closed) { if (round > 0) st.notes.unshift(prompt); break; }
        const back = emit(st, () => events.hook(s, { hook_event_name: 'UserPromptSubmit', prompt }));
        if (noteOf(back)) st.notes.push(noteOf(back));
        if (overBudget(st)) { if (round > 0) st.notes.unshift(prompt); over = true; break; }
        // Notes from before this prompt (a turn that was stopped, or the hook just now) go with it.
        const notes = st.notes.splice(0);
        st.abort = new AbortController();
        const ctx = {
          s, st, prompt: [prompt, ...notes].join('\n\n'), signal: st.abort.signal, makeId,
          emit: (fn) => emit(st, fn),
          // A hook's answer can carry a note from the tracker's inbox. It is kept for the next prompt.
          hook: (p) => { const r = emit(st, () => events.hook(s, p)); if (noteOf(r)) st.notes.push(noteOf(r)); return r; },
          stream: (m) => emit(st, () => events.stream(s, m)),
          ask: (tool, input) => ask(st, s, tool, input),
          charge: (usd) => charge(st, usd),
          overBudget: () => overBudget(st),
          stopped: () => st.interrupted || st.closed,
        };
        const r = await turn(ctx);
        if (r && r.last) last = r.last;
        if (r && r.overBudget) { over = true; break; }
        if (st.interrupted || st.closed) break;
        // The turn would end. A note that came in meanwhile, or one the Stop hook hands out, is the next prompt.
        let next = st.notes.splice(0).join('\n\n');
        if (!next) {
          const stop = emit(st, () => events.hook(s, { hook_event_name: 'Stop', last_assistant_message: last }));
          if (stop && stop.decision === 'block' && stop.reason) next = String(stop.reason);
        }
        if (!next) break;
        if (round + 1 >= MAX_ROUNDS) { st.queue.unshift(next); break; }
        prompt = next;
      }
    } catch (e) {
      if (!st.interrupted && !st.closed) failure = textOf(e);
    } finally { st.abort = null; }
    finish(s, st, last, failure, over);
  }

  function finish(s, st, last, failure, over) {
    asks.cancelAll(st);
    if (st.closed) { st.busy = false; return; }
    // The next queued message keeps the session busy, so a message that comes in with the result below waits behind it.
    const next = st.queue.shift();
    if (next === undefined) st.busy = false;
    const cost = priced ? { total_cost_usd: st.cost } : {};
    if (st.interrupted) events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Stopped', ...cost });
    else if (over) events.stream(s, { type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['The spending limit is reached.'], ...cost });
    else if (failure) events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: failure, ...cost });
    else events.stream(s, { type: 'result', subtype: 'success', is_error: false, result: last, ...cost });
    if (next !== undefined) start(s, st, next);
  }

  return {
    open(s, o = {}) {
      const st = { busy: false, closed: false, interrupted: false, abort: null, queue: [], notes: [], asks: new Map(), cost: 0, budget: o.budget > 0 ? Number(o.budget) : null, ...newState(s, o) };
      agents.set(s.uid, st);
      return st;
    },
    state: (s) => agents.get(s.uid) || null,
    charge,
    message(s, { text = '', attachments = [] } = {}) {
      const st = agents.get(s.uid);
      if (!st || st.closed) throw providerError(409, 'That session is not running.');
      if (attachments.length) throw providerError(415, `${label} agents take text only.`);
      const prompt = String(text);
      if (st.busy) st.queue.push(prompt);
      else start(s, st, prompt);
    },
    // The user's decision on a request this provider raised. No decision ({}) declines.
    answer(s, request, d = {}) {
      const st = agents.get(s.uid);
      if (st) asks.answer(st, request?.id, d);
    },
    interrupt(s) {
      const st = agents.get(s.uid);
      if (!st || !st.busy) return;
      st.interrupted = true;
      st.queue.length = 0;
      asks.cancelAll(st);
      if (st.abort) st.abort.abort(new Error('interrupted'));
      try { onStop(s, st); } catch { /* best effort */ }
    },
    close(s) {
      const st = agents.get(s.uid);
      agents.delete(s.uid);
      if (st) {
        st.closed = true;
        if (st.abort) st.abort.abort(new Error('closed'));
        asks.cancelAll(st);
        try { onStop(s, st); } catch { /* best effort */ }
      }
      return Promise.resolve();
    },
  };
}
