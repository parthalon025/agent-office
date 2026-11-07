// What the Copilot CLI entry of providers/acp.mjs needs that ACP does not carry (#22). A distinct job, so its own file, like
// openclaw.mjs; there is no second ACP client. GitHub Copilot CLI speaks ACP as `copilot --acp`; acp.mjs runs it.
//   SESSION_ARGS, PROBE_ARGS   the switches of a session and of the readiness check
//   SELF_APPROVE               the environment switches that approve tool calls by themselves: taken out of its environment
//   requestCall(raw)           Copilot's own permission request body (rawInput.kind shell, write, read, url, mcp...) as the
//                              tool name and input the office rates; null for anything else (a tool's own arguments)
//   argsCall(card, raw, loc)   a call's own arguments in the shape of that card, so a change after the request is seen
//   MODEL_RE                   a model id the office passes as --model
// From Copilot CLI 1.0.105 (copilot help config, copilot help permissions, copilot help environment; the handshake in
// test/fixtures/copilot-acp.json signed out, copilot-acp-signed-in.json signed in). Its request bodies come from the SDK schema of that version
// (copilot-sdk/generated/session-events.d.ts PermissionRequest*), not from a signed-in run that asked for a permission. One signed-in prompt with no tools ("Reply with the word ok.") was recorded on
// 2026-11-06 (test/fixtures/copilot-acp-prompt.json).
//
// What Copilot does (2026-11-05, from 1.0.105 on the owner's PC). Its default permission mode ("manual") asks before writes and
// commands and approves read-only requests by itself, so it reads in its folder and runs a command or MCP tool it rates read-only
// without asking. Hooks (user settings, .github/hooks) run commands without asking, and allowedUrls open without asking.
// defaultPermissionMode is ignored outside interactive runs, so --acp sessions cannot be set to allow-all from its config.
// requestCall returns the ACP kind, tool name and input the office shows and rates; an edit carries only its file, like every ACP edit.
// argsCall reads a later rawInput and its location in the shape of the card: the command, file or address it shows, or an MCP
// tool's plain arguments object. A wrapper that names the server or tool, or a card that showed no arguments, gives null until a
// signed-in run records the real shape.
// No spend limit (owner decision Q22, decision 1 of the #22 review pending; default A: one rule for every no-cost kind), so the
// office never passes --max-ai-credits. The office MCP server is not given to it (mcpServers: [], as for every ACP agent).
// Tested in test/copilot.test.mjs with the fake test/fixtures/fake-copilot.mjs (the handshakes and the prompt recorded from 1.0.105).
// Pure: no I/O.

// Every session: ACP on stdio, the installed version (no download), no ask_user tool (the office cannot show its questions
// over ACP), and no automatic file access to the system temp folder (only the session folder).
export const SESSION_ARGS = ['--acp', '--no-auto-update', '--no-ask-user', '--disallow-temp-dir'];
// The readiness check: no update, and none of the built-in MCP servers (the GitHub one signs in and calls out). acp.mjs adds
// --log-dir with a temp folder of its own, so the check writes no log in ~/.copilot/logs.
export const PROBE_ARGS = ['--acp', '--no-auto-update', '--disable-builtin-mcps'];
export const LOG_DIR_ARG = '--log-dir';
// COPILOT_ALLOW_ALL approves every tool call (and "true" also trusts the folder, which loads its hooks); COPILOT_ASSISTED_APPROVAL
// lets a model approve calls in older versions. The office never passes --allow-all, --allow-tool, --yolo or --autopilot.
// Windows names are not case-sensitive, so acp.mjs matches them in any case.
export const SELF_APPROVE = ['COPILOT_ALLOW_ALL', 'COPILOT_ASSISTED_APPROVAL'];
export const MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,79}$/;
export const SIGN_IN = 'Sign in to GitHub Copilot: run copilot login in a terminal, then check again.';
export const INSTALL = 'Install GitHub Copilot CLI so that copilot.exe is on the PATH (winget install GitHub.Copilot), then run copilot login in a terminal.';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const safeName = (v) => str(v).replace(/[^\w.-]/g, '_').slice(0, 60) || 'tool';
const KINDS = new Set(['shell', 'write', 'read', 'url', 'mcp', 'memory', 'custom-tool', 'hook', 'extension-management', 'workflow', 'extension-permission-access', 'extension-env-access']);

