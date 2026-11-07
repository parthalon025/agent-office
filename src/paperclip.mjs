// Paperclip as an optional HQ above the office (#76). A watcher of an outside system, not a provider: the office never opens,
// drives or closes a Paperclip run. Paperclip owns its goals, heartbeats, routines and budgets; the office reads its REST
// routes and its live events (WebSocket /api/companies/{id}/events/ws) and shows them. Its Claude Code runs reach the office
// like any terminal session, through the office hooks (hook.mjs adds the PAPERCLIP_* ids of the run), once "Supervise in
// office" has set the agent up for that. That PATCH, after the Security room's painted Confirm, is the one write the office
// made to Paperclip (ADR 0005); the goal handoff (ADR 0007) is the second. Since ADR 0010 every other write goes through `write` (#198), after the
// HQ write grid. The office never sends a heartbeat and never runs a routine.
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
import { readArgs, CLAUDE_FLAGS_VERSION } from './providers/claude-code.mjs';
import { floorsOf, cablesOf, lobbyOf, costsOf, roomsOf, monthWindows, searchOf, shapeProblems, planWrite, writeValueOf, WRITE_KINDS } from './hq-model.mjs';
import { archetypeOf, GENERAL } from './archetypes.mjs';

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
  if (r.unknown.length) return { ...none, partly: `It passes ${text(r.unknown[0].as, 80)}, which is not a flag of Claude Code ${CLAUDE_FLAGS_VERSION}, so the office cannot tell which arguments are its values.`, kind: 'unknown' };
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

/** The adapter type of the office adapter plugin (src/integrations/paperclip-adapter). */
export const OFFICE_ADAPTER = 'agent_office';

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
  // The office adapter (#200) hands every run to the office: its calls go through the Security room, whatever the agent kind.
  if (a.adapterType === OFFICE_ADAPTER) return { state: 'supervised', label: '', why: 'Its runs go through the office adapter, so the Security room decides every call.', can: false };
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

/**
 * The company the orientation step makes (#199): { name, archetype, description }. The name is 1 to 80 characters (a 400 otherwise); the
 * building kind is an archetype id of archetypes.mjs, else General. The description says only where the company came from.
 */
export function companyDraft({ name, archetype } = {}) {
  const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!n) throw httpError(400, 'Name the company.');
  if (n.length > 80) throw httpError(400, 'The company name is at most 80 characters.');
  const a = archetypeOf(archetype) || archetypeOf(GENERAL);
  return { name: n, archetype: a.id, description: `Made by Agent Office from the ${a.name} building kind.` };
}
// Run states that end a run (heartbeat.ts). A run that ends refreshes the budgets (Paperclip records its cost).
const ISSUE_LIST_LIMIT = 500;
const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'error']);

/**
 * createHq(deps) -> the Paperclip watcher. deps: { hooksFile() (the office's command hooks file, the path Supervise writes),
 * onChange(), onFeed(text, kind), onRun({ agentId, runId, status }) (a run ended), fetch, WebSocket, setTimer, clearTimer,
 * refetchMs, retryMs, key(url) (the board key for that address, or null: sent only as a bearer to that address, never held in a view) }.
 * connect, disconnect, supervise, write (the one writer, #198; a reporting line is its kind `reporting`, #202), view (the snapshot part, with the HQ floors and Lobby, #197), model (the fuller read model), labelOf (a session's label). Only the
 * labels need the company match: a held call of any Paperclip run waits the long hold (server.mjs holdRequest).
 */
