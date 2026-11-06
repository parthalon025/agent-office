// ACP provider: agents that speak the Agent Client Protocol (agentclientprotocol.com, protocol version 1) behind the provider
// seam (providers/index.mjs). One factory for many agents: each agent is an entry in AGENTS, not a new file. The agents are
// Hermes Agent (`hermes acp`), DeepSeek Harness (`dsh --profile acp`), OpenClaw (`openclaw acp`, behind a Gateway) and
// GitHub Copilot CLI (`copilot --acp`, its extras in providers/copilot.mjs).
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
// providers/local-tools.mjs: limited to the session's root, and each call goes to the office like any other request (the
// Security room rules, then a hold). A path outside the root is refused before anyone is asked. So an agent that uses them is held more strictly than one
// that only asks: an edit the user declined in a turn cannot come back through fs/write_text_file (Hermes issue #31682).
// An agent may ignore those capabilities and use its own tools (Hermes does): the office then sees a call only in its
// updates, cannot stop it, and says so in the feed. Such an agent is not gated (ADR 0001; AGENTS gated and supervision).
//
// ACP reports no cost in the stable protocol, so the provider is paid with cost 'unknown' (owner decision Q22). The process
// calls and the timers are injected, so tests drive a fake agent (test/fixtures/fake-acp.mjs). Nothing starts on import.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn, execFile as realExecFile } from 'node:child_process';
import { resolveExe } from '../git.mjs';
import { fileKey, riskOf } from '../risk.mjs';
import { clip } from '../tracker.mjs';
import { providerError } from './index.mjs';
import { createLocalTools, killTree } from './local-tools.mjs';
import { GATEWAY_HOST, DEFAULT_GATEWAY_PORT, MIN_VERSION, PLUGIN_ID, gatewayPort, probeGateway, versionAtLeast, wantedConfig, checkConfig, configReader, officeKey, toolCall } from './openclaw.mjs';
import * as COPILOT from './copilot.mjs';

export const PROTOCOL_VERSION = 1;
// One entry per agent. program: the name resolveExe finds on PATH. args: what starts its ACP mode on stdio.
// askTimeoutMs: how long the agent waits for an approval before it moves on by itself (the office's hold is longer, so the
// feed says when the agent gave up first). features: what the agent has beyond the seam, for the page (#72); 'resume' and
// 'images' come from the handshake, and so does 'fork' (sessionCapabilities.fork): no agent declares it here, so the Fork button never shows for a build that has no session/fork. skillsHome: where the agent keeps its skills, the
// variable that moves it and the folder under the user's home (the office lists them, #72; only with the 'skills' feature). pin: the version the office was tested against (null: not tested with a real one yet).
// gated (ADR 0001): true only when the agent asks the office before every tool call that is not low risk; an agent where only
// some calls ask is ungated, with its supervision label. None of the agents has been run against the office yet (pin: null).
const HERMES_EDITS = 'Edit requests come to the office and the rule applies. Reads, and writes to its own skills and memory, run without asking.';
const HERMES_SHELL = 'Only the commands Hermes rates dangerous come to the office.';   // one line on the wall
const HERMES_READS = 'This agent reads files without asking the office.';   // Hermes and Copilot CLI: one line on the wall
export const AGENTS = {
  hermes: {
    label: 'Hermes Agent', program: 'hermes', args: ['acp'],
    // From Hermes's source (acp_adapter/server.py: initialize ignores the client's fs and terminal) and upstream issue
    // #139074 (0.21.5, a client with terminal: true: a write asked, a touch ran without asking). Read again on main
    // 6c2bf4b (2026-11-05, review M1): in its default mode every write_file and patch asks (acp_adapter/edit_approval.py
    // maybe_require_edit_approval, kind "edit"); its terminal tool asks only for a command that matches DANGEROUS_PATTERNS
    // (tools/approval.py check_all_command_guards, kind "execute"), and none when yolo or approvals.mode off is set. The
    // office holds every session/request_permission, so the label names both.
    gated: false, supervision: 'Partly supervised: file edits and risky commands ask',
    // The Security room cells (security.mjs enforcement): an edit request inside the worktree comes through
    // session/request_permission, so the office's rule decides it. Reads do not ask. An edit outside the worktree or of a
    // settings file asks too, but Hermes writes its own skills and memory (under .hermes) with no request: partly enforced.
    // So is a command: only the ones Hermes rates dangerous come to the office.
    enforces: ['edit-inside'],
    unenforced: { 'read-inside': HERMES_READS, secrets: HERMES_READS },
    partly: { 'files-outside': HERMES_EDITS, settings: HERMES_EDITS, shell: HERMES_SHELL },
    askTimeoutMs: 60_000, // Hermes issue #63302: a fixed 60 s timeout on edit approval (command approval has its own setting)
    features: ['skills', 'memory'], skillsHome: { env: 'HERMES_HOME', dir: '.hermes' }, pin: null,
    needs: ['Install Hermes Agent so that hermes.exe is on the PATH, then run hermes acp --check in a terminal.'],
  },
  dsh: {
    label: 'DeepSeek Harness', program: 'dsh', args: ['--profile', 'acp'],
    gated: true, // research (2026-11-04): it sends its tool approvals over ACP and fails closed when no client answers
    askTimeoutMs: null,
    // dsh-acp lists forks, deletion and transcript replay as unsupported; fork would show only if its handshake said it.
    features: ['reason', 'teams', 'schedules'], pin: null, // a developer preview: pin the version tested on the owner's PC
    needs: ['Install DeepSeek Harness so that dsh.exe is on the PATH, and set DEEPSEEK_API_KEY.'],
  },
  // OpenClaw (#73, #77, ADR 0001). `openclaw acp` is a bridge to a Gateway that already runs on loopback (providers/openclaw.mjs);
  // the office never starts or stops that Gateway. Its own approvals cover shell commands only, so the office holds every call
  // another way: the Agent Office plugin (integrations/openclaw-plugin) runs in the Gateway, and its before_tool_call handler
  // sends every tool call of an office session to POST /hook/openclaw (gate() below) and waits; no answer means deny. The office
  // marks its sessions by the Gateway session key it gives session/new (openclaw.mjs officeKey). So the agent is gated, and a
  // session starts only when the Gateway config loads that plugin for this office (gateCheck; the office only reads it).
  // gateway: check the Gateway before the bridge starts. plugin: the gate above. minVersion: the release the plugin is built
  // against (2026.10.10: before_tool_call runs on the tool path, src/agents/agent-tools.before-tool-call*.ts; the 2026.1 copy
  // on the owner's PC has no caller outside src/plugins/).
  openclaw: {
    label: 'OpenClaw', program: 'openclaw', args: ['acp'],
    gated: true, plugin: true,
    askTimeoutMs: null, gateway: true, minVersion: MIN_VERSION,
    contextUsage: false, // its usage_update is Gateway session totals, not the tokens in context (#164): the Context bar stays unknown
    features: [], pin: null, // not run against a real Gateway yet: OpenClaw on the owner's PC (2026.1.29) is too old to start
    needs: ['Install OpenClaw so that openclaw.exe is on the PATH, then start its Gateway.'], // a .cmd shim from npm is not accepted (resolveExe)
  },
  // GitHub Copilot CLI (#22, ADR 0001). From 1.0.105 (copilot help config, permissions, environment; the signed-out handshake in
  // test/fixtures/copilot-acp.json). Its default permission mode ("manual") asks before writes and commands and approves
  // read-only requests by itself: it reads files in its folder, and runs a command it rates read-only, without asking. Hooks in
  // its own settings or in the repository (.github/hooks) run commands without asking, and the URLs its settings allow
  // (allowedUrls) open without asking. So it is ungated, off until the user turns it on on the Agents screen.
  // The extras ACP does not carry (providers/copilot.mjs): probeArgs and logDirArg (the readiness check writes its log to a
  // temp folder of its own, removed after the check); envDrop (the switches that approve calls by themselves, any case);
  // probeSession (a signed-out Copilot answers initialize, so the check opens and closes one session: session/new answers
  // -32000 "Authentication required", ACP auth_required, and gives the models; each check leaves an empty session folder in
  // ~/.copilot/session-state that Copilot cannot delete, so readyTtlMs is an hour); probeMs (a cold start can take more than
  // 10 s); modelArg (the model the Open dialog picks, from the models session/new listed); callOf (its permission requests
  // carry its own request body, not the tool's arguments); argsOf (the tool's own arguments of a later update, read against
  // that body, so a call changed after the request is seen, #125); signIn (the step for a sign-in error).
  copilot: {
    label: 'Copilot CLI', program: 'copilot', args: COPILOT.SESSION_ARGS,
    probeArgs: COPILOT.PROBE_ARGS, logDirArg: COPILOT.LOG_DIR_ARG, envDrop: COPILOT.SELF_APPROVE,
    probeSession: true, probeMs: 60_000, readyTtlMs: 60 * 60_000, notReadyTtlMs: 10_000, modelArg: '--model', modelRe: COPILOT.MODEL_RE,
    callOf: COPILOT.requestCall, argsOf: COPILOT.argsCall, signIn: COPILOT.SIGN_IN,
    gated: false, supervision: 'Partly supervised: edits and most commands ask, reads do not',
    // The Security room cells (security.mjs enforcement). A write asks (session/request_permission), also of a settings file.
    // Reads in its folder do not ask, a secret file there too: Not enforced, with Hermes's words, so the wall says it once for
    // both. (It asks before a read outside its folder, but a Deny on Secret files cannot hold the ones inside.) The Settings row
    // is only Partly enforced: risk.mjs actionOf puts a read of .git/config or .github/hooks in it, and that read asks nothing.
    enforces: ['edit-inside'],
    unenforced: { 'read-inside': HERMES_READS, secrets: HERMES_READS },
    partly: {
      settings: 'Writes ask. Reads in its folder do not.',
      'files-outside': 'It asks, except in folders its own settings trust (trustedFolders).',
      shell: 'It asks, except for a command it rates read-only. Hooks in its settings or the repository run commands without asking.',
      web: 'It asks, except for the URLs its own settings allow (allowedUrls).',
      mcp: 'It asks, except for an MCP tool it rates read-only.',
    },
    askTimeoutMs: null, features: [], pin: null, // only the signed-out handshake of 1.0.105 was recorded: no signed-in run yet
    needs: [COPILOT.INSTALL], // the native copilot.exe: an npm copilot.cmd is not accepted (resolveExe)
  },
};

