// Microsoft Agent Framework provider: an agent team behind the provider seam (providers/index.mjs), on a local model.
// The team runs in its own Python process (providers/agent_framework_runner.py), because the framework is a Python package.
// The office keeps the rules:
//   - The team's agents are bots. The lead (the start agent) is the session's bot. When work passes to another member, that
//     member becomes a helper bot: a delegation (an Agent tool call and SubagentStart, like a Claude Code subagent). When the
//     member hands back or finishes, the helper finishes (SubagentStop).
//   - A hand-off (the framework's handoff_sent event) is a delegation. A member that speaks or calls a tool before any hand-off
//     (a sequential team) is delegated to at that moment. In a handoff team the member's next hand-off, or the end of the
//     run, closes it; executor_completed does not, because the framework sends every reply to every member first, and each
//     of those messages is its own executor_invoked and executor_completed (test/fixtures/README.md). In a sequential team
//     each member runs once, so its executor_completed closes it.
//   - A member calls only the tools of its own list in the team file; the office refuses any other name.
//   - A team turn has at most MAX_STEPS steps (tool calls and hand-offs). Then the office stops the run and the turn fails.
//   - Tool calls are tool calls. Every tool of a team member is a proxy: the runner sends the call here, and the office runs it
//     through the same gate as a local model (providers/local.mjs createToolGate): the Security room rules decide it first
//     (the team's own column, agent-framework; risk.mjs names the row), else it comes to you, and the tool runs inside the
//     worktree (providers/local-tools.mjs). The runner never runs a tool itself. Every cell of the column is Ask by default,
//     a low read inside the worktree included: a new kind keeps no older behavior (only the local model does).
//   - The model client is the local OpenAI-compatible server (LM Studio or Ollama, deps.servers). It costs nothing. The runner
//     gets a scrubbed environment, so no cloud key (OPENAI_*, AZURE_*) can send the team to a paid service.
//
// Runner protocol: one JSON object per line.
//   office -> runner (stdin)
//     { type: 'start', model, base_url, team: { name, pattern, start, agents: [{ name, description, instructions, tools }] },
//       tools: [OpenAI function definitions] }                      first line; the runner builds the team
//     { type: 'message', text }                                     a user message: one team run
//     { type: 'tool_result', id, text }                             the answer to a tool line
//     { type: 'stop' }                                              stop the run that runs (interrupt)
//     { type: 'close' }                                             end the runner
//   runner -> office (stdout)
//     { type: 'ready', version }                                    the team is built
//     { type: 'event', event, ... }                                 a framework workflow event, by its type:
//        output { executor_id, author, response_id, contents: [{ type: 'text', text } | { type: 'usage', input_tokens, output_tokens }] }
//        handoff_sent { source, target }   executor_invoked / executor_completed { executor_id }   executor_failed { executor_id, error }
//     { type: 'tool', id, agent, name, input }                      a member calls a tool and waits for tool_result
//     { type: 'turn_end', stopped?, error? }                        the run ended: the team waits for the user, stopped, or failed
//                                                                   (a message that came during a run is kept and runs next)
//     { type: 'fatal', error }                                      the team could not be built
//   `python agent_framework_runner.py --check` prints { ok, version } or { ok: false, error } and exits.
//
// Everything is reported in the tracker's vocabulary (events.hook, events.stream). The process calls are injected (spawn,
// execFile, exe, kill), so tests drive this file with a fake runner. Nothing starts on import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as realSpawn, execFile as realExecFile } from 'node:child_process';
import { resolveExe, helperCwd, killTree } from '../launch.mjs';
import { clip } from '../tracker.mjs';
import { providerError } from './index.mjs';
import { createToolGate, noteOf, OFFICE_TOOLS } from './local.mjs';
import { createLocalTools, TOOL_DEFINITIONS } from './local-tools.mjs';

