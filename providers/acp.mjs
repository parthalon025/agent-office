// ACP provider: agents that speak the Agent Client Protocol (agentclientprotocol.com, protocol version 1) behind the provider
// seam (providers/index.mjs). One factory for many agents: each agent is an entry in AGENTS, not a new file. The first two are
// Hermes Agent (`hermes acp`) and DeepSeek Harness (`dsh --profile acp`).
//
// The office is the ACP client. It starts the agent by its absolute path (git.mjs resolveExe), speaks newline-delimited
// JSON-RPC 2.0 on its stdin and stdout, and reports everything in the tracker's vocabulary (events.hook, events.stream):
//   session/update text            -> stream deltas and an assistant message
//   session/update tool_call(_update) -> PreToolUse, PostToolUse, PostToolUseFailure
//   session/update plan            -> a TodoWrite result (the session's plan)
//   session/request_permission     -> events.permission, held until the user answers. The office sends allow once or reject
//                                     once, never an "always" option: Hermes writes those as a lasting allowlist outside
//                                     the office (owner decision Q23). The answer is for what the card showed: a call the
//                                     agent changes while it waits is declined at once, and nothing approved moves to it.
//   interrupt                      -> session/cancel
// The office also serves the agent's files and terminals (clientCapabilities fs and terminal, owner decision Q24) with
// providers/local-tools.mjs: limited to the session's root, rated with riskOf, and held like any other call when not low
// risk. A path outside the root is refused before anyone is asked. So an agent that uses them is held more strictly than one
// that only asks: an edit the user declined in a turn cannot come back through fs/write_text_file (Hermes issue #31682).
// An agent may ignore those capabilities and use its own tools (Hermes does): the office then sees a call only in its
// updates, cannot stop it, and says so in the feed. Such an agent is not gated (ADR 0001; AGENTS gated and supervision).
//
// ACP reports no cost in the stable protocol, so the provider is paid with cost 'unknown' (owner decision Q22). The process
// calls and the timers are injected, so tests drive a fake agent (test/fixtures/fake-acp.mjs). Nothing starts on import.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn, execFile as realExecFile } from 'node:child_process';
import { resolveExe } from '../git.mjs';
import { riskOf, fileKey } from '../risk.mjs';
import { clip } from '../tracker.mjs';
import { providerError } from './index.mjs';
import { createLocalTools, killTree } from './local-tools.mjs';

export const PROTOCOL_VERSION = 1;
// One entry per agent. program: the name resolveExe finds on PATH. args: what starts its ACP mode on stdio.
// askTimeoutMs: how long the agent waits for an approval before it moves on by itself (the office's hold is longer, so the
// feed says when the agent gave up first). features: what the agent has beyond the seam, for the page (#72); 'resume' and
// 'images' come from the handshake. pin: the version the office was tested against (null: not tested with a real one yet).
// gated (ADR 0001): true only when the agent asks the office before every tool call that is not low risk; an agent where only
// some calls ask is ungated, with its supervision label. Neither agent has been run against the office yet (pin: null).
export const AGENTS = {
  hermes: {
    label: 'Hermes Agent', program: 'hermes', args: ['acp'],
    // From Hermes's source (acp_adapter/server.py: initialize ignores the client's fs and terminal; its terminal tool asks
    // only for commands that match its danger patterns) and upstream issue #139074 (0.21.5, a client with terminal: true:
    // a write asked, a touch ran without asking). Its default mode asks before edits.
    gated: false, supervision: 'Partly supervised: file edits ask, commands do not',
    askTimeoutMs: 60_000, // Hermes issue #63302: a fixed 60 s timeout on edit approval (command approval has its own setting)
    features: ['skills', 'memory', 'fork'], pin: null,
    needs: ['Install Hermes Agent so that hermes.exe is on the PATH, then run hermes acp --check in a terminal.'],
  },
  dsh: {
    label: 'DeepSeek Harness', program: 'dsh', args: ['--profile', 'acp'],
    gated: true, // research (2026-11-04): it sends its tool approvals over ACP and fails closed when no client answers
    askTimeoutMs: null,
    // dsh-acp lists forks, deletion and transcript replay as unsupported, so no fork here.
    features: ['reason', 'teams', 'schedules'], pin: null, // a developer preview: pin the version tested on the owner's PC
    needs: ['Install DeepSeek Harness so that dsh.exe is on the PATH, and set DEEPSEEK_API_KEY.'],
  },
};

const INIT_MS = 20_000;          // the handshake and the first session
const PROBE_MS = 10_000;         // readiness: one handshake
const PROBE_TTL_MS = 60_000;     // what a probe learned is good for this long
const CANCEL_MS = 10_000;        // after session/cancel, the turn ends here even when the agent never answers
const TERMINAL_MS = 10 * 60_000; // the longest an agent's terminal runs
const MAX_LINE = 8_000_000;      // characters of one JSON-RPC line; more is dropped
const MAX_ATTACH_CHARS = 9_000_000;
const STOP_WORDS = {
  max_tokens: 'The agent reached its token limit.',
  max_turn_requests: 'The agent used all the steps of one turn.',
  refusal: 'The agent refused to go on.',
};
// ACP tool kinds as the tool names risk.mjs, payload.mjs and vocab.js know.
const KIND_TOOL = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Grep', execute: 'Bash', fetch: 'WebFetch', think: 'Think', switch_mode: 'SwitchMode' };
const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

