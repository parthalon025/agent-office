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

`short-name.mjs` is not a recording. `shortOf(dir)` gives the 8.3 short spelling of a folder (cmd's `%~s`), or null when the volume keeps none. GitHub's Windows runner has TEMP in `C:\Users\RUNNER~1\...`, so the tests that check that both spellings of one folder are one place (`test/risk.test.mjs`, `test/security-routes.test.mjs`) use it.

`agent-framework.jsonl` is not a recording. It is the stdout of `providers/agent_framework_runner.py` for one team turn
(a lead, a hand-off to coder, coder to reviewer, back to lead), written by hand from the Microsoft Agent Framework 1.24
Python sources (`WorkflowEvent` types `output`, `handoff_sent`, `executor_invoked`, `executor_completed`; `Content`
types `text` and `usage`), in the order those sources make:
- `handoff_sent` comes before the source's `executor_completed`: the hand-off executor adds it inside its handler
  (`agent_framework_orchestrations/_handoff.py` `_run_agent_and_emit`).
- Before the request to the target, the source sends its reply to every other member with `should_respond=False`
  (`_broadcast_messages`; the start agent also sends the first input on its first run). Each such message is one
  `executor_invoked` and one `executor_completed` of that member (`agent_framework/_workflows/_executor.py` `execute`),
  in the next superstep, before the target runs. So a member's `executor_completed` does not mean it finished.
- Members in one superstep run in parallel, so their events interleave.
The framework is not installed on the build machine, so no live run has checked it yet (#23).
`fake-af/` is a stand-in `agent_framework` package with the same names, for the test that runs the real runner with Python.

`fake-openclaw.mjs` is not a recording. It stands in for the OpenClaw Gateway's plugin host for `test/openclaw-plugin.test.mjs` and `test/mcp-routes.test.mjs` (#77): it loads `integrations/openclaw-plugin` by its `package.json` entry, checks the manifest id and the config, and runs `before_tool_call` handlers by priority with the host's failure rule (a throw or the handler's `timeoutMs`, default 15 s, blocks the call). The rules come from the OpenClaw v2026.10.10 sources and docs (`src/plugin-sdk/plugin-entry.ts`, `docs/plugins/hooks/reference.md`, `docs/plugins/hooks/tool-policy.md`): OpenClaw on the build PC (2026.1.29) is too old to start, so no real Gateway ran the plugin yet.
