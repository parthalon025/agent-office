# 0004: The office reads the OpenClaw config and never writes it

Status: proposed (needs the owner to confirm). Found in the review of #73.

## Context

Spec #73 says: "Start it with `tools.fs.workspaceOnly` on. Push the Security room rules that OpenClaw config can carry (exec ask, tool deny list)." The office has only read the OpenClaw config (`openclaw config get`). It has not written it.

Reasons to read only:

- The Gateway is shared. Other clients use it (owner decision Q40). `tools.fs.workspaceOnly`, `tools.exec.ask` and `tools.deny` apply to all of them. A write from the office changes their behavior.
- The config lives outside the office folder. The Safety rules in `CLAUDE.md` say the office writes only files in its own folder, its page file and the per-project rule a user approves.
- The Security room (#70) does not exist yet. There is no screen with a Confirm for a write.

## Decision (proposed)

- The office reads the OpenClaw config before each session (`providers/acp.mjs`, `gateCheck`). It never writes it.
- `tools.fs.workspaceOnly` is a precondition. If it is off or unreadable, OpenClaw is not ready and no session starts. The message gives the `openclaw config set` command for the user to run.
- Exec approval (`tools.exec.ask` or `tools.exec.mode`) is a precondition too (owner decision 3, default B, 2026-11-05; it replaces "the session runs as Unsupervised"). If it is off or unreadable, OpenClaw is not ready, the office refuses the open before the cost question and before a worktree (`preflight`), and no session starts. The message gives `openclaw config set tools.exec.ask always`. So the label "commands ask" is true for every session that runs (ADR 0001).
- Changed by #77 (2026-11-05): the office plugin for OpenClaw (`integrations/openclaw-plugin`) sends every tool call of an office session to the office, so OpenClaw is gated and the Security room rules apply to every call. The preconditions are now workspace-only and the plugin loaded for this office (`plugins.enabled`, `plugins.allow`, `plugins.deny`, `plugins.entries.agent-office.enabled` and its `config.tokenFile`). Exec approval is no longer one: a command asks through the plugin, and when exec approval is on as well, the office answers it with the same decision, so the user is asked once. The office still only reads the config and shows the commands. The owner confirms this with #77.
- Pushing Security room rules into the config is out until #70 has a painted Confirm for it. Until then the Security room shows those cells as "Not enforced for this agent".

## Consequences

- The user sets two or three config keys by hand once. The message names each command.
- If the owner wants the office to write the config, that needs a new decision, the Confirm in the Security room, and a note to the user that other clients of the Gateway are affected.
