// Local model provider: Ollama and LM Studio agents behind the provider seam (providers/index.mjs).
// One factory, two kinds. It talks to an OpenAI-compatible chat server on this machine and runs the agent loop in the
// office: the model asks for a tool, the office rates the call (risk.mjs), asks you when it is not low risk, runs it
// inside the worktree (providers/local-tools.mjs) and sends the result back, until the model answers in plain text.
//
// Everything the agent does is reported to the tracker in its own vocabulary (events.hook, events.stream): this file
// never sets a session's status, calls or error itself. Cost is always 0; tokens come from the server's usage numbers.
// The server address and fetch are injected, so tests use a fake server and nothing here touches the network on import.
//
// Local servers are shared with other tools (LM Studio also serves embeddings). So this file only reads the model list and
// sends chat requests. It never loads, unloads or downloads a model.
import crypto from 'node:crypto';
import { riskOf } from '../risk.mjs';
import { providerError } from './index.mjs';
import { createLocalTools } from './local-tools.mjs';

export const KINDS = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', needs: ['Start Ollama and pull a model: ollama pull <model>.'] },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', needs: ['Start the LM Studio local server (Developer tab) and load a chat model.'] },
};
export const MAX_ROUNDS = 25;          // model calls in one turn
const STALL_MS = 120_000;              // no bytes from the server for this long ends the turn
const READY_MS = 3000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const EMBEDDING = /embed|rerank/i;     // LM Studio lists its embedding models next to the chat models
const SYSTEM = (cwd) => `You are a coding agent working in the folder ${cwd}. Use the tools to read and change files and to run commands in that folder. `
  + 'Paths are relative to the folder. Keep answers short. When the work is done, say what you did.';

