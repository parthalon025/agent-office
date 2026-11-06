# Development

How the office works inside, which files do what, and how to run and test it. The full module map, with the rules each file owns, is in [CLAUDE.md](../CLAUDE.md). The design system documents are in [DS-README.md](design-system/DS-README.md).

## Commands

```
npm start            # the server on 127.0.0.1:4317; prints and opens a one-time launch link
npm run start:branch # the server on the port of this checkout's branch (4330-4399); prints the link and opens nothing
npm run probe        # prove HTTP hooks on this Claude Code version (one tiny call)
npm run smoke        # open real Haiku sessions in a throwaway repo (a few cents); the office must be running
npm run gate:jobs    # count the steps of the five core jobs in a headless browser (no paid call)
npm test             # offline tests
```

- `npm test` passes a quoted glob to `node --test`, which Node reads only from version 21 on. That is why the office needs Node 22 or newer.
- `npm run probe -- <port>` and `npm run smoke -- <port>` test an office on another port.
- `npm run gate:jobs` is not part of `npm test` and not in CI. It needs Chrome or Edge, starts its own office on a free port (never 4317), seeds it with fake hooks, and fails when a job takes more steps than its limit. The five jobs are start an agent, answer an approval, read the change, discard a room and find a past session. Its screenshots go to `.screens/core-jobs/` and are never committed. Run it before a UI merge.
- Before you finish a UI change, run the design system checker:

```
python kit/check.py public/index.html public/office.css public/page-core.js public/dialogs.js public/dialogs-extra.js public/panels.js public/needs.js public/office.js public/adapter.js public/chat-extras.js public/city.js public/board.js public/terminal.js public/persona.js public/lobby.js public/desk.js public/wheel-gate.js public/vocab.js public/scene-host.js public/building.js public/format.js public/toasts.js public/wire.js public/security.js components/bundle.css components/bundle.js kit/page.html
```

## Branch ports

`OFFICE_PORT=branch` (and `npm run start:branch`) takes a port from the name of the current branch, in the range 4330-4399, so each worktree has its own office. The name gives a fixed sequence of 12 ports. The office takes the first free one and prints which one it took. Final browser tests of a worktree run on that port and never on 4317, which is the port of your own office. Stop an office by the process id that owns its port (`netstat -ano | findstr :<port>`, then `taskkill /PID <pid> /F`). Never stop one by image name: that would stop your other Claude Code sessions. The full rule is under `OFFICE_PORT` in [Configuration](configuration.md).

## How it works

```
Claude Code ──hooks (HTTP or command)──▶ src/server.mjs ──SSE──▶ browser (adapter.js ▶ Agent Office DS)
     ▲  ▲                                   │  │
     │  └── stdin: messages, control ───────┘  └── REST: open, close, answer, message, history ...
     └───── MCP (src/mcp.mjs): office_inbox, office_ask, office_room, office_room_update
```

- **Hooks** report prompts, tool calls (with their id and time), failed tool calls, subagent start and stop, and stops. `payload.mjs` trims each payload the same way for command and HTTP hooks; tool output never leaves the session. A `PermissionRequest` hook holds the prompt until you answer in the office.
- **Sessions in the office** run `claude -p` in stream-json mode with a pipe. Messages go in on stdin, replies and control requests come out on stdout.
- **MCP** gives a session four tools: read messages the user sent from the office, ask the user a question, describe its room (`office_room`), and change the room's notes board or blackboard pin when the user asks (`office_room_update`).
- **The adapter** (`public/building.js`, loaded by `public/adapter.js`) turns the server's session snapshots into design system events. A snapshot store holds the latest snapshot, and each mounted building has its own adapter.

### Hook modes

The office uses **HTTP hooks** when they were proven on your Claude Code version, which makes each event about 60 times faster than starting Node. Otherwise it uses **command hooks**. Run `npm run probe` after a Claude Code update to test HTTP hooks again. A stopped office never blocks Claude, because HTTP hook failures are non-blocking and command hooks always exit 0.

## Files

The server code is in `src/`. The repository root is the office folder: the office keeps its runtime files there (below), never in `src/`. `src/files.mjs` names that folder (`OFFICE_ROOT`) and the files in it.

