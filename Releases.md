# Releases

Changes to the Agent Office page and server. The design system has its own list in [Changelog.md](Changelog.md).
Versions keep the `x` prefix.

## x0.2 (not released yet)

### Added

- Rooms know their agents. An agent can read its room and change the notes board and the blackboard pin (`office_room`, `office_room_update`).
- Room boards. The blackboard shows to-dos, browser steps, last calls and the repository. A notes board in each room takes your text and merges agent lines with your edits.
- Terminal panel. Each desk monitor shows its session as a live terminal.
- Room decor: a stats display, a whiteboard, a door that pulses, a lamp and plants.
- City of repositories. Every repository is a building. You zoom in, click to enter, and scroll out one level at a time. Streets, trees and birds fill the city.
- Floors and rooms from git. A branch is a floor. A worktree is a room. You add and remove them from a dialog.
- Extensions view. It lists MCP servers and plugins for a session, with a filter.
- Needs you. One button and one dialog list the requests of all buildings. You approve, decline or go to the bot.
- Keyboard path. Ctrl+K opens room tools and session terminals. Esc closes only the top layer.
- Toasts that keep an action or an error until you act.
- The "Since you left" card shows once per visit.
- A folder list for the Open dialog that comes from the server.
- Pure session tracker, session vocabulary, place, notes and scene host modules, each with offline tests.
- Tools for local-model agents (read, list, search, edit, write, run). Every path stays inside the worktree.
- A Manager core. It turns a goal into steps, hands each step to a free agent, holds a plan for your approval, retries a failed step, stops at a spend limit, and caps agent mail.
- GitHub Actions. Each push runs the tests, the syntax check and the design-system check.

### Changed

- The server owns where a session sits: building, floor, room id and notes key. The page reads them.
- One status word per state on every surface. A failed turn reads as Error until you dismiss it or the next turn starts.
- The room's waiting count is the same on the stats display, the stats panel, the room dialog and in what agents read.
- A tool result settles only the permission request of its own call.
- Risk rating is an allowlist. Approve all low-risk no longer approves PowerShell deletes or agent questions.
- Reads are low risk only inside the session's worktree or start folder. Secret files (`.env`, keys, credentials, the office token) and settings folders (`.git`, `.claude`, `.vscode`, `.idea`, `.mcp.json`) are never low risk. An edit that can make a program run (git config and hooks, Claude Code settings, MCP lists, editor tasks) is high risk. A link that leads out of the folder counts as outside. Shell commands that make links, change git config, or start `cmd /c` or encoded PowerShell are high risk.
- The calm dock. Approvals show in the panels, and only one panel is open at a time.
- Status words and notes text are readable in Day, Night and Sublevel. Reduced motion gives a still door ring and instant City lifts.
- Each mounted building has its own adapter. The page no longer keeps a global reset.
- Folder keys follow Windows rules on every host.
- The room inventory pipeline is gone. The server keeps one decor list.

### Fixed

- A session never shows as Finished after an error.
- A subagent tool call no longer hides a request that waits for you.
- A note an agent adds while you type no longer undoes your deletion.
- The notes caret stays in place when text from outside arrives.
- One building name per repository, whatever the case of the folder.
- A room outside git no longer asks for a file list. The board says "Not a git folder".
- A click on a desk monitor in front of a board opens only the terminal.
- The page loads again after a stale chat header call was removed.

## x0.1

First version. Bots at desks for Claude Code sessions, a chat per bot, approvals, diffs and schedules, fed by hooks.
