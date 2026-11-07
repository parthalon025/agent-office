// ACP provider: agents that speak the Agent Client Protocol (agentclientprotocol.com, protocol version 1) behind the provider
// seam (providers/index.mjs). One factory for many agents: each agent is an entry in AGENTS, not a new file. The agents are
// Hermes Agent (`hermes acp`), DeepSeek Harness (`dsh --profile acp`), OpenClaw (`openclaw acp`, behind a Gateway) and
// GitHub Copilot CLI (`copilot --acp`, its extras in providers/copilot.mjs).
//
// The office is the ACP client. It starts the agent by its absolute path (launch.mjs resolveExe), speaks newline-delimited
// JSON-RPC 2.0 on its stdin and stdout, and reports everything in the tracker's vocabulary (events.hook, events.stream):
//   session/update text            -> stream deltas and an assistant message
//   session/update tool_call(_update) -> PreToolUse, PostToolUse, PostToolUseFailure
//   session/update plan            -> a TodoWrite result (the session's plan)
//   session/request_permission     -> events.permission, held until the user answers. The office sends allow once or reject
//                                     once, never an "always" option: Hermes writes those as a lasting allowlist outside
//                                     the office (owner decision Q23). The answer is for what the card showed: a call the
//                                     agent changes while it waits is declined at once, and nothing approved moves to it.
//   interrupt                      -> session/cancel
// The office also serves the agent's files and terminals (clientCapabilities fs and terminal, owner decision Q24) with
// providers/local-tools.mjs: limited to the session's root, and each call goes to the office like any other request (the
// Security room rules, then a hold). A path outside the root is refused before anyone is asked. So an agent that uses them is held more strictly than one
// that only asks: an edit the user declined in a turn cannot come back through fs/write_text_file (Hermes issue #31682).
// An agent may ignore those capabilities and use its own tools (Hermes does): the office then sees a call only in its
// updates, cannot stop it, and says so in the feed. Such an agent is not gated (ADR 0001; AGENTS gated and supervision).
//
// Session: the office starts the agent, sends initialize with the client capabilities fs (read and write) and terminal, then
// session/new with the session folder (or session/load on Reopen when the agent said loadSession; session/fork for open(s, { fork }),
// and the replay is not shown again). Prompts are session/prompt. The agent's updates, permission requests, file calls and terminal
// calls come back on stdout and are handled in the order the agent sent them. The office answers every fs/* and terminal/* call
// itself, in the root only (acp-files.mjs). A resume that falls back to session/new reports events.fresh. canResume and features
// come from the handshake (learn(); fork also from sessionCapabilities.fork). Messages: ACP has no way to add text to a turn that
// runs, so a message that came back on a tool result (the return value of events.hook) is sent as the next prompt of the same turn,
// or with the next prompt when the turn was stopped. The token counts in a prompt answer (usage) go to the tracker once per turn.
// usage_update becomes a usage stream line; its optional cost (in the current ACP spec) is not read yet.
//
// Held requests: a request keeps a frozen copy of what its card showed. The grant and the declined file come from it, and a
// tool_call_update that changes a held call declines that request at once (reject once, events.drop, a feed line that names the
// change; the same input with its keys in another order is no change). A hold its agent stopped waiting for is freed with
// events.drop (a tool result for a held call, or Hermes's 60 s on an edit). The feed says when the agent ran a command or changed a
// file without asking, or changed a file the user declined; a read it ran without asking that riskOf does not rate low gets a feed
// line too. The reason agent kinds (dsh) pass the reason the agent gives for a request (reason or _meta.reason, not yet checked
// against a real dsh) as ask_reason.
//
// Files and terminals: a path outside the root is refused unasked. Every other call goes to the office like a local agent's
// (events.permission: the Security room rules, then a hold; a Deny refuses with its reason). A write to a file whose edit the user
// declined in the turn is refused under any spelling (risk.mjs fileKey; Hermes #31682). A declined edit that names no file makes
// every write of the turn ask. An unanswered or changed edit makes that file ask (both firm: an Allow rule does not answer them, a
// Deny rule does). An approved command or edit runs once without a second question until its call ends. commandLine refuses an
// argument the shell cannot take as plain text (on Windows a quote, %, ! or a line break: cmd.exe ignores \" when it tracks quotes).
//
// Gating (ADR 0001): gated and supervision are set per AGENTS entry. cost is 'unknown' and the provider is paid. Every ACP agent: a
// sign-in error (isAuth, the text, not -32000 alone) is the agent's sign-in step at start, in a turn and in readiness. One readiness
// answer waits at most 12 s (READY_WAIT_MS, under the 15 s of registry.status) and says "still starting" while the same probe goes on.
//   hermes    gated: false, "Partly supervised: file edits and risky commands ask". Every edit asks in its default mode, a command
//             only when it matches Hermes's danger patterns: its Shell cell is Partly enforced. Off until the Agents screen turns
//             it on, like OpenClaw.
//   dsh       gated: true.
//   openclaw  gated: true through its office plugin (#77, see the OpenClaw paragraph).
//   copilot   gated: false, "Partly supervised: edits and most commands ask, reads do not". enforces Edit inside. Settings is Partly
//             enforced (a write asks, a read in its folder does not). Read inside and Secret files are Not enforced in Hermes's words,
//             one line on the wall. Outside files, shell, web and MCP are Partly enforced. Off until the Agents screen turns it on.
//             Its extras are in copilot.mjs.
// ACP tools (#216): gemini (gemini --acp, partly supervised), opencode (opencode acp), kimi (kimi acp) and acp (the generic agent:
// spec.env makes its program and arguments come from OFFICE_ACP_PROGRAM (a plain name, never a path) and OFFICE_ACP_ARGS (a JSON
// list), checked in program()). All are ungated (opencode, kimi and acp Unsupervised: their docs show no approval flow over ACP that
// the office can rely on). All are in the one Security room column acp ("ACP tools", public/vocab-security.js), so there is one
// switch and one reason sentence for the four. A new agent is a new entry in AGENTS, not a file.
//
// Hermes (2026-11-04). Not from a run against the office: from Hermes Agent's source (acp_adapter/server.py, modes.py on main, read
// 2026-11-04) and a third-party report on 0.21.5 (upstream issue #139074). Hermes's initialize ignores the client's fs and terminal,
// so the office's file and terminal service never sees its writes or commands. Its edits ask over ACP in its default mode. Its
// terminal tool asks only for commands that match its danger patterns. Its 60 s limit is for edits only (#63302, a timeout reads as
// a denial). So it is ungated, and the #31682 protection in serveWrite does not cover it: the feed lines are the only signal. The
// feed says "ran a command without asking the office" when that happens. AGENTS.*.pin stays null until a real run. dsh comes from
// npm (@deepseek-ai/dsh) as dsh.cmd, which resolveExe refuses, so the office cannot start it yet. A hermes program may also be the
// React Native JS engine: readiness runs one ACP handshake (learn()), so a program that does not speak ACP is not ready.
// skillsDir() is where Hermes keeps its skills (HERMES_HOME, else ~/.hermes, then skills).
//
// Copilot CLI: see copilot.mjs. The extras its AGENTS entry names: probeArgs and logDirArg (the check's log in a temp folder of its
// own, removed after it), envDrop, probeSession (the check also opens and closes one session, because a signed-out Copilot answers
// initialize and only session/new says auth_required, -32000 "Authentication required"; it also gives the models), probeMs 60 s,
// readyTtlMs and notReadyTtlMs, modelArg (--model, from the models session/new listed), callOf (a call that had a request body keeps
// that card), argsOf (the call's own later arguments in the shape of that card, kept as c.args: recheck compares them with what the
// user saw, so a call changed after its request is declined while it waits or named in the feed after an approval, and endCall names
// a declined file from them, #125) and signIn.
//
// OpenClaw (#73, #77, ADR 0004; its facts and the live-run checklist are in openclaw.mjs). openclaw acp is a bridge to a Gateway on
// loopback that the office never starts. An entry with gateway: true is checked with probeGateway before the bridge starts, in
// readiness and at session start, and gets --url ws://127.0.0.1:<port> only when OFFICE_OPENCLAW_PORT moves it. minVersion 2026.10.10
// (the bridge's ACP agentInfo.version, OpenClaw's own release; the release the office plugin is built against): an old or unnamed
// version is not ready and start() refuses it. plugin: true and gated: true: the office plugin in the Gateway sends every tool call
// of an office session to POST /hook/openclaw, and gate(s, call, signal) holds it like every request (openclaw.mjs toolCall names it;
// the Security room rules, then the user) and answers { allow, reason }.
//   - The answer is kept by toolCallId (st.gated: { allow, pending, command, host }). pending runs from the moment the plugin sends
//     the call until the office answers, so a call OpenClaw ends while the office still decides is not one the office never got. A
//     call with no id is denied.
//   - A no also answers OpenClaw's own exec approval for the same toolCallId at once. A yes does so only when the approval shows the
//     same command, no paired device, and the host the call named if it named one. The approval carries only command and host
//     (src/acp/permission-relay.ts), so env, workdir and elevated cannot be compared; another command or host is held again, with a
//     feed line. A call of several files is held one file at a time.
//   - A completed call without the office's yes, or a failed call the office never got (endCall: the office did not serve it, and
//     OpenClaw did not mark it blocked before it ran: rawOutput.details.status blocked; the result text is never trusted), means the
//     plugin did not hold it. The turn ends with an Error that names the plugin (gateFailed) and the agent is stopped.
//   - signal aborts when the plugin stops waiting, and the hold goes (withdraw).
//   - session/new and session/load carry _meta.sessionKey = s.gatewayKey (agent-office:<uid>, or the past record's gatewayKey on
//     Reopen; a record without one, or one whose key a live session has, starts fresh).
//   - policy(fresh) gives the config check (null while the kind is blocked by a no-cost Deny or not installed). start() goes Gateway,
//     handshake, version, config (gateCheck), and only then session/new, so no prompt goes out before the config is read.
//     tools.fs.workspaceOnly off, or the plugin not loaded for this office (plugins.enabled, plugins.allow, plugins.deny,
//     plugins.entries.agent-office.enabled, its config.tokenFile = deps.tokenFile, the server's token file), or any of them
//     unreadable, is not ready and ends the session with the commands that fix it (the office does not write the config, ADR 0004).
//   - preflight() is that check without a session. The server asks it before the cost question and before a worktree (409
//     "OpenClaw cannot start: ...").
//
// Tested in test/acp-provider.test.mjs with the fake agent test/fixtures/fake-acp.mjs, and through the server in
// test/mcp-routes.test.mjs (Windows only).
//
// ACP reports no cost in the stable protocol, so the provider is paid with cost 'unknown' (owner decision Q22). The process
// calls and the timers are injected, so tests drive a fake agent (test/fixtures/fake-acp.mjs). Nothing starts on import.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn, execFile as realExecFile } from 'node:child_process';
import { resolveExe, killTree } from '../launch.mjs';
import { clip } from '../tracker.mjs';
import { providerError } from './index.mjs';
import { createLocalTools } from './local-tools.mjs';
import { createAsks } from './asks.mjs';
import { channel, within, rpcError, textOf, isAuth, REFUSED } from './acp-rpc.mjs';
import { createFiles } from './acp-files.mjs';
import { createPolicy } from './acp-policy.mjs';
import { GATEWAY_HOST, DEFAULT_GATEWAY_PORT, MIN_VERSION, PLUGIN_ID, gatewayPort, probeGateway, versionAtLeast, wantedConfig, checkConfig, configReader, officeKey, toolCall } from './openclaw.mjs';
import * as COPILOT from './copilot.mjs';