export function createHq(deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const Ws = deps.WebSocket || globalThis.WebSocket;
  const hooksFile = deps.hooksFile || (() => '');
  const subs = new Set();   // plan source listeners
  const changed = () => { deps.onChange?.(); for (const fn of [...subs]) { try { fn(); } catch { /* a listener never stops the watcher */ } } };
  const feed = (t, kind = 'tool') => deps.onFeed?.(t, kind);
  const setTimer = deps.setTimer || ((fn, n) => { const t = setTimeout(fn, n); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer || clearTimeout;
  const REFETCH_MS = deps.refetchMs ?? 800;
  const RETRY_MS = deps.retryMs || [1000, 2000, 5000, 10000, 30000];

  let c = null;   // the connection: { url, companyId, state, error, ws, tries, timer, refetch, busy, companies }
  let d = null;   // what Paperclip said: { company, agents: Map, issues, routines, runs: Map agentId -> run, last: Map agentId -> lastRun }

  // The board key (the connect mode #194, the Paperclip the office runs #197): asked per call for the address it is used at (deps.key), so it goes only to the Paperclip it was made for (redirects are refused) and is held nowhere.
  const keyOf = (url) => { try { return deps.key?.(url) || null; } catch { return null; } };
  async function call(conn, route, init = {}) {
    let res;
    const key = keyOf(conn.url);
    try {
      res = await doFetch(conn.url + route, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.method ? 15000 : 8000), headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } catch (e) { throw httpError(502, `No Paperclip answers at ${conn.url} (${e.cause?.code || e.name || 'no answer'}).`); }
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw httpError(502, key
        ? `Paperclip at ${conn.url} does not accept the board key (${res.status}). It may be expired or revoked. Connect to Paperclip again with a new key.`
        : `Paperclip at ${conn.url} asks for sign-in (${res.status}). The office reads a Paperclip that runs in local_trusted mode (paperclipai run --bind loopback), or one that you connect with a board key (Attach sessions, Paperclip runtime).`);
    }
    if (!res.ok) throw Object.assign(httpError(502, `Paperclip answered ${res.status} for ${route.split('?')[0]}${body ? `: ${text(body, 160)}` : '.'}`), { upstream: res.status });
    try { return body ? JSON.parse(body) : null; } catch { throw httpError(502, `Paperclip at ${conn.url} did not answer JSON for ${route.split('?')[0]}.`); }
  }
  const list = (v) => (Array.isArray(v) ? v : []);

  // Every read of one company. Routines and live runs are optional (an older Paperclip may not have them).
  async function read(conn) {
    const id = encodeURIComponent(conn.companyId);
    const unread = [];
    const opt = (name, route, fallback = []) => call(conn, route).catch(() => { unread.push(name); return fallback; });
    // The contract (hq-model.mjs SHAPES): an answer in a shape the office does not know is not used. A part is then unknown; company and
    // agents are the ground of everything, so a changed shape there stops the read, loudly.
    const contract = [];
    const shaped = async (name, route, fallback) => {
      let json;
      try { json = await call(conn, route); } catch { unread.push(name); return fallback; }
      const p = shapeProblems(name, json);
      if (p.length) { contract.push(...p); unread.push(name); return fallback; }
      return json;
    };
    const must = async (name, route) => {
      const json = await call(conn, route), p = shapeProblems(name, json);
      if (p.length) throw httpError(502, `Paperclip answered in a shape the office does not know (${p[0]}) Update the office or the pinned Paperclip.`);
      return json;
    };
    const [company, agents, issues, routines, projects, live, goals, approvals, activity, costs, secrets] = await Promise.all([
      must('company', `/api/companies/${id}`),
      must('agents', `/api/companies/${id}/agents`),
      shaped('issues', `/api/companies/${id}/issues?status=backlog,todo,in_progress,in_review,blocked`, []),
      opt('routines', `/api/companies/${id}/routines`),
      opt('projects', `/api/companies/${id}/projects`),
      call(conn, `/api/companies/${id}/live-runs`).catch(() => []),
      shaped('goals', `/api/companies/${id}/goals`, null),
      shaped('approvals', `/api/companies/${id}/approvals?status=pending`, null),
      shaped('activity', `/api/companies/${id}/activity`, null),
      shaped('costs', `/api/companies/${id}/costs/summary`, null),
      shaped('secrets', `/api/companies/${id}/secrets`, null),
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
    for (const p of contract) if (!conn.told.has(p)) { conn.told.add(p); feed(`Paperclip answered in a shape the office does not know, so the office does not use that part. ${p}`, 'wait'); }
    d = { company: obj(company), agents: new Map(list(agents).filter((a) => a && a.id).map((a) => [a.id, scrubAgent(a)])), issues: list(issues).map(scrubIssue), routines: list(routines).map(envOnly), projects: list(projects).map(envOnly), unread, contract, hqRead: readHq({ goals, approvals, activity, costs, secrets }), runs, last: d && d.last ? d.last : new Map() };
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
    const key = keyOf(conn.url);
    try { ws = new Ws(`${conn.url.replace(/^http/, 'ws')}/api/companies/${encodeURIComponent(conn.companyId)}/events/ws`, key ? { headers: { authorization: `Bearer ${key}` } } : undefined); } catch (e) { lose(conn, e.message); return; }
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
    const conn = c = { url: u.url, companyId: company ? String(company) : null, state: 'connecting', error: '', ws: null, tries: 0, timer: null, refetch: null, busy: new Set(), companies: null, told: new Set() };
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
      id: a.id, name: text(a.name, 60) || 'Agent', reportsTo: a.reportsTo ? String(a.reportsTo) : null, role: roleLabel(a.role), title: text(a.title, 60), status: text(a.status, 30), kind: text(a.adapterType, 40),
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

  // What the HQ read model keeps of the extra routes (#197): the fields the page shows and nothing else. An approval's payload, an activity's
  // details and a secret's value are dropped here, so they cannot reach a view. null: the route was not read (unknown, not zero).
  function readHq(x) {
    const rows = (v) => (v ? list(v).filter((r) => r && r.id) : null);
    const goals = rows(x.goals), approvals = rows(x.approvals), activity = rows(x.activity);
    return {
      goals: goals && goals.slice(0, 50).map((g) => ({ id: String(g.id), title: text(g.title, 100), status: text(g.status, 30), level: text(g.level, 30), parentId: g.parentId ? String(g.parentId) : null, ownerAgentId: g.ownerAgentId ? String(g.ownerAgentId) : null })),
      approvals: approvals && approvals.slice(0, 50).map((a) => ({ id: String(a.id), type: text(a.type, 40), status: text(a.status, 30), requestedByAgentId: a.requestedByAgentId ? String(a.requestedByAgentId) : null, at: ms(a.createdAt) })),
      activity: activity && activity.slice(0, 50).map((l) => ({ id: String(l.id), actorType: text(l.actorType, 20), actorId: l.actorId ? String(l.actorId) : '', action: text(l.action, 60), entityType: text(l.entityType, 30), at: ms(l.createdAt) })),
      costs: x.costs && typeof x.costs === 'object' ? { spent: cents(x.costs.spendCents), limit: cents(x.costs.budgetCents) } : null,
      secrets: x.secrets ? list(x.secrets).filter((r) => r && r.name).map((r) => text(r.name, 60)) : null,
    };
  }
  const known = (n) => !!d && !d.unread.some((u) => u === n || u.startsWith(`${n} `));
  const activityOf = (n) => {
    const a = d.hqRead.activity;
    if (!a) return null;
    return a.slice().sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, n).map((l) => {
      const who = l.actorType === 'agent' ? (d.agents.get(l.actorId) ? text(d.agents.get(l.actorId).name, 60) : 'An agent') : (l.actorId ? text(l.actorId, 40) : l.actorType || 'Someone');
      return { id: l.id, text: `${who}: ${l.action}${l.entityType ? ` (${l.entityType})` : ''}`, at: l.at };
    });
  };

  /** The HQ part of the snapshot, or null while the office is not connected. Money in dollars, times in ms. */
  function view() {
    if (!c) return null;
    const base = { state: c.state, url: c.url, error: c.error, companies: c.state === 'choose' ? c.companies : null };
    if (!d) return { ...base, company: null, budget: null, agents: [], routines: [], floors: [], cables: [], rooms: [], lobby: null, search: [], contract: [] };
    const agents = [...d.agents.values()].filter((a) => a.status !== 'terminated').map(agentView), hr = d.hqRead;
    const lobby = lobbyOf({
      agents, issues: known('issues') ? d.issues : null, approvals: known('approvals') ? hr.approvals : null, goals: known('goals') ? hr.goals : null, activity: known('activity') ? activityOf(8) : null,
      costs: known('costs') && hr.costs ? hr.costs : { spent: cents(d.company.spentMonthlyCents), limit: cents(d.company.budgetMonthlyCents) }, secrets: known('secrets') ? hr.secrets : null, unread: d.unread,
    });
    const floors = floorsOf(agents), routines = d.routines.filter((r) => r && r.id && r.status !== 'archived').map(routineView);
    return {
      ...base,
      company: { id: String(d.company.id || c.companyId), name: text(d.company.name, 80) || 'Paperclip' },
      budget: { spent: cents(d.company.spentMonthlyCents), limit: cents(d.company.budgetMonthlyCents) },
      agents,
      floors: floors.map((f) => ({ key: f.key, name: f.name, rank: f.rank, employees: f.employees.map((e) => ({ id: e.id, name: e.name, role: e.role, reportsTo: e.reportsTo, floor: f.name })) })),
      rooms: known('projects') ? roomsOf({ projects: d.projects, agents, issues: known('issues') ? d.issues : null }) : [],
      cables: cablesOf(agents),
      lobby, contract: d.contract,
      routines,
      // what Ctrl+K searches (#214): names and statuses only; an unread route gives no entries
      search: searchOf({ agents, floors, issues: known('issues') ? d.issues : [], goals: known('goals') ? hr.goals : [], approvals: known('approvals') ? hr.approvals : [], routines }),
    };
  }
  /** The view plus the lists behind the Lobby (goals, pending approvals, activity), for GET /api/hq/lobby. Names and counts, never a payload, a value or a key. */
  function model() {
    const v = view();
    if (!v || !d) return v;
    return { ...v, goals: known('goals') ? d.hqRead.goals : null, approvals: known('approvals') ? d.hqRead.approvals : null, activity: known('activity') ? activityOf(30) : null };
  }
  /**
   * The Costs view (#208): the last three UTC months per agent and per project, and the budgets overview, read when asked (the page opens
   * the view; the watcher does not poll them). Null while not connected. A part Paperclip does not answer, or answers in a shape the
   * office does not know, is null (unknown, never zero); `contract` names the shapes. Dollars. Reads only.
   */
  async function costs() {
    const conn = c;
    if (!conn || !d) return null;
    const id = encodeURIComponent(conn.companyId), contract = [];
    const dollars = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) / 100 : null);
    const rows = async (name, route, idKey, nameKey) => {
      let json;
      try { json = await call(conn, route); } catch { return null; }
      const p = shapeProblems(name, json);
      if (p.length) { contract.push(...p.filter((x) => !contract.includes(x))); return null; }
      return list(json).filter((r) => r && r[idKey]).map((r) => ({ id: String(r[idKey]), name: text(r[nameKey], 60) || (d.agents.get(String(r[idKey])) ? text(d.agents.get(String(r[idKey])).name, 60) : '') || 'Unknown', cost: dollars(r.costCents) }));
    };
    const months = await Promise.all(monthWindows((deps.now || Date.now)()).map(async (w) => {
      const q = `?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;
      const [agents, projects] = await Promise.all([rows('costsByAgent', `/api/companies/${id}/costs/by-agent${q}`, 'agentId', 'agentName'), rows('costsByProject', `/api/companies/${id}/costs/by-project${q}`, 'projectId', 'projectName')]);
      return { key: w.key, agents, projects };
    }));
    let budgets = null;
    try {
      const json = await call(conn, `/api/companies/${id}/budgets/overview`), p = shapeProblems('budgets', json);
      if (p.length) contract.push(...p);
      else budgets = {
        paused: Number.isFinite(json.pausedAgentCount) ? json.pausedAgentCount : null,
        policies: json.policies.filter((x) => x && x.policyId && Number.isFinite(x.amount)).map((x) => {
          const money = x.metric === 'billed_cents', n = (v) => (Number.isFinite(v) ? (money ? Math.round(v) / 100 : v) : null);
          return { id: String(x.policyId), scope: text(x.scopeType, 20), name: text(x.scopeName, 60) || text(x.scopeType, 20), metric: text(x.metric, 30), limit: n(x.amount), used: n(x.observedAmount), percent: Number.isFinite(x.utilizationPercent) ? x.utilizationPercent : null, status: text(x.status, 20), paused: x.paused === true };
        }),
      };
    } catch { /* an older Paperclip has no budgets route: unknown */ }
    if (c !== conn) return null;
    return { ...costsOf({ months, budgets }), contract };
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

  // ---------- the plan source (#155, contract in manager.mjs) ----------
  // Read only: it maps what the watcher already holds (GET and the WebSocket), and sends nothing. A Paperclip task is a step.
  const STEP_STATE = { backlog: 'pending', todo: 'pending', in_progress: 'working', in_review: 'working', blocked: 'error', done: 'finished' };
  const P = () => globalThis.OfficeVocab.plan;
  function planList() {
    if (!c) return [];
    const lost = c.state === 'lost';
    if (!d) { if (lost) throw httpError(502, 'The Paperclip plan could not be read.'); return []; }
    // A list that may be cut, or one that failed, is no plan: it is named unreadable (never a plan that looks whole).
    if (!lost && d.unread.some((u) => /^issues/.test(u))) throw httpError(502, 'The Paperclip plan could not be read.');
    const sessions = deps.sessions ? list(deps.sessions()) : [];
    const steps = d.issues.filter((i) => i && i.id).map((i) => {
      const a = i.assigneeAgentId ? d.agents.get(i.assigneeAgentId) : null;
      const known = Object.hasOwn(STEP_STATE, i.status);
      const sess = sessions.find((x) => x && x.paperclip && x.paperclip.task === i.id);
      const last = a ? d.last.get(a.id) : null;
      const skipped = !!(last && last.ok === false);
      const model = a && typeof obj(a.adapterConfig).model === 'string' ? text(a.adapterConfig.model, 60) : '';
      return {
        id: i.id, title: [text(i.identifier, 30), text(i.title, 100)].filter(Boolean).join(' ') || 'Task', state: known ? STEP_STATE[i.status] : 'unknown', raw: text(i.status, 40),
        owner: a ? text(a.name, 60) : '', cost: null, model, budget: a ? { spent: cents(a.spentMonthlyCents), limit: cents(a.budgetMonthlyCents) } : null,
        uid: sess ? String(sess.uid) : '', skipped, skippedWhy: skipped ? text(last.why, 200) : '',
      };
    });
    const name = text(d.company.name, 80) || 'Paperclip';
    return [{ id: `paperclip:${c.companyId}`, building: deps.building ? deps.building() : '', goal: `${name} tasks`, status: lost ? 'not-connected' : '', reason: lost ? P().notConnectedReason(c.error) : '', frozen: lost, steps }];
  }
  const planSource = { kind: 'paperclip', list: planList, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };

  // ---------- the goal handoff (ADR 0007): the one function that sends a task POST ----------
  // Paperclip's create-issue body (packages/shared validators/issue.ts, 0.3.1) has no metadata field and takes no idempotency key,
  // so the marker is the first line of the description. The office assigns nobody: the suggested agent is text. Status backlog.
  const markerOf = (goalId, stepId) => `Agent Office goal ${goalId} step ${stepId}`;
  const ALL_STATUS = 'backlog,todo,in_progress,in_review,blocked,done,cancelled';
  /** The tasks the office would create for a goal: what the painted Confirm shows, and what handoffGoal posts. */
  function handoffTasks(goal) {
    return list(goal.steps).map((st) => ({ step: st.id, title: text(st.text, 120) || 'Task', description: `${markerOf(goal.id, st.id)}\n\n${text(goal.goal, 300)}\n\nStep: ${text(st.text, 300)}${st.bot || st.role ? `\nSuggested agent: ${text(st.bot || st.role, 60)}` : ''}`, status: 'backlog' }));
  }
  /**
   * Create one task per step of an office goal, after the caller checked the Confirm. goal: { id, goal, steps: [{ id, text, bot?, role? }] };
   * done: { stepId: taskId } already written. It reads the company again first, lists its tasks before each POST and skips a step whose
   * marker is there (so a retry never doubles a task). Resolves to { written: { stepId: taskId }, company }. On a failure it throws an
   * error with `written` (every step written so far, the earlier ones included). It never deletes, assigns or changes a task.
   */
  async function handoffGoal(goal, done = {}) {
    const conn = c;
    if (!conn || !d || conn.state === 'choose' || !conn.companyId) throw httpError(409, 'Paperclip is not connected.');
    const written = { ...done }, name = text(d.company.name, 80) || 'Paperclip';
    const id = encodeURIComponent(conn.companyId);
    try {
      const co = obj(await call(conn, `/api/companies/${id}`));
      if (co.id !== conn.companyId) throw httpError(409, 'Paperclip answered for another company.');
      for (const t of handoffTasks(goal)) {
        if (written[t.step]) continue;
        const have = list(await call(conn, `/api/companies/${id}/issues?status=${ALL_STATUS}`));
        if (have.length >= ISSUE_LIST_LIMIT) throw httpError(502, 'Paperclip lists too many tasks for the office to check for a copy. Nothing more was written.');
        const mark = markerOf(goal.id, t.step);
        const same = have.find((i) => i && typeof i.description === 'string' && i.description.split(/\r?\n/, 1)[0] === mark);
        if (same) { written[t.step] = String(same.id); continue; }
        const { step, ...body } = t;
        const made = obj(await call(conn, `/api/companies/${id}/issues`, { method: 'POST', body: JSON.stringify(body) }));
        if (!made.id) throw httpError(502, 'Paperclip did not name the task it made.');
        written[step] = String(made.id);
      }
    } catch (e) { throw Object.assign(e, { written, company: name }); }
    refetchSoon(conn);
    return { written, company: name };
  }

  // ---------- the writer (#198, ADR 0010): the one function that sends a write ----------
  // One write, keyed by its kind (hq-model.mjs planWrite). The write grid (deps.grid(): the saved cells; a cell not set uses its default)
  // answers first: Deny refuses (403), Confirm asks first (deps.askFirst, the ask-first protocol, ask.js) until the same call comes with
  // confirmed: true, Allow sends. Before the question and before the send, every thing the write names is read from Paperclip and must
  // belong to the connected company (and an approval must wait for a decision), so a Confirm is never asked for a write that cannot
  // happen. Every write, and every refusal, leaves a feed line. The result carries ids only, never a body from Paperclip.
  // The two earlier writes (supervise and handoffGoal, ADR 0005 and 0007) predate it and keep their own Confirm.
  // The first company (#199) is the one write with no company yet: it names the loopback address it goes to and needs no connection.
  const askWrite = deps.askFirst || ((kind, message, extra) => Object.assign(httpError(409, message), { confirm: kind, ...extra }));
  const OPEN_APPROVAL = new Set(['pending', 'revision_requested']);
  async function check(conn, t) {
    if (t.type === 'agent') {
      const a = d.agents.get(t.id);
      if (!a || a.status === 'terminated') throw httpError(404, 'Paperclip has no such agent in this company.');
      return;
    }
    const issue = t.type === 'issue', route = `/api/${issue ? 'issues' : 'approvals'}/${t.id}`, shape = issue ? 'issue' : 'approval';
    const json = await call(conn, route).catch((e) => { throw e.upstream === 404 ? httpError(404, `Paperclip has no such ${issue ? 'task' : 'approval'} in this company.`) : e; }), problems = shapeProblems(shape, json);
    if (problems.length) throw httpError(502, `Paperclip answered in a shape the office does not know (${problems[0]}) Update the office or the pinned Paperclip.`);
    if (json.id !== t.id || json.companyId !== conn.companyId) throw httpError(404, `Paperclip has no such ${issue ? 'task' : 'approval'} in this company.`);
    if (!issue && !OPEN_APPROVAL.has(json.status)) throw httpError(409, 'This approval is not waiting for a decision.');
  }
  /**
   * write({ kind, action, ...fields }, { confirmed }) -> { ok: true, id?, identifier? } for what Paperclip made. Errors carry a status:
   * 400 a bad write, 403 the grid says Deny, 409 not connected or an approval already decided, ask-first for Confirm, 404 a thing that is
   * not in this company, 502 Paperclip failed or answered in another shape.
   */
  async function write(body, { confirmed = false } = {}) {
    if (!(body && body.kind === 'company') && (!c || !d || c.state === 'choose' || !c.companyId)) throw httpError(409, 'Paperclip is not connected.');
    const plan = planWrite(body), label = WRITE_KINDS[plan.kind].label, cell = writeValueOf(deps.grid ? deps.grid() : {}, plan.kind);
    // The first company has no connection and no company to belong to (#199): it goes to the address it names, which must be loopback.
    const first = plan.scope === 'none';
    let conn = c, name;
    if (first) {
      const u = checkUrl(plan.url);
      if (!u.ok) throw httpError(400, u.error);
      conn = { url: u.url }; name = `Paperclip at ${u.url}`;
    } else {
      if (!conn || !d || conn.state === 'choose' || !conn.companyId) throw httpError(409, 'Paperclip is not connected.');
      name = text(d.company.name, 80) || 'Paperclip';
    }
    if (cell === 'deny') { feed(`Refused by the HQ write grid: ${label}. Nothing was sent.`, 'wait'); throw httpError(403, `Denied by the HQ write grid: ${label}.`); }
    if (plan.review) {   // what the plan checks against the org chart held here (a reporting line: a loop, a self report, a stranger)
      const r = plan.review([...d.agents.values()].filter((a) => a.status !== 'terminated').map(agentView));
      if (r.problem) throw httpError(r.status || 400, r.problem);
      plan.summary = r.summary || plan.summary;
    }
    for (const t of plan.targets) await check(conn, t);
    if (!first && c !== conn) throw httpError(409, 'Paperclip is not connected.');
    if (first && plan.kind === 'company') {
      // A retry never doubles the company: a name that exists is reused, with no write and no question.
      const have = list(await call(conn, '/api/companies')).find((x) => x && x.id && text(x.name, 80) === plan.name);
      if (have) { feed(`The company "${plan.name}" was already in Paperclip. Nothing was sent.`); return { ok: true, id: String(have.id), name: plan.name, existed: true }; }
    }
    if (cell === 'confirm' && confirmed !== true) {
      throw askWrite('write', `${plan.summary} in ${name}? The office sends this one change to Paperclip and nothing else.`, { write: { kind: plan.kind, action: plan.action, summary: plan.summary } });
    }
    // A reporting line marks its employee busy while it sends (the page keeps its Confirm off, #202); a second change waits.
    const busyId = plan.kind === 'reporting' ? plan.targets[0].id : null;
    if (busyId) {
      if (conn.busy.has(busyId)) throw httpError(409, 'The office is already changing this employee.');
      conn.busy.add(busyId); changed();
    }
    let made;
    try {
      try { made = obj(await call(conn, plan.path(conn.companyId), { method: plan.method, body: JSON.stringify(plan.body) })); }
      catch (e) { feed(`Paperclip refused the write: ${plan.summary}. ${e.message}`, 'wait'); throw e; }
      if (busyId && c === conn && d) {
        // the agent as Paperclip kept it (the PATCH answer may be partial): the floors and cables come from this read. The write is done, so a
        // failed read is not an error of it; the read of the company that follows has the same data.
        try {
          const saved = scrubAgent(await call(conn, plan.path()));
          if (c === conn && d && saved && saved.id === busyId && saved.companyId === conn.companyId) d.agents.set(busyId, saved);
        } catch { /* refetchSoon below */ }
      }
    } finally { if (busyId) { conn.busy.delete(busyId); changed(); } }
    if (plan.kind === 'task' && plan.action === 'create' && !made.id) { feed(`Paperclip did not name the task it made: ${plan.summary}.`, 'wait'); throw httpError(502, 'Paperclip did not name the task it made.'); }
    if (plan.kind === 'company' && !made.id) { feed(`Paperclip did not name the company it made: ${plan.summary}.`, 'wait'); throw httpError(502, 'Paperclip did not name the company it made.'); }
    feed(`Wrote to ${name}: ${plan.summary}.`);
    if (!first) refetchSoon(conn);
    const out = { ok: true };
    if (plan.kind === 'company') { out.id = String(made.id); out.name = plan.name; out.existed = false; }
    if (plan.kind === 'task' && plan.action === 'create') { out.id = String(made.id); if (typeof made.identifier === 'string') out.identifier = text(made.identifier, 30); }
    return out;
  }

  return { connect, disconnect, supervise, handoffGoal, handoffTasks, write, view, model, costs, labelOf, held, planSource, state: () => (c ? c.state : 'off') };
}
