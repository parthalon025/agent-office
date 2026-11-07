// The settings files an office hands to Claude Code (#185): command hooks, HTTP hooks and the MCP config. Pure: the folder, the port
// and the agent token go in, three plain objects come out. The office writes them (owner-only) once it owns its port.
import path from 'node:path';
import { portArgs } from './files.mjs';

const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd',
];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
// HTTP hooks: Claude posts straight to the office, with no Node start-up. Session start and end stay command hooks (start needs
// the process walk, end runs while the process exits). An HTTP failure is non-blocking, so a stopped office never stalls a session.
const HTTP_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop']);
// The hook may wait as long as the longest hold; the server decides when to give up.
const ASK_SECONDS = 1000;
// The office tools are safe to pre-allow: they only talk to this server, and office_room_update changes only the caller's own
// room boards (notes and blackboard pin in state.json).
const PERMISSIONS = { allow: ['mcp__office__office_inbox', 'mcp__office__office_ask', 'mcp__office__office_room', 'mcp__office__office_room_update', 'mcp__office__office_mail'] };

/** { commandSettings, httpSettings, mcpConfig } for the office in `root` on `port` with `agentToken`. `node` is the Node program the hooks run. */
export function hookSettings({ root, port, agentToken, node = process.execPath }) {
  const NODE = node.replace(/\\/g, '/');
  // On a port other than the default, the port follows as an argument, so hook.mjs reads this office's token file.
  const hookCommand = [`"${NODE}" "${path.join(root, 'src', 'hook.mjs').replace(/\\/g, '/')}"`, ...portArgs(port)].join(' ');
  // Command hooks: one Node process per event (~60 ms). Works on every Claude Code version.
  const commandSettings = {
    hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => {
      const entry = { hooks: [{ type: 'command', command: hookCommand, timeout: ev === 'PermissionRequest' ? ASK_SECONDS : 10 }] };
      if (TOOL_EVENTS.has(ev)) entry.matcher = '*';
      return [ev, [entry]];
    })),
    permissions: PERMISSIONS,
  };
  const httpSettings = {
    hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => {
      const hook = HTTP_EVENTS.has(ev)
        ? { type: 'http', url: `http://127.0.0.1:${port}/hook/http`, headers: { 'x-office-token': agentToken, 'x-office-id': '$OFFICE_ID' }, allowedEnvVars: ['OFFICE_ID'], timeout: ev === 'PermissionRequest' ? ASK_SECONDS : 10 }
        : { type: 'command', command: hookCommand, timeout: 10 };
      const entry = { hooks: [hook] };
      if (TOOL_EVENTS.has(ev)) entry.matcher = '*';
      return [ev, [entry]];
    })),
    permissions: PERMISSIONS,
  };
  const mcpConfig = { mcpServers: { office: { command: NODE, args: [path.join(root, 'src', 'mcp.mjs').replace(/\\/g, '/'), ...portArgs(port)] } } };
  return { commandSettings, httpSettings, mcpConfig };
}