// The four office tools, for agents the office runs itself. The same words as the MCP server (mcp.mjs) uses.
const OFFICE_TOOLS = [
  { name: 'office_inbox', description: 'Read new messages the user sent to this session from Agent Office. Returns them and clears the queue.', parameters: { type: 'object', properties: {} } },
  { name: 'office_ask', description: 'Ask the user a question in Agent Office and wait for the answer (up to 10 minutes). Use it for decisions you cannot make alone.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'A short, specific question. A yes or no question works best.' } }, required: ['question'] } },
  { name: 'office_room', description: 'Describe your place in Agent Office: building, floor, room, the other sessions, the notes board and the blackboard pin. Call it first when the user talks about their room.', parameters: { type: 'object', properties: {} } },
  { name: 'office_room_update', description: 'Change your room when the user asks: give notes_append, notes_replace (not both) or pin. Returns what changed.',
    parameters: { type: 'object', properties: { notes_append: { type: 'string' }, notes_replace: { type: 'string' }, pin: { type: 'string' } } } },
].map((t) => ({ type: 'function', function: t }));
const OFFICE_NAMES = new Set(OFFICE_TOOLS.map((t) => t.function.name));

const textOf = (e) => String((e && e.message) || e || 'unknown error');

/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {'ollama'|'lmstudio'} deps.kind
 * @param {string} [deps.baseUrl] the chat server, a loopback address only (default per kind).
 * @param {Function} [deps.fetch] fetch.  @param {(root: string) => object} [deps.makeTools] createLocalTools.
 * @param {() => string} [deps.makeId] ids for the messages.  @param {number} [deps.stallMs]
 * @param {{inbox: Function, ask: Function, room: Function, roomUpdate: Function}} [deps.officeTools] the office tools as in-process
 *   calls (server.mjs officeTools): each takes the session first and answers text, or throws an error with a message.
 */
export function createLocal(deps) {
  const spec = KINDS[deps.kind];
  if (!spec) throw new Error(`Unknown local kind: ${deps.kind}`);
  const events = deps.events;
  const baseUrl = String(deps.baseUrl || spec.baseUrl).replace(/\/+$/, '');
  if (!LOOPBACK.has(new URL(baseUrl).hostname)) throw new Error('A local model provider talks to this machine only.');
  const doFetch = deps.fetch || globalThis.fetch;
  const makeTools = deps.makeTools || ((root) => createLocalTools(root));
  const makeId = deps.makeId || (() => crypto.randomBytes(5).toString('hex'));
  const stallMs = deps.stallMs || STALL_MS;
  const office = deps.officeTools || null;
  /** @type {Map<string, object>} uid -> the agent state of an open session */
  const agents = new Map();

  // ----- the chat server -----
  async function listModels(ms = READY_MS) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await doFetch(baseUrl + '/models', { signal: ctl.signal });
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      const j = await r.json();
      return (Array.isArray(j.data) ? j.data : []).map((m) => String(m.id)).filter((id) => id && !EMBEDDING.test(id));
    } finally { clearTimeout(t); }
  }

  // One streamed chat call. Resolves { text, toolCalls, usage }. onText gets each text piece as it arrives.
  async function chat(st, onText) {
    const ctl = new AbortController();
    st.abort = ctl;
    let timer;
    const kick = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error('stalled')), stallMs); };
    kick();
    try {
      const r = await doFetch(baseUrl + '/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ model: st.model, messages: st.messages, tools: office ? [...st.tools.definitions, ...OFFICE_TOOLS] : st.tools.definitions, stream: true, stream_options: { include_usage: true } }),
      });
      if (!r.ok) {
        let why = '';
        try { why = (await r.json()).error?.message || ''; } catch { /* no body */ }
        throw new Error(`${spec.label} answered ${r.status}${why ? ': ' + why : ''}`);
      }
      let text = '', usage = null, buf = '';
      const calls = [];
      const dec = new TextDecoder();
      const eat = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let j; try { j = JSON.parse(data); } catch { return; }
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (!d) return;
        if (typeof d.content === 'string' && d.content) { text += d.content; onText(d.content); }
        for (const tc of d.tool_calls || []) {
          const c = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      };
      for await (const chunk of r.body) {
        kick();
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) eat(buf.trim());
      return { text, toolCalls: calls.filter((c) => c && c.name).map((c, i) => ({ ...c, id: c.id || `call_${makeId()}_${i}` })), usage };
    } finally { clearTimeout(timer); }
  }

  // ----- the agent loop -----
  // Every report goes through emit(): after close, nothing more is reported (the seam's timing rule 2).
  // It gives back what fn gives back: a hook answers with the office messages that waited (see note below).
  const emit = (st, fn) => (st.closed ? undefined : fn());
  // A message the user sent while a turn ran waits in the session's inbox. The tracker hands it back as the answer of a hook:
  // as context on the prompt and on a tool result, and as a block on Stop (go on, here is a new message).
  const noteOf = (back) => back?.hookSpecificOutput?.additionalContext || '';

  // Ask the user and wait. The server holds the request and calls answer(); a close or an interrupt drops it as a decline.
  function ask(st, s, name, input) {
    return new Promise((resolve) => {
      const id = events.permission(s, { tool_name: name, tool_input: input, permission_suggestions: [] });
      if (!id) return resolve(false);
      st.waiting.set(id, resolve);
    });
  }

  async function runTurn(s, st, prompt) {
    st.busy = true;
    st.interrupted = false;
    const back = emit(st, () => events.hook(s, { hook_event_name: 'UserPromptSubmit', prompt }));
    st.messages.push({ role: 'user', content: noteOf(back) ? prompt + '\n\n' + noteOf(back) : prompt });
    let last = '', failure = null;
    try {
      for (let round = 0; ; round++) {
        if (st.interrupted || st.closed) break;
        if (round >= MAX_ROUNDS) { failure = `The model used all ${MAX_ROUNDS} steps of one turn.`; break; }
        const id = 'm' + makeId();
        emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'message_start' } }));
        const res = await chat(st, (piece) => emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } })));
        if (st.interrupted || st.closed) break;
        const u = res.usage || {};
        emit(st, () => events.stream(s, { type: 'assistant', message: { id, content: res.text.trim() ? [{ type: 'text', text: res.text }] : [], usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } } }));
        if (res.text.trim()) last = res.text;
        st.messages.push({ role: 'assistant', content: res.text || null, ...(res.toolCalls.length ? { tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) } : {}) });
        if (!res.toolCalls.length) {
          // The turn would end. A message that came in meanwhile goes to the model first.
          const stop = emit(st, () => events.hook(s, { hook_event_name: 'Stop', last_assistant_message: last }));
          if (stop && stop.decision === 'block' && stop.reason) { st.messages.push({ role: 'user', content: stop.reason }); continue; }
          break;
        }
        for (const c of res.toolCalls) {
          if (st.interrupted || st.closed) break;
          st.messages.push({ role: 'tool', tool_call_id: c.id, content: await callTool(s, st, c) });
        }
      }
    } catch (e) {
      if (!st.interrupted && !st.closed) failure = textOf(e) === 'stalled' ? `${spec.label} stopped answering.` : `API Error: ${textOf(e)}`;
    } finally { st.abort = null; }
    finishTurn(s, st, last, failure);
  }

  // One tool call: Pre hook, approval when the risk is not low, the tool, then Post or PostFailure. Returns the text for the model.
  async function callTool(s, st, c) {
    let input;
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = null; }
    const shown = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const base = { tool_name: c.name, tool_use_id: c.id, tool_input: shown };
    emit(st, () => events.hook(s, { hook_event_name: 'PreToolUse', ...base }));
    const t0 = Date.now();
    const failed = (error, interrupt = false) => { emit(st, () => events.hook(s, { hook_event_name: 'PostToolUseFailure', ...base, error, is_interrupt: interrupt, duration_ms: Date.now() - t0 })); return error; };
    if (input === null) return failed('The arguments are not valid JSON.');
    if (OFFICE_NAMES.has(c.name)) return officeCall(s, st, c, shown, base, t0, failed);
    if (riskOf(c.name, shown, s.cwd) !== 'low' && !st.closed) {
      if (!(await ask(st, s, c.name, shown))) return failed(st.interrupted || st.closed ? 'Stopped' : 'Declined from Agent Office.', st.interrupted);
    }
    if (st.interrupted || st.closed) return failed('Stopped', true);
    const r = await st.tools.run(c.name, shown);
    if (st.interrupted || st.closed) return failed('Stopped', true);
    if (!r.ok) return failed(r.text);
    const back = emit(st, () => events.hook(s, { hook_event_name: 'PostToolUse', ...base, duration_ms: Date.now() - t0 }));
    return noteOf(back) ? r.text + '\n\n' + noteOf(back) : r.text;
  }

  // An office tool: the office's own, so it needs no approval (office_ask asks the user itself). Not offered without deps.officeTools.
  async function officeCall(s, st, c, input, base, t0, failed) {
    if (!office) return failed('The office tools are not available.');
    let text;
    try {
      if (c.name === 'office_inbox') text = await office.inbox(s);
      else if (c.name === 'office_room') text = await office.room(s);
      else if (c.name === 'office_room_update') text = await office.roomUpdate(s, input);
      else {
        if (typeof input.question !== 'string' || !input.question.trim()) return failed('question must be text.');
        text = await office.ask(s, input.question.slice(0, 1000));
      }
    } catch (e) { return failed(textOf(e)); }
    if (st.interrupted || st.closed) return failed('Stopped', true);
    const back = emit(st, () => events.hook(s, { hook_event_name: 'PostToolUse', ...base, duration_ms: Date.now() - t0 }));
    return noteOf(back) ? String(text) + '\n\n' + noteOf(back) : String(text);
  }

  function finishTurn(s, st, last, failure) {
    st.busy = false;
    for (const resolve of st.waiting.values()) resolve(false);
    st.waiting.clear();
    if (st.closed) return;
    if (st.interrupted) {
      events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Stopped', total_cost_usd: 0 });
    } else if (failure) {
      events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: failure, total_cost_usd: 0 });
    } else {
      events.stream(s, { type: 'result', subtype: 'success', is_error: false, result: last, total_cost_usd: 0 });
    }
    const next = st.queue.shift();
    if (next !== undefined) setImmediate(() => runTurn(s, st, next));
  }

  return {
    kind: deps.kind,
    label: spec.label,
    paid: false, // a model on this machine costs nothing: no spend limit
    canResume: false, // a local conversation lives in memory: Reopen starts a fresh session in the same folder

    async readiness() {
      let ids;
      try { ids = await listModels(); } catch { return { ready: false, version: null, needs: [...spec.needs] }; }
      if (!ids.length) return { ready: false, version: null, needs: [...spec.needs] };
      return { ready: true, version: `${ids.length} model${ids.length === 1 ? '' : 's'}`, needs: [] };
    },

    async models() { return (await listModels()).map((id) => ({ id, label: id })); },

    // Before the office makes a worktree: a local agent needs a model. check({}) asks only whether a session can start
    // (Reopen), and a local agent needs no program for that, so an empty option object passes.
    check(o = {}) {
      if (Object.keys(o).length === 0) return;
      if (!o.model || typeof o.model !== 'string' || o.model.length > 200) throw providerError(400, 'Pick a model for this agent.');
    },

    open(s, o = {}) {
      this.check(o);
      const st = {
        model: o.model, messages: [{ role: 'system', content: SYSTEM(s.cwd) }], tools: makeTools(s.cwd),
        busy: false, closed: false, interrupted: false, abort: null, queue: [], waiting: new Map(),
      };
      agents.set(s.uid, st);
      // The session shows its model like a Claude Code session does, on a later tick (seam rule 1).
      setImmediate(() => emit(st, () => events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: o.model, permissionMode: 'default' })));
    },

    message(s, { text = '', attachments = [] } = {}) {
      const st = agents.get(s.uid);
      if (!st || st.closed) throw providerError(409, 'That session is not running.');
      if (attachments.length) throw providerError(415, 'Local agents take text only.');
      const prompt = String(text);
      if (st.busy) st.queue.push(prompt);
      else setImmediate(() => runTurn(s, st, prompt));
    },

    // The user's decision on a request this provider raised. No decision ({}) declines.
    answer(s, request, d = {}) {
      const st = agents.get(s.uid);
      const resolve = st && st.waiting.get(request?.id);
      if (!resolve) return;
      st.waiting.delete(request.id);
      resolve(d.allow === true);
    },

    interrupt(s) {
      const st = agents.get(s.uid);
      if (!st || !st.busy) return;
      st.interrupted = true;
      st.queue.length = 0;
      st.tools.stop();
      if (st.abort) st.abort.abort();
      for (const resolve of st.waiting.values()) resolve(false);
      st.waiting.clear();
    },

    close(s) {
      const st = agents.get(s.uid);
      agents.delete(s.uid);
      if (st) {
        st.closed = true;
        st.tools.stop();
        if (st.abort) st.abort.abort();
        for (const resolve of st.waiting.values()) resolve(false);
      }
      return Promise.resolve();
    },
  };
}
