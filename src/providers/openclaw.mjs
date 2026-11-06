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
import fs from 'node:fs';
import os from 'node:os';
import { execFile as realExecFile } from 'node:child_process';
import { clip } from '../tracker.mjs';
import { helperCwd } from '../launch.mjs';
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
// OpenClaw loads src/integrations/openclaw-plugin into its Gateway. Its before_tool_call handler sends each tool call of a session the
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
const HANDOFF = (name) => `${name} starts work outside this session (another session, a later run, a paired device) or changes the Gateway. The office cannot hold that work, so it denies the call.`;
const NODE_HANDOFF = (name) => `${name} on a paired device (node) runs outside this PC and its worktree. The office cannot hold that work, so it denies the call.`;
const short = (v) => clip(JSON.stringify(v ?? {}), 300);
// apply_patch names its files in its own text (OpenClaw's patch format). OpenClaw's derivedPaths are hints only ("best-effort,
// may be incomplete", src/plugins/hook-types.ts), so the office reads these lines itself. OpenClaw splits the text on line
// breaks and trims each line before it looks for a header (src/agents/apply-patch-parse.ts at v2026.10.10), so the office does
// the same: a header with spaces or a tab in front is still a header. Any line that reads as a header counts, also one OpenClaw
// would take as hunk text: more files ask, never fewer.
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+?)\s*$/;
/** The files an apply_patch text names (Add, Update, Delete File and Move to), in order, as written, or [] when it names none. */
export function patchFiles(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/).map((l) => PATCH_FILE.exec(l.trim())?.[1]).filter(Boolean);
}

