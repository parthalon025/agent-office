# CLAUDE.md: Agent Office for Claude Code

A browser office for Claude Code sessions: bots at desks, a chat per bot, approvals, diffs, schedules. Node ES modules, no dependencies, Windows first.

## Where the rules are

- **Module rules** are in the header comment at the top of each file. Read it before you change the file. When you change a rule, change its header in the same commit. The Map below names the owner of each concern.
- **Cross-module behaviour** (hooks and holds, the Security room before a hold, providers, the snapshot, rooms, past sessions, access): `docs/development.md`, "How data moves".
- **Decisions** are in `docs/adr/`: read them before you change approvals, providers, Paperclip or the Security room. Terms are in `GLOSSARY.md` (it stays at the root, where the domain skills look for it).
- **Review rules** are in `CODING_STANDARDS.md`: read it when you review a change.
- **Paperclip routes** are checked against the pinned Paperclip release: `npm run paperclip:source`, `test/paperclip-contract.test.mjs`.
- **User docs**: `README.md` (short: what it is, how to start it, the five core jobs) and the sub-documents in `docs/`. Put detail in the matching sub-document and keep the README short. `test/static.test.mjs` checks every image (alt text and a caption sentence under it) and every relative link in them.

## UI rules (the DS is law for anything visual)

The UI is the Agent Office design system (DS x1.7.18). Read `docs/design-system/DS-README.md`, `Recipes.md` and `Reference.md` before you change the UI (`Concepts.md` explains the model), and follow the DS Rules and Definition of done.

- Use DS tokens for every color, size and duration. No literal colors. A theme (skin) is its tokens plus its `AgentOffice.MODES` and engine `LOOKS` entries: page code reads flags (`K.dark`, `K.caps`, `K.term`) and tokens, never compares a look or theme id with a string, and styles a theme only with a family selector (`[data-theme|="<family>"]`). `test/skin.test.mjs` runs the same checks for every theme of `tokens.json`; to add a theme, follow Recipes, "Add a theme". Use the DS icon set and DS components (`Button`, `Dialog`, `Select`, `TextInput`, `EmptyState`, ...). No emoji.
- Status text on a theme surface is `--status-*-text` (the dot is `--status-*`), on a bubble face `--status-*-on-bubble`. A raw `--status-*` is a fill or a dot, never text (`test/contrast.test.mjs`).
- Write copy in Simplified Technical English: short sentences, active voice, buttons say the result. No "Oops", "Sorry", exclamation marks, "please".
- Keep the `x` version prefix (page `x0.2`, DS `x1.7.18`) in titles.
- The DS lives in this repo and its owner may change it. DS changes go in `components/`, `kit/`, the tokens and the DS docs, with a Changelog row and the DS Definition of done. Page code still uses only DS APIs: no DOM patching of DS internals.
- Never move bots yourself. The scene changes only from adapter events.
- The page's own styles go in `public/office.css`. The DS sets its theme on `.ao-office`, and `chat-extras.js` mirrors it to `<html data-theme>`, so page UI reads tokens only.
- In-scene controls (the Security room screens) have no keyboard or screen reader path (ADR 0003, the exception line in the DS Definition of done). Do not add one.
- Every ask-first Confirm stays reachable at 400 px.
- Before you finish a UI change: `python kit/check.py public/index.html public/office.css public/page-core.js public/skills.js public/dialogs.js public/schedules.js public/extensions.js public/hq.js public/characters.js public/reception.js public/panels.js public/changes.js public/screens.js public/merge.js public/needs.js public/office.js public/adapter.js public/chat-extras.js public/city.js public/board.js public/terminal.js public/persona.js public/lobby.js public/cables.js public/desk.js public/wheel-gate.js public/vocab.js public/ask.js public/client.js public/screen-kit.js public/scene-host.js public/building.js public/format.js public/toasts.js public/wire.js public/security.js public/vocab-security.js public/vocab-layers.js public/vocab-persona.js components/bundle.css components/bundle.js kit/page.html`, run `npm run gate:jobs` once, then look at screenshots in Day, Night, Sublevel, Fluent and Fluent Dark at 1360, 1100 and 400 px.

