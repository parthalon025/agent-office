# Security review (issue #27)

Read-only audit of main at 0fc02ec, then a fix pass on main at 371f7cf. This file records each finding and its state.

## What was reviewed

`server.mjs`, `tracker.mjs`, `git.mjs`, `place.mjs`, `notes.mjs`, `hook.mjs`, `payload.mjs`, `mcp.mjs`, `risk.mjs` (all in `src/` since the folder cleanup; the findings below name them without the folder), `launch.ps1`, `public/*.js`, `index.html` and the DS bundle sinks. Checked by reading the code and by probes on Node 22.18 (Windows). Sound at audit time: Host allowlist before any route, no CORS headers, a token on every route except the page and its static files, static files by exact-match map, bind to 127.0.0.1, argument lists for git (no shell), permission holds answered on their own response.

## Findings

| Id | Finding | State |
| --- | --- | --- |
| C1 | A planted `git.exe`, `claude.exe`, `cmd.exe` in a session folder ran with no click | Fixed earlier: every program starts by its absolute path (`resolveExe`, `programPath`); `test/spawn-safety.test.mjs` scans the sources. |
| H1 | Any local client got the one token | Fixed earlier: two tokens, one-time launch link, owner-only ACL on token files (`auth.mjs`). |
| H2 | "Low" risk covered secret reads and code-running edits | Fixed earlier: `risk.mjs` is an allowlist on real paths (links resolved), rated against the session root. #109 and #120 widened it. |
| M1 | Remote images in replies leaked data | Fixed earlier (ecc02ac): click-to-load images. |
| M2 | React and fonts from a CDN without SRI | Fixed earlier (ecc02ac): vendored, strict CSP. |
| M3 | Clickjacking | Fixed earlier: `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`. |
| M4 | `mcp-add` could reach user scope | Fixed earlier: `extensions.mjs` name rule and `--scope` order. |
| L1 | Any next message answered a pending `office_ask`, also Resume and Retry | Fixed here: `sendMessage` takes `answers`; the page sends `answers: false` for Resume and Retry. A message the user types in the chat still answers. Test: `test/mcp-routes.test.mjs`. |
| L2 | Always allow on high risk was a UI rule only; suggestion `destination` kept as given | Fixed here: `answer()` refuses `always` on a high-risk request (400), and the provider forces `destination: 'localSettings'`. Tests: `test/providers.test.mjs`. |
| L3 | Write and MultiEdit previews cut silently | Fixed here: the preview ends with "N more lines" or "N more edits". The risk rating already reads the full input, not the preview. Test: `test/tracker.test.mjs`. |
| L4 | `?t=` token on every route, no Content-Type or Origin check | Fixed earlier: no token from the URL, JSON body required, foreign Origin refused (`auth.checkRequest`). |
| L5 | `--resume <sid>` and `--model` unchecked on reopen | Fixed here: a resume id must be a UUID (`SID_RE`) and the model must match `MODEL_RE`, in `check()` and `open()`. Tests: `test/providers.test.mjs`. |
| L6 | `from` and `branch` without `BRANCH_RE` | Fixed earlier: `BRANCH_RE` in `git.mjs`. |
| L7 | A stale `OFFICE_ID` in a `-NoExit` window attached later sessions to an old one | Fixed here: `launch.ps1` clears `OFFICE_ID` when claude returns. Not reproduced at audit time; the fix is the cheap guard the audit named. The hook still matches by `office_id` first, so a hook from the same window while claude runs is unchanged. |
| L8 | The prompt was a bare positional argument | Fixed here: the terminal window passes `--` before the prompt. The prompt already travels in `OFFICE_ARGS` (JSON in the environment), so it never passes through shell quoting. Test: `test/providers.test.mjs`. |
| L9 | Notes hygiene | Fixed here, in parts. `notes.mjs`: a board key that every object has (`__proto__`, `constructor`, `toString`, `prototype`) is refused (400) and reads use own keys only; the user's text loses control, C1 and invisible direction characters. Agent writes were already scanned (#72). `office_room`: the disclaimer comes first, and the notes, the pin and the other sessions' tasks sit between BEGIN and END lines; session names are one line. The number of boards is capped (`MAX_BOARDS`, 500): a save or an agent append that would make a new board past it is refused (413); a board that exists still saves. Tests: `test/notes.test.mjs`, `test/mcp-routes.test.mjs`. |
| L10 | Secrets at rest | Fixed earlier (a36f16f): owner-only ACL on `state.json`, `history.json` and the token files. |
| L11 | Token compare with `!==`; `taskkill` on a reused pid; PR link without `safeUrl` | Compare fixed earlier (`auth.tokenEqual`, constant time; a test fails on `=== AGENT_TOKEN`). PR link fixed here: `public/dialogs.js` makes a link only for an `https://` address. Pid reuse fixed: the Claude Code provider records the start time of the process it spawned (`git.processStart`, never an image name) and `close()` runs `taskkill /T` only when the pid still has that start time; a different start time or no process means nothing is killed, and a session whose start time was never recorded is refused (409). A session found by the hook walk is stamped when it is found. Tests: `test/providers.test.mjs`. The token is not rotated while the office runs on purpose (the agent token is reused across restarts; the page token is new at each start). |

## Remaining risk

- `taskkill` on a reused pid (L11) is checked for Claude Code sessions only. `killTree` (local tool commands, ACP agents, Agent Framework runners) still kills by pid; a local tool command is killed only while it runs, and the ACP and runner pids come from the office's own spawn, so the window is short but not closed.
- The rules apply only while the office runs (ADR 0001).