export const PROTOCOL_VERSION = 1;
// One entry per agent. program: the name resolveExe finds on PATH. args: what starts its ACP mode on stdio.
// askTimeoutMs: how long the agent waits for an approval before it moves on by itself (the office's hold is longer, so the
// feed says when the agent gave up first). features: what the agent has beyond the seam, for the page (#72); 'resume' and
// 'images' come from the handshake, and so does 'fork' (sessionCapabilities.fork): no agent declares it here, so the Fork button never shows for a build that has no session/fork. skillsHome: where the agent keeps its skills, the
// variable that moves it and the folder under the user's home (the office lists them, #72; only with the 'skills' feature). pin: the version the office was tested against (null: not tested with a real one yet).
// gated (ADR 0001): true only when the agent asks the office before every tool call that is not low risk; an agent where only
// some calls ask is ungated, with its supervision label. None of the agents has been run against the office yet (pin: null).
const HERMES_EDITS = 'Edit requests come to the office and the rule applies. Reads, and writes to its own skills and memory, run without asking.';
const HERMES_SHELL = 'Only the commands Hermes rates dangerous come to the office.';   // one line on the wall
const HERMES_READS = 'This agent reads files without asking the office.';   // Hermes and Copilot CLI: one line on the wall
const ACP_TOOLS_ASK = 'ACP tools ask the office only when their own settings say so.';   // one sentence for the wall (Gemini CLI asks by default, the others by their own config)
export const AGENTS = {
  hermes: {
    label: 'Hermes Agent', program: 'hermes', args: ['acp'],
    // From Hermes's source (acp_adapter/server.py: initialize ignores the client's fs and terminal) and upstream issue
    // #139074 (0.21.5, a client with terminal: true: a write asked, a touch ran without asking). Read again on main
    // 6c2bf4b (2026-11-05, review M1): in its default mode every write_file and patch asks (acp_adapter/edit_approval.py
    // maybe_require_edit_approval, kind "edit"); its terminal tool asks only for a command that matches DANGEROUS_PATTERNS
    // (tools/approval.py check_all_command_guards, kind "execute"), and none when yolo or approvals.mode off is set. The
    // office holds every session/request_permission, so the label names both.
    gated: false, supervision: 'Partly supervised: file edits and risky commands ask',
    // The Security room cells (security.mjs enforcement): an edit request inside the worktree comes through
    // session/request_permission, so the office's rule decides it. Reads do not ask. An edit outside the worktree or of a
    // settings file asks too, but Hermes writes its own skills and memory (under .hermes) with no request: partly enforced.
    // So is a command: only the ones Hermes rates dangerous come to the office.
    enforces: ['edit-inside'],
    unenforced: { 'read-inside': HERMES_READS, secrets: HERMES_READS },
    partly: { 'files-outside': HERMES_EDITS, settings: HERMES_EDITS, shell: HERMES_SHELL },
    askTimeoutMs: 60_000, // Hermes issue #63302: a fixed 60 s timeout on edit approval (command approval has its own setting)
    features: ['skills', 'memory'], skillsHome: { env: 'HERMES_HOME', dir: '.hermes' }, pin: null,
    needs: ['Install Hermes Agent so that hermes.exe is on the PATH, then run hermes acp --check in a terminal.'],
  },
  dsh: {
    label: 'DeepSeek Harness', program: 'dsh', args: ['--profile', 'acp'],
    gated: true, // research (2026-11-04): it sends its tool approvals over ACP and fails closed when no client answers
    askTimeoutMs: null,
    // dsh-acp lists forks, deletion and transcript replay as unsupported; fork would show only if its handshake said it.
    features: ['reason', 'teams', 'schedules'], pin: null, // a developer preview: pin the version tested on the owner's PC
    needs: ['Install DeepSeek Harness so that dsh.exe is on the PATH, and set DEEPSEEK_API_KEY.'],
  },
  // OpenClaw (#73, #77, ADR 0001). `openclaw acp` is a bridge to a Gateway that already runs on loopback (providers/openclaw.mjs);
  // the office never starts or stops that Gateway. Its own approvals cover shell commands only, so the office holds every call
  // another way: the Agent Office plugin (src/integrations/openclaw-plugin) runs in the Gateway, and its before_tool_call handler
  // sends every tool call of an office session to POST /hook/openclaw (gate() below) and waits; no answer means deny. The office
  // marks its sessions by the Gateway session key it gives session/new (openclaw.mjs officeKey). So the agent is gated, and a
  // session starts only when the Gateway config loads that plugin for this office (gateCheck; the office only reads it).
  // gateway: check the Gateway before the bridge starts. plugin: the gate above. minVersion: the release the plugin is built
  // against (2026.10.10: before_tool_call runs on the tool path, src/agents/agent-tools.before-tool-call*.ts; the 2026.1 copy
  // on the owner's PC has no caller outside src/plugins/).
  openclaw: {
    label: 'OpenClaw', program: 'openclaw', args: ['acp'],
    gated: true, plugin: true,
    askTimeoutMs: null, gateway: true, minVersion: MIN_VERSION,
    contextUsage: false, // its usage_update is Gateway session totals, not the tokens in context (#164): the Context bar stays unknown
    features: [], pin: null, // not run against a real Gateway yet: OpenClaw on the owner's PC (2026.1.29) is too old to start
    needs: ['Install OpenClaw so that openclaw.exe is on the PATH, then start its Gateway.'], // a .cmd shim from npm is not accepted (resolveExe)
  },
  // GitHub Copilot CLI (#22, ADR 0001). From 1.0.105 (copilot help config, permissions, environment; the signed-out handshake in
  // test/fixtures/copilot-acp.json). Its default permission mode ("manual") asks before writes and commands and approves
  // read-only requests by itself: it reads files in its folder, and runs a command it rates read-only, without asking. Hooks in
  // its own settings or in the repository (.github/hooks) run commands without asking, and the URLs its settings allow
  // (allowedUrls) open without asking. So it is ungated, off until the user turns it on on the Agents screen.
  // The extras ACP does not carry (providers/copilot.mjs): probeArgs and logDirArg (the readiness check writes its log to a
  // temp folder of its own, removed after the check); envDrop (the switches that approve calls by themselves, any case);
  // probeSession (a signed-out Copilot answers initialize, so the check opens and closes one session: session/new answers
  // -32000 "Authentication required", ACP auth_required, and gives the models; each check leaves an empty session folder in
  // ~/.copilot/session-state that Copilot cannot delete, so readyTtlMs is an hour); probeMs (a cold start can take more than
  // 10 s); modelArg (the model the Open dialog picks, from the models session/new listed); callOf (its permission requests
  // carry its own request body, not the tool's arguments); argsOf (the tool's own arguments of a later update, read against
  // that body, so a call changed after the request is seen, #125); signIn (the step for a sign-in error).
  copilot: {
    label: 'Copilot CLI', program: 'copilot', args: COPILOT.SESSION_ARGS,
    probeArgs: COPILOT.PROBE_ARGS, logDirArg: COPILOT.LOG_DIR_ARG, envDrop: COPILOT.SELF_APPROVE,
    probeSession: true, probeMs: 60_000, readyTtlMs: 60 * 60_000, notReadyTtlMs: 10_000, modelArg: '--model', modelRe: COPILOT.MODEL_RE,
    callOf: COPILOT.requestCall, argsOf: COPILOT.argsCall, signIn: COPILOT.SIGN_IN,
    gated: false, supervision: 'Partly supervised: edits and most commands ask, reads do not',
    // The Security room cells (security.mjs enforcement). A write asks (session/request_permission), also of a settings file.
    // Reads in its folder do not ask, a secret file there too: Not enforced, with Hermes's words, so the wall says it once for
    // both. (It asks before a read outside its folder, but a Deny on Secret files cannot hold the ones inside.) The Settings row
    // is only Partly enforced: risk.mjs actionOf puts a read of .git/config or .github/hooks in it, and that read asks nothing.
    enforces: ['edit-inside'],
    unenforced: { 'read-inside': HERMES_READS, secrets: HERMES_READS },
    partly: {
      settings: 'Writes ask. Reads in its folder do not.',
      'files-outside': 'It asks, except in folders its own settings trust (trustedFolders).',
      shell: 'It asks, except for a command it rates read-only. Hooks in its settings or the repository run commands without asking.',
      web: 'It asks, except for the URLs its own settings allow (allowedUrls).',
      mcp: 'It asks, except for an MCP tool it rates read-only.',
    },
    askTimeoutMs: null, features: [], pin: null, // only the signed-out handshake of 1.0.105 was recorded: no signed-in run yet
    needs: [COPILOT.INSTALL], // the native copilot.exe: an npm copilot.cmd is not accepted (resolveExe)
  },
  // The ACP tools of Paperclip's adapter list (#216, ADR 0010). Read from each tool's own docs on 2026-11-06, not from a run: no tool
  // was installed on the owner's PC, so pin stays null. Paperclip starts the same commands (adapters gemini-local, kimi-local and
  // acpx-local). None of the four is gated, so each is off until the Agents screen turns it on and runs only in a room of its own
  // (ADR 0001). They share one Security room column, "ACP tools" (public/vocab-security.js), so a reason there holds for all four.
  // Gemini CLI (`gemini --acp`, docs/cli/acp-mode.md): it sends session/request_permission for the tool calls its approval mode
  // asks about (an MCP tool names its server in toolCall._meta), the client can change that mode with session/set_mode, and its file
  // reads and writes go through the client. Its own settings can still allow a tool, so edits, commands and MCP tools are partly
  // enforced, and nothing is claimed for reads.
  gemini: {
    label: 'Gemini CLI', program: 'gemini', args: ['--acp'],
    gated: false, supervision: 'Partly supervised: tool calls ask unless its approval mode allows them',
    partly: { 'edit-inside': ACP_TOOLS_ASK, 'files-outside': ACP_TOOLS_ASK, shell: ACP_TOOLS_ASK, mcp: ACP_TOOLS_ASK },
    askTimeoutMs: null, features: [], pin: null,
    needs: ['Install Gemini CLI so that gemini.exe is on the PATH (npm i -g @google/gemini-cli makes gemini.cmd, which the office does not accept), then run gemini once in a terminal to sign in.'],
  },
  // OpenCode (`opencode acp`, opencode.ai/docs/acp): its docs say it works over ACP as in the terminal, and give no approval flow for
  // ACP. In its permission settings most tools default to allow (only .env reads default to ask), so the office cannot rely on a
  // request: Unsupervised. A tool the user set to ask in opencode.json does reach the office as a request and is held.
  opencode: {
    label: 'OpenCode', program: 'opencode', args: ['acp'],
    gated: false, supervision: 'Unsupervised: its own permission settings decide which calls ask',
    askTimeoutMs: null, features: [], pin: null,
    needs: ['Install OpenCode so that opencode.exe is on the PATH (an npm install makes opencode.cmd, which the office does not accept), then run opencode auth login in a terminal.'],
  },
  // Kimi CLI (`kimi acp`, moonshotai.github.io/kimi-cli): a multi-session ACP server; signed out it answers AUTH_REQUIRED (-32000) and
  // wants `kimi login`. Its docs do not say how approvals work over ACP, so nothing is assumed: Unsupervised.
  kimi: {
    label: 'Kimi CLI', program: 'kimi', args: ['acp'],
    gated: false, supervision: 'Unsupervised: the office has not confirmed which calls it asks about',
    askTimeoutMs: null, features: [], pin: null,
    needs: ['Install Kimi CLI so that kimi.exe is on the PATH (uv tool install kimi-cli), then run kimi login in a terminal.'],
  },
  // Any other ACP agent (Paperclip's acpx-local takes an agentCommand): the owner names the program in OFFICE_ACP_PROGRAM (a plain
  // program name found on the PATH, started by absolute path, no shell) and its arguments in OFFICE_ACP_ARGS (a JSON list of
  // strings). The office knows nothing about its tools, so it is Unsupervised. env: where program and args come from.
  acp: {
    label: 'ACP agent', program: null, args: [], env: { program: 'OFFICE_ACP_PROGRAM', args: 'OFFICE_ACP_ARGS' },
    gated: false, supervision: 'Unsupervised: the office does not know which calls this agent asks about',
    askTimeoutMs: null, features: [], pin: null,
    needs: ['Set OFFICE_ACP_PROGRAM to the name of an agent that speaks ACP on stdio, and OFFICE_ACP_ARGS to its arguments as a JSON list, then start the office again. Example: OFFICE_ACP_PROGRAM=myagent, OFFICE_ACP_ARGS=["serve","--stdio"].'],
  },
  // OpenAI Codex (#217). Through codex-acp, the ACP bridge Paperclip's codex-local adapter starts for its ACP engine
  // (packages/adapters/codex-local/src/server/acp.ts; MIT, credit in NOTICE.md); `codex-acp` takes no arguments there. It sends
  // session/request_permission, which the office holds like any ACP request, but how many of Codex's own calls ask is not known:
  // the bridge was not run against the office, and none is installed on the owner's PC. So it is ungated and "Unsupervised",
  // off until the user turns it on on the Agents screen, in a room of its own (ADR 0001). It shares the CLI tools column.
  codex: {
    label: 'Codex', program: 'codex-acp', args: [],
    gated: false, supervision: 'Unsupervised: some calls may ask the office, but Codex decides which',
    askTimeoutMs: null, features: [], pin: null,
    needs: ['Install the Codex ACP bridge so that codex-acp.exe is on the PATH, then sign in with codex login in a terminal.'],
  },
};