export const KIND = 'agent-framework';
export const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent_framework_runner.py');
/** The team file in a session folder. Without it the session gets DEFAULT_TEAM. */
export const TEAM_FILE = 'agent-team.json';
export const PATTERNS = ['handoff', 'sequential'];
const TOOLS = [...TOOL_DEFINITIONS, ...OFFICE_TOOLS];
export const TOOL_NAMES = TOOLS.map((t) => t.function.name);
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/; // the framework names a hand-off tool handoff_to_<name>: a function name
const MAX_AGENTS = 8, MAX_INSTRUCTIONS = 4000, MAX_TEAM_BYTES = 64_000;
const CHECK_MS = 14_000;     // importing the framework takes some seconds; under the registry's 15 s, so this file's reason shows
const CLOSE_MS = 1500;       // a runner that does not end after close is killed
export const MAX_STEPS = 60;   // tool calls and hand-offs in one team turn (a local agent has MAX_ROUNDS model calls)
// Only these variables reach the runner. No OPENAI_*, AZURE_* or ANTHROPIC_* key: the team talks to the local server only.
const ENV_KEEP = /^(SystemRoot|windir|SystemDrive|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA|ComSpec|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|LANG|LC_ALL|PYTHONPATH|PYTHONHOME|VIRTUAL_ENV)$/i;

export const SETUP = [
  'Install Python 3.10 or later.',
  'Install Microsoft Agent Framework in its own environment: python -m venv %USERPROFILE%\\.agent-office-af, then %USERPROFILE%\\.agent-office-af\\Scripts\\pip install agent-framework.',
  'Set OFFICE_AF_PYTHON to %USERPROFILE%\\.agent-office-af\\Scripts\\python.exe, then restart the office.',
];
const NO_MODEL = 'Start LM Studio or Ollama with a chat model. The team runs on it.';

/** The team when the folder has no agent-team.json: a lead that hands work to a coder and a reviewer. */
export const DEFAULT_TEAM = {
  name: 'Team', pattern: 'handoff', start: 'lead',
  agents: [
    { name: 'lead', description: 'Plans the work, hands parts of it to the team, and reports to the user.',
      instructions: 'You lead a small coding team. Read enough of the folder to plan. Hand code changes to coder and checks to reviewer. '
        + 'When the work is done, tell the user in a few sentences what the team did.',
      tools: ['Read', 'LS', 'Grep', 'office_room', 'office_ask'] },
    { name: 'coder', description: 'Reads and changes files and runs commands.',
      instructions: 'You change code. Make the change the lead asks for, run a quick check, then hand back to lead with a short summary.',
      tools: ['Read', 'LS', 'Grep', 'Edit', 'Write', 'Bash'] },
    { name: 'reviewer', description: 'Checks the changes and runs the tests.',
      instructions: 'You review changes. Read the changed files, run the tests, then hand back to lead with what you found.',
      tools: ['Read', 'LS', 'Grep', 'Bash'] },
  ],
};

/**
 * A team from the text of agent-team.json: { name, pattern, start, agents: [{ name, description, instructions, tools }] }.
 * Throws a 400 error that says what to fix. Tools are names from TOOL_NAMES only: every tool goes through the office's gate,
 * so a team file cannot add a tool the office does not rate.
 */
