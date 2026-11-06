// Paperclip as an optional HQ above the office (#76). A watcher of an outside system, not a provider: the office never opens,
// drives or closes a Paperclip run. Paperclip owns its goals, heartbeats, routines and budgets; the office reads its REST
// routes and its live events (WebSocket /api/companies/{id}/events/ws) and shows them. Its Claude Code runs reach the office
// like any terminal session, through the office hooks (hook.mjs adds the PAPERCLIP_* ids of the run), once "Supervise in
// office" has set the agent up for that. That PATCH, after the Security room's painted Confirm, is the one write the office
// makes to Paperclip (ADR 0005). It never sends a heartbeat, never assigns or changes a task and never runs a routine.
//
// Facts from the spike (#75, Paperclip 2026.1023.0 on Windows, Node 24.11+): a claude_local agent holds its calls in the
// office only with engine 'cli', dangerouslySkipPermissions false and extraArgs ['--permission-mode', 'default', '--settings',
// <office hooks file>]. The default ACP engine approves every call and ignores extraArgs; without --permission-mode default
// the machine's default (Auto) asks nothing. The shapes of the routes and events come from the Paperclip source (0.3.1,
// server/src/routes, server/src/services/heartbeat.ts, packages/shared/src/types). PATCH /api/agents/:id merges adapterConfig
// key by key (a list such as extraArgs is replaced whole), so the patch carries the whole new extraArgs.
//
// Pure apart from createHq, whose network, clock and timers are injected (tests: test/paperclip.test.mjs with the fake server
// test/fixtures/fake-paperclip.mjs; through the server: test/paperclip-routes.test.mjs).
import path from 'node:path';
import { runIds, cleanIds } from './payload.mjs';

export const DEFAULT_URL = 'http://127.0.0.1:3100';

// ---------- the address: loopback only ----------
/**
 * The Paperclip address the office may use: http on 127.0.0.1, any port, nothing after the port. Returns
 * { ok: true, url: 'http://127.0.0.1:<port>' } or { ok: false, error }. localhost is refused too: it can name another
 * address than 127.0.0.1 (::1, or a hosts file entry), and the rule is one address.
 */
export function checkUrl(raw) {
  const text = String(raw ?? '').trim();
  const refuse = (why) => ({ ok: false, error: `${why} The office connects only to a Paperclip on this computer, at http://127.0.0.1:<port> (for example ${DEFAULT_URL}).` });
  if (!text) return refuse('Type the address of Paperclip.');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch { return refuse('That is not an address.'); }
  if (u.protocol !== 'http:') return refuse(`The address must start with http://, not ${u.protocol}//.`);
  if (u.hostname !== '127.0.0.1') return refuse(`${u.hostname || 'That host'} is not 127.0.0.1.`);
  if (u.username || u.password) return refuse('The address must not carry a user name or password.');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return refuse('The address ends after the port.');
  return { ok: true, url: `http://127.0.0.1:${u.port || '80'}` };
}

// ---------- supervision: does an agent's config send its runs through the office? ----------
const ROLE_LABELS = { ceo: 'CEO', cto: 'CTO', cmo: 'CMO', cfo: 'CFO', security: 'Security', engineer: 'Engineer', designer: 'Designer', pm: 'PM', qa: 'QA', devops: 'DevOps', researcher: 'Researcher', general: 'General' };
export const roleLabel = (role) => (ROLE_LABELS[role] || (typeof role === 'string' && role ? role[0].toUpperCase() + role.slice(1) : 'Agent'));

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// The CLI arguments Paperclip adds to a claude_local run: extraArgs, else the older args (execute.ts reads them in that order).
export const argsOf = (cfg) => { const e = strings(obj(cfg).extraArgs); return e.length ? e : strings(obj(cfg).args); };
const samePath = (a, b) => !!a && !!b && path.win32.normalize(String(a)).toLowerCase() === path.win32.normalize(String(b)).toLowerCase();

// ---------- Claude Code's arguments, read the way Claude Code reads them ----------
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
const CLAUDE_VERSION = '2.1.318';
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
    if (!e) throw new Error(`paperclip.mjs: ${n} is not in CLAUDE_FLAGS`);
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
  const a = strings(args), flags = [], unknown = [];
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
const named = (f, name) => f.e.names.includes(name);
const settingsOf = (r) => r.flags.filter((f) => named(f, '--settings')).map((f) => f.values[0]);

/**
 * What a claude argument list says about the office: { why, stuck, partly, kind }. why: why the run's calls skip the hold
 * ('' = they do not); stuck: Supervise in office does not change that. partly: why the office cannot check all of them
 * (kind 'load' or 'unknown'), when why is ''.
 */
