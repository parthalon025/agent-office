// Trims a Claude Code hook payload to what the office shows. hook.mjs (command hooks) and
// server.mjs (HTTP hooks) both use it, so the two hook paths carry the same fields.
// Never forward file contents or tool output: only names, short inputs, timings and flags.

const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);
const KEEP = ['command', 'file_path', 'pattern', 'url', 'description', 'path', 'query', 'subagent_type', 'skill'];
const TODO_STATES = new Set(['pending', 'in_progress', 'completed']);

export function slimPayload(b, officeId = null) {
  const ev = b.hook_event_name;
  const tool_input = {};
  if (b.tool_input && typeof b.tool_input === 'object') {
    for (const k of KEEP) if (b.tool_input[k] != null) tool_input[k] = clip(String(b.tool_input[k]), 300);
    // TodoWrite is the session's own plan. Keep the step texts and states only.
    if (b.tool_name === 'TodoWrite' && Array.isArray(b.tool_input.todos)) {
      tool_input.todos = b.tool_input.todos.slice(0, 40).map((t) => ({
        text: clip(String(t?.content || t?.activeForm || ''), 160),
        status: TODO_STATES.has(t?.status) ? t.status : 'pending',
      }));
    }
  }
  return {
    hook_event_name: ev, session_id: b.session_id, cwd: b.cwd, source: b.source, model: b.model,
    tool_name: b.tool_name, tool_input, tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
    // Set when the event comes from inside a subagent (Task or Agent tool).
    agent_id: typeof b.agent_id === 'string' ? b.agent_id : null, agent_type: clip(b.agent_type, 80) || null,
    duration_ms: typeof b.duration_ms === 'number' ? b.duration_ms : null,
    error: ev === 'PostToolUseFailure' ? clip(String(b.error || ''), 240) : null, is_interrupt: b.is_interrupt === true,
    prompt: clip(b.prompt, 400), message: clip(b.message, 300), reason: b.reason,
    office_id: officeId,
    // A permission prompt needs the full input (to show the change) and Claude's "always allow" suggestions.
    ...(ev === 'PermissionRequest' ? { full_input: b.tool_input, permission_suggestions: b.permission_suggestions } : {}),
  };
}