| File | Purpose |
| --- | --- |
| `src/server.mjs` | The HTTP adapter: port, tokens, the gate, the response, the files written at start. |
| `src/office.mjs` | The office: state, hooks, sessions, schedules, history and the route table, behind `createOffice`. |
| `src/office-core.mjs` | The core: `handle(request)`, the route groups of the table, the static files. Tests call it in process. |
| `src/auth.mjs` | Access rules: the agent token and the page token, the launch code, the request checks, files that only you, SYSTEM and Administrators can read. |
| `src/files.mjs` | The names of the files an office keeps in this folder, per port. |
| `src/git.mjs` | Worktrees, the changes view, remove worktree, pull request. |
| `src/tracker.mjs` | The session rules: hook payloads and stream lines in, sessions out. No I/O of its own, so tests run offline. |
| `src/place.mjs` | Where a session or worktree sits: building, floor, room id and notes key. The snapshot carries it. |
| `src/security.mjs`, `src/risk.mjs`, `src/trust.mjs` | The Security room rules, the risk of a tool call, and the proposals that come from your answers (see [Security](security.md)). |
| `src/manager.mjs`, `src/paperclip.mjs` | The Manager (goals into steps) and the read side of Paperclip (see [Manager](manager.md) and [Paperclip HQ](paperclip.md)). |
| `src/personas.mjs`, `src/rituals.mjs`, `src/explain.mjs`, `src/changes.mjs`, `src/archetypes.mjs` | Agent characters and teams, the weekly recap and Focus mode, the one-line request explanation, the merge-ready check, and the kind of a building (see [Customization](customization.md)). |
| `src/skills.mjs`, `src/extensions.mjs`, `src/payload.mjs`, `src/post.mjs` | The skills an agent writes, the `claude mcp` and `claude plugin` arguments, the hook payload trim, and the one POST that `hook.mjs` and `mcp.mjs` send. |
| `src/notes.mjs` | The notes board of a room: the user's save with a base version, agent appends, the pin, and a three-way merge so an agent's line and the user's edit both stay. |
| `src/hook.mjs` | Command hook. Sends one event to the server. |
| `src/mcp.mjs` | MCP server with `office_inbox`, `office_ask`, `office_room` and `office_room_update`. |
| `src/providers/` | The agent kinds behind one seam (`index.mjs`): Claude Code, local models (Ollama and LM Studio, with their tools in `local-tools.mjs`), ACP agents (`acp.mjs`: Hermes Agent, DeepSeek Harness, Copilot CLI and OpenClaw, with `copilot.mjs` and `openclaw.mjs`), Agent Framework teams (`agent-framework.mjs`, with the Python runner `agent_framework_runner.py`), and the cloud kinds (`cloud.mjs`, `foundry.mjs`, `copilot-studio.mjs`). |
| `launch.ps1` | Starts a session in a terminal window. |
| `src/startup.mjs` | Adds or removes the Start with Windows entry (a .cmd in your Startup folder). At sign-in the office starts and opens its launch link. Only the office on port 4317 in the main folder can change the entry; an office on another port or in a worktree shows it read-only with the reason. |
| `src/probe.mjs` | Tests HTTP hooks on this Claude Code version. |
| `public/` | The page. Rules without a screen: `vocab.js` (shared status words, tool names and room figures), `format.js`, `wire.js`, `building.js` (snapshot store and building adapter), `toasts.js`, `wheel-gate.js`. The 3D scene: `scene-host.js` (the one reader of the 3D stage), `city.js`, `board.js`, `terminal.js`, `security.js`, `desk.js`, `lobby.js`, `persona.js`. The React page: `page-core.js`, `dialogs.js`, `dialogs-extra.js`, `panels.js`, `needs.js`, `office.js`, `adapter.js`, `chat-extras.js`, `office.css`, `index.html`. `vendor/` holds React 18.3.1 and the fonts, byte for byte as published (`vendor/README.md`: sources, SHA-256, how to update). |
| `test/*.test.mjs` | Offline tests (`npm test`): access rules (with a real server on a free port), the vendored files and the static file list, the documents (every link and image), place rules, the risk classifier, the session tracker, the providers with fake agents, the scene host, notes merge, the snapshot store and building adapter, contrast pairs, wheel gate and toast rules. |
| `test/tracker.test.mjs` | Session tracker tests from recorded-shape hook payloads and stream lines in `test/fixtures/`. |
| `test/smoke.mjs` | End-to-end test against real Claude Code. |
| `test/core-jobs.mjs` | The core-jobs gate: a browser script that counts the steps of each core job (`npm run gate:jobs`). |
| `docs/` | These documents, the screenshots (`docs/img`), the security review and the decision records (`docs/adr`). |
| `docs/design-system/`, `kit/`, `components/`, `tokens.css`, `tokens.json` | The Agent Office design system: its documents (`DS-README.md`, `Recipes.md`, `Reference.md`, `Concepts.md`, `Changelog.md`), checker, components and tokens. |
| `docs/releases.md` | The changes to the page and the server, by version. |
| `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/` | The license, how to contribute, how to report a problem, issue and pull request templates, CODEOWNERS and CI. |

Generated at run time and ignored by git: `.office-token`, `office-hooks.json`, `office-hooks-http.json`, `office-mcp.json`, `state.json`, `history.json`. Outside this folder: `%LOCALAPPDATA%\AgentOffice\office-page-<port>.json`.

An office on a port other than 4317 (`OFFICE_PORT`, `npm run start:branch`) writes the same files with its port in the name, for example `.office-token-4392`, `office-hooks-4392.json`, `office-hooks-http-4392.json`, `office-mcp-4392.json`, `state-4392.json` and `history-4392.json`. Its settings files call `src/hook.mjs` and `src/mcp.mjs` with the port, so a session attached to it talks to it, and a session attached to the office on 4317 keeps talking to 4317. That office starts with its own empty notes, schedules and past sessions. An office on another port that ran here before this change keeps its agent token, so settings files it made still work. Its old notes and schedules stay in `state.json`. To probe the HTTP hooks of that office, run `npm run probe -- <port>`.
