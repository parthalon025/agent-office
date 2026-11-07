// The headless command-line tools that speak neither ACP nor hooks (#217, Paperclip HQ 26/27): Cursor CLI, Grok CLI and Pi.
// One factory for the family, like providers/acp.mjs: each tool is an entry in TOOLS, not a new file. A turn is one process: the
// program starts with the prompt, prints JSON lines, and exits. The office starts it by its absolute path (launch.mjs resolveExe),
// in the session folder, and reads the lines into the tracker's vocabulary (providers/index.mjs). Spawn, execFile and the resolver
// are injected, so tests run a fake CLI (test/fixtures/fake-cli.mjs). Nothing starts on import.
//
// Supervision, honestly (ADR 0001). None of the three has a hook or an approval channel the office can answer:
//   cursor-agent -p and grok --single run their tools on their own rules (the office passes no --yolo, --force or --always-approve,
//   so what they refuse in a headless run stays refused); pi has no approval step at all. So every kind is ungated, "Unsupervised",
//   off until the user turns it on in the Security room (Agents screen), and opens only in a room of its own. The tool's own
//   report is all the office has: the feed says so. Cost: Cursor and Grok print a dollar figure only in some versions, Pi per
//   message; none is promised, so cost is 'unknown' (the office asks once, no spend limit can stop it).
// Codex is not here: it has an ACP bridge (codex-acp), so it is an entry of the ACP list in providers/acp.mjs.
//
// This file owns the three tools, one entry each in TOOLS, and createCliTool({ events, kind }).
// - One process per turn: the program starts by resolveExe in the session folder with the prompt (stdin for cursor, an argument
//   for grok and pi), prints JSON lines, and exits. read(msg) of each entry turns a line into items (sid, text, tool, done,
//   usage, error, end), which the provider reports as tracker hooks and stream lines.
// - Every kind is gated: false, "Unsupervised", cost: 'unknown', canResume: false. The office passes no approve switch (--yolo,
//   --force, --always-approve). A prompt that starts with a dash gets a space first. Only Pi shows its tool calls (the others say
//   so in the feed).
// - The three share the Security room column cli (CLI tools, with Codex, an entry of the ACP list: codex-acp, ungated).
// - Tested in test/cli-tools.test.mjs with test/fixtures/fake-cli.mjs.
//
// What each tool prints is learned from Paperclip's adapters (packages/adapters/cursor-local, grok-local, pi-local, parse.ts and
// execute.ts; MIT, Copyright (c) 2025 Paperclip AI, credit in NOTICE.md). Not recorded from a run of the real tools: none of them is
// installed on the owner's PC (pi is an npm pi.cmd, which resolveExe refuses). `pin: null` until a real run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn, execFile as realExecFile } from 'node:child_process';
import { resolveExe, killTree, helperCwd } from '../launch.mjs';
import { providerError } from './index.mjs';
import { noteOf } from './local.mjs';

const MODEL_RE = /^[A-Za-z0-9][\w.:/-]{0,99}$/;
const UNSUPERVISED = 'Unsupervised: its tools run without asking the office';
const VERSION_MS = 10_000;
const MAX_LINE = 4_000_000;   // a JSON line longer than this is dropped, never buffered
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const textOf = (e) => (e && e.message) || str(e);
const PI_TOOLS = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob', ls: 'LS' };

/**
 * One tool per entry. program: the name resolveExe finds. args(o): the switches of one turn, before the prompt; o has cwd, model,
 * sid (the tool's own session id from an earlier turn), file (pi's session file). prompt: where the prompt goes ('stdin',
 * 'args', or a function giving the last arguments). read(msg, st): one JSON line as a list of items for the provider:
 *   { sid } { text } { tool: { id, name, input } } { done: { id, error } } { usage: { input, output, cached } } { error } { end }
 * shows: false when the tool prints no tool calls the office could show (the feed says so at the start).
 */
