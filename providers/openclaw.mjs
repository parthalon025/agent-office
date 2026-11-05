// OpenClaw helpers for the ACP provider's `openclaw` entry (providers/acp.mjs AGENTS). OpenClaw speaks ACP through
// `openclaw acp`, a bridge to a Gateway that already runs on loopback (default 127.0.0.1:18789). So this is not a second
// client. It holds only what ACP does not carry:
//   - gatewayPort / probeGateway: is a Gateway there? The office never starts or stops it (owner decision Q40); other clients use it.
//   - versionAtLeast: OpenClaw relays exec approvals over ACP from v2026.10.10 (spec #67). The version compared is the one the
//     bridge reports in the ACP initialize answer (agentInfo.version). In the OpenClaw source that is the package's own VERSION
//     (dist/acp/types.js, seen in release 2026.1.29), so it is the release. A bridge that reports none is "unknown", and unknown
//     is not new enough.
//   - wantedConfig / checkConfig / configReader: the OpenClaw settings that the Security room rules need. The Gateway runs the
//     tools, so its config decides. The office only READS that config (`openclaw config get`); it never writes it. A setting that
//     is off is named with the command that turns it on, and the session says so. A rule that config cannot carry is a "gap":
//     the Security room shows "Not enforced for this agent" for it (ADR 0001).
// The docs that name the keys: docs.openclaw.ai/gateway/config-tools/tool-policy (tool ids and groups), /tools/exec-approvals
// (tools.exec.ask: off | on-miss | always; the newer tools.exec.mode: deny | allowlist | ask | auto | full), /cli/config.
// None of this ran against a real Gateway yet (see CLAUDE.md, Gotchas).
import net from 'node:net';
import { execFile as realExecFile } from 'node:child_process';
import { clip } from '../tracker.mjs';
import { helperCwd } from '../git.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_GATEWAY_PORT = 18789;
export const MIN_VERSION = '2026.10.10';
const PROBE_MS = 1500;
const READ_MS = 8000;

/** The Gateway port: OFFICE_OPENCLAW_PORT when it is a port number, else 18789. The host is always loopback. */
export function gatewayPort(env = process.env) {
  const raw = env && env.OFFICE_OPENCLAW_PORT;
  const n = /^\d{1,5}$/.test(String(raw ?? '')) ? Number(raw) : 0;
  return n >= 1 && n <= 65535 ? n : DEFAULT_GATEWAY_PORT;
}

/** True when something accepts a connection on the Gateway port. It sends nothing. connect, setTimer, clearTimer are injectable. */
export function probeGateway({ port = DEFAULT_GATEWAY_PORT, connect = net.createConnection, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = PROBE_MS } = {}) {
  return new Promise((resolve) => {
    let sock, timer, done = false;
    const end = (up) => { if (done) return; done = true; clearTimer(timer); try { sock?.destroy(); } catch { /* gone */ } resolve(up); };
    try {
      sock = connect({ host: GATEWAY_HOST, port });
      sock.once('connect', () => end(true));
      sock.on('error', () => end(false));
    } catch { return end(false); }
    timer = setTimer(() => end(false), timeoutMs);
  });
}

