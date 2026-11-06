# 0005: Paperclip is watched, not driven, and Supervise in office is its one write

Status: accepted, 2026-11-05. From #76 (spec #67: Q18 revised, Q20 b, Q31, Q32, Q33) and the spike in #75.

## Context

Paperclip is the graph harness that runs a company of agents: goals, heartbeats, routines, budgets. The office supervises those agents: it holds the Claude Code calls of their runs for the user's answer, and shows them. Spec #67 makes Paperclip an optional HQ above the office. The office must show its agents and keep its Claude Code runs supervised, without a second scheduler or a second budget fighting Paperclip's. The office is the user's check on a harness that runs them.

The spike (#75, Paperclip 2026.1023.0 on Windows) found:

- A `claude_local` agent defaults to the ACP engine, which approves every call and ignores `extraArgs`. Only `engine: cli` runs `claude --print` with the agent's `extraArgs`.
- The CLI engine still defaults `dangerouslySkipPermissions` to true.
- With `--settings <office hooks file>` but no `--permission-mode default`, the machine default (Auto) asked nothing: the session showed, no call was held.
- With all three, a Write was held in the office and Decline stopped it. A hold that timed out still left the run "succeeded" in Paperclip.

## Decision

- Paperclip is a watcher (`paperclip.mjs`), not a provider. The provider seam is for agents the office opens, messages and closes; the office does none of that for Paperclip. Its Claude Code runs reach the office through the command hooks like terminal sessions, and the ids Paperclip puts in their environment (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`) label them.
- The office reads Paperclip's REST routes and its live events WebSocket. It never sends a heartbeat, assigns or changes a task, runs a routine or changes a budget. Both schedulers run. Paperclip's budget is the only limit on its runs.
- Loopback only: `http://127.0.0.1:<port>`, no other host (`localhost` included), no redirect, no credentials. Off until the user connects it.
- Supervise in office is the one write: one `PATCH /api/agents/:id` of one agent's `adapterConfig`, after the painted Confirm on the Security room's Agents screen (the route refuses it without `confirmed: true`). It sets `engine: cli`, `dangerouslySkipPermissions: false` and adds `--permission-mode default --settings <this office's command hooks file>` to `extraArgs`, keeping the agent's other arguments and taking out each flag that lets a run approve its own calls or turns off hooks (`--allowedTools` among them). All three in one PATCH, because each alone leaves the calls unheld. The office reads the agent again just before the PATCH and builds it from that read.
- The agent shows "Unsupervised" until Paperclip's saved config carries all three. The office also reads each run's command line (`adapter.invoke`): a run without the office hooks is named in the feed and shown on the agent, and a model profile or an issue override that changes the run config, another program than claude, or a flag or env key that loads what the office cannot read, shows "Partly supervised". The office reads only the names of the agent's env keys and never writes env. It cannot see the environment of the Paperclip process itself, which Paperclip also passes to its runs. The office cannot stop such a run: it only says so.
- A Paperclip run has no terminal dialog, so its held calls wait like an office session's (15 minutes, as for an office session; the command hook waits up to 1000 seconds since `hook.mjs` posts with `node:http`, #128) and end in a deny with a reason. That holds for every session with Paperclip run ids, whether or not the office watches its company. When Paperclip marks such a run succeeded, the feed says that the office denied a call of it.

## Consequences

- The office never undoes Supervise in office: turning it back is a Paperclip setting, made in Paperclip.
- The office writes outside its own folder only through Paperclip's API, for one agent at a time, after a confirm. A later write (for example budgets) needs a new decision.
- A Paperclip in authenticated mode is not supported: the office keeps no Paperclip secret.
- What the office cannot read fails closed: a route that fails, an `env` field a Paperclip does not list, an issue list that may be cut, or a setting the office does not know shows "Partly supervised" with the reason, never "Supervised". The projects and routines routes and their `env` fields are in the Paperclip source (0.3.1); the `engine` setting of `claude_local` is from the spike only, and without it the agent shows Unsupervised.
- "Supervised" means the office holds every call Claude Code asks about. A call that an allow rule in a settings file of the run's folder or the home folder allows is not asked about, and the office does not read those files.