export const TOOLS = {
  cursor: {
    label: 'Cursor CLI', program: 'cursor-agent', shows: false, prompt: 'stdin',
    args: (o) => ['-p', '--output-format', 'stream-json', '--workspace', o.cwd, ...(o.sid ? ['--resume', o.sid] : []), ...(o.model ? ['--model', o.model] : [])],
    read(m) {
      const out = [];
      if (m.session_id) out.push({ sid: str(m.session_id) });
      if (m.type === 'assistant') {
        for (const b of Array.isArray(asObj(m.message).content) ? asObj(m.message).content : []) if (b && (b.type === 'text' || b.type === 'output_text') && b.text) out.push({ text: str(b.text) });
      } else if (m.type === 'result') {
        const u = asObj(m.usage);
        out.push({ usage: { input: num(u.input_tokens ?? u.inputTokens), output: num(u.output_tokens ?? u.outputTokens), cached: num(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens) } });
        if (m.is_error === true || str(m.subtype).toLowerCase() === 'error') out.push({ error: str(m.error ?? m.message ?? m.result) || 'Cursor CLI reported an error.' });
        out.push({ end: true });
      } else if (m.type === 'error' || (m.type === 'system' && str(m.subtype).toLowerCase() === 'error')) out.push({ error: str(m.message ?? m.error ?? m.detail) || 'Cursor CLI reported an error.' });
      return out;
    },
    needs: ['Install Cursor CLI so that cursor-agent.exe is on the PATH, then run cursor-agent login in a terminal.'],
  },
  grok: {
    label: 'Grok CLI', program: 'grok', shows: false, prompt: (p) => ['--single', p],
    args: (o) => ['--cwd', o.cwd, '--output-format', 'streaming-json', ...(o.sid ? ['--resume', o.sid] : []), ...(o.model ? ['--model', o.model] : [])],
    read(m) {
      const out = [];
      if (m.type === 'text' && m.data) out.push({ text: str(m.data) });
      else if (m.type === 'end') {
        if (m.sessionId) out.push({ sid: str(m.sessionId) });
        const u = asObj(m.usage);
        out.push({ usage: { input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens) } });
        out.push({ end: true });
      } else if (m.type === 'error') out.push({ error: str(m.error ?? m.message ?? m.detail ?? m.data) || 'Grok CLI reported an error.' });
      return out;   // "thought" lines are the model's reasoning: not shown
    },
    needs: ['Install Grok CLI so that grok.exe is on the PATH, then run grok login in a terminal.'],
  },
  pi: {
    label: 'Pi', program: 'pi', shows: true, prompt: (p) => [p], session: true,
    args: (o) => ['--mode', 'json', '-p', ...(o.model ? ['--model', o.model] : []), '--tools', 'read,bash,edit,write,grep,find,ls', '--session', o.file],
    read(m) {
      const out = [];
      if (m.type === 'message_update') {
        const e = asObj(m.assistantMessageEvent);
        if (e.type === 'text_delta' && e.delta) out.push({ text: str(e.delta) });
      } else if (m.type === 'tool_execution_start') out.push({ tool: { id: str(m.toolCallId), name: str(m.toolName), input: asObj(m.args) } });
      else if (m.type === 'tool_execution_end') out.push({ done: { id: str(m.toolCallId), error: m.isError === true ? str(m.result) || 'The tool failed.' : '' } });
      else if (m.type === 'turn_end') {
        const msg = asObj(m.message), u = asObj(msg.usage);
        out.push({ usage: { input: num(u.input) + num(u.cacheWrite), output: num(u.output), cached: num(u.cacheRead) } });
        if (msg.stopReason === 'error') out.push({ error: str(msg.errorMessage) || 'Pi provider request failed.' });
      } else if (m.type === 'agent_end') out.push({ end: true });
      else if (m.type === 'error') out.push({ error: str(m.message) || 'Pi reported an error.' });
      return out;
    },
    needs: ['Install Pi so that pi.exe is on the PATH (the npm pi.cmd shim is not accepted), then sign in to a model provider in a terminal.'],
  },
};

/**
 * One CLI tool as a provider. deps: events (providerEvents), kind (a key of TOOLS), exe (the program resolver, default resolveExe),
 * spawn, execFile, env, sessionDir (where pi's session files go; default a folder under the temp folder), makeId.
 */
