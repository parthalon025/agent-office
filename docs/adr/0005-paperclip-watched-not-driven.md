# 0005: Paperclip is watched, not driven, and Supervise in office is its one write

Status: proposed (needs the owner to confirm). From #76 (spec #67: Q18 revised, Q20 b, Q31, Q32, Q33) and the spike in #75.

## Context

Paperclip runs a company of agents: goals, heartbeats, routines, budgets. Spec #67 makes it an optional HQ above the office. The office must show its agents and keep its Claude Code runs supervised, without a second scheduler or a second budget fighting Paperclip's.

The spike (#75, Paperclip 2026.1023.0 on Windows) found:

- A `claude_local` agent defaults to the ACP engine, which approves every call and ignores `extraArgs`. Only `engine: cli` runs `claude --print` with the agent's `extraArgs`.
- The CLI engine still defaults `dangerouslySkipPermissions` to true.
- With `--settings <office hooks file>` but no `--permission-mode default`, the machine default (Auto) asked nothing: the session showed, no call was held.
- With all three, a Write was held in the office and Decline stopped it. A hold that timed out still left the run "succeeded" in Paperclip.

## Decision (proposed)

- Paperclip is a watcher (`paperclip.mjs`), not a provider. The provider seam is for agents the office opens, messages and closes; the office does none of that for Paperclip. Its Claude Code runs reach the office through the command hooks like terminal sessions, and the ids Paperclip puts in their environment (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`) label them.
- The office reads Paperclip's REST routes and its live events WebSocket. It never sends a heartbeat, assigns or changes a task, runs a routine or changes a budget. Both schedulers run. Paperclip's budget is the only limit on its runs.
- Loopback only: `http://127.0.0.1:<port>`, no other host (`localhost` included), no redirect, no credentials. Off until the user connects it.
- Supervise in office is the one write: one `PATCH /api/agents/:id` of one agent's `adapterConfig`, after the painted Confirm on the Security room's Agents screen (the route refuses it without `confirmed: true`). It sets `engine: cli`, `dangerouslySkipPermissions: false` and adds `--permission-mode default --settings <this office's command hooks file>` to `extraArgs`, keeping the agent's other arguments. All three in one PATCH, because each alone leaves the calls unheld.
- The agent shows "Unsupervised" until Paperclip's saved config carries all three. The office also reads each run's command line (`adapter.invoke`): a run without the office hooks is named in the feed and shown on the agent, and a model profile or an issue override that changes the run config shows "Partly supervised". The office cannot stop such a run: it only says so.
- A Paperclip run has no terminal dialog, so its held calls wait like an office session's (15 minutes) and end in a deny with a reason. When Paperclip marks such a run succeeded, the feed says that the office denied a call of it.

## Consequences

- The office never undoes Supervise in office: turning it back is a Paperclip setting, made in Paperclip.
- The office writes outside its own folder only through Paperclip's API, for one agent at a time, after a confirm. A later write (for example budgets) needs a new decision.
- A Paperclip in authenticated mode is not supported: the office keeps no Paperclip secret.
