# Agent Office for Claude Code x0.1

A 3D office that shows your Claude Code sessions as bots at desks, and lets you run them without a terminal. Open a session, talk to it in a chat, approve its steps, see what it changed, and close it, all from one browser tab.

It is built on the Agent Office design system (x1.5), which lives in this folder. The design system documents are in [DS-README.md](DS-README.md).

## What it does

- **City.** Every repository stands as a building in one city: a floor per branch, a pip per session, a beacon when a session needs you. Scroll to zoom toward the mouse, right-drag or Shift-drag to move sideways, drag to turn. Click a building, or zoom in on it, to fly in; inside, zoom out past the widest view to go from floor to building to city. New buildings rise, removed ones sink, floors grow and shrink, sessions pop in and out. Streets with lane marks, trees and street lights run between the lots (the lights glow at night), and birds circle over the city. The building view of the office gets the same street, trees and birds around its lot; the floor view, which is inside, gets none.
- **Room boards.** The board on the back wall of each room is a live screen: the session's to-do list, the browser steps (Playwright page loads, clicks, key presses), the last tool calls, and the top folders of the repository with the ones the agents touched. Click it and the camera flies up to it; a side panel shows the same in full. The camera stays yours: turn, zoom and move, then press Esc or Back.
- **Notes board.** Next to it hangs a notes board for your own reminders. Click it, the camera flies to it, and you write on the board itself. Notes save as you type and stay per room (in `state.json`). Rooms have taller walls so the room name sits above the cable tray.
- **Repos as buildings.** A git repository is a building, a branch is a floor and a worktree is a room. Pick the building in the control strip; a button there shows requests that wait in another building. Folders outside git share the "Other folders" building.
- **Floors and rooms.** The Floors dialog creates a floor (a new branch with its first worktree), adds a room (one more worktree on a branch, also on a branch that has one), removes a room and deletes a floor (its worktrees and the branch). Git refusals (uncommitted changes, commits that are not merged) show with a button to go ahead anyway. The main folder and a room with an open session cannot be removed.
- **Extensions.** The Extensions button in the chat header lists the session's connectors (MCP servers) and plugins. Turn a connector off or on for this session, reconnect it, add one (a URL or a command) or remove one. Turn a plugin off or on for this folder, install or remove one. Saved changes go to the local or project scope of the folder, never to your user settings.
- **Sessions as bots.** Each session sits at a desk in the room of its worktree. Typing means working, an amber badge means it needs you, and a red badge means the turn failed (Retry or Dismiss).
- **Subagents as helpers.** A Task or Agent call brings a grey helper by the elevator. The helper does its own tool calls and leaves when it returns its result.
- **Trace every step.** Select a bot and open Trace: the plan from TodoWrite with each step's state, every tool call with its argument, time and failure, skills loaded, pages read, and the schedule that started the run.
- **No terminal needed.** A session can run inside the office. You chat with it, and its replies appear as they are written.
- **Approve from the office.** Permission prompts become Approve and Decline cards that show the edit or command. One click can also allow it from now on.
- **Control a live session.** Stop the current turn, switch model or permissions, attach images and text files, and run slash commands and skills (type `/` in the chat).
- **See the work.** A Changes view shows the branch, the files and a colored diff. A session can run in its own git worktree, so your main branch stays clean, and you can open a pull request from the office.
- **Come back later.** Closed sessions are saved. Reopen one and Claude continues with its context. Search every past session.
- **Run things on a schedule.** Save prompts as templates. Schedule a prompt daily or every N minutes.
- **Weekly limit.** The meter shows the real 7-day plan usage and its reset time when your status line command saves Claude Code's `rate_limits` to `~/.claude/rate_limits_state.json` (or the file in `OFFICE_RATE_FILE`). Without that file the meter stays hidden.
- **Keep an eye on cost.** The control strip shows tokens, cost and the cache hit rate of a session that runs in the office, and its context fill. A session can have a spend limit.
- **Ask the user.** Claude can call an `office_ask` tool to ask you a question and wait for your answer.
- **Room awareness.** Claude can read its room (`office_room`): the place, the other sessions, the notes board, the pin and what is in the room. When you ask, it can add to the notes board or pin a short message on the blackboard (`office_room_update`). It puts its session name in front of each line it adds. It cannot move furniture or bots.

## Requirements

- Windows 11. Opening and closing sessions is written for Windows.
- Node.js 20 or newer.
- Claude Code 2.1.295 or newer, already signed in. The office uses your existing login. It was tested on 2.1.317.
- Git for worktrees and the Changes view. The GitHub CLI (`gh`) for pull requests.
- Internet access: the page loads React from jsDelivr and fonts from Google.