export function createCliTool(deps) {
  const spec = TOOLS[deps.kind];
  if (!spec) throw new Error(`Unknown CLI tool ${deps.kind}.`);
  const events = deps.events;
  const env = deps.env || process.env;
  const spawn = deps.spawn || realSpawn;
  const execFile = deps.execFile || realExecFile;
  const exe = deps.exe || ((name) => resolveExe(name, env));
  const sessionDir = deps.sessionDir || path.join(os.tmpdir(), 'agent-office-cli');
  const makeId = deps.makeId || (() => crypto.randomBytes(5).toString('hex'));
  const blocked = deps.blocked || (() => null);
  /** @type {Map<string, object>} uid -> the state of an open session */
  const agents = new Map();
  // Every report goes through emit(): after close, nothing more is reported (seam timing rule 2).
  const emit = (st, fn) => (st.closed ? undefined : fn());

  // The program's absolute path, or a StatusError in the user's words (a script install is named, as for the ACP agents).
  function programPath() {
    try { return exe(spec.program); } catch (e) {
      if (e && e.code === 'SCRIPT_INSTALL') throw providerError(409, `${spec.label} is installed as a script (${e.file}). Install the native ${spec.program}.exe so that it is on the PATH.`);
      throw providerError(409, spec.needs[0]);
    }
  }

  function runTurn(s, st, prompt) {
    st.busy = true;
    if (st.interrupted) { finish(s, st, '', ''); return; }   // Stop came before the process started
    const back = emit(st, () => events.hook(s, { hook_event_name: 'UserPromptSubmit', prompt }));
    const text = noteOf(back) ? prompt + '\n\n' + noteOf(back) : prompt;
    let file;
    try { file = programPath(); } catch (e) { finish(s, st, '', textOf(e)); return; }
    // A prompt that starts with a dash is not read as a switch: a space goes first (cursor reads stdin, grok a value).
    const safe = text.startsWith('-') ? ' ' + text : text;
    const argv = [...spec.args({ cwd: s.cwd, model: st.model, sid: st.toolSid, file: st.file }), ...(spec.prompt === 'stdin' ? [] : spec.prompt(safe))];
    let child;
    try { if (st.file) fs.mkdirSync(sessionDir, { recursive: true }); child = spawn(file, argv, { cwd: s.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, OFFICE_ID: s.officeId } }); } catch (e) { finish(s, st, '', `${spec.label} did not start: ${textOf(e)}`); return; }
    st.child = child;
    if (s.pid == null) s.pid = child.pid;
    const turn = { out: '', text: '', error: '', err: '', ended: false, tools: new Map() };
    child.stdin?.on('error', () => {});
    try { child.stdin?.end(spec.prompt === 'stdin' ? safe : undefined); } catch { /* the process is gone */ }
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => { turn.err = (turn.err + d).slice(-2000); });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      turn.out += d;
      let i;
      while ((i = turn.out.indexOf('\n')) >= 0) { line(s, st, turn, turn.out.slice(0, i)); turn.out = turn.out.slice(i + 1); }
      if (turn.out.length > MAX_LINE) turn.out = '';
    });
    let over = false;
    const exit = (code, err) => {
      if (over) return;
      over = true;
      if (turn.out.trim()) line(s, st, turn, turn.out);
      st.child = null;
      if (turn.text.trim()) emit(st, () => events.stream(s, { type: 'assistant', message: { id: 'm' + makeId(), content: [{ type: 'text', text: turn.text }] } }));
      const why = turn.error || (err ? textOf(err) : '') || (code !== 0 && !turn.ended ? (turn.err.trim().split(/\r?\n/).pop() || code == null ? `${spec.label} was stopped.` : `${spec.label} stopped with exit code ${code}.`) : '');
      finish(s, st, turn.text, st.interrupted ? '' : why);
    };
    child.on('error', (e) => exit(null, e));
    child.on('close', (code) => exit(code));
  }

  // One line of the tool's output, as items for the tracker. A line that is not JSON is ignored: a tool may print a banner.
  function line(s, st, turn, raw) {
    const t = raw.trim();
    if (!t || t[0] !== '{') return;
    let m; try { m = JSON.parse(t); } catch { return; }
    for (const it of spec.read(asObj(m))) {
      if (it.sid) st.toolSid = it.sid;
      else if (it.text) {
        turn.text += it.text;
        emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: it.text } } }));
      } else if (it.tool) {
        const name = PI_TOOLS[it.tool.name] || it.tool.name || 'tool';
        turn.tools.set(it.tool.id, name);
        emit(st, () => events.hook(s, { hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: it.tool.id, tool_input: it.tool.input }));
      } else if (it.done) {
        const name = turn.tools.get(it.done.id) || 'tool';
        emit(st, () => events.hook(s, it.done.error
          ? { hook_event_name: 'PostToolUseFailure', tool_name: name, tool_use_id: it.done.id, error: it.done.error }
          : { hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: it.done.id }));
      } else if (it.usage) {
        const u = it.usage;
        if (u.input || u.output || u.cached) emit(st, () => events.stream(s, { type: 'assistant', message: { id: 'u' + makeId(), usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cached }, content: [] } }));
      } else if (it.error) turn.error = it.error;
      else if (it.end) turn.ended = true;
    }
  }

  function finish(s, st, last, failure) {
    st.busy = false;
    if (st.closed) return;
    if (st.interrupted) { st.interrupted = false; events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Stopped' }); }
    else if (failure) events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: failure });
    else events.stream(s, { type: 'result', subtype: 'success', is_error: false, result: last });
    const next = st.queue.shift();
    if (next !== undefined) setImmediate(() => runTurn(s, st, next));
  }

  return {
    kind: deps.kind,
    label: spec.label,
    paid: true,          // a hosted model: it costs money, and says so unreliably
    cost: 'unknown',
    gated: false,        // no hook and no approval channel: ADR 0001
    supervision: UNSUPERVISED,
    canResume: false,    // the tool keeps its session in its own store; Reopen starts a fresh session in the same folder
    features: [],
    // The Security room cells (security.mjs enforcement): nothing reaches the office, so none is enforced; the default reason says so.
    enforces: [],
    askTimeoutMs: null, pin: null, needs: [...spec.needs], programName: spec.program,

    async readiness() {
      let file;
      try { file = programPath(); } catch (e) { return { ready: false, version: null, needs: [textOf(e)] }; }
      return new Promise((resolve) => {
        const bad = () => resolve({ ready: false, version: null, needs: [...spec.needs] });
        try {
          execFile(file, ['--version'], { cwd: helperCwd(env), windowsHide: true, timeout: VERSION_MS }, (err, out) => {
            const v = err ? '' : String(out || '').trim().split(/\r?\n/)[0];
            if (v) resolve({ ready: true, version: v, needs: [] }); else bad();
          });
        } catch { bad(); }
      });
    },

    // The tool picks its own default model; the office lists none (it never reads the tool's account).
    async models() { return []; },

    check(o = {}) {
      if (Object.keys(o).length === 0) { programPath(); return; }
      const why = blocked();
      if (why) throw providerError(409, why);
      if (o.model !== undefined && o.model !== null && o.model !== '' && !(typeof o.model === 'string' && MODEL_RE.test(o.model))) throw providerError(400, 'That model name is not valid.');
      programPath();
    },

    open(s, o = {}) {
      this.check(o);
      const st = { model: o.model || null, toolSid: null, busy: false, closed: false, interrupted: false, child: null, queue: [], file: null };
      if (spec.session) st.file = path.join(sessionDir, `${s.uid.replace(/[^\w-]/g, '_')}-${makeId()}.jsonl`);
      agents.set(s.uid, st);
      // The session shows its model like a Claude Code session does, on a later tick (seam rule 1).
      setImmediate(() => {
        emit(st, () => events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: st.model, permissionMode: 'default' }));
        if (!spec.shows) emit(st, () => events.feed(s, 'note', `${spec.label} does not report its tool calls, so the office shows only its replies.`));
      });
    },

    message(s, { text = '', attachments = [] } = {}) {
      const st = agents.get(s.uid);
      if (!st || st.closed) throw providerError(409, 'That session is not running.');
      if (attachments.length) throw providerError(415, `${spec.label} takes text only.`);
      const prompt = String(text);
      if (st.busy) st.queue.push(prompt);
      else { st.busy = true; st.interrupted = false; setImmediate(() => runTurn(s, st, prompt)); }
    },

    answer() { /* the office holds nothing for this kind: it asks no questions */ },

    interrupt(s) {
      const st = agents.get(s.uid);
      if (!st || !st.busy) return;
      st.interrupted = true;
      st.queue.length = 0;
      if (st.child) killTree(st.child.pid).then(() => { try { st.child?.kill(); } catch { /* gone */ } });
    },

    // Resolves when the process has ended (a room cannot be removed while a process holds it as its folder).
    async close(s) {
      const st = agents.get(s.uid);
      agents.delete(s.uid);
      if (!st) return;
      st.closed = true;
      const child = st.child;
      if (child && child.exitCode == null) {
        const ended = new Promise((r) => child.once('close', r));
        await killTree(child.pid);
        try { child.kill(); } catch { /* gone */ }
        await Promise.race([ended, new Promise((r) => setTimeout(r, 5000))]);
      }
      if (st.file) fs.rm(st.file, { force: true }, () => {});
    },
  };
}
