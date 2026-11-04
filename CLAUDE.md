# CLAUDE.md: Agent Office for Claude Code

A browser office for Claude Code sessions: bots at desks, a chat per bot, approvals, diffs, schedules. Node ES modules, no dependencies, Windows first. User docs are in `README.md`. The UI is the Agent Office design system (DS x1.5), documented in `DS-README.md`, `Recipes.md`, `Reference.md`, `Concepts.md`.

## UI rules (the DS is law for anything visual)

Read `DS-README.md`, `Recipes.md` and `Reference.md` before you change the UI, and follow the DS Rules and Definition of done.

- Use DS tokens for every color, size and duration. No literal colors. Use the DS icon set and DS components (`Button`, `Dialog`, `Select`, `TextInput`, `EmptyState`, ...). No emoji.
- Write copy in Simplified Technical English: short sentences, active voice, buttons say the result. No "Oops", "Sorry", exclamation marks, "please".
- Keep the `x` version prefix (page `x0.1`, DS `x1.5`) in titles.
- Never move bots yourself. The scene changes only from adapter events.
- Before you finish a UI change: `python kit/check.py public/index.html public/office.css public/office.js public/adapter.js public/chat-extras.js public/city.js public/board.js public/terminal.js public/wheel-gate.js public/vocab.js public/scene-host.js public/building.js public/format.js public/toasts.js`, then look at screenshots in Day, Night and Sublevel at 1360, 1100 and 400 px.
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
| `server.mjs` | Headless sessions (stdin/stdout), permission holds, MCP routes, history, schedules, REST and SSE. It feeds the tracker and sends its sessions as the snapshot. |
| `tracker.mjs` | Session tracker: the session rules. Hook payloads (`onHook`, `permissionRequest`, `askQuestion`) and stream lines (`onStream`) in, `tracker.sessions` and `tracker.feed` out. Clock, id maker, git locate, persistence sink, change callback and hold release are injected (`createTracker(deps)`), so importing it starts nothing and tests need no server. This is the seam other agent providers feed. |
| `git.mjs` | Worktrees, changes, remove worktree, pull request, `locate` (repo, worktree, branch of a folder), floors and rooms (`layout`, `branches`, `createFloor`, `createRoom`, `removeRoom`, `deleteFloor`), and `resolveExe(name)`, which turns a program name into an absolute path. Argument lists only, never a shell. Every git call gets `GIT_HARDENING` (no fsmonitor, no hooks, no pager, no external diff, no ext:: remote) before its subcommand, read-only ones also `--no-optional-locks` (`gitArgs`), and `createPr` refuses when the repository config sets a filter driver (`assertNoFilters`). Raw `execFile('git')` outside `git.mjs` is not allowed. Tests: `test/git-hardening.test.mjs`. |
| `extensions.mjs` | Argument lists for `claude mcp` and `claude plugin`. Names start with a letter or digit, `--` comes before connector names, scope is local or project only. Pure; tested in `test/extensions.test.mjs`. |
| `place.mjs` | Place: where a session or worktree sits. Building key and name, floor, room id and name, notes key. Pure, no I/O. The snapshot carries it as `session.place` and `worktree.place`; the page reads it and keeps no copy of the rules. |
| `notes.mjs` | Notes board: read, the user's save with a base version, agent append and replace, the blackboard pin. The version is a counter. A three-way merge (`merge3`) keeps the user's deletions and changes. Pure: the maps and the clock are injected. |
| `risk.mjs` | Risk of a tool call (`riskOf(tool, input, root)`): an allowlist, so only reads and edits inside the root are low, and never for a secret-looking file or a settings path (`.git`, `.claude`, `.vscode`, `.idea`, `.mcp.json`). An edit to settings that run code is high anywhere; a secret read outside the root is high. Relative paths are read against the root. `inside(root, target)` compares path text only (no I/O, links not followed); `realInside(root, target)` also resolves junctions, links and short names (`realpathSync.native`, nearest existing parent) and is what the rating uses. Every agent provider uses this one rule. Tested in `test/risk.test.mjs` (real junctions in a temp folder). |
| `manager.mjs` | Manager core: one goal into steps handed to agents (plan, assign, approve first, retry, spend limit before each dispatch, mail hop and message caps). Pure like `tracker.mjs`: `createManager(deps)` gets planner, agents, dispatch and clock injected. `events()` gives `plan` and `plan.step` for the page to re-emit on every mount. Tested in `test/manager.test.mjs`. Server wiring waits for the provider seam (#18). |
| `providers/local-tools.mjs` | The tools of a local-model agent (Read, LS, Grep, Edit, Write, Bash), limited to one worktree: `inside()` plus a realpath check, a time limit, and a process-tree kill. It never decides approval; the caller asks `riskOf` first. Tested in `test/local-tools.test.mjs` with the fake OpenAI server in `test/fixtures/fake-openai.mjs`. |
| `startup.mjs` | Start with Windows: a `.cmd` in the per-user Startup folder (no admin). Folder injected in tests. Routes: `startup` in `GET /api/info`, `POST /api/startup {enabled}`. The UI is in the Attach sessions dialog. Never kills by image name. |
| `hook.mjs` | Command hook. Exits 0 on every path. |
| `probe.mjs` | `npm run probe`: proves HTTP hooks on this Claude Code version (one tiny Haiku call) and switches the office to them. Needs the office running. |
| `payload.mjs` | Trims a hook payload to the fields the office shows. Used by `hook.mjs` and the HTTP hook route. Also the tool label (`describeTool`) and the call key (`callKey`, `settles`) that links a tool result to its permission request. |
| `mcp.mjs` | stdio MCP server: `office_inbox`, `office_ask`, `office_room`, `office_room_update`. |
| `public/vocab.js` | Session vocabulary, shared by the page, the server and the tests (`globalThis.OfficeVocab`). Status key and word (error included), task line, tool kind and short name, to-do status, room figures. Plain script, no I/O, no timers. |
| `public/wheel-gate.js` | Wheel gate (`OfficeWheelGate`, tested in `test/wheel-gate.test.mjs`). Decides when scrolling out leaves a level: one gesture, one level; 600 ms pause after a change; 2 pushes at the floor, 3 at the building. Plain script, the caller passes the time. |
| `public/building.js` | Snapshot store and building adapter, no DOM (`globalThis.OfficeBuilding`, tested in `test/building.test.mjs`). `createStore()` owns the latest snapshot; `store.mount(repo)` makes one building adapter per mounted scene: snapshot to DS events (repo = building, branch = floor, worktree = room; tool calls, helpers, plan, errors, triggers, usage), `stale()`, `roomInfo / figures / noteKey / session / lookup / uidsOf`. `store.requests()` is the Needs you list: every open request and question of every building, oldest first. |
| `public/adapter.js` | The browser side of it: the SSE stream into the store, DS commands to REST calls, and `window.officeAdapter` (the store plus `mount(repo)`, which adds the DS adapter as `.adapter`). |
| `public/city.js` | The city: all repositories as buildings on one DS stage (`AgentOffice.office.Stage`), with rise and sink effects, zoom to mouse, bounded pan, click or zoom in to enter. `OfficeCity.cameraFeel(stage)` also gives the office scene zoom to mouse. |
| `public/scene-host.js` | Scene host (`OfficeSceneHost`): the only module that reads the DS stage for the page's 3D additions. Shown floor and view, room groups matched to DS rooms, a rebuild event, a per-frame tick, one pick with bot occlusion and one winner, and the pointer cursor. The pure part runs on plain scene graphs in `test/scene-host.test.mjs`. |
| `public/board.js` | Room boards: repaints the DS chalkboard as a live screen (to-dos, browser steps, last calls, repo top), adds a notes board, raises room walls to 7 and moves the room sign above the cable tray, flies the camera to a clicked board or, from `open(roomId, kind)`, to the one Ctrl+K asked for. `OfficeBoard.escTaken(e)` tells Esc that a dialog or the palette is on top. A host adapter: it registers a pick target and a frame, and never raycasts or sets the cursor itself. |
| `public/terminal.js` | Desk terminals (`OfficeTerminal`): repaints each bot's desk monitor as its session terminal (prompt, tool calls, streamed reply, cursor) and stats, and adds the night light pool (amber when the bot needs you, red after an error). A click on a monitor calls `onOpen(uid, name)`. A host adapter, like `board.js`. |
| `public/toasts.js` | Toast list rules, no DOM (`globalThis.OfficeToasts`, tested in `test/toasts.test.mjs`): an error or a toast with an action stays, others close after 8 s, at most 4, the oldest timed toast goes first. `office.js` owns the timer. |
| `public/office.js` | React: the dock (strip), dialogs, the request bar of the terminal and room panels. Mounts `OfficeScene` once. |
| `public/format.js` | Display formats shared by the page and the server: money (`$0.00`, `<$0.01`), plurals, short folder paths. Plain script, tested in `test/format.test.mjs`. |
| `public/chat-extras.js` | Chat resize grips, the `/` list, theme mirror. It depends on DS class names (`.ao-hud-chat`, `.ao-input`). |

Add a new file only for a distinct job. Extend the file that owns the concern first.

## How data moves

- Hooks (HTTP or command) post to `/hook/http` or `/hook`. `PermissionRequest` is held until `/api/answer`, or until it times out (60 s for terminal sessions, 15 min for office sessions).
- `PostToolUse`, `UserPromptSubmit` and `Stop` can return queued office messages to the session.
- An office session is `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`. Messages and control requests go to stdin. `onStream()` reads stdout.
- Every state change calls `broadcast()`. The browser gets full snapshots over `/events`.
- Sessions are keyed by `uid`. `sid` is Claude's session id. `officeId` links hooks to a session the office opened (env `OFFICE_ID`).

- Room awareness: `office_room` describes the room of the calling session. `office_room_update` changes only that room's notes board (`persisted.notes[key]`, kept as `{ text, at, v, by? }`: `v` is the version counter, `by` is set when an agent wrote it) and one blackboard pin (`persisted.pins`). Each line an agent appends starts with the session name. A rewrite returns the old text in the reply. All of these rules live in `notes.mjs`; `server.mjs` only calls it and saves the maps.
- `POST /api/notes/save` takes `{ key, text, base, sent }`, where `base` is the version (`v`) the editor started from. `sent: true` means the editor typed on while a merged answer came back, so `notes.mjs` merges against the text the editor sent with version `base` (kept as `sent` on that remembered version), not against that version's board text. When the board moved on, `notes.mjs` merges three ways against the text of that version (kept in memory, last 12 versions per board; an older base falls back to the server text plus the user's new lines) and the answer is `{ ok, version, text, merged }`. The editor shows `text` when `merged` is true. There is no 409. A cleared board keeps its counter (`text: ''`, `at: 0`), so a version never comes back with other text. Over the 4000 character cap (also for a merge result) the answer is 413 and nothing changes.
- `office_room` lists the decor of a lab room under "What is in the room" from one list in `roomContents()` (server.mjs), next to the fixed lab-room parts and the street. The list is the same for every room, so the page does not report it. Keep it in step with `board.js`.