function argsRead(args, hooksFile) {
  const r = readArgs(args);
  const first = (kind) => r.flags.find((f) => f.e.kind === kind);
  const none = { why: '', stuck: false, partly: '', kind: '' };
  let f = first('cloud');
  if (f) return { ...none, why: f.e.why(f.as), stuck: true };
  if ((f = first('self'))) return { ...none, why: f.e.why(f.as) };
  // manual is the name Claude Code 2.1 shows for the default mode; it reads manual as default
  const mode = r.flags.filter((x) => named(x, '--permission-mode')).map((x) => x.values[0]).pop();
  if (mode !== 'default' && mode !== 'manual') return { ...none, why: mode ? `It runs in the ${mode} permission mode, so Claude Code runs calls without asking.` : 'It does not set --permission-mode default, so the machine default (Auto) runs calls without asking.' };
  const settings = settingsOf(r);
  if (!settings.some((x) => samePath(x, hooksFile))) return { ...none, why: 'It does not load the office hooks file.' };
  if (!samePath(settings.at(-1), hooksFile)) return { ...none, why: 'Claude Code loads only the last --settings, and that is not the office hooks file.' };
  if ((f = first('load'))) return { ...none, partly: f.e.why(f.as), kind: 'load' };
  // stream-json input lets what writes to stdin switch the permission mode (a control request), so the office cannot hold it
  if ((f = r.flags.find((x) => named(x, '--input-format') && String(x.values[0]).toLowerCase() === 'stream-json'))) return { ...none, partly: `It reads stream-json input (${f.as}), where the program that writes to stdin can switch the permission mode.`, kind: 'load' };
  if (r.unknown.length) return { ...none, partly: `It passes ${text(r.unknown[0].as, 80)}, which is not a flag of Claude Code ${CLAUDE_VERSION}, so the office cannot tell which arguments are its values.`, kind: 'unknown' };
  return none;
}
/** Why a claude CLI argument list does not hold calls in this office ('' = it does): the run as Paperclip starts it. */
export function argsWhy(args, hooksFile) { return argsRead(args, hooksFile).why; }