const parts = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
/** Numeric compare of the first x.y.z in `v` with `min`. Text with no version is false. */
export function versionAtLeast(v, min = MIN_VERSION) {
  const a = parts(v), b = parts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// ---------- the Agent Office plugin (#77): every tool call of an office session goes to the office ----------
// OpenClaw loads integrations/openclaw-plugin into its Gateway. Its before_tool_call handler sends each tool call of a session the
// office opened to POST /hook/openclaw and waits for the decision; no answer means deny. The office marks its sessions by the
// Gateway session key it gives session/new (`_meta.sessionKey`): "agent-office:<uid>". The Gateway may put "agent:<id>:" in
// front, so the rule reads the end of the key. The plugin keeps the same rule (gate.js OFFICE_KEY; the tests compare the two).
export const PLUGIN_ID = 'agent-office';
export const PLUGIN_DIR = fileURLToPath(new URL('../integrations/openclaw-plugin/', import.meta.url));
export const OFFICE_KEY = /(?:^|:)agent-office:(o[0-9a-f]{8})$/i;
/** The Gateway session key of an office session. */
export const officeKey = (uid) => `agent-office:${uid}`;
/** The office session id in a Gateway session key, or null when the key is not one the office gave. */
export function officeIdOf(key) {
  const m = typeof key === 'string' ? OFFICE_KEY.exec(key) : null;
  return m ? m[1].toLowerCase() : null;
}

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
/**
 * The body the plugin posts to /hook/openclaw (gate.js): { session_key, tool_name, params, tool_call_id?, run_id?, derived_paths? }.
 * Returns { ok: true, call: { sessionKey, toolName, params, toolCallId, runId, derivedPaths } } or { ok: false, error }.
 */
export function gateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'The body is not an object.' };
  if (!str(body.session_key, 500)) return { ok: false, error: 'session_key is missing.' };
  if (!str(body.tool_name, 200)) return { ok: false, error: 'tool_name is missing.' };
  const params = body.params === undefined ? {} : body.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'params must be an object.' };
  const id = (v) => (str(v, 200) ? v : null);
  const paths = Array.isArray(body.derived_paths) ? body.derived_paths.filter((p) => str(p, 4000)).slice(0, 100) : [];
  return { ok: true, call: { sessionKey: body.session_key, toolName: body.tool_name, params, toolCallId: id(body.tool_call_id), runId: id(body.run_id), derivedPaths: paths } };
}

// OpenClaw tool ids (docs.openclaw.ai/gateway/config-tools/tool-policy, v2026.10.10) as the tool names risk.mjs, payload.mjs and
// vocab.js know. A tool the office does not know keeps its id behind "openclaw:", so a plugin tool that borrows a core name
// ("Read") is never rated as that tool, and an unknown call is an "other" call: Ask by default.
const SHELL_TOOLS = new Set(['exec', 'bash']);
const RUN_TOOLS = new Set(['process', 'code_execution']);
const FILE_TOOLS = { read: 'Read', write: 'Write', edit: 'Edit' };
// Tools that start work the office cannot hold: another session (spawn, send, a conversation turn), a later run (cron,
// automations), a paired device (nodes, computer), or a change to the Gateway itself (gateway, plugins, openclaw), which could
// turn this plugin off. The office denies them in its sessions.
const OUTSIDE = new Set(['sessions_spawn', 'sessions_send', 'subagents', 'conversations_send', 'conversations_turn', 'automations', 'cron', 'gateway', 'plugins', 'openclaw', 'nodes', 'computer']);
const short = (v) => clip(JSON.stringify(v ?? {}), 300);
/** One OpenClaw tool call as { tool_name, tool_input, handoff }: handoff is why the office denies it, or null. */
export function toolCall(name, params = {}, derivedPaths = []) {
  const p = params && typeof params === 'object' ? params : {};
  const s = (v) => (typeof v === 'string' && v ? v : null);
  const other = (input = { description: short(p) }) => ({ tool_name: `openclaw:${name}`, tool_input: input, handoff: null });
  if (OUTSIDE.has(name)) return { tool_name: `openclaw:${name}`, tool_input: { description: short(p) }, handoff: `${name} starts work outside this session (another session, a later run, a paired device) or changes the Gateway. The office cannot hold that work, so it denies the call.` };
  if (FILE_TOOLS[name]) { const f = s(p.path) || s(p.file_path) || s(p.filePath); return f ? { tool_name: FILE_TOOLS[name], tool_input: { file_path: f }, handoff: null } : other(); }
  if (name === 'apply_patch') {
    const paths = (Array.isArray(derivedPaths) ? derivedPaths : []).map(String);
    return paths.length === 1 ? { tool_name: 'Edit', tool_input: { file_path: paths[0] }, handoff: null } : other({ description: clip(paths.join(', ') || 'a patch', 300) });
  }
  if (SHELL_TOOLS.has(name)) return s(p.command) ? { tool_name: 'Bash', tool_input: { command: p.command }, handoff: null } : other();
  if (RUN_TOOLS.has(name)) return { tool_name: 'Bash', tool_input: { command: `${name} ${short(p)}` }, handoff: null };
  if (name === 'web_fetch' && s(p.url)) return { tool_name: 'WebFetch', tool_input: { url: p.url }, handoff: null };
  if ((name === 'web_search' || name === 'x_search') && s(p.query)) return { tool_name: 'WebSearch', tool_input: { query: p.query }, handoff: null };
  return other();
}

