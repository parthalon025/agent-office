// The built-in tools of a local-model agent: read, list, search, edit, write and run, all limited to one folder (the worktree).
// Names and argument names follow Claude Code's (Read, LS, Grep, Edit, Write, Bash), so risk.mjs rates a call the same way
// and payload.mjs labels it the same way. This module never decides about approval: the caller asks the office first (the Security room rules, then a hold).
// A path outside the folder is refused here also when the user approved the call: the tools are the last fence.
//
// This file owns the tools of a local-model agent (Read, LS, Grep, Edit, Write, Bash), limited to one worktree: inside() plus a
// realpath check, a time limit, and a process-tree kill.
// - The ACP provider reuses them for its agents' files and terminals: readText (whole raw text, refused over 4 MB, never cut),
//   guard (the path fence without running anything) and start (a command handle: output, exit, kill, a byte limit that keeps
//   the end). Bash runs on start.
// - Commands go to cmd /d /s /c "<line>": the outer quotes are the ones /s strips.
// - killTree and stop() return promises. stop() settles when every running command is killed and closed, or after stopWaitMs
//   (2 s; a child that left the tree), so a provider close() waits for it and Remove room does not meet a busy folder (#123).
//   The provider's interrupt() calls stop() without waiting.
// - It never decides approval; the caller asks the office first.
// - Tested in test/local-tools.test.mjs with the fake OpenAI server in test/fixtures/fake-openai.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inside, realInside, isProtectedPart } from '../risk.mjs';
import { resolveExe, helperCwd, killTree } from '../launch.mjs'; // absolute program paths: a cmd.exe planted in the worktree never runs

