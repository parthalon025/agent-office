Hook payloads and stream lines for test/tracker.test.mjs.

They follow the shapes Claude Code sends (the fields the office reads: hook_event_name, session_id, cwd,
tool_name, tool_input, tool_use_id, agent_id, duration_ms, is_interrupt, permission_suggestions; and the
stream-json lines system/init, stream_event, assistant, result). They were assembled by hand from those
shapes and the gotchas in CLAUDE.md, with no paid call. Hook payloads go through payload.mjs slimPayload,
as the server does. To refresh one with a real recording, capture the body posted to /hook/http.
