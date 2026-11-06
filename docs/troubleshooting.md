# Troubleshooting

The office knows several kinds of session (see [Agent kinds](agents.md)). A session **in the office** runs `claude -p` with a pipe. A **terminal session** is one you start yourself with the office settings. A **local agent** runs a model on this PC through Ollama or LM Studio. An **Agent Framework team** runs a team of agents on such a model. A **cloud agent** runs in your Azure account (Azure AI Foundry or Copilot Studio). Find your kind below.

## Any session

- **"Already running on port 4317."** A second `npm start` is harmless: it changes nothing, and it opens a new launch link for the office that runs. To restart, stop the first copy by the process id that owns the port. Never stop it by image name: that would stop your other Claude Code sessions. Run `netstat -ano | findstr :4317`, then `taskkill /PID <pid> /F`. Or start a second office on another port with `OFFICE_PORT`. It has its own files and sessions (see [Development](development.md#files)), and it leaves the first office as it is.
- **The page says "No access to the office".** The page has no working cookie: you opened it without a launch link, the link was used or older than 5 minutes, or the office restarted (each start makes a new page token). Run `npm start` to get a new link. Other office tabs in the same browser get access again within 5 seconds.
- **A call answers 401 Unauthorized.** The token did not match. For the page, open a new launch link (see above). For hooks: if you deleted `.office-token`, the office made a new agent token. Sessions that started before that keep the old token in their settings, so start them again.
- **A call answers 403 Forbidden.** The server accepts only `127.0.0.1:<port>` and `localhost:<port>` as host name, and refuses requests that a page on another site or port sends. Open the office with its launch link.
- **A call answers 415.** The office takes changes as JSON only (`content-type: application/json`).
- **"WARNING: Could not limit ... to your Windows user."** The office could not set or check who can read that file. The text in brackets gives the reason: `icacls` failed (for example on a drive without permissions, such as FAT32 or exFAT), Windows PowerShell could not read the permissions back, or an entry is still on the file (for example "inheritance is on" or "Allow entry for S-1-5-32-545", which is the Users group). The office still runs. Other users of this computer may read that file. Run `icacls <file>` to see who can.
- **No Approve cards.** Your Claude Code default mode may be Auto, which rarely asks. Choose Default or Plan under Permissions when you open the session.
- **The scene stays empty or black.** The scene is 3D and needs WebGL. Turn on hardware acceleration in the browser. The page loads every file from the office. If the browser console shows a 404 for a `/vendor/` file, the `public/vendor` folder is not complete: get it again from git.
- **Remove worktree is refused.** Close the session first: the button stays off until it ends. If the room has uncommitted changes, the dialog says so and offers Remove and discard changes. In the Floors dialog, git refuses uncommitted changes and commits that are not merged in the same way, and the dialog offers to go ahead anyway. The main folder cannot be removed.

## Sessions in the office

- **A session stops at start.** The bot's chat shows Claude Code's error. The usual cause is a signed-out login. Sign in with Claude Code, then open the session again.
- **Claude Code says "Not ready: Sign in to Claude Code", but you use Bedrock, Vertex, Foundry or an API key.** The office does not block when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set in the environment of the office, or when `claude auth status` says you are logged in. Set the variable before `npm start`. A setting that exists only in a project's `.claude/settings.json` is not visible to this check. Open session still works in that case: Not ready only advises, and a session in that project uses its own settings.
- **The `/` list is empty.** Claude reports its commands after the first message. The office reuses the last known list until then.
- **A turn failed.** The bot shows a red badge until you click Retry or Dismiss.

## Local agents

- **The office stops at start with "A local model provider talks to this machine only."** The address in `OFFICE_OLLAMA_URL` or `OFFICE_LMSTUDIO_URL` is not on this PC. Use `127.0.0.1`, `localhost` or `::1`, or remove the variable.
- **`GET /api/providers` says the kind is not ready.** The office could not list models in 3 seconds, or the list is empty. The answer can be up to 30 seconds old: click Check again, or ask with `?fresh=1`. For Ollama, start it and run `ollama pull <model>`. For LM Studio, start the local server (Developer tab) and load a chat model. Check that the address matches the server.
- **A turn fails with "API Error: fetch failed" (or another connection error).** The server is not reachable at the address. Start it, or set the right address, then send the message again.
- **A turn fails with "API Error: Ollama answered 404" or "LM Studio answered 404".** The server does not know the model. The text after the colon is the server's own message. Use an id from the list in `/api/providers`. The list leaves out models whose id contains `embed` or `rerank`.
- **A turn fails with "API Error: ... answered 400" and the server message says the model does not support tools.** The agent needs tool calling. Pick a model that supports tool calling.
- **A turn fails with "Ollama stopped answering."** The server sent no data for 2 minutes. Check that the model is loaded and that the PC has enough memory.
- **A turn fails with "The model used all 25 steps of one turn."** Send a smaller task.
- **"Pick a model for this agent."** The open call has no `model`.
- **"Local agents take text only."** Remove the attachment.

## Agent Framework teams

- **Agent kinds says "The office cannot find Python" or "OFFICE_AF_PYTHON does not point to a program".** Do the setup steps in [Agent Framework teams](agents.md#agent-framework-teams), and check the path in `OFFICE_AF_PYTHON`.
- **Agent kinds says "The office could not load Agent Framework: ModuleNotFoundError ...".** That Python does not have the framework. Install it in that environment (`pip install agent-framework`), or point `OFFICE_AF_PYTHON` at the environment that has it.
- **Agent kinds says "Start LM Studio or Ollama with a chat model."** The framework loads, but no local server lists a model.
- **"agent-team.json: ..." when you open a session.** The team file has a mistake. The message says what to fix.
- **A turn fails with "Agent Framework: APIConnectionError ...".** The local server stopped or does not answer at its address. Start it, then send the message again.
- **A turn fails with "Agent Framework: The team used all 60 steps of one turn."** The members handed the work back and forth, or called tools, without an end. The team starts again. Send a smaller task, or make the instructions in `agent-team.json` say when to stop.
- **A tool call fails with "... is not a tool of ...".** That member asked for a tool that is not in its `tools` list. Add the tool to the list in `agent-team.json` if the member needs it.
- **"Agent Framework stopped: ..." and the session ends.** The team process ended. The text is its last error output. If it names a framework class or option, the installed framework is newer or older than the one the runner was written for (1.24); tell the office maintainers.
## Cloud agents (Azure AI Foundry and Copilot Studio)

- **The kind says "Not configured".** The settings are missing or wrong. The text under the name lists each missing step. Set the endpoint and the token file, then start the office again. See [Azure AI Foundry and Copilot Studio agents](agents.md#azure-ai-foundry-and-copilot-studio-agents).
- **The kind says the endpoint cannot be used.** The address must start with `https://` and the host must be a Microsoft host (see [Configuration](configuration.md)). A user name, a password or a `#` part is not allowed.
- **A turn fails with "... refused the token".** The token is old or for another resource. Make a new token and save it in the token file. No restart is needed.
- **A turn fails with "... says this token has no access".** Your account has no role on the project or the agent. Check the role in the portal.
- **A turn fails with "... did not find the agent or the conversation".** Check the endpoint and the agent. For Copilot Studio the next message starts a new conversation.
- **A turn fails with "The agent asked the office to run <function>".** The Foundry agent has a function tool. The office has no functions. Remove the tool from the agent.
- **A turn fails with "The agent asks for a sign-in".** A Copilot Studio connector needs your own connection. Set it up in Copilot Studio. The office does not sign in.
- **The office asks "This agent does not report cost" and shows the cost as unknown.** No prices are set (Foundry needs both). Set the price variables (see [Configuration](configuration.md)) and start the office again, or set **Run without cost reports** to Allow for **Cloud agent** on the Agents screen.
- **Open session says "Turn on Cloud agent on the Agents screen of the Security room first".** Agent kinds then shows Not ready with the same words, and the office makes no call. Turn on **Cloud agent** there (see [Azure AI Foundry and Copilot Studio agents](agents.md#azure-ai-foundry-and-copilot-studio-agents)).

## Copilot CLI

- **Not ready: "Copilot CLI runs tool calls without asking the office. Turn on Copilot on the Agents screen of the Security room first".** Turn on **Copilot** on the Agents screen of the Security room.
- **Not ready: "The office cannot find Copilot CLI".** Run `winget install GitHub.Copilot`, open a new terminal and run `copilot --version`. Restart the office so that it reads the new PATH.
- **Not ready: "The office needs copilot.exe. It found only ... copilot.cmd".** That is the npm install. Install the native program with winget.
- **Not ready: "Sign in to GitHub Copilot".** Run `copilot login` in a terminal and finish the sign-in. Click **Check again** after 10 seconds.
- **Not ready: "Copilot CLI is still starting".** A first start after a restart of the PC can take more than 10 seconds. Click **Check again** after a few seconds. A check with no answer in 60 seconds says "did not answer the ACP handshake": then run `copilot` in a terminal and check that it starts.
- **The feed says "Copilot CLI read ... without asking the office" or "ran a command without asking the office".** Copilot did a call it approves by itself (a read in its folder, a read-only command, a hook or an allowed URL). Check the call in the Terminal tab of its desk monitor. Remove the rule or the hook in Copilot's settings if you want it to ask.

## ACP agents (Hermes Agent and DeepSeek Harness)

- **Not ready: the office cannot find the program, or names a `.cmd` file.** The office starts `.exe` files only. Install the native program and put it on the PATH, then restart the office. DeepSeek Harness from npm is a `.cmd` install, so the office cannot start it yet.
- **Not ready: "did not answer the ACP handshake".** The program started but does not speak ACP. A `hermes` program can also be another tool with the same name. Run `hermes acp` in a terminal and check it.
- **Not ready: "is not signed in", or a turn fails with "is not signed in".** Sign in with the agent itself, then click **Check again** or send the message again.
- **Not ready: the agent runs tool calls without asking the office.** Hermes Agent is partly supervised. Turn on **Hermes** on the Agents screen of the Security room (see [Partly supervised: Hermes Agent](agents.md#acp-agents-hermes-agent-and-deepseek-harness)).
- **Open session answers "This agent does not report cost. Run it?"** This is a question, not an error. Choose Run, or set **Run without cost reports** on the Security room wall.
- **A card disappears and the feed says the agent moved on.** Hermes Agent waits 60 s for an answer to an edit. The office dropped the card and declined the edit. Ask the agent to try again and answer sooner.
- **Open is refused with "own room" text.** Hermes Agent opens only in a new git worktree. Turn off **Use this folder**, and use a folder that is in git.

## OpenClaw

- **"Not ready: start the OpenClaw Gateway".** Nothing listens on `127.0.0.1:18789`. Start the Gateway yourself (the office never does). If it uses another loopback port, set `OFFICE_OPENCLAW_PORT` before `npm start`.
- **Not ready: the version is too old or unknown.** Use OpenClaw v2026.10.10 or later, as a native `openclaw.exe`. An npm install (`openclaw.cmd`) is not accepted.
- **"OpenClaw cannot start: ..." with commands.** A setting in the OpenClaw config is off or unreadable: `tools.fs.workspaceOnly`, `tools.exec.host`, or the `agent-office` plugin (on, not denied, `tokenFile` is this office's). Run the commands the message gives. The office reads the config and never writes it. Nothing started yet, so no worktree was made.
- **The session ends and the feed says the plugin "did not hold this call".** The plugin is not loaded. Restart the Gateway after `openclaw plugins enable agent-office`, and check the token file path in the plugin config.
- **Every call is denied.** The plugin cannot reach the office: it must run, and `tokenFile` must name this office's token file (`.office-token-<port>` on a port other than 4317).

## Terminal sessions

- **A session does not appear.** Start Claude Code with the `--settings` and `--mcp-config` flags shown in [Using the office](using-the-office.md#sessions-you-start-yourself). The Attach sessions dialog shows the exact command for the hook mode in use.
- **Hooks do not arrive.** Check that the office runs and that the settings file matches the hook mode (`office-hooks-http.json` or `office-hooks.json`). An office on a port other than 4317 has its own settings files with the port in the name (`office-hooks-http-<port>.json`); the Attach sessions dialog shows the right one. Run `npm run probe` after a Claude Code update to test HTTP hooks again. A stopped office never blocks Claude, and it shows no error in the terminal.
- **A message sits queued.** A terminal session at an idle prompt reads it when it next runs.
- **A request disappears from the office after 60 seconds.** This is the wait limit for terminal sessions. Change it with `OFFICE_ASK_TIMEOUT_S`, or answer in the terminal.
- **Stop turn, mode and model switches and attachments do nothing.** They work only in sessions in the office.