/**
 * A Copilot permission request body as { kind, tool_name, tool_input }: kind is the ACP tool kind the provider's rules use
 * (an edit's declined file, a command's grant), tool_name and tool_input what the card shows and risk.mjs rates. An edit
 * carries only its file, like every ACP edit, so a later update of the same call keeps the same card. null: not a request
 * body (the tool's own arguments of a tool_call), so the provider reads the call as it reads any ACP call.
 */
export function requestCall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !KINDS.has(raw.kind)) return null;
  switch (raw.kind) {
    case 'shell': return { kind: 'execute', tool_name: 'Bash', tool_input: { command: str(raw.fullCommandText) } };
    case 'write': return { kind: 'edit', tool_name: 'Edit', tool_input: { file_path: str(raw.fileName) } };
    case 'read': return { kind: 'read', tool_name: 'Read', tool_input: { file_path: str(raw.path) } };
    case 'url': return { kind: 'fetch', tool_name: 'WebFetch', tool_input: { url: str(raw.url) } };
    case 'mcp': return { kind: 'other', tool_name: `mcp__${safeName(raw.serverName)}__${safeName(raw.toolName)}`, tool_input: raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? { ...raw.args } : {} };
    // memory, custom tools, hooks, extensions, workflows: a name risk.mjs does not know, so it is medium and the user reads it.
    default: return { kind: 'other', tool_name: 'Copilot ' + raw.kind, tool_input: { description: str(raw.intention || raw.toolName || raw.kind).slice(0, 300) } };
  }
}

/**
 * A call's own arguments (the rawInput of a later tool_call update, and its location) in the shape of the card its request
 * body gave (requestCall): { tool_name, tool_input } with the field that card shows (command, file_path, url, or an MCP
 * tool's arguments). The provider compares it with what the user saw, so a call that changed after the request is seen
 * (#125). null: the arguments do not say (no such field, a request body, an MCP wrapper, or a card such as memory, or an MCP
 * card with no arguments, that they cannot be read against), so the card stands. Only fields read from the arguments: never the title, which would look like a change.
 */
export function argsCall(card, raw, loc = null) {
  if (!card || !card.tool_input || !raw || typeof raw !== 'object' || Array.isArray(raw) || requestCall(raw)) return null;
  const text = (v) => (typeof v === 'string' && v ? v : null);
  const as = (tool_input) => ({ tool_name: card.tool_name, tool_input });
  // An MCP tool: only a plain arguments object says, read against a card that showed arguments. A wrapper that names the
  // server or the tool ({ serverName, toolName, arguments }) is a shape no signed-in run has recorded yet, so it does not
  // say: read as plain arguments it would look like a change and decline a call that did not change. The provider compares
  // with the keys sorted, so the same arguments in another order are no change.
  if (card.tool_name.startsWith('mcp__')) {
    if (!Object.keys(card.tool_input).length || !Object.keys(raw).length || 'serverName' in raw || 'toolName' in raw) return null;
    return as({ ...raw });
  }
  const input = card.tool_input;
  if ('command' in input) {
    const command = Array.isArray(raw.command) ? raw.command.map(String).join(' ') : text(raw.command);
    return command ? as({ command }) : null;
  }
  if ('file_path' in input) {
    const file = text(loc) || text(raw.file_path) || text(raw.path) || text(raw.filePath) || text(raw.fileName);
    return file ? as({ file_path: file }) : null;
  }
  if ('url' in input) return text(raw.url) ? as({ url: raw.url }) : null;
  return null;
}