const textOf = (e) => String((e && e.message) || e || 'unknown error');
function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }
const REFUSED = -32000; // the office said no (a path outside the root, a declined call)

const WIN = process.platform === 'win32';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
// cmd.exe has no way to keep these as plain text inside quotes: it ignores \" when it tracks quotes (so a quote in an
// argument ends the quoted part, and & | < > after it run as commands), it expands %NAME% and !NAME! inside quotes, and a
// line break ends the command. sh in single quotes keeps everything but NUL.
const CMD_UNQUOTABLE = /["%!\r\n\0]/;
// One argument as the shell reads it: cmd.exe on Windows (local-tools runs cmd /d /s /c), sh elsewhere. An argument the
// shell would read as more than text is refused: the agent can put that text in the command, where the user reads it as is.
function quoteArg(a) {
  const s = String(a);
  if (WIN ? CMD_UNQUOTABLE.test(s) : s.includes('\0')) {
    throw rpcError(-32602, `The office cannot pass the argument ${clip(JSON.stringify(s), 60)} as plain text to the shell. Put that text in the command.`);
  }
  // Trailing backslashes are doubled so they do not escape the closing quote for the program (C runtime rules).
  if (WIN) return s && !/[\s&|<>^()%!,;=]/.test(s) ? s : '"' + s.replace(/(\\+)$/, '$1$1') + '"';
  return s && /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}
/**
 * The one command line of an ACP terminal/create: command, then its args quoted, after the variables it sets. The user
 * approves this text and the office runs this text, so no variable hides from the approval. A variable name that is not a
 * plain name, a value with a quote or a line break (on Windows also % or !), or an argument the shell cannot take as plain
 * text (quoteArg) is refused.
 */
export function commandLine({ command, args = [], env = [] } = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) throw rpcError(-32602, 'command is empty.');
  const sets = (Array.isArray(env) ? env : []).map((e) => {
    const name = String(e?.name ?? ''), value = String(e?.value ?? '');
    if (!ENV_NAME.test(name) || (WIN ? CMD_UNQUOTABLE : /[\r\n"\0]/).test(value)) {
      throw rpcError(-32602, `The office does not set the variable ${clip(name, 40)} that way. Use a plain name and a value without quotes${WIN ? ', % or !' : ''}.`);
    }
    return WIN ? `set "${name}=${value}" && ` : `${name}=${quoteArg(value)} `;
  });
  return sets.join('') + [cmd, ...(Array.isArray(args) ? args : []).map(quoteArg)].join(' ');
}

/**
 * A JSON-RPC 2.0 channel on a child's stdio, one message per line. onRequest(method, params) answers with a value or a
 * promise (an error becomes the error answer); onNotify(method, params) gets notifications.
 */
function channel(child, { onRequest, onNotify }) {
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
function within(p, ms, why, setTimer, clearTimer) {
  let t;
  const late = new Promise((_r, reject) => { t = setTimer(() => reject(new Error(why)), ms); });
  return Promise.race([p, late]).finally(() => clearTimer(t));
}

/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {string} deps.kind a key of AGENTS.
 * @param {Function} [deps.spawn] child_process.spawn.  @param {Function} [deps.execFile] child_process.execFile (taskkill).
 * @param {(name: string) => string} [deps.exe] the program resolver: an absolute path, or it throws (git.mjs resolveExe).
 * @param {object} [deps.env] the environment for the agent (process.env).
 * @param {(root: string) => object} [deps.makeTools] createLocalTools.
 * @param {Function} [deps.setTimer] setTimeout.  @param {Function} [deps.clearTimer] clearTimeout.
 * @param {() => number} [deps.now] the clock.  @param {() => string} [deps.makeId] ids for messages and terminals.
 * @param {string} [deps.probeDir] the folder readiness starts the agent in (the temp folder).
 */
export function createAcp(deps) {
  const spec = AGENTS[deps.kind];
  if (!spec) throw new Error(`Unknown ACP agent: ${deps.kind}`);
  const kind = deps.kind, label = spec.label;
  const events = deps.events;
  const spawn = deps.spawn || realSpawn;
  const execFile = deps.execFile || realExecFile;
  const env = deps.env || process.env;
  const exe = deps.exe || ((name) => resolveExe(name, env));
  const makeTools = deps.makeTools || ((root) => createLocalTools(root));
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const now = deps.now || Date.now;
  const makeId = deps.makeId || (() => crypto.randomBytes(5).toString('hex'));
  const probeDir = deps.probeDir || os.tmpdir();
  /** @type {Map<string, object>} uid -> the agent state of an open session */
  const agents = new Map();
  // What the agent said at its last handshake (a probe or a session): its capabilities and version.
  let learned = { caps: null, version: null, at: 0, ok: false, why: '' };

  // The absolute path of the program, or a status error the user can act on (409).
  function program() {
    try { return exe(spec.program); } catch (e) {
      if (e.code === 'SCRIPT_INSTALL') throw providerError(409, `The office needs ${spec.program}.exe. It found only ${e.file} (a script install). The office starts programs without a shell.`);
      throw providerError(409, `The office cannot find ${label}: ${spec.program}.exe is not on the PATH. Install it, then try again.`);
    }
  }
  function remember(init) {
    const caps = init && typeof init.agentCapabilities === 'object' && init.agentCapabilities ? init.agentCapabilities : {};
    learned = { caps, version: String(init?.agentInfo?.version || '') || null, at: now(), ok: true, why: '' };
  }
  // readiness and learn(): one handshake with the agent in a temp folder, then it stops. A failure is kept like an answer.
  let probing = null;
  async function probe() {
    let file;
    try { file = program(); } catch (e) { learned = { caps: null, version: null, at: now(), ok: false, why: e.message }; return; }
    let child;
    try { child = spawn(file, spec.args, { cwd: probeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env } }); } catch (e) {
      learned = { caps: null, version: null, at: now(), ok: false, why: textOf(e) };
      return;
    }
    let err = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => { err = (err + d).slice(-600); });
    const rpc = channel(child, { onRequest: () => { throw rpcError(-32601, 'Method not found'); }, onNotify: () => {} });
    const gone = new Promise((_r, reject) => {
      child.on('error', (e) => reject(e));
      child.on('exit', (code) => reject(new Error(clip(err.trim(), 300) || `it stopped with exit code ${code}`)));
    });
    try {
      remember(await within(Promise.race([handshake(rpc), gone]), PROBE_MS, 'no answer in time', setTimer, clearTimer));
    } catch (e) {
      learned = { caps: null, version: null, at: now(), ok: false, why: textOf(e) };
    } finally {
      gone.catch(() => {});
      rpc.fail('probe over');
      if (child.pid) killTree(child.pid, execFile);
    }
  }
  const handshake = (rpc) => rpc.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'agent-office', title: 'Agent Office', version: '0.1.0' },
  });

  // ----- reporting -----
  // Every report goes through emit(): after close, nothing more is reported (the seam's timing rule 2).
  const emit = (st, fn) => (st.closed ? undefined : fn());
  // A message the user sent while a turn ran comes back as the answer of a hook. ACP has no way to add it to a turn that
  // runs, so it waits in st.notes and goes to the agent as the next prompt of the same turn.
  const noteOf = (back) => back?.hookSpecificOutput?.additionalContext || '';
  function hook(s, st, p) {
    const back = emit(st, () => events.hook(s, p));
    if (noteOf(back) && p.hook_event_name !== 'UserPromptSubmit') st.notes.push(noteOf(back));
    return back;
  }

  // The text of the agent's message so far goes out as one assistant message when a tool starts or the turn ends.
  function flushText(s, st) {
    if (!st.text) return;
    const text = st.text;
    st.text = '';
    st.last = text;
    emit(st, () => events.stream(s, { type: 'assistant', message: { id: 'm' + makeId(), content: [{ type: 'text', text }] } }));
  }
  function onText(s, st, u) {
    const t = u.content && u.content.type === 'text' ? String(u.content.text || '') : '';
    if (!t) return;
    if (u.messageId && st.msgId && u.messageId !== st.msgId) flushText(s, st);
    if (u.messageId) st.msgId = u.messageId;
    if (!st.text) emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'message_start' } }));
    st.text += t;
    emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } }));
  }

  // ----- tool calls -----
  // An ACP tool call as the tool name and input that the tracker, risk.mjs and payload.mjs know. A call keeps what it learned
  // in st.calls, because an update brings only the fields that changed. The kind picks the name; a kind the office does not
  // know is 'Tool', so riskOf rates it medium whatever name the agent gives it.
  function track(st, tc = {}) {
    const id = typeof tc.toolCallId === 'string' && tc.toolCallId ? tc.toolCallId : null;
    if (!id) return null;
    // held: request id -> what its card showed (frozen). approved: what the card showed when the user approved it.
    const c = st.calls.get(id) || { id, kind: 'other', title: '', path: null, raw: {}, opened: false, done: false, asked: false, served: false, held: new Map(), approved: null };
    if (typeof tc.kind === 'string') c.kind = tc.kind;
    if (typeof tc.title === 'string' && tc.title) c.title = clip(tc.title, 300);
    if (tc.rawInput && typeof tc.rawInput === 'object' && !Array.isArray(tc.rawInput)) c.raw = tc.rawInput;
    const loc = Array.isArray(tc.locations) ? tc.locations.find((l) => l && typeof l.path === 'string' && l.path) : null;
    if (loc) c.path = loc.path;
    if (Array.isArray(tc.content) && tc.content.some((x) => x && x.type === 'terminal' && st.terminalIds.has(x.terminalId))) c.served = true;
    const raw = c.raw, str = (v) => (typeof v === 'string' && v ? v : undefined);
    c.tool_name = KIND_TOOL[c.kind] || 'Tool';
    const file = c.path || str(raw.file_path) || str(raw.path) || str(raw.filePath);
    const command = Array.isArray(raw.command) ? raw.command.map(String).join(' ') : str(raw.command);
    const input = c.tool_name === 'Bash' ? { command: command || c.title }
      : c.tool_name === 'Grep' ? { pattern: str(raw.pattern) || str(raw.query) || c.title, path: file }
      : c.tool_name === 'WebFetch' ? { url: str(raw.url) || c.title }
      : KIND_TOOL[c.kind] && c.kind !== 'think' && c.kind !== 'switch_mode' ? { file_path: file }
      : { description: c.title };
    c.tool_input = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    st.calls.set(id, c);
    return c;
  }
  // What the user sees of a call: its tool and input. A request is answered for this, never for what the call says later.
  const sigOf = (c) => JSON.stringify([c.tool_name, c.tool_input]);
  const what = (c) => clip(String(c.tool_input.command || (c.tool_input.file_path && path.basename(String(c.tool_input.file_path))) || c.tool_input.url || c.tool_input.pattern || c.title || c.tool_name), 100);
  // The agent changed a call after the user saw it. While a request for it waits, that request is declined at once (the
  // user cannot approve what the card no longer shows), and the files of both forms ask first for the rest of the turn.
  // After an approval, the feed says so: the agent runs its own tool with the new input, which the office cannot stop.
  function recheck(s, st, c) {
    const sig = sigOf(c);
    for (const [id, shown] of [...c.held]) {
      if (shown.sig === sig) continue;
      if (c.tool_input.file_path && EDIT_KINDS.has(c.kind)) st.askFirst.add(norm(st, c.tool_input.file_path));
      withdraw(s, st, id, `${label} changed the call while it waited for your answer, so the office declined it: ${what(c)}`);
    }
    if (c.approved && !c.approved.told && c.approved.sig !== sig) {
      c.approved.told = true;
      emit(st, () => events.feed(s, 'wait', `${label} changed the call after you approved it: ${what(c)}`));
    }
  }
  function openCall(s, st, c) {
    if (c.opened) return;
    c.opened = true;
    hook(s, st, { hook_event_name: 'PreToolUse', tool_name: c.tool_name, tool_use_id: c.id, tool_input: c.tool_input });
  }
  function endCall(s, st, c, u) {
    if (c.done) return;
    c.done = true;
    // The agent finished a call the user has not answered yet: it did not wait (Hermes stops after its own time).
    for (const id of [...c.held.keys()]) withdraw(s, st, id, `${label} moved on without your answer.`);
    // What the user approved for this call is used up: a later command or write with the same text asks again.
    for (const [key, callId] of [...st.grants]) if (callId === c.id) st.grants.delete(key);
    const file = c.tool_input.file_path ? norm(st, c.tool_input.file_path) : null;
    // Hermes #31682: an edit the user declined can come back through another of the agent's own tools. The office cannot
    // stop the agent's own tools, so it says so when one reports that file changed.
    if (u.status === 'completed' && EDIT_KINDS.has(c.kind) && file && st.denied.has(file)) {
      emit(st, () => events.feed(s, 'wait', `${label} changed ${path.basename(String(c.tool_input.file_path))} after you declined that edit.`));
    } else if (u.status === 'completed' && !c.asked && !c.served) {
      if (c.kind === 'execute') emit(st, () => events.feed(s, 'wait', `${label} ran a command without asking the office: ${clip(c.tool_input.command || c.title, 100)}`));
      else if (EDIT_KINDS.has(c.kind) && !(file && st.wrote.has(file))) {
        emit(st, () => events.feed(s, 'wait', `${label} changed ${path.basename(String(c.tool_input.file_path || c.title))} without asking the office.`));
      }
    }
    const said = (Array.isArray(u.content) ? u.content : []).map((x) => (x?.type === 'content' && x.content?.type === 'text' ? x.content.text : '')).find(Boolean);
    const base = { tool_name: c.tool_name, tool_use_id: c.id, tool_input: c.tool_input };
    if (u.status === 'completed') hook(s, st, { hook_event_name: 'PostToolUse', ...base });
    else hook(s, st, { hook_event_name: 'PostToolUseFailure', ...base, error: clip(String(said || 'Failed'), 240), is_interrupt: st.interrupted });
  }

  // ----- approvals -----
  const CANCELLED = { outcome: { outcome: 'cancelled' } };
  const pick = (o) => ({ outcome: { outcome: 'selected', optionId: o.optionId } });
  const norm = (st, p) => fileKey(st.root, p);
  // The office answers request id itself, without the user: the agent stopped waiting for it, or changed the call it asks
  // about. A request of the agent gets reject once (verdict 'withdraw'), never cancelled: in ACP that means the turn was
  // cancelled. The hold goes (events.drop: the server frees it, and provider.answer then finds nothing), and the feed says why.
  function withdraw(s, st, id, why) {
    const ask = st.asks.get(id);
    if (!ask) return;
    ask.gaveUp = true;
    ask.done('withdraw');
    emit(st, () => events.drop(s, id, why));
  }
  // Hold a request until the user answers. done(verdict) gets 'allow', 'deny', 'cancel' or 'withdraw'.
  function hold(s, st, toolName, input, done) {
    const id = emit(st, () => events.permission(s, { tool_name: toolName, tool_input: input, permission_suggestions: [] }));
    if (!id) { done('deny'); return null; }
    const ask = { gaveUp: false, timer: null, done: (v) => { if (st.asks.get(id) !== ask) return; st.asks.delete(id); if (ask.timer) clearTimer(ask.timer); done(v); } };
    st.asks.set(id, ask);
    return id;
  }
  function cancelAsks(st) { for (const ask of [...st.asks.values()]) { ask.gaveUp = true; ask.done('cancel'); } }

  // session/request_permission: held like any request. The answer is allow once or reject once, never an always option.
  // It is the answer to what the card showed: a frozen copy of the call (shown) gives the grant and the declined file.
  function onPermission(s, st, params) {
    const c = track(st, params.toolCall);
    if (!c) throw rpcError(-32602, 'The request names no tool call.');
    recheck(s, st, c); // a second request for a call that changed: the first one goes
    openCall(s, st, c);
    c.asked = true;
    const options = (Array.isArray(params.options) ? params.options : []).filter((o) => o && typeof o.optionId === 'string');
    const once = options.find((o) => o.kind === 'allow_once'), no = options.find((o) => o.kind === 'reject_once');
    if (!once && options.some((o) => o.kind === 'allow_always')) {
      emit(st, () => events.feed(s, 'wait', `${label} offers only Always allow for ${c.tool_name} ${c.title}. The office never gives a lasting allow, so Approve declines.`.replace(/\s+\./, '.')));
    }
    if (st.closed || st.interrupted) return CANCELLED;
    const shown = { kind: c.kind, tool_name: c.tool_name, tool_input: { ...c.tool_input }, sig: sigOf(c), told: false };
    shown.file = EDIT_KINDS.has(c.kind) && shown.tool_input.file_path ? norm(st, shown.tool_input.file_path) : null;
    return new Promise((resolve) => {
      let id = null;
      id = hold(s, st, shown.tool_name, shown.tool_input, (v) => {
        if (id) c.held.delete(id);
        if (v === 'allow' && once) { grant(st, shown, c.id); c.approved = shown; resolve(pick(once)); }
        else if (v === 'cancel') resolve(CANCELLED);
        else if (v === 'withdraw' || v === 'allow') {
          // Not the user's no (the agent moved on or changed the call, or offered only Always allow): no refusal, but a
          // write of that file through the office asks first for the rest of the turn.
          if (shown.file) st.askFirst.add(shown.file);
          resolve(no ? pick(no) : CANCELLED);
        } else if (!no) resolve(CANCELLED);
        else {
          // A declined edit: that file is refused for the rest of the turn. One that names no file makes every write ask.
          if (shown.file) st.denied.add(shown.file);
          else if (EDIT_KINDS.has(shown.kind)) st.deniedVague = true;
          resolve(pick(no));
        }
      });
      if (!id) return;
      c.held.set(id, shown);
      // Hermes issue #63302: its edit approval stops after a fixed time (a command approval follows its own setting). When
      // the agent reports the call as failed first, endCall frees the hold the same way.
      if (spec.askTimeoutMs && EDIT_KINDS.has(c.kind)) {
        const ask = st.asks.get(id);
        ask.timer = setTimer(() => withdraw(s, st, id, `${label} waits ${Math.round(spec.askTimeoutMs / 1000)} s for an answer to an edit. It moved on without yours.`), spec.askTimeoutMs);
      }
    });
  }
  // An approved call lets the office serve that same command or that same file's write once, without a second prompt, until
  // that call ends (endCall). The keys come from what the card showed.
  function grant(st, shown, callId) {
    if (shown.tool_name === 'Bash' && shown.tool_input.command) st.grants.set('Bash\n' + shown.tool_input.command, callId);
    if (shown.file) st.grants.set('Write\n' + shown.file, callId);
  }

  // ----- what the office serves: files and terminals (local-tools.mjs, limited to the root) -----
  // A call the office runs for the agent is refused when its path is outside the root (before anyone is asked), runs at once
  // when riskOf rates it low or the user just approved that same call, and is held otherwise.
  function allowed(s, st, toolName, input) {
    const file = toolName === 'Write' ? norm(st, input.file_path) : null;
    // The user declined an edit of a file the office could not name, or a request for this file went unanswered.
    const strict = toolName === 'Write' && (st.deniedVague || st.askFirst.has(file));
    if (!strict && riskOf(toolName, input, st.root) === 'low') return Promise.resolve(true);
    const key = toolName === 'Bash' ? 'Bash\n' + input.command : 'Write\n' + file;
    if ((toolName === 'Bash' || toolName === 'Write') && st.grants.delete(key)) return Promise.resolve(true);
    if (st.closed || st.interrupted) return Promise.resolve(false);
    return new Promise((resolve) => { hold(s, st, toolName, input, (v) => resolve(v === 'allow')); });
  }
  const declined = () => rpcError(REFUSED, 'Declined from Agent Office.');
  const short = (p) => clip(String(p), 120);

  async function serveRead(s, st, p) {
    const input = { file_path: String(p.path || '') };
    const no = st.tools.guard('Read', input);
    if (no) { emit(st, () => events.feed(s, 'tool', `refused a read outside the worktree: ${short(input.file_path)}`)); throw rpcError(REFUSED, no); }
    if (!(await allowed(s, st, 'Read', input))) throw declined();
    const r = st.tools.readText(input.file_path, { line: p.line, limit: p.limit });
    if (!r.ok) throw rpcError(REFUSED, r.text);
    return { content: r.text };
  }

  async function serveWrite(s, st, p) {
    if (typeof p.content !== 'string') throw rpcError(-32602, 'content must be text.');
    const input = { file_path: String(p.path || ''), content: p.content };
    const no = st.tools.guard('Write', input);
    if (no) { emit(st, () => events.feed(s, 'tool', `refused a write outside the worktree: ${short(input.file_path)}`)); throw rpcError(REFUSED, no); }
    // Hermes issue #31682: an edit the user declined can come back through another write tool. Not through the office.
    if (st.denied.has(norm(st, input.file_path))) {
      emit(st, () => events.feed(s, 'tool', `refused a write to ${path.basename(input.file_path)}: you declined that edit in this turn`));
      throw rpcError(REFUSED, 'You declined the edit of this file in this turn. The office does not write it another way.');
    }
    if (!(await allowed(s, st, 'Write', input))) throw declined();
    const r = await st.tools.run('Write', input);
    if (!r.ok) throw rpcError(REFUSED, r.text);
    st.wrote.add(norm(st, input.file_path));
    emit(st, () => events.feed(s, 'tool', `Write ${path.basename(input.file_path)} (the office wrote it for the agent)`));
    return {};
  }

  // terminal/create: the command line the user sees is the line that runs, variables included. Every command is held
  // (riskOf never rates a shell command low) unless the user just approved that same line in a request.
  async function serveTerminal(s, st, p) {
    const line = commandLine(p);
    const cwd = p.cwd ? String(p.cwd) : st.root;
    const no = st.tools.guard('LS', { path: cwd });
    if (no) { emit(st, () => events.feed(s, 'tool', `refused a command outside the worktree: ${short(cwd)}`)); throw rpcError(REFUSED, no); }
    if (!(await allowed(s, st, 'Bash', { command: line })) || st.closed) throw declined();
    let h;
    try {
      h = st.tools.start(line, { cwd, timeoutMs: TERMINAL_MS, keep: 'end', limitBytes: Number(p.outputByteLimit) > 0 ? Number(p.outputByteLimit) : undefined });
    } catch (e) { throw rpcError(REFUSED, textOf(e)); }
    const id = 'term_' + makeId();
    st.terminals.set(id, h);
    st.terminalIds.add(id);
    emit(st, () => events.feed(s, 'tool', `Bash ${clip(line, 100)} (the office runs it for the agent)`));
    return { terminalId: id };
  }
  function terminalOf(st, p) {
    const h = st.terminals.get(String(p.terminalId));
    if (!h) throw rpcError(-32602, 'Unknown terminal.');
    return h;
  }
  const TERMINAL = {
    'terminal/output': (st, p) => { const h = terminalOf(st, p), x = h.exit(); return { output: h.output(), truncated: h.truncated(), ...(x ? { exitStatus: x } : {}) }; },
    'terminal/wait_for_exit': async (st, p) => { const r = await terminalOf(st, p).done; return { exitCode: r.exitCode, signal: r.signal }; },
    'terminal/kill': (st, p) => { terminalOf(st, p).kill(); return {}; },
    'terminal/release': (st, p) => { terminalOf(st, p).kill(); st.terminals.delete(String(p.terminalId)); return {}; },
  };

  function onUpdate(s, st, params) {
    if (st.closed) return; // a line that comes in while the agent stops: nothing after close (seam timing rule 2)
    if (params.sessionId !== st.sid || st.loading) return; // a loaded session replays its past: the office has those replies
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': onText(s, st, u); break;
      case 'tool_call': case 'tool_call_update': {
        if (u.sessionUpdate === 'tool_call') flushText(s, st);
        const c = track(st, u);
        if (!c) break;
        recheck(s, st, c);
        openCall(s, st, c);
        if (u.status === 'completed' || u.status === 'failed') endCall(s, st, c, u);
        break;
      }
      case 'plan': {
        const todos = (Array.isArray(u.entries) ? u.entries : []).map((e) => ({ content: String(e?.content || ''), status: e?.status }));
        hook(s, st, { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_use_id: null, tool_input: { todos } });
        break;
      }
      default: break; // thoughts, commands, modes, usage: not shown yet
    }
  }

  // ----- a turn -----
  async function runTurn(s, st, item) {
    st.busy = true;
    st.interrupted = false;
    st.last = '';
    const back = hook(s, st, { hook_event_name: 'UserPromptSubmit', prompt: item.text });
    // Messages a stopped turn took from the inbox but could not deliver go first, then any that wait now.
    const notes = [...st.carry.splice(0), noteOf(back)].filter(Boolean);
    let prompt = notes.length ? [...item.prompt, { type: 'text', text: notes.join('\n\n') }] : item.prompt;
    let failure = null;
    try {
      for (;;) {
        st.cancelled = new Promise((resolve) => { st.endCancel = resolve; });
        const r = await Promise.race([st.rpc.request('session/prompt', { sessionId: st.sid, prompt }), st.cancelled]);
        flushText(s, st);
        if (st.closed || st.interrupted) break;
        const why = STOP_WORDS[r?.stopReason];
        if (why) { failure = why; break; }
        if (st.notes.length) { prompt = [{ type: 'text', text: st.notes.splice(0).join('\n\n') }]; continue; }
        const stop = hook(s, st, { hook_event_name: 'Stop', last_assistant_message: st.last });
        if (stop && stop.decision === 'block' && stop.reason) { prompt = [{ type: 'text', text: stop.reason }]; continue; }
        break;
      }
    } catch (e) {
      flushText(s, st);
      if (!st.interrupted && !st.closed) failure = `${label}: ${textOf(e)}`;
    }
    finishTurn(s, st, failure);
  }

  function finishTurn(s, st, failure) {
    st.busy = false;
    st.endCancel = null;
    cancelAsks(st); // an agent that ended its turn waits for nothing
    st.grants.clear(); st.denied.clear(); st.askFirst.clear(); st.wrote.clear(); st.deniedVague = false;
    st.carry.push(...st.notes.splice(0)); // the inbox gave them up already: they go with the next prompt
    if (st.closed) return;
    if (st.interrupted) events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Stopped' });
    else if (failure) events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: failure });
    else events.stream(s, { type: 'result', subtype: 'success', is_error: false, result: st.last });
    // No total_cost_usd: ACP reports no cost, so the session's cost stays unknown, never $0.00.
    const next = st.queue.shift();
    if (next) setImmediate(() => runTurn(s, st, next));
  }

  // ----- requests from the agent -----
  function onRequest(s, st, method, params) {
    if (st.closed) throw rpcError(REFUSED, 'The session closed.');
    if (params.sessionId !== st.sid) throw rpcError(-32602, 'Unknown session.');
    flushText(s, st); // what the agent said before a request shows with it (a request may wait for the user)
    if (method === 'session/request_permission') return onPermission(s, st, params);
    if (method === 'fs/read_text_file') return serveRead(s, st, params);
    if (method === 'fs/write_text_file') return serveWrite(s, st, params);
    if (method === 'terminal/create') return serveTerminal(s, st, params);
    if (TERMINAL[method]) return TERMINAL[method](st, params);
    throw rpcError(-32601, `Method not found: ${method}`);
  }

  // ----- the session -----
  async function start(s, st, o) {
    const init = await within(handshake(st.rpc), INIT_MS, 'it did not answer the handshake in time', setTimer, clearTimer);
    remember(init);
    if (init?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`it speaks ACP version ${init?.protocolVersion}; the office speaks version ${PROTOCOL_VERSION}`);
    st.caps = learned.caps;
    let r, sid;
    if (o.resume && st.caps.loadSession === true) {
      // The agent replays the past conversation as updates before it answers. The office already has those replies
      // (the past record), so the replay is not shown again.
      st.loading = true;
      r = await within(st.rpc.request('session/load', { sessionId: String(o.resume), cwd: s.cwd, mcpServers: [] }), INIT_MS, 'it did not load the past session in time', setTimer, clearTimer);
      st.loading = false;
      sid = String(o.resume);
    } else {
      // Before the session id: the office keeps the past record of a conversation that did not continue.
      if (o.resume) emit(st, () => events.fresh(s, `${label} cannot load a past session now. A new session started.`));
      r = await within(st.rpc.request('session/new', { cwd: s.cwd, mcpServers: [] }), INIT_MS, 'it did not start a session in time', setTimer, clearTimer);
      sid = r && r.sessionId;
    }
    if (typeof sid !== 'string' || !sid) throw new Error('it gave no session id');
    st.sid = sid;
    // The session id first (the tracker saves the session when its sid arrives), then the bot sits down at rest.
    emit(st, () => events.stream(s, { type: 'system', subtype: 'init', session_id: sid, model: r.models?.currentModelId || null, permissionMode: 'default' }));
    // With a first prompt waiting, the turn starts at once instead (no flicker from at rest to working).
    if (!st.queue.length) hook(s, st, { hook_event_name: 'SessionStart', source: o.resume ? 'resume' : 'startup' });
    const next = st.queue.shift();
    if (next && !st.closed) runTurn(s, st, next);
  }

  function promptOf(st, text, attachments) {
    const blocks = [];
    let total = 0;
    for (const a of attachments.slice(0, 6)) {
      const data = String(a.data || '');
      total += data.length;
      if (total > MAX_ATTACH_CHARS) throw providerError(413, 'The attachments are too large. The limit is about 6 MB in total.');
      const mime = String(a.mime || ''), name = String(a.name || 'file').slice(0, 80);
      if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
        if (!st.caps) throw providerError(409, `${label} is still starting. Send the image again in a moment.`);
        if (st.caps.promptCapabilities?.image !== true) throw providerError(415, `${label} takes no images.`);
        blocks.push({ type: 'image', mimeType: mime, data });
      } else if (/^text\//.test(mime) || /\.(md|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|css|html|csv|log|yml|yaml|toml|xml|sh|ps1|sql)$/i.test(name)) {
        blocks.push({ type: 'text', text: `Attached file ${name}:\n\`\`\`\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 200000)}\n\`\`\`` });
      } else throw providerError(415, `Cannot attach ${name}. Attach images or text files.`);
    }
    if (text) blocks.push({ type: 'text', text });
    return blocks;
  }

  return {
    kind,
    label,
    paid: true,       // the agent runs on the user's own model account
    cost: 'unknown',  // ACP reports no cost: the office asks once per session and shows "unknown"
    // gated (ADR 0001): an agent that runs some calls without asking is not, whatever the office holds of what it does ask.
    gated: spec.gated === true,
    ...(spec.gated === true ? {} : { supervision: spec.supervision || 'Unsupervised' }),
    get canResume() { return learned.caps?.loadSession === true; },
    get features() {
      const f = [];
      if (learned.caps?.loadSession === true) f.push('resume');
      if (learned.caps?.promptCapabilities?.image === true) f.push('images');
      return [...f, ...spec.features];
    },
    spec,

    async readiness() {
      try { program(); } catch (e) { return { ready: false, version: null, needs: [e.message, ...spec.needs] }; }
      await this.learn();
      if (!learned.ok) return { ready: false, version: null, needs: [`${label} did not answer the ACP handshake: ${learned.why}`, ...spec.needs] };
      const needs = spec.pin && learned.version !== spec.pin ? [`The office was tested with ${label} ${spec.pin}. This is ${learned.version || 'an unknown version'}.`] : [];
      return { ready: true, version: learned.version || 'unknown', needs };
    },

    // One handshake with the agent in a temp folder, then it stops. What it says is kept for a minute, and calls that
    // overlap share one probe.
    learn() {
      if (learned.at && now() - learned.at < PROBE_TTL_MS) return Promise.resolve();
      if (!probing) probing = probe().finally(() => { probing = null; });
      return probing;
    },

    async models() { return []; }, // the agent picks its model in its own settings

    // Before the office makes a worktree or a session. check({}) checks only that a session can start (Reopen).
    check(o = {}) {
      program();
      if (o.model) throw providerError(400, `${label} picks its model in its own settings. Leave the model empty.`);
      if (o.permissionMode && o.permissionMode !== 'default') throw providerError(400, `${label} runs with the office's approvals only. Leave the permission mode empty.`);
    },
    open(s, o = {}) {
      let file, child;
      // A missing program or a spawn that throws: the session says why and ends, on a later tick (seam timing rule 1).
      try {
        file = program();
        child = spawn(file, spec.args, { cwd: s.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, OFFICE_ID: s.officeId } });
      } catch (e) {
        setImmediate(() => { events.reply(s, `Could not start ${label}: ${textOf(e)}`); events.end(s, 'could not start'); });
        return;
      }
      s.pid = child.pid;
      const root = s.worktree?.root || s.startDir || s.cwd;
      const st = {
        child, root, tools: makeTools(root), sid: null, caps: null, busy: false, closed: false, interrupted: false, failed: false,
        loading: false, queue: [], notes: [], carry: [], text: '', last: '', msgId: null, cancelled: null, endCancel: null, err: '',
        calls: new Map(),        // toolCallId -> what the office knows of the call
        asks: new Map(),         // request id -> a held request: the agent's own, or a file or command the office serves
        grants: new Map(),       // this turn: 'Bash\n<line>' or 'Write\n<fileKey>' the user approved -> its toolCallId; served once
        denied: new Set(),       // this turn: files whose edit the user declined (fileKey); a write to them is refused at once
        askFirst: new Set(),     // this turn: files whose edit request went unanswered or changed; a write to them asks first
        deniedVague: false,      // this turn: the user declined an edit that named no file, so every write asks first
        wrote: new Set(),        // this turn: files the office wrote for the agent
        terminals: new Map(),    // terminalId -> a running or finished command (local-tools start())
        terminalIds: new Set(),  // every terminal id the office gave out
      };
      st.rpc = channel(child, {
        onRequest: (method, params) => onRequest(s, st, method, params),
        onNotify: (method, params) => { if (method === 'session/update') onUpdate(s, st, params); },
      });
      agents.set(s.uid, st);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { st.err = (st.err + d).slice(-1500); });
      child.on('error', (e) => {
        st.dead = true; st.rpc.fail('The agent stopped.');
        if (st.closed || st.failed) return;
        st.failed = true;
        events.reply(s, `Could not start ${label}: ${e.message}`);
        events.end(s, 'could not start');
      });
      child.on('exit', (code) => {
        st.dead = true; st.rpc.fail('The agent stopped.');
        st.tools.stop();
        if (st.closed) return; // the office closes it: the close ends the session
        if (!st.sid && !st.failed) events.reply(s, `${label} stopped before it started: ` + (clip(st.err.trim(), 400) || 'exit code ' + code));
        events.end(s, code ? `exited (${code})` : 'finished');
      });
      start(s, st, o).catch((e) => {
        if (st.closed || st.dead) return;
        st.failed = true;
        events.reply(s, `${label} could not start a session: ${textOf(e)}`);
        killTree(child.pid, execFile); // the exit ends the session
      });
    },

    message(s, { text = '', attachments = [] } = {}) {
      const st = agents.get(s.uid);
      if (!st || st.closed || st.dead) throw providerError(409, 'That session is not running.');
      const item = { text: String(text), prompt: promptOf(st, String(text), attachments) };
      if (st.busy || !st.sid) st.queue.push(item);
      else setImmediate(() => runTurn(s, st, item));
    },

    // The user's decision on a request this provider holds. No decision ({}) is a decline (reject once), unless the agent no
    // longer waits for it or the turn is being stopped: then the answer is cancelled.
    answer(s, request, d = {}) {
      const st = agents.get(s.uid);
      const ask = st && st.asks.get(request?.id);
      if (!ask) return;
      ask.done(d.allow === true ? 'allow' : d.allow === false ? 'deny' : ask.gaveUp || st.interrupted || st.closed ? 'cancel' : 'deny');
    },

    interrupt(s) {
      const st = agents.get(s.uid);
      if (!st || !st.busy) return;
      st.interrupted = true;
      st.queue.length = 0;
      st.rpc.notify('session/cancel', { sessionId: st.sid });
      cancelAsks(st); // ACP: every request that waits gets the cancelled outcome
      st.tools.stop();
      // The agent answers the prompt with stopReason cancelled. One that never does still ends the turn.
      const end = st.endCancel;
      setTimer(() => { if (end && st.endCancel === end) end({ stopReason: 'cancelled' }); }, CANCEL_MS);
    },

    // The agent and its commands stop. While it closes, its exit reports nothing: the office ends the session.
    close(s) {
      const st = agents.get(s.uid);
      agents.delete(s.uid);
      if (!st) return Promise.resolve();
      st.closed = true;
      cancelAsks(st);
      st.tools.stop();
      st.rpc.fail('The session closed.');
      if (st.endCancel) st.endCancel({ stopReason: 'cancelled' });
      if (st.dead || !st.child.pid) return Promise.resolve();
      return new Promise((resolve) => {
        st.child.once('exit', () => resolve());
        killTree(st.child.pid, (file, args, opts, cb) => execFile(file, args, opts, (...a) => { cb(...a); setTimer(resolve, 2000); }));
      });
    },
  };
}
