// Trims a Claude Code hook payload to what the office shows. hook.mjs (command hooks) and
// server.mjs (HTTP hooks) both use it, so the two hook paths carry the same fields.
// Never forward file contents or tool output: only names, short inputs, timings and flags.

const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);
// element and key: what a browser tool (Playwright) clicks or presses. Typed text is never kept.
const KEEP = ['command', 'file_path', 'pattern', 'url', 'description', 'path', 'query', 'subagent_type', 'skill', 'element', 'key'];
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

// One-line label for a tool call, shared by the tracker's calls, task line and requests.
const basename = (v) => (v ? v.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
export function describeTool(name, input = {}) {
  const base = (v) => basename(String(v || ''));
  switch (name) {
    case 'Bash': return short(input.command, 90);
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return base(input.file_path);
    case 'Grep': case 'Glob': return short(input.pattern, 60);
    case 'WebFetch': return short(input.url, 70);
    case 'WebSearch': return short(input.query, 70);
    case 'Task': case 'Agent': return short(input.description || input.subagent_type, 70);
    case 'Skill': return short(input.skill, 70);
    default:
      // browser tools (Playwright and the like): the page, the element or the key
      if (/playwright|browser/i.test(name)) return short(input.url || input.element || input.key || '', 80);
      return short(input.description || input.command || input.file_path || input.query || '', 70);
  }
}

// The identity of one tool call: agent, tool and the trimmed input. slimPayload builds tool_input in the fixed
// KEEP order, so the PermissionRequest and the PostToolUse of the same call give the same key. The label from
// describeTool is not enough: it keeps only a basename or the start of a command, so two calls can share it.
export const callKey = (p) => (p.agent_id || '') + '\n' + p.tool_name + '\n' + JSON.stringify(p.tool_input || {});
// A tool result settles a request only when the request is for the same call (r.key = callKey of the request).
export const settles = (r, p) => r.key === callKey(p);
