// Extensions: the argument lists for Claude Code's own CLI (`claude mcp`, `claude plugin`) that the office runs in a
// session's folder. Pure, no I/O, so the rules are tested without a server (test/extensions.test.mjs). server.mjs
// runs the lists; a test cannot import server.mjs, because importing it starts the office.
// The office changes only scope local or project, never user (owner decision, 2026-11-03). The CLI reads options
// after the name too, and the last --scope wins (checked with `claude mcp add`), so a name `-suser` would become
// `--scope user`. Two fences stop that: a name or id starts with a letter or a digit, and `--` ends the options
// before every connector name. Plugin verbs keep --scope as the last argument, so it wins over anything before it.
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