There is nothing to install. The server has no dependencies.

## Start it

```
cd E:\agent-office
npm start
```

Open http://localhost:4317 and choose **Open session**.

1. Pick a folder.
2. Leave **Runs** on "In the office (no terminal)".
3. Optional: choose "New git worktree", a model, a spend limit, and a first instruction.
4. Click a bot, then use its chat. Type `/` for commands and skills.

The controls strip at the bottom holds Open session, Past, Schedules and Hooks. When a bot is selected it also shows the model, the permissions, Stop turn, Changes and Always allow.

### Sessions you start yourself

Start Claude Code with the office settings so the office can see it:

```
claude --settings "E:\agent-office\office-hooks-http.json" --mcp-config "E:\agent-office\office-mcp.json"
```

The **Hooks** button shows the exact command for the active hook mode. A terminal session reports its activity and asks permission through the office, but you answer its chat in the terminal. Stop turn, mode and model switches, attachments and the command list work only in sessions that run inside the office.

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
- **The adapter** (`public/adapter.js`) turns the server's session snapshots into design system events.

### Hook modes

The office uses **HTTP hooks** when they were proven on your Claude Code version, which makes each event about 60 times faster than starting Node. Otherwise it uses **command hooks**. Run `npm run probe` after a Claude Code update to test HTTP hooks again. A stopped office never blocks Claude, because HTTP hook failures are non-blocking and command hooks always exit 0.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `OFFICE_PORT` | `4317` | Port on 127.0.0.1. |
| `OFFICE_HOOKS` | auto | `command` or `http` forces a hook mode. |
| `OFFICE_ASK_TIMEOUT_S` | `60` | How long a terminal session's permission prompt waits for the office before the terminal dialog decides. Sessions in the office wait 15 minutes. |

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | The server: state, hooks, sessions, REST, SSE, schedules, history. |
| `git.mjs` | Worktrees, the changes view, remove worktree, pull request. |
| `place.mjs` | Where a session or worktree sits: building, floor, room id and notes key. The snapshot carries it. |
| `hook.mjs` | Command hook. Sends one event to the server. |
| `mcp.mjs` | MCP server with `office_inbox`, `office_ask`, `office_room` and `office_room_update`. |
| `launch.ps1` | Starts a session in a terminal window. |
| `probe.mjs` | Tests HTTP hooks on this Claude Code version. |
| `public/` | The page: `adapter.js`, `office.js`, `office.css`, `chat-extras.js`, `index.html`. |
| `test/smoke.mjs` | End-to-end test against real Claude Code. |
| `DS-README.md`, `Recipes.md`, `Reference.md`, `Concepts.md`, `kit/`, `components/`, `tokens.css` | The Agent Office design system. |

Generated at run time and ignored by git: `.office-token`, `office-hooks.json`, `office-hooks-http.json`, `office-mcp.json`, `state.json`, `history.json`.

## Safety

- The server listens on 127.0.0.1 only and rejects other host names.
- Every request needs a token. The token is kept in `.office-token` and reused across restarts, so running sessions keep working.
- The office sends hook data to your own machine only. Hooks forward short fields: the tool name, a path or command, and the prompt. A permission prompt also carries the full input so the card can show the change.
- "Always allow" writes the rule Claude suggests to that project's `.claude/settings.local.json`, and only when you click it.
- Creating a pull request runs `git push` and `gh pr create`. The office asks you to confirm and lists the steps first.
- The office never edits `~/.claude/settings.json` or your credentials.
- Saved sessions (`history.json`) contain Claude's replies. They stay on this machine.
- Remote access is not supported. Reaching an agent that can run commands needs real login and encryption. If you want it from a phone, put the office behind Tailscale.

## Troubleshooting

- **"Already running on port 4317."** A second `npm start` is harmless: it changes nothing. Stop the first copy to restart.
- **A session does not appear.** Terminal sessions need the `--settings` flag above. Check the Hooks dialog for the mode in use.
- **No Approve cards.** Your Claude Code default mode may be Auto, which rarely asks. Choose Default or Plan under Permissions when you open the session.
- **A message sits queued.** A terminal session at an idle prompt reads it when it next runs. Sessions in the office take messages at once.
- **The `/` list is empty.** Claude reports its commands after the first message. The office reuses the last known list until then.
- **A session stops at start.** The bot's chat shows Claude Code's error. The usual cause is a signed-out login.

## Tests

```
npm run probe   # HTTP hooks on this Claude Code version (one tiny call)
npm run smoke   # opens real Haiku sessions in a throwaway repo (a few cents); the office must be running
python kit/check.py public/index.html public/office.css public/office.js public/adapter.js public/chat-extras.js
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