- Place rules live only in `place.mjs`. Room id = readable tail of the folder plus a hash of the whole normalized path, so look-alike folder names stay two rooms. Paths are normalized and lower-cased, so path case never makes a second building. A session outside git has building key `''` (name "Other folders") and notes key prefix `other`. `adoptNotes()` in `server.mjs` moves a note or pin saved under an old key (room id without hash) to the new key when its room is first seen.
- Session rules (status, tool calls, subagent links, the 60-call cap, errors, budget stops, interrupts) live only in `tracker.mjs`. Rules read the clock, ids and timers only through `now()`, `makeId()` and `setTimer()`. Their real defaults are at the top of `createTracker` and nowhere else. Never call `git` or `broadcast()` from the tracker: use `deps.locate` and `deps.onChange`. Test a rule in `test/tracker.test.mjs` with the fixtures in `test/fixtures/` (small stand-ins, shapes checked against a real recording; subagent `agent_id` payloads are not recorded yet; no paid call). The server keeps the parts that need a socket or a process: the permission and question holds (`holds`), `sendMessage`, `writeUser`, `control`, `taskkill`.
- Add a place field in `place.mjs` and read it from `s.place` in the page. Do not rebuild keys in `building.js`, `office.js` or `board.js`.

- Status words, task lines, tool names and kinds, to-do status and room figures live only in `public/vocab.js`. Do not write a second copy in `building.js`, `adapter.js`, `office.js`, `terminal.js`, `board.js` or `server.mjs`. The server computes room figures once per snapshot (`snapshot.figures`, keyed by notes key); the page reads them with `mount.figures(roomId)`.
- Waiting = a pending permission prompt or an open question (`isWaiting`). The `status` field alone does not count, and a subagent's tool call does not hide a request.
- A tool result settles one permission request: the oldest one with the same `callKey` (agent, tool and trimmed input). Never match on the short label from `describeTool`: it keeps only a basename or the start of a command.
- A permission request is rated against the session's root (`rootOf` in `tracker.mjs`): `worktree.root`, else `startDir` (the office's launch folder, or the first `cwd` a hook reported). Never against the live `cwd`: it follows the agent, so a `cd` would widen what is low risk.
- A failed turn shows as Error on every surface until Dismiss (`POST /api/dismiss`, `tracker.dismissError`) or the next turn starts (`tracker.startTurn`, or the `UserPromptSubmit` hook).

