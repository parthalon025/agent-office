# CLAUDE.md: Agent Office for Claude Code

A browser office for Claude Code sessions: bots at desks, a chat per bot, approvals, diffs, schedules. Node ES modules, no dependencies, Windows first. User docs are in `README.md`. The UI is the Agent Office design system (DS x1.5), documented in `DS-README.md`, `Recipes.md`, `Reference.md`, `Concepts.md`.

## UI rules (the DS is law for anything visual)

Read `DS-README.md`, `Recipes.md` and `Reference.md` before you change the UI, and follow the DS Rules and Definition of done.

- Use DS tokens for every color, size and duration. No literal colors. Use the DS icon set and DS components (`Button`, `Dialog`, `Select`, `TextInput`, `EmptyState`, ...). No emoji.
- Write copy in Simplified Technical English: short sentences, active voice, buttons say the result. No "Oops", "Sorry", exclamation marks, "please".
- Keep the `x` version prefix (page `x0.1`, DS `x1.5`) in titles.
- Never move bots yourself. The scene changes only from adapter events.
- Before you finish a UI change: `python kit/check.py public/index.html public/office.css public/office.js public/adapter.js public/chat-extras.js`, then look at screenshots in Day, Night and Sublevel at 1360, 1100 and 400 px.
- The page's own styles go in `public/office.css`. The DS sets its theme on `.ao-office`, and `chat-extras.js` mirrors it to `<html data-theme>`, so page UI must read tokens only.

## Commands

```
npm start            # server on http://localhost:4317
npm run probe        # prove HTTP hooks on this Claude Code version (one tiny call)
npm run smoke        # end-to-end test with real Haiku sessions, a few cents; needs the office running
```

Stop the server by the pid that owns port 4317 (`netstat -ano | grep :4317`, then `taskkill //PID <pid> //F`). Never kill by image name: that would kill other Claude Code sessions.

## Map

| File | Owns |
| --- | --- |
| `server.mjs` | Session state, hooks, headless sessions (stdin/stdout), permission holds, MCP routes, history, schedules, REST and SSE. |
| `git.mjs` | Worktrees, changes, remove worktree, pull request, `locate` (repo, worktree, branch of a folder), floors and rooms (`layout`, `branches`, `createFloor`, `createRoom`, `removeRoom`, `deleteFloor`). Argument lists only, never a shell. |
| `hook.mjs` | Command hook. Exits 0 on every path. |
| `payload.mjs` | Trims a hook payload to the fields the office shows. Used by `hook.mjs` and the HTTP hook route. |
| `mcp.mjs` | stdio MCP server: `office_inbox`, `office_ask`, `office_room`, `office_room_update`. |
| `public/adapter.js` | Snapshot to DS events (repo = building, branch = floor, worktree = room; tool calls, helpers, plan, errors, triggers, usage), and DS commands to REST calls. Exposes `officeAdapter.onSnapshot / session / lookup / buildings / buildingFor / shown / roomsShown / roomsNow`. |
| `public/city.js` | The city: all repositories as buildings on one DS stage (`AgentOffice.office.Stage`), with rise and sink effects, zoom to mouse, bounded pan, click or zoom in to enter. `OfficeCity.cameraFeel(stage)` also gives the office scene zoom to mouse. |
| `public/board.js` | Room boards: repaints the DS chalkboard as a live screen (to-dos, browser steps, last calls, repo top), adds a notes board, raises room walls to 7 and moves the room sign above the cable tray, flies the camera to a clicked board. |
| `public/office.js` | React: control strip and dialogs. Mounts `OfficeScene` once. |
| `public/chat-extras.js` | Chat resize grips, the `/` list, theme mirror. It depends on DS class names (`.ao-hud-chat`, `.ao-input`). |

Add a new file only for a distinct job. Extend the file that owns the concern first.

## How data moves

- Hooks (HTTP or command) post to `/hook/http` or `/hook`. `PermissionRequest` is held until `/api/answer`, or until it times out (60 s for terminal sessions, 15 min for office sessions).
- `PostToolUse`, `UserPromptSubmit` and `Stop` can return queued office messages to the session.
- An office session is `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`. Messages and control requests go to stdin. `onStream()` reads stdout.
- Every state change calls `broadcast()`. The browser gets full snapshots over `/events`.
- Sessions are keyed by `uid`. `sid` is Claude's session id. `officeId` links hooks to a session the office opened (env `OFFICE_ID`).