// ---------- the config an office session needs ----------
// The Security room rows (security.mjs CALL_ROWS): with the plugin, every call goes to the office, so its settings carry them all.
const CALL_ROWS = ['read-inside', 'edit-inside', 'files-outside', 'shell', 'web', 'mcp', 'settings', 'secrets'];
const ENTRY = `plugins.entries.${PLUGIN_ID}`;
const unix = (p) => String(p).replace(/\\/g, '/').replace(/\/$/, '');
const samePath = (a, b) => { const n = (p) => unix(path.resolve(String(p))); return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };
// A path goes into a command in double quotes, with forward slashes (Windows takes them). A character that cmd, PowerShell or
// bash reads as more than text gets no command: quoting it right for three shells is not something to guess.
const SAFE_PATH = /^[\w:./\\ ()~+,=@-]+$/;
const quotedPath = (p) => (SAFE_PATH.test(String(p)) ? `"${unix(p)}"` : null);
// A list as a JSON5 array of single-quoted names inside double quotes, so it pastes into cmd, PowerShell and bash alike
// (OpenClaw parses values as JSON5, docs.openclaw.ai/cli/config). A name with an odd character gets no command.
const SAFE_ID = /^[\w:*.\-]+$/;
const listCommand = (key, list) => (list.every((t) => SAFE_ID.test(t)) ? `openclaw config set ${key} "[${list.map((t) => `'${t}'`).join(', ')}]" --strict-json` : null);
const norm = (x) => String(x).toLowerCase();
const listOf = (r) => (r.state === 'set' && Array.isArray(r.value) ? r.value.map(String) : []);

/**
 * What an office session needs in the Gateway config. tokenFile: this office's token file (the plugin reads its token and
 * port there). Returns { want: [{ path, value, rows, check }], gaps: [] }. check(read result) -> { ok, fix }.
 *   tools.fs.workspaceOnly = true (spec #73): its file tools stay in the worktree.
 *   plugins.enabled not false, the plugin not left out by plugins.allow or named in plugins.deny, plugins.entries.agent-office
 *   enabled, and its tokenFile this office's: then the plugin is loaded and asks this office about every tool call.
 * No gap: the office decides every call (the Security room rules, then a hold).
 */
export function wantedConfig({ tokenFile = null } = {}) {
  const set = (r) => r.state === 'set';
  const want = [
    { path: 'tools.fs.workspaceOnly', value: true, rows: ['files-outside'], check: (r) => ({ ok: set(r) && r.value === true, fix: 'openclaw config set tools.fs.workspaceOnly true' }) },
    { path: 'plugins.enabled', value: true, rows: CALL_ROWS, check: (r) => ({ ok: !set(r) || r.value !== false, fix: 'openclaw config set plugins.enabled true' }) },
    { path: 'plugins.allow', value: `unset, or a list with ${PLUGIN_ID}`, rows: CALL_ROWS, check: (r) => {
      const list = listOf(r);
      return { ok: !set(r) || !Array.isArray(r.value) || list.some((x) => norm(x) === PLUGIN_ID), fix: listCommand('plugins.allow', [...list, PLUGIN_ID]) };
    } },
    { path: 'plugins.deny', value: `no ${PLUGIN_ID}`, rows: CALL_ROWS, check: (r) => {
      const list = listOf(r);
      return { ok: !list.some((x) => norm(x) === PLUGIN_ID), fix: listCommand('plugins.deny', list.filter((x) => norm(x) !== PLUGIN_ID)) };
    } },
    { path: `${ENTRY}.enabled`, value: true, rows: CALL_ROWS, check: (r) => ({
      ok: set(r) && r.value === true,
      // Unset: the plugin is not installed. Installed from this folder (a link: an office update is the plugin update), it is on.
      fix: set(r) ? `openclaw plugins enable ${PLUGIN_ID}` : (quotedPath(PLUGIN_DIR) && `openclaw plugins install --link ${quotedPath(PLUGIN_DIR)} --force`),
    }) },
    { path: `${ENTRY}.config.tokenFile`, value: tokenFile ? unix(tokenFile) : 'the office token file', rows: CALL_ROWS, check: (r) => ({
      ok: Boolean(tokenFile) && set(r) && typeof r.value === 'string' && samePath(r.value, tokenFile),
      fix: tokenFile && quotedPath(tokenFile) ? `openclaw config set ${ENTRY}.config.tokenFile ${quotedPath(tokenFile)}` : null,
    }) },
  ];
  return { want, gaps: [] };
}

