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

// ---------- the config the Security room rules need ----------
// What the Security room cells (row -> ask | allow | deny) were before the user changes them. #70 owns the real rules; the
// caller passes the cells of the OpenClaw column.
// The server passes the OpenClaw column of the Security room (security.mjs cellsOf, for the session's building) as the cells.
// DEFAULT_CELLS (the room's defaults) is what a caller without the room gets. workspaceOnly and exec ask decide whether a
// session starts and how it is labelled (providers/acp.mjs start()); the rest says which cells the wall marks Not enforced.
export const DEFAULT_CELLS = { 'read-inside': 'allow', 'edit-inside': 'allow', 'files-outside': 'ask', shell: 'ask', web: 'ask', mcp: 'ask', settings: 'ask', secrets: 'ask' };
// A Deny cell is these tool ids in tools.deny (tool groups and ids as OpenClaw names them).
const DENY = { shell: ['group:runtime'], web: ['group:web'], 'edit-inside': ['write', 'edit', 'apply_patch'], mcp: ['group:plugins'], 'read-inside': ['read'] };
const DENY_ORDER = ['shell', 'web', 'edit-inside', 'mcp', 'read-inside'];
const NO_ASK = 'OpenClaw has no approval step for this kind of call, so it cannot ask.';
const GAP = {
  ask: { web: NO_ASK, mcp: NO_ASK, 'edit-inside': NO_ASK, 'read-inside': NO_ASK, 'files-outside': NO_ASK },
};
const NO_RULE = 'OpenClaw config has no rule for settings files that run code or for secret files.';
const WORKSPACE = 'Workspace-only is always on, so a read or edit outside the worktree is denied whatever this cell says.';

/**
 * The OpenClaw settings a set of Security room cells needs, and the cells config cannot carry.
 * cells: row -> 'ask' | 'allow' | 'deny' for the rows that rule tool calls. Only the rows given are judged.
 * Returns { want: [{ path, value, rows }], gaps: [{ row, value, reason }] }.
 *   tools.fs.workspaceOnly = true, always (spec #73).
 *   shell Ask: exec approval on (tools.exec.ask = always). Allow wants nothing: the office answers the prompt it gets.
 *   a Deny cell: its tool ids in tools.deny.
 */
export function wantedConfig(cells = {}) {
  const want = [{ path: 'tools.fs.workspaceOnly', value: true, rows: ['files-outside'] }];
  const gaps = [];
  const c = cells || {};
  if (c.shell === 'ask') want.push({ path: 'tools.exec.ask', value: 'always', rows: ['shell'] });
  const deny = [], rows = [];
  for (const row of DENY_ORDER) if (c[row] === 'deny') { deny.push(...DENY[row]); rows.push(row); }
  if (deny.length) want.push({ path: 'tools.deny', value: deny, rows });
  for (const row of Object.keys(c)) {
    const v = c[row];
    if (row === 'settings' || row === 'secrets') gaps.push({ row, value: v, reason: NO_RULE });
    else if (row === 'files-outside') { if (v !== 'deny') gaps.push({ row, value: v, reason: WORKSPACE }); }
    else if (v === 'ask' && GAP.ask[row]) gaps.push({ row, value: v, reason: GAP.ask[row] });
  }
  return { want, gaps };
}

// The command that sets the deny list. It must paste into cmd, PowerShell and bash alike, and single quotes do not protect JSON
// double quotes on native Windows. So the list is a JSON5 array of single-quoted names (OpenClaw parses values as JSON5,
// docs.openclaw.ai/cli/config) inside double quotes. A name with a character outside a tool id's usual set gets no command:
// quoting it right for three shells is not something to guess.
const SAFE_ID = /^[\w:*.\-]+$/;
function denyCommand(list) {
  if (!list.every((t) => SAFE_ID.test(t))) return null;
  return `openclaw config set tools.deny "[${list.map((t) => `'${t}'`).join(', ')}]" --strict-json`;
}
const norm = (x) => String(x).toLowerCase();
const show = (r) => (r.state === 'unreadable' ? 'unknown' : r.state === 'unset' ? 'unset' : JSON.stringify(r.value));

/**
 * Compare the wanted settings with the real ones. read(path) -> { state: 'set', value } | { state: 'unset' } | { state: 'unreadable', why }.
 * Returns { ok, unreadable, execAsks, settings: [{ path, value, have, ok, fix, rows }], fix: [command text] }. rows: the Security
 * room rows the setting carries (security.mjs enforcement says a cell is not enforced while its setting is off).
 * execAsks: true when OpenClaw asks before a shell command (tools.exec.ask is always or on-miss, or tools.exec.mode is ask),
 * false when it does not, null when the office could not read it. An unreadable setting is never a pass.
 */
export async function checkConfig(w, read) {
  const paths = [...new Set([...w.want.map((x) => x.path), 'tools.exec.ask', 'tools.exec.mode'])];
  const got = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await read(p)])));
  const ask = got['tools.exec.ask'], mode = got['tools.exec.mode'];
  const execAsks = ask.state === 'unreadable' || mode.state === 'unreadable' ? null
    : mode.value === 'ask' || ['always', 'on-miss'].includes(ask.value);
  const settings = [], fix = [];
  for (const x of w.want) {
    const r = got[x.path];
    let ok = false, command = null;
    if (x.path === 'tools.deny') {
      const list = r.state === 'set' && Array.isArray(r.value) ? r.value.map(String) : [];
      const missing = x.value.filter((t) => !list.some((h) => norm(h) === norm(t)));
      ok = r.state !== 'unreadable' && !missing.length;
      if (!ok) command = denyCommand([...list, ...missing]);
    } else if (x.path === 'tools.exec.ask') {
      ok = execAsks === true;
      // execAsks null: one of the two keys could not be read, so there is nothing true to tell the user to change.
      if (!ok && execAsks !== null) command = `openclaw config set ${x.path} ${x.value}`;
    } else {
      ok = r.state === 'set' && r.value === x.value;
      if (!ok) command = `openclaw config set ${x.path} ${x.value}`;
    }
    settings.push({ path: x.path, value: x.value, have: show(r), ok, fix: command && r.state !== 'unreadable' ? command : null, rows: [...x.rows] });
    if (command && r.state !== 'unreadable') fix.push(command);
  }
  const unreadable = paths.some((p) => got[p].state === 'unreadable');
  return { ok: settings.every((s) => s.ok), unreadable, execAsks, settings, fix };
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
