// The built-in tools of a local-model agent: read, list, search, edit, write and run, all limited to one folder (the worktree).
// Names and argument names follow Claude Code's (Read, LS, Grep, Edit, Write, Bash), so risk.mjs rates a call the same way
// and payload.mjs labels it the same way. This module never decides about approval: the caller asks the office first (the Security room rules, then a hold).
// A path outside the folder is refused here also when the user approved the call: the tools are the last fence.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { inside, realInside, isProtectedPart } from '../risk.mjs';
import { resolveExe, helperCwd } from '../git.mjs'; // absolute program paths: a cmd.exe planted in the worktree never runs

export const LIMITS = {
  readBytes: 200_000,     // most of one file the model gets back
  outputChars: 20_000,    // most of a command's output the model gets back
  grepHits: 100,
  grepFileBytes: 1_000_000,
  lsEntries: 300,
  runTimeoutMs: 60_000,
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

/** Kill a process and its children. Windows: taskkill /T by PID (a shell's children outlive a plain kill). */
export function killTree(pid, run = execFile) {
  if (!pid) return;
  if (process.platform === 'win32') run(resolveExe('taskkill'), ['/PID', String(pid), '/T', '/F'], { cwd: helperCwd(), windowsHide: true }, () => {});
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
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

  /** Run a shell command; resolves with its output. A timeout kills the whole process tree. */
  function bash(a) {
    const cmd = String(a.command || '').trim();
    if (!cmd) fail('command is empty.');
    const limit = Math.min(Math.max(Number(a.timeout_ms) || LIMITS.runTimeoutMs, 100), 10 * 60_000);
    const win = process.platform === 'win32';
    const shell = resolveExe(win ? 'cmd.exe' : 'sh'); // throws to run(), which answers "The tool failed"
    return new Promise((resolve) => {
      const child = spawn(shell, win ? ['/d', '/s', '/c', cmd] : ['-c', cmd], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsVerbatimArguments: win,
      });
      running.add(child);
      let out = '', timedOut = false, done = false;
      const add = (d) => { if (out.length < LIMITS.outputChars * 2) out += d; };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const timer = setTimeout(() => { timedOut = true; kill(child.pid); }, limit);
      const end = (text, ok) => { if (done) return; done = true; clearTimeout(timer); running.delete(child); resolve({ ok, text }); };
      child.on('error', (e) => end(`Could not run the command: ${e.message}`, false));
      child.on('close', (code, sig) => {
        const body = clip(out.trim(), LIMITS.outputChars);
        if (timedOut) end(`${body}\n[stopped: the command ran longer than ${limit} ms]`.trim(), false);
        else end(`${body}${body ? '\n' : ''}[exit ${code ?? sig}]`, code === 0);
      });
    });
  }

  return {
    definitions: TOOL_DEFINITIONS,
    root,
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
    /** Kill every command that still runs (interrupt and close). */
    stop() { for (const c of running) kill(c.pid); },
  };
}
