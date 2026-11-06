// Claude Code provider: the first adapter behind the provider seam (providers/index.mjs).
// It runs `claude -p` in stream-json mode inside the office (no terminal), or opens Claude Code in a terminal window.
// It sends user messages and control requests on stdin and closes a session with taskkill on its process tree.
// Stdout messages go to the session tracker through events.stream; a control response goes back to its request here.
// Hooks reach the tracker over the server's hook routes, not through this file, so a permission decision goes back as the
// hook's answer (answer() below gives its body).
// Every program starts from the absolute path that launch.mjs resolveExe gives, never from a bare name: Windows would look in
// the session folder first. The process calls are injected (deps.spawn, deps.execFile, deps.exe), so tests drive it with a
// fake runner. Nothing starts on import.
import crypto from 'node:crypto';
import { spawn as realSpawn, execFile as realExecFile, execFileSync as realExecFileSync } from 'node:child_process';
import { resolveExe, helperCwd, processStart } from '../launch.mjs';
import { clip } from '../tracker.mjs';
import { providerError } from './index.mjs';

export const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MODEL_RE = /^(opus|sonnet|haiku|claude-[\w.-]+)$/;
export const MODES = new Set(['default', 'acceptEdits', 'plan']);
const MAX_ATTACH_CHARS = 9_000_000; // base64 characters across all attachments of one message
// The Open dialog and a room's Add agent read this list through models() (GET /api/providers). The page still has its own
// copy (public/page-core.js MODELS) for the schedule form, the dock's model switch, the model word, and those two forms
// until the server answers (#101).
const MODELS = [
  { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }, { id: 'claude-fable-5-1', label: 'Fable' },
];
const HEADLESS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
const ENDED = { subtype: 'error', error: 'The session ended.' };

const CLOUD_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * True when the environment gives Claude Code a key source that needs no claude.ai sign-in: a Bedrock, Vertex or Foundry
 * switch that is on (Claude Code reads only 1, true, yes and on, in any case and trimmed, as on; any other value is off), or an API key or an auth token.
 */
export function hasKeySource(env) {
  const on = (v) => typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  return CLOUD_SWITCHES.some((k) => on(env[k])) || KEY_VARS.some((k) => typeof env[k] === 'string' && env[k] !== '');
}

/**
 * The absolute path of a program, or an error (status 409) the user can act on. resolveExe refuses a .cmd or .ps1 shim,
 * because the office starts programs without a shell. The office requires claude.exe (owner decision): a shim means an npm
 * install, so the message tells the user to install the native Claude Code.
 */
export function programPath(name, exe = resolveExe) {
  try { return exe(name); } catch (e) {
    if (name === 'claude' && e.code === 'SCRIPT_INSTALL') throw providerError(409, `The office needs claude.exe. It found only ${e.file} (an npm install). Install the native Claude Code, then try again.`);
    if (name === 'claude') throw providerError(409, 'The office cannot find Claude Code: claude.exe is not on the PATH. Install it, then try again.');
    throw providerError(409, e.message);
  }
}

