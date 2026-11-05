fake-openai.mjs is a fake OpenAI-compatible chat server for the local providers. fake-acp.mjs is a fake ACP agent (newline-
delimited JSON-RPC on stdio) for test/acp-provider.test.mjs and test/mcp-routes.test.mjs; its prompt steps are listed at the
top of the file. It follows the ACP v1 schema (agentclientprotocol.com), not a recording of Hermes Agent or dsh: neither was
run for these tests.

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

Result lines: a `success` result has `result`. An API failure is `subtype: success` with `is_error: true`,
`api_error_status` and `result: "API Error: ..."`. The `error_*` subtypes (`error_during_execution`,
`error_max_turns`, `error_max_budget_usd`) have `errors[]` and no `result`. The raw recording from 2026-11-04 is
not kept, so these result shapes follow the SDK type `SDKResultError` (claude-agent-sdk sdk.d.ts), not a recording.

Not recorded yet: payloads from inside a subagent. The agent_id field on those events (SubagentStart,
SubagentStop, and the tool events a subagent makes) still follows the documented shape, not a recording.
Hook payloads go through payload.mjs slimPayload, as the server does.

`office-server.mjs` is not a recording. It starts a real `server.mjs` copy for the tests that need one: ready on the server's own "is open" line, a fast failure when the server stops first, and a new port when the free port was taken before the bind (#98). Its own test is `test/office-server.test.mjs`.

`agent-framework.jsonl` is not a recording. It is the stdout of `providers/agent_framework_runner.py` for one team turn
(a lead, a hand-off to coder, coder to reviewer, back to lead), written by hand from the Microsoft Agent Framework 1.24
Python sources (`WorkflowEvent` types `output`, `handoff_sent`, `executor_invoked`, `executor_completed`; `Content`
types `text` and `usage`). The framework is not installed on the build machine, so no live run has checked it yet (#23).
`fake-af/` is a stand-in `agent_framework` package with the same names, for the test that runs the real runner with Python.