export function readTeam(text) {
  const bad = (why) => providerError(400, `${TEAM_FILE}: ${why}`);
  if (String(text).length > MAX_TEAM_BYTES) throw bad('the file is too large.');
  let j;
  try { j = JSON.parse(text); } catch { throw bad('the file is not valid JSON.'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw bad('the file must hold one object.');
  const pattern = j.pattern === undefined ? 'handoff' : j.pattern;
  if (!PATTERNS.includes(pattern)) throw bad(`pattern must be ${PATTERNS.join(' or ')}.`);
  if (!Array.isArray(j.agents) || !j.agents.length) throw bad('agents must list at least one agent.');
  if (j.agents.length > MAX_AGENTS) throw bad(`a team has at most ${MAX_AGENTS} agents.`);
  const seen = new Set();
  const agents = j.agents.map((a, i) => {
    if (!a || typeof a !== 'object') throw bad(`agent ${i + 1} must be an object.`);
    const name = a.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad(`agent ${i + 1}: name must be lower-case letters, digits and _ (at most 32), starting with a letter.`);
    if (seen.has(name)) throw bad(`two agents have the name ${name}.`);
    seen.add(name);
    if (typeof a.instructions !== 'string' || !a.instructions.trim()) throw bad(`${name}: instructions must be text.`);
    if (a.instructions.length > MAX_INSTRUCTIONS) throw bad(`${name}: instructions are longer than ${MAX_INSTRUCTIONS} characters.`);
    const tools = a.tools === undefined ? ['Read', 'LS', 'Grep'] : a.tools;
    if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')) throw bad(`${name}: tools must be a list of tool names.`);
    const unknown = tools.filter((t) => !TOOL_NAMES.includes(t));
    if (unknown.length) throw bad(`${name}: unknown tool ${unknown[0]}. Use ${TOOL_NAMES.join(', ')}.`);
    return { name, description: typeof a.description === 'string' ? a.description.slice(0, 300) : '', instructions: a.instructions, tools: [...new Set(tools)] };
  });
  const start = j.start === undefined ? agents[0].name : j.start;
  if (!seen.has(start)) throw bad(`start must be the name of an agent.`);
  const name = typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, 40) : 'Team';
  return { name, pattern, start, agents };
}

/** The team of a folder: its agent-team.json, or DEFAULT_TEAM when there is none. Throws readTeam's 400 for a bad file. */
export function teamOf(cwd, read = fs.readFileSync) {
  let text;
  try { text = read(path.join(cwd, TEAM_FILE), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return readTeam(JSON.stringify(DEFAULT_TEAM));
    throw providerError(400, `${TEAM_FILE}: the office cannot read it (${e.code || e.message}).`);
  }
  return readTeam(text);
}

/** The runner's environment: the allowlist above, and UTF-8 pipes. */
export function runnerEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (ENV_KEEP.test(k) && typeof v === 'string') out[k] = v;
  return { ...out, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
}

const textOf = (e) => String((e && e.message) || e || 'unknown error');

/**
 * @param {object} deps
 * @param {object} deps.events the provider events (providers/index.mjs providerEvents).
 * @param {object[]} deps.servers the local model providers the team can run on (providers/local.mjs createLocal):
 *   each gives kind, label, baseUrl and models().
 * @param {object} [deps.officeTools] the office tools as in-process calls (server.mjs officeTools).
 * @param {object} [deps.env] the office environment (process.env). OFFICE_AF_PYTHON: the Python that has the framework.
 * @param {Function} [deps.spawn] @param {Function} [deps.execFile] @param {(name: string) => string} [deps.exe] launch.mjs resolveExe
 * @param {(pid: number) => void} [deps.kill] killTree. @param {(root: string) => object} [deps.makeTools] createLocalTools.
 * @param {string} [deps.runner] the runner script (RUNNER).
 */
export function createAgentFramework(deps) {
  const events = deps.events;
  const servers = deps.servers || [];
  const env = deps.env || process.env;
  const spawn = deps.spawn || realSpawn;
  const execFile = deps.execFile || realExecFile;
  const exe = deps.exe || ((name) => resolveExe(name, env));
  const kill = deps.kill || ((pid) => killTree(pid));
  const makeTools = deps.makeTools || ((root) => createLocalTools(root));
  const runner = deps.runner || RUNNER;
  const gate = createToolGate({ events, office: deps.officeTools || null });
  /** @type {Map<string, object>} uid -> the team state of an open session */
  const teams = new Map();

  // The Python that runs the team: OFFICE_AF_PYTHON (a virtual environment, as SETUP says), else python on the PATH.
  function python() {
    const own = String(env.OFFICE_AF_PYTHON || '').trim();
    try { return exe(own || (process.platform === 'win32' ? 'python' : 'python3')); } catch (e) {
      throw providerError(409, own ? `OFFICE_AF_PYTHON does not point to a program: ${own}.` : 'The office cannot find Python. ' + SETUP[0]);
    }
  }
  // A model id names its server: 'lmstudio:qwen2.5-7b'. The server's own id can hold more colons (Ollama's llama3:8b).
  function serverOf(model) {
    const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(String(model || ''));
    const server = m && servers.find((p) => p.kind === m[1]);
    return server ? { server, id: m[2] } : null;
  }
  async function allModels() {
    const lists = await Promise.all(servers.map(async (p) => {
      try { return (await p.models()).map((m) => ({ id: `${p.kind}:${m.id}`, label: `${m.label || m.id} (${p.label})` })); } catch { return []; }
    }));
    return lists.flat();
  }
  function checkRunner(file) {
    return new Promise((resolve) => {
      execFile(file, ['-u', runner, '--check'], { cwd: helperCwd(), env: runnerEnv(env), windowsHide: true, timeout: CHECK_MS, encoding: 'utf8' }, (err, out) => {
        const line = String(out || '').trim().split('\n').pop() || '';
        try { return resolve(JSON.parse(line)); } catch { /* below */ }
        resolve({ ok: false, error: err ? textOf(err) : 'The runner gave no answer.' });
      });
    });
  }

  // ----- one team session -----
  // Every report goes through emit(): after close, nothing more is reported (the seam's timing rule 2).
  const emit = (st, fn) => (st.closed ? undefined : fn());
  const send = (st, m) => { if (!st.closed && st.child.stdin.writable) st.child.stdin.write(JSON.stringify(m) + '\n'); };
  const isMember = (st, name) => name !== st.team.start && st.names.has(name);

  // A delegation: the member becomes a helper bot of the session's bot, as a Claude Code subagent does.
  function delegate(s, st, name, task) {
    if (st.deleg.has(name)) return st.deleg.get(name);
    const n = ++st.seq;
    const d = { call: `handoff-${n}`, agent: `${name}-${n}` };
    st.deleg.set(name, d);
    emit(st, () => events.hook(s, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: d.call, tool_input: { subagent_type: name, description: clip(task, 120) } }));
    emit(st, () => events.hook(s, { hook_event_name: 'SubagentStart', agent_id: d.agent, agent_type: name }));
    return d;
  }
  function handBack(s, st, name, error) {
    const d = st.deleg.get(name);
    if (!d) return;
    st.deleg.delete(name);
    const input = { subagent_type: name, description: '' };
    // SubagentStop says the helper finished well, so a member that failed or was stopped gets only the failed call.
    if (error) { emit(st, () => events.hook(s, { hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: d.call, tool_input: input, error })); return; }
    emit(st, () => events.hook(s, { hook_event_name: 'SubagentStop', agent_id: d.agent, agent_type: name }));
    emit(st, () => events.hook(s, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: d.call, tool_input: input }));
  }

  // One agent response is one assistant message. A member's reply starts with its name, so the chat says who spoke.
  function flush(s, st) {
    const r = st.resp;
    if (!r) return;
    st.resp = null;
    // A response the office split at a tool call can start with a space: the reply is trimmed.
    const body = r.text.trim();
    const text = body ? (isMember(st, r.author) ? `${r.author}: ${body}` : body) : '';
    if (text) st.last = text;
    emit(st, () => events.stream(s, { type: 'assistant', message: { id: r.id, content: text ? [{ type: 'text', text }] : [], usage: { input_tokens: r.input, output_tokens: r.output } } }));
    // The window is the model server's (#164); the tokens are this response's prompt plus completion. Unknown window: no line.
    if (st.window && (r.input || r.output)) emit(st, () => events.stream(s, { type: 'usage', ctx: { used: r.input + r.output, size: st.window } }));
  }
  function output(s, st, m) {
    const author = String(m.author || m.executor_id || '');
    const contents = Array.isArray(m.contents) ? m.contents : [];
    if (!author || !contents.length) return;
    if (isMember(st, author)) delegate(s, st, author, `${author} works on it`);
    const key = `${author}\n${m.response_id || ''}`;
    if (!st.resp || st.resp.key !== key) {
      flush(s, st);
      st.resp = { key, id: `af-${++st.seq}`, author, text: '', input: 0, output: 0 };
      emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'message_start' } }));
    }
    const r = st.resp;
    for (const c of contents) {
      if (c && c.type === 'text' && typeof c.text === 'string' && c.text) {
        const piece = !r.text && isMember(st, author) ? `${author}: ${c.text.trimStart()}` : c.text;
        r.text += c.text;
        emit(st, () => events.stream(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } }));
      } else if (c && c.type === 'usage') {
        r.input += Number(c.input_tokens) || 0;
        r.output += Number(c.output_tokens) || 0;
      }
    }
  }
  function onEvent(s, st, m) {
    const id = String(m.executor_id || '');
    switch (m.event) {
      case 'output': case 'intermediate': return output(s, st, m);
      case 'handoff_sent': {
        flush(s, st);
        step(s, st);
        const from = String(m.source || ''), to = String(m.target || '');
        if (isMember(st, from)) handBack(s, st, from);
        if (isMember(st, to)) delegate(s, st, to, `Hand-off from ${from || 'the team'}`);
        else if (to) events.feed(s, 'tool', `${from || 'a member'} handed back to ${to}`);
        return;
      }
      // Only a sequential member is done when its executor completes (see the top of this file).
      case 'executor_completed': if (st.team.pattern === 'sequential' && isMember(st, id)) { flush(s, st); handBack(s, st, id); } return;
      case 'executor_failed': if (isMember(st, id)) { flush(s, st); handBack(s, st, id, String(m.error || 'Failed')); } return;
      default: return; // executor_invoked and the rest: no change a bot shows
    }
  }

  // One more step of this turn. Over the limit the office stops the run, and the turn fails with the reason.
  function step(s, st) {
    if (++st.steps <= MAX_STEPS) return true;
    if (!st.failure) {
      st.failure = `The team used all ${MAX_STEPS} steps of one turn.`;
      st.tools.stop();
      for (const resolve of st.waiting.values()) resolve({ allow: false });
      st.waiting.clear();
      send(st, { type: 'stop' });
    }
    return false;
  }

  // A member's tool call: through the gate, then the answer goes back to the runner. Every path answers the runner (it waits
  // for the answer) and nothing rejects: an error here would end the office (no unhandledRejection handler).
  async function onTool(s, st, m) {
    const id = String(m.id || '').slice(0, 40), agent = String(m.agent || ''), name = String(m.name || '');
    if (!id) return;
    flush(s, st);
    const member = st.team.agents.find((a) => a.name === agent);
    const d = isMember(st, agent) ? delegate(s, st, agent, `${agent} works on it`) : null;
    const input = m.input && typeof m.input === 'object' && !Array.isArray(m.input) ? m.input : null;
    const base = { tool_name: name, tool_use_id: `af-${id}`, tool_input: input || {}, ...(d ? { agent_id: d.agent } : {}) };
    // A call the office does not run: shown as a failed call, and the text goes back to the team.
    const refuse = (error) => {
      try {
        emit(st, () => events.hook(s, { hook_event_name: 'PreToolUse', ...base }));
        emit(st, () => events.hook(s, { hook_event_name: 'PostToolUseFailure', ...base, error }));
      } catch { /* the answer below still goes */ }
      send(st, { type: 'tool_result', id, text: error });
    };
    // The runner builds proxies only for a member's own tools; this second check holds even if it did not.
    if (!member) return refuse(`${agent || 'An unnamed agent'} is not an agent of the team ${st.team.name}.`);
    if (!member.tools.includes(name)) return refuse(`${name || 'A tool with no name'} is not a tool of ${agent}.`);
    if (!step(s, st)) return refuse(`Stopped: ${st.failure}`);
    let text;
    try {
      text = await gate.call(s, st, { id: base.tool_use_id, name, input, agentId: d ? d.agent : undefined });
    } catch (e) {
      text = `Error: ${textOf(e)}`;
      try { emit(st, () => events.hook(s, { hook_event_name: 'PostToolUseFailure', ...base, error: text })); } catch { /* still answer */ }
    }
    send(st, { type: 'tool_result', id, text: String(text) });
  }

  function startRun(s, st, text) {
    st.busy = true; st.interrupted = false; st.failure = null; st.last = ''; st.steps = 0;
    const back = emit(st, () => events.hook(s, { hook_event_name: 'UserPromptSubmit', prompt: text }));
    send(st, { type: 'message', text: noteOf(back) ? text + '\n\n' + noteOf(back) : text });
  }
  function onTurnEnd(s, st, m) {
    flush(s, st);
    for (const resolve of st.waiting.values()) resolve({ allow: false });
    st.waiting.clear();
    if (st.closed) return;
    // The step limit stops the run like Stop does, but the turn failed: that reason comes first.
    const failure = st.failure || (m.error ? String(m.error) : null);
    if (failure && !st.interrupted) {
      for (const name of [...st.deleg.keys()]) handBack(s, st, name, failure);
      events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: `Agent Framework: ${clip(failure, 300)}`, total_cost_usd: 0 });
    } else if (st.interrupted || m.stopped) {
      for (const name of [...st.deleg.keys()]) handBack(s, st, name, 'Stopped');
      events.stream(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Stopped', total_cost_usd: 0 });
    } else {
      // The team waits for the user. A member that still holds the work has done its part.
      for (const name of [...st.deleg.keys()]) handBack(s, st, name);
      // A message that came in meanwhile goes to the team first (the tracker answers Stop with a block).
      const stop = events.hook(s, { hook_event_name: 'Stop', last_assistant_message: st.last });
      if (stop && stop.decision === 'block' && stop.reason) { send(st, { type: 'message', text: stop.reason }); return; }
      events.stream(s, { type: 'result', subtype: 'success', is_error: false, result: st.last, total_cost_usd: 0 });
    }
    st.busy = false;
    const next = st.queue.shift();
    if (next !== undefined) setImmediate(() => { if (!st.closed) startRun(s, st, next); });
  }

  function onLine(s, st, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || st.closed) return;
    if (m.type === 'ready') { st.version = m.version || null; events.feed(s, 'start', `team ${st.team.name} is ready (${st.team.agents.map((a) => a.name).join(', ')})`); }
    else if (m.type === 'event') onEvent(s, st, m);
    else if (m.type === 'tool') void onTool(s, st, m);
    else if (m.type === 'turn_end') onTurnEnd(s, st, m);
    else if (m.type === 'fatal') { st.fatal = String(m.error || 'unknown error'); }
  }

  // The runner is gone: the session ends with the reason. After close the office ends it, so nothing is reported here.
  function gone(s, st, why) {
    if (st.closed || st.ended) return;
    st.ended = true;
    teams.delete(s.uid);
    st.closed = true; // nothing more from this runner
    st.tools.stop();
    for (const resolve of st.waiting.values()) resolve({ allow: false });
    if (st.busy) events.stream(s, { type: 'result', subtype: 'success', is_error: true, result: `Agent Framework stopped: ${clip(why, 300)}`, total_cost_usd: 0 });
    else events.reply(s, `Agent Framework stopped: ${clip(why, 400)}`);
    events.end(s, 'the team stopped');
  }

  return {
    kind: KIND,
    label: 'Agent Framework',
    paid: false, // the team runs on a model on this machine: no spend limit
    canResume: false, // the team's conversation lives in the runner: Reopen starts a fresh team in the same folder
    needsModel: true, // the user picks a model of the local server
    team: true, // a team: its members show as helper bots
    features: ['teams'], // the adapter feature word (#72): Agent teams
    gated: true, // every member tool call goes to the office first (the Security room rules, then a hold): the runner runs none itself

    async readiness() {
      let file;
      try { file = python(); } catch { return { ready: false, version: null, needs: [...SETUP] }; }
      const r = await checkRunner(file);
      if (!r || r.ok !== true) {
        return { ready: false, version: null, needs: [`The office could not load Agent Framework: ${clip(String(r?.error || 'no answer'), 200)}`, ...SETUP.slice(1)] };
      }
      const version = `Agent Framework ${r.version || 'unknown'}`;
      if (!(await allModels()).length) return { ready: false, version, needs: [NO_MODEL] };
      return { ready: true, version, needs: [] };
    },

    models: allModels,

    // Before the office makes a worktree or a session. check({}) checks only that a session can start (Reopen): Python.
    check(o = {}) {
      if (Object.keys(o).length) {
        if (!o.model || typeof o.model !== 'string' || o.model.length > 300) throw providerError(400, 'Pick a model for this team.');
        if (!serverOf(o.model)) throw providerError(400, 'Pick a model of LM Studio or Ollama for this team.');
        if (o.cwd && o.isolation !== 'worktree') teamOf(String(o.cwd)); // a bad team file is refused here, with what to fix
      }
      python();
    },

    open(s, o = {}) {
      const fail = (why) => setImmediate(() => { events.reply(s, 'Could not start the team: ' + why); events.end(s, 'could not start'); });
      const target = serverOf(o.model);
      if (!target) return fail('pick a model of LM Studio or Ollama.');
      let team, file;
      try { team = teamOf(s.cwd); file = python(); } catch (e) { return fail(textOf(e)); }
      const child = spawn(file, ['-u', runner], { cwd: helperCwd(), env: runnerEnv(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const st = {
        child, team, names: new Set(team.agents.map((a) => a.name)), tools: makeTools(s.cwd),
        busy: false, closed: false, ended: false, interrupted: false, failure: null, fatal: null, version: null, steps: 0,
        queue: [], waiting: new Map(), deleg: new Map(), resp: null, last: '', seq: 0,
        window: (typeof target.server.windowOf === 'function' && target.server.windowOf(target.id)) || null,
      };
      teams.set(s.uid, st);
      s.pid = child.pid;
      let buf = '', err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(s, st, line); }
      });
      child.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      child.stdin.on('error', () => {});
      child.on('error', (e) => gone(s, st, textOf(e)));
      child.on('exit', (code) => gone(s, st, st.fatal || clip(err.trim(), 400) || `exit code ${code}`));
      // Each agent learns where it works. Paths are relative to the session folder; the office's tools resolve them there.
      const where = (name) => `You work in the folder ${s.cwd} as ${name} in the team ${team.name}. Paths are relative to that folder. Keep answers short.\n\n`;
      const agents = team.agents.map((a) => ({ ...a, instructions: where(a.name) + a.instructions }));
      const used = new Set(team.agents.flatMap((a) => a.tools));
      send(st, { type: 'start', model: target.id, base_url: target.server.baseUrl, team: { ...team, agents }, tools: TOOLS.filter((t) => used.has(t.function.name)) });
      // The session shows its model like a Claude Code session does, on a later tick (seam rule 1).
      setImmediate(() => emit(st, () => events.stream(s, { type: 'system', subtype: 'init', session_id: s.uid, model: o.model, permissionMode: 'default' })));
    },

    message(s, { text = '', attachments = [] } = {}) {
      const st = teams.get(s.uid);
      if (!st || st.closed) throw providerError(409, 'That session is not running.');
      if (attachments.length) throw providerError(415, 'An Agent Framework team takes text only.');
      const prompt = String(text);
      if (st.busy) st.queue.push(prompt);
      else { st.busy = true; setImmediate(() => { if (!st.closed) startRun(s, st, prompt); }); }
    },

    // The decision on a tool call the gate asked about: the user's, or the Security room's (with message, why it refused).
    // No decision ({}) declines.
    answer(s, request, d = {}) {
      const st = teams.get(s.uid);
      const resolve = st && st.waiting.get(request?.id);
      if (!resolve) return;
      st.waiting.delete(request.id);
      resolve({ allow: d.allow === true, message: typeof d.message === 'string' ? d.message : '' });
    },

    // The runner stops the run and answers with turn_end { stopped }; the result line follows from that.
    interrupt(s) {
      const st = teams.get(s.uid);
      if (!st || !st.busy) return;
      st.interrupted = true;
      st.queue.length = 0;
      st.tools.stop();
      for (const resolve of st.waiting.values()) resolve({ allow: false });
      st.waiting.clear();
      send(st, { type: 'stop' });
    },

    close(s) {
      const st = teams.get(s.uid);
      teams.delete(s.uid);
      if (!st) return Promise.resolve();
      send(st, { type: 'close' });
      st.closed = true;
      const stopped = st.tools.stop();
      for (const resolve of st.waiting.values()) resolve({ allow: false });
      st.waiting.clear();
      try { st.child.stdin.end(); } catch { /* gone */ }
      // The runner ends on close. One that does not is killed, process tree and all.
      const timer = setTimeout(() => { if (st.child.exitCode === null) kill(st.child.pid); }, CLOSE_MS);
      timer.unref?.();
      return Promise.resolve(stopped);
    },
  };
}
