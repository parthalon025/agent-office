# Configuration

The office reads these environment variables when it starts. Set them before `npm start`. Everything else is set in the page. The files the office keeps are in [Development](development.md#files).


| Variable | Default | Effect |
| --- | --- | --- |
| `OFFICE_PORT` | `4317` | Port on 127.0.0.1. `branch` takes a port from the current branch name (4330-4399), so each worktree has its own; `npm run start:branch` sets it. The name gives a fixed sequence of 12 ports. The office takes the first free one and prints which port it took. It stops, and takes no other port, when an office of the same folder already holds any one of them, or none is free. A branch that takes another port of its sequence than last time starts with the files of that port (empty notes, schedules and past sessions, a new agent token). A session attached with the settings file of the old port keeps posting to the old port. An office on a port other than 4317 has its own files, with the port in the name (see [Development](development.md#files)), so it never takes over the hooks, notes or schedules of the office on 4317 in the same folder. |
| `OFFICE_OPEN` | on | `0` stops the server from opening the launch link in your browser. It still prints the link. |
| `OFFICE_HOOKS` | auto | `command` or `http` forces a hook mode. |
| `OFFICE_ROOMS_DIR` | `~/.agent-office/worktrees` | The folder where a floor or room you make in the office (not an agent room, which goes next to the repository) is created. The tests set it to a temp folder. |
| `OFFICE_ASK_TIMEOUT_S` | `60` | How long a terminal session's permission prompt waits for the office before the terminal dialog decides. Sessions in the office wait 15 minutes. |
| `OFFICE_OLLAMA_URL` | `http://127.0.0.1:11434/v1` | Where the Ollama agents find their server. Loopback addresses only (127.0.0.1, localhost, ::1). Any other host stops the office at start. |
| `OFFICE_LMSTUDIO_URL` | `http://127.0.0.1:1234/v1` | The same for LM Studio agents. The office only lists models and sends chat requests. It never loads or unloads a model. |
| `OFFICE_AF_PYTHON` | `python` on the PATH | The full path of the Python that has Microsoft Agent Framework (see [Agent Framework teams](agents.md#agent-framework-teams)). Agent Framework teams use the two server addresses above. |
| `OFFICE_FOUNDRY_ENDPOINT` | none | The project endpoint of your Azure AI Foundry project. The kind is off without it. `https` only, and the host must end with `.services.ai.azure.com`, `.openai.azure.com` or `.cognitiveservices.azure.com`, so the token goes to a Microsoft host only. |
| `OFFICE_FOUNDRY_TOKEN_FILE` / `OFFICE_FOUNDRY_TOKEN` | none | The access token you made, in a file (read at each call, so a new token needs no restart) or as a value. Use the file. The kind is off without one. The office takes both out of its environment at start, so the processes it starts do not get them. |
| `OFFICE_FOUNDRY_API_VERSION` | `2025-05-01` | The api-version sent to the Agent Service. |
| `OFFICE_FOUNDRY_PRICE_IN` / `OFFICE_FOUNDRY_PRICE_OUT` | `0` | Dollars for 1 million input and output tokens. Set both. The spend limit counts tokens with these prices. Without both, Foundry does not report cost: the office asks before a session runs, shows the cost as unknown, and no limit can stop it. |
| `OFFICE_COPILOTSTUDIO_ENDPOINT` | none | The connection string of your Copilot Studio agent. The kind is off without it. `https` only, on a `.api.powerplatform.com` host (or the government hosts `.api.gov.powerplatform.microsoft.us`, `.api.high.powerplatform.microsoft.us`, `.api.appsplatform.us`). |
| `OFFICE_COPILOTSTUDIO_TOKEN_FILE` / `OFFICE_COPILOTSTUDIO_TOKEN` | none | The same as for Foundry. |
| `OFFICE_COPILOTSTUDIO_PRICE_MESSAGE` | `0` | Dollars the spend limit counts for each message you send. Without it, Copilot Studio does not report cost, as for Foundry. |
| `OFFICE_CURSORCLOUD_TOKEN_FILE` / `OFFICE_CURSORCLOUD_TOKEN` | none | Your Cursor API key, in a file or as a value (use the file). The Cursor cloud agent kind is off without one. The office takes both out of its environment. |
| `OFFICE_CURSORCLOUD_REPOSITORY` | none | The GitHub repository the Cursor agent works on, `https://github.com/owner/name`. The kind is off without it. `OFFICE_CURSORCLOUD_REF` (optional) is a branch or tag. `OFFICE_CURSORCLOUD_ENDPOINT` (optional) defaults to `https://api.cursor.com` and must be a `.cursor.com` host. |
| `OFFICE_HERMESGATEWAY_ENDPOINT` | none | The base address of your Hermes gateway API server. The kind is off without it. `https` on any host, or `http` on this PC only. |
| `OFFICE_HERMESGATEWAY_TOKEN_FILE` / `OFFICE_HERMESGATEWAY_TOKEN` | none | The gateway API key (16 characters or more), as for Cursor. `OFFICE_HERMESGATEWAY_MODEL` (optional) is the model name, default `hermes-agent`. |
| `OFFICE_OPENCLAW_PORT` | `18789` | The loopback port of your OpenClaw Gateway. The office only checks that something listens there (see [OpenClaw](agents.md#openclaw)). |
| `OFFICE_ACP_PROGRAM` / `OFFICE_ACP_ARGS` | none | The program (a plain name on the PATH) and the arguments (a JSON list of strings) of the generic **ACP agent** kind. The kind is not ready without a program (see [ACP tools](agents.md#acp-tools-gemini-cli-opencode-kimi-cli-and-other-acp-agents)). |
| `OFFICE_PAPERCLIP_PORT` / `OFFICE_PAPERCLIP_DB_PORT` | `3100` / `54339` | The loopback port of the Paperclip that the office installs and runs, and the port of its embedded database (see [Run Paperclip from the office](paperclip.md#run-paperclip-from-the-office)). |
| `OFFICE_NPM_CLI` | npm next to node | The full path of npm's `npm-cli.js`, when the office cannot find npm next to node. The office runs it with node: it never starts `npm.cmd`. |
| `OFFICE_PAPERCLIP_ASK_S` | the 15 minute office wait | Seconds a request of a Paperclip run waits for you before the office denies it. |
| `OFFICE_RATE_FILE` | `~/.claude/rate_limits_state.json` | The file with Claude Code's `rate_limits` that the weekly limit meter reads. Without the file the meter stays hidden. |
| `OFFICE_EXPLAIN` | on | `off` stops the one-line explanation that a local model adds to a waiting request. The explanation only informs: the raw command always shows next to it. |
| `OFFICE_EXPLAIN_MODEL` | first chat model of the first ready local server | The model that writes those explanations. |
| `OFFICE_EMBED` | on | `off` stops the embedding model that makes company memory search find meaning. Keyword search still works. |
| `OFFICE_MEMORY_ADAPTER` | `sqlite` | The company memory store. Only `sqlite` (built in) exists. |
| `OFFICE_FLOOR_MIN_AGE_MS` | one hour | How old a floor must be before **Clean up unused floors** offers it. |
| `OFFICE_REMOTE_HOST`, `OFFICE_REMOTE_TEAM`, `OFFICE_REMOTE_AUD`, `OFFICE_REMOTE_EMAILS`, `OFFICE_REMOTE_PORT` | none | Remote access. All four of the first four are needed. See [Remote access](remote-access.md). |
