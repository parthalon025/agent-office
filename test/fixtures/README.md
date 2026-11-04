Hook payloads and stream lines for test/tracker.test.mjs.

The shapes were checked against a real recording on 2026-11-04 (Claude Code 2.1.318, one smoke run with
OFFICE_HOOKS=http; the raw /hook/http bodies and every headless stdout line). Values are small stand-ins and
file contents are removed. What the recording showed:

- Every hook body carries session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name.
- PermissionRequest has tool_name, tool_input, permission_suggestions. It has NO tool_use_id.
- PreToolUse and PostToolUse have tool_use_id. PostToolUse adds tool_response and duration_ms.
- Stop has last_assistant_message. UserPromptSubmit has prompt.
- Stream lines seen: system/init, system/status, system/hook_started, system/hook_response, stream_event,
  assistant, user, rate_limit_event, result (success and error_during_execution), control_response.

Not recorded yet: payloads from inside a subagent. The agent_id field on those events (SubagentStart,
SubagentStop, and the tool events a subagent makes) still follows the documented shape, not a recording.
Hook payloads go through payload.mjs slimPayload, as the server does.
