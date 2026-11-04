// Claude Code provider: the first adapter behind the provider seam (providers/index.mjs).
// It runs `claude -p` in stream-json mode inside the office (no terminal), or opens Claude Code in a terminal window.
// It sends user messages and control requests on stdin and closes a session with taskkill on its process tree.
// Stdout messages go to the session tracker through events.stream; a control response goes back to its request here.
// Hooks reach the tracker over the server's hook routes, not through this file, so a permission decision goes back as the
// hook's answer (answer() below gives its body).
// The process calls are injected (deps.spawn, deps.execFile), so tests drive it with a fake runner. Nothing starts on import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as realSpawn, execFile as realExecFile, execFileSync as realExecFileSync } from 'node:child_process';
import { clip } from '../tracker.mjs';
import { providerError } from './index.mjs';

/**
 * The absolute path of a program, from the absolute folders on PATH only, or null. Every process this provider starts
 * goes through this one function, never a bare name: Windows would look in the current folder (a session's repository)
 * first, so a planted claude.exe or powershell.exe there could run. Like Windows, a name with no extension gets .com or
 * .exe; .cmd and .bat need a shell, which the office never uses. The shared resolver of the security fix (t/sec-c1)
 * replaces this function when it lands.
 */
export function exePath(name, env = process.env) {
  if (path.isAbsolute(name)) return name;
  const exts = process.platform !== 'win32' || path.extname(name) ? [''] : ['.com', '.exe'];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // a relative entry is the current folder again
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
    }
  }
  return null;
}

export const MODEL_RE = /^(opus|sonnet|haiku|claude-[\w.-]+)$/;
export const MODES = new Set(['default', 'acceptEdits', 'plan']);
const MAX_ATTACH_CHARS = 9_000_000; // base64 characters across all attachments of one message
// The page's Open dialog has its own copy of this list until it reads models() (#20).
const MODELS = [
  { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }, { id: 'claude-fable-5-1', label: 'Fable' },
];
const HEADLESS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

/** The Claude Code version (`claude --version`), or 'unknown'. Synchronous: the server needs it at start for the hooks mode. */
export function claudeVersion(run = realExecFileSync, exe = exePath) {
  const file = exe('claude');
  if (!file) return 'unknown';
  try { return String(run(file, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })).trim(); } catch { return 'unknown'; }
}

// Images go in as image blocks and text files inline. Anything else is refused, never silently dropped.
function blocksFor(text, attachments) {
  const content = [];
  let total = 0;
  for (const a of attachments.slice(0, 6)) {
    const data = String(a.data || '');
    total += data.length;
    if (total > MAX_ATTACH_CHARS) throw providerError(413, 'The attachments are too large. The limit is about 6 MB in total.');
    const mime = String(a.mime || ''), name = String(a.name || 'file').slice(0, 80);
    if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
    else if (/^text\//.test(mime) || /\.(md|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|css|html|csv|log|yml|yaml|toml|xml|sh|ps1|sql)$/i.test(name)) {
      content.push({ type: 'text', text: `Attached file ${name}:\n\`\`\`\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 200000)}\n\`\`\`` });
    } else throw providerError(415, `Cannot attach ${name}. Attach images or text files.`);
  }
  if (text) content.push({ type: 'text', text });
  return content;
}


/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {() => {settings: string, mcp: string, launcher: string}} deps.files the hook settings file in use, the office MCP
 *   config and launch.ps1. Read at each open, so a change of hooks mode applies to the next session.
 * @param {Function} [deps.spawn] child_process.spawn. @param {Function} [deps.execFile] child_process.execFile.
 * @param {(name: string) => string|null} [deps.exe] the program resolver (exePath).
 * @param {object} [deps.env] the environment for Claude Code (process.env).
 * @param {() => string} [deps.makeId] control request ids.
 */
