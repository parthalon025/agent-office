// Extensions: the argument lists for Claude Code's own CLI (`claude mcp`, `claude plugin`) that the office runs in a
// session's folder. The lists are pure, no I/O, so the rules are tested without a server (test/extensions.test.mjs). The service
// at the end (createExtensions) runs them for one session, with everything it touches injected (the sessions, the control request, the CLI).
// The office changes only scope local or project, never user (owner decision, 2026-11-03). The CLI reads options
// after the name too, and the last --scope wins (checked with `claude mcp add`), so a name `-suser` would become
// `--scope user`. Two fences stop that: a name or id starts with a letter or a digit, and `--` ends the options
// before every connector name. Plugin verbs keep --scope as the last argument, so it wins over anything before it.
import path from 'node:path';
import { httpError } from './office-core.mjs';

export const EXT_SCOPES = new Set(['local', 'project']);
const MCP_NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
// Names listed by a session (mcp_status) can have spaces, colons and @ (plugin and claude.ai connectors).
const LISTED_NAME_RE = /^[A-Za-z0-9][\w.:@ -]{0,119}$/;
const PLUGIN_RE = /^[A-Za-z0-9][\w.@\/-]{0,159}$/;
const PLUGIN_VERBS = new Set(['enable', 'disable', 'install', 'uninstall']);

/** Throws a 400 error; the server sends `e.status` and `e.message` as they are. */
function refuse(message) { const e = new Error(message); e.status = 400; throw e; }
function checkScope(scope) {
  if (!EXT_SCOPES.has(scope)) refuse('Use the scope local or project. The office does not change user settings.');
}