const show = (r) => (r.state === 'unreadable' ? 'unknown' : r.state === 'unset' ? 'unset' : JSON.stringify(r.value));

/**
 * Compare the wanted settings with the real ones. read(path) -> { state: 'set', value } | { state: 'unset' } | { state: 'unreadable', why }.
 * Returns { ok, unreadable, settings: [{ path, value, have, ok, fix, rows }], fix: [command text] }. rows: the Security room rows
 * the setting carries (security.mjs enforcement says a cell is not enforced while its setting is off). An unreadable setting is
 * never a pass and gets no command.
 */
export async function checkConfig(w, read) {
  const got = Object.fromEntries(await Promise.all(w.want.map(async (x) => [x.path, await read(x.path)])));
  const settings = [], fix = [];
  for (const x of w.want) {
    const r = got[x.path];
    const c = r.state === 'unreadable' ? { ok: false, fix: null } : x.check(r);
    const command = c.ok ? null : c.fix || null;
    settings.push({ path: x.path, value: x.value, have: show(r), ok: c.ok, fix: command, rows: [...x.rows] });
    if (command) fix.push(command);
  }
  return { ok: settings.every((s) => s.ok), unreadable: w.want.some((x) => got[x.path].state === 'unreadable'), settings, fix };
}

/**
 * A reader of the OpenClaw config by `openclaw config get <path> --json`. exe: the program resolver. Read-only.
 * Exit 1 means "valid key, no value" (docs.openclaw.ai/cli/config), but a crash, an invalid config or the wrong program also
 * exit 1. So exit 1 counts as unset only when `openclaw config validate` passes (exit 0) right after it. Any other failure,
 * and a validate that fails or cannot run, is "unreadable": the caller then cannot confirm the setting and says so.
 */
export function configReader({ exe, execFile = realExecFile, env = process.env, timeoutMs = READ_MS }) {
  const run = (args) => new Promise((resolve) => {
    let file;
    try { file = exe('openclaw'); } catch (e) { return resolve({ err: e, stdout: '' }); }
    execFile(file, args, { cwd: helperCwd(env), windowsHide: true, timeout: timeoutMs, env: { ...env }, maxBuffer: 1 << 20 }, (err, stdout) => resolve({ err, stdout }));
  });
  // Reads that fail with exit 1 at the same time share one validate.
  let validating = null;
  const valid = () => (validating ||= run(['config', 'validate']).then((r) => !r.err).finally(() => { validating = null; }));
  const why = (e) => clip(String(e.message || e), 200);
  return async (path) => {
    const { err, stdout } = await run(['config', 'get', path, '--json']);
    if (err && err.code === 1) {
      return (await valid()) ? { state: 'unset' } : { state: 'unreadable', why: 'it exited with 1 and `openclaw config validate` does not pass' };
    }
    if (err) return { state: 'unreadable', why: why(err) };
    try { return { state: 'set', value: JSON.parse(String(stdout).trim()) }; } catch { return { state: 'unreadable', why: 'it printed text that is not JSON' }; }
  };
}