export function createClaudeCode(deps) {
  const events = deps.events;
  const files = deps.files;
  const spawn = deps.spawn || realSpawn;
  const execFile = deps.execFile || realExecFile;
  const env = deps.env || process.env;
  const exe = deps.exe || ((name) => exePath(name, env));
  const makeId = deps.makeId || (() => 'c' + crypto.randomBytes(4).toString('hex'));
  /** @type {Map<string, import('node:child_process').ChildProcess>} uid -> the claude process of a session that runs in the office */
  const procs = new Map();
  /** request id -> { uid, done }: control requests that wait for their control_response */
  const controls = new Map();

  // The absolute path of a program, or an error the user can act on.
  function program(name) {
    const f = exe(name);
    if (!f) throw providerError(409, name === 'claude'
      ? 'The office cannot find Claude Code: claude is not on the PATH. Install it, then try again.'
      : `The office cannot find ${name} on the PATH.`);
    return f;
  }
  // Options shared by the office and the terminal window: the office's hooks and MCP server, then model and mode.
  function baseArgs(o) {
    const f = files();
    const args = ['--settings', f.settings, '--mcp-config', f.mcp];
    if (o.model) args.push('--model', o.model);
    if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
    return args;
  }
  function running(s) {
    const c = procs.get(s.uid);
    if (!c || !c.stdin.writable) throw providerError(409, 'That session is not running.');
    return c;
  }
  function run(name, args, ms) {
    return new Promise((resolve, reject) => {
      execFile(program(name), args, { windowsHide: true, timeout: ms }, (err, out) => (err ? reject(err) : resolve(String(out))));
    });
  }

  // One stdout line. A control response answers the office's own request; every other message is the tracker's.
  function onLine(s, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m && m.type === 'control_response') {
      const id = m.response?.request_id, c = controls.get(id);
      if (c) { controls.delete(id); c.done(m.response); }
      return;
    }
    events.stream(s, m);
  }

  // Control requests (stop this turn, change mode or model, connectors) go down the same pipe as messages.
  // onDone gets the control response: { subtype: 'success', response } or { subtype: 'error', error }.
  function control(s, request, onDone) {
    const c = running(s);
    const id = makeId();
    if (onDone) controls.set(id, { uid: s.uid, done: onDone });
    c.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
  }

  return {
    kind: 'claude-code',
    label: 'Claude Code',

    async readiness() {
      let version;
      try { version = (await run('claude', ['--version'], 8000)).trim(); } catch {
        return { ready: false, version: null, needs: ['Install Claude Code. Then run claude in a terminal and sign in.'] };
      }
      // An older Claude Code has no `auth status`: then the office does not know, and does not block.
      let auth = null;
      try { auth = JSON.parse(await run('claude', ['auth', 'status', '--json'], 15000)); } catch { /* unknown */ }
      if (auth && auth.loggedIn === false && !env.ANTHROPIC_API_KEY) {
        return { ready: false, version, needs: ['Sign in to Claude Code: run claude auth login in a terminal.'] };
      }
      return { ready: true, version, needs: [] };
    },

    async models() { return MODELS.map((m) => ({ ...m })); },

    // Before the office makes a worktree: the options, and the programs the session needs.
    check(o = {}) {
      if (o.model && !MODEL_RE.test(o.model)) throw providerError(400, 'Unknown model.');
      if (o.permissionMode && !MODES.has(o.permissionMode)) throw providerError(400, 'Unknown permission mode.');
      program('claude');
      if (o.where === 'terminal') { program('cmd.exe'); program('powershell.exe'); }
    },

    // Claude Code runs headless in stream-json mode: prompts go in on stdin, replies come back on stdout.
    // Hooks still report activity and permission prompts, so the office behaves the same as for a terminal.
    open(s, o = {}) {
      const file = exe('claude');
      if (!file) {
        // Like a start that fails: the session shows why, then ends.
        setImmediate(() => { events.reply(s, 'Could not start Claude Code: claude is not on the PATH.'); events.end(s, 'could not start'); });
        return;
      }
      const args = [...HEADLESS, ...baseArgs(o)];
      if (o.resume) args.push('--resume', o.resume);
      if (o.budget) args.push('--max-budget-usd', String(o.budget));
      const child = spawn(file, args, {
        cwd: s.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...env, OFFICE_ID: s.officeId },
      });
      procs.set(s.uid, child);
      s.pid = child.pid;
      let buf = '', err = '';
      // Text, not bytes: a character split across two chunks stays one character.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(s, line); }
      });
      child.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      child.stdin.on('error', () => {});
      child.on('error', (e) => { events.reply(s, 'Could not start Claude Code: ' + e.message); events.end(s, 'could not start'); });
      child.on('exit', (code) => {
        procs.delete(s.uid);
        for (const [id, c] of controls) if (c.uid === s.uid) controls.delete(id); // no answer can come now
        if (s.status !== 'ended' && code && !s.sid) events.reply(s, 'Claude Code stopped before it started: ' + (clip(err.trim(), 400) || 'exit code ' + code));
        events.end(s, code ? `exited (${code})` : 'finished');
      });
    },

    // A terminal window: `start /wait` gives the session its own console while cmd.exe stays alive as the process-tree root,
    // so close = taskkill /T on that one pid. The quoted "Office" is the window title; unquoted, `start` would try to run a
    // program named Office. PowerShell goes in by its full path, because cmd.exe looks in the session folder first.
    // launch.ps1 reads the options from the environment, so no user text passes through shell quoting.
    openWindow(s, o = {}) {
      const shell = program('cmd.exe'), ps = program('powershell.exe');
      const args = baseArgs(o);
      if (o.prompt) args.push(o.prompt);
      const title = ('Office - ' + s.name).replace(/[^\w .-]/g, '');
      const child = spawn(shell, [
        '/d', '/s', '/c', `start "Office" /wait "${ps}" -NoLogo -NoExit -ExecutionPolicy Bypass -File "${files().launcher}"`,
      ], {
        windowsVerbatimArguments: true, cwd: s.cwd, stdio: 'ignore', windowsHide: true,
        env: { ...env, OFFICE_ID: s.officeId, OFFICE_ARGS: JSON.stringify(args), OFFICE_TITLE: title },
      });
      s.pid = child.pid;
      child.on('error', (e) => { events.feed(s, 'end', `could not start: ${e.message}`); events.end(s, 'could not start'); });
      child.on('exit', () => events.end(s, 'window closed'));
      child.unref();
    },

    message(s, { text = '', attachments = [] } = {}) {
      const c = running(s);
      const content = attachments.length ? blocksFor(text, attachments) : [{ type: 'text', text }];
      c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    },

    // The PermissionRequest hook's answer. No decision ({}) lets Claude Code decide: its terminal dialog, or it moves on.
    answer(_s, request, d = {}) {
      if (typeof d.allow !== 'boolean') return {};
      const decision = d.allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Declined from Agent Office.' };
      if (d.allow && d.always && request?.suggestions?.length) decision.updatedPermissions = request.suggestions;
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
    },

    interrupt(s) { control(s, { subtype: 'interrupt' }); },

    // Any Claude Code session with a known process: office, terminal window, or found by the hook's process walk.
    close(s) {
      if (!s.pid || s.pid === process.pid) throw providerError(409, 'This session has no known process to close. Close it in its own terminal.');
      const taskkill = program('taskkill');
      return new Promise((resolve, reject) => {
        execFile(taskkill, ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true }, (err, _o, stderr) => {
          if (err && !/not found|no running instance/i.test(String(stderr))) return reject(providerError(500, `Could not close it: ${String(stderr || err.message).trim()}`));
          resolve();
        });
      });
    },

    control,

    // The claude command line for one job (`claude mcp`, `claude plugin`, the hooks probe): execFile without the file name.
    cli(args, opts, done) {
      let file;
      try { file = program('claude'); } catch (e) { return void done(e, '', ''); }
      execFile(file, args, opts, done);
    },
  };
}