const INIT_MS = 20_000;          // the handshake and the first session
const PROBE_MS = 10_000;         // readiness: one handshake
const POLICY_MS = 20_000;        // OpenClaw: reading its config before a session starts
const PROBE_TTL_MS = 60_000;     // what a probe learned is good for this long
const READY_WAIT_MS = 12_000;    // one readiness answer waits this long (under the 15 s of registry.status); a probe that runs
                                 // on (spec.probeMs) is "still starting", and the next answer waits for the same probe
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
// JSON with the keys of every object sorted, so two values that differ only in key order give one text (undefined stays undefined).
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

const textOf = (e) => String((e && e.message) || e || 'unknown error');
// ACP auth_required: -32000 "Authentication required" (recorded from Copilot CLI 1.0.105). -32000 alone is JSON-RPC's generic
// server error (a rate limit, a quota), so the text decides.
const isAuth = (e) => /\bauthentication required\b/i.test(textOf(e));
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
 * @param {Function} [deps.spawn] child_process.spawn.  @param {Function} [deps.execFile] child_process.execFile, for taskkill.
 * @param {(name: string) => string} [deps.exe] the program resolver: an absolute path, or it throws (git.mjs resolveExe).
 * @param {object} [deps.env] the environment for the agent (process.env).
 * @param {(root: string) => object} [deps.makeTools] createLocalTools.
 * @param {Function} [deps.setTimer] setTimeout.  @param {Function} [deps.clearTimer] clearTimeout.
 * @param {() => number} [deps.now] the clock.  @param {() => string} [deps.makeId] ids for messages and terminals.
 * @param {string} [deps.probeDir] the folder readiness starts the agent in (the temp folder).
 * @param {number} [deps.probeMs] the longest one readiness probe runs (spec.probeMs, else PROBE_MS).
 * @param {number} [deps.readyWaitMs] how long one readiness answer waits for a probe that runs on (READY_WAIT_MS).
 * OpenClaw only (spec.gateway): @param {(port: number) => Promise<boolean>} [deps.gatewayUp] is a Gateway listening (probeGateway);
 * @param {(path: string) => Promise<object>} [deps.readConfig] reads one OpenClaw config key (configReader);
 * @param {string} [deps.tokenFile] the office's token file: the OpenClaw plugin must read this one (its config is checked).
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
  const homedir = deps.homedir || os.homedir;
  // OpenClaw: a Gateway the office never starts, and a config it only reads.
  const port = gatewayPort(env);
  const gatewayUp = deps.gatewayUp || ((p) => probeGateway({ port: p }));
  const readConfig = deps.readConfig || configReader({ exe, execFile, env });
  const tokenFile = deps.tokenFile || null;
  // blocked(): why the Security room does not let this agent kind run now (its Agents screen), or null. It is the server's
  // security.mjs openRefusal, so the provider keeps no switch of its own.
  const blocked = deps.blocked || (() => null);
  const args = spec.gateway && port !== DEFAULT_GATEWAY_PORT ? [...spec.args, '--url', `ws://${GATEWAY_HOST}:${port}`] : spec.args;
  const probeMs = deps.probeMs || spec.probeMs || PROBE_MS;
  const readyWaitMs = deps.readyWaitMs || READY_WAIT_MS;
  // The agent's environment: the caller's, without the switches that let the agent approve its own calls (spec.envDrop; Windows
  // names are not case-sensitive, so neither is the match).
  const dropped = new Set((spec.envDrop || []).map((k) => k.toUpperCase()));
  const envOf = (extra = {}) => Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([k]) => !dropped.has(k.toUpperCase())));
  // The models the agent listed in its last session/new (spec.modelArg only): [{ id, label }].
  let models = [];
  function learnModels(r) {
    const list = spec.modelArg && r && r.models && Array.isArray(r.models.availableModels) ? r.models.availableModels : null;
    if (list) models = list.filter((m, i) => m && typeof m.modelId === 'string' && spec.modelRe.test(m.modelId) && list.findIndex((x) => x && x.modelId === m.modelId) === i).slice(0, 60).map((m) => ({ id: m.modelId, label: clip(String(m.name || m.modelId), 60) }));
  }
  /** @type {Map<string, object>} uid -> the agent state of an open session */
  const agents = new Map();
  // What the agent said at its last handshake (a probe or a session): its capabilities and version.
  // auth: the agent answered, but it is not signed in (spec.probeSession: session/new said auth_required).
  let learned = { caps: null, version: null, at: 0, ok: false, why: '', auth: false };

  // The absolute path of the program, or a status error the user can act on (409).
  function program() {
    try { return exe(spec.program); } catch (e) {
      if (e.code === 'SCRIPT_INSTALL') throw providerError(409, `The office needs ${spec.program}.exe. It found only ${e.file} (a script install). The office starts programs without a shell.`);
      throw providerError(409, `The office cannot find ${label}: ${spec.program}.exe is not on the PATH. Install it, then try again.`);
    }
  }
  function remember(init) {
    const caps = init && typeof init.agentCapabilities === 'object' && init.agentCapabilities ? init.agentCapabilities : {};
    learned = { caps, version: String(init?.agentInfo?.version || '') || null, at: now(), ok: true, why: '', auth: false };
  }
  // The probe's handshake. With spec.probeSession it also opens one session in the probe folder and closes it: an agent that is
  // not signed in answers initialize, and only session/new says so. No prompt goes out.
  async function probeTalk(rpc) {
    const init = await handshake(rpc);
    if (!spec.probeSession) return init;
    remember(init);
    let r;
    try { r = await rpc.request('session/new', { cwd: probeDir, mcpServers: [] }); } catch (e) {
      if (isAuth(e)) { const err = new Error(spec.signIn || textOf(e)); err.auth = true; throw err; }
      throw new Error(`it did not open a session: ${clip(textOf(e), 200)}`);
    }
    learnModels(r);
    if (r && typeof r.sessionId === 'string' && init?.agentCapabilities?.sessionCapabilities?.close) {
      await within(rpc.request('session/close', { sessionId: r.sessionId }), 3000, 'close', setTimer, clearTimer).catch(() => {});
    }
    return init;
  }
  // readiness and learn(): one handshake with the agent in a temp folder, then it stops. A failure is kept like an answer.
  let probing = null;
  async function probe() {
    let file;
    try { file = program(); } catch (e) { learned = { caps: null, version: null, at: now(), ok: false, why: e.message, auth: false }; return; }
    // spec.logDirArg: the probe's log goes to a temp folder of its own, removed when the probe's agent has stopped.
    let logDir = null;
    if (spec.logDirArg) { try { logDir = fs.mkdtempSync(path.join(probeDir, `agent-office-${kind}-check-`)); } catch { logDir = null; } }
    const dropLog = () => { if (logDir) { try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* the agent still holds it */ } } };
    let child;
    try {
      child = spawn(file, [...(spec.probeArgs || args), ...(logDir ? [spec.logDirArg, logDir] : [])], { cwd: probeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: envOf() });
    } catch (e) {
      dropLog();
      learned = { caps: null, version: null, at: now(), ok: false, why: textOf(e), auth: false };
      return;
    }
    child.once?.('exit', dropLog);
    let err = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => { err = (err + d).slice(-600); });
    const rpc = channel(child, { onRequest: () => { throw rpcError(-32601, 'Method not found'); }, onNotify: () => {} });
    const gone = new Promise((_r, reject) => {
      child.on('error', (e) => reject(e));
      child.on('exit', (code) => reject(new Error(clip(err.trim(), 300) || `it stopped with exit code ${code}`)));
    });
    try {
      remember(await within(Promise.race([probeTalk(rpc), gone]), probeMs, 'no answer in time', setTimer, clearTimer));
    } catch (e) {
      // A sign-in error keeps what the handshake said (the version); any other failure keeps nothing.
      learned = e.auth ? { ...learned, at: now(), ok: false, why: textOf(e), auth: true } : { caps: null, version: null, at: now(), ok: false, why: textOf(e), auth: false };
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

  // ----- OpenClaw: the Gateway and its config (providers/openclaw.mjs) -----
  // Why the agent cannot start now, or null: the Security room does not let it run (blocked), or no Gateway answers. The office
  // only looks: it never starts, stops or restarts the Gateway.
  async function notReady() {
    const off = blocked();
    if (off) return off;
    if (!spec.gateway) return null;
    return (await gatewayUp(port)) ? null : `Not ready: start the ${label} Gateway. It should listen on ${GATEWAY_HOST}:${port}. The office never starts or stops it.`;
  }
  // What the Gateway config says, read-only: null for an agent with no config, one that is off (blocked: nothing is read then)
  // or one that is not installed. Kept for a minute; fresh: read it again now. A read that does not finish in POLICY_MS counts
  // as unreadable, never as a pass.
  let policyNow = null;
  async function policy(fresh = false) {
    if (!spec.gateway || blocked()) return null;
    try { program(); } catch { return null; }
    if (!fresh && policyNow && now() - policyNow.at < PROBE_TTL_MS) return policyNow.value;
    const w = wantedConfig({ tokenFile });
    let config;
    try { config = await within(checkConfig(w, readConfig), POLICY_MS, 'reading its config took too long', setTimer, clearTimer); } catch (e) {
      config = await checkConfig(w, async () => ({ state: 'unreadable', why: textOf(e) }));
    }
    policyNow = { at: now(), value: { config, gaps: w.gaps } };
    return policyNow.value;
  }
  // The settings that are off, in words and with the command that turns each on. A setting the office could not read is never
  // a pass: it says it cannot confirm.
  // warn: true gives only the settings that are not preconditions (openclaw.mjs wantedConfig warn), false only the others.
  function configNotes(c, warn = false) {
    const notes = [];
    for (const x of c.settings) {
      if (x.ok || x.warn !== warn) continue;
      const run = x.fix ? ` Run: ${x.fix}` : '';
      if (x.have === 'unknown') notes.push(`the office could not read ${x.path}, so it cannot confirm it.`);
      else if (x.note) notes.push(`${x.note}${run}`);
      else if (x.path === 'tools.fs.workspaceOnly') notes.push(`${x.path} is ${x.have}, so its file tools can reach outside the worktree.${run}`);
      else if (x.path === 'tools.exec.host') notes.push(`${x.path} is ${x.have}, so a command that names no host runs on a paired device, outside the worktree.${run}`);
      else notes.push(`${x.path} is ${x.have} (wanted: ${typeof x.value === 'string' ? x.value : JSON.stringify(x.value)}), so the ${PLUGIN_ID} plugin does not send its tool calls to this office.${run}`);
    }
    return notes;
  }
  // Both are preconditions: workspace-only (spec #73: "start it with tools.fs.workspaceOnly on"), and the plugin that sends
  // every tool call to the office (#77): without it nothing would ask, and the agent is gated only through it. The office
  // cannot write the config (the Gateway is shared, Q40; the office only reads, ADR 0004), so it does not start the agent while
  // a setting is off or unknown. Returns the text that says why, with each command that fixes it, or null when all are on.
  const NO_WRITE = ' The office does not change the OpenClaw config. Fix it, then open the session again.';
  function gateBlock(c) {
    const notes = configNotes(c);
    return notes.length ? notes.join(' ') + NO_WRITE : null;
  }

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
    // An agent whose requests carry its own request body (spec.callOf: Copilot CLI) is rated and shown by that body. Once a call
    // had one, the body names it: a later update with the tool's own arguments keeps the card the user saw.
    const req = spec.callOf && tc.rawInput ? spec.callOf(tc.rawInput) : null;
    if (req) { c.req = req; c.args = null; }
    if (c.req) {
      c.kind = c.req.kind;
      c.tool_name = c.req.tool_name;
      c.tool_input = { ...c.req.tool_input };
      if (c.tool_input.command === '') c.tool_input.command = c.title;
      if (c.tool_input.file_path === '') c.tool_input.file_path = c.path || '';
      // #125: what the call does now is its own arguments after the request body (spec.argsOf, in the card's shape), so
      // recheck sees a change. An update that does not say keeps the last that did; a new request body clears them. A file
      // that is the same file spelled another way (case, slashes, a relative path) keeps the card's spelling: no change.
      const args = !req && spec.argsOf && (tc.rawInput || loc) ? spec.argsOf({ tool_name: c.tool_name, tool_input: c.tool_input }, tc.rawInput || {}, loc && loc.path) : null;
      if (args) {
        const was = c.tool_input.file_path, now = args.tool_input.file_path;
        if (was && now && norm(st, was) === norm(st, now)) args.tool_input.file_path = was;
        c.args = args;
      }
    }
    st.calls.set(id, c);
    return c;
  }
  // What the user sees of a call: its tool and input. A request is answered for this, never for what the call says later.
  // Keys in any order, at any depth, are the same input: the same MCP arguments sent in another order are no change (#125).
  const sigOf = (c) => stable([c.tool_name, c.tool_input]);
  // A call in a few words: its command, file, address or pattern. A call that only its arguments name (an MCP tool) is the
  // tool and the arguments that are not what the user saw (was), so a feed line says what changed.
  const what = (c, was) => {
    const t = c.tool_input;
    const named = t.command || (t.file_path && path.basename(String(t.file_path))) || t.url || t.pattern;
    if (named) return clip(String(named), 100);
    const before = (was && was.tool_input) || {};
    const keys = [...new Set([...Object.keys(t), ...Object.keys(before)])].filter((k) => k !== 'description' && stable(t[k]) !== stable(before[k]));
    if (keys.length) return clip(`${c.tool_name} (${keys.map((k) => `${k}: ${clip(stable(t[k]) ?? 'none', 40)}`).join(', ')})`, 100);
    return clip(String(c.title || c.tool_name), 100);
  };
  // The agent changed a call after the user saw it. While a request for it waits, that request is declined at once (the
  // user cannot approve what the card no longer shows), and the files of both forms ask first for the rest of the turn.
  // After an approval, the feed says so: the agent runs its own tool with the new input, which the office cannot stop.
  // What the call says now is its card, or for an agent with request bodies its own later arguments (c.args, #125).
  function recheck(s, st, c) {
    const now = c.args || c, sig = sigOf(now);
    for (const [id, shown] of [...c.held]) {
      if (shown.sig === sig) continue;
      if (now.tool_input.file_path && EDIT_KINDS.has(c.kind)) st.askFirst.add(norm(st, now.tool_input.file_path));
      withdraw(s, st, id, `${label} changed the call while it waited for your answer, so the office declined it: ${what(now, shown)}`);
    }
    if (c.approved && !c.approved.told && c.approved.sig !== sig) {
      c.approved.told = true;
      const line = `${label} changed the call after you approved it: ${what(now, c.approved)}`;
      emit(st, () => events.feed(s, 'wait', line));
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
    // What the call did: its card, or for an agent with request bodies its own last arguments (c.args, #125), so an approved
    // edit that moved to a file the user declined is named. The hooks below keep the card, which the PreToolUse carried.
    const did = c.args || c, input = did.tool_input;
    const file = input.file_path ? norm(st, input.file_path) : null;
    const gated = st.gated.get(c.id);
    st.gated.delete(c.id);
    // spec.plugin: every call of the session goes to the office through the plugin before it runs (gate). A call that ran
    // without the office's yes means the plugin did not hold it: not loaded, a Gateway not restarted after the plugin was
    // turned on, or another call id. Nothing else stops OpenClaw's calls, so the session ends with an Error that says so.
    // A failed call the office never got may have run too: OpenClaw reports "failed" for every tool result that is an error
    // (src/acp/translator.agent-events.ts), so a push that ran and then exited 1 is "failed". Only a result OpenClaw marks as
    // blocked before the tool ran (rawOutput.details.status "blocked": agent-tools.before-tool-call.wrapper.ts
    // buildBlockedToolResult, also the plugin's own denials) did not run. Its text is never trusted: a command can print anything.
    const before = blockedBefore(u);
    if (spec.plugin && u.status === 'completed' && !before && !c.served && !(file && st.wrote.has(file)) && !(gated && gated.allow)) {
      gateFailed(s, st, c, gated);
    } else if (spec.plugin && u.status === 'failed' && !before && !c.served && !gated) {
      gateFailed(s, st, c, null, true);
    } else if (spec.plugin) {
      // held by the office: nothing to say
    } else if (u.status === 'completed' && EDIT_KINDS.has(c.kind) && file && st.denied.has(file)) {
      // Hermes #31682: an edit the user declined can come back through another of the agent's own tools. The office cannot
      // stop the agent's own tools, so it says so when one reports that file changed.
      emit(st, () => events.feed(s, 'wait', `${label} changed ${path.basename(String(input.file_path))} after you declined that edit.`));
    } else if (u.status === 'completed' && !c.asked && !c.served) {
      if (c.kind === 'execute') emit(st, () => events.feed(s, 'wait', `${label} ran a command without asking the office: ${clip(input.command || c.title, 100)}`));
      else if (EDIT_KINDS.has(c.kind) && !(file && st.wrote.has(file))) {
        emit(st, () => events.feed(s, 'wait', `${label} changed ${path.basename(String(input.file_path || c.title))} without asking the office.`));
      } else if (c.kind === 'read' || c.kind === 'search') {
        // A read the office cannot stop: the feed names it when it is not low risk (a secret, a settings file, outside the root).
        const risk = riskOf(did.tool_name, input, st.root);
        if (risk !== 'low') emit(st, () => events.feed(s, 'wait', `${label} read ${clip(String((input.file_path && path.basename(String(input.file_path))) || input.pattern || c.title), 100)} without asking the office (risk ${risk}).`));
      }
    }
    const said = (Array.isArray(u.content) ? u.content : []).map((x) => (x?.type === 'content' && x.content?.type === 'text' ? x.content.text : '')).find(Boolean);
    const base = { tool_name: c.tool_name, tool_use_id: c.id, tool_input: c.tool_input };
    if (u.status === 'completed') hook(s, st, { hook_event_name: 'PostToolUse', ...base });
    else hook(s, st, { hook_event_name: 'PostToolUseFailure', ...base, error: clip(String(said || 'Failed'), 240), is_interrupt: st.interrupted });
  }

  // OpenClaw marked the call's result as blocked before the tool ran (agent-tools.before-tool-call.wrapper.ts buildBlockedToolResult:
  // details.status "blocked"). The text of the result is not read: a command can print anything.
  function blockedBefore(u) {
    const d = u && u.rawOutput && typeof u.rawOutput === 'object' ? u.rawOutput.details : null;
    return !!(d && typeof d === 'object' && d.status === 'blocked');
  }
  // The plugin did not hold a call that ran (spec.plugin). The turn ends with an Error naming the plugin, and the agent stops:
  // its next calls would not be held either.
  function gateFailed(s, st, c, gated, failed = false) {
    if (st.closed || st.gateFail) return;
    const why = !gated ? 'the office never got it' : gated.pending ? 'before the office answered' : 'the office had declined it';
    const ran = failed
      ? `${label} reports a failed ${c.tool_name} ${what(c)} that the office never got. It may have run without the office's yes.`
      : `${label} ran ${c.tool_name} ${what(c)} without the office's yes (${why}).`;
    st.gateFail = `${ran} The ${PLUGIN_ID} plugin did not hold this call: it is not loaded, the Gateway was not restarted after openclaw plugins enable ${PLUGIN_ID}, or ${label} gave the call another id. The office stopped the session.`;
    emit(st, () => events.feed(s, 'wait', st.gateFail));
    try { st.rpc.notify('session/cancel', { sessionId: st.sid }); } catch { /* the agent is gone */ }
    if (st.endCancel) st.endCancel({ stopReason: 'cancelled' });
    setImmediate(() => { if (!st.dead && st.child.pid) killTree(st.child.pid, execFile); }); // the exit ends the session
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
  // Ask the office about a request: the Security room rules answer it at once (on a later tick), else it is held until the
  // user answers. done(verdict, message) gets 'allow', 'deny', 'cancel' or 'withdraw', and why the office refused (a Deny rule).
  // firm: the user must answer this one, so an Allow rule does not (events.permission).
  function hold(s, st, toolName, input, done, reason = null, firm = false) {
    const id = emit(st, () => events.permission(s, { tool_name: toolName, tool_input: input, permission_suggestions: [], ask_reason: reason }, { firm }));
    if (!id) { done('deny'); return null; }
    const ask = { gaveUp: false, timer: null, done: (v, why) => { if (st.asks.get(id) !== ask) return; st.asks.delete(id); if (ask.timer) clearTimer(ask.timer); done(v, why); } };
    st.asks.set(id, ask);
    return id;
  }
  function cancelAsks(st) { for (const ask of [...st.asks.values()]) { ask.gaveUp = true; ask.done('cancel'); } }

  // The reason the agent gives for a request (dsh asks again with one), only for an agent kind that declares 'reason'. ACP names no
  // field for it: it is read from `reason` or `_meta.reason` of the request or its tool call. Not checked against a real dsh yet.
  function reasonOf(params) {
    if (!spec.features.includes('reason')) return null;
    for (const o of [params, params.toolCall]) {
      const v = o && (typeof o.reason === 'string' ? o.reason : o._meta && typeof o._meta.reason === 'string' ? o._meta.reason : null);
      if (v && v.trim()) return v;
    }
    return null;
  }

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
    if (st.closed || st.interrupted || st.gateFail) return CANCELLED;
    // spec.plugin: the office already answered this call when the plugin sent it (gate). OpenClaw's own exec approval for the
    // same call gets a no at once, and a yes only for the command the office approved: that request shows the command that
    // will run, which another plugin may have changed after the office's yes. Another command, or a paired device, is held again.
    const g0 = st.gated.get(c.id), g = g0 && !g0.pending ? g0 : null; // a call the office has not answered yet is held as usual
    if (g && !g.allow) return no ? pick(no) : CANCELLED;
    if (g && g.allow) {
      // The approval carries only the command and the host (OpenClaw src/acp/permission-relay.ts), so env, workdir and elevated
      // cannot be compared here; a host the user approved by name must be the same.
      const host = c.raw && typeof c.raw.host === 'string' ? c.raw.host.trim() : '';
      const ran = String(c.tool_input.command || '').trim();
      const moved = !!(g.host && host && host !== g.host);
      if (c.tool_name === 'Bash' && g.command !== null && ran === g.command && host !== 'node' && !moved) return once ? pick(once) : CANCELLED;
      const why = host === 'node' ? 'on a paired device' : moved ? `on another host (${host}) than the one you approved (${g.host})` : 'another command than the one you approved';
      emit(st, () => events.feed(s, 'wait', `${label} asks to run ${why}: ${clip(ran || c.title, 100)}`));
    }
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
      }, reasonOf(params));
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
    return new Promise((resolve) => { hold(s, st, toolName, input, (v, why) => resolve({ ok: v === 'allow', why }), null, strict); });
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
      case 'usage_update':
        // Token totals (used, size) go to the stats. The cost the spec allows here is not read: the session stays "unknown".
        // used is the tokens in context for an agent that follows the spec (#164); OpenClaw sends session totals (contextUsage: false).
        emit(st, () => events.stream(s, spec.contextUsage === false ? { type: 'usage', used: u.used } : { type: 'usage', used: u.used, ctx: { used: u.used, size: u.size } }));
        break;
      default: break; // thoughts, commands, modes: not shown yet
    }
  }

  // ----- a turn -----
  // The token counts an agent puts in the answer of a prompt (inputTokens, outputTokens, cachedReadTokens, or only totalTokens). They go
  // to the tracker as the usage of one assistant message with its own id, so each turn counts once. No usage, nothing reported.
  function reportUsage(s, st, r) {
    const u = r && typeof r.usage === 'object' && r.usage ? r.usage : null;
    const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    if (!u) return;
    const out = n(u.outputTokens), cached = n(u.cachedReadTokens);
    const input = n(u.inputTokens) || Math.max(0, n(u.totalTokens) - out);
    if (!input && !out) return;
    emit(st, () => events.stream(s, { type: 'assistant', message: { id: `acp-${makeId()}`, usage: { input_tokens: Math.max(0, input - cached), output_tokens: out, cache_read_input_tokens: cached }, content: [] } }));
  }

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
        if (st.closed || st.interrupted || st.gateFail) break;
        reportUsage(s, st, r);
        const why = STOP_WORDS[r?.stopReason];
        if (why) { failure = why; break; }
        if (st.notes.length) { prompt = [{ type: 'text', text: st.notes.splice(0).join('\n\n') }]; continue; }
        const stop = hook(s, st, { hook_event_name: 'Stop', last_assistant_message: st.last });
        if (stop && stop.decision === 'block' && stop.reason) { prompt = [{ type: 'text', text: stop.reason }]; continue; }
        break;
      }
    } catch (e) {
      flushText(s, st);
      if (!st.interrupted && !st.closed) {
        if (isAuth(e)) learned.at = 0; // readiness asks again
        failure = isAuth(e) ? `${label} is not signed in. ${spec.signIn || 'Sign in, then send the message again.'}` : `${label}: ${textOf(e)}`;
      }
    }
    finishTurn(s, st, failure);
  }

  function finishTurn(s, st, failure) {
    st.busy = false;
    st.endCancel = null;
    cancelAsks(st); // an agent that ended its turn waits for nothing
    st.grants.clear(); st.denied.clear(); st.askFirst.clear(); st.wrote.clear(); st.gated.clear(); st.deniedVague = false;
    st.carry.push(...st.notes.splice(0)); // the inbox gave them up already: they go with the next prompt
    if (st.closed) return;
    if (st.gateFail) { events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: st.gateFail }); return; }
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

  // One call of the office plugin, held like every request (gate): { allow, reason }. signal: the plugin stopped waiting.
  function holdOne(s, st, m, signal) {
    return new Promise((resolve) => {
      const held = hold(s, st, m.tool_name, m.tool_input, (v, why) => {
        if (v === 'allow') return resolve({ allow: true, reason: '' });
        resolve({ allow: false, reason: why || (v === 'cancel' ? 'The turn was stopped in Agent Office.' : v === 'withdraw' ? `${label} stopped waiting for the answer.` : 'Declined in Agent Office.') });
      }, m.reason || null, m.firm === true);
      if (held && signal) {
        if (signal.aborted) withdraw(s, st, held, `${label} stopped waiting for your answer.`);
        else signal.addEventListener('abort', () => withdraw(s, st, held, `${label} stopped waiting for your answer.`), { once: true });
      }
    });
  }

  // ----- the session -----
  // OpenClaw, before the session exists (so before any prompt goes out): the version the plugin is built against, the file tools
  // in the worktree, and the plugin loaded for this office, so every tool call of the session asks the office (#77). The
  // Gateway config is only read; the office never writes it. Returns the config check, for the feed line after the start.
  async function gateCheck() {
    if (spec.minVersion && !versionAtLeast(learned.version, spec.minVersion)) {
      throw new Error(`${label} ${learned.version || '(unknown version)'} is older than ${spec.minVersion}, or does not say its version. The office plugin needs ${spec.minVersion} or later to hold its tool calls. Update ${label}.`);
    }
    const p = await policy(true);
    if (!p) throw new Error(`the office could not check the ${label} config.`);
    const block = gateBlock(p.config);
    if (block) throw new Error(block);
    return p.config;
  }
  function announce(s, st, c) {
    emit(st, () => events.feed(s, 'start', `${label} config: workspace-only is on, and the ${PLUGIN_ID} plugin sends every tool call to the office.`));
    for (const n of configNotes(c, true)) emit(st, () => events.feed(s, 'wait', `${label}: ${n}`));
  }
  // The Gateway session key of an office session (#77): the plugin knows the session by it. A reopened session keeps the key of
  // its past record (session/load rebinds the same Gateway session); a new one gets a key with its own uid.
  // Two live sessions never share a key: the plugin's calls would show on the first one. So a second Reopen of the same past
  // record, while the first is open, starts a new conversation with its own key.
  function gatewayKeyOf(s, o) {
    const past = o.prior && typeof o.prior.gatewayKey === 'string' ? o.prior.gatewayKey : null;
    if (!o.resume || !past) return { key: officeKey(s.uid), taken: false };
    const taken = [...agents.values()].some((x) => x.session !== s && !x.closed && !x.dead && x.session?.gatewayKey === past);
    return taken ? { key: officeKey(s.uid), taken: true } : { key: past, taken: false };
  }

  async function start(s, st, o) {
    const down = await notReady();
    if (down) throw new Error(down);
    const init = await within(handshake(st.rpc), INIT_MS, 'it did not answer the handshake in time', setTimer, clearTimer);
    remember(init);
    if (init?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`it speaks ACP version ${init?.protocolVersion}; the office speaks version ${PROTOCOL_VERSION}`);
    st.caps = learned.caps;
    const gate = spec.gateway ? await gateCheck() : null; // before session/new: nothing runs while this is open
    if (st.closed) return;
    // spec.plugin: the session key the plugin reads goes with session/new and session/load. A past record without one (from
    // before #77) cannot be held, so it starts a new conversation instead.
    const gk = spec.plugin ? gatewayKeyOf(s, o) : { key: null, taken: false };
    const key = gk.key;
    const meta = key ? { _meta: { sessionKey: key } } : {};
    if (key) s.gatewayKey = key;
    let r, sid;
    if (o.resume && st.caps.loadSession === true && (!spec.plugin || (o.prior?.gatewayKey && !gk.taken))) {
      // The agent replays the past conversation as updates before it answers. The office already has those replies
      // (the past record), so the replay is not shown again.
      st.loading = true;
      r = await within(st.rpc.request('session/load', { sessionId: String(o.resume), cwd: s.cwd, mcpServers: [], ...meta }), INIT_MS, 'it did not load the past session in time', setTimer, clearTimer);
      st.loading = false;
      sid = String(o.resume);
    } else if (o.fork) {
      // A copy of a past session (#72). The agent replays the past as updates of the new session, before it answers; the office
      // has those replies already (the past record), so the replay is not shown again.
      st.loading = true;
      r = await within(st.rpc.request('session/fork', { sessionId: String(o.fork), cwd: s.cwd, mcpServers: [], ...meta }), INIT_MS, 'it did not fork the past session in time', setTimer, clearTimer);
      st.loading = false;
      sid = r && r.sessionId;
    } else {
      // Before the session id: the office keeps the past record of a conversation that did not continue.
      if (o.resume) emit(st, () => events.fresh(s, gk.taken ? `That ${label} conversation is open in another session. A new session started.` : `${label} cannot load a past session now. A new session started.`));
      r = await within(st.rpc.request('session/new', { cwd: s.cwd, mcpServers: [], ...meta }), INIT_MS, 'it did not start a session in time', setTimer, clearTimer);
      sid = r && r.sessionId;
    }
    if (typeof sid !== 'string' || !sid) throw new Error('it gave no session id');
    st.sid = sid;
    learnModels(r);
    // The session id first (the tracker saves the session when its sid arrives), then the bot sits down at rest.
    emit(st, () => events.stream(s, { type: 'system', subtype: 'init', session_id: sid, model: r.models?.currentModelId || (spec.modelArg && o.model && spec.modelRe.test(String(o.model)) ? String(o.model) : null) || null, permissionMode: 'default' }));
    if (gate) announce(s, st, gate);
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
      f.push(...spec.features);
      // Only what the handshake said: a build without session/fork must not offer Fork (the worktree would be made for nothing).
      if (learned.caps?.sessionCapabilities?.fork && !f.includes('fork')) f.push('fork');
      return f;
    },
    // Where this agent keeps the skills it writes (#72), or null for an agent kind without the 'skills' feature.
    skillsDir() {
      const h = spec.features.includes('skills') && spec.skillsHome;
      if (!h) return null;
      return path.join(env[h.env] || path.join(homedir(), h.dir), 'skills');
    },
    spec,
    // The Security room rows the agent's own config takes (providers/index.mjs; security.mjs enforcement()).
    ...(spec.enforces ? { enforces: [...spec.enforces] } : {}),
    ...(spec.unenforced ? { unenforced: { ...spec.unenforced } } : {}),
    ...(spec.partly ? { partly: { ...spec.partly } } : {}),
    // OpenClaw: the Gateway config check (null: no config, or the kind is off or not installed).
    policy: (fresh) => policy(fresh === true),
    // The gate check of start() that needs no session, for the server to ask before the cost question and before a worktree:
    // why the agent would not start, or null. Only an agent with a Gateway config has one; a missing program or an off kind is
    // said elsewhere (null here).
    async preflight() {
      if (!spec.gateway) return null;
      const p = await policy(true);
      return p ? gateBlock(p.config) : null;
    },
    // spec.plugin (#77): one tool call the office plugin in the OpenClaw Gateway sends (POST /hook/openclaw, openclaw.mjs
    // gateRequest). It is held like every request of the session (the Security room rules, then the user), and the answer goes
    // back as { allow, reason }. A call that starts work outside the session is denied at once (openclaw.mjs toolCall). signal:
    // the plugin stopped waiting (its limit, or OpenClaw cancelled the call); the hold then goes, and the feed says so.
    // The answer is kept by toolCallId (st.gated) for endCall and for OpenClaw's own exec approval of the same call, so a call
    // with no id is denied: the office could not tell later whether it ran unheld. A patch of several files is held as an Edit
    // of each, one after another, and runs only when every one is allowed.
    async gate(s, call, signal) {
      const st = agents.get(s.uid);
      if (!spec.plugin || !st || st.closed || st.dead || st.gateFail) return { allow: false, reason: `This ${label} session is not open in Agent Office.` };
      const id = call.toolCallId ? String(call.toolCallId) : null;
      const m = toolCall(call.toolName, call.params, call.derivedPaths, s.cwd);
      // host: the host the call named (not "auto"), so OpenClaw's own exec approval on another host is held again (onPermission).
      const named = call.params && typeof call.params.host === 'string' && call.params.host.trim() && call.params.host !== 'auto' ? call.params.host.trim() : null;
      const record = (allow, pending = false) => st.gated.set(id, { allow, pending, command: m.tool_name === 'Bash' && typeof m.tool_input.command === 'string' ? m.tool_input.command.trim() : null, host: named });
      const done = (allow, reason = '') => { if (id) record(allow); return { allow, reason }; };
      if (m.handoff) {
        emit(st, () => events.feed(s, 'tool', `refused ${call.toolName}: ${m.handoff}`));
        return done(false, m.handoff);
      }
      if (!id) {
        emit(st, () => events.feed(s, 'tool', `refused ${call.toolName}: the ${PLUGIN_ID} plugin sent no tool call id`));
        return { allow: false, reason: `The ${PLUGIN_ID} plugin sent no tool call id, so the office cannot match the call to what ${label} reports. The call is denied.` };
      }
      // The office has the call from now on (pending until it answers): a failed call it is still deciding about is not one
      // the office never got (endCall), for example when OpenClaw stops the call on a Stop before the plugin's wait ends.
      record(false, true);
      const parts = m.files && m.files.length > 1 ? m.files.map((f) => ({ ...m, tool_input: { file_path: f } })) : [m];
      for (const part of parts) {
        if (st.closed || st.dead || st.gateFail) return done(false, `This ${label} session is not open in Agent Office.`);
        if (st.interrupted) return done(false, 'The turn was stopped in Agent Office.');
        if (signal?.aborted) return done(false, `${label} stopped waiting for the answer.`);
        const d = await holdOne(s, st, part, signal);
        if (!d.allow) return done(false, d.reason);
      }
      return done(true);
    },

    async readiness() {
      try { program(); } catch (e) { return { ready: false, version: null, needs: [e.message, ...spec.needs] }; }
      const down = await notReady(); // before the bridge starts: off, or without a Gateway it has nothing to talk to
      if (down) return { ready: false, version: null, needs: [down] };
      // A probe that runs longer than one answer may wait (a cold start) goes on; the next answer waits for that same probe.
      const done = await within(this.learn().then(() => true), readyWaitMs, 'still starting', setTimer, clearTimer).catch(() => false);
      if (!done) return { ready: false, version: null, needs: [`${label} is still starting. A first start can take more than 10 s. Click Check again in a few seconds.`] };
      if (learned.auth) return { ready: false, version: learned.version || null, needs: [learned.why] };
      if (!learned.ok) return { ready: false, version: null, needs: [`${label} did not answer the ACP handshake: ${learned.why}`, ...spec.needs] };
      const needs = spec.pin && learned.version !== spec.pin ? [`The office was tested with ${label} ${spec.pin}. This is ${learned.version || 'an unknown version'}.`] : [];
      let ready = true;
      if (spec.minVersion && !versionAtLeast(learned.version, spec.minVersion)) {
        ready = false; // start() refuses the same way (gateCheck)
        needs.push(`${label} ${learned.version || '(unknown version)'} is older than ${spec.minVersion}, or does not say its version. The office plugin needs ${spec.minVersion} or later to hold its tool calls. Update ${label}.`);
      }
      if (spec.gateway) {
        try {
          const c = (await policy()).config;
          if (gateBlock(c)) ready = false;   // start() refuses the same way (gateCheck)
          needs.push(...[...configNotes(c), ...configNotes(c, true)].map((n) => `${label}: ${n}`));
        } catch (e) { ready = false; needs.push(`${label}: the office could not check its config: ${textOf(e)}`); }
      }
      return { ready, version: learned.version || 'unknown', needs };
    },

    // One handshake with the agent in a temp folder, then it stops. What it says is kept for a minute, and calls that
    // overlap share one probe.
    learn() {
      const ttl = learned.ok ? spec.readyTtlMs || PROBE_TTL_MS : spec.notReadyTtlMs || PROBE_TTL_MS;
      if (learned.at && now() - learned.at < ttl) return Promise.resolve();
      if (!probing) probing = probe().finally(() => { probing = null; });
      return probing;
    },

    // The agent picks its model in its own settings, unless it takes one on its command line (spec.modelArg): then the models
    // its last session/new listed (a readiness probe opens one). None yet: Default only.
    async models() { return models.map((m) => ({ ...m })); },

    // Before the office makes a worktree or a session. check({}) checks only that a session can start (Reopen).
    check(o = {}) {
      program();
      if (o.model && !spec.modelArg) throw providerError(400, `${label} picks its model in its own settings. Leave the model empty.`);
      if (o.model && !spec.modelRe.test(String(o.model))) throw providerError(400, 'Unknown model.');
      if (o.permissionMode && o.permissionMode !== 'default') throw providerError(400, `${label} runs with the office's approvals only. Leave the permission mode empty.`);
    },
    open(s, o = {}) {
      let file, child;
      // A missing program or a spawn that throws: the session says why and ends, on a later tick (seam timing rule 1).
      try {
        file = program();
        // Only a model id goes on the command line (a Reopen's model is not behind check()): never a value that reads as a switch.
        const sessionArgs = o.model && spec.modelArg && spec.modelRe.test(String(o.model)) ? [...args, spec.modelArg, String(o.model)] : args;
        child = spawn(file, sessionArgs, { cwd: s.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: envOf({ OFFICE_ID: s.officeId }) });
      } catch (e) {
        setImmediate(() => { events.reply(s, `Could not start ${label}: ${textOf(e)}`); events.end(s, 'could not start'); });
        return;
      }
      s.pid = child.pid;
      const root = s.worktree?.root || s.startDir || s.cwd;
      const st = {
        session: s, child, root, tools: makeTools(root), sid: null, caps: null, busy: false, closed: false, interrupted: false, failed: false, gateFail: null,
        loading: false, queue: [], notes: [], carry: [], text: '', last: '', msgId: null, cancelled: null, endCancel: null, err: '',
        calls: new Map(),        // toolCallId -> what the office knows of the call
        asks: new Map(),         // request id -> a held request: the agent's own, or a file or command the office serves
        grants: new Map(),       // this turn: 'Bash\n<line>' or 'Write\n<fileKey>' the user approved -> its toolCallId; served once
        denied: new Set(),       // this turn: files whose edit the user declined (fileKey); a write to them is refused at once
        askFirst: new Set(),     // this turn: files whose edit request went unanswered or changed; a write to them asks first
        deniedVague: false,      // this turn: the user declined an edit that named no file, so every write asks first
        wrote: new Set(),        // this turn: files the office wrote for the agent
        gated: new Map(),        // spec.plugin: toolCallId -> { allow, command } the office's answer to the plugin, until the call ends
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
        events.end(s, st.gateFail ? `stopped: the ${PLUGIN_ID} plugin did not hold a call` : code ? `exited (${code})` : 'finished');
      });
      start(s, st, o).catch((e) => {
        if (st.closed || st.dead) return;
        st.failed = true;
        if (isAuth(e)) learned.at = 0; // readiness asks again
        events.reply(s, `${label} could not start a session: ${isAuth(e) ? `it is not signed in. ${spec.signIn || 'Sign in, then open the session again.'}` : textOf(e)}`);
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
      // d.message: why the Security room refused it (a Deny rule), for the agent.
      ask.done(d.allow === true ? 'allow' : d.allow === false ? 'deny' : ask.gaveUp || st.interrupted || st.closed ? 'cancel' : 'deny', typeof d.message === 'string' ? d.message : '');
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
      const stopped = st.tools.stop();
      st.rpc.fail('The session closed.');
      if (st.endCancel) st.endCancel({ stopReason: 'cancelled' });
      // The agent process and its commands both end before this resolves.
      if (st.dead || !st.child.pid) return Promise.resolve(stopped);
      const exited = new Promise((resolve) => {
        st.child.once('exit', () => resolve());
        killTree(st.child.pid, (file, args, opts, cb) => execFile(file, args, opts, (...a) => { cb(...a); setTimer(resolve, 2000); }));
      });
      return Promise.all([exited, stopped]).then(() => undefined);
    },
  };
}