export const LIMITS = {
  readBytes: 200_000,     // most of one file the model gets back
  outputChars: 20_000,    // most of a command's output the model gets back
  grepHits: 100,
  grepFileBytes: 1_000_000,
  lsEntries: 300,
  runTimeoutMs: 60_000,
  maxRunMs: 10 * 60_000,  // the longest any command may run
  textBytes: 4_000_000,   // the largest file readText gives whole (an ACP agent may write it back, so it is never cut)
  endBytes: 1_000_000,    // what start() keeps of a command's output with keep 'end' when the caller sets no limit
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

/** The tool definitions in the OpenAI function-calling shape. */
export const TOOL_DEFINITIONS = [
  { name: 'Read', description: 'Read a text file in the working folder. Optional offset and limit count lines.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['file_path'] } },
  { name: 'LS', description: 'List the entries of a folder in the working folder. Folders end with a slash.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'Grep', description: 'Search text files for a regular expression. Returns file:line: text.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Edit', description: 'Replace old_string with new_string in a file. old_string must occur once, unless replace_all is true.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Write', description: 'Write a whole file in the working folder. Missing folders are made.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Bash', description: 'Run one shell command in the working folder. It stops after the time limit.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] } },
].map((t) => ({ type: 'function', function: t }));

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n[cut: ${s.length - n} more characters]` : s);
// The last n bytes of a text, cut at the start of a character (UTF-8 continuation bytes are 10xxxxxx).
function lastBytes(s, n) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= n) return s;
  let i = b.length - n;
  while (i < b.length && (b[i] & 0xc0) === 0x80) i++;
  return b.subarray(i).toString('utf8');
}

/**
 * Tools bound to one folder. `run(name, args)` resolves to { ok, text }; it never throws for a bad call
 * (the model reads the text and tries again). `stop()` kills every command that still runs.
 * deps.kill is injectable for tests.
 */
export function createLocalTools(root, deps = {}) {
  if (!root || !path.isAbsolute(root)) throw new Error('createLocalTools needs an absolute folder');
  const kill = deps.kill || killTree;
  const running = new Set();
  const waits = new WeakMap(); // child -> promise that settles when it has closed
  const stopWaitMs = deps.stopWaitMs ?? 2000;

  /** The absolute path of a target inside the folder, or a refusal. Checks the text path, then every link on the way (realInside). */
  function safe(p, { mustExist = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) fail('A path is required.');
    if (p.includes('\0')) fail('The path is not valid.');
    const abs = path.resolve(root, p);
    if (!inside(root, abs)) fail(`The path is outside the working folder: ${p}`);
    // A link that leads out, a broken link and a path that cannot be read all fail closed.
    if (!realInside(root, abs)) fail(`The path leads outside the working folder: ${p}`);
    if (mustExist && !fs.existsSync(abs)) fail(`No such file or folder: ${p}`);
    return abs;
  }
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/') || '.';

  const impl = {
    Read(a) {
      const f = safe(a.file_path, { mustExist: true });
      const st = fs.statSync(f);
      if (!st.isFile()) fail(`Not a file: ${a.file_path}`);
      const buf = fs.readFileSync(f).subarray(0, LIMITS.readBytes);
      if (buf.includes(0)) fail(`Not a text file: ${a.file_path}`);
      let lines = buf.toString('utf8').split('\n');
      const off = Math.max(0, (Number(a.offset) || 1) - 1), lim = Number(a.limit) > 0 ? Number(a.limit) : lines.length;
      lines = lines.slice(off, off + lim);
      return lines.map((l, i) => `${off + i + 1}\t${l}`).join('\n') + (st.size > LIMITS.readBytes ? `\n[cut: file is ${st.size} bytes]` : '');
    },
    LS(a) {
      const d = safe(a.path || '.', { mustExist: true });
      if (!fs.statSync(d).isDirectory()) fail(`Not a folder: ${a.path}`);
      const all = fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
      const out = all.slice(0, LIMITS.lsEntries).map((e) => e.name + (e.isDirectory() ? '/' : ''));
      return out.join('\n') + (all.length > out.length ? `\n[cut: ${all.length - out.length} more]` : '') || '[empty]';
    },
    Grep(a) {
      let re;
      try { re = new RegExp(String(a.pattern), 'i'); } catch (e) { fail(`The pattern is not a regular expression: ${e.message}`); }
      const start = safe(a.path || '.', { mustExist: true });
      const hits = [];
      // Only the parts below the folder count: the folder itself may sit under a .claude folder.
      const protectedBelowRoot = (p) => path.relative(root, p).split(/[\\/]+/).some((part) => part && isProtectedPart(part));
      const walk = (p) => {
        if (hits.length >= LIMITS.grepHits) return;
        let st; try { st = fs.lstatSync(p); } catch { return; }
        if (st.isSymbolicLink()) return; // never follow a link while searching
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(path.basename(p)) && p !== start) return;
          if (protectedBelowRoot(p)) return;
          for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
        } else if (st.isFile() && st.size <= LIMITS.grepFileBytes) {
          if (protectedBelowRoot(p)) return; // .env, key files, .office-token: a search never reads them
          const buf = fs.readFileSync(p);
          if (buf.includes(0)) return;
          buf.toString('utf8').split('\n').forEach((l, i) => { if (hits.length < LIMITS.grepHits && re.test(l)) hits.push(`${rel(p)}:${i + 1}: ${l.slice(0, 300)}`); });
        }
      };
      walk(start);
      return hits.length ? hits.join('\n') + (hits.length >= LIMITS.grepHits ? '\n[cut: more matches]' : '') : 'No matches.';
    },
    Edit(a) {
      const f = safe(a.file_path, { mustExist: true });
      const old = String(a.old_string ?? ''), neu = String(a.new_string ?? '');
      if (!old) fail('old_string is empty.');
      if (old === neu) fail('old_string and new_string are the same.');
      const text = fs.readFileSync(f, 'utf8');
      const n = text.split(old).length - 1;
      if (n === 0) fail('old_string was not found.');
      if (n > 1 && a.replace_all !== true) fail(`old_string occurs ${n} times. Add context or set replace_all.`);
      fs.writeFileSync(f, a.replace_all === true ? text.split(old).join(neu) : text.replace(old, () => neu));
      return `Edited ${rel(f)} (${a.replace_all === true ? n : 1} replaced).`;
    },
    Write(a) {
      const f = safe(a.file_path);
      if (typeof a.content !== 'string') fail('content must be text.');
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) fail(`A folder is at ${a.file_path}.`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // The made folders came from a checked path, but check the real parent again: a link may have been just made.
      if (!realInside(root, f)) fail(`The path leads outside the working folder: ${a.file_path}`);
      fs.writeFileSync(f, a.content);
      return `Wrote ${rel(f)} (${Buffer.byteLength(a.content)} bytes).`;
    },
  };

  /**
   * Start one shell command in the folder, or in a folder inside it, and return at once (Bash below, and an ACP terminal).
   * The handle: output() the text so far; truncated() whether some was dropped; exit() null while it runs, then
   * { exitCode, signal }; done, a promise of { exitCode, signal, timedOut } (and error when it could not start); kill() stops
   * its process tree. keep 'start' keeps the first part of a long output (a model reads the start); keep 'end' keeps the last
   * limitBytes, cut at a character (an ACP terminal, as the protocol asks). The time limit kills the whole tree.
   * Throws a ToolError for an empty command or a folder outside the root.
   */
  function start(command, { cwd = root, timeoutMs, keep = 'start', limitBytes = LIMITS.endBytes } = {}) {
    const cmd = String(command || '').trim();
    if (!cmd) fail('command is empty.');
    const dir = safe(cwd, { mustExist: true });
    if (!fs.statSync(dir).isDirectory()) fail(`Not a folder: ${cwd}`);
    const limitMs = Math.min(Math.max(Number(timeoutMs) || LIMITS.runTimeoutMs, 100), LIMITS.maxRunMs);
    const win = process.platform === 'win32';
    const shell = resolveExe(win ? 'cmd.exe' : 'sh'); // throws to the caller: run() answers "The tool failed"
    // cmd /s takes the line after /c and strips its first and last quote, so the line goes in one more pair of quotes:
    // a line that starts and ends with a quote ("C:\Program Files\x.exe" "a b") keeps its own.
    const child = spawn(shell, win ? ['/d', '/s', '/c', `"${cmd}"`] : ['-c', cmd], {
      cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsVerbatimArguments: win,
    });
    running.add(child);
    const cap = Math.max(1, Number(limitBytes) || LIMITS.endBytes);
    let out = '', cut = false, timedOut = false, exit = null;
    const add = (d) => {
      if (keep === 'end') { out += d; if (Buffer.byteLength(out) > cap) { out = lastBytes(out, cap); cut = true; } }
      else if (out.length < LIMITS.outputChars * 2) out += d;
      else cut = true;
    };
    // Text, not bytes: a character split across two chunks stays one character.
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; kill(child.pid); }, limitMs);
    waits.set(child, new Promise((r) => { child.once('close', r); child.once('error', r); }));
    const done = new Promise((resolve) => {
      let ended = false;
      const end = (exitCode, signal, error) => {
        if (ended) return;
        ended = true; clearTimeout(timer); running.delete(child);
        exit = { exitCode, signal };
        resolve(error ? { exitCode, signal, timedOut, error } : { exitCode, signal, timedOut });
      };
      child.on('error', (e) => end(null, null, e.message));
      child.on('close', (code, sig) => end(code ?? null, sig ?? null));
    });
    return {
      done, limitMs,
      output: () => out,
      truncated: () => cut,
      exit: () => exit,
      kill: () => { if (!exit) kill(child.pid); },
    };
  }

  /** Run a shell command in the folder; resolves with its output when it ends. */
  async function bash(a) {
    const h = start(a.command, { timeoutMs: a.timeout_ms });
    const r = await h.done;
    if (r.error) return { ok: false, text: `Could not run the command: ${r.error}` };
    const body = clip(h.output().trim(), LIMITS.outputChars);
    if (r.timedOut) return { ok: false, text: `${body}\n[stopped: the command ran longer than ${h.limitMs} ms]`.trim() };
    return { ok: r.exitCode === 0, text: `${body}${body ? '\n' : ''}[exit ${r.exitCode ?? r.signal}]` };
  }

  // { ok, text } for a call that throws a ToolError for the caller to read, never an exception.
  function attempt(fn) {
    try { return { ok: true, text: fn() }; } catch (e) {
      if (e instanceof ToolError) return { ok: false, text: e.message };
      return { ok: false, text: `The tool failed: ${e.code || e.message}` };
    }
  }

  /**
   * The whole text of a file, without line numbers (an ACP agent's fs/read_text_file). line (1-based) and limit pick lines.
   * A file over LIMITS.textBytes is refused, never cut: an agent that writes the text back would lose the rest.
   */
  function readText(p, { line, limit } = {}) {
    return attempt(() => {
      const f = safe(p, { mustExist: true });
      const st = fs.statSync(f);
      if (!st.isFile()) fail(`Not a file: ${p}`);
      if (st.size > LIMITS.textBytes) fail(`The file is larger than ${LIMITS.textBytes} bytes: ${p}. The office does not send part of it as the whole file.`);
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) fail(`Not a text file: ${p}`);
      const text = buf.toString('utf8');
      const from = Number(line) > 0 ? Math.floor(Number(line)) : 1, n = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
      if (from === 1 && !n) return text;
      const lines = text.split('\n');
      return lines.slice(from - 1, n ? from - 1 + n : undefined).join('\n');
    });
  }

  /** The refusal text when the path of a call is outside the folder (or leads out), else null. Runs nothing. */
  function guard(name, a = {}) {
    const p = name === 'LS' || name === 'Grep' ? a.path || '.' : a.file_path;
    try { safe(p); return null; } catch (e) { if (e instanceof ToolError) return e.message; throw e; }
  }

  return {
    definitions: TOOL_DEFINITIONS,
    root,
    start,
    readText,
    guard,
    async run(name, args) {
      let a = args;
      if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch { return { ok: false, text: 'The arguments are not valid JSON.' }; } }
      if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, text: 'The arguments must be an object.' };
      try {
        if (name === 'Bash') return await bash(a);
        if (!impl[name]) return { ok: false, text: `Unknown tool: ${name}` };
        return { ok: true, text: clip(String(impl[name](a)), LIMITS.outputChars) };
      } catch (e) {
        if (e instanceof ToolError) return { ok: false, text: e.message };
        return { ok: false, text: `The tool failed: ${e.code || e.message}` };
      }
    },
    /** Kills every running command. Settles when each is killed and closed, or after stopWaitMs (a child that left the tree). */
    stop() {
      const all = [...running].map((c) => {
        let k; try { k = kill(c.pid); } catch { k = null; }
        return Promise.all([k, waits.get(c)]);
      });
      if (!all.length) return Promise.resolve();
      let timer;
      const limit = new Promise((r) => { timer = setTimeout(r, stopWaitMs); timer.unref?.(); });
      return Promise.race([Promise.all(all), limit]).finally(() => clearTimeout(timer));
    },
  };
}