// The files an OpenClaw file tool can touch for one path. OpenClaw reads a path before it uses it (v2026.10.10), and the office
// rates the file that is used, not the text the model wrote:
//   - agent-tools.params.ts normalizeFileToolPathParam: a "</arg_value>>" left at the end goes, and an invented Office
//     extension (".docodex") becomes the real one.
//   - path-policy.ts preserveAtPrefixedRelativePath: "@x" names the literal file "./@x" only when it, or its top folder, exists.
//   - sessions/tools/path-utils.ts expandPath with sandbox-paths.ts normalizeFileReferencePrefix: one leading "@" goes (a
//     file reference; a second "@" stays part of the name), then a file:// URL becomes its path, and "~", "~/" (and "~\" on
//     Windows) become the home folder.
//   - path-utils.ts getReadPathVariants: a read that misses tries other spellings of the name (Unicode spaces as plain spaces,
//     the NFC form). Quote spellings are left out: no Security room name has a quote.
// A literal "@" file can go away between the hold and the run, so the office then holds both files. Every file is held on its
// own row, so a call is allowed only when each one is.
const XML_TAIL = /<\/arg_value>>+$/;
const OFFICE_EXT = /\.(doc|ppt|xls)(?:odex|codex|xodex|xcodex)$/i;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const isHome = (p) => p === '~' || p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'));
const isAbs = (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
/**
 * The files OpenClaw can use for path `raw`: the one it uses now first, then the one it uses if a literal "@" file goes. [] for
 * no path. opts: { cwd, home, exists, read } (exists(absolutePath) -> boolean; read: the read tool, which tries other spellings).
 */
export function pathsOf(raw, { cwd = '', home = os.homedir(), exists = fs.existsSync, read = false } = {}) {
  if (typeof raw !== 'string' || !raw) return [];
  const repaired = (raw.includes('</arg_value>') ? raw.replace(XML_TAIL, '') : raw).replace(OFFICE_EXT, (m, f) => `.${f.toLowerCase()}x`);
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const literal = literalAt(repaired, cwd, exists);
  if (literal) add(literal);
  add(expand(repaired, home));
  if (read) {
    for (const p of [...out]) {
      const name = path.basename(p), dir = p.slice(0, p.length - name.length);
      add(dir + name.replace(UNICODE_SPACES, ' ').normalize('NFC'));
    }
  }
  return out;
}
// preserveAtPrefixedRelativePath: "./@x" when x is a plain relative path and "./@x" or its top folder exists, else null.
function literalAt(p, cwd, exists) {
  if (!p.startsWith('@')) return null;
  const rest = p.slice(1);
  if (!rest || isHome(rest) || rest.startsWith('~\\') || /^file:\/\//i.test(rest) || isAbs(rest)) return null;
  let top = p;
  for (;;) { const up = path.dirname(top); if (up === '.' || up === top) break; top = up; }
  const at = (q) => { try { return exists(path.resolve(String(cwd || '.'), `./${q}`)); } catch { return false; } };
  return at(p) || (top !== p && at(top)) ? `./${p}` : null;
}
// expandPath: one leading "@" goes (a second one stays, behind "./"), a file:// URL becomes its path, "~" is the home folder.
function expand(p, home) {
  let q = p.startsWith('@') ? p.slice(1) : p;
  if (q.startsWith('@')) q = `./${q}`;
  if (q.startsWith('file://')) { try { return fileURLToPath(q); } catch { return q; } }
  if (isHome(q)) return q === '~' ? home : path.join(home, q.slice(2));
  return q;
}
// The MCP tools of OpenClaw's bundle-mcp are named "<server>__<tool>" (docs.openclaw.ai/gateway/config-tools/tool-policy, "MCP
// servers"); no core tool id has "__". They become "mcp__<server>__<tool>", so the Security room MCP row rates them (risk.mjs).
// A server called "office" would read as the office's own tools (mcp__office__, no row), so it keeps an "openclaw-" prefix.
const MCP_NAME = /^([A-Za-z][\w-]*)__(.+)$/;
const SECRET_NAME = /key|token|secret|passw|auth|cred/i;

/**
 * One OpenClaw tool call as the office holds it: { tool_name, tool_input, handoff, reason, firm, files }.
 *   handoff: why the office denies the call at once, or null. reason: what the card adds to the tool and input (the fields of
 *   an exec that change what it does), or null. firm: the user answers it (an Allow rule does not), a Deny rule still does.
 *   files: more than one file (an apply_patch, or a path OpenClaw can read as two files, pathsOf); the office holds each on
 *   its own, with the same tool. tool_input.file_path is the first.
 * Paths are the files OpenClaw uses (pathsOf), not the text the model wrote. paths: { home, exists } for pathsOf (tests).
 */
export function toolCall(name, params = {}, derivedPaths = [], cwd = '', paths = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const s = (v) => (typeof v === 'string' && v ? v : null);
  const out = (tool_name, tool_input, more = {}) => ({ tool_name, tool_input, handoff: null, reason: null, firm: false, ...more });
  const other = (input = { description: short(p) }) => out(`openclaw:${name}`, input);
  const where = (f, read = false) => pathsOf(f, { cwd, ...paths, read });
  if (OUTSIDE.has(name)) return out(`openclaw:${name}`, { description: short(p) }, { handoff: HANDOFF(name) });
  if (FILE_TOOLS[name]) {
    const f = s(p.path) || s(p.file_path) || s(p.filePath);
    const files = f ? where(f, name === 'read') : [];
    if (!files.length) return other();
    if (files.length === 1) return out(FILE_TOOLS[name], { file_path: files[0] });
    return out(FILE_TOOLS[name], { file_path: files[0] }, { files, reason: clip(`OpenClaw can use either file for ${f}: ${files.join(', ')}.`, 300) });
  }
  if (name === 'apply_patch') return patchCall(p, derivedPaths, cwd, other, where);
  if (SHELL_TOOLS.has(name)) return s(p.command) ? execCall(name, p) : other();
  if (RUN_TOOLS.has(name)) return out('Bash', { command: `${name} ${short(p)}` });
  if (name === 'web_fetch') return out('WebFetch', { url: s(p.url) || short(p) });
  if (name === 'web_search' || name === 'x_search') return out('WebSearch', { query: s(p.query) || short(p) });
  if (name === 'browser') return browserCall(p);
  const mcp = MCP_NAME.exec(name);
  if (mcp) return out(`mcp__${mcp[1].toLowerCase() === 'office' ? 'openclaw-' : ''}${mcp[1]}__${mcp[2]}`, { description: short(p) });
  return other();
}

// exec (bash is its alias), src/agents/bash-tools.schemas.ts at v2026.10.10. host "node" or a node name runs on a paired
// device: denied, like the nodes tool. elevated runs with host elevation: high risk (risk.mjs), and the user answers it. env
// changes what the command does (NODE_OPTIONS, a PATH-like variable): the user answers it. workdir, env, elevated, host and
// background go on the card as its reason line, so what the user approves is what runs.
function execCall(name, p) {
  if (p.host === 'node' || (typeof p.node === 'string' && p.node.trim())) {
    return { tool_name: 'Bash', tool_input: { command: p.command }, handoff: NODE_HANDOFF(name), reason: null, firm: false };
  }
  const env = p.env && typeof p.env === 'object' && !Array.isArray(p.env) ? Object.entries(p.env) : [];
  const elevated = p.elevated === true;
  const parts = [];
  if (elevated) parts.push('Runs with host elevation.');
  if (typeof p.workdir === 'string' && p.workdir.trim()) parts.push(`Folder: ${p.workdir}.`);
  // A value under a name that reads as a secret is not shown: the card is on the screen.
  if (env.length) parts.push(`Environment: ${env.map(([k, v]) => `${k}=${SECRET_NAME.test(k) ? '(hidden)' : String(v)}`).join(', ')}.`);
  if (typeof p.host === 'string' && p.host && p.host !== 'auto') parts.push(`Host: ${p.host}.`);
  if (p.background === true) parts.push('Keeps running after the turn (background).');
  return {
    tool_name: 'Bash', tool_input: elevated ? { command: p.command, elevated: true } : { command: p.command },
    handoff: null, reason: parts.length ? clip(parts.join(' '), 300) : null, firm: elevated || env.length > 0,
  };
}

// apply_patch: the files its text names, together with OpenClaw's hints. One file: an Edit of that file. More: an Edit of
// each, so each file meets its own Security room row (a hook or a settings file asks, a secret file asks or is denied).
// A patch text that names no file is not rated as an edit: the office cannot see what it changes, so it asks.
// Each path, from the text or a hint, is read the way OpenClaw reads it (pathsOf): "@.git/hooks/x" is .git/hooks/x.
function patchCall(p, derivedPaths, cwd, other, where) {
  const named = patchFiles(p.input ?? p.patch);
  const hints = (Array.isArray(derivedPaths) ? derivedPaths : []).map(String).filter(Boolean);
  if (!named.length) return other({ description: clip(`a patch that names no file it changes${hints.length ? ` (OpenClaw's hints: ${hints.join(', ')})` : ''}`, 300) });
  const seen = new Map();
  const keyOf = (f) => { const a = path.resolve(String(cwd || '.'), f); return process.platform === 'win32' ? a.replace(/\//g, '\\').toLowerCase() : a; };
  for (const f of [...named, ...hints].flatMap((x) => where(x))) if (!seen.has(keyOf(f))) seen.set(keyOf(f), f);
  const files = [...seen.values()];
  return { tool_name: 'Edit', tool_input: { file_path: files[0] }, handoff: null, reason: files.length > 1 ? clip(`A patch of ${files.length} files: ${files.join(', ')}.`, 300) : null, firm: false, files };
}

// browser (extensions/browser/src/browser-tool.schema.ts at v2026.10.10): the Web row. target "node" or a node name is a paired
// device: denied. An upload sends files from this PC to a page: the user answers it, and the card names the files.
function browserCall(p) {
  const s = (v) => (typeof v === 'string' && v ? v : null);
  const where = s(p.targetUrl) || s(p.url) || `browser ${s(p.action) || short(p)}`;
  if (p.target === 'node' || (typeof p.node === 'string' && p.node.trim())) return { tool_name: 'WebFetch', tool_input: { url: where }, handoff: NODE_HANDOFF('browser'), reason: null, firm: false };
  const files = Array.isArray(p.paths) ? p.paths.map(String).filter(Boolean) : [];
  if (p.action === 'upload' || files.length) {
    return { tool_name: 'WebFetch', tool_input: { url: where }, handoff: null, reason: clip(`Uploads files from this PC: ${files.join(', ') || 'files the call does not name'}.`, 300), firm: true };
  }
  return { tool_name: 'WebFetch', tool_input: { url: where }, handoff: null, reason: null, firm: false };
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
 * port there). Returns { want: [{ path, value, rows, check, warn? }], gaps: [] }. check(read result) -> { ok, fix, note? }.
 *   tools.fs.workspaceOnly = true (spec #73): its file tools stay in the worktree.
 *   tools.exec.host not "node": an exec that names no host runs where this says, and "node" is a paired device (the plugin
 *   denies an exec that names a node itself, toolCall).
 *   plugins.enabled not false, the plugin not left out by plugins.allow or named in plugins.deny, plugins.entries.agent-office
 *   enabled, and its tokenFile this office's: then the plugin is loaded and asks this office about every tool call.
 *   warn (not a precondition, carries no row): plugins.entries.agent-office.hooks gives OpenClaw's wait for the plugin's
 *   answer no shorter limit than the 600 s the plugin asks for. A shorter one only denies sooner: the plugin ends its own wait
 *   before it (src/integrations/openclaw-plugin/gate.js hookLimit), so the card goes with the call.
 * No gap: the office decides every call (the Security room rules, then a hold).
 */
export function wantedConfig({ tokenFile = null } = {}) {
  const set = (r) => r.state === 'set';
  const want = [
    { path: 'tools.fs.workspaceOnly', value: true, rows: ['files-outside'], check: (r) => ({ ok: set(r) && r.value === true, fix: 'openclaw config set tools.fs.workspaceOnly true' }) },
    { path: 'tools.exec.host', value: 'unset, auto, gateway or sandbox', rows: ['shell'], check: (r) => ({ ok: !set(r) || norm(r.value) !== 'node', fix: 'openclaw config set tools.exec.host auto' }) },
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
    { path: `${ENTRY}.hooks`, value: `no limit under ${HOOK_LIMIT_MS / 1000} s for before_tool_call`, rows: [], warn: true, check: (r) => {
      const h = set(r) && r.value && typeof r.value === 'object' ? r.value : {};
      const limit = hookLimit(h);
      if (limit >= HOOK_LIMIT_MS) return { ok: true, fix: null };
      const key = positive(h.timeouts?.before_tool_call) !== undefined ? `${ENTRY}.hooks.timeouts.before_tool_call` : `${ENTRY}.hooks.timeoutMs`;
      return { ok: false, fix: `openclaw config unset ${key}`, note: `${key} is ${limit} ms, so OpenClaw waits ${Math.round(limit / 1000)} s for your answer to a tool call; a call you do not answer by then is denied.` };
    } },
  ];
  return { want, gaps: [] };
}

// OpenClaw's limit for the plugin's before_tool_call handler, the way it picks it (src/plugins/registry-state.ts
// resolveTypedHookTimeoutMs): hooks.timeouts.before_tool_call, else hooks.timeoutMs, else the plugin's own 600 s. The plugin
// keeps the same rule (gate.js hookLimit; test/openclaw-plugin.test.mjs compares the two).
export const HOOK_LIMIT_MS = 600_000;
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
export const hookLimit = (hooks) => positive(hooks?.timeouts?.before_tool_call) ?? positive(hooks?.timeoutMs) ?? HOOK_LIMIT_MS;

const show = (r) => (r.state === 'unreadable' ? 'unknown' : r.state === 'unset' ? 'unset' : JSON.stringify(r.value));

/**
 * Compare the wanted settings with the real ones. read(path) -> { state: 'set', value } | { state: 'unset' } | { state: 'unreadable', why }.
 * Returns { ok, unreadable, settings: [{ path, value, have, ok, fix, rows, warn, note }], fix: [command text] }. rows: the Security
 * room rows the setting carries (security.mjs enforcement says a cell is not enforced while its setting is off). An unreadable
 * setting is never a pass and gets no command. warn: a setting that is not a precondition (ok and unreadable leave it out);
 * note: its words.
 */
export async function checkConfig(w, read) {
  const got = Object.fromEntries(await Promise.all(w.want.map(async (x) => [x.path, await read(x.path)])));
  const settings = [], fix = [];
  for (const x of w.want) {
    const r = got[x.path];
    const c = r.state === 'unreadable' ? { ok: false, fix: null } : x.check(r);
    const command = c.ok ? null : c.fix || null;
    settings.push({ path: x.path, value: x.value, have: show(r), ok: c.ok, fix: command, rows: [...x.rows], warn: x.warn === true, note: c.ok ? null : c.note || null });
    if (command) fix.push(command);
  }
  const needed = w.want.filter((x) => !x.warn);
  return { ok: settings.every((s) => s.ok || s.warn), unreadable: needed.some((x) => got[x.path].state === 'unreadable'), settings, fix };
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
