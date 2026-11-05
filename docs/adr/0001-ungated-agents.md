# 0001: Ungated agents are allowed, labelled and opt-in

Status: accepted (owner decision, 2026-11-04)

## Context

The office holds every tool call that is not low risk until the user answers (`riskOf`, the permission holds in `server.mjs`). New agent kinds come in as providers: Hermes and DeepSeek Harness (`dsh`) through one ACP provider, OpenClaw, and Paperclip as an optional HQ. Research (2026-11-04) found:

- Hermes (`hermes acp`) and `dsh` (`dsh --profile acp`) send tool approvals to the client with ACP `session/request_permission`. `dsh` fails closed when no client answers. Hermes has open issues: a fixed 60 s edit timeout, and a denied edit that may be retried through another write tool. Its "always" answer writes a permanent allowlist in Hermes's own settings.
- OpenClaw (v2026.10.10) relays only shell exec approvals over ACP. File edits, writes, browser and web tools have no approval step. Native Windows is untested upstream.
- Paperclip's `claude-local` adapter starts Claude Code with `--dangerously-skip-permissions` by default and without the office's hooks. Paperclip approvals cover business actions only (hire an agent, CEO strategy), not tool calls.

The rule "every tool call is held" would keep OpenClaw and unsupervised Paperclip agents out. The owner chose to let them in.

## Decision

- A provider declares `gated: true` or `gated: false`. A gated provider holds every tool call, as before. Only `gated: false` skips the hold.
- An ungated agent shows a label on its bot, its desk terminal and its room sign: "Unsupervised", or "Partly supervised: commands ask, file edits do not" when some calls are held (OpenClaw).
- An ungated provider is off until the user turns it on in the Security room (Agents screen), with a confirm.
- An ungated agent runs only in a fresh worktree. The open dialog does not offer "Use this folder" for it.
- The Security room grid (agent kind x kind of action: Ask, Allow, Deny) applies to every agent kind. For a gated agent the office answers Allow and Deny at once and holds Ask. For an ungated agent the office sets what the agent's own config supports (for OpenClaw: exec approval, tool deny list, `tools.fs.workspaceOnly`) and marks every other cell "Not enforced for this agent", with the reason. It never shows a setting as active when it is not.
- The Secrets cells (settings files that run code, secret files) offer Ask and Deny only, for every agent kind.
- ACP agents never get "Always allow": the office sends allow-once or deny.
- The office offers its own file and terminal capabilities to ACP agents. Their reads, writes and commands then run through `providers/local-tools.mjs`, limited to the worktree and rated by `riskOf`.
- The office still records every tool call it can see, with its risk, in the feed.

## Consequences

- An ungated agent can change any file the user can change. A fresh worktree limits accidents, not deliberate misuse.
- The label and the "Not enforced" marks are the only signal. They must stay true when a provider changes.
- Paperclip agents can become gated: "Supervise in office" turns off skip-permissions and adds the office hooks (after a confirm, because it writes to Paperclip).
- The planned real fix is a sandbox: the office as a container stack (ADR 0002). An OpenClaw plugin on `before_tool_call` that sends every call to the office is a follow-up and would make OpenClaw gated.