/** `claude mcp add`: a URL becomes an http (or sse) connector; any other target is a command and its arguments. */
export function mcpAddArgs({ scope, name, target, transport }) {
  checkScope(scope);
  const n = String(name ?? '').trim(), t = String(target ?? '').trim();
  if (!MCP_NAME_RE.test(n)) refuse('Use letters, digits, dots and dashes for the name. Start with a letter or a digit.');
  if (!t) refuse('Give a URL or a command.');
  if (/^https?:\/\//i.test(t)) return ['mcp', 'add', '--scope', scope, '--transport', transport === 'sse' ? 'sse' : 'http', '--', n, t];
  return ['mcp', 'add', '--scope', scope, '--', n, ...t.split(/\s+/)];
}

/** `claude mcp remove` for a connector name the session listed. */
export function mcpRemoveArgs({ scope, name }) {
  checkScope(scope);
  const n = String(name ?? '');
  if (!LISTED_NAME_RE.test(n)) refuse('Unknown connector.');
  return ['mcp', 'remove', '--scope', scope, '--', n];
}

/** `claude plugin enable|disable|install|uninstall <id> --scope <scope>`. */
export function pluginArgs({ verb, scope, id }) {
  checkScope(scope);
  if (!PLUGIN_VERBS.has(verb)) refuse('Unknown action.');
  const p = String(id ?? '').trim();
  if (!PLUGIN_RE.test(p)) refuse('Use the plugin id, for example name@marketplace.');
  return ['plugin', verb, p, '--scope', scope];
}

// ---------- the extensions service: connectors and plugins of one session ----------
/**
 * createExtensions({ sessions, control, claude, addFeed, root }) -> { list(uid), action(body) }.
 * sessions: the live sessions map. control(s, request, onDone): a control request to the session's provider. claude: the Claude Code
 * provider (its CLI). addFeed(s, kind, text). root: the folder a session without a repository works from.
 */
export function createExtensions({ sessions, control, claude, addFeed, root: ROOT }) {
// Turn on and off: the running session only (control requests mcp_toggle, mcp_reconnect).
// Add, remove, enable and disable for good: Claude Code's own CLI (`claude mcp`, `claude plugin`) in the
// session's folder, with scope local (this folder, not shared) or project (shared in the repo).
// The office never writes user scope: that is ~/.claude settings, which the office does not change.
// The CLI argument lists, with the scope and name rules, come from extensions.mjs.
const NAME_RE = /^[\w.:@ -]{1,120}$/;
function ask(s, request, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(httpError(504, 'The session did not answer.')), ms);
    try { control(s, request, (r) => { clearTimeout(t); if (r.subtype === 'error') reject(httpError(409, r.error || 'The session refused.')); else resolve(r.response || {}); }); }
    catch (e) { clearTimeout(t); reject(e); }
  });
}
function claudeCli(args, cwd) {
  return new Promise((resolve, reject) => {
    claude.cli(args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) return reject(httpError(409, (String(stderr || '').trim() || String(out || '').trim() || err.message).split('\n').slice(-3).join(' ')));
      resolve(String(out));
    });
  });
}
function extSession(uid) {
  const s = sessions.get(String(uid));
  if (!s || s.status === 'ended') throw httpError(404, 'That session is not open.');
  return s;
}
const samePath = (a, b) => !!a && !!b && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
async function extList(s) {
  let servers = null;
  if (s.headless) servers = ((await ask(s, { subtype: 'mcp_status' }, 45000)).mcpServers || []).map((m) => ({
    name: m.name, status: m.status, scope: m.scope, source: m.source, error: m.error || null,
    transport: m.transport, tools: Array.isArray(m.tools) ? m.tools.length : null,
  }));
  const root = s.git?.root || s.cwd;
  let plugins = [];
  try {
    plugins = JSON.parse(await claudeCli(['plugin', 'list', '--json'], s.cwd || ROOT))
      .filter((p) => p.scope === 'user' || samePath(p.projectPath, root) || samePath(p.projectPath, s.cwd))
      .map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled === true }));
  } catch { /* no plugins or an older CLI */ }
  return { servers, plugins, folder: root, live: !!s.headless };
}
async function extAction(body) {
  const s = extSession(body.uid);
  const scope = String(body.scope || 'local');
  const cwd = s.git?.root || s.cwd;
  const reload = async () => { if (s.headless) await ask(s, { subtype: 'reload_plugins' }, 60000).catch(() => null); };
  switch (String(body.action)) {
    case 'toggle': {
      if (!s.headless) throw httpError(409, 'Only sessions that run in the office can turn connectors on and off.');
      if (!NAME_RE.test(String(body.name))) throw httpError(400, 'Unknown connector.');
      await ask(s, { subtype: 'mcp_toggle', serverName: String(body.name), enabled: body.enabled === true });
      addFeed(s, 'tool', `${body.enabled ? 'turned on' : 'turned off'} ${body.name} for this session`);
      return { ok: true };
    }
    case 'reconnect':
      if (!s.headless) throw httpError(409, 'Only sessions that run in the office can reconnect connectors.');
      await ask(s, { subtype: 'mcp_reconnect', serverName: String(body.name) }, 60000);
      return { ok: true };
    case 'mcp-add': {
      const name = String(body.name || '').trim();
      await claudeCli(mcpAddArgs({ scope, name, target: body.target, transport: body.transport }), cwd);
      addFeed(s, 'tool', `added the connector ${name} (${scope})`);
      return { ok: true, restart: true };
    }
    case 'mcp-remove': {
      await claudeCli(mcpRemoveArgs({ scope, name: body.name }), cwd);
      addFeed(s, 'tool', `removed the connector ${body.name} (${scope})`);
      return { ok: true, restart: true };
    }
    case 'plugin-enable': case 'plugin-disable': case 'plugin-install': case 'plugin-uninstall': {
      const id = String(body.id || '').trim();
      const verb = String(body.action).slice(7);
      await claudeCli(pluginArgs({ verb, scope, id }), cwd);
      addFeed(s, 'tool', `${{ enable: 'enabled', disable: 'disabled', install: 'installed', uninstall: 'removed' }[verb]} the plugin ${id} (${scope})`);
      await reload();
      return { ok: true };
    }
    default: throw httpError(400, 'Unknown action.');
  }
}
  return { list: (uid) => extList(extSession(uid)), action: extAction };
}