- Room awareness: `office_room` describes the room of the calling session. `office_room_update` changes only that room's notes board (`persisted.notes[key]`, kept as `{ text, at, by? }`, `by` is set when an agent wrote it) and one blackboard pin (`persisted.pins`). Each line an agent appends starts with the session name. A rewrite returns the old text in the reply.
- `POST /api/notes/save` takes an optional `base` (the `at` the editor last saw). If the stored `at` differs, it answers 409 `{ error, text, at }`. On success it returns `{ ok: true, at }`. A cleared board returns `at: 0`.
- `office_room` lists the decor of a lab room under "What is in the room" from one list in `roomContents()` (server.mjs), next to the fixed lab-room parts and the street. The list is the same for every room, so the page does not report it. Keep it in step with `board.js`.

## Gotchas learned the hard way

- `cmd /c start "Office" ...` needs the quoted title. Unquoted, `start` runs a program named Office.
- Write `.office-token` only after `listen` succeeds. A second copy that fails with EADDRINUSE must not change it. The token is reused across restarts on purpose.
- A headless session emits `init` (session id, commands, skills) only after its first message. The server keeps the last command list for new sessions.
- Claude Code's default permission mode may be Auto, so no prompts appear. Tests that need a prompt must pass `permissionMode: 'default'`.
- The hook's parent shell dies right after the hook returns, so the process walk must happen while the hook waits. A persistent PowerShell helper (`walkToClaude`) does it.
- HTTP hook failures are non-blocking. Command hooks must stay silent on stdout unless they return real hook JSON.
- "Always allow" uses `permission_suggestions` from the hook payload and returns them as `updatedPermissions`. Pass only `addRules` with `behavior: allow`. Edits get a mode suggestion, not a rule.
- `result` with `error_during_execution` after an interrupt is not an error. Check `s.interrupted`.
- Hooks fired inside a subagent carry `agent_id`. Use it to put the call on the helper bot, and keep it off the parent's task line.
- `room.add` needs `floorId`. The building's floor has `id: 1` for that reason.
- The DS weekly-limit meter shows demo numbers when no `usage` events arrive, and its engine adds usage while bots work. The server reads `rate_limits` from the status line file; the adapter re-sends the figure every 15 s; `office.css` hides the meter without it and always hides the per-bot rows.
- One scene shows one building. `buildingFor(repo)` sets the layout, then the scene mounts; `subscribe` resets the adapter's mapping each mount. The SSE stream belongs to the page, not to the scene.
- The DS has no `room.remove` or `floor.remove`. The page rebuilds the scene (a new React key) when a shown room is gone.
- Two worktrees on one branch need `git worktree add --force`.
- Room boards are matched to rooms by order: the shown floor's lab rooms, left to right, against the chalkboards (4 x 2.5 planes) sorted by x. The engine rebuilds a floor when a bot joins, so board.js rescans every 1.5 s and patches what is new.
- The scene fades out (`duration-base`) before any rebuild: another building, the city, a removed floor or room. Labels in the city sit on layer 1 so the bloom pass skips them.
- Extensions: `mcp_status`, `mcp_toggle`, `mcp_reconnect`, `reload_plugins` are control requests on the session's stdin; they work before the first prompt. Persistent changes use `claude mcp` and `claude plugin` with scope local or project only.
- The Bash tool mangles backslashes and quotes in long heredocs. Write patch scripts with the Write tool.

## Safety rules

- Bind to 127.0.0.1, check the Host header, require the token on every route except the page and its static files.
- Never edit `~/.claude/settings.json` or `.credentials.json`. The office only writes files in this folder and the per-project rule a user approves.
- Extensions change only the local or project scope of a session's folder. User scope stays out of reach, also through `claude mcp` or `claude plugin` (owner decision, 2026-11-03).
- Pull requests, pushes and worktree removal happen only after an explicit click and a confirm dialog.
- Do not add dependencies without asking. The server runs on Node built-ins.

## Not built

Remote or phone access (needs real login and TLS; suggest Tailscale), terminal sessions taking chat input, non-Windows session launch.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on parthalon025/agent-office (use `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles as GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created when terms or decisions are settled. See `docs/agents/domain.md`.