## Commands

```
npm start            # server on 127.0.0.1:4317; prints and opens a one-time launch link (OFFICE_OPEN=0: print only). Again while it runs: a new link
npm run start:branch # server on the port of this checkout's branch (4330-4399); OFFICE_OPEN=0, so it only prints the link
npm test             # offline tests
npm run probe        # prove HTTP hooks on this Claude Code version (one tiny call); npm run probe -- <port> for an office on another port
npm run smoke        # end-to-end test with real Haiku sessions, a few cents; needs the office running; npm run smoke -- <port> for an office on another port
npm run gate:jobs    # core-jobs gate (#147): five jobs at 1360 and 400 px against the step limits in test/core-jobs.mjs; own office and headless browser, no paid call, about 2 minutes, not in CI
npm run check:merge  # the merge checklist: syntax, kit/check.py (CI list), npm test twice, test:junction, gate:jobs; about 5 minutes. Linux is CI's job
```

Stop the server by the pid that owns port 4317 (`netstat -ano | grep :4317`, then `taskkill //PID <pid> //F`). Never kill by image name: that would kill other Claude Code sessions.

Owner rules for final tests and clean-up:

- Final browser tests in a worktree run on that worktree's own port, from `npm run start:branch`. Never on 4317 (the owner's office) and never on a hand-picked port. `OFFICE_PORT=branch` is the same switch for any other start. The port comes from the branch name (a detached HEAD uses the worktree folder name) as a fixed sequence of 12 ports in 4330-4399 (`branch-port.mjs`). The office takes the first free port of the sequence and prints which one (and which were busy); it never leaves the sequence, and it stops and says so when an office of the same checkout holds any port of it or when no port is free. Its files carry the port it took (`files.mjs`): a branch that takes another port of its sequence than last time starts with the files of that port (empty notes, schedules and past sessions, a new agent token), and an outside session attached with the old `office-hooks-<port>.json` keeps posting to the old port. A test that starts an office picks a branch name whose whole sequence is free to hold, so another running office cannot fail it (#96). Stop it by the pid that owns its port, as above.
- When a branch is merged, remove its worktree and its branch. Close a finished office session.

## Layout

```
src/             server modules: server.mjs (HTTP adapter), office.mjs (the office), the libraries, providers/, integrations/
public/          the page (scripts, styles, index.html, vendor/)
components/ kit/ tokens.css tokens.json   the design system (DS)
assets/          pictures the DS uses
test/            offline tests, fixtures, the smoke and core-jobs scripts
docs/            user and developer documents; design-system/ the DS documents; adr/ decision records; releases.md
launch.ps1       starts a session in a terminal window (the server names it by path)
```

The repository root is the office folder (`files.mjs` `OFFICE_ROOT`, the one constant that knows the layout). Runtime files live there, never in `src/`: `.office-token*`, `office-hooks*.json`, `office-mcp*.json`, `state*.json`, `history*.json` and `.paperclip-runtime/` (all git-ignored). Every module that needs the folder imports `OFFICE_ROOT`; none walks up from its own file. A bare `x.mjs` in this file is `src/x.mjs`.

## Map

Add a new file only for a distinct job; extend the file that owns the concern first. A new file gets a header comment and a line here.

Server (`src/`):
- `server.mjs`: the HTTP adapter and start-up: port, tokens, the gate, body parsing, the response, the files written at `listen`.
- `office.mjs`: the office (`createOffice`): the route table and the glue that has no module yet (holds, tracker wiring, providers, open, reopen, fork, close, goals, past sessions, the snapshot).
- `office-core.mjs`: the office's interface to its adapters: `handle(request)`, route groups, static files.
- `hook-settings.mjs`: the hook and MCP settings an office hands to Claude Code.
- `admission.mjs`: the one ordered check before any session starts.
- `auth.mjs`: route groups, the request gate, tokens, launch codes, remote access, page files, owner-only writes.
- `files.mjs`: the office folder and the files of each port.
- `state.mjs`: the saved state as slices; the one writer of `state.json`.
- `tracker.mjs`: session rules: hooks and stream lines in, sessions and feed out.
- `holds.mjs`: the queue of requests held for the user.
- `security.mjs`: the Security room grid, enforcement words, the cost ledger.
- `risk.mjs`: the risk and Security room row of a tool call; what is inside a root.
- `trust.mjs`: earned-trust proposals from the user's answers (never applied by the office).
- `explain.mjs`: a one-line explanation of a held request by a local model.
- `git.mjs`: worktrees, floors, rooms, changes, pull requests; every git and gh run, hardened.
- `launch.mjs`: program start: `resolveExe`, helper cwd, process-tree kill.
- `branch-port.mjs`: the port sequence of a checkout for `OFFICE_PORT=branch`.
- `place.mjs`: where a session or worktree sits: building, floor, room id, notes key.
- `rooms.mjs`, `recent.mjs`: room names and records; recent folders.
- `campus.mjs`: buildings, layouts, room views, changes and merge, floor actions.
- `archetypes.mjs`: function floors: catalog, archetypes, detection, the building record.
- `changes.mjs`: pull requests as folders (paper flow).
- `notes.mjs`, `room-awareness.mjs`: the room notes board and pin (merge, injection scan); what an agent knows about its room.
- `skills.mjs`, `extensions.mjs`: skills an agent writes; `claude mcp` and `claude plugin` runs.
- `schedules.mjs`: the spend default, message templates, schedules.
- `manager.mjs`, `manager-employees.mjs`: goals into steps (model ladder, plan board); office Managers as Paperclip employees.
- `memory.mjs`: company memory (SQLite, keyword and vector search).
- `personas.mjs`, `rituals.mjs`, `orientation.mjs`: agent characters; rituals and the attention measure; the first-run walk.
- `startup.mjs`, `node-check.mjs`: the Start with Windows entry; the Node 24.11 check.
- `hook.mjs`, `mcp.mjs`, `post.mjs`, `payload.mjs`, `probe.mjs`: the command hook; the stdio MCP server; their one POST; the hook payload trim and call key; `npm run probe`.
- `vocab.mjs`: loads `OfficeVocab` for the server and the tests.

Paperclip (`src/`):
- `paperclip.mjs`: the HQ watcher, the supervision checks and the one writer (`hq.write`).
- `hq-model.mjs`: the pure HQ read model (org chart: floors by department going up by rank, a room per rank, reporting-line cables; lobby, costs, rooms, search), self-approval, the office adapter state.
- `hq-writes/`: the write kinds, one file each (grid row, requests, what Paperclip must answer, the ids returned, samples); `index.mjs` lists them in grid order with the grid rules and `planWrite`; `shared.mjs` their checks and limits.
- `paperclip-runtime.mjs`: the Paperclip the office installs, runs, updates or connects to; the board key.
- `paperclip-runs.mjs`, `integrations/paperclip-adapter/`: runs Paperclip hands to the office; the adapter plugin Paperclip loads.

Providers (`src/providers/`):
- `index.mjs`: the provider seam: contract, events, registry, traits, spend limits.
- `asks.mjs`: how a kind that holds its own requests asks the office and waits.
- `claude-code.mjs`: Claude Code (stream-json process, terminal window, hook answers) and the claude flag reader.
- `local.mjs`, `local-tools.mjs`: local models (Ollama, LM Studio), the one tool gate, the worktree-fenced tools.
- `acp.mjs`, `acp-rpc.mjs`, `acp-files.mjs`, `acp-policy.mjs`: the one ACP client: sessions, the wire, files and terminals, the permission policy.
- `copilot.mjs`, `openclaw.mjs`: what Copilot CLI and OpenClaw need beyond ACP; `src/integrations/openclaw-plugin/` is the plugin OpenClaw loads.
- `agent-framework.mjs` (+ `agent_framework_runner.py`), `cli-tools.mjs`: Agent Framework teams; Cursor CLI, Grok CLI and Pi.
- `cloud.mjs`, `foundry.mjs`, `copilot-studio.mjs`, `remote-tools.mjs`: the cloud kinds; Cursor cloud agents and a Hermes gateway.

Page (`public/`):
- `client.js`, `ask.js`, `wire.js`: the one module that knows the routes; the ask-first protocol; the `/events` wire format.
- `building.js`, `adapter.js`: the snapshot store and building adapter (also the HQ as a building you enter: `OfficeBuilding.HQ_KEY`, employees at desks, #226); the launch code, SSE and `window.officeAdapter`.
- `vocab.js`, `vocab-security.js`, `vocab-layers.js`, `vocab-persona.js`: `OfficeVocab`, the shared words and rules.
- `format.js`, `toasts.js`, `wheel-gate.js`: display formats; toast rules and placement; when scrolling out leaves a level.
- `scene-host.js`, `screen-kit.js`: the one reader of the DS stage (picks, focus, flights, pinned screens); the painted screen kit.
- `board.js`, `terminal.js`, `security.js`, `lobby.js`, `desk.js`, `persona.js`, `city.js`, `cables.js`: room boards, desk terminals, the Security room walls, the lobby, desk actions, bot cues, the city, the HQ reporting lines as cables.
- `page-core.js`, `dialogs.js`, `panels.js`: shared page helpers (`OfficePage`); session dialogs; room panels and pinned-screen parts.
- `skills.js`, `schedules.js`, `extensions.js`, `hq.js`, `characters.js`, `reception.js`, `changes.js`, `merge.js`, `screens.js`, `needs.js`: page features, one Module each on `OfficePage`.
- `office.js`, `chat-extras.js`: the React app (city, Ctrl+K, scene mount, dialog wiring; loads last); chat grips, the `/` list, the theme mirror.
- `index.html` (the load order), `office.css`, `vendor/` (React and fonts, byte for byte; `vendor/README.md`).

## One owner per rule

Read a rule from its owner; never write a second copy. Place rules: `place.mjs` (the page reads `s.place`). Session rules: `tracker.mjs`. Provider facts: `describe()` and `traitsOf` in `providers/index.mjs` (spend limits: `spendLimitFor`). Risk of a call: `risk.mjs`. Words, status, room figures, Always allow: `public/vocab.js`. Ask-first: `public/ask.js`. Routes: `public/client.js`. Paperclip writes: one write kind file in `src/hq-writes/` (listed in its `index.mjs`), sent by `hq.write`, which names no kind. Git and gh: `git.mjs`. Programs: `launch.mjs`. Folder compares: `recent.mjs`.

## Gotchas

- Tests scan source text, comments included: a bare program start (`test/spawn-safety.test.mjs`) anywhere in `src/` or `test/`, and a route string (`/api/`) in any `public/` file but `client.js` (`test/client.test.mjs`).
- Start every program with `resolveExe(name)` from `launch.mjs`, never a bare name (on Windows a bare name is looked up in the child's folder first), and name its `cwd` (the session folder, or `launch.helperCwd()` for a helper: an inherited folder stays busy on Windows). A program that runs in a room goes through the record in `git.mjs` (`git()` or `recorded()`), or a removal cannot wait for it.
- Write office files only after `listen` succeeds: a second copy on a busy port writes nothing. A new file goes into `officeFiles` (`files.mjs`, with the port in its name), is rated in `risk.mjs` for every port, and is written with `writeSecret` (owner-only) when it holds a token or user or agent text.
- HTTP hook failures are non-blocking, and command hooks exit 0 and stay silent on stdout unless they return real hook JSON: a stopped office never blocks Claude Code.
- Claude Code's default permission mode may be Auto, so no prompts appear. Tests that need a prompt pass `permissionMode: 'default'`.
- The local provider sends only `model`, `messages`, `tools`, `stream` and `stream_options` to `/chat/completions`. LM Studio runs MCP servers a request names, so another field or endpoint could run a tool past `riskOf` and the approval.
- The CSP (`auth.CSP`) allows no inline `<script>`, no `on...=` attribute, no `style="..."` or `setAttribute('style', ...)`, no `eval` or `new Function`, and no other site; never add `'unsafe-inline'`, `'unsafe-eval'` or a CDN. A new page script or style sheet is a file in `public/`, listed in `index.html`, `STATIC_FILES` (`office-core.mjs`), the `kit/check.py` list of CI and of this file.
- `public/vendor/**` is `-text` in `.gitattributes`: with `core.autocrlf`, a CRLF checkout breaks the SHA-256 pins. Change a vendored file only with the steps in `public/vendor/README.md`.
- The DS has no event that removes a floor or a room: rename a spare one (`floor.update`, `room.update`), or mount a new building adapter when `mount.stale()`.
- Never hide `.ao-hud-right` with `display: none` above 820 px; use `visibility: hidden; pointer-events: none`. The DS camera frames the scene from that column's left edge and does not measure again. Do not set the `.ao-office` height in CSS: it is `office.js` state (#55).
- A panel that hides the DS chat (`has-panel`) shows a way to the open requests (`NeedsButton`; the bezel count on a pinned screen), or an approval hides behind it. Only the page's one `Notifier` writes the tab title (the scene gets `notifier: false`).
- Only `public/scene-host.js` reads the DS stage, raycasts the pointer, listens to pointer events or sets the cursor: two picks gave two actions for one click.
- Tests: a route test runs the office in process (`startInProcess`, `test/fixtures/office-inproc.mjs`); a test that needs real HTTP starts a copy with `test/fixtures/office-server.mjs` (`copyOffice`, `startOnFreePort`), never with its own spawn, port or file list. A test that makes a temp folder removes it in `finally` or `after()`; `test/fixtures/temp-leaks.mjs` fails a process that leaves one.
- `cmd /c start "Office" ...` needs the quoted title: unquoted, `start` runs a program named Office.
- The Bash tool mangles backslashes and quotes in long heredocs. Write patch scripts with the Write tool.

## Safety rules

- The Security room rules decide before any hold, and a looser rule never applies without its painted Confirm (the route refuses it). The two Secrets rows never take Allow. Never show a rule as active when it is not (ADR 0001): a cell the office cannot enforce for an agent kind says "Not enforced" with the reason; an Ask the agent decides by itself, and a row where only some calls reach the office (Hermes: edit requests do, reads and its own skill and memory writes do not), say "Partly enforced" with the reason (`partly` of `enforcement()`). The rules apply only while the office runs; say so wherever enforcement is described.
- Nothing is answered for the user unless a cell the USER set says Allow or Deny. Every call cell of every agent kind is Ask by default, a low-risk read or edit inside a worktree included, in terminal and office sessions alike, and a default cell forces no prompt (review B1): Claude Code decides what it asks, as before the Security room, and only a cell the user set makes it ask or changes its permission mode. The one exception is the local model: its reads and edits in its folder never were requests (they ran at once in `src/providers/local.mjs`, also outside git), so its two inside cells default to Allow and show it on the wall. `~/.claude` and `~/.hermes` are always settings paths. An OpenClaw session starts only while its Gateway config loads the office plugin for this office (#77). (These defaults were built 2026-11-05; the owner may change them.)
- A gated provider holds every tool call until the user answers or a user-set cell answers it. Only a provider with `gated: false` skips the hold (owner decision, 2026-11-04, ADR 0001): it shows "Unsupervised" or "Partly supervised", is off until the user turns it on in the Security room, and runs only in a fresh worktree. A setting the office cannot enforce for an agent shows "Not enforced for this agent". ACP agents never get Always allow, and a high-risk request never offers it.
- Bind to 127.0.0.1, check the Host header and the Origin, and require the token of the route's group on every route except the page, its static files and `POST /launch` (which takes a one-time launch code). The agent token never opens `/api/*` or `/events`; the page token never opens `/hook*` or `/mcp/*`. A new route goes into one group (`auth.routeOf` and the route table). Never put the page token where an agent reads files (not in `GET /`, a file in this folder or a URL), never accept a token from a URL, and compare tokens and launch codes only with `auth.tokenEqual`.
- Never edit `~/.claude/settings.json` or `.credentials.json`. The office writes only: files in this folder; its files in `%LOCALAPPDATA%\AgentOffice` (the page file; the Paperclip data, board key and company memory of ADR 0010); the rooms of floors in `~/.agent-office/worktrees` (`OFFICE_ROOMS_DIR`); the per-project rule a user approves. Opening an agent also writes `branch.<agent branch>.officebase` into the repository's `.git/config` and makes the folder `<repo>.worktrees` and the worktrees in it (next to the repository, outside this folder). The key only places the room on a floor and is display-only: an agent can edit it and so choose the floor of its own room, and nothing else reads it.
- Pull requests, pushes and worktree removal happen only after an explicit click and a confirm dialog. The office never removes a worktree or branch by itself, with one exception: a fork that did not start (it ended before init, or its open threw) removes the worktree and branch that the same call made for it, which never held work (`failedFork` and the catch in `forkSession`). It goes through `git.discardNew`, which takes only the object `createWorktree` returned in this process, once, and does not force: a copy (a past record, a session's `worktree` field) is refused (`test/floors.test.mjs`).
- Extensions change only the local or project scope of a session's folder. User scope stays out of reach, also through `claude mcp` or `claude plugin` (owner decision, 2026-11-03).
- Paperclip runtime (ADR 0010, #193): the office installs only the pinned `paperclipai` (exact version, no install scripts, SHA-512 checked against npm's lock file) into `.paperclip-runtime`, never over a Paperclip that already answers on the port, never into or over `~/.paperclip`. It starts Paperclip only in login mode on 127.0.0.1 (a health answer in another mode stops it), with a scrubbed environment (no `PAPERCLIP_*`, `DATABASE_URL`, `HOST` or `PORT` of the owner) and its own instance, data folder and database port, and kills only a process it started or adopted by pid and start time. The board key and Paperclip's first-run secrets are written only with `writeSecret` and never reach a page, a feed line, a reason or an error. The first admin and the key approval are a person's steps: the office never makes an account.
- Paperclip HQ (ADR 0010, which supersedes ADR 0005 and 0007): off until the user installs or connects it; loopback only (127.0.0.1, no redirect followed); every Paperclip call goes through the office server, so the board key never reaches the browser. Every write goes through the one writer (`hq.write`) and its write grid cell (Confirm, Allow or Deny; a looser cell needs the painted Confirm; secrets never take Allow; every write leaves a feed line). An employee approves its own work only for the approval kinds the user turned on behind the painted Confirm; budget, hire, access and secrets stay with the user (`NEVER_SELF_APPROVED`), and a Deny in the write grid still wins. A hire is Supervised and always has a budget. Supervise in office needs the painted Confirm on the Agents screen (the route refuses it without `confirmed: true`), builds its PATCH from the agent as Paperclip has it at the click, never writes env, and shows the agent as Paperclip saved it after the PATCH. An agent shows Unsupervised until Paperclip's saved config carries all three settings; never show it as supervised from what the office sent. A flag or env key that lets a run approve its own calls or turns off hooks is never Supervised; one that loads what the office cannot read, a flag it does not know and another program than claude are Partly supervised (ADR 0001: never show Supervised while a call can skip the hold).
- Do not add dependencies without asking. The server runs on Node built-ins. The page loads nothing from another site: React and the fonts are vendored in `public/vendor` (owner decision on #27 M2), and the CSP allows scripts, style sheets and fonts from the office only.
- A remote image in agent text loads only after the user clicks it (DS RichText). `data:` and `blob:` are the only images that show at once.

## Not built

Remote access to another machine's office or for other users (remote access for the owner through Cloudflare Tunnel and Access is built, ADR 0008), terminal sessions taking chat input, non-Windows session launch.

## Agent skills

- Issue tracker: GitHub issues on parthalon025/agent-office (use `gh`). See `docs/agents/issue-tracker.md`.
- Triage labels: the five default roles as GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- Domain docs: single-context, one `GLOSSARY.md` and `docs/adr/` at the repo root, created when terms or decisions are settled. See `docs/agents/domain.md`.