const INIT_MS = 20_000;          // the handshake and the first session
const PROBE_MS = 10_000;         // readiness: one handshake
const POLICY_MS = 20_000;        // OpenClaw: reading its config before a session starts
const PROBE_TTL_MS = 60_000;     // what a probe learned is good for this long
const READY_WAIT_MS = 12_000;    // one readiness answer waits this long (under the 15 s of registry.status); a probe that runs
                                 // on (spec.probeMs) is "still starting", and the next answer waits for the same probe
const CANCEL_MS = 10_000;        // after session/cancel, the turn ends here even when the agent never answers
const MAX_ATTACH_CHARS = 9_000_000;
const STOP_WORDS = {
  max_tokens: 'The agent reached its token limit.',
  max_turn_requests: 'The agent used all the steps of one turn.',
  refusal: 'The agent refused to go on.',
};


/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {string} deps.kind a key of AGENTS.
 * @param {Function} [deps.spawn] child_process.spawn.  @param {Function} [deps.execFile] child_process.execFile, for taskkill.
 * @param {(name: string) => string} [deps.exe] the program resolver: an absolute path, or it throws (launch.mjs resolveExe).
 * @param {object} [deps.env] the environment for the agent (process.env).
 * @param {(root: string) => object} [deps.makeTools] createLocalTools.
 * @param {Function} [deps.setTimer] setTimeout.  @param {Function} [deps.clearTimer] clearTimeout.
 * @param {() => number} [deps.now] the clock.  @param {() => string} [deps.makeId] ids for messages and terminals.
 * @param {string} [deps.probeDir] the folder readiness starts the agent in (the temp folder).
 * @param {number} [deps.probeMs] the longest one readiness probe runs (spec.probeMs, else PROBE_MS).
 * @param {number} [deps.readyWaitMs] how long one readiness answer waits for a probe that runs on (READY_WAIT_MS).
 * OpenClaw only (spec.gateway): @param {(port: number) => Promise<boolean>} [deps.gatewayUp] is a Gateway listening (probeGateway);
 * @param {(path: string) => Promise<object>} [deps.readConfig] reads one OpenClaw config key (configReader);
 * @param {string} [deps.tokenFile] the office's token file: the OpenClaw plugin must read this one (its config is checked).
 */