## Gotchas learned the hard way

- The dock (`.strip`) is measured by `office.js`, which sets `--strip-clear` on `<html>` (its height plus a gap). The DS chat, roster, Since you left card and the page panels use it as their bottom edge. Do not hard-code a bottom offset for them. `kit/check.py` counts custom properties that the page defines in its own CSS as known tokens, so `--strip-clear` has a default in `office.css`.
- `backdrop-filter` on `.strip` makes it the containing block of its fixed children, so the More popover is `position: absolute`, not fixed.
- One panel at a time: `office.js` adds `has-panel` to `#office` while the terminal, board or stats panel is open, and `office.css` hides `.ao-hud-right` (the DS chat and roster) then. Every such panel must show `RequestBar`, or an approval could hide behind the hidden chat.
- "Always allow" and the risk of a request come from `OfficeVocab.alwaysOffer / requests`. A question has no risk and no rule. A high-risk request never offers Always allow.
- Recent folders are kept by `place.mjs` (`addRecent`, `cleanRecent`): one form, no duplicates in any case or slash style. Do not compare folder strings by hand.
- Bot body color comes from `OfficeBuilding.colorOf(uid)` (the DS color of its shape) and is sent to the scene in the bot definition. Lists read the same value, so a bot looks the same everywhere.
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
- One scene shows one building, and each scene gets its own building adapter (`officeAdapter.mount(repo)`). `office.js` keeps it in `cur2.mount`; its React key is `'m' + mount.id`. The adapter holds the mirror, the layout and the bot names, so there is no global reset and no generation counter. The SSE stream and the latest snapshot belong to the store, not to the scene.
- The DS has no event that removes a floor or a room. `mount.stale()` is true when the scene shows a room that is gone, or was empty and now has rooms. `office.js` then fades the scene out and mounts a new adapter. Dialogs that need a room (`RoomDialog`, `StatsPanel`) take `mount` as a prop. `officeAdapter.session / lookup` look in the adapter that is attached now.
- Ctrl+K page commands are built from App state each render and handed to the palette in an effect (`pageActions`). Room tools (`board.open`) and session commands (terminal, changes, Stop turn, Go to) are built by `liveActions()` at that moment, so the rooms of the floor on screen are current. The DS calls `CommandPalette.actions` on every scene render, so `liveActions()` runs on each scene event; keep it cheap. Do not mutate a module array during render.
- Esc closes the top layer only. A dialog (`.ao-dialog`) or the palette (`.ao-cmdk`) takes it first; a DS Dialog is gone from the DOM before window bubble listeners run. So decide in the bubble phase with `OfficeBoard.escTaken(e)`, which records the layer state in window capture. Do not move the handler to capture: `chat-extras.js` stops Esc for the `/` list there.
- Needs you is `officeAdapter.requests(snap)`, not a sum of the DS inboxes (they list one building). The tab title count is the page's: the DS `Notifier` of the scene writes the shown building's count, so a MutationObserver on `<title>` writes the total last. Alerts for other buildings use a second `Notifier` and the DS `ao-alerts` setting.
- Since you left shows on the first scene of a page visit only (`sylScene` in `office.js` passes `sinceYouLeft={false}` to later scenes). Each new scene is seeded with the whole mirror, and the DS counts it again (DS request #35). Remove the guard when the DS fixes it.
- The notes editor takes focus when it shows and again when the camera lands (it checks `board.flying()` each frame). Its font is never under 16 px.
- The DS has no `room.remove` or `floor.remove`. The page rebuilds the scene (a new React key) when a shown room is gone.
- Two worktrees on one branch need `git worktree add --force`.
- Room boards are matched to rooms by order: the shown floor's lab rooms, left to right (`OfficeSceneHost` `host.rooms()`), against the chalkboards (4 x 2.5 planes). The engine rebuilds a floor when a bot joins or the theme changes. The host sees that (new bot list, floor, floor groups, theme tokens, or a lost anchor) and fires `onRebuild` before the frame draws; board.js and terminal.js rescan then, and still on a 1.5 s timer.
- Only `public/scene-host.js` reads the DS stage's floors, views and room geometry. A new scene decoration registers a frame (`host.frame`), a rebuild listener, and, if it can be clicked, a pick target (`host.register`). Do not add a pick Raycaster (one that turns the pointer into an action), pointer listeners or `canvas.style.cursor` writes in another file: two raycasts gave two actions for one click. Geometry raycasts that do not react to the pointer, like terminal.js placing the desk light, are fine. The building view is `host.inBuilding()` (no floor group is visible), not the Building button's `aria-pressed`.
- The scene fades out (`duration-base`) before any rebuild: another building, the city, a removed floor or room. Labels in the city sit on layer 1 so the bloom pass skips them.
- Extensions: `mcp_status`, `mcp_toggle`, `mcp_reconnect`, `reload_plugins` are control requests on the session's stdin; they work before the first prompt. Persistent changes use `claude mcp` and `claude plugin` with scope local or project only.
- A trackpad flick sends wheel events for about a second, some after the finger lifts. Scroll-out goes through `OfficeWheelGate`: events less than 140 ms apart are one gesture, and a gesture that changed a level changes no more. Do not count scroll-out wheel events by hand (`city.js` counts zoom-in pushes to enter, which is a different gesture). While the gate holds, `office.js` stops the wheel event so the DS camera feel does not clear the framing.
- Status words are ink with a colored dot (`::before`). A status color is not 4.5:1 as text in Day. `test/contrast.test.mjs` computes the pairs from `tokens.json` and fails on a rule that colors text with `--status-*`. The DS checker rejects custom properties that are not DS tokens, so write the value in the rule.
- The notes editor and the City label sit on light faces in every theme (bubble, chip). Their ink is the mix `board.js` uses, not `--ink` (light at night). The City label card is the `bg` color (the DS `K.tok` has no `chip` or `line`).
- The City's minimum zoom is Show all (`SHOW_ZOOM` times `s.D` over the fit distance), set every frame in `city.js`. Do not set `ctl.minZoom` to a constant.
- Reduced motion in the 3D scripts: `stage.rm` is read when the stage is made. City flies and zoom steps are instant, a building lifts at once, the door stays shut and shows a still ring (`d.ring` in `board.js`), terminal cursors are solid (`terminal.js`). The DS engine's own camera moves are the DS's.
- Start every program with `resolveExe(name)` from `git.mjs`, never a bare name. On Windows a bare name is looked up in the child's folder first, so a planted `git.exe` in a repo would run. The entry points also set `NoDefaultCurrentDirectoryInExePath`. `test/spawn-safety.test.mjs` scans the sources for bare names.
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