/** The Claude Code version (`claude --version`), or 'unknown'. Synchronous: the server needs it at start for the hooks mode. */
export function claudeVersion(run = realExecFileSync, exe = resolveExe) {
  try { return String(run(exe('claude'), ['--version'], { cwd: helperCwd(), encoding: 'utf8', timeout: 8000, windowsHide: true })).trim(); } catch { return 'unknown'; }
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
 * @param {(name: string) => string} [deps.exe] the program resolver: an absolute path, or it throws (launch.mjs resolveExe).
 * @param {object} [deps.env] the environment for Claude Code (process.env).
 * @param {() => string} [deps.makeId] control request ids.
 */
export function createClaudeCode(deps) {
  const events = deps.events;
  const files = deps.files;
  const spawn = deps.spawn || realSpawn;
  const execFile = deps.execFile || realExecFile;
  const env = deps.env || process.env;
  const exe = deps.exe || ((name) => resolveExe(name, env));
  const makeId = deps.makeId || (() => 'c' + crypto.randomBytes(4).toString('hex'));
  /** @type {Map<string, import('node:child_process').ChildProcess>} uid -> the claude process of a session that runs in the office */
  const procs = new Map();
  /** uids with a terminal window that is still open */
  const windows = new Set();
  /** request id -> { uid, done }: control requests that wait for their control_response */
  const controls = new Map();
  /** uids the office is closing: their process exit is not the session's end, the close is (timing rule 2) */
  const closing = new Set();

  const program = (name) => programPath(name, exe);
  // The start time of each process the office spawned (#27 L11): close kills only a pid that still has it.
  const stamps = new Map();
  const stamp = (s) => {
    const p = processStart(s.pid, { execFile, exe: program }).then((t) => { s.pidStart = t; stamps.delete(s.uid); return t; });
    stamps.set(s.uid, p);
    return p;
  };
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
      execFile(program(name), args, { cwd: helperCwd(), windowsHide: true, timeout: ms }, (err, out) => (err ? reject(err) : resolve(String(out))));
    });
  }
  // The process is gone: no control response can come now, so every waiting request fails at once.
  function gone(s) {
    procs.delete(s.uid);
    for (const [id, c] of controls) if (c.uid === s.uid) { controls.delete(id); c.done({ ...ENDED }); }
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
    paid: true, // runs on the user's account: new sessions get the default spend limit
    canResume: true, // claude --resume continues a past conversation
    modes: [...MODES], // the permission modes open() takes (--permission-mode)
    gated: true, // its PermissionRequest hook holds every call Claude Code asks about

    async readiness() {
      let version;
      try { version = (await run('claude', ['--version'], 8000)).trim(); } catch (e) {
        return { ready: false, version: null, needs: [/needs claude\.exe/.test(e.message) ? e.message : 'Install Claude Code. Then run claude in a terminal and sign in.'] };
      }
      // An older Claude Code has no `auth status`: then the office does not know, and does not block.
      let auth = null;
      try { auth = JSON.parse(await run('claude', ['auth', 'status', '--json'], 15000)); } catch { /* unknown */ }
      // Only `loggedIn: false` blocks, and only with no other key source. A logged-in status counts whatever its authMethod
      // (claude.ai, an API key, third_party for Bedrock, Vertex or Foundry). Any other shape does not block (#103).
      if (auth && auth.loggedIn === false && !hasKeySource(env)) {
        return { ready: false, version, needs: ['Sign in to Claude Code: run claude auth login in a terminal.'] };
      }
      return { ready: true, version, needs: [] };
    },

    async models() { return MODELS.map((m) => ({ ...m })); },

    // Before the office makes a worktree or a session: the options, and the programs the session needs.
    // check({}) checks only that a session can start (the office calls it before Reopen too).
    check(o = {}) {
      if (o.model && !MODEL_RE.test(o.model)) throw providerError(400, 'Unknown model.');
      if (o.resume && !SID_RE.test(o.resume)) throw providerError(400, 'That is not a session id.');
      if (o.permissionMode && !MODES.has(o.permissionMode)) throw providerError(400, 'Unknown permission mode.');
      program('claude');
      if (o.where === 'terminal') { program('cmd.exe'); program('powershell.exe'); }
    },

    // Claude Code runs headless in stream-json mode: prompts go in on stdin, replies come back on stdout.
    // Hooks still report activity and permission prompts, so the office behaves the same as for a terminal.
    open(s, o = {}) {
      let file;
      try { file = program('claude'); } catch (e) {
        // check() found it a moment ago. Like a start that fails: the session shows why, then ends.
        setImmediate(() => { events.reply(s, 'Could not start Claude Code: ' + e.message); events.end(s, 'could not start'); });
        return;
      }
      // A hook can set a session's sid, so a resume id that is not a UUID could become a flag (#27 L5). The model is checked too.
      if (o.resume && !SID_RE.test(o.resume)) throw providerError(400, 'That is not a session id.');
      if (o.model && !MODEL_RE.test(o.model)) throw providerError(400, 'Unknown model.');
      const args = [...HEADLESS, ...baseArgs(o)];
      if (o.resume) args.push('--resume', o.resume);
      if (o.budget) args.push('--max-budget-usd', String(o.budget));
      // The persona's tone line (#150): text only, an argument list entry, never a permission flag.
      if (o.tone) args.push('--append-system-prompt', String(o.tone));
      const child = spawn(file, args, {
        cwd: s.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...env, OFFICE_ID: s.officeId },
      });
      procs.set(s.uid, child);
      s.pid = child.pid; stamp(s);
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
      child.on('error', (e) => { gone(s); events.reply(s, 'Could not start Claude Code: ' + e.message); events.end(s, 'could not start'); });
      child.on('exit', (code) => {
        gone(s);
        if (closing.delete(s.uid)) return; // the office closes it: the close ends the session, as "closed from the office"
        if (s.status !== 'ended' && code && !s.sid) events.reply(s, 'Claude Code stopped before it started: ' + (clip(err.trim(), 400) || 'exit code ' + code));
        events.end(s, code ? `exited (${code})` : 'finished');
      });
    },

    // A terminal window: `start /wait` gives the session its own console while cmd.exe stays alive as the process-tree root,
    // so close = taskkill /T on that one pid. The quoted "Office" is the window title; unquoted, `start` would try to run a
    // program named Office. cmd.exe, PowerShell and claude all go in by their full paths (claude as OFFICE_CLAUDE, which
    // launch.ps1 runs), so no folder is searched. launch.ps1 reads the options from the environment, so no user text passes
    // through shell quoting.
    openWindow(s, o = {}) {
      const shell = program('cmd.exe'), ps = program('powershell.exe'), claude = program('claude');
      const args = baseArgs(o);
      if (o.prompt) args.push('--', o.prompt); // after "--" the prompt is never an option (#27 L8)
      const title = ('Office - ' + s.name).replace(/[^\w .-]/g, '');
      const child = spawn(shell, [
        '/d', '/s', '/c', `start "Office" /wait "${ps}" -NoLogo -NoExit -ExecutionPolicy Bypass -File "${files().launcher}"`,
      ], {
        windowsVerbatimArguments: true, cwd: s.cwd, stdio: 'ignore', windowsHide: true,
        env: { ...env, OFFICE_ID: s.officeId, OFFICE_ARGS: JSON.stringify(args), OFFICE_TITLE: title, OFFICE_CLAUDE: claude },
      });
      s.pid = child.pid; stamp(s);
      windows.add(s.uid);
      child.on('error', (e) => { windows.delete(s.uid); events.feed(s, 'end', `could not start: ${e.message}`); events.end(s, 'could not start'); });
      child.on('exit', () => {
        windows.delete(s.uid);
        if (closing.delete(s.uid)) return;
        events.end(s, 'window closed');
      });
      child.unref();
    },

    message(s, { text = '', attachments = [] } = {}) {
      const c = running(s);
      const content = attachments.length ? blocksFor(text, attachments) : [{ type: 'text', text }];
      c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    },

    // The PermissionRequest hook's answer. No decision ({}) lets Claude Code decide: its terminal dialog, or it moves on.
    // A refusal says why (d.message: the Security room rule), else that the user declined.
    answer(_s, request, d = {}) {
      if (typeof d.allow !== 'boolean') return {};
      const decision = d.allow ? { behavior: 'allow' } : { behavior: 'deny', message: typeof d.message === 'string' && d.message ? d.message : 'Declined from Agent Office.' };
      if (d.allow && d.always && request?.suggestions?.length) decision.updatedPermissions = request.suggestions.map((x) => ({ ...x, destination: 'localSettings' })); // never user scope (#27 L2)
      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
    },

    // The PreToolUse hook's answer (#70, security.mjs preToolDecision): 'deny' refuses the call before Claude Code's own
    // permission check, 'ask' makes Claude Code ask (the office then holds the prompt). The office never answers 'allow'
    // here: an Allow rule answers only the prompts Claude Code raises, so Claude Code's own deny and ask rules stay.
    preToolAnswer(d) {
      if (!d || (d.decision !== 'deny' && d.decision !== 'ask')) return null;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: String(d.reason || '') } };
    },

    interrupt(s) { control(s, { subtype: 'interrupt' }); },

    // Any Claude Code session with a known process: office, terminal window, or found by the hook's process walk.
    // While it closes, the process exit reports nothing: the office ends the session when this resolves.
    close(s) {
      if (!s.pid || s.pid === process.pid) throw providerError(409, 'This session has no known process to close. Close it in its own terminal.');
      const taskkill = program('taskkill');
      closing.add(s.uid);
      // #27 L11: the pid must still be the process the office saw start. Another start time, or none, means it is gone
      // and the pid belongs to something else (or nothing), so nothing is killed.
      const verified = (async () => {
        const known = s.pidStart || (await stamps.get(s.uid)) || null;
        const now = await processStart(s.pid, { execFile, exe: program });
        if (!now) return false; // nothing runs under that pid: already gone
        if (!known) throw providerError(409, 'This session\'s process cannot be checked, so the office will not stop it. Close it in its own terminal.');
        return now === known;
      })();
      return verified.catch((e) => { closing.delete(s.uid); throw e; }).then((same) => new Promise((resolve, reject) => {
        if (!same) { if (!procs.has(s.uid) && !windows.has(s.uid)) closing.delete(s.uid); return resolve(); }
        execFile(taskkill, ['/PID', String(s.pid), '/T', '/F'], { cwd: helperCwd(), windowsHide: true }, (err, _o, stderr) => {
          if (err && !/not found|no running instance/i.test(String(stderr))) {
            closing.delete(s.uid); // it still runs: a later exit is the session's end again
            return reject(providerError(500, `Could not close it: ${String(stderr || err.message).trim()}`));
          }
          if (!procs.has(s.uid) && !windows.has(s.uid)) closing.delete(s.uid); // no exit to wait for (gone, or not ours)
          resolve();
        });
      }));
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

// ---------- the claude CLI flag list (moved here from paperclip.mjs, #186) ----------
// The flags of the claude main command in Claude Code 2.1.318, read from its binary (`claude --help` shows most; the rest
// are hidden), with what each takes after it: 0 nothing (a switch), 1 the next argument whatever it is, ? the next argument
// when it is not a flag, + the next argument and then each next one up to a flag. That is how its parser (commander) reads
// them. The spellings of one flag share an entry. A flag that is not here is not guessed at: the agent is Partly supervised.
const CLAUDE_FLAGS = '-d --debug ?|-d2e --debug-to-stderr 0|--debug-file 1|--verbose 0|-p --print 0|--bare 0|--safe-mode 0|--init 0|' +
  '--init-only 0|--maintenance 0|--output-format 1|--json-schema 1|--include-hook-events 0|--include-partial-messages 0|' +
  '--forward-subagent-text 0|--session-mirror 0|--await-claim 0|--input-format 1|--await-initialize 0|--dangerously-skip-permissions 0|' +
  '--allow-dangerously-skip-permissions 0|--thinking 1|--thinking-display 1|--max-thinking-tokens 1|--max-turns 1|--max-budget-usd 1|' +
  '--task-budget 1|--replay-user-messages 0|--prompt-suggestions ?|--enable-auth-status 0|--allowedTools --allowed-tools +|--tools +|' +
  '--restricted 0|--disallowedTools --disallowed-tools +|--mcp-config +|--permission-prompt-tool 1|--permission-prompts 1|' +
  '--system-prompt 1|--system-prompt-file 1|--append-system-prompt 1|--append-system-prompt-file 1|--system-prompt-snapshot 1|' +
  '--append-subagent-system-prompt 1|--append-subagent-system-prompt-file 1|--plan-mode-instructions 1|' +
  '--exclude-dynamic-system-prompt-sections 0|--permission-mode 1|--inherit-permission-mode 1|-c --continue 0|-r --resume ?|' +
  '--fork-session 0|--watch-artifact 1|--watch-artifact-no-autoreact 1|--prefill 1|--deep-link-origin 0|--deep-link-repo 1|' +
  '--deep-link-last-fetch 1|--prefill-b64 1|--deep-link-cwd-b64 1|--from-pr ?|--no-session-persistence 0|--resume-session-at 1|' +
  '--resume-drops-turn 1|--reply-on-resume 0|--rewind-files 1|--model 1|--include-unsupported-models 0|--effort 1|--fast-mode 1|' +
  '--agent 1|--betas +|--fallback-model 1|--workload 1|--settings 1|--client-data-url 1|--allow-other-models 0|--managed-settings 1|' +
  '--host-auth-is-org-sign-in 0|--add-dir +|--project-config-root 1|--ide 0|--desktop 0|--strict-mcp-config 0|--session-id 1|' +
  '-n --name 1|--agents 1|--setting-sources 1|--plugin-dir 1|--plugin-dir-no-mcp 1|--plugin-url 1|--disable-slash-commands 0|' +
  '--chrome 0|--no-chrome 0|--file +|-w --worktree ?|--tmux 0|--advisor 1|--autocompact 1|--enable-auto-mode 0|--proactivity 1|' +
  '--agents-view-if-allowed 0|--bg --background 0|--messaging-socket-path 1|--brief 0|--ax-screen-reader 0|--channels +|' +
  '--dangerously-load-development-channels +|--agent-id 1|--agent-name 1|--team-name 1|--agent-color 1|--plan-mode-required 0|' +
  '--parent-session-id 1|--teammate-mode 1|--agent-type 1|--sdk-url 1|--runner-declares 1|--session-began-as-copy 1|--teleport ?|' +
  '--cloud ?|--forward-home-settings 1|--remote ?|--attach-serve 1|--environment 1|--pool 1|--correlation-id 1|--ref 1|--on-branch 1|' +
  '--remote-control ?|--rc ?|--remote-control-session-name-prefix 1|-h --help 0|-v --version 0';
export const CLAUDE_FLAGS_VERSION = '2.1.318';
// What a flag does to the office's view of a run (the rest change nothing for it).
// self: the run approves its own calls, or the hooks are off, so a call skips the hold. Unsupervised; Supervise takes it out
//   with its values. --allowedTools is what Paperclip passes on a sandbox target in place of --dangerously-skip-permissions
//   (claude-local permissions.ts).
// cloud: the session runs in the cloud, so its calls never reach the office hooks. Unsupervised; Supervise keeps it (taking
//   it out would move the work), so Supervise is not offered.
// load: it loads plugins, agents or settings the office cannot read, or lets something other than the office answer a call.
//   Partly supervised; Supervise keeps it, because taking it out changes what the agent does and the office cannot tell if
//   that is safe.
const FLAG_KINDS = [
  ['self', ['--dangerously-skip-permissions'], () => 'It skips permissions (--dangerously-skip-permissions).'],
  ['self', ['--allow-dangerously-skip-permissions'], () => 'It can turn on skip permissions (--allow-dangerously-skip-permissions).'],
  ['self', ['--permission-prompt-tool'], () => 'Its own tool answers permission prompts (--permission-prompt-tool).'],
  ['self', ['--allowedTools'], (f) => `It allows tools without asking (${f}).`],
  ['self', ['--managed-settings'], () => 'It passes policy settings (--managed-settings), which can allow calls or turn off the office hooks.'],
  ['self', ['--bare'], () => 'It runs in bare mode (--bare), which skips the hooks of settings files, so the office hooks do not run.'],
  ['self', ['--safe-mode'], () => 'It runs in safe mode (--safe-mode), which turns off hooks, so the office hooks do not run.'],
  ['cloud', ['--cloud', '--remote', '--environment', '--pool', '--attach-serve'], (f) => `It runs its session in the cloud (${f}), so its calls never reach the office hooks.`],
  ['load', ['--plugin-dir', '--plugin-dir-no-mcp', '--plugin-url', '--await-initialize'], (f) => `It loads plugins (${f}), and a plugin hook can allow a call without the office.`],
  ['load', ['--agents', '--agent', '--agent-type'], (f) => `It loads agents (${f}), and an agent can set its own permission mode and hooks.`],
  ['load', ['--setting-sources', '--project-config-root', '--client-data-url'], (f) => `It changes which settings load (${f}), and the office cannot read them.`],
  ['load', ['--sdk-url', '--await-claim'], (f) => `It connects to an SDK host (${f}), which can answer permission prompts.`],
  ['load', ['--remote-control', '--rc'], (f) => `It turns on Remote Control (${f}), where a remote client can answer permission prompts.`],
  ['load', ['--channels', '--dangerously-load-development-channels'], (f) => `It registers channel servers (${f}), which the office cannot check.`],
  ['load', ['--teleport'], (f) => `It resumes a cloud session here (${f}), which the office cannot check.`],
  ['load', ['--chrome'], (f) => `It turns on Claude in Chrome (${f}), whose browser actions the office cannot check.`],
];
const FLAGS = new Map();   // spelling -> { names, takes, kind, why }
for (const entry of CLAUDE_FLAGS.split('|')) {
  const names = entry.split(' '), t = names.pop();
  const e = { names, takes: t === '0' ? 0 : t === '1' ? 1 : t, kind: '', why: null };
  for (const n of names) FLAGS.set(n, e);
}
for (const [kind, names, why] of FLAG_KINDS) {
  for (const n of names) {
    const e = FLAGS.get(n);
    if (!e) throw new Error(`claude-code.mjs: ${n} is not in CLAUDE_FLAGS`);
    Object.assign(e, { kind, why });
  }
}
// An argument Claude Code's parser reads as a flag: a dash and at least one more character.
const isFlag = (a) => typeof a === 'string' && a.length > 1 && a[0] === '-';

/**
 * A claude argument list as Claude Code's parser reads it: { flags, unknown, end }. flags: [{ e, as, values, first, last }]
 * (as: the spelling used; first..last: the arguments it takes up). unknown: [{ i, as }], flags that are not Claude Code
 * 2.1.318's. end: the index of a '--' (after it every argument is text, not a flag), else the length. Short flags may sit
 * together (-pc), a short flag that takes a value takes the rest of its argument (-nName), and --flag=value holds its value.
 */
export function readArgs(args) {
  const a = Array.isArray(args) ? args.filter((x) => typeof x === 'string') : [], flags = [], unknown = [];
  const queue = a.map((v, i) => ({ v, i }));
  let list = null, end = a.length;
  while (queue.length) {
    const { v: x, i } = queue.shift();
    if (x === '--') { end = i; break; }
    if (list && !isFlag(x)) { list.values.push(x); list.last = i; continue; }
    list = null;
    if (!isFlag(x)) continue;   // text: the prompt, or - (read the prompt from stdin)
    let e = FLAGS.get(x);
    if (e) {
      const f = { e, as: x, values: [], first: i, last: i }, next = queue[0];
      if (next && (e.takes === 1 || e.takes === '+' || (e.takes === '?' && !isFlag(next.v)))) { queue.shift(); f.values.push(next.v); f.last = next.i; }
      if (e.takes === '+') list = f;
      flags.push(f);
      continue;
    }
    if (x.length > 2 && x[1] !== '-' && (e = FLAGS.get('-' + x[1]))) {
      flags.push({ e, as: '-' + x[1], values: e.takes ? [x.slice(2)] : [], first: i, last: i, part: true });
      if (!e.takes) queue.unshift({ v: '-' + x.slice(2), i });   // the rest of -pc is read again: -c
      continue;
    }
    const eq = x.indexOf('=');
    if (x.startsWith('--') && eq > 2 && (e = FLAGS.get(x.slice(0, eq))) && e.takes) { flags.push({ e, as: x.slice(0, eq), values: [x.slice(eq + 1)], first: i, last: i }); continue; }
    unknown.push({ i, as: x });
  }
  return { flags, unknown, end };
}