export function createAcp(deps) {
  const spec = AGENTS[deps.kind];
  if (!spec) throw new Error(`Unknown ACP agent: ${deps.kind}`);
  const kind = deps.kind, label = spec.label;
  const events = deps.events;
  const spawn = deps.spawn || realSpawn;
  const execFile = deps.execFile || realExecFile;
  const env = deps.env || process.env;
  const exe = deps.exe || ((name) => resolveExe(name, env));
  const makeTools = deps.makeTools || ((root) => createLocalTools(root));
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const now = deps.now || Date.now;
  const makeId = deps.makeId || (() => crypto.randomBytes(5).toString('hex'));
  const probeDir = deps.probeDir || os.tmpdir();
  const homedir = deps.homedir || os.homedir;
  // OpenClaw: a Gateway the office never starts, and a config it only reads.
  const port = gatewayPort(env);
  const gatewayUp = deps.gatewayUp || ((p) => probeGateway({ port: p }));
  const readConfig = deps.readConfig || configReader({ exe, execFile, env });
  const tokenFile = deps.tokenFile || null;
  // blocked(): why the Security room does not let this agent kind run now (its Agents screen), or null. It is the server's
  // security.mjs openRefusal, so the provider keeps no switch of its own.
  const blocked = deps.blocked || (() => null);
  // The generic ACP agent (spec.env): its program and arguments come from the owner's environment, read at each call.
  const programName = () => {
    if (!spec.env) return spec.program;
    const v = env[spec.env.program];
    if (!v) throw providerError(409, `The office has no ${label} to start: set ${spec.env.program} to a program name.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) throw providerError(409, `${spec.env.program} must be a plain program name found on the PATH, not a path or a command line.`);
    return v;
  };
  const argsNow = () => {
    if (!spec.env) return spec.gateway && port !== DEFAULT_GATEWAY_PORT ? [...spec.args, '--url', `ws://${GATEWAY_HOST}:${port}`] : spec.args;
    let a = [];
    if (env[spec.env.args]) {
      try { a = JSON.parse(env[spec.env.args]); } catch { a = null; }
      if (!Array.isArray(a) || !a.every((x) => typeof x === 'string')) throw providerError(409, `${spec.env.args} must be a JSON list of strings, for example ["serve","--stdio"].`);
    }
    return a;
  };
  const probeMs = deps.probeMs || spec.probeMs || PROBE_MS;
  const readyWaitMs = deps.readyWaitMs || READY_WAIT_MS;
  // The agent's environment: the caller's, without the switches that let the agent approve its own calls (spec.envDrop; Windows
  // names are not case-sensitive, so neither is the match).
  const dropped = new Set((spec.envDrop || []).map((k) => k.toUpperCase()));
  const envOf = (extra = {}) => Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([k]) => !dropped.has(k.toUpperCase())));
  // The models the agent listed in its last session/new (spec.modelArg only): [{ id, label }].
  let models = [];
  function learnModels(r) {
    const list = spec.modelArg && r && r.models && Array.isArray(r.models.availableModels) ? r.models.availableModels : null;
    if (list) models = list.filter((m, i) => m && typeof m.modelId === 'string' && spec.modelRe.test(m.modelId) && list.findIndex((x) => x && x.modelId === m.modelId) === i).slice(0, 60).map((m) => ({ id: m.modelId, label: clip(String(m.name || m.modelId), 60) }));
  }
  /** @type {Map<string, object>} uid -> the agent state of an open session */
  const agents = new Map();
  // What the agent said at its last handshake (a probe or a session): its capabilities and version.
  // auth: the agent answered, but it is not signed in (spec.probeSession: session/new said auth_required).
  let learned = { caps: null, version: null, at: 0, ok: false, why: '', auth: false };

  // The absolute path of the program, or a status error the user can act on (409).
  function program() {
    const name = programName(); argsNow();   // the generic entry: a bad name or argument list is its own 409
    try { return exe(name); } catch (e) {
      if (e.code === 'SCRIPT_INSTALL') throw providerError(409, `The office needs ${name}.exe. It found only ${e.file} (a script install). The office starts programs without a shell.`);
      throw providerError(409, `The office cannot find ${label}: ${name}.exe is not on the PATH. Install it, then try again.`);
    }
  }
  function remember(init) {
    const caps = init && typeof init.agentCapabilities === 'object' && init.agentCapabilities ? init.agentCapabilities : {};
    learned = { caps, version: String(init?.agentInfo?.version || '') || null, at: now(), ok: true, why: '', auth: false };
  }
  // The probe's handshake. With spec.probeSession it also opens one session in the probe folder and closes it: an agent that is
  // not signed in answers initialize, and only session/new says so. No prompt goes out.
  async function probeTalk(rpc) {
    const init = await handshake(rpc);
    if (!spec.probeSession) return init;
    remember(init);
    let r;
    try { r = await rpc.request('session/new', { cwd: probeDir, mcpServers: [] }); } catch (e) {
      if (isAuth(e)) { const err = new Error(spec.signIn || textOf(e)); err.auth = true; throw err; }
      throw new Error(`it did not open a session: ${clip(textOf(e), 200)}`);
    }
    learnModels(r);
    if (r && typeof r.sessionId === 'string' && init?.agentCapabilities?.sessionCapabilities?.close) {
      await within(rpc.request('session/close', { sessionId: r.sessionId }), 3000, 'close', setTimer, clearTimer).catch(() => {});
    }
    return init;
  }
  // readiness and learn(): one handshake with the agent in a temp folder, then it stops. A failure is kept like an answer.
  let probing = null;
  async function probe() {
    let file;
    try { file = program(); } catch (e) { learned = { caps: null, version: null, at: now(), ok: false, why: e.message, auth: false }; return; }
    // spec.logDirArg: the probe's log goes to a temp folder of its own, removed when the probe's agent has stopped.
    let logDir = null;
    if (spec.logDirArg) { try { logDir = fs.mkdtempSync(path.join(probeDir, `agent-office-${kind}-check-`)); } catch { logDir = null; } }
    const dropLog = () => { if (logDir) { try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* the agent still holds it */ } } };
    let child;
    try {
      child = spawn(file, [...(spec.probeArgs || argsNow()), ...(logDir ? [spec.logDirArg, logDir] : [])], { cwd: probeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: envOf() });
    } catch (e) {
      dropLog();
      learned = { caps: null, version: null, at: now(), ok: false, why: textOf(e), auth: false };
      return;
    }
    child.once?.('exit', dropLog);
    let err = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => { err = (err + d).slice(-600); });
    const rpc = channel(child, { onRequest: () => { throw rpcError(-32601, 'Method not found'); }, onNotify: () => {} });
    const gone = new Promise((_r, reject) => {
      child.on('error', (e) => reject(e));
      child.on('exit', (code) => reject(new Error(clip(err.trim(), 300) || `it stopped with exit code ${code}`)));
    });
    try {
      remember(await within(Promise.race([probeTalk(rpc), gone]), probeMs, 'no answer in time', setTimer, clearTimer));
    } catch (e) {
      // A sign-in error keeps what the handshake said (the version); any other failure keeps nothing.
      learned = e.auth ? { ...learned, at: now(), ok: false, why: textOf(e), auth: true } : { caps: null, version: null, at: now(), ok: false, why: textOf(e), auth: false };
    } finally {
      gone.catch(() => {});
      rpc.fail('probe over');
      if (child.pid) killTree(child.pid, execFile);
    }
  }
  const handshake = (rpc) => rpc.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'agent-office', title: 'Agent Office', version: '0.1.0' },
  });

  // ----- OpenClaw: the Gateway and its config (providers/openclaw.mjs) -----
  // Why the agent cannot start now, or null: the Security room does not let it run (blocked), or no Gateway answers. The office
  // only looks: it never starts, stops or restarts the Gateway.
  async function notReady() {
    const off = blocked();
    if (off) return off;
    if (!spec.gateway) return null;
    return (await gatewayUp(port)) ? null : `Not ready: start the ${label} Gateway. It should listen on ${GATEWAY_HOST}:${port}. The office never starts or stops it.`;
  }
  // What the Gateway config says, read-only: null for an agent with no config, one that is off (blocked: nothing is read then)
  // or one that is not installed. Kept for a minute; fresh: read it again now. A read that does not finish in POLICY_MS counts
  // as unreadable, never as a pass.
  let policyNow = null;
  async function policy(fresh = false) {
    if (!spec.gateway || blocked()) return null;
    try { program(); } catch { return null; }
    if (!fresh && policyNow && now() - policyNow.at < PROBE_TTL_MS) return policyNow.value;
    const w = wantedConfig({ tokenFile });
    let config;
    try { config = await within(checkConfig(w, readConfig), POLICY_MS, 'reading its config took too long', setTimer, clearTimer); } catch (e) {
      config = await checkConfig(w, async () => ({ state: 'unreadable', why: textOf(e) }));
    }
    policyNow = { at: now(), value: { config, gaps: w.gaps } };
    return policyNow.value;
  }
  // The settings that are off, in words and with the command that turns each on. A setting the office could not read is never
  // a pass: it says it cannot confirm.
  // warn: true gives only the settings that are not preconditions (openclaw.mjs wantedConfig warn), false only the others.
  function configNotes(c, warn = false) {
    const notes = [];
    for (const x of c.settings) {
      if (x.ok || x.warn !== warn) continue;
      const run = x.fix ? ` Run: ${x.fix}` : '';
      if (x.have === 'unknown') notes.push(`the office could not read ${x.path}, so it cannot confirm it.`);
      else if (x.note) notes.push(`${x.note}${run}`);
      else if (x.path === 'tools.fs.workspaceOnly') notes.push(`${x.path} is ${x.have}, so its file tools can reach outside the worktree.${run}`);
      else if (x.path === 'tools.exec.host') notes.push(`${x.path} is ${x.have}, so a command that names no host runs on a paired device, outside the worktree.${run}`);
      else notes.push(`${x.path} is ${x.have} (wanted: ${typeof x.value === 'string' ? x.value : JSON.stringify(x.value)}), so the ${PLUGIN_ID} plugin does not send its tool calls to this office.${run}`);
    }
    return notes;
  }
  // Both are preconditions: workspace-only (spec #73: "start it with tools.fs.workspaceOnly on"), and the plugin that sends
  // every tool call to the office (#77): without it nothing would ask, and the agent is gated only through it. The office
  // cannot write the config (the Gateway is shared, Q40; the office only reads, ADR 0004), so it does not start the agent while
  // a setting is off or unknown. Returns the text that says why, with each command that fixes it, or null when all are on.
  const NO_WRITE = ' The office does not change the OpenClaw config. Fix it, then open the session again.';
  function gateBlock(c) {
    const notes = configNotes(c);
    return notes.length ? notes.join(' ') + NO_WRITE : null;
  }

  // ----- reporting -----
  // Every report goes through emit(): after close, nothing more is reported (the seam's timing rule 2).
  const emit = (st, fn) => (st.closed ? undefined : fn());
  // A message the user sent while a turn ran comes back as the answer of a hook. ACP has no way to add it to a turn that
  // runs, so it waits in st.notes and goes to the agent as the next prompt of the same turn.
  const noteOf = (back) => back?.hookSpecificOutput?.additionalContext || '';
  function hook(s, st, p) {
    const back = emit(st, () => events.hook(s, p));
    if (noteOf(back) && p.hook_event_name !== 'UserPromptSubmit') st.notes.push(noteOf(back));
    return back;
  }

  // The text of the agent's message so far goes out as one assistant message when a tool starts or the turn ends.
  function flushText(s, st) {
    if (!st.text) return;
    const text = st.text;
    st.text = '';
    st.last = text;
    emit(st, () => events.stream(s, { type: 'assistant', message: { id: 'm' + makeId(), content: [{ type: 'text', text }] } }));
  }
  function onText(s, st, u) {
    const t = u.content && u.content.type === 'text' ? String(u.content.text || '') : '';
    if (!t) return;
    if (u.messageId && st.msgId && u.messageId !== st.msgId) flushText(s, st);
    if (u.messageId) st.msgId = u.messageId;
    if (!st.text) emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'message_start' } }));
    st.text += t;
    emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } }));
  }

  // ----- approvals -----
  // Ask the office and wait: providers/asks.mjs (the Security room rules answer at once, else the user; withdraw, cancel all).
  // done(verdict, why) gets 'allow', 'deny', 'cancel' or 'withdraw', and why the office refused (a Deny rule). A request of
  // the agent that is withdrawn gets reject once, never cancelled: in ACP that means the turn was cancelled.
  const asks = createAsks({ events, setTimer, clearTimer });
  const { withdraw } = asks;
  // The permission policy (acp-policy.mjs) and the file and terminal service (acp-files.mjs) share the session state `st`.
  const { track, recheck, openCall, endCall, onPermission } = createPolicy({
    spec, label, events, emit, hook, asks,
    killChild: (st) => { if (!st.dead && st.child.pid) killTree(st.child.pid, execFile); }, // the exit ends the session
  });
  const files = createFiles({ events, asks, emit, makeId });

  function onUpdate(s, st, params) {
    if (st.closed) return; // a line that comes in while the agent stops: nothing after close (seam timing rule 2)
    if (params.sessionId !== st.sid || st.loading) return; // a loaded session replays its past: the office has those replies
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': onText(s, st, u); break;
      case 'tool_call': case 'tool_call_update': {
        if (u.sessionUpdate === 'tool_call') flushText(s, st);
        const c = track(st, u);
        if (!c) break;
        recheck(s, st, c);
        openCall(s, st, c);
        if (u.status === 'completed' || u.status === 'failed') endCall(s, st, c, u);
        break;
      }
      case 'plan': {
        const todos = (Array.isArray(u.entries) ? u.entries : []).map((e) => ({ content: String(e?.content || ''), status: e?.status }));
        hook(s, st, { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_use_id: null, tool_input: { todos } });
        break;
      }
      case 'usage_update':
        // Token totals (used, size) go to the stats. The cost the spec allows here is not read: the session stays "unknown".
        // used is the tokens in context for an agent that follows the spec (#164); OpenClaw sends session totals (contextUsage: false).
        emit(st, () => events.stream(s, spec.contextUsage === false ? { type: 'usage', used: u.used } : { type: 'usage', used: u.used, ctx: { used: u.used, size: u.size } }));
        break;
      default: break; // thoughts, commands, modes: not shown yet
    }
  }

  // ----- a turn -----
  // The token counts an agent puts in the answer of a prompt (inputTokens, outputTokens, cachedReadTokens, or only totalTokens). They go
  // to the tracker as the usage of one assistant message with its own id, so each turn counts once. No usage, nothing reported.
  function reportUsage(s, st, r) {
    const u = r && typeof r.usage === 'object' && r.usage ? r.usage : null;
    const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    if (!u) return;
    const out = n(u.outputTokens), cached = n(u.cachedReadTokens);
    const input = n(u.inputTokens) || Math.max(0, n(u.totalTokens) - out);
    if (!input && !out) return;
    emit(st, () => events.stream(s, { type: 'assistant', message: { id: `acp-${makeId()}`, usage: { input_tokens: Math.max(0, input - cached), output_tokens: out, cache_read_input_tokens: cached }, content: [] } }));
  }

  async function runTurn(s, st, item) {
    st.busy = true;
    st.interrupted = false;
    st.last = '';
    const back = hook(s, st, { hook_event_name: 'UserPromptSubmit', prompt: item.text });
    // Messages a stopped turn took from the inbox but could not deliver go first, then any that wait now.
    const notes = [...st.carry.splice(0), noteOf(back)].filter(Boolean);
    let prompt = notes.length ? [...item.prompt, { type: 'text', text: notes.join('\n\n') }] : item.prompt;
    let failure = null;
    try {
      for (;;) {
        st.cancelled = new Promise((resolve) => { st.endCancel = resolve; });
        const r = await Promise.race([st.rpc.request('session/prompt', { sessionId: st.sid, prompt }), st.cancelled]);
        flushText(s, st);
        if (st.closed || st.interrupted || st.gateFail) break;
        reportUsage(s, st, r);
        const why = STOP_WORDS[r?.stopReason];
        if (why) { failure = why; break; }
        if (st.notes.length) { prompt = [{ type: 'text', text: st.notes.splice(0).join('\n\n') }]; continue; }
        const stop = hook(s, st, { hook_event_name: 'Stop', last_assistant_message: st.last });
        if (stop && stop.decision === 'block' && stop.reason) { prompt = [{ type: 'text', text: stop.reason }]; continue; }
        break;
      }
    } catch (e) {
      flushText(s, st);
      if (!st.interrupted && !st.closed) {
        if (isAuth(e)) learned.at = 0; // readiness asks again
        failure = isAuth(e) ? `${label} is not signed in. ${spec.signIn || 'Sign in, then send the message again.'}` : `${label}: ${textOf(e)}`;
      }
    }
    finishTurn(s, st, failure);
  }

  function finishTurn(s, st, failure) {
    st.busy = false;
    st.endCancel = null;
    asks.cancelAll(st); // an agent that ended its turn waits for nothing
    st.grants.clear(); st.denied.clear(); st.askFirst.clear(); st.wrote.clear(); st.gated.clear(); st.deniedVague = false;
    st.carry.push(...st.notes.splice(0)); // the inbox gave them up already: they go with the next prompt
    if (st.closed) return;
    if (st.gateFail) { events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: st.gateFail }); return; }
    if (st.interrupted) events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Stopped' });
    else if (failure) events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: failure });
    else events.stream(s, { type: 'result', subtype: 'success', is_error: false, result: st.last });
    // No total_cost_usd: ACP reports no cost, so the session's cost stays unknown, never $0.00.
    const next = st.queue.shift();
    if (next) setImmediate(() => runTurn(s, st, next));
  }

  // ----- requests from the agent -----
  function onRequest(s, st, method, params) {
    if (st.closed) throw rpcError(REFUSED, 'The session closed.');
    if (params.sessionId !== st.sid) throw rpcError(-32602, 'Unknown session.');
    flushText(s, st); // what the agent said before a request shows with it (a request may wait for the user)
    if (method === 'session/request_permission') return onPermission(s, st, params);
    if (files.handles(method)) return files.serve(s, st, method, params);
    throw rpcError(-32601, `Method not found: ${method}`);
  }

  // One call of the office plugin, held like every request (gate): { allow, reason }. signal: the plugin stopped waiting.
  function holdOne(s, st, m, signal) {
    return new Promise((resolve) => {
      const held = asks.hold(s, st, { tool_name: m.tool_name, tool_input: m.tool_input, ask_reason: m.reason || null }, (v, why) => {
        if (v === 'allow') return resolve({ allow: true, reason: '' });
        resolve({ allow: false, reason: why || (v === 'cancel' ? 'The turn was stopped in Agent Office.' : v === 'withdraw' ? `${label} stopped waiting for the answer.` : 'Declined in Agent Office.') });
      }, { firm: m.firm === true });
      if (held && signal) {
        if (signal.aborted) withdraw(s, st, held, `${label} stopped waiting for your answer.`);
        else signal.addEventListener('abort', () => withdraw(s, st, held, `${label} stopped waiting for your answer.`), { once: true });
      }
    });
  }

  // ----- the session -----
  // OpenClaw, before the session exists (so before any prompt goes out): the version the plugin is built against, the file tools
  // in the worktree, and the plugin loaded for this office, so every tool call of the session asks the office (#77). The
  // Gateway config is only read; the office never writes it. Returns the config check, for the feed line after the start.
  async function gateCheck() {
    if (spec.minVersion && !versionAtLeast(learned.version, spec.minVersion)) {
      throw new Error(`${label} ${learned.version || '(unknown version)'} is older than ${spec.minVersion}, or does not say its version. The office plugin needs ${spec.minVersion} or later to hold its tool calls. Update ${label}.`);
    }
    const p = await policy(true);
    if (!p) throw new Error(`the office could not check the ${label} config.`);
    const block = gateBlock(p.config);
    if (block) throw new Error(block);
    return p.config;
  }
  function announce(s, st, c) {
    emit(st, () => events.feed(s, 'start', `${label} config: workspace-only is on, and the ${PLUGIN_ID} plugin sends every tool call to the office.`));
    for (const n of configNotes(c, true)) emit(st, () => events.feed(s, 'wait', `${label}: ${n}`));
  }
  // The Gateway session key of an office session (#77): the plugin knows the session by it. A reopened session keeps the key of
  // its past record (session/load rebinds the same Gateway session); a new one gets a key with its own uid.
  // Two live sessions never share a key: the plugin's calls would show on the first one. So a second Reopen of the same past
  // record, while the first is open, starts a new conversation with its own key.
  function gatewayKeyOf(s, o) {
    const past = o.prior && typeof o.prior.gatewayKey === 'string' ? o.prior.gatewayKey : null;
    if (!o.resume || !past) return { key: officeKey(s.uid), taken: false };
    const taken = [...agents.values()].some((x) => x.session !== s && !x.closed && !x.dead && x.session?.gatewayKey === past);
    return taken ? { key: officeKey(s.uid), taken: true } : { key: past, taken: false };
  }

  async function start(s, st, o) {
    const down = await notReady();
    if (down) throw new Error(down);
    const init = await within(handshake(st.rpc), INIT_MS, 'it did not answer the handshake in time', setTimer, clearTimer);
    remember(init);
    if (init?.protocolVersion !== PROTOCOL_VERSION) throw new Error(`it speaks ACP version ${init?.protocolVersion}; the office speaks version ${PROTOCOL_VERSION}`);
    st.caps = learned.caps;
    const gate = spec.gateway ? await gateCheck() : null; // before session/new: nothing runs while this is open
    if (st.closed) return;
    // spec.plugin: the session key the plugin reads goes with session/new and session/load. A past record without one (from
    // before #77) cannot be held, so it starts a new conversation instead.
    const gk = spec.plugin ? gatewayKeyOf(s, o) : { key: null, taken: false };
    const key = gk.key;
    const meta = key ? { _meta: { sessionKey: key } } : {};
    if (key) s.gatewayKey = key;
    let r, sid;
    if (o.resume && st.caps.loadSession === true && (!spec.plugin || (o.prior?.gatewayKey && !gk.taken))) {
      // The agent replays the past conversation as updates before it answers. The office already has those replies
      // (the past record), so the replay is not shown again.
      st.loading = true;
      r = await within(st.rpc.request('session/load', { sessionId: String(o.resume), cwd: s.cwd, mcpServers: [], ...meta }), INIT_MS, 'it did not load the past session in time', setTimer, clearTimer);
      st.loading = false;
      sid = String(o.resume);
    } else if (o.fork) {
      // A copy of a past session (#72). The agent replays the past as updates of the new session, before it answers; the office
      // has those replies already (the past record), so the replay is not shown again.
      st.loading = true;
      r = await within(st.rpc.request('session/fork', { sessionId: String(o.fork), cwd: s.cwd, mcpServers: [], ...meta }), INIT_MS, 'it did not fork the past session in time', setTimer, clearTimer);
      st.loading = false;
      sid = r && r.sessionId;
    } else {
      // Before the session id: the office keeps the past record of a conversation that did not continue.
      if (o.resume) emit(st, () => events.fresh(s, gk.taken ? `That ${label} conversation is open in another session. A new session started.` : `${label} cannot load a past session now. A new session started.`));
      r = await within(st.rpc.request('session/new', { cwd: s.cwd, mcpServers: [], ...meta }), INIT_MS, 'it did not start a session in time', setTimer, clearTimer);
      sid = r && r.sessionId;
    }
    if (typeof sid !== 'string' || !sid) throw new Error('it gave no session id');
    st.sid = sid;
    learnModels(r);
    // The session id first (the tracker saves the session when its sid arrives), then the bot sits down at rest.
    emit(st, () => events.stream(s, { type: 'system', subtype: 'init', session_id: sid, model: r.models?.currentModelId || (spec.modelArg && o.model && spec.modelRe.test(String(o.model)) ? String(o.model) : null) || null, permissionMode: 'default' }));
    if (gate) announce(s, st, gate);
    // With a first prompt waiting, the turn starts at once instead (no flicker from at rest to working).
    if (!st.queue.length) hook(s, st, { hook_event_name: 'SessionStart', source: o.resume ? 'resume' : 'startup' });
    const next = st.queue.shift();
    if (next && !st.closed) runTurn(s, st, next);
  }

  function promptOf(st, text, attachments) {
    const blocks = [];
    let total = 0;
    for (const a of attachments.slice(0, 6)) {
      const data = String(a.data || '');
      total += data.length;
      if (total > MAX_ATTACH_CHARS) throw providerError(413, 'The attachments are too large. The limit is about 6 MB in total.');
      const mime = String(a.mime || ''), name = String(a.name || 'file').slice(0, 80);
      if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
        if (!st.caps) throw providerError(409, `${label} is still starting. Send the image again in a moment.`);
        if (st.caps.promptCapabilities?.image !== true) throw providerError(415, `${label} takes no images.`);
        blocks.push({ type: 'image', mimeType: mime, data });
      } else if (/^text\//.test(mime) || /\.(md|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|css|html|csv|log|yml|yaml|toml|xml|sh|ps1|sql)$/i.test(name)) {
        blocks.push({ type: 'text', text: `Attached file ${name}:\n\`\`\`\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 200000)}\n\`\`\`` });
      } else throw providerError(415, `Cannot attach ${name}. Attach images or text files.`);
    }
    if (text) blocks.push({ type: 'text', text });
    return blocks;
  }

  return {
    kind,
    label,
    paid: true,       // the agent runs on the user's own model account
    cost: 'unknown',  // ACP reports no cost: the office asks once per session and shows "unknown"
    // gated (ADR 0001): an agent that runs some calls without asking is not, whatever the office holds of what it does ask.
    gated: spec.gated === true,
    ...(spec.gated === true ? {} : { supervision: spec.supervision || 'Unsupervised' }),
    get canResume() { return learned.caps?.loadSession === true; },
    get features() {
      const f = [];
      if (learned.caps?.loadSession === true) f.push('resume');
      if (learned.caps?.promptCapabilities?.image === true) f.push('images');
      f.push(...spec.features);
      // Only what the handshake said: a build without session/fork must not offer Fork (the worktree would be made for nothing).
      if (learned.caps?.sessionCapabilities?.fork && !f.includes('fork')) f.push('fork');
      return f;
    },
    // Where this agent keeps the skills it writes (#72), or null for an agent kind without the 'skills' feature.
    skillsDir() {
      const h = spec.features.includes('skills') && spec.skillsHome;
      if (!h) return null;
      return path.join(env[h.env] || path.join(homedir(), h.dir), 'skills');
    },
    spec,
    // The Security room rows the agent's own config takes (providers/index.mjs; security.mjs enforcement()).
    ...(spec.enforces ? { enforces: [...spec.enforces] } : {}),
    ...(spec.unenforced ? { unenforced: { ...spec.unenforced } } : {}),
    ...(spec.partly ? { partly: { ...spec.partly } } : {}),
    // OpenClaw: the Gateway config check (null: no config, or the kind is off or not installed).
    policy: (fresh) => policy(fresh === true),
    // The gate check of start() that needs no session, for the server to ask before the cost question and before a worktree:
    // why the agent would not start, or null. Only an agent with a Gateway config has one; a missing program or an off kind is
    // said elsewhere (null here).
    async preflight() {
      if (!spec.gateway) return null;
      const p = await policy(true);
      return p ? gateBlock(p.config) : null;
    },
    // spec.plugin (#77): one tool call the office plugin in the OpenClaw Gateway sends (POST /hook/openclaw, openclaw.mjs
    // gateRequest). It is held like every request of the session (the Security room rules, then the user), and the answer goes
    // back as { allow, reason }. A call that starts work outside the session is denied at once (openclaw.mjs toolCall). signal:
    // the plugin stopped waiting (its limit, or OpenClaw cancelled the call); the hold then goes, and the feed says so.
    // The answer is kept by toolCallId (st.gated) for endCall and for OpenClaw's own exec approval of the same call, so a call
    // with no id is denied: the office could not tell later whether it ran unheld. A patch of several files is held as an Edit
    // of each, one after another, and runs only when every one is allowed.
    async gate(s, call, signal) {
      const st = agents.get(s.uid);
      if (!spec.plugin || !st || st.closed || st.dead || st.gateFail) return { allow: false, reason: `This ${label} session is not open in Agent Office.` };
      const id = call.toolCallId ? String(call.toolCallId) : null;
      const m = toolCall(call.toolName, call.params, call.derivedPaths, s.cwd);
      // host: the host the call named (not "auto"), so OpenClaw's own exec approval on another host is held again (onPermission).
      const named = call.params && typeof call.params.host === 'string' && call.params.host.trim() && call.params.host !== 'auto' ? call.params.host.trim() : null;
      const record = (allow, pending = false) => st.gated.set(id, { allow, pending, command: m.tool_name === 'Bash' && typeof m.tool_input.command === 'string' ? m.tool_input.command.trim() : null, host: named });
      const done = (allow, reason = '') => { if (id) record(allow); return { allow, reason }; };
      if (m.handoff) {
        emit(st, () => events.feed(s, 'tool', `refused ${call.toolName}: ${m.handoff}`));
        return done(false, m.handoff);
      }
      if (!id) {
        emit(st, () => events.feed(s, 'tool', `refused ${call.toolName}: the ${PLUGIN_ID} plugin sent no tool call id`));
        return { allow: false, reason: `The ${PLUGIN_ID} plugin sent no tool call id, so the office cannot match the call to what ${label} reports. The call is denied.` };
      }
      // The office has the call from now on (pending until it answers): a failed call it is still deciding about is not one
      // the office never got (endCall), for example when OpenClaw stops the call on a Stop before the plugin's wait ends.
      record(false, true);
      const parts = m.files && m.files.length > 1 ? m.files.map((f) => ({ ...m, tool_input: { file_path: f } })) : [m];
      for (const part of parts) {
        if (st.closed || st.dead || st.gateFail) return done(false, `This ${label} session is not open in Agent Office.`);
        if (st.interrupted) return done(false, 'The turn was stopped in Agent Office.');
        if (signal?.aborted) return done(false, `${label} stopped waiting for the answer.`);
        const d = await holdOne(s, st, part, signal);
        if (!d.allow) return done(false, d.reason);
      }
      return done(true);
    },

    async readiness() {
      try { program(); } catch (e) { return { ready: false, version: null, needs: [e.message, ...spec.needs] }; }
      const down = await notReady(); // before the bridge starts: off, or without a Gateway it has nothing to talk to
      if (down) return { ready: false, version: null, needs: [down] };
      // A probe that runs longer than one answer may wait (a cold start) goes on; the next answer waits for that same probe.
      const done = await within(this.learn().then(() => true), readyWaitMs, 'still starting', setTimer, clearTimer).catch(() => false);
      if (!done) return { ready: false, version: null, needs: [`${label} is still starting. A first start can take more than 10 s. Click Check again in a few seconds.`] };
      if (learned.auth) return { ready: false, version: learned.version || null, needs: [learned.why] };
      if (!learned.ok) return { ready: false, version: null, needs: [`${label} did not answer the ACP handshake: ${learned.why}`, ...spec.needs] };
      const needs = spec.pin && learned.version !== spec.pin ? [`The office was tested with ${label} ${spec.pin}. This is ${learned.version || 'an unknown version'}.`] : [];
      let ready = true;
      if (spec.minVersion && !versionAtLeast(learned.version, spec.minVersion)) {
        ready = false; // start() refuses the same way (gateCheck)
        needs.push(`${label} ${learned.version || '(unknown version)'} is older than ${spec.minVersion}, or does not say its version. The office plugin needs ${spec.minVersion} or later to hold its tool calls. Update ${label}.`);
      }
      if (spec.gateway) {
        try {
          const c = (await policy()).config;
          if (gateBlock(c)) ready = false;   // start() refuses the same way (gateCheck)
          needs.push(...[...configNotes(c), ...configNotes(c, true)].map((n) => `${label}: ${n}`));
        } catch (e) { ready = false; needs.push(`${label}: the office could not check its config: ${textOf(e)}`); }
      }
      return { ready, version: learned.version || 'unknown', needs };
    },

    // One handshake with the agent in a temp folder, then it stops. What it says is kept for a minute, and calls that
    // overlap share one probe.
    learn() {
      const ttl = learned.ok ? spec.readyTtlMs || PROBE_TTL_MS : spec.notReadyTtlMs || PROBE_TTL_MS;
      if (learned.at && now() - learned.at < ttl) return Promise.resolve();
      if (!probing) probing = probe().finally(() => { probing = null; });
      return probing;
    },

    // The agent picks its model in its own settings, unless it takes one on its command line (spec.modelArg): then the models
    // its last session/new listed (a readiness probe opens one). None yet: Default only.
    async models() { return models.map((m) => ({ ...m })); },

    // Before the office makes a worktree or a session. check({}) checks only that a session can start (Reopen).
    check(o = {}) {
      program();
      if (o.model && !spec.modelArg) throw providerError(400, `${label} picks its model in its own settings. Leave the model empty.`);
      if (o.model && !spec.modelRe.test(String(o.model))) throw providerError(400, 'Unknown model.');
      if (o.permissionMode && o.permissionMode !== 'default') throw providerError(400, `${label} runs with the office's approvals only. Leave the permission mode empty.`);
    },
    open(s, o = {}) {
      let file, child;
      // A missing program or a spawn that throws: the session says why and ends, on a later tick (seam timing rule 1).
      try {
        file = program();
        // Only a model id goes on the command line (a Reopen's model is not behind check()): never a value that reads as a switch.
        const sessionArgs = o.model && spec.modelArg && spec.modelRe.test(String(o.model)) ? [...argsNow(), spec.modelArg, String(o.model)] : argsNow();
        child = spawn(file, sessionArgs, { cwd: s.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: envOf({ OFFICE_ID: s.officeId }) });
      } catch (e) {
        setImmediate(() => { events.reply(s, `Could not start ${label}: ${textOf(e)}`); events.end(s, 'could not start'); });
        return;
      }
      s.pid = child.pid;
      const root = s.worktree?.root || s.startDir || s.cwd;
      const st = {
        session: s, child, root, tools: makeTools(root), sid: null, caps: null, busy: false, closed: false, interrupted: false, failed: false, gateFail: null,
        loading: false, queue: [], notes: [], carry: [], text: '', last: '', msgId: null, cancelled: null, endCancel: null, err: '',
        calls: new Map(),        // toolCallId -> what the office knows of the call
        asks: new Map(),         // request id -> a held request: the agent's own, or a file or command the office serves
        grants: new Map(),       // this turn: 'Bash\n<line>' or 'Write\n<fileKey>' the user approved -> its toolCallId; served once
        denied: new Set(),       // this turn: files whose edit the user declined (fileKey); a write to them is refused at once
        askFirst: new Set(),     // this turn: files whose edit request went unanswered or changed; a write to them asks first
        deniedVague: false,      // this turn: the user declined an edit that named no file, so every write asks first
        wrote: new Set(),        // this turn: files the office wrote for the agent
        gated: new Map(),        // spec.plugin: toolCallId -> { allow, command } the office's answer to the plugin, until the call ends
        terminals: new Map(),    // terminalId -> a running or finished command (local-tools start())
        terminalIds: new Set(),  // every terminal id the office gave out
      };
      st.rpc = channel(child, {
        onRequest: (method, params) => onRequest(s, st, method, params),
        onNotify: (method, params) => { if (method === 'session/update') onUpdate(s, st, params); },
      });
      agents.set(s.uid, st);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { st.err = (st.err + d).slice(-1500); });
      child.on('error', (e) => {
        st.dead = true; st.rpc.fail('The agent stopped.');
        if (st.closed || st.failed) return;
        st.failed = true;
        events.reply(s, `Could not start ${label}: ${e.message}`);
        events.end(s, 'could not start');
      });
      child.on('exit', (code) => {
        st.dead = true; st.rpc.fail('The agent stopped.');
        st.tools.stop();
        if (st.closed) return; // the office closes it: the close ends the session
        if (!st.sid && !st.failed) events.reply(s, `${label} stopped before it started: ` + (clip(st.err.trim(), 400) || 'exit code ' + code));
        events.end(s, st.gateFail ? `stopped: the ${PLUGIN_ID} plugin did not hold a call` : code ? `exited (${code})` : 'finished');
      });
      start(s, st, o).catch((e) => {
        if (st.closed || st.dead) return;
        st.failed = true;
        if (isAuth(e)) learned.at = 0; // readiness asks again
        events.reply(s, `${label} could not start a session: ${isAuth(e) ? `it is not signed in. ${spec.signIn || 'Sign in, then open the session again.'}` : textOf(e)}`);
        killTree(child.pid, execFile); // the exit ends the session
      });
    },

    message(s, { text = '', attachments = [] } = {}) {
      const st = agents.get(s.uid);
      if (!st || st.closed || st.dead) throw providerError(409, 'That session is not running.');
      const item = { text: String(text), prompt: promptOf(st, String(text), attachments) };
      if (st.busy || !st.sid) st.queue.push(item);
      else setImmediate(() => runTurn(s, st, item));
    },

    // The user's decision on a request this provider holds. No decision ({}) is a decline (reject once), unless the agent no
    // longer waits for it or the turn is being stopped: then the answer is cancelled.
    answer(s, request, d = {}) {
      const st = agents.get(s.uid);
      // d.message: why the Security room refused it (a Deny rule), for the agent.
      if (st) asks.answer(st, request?.id, d);
    },

    interrupt(s) {
      const st = agents.get(s.uid);
      if (!st || !st.busy) return;
      st.interrupted = true;
      st.queue.length = 0;
      st.rpc.notify('session/cancel', { sessionId: st.sid });
      asks.cancelAll(st); // ACP: every request that waits gets the cancelled outcome
      st.tools.stop();
      // The agent answers the prompt with stopReason cancelled. One that never does still ends the turn.
      const end = st.endCancel;
      setTimer(() => { if (end && st.endCancel === end) end({ stopReason: 'cancelled' }); }, CANCEL_MS);
    },

    // The agent and its commands stop. While it closes, its exit reports nothing: the office ends the session.
    close(s) {
      const st = agents.get(s.uid);
      agents.delete(s.uid);
      if (!st) return Promise.resolve();
      st.closed = true;
      asks.cancelAll(st);
      const stopped = st.tools.stop();
      st.rpc.fail('The session closed.');
      if (st.endCancel) st.endCancel({ stopReason: 'cancelled' });
      // The agent process and its commands both end before this resolves.
      if (st.dead || !st.child.pid) return Promise.resolve(stopped);
      const exited = new Promise((resolve) => {
        st.child.once('exit', () => resolve());
        killTree(st.child.pid, (file, args, opts, cb) => execFile(file, args, opts, (...a) => { cb(...a); setTimer(resolve, 2000); }));
      });
      return Promise.all([exited, stopped]).then(() => undefined);
    },
  };
}