// ---------- the env of a run: key names only ----------
// Env keys of Claude Code 2.1.318 (its binary) that turn off hooks or permissions, and keys that load what the office cannot
// read. The office reads the names in adapterConfig.env (and in the env of a run's command line), never a value, so a key
// counts whatever its value is, and it never writes env. Paperclip's own process env is passed to the run too, and the office
// cannot see it.
const ENV_OFF = {
  CLAUDE_CODE_SIMPLE: 'turns off the hooks of settings files (bare mode)',
  CLAUDE_CODE_SAFE_MODE: 'turns off hooks (safe mode)',
  CLAUDE_CODE_PERSONAL_HOOKS_OFF: 'can turn off your own hooks',
  CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: 'can stop your own hooks',
  CLAUDE_CODE_MANAGED_SETTINGS_PATH: 'loads policy settings that can allow calls or turn off the office hooks',
  CLAUDE_BG_SESSION_PERMISSION_RULES: 'adds permission rules that can allow calls',
  CLAUDE_CODE_REMOTE_TOOLS_HOST_ALLOWS_UNATTENDED: 'lets tools run with no one to ask',
  CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: 'skips more permission checks',
  // keys that can run another program in place of the office hook, or change which program or file loads (review 76, finding 1)
  CLAUDE_CODE_SHELL_PREFIX: 'runs every shell command through another program',
  CLAUDE_CODE_GIT_BASH_PATH: 'picks the shell program that runs the hooks',
  BASH_ENV: 'runs a script before each shell command, and it can answer the office hook',
  ENV: 'runs a script when a shell starts, and it can answer the office hook',
  SHELLOPTS: 'changes how the shell runs, and it can answer the office hook',
  BASHOPTS: 'changes how the shell runs, and it can answer the office hook',
  PS4: 'can run a command each time a shell traces, and it can answer the office hook',
  NODE_OPTIONS: 'can load code into the hook program, and it can answer the office hook',
  NODE_PATH: 'can change which code the hook program loads, and it can answer the office hook',
  PATH: 'can change which program runs as claude or as the hook, and it can answer the office hook',
  PATHEXT: 'can change which program a name starts, and it can answer the office hook',
};
const ENV_LOAD = {
  CLAUDE_CODE_PLUGIN_DIRS: 'loads plugins, and a plugin hook can allow a call without the office',
  CLAUDE_CODE_REMOTE_SETTINGS_PATH: 'loads other settings, which the office cannot read',
  CLAUDE_CHROME_PERMISSION_MODE: 'sets how Claude in Chrome asks, which the office cannot check',
  CLAUDE_CODE_DISABLE_HOOK_FORWARDING: 'changes how hooks are passed on, which the office cannot check',
};
// The key names of an env object (Object.keys reads no value). Windows env names do not care about case.
const envKeys = (env) => Object.keys(obj(env));
// A copy of an adapter config that keeps the env key names and drops every value (review 76, finding 8): the office never
// holds an env value in memory, since a key is all it reads.
const noEnv = (cfg) => (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && 'env' in cfg ? { ...cfg, env: Object.fromEntries(envKeys(cfg.env).map((k) => [k, ''])) } : cfg);
export function scrubAgent(a) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a };
  if (a.adapterConfig) out.adapterConfig = noEnv(a.adapterConfig);
  const profiles = obj(obj(a.runtimeConfig).modelProfiles);
  if (Object.keys(profiles).length) out.runtimeConfig = { ...a.runtimeConfig, modelProfiles: Object.fromEntries(Object.entries(profiles).map(([k, p]) => [k, obj(p).adapterConfig ? { ...p, adapterConfig: noEnv(p.adapterConfig) } : p])) };
  return out;
}
export function scrubIssue(i) {
  const o = obj(obj(i).assigneeAdapterOverrides);
  return o.adapterConfig ? { ...i, assigneeAdapterOverrides: { ...o, adapterConfig: noEnv(o.adapterConfig) } } : i;
}
// a project or a routine: its id and the key names of its env, nothing else of the env
const envOnly = (x) => ({ ...x, env: Object.fromEntries(envKeys(x && x.env).map((k) => [k, ''])) });
// The two lists above are what the office knows of Claude Code 2.1.318 and Node: they cannot be complete. So a key of the
// families that configure Claude Code or the hook program (CLAUDE_CODE_*, CLAUDE_BG_*, NODE_*) that the office has not
// read is Partly supervised, except these, which only carry a login, a provider choice or a size (review 76, round 4).
const ENV_KNOWN_SAFE = new Set(['NODE_ENV', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
const ENV_FAMILY = /^(CLAUDE_CODE_|CLAUDE_BG_|NODE_)/;
function envRead(keys) {
  const names = strings(keys).map((k) => k.toUpperCase());
  for (const k of names) if (Object.hasOwn(ENV_OFF, k)) return { why: `Its env has ${k}, which ${ENV_OFF[k]}.`, partly: '' };
  for (const k of names) if (Object.hasOwn(ENV_LOAD, k)) return { why: '', partly: `Its env has ${k}, which ${ENV_LOAD[k]}.` };
  for (const k of names) if (ENV_FAMILY.test(k) && !ENV_KNOWN_SAFE.has(k)) return { why: '', partly: `Its env has ${k}, a setting of Claude Code or Node that the office does not know, so it cannot tell if it keeps the office hooks.` };
  return { why: '', partly: '' };
}

/** Why an adapter config does not hold its runs' calls in this office ('' = it does). */
export function configWhy(cfg, hooksFile) {
  const c = obj(cfg);
  if (c.engine !== 'cli') return c.engine ? `It runs on the ${c.engine} engine, which ignores the office hooks.` : 'It runs on the ACP engine (the default), which approves every call and ignores the office hooks.';
  if (c.dangerouslySkipPermissions !== false) return 'Skip permissions is on (dangerouslySkipPermissions is not false).';
  return envRead(envKeys(c.env)).why || argsWhy(argsOf(c), hooksFile);
}
/**
 * Why the program a run starts may not be Claude Code ('' = it is claude): adapterConfig.command, which Paperclip uses when it
 * is a text that is not empty (else claude, execute.ts), or the program of a run's command line. Another program may pass the
 * calls on to Claude Code with the office hooks, or not: the office cannot tell, so the agent is Partly supervised.
 */
export function commandWhy(command) {
  const cmd = typeof command === 'string' && command.length ? command : 'claude';
  if (CLAUDE.has(cmd.toLowerCase())) return '';   // a bare name only: a path, or a name with a folder, is not checked (the folder may hold another program)
  return `It starts ${text(cmd, 120)}, not claude. The office cannot tell if that program uses the office hooks.`;
}
const CLAUDE = new Set(['claude', 'claude.exe']);
// A run on another computer: Paperclip logs its program as '<scheme>://... :: claude' (execution-target.ts, server-utils.ts).
// Its hooks run there, so its calls never reach this office.
function remoteWhy(command) {
  const m = typeof command === 'string' ? /^(ssh|sandbox):\/\//i.exec(command.trim()) : null;
  return m ? `It runs on another computer (${m[1].toLowerCase()}), so its calls never reach the office hooks.` : '';
}
// The Partly supervised words of each reason: [for the agent, for its last run].
const PARTLY = {
  program: ['it starts another program', 'its last run started another program'],
  load: ['it loads what the office cannot check', 'its last run loaded what the office cannot check'],
  unknown: ['it passes a flag the office does not know', 'its last run passed a flag the office does not know'],
  env: ['its env loads what the office cannot check', 'the env of its last run loads what the office cannot check'],
};
// Why the office cannot check all calls of a config whose settings are right: { why, kind } or null. Supervise in office
// leaves all of these as they are.
function partlyOf(cfg, hooksFile) {
  const c = obj(cfg);
  const program = commandWhy(c.command);
  if (program) return { why: program, kind: 'program' };
  const r = argsRead(argsOf(c), hooksFile);
  if (r.partly) return { why: r.partly, kind: r.kind };
  const env = envRead(envKeys(c.env));
  if (env.partly) return { why: env.partly, kind: 'env' };
  // adapterConfig.chrome turns on Claude in Chrome (an unset or false value does not)
  if (c.chrome !== undefined && c.chrome !== null && c.chrome !== false) return { why: 'It turns on Claude in Chrome (chrome), whose browser actions the office cannot check.', kind: 'load' };
  return null;
}
/**
 * What one run's command line says (adapter.invoke: its program, arguments and the key names of its env): { ok, why, partly,
 * kind }. partly: the run's calls reach the office, but the office cannot check all of them (kind: a PARTLY key).
 */
export function runCheck(command, args, hooksFile, keys = []) {
  const env = envRead(keys), r = argsRead(args, hooksFile);
  const why = remoteWhy(command) || env.why || r.why;
  if (why) return { ok: false, why, partly: false, kind: '' };
  const program = commandWhy(command);
  // Paperclip logs at most 50 arguments of a run line: a list that long may be cut, and the part cut is not read
  if (strings(args).length >= 50 && !program && !r.partly) return { ok: false, why: 'Its run line has 50 or more arguments, and Paperclip may have cut it, so the office cannot read all of it.', partly: true, kind: 'unknown' };
  const p = program ? { why: program, kind: 'program' } : r.partly ? { why: r.partly, kind: r.kind } : env.partly ? { why: env.partly, kind: 'env' } : null;
  return p ? { ok: false, why: p.why, partly: true, kind: p.kind } : { ok: true, why: '', partly: false, kind: '' };
}

/**
 * The supervision of one Paperclip agent: { state, label, why, can }.
 * state: 'supervised' (its runs hold every call Claude Code asks about in the office), 'partly' (the office cannot check all
 * of its calls: another program than claude, a flag or env key that loads what the office cannot read, a flag it does not
 * know, or a model profile or an open issue that changes the run config), 'unsupervised', or 'unknown' (Paperclip did not
 * show the config).
 * label: '' for a supervised agent, else the words a bot card and the HQ list show (ADR 0001). can: "Supervise in office" can
 * set it up (a claude_local agent that is not supervised yet, and nothing Supervise does not change stands in the way).
 * issues: the agent's open issues (their adapter overrides). lastRun: { ok, why, partly, kind } from the command line of its
 * last run (adapter.invoke, runCheck), the last word on what ran.
 */
export function supervisionOf(agent, hooksFile, { issues = [], lastRun = null, unread = [], layers = [] } = {}) {
  const a = obj(agent);
  if (a.adapterType !== 'claude_local') {
    const why = `Its runs use ${a.adapterType || 'another adapter'}, not Claude Code, so they never reach the office hooks.`;
    return { state: 'unsupervised', label: 'Unsupervised: runs without the office hooks', why, can: false };
  }
  if (!a.adapterConfig || typeof a.adapterConfig !== 'object' || Array.isArray(a.adapterConfig) || !Object.keys(a.adapterConfig).length) return { state: 'unknown', label: 'Unsupervised: config not shown', why: 'Paperclip did not show its adapter config to the office, so the office cannot tell.', can: false };
  const cfg = a.adapterConfig;
  // What Supervise in office does not change (the env, a cloud session): it is not offered, and the wall says why.
  const env = envRead(envKeys(cfg.env)).why, args = argsRead(argsOf(cfg), hooksFile);
  if (env) return { state: 'unsupervised', label: 'Unsupervised: its env turns off the office', why: `${env} Supervise in office does not change env: change it in Paperclip.`, can: false };
  if (args.stuck) return { state: 'unsupervised', label: 'Unsupervised', why: `${args.why} Supervise in office does not change that: change it in Paperclip.`, can: false };
  const base = configWhy(cfg, hooksFile);
  if (base) return { state: 'unsupervised', label: 'Unsupervised', why: base, can: true };
  // The config is right, but the last run Paperclip started was not (an issue or model profile override, or a run that
  // started before the change): the PATCH would change nothing, so it is not offered. The next run that is held clears it.
  if (lastRun && lastRun.ok === false) {
    return lastRun.partly
      ? { state: 'partly', label: `Partly supervised: ${(PARTLY[lastRun.kind] || PARTLY.program)[1]}`, why: `Its last run: ${lastRun.why}`, can: false }
      : { state: 'unsupervised', label: 'Unsupervised: its last run skipped the office', why: `Its last run: ${lastRun.why}`, can: false };
  }
  const partly = partlyOf(cfg, hooksFile);
  if (partly) return { state: 'partly', label: `Partly supervised: ${PARTLY[partly.kind][0]}`, why: partly.why, can: false };
  // What the office could not read (a failed read of the issues, routines or projects): never Supervised (fail closed)
  if (unread.length) return { state: 'partly', label: 'Partly supervised: the office could not read all of its setup', why: `The office could not read the ${unread.join(', ')} of this company, which can change how its runs start.`, can: false };
  // The env of a project or a routine of this agent (key names only) is passed to its runs too.
  for (const l of layers) {
    const e = envRead(l.keys);
    if (e.why) return { state: 'unsupervised', label: 'Unsupervised: its env turns off the office', why: `For ${l.name}: ${e.why} Supervise in office does not change env: change it in Paperclip.`, can: false };
    if (e.partly) return { state: 'partly', label: `Partly supervised: ${PARTLY.env[0]}`, why: `For ${l.name}: ${e.partly}`, can: false };
  }
  // A model profile or an issue's adapter overrides are merged over the config for some runs (heartbeat.ts). Each bad setting
  // is a fault on its own (a later layer replaces a key, and env keys only add), so each layer is read over the config alone.
  const merged = (...os) => {
    const m = { ...cfg }; let env = { ...obj(cfg.env) };
    for (const o of os) { Object.assign(m, obj(o)); env = { ...env, ...obj(obj(o).env) }; }
    m.env = env;
    return configWhy(m, hooksFile) || (partlyOf(m, hooksFile) || {}).why || '';
  };
  const profiles = Object.entries(obj(obj(a.runtimeConfig).modelProfiles)).filter(([, p]) => obj(p).enabled !== false && obj(p).adapterConfig);
  const overs = issues.map((i) => [i, obj(obj(i).assigneeAdapterOverrides).adapterConfig]).filter(([i, o]) => o && i.assigneeAgentId === a.id);
  for (const [key, p] of profiles) {
    const why = merged(p.adapterConfig);
    if (why) return { state: 'partly', label: 'Partly supervised: a model profile skips the office', why: `With the ${key} model profile: ${why}`, can: false };
  }
  const issueName = (i) => i.identifier || i.title || 'one issue';
  for (const [i, o] of overs) {
    const why = merged(o);
    if (why) return { state: 'partly', label: 'Partly supervised: an issue skips the office', why: `For ${issueName(i)}: ${why}`, can: false };
  }
  return { state: 'supervised', label: '', why: '', can: false };
}

/**
 * The one PATCH body of "Supervise in office": the CLI engine, skip permissions off, and the run's arguments with the
 * default permission mode and the office hooks file at the end (before a --, after which Claude Code reads only text). The
 * agent's other arguments stay as Claude Code reads them; a self flag with its values, an earlier permission mode and an
 * earlier copy of the office hooks file go. An earlier --settings of the agent stays in the list, but Claude Code then loads
 * only the office's (the last one): supervise() says so in the feed. The env and the program are never in the patch.
 */
export function supervisePatch(agent, hooksFile) {
  const args = argsOf(obj(agent).adapterConfig), r = readArgs(args), drop = new Set();
  for (const f of r.flags) {
    if (f.part) continue;   // a short flag inside another argument: none of the ones below has a short spelling
    if (f.e.kind === 'self' || named(f, '--permission-mode') || (named(f, '--settings') && samePath(f.values[0], hooksFile))) {
      for (let k = f.first; k <= f.last; k++) drop.add(k);
    }
  }
  const kept = args.filter((_, k) => !drop.has(k));
  // A flag at the end that takes a value and has none would take the next argument we add as its value: the office's
  // arguments go in front of it. (Not a flag the patch drops.)
  const dangling = r.flags.find((f) => (f.e.takes === 1 || f.e.takes === '+') && !f.values.length && f.last === args.length - 1);
  const stop = Math.min(r.end, dangling ? dangling.first : args.length);
  const cut = stop - [...drop].filter((k) => k < stop).length;
  return { adapterConfig: { engine: 'cli', dangerouslySkipPermissions: false, extraArgs: [...kept.slice(0, cut), '--permission-mode', 'default', '--settings', hooksFile, ...kept.slice(cut)] } };
}

// The ids a run carries (runIds, cleanIds) live in payload.mjs: hook.mjs reads them from the environment Paperclip gives
// Claude Code, and the command hook stays light.
export { runIds, cleanIds };

// ---------- the watcher ----------
const cents = (n) => (Number.isFinite(+n) && +n >= 0 ? Math.round(+n) / 100 : 0);
const ms = (t) => { const v = t ? Date.parse(t) : NaN; return Number.isFinite(v) ? v : null; };
const text = (v, n = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const httpError = (status, message) => Object.assign(new Error(message), { status });
// Run states that end a run (heartbeat.ts). A run that ends refreshes the budgets (Paperclip records its cost).
const ISSUE_LIST_LIMIT = 500;
const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'error']);

/**
 * createHq(deps) -> the Paperclip watcher. deps: { hooksFile() (the office's command hooks file, the path Supervise writes),
 * onChange(), onFeed(text, kind), onRun({ agentId, runId, status }) (a run ended), fetch, WebSocket, setTimer, clearTimer,
 * refetchMs, retryMs }. connect, disconnect, supervise, view (the snapshot part), labelOf (a session's label). Only the
 * labels need the company match: a held call of any Paperclip run waits the long hold (server.mjs holdRequest).
 */
export function createHq(deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const Ws = deps.WebSocket || globalThis.WebSocket;
  const hooksFile = deps.hooksFile || (() => '');
  const changed = () => deps.onChange?.();
  const feed = (t, kind = 'tool') => deps.onFeed?.(t, kind);
  const setTimer = deps.setTimer || ((fn, n) => { const t = setTimeout(fn, n); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer || clearTimeout;
  const REFETCH_MS = deps.refetchMs ?? 800;
  const RETRY_MS = deps.retryMs || [1000, 2000, 5000, 10000, 30000];

  let c = null;   // the connection: { url, companyId, state, error, ws, tries, timer, refetch, busy, companies }
  let d = null;   // what Paperclip said: { company, agents: Map, issues, routines, runs: Map agentId -> run, last: Map agentId -> lastRun }

  async function call(conn, route, init = {}) {
    let res;
    try {
      res = await doFetch(conn.url + route, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.method ? 15000 : 8000), headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } catch (e) { throw httpError(502, `No Paperclip answers at ${conn.url} (${e.cause?.code || e.name || 'no answer'}).`); }
    const body = await res.text();
    if (res.status === 401 || res.status === 403) throw httpError(502, `Paperclip at ${conn.url} asks for sign-in (${res.status}). The office reads a Paperclip that runs in local_trusted mode (paperclipai run --bind loopback).`);
    if (!res.ok) throw httpError(502, `Paperclip answered ${res.status} for ${route.split('?')[0]}${body ? `: ${text(body, 160)}` : '.'}`);
    try { return body ? JSON.parse(body) : null; } catch { throw httpError(502, `Paperclip at ${conn.url} did not answer JSON for ${route.split('?')[0]}.`); }
  }
  const list = (v) => (Array.isArray(v) ? v : []);

  // Every read of one company. Routines and live runs are optional (an older Paperclip may not have them).
  async function read(conn) {
    const id = encodeURIComponent(conn.companyId);
    const unread = [];
    const opt = (name, route, fallback = []) => call(conn, route).catch(() => { unread.push(name); return fallback; });
    const [company, agents, issues, routines, projects, live] = await Promise.all([
      call(conn, `/api/companies/${id}`),
      call(conn, `/api/companies/${id}/agents`),
      opt('issues', `/api/companies/${id}/issues?status=backlog,todo,in_progress,in_review,blocked`),
      opt('routines', `/api/companies/${id}/routines`),
      opt('projects', `/api/companies/${id}/projects`),
      call(conn, `/api/companies/${id}/live-runs`).catch(() => []),
    ]);
    if (c !== conn) return;
    // What the office cannot tell fails closed (review 76, round 4). Paperclip lists at most 500 issues by default, so a list
    // that long may be cut; and a project or routine with no env field may come from a Paperclip that has none.
    if (list(issues).length >= ISSUE_LIST_LIMIT) unread.push('issues (the list may be cut)');
    if (list(projects).some((x) => x && typeof x === 'object' && !('env' in x))) unread.push('project env');
    if (list(routines).some((x) => x && typeof x === 'object' && !('env' in x))) unread.push('routine env');
    const runs = d && d.company && d.company.id === conn.companyId ? d.runs : new Map();
    for (const r of list(live)) if (r && r.agentId && r.id) runs.set(r.agentId, { id: r.id, status: r.status || 'running' });
    // env values are dropped here: only the key names are kept (scrubAgent, scrubIssue, envOnly)
    d = { company: obj(company), agents: new Map(list(agents).filter((a) => a && a.id).map((a) => [a.id, scrubAgent(a)])), issues: list(issues).map(scrubIssue), routines: list(routines).map(envOnly), projects: list(projects).map(envOnly), unread, runs, last: d && d.last ? d.last : new Map() };
    changed();
  }
  function refetchSoon(conn) {
    if (conn.refetch) return;
    conn.refetch = setTimer(() => { conn.refetch = null; if (c === conn) read(conn).catch((e) => lose(conn, e.message)); }, REFETCH_MS);
  }

  function onEvent(conn, ev) {
    if (!ev || typeof ev !== 'object' || ev.companyId !== conn.companyId || !d) return;
    const p = obj(ev.payload);
    switch (ev.type) {
      case 'heartbeat.run.queued': case 'heartbeat.run.status': {
        if (!p.agentId || !p.runId) return;
        const status = ev.type === 'heartbeat.run.queued' ? 'queued' : String(p.status || 'running');
        d.runs.set(p.agentId, { id: p.runId, status, error: text(p.error, 200) || null });
        if (ENDED.has(status)) { deps.onRun?.({ agentId: p.agentId, runId: p.runId, status }); refetchSoon(conn); }
        changed();
        return;
      }
      case 'agent.status': {
        const a = d.agents.get(p.agentId);
        if (a && typeof p.status === 'string') { a.status = p.status; if (p.lastHeartbeatAt) a.lastHeartbeatAt = p.lastHeartbeatAt; changed(); }
        return;
      }
      case 'heartbeat.run.event': {
        // adapter.invoke carries the command line Paperclip started (its program and arguments): the last word on whether
        // this run is held in the office
        if (p.eventType !== 'adapter.invoke') return;
        const a = d.agents.get(p.agentId), inv = obj(p.payload), args = inv.commandArgs;
        if (!a || a.adapterType !== 'claude_local' || !Array.isArray(args)) return;
        // the env of the run as Paperclip logs it (its adapter env and its own ids): key names only, as for adapterConfig.env
        const r = runCheck(inv.command, args, hooksFile(), envKeys(inv.env));
        const was = d.last.get(a.id), name = text(a.name, 60) || 'an agent';
        d.last.set(a.id, { run: p.runId, ...r });
        if (r.partly) feed(r.kind === 'program' ? `Paperclip started a run of ${name} with another program: ${r.why}` : `Paperclip started a run of ${name} that the office cannot check: ${r.why}`, 'wait');
        else if (!r.ok) feed(`Paperclip started a run of ${name} without the office: ${r.why} Its tool calls are not held.`, 'wait');
        if (!was || was.ok !== r.ok || was.why !== r.why) changed();
        return;
      }
      case 'activity.logged': refetchSoon(conn); return;   // agents, issues, routines, budgets: read them again
      default: return;   // run logs and plugin events are not shown
    }
  }

  function openSocket(conn) {
    if (!Ws) { lose(conn, 'This Node has no WebSocket, so the office cannot follow Paperclip live.'); return; }
    let ws;
    try { ws = new Ws(`${conn.url.replace(/^http/, 'ws')}/api/companies/${encodeURIComponent(conn.companyId)}/events/ws`); } catch (e) { lose(conn, e.message); return; }
    conn.ws = ws;
    ws.onopen = () => { if (c !== conn) { try { ws.close(); } catch { /* gone */ } return; } conn.state = 'on'; conn.error = ''; conn.tries = 0; changed(); refetchSoon(conn); };
    ws.onmessage = (m) => { if (c !== conn) return; let ev; try { ev = JSON.parse(String(m.data)); } catch { return; } onEvent(conn, ev); };
    ws.onclose = () => { if (c !== conn || conn.ws !== ws) return; conn.ws = null; lose(conn, 'The live events of Paperclip stopped.'); };
    ws.onerror = () => { /* onclose follows */ };
  }
  // The connection is lost: say why and try again later (1 s, 2 s, 5 s, 10 s, then every 30 s).
  function lose(conn, why) {
    if (c !== conn) return;
    conn.state = 'lost'; conn.error = why;
    if (conn.ws) { const w = conn.ws; conn.ws = null; try { w.close(); } catch { /* gone */ } }
    changed();
    if (conn.timer) return;
    conn.timer = setTimer(async () => {
      conn.timer = null;
      if (c !== conn) return;
      try { await read(conn); if (c === conn) openSocket(conn); } catch (e) { lose(conn, e.message); }
    }, RETRY_MS[Math.min(conn.tries++, RETRY_MS.length - 1)]);
  }

  function stop() {
    if (!c) return;
    const old = c; c = null; d = null;
    if (old.timer) clearTimer(old.timer);
    if (old.refetch) clearTimer(old.refetch);
    if (old.ws) { try { old.ws.close(); } catch { /* gone */ } }
  }

  /**
   * Connect to one company. { url, company?, keep? }. Throws 400 for an address the office refuses, before any request.
   * With several companies and none named, nothing is watched yet: { choose: [{ id, name }] }. keep: a saved connection at
   * start: a Paperclip that does not answer yet is tried again, not given up.
   */
  async function connect({ url, company = null, keep = false } = {}) {
    const u = checkUrl(url);
    if (!u.ok) throw httpError(400, u.error);
    stop();
    const conn = c = { url: u.url, companyId: company ? String(company) : null, state: 'connecting', error: '', ws: null, tries: 0, timer: null, refetch: null, busy: new Set(), companies: null };
    changed();
    try {
      const health = await call(conn, '/api/health');
      if (!health || health.status !== 'ok') throw httpError(502, `${conn.url} is not a Paperclip that is ready (its /api/health did not say ok).`);
      const all = list(await call(conn, '/api/companies')).filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: text(x.name, 80) || String(x.id) }));
      if (c !== conn) return { ok: false };
      if (conn.companyId && !all.some((x) => x.id === conn.companyId)) throw httpError(404, 'Paperclip has no company with that id.');
      if (!conn.companyId) {
        if (!all.length) throw httpError(409, 'Paperclip has no company yet. Make one in Paperclip, then connect again.');
        if (all.length > 1) { conn.state = 'choose'; conn.companies = all; changed(); return { choose: all }; }
        conn.companyId = all[0].id;
      }
      await read(conn);
      if (c !== conn) return { ok: false };
      openSocket(conn);
      return { ok: true, url: conn.url, company: conn.companyId };
    } catch (e) {
      if (c !== conn) throw e;
      if (keep && conn.companyId) { lose(conn, e.message); return { ok: false, error: e.message }; }
      stop(); changed();
      throw e;
    }
  }
  // What the watcher holds of Paperclip, for tests: the env of every part is key names only.
  const held = () => (d ? { agents: [...d.agents.values()], issues: d.issues, routines: d.routines, projects: d.projects } : null);
  function disconnect() { const had = !!c; stop(); if (had) changed(); }

  const issueOf = (agentId) => {
    const mine = (d ? d.issues : []).filter((i) => i && i.assigneeAgentId === agentId);
    return mine.find((i) => i.status === 'in_progress') || mine.find((i) => i.status === 'in_review') || mine.find((i) => i.status === 'todo') || null;
  };
  function layersOf(a) {
    if (!d) return [];
    const out = [];
    // A project env applies to every run on an issue of the project, and an agent can be given an issue of any project (or
    // woken on one in a status the office does not list), so every project counts.
    for (const p of d.projects) if (p && p.id) out.push({ name: `its project ${text(p.name, 60) || p.id}`, keys: envKeys(p.env) });
    for (const r of d.routines) if (r && (r.assigneeAgentId === a.id || !r.assigneeAgentId)) out.push({ name: `its routine ${text(r.title, 60) || r.id}`, keys: envKeys(r.env) });
    return out;
  }
  const supOf = (a) => supervisionOf(a, hooksFile(), { issues: d ? d.issues.filter((i) => i && i.assigneeAgentId === a.id && i.status !== 'done') : [], lastRun: d ? d.last.get(a.id) : null, unread: d ? d.unread : [], layers: layersOf(a) });
  function agentView(a) {
    const i = issueOf(a.id), hb = obj(obj(a.runtimeConfig).heartbeat), run = d.runs.get(a.id) || null;
    return {
      id: a.id, name: text(a.name, 60) || 'Agent', role: roleLabel(a.role), title: text(a.title, 60), status: text(a.status, 30), kind: text(a.adapterType, 40),
      supervision: supOf(a), run: run ? { id: run.id, status: run.status } : null,
      task: i ? { id: i.id, identifier: text(i.identifier, 30), title: text(i.title, 100), status: i.status } : null,
      budget: { spent: cents(a.spentMonthlyCents), limit: cents(a.budgetMonthlyCents) },
      heartbeat: { on: hb.enabled === true && +hb.intervalSec > 0, every: Math.max(0, +hb.intervalSec || 0), last: ms(a.lastHeartbeatAt) },
      busy: !!(c && c.busy.has(a.id)),
    };
  }
  function routineView(r) {
    const trig = list(r.triggers).filter((t) => t && t.enabled !== false);
    const next = trig.map((t) => ms(t.nextRunAt)).filter((x) => x != null).sort((x, y) => x - y)[0] ?? null;
    const a = r.assigneeAgentId && d.agents.get(r.assigneeAgentId);
    return { id: r.id, title: text(r.title, 100) || 'Routine', status: text(r.status, 30), agent: a ? text(a.name, 60) : '', next, cron: text((trig.find((t) => t.cronExpression) || {}).cronExpression, 60), last: ms(r.lastTriggeredAt) };
  }

  /** The HQ part of the snapshot, or null while the office is not connected. Money in dollars, times in ms. */
  function view() {
    if (!c) return null;
    const base = { state: c.state, url: c.url, error: c.error, companies: c.state === 'choose' ? c.companies : null };
    if (!d) return { ...base, company: null, budget: null, agents: [], routines: [] };
    return {
      ...base,
      company: { id: String(d.company.id || c.companyId), name: text(d.company.name, 80) || 'Paperclip' },
      budget: { spent: cents(d.company.spentMonthlyCents), limit: cents(d.company.budgetMonthlyCents) },
      agents: [...d.agents.values()].filter((a) => a.status !== 'terminated').map(agentView),
      routines: d.routines.filter((r) => r && r.id && r.status !== 'archived').map(routineView),
    };
  }
  /** A Paperclip run's label for its office session (hook ids), or null when the agent is not one of the watched company. */
  function labelOf(ids) {
    const x = cleanIds(ids);
    if (!x || !c || !d || x.company !== c.companyId) return null;
    const a = d.agents.get(x.agent);
    if (!a) return null;
    const v = agentView(a);
    const task = (x.task && d.issues.find((i) => i && i.id === x.task)) || null;
    const t = task ? { identifier: text(task.identifier, 30), title: text(task.title, 100) } : v.task;
    return { agent: v.name, role: v.title || v.role, company: text(d.company.name, 80) || 'Paperclip', task: t ? [t.identifier, t.title].filter(Boolean).join(' ') : '', budget: v.budget, run: x.run || null };
  }

  /**
   * "Supervise in office" for one agent: one PATCH of its adapter config (supervisePatch). The caller checked the Confirm.
   * The PATCH replaces extraArgs whole, so the agent is read again (GET /api/agents/:id) just before it, and the change is
   * built from that read: a change made in Paperclip since the office last read the company stays.
   */
  async function supervise(agentId) {
    const conn = c;
    if (!conn || !d || conn.state === 'choose') throw httpError(409, 'Paperclip is not connected.');
    const id = String(agentId || '');
    if (!d.agents.has(id)) throw httpError(404, 'Paperclip has no such agent in this company.');
    if (conn.busy.has(id)) throw httpError(409, 'The office is already setting up this agent.');
    const file = hooksFile();
    if (!file) throw httpError(500, 'The office has no hooks file yet.');
    conn.busy.add(id); changed();
    try {
      const route = `/api/agents/${encodeURIComponent(id)}`;
      const a = scrubAgent(await call(conn, route));
      if (c !== conn || !d) return { ok: false };
      if (!a || a.id !== id || a.companyId !== conn.companyId) throw httpError(404, 'Paperclip has no such agent in this company.');
      d.agents.set(id, a);
      const before = supOf(a);
      if (before.state === 'supervised') return { ok: true, already: true, supervision: before };
      if (!before.can) throw httpError(409, `Supervise in office cannot set up ${text(a.name, 60)}: ${before.why}`);
      const patch = supervisePatch(a, file);
      const out = scrubAgent(await call(conn, route, { method: 'PATCH', body: JSON.stringify(patch) }));
      if (c !== conn || !d) return { ok: false };
      // Paperclip's PATCH has no version check, so a change saved in Paperclip at the same time can replace the office's.
      // The agent is read once more, and its supervision comes from what Paperclip keeps, not from what the office sent.
      const saved = scrubAgent(await call(conn, route));
      if (c !== conn || !d) return { ok: false };
      const now = saved && saved.id === id ? saved : out && out.id === id ? out : null;
      if (now) d.agents.set(id, now);
      d.last.delete(id);
      const after = supOf(d.agents.get(id)), name = text(a.name, 60);
      const sent = patch.adapterConfig.extraArgs, got = strings(obj(obj(now).adapterConfig).extraArgs);
      if (now && (got.length !== sent.length || got.some((x, k) => x !== sent[k]))) {
        feed(`Supervise in office: Paperclip saved other arguments for ${name} than the office sent (a change made in Paperclip at the same time). The office shows the saved config${after.why ? `: ${after.why}` : ', which holds its calls here.'}`, 'wait');
        return { ok: after.state === 'supervised', supervision: after };
      }
      // the agent's own --settings stay in its arguments, but only the last one loads, and that is the office's now
      const own = settingsOf(readArgs(sent)).filter((f) => !samePath(f, file)).map((f) => text(f, 80));
      const lost = after.state === 'supervised' && own.length ? ` Its own --settings ${own.join(', ')} no longer ${own.length > 1 ? 'load' : 'loads'}: Claude Code loads only the last --settings.` : '';
      feed(after.state === 'supervised'
        ? `Supervise in office: ${name} now runs Claude Code with the office hooks. Its next run asks here.${lost}`
        : `Supervise in office: Paperclip took the change for ${name}, but ${after.why.charAt(0).toLowerCase()}${after.why.slice(1)}`);
      return { ok: after.state === 'supervised', supervision: after };
    } finally { conn.busy.delete(id); changed(); }
  }

  return { connect, disconnect, supervise, view, labelOf, held, state: () => (c ? c.state : 'off') };
}
