# 0010: Paperclip is included and driven from the HQ

Status: accepted (Paperclip HQ grilling, 2026-11-06). Supersedes ADR 0005 (watched, not driven) and ADR 0007 (the goal handoff as the second and last write).

## Context

The owner wants all of Paperclip inside Agent Office: its views rebuilt in the office design, every write available from the office, and Paperclip part of the first-run setup for every user. Until now the office only watched Paperclip and wrote two things: Supervise and the goal handoff. A local Paperclip in its default mode (`local_trusted`) trusts every program on the PC, so any process, an agent included, could hire, pay or approve without a token.

## Decision

- **Included, not vendored.** Orientation installs a pinned version of the official `paperclipai` package into a folder of the office that git ignores. Its data (the embedded database) lives in `%LOCALAPPDATA%\AgentOffice\paperclip`, outside the repo. The office starts and stops it with the office; "Update Paperclip" at the HQ needs a Confirm. A user who already runs Paperclip can connect to it instead, and the office never installs over it. The office repository still has no npm dependencies. The office requires Node 24.11 or newer (Paperclip's own minimum).
- **Login mode on loopback.** The office sets Paperclip up in its authenticated mode, bound to loopback, and holds the only board key in an owner-only file. Only the office acts on Paperclip; a local process without the key cannot.
- **Rebuilt, not reskinned.** Every Paperclip product page is rebuilt in the office design system and calls Paperclip's API through the office server (Paperclip has no CORS, and the key never reaches the browser). Sign-in pages, the design guide and the UX labs are not rebuilt.
- **Every write, by a user-set grid.** The HQ has a write grid like the Security room: each write kind (hire, pause or retire, budget, approval, reporting line, routine, invite and access, secret, task, comment, and the first company of Orientation, #199) is Confirm, Allow or Deny. Defaults: Confirm for the consequential kinds, Allow for the user's own task edits and comments, and secrets never Allow. Loosening a cell needs the painted Confirm. Every write leaves a feed line.
- **Self-approval is a setting, not an open door.** An employee may approve its own work only for the approval kinds the user allows at the HQ. Budget, hire, access and secrets stay with the user.
- **Every agent through the office.** New hires run through the office adapter: Paperclip hands each run to the office, which runs it with the employee agent kind under supervision, and reports result, cost and transcript back. The office adds a provider for every tool Paperclip has an adapter for (Codex, Cursor local and cloud, Gemini, Grok, Kimi, OpenCode, Pi, Hermes local and gateway, the OpenClaw gateway, generic ACP), gated where the tool allows it and otherwise ungated under ADR 0001. Paperclip adapter code is MIT and may be learned from with attribution. Office Managers are Paperclip employees in a manager role (amended 2026-11-07, #204: Paperclip has no `manager` role, so a Manager is hired as a Project manager, `pm`, and the office keeps its own record of which employees are Managers).
- **A hire is supervised and budgeted.** A new employee starts Supervised (the office's settings on its adapter) and always has a budget; the office never hires without the write grid's answer.

## Consequences

- The office becomes Paperclip's front end for this user. Paperclip's own UI stays reachable on its port but is not the main surface.
- The office has a much larger write surface into another system. One writer module owns every Paperclip write, and a test asserts the full set of non-GET requests per write kind.
- Node 22 support ends for the office. CI moves to Node 24.
- A Paperclip upgrade can change its API. The pinned version and a contract test against the recorded API protect the office; updates go through the HQ button.
