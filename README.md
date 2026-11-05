# Agent Office for Claude Code x0.1

[![CI](https://github.com/parthalon025/agent-office/actions/workflows/ci.yml/badge.svg)](https://github.com/parthalon025/agent-office/actions/workflows/ci.yml)

A 3D office that shows your Claude Code sessions as bots at desks, and lets you run them without a terminal. Open a session, talk to it in a chat, approve its steps, see what it changed, and close it, all from one browser tab.

It is built on the Agent Office design system (x1.6.8), which lives in this folder. The design system documents are in [DS-README.md](DS-README.md).

## What it does

- **City.** Every repository stands as a building in one city: a floor per branch, a pip per session, a beacon when a session needs you. Scroll to zoom toward the mouse, right-drag or Shift-drag to move sideways, drag to turn. Click a building, or zoom in on it, to fly in. Inside, zoom out past the widest view to go from floor to building to city: one scroll gesture leaves one level, with a short pause after each, and the building level needs three pushes. The City does not zoom out past Show all. The City panel has the Day, Night and Sublevel switch, the number of sessions by state across all buildings, a Search actions button (Ctrl+K works too), and a status dot for each session in each building row. New buildings rise, removed ones sink, floors grow and shrink, sessions pop in and out. Streets with lane marks, trees and street lights run between the lots (the lights glow at night), and birds circle over the city. The building view of the office gets the same street, trees and birds around its lot; the floor view, which is inside, gets none.
- **Reduced motion.** With the system setting on, City flies and zoom steps cut at once, the camera goes to a room screen and back at once, buildings do not lift, a door that an agent uses stays shut and shows a still ring, and terminal cursors do not blink.
- **Look, then open.** The screens of a room (the board, the notes board, the stats display and each desk monitor) take two clicks. The first click flies the camera up to the screen, so it fills most of the free part of the view and you can read it; a bot or a desk in front of it is cut away. Click it again to open it: the board overview, the notes editor, the room stats or the session terminal. The bar under the screen has the same two steps: Back to the room, and the screen's own action. Click another screen to look at that one. Esc, Back or a click on empty scene flies back. The door opens the agents dialog with one click.
- **Room boards.** The board on the back wall of each room is a live screen: the session's to-do list, the browser steps (Playwright page loads, clicks, key presses), the last tool calls, and the top folders of the repository with the ones the agents touched. Open it and a side panel shows the same in full, with the board framed beside it. The camera stays yours: turn, zoom and move, then press Esc or Back.
- **Notes board.** Next to it hangs a notes board for your own reminders. Open it and you write on the board itself. The notes editor takes focus when the camera arrives, and its text is never smaller than 16 px. Notes save as you type and stay per room (in `state.json`). Rooms have taller walls so the room name sits above the cable tray.
- **Desk monitors.** Each monitor shows its session as a terminal. Open it and the terminal panel shows the whole transcript beside the monitor. For a session in the office, the message box takes focus; a terminal session says to type in its own window.
- **Needs you.** One button in the control strip shows the number of requests that wait in every building. Its list shows each request, oldest first, with Approve, Decline and Go to (a question has Yes and No). With browser alerts on, a request or an error in any building alerts you while the page is hidden. The tab title shows the total, also in the city.
- **Keyboard path.** Ctrl+K opens the room tools (board, notes, stats, agents) of the floor on screen, both steps at once. The hint that shows when the pointer is over a screen, a display or the door names the next click and carries a Ctrl+K key chip. In the building view, pick the floor first with its Floor action in Ctrl+K. For each session, Ctrl+K opens its terminal and its changes, Stop turn, and Go to. Esc closes only the top layer: a dialog or the palette first, then the board.
- **Toasts.** A toast with an action, and every error, stays until you close it. The others close after 8 seconds, and wait while the pointer or the focus is on them.
- **Since you left.** When you open a building, the card counts what happened there since you last saw it. A building you come back to shows only the news. Requests that were open before do not show a toast again; they stay in Needs you and in Decisions.
- **Repos as buildings.** A git repository is a building, a branch is a floor and a worktree is a room. Pick the building in the control strip; one **Needs you** button shows how many requests wait in every building. Folders outside git share the "Other folders" building.
- **Floors and rooms.** The Floors dialog creates a floor (a new branch with its first worktree), adds a room (one more worktree on a branch, also on a branch that has one), removes a room and deletes a floor (its worktrees and the branch). You can name a room when you add it: the name is the worktree folder name (letters, digits, dots and dashes; Windows reserved names are refused). **Clean up unused floors** lists the floors that are merged into the main branch, have clean rooms, no session and are over an hour old (never the default branch). Press Keep this floor to leave one out, then confirm to delete the rest. It never forces. Removing a room also deletes the files git ignores in it, such as a local `.env`; the confirm dialogs say so. Git refusals (uncommitted changes, commits that are not merged) show with a button to go ahead anyway. The main folder and a room with an open session cannot be removed. A floor cannot be deleted while an agent room sits on it: remove the agent rooms first. The branch of a removed agent room stays in git and is not offered as a floor.
- **Extensions.** The Extensions button (More > Actions for the selected bot, or Ctrl+K) lists the session's connectors (MCP servers) and plugins. Turn a connector off or on for this session, reconnect it, add one (a URL or a command) or remove one. Turn a plugin off or on for this folder, install or remove one. Saved changes go to the local or project scope of the folder, never to your user settings.
- **Sessions as bots.** Each agent gets its own room: Open session makes a new worktree (branch `agent/<name>-<id>`, folder `<repo>.worktrees/<name>` next to the repository) unless you tick **Use this folder**. The room sits on the floor of the branch it was made from, and its sign shows the worktree branch. When two or more agents share a room (terminal sessions in one folder, or **Use this folder**), the sign says "N agents". Subagents are helpers in their parent's room and do not count. Typing means working, an amber badge means it needs you, and a red badge means the turn failed (Retry or Dismiss).
- **Subagents as helpers.** A Task or Agent call brings a grey helper by the elevator. The helper does its own tool calls and leaves when it returns its result.
- **Trace every step.** Select a bot and open Trace: the plan from TodoWrite with each step's state, every tool call with its argument, time and failure, skills loaded, pages read, and the schedule that started the run.
- **No terminal needed.** A session can run inside the office. You chat with it, and its replies appear as they are written.
- **Approve from the office.** Permission prompts become Approve and Decline cards that show the edit or command. One click can also allow it from now on.
- **Pick the permissions in the Security room.** The ground floor of each building has a Security room with six wall screens: Files, Commands, Network, Secrets, Agents and Spend. Each screen has one row per kind of tool call and one column per agent kind (Claude Code, Hermes, dsh, OpenClaw, local model). Click a screen to look at it, then click a cell: Ask, Allow, Deny. Allow makes the cell amber with a Confirm on the wall; Ask and Deny apply at once. Secret files and settings files that run code offer only Ask or Deny. The rules are for all buildings, or for this building only. The office answers Allow and Deny at once and writes a line in the activity feed; Ask waits for you as before. By default reads and edits inside the worktree are Allow and the rest is Ask. Inside the worktree means a git worktree: a session that started in a folder outside git, in your home folder or at a drive root has no worktree, so its reads and edits are Ask. Files that run code at sign-in or in every shell (the Startup folder, PowerShell and shell profiles) and the office's own `state.json` and `history.json` count as settings files that run code. Ctrl+K **Permissions** goes there. A cell the office cannot enforce for an agent says "Not enforced" and why. "Partly enforced" marks an Ask that Claude Code decides by itself: for outside files, shell commands, web and MCP calls, Claude Code asks only when its own allow rules and permission mode say so, and the office holds what it asks. For secret files, settings files and reads or edits inside the worktree, the office makes Claude Code ask. On the Spend screen, minus stops at $1; No limit (type 0) needs the Confirm on the wall. The rules work only while the office runs: when it is stopped, Claude Code decides alone, and a Deny does not apply. The screens take pointer clicks only: they have no keyboard path.
- **Control a live session.** Stop the current turn, switch model or permissions, attach images and text files, and run slash commands and skills (type `/` in the chat).
- **See the work.** A Changes view shows the branch, the files and a colored diff. A session runs in its own git worktree by default, so your main branch stays clean, and you can open a pull request from the office.
- **Come back later.** Closed sessions are saved. Reopen one and Claude continues with its context. Search every past session.
- **Run things on a schedule.** Save prompts as templates. Schedule a prompt daily or every N minutes.
- **Weekly limit.** The meter shows the real 7-day plan usage and its reset time when your status line command saves Claude Code's `rate_limits` to `~/.claude/rate_limits_state.json` (or the file in `OFFICE_RATE_FILE`). Without that file the meter stays hidden.
- **Keep an eye on cost.** The control strip shows tokens, cost and the cache hit rate of a session that runs in the office, and its context fill. A session can have a spend limit.
- **Ask the user.** Claude can call an `office_ask` tool to ask you a question and wait for your answer.
- **Room awareness.** Claude can read its room (`office_room`): the place, the other sessions, the notes board, the pin and what is in the room. When you ask, it can add to the notes board or pin a short message on the blackboard (`office_room_update`). It puts its session name in front of each line it adds. It cannot move furniture or bots.

## Requirements

- Windows 11. Opening and closing sessions is written for Windows.
- Node.js 22 or newer. `npm test` passes a quoted glob to `node --test`, which Node reads only from version 21 on.
- Claude Code 2.1.295 or newer, already signed in. The office uses your existing login. It was tested on 2.1.317.
- Git for worktrees and the Changes view. The GitHub CLI (`gh`) for pull requests.

There is nothing to install. The server has no dependencies. The page needs no internet access: React and the fonts come with the office (`public/vendor`, with their versions and licenses in `public/vendor/README.md`).

## Start it

```
cd E:\agent-office
npm start
```

The office opens in your browser with a launch link (`http://127.0.0.1:4317/#n=...`). The server also prints the link. The link works once, for 5 minutes. After that, a reload or a bookmark of http://127.0.0.1:4317 keeps working until the office or the browser stops. For a new link, run `npm start` again: a second copy changes nothing and opens a new link for the office that runs. Then choose **Open session**.

1. Pick a folder.
2. Leave **Runs** on "In the office (no terminal)".
3. Optional: tick **Use this folder** (the default is a new worktree, a room of its own), choose a model, a spend limit, and a first instruction.
4. Click a bot, then use its chat. Type `/` for commands and skills.

The dock at the bottom holds Open session, the building picker, City (or Go inside), Floors, Sessions, Past, a **More** control (Schedules, Attach sessions, Compact) and **Search actions** (Ctrl+K). When a bot is selected, the dock adds a row with its name, its context use and Stop turn (office sessions). More then lists Actions for that bot: Open terminal, Changes, Extensions, a quiet Always allow (never for a high-risk request), its cost, and for office sessions the model and the permissions. At laptop and phone widths the chat, the roster and the Since you left card stop above the dock, so the message box and Send stay clear.

Only one panel takes the right column at a time. While the terminal, the board or the stats panel is open, the chat is hidden. Each of those panels shows the requests of its sessions with Approve and Decline (Yes and No for a question), so you can answer without the chat.

**Open session** starts in the building you are looking at and offers your recent folders as one-click buttons. **Past sessions** and **Schedules** ask before they forget a session or delete a schedule. **All sessions** shows the folder, the state and a Go to button for each session.

### Sessions you start yourself

Start Claude Code with the office settings so the office can see it:

```
claude --settings "E:\agent-office\office-hooks-http.json" --mcp-config "E:\agent-office\office-mcp.json"
```

The **Attach sessions** dialog (under More) shows the exact command for the active hook mode, with Copy buttons. A terminal session reports its activity and asks permission through the office, but you answer its chat in the terminal. Stop turn, mode and model switches, attachments and the command list work only in sessions that run inside the office.

## Core jobs

Each job names the control to use. Ctrl+K finds all of them.

1. **Start the office.** Run `npm start`. The office opens in your browser with its launch link. The city has no buildings until a session exists, so open one (job 2).
2. **Open a session.** Click **Open session**, pick a folder and start it. The folder becomes a building, its branch a floor and its worktree a room. The bot sits at a desk in that room. Click the bot to open its chat.
3. **Approve a request.** A bot that needs you shows an amber badge, and the **Needs you** button in the dock shows a count. Open the list, read the request, then click Approve or Decline. A question has Yes and No. The office holds a request from a terminal session for 60 seconds, then the terminal dialog decides. A session in the office waits 15 minutes.
4. **Read a room board and its notes.** The blackboard, the notes board, the stats display and each desk monitor take two clicks. The first click flies the camera to the screen, so you can read it. The second click, or the button that appears with it, opens the panel (Open the overview, Write notes, Show room stats, Open terminal). On the notes board you can then type. Notes save as you type and stay with the room. Press Esc or click Back to fly out again. The door opens the Agents dialog at once.
5. **Schedule a prompt.** Open **More**, then **Schedules**, then **Add a schedule**. Give it a name, a folder and an instruction. Run it every N minutes (5 or more) or daily at a time. A schedule opens an office session on its own. A daily slot that the office misses by more than 10 minutes is skipped. **Run now** starts one run at once and does not change the times.
6. **Make a floor or a room.** Open **Floors**. Create a floor to make a new branch with its first worktree. Add a room to put one more worktree on a branch. Remove a room or delete a floor in the same dialog. If git refuses, the dialog says why and offers a button to go ahead anyway. The main folder cannot be removed.
7. **Manage extensions.** Select a bot, open **More**, then **Extensions** (or use Ctrl+K). Turn connectors and plugins off or on, add them or remove them. Changes go to the local or project scope of the folder, never to your user settings. Only office sessions can turn connectors on and off.
8. **Review the changes.** Select a bot, open **More**, then **Changes**. The same button is in **Past** for a closed session. Read the diff before you keep the work.
9. **Stop or reopen.** Select a bot. **Stop turn** is in the dock row next to its name. It ends the turn that runs now, and it is for office sessions only. A closed session moves to **Past**. Click **Past** in the dock, then click **Reopen** to bring a session back or **Forget** to remove it with its history. A Claude Code session resumes with its replies, cost and turns, and leaves **Past**. A local agent cannot resume: **Reopen** starts a new session in the same folder with the same model, and the old record stays in **Past**.

### Local model agents

Two more agent kinds are built: **Ollama** and **LM Studio**. They run a model on this PC at a desk, in a worktree or a folder. Most jobs above work for them. These parts differ:

- **Start one.** In **Open session** (or a room's **Add an agent**), set **Agent** to Ollama or LM Studio and pick a model from the list the server gives. A local agent runs in the office only and has no spend limit or permission mode, so the dialog does not show those fields. A kind that is not ready says what it needs, and **Check again** asks once more. **More**, then **Agent kinds**, lists every kind, whether it is ready, what it needs and its models. Each bot, the Sessions list, Past sessions, the room's agent list and the terminal name the kind. Schedules start Claude Code only.
- **Start one with the API.** Send `POST /api/open` with the header `x-office-token` and a JSON body with `cwd`, `provider` (`ollama` or `lmstudio`), `model` and an optional first `prompt`. `model` is required. The value for the header is the page token, not the value in `.office-token` (that is the agent token, and `/api/*` answers 401 to it). Read the page token from the `token` field of `%LOCALAPPDATA%\AgentOffice\office-page-<port>.json` (`<port>` is 4317 by default). The office writes a new token at each start. To send a later prompt, use `POST /api/message` with `{ "uid": ..., "text": ... }`; `/api/open` returns the `uid`. `GET /api/providers` lists each agent kind, whether it is ready, what it still needs and its models. Opening a session works on Windows only.
- **Tools.** The agent reads, lists, searches, edits, writes and runs commands, all inside its folder. It can also use the office tools (inbox, ask, room, room notes). One turn stops after 25 model calls.
- **Approve a request (job 3).** The cards are the same, with the same risk rule. A local agent never offers Always allow.
- **Cost.** The cost is always $0. The office counts tokens.
- **Not available.** A local agent has no model or permission switch and no Extensions (the dock does not show them, and the API refuses them), and it takes text only (no attachments). Schedules start Claude Code.
- **Reopen (job 9).** It starts a new session and cannot resume.

The office only lists models and sends chat requests to the server. It never loads, unloads or downloads a model. See **Settings** for the server addresses.

## How it works

```
Claude Code ──hooks (HTTP or command)──▶ server.mjs ──SSE──▶ browser (adapter.js ▶ Agent Office DS)
     ▲  ▲                                   │  │
     │  └── stdin: messages, control ───────┘  └── REST: open, close, answer, message, history ...
     └───── MCP (mcp.mjs): office_inbox, office_ask, office_room, office_room_update
```

- **Hooks** report prompts, tool calls (with their id and time), failed tool calls, subagent start and stop, and stops. `payload.mjs` trims each payload the same way for command and HTTP hooks; tool output never leaves the session. A `PermissionRequest` hook holds the prompt until you answer in the office.
- **Sessions in the office** run `claude -p` in stream-json mode with a pipe. Messages go in on stdin, replies and control requests come out on stdout.
- **MCP** gives a session four tools: read messages the user sent from the office, ask the user a question, describe its room (`office_room`), and change the room's notes board or blackboard pin when the user asks (`office_room_update`).
- **The adapter** (`public/building.js`, loaded by `public/adapter.js`) turns the server's session snapshots into design system events. A snapshot store holds the latest snapshot, and each mounted building has its own adapter.

### Hook modes

The office uses **HTTP hooks** when they were proven on your Claude Code version, which makes each event about 60 times faster than starting Node. Otherwise it uses **command hooks**. Run `npm run probe` after a Claude Code update to test HTTP hooks again. A stopped office never blocks Claude, because HTTP hook failures are non-blocking and command hooks always exit 0.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `OFFICE_PORT` | `4317` | Port on 127.0.0.1. `branch` takes a fixed port from the current branch name (4330-4399), so each worktree has its own; `npm run start:branch` sets it. If that port is busy, the office stops and does not try another. An office on a port other than 4317 has its own files, with the port in the name (see Files), so it never takes over the hooks, notes or schedules of the office on 4317 in the same folder. |
| `OFFICE_OPEN` | on | `0` stops the server from opening the launch link in your browser. It still prints the link. |
| `OFFICE_HOOKS` | auto | `command` or `http` forces a hook mode. |
| `OFFICE_ASK_TIMEOUT_S` | `60` | How long a terminal session's permission prompt waits for the office before the terminal dialog decides. Sessions in the office wait 15 minutes. |
| `OFFICE_OLLAMA_URL` | `http://127.0.0.1:11434/v1` | Where the Ollama agents find their server. Loopback addresses only (127.0.0.1, localhost, ::1). Any other host stops the office at start. |
| `OFFICE_LMSTUDIO_URL` | `http://127.0.0.1:1234/v1` | The same for LM Studio agents. The office only lists models and sends chat requests. It never loads or unloads a model. |

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | The server: state, hooks, sessions, REST, SSE, schedules, history. |
| `auth.mjs` | Access rules: the agent token and the page token, the launch code, the request checks, files that only you, SYSTEM and Administrators can read. |
| `files.mjs` | The names of the files an office keeps in this folder, per port. |
| `git.mjs` | Worktrees, the changes view, remove worktree, pull request. |
| `tracker.mjs` | The session rules: hook payloads and stream lines in, sessions out. No I/O of its own, so tests run offline. |
| `place.mjs` | Where a session or worktree sits: building, floor, room id and notes key. The snapshot carries it. |
| `notes.mjs` | The notes board of a room: the user's save with a base version, agent appends, the pin, and a three-way merge so an agent's line and the user's edit both stay. |
| `hook.mjs` | Command hook. Sends one event to the server. |
| `mcp.mjs` | MCP server with `office_inbox`, `office_ask`, `office_room` and `office_room_update`. |
| `launch.ps1` | Starts a session in a terminal window. |
| `startup.mjs` | Adds or removes the Start with Windows entry (a .cmd in your Startup folder). At sign-in the office starts and opens its launch link. |
| `probe.mjs` | Tests HTTP hooks on this Claude Code version. |
| `public/` | The page: `vocab.js` (shared status words, tool names and room figures), `wheel-gate.js` (one scroll-out gesture leaves one level), `scene-host.js` (the one reader of the 3D stage: floor, view, rooms, pick, cursor), `building.js` (snapshot store and building adapter), `toasts.js` (toast rules), `adapter.js`, `office.js`, `office.css`, `chat-extras.js`, `index.html`. `vendor/` holds React 18.3.1 and the fonts, byte for byte as published (`vendor/README.md`: sources, SHA-256, how to update). |
| `test/*.test.mjs` | Offline unit tests (`npm test`): access rules (with a real server on a free port), vendored files and the static file list (also on a real server), click-to-load chat images in the design system, place rules, risk classifier, session vocabulary, hook payload, session tracker, scene host, notes merge, snapshot store and building adapter, contrast pairs, wheel gate, toast rules. |
| `test/tracker.test.mjs` | Session tracker tests from recorded-shape hook payloads and stream lines in `test/fixtures/`. |
| `test/smoke.mjs` | End-to-end test against real Claude Code. |
| `DS-README.md`, `Recipes.md`, `Reference.md`, `Concepts.md`, `kit/`, `components/`, `tokens.css` | The Agent Office design system. |

Generated at run time and ignored by git: `.office-token`, `office-hooks.json`, `office-hooks-http.json`, `office-mcp.json`, `state.json`, `history.json`. Outside this folder: `%LOCALAPPDATA%\AgentOffice\office-page-<port>.json`.

An office on a port other than 4317 (`OFFICE_PORT`, `npm run start:branch`) writes the same files with its port in the name, for example `.office-token-4392`, `office-hooks-4392.json`, `office-hooks-http-4392.json`, `office-mcp-4392.json`, `state-4392.json` and `history-4392.json`. Its settings files call `hook.mjs` and `mcp.mjs` with the port, so a session attached to it talks to it, and a session attached to the office on 4317 keeps talking to 4317. That office starts with its own empty notes, schedules and past sessions. An office on another port that ran here before this change keeps its agent token, so settings files it made still work. Its old notes and schedules stay in `state.json`. To probe the HTTP hooks of that office, run `npm run probe -- <port>`.

## Safety

- The server listens on 127.0.0.1 only and rejects other host names.
- Two tokens keep agents and you apart. The **agent token** opens only the routes that hooks and the MCP server use (`/hook`, `/mcp/...`). It is kept in `.office-token` and in the HTTP hooks file, and reused across restarts, so running sessions keep working. The **page token** opens only the page's routes (`/events`, `/api/...`): answers, sessions, extensions, schedules. Neither token opens the other routes.
- The page token is new at each start and is never in this folder, so an agent that reads files here cannot approve its own requests. The page itself holds no token: the launch link carries a one-time code, and the page trades it for a cookie that page scripts cannot read. Your own tools (`npm run probe`, `npm run smoke`, a second `npm start`) read the page token from `%LOCALAPPDATA%\AgentOffice\office-page-<port>.json`.
- Only your Windows user, SYSTEM and the Administrators group can read the files with a token and the settings files whose commands sessions run. Other users, and groups such as Users, Authenticated Users and Everyone, cannot. SYSTEM and Administrators keep access because they can take ownership of any file anyway, and backup and antivirus need it. If the office cannot set that, it prints a warning when it starts. The office folder itself keeps the permissions of its drive; on a shared computer, keep it in your user folder.
- Requests from another site or another port of this computer are refused, and every change must be sent as JSON. No page can show the office in a frame.
- The page loads its scripts, style sheets and fonts from the office only. Nothing comes from a CDN or a font service. Its content security policy refuses scripts, style sheets and fonts from any other place, and inline scripts.
- An image from another site in an agent's reply shows as a card with a **Load image from** button and the site name. Nothing goes to that site until you click; point at the button to see the full address first. The click loads that one image until you reload the page, and the request does not send the office address. Images that are part of the message itself (`data:`) show at once.
- The office sends hook data to your own machine only. Hooks forward short fields: the tool name, a path or command, and the prompt. A permission prompt also carries the full input so the card can show the change.
- "Always allow" writes the rule Claude suggests to that project's `.claude/settings.local.json`, and only when you click it.
- Creating a pull request runs `git push` and `gh pr create`. The office asks you to confirm and lists the steps first.
- The office never edits `~/.claude/settings.json` or your credentials.
- Saved sessions (`history.json`) contain Claude's replies, and `state.json` keeps schedule prompts and room notes. They stay on this machine, and only your Windows user, SYSTEM and Administrators can read them (set when the office starts).
- Remote access is not supported. Reaching an agent that can run commands needs real login and encryption. If you want it from a phone, put the office behind Tailscale.

## Troubleshooting

The office knows three kinds of session. A session **in the office** runs `claude -p` with a pipe. A **terminal session** is one you start yourself with the office settings. A **local agent** runs a model on this PC through Ollama or LM Studio. Find your kind below.

### Any session

- **"Already running on port 4317."** A second `npm start` is harmless: it changes nothing, and it opens a new launch link for the office that runs. To restart, stop the first copy by the process id that owns the port. Never stop it by image name: that would stop your other Claude Code sessions. Run `netstat -ano | findstr :4317`, then `taskkill /PID <pid> /F`. Or start a second office on another port with `OFFICE_PORT`. It has its own files and sessions (see Files), and it leaves the first office as it is.
- **The page says "No access to the office".** The page has no working cookie: you opened it without a launch link, the link was used or older than 5 minutes, or the office restarted (each start makes a new page token). Run `npm start` to get a new link. Other office tabs in the same browser get access again within 5 seconds.
- **A call answers 401 Unauthorized.** The token did not match. For the page, open a new launch link (see above). For hooks: if you deleted `.office-token`, the office made a new agent token. Sessions that started before that keep the old token in their settings, so start them again.
- **A call answers 403 Forbidden.** The server accepts only `127.0.0.1:<port>` and `localhost:<port>` as host name, and refuses requests that a page on another site or port sends. Open the office with its launch link.
- **A call answers 415.** The office takes changes as JSON only (`content-type: application/json`).
- **"WARNING: Could not limit ... to your Windows user."** The office could not set or check who can read that file. The text in brackets gives the reason: `icacls` failed (for example on a drive without permissions, such as FAT32 or exFAT), Windows PowerShell could not read the permissions back, or an entry is still on the file (for example "inheritance is on" or "Allow entry for S-1-5-32-545", which is the Users group). The office still runs. Other users of this computer may read that file. Run `icacls <file>` to see who can.
- **No Approve cards.** Your Claude Code default mode may be Auto, which rarely asks. Choose Default or Plan under Permissions when you open the session.
- **The scene stays empty or black.** The scene is 3D and needs WebGL. Turn on hardware acceleration in the browser. The page loads every file from the office. If the browser console shows a 404 for a `/vendor/` file, the `public/vendor` folder is not complete: get it again from git.
- **Remove worktree is refused.** Close the session first: the button stays off until it ends. If the room has uncommitted changes, the dialog says so and offers Remove and discard changes. In the Floors dialog, git refuses uncommitted changes and commits that are not merged in the same way, and the dialog offers to go ahead anyway. The main folder cannot be removed.

### Sessions in the office

- **A session stops at start.** The bot's chat shows Claude Code's error. The usual cause is a signed-out login. Sign in with Claude Code, then open the session again.
- **The `/` list is empty.** Claude reports its commands after the first message. The office reuses the last known list until then.
- **A turn failed.** The bot shows a red badge until you click Retry or Dismiss.

### Local agents

- **The office stops at start with "A local model provider talks to this machine only."** The address in `OFFICE_OLLAMA_URL` or `OFFICE_LMSTUDIO_URL` is not on this PC. Use `127.0.0.1`, `localhost` or `::1`, or remove the variable.
- **`GET /api/providers` says the kind is not ready.** The office could not list models in 3 seconds, or the list is empty. For Ollama, start it and run `ollama pull <model>`. For LM Studio, start the local server (Developer tab) and load a chat model. Check that the address matches the server.
- **A turn fails with "API Error: fetch failed" (or another connection error).** The server is not reachable at the address. Start it, or set the right address, then send the message again.
- **A turn fails with "API Error: Ollama answered 404" or "LM Studio answered 404".** The server does not know the model. The text after the colon is the server's own message. Use an id from the list in `/api/providers`. The list leaves out models whose id contains `embed` or `rerank`.
- **A turn fails with "API Error: ... answered 400" and the server message says the model does not support tools.** The agent needs tool calling. Pick a model that supports tool calling.
- **A turn fails with "Ollama stopped answering."** The server sent no data for 2 minutes. Check that the model is loaded and that the PC has enough memory.
- **A turn fails with "The model used all 25 steps of one turn."** Send a smaller task.
- **"Pick a model for this agent."** The open call has no `model`.
- **"Local agents take text only."** Remove the attachment.

### Terminal sessions

- **A session does not appear.** Start Claude Code with the `--settings` and `--mcp-config` flags shown above. The Attach sessions dialog shows the exact command for the hook mode in use.
- **Hooks do not arrive.** Check that the office runs and that the settings file matches the hook mode (`office-hooks-http.json` or `office-hooks.json`). An office on a port other than 4317 has its own settings files with the port in the name (`office-hooks-http-<port>.json`); the Attach sessions dialog shows the right one. Run `npm run probe` after a Claude Code update to test HTTP hooks again. A stopped office never blocks Claude, and it shows no error in the terminal.
- **A message sits queued.** A terminal session at an idle prompt reads it when it next runs.
- **A request disappears from the office after 60 seconds.** This is the wait limit for terminal sessions. Change it with `OFFICE_ASK_TIMEOUT_S`, or answer in the terminal.
- **Stop turn, mode and model switches and attachments do nothing.** They work only in sessions in the office.

## Tests

```
npm run probe   # HTTP hooks on this Claude Code version (one tiny call)
npm run smoke   # opens real Haiku sessions in a throwaway repo (a few cents); the office must be running; npm run smoke -- <port> for an office on another port
python kit/check.py public/index.html public/office.css public/office.js public/adapter.js public/chat-extras.js public/city.js public/board.js public/terminal.js public/wheel-gate.js public/vocab.js public/scene-host.js public/building.js public/format.js public/toasts.js public/wire.js components/bundle.css components/bundle.js kit/page.html
```

## Limits

- Windows only for opening and closing sessions.
- Replies appear as whole messages in the chat. The live text shows in the bot's speech bubble.
- Only images and text files can be attached.
- A permission rule offered for "always allow" depends on the tool. Claude offers a mode switch for edits instead of a rule.
- The office keeps the last 60 sessions.
- The design system has no event that removes a floor or a room, so the office rebuilds the scene when one goes. Chats and the trace refill from the server; bubbles and walks in progress stop.
- Only office sessions can turn connectors on and off. A terminal session uses /mcp.
- The weekly limit needs the status line file (see above). The meter's per-bot rows stay hidden: a session's share of the plan is not known.
