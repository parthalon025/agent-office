// What the office serves an ACP agent: its files and terminals (#176). The agent's fs/read_text_file, fs/write_text_file and
// terminal/* calls run here with providers/local-tools.mjs, limited to the session's root. A path outside the root is refused
// before anyone is asked; every other call goes to the office through the ask module (the Security room rules, then a hold).
// The permission policy (acp-policy.mjs) writes what this module reads from the session state: st.grants (an approved call
// runs once), st.denied, st.deniedVague and st.askFirst (a declined or unanswered edit), and this module writes st.wrote and
// st.terminals / st.terminalIds.
//
// Interface: createFiles({ events, asks, emit, makeId }) -> { handles(method), serve(s, st, method, params) -> Promise|value };
// commandLine({ command, args, env }) (the one line a terminal runs, quoted for the shell it runs in).
import path from 'node:path';
import { fileKey } from '../risk.mjs';
import { clip } from '../tracker.mjs';
import { rpcError, textOf, REFUSED } from './acp-rpc.mjs';

const TERMINAL_MS = 10 * 60_000; // the longest an agent's terminal runs

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


export function createFiles({ events, asks, emit, makeId }) {
  const norm = (st, p) => fileKey(st.root, p);
  // ----- what the office serves: files and terminals (local-tools.mjs, limited to the root) -----
  // A call the office runs for the agent is refused when its path is outside the root (before anyone is asked), and runs at once
  // when the user just approved that same call. Every other call goes to the office like a local agent's (#70): the Security
  // room rules decide (by default every call is held until the user answers; a cell the user set to Allow or Deny answers it), else it is held. So
  // this file keeps no approval rule of its own. Returns { ok, why }: why the office refused, for the agent.
  function allowed(s, st, toolName, input) {
    const file = toolName === 'Write' ? norm(st, input.file_path) : null;
    // The user declined an edit of a file the office could not name, or a request for this file went unanswered: the user
    // answers this write (firm), whatever an Allow rule says.
    const strict = toolName === 'Write' && (st.deniedVague || st.askFirst.has(file));
    const key = toolName === 'Bash' ? 'Bash\n' + input.command : 'Write\n' + file;
    if ((toolName === 'Bash' || toolName === 'Write') && st.grants.delete(key)) return Promise.resolve({ ok: true });
    if (st.closed || st.interrupted) return Promise.resolve({ ok: false });
    return new Promise((resolve) => { asks.hold(s, st, { tool_name: toolName, tool_input: input, ask_reason: null }, (v, why) => resolve({ ok: v === 'allow', why }), { firm: strict }); });
  }
  const declined = (why) => rpcError(REFUSED, why || 'Declined from Agent Office.');
  const short = (p) => clip(String(p), 120);

  async function serveRead(s, st, p) {
    const input = { file_path: String(p.path || '') };
    const no = st.tools.guard('Read', input);
    if (no) { emit(st, () => events.feed(s, 'tool', `refused a read outside the worktree: ${short(input.file_path)}`)); throw rpcError(REFUSED, no); }
    const a = await allowed(s, st, 'Read', input);
    if (!a.ok) throw declined(a.why);
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
    const a = await allowed(s, st, 'Write', input);
    if (!a.ok) throw declined(a.why);
    const r = await st.tools.run('Write', input);
    if (!r.ok) throw rpcError(REFUSED, r.text);
    st.wrote.add(norm(st, input.file_path));
    emit(st, () => events.feed(s, 'tool', `Write ${path.basename(input.file_path)} (the office wrote it for the agent)`));
    return {};
  }

  // terminal/create: the command line the user sees is the line that runs, variables included. Every command goes to the office
  // (the Shell commands rule: Ask by default holds it) unless the user just approved that same line in a request.
  async function serveTerminal(s, st, p) {
    const line = commandLine(p);
    const cwd = p.cwd ? String(p.cwd) : st.root;
    const no = st.tools.guard('LS', { path: cwd });
    if (no) { emit(st, () => events.feed(s, 'tool', `refused a command outside the worktree: ${short(cwd)}`)); throw rpcError(REFUSED, no); }
    const a = await allowed(s, st, 'Bash', { command: line });
    if (!a.ok || st.closed) throw declined(a.why);
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

  const METHODS = { 'fs/read_text_file': serveRead, 'fs/write_text_file': serveWrite, 'terminal/create': serveTerminal, ...TERMINAL };
  return {
    handles: (method) => Object.hasOwn(METHODS, method),
    serve: (s, st, method, params) => (Object.hasOwn(TERMINAL, method) ? TERMINAL[method](st, params) : METHODS[method](s, st, params)),
  };
}
